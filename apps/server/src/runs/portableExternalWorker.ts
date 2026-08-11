import { constants, existsSync, mkdirSync, lstatSync, openSync, readFileSync, statSync, writeFileSync, closeSync, chmodSync } from "node:fs";
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { redactWorkerOutput, safeWorkerEnvironment } from "../security/processEnvironment.js";
import { resolvePortableExternalRunner } from "./portableExternalRunnerConfig.js";
import { issuePortableExternalActionPlan } from "./portableExternalActionPlan.js";
import type { PortableExternalEffectAuthorityV1 } from "./portableExternalEffectAuthority.js";
import { validateWebOperationIntent } from "./webOperationContract.js";
import { cleanupOwnedProcessGroup, type OwnedProcessGroupCleanup } from "./processGroupCleanup.js";

export const PORTABLE_EXTERNAL_ADAPTER_NOT_CONFIGURED = "portable_external_adapter_not_configured" as const;
export const PORTABLE_EXTERNAL_ADAPTER_INVALID = "portable_external_adapter_invalid" as const;
export const PORTABLE_EXTERNAL_WORKER_TIMEOUT = "portable_external_worker_timeout" as const;
export const PORTABLE_EXTERNAL_ADMISSION_ISSUE_FAILED = "portable_external_admission_issue_failed" as const;
export const PORTABLE_EXTERNAL_APPROVAL_REQUIRED = "portable_external_approval_required" as const;
export const PORTABLE_EXTERNAL_LEGACY_RUNNER_FORBIDDEN = "portable_external_legacy_runner_forbidden" as const;
export const PORTABLE_EXTERNAL_EFFECT_AUTHORITY_WRITE_FAILED = "portable_external_effect_authority_write_failed" as const;
export const PORTABLE_EXTERNAL_WEB_OPERATION_INTENT_WRITE_FAILED = "portable_external_web_operation_intent_write_failed" as const;
export const PORTABLE_EXTERNAL_PROCESS_GROUP_CLEANUP_UNVERIFIED = "portable_external_process_group_cleanup_unverified" as const;

export type PortableExternalWorkerResult = {
  status: "complete" | "partial" | "blocked";
  exactBlocker: string | null;
  externalActionExecuted: boolean;
  stdoutTail: string;
  stderrTail: string;
  exitStatus: number | null;
  signal: NodeJS.Signals | null;
  response: Record<string, unknown> | null;
  admissionPath?: string;
  admissionSha256?: string;
  actionPlanPath?: string;
  actionPlanSha256?: string;
  webOperationIntentPath?: string;
  webOperationIntentSha256?: string;
  processGroupCleanup?: OwnedProcessGroupCleanup;
};

function boundedTimeoutMs(): number {
  const value = Number(process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_TIMEOUT_MS ?? "900000");
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 3_600_000) : 900_000;
}

function parseResponse(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch {
      // The adapter may log human-readable progress before its final JSON receipt.
    }
  }
  return null;
}

function portableExternalEffectsEnabled(): boolean {
  return /^(?:1|true|yes|on|enabled)$/i.test(
    String(process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS || "").trim(),
  );
}

function issuePortableExternalAdmission(input: {
  workflowId: string;
  runId: string;
  stepId: string;
  sourceTrigger: string;
  idempotencyKey: string;
  approvalGranted: boolean;
}): { path: string; sha256: string } {
  const artifactRoot = resolve(
    process.env.AUTOMATION_OS_ARTIFACT_ROOT?.trim() || resolve(process.cwd(), "data", "artifacts"),
  );
  const runRoot = resolve(artifactRoot, input.runId);
  if (runRoot !== artifactRoot && !runRoot.startsWith(`${artifactRoot}${sep}`)) {
    throw new Error("portable_external_admission_run_path_invalid");
  }
  const issuedAt = new Date().toISOString();
  const timeoutMs = boundedTimeoutMs();
  const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
  const payload = {
    schema: "automation_os_portable_external_admission.v1",
    issued_by: "automation_os_worker",
    audience: "portable_external_runner",
    workflow_id: input.workflowId,
    run_id: input.runId,
    step_id: input.stepId,
    source_trigger: input.sourceTrigger,
    idempotency_key: input.idempotencyKey,
    effect_class: "external_non_idempotent",
    browser_surface: "browser_use_cli",
    external_effects: portableExternalEffectsEnabled() ? "enabled" : "read_only",
    approval_status: input.approvalGranted ? "approved" : "missing",
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
  const bytes = `${JSON.stringify(payload, null, 2)}\n`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const admissionPath = resolve(runRoot, `portable-external-admission-${sha256}.json`);
  mkdirSync(dirname(admissionPath), { recursive: true, mode: 0o700 });
  if (existsSync(admissionPath)) {
    const stat = lstatSync(admissionPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || readFileSync(admissionPath, "utf8") !== bytes) {
      throw new Error("portable_external_admission_immutable_collision");
    }
    chmodSync(admissionPath, 0o600);
    return { path: admissionPath, sha256 };
  }
  const fd = openSync(
    admissionPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    writeFileSync(fd, bytes, "utf8");
  } finally {
    closeSync(fd);
  }
  chmodSync(admissionPath, 0o600);
  return { path: admissionPath, sha256 };
}

function materializePortableExternalEffectAuthority(input: {
  runId: string;
  authority: PortableExternalEffectAuthorityV1;
}): { path: string; sha256: string } {
  const artifactRoot = resolve(
    process.env.AUTOMATION_OS_ARTIFACT_ROOT?.trim() || resolve(process.cwd(), "data", "artifacts"),
  );
  const runRoot = resolve(artifactRoot, input.runId);
  if (runRoot === artifactRoot || !runRoot.startsWith(`${artifactRoot}${sep}`)) {
    throw new Error("portable_external_effect_authority_run_path_invalid");
  }
  const bytes = `${JSON.stringify(input.authority, null, 2)}\n`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const authorityPath = resolve(runRoot, "portable-effect-authority.v1.json");
  mkdirSync(dirname(authorityPath), { recursive: true, mode: 0o700 });
  if (existsSync(authorityPath)) {
    const stat = lstatSync(authorityPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || readFileSync(authorityPath, "utf8") !== bytes) {
      throw new Error("portable_external_effect_authority_immutable_collision");
    }
    chmodSync(authorityPath, 0o600);
    return { path: authorityPath, sha256 };
  }
  const fd = openSync(
    authorityPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    writeFileSync(fd, bytes, "utf8");
  } finally {
    closeSync(fd);
  }
  chmodSync(authorityPath, 0o600);
  return { path: authorityPath, sha256 };
}

function materializePortableWebOperationIntent(input: {
  workflowId: string;
  runId: string;
  stepId: string;
  sourceTrigger: string;
  idempotencyKey: string;
  intent: Record<string, unknown>;
  authoritySha256?: string | null;
}): { path: string; sha256: string } {
  const operation = String(input.intent.operation || "");
  const authoritySha256 = input.authoritySha256 || input.intent.authority_sha256 || null;
  const approvalStatus = operation === "read" ? "not_required" : "approved";
  const validated = validateWebOperationIntent({
    schema: "automation_os_web_operation_intent.v1",
    operation,
    run_id: input.runId,
    step_id: input.stepId,
    idempotency_key: input.idempotencyKey,
    account_ref: input.intent.account_ref,
    allowed_origins: input.intent.allowed_origins,
    ...(input.intent.entry_url !== undefined ? { entry_url: input.intent.entry_url } : {}),
    target: input.intent.target,
    ...(input.intent.target_binding !== undefined ? { target_binding: input.intent.target_binding } : {}),
    ...(input.intent.action_plan !== undefined ? { action_plan: input.intent.action_plan } : {}),
    payload_hash: input.intent.payload_hash ?? null,
    approval_status: input.intent.approval_status || approvalStatus,
    authority_sha256: authoritySha256,
    readback_required: true,
    no_replay: true,
  });
  const value = {
    schema: "automation_os_web_operation_intent.v1",
    browser_surface: "browser_use_cli",
    workflow_id: input.workflowId,
    run_id: validated.run_id,
    step_id: validated.step_id,
    source_trigger: input.sourceTrigger,
    idempotency_key: validated.idempotency_key,
    operation: validated.operation,
    account_ref: validated.account_ref,
    allowed_origins: [...validated.allowed_origins],
    ...(validated.entry_url ? { entry_url: validated.entry_url } : {}),
    target: { ...validated.target },
    ...(validated.target_binding ? { target_binding: { ...validated.target_binding } } : {}),
    ...(validated.action_plan ? { action_plan: validated.action_plan } : {}),
    payload_hash: validated.payload_hash,
    approval_status: validated.operation === "read" ? "not_required" : "approved",
    authority_sha256: validated.authority_sha256,
    readback_required: true,
    no_replay: true,
  };
  const artifactRoot = resolve(
    process.env.AUTOMATION_OS_ARTIFACT_ROOT?.trim() || resolve(process.cwd(), "data", "artifacts"),
  );
  const runRoot = resolve(artifactRoot, input.runId);
  if (runRoot === artifactRoot || !runRoot.startsWith(`${artifactRoot}${sep}`)) {
    throw new Error("portable_external_web_operation_intent_run_path_invalid");
  }
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const intentPath = resolve(runRoot, "web-operation-intent.v1.json");
  mkdirSync(dirname(intentPath), { recursive: true, mode: 0o700 });
  if (existsSync(intentPath)) {
    const stat = lstatSync(intentPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || readFileSync(intentPath, "utf8") !== bytes) {
      throw new Error("portable_external_web_operation_intent_immutable_collision");
    }
    chmodSync(intentPath, 0o600);
    return { path: intentPath, sha256 };
  }
  const fd = openSync(
    intentPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    writeFileSync(fd, bytes, "utf8");
  } finally {
    closeSync(fd);
  }
  chmodSync(intentPath, 0o600);
  return { path: intentPath, sha256 };
}

export async function runPortableExternalWorker(input: {
  workflowId: string;
  runId: string;
  stepId: string;
  sourceTrigger: string;
  idempotencyKey: string;
  approvalGranted: boolean;
  inputBundlePath?: string | null;
  readOnlyStage?: "candidate_supply" | "reference_readback" | "web_operation_read" | null;
  effectAuthority?: PortableExternalEffectAuthorityV1 | null;
  webOperationIntent?: Record<string, unknown> | null;
}): Promise<PortableExternalWorkerResult> {
  if (!input.approvalGranted) {
    return {
      status: "blocked",
      exactBlocker: PORTABLE_EXTERNAL_APPROVAL_REQUIRED,
      externalActionExecuted: false,
      stdoutTail: "",
      stderrTail: "",
      exitStatus: null,
      signal: null,
      response: null
    };
  }
  const command = resolvePortableExternalRunner();
  if (!command) {
    return {
      status: "blocked",
      exactBlocker: PORTABLE_EXTERNAL_ADAPTER_NOT_CONFIGURED,
      externalActionExecuted: false,
      stdoutTail: "",
      stderrTail: "",
      exitStatus: null,
      signal: null,
      response: null
    };
  }
  if (!isAbsolute(command) || !existsSync(command) || !statSync(command).isFile()) {
    return {
      status: "blocked",
      exactBlocker: PORTABLE_EXTERNAL_ADAPTER_INVALID,
      externalActionExecuted: false,
      stdoutTail: "",
      stderrTail: "",
      exitStatus: null,
      signal: null,
      response: null
    };
  }
  if (/(?:^|\/)portable-external-runner\.mjs$/u.test(command)) {
    return {
      status: "blocked",
      exactBlocker: PORTABLE_EXTERNAL_LEGACY_RUNNER_FORBIDDEN,
      externalActionExecuted: false,
      stdoutTail: "",
      stderrTail: "",
      exitStatus: null,
      signal: null,
      response: null
    };
  }

  let admission: { path: string; sha256: string };
  try {
    admission = issuePortableExternalAdmission(input);
  } catch {
    return {
      status: "blocked",
      exactBlocker: PORTABLE_EXTERNAL_ADMISSION_ISSUE_FAILED,
      externalActionExecuted: false,
      stdoutTail: "",
      stderrTail: "",
      exitStatus: null,
      signal: null,
      response: null
    };
  }

  let actionPlan: { path: string; sha256: string };
  try {
    actionPlan = issuePortableExternalActionPlan({
      workflowId: input.workflowId,
      runId: input.runId,
      stepId: input.stepId,
      sourceTrigger: input.sourceTrigger,
      idempotencyKey: input.idempotencyKey,
      inputBundlePath: input.inputBundlePath,
    });
  } catch {
    return {
      status: "blocked",
      exactBlocker: "portable_external_action_plan_issue_failed",
      externalActionExecuted: false,
      stdoutTail: "",
      stderrTail: "",
      exitStatus: null,
      signal: null,
      response: null,
      admissionPath: admission.path,
      admissionSha256: admission.sha256,
    };
  }

  let effectAuthorityFile: { path: string; sha256: string } | null = null;
  if (input.effectAuthority) {
    try {
      effectAuthorityFile = materializePortableExternalEffectAuthority({ runId: input.runId, authority: input.effectAuthority });
    } catch {
      return {
        status: "blocked",
        exactBlocker: PORTABLE_EXTERNAL_EFFECT_AUTHORITY_WRITE_FAILED,
        externalActionExecuted: false,
        stdoutTail: "",
        stderrTail: "",
        exitStatus: null,
        signal: null,
        response: null,
        admissionPath: admission.path,
        admissionSha256: admission.sha256,
        actionPlanPath: actionPlan.path,
        actionPlanSha256: actionPlan.sha256,
      };
    }
  }

  let webOperationIntentFile: { path: string; sha256: string } | null = null;
  const webOperationEffect = Boolean(input.webOperationIntent && String(input.webOperationIntent.operation || "") !== "read");
  if (input.webOperationIntent) {
    try {
      webOperationIntentFile = materializePortableWebOperationIntent({
        workflowId: input.workflowId,
        runId: input.runId,
        stepId: input.stepId,
        sourceTrigger: input.sourceTrigger,
        idempotencyKey: input.idempotencyKey,
        intent: input.webOperationIntent,
        authoritySha256: effectAuthorityFile?.sha256 || null,
      });
    } catch (error) {
      return {
        status: "blocked",
        exactBlocker: PORTABLE_EXTERNAL_WEB_OPERATION_INTENT_WRITE_FAILED,
        externalActionExecuted: false,
        stdoutTail: "",
        stderrTail: "",
        exitStatus: null,
        signal: null,
        response: null,
        admissionPath: admission.path,
        admissionSha256: admission.sha256,
        actionPlanPath: actionPlan.path,
        actionPlanSha256: actionPlan.sha256,
      };
    }
  }

  const args = [
    "--workflow-id", input.workflowId,
    "--run-id", input.runId,
    "--step-id", input.stepId,
    "--source-trigger", input.sourceTrigger,
    "--idempotency-key", input.idempotencyKey
  ];
  const child = spawn(command, args, {
    cwd: process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_WORKDIR?.trim() || process.cwd(),
    env: safeWorkerEnvironment(process.env, {
      overrides: {
        AUTOMATION_OS_PORTABLE_EXTERNAL_WORKFLOW_ID: input.workflowId,
        AUTOMATION_OS_PORTABLE_EXTERNAL_RUN_ID: input.runId,
        AUTOMATION_OS_PORTABLE_EXTERNAL_STEP_ID: input.stepId,
        AUTOMATION_OS_PORTABLE_EXTERNAL_SOURCE_TRIGGER: input.sourceTrigger,
        AUTOMATION_OS_PORTABLE_EXTERNAL_IDEMPOTENCY_KEY: input.idempotencyKey,
        AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_VERSION: "1",
        AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_PATH: admission.path,
        AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_SHA256: admission.sha256,
        AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_PATH: actionPlan.path,
        AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_SHA256: actionPlan.sha256,
        AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL: "approved",
        ...(effectAuthorityFile ? {
          AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_REQUIRED: "1",
          AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH: effectAuthorityFile.path,
          AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256: effectAuthorityFile.sha256,
          AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_ID: input.effectAuthority?.authority_id || "",
        } : {}),
        ...(input.readOnlyStage ? { AUTOMATION_OS_PORTABLE_EXTERNAL_READ_ONLY_STAGE: input.readOnlyStage } : {}),
        ...(input.inputBundlePath ? { AUTOMATION_OS_PORTABLE_EXTERNAL_INPUT_BUNDLE_PATH: input.inputBundlePath } : {}),
        ...(webOperationIntentFile ? {
          AUTOMATION_OS_PORTABLE_WEB_OPERATION_INTENT_PATH: webOperationIntentFile.path,
          AUTOMATION_OS_PORTABLE_WEB_OPERATION_INTENT_SHA256: webOperationIntentFile.sha256,
          AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS: webOperationEffect ? "enabled" : "read_only",
          ...(!webOperationEffect ? { AUTOMATION_OS_PORTABLE_EXTERNAL_READ_ONLY_STAGE: input.readOnlyStage || "web_operation_read" } : {}),
        } : {}),
        AUTOMATION_OS_WEB_OPERATION_CONTRACT_SCHEMA: "automation_os_web_operation_contract.v1",
        AUTOMATION_OS_WEB_OPERATION_ADAPTIVE: "semantic_live_state_bounded_exploration",
      }
    }),
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; processGroupCleanup: OwnedProcessGroupCleanup }>((resolve) => {
    let settled = false;
    let cleanupStarted = false;
    const finish = (value: { code: number | null; signal: NodeJS.Signals | null; timedOut: boolean; processGroupCleanup: OwnedProcessGroupCleanup }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const cleanup = (graceMs: number, timedOut: boolean, code: number | null, signal: NodeJS.Signals | null) => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      void cleanupOwnedProcessGroup(child, graceMs).then((processGroupCleanup) => {
        finish({ code: child.exitCode ?? code, signal: child.signalCode ?? signal, timedOut, processGroupCleanup });
      });
    };
    const timer = setTimeout(() => {
      cleanup(5_000, true, null, "SIGTERM");
    }, boundedTimeoutMs());
    child.once("error", () => {
      clearTimeout(timer);
      cleanup(1_000, false, null, null);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      cleanup(1_000, false, code, signal);
    });
  });
  const response = parseResponse(stdout);
  const externalActionExecuted = response?.external_action_executed === true;
  const responseStatus = response?.status === "complete" || response?.status === "partial" || response?.status === "blocked"
    ? response.status
    : null;
  const processGroupCleanupVerified = result.processGroupCleanup.verified === true;
  const exactBlocker = result.timedOut
    ? PORTABLE_EXTERNAL_WORKER_TIMEOUT
    : !processGroupCleanupVerified
      ? PORTABLE_EXTERNAL_PROCESS_GROUP_CLEANUP_UNVERIFIED
    : typeof response?.exact_blocker === "string" && response.exact_blocker.trim()
      ? response.exact_blocker
      : result.code === 0 && responseStatus
        ? null
        : "portable_external_worker_exit_nonzero";
  return {
    status: processGroupCleanupVerified ? (responseStatus ?? (result.code === 0 ? "partial" : "blocked")) : "blocked",
    exactBlocker,
    externalActionExecuted,
    stdoutTail: redactWorkerOutput(stdout),
    stderrTail: redactWorkerOutput(stderr),
    exitStatus: result.code,
    signal: result.signal,
    response,
    admissionPath: admission.path,
    admissionSha256: admission.sha256,
    actionPlanPath: actionPlan.path,
    actionPlanSha256: actionPlan.sha256,
    ...(webOperationIntentFile ? { webOperationIntentPath: webOperationIntentFile.path, webOperationIntentSha256: webOperationIntentFile.sha256 } : {}),
    processGroupCleanup: result.processGroupCleanup,
  };
}

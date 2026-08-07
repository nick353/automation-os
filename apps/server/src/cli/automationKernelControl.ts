import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
  compileAutomationKernelManifestV1,
  parseAutomationKernelManifestFileV1
} from "../automationKernel/manifestCompiler.js";
import {
  claimKernelEffect,
  ensureKernelDefinition,
  projectKernelReadback,
  recordKernelReceipt,
  writeKernelArtifact
} from "../automationKernel/repository.js";
import {
  assertAutomationKernelResultMatchesSnapshot,
  parseAutomationKernelResultV2
} from "../automationKernel/result.js";
import { hashAutomationKernelValue } from "../automationKernel/reducer.js";

type Action = "validate" | "compile" | "status" | "claim" | "record" | "result";
type Options = {
  action: Action;
  manifest: string;
  runId: string;
  root?: string;
  effectId?: string;
  outcome?: "succeeded" | "failed" | "ambiguous";
  externalActionExecuted?: boolean;
  summary?: string;
  evidenceFile?: string;
  resultFile?: string;
  selectedStages?: string[];
  approvalFile?: string;
  chromeCapabilityFile?: string;
  sessionId?: string;
  turnId?: string;
  promptSha256?: string;
  exactBlocker?: string;
  unitId?: string;
  attempt?: number;
  stageTerminal?: boolean;
  admissionFailed?: boolean;
};

const CHROME_STAGE_CAPABILITY = "/Users/nichikatanaka/.codex/scripts/chrome-stage-capability.mjs";
export const AUTOMATION_KERNEL_BROWSER_USE_CLI_REQUIRED = "automation_kernel_browser_use_cli_required";

export function runAutomationKernelControl(options: Options): Record<string, unknown> {
  const manifest = parseAutomationKernelManifestFileV1(options.manifest);
  const compiled = compileAutomationKernelManifestV1(manifest, options.runId, options.selectedStages);
  const base = {
    ok: true,
    action: options.action,
    workflow_id: compiled.workflow_id,
    run_id: compiled.run_id,
    kernel_id: compiled.kernel_id,
    manifest_sha256: compiled.manifest_sha256,
    stage_order: compiled.definition.effects.map((effect) => effect.effect_id),
    definition_hash: hashAutomationKernelValue(compiled.definition),
    external_action_executed: false
  };
  if (options.action === "validate") return base;

  const definition = ensureKernelDefinition({ definition: compiled.definition, root: options.root });
  if (options.action === "compile" || options.action === "status") {
    return { ...base, snapshot: projectKernelReadback({ kernelId: compiled.kernel_id, root: options.root }) };
  }
  if (options.action === "claim") {
    const beforeClaim = projectKernelReadback({ kernelId: compiled.kernel_id, root: options.root });
    const selectedEffectId = options.effectId ?? beforeClaim.next_effect_id;
    const selectedEffect = definition.effects.find((candidate) => candidate.effect_id === selectedEffectId);
    if (!selectedEffect) throw new Error("automation_kernel_effect_missing");
    if (selectedEffect.payload.browser_surface === "in_app_browser" || selectedEffect.payload.needs_chrome === true) {
      throw new Error(`${AUTOMATION_KERNEL_BROWSER_USE_CLI_REQUIRED}:${selectedEffect.effect_id}`);
    }
    const approval = selectedEffect.payload.approval_required === true
      ? validateAutomationKernelApprovalFile(options.approvalFile, {
          workflowId: compiled.workflow_id,
          runId: compiled.run_id,
          stageId: selectedEffect.effect_id,
          manifestSha256: compiled.manifest_sha256,
          sessionId: options.sessionId,
          turnId: options.turnId,
          promptSha256: options.promptSha256
        })
      : null;
    const claimed = claimKernelEffect({
      definition,
      root: options.root,
      effectId: options.effectId,
      claimedBy: "automation-kernel-control",
      createdAt: new Date().toISOString(),
      unitId: options.unitId
    });
    const artifactPath = writeKernelArtifact({
      kernelId: compiled.kernel_id,
      root: options.root,
      suffix: `claims/${claimed.timeline_entry.entry_hash}.json`,
      artifact: {
        schema: "automation_kernel_claim.v1",
        workflow_id: compiled.workflow_id,
        run_id: compiled.run_id,
        manifest_sha256: compiled.manifest_sha256,
        approval,
        timeline_entry: claimed.timeline_entry,
        snapshot: claimed.snapshot
      }
    });
    return { ...base, snapshot: claimed.snapshot, timeline_entry: claimed.timeline_entry, artifact_path: artifactPath };
  }
  if (options.action === "record") {
    if (!options.effectId || !options.outcome || !options.summary) throw new Error("automation_kernel_record_arguments_required");
    const effect = definition.effects.find((candidate) => candidate.effect_id === options.effectId);
    if (!effect) throw new Error("automation_kernel_effect_missing");
    const suppliedEvidence = options.evidenceFile
      ? parseJsonObject(readFileSync(resolve(options.evidenceFile), "utf8"), "automation_kernel_evidence_invalid")
      : {};
    const inAppBrowserStage = effect.payload.browser_surface === "in_app_browser";
    const legacyBrowserStage = inAppBrowserStage || effect.payload.needs_chrome === true;
    if (legacyBrowserStage && !options.admissionFailed) {
      throw new Error(`${AUTOMATION_KERNEL_BROWSER_USE_CLI_REQUIRED}:${effect.effect_id}`);
    }
    if (options.admissionFailed) {
      if ((!legacyBrowserStage)
        || options.outcome !== "failed"
        || options.externalActionExecuted === true) {
        throw new Error("automation_kernel_browser_admission_failure_invalid");
      }
      if (options.exactBlocker !== `${AUTOMATION_KERNEL_BROWSER_USE_CLI_REQUIRED}:${effect.effect_id}`) {
        throw new Error("automation_kernel_browser_use_cli_admission_exact_blocker_invalid");
      }
    }
    const chromeCapability = effect.payload.needs_chrome === true && !options.admissionFailed
      ? validateChromeStageCapabilityFile(options.chromeCapabilityFile, {
          workflowId: compiled.workflow_id,
          runId: compiled.run_id,
          stageId: effect.effect_id,
          unitId: options.unitId,
          attempt: options.attempt,
          manifestSha256: compiled.manifest_sha256,
          allowExpired: options.outcome !== "succeeded"
        })
      : null;
    const evidenceWithBlocker = options.exactBlocker
      ? { ...suppliedEvidence, exact_blocker: options.exactBlocker }
      : suppliedEvidence;
    if (inAppBrowserStage && options.outcome === "succeeded"
      && !String(evidenceWithBlocker.in_app_browser_capability_path || "").trim()) {
      throw new Error(`automation_kernel_in_app_browser_capability_evidence_required:${effect.effect_id}`);
    }
    const evidence = chromeCapability
      ? {
          ...evidenceWithBlocker,
          automation_kernel_chrome_capability: {
            schema: chromeCapability.schema,
            capability_path: chromeCapability.capability_path,
            capability_sha256: chromeCapability.capability_sha256,
            health_receipt_path: chromeCapability.health_receipt_path,
            health_receipt_sha256: chromeCapability.health_receipt_sha256,
            runtime_generation: chromeCapability.runtime_generation,
            runtime_input_fingerprint: chromeCapability.runtime_input_fingerprint,
            expires_at: chromeCapability.expires_at
          }
        }
      : evidenceWithBlocker;
    const recorded = recordKernelReceipt({
      kernelId: compiled.kernel_id,
      root: options.root,
      effectId: options.effectId,
      effectClass: effect.effect_class,
      outcome: options.outcome,
      externalActionExecuted: options.externalActionExecuted === true,
      summary: options.summary,
      evidence,
      createdAt: new Date().toISOString(),
      unitId: options.unitId,
      stageTerminal: options.stageTerminal
    });
    const artifactPath = writeKernelArtifact({
      kernelId: compiled.kernel_id,
      root: options.root,
      suffix: `receipts/${recorded.timeline_entry.entry_hash}.json`,
      artifact: {
        schema: "automation_kernel_stage_receipt.v1",
        workflow_id: compiled.workflow_id,
        run_id: compiled.run_id,
        manifest_sha256: compiled.manifest_sha256,
        timeline_entry: recorded.timeline_entry,
        snapshot: recorded.snapshot
      }
    });
    return {
      ...base,
      external_action_executed: options.externalActionExecuted === true,
      snapshot: recorded.snapshot,
      timeline_entry: recorded.timeline_entry,
      artifact_path: artifactPath
    };
  }
  if (!options.resultFile) throw new Error("automation_kernel_result_file_required");
  const result = parseAutomationKernelResultV2(JSON.parse(readFileSync(resolve(options.resultFile), "utf8")) as unknown);
  const snapshot = projectKernelReadback({ kernelId: compiled.kernel_id, root: options.root });
  assertAutomationKernelResultMatchesSnapshot(result, definition, snapshot);
  const resultHash = hashAutomationKernelValue(result);
  const artifactPath = writeKernelArtifact({
    kernelId: compiled.kernel_id,
    root: options.root,
    suffix: `results/${resultHash}.json`,
    artifact: result
  });
  return { ...base, terminal_result: result, snapshot, artifact_path: artifactPath };
}

function parseArgs(argv: string[]): Options {
  const [actionValue, ...rest] = argv;
  if (!new Set(["validate", "compile", "status", "claim", "record", "result"]).has(actionValue ?? "")) {
    throw new Error("automation_kernel_action_invalid");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (!arg.startsWith("--")) throw new Error(`automation_kernel_argument_invalid:${arg}`);
    const separator = arg.indexOf("=");
    if (separator > 2) {
      values.set(arg.slice(2, separator), arg.slice(separator + 1));
      continue;
    }
    const value = rest[++index];
    if (value === undefined) throw new Error(`automation_kernel_argument_value_missing:${arg}`);
    values.set(arg.slice(2), value);
  }
  const manifest = values.get("manifest");
  const runId = values.get("run-id");
  if (!manifest || !runId) throw new Error("automation_kernel_manifest_and_run_id_required");
  const outcome = values.get("outcome");
  if (outcome && outcome !== "succeeded" && outcome !== "failed" && outcome !== "ambiguous") {
    throw new Error("automation_kernel_outcome_invalid");
  }
  const external = values.get("external-action-executed");
  if (external && external !== "true" && external !== "false") throw new Error("automation_kernel_external_action_flag_invalid");
  const stageTerminal = values.get("stage-terminal");
  if (stageTerminal && stageTerminal !== "true" && stageTerminal !== "false") throw new Error("automation_kernel_stage_terminal_flag_invalid");
  const admissionFailed = values.get("admission-failed");
  if (admissionFailed && admissionFailed !== "true" && admissionFailed !== "false") throw new Error("automation_kernel_admission_failed_flag_invalid");
  const attempt = values.get("attempt") === undefined ? undefined : Number(values.get("attempt"));
  if (attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt < 1)) throw new Error("automation_kernel_attempt_invalid");
  return {
    action: actionValue as Action,
    manifest,
    runId,
    root: values.get("root"),
    effectId: values.get("effect-id"),
    outcome: outcome as Options["outcome"],
    externalActionExecuted: external === "true",
    summary: values.get("summary"),
    evidenceFile: values.get("evidence-file"),
    resultFile: values.get("result-file"),
    selectedStages: values.get("selected-stages")
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    approvalFile: values.get("approval-file"),
    chromeCapabilityFile: values.get("chrome-capability-file"),
    sessionId: values.get("session-id"),
    turnId: values.get("turn-id"),
    promptSha256: values.get("prompt-sha256"),
    exactBlocker: values.get("exact-blocker"),
    unitId: values.get("unit-id"),
    attempt,
    stageTerminal: stageTerminal === undefined ? undefined : stageTerminal === "true",
    admissionFailed: admissionFailed === "true"
  };
}

export function validateChromeStageCapabilityFile(
  file: string | undefined,
  expected: { workflowId: string; runId: string; stageId: string; unitId?: string; attempt?: number; manifestSha256: string; allowExpired: boolean }
): Record<string, unknown> {
  if (!file) throw new Error(`automation_kernel_chrome_stage_capability_required:${expected.stageId}`);
  const scriptStat = lstatSync(CHROME_STAGE_CAPABILITY);
  const uid = typeof process.getuid === "function" ? process.getuid() : scriptStat.uid;
  if (!scriptStat.isFile() || scriptStat.isSymbolicLink() || scriptStat.nlink !== 1 || scriptStat.uid !== uid || (scriptStat.mode & 0o022) !== 0) {
    throw new Error("automation_kernel_chrome_stage_capability_helper_invalid");
  }
  const checked = spawnSync(process.execPath, [
    CHROME_STAGE_CAPABILITY,
    "read",
    JSON.stringify({
      capabilityPath: resolve(file),
      workflowId: expected.workflowId,
      runId: expected.runId,
      stageId: expected.stageId,
      unitId: expected.unitId,
      attempt: expected.attempt,
      manifestSha256: expected.manifestSha256,
      allowExpired: expected.allowExpired,
      requireActive: true
    })
  ], { encoding: "utf8", timeout: 30_000 });
  const result = parseJsonObject(
    String(checked.stdout || "{}").trim() || "{}",
    "automation_kernel_chrome_stage_capability_readback_invalid"
  );
  if (checked.error || checked.status !== 0 || result.schema !== "chrome_stage_capability.v1") {
    throw new Error(String(result.exact_blocker || checked.error?.message || "automation_kernel_chrome_stage_capability_invalid"));
  }
  return result;
}

export function validateAutomationKernelApprovalFile(
  file: string | undefined,
  expected: {
    workflowId: string;
    runId: string;
    stageId: string;
    manifestSha256: string;
    sessionId?: string;
    turnId?: string;
    promptSha256?: string;
  }
): Record<string, unknown> {
  if (!file) throw new Error(`automation_kernel_stage_approval_required:${expected.stageId}`);
  const resolved = resolve(file);
  const stat = lstatSync(resolved);
  const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new Error("automation_kernel_approval_file_invalid");
  }
  const bytes = readFileSync(resolved);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (basename(resolved) !== `${digest}.json`) throw new Error("automation_kernel_approval_content_address_invalid");
  const approval = parseJsonObject(bytes.toString("utf8"), "automation_kernel_approval_json_invalid");
  const allowed = new Set([
    "schema", "workflow_id", "run_id", "stage_id", "manifest_sha256", "approved",
    "authorized_by", "session_id", "turn_id", "prompt_sha256", "issued_at", "expires_at"
  ]);
  if (Object.keys(approval).some((key) => !allowed.has(key))) throw new Error("automation_kernel_approval_unknown_field");
  if (approval.schema !== "automation_kernel_approval.v1" || approval.approved !== true || approval.authorized_by !== "current_user_turn") {
    throw new Error("automation_kernel_approval_invalid");
  }
  for (const [field, value] of [
    ["workflow_id", expected.workflowId],
    ["run_id", expected.runId],
    ["stage_id", expected.stageId],
    ["manifest_sha256", expected.manifestSha256]
  ]) {
    if (approval[field] !== value) throw new Error(`automation_kernel_approval_identity_mismatch:${field}`);
  }
  for (const field of ["session_id", "turn_id", "prompt_sha256", "issued_at", "expires_at"]) {
    if (typeof approval[field] !== "string" || !String(approval[field]).trim()) throw new Error(`automation_kernel_approval_field_missing:${field}`);
  }
  for (const [field, value] of [
    ["session_id", expected.sessionId],
    ["turn_id", expected.turnId],
    ["prompt_sha256", expected.promptSha256]
  ] as const) {
    if (!String(value || "").trim()) throw new Error(`automation_kernel_approval_current_binding_required:${field}`);
    if (approval[field] !== value) throw new Error(`automation_kernel_approval_current_binding_mismatch:${field}`);
  }
  const issuedAt = Date.parse(String(approval.issued_at));
  const expiresAt = Date.parse(String(approval.expires_at));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > Date.now() + 2_000 || expiresAt <= Date.now() || expiresAt - issuedAt > 300_000) {
    throw new Error("automation_kernel_approval_expiry_invalid");
  }
  return { ...approval, artifact_path: resolved, artifact_sha256: digest };
}

function parseJsonObject(text: string, code: string): Record<string, unknown> {
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  try {
    console.log(JSON.stringify(runAutomationKernelControl(parseArgs(process.argv.slice(2))), null, 2));
  } catch (error) {
    const exactBlocker = error instanceof Error ? error.message : "automation_kernel_unknown_error";
    console.error(JSON.stringify({ ok: false, exact_blocker: exactBlocker, external_action_executed: false }, null, 2));
    process.exitCode = 1;
  }
}

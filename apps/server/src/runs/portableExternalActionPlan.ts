import { constants, chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { getPortableExternalBusinessPlan } from "./portableExternalBusinessPlan.js";
import { getWebOperationContractForSurface } from "./webOperationContract.js";

export const PORTABLE_EXTERNAL_ACTION_PLAN_SCHEMA_V1 = "automation_os_portable_external_action_plan.v1" as const;
export const PORTABLE_EXTERNAL_ACTION_PLAN_ISSUE_FAILED = "portable_external_action_plan_issue_failed" as const;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeRunRoot(runId: string): string {
  if (!/^[A-Za-z0-9][-_A-Za-z0-9.:]{0,179}$/u.test(runId)) throw new Error("portable_external_action_plan_run_id_invalid");
  const artifactRoot = resolve(process.env.AUTOMATION_OS_ARTIFACT_ROOT?.trim() || resolve(process.cwd(), "data", "artifacts"));
  const runRoot = resolve(artifactRoot, runId);
  if (runRoot === artifactRoot || !runRoot.startsWith(`${artifactRoot}${sep}`)) throw new Error("portable_external_action_plan_run_path_invalid");
  return runRoot;
}

function bundleSha256(inputBundlePath: string | null | undefined, runRoot: string): string | null {
  const candidate = String(inputBundlePath || "").trim();
  if (!candidate) return null;
  const resolved = resolve(candidate);
  const expected = resolve(runRoot, "portable-input-bundle.v1.json");
  if (resolved !== expected || !existsSync(resolved)) throw new Error("portable_external_action_plan_input_bundle_path_invalid");
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw new Error("portable_external_action_plan_input_bundle_invalid");
  return sha256(readFileSync(resolved));
}

function writeImmutable(filePath: string, bytes: string): { path: string; sha256: string } {
  const digest = sha256(bytes);
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(filePath), 0o700);
  if (existsSync(filePath)) {
    const stat = lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || readFileSync(filePath, "utf8") !== bytes) throw new Error("portable_external_action_plan_immutable_collision");
    chmodSync(filePath, 0o600);
    return { path: filePath, sha256: digest };
  }
  const fd = openSync(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
  try {
    writeFileSync(fd, bytes, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(filePath, 0o600);
  return { path: filePath, sha256: digest };
}

export function issuePortableExternalActionPlan(input: {
  workflowId: string;
  runId: string;
  stepId: string;
  sourceTrigger: string;
  idempotencyKey: string;
  inputBundlePath?: string | null;
  webOperationBackend?: Record<string, unknown> | null;
}): { path: string; sha256: string } {
  const plan = getPortableExternalBusinessPlan(input.workflowId);
  if (!plan) throw new Error("portable_external_action_plan_workflow_invalid");
  const backend = String(input.webOperationBackend?.resolved_backend || input.webOperationBackend?.requested_backend || "aos_chrome_companion").trim();
  const profile = input.webOperationBackend?.chrome_profile && typeof input.webOperationBackend.chrome_profile === "object"
    ? input.webOperationBackend.chrome_profile as Record<string, unknown>
    : {};
  const browserSurface = backend === "aos_chrome_companion"
    ? "aos_chrome_companion_profile_instance"
    : backend === "chrome_plugin"
      ? String(profile.surface || "signed_chrome_extension_profile2")
      : backend;
  if (!new Set(["chrome_plugin", "browser_use_cli", "playwright", "aos_chrome_companion"]).has(backend)) {
    throw new Error(`portable_external_action_plan_backend_invalid:${backend || "empty"}`);
  }
  const webOperationContractSurface = backend === "aos_chrome_companion"
    ? "aos_chrome_companion_profile_instance"
    : backend === "chrome_plugin"
      ? "signed_chrome_extension_profile2"
      : backend === "browser_use_cli"
        ? "browser_use_cli"
        : null;
  if (!webOperationContractSurface) throw new Error(`portable_external_action_plan_backend_not_bound:${backend}`);
  const webOperationContract = getWebOperationContractForSurface(webOperationContractSurface);
  const runRoot = safeRunRoot(input.runId);
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  chmodSync(runRoot, 0o700);
  const now = Date.now();
  const existingPath = resolve(runRoot, "portable-external-action-plan.v1.json");
  if (existsSync(existingPath)) {
    const existingBytes = readFileSync(existingPath, "utf8");
    const existing = JSON.parse(existingBytes) as Record<string, unknown>;
    if (Date.parse(String(existing.expires_at || "")) <= now) throw new Error("portable_external_action_plan_expired");
    if (existing.schema !== PORTABLE_EXTERNAL_ACTION_PLAN_SCHEMA_V1
      || existing.workflow_id !== input.workflowId
      || existing.runner_key !== plan.runner_key
      || existing.run_id !== input.runId
      || existing.step_id !== input.stepId
      || existing.source_trigger !== input.sourceTrigger
      || existing.idempotency_key !== input.idempotencyKey
      || existing.approval_status !== "approved"
    || String(existing.web_operation_backend || "aos_chrome_companion") !== backend
    || Number(existing.web_operation_backend_revision || 1) !== Number(input.webOperationBackend?.revision || 1)
    || String(existing.browser_surface || "aos_chrome_companion_profile_instance") !== browserSurface
      || JSON.stringify(existing.web_operation_contract) !== JSON.stringify(webOperationContract)) {
      throw new Error("portable_external_action_plan_immutable_collision");
    }
    chmodSync(existingPath, 0o600);
    return { path: existingPath, sha256: sha256(existingBytes) };
  }
  const payload = {
    schema: PORTABLE_EXTERNAL_ACTION_PLAN_SCHEMA_V1,
    issued_by: "automation_os_worker",
    workflow_id: input.workflowId,
    runner_key: plan.runner_key,
    run_id: input.runId,
    step_id: input.stepId,
    source_trigger: input.sourceTrigger,
    idempotency_key: input.idempotencyKey,
    web_operation_backend: backend,
    web_operation_backend_revision: Number(input.webOperationBackend?.revision || 1),
    browser_surface: browserSurface,
    external_effect_policy: "approved",
    approval_status: "approved",
    allowed_stages: plan.stages,
    required_business_proofs: plan.required_business_proofs,
    web_operation_contract: webOperationContract,
    input_bundle_sha256: bundleSha256(input.inputBundlePath, runRoot),
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + Math.min(3_600_000, Math.max(1_000, Number(process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_TIMEOUT_MS || 900_000)))).toISOString(),
  };
  const bytes = `${JSON.stringify(payload, null, 2)}\n`;
  return writeImmutable(existingPath, bytes);
}

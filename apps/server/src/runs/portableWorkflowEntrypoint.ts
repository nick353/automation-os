import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { dbBackend, initDb, makeId, nowIso, querySqlAsync, runSqlTransactionAsync, sqlValue } from "../db/client.js";
import { createHash } from "node:crypto";
import { hashIdempotencyRequest } from "../automations/idempotency.js";
import {
  fixedRegisteredWorkflows,
  getRegisteredWorkflowAsync,
  getRegisteredWorkflowStartCommand,
  initRegisteredWorkflows,
  type RegisteredWorkflowRow
} from "../registeredWorkflows.js";
import { runWorkerOnce, startCommandRun } from "./workerEngine.js";
import { buildPortableWorkerExecutionRoutingSnapshot } from "../codex/executionRouting.js";
import { PORTABLE_EXECUTION_SOURCE } from "./portableWorkerIsolation.js";
import {
  PORTABLE_WORKER_CANARY_MODE,
  PORTABLE_WORKER_EXTERNAL_MODE,
  portableWorkflowIdForWorkerAdapter
} from "./portableWorkflowWorker.js";
import {
  type PortableTrigger,
  type PortableWorkflowId
} from "./portableWorkflowContract.js";
import {
  createRegisteredRootAdmissionV1,
  type RegisteredRootAdmissionV1
} from "./registeredRootAdmission.js";
import { portableExternalRunnerConfigured } from "./portableExternalRunnerConfig.js";
import { validatePortableBusinessInputBundle } from "./portableExternalBusinessPlan.js";
import { validateWebOperationIntent } from "./webOperationContract.js";

export type PortableWorkflowStartInput = {
  workflowId: PortableWorkflowId;
  sourceTrigger: PortableTrigger;
  idempotencyKey: string;
  /** The company-scoped registered automation that owns this run. */
  registeredAutomationId?: string;
  dueKey?: string;
  /** A workflow-owned, strictly read-only stage admission. */
  readOnlyStage?: "candidate_supply" | "reference_readback" | null;
  /** An explicit, run-bound business stage. Absent means no external effect claim. */
  effectStage?: PortableBusinessEffectStage | null;
  /**
   * Optional viewer/company scope for interactive starts. Global scheduler
   * starts intentionally omit it; App bridge starts must bind it so the run
   * is visible in the same company-scoped readback that accepted it.
   */
  companyId?: string | null;
  /**
   * Non-secret, run-scoped business input. The server writes this to the
   * current run artifact and also includes the validated data-only payload in
   * the run metadata so a Mac worker can materialize its own local copy when
   * the AOS API and worker do not share a filesystem. Browser credentials,
   * cookies, tokens, and arbitrary filesystem paths are intentionally not
   * accepted here.
   */
  inputBundle?: PortableWorkflowInputBundle | null;
  /** A run-bound, provider-neutral Web intent. Effectful intents require a target-bound approval. */
  webOperationIntent?: Record<string, unknown> | null;
};

export type PortableWorkflowInputBundle = {
  account_ref?: string;
  target_key?: string;
  payload_hash?: string;
  content_key?: string;
  product_key?: string;
  asset_manifest_id?: string;
  job_url?: string;
  application_url?: string;
  candidate_key?: string;
  bucket?: "japan_targeted" | "overseas_global";
  sequence?: number;
  attempt?: number;
  source_snapshot_id?: string;
  supply_run_id?: string;
  remaining?: number;
  margin?: number;
  company?: string;
  role?: string;
  target_digest?: string;
  source_state_digest?: string;
};

export type PortableBusinessEffectStage =
  | "one_candidate_submit"
  | "publish"
  | "business_execute"
  | "web_operation_effect";

export type PortableWorkflowStartResult = {
  runId: string;
  replayed: boolean;
  workflowId: PortableWorkflowId;
  sourceTrigger: PortableTrigger;
  idempotencyKey: string;
  executionMode: typeof PORTABLE_WORKER_CANARY_MODE | typeof PORTABLE_WORKER_EXTERNAL_MODE;
  status?: string;
  registeredRoot?: RegisteredRootAdmissionV1;
};

const portableTriggers = new Set<PortableTrigger>(["automation_os_scheduler", "automation_os_ui", "codex_app_bridge", "launchd", "github_actions"]);

export function isPortableWorkflowTrigger(value: string): value is PortableTrigger {
  return portableTriggers.has(value as PortableTrigger);
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function portableInvocationMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const value = metadata.portable_workflow_invocation;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

type PortableInvocationRow = {
  id: string;
  workflow_id: string;
  source_trigger: PortableTrigger;
  company_scope: string;
  company_id: string | null;
  idempotency_key: string;
  request_hash: string;
  status: "pending" | "completed";
  run_id: string | null;
};

type PortableInvocationReservation =
  | { kind: "owner"; reservationId: string }
  | { kind: "completed"; row: PortableInvocationRow };

const PORTABLE_GLOBAL_COMPANY_SCOPE = "__global__";
const PORTABLE_INVOCATION_WAIT_ATTEMPTS = 20;
const PORTABLE_INVOCATION_WAIT_MS = 100;

function normalizedCompanyId(input: PortableWorkflowStartInput): string | null {
  const value = typeof input.companyId === "string" ? input.companyId.trim() : input.companyId;
  return value || null;
}

function normalizedReadOnlyStage(input: PortableWorkflowStartInput): "candidate_supply" | "reference_readback" | null {
  const stage = input.readOnlyStage ?? null;
  if (stage === null) return null;
  if (input.workflowId === "job-application-manager" && stage === "candidate_supply") {
    return stage;
  }
  if ((input.workflowId === "daily-ai-research-publish-run"
    || input.workflowId === "nisenprints-daily-product-canva-printify-etsy-pinterest"
    || input.workflowId === "job-application-manager") && stage === "reference_readback") {
    return stage;
  }
  throw new Error("portable_read_only_stage_unsupported");
}

function normalizedEffectStage(input: PortableWorkflowStartInput): PortableBusinessEffectStage | null {
  const stage = input.effectStage ?? null;
  if (stage === null) return null;
  if (stage === "web_operation_effect") {
    const operation = input.webOperationIntent && typeof input.webOperationIntent === "object" && !Array.isArray(input.webOperationIntent)
      ? String((input.webOperationIntent as Record<string, unknown>).operation || "")
      : "";
    if (["create", "update", "publish", "submit", "delete"].includes(operation)) return stage;
    throw new Error("portable_web_operation_effect_stage_requires_effect_intent");
  }
  if (input.workflowId === "job-application-manager" && stage === "one_candidate_submit") return stage;
  if (input.workflowId === "daily-ai-research-publish-run" && stage === "publish") return stage;
  if (input.workflowId === "nisenprints-daily-product-canva-printify-etsy-pinterest" && stage === "business_execute") return stage;
  throw new Error("portable_business_effect_stage_unsupported");
}

const PORTABLE_INPUT_BUNDLE_KEYS = new Set<keyof PortableWorkflowInputBundle>([
  "account_ref", "target_key", "payload_hash", "content_key", "product_key", "asset_manifest_id",
  "job_url", "application_url", "candidate_key", "bucket", "sequence", "attempt",
  "source_snapshot_id", "supply_run_id", "remaining", "margin", "company", "role", "target_digest", "source_state_digest"
]);
const PORTABLE_INPUT_BUNDLE_SECRET_KEY = /(token|cookie|password|secret|authorization|storage[_-]?state|credential|profile[_-]?path)/iu;

function normalizedInputBundle(input: PortableWorkflowStartInput): PortableWorkflowInputBundle | null {
  if (input.inputBundle === undefined || input.inputBundle === null) return null;
  if (typeof input.inputBundle !== "object" || Array.isArray(input.inputBundle)) {
    throw new Error("portable_workflow_input_bundle_invalid");
  }
  const value = input.inputBundle as Record<string, unknown>;
  const output: PortableWorkflowInputBundle = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!PORTABLE_INPUT_BUNDLE_KEYS.has(key as keyof PortableWorkflowInputBundle) || PORTABLE_INPUT_BUNDLE_SECRET_KEY.test(key)) {
      throw new Error("portable_workflow_input_bundle_key_forbidden");
    }
    if (typeof raw === "string") {
      const normalized = raw.trim();
      if (normalized.length > 1000) throw new Error("portable_workflow_input_bundle_value_too_large");
      (output as Record<string, unknown>)[key] = normalized;
      continue;
    }
    if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) {
      (output as Record<string, unknown>)[key] = raw;
      continue;
    }
    throw new Error("portable_workflow_input_bundle_value_invalid");
  }
  if (output.bucket !== undefined && output.bucket !== "japan_targeted" && output.bucket !== "overseas_global") {
    throw new Error("portable_workflow_input_bundle_bucket_invalid");
  }
  for (const key of ["remaining", "margin"] as const) {
    if (output[key] !== undefined && (!Number.isSafeInteger(output[key]) || output[key] < 0 || output[key] > 20)) {
      throw new Error("portable_workflow_input_bundle_count_invalid");
    }
  }
  return output;
}

const PORTABLE_WEB_INTENT_SECRET_KEY = /(token|cookie|password|secret|authorization|storage[_-]?state|credential|profile[_-]?path|header|body|html)/iu;

function normalizedWebOperationIntent(input: PortableWorkflowStartInput): Record<string, unknown> | null {
  const raw = input.webOperationIntent;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("portable_web_operation_intent_invalid");
  for (const key of Object.keys(raw)) {
    if (PORTABLE_WEB_INTENT_SECRET_KEY.test(key)) throw new Error("portable_web_operation_intent_key_forbidden");
  }
  const candidate = {
    schema: "automation_os_web_operation_intent.v1",
    operation: raw.operation,
    run_id: "pending-run",
    step_id: "pending-step",
    idempotency_key: input.idempotencyKey,
    account_ref: raw.account_ref,
    allowed_origins: raw.allowed_origins,
    ...(raw.entry_url !== undefined ? { entry_url: raw.entry_url } : {}),
    target: raw.target,
    ...(raw.target_binding !== undefined ? { target_binding: raw.target_binding } : {}),
    ...(raw.action_plan !== undefined ? { action_plan: raw.action_plan } : {}),
    payload_hash: raw.payload_hash ?? null,
    approval_status: raw.approval_status ?? (raw.operation === "read" ? "not_required" : "pending"),
    authority_sha256: raw.authority_sha256 ?? null,
    readback_required: true,
    no_replay: true,
  };
  const validated = validateWebOperationIntent(candidate);
  return Object.freeze({
    schema: "automation_os_web_operation_intent.v1",
    browser_surface: "browser_use_cli",
    operation: validated.operation,
    account_ref: validated.account_ref,
    allowed_origins: [...validated.allowed_origins],
    ...(validated.entry_url ? { entry_url: validated.entry_url } : {}),
    target: { ...validated.target },
    ...(validated.target_binding ? { target_binding: { ...validated.target_binding } } : {}),
    ...(validated.action_plan ? { action_plan: validated.action_plan } : {}),
    payload_hash: validated.payload_hash,
    approval_status: validated.approval_status,
    authority_sha256: validated.authority_sha256,
    readback_required: true,
    no_replay: true,
  });
}

function validatePortableWebEffectInput(input: {
  intent: Record<string, unknown> | null;
  inputBundle: PortableWorkflowInputBundle | null;
  companyId: string | null;
}): void {
  if (!input.intent || String(input.intent.operation || "") === "read") throw new Error("portable_web_operation_effect_intent_missing");
  if (String(input.intent.approval_status || "") !== "approved" || !/^[a-f0-9]{64}$/u.test(String(input.intent.authority_sha256 || ""))) {
    throw new Error("portable_web_operation_effect_approval_required");
  }
  if (!input.companyId) throw new Error("portable_web_operation_effect_company_scope_missing");
  if (!input.inputBundle) throw new Error("portable_web_operation_effect_input_bundle_missing");
  const targetBinding = input.intent.target_binding && typeof input.intent.target_binding === "object" && !Array.isArray(input.intent.target_binding)
    ? input.intent.target_binding as Record<string, unknown>
    : {};
  if (!/^[a-f0-9]{64}$/u.test(String(input.inputBundle.target_digest || ""))
    || !/^[a-f0-9]{64}$/u.test(String(input.inputBundle.source_state_digest || ""))
    || String(input.inputBundle.target_digest) !== String(targetBinding.target_digest)
    || String(input.inputBundle.source_state_digest) !== String(targetBinding.source_state_digest)) {
    throw new Error("portable_web_operation_effect_target_binding_invalid");
  }
  if (!input.intent.action_plan || typeof input.intent.action_plan !== "object" || Array.isArray(input.intent.action_plan)) {
    throw new Error("portable_web_operation_effect_action_plan_missing");
  }
  if (String(input.inputBundle.account_ref || "") !== String(input.intent.account_ref || "")) {
    throw new Error("portable_web_operation_effect_account_binding_invalid");
  }
  if (String(input.inputBundle.payload_hash || "") !== String(input.intent.payload_hash || "")) {
    throw new Error("portable_web_operation_effect_payload_binding_invalid");
  }
}

function portableCompanyScope(companyId: string | null): string {
  return companyId ?? PORTABLE_GLOBAL_COMPANY_SCOPE;
}

function browserGoalIdFor(input: PortableWorkflowStartInput): string {
  return `aos-goal-${createHash("sha256").update(`${input.workflowId}:${input.sourceTrigger}:${input.idempotencyKey}`).digest("hex").slice(0, 32)}`;
}

function browserGoalStatePathFor(runId: string): string {
  const artifactRoot = resolve(process.env.AUTOMATION_OS_ARTIFACT_ROOT?.trim() || resolve(process.cwd(), "data", "artifacts"));
  return resolve(artifactRoot, runId, "browser-use-goal-kernel.v1.json");
}

function portableInvocationRequestHash(input: PortableWorkflowStartInput): string {
  const payload = {
    workflow_id: input.workflowId,
    source_trigger: input.sourceTrigger,
    company_id: normalizedCompanyId(input),
    due_key: input.dueKey ?? null,
    idempotency_key: input.idempotencyKey
  } as Record<string, unknown>;
  const readOnlyStage = normalizedReadOnlyStage(input);
  if (readOnlyStage) payload.read_only_stage = readOnlyStage;
  const effectStage = normalizedEffectStage(input);
  if (effectStage) payload.effect_stage = effectStage;
  const bundle = normalizedInputBundle(input);
  if (bundle) payload.input_bundle = bundle;
  const webOperationIntent = normalizedWebOperationIntent(input);
  if (webOperationIntent) payload.web_operation_intent = webOperationIntent;
  return hashIdempotencyRequest(payload);
}

function writePortableInputBundle(runId: string, workflowId: PortableWorkflowId, inputBundle: PortableWorkflowInputBundle | null): { path: string; sha256: string } | null {
  if (!inputBundle) return null;
  const artifactRoot = resolve(process.env.AUTOMATION_OS_ARTIFACT_ROOT?.trim() || resolve(process.cwd(), "data", "artifacts"));
  const runRoot = resolve(artifactRoot, runId);
  if (runRoot === artifactRoot || !runRoot.startsWith(`${artifactRoot}${sep}`)) throw new Error("portable_workflow_input_bundle_run_path_invalid");
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  chmodSync(runRoot, 0o700);
  const payload = {
    schema: "automation_os_portable_workflow_input_bundle.v1",
    workflow_id: workflowId,
    run_id: runId,
    input: inputBundle,
    created_at: nowIso()
  };
  const bytes = `${JSON.stringify(payload, null, 2)}\n`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const bundlePath = resolve(runRoot, "portable-input-bundle.v1.json");
  if (existsSync(bundlePath)) {
    const stat = lstatSync(bundlePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || readFileSync(bundlePath, "utf8") !== bytes) {
      throw new Error("portable_workflow_input_bundle_immutable_collision");
    }
    chmodSync(bundlePath, 0o600);
    return { path: bundlePath, sha256 };
  }
  const fd = openSync(bundlePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
  try {
    writeFileSync(fd, bytes, "utf8");
  } finally {
    closeSync(fd);
  }
  chmodSync(bundlePath, 0o600);
  return { path: bundlePath, sha256 };
}

async function readPortableInvocation(input: PortableWorkflowStartInput, requestHash: string): Promise<PortableInvocationRow | undefined> {
  const companyId = normalizedCompanyId(input);
  const row = (await querySqlAsync<PortableInvocationRow>(`
    SELECT id, workflow_id, source_trigger, company_scope, company_id, idempotency_key,
           request_hash, status, run_id
    FROM portable_workflow_invocations
    WHERE workflow_id=${sqlValue(input.workflowId)}
      AND source_trigger=${sqlValue(input.sourceTrigger)}
      AND company_scope=${sqlValue(portableCompanyScope(companyId))}
      AND idempotency_key=${sqlValue(input.idempotencyKey)}
    LIMIT 1
  `))[0];
  if (row && row.request_hash !== requestHash) {
    throw new Error("portable_workflow_invocation_payload_conflict");
  }
  return row;
}

function portableWorkerExecutionMode(): typeof PORTABLE_WORKER_CANARY_MODE | typeof PORTABLE_WORKER_EXTERNAL_MODE {
  return process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE?.trim() === PORTABLE_WORKER_CANARY_MODE
    ? PORTABLE_WORKER_CANARY_MODE
    : PORTABLE_WORKER_EXTERNAL_MODE;
}

function resultFromRun(
  input: PortableWorkflowStartInput,
  idempotencyKey: string,
  run: { id: string; status: string },
  replayed: boolean,
  registeredRoot?: RegisteredRootAdmissionV1
): PortableWorkflowStartResult {
  return {
    runId: run.id,
    replayed,
    workflowId: input.workflowId,
    sourceTrigger: input.sourceTrigger,
    idempotencyKey,
    executionMode: portableWorkerExecutionMode(),
    status: run.status,
    ...(registeredRoot ? { registeredRoot } : {})
  };
}

async function resultFromCompletedInvocation(input: PortableWorkflowStartInput, idempotencyKey: string, row: PortableInvocationRow): Promise<PortableWorkflowStartResult> {
  if (!row.run_id) throw new Error("portable_workflow_invocation_run_missing");
  const run = (await querySqlAsync<{ id: string; status: string }>(
    `SELECT id, status FROM runs WHERE id=${sqlValue(row.run_id)} LIMIT 1`
  ))[0];
  if (!run) throw new Error("portable_workflow_invocation_run_missing");
  return resultFromRun(input, idempotencyKey, run, true);
}

async function findExistingPortableRun(input: PortableWorkflowStartInput): Promise<{ id: string; status: string } | undefined> {
  const companyId = normalizedCompanyId(input);
  if (dbBackend === "postgres") {
    const companyPredicate = companyId ? `company_id=${sqlValue(companyId)}` : "company_id IS NULL";
    const readOnly = normalizedReadOnlyStage(input) ?? "";
    const effect = normalizedEffectStage(input) ?? "";
    const rows = await querySqlAsync<{ id: string; status: string }>(`
      SELECT id, status
      FROM runs
      WHERE execution_source=${sqlValue(PORTABLE_EXECUTION_SOURCE)}
        AND quarantined=0
        AND ${companyPredicate}
        AND metadata_json::jsonb #>> '{portable_workflow_invocation,workflow_id}'=${sqlValue(input.workflowId)}
        AND metadata_json::jsonb #>> '{portable_workflow_invocation,source_trigger}'=${sqlValue(input.sourceTrigger)}
        AND metadata_json::jsonb #>> '{portable_workflow_invocation,idempotency_key}'=${sqlValue(input.idempotencyKey)}
        AND COALESCE(metadata_json::jsonb #>> '{portable_workflow_invocation,read_only_stage}', '')=${sqlValue(readOnly)}
        AND COALESCE(metadata_json::jsonb #>> '{portable_workflow_invocation,effect_stage}', '')=${sqlValue(effect)}
        AND COALESCE(metadata_json::jsonb #>> '{registered_workflow_start,dueKey}', '')=${sqlValue(input.dueKey ?? "")}
      ORDER BY created_at DESC
      LIMIT 1
    `);
    return rows[0];
  }
  const rows = await querySqlAsync<{ id: string; status: string; company_id: string | null; metadata_json: string }>(`
    SELECT id, status, company_id, metadata_json
    FROM runs
    WHERE execution_source='${PORTABLE_EXECUTION_SOURCE}' AND quarantined=0
    ORDER BY created_at DESC
    LIMIT 500
  `);
  return rows.find((row) => {
    const invocation = portableInvocationMetadata(parseMetadata(row.metadata_json));
    const start = parseMetadata(row.metadata_json).registered_workflow_start;
    const startMetadata = start && typeof start === "object" && !Array.isArray(start)
      ? start as Record<string, unknown>
      : {};
    return invocation.workflow_id === input.workflowId
      && invocation.source_trigger === input.sourceTrigger
      && invocation.idempotency_key === input.idempotencyKey
      && (typeof invocation.read_only_stage === "string" ? invocation.read_only_stage : null) === normalizedReadOnlyStage(input)
      && (typeof invocation.effect_stage === "string" ? invocation.effect_stage : null) === normalizedEffectStage(input)
      && row.company_id === companyId
      && (typeof startMetadata.dueKey === "string" ? startMetadata.dueKey : null) === (input.dueKey ?? null);
  });
}

async function waitForPortableInvocation(input: PortableWorkflowStartInput, requestHash: string, initial: PortableInvocationRow): Promise<PortableInvocationRow | null> {
  let current: PortableInvocationRow | undefined = initial;
  for (let attempt = 0; attempt < PORTABLE_INVOCATION_WAIT_ATTEMPTS; attempt += 1) {
    if (current.status === "completed") return current;
    const existingRun = await findExistingPortableRun(input);
    if (existingRun) {
      await completePortableInvocation(current.id, existingRun.id, requestHash);
      return await readPortableInvocation(input, requestHash) ?? null;
    }
    await new Promise((resolve) => setTimeout(resolve, PORTABLE_INVOCATION_WAIT_MS));
    current = await readPortableInvocation(input, requestHash);
    if (!current) return null;
  }
  throw new Error("portable_workflow_invocation_pending");
}

async function reservePortableInvocation(input: PortableWorkflowStartInput, requestHash: string): Promise<PortableInvocationReservation> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await readPortableInvocation(input, requestHash);
    if (existing) {
      const resolved = await waitForPortableInvocation(input, requestHash, existing);
      if (resolved) {
        if (resolved.status !== "completed") throw new Error("portable_workflow_invocation_pending");
        return { kind: "completed", row: resolved };
      }
      continue;
    }
    const reservationId = makeId("portable_invocation");
    const companyId = normalizedCompanyId(input);
    try {
      await runSqlTransactionAsync([{
        sql: `INSERT INTO portable_workflow_invocations
              (id, workflow_id, source_trigger, company_scope, company_id, idempotency_key, request_hash, status, run_id, created_at, updated_at)
              VALUES (${sqlValue(reservationId)}, ${sqlValue(input.workflowId)}, ${sqlValue(input.sourceTrigger)},
                      ${sqlValue(portableCompanyScope(companyId))}, ${sqlValue(companyId)}, ${sqlValue(input.idempotencyKey)},
                      ${sqlValue(requestHash)}, 'pending', NULL, ${sqlValue(nowIso())}, ${sqlValue(nowIso())})`,
        expectChanges: 1
      }]);
      return { kind: "owner", reservationId };
    } catch (error) {
      const raced = await readPortableInvocation(input, requestHash);
      if (!raced) throw error;
      const resolved = await waitForPortableInvocation(input, requestHash, raced);
      if (resolved) {
        if (resolved.status !== "completed") throw new Error("portable_workflow_invocation_pending");
        return { kind: "completed", row: resolved };
      }
    }
  }
  throw new Error("portable_workflow_invocation_pending");
}

async function completePortableInvocation(reservationId: string, runId: string, requestHash: string): Promise<void> {
  await runSqlTransactionAsync([{
    sql: `UPDATE portable_workflow_invocations
          SET status='completed', run_id=${sqlValue(runId)}, updated_at=${sqlValue(nowIso())}
          WHERE id=${sqlValue(reservationId)} AND request_hash=${sqlValue(requestHash)} AND status='pending'`
  }]);
  if (dbBackend === "postgres") return;
  const row = (await querySqlAsync<{ status: string; run_id: string | null }>(`
    SELECT status, run_id
    FROM portable_workflow_invocations
    WHERE id=${sqlValue(reservationId)} AND request_hash=${sqlValue(requestHash)}
    LIMIT 1
  `))[0];
  if (!row) throw new Error("portable_workflow_invocation_missing");
  if (row.status !== "completed" || row.run_id !== runId) {
    throw new Error("portable_workflow_invocation_completion_conflict");
  }
}

async function releasePortableInvocation(reservationId: string): Promise<void> {
  await runSqlTransactionAsync([{
    sql: `DELETE FROM portable_workflow_invocations
          WHERE id=${sqlValue(reservationId)} AND status='pending'`
  }]);
}

async function getPortableRegisteredWorkflow(workflowId: PortableWorkflowId): Promise<RegisteredWorkflowRow> {
  // The fixed registration source is the authority for portable starts, but
  // test/CLI callers can enter this boundary before the normal server startup
  // seed has run.  Materialize the trusted definitions once at the boundary
  // instead of treating a missing derived row as a missing adapter.
  let workflow = await getRegisteredWorkflowAsync(workflowId);
  if (!workflow) {
    initRegisteredWorkflows();
    workflow = await getRegisteredWorkflowAsync(workflowId);
  }
  if (!workflow) throw new Error("portable_registered_workflow_missing");
  if (!fixedRegisteredWorkflows.some((fixed) => fixed.id === workflow.id && fixed.runnerKind === workflow.runner_kind)) {
    throw new Error("portable_registered_workflow_not_fixed");
  }
  if (workflow.company_id) throw new Error("portable_workflow_company_scope_unsupported");
  if (portableWorkflowIdForWorkerAdapter(workflow.runner_kind) !== workflowId) {
    throw new Error("portable_registered_runner_binding_mismatch");
  }
  return workflow;
}

export async function startPortableWorkflowRun(input: PortableWorkflowStartInput): Promise<PortableWorkflowStartResult> {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey) throw new Error("portable_idempotency_key_required");
  if (!isPortableWorkflowTrigger(input.sourceTrigger)) throw new Error("portable_source_trigger_invalid");
  initDb();
  const workflow = await getPortableRegisteredWorkflow(input.workflowId);
  const normalizedInput = {
    ...input,
    idempotencyKey,
    readOnlyStage: normalizedReadOnlyStage(input),
    effectStage: normalizedEffectStage(input),
  };
  const inputBundle = normalizedInputBundle(normalizedInput);
  const webOperationIntent = normalizedWebOperationIntent(normalizedInput);
  if (normalizedInput.effectStage) {
    if (normalizedInput.effectStage === "web_operation_effect") {
      validatePortableWebEffectInput({ intent: webOperationIntent, inputBundle, companyId: normalizedCompanyId(normalizedInput) });
    } else {
      const validation = validatePortableBusinessInputBundle(input.workflowId, inputBundle as Record<string, unknown> | null);
      if (!validation.ok) throw new Error(validation.exact_blocker);
    }
  }
  const requestHash = portableInvocationRequestHash(normalizedInput);
  const stored = await readPortableInvocation(normalizedInput, requestHash);
  if (stored?.status === "completed") return await resultFromCompletedInvocation(normalizedInput, idempotencyKey, stored);
  const existing = dbBackend === "postgres" ? undefined : await findExistingPortableRun(normalizedInput);
  if (existing) {
    return resultFromRun(normalizedInput, idempotencyKey, existing, true);
  }
  const command = normalizedInput.readOnlyStage === "candidate_supply"
    ? "Job Application Manager candidate supply read-only"
    : normalizedInput.readOnlyStage === "reference_readback"
      ? `${workflow.id} Browser Use CLI reference read-only preflight`
      : getRegisteredWorkflowStartCommand(workflow.id);
  if (!command) throw new Error("portable_registered_start_command_missing");
  const source = input.sourceTrigger === "automation_os_scheduler" ? "scheduler" as const : "manual" as const;
  // Fixed workflows are always handed to the portable external worker unless
  // canary is explicitly requested.  An unset server mode must not re-enable
  // the legacy per-workflow runner; the external worker still enforces its
  // approval and effect-policy gates before invoking Browser Use CLI.
  const portableWorkerMode = portableWorkerExecutionMode();
  const queuedAt = nowIso();
  const reservation = await reservePortableInvocation(normalizedInput, requestHash);
  if (reservation.kind === "completed") return resultFromCompletedInvocation(normalizedInput, idempotencyKey, reservation.row);
  const preassignedRunId = makeId("run");
  const registeredRoot = createRegisteredRootAdmissionV1({
    registeredAutomationId: input.registeredAutomationId ?? workflow.id,
    workflowId: input.workflowId,
    runId: preassignedRunId,
    sourceTrigger: input.sourceTrigger,
    definitionFingerprint: hashRegisteredWorkflowDefinition(workflow)
  });
  const browserGoalId = browserGoalIdFor(normalizedInput);
  const browserGoalStatePath = browserGoalStatePathFor(preassignedRunId);
  const persistedInputBundle = writePortableInputBundle(preassignedRunId, input.workflowId, inputBundle);
  let runCreated = false;
  try {
    const result = await startCommandRun(command, {
      runId: preassignedRunId,
      deferWorker: true,
      ...(input.companyId !== undefined ? { companyId: input.companyId } : {}),
      executionRouting: buildPortableWorkerExecutionRoutingSnapshot({
        command,
        source,
        workflowId: input.workflowId
      }),
      metadata: {
      ...(normalizedInput.readOnlyStage ? { read_only_stage: normalizedInput.readOnlyStage } : {}),
      registeredWorkflowId: workflow.id,
      registered_workflow_id: workflow.id,
      workflowId: workflow.id,
      workflow_id: workflow.id,
      registered_workflow_start: {
        source,
        runnerKind: workflow.runner_kind,
        workflow_id: workflow.id,
        definition_fingerprint: hashRegisteredWorkflowDefinition(workflow),
        schedule_fingerprint: hashRegisteredWorkflowSchedule(workflow),
        ...(input.dueKey ? { dueKey: input.dueKey } : {}),
        portable: true
      },
      portable_workflow_invocation: {
        schema: "automation_os_portable_workflow_invocation_v1",
        workflow_id: input.workflowId,
        source_trigger: input.sourceTrigger,
        registered_automation_id: registeredRoot.registered_automation_id,
        idempotency_key: idempotencyKey,
        browser_goal_id: browserGoalId,
        browser_goal_state_path: browserGoalStatePath,
        ...(normalizedInput.readOnlyStage ? { read_only_stage: normalizedInput.readOnlyStage } : {}),
        ...(normalizedInput.effectStage ? { effect_stage: normalizedInput.effectStage } : {}),
        ...(webOperationIntent ? { web_operation_intent: webOperationIntent } : {}),
        ...(persistedInputBundle ? { input_bundle_path: persistedInputBundle.path } : {}),
        app_dependency: false,
        external_action_executed: false
      },
      registered_root_admission: registeredRoot,
      ...(persistedInputBundle
        ? {
            portable_input_bundle: {
              schema: "automation_os_portable_workflow_input_bundle.v1",
              run_id: preassignedRunId,
              path: persistedInputBundle.path,
              sha256: persistedInputBundle.sha256,
              fields: Object.keys(inputBundle ?? {}),
              ...(inputBundle ? { input: inputBundle } : {})
            }
          }
        : {}),
      portable_worker: {
        ...(portableWorkerMode ? { mode: portableWorkerMode } : {}),
        workflow_id: workflow.id,
        ...(normalizedInput.readOnlyStage ? { read_only_stage: normalizedInput.readOnlyStage } : {}),
        ...(normalizedInput.effectStage ? { effect_stage: normalizedInput.effectStage } : {}),
        ...(webOperationIntent ? { web_operation_intent: webOperationIntent } : {}),
        browser_goal_id: browserGoalId,
        browser_goal_state_path: browserGoalStatePath,
        external_adapter_configured: portableExternalRunnerConfigured(),
        external_action_executed: false
      },
      worker_protocol: "mac_worker_polling_required",
      worker_mode: "queued_for_mac_worker",
      worker_loop: {
        status: "waiting_for_pickup",
        launchReason: "portable_workflow_entrypoint",
        queuedAt,
        requiredCommand: "npm run worker:loop:stored"
      },
      mac_worker: {
        status: "waiting_for_pickup",
        launchReason: "portable_workflow_entrypoint",
        queuedAt,
        requiredCommand: "npm run worker:loop:stored"
      }
      }
    });
    runCreated = true;
    if (normalizedInput.effectStage) {
      // Business runs need an AOS-owned, target-bound approval before the Mac
      // worker can claim them.  The worker engine is deliberately invoked only
      // for admission preparation here; portableRemoteBusinessMacWorkerRequired
      // keeps Browser Use execution on the Mac and leaves the run waiting for
      // the approved claim/receipt boundary.
      await runWorkerOnce(result.runId);
    }
    await completePortableInvocation(reservation.reservationId, result.runId, requestHash);
    const currentRun = dbBackend === "postgres"
      ? { id: result.runId, status: String(result.run.status ?? "queued") }
      : (await querySqlAsync<{ id: string; status: string }>(
          `SELECT id, status FROM runs WHERE id=${sqlValue(result.runId)} LIMIT 1`
        ))[0] ?? { id: result.runId, status: String(result.run.status ?? "queued") };
    return resultFromRun(normalizedInput, idempotencyKey, {
      id: currentRun.id,
      status: currentRun.status
    }, false, registeredRoot);
  } catch (error) {
    if (!runCreated && persistedInputBundle) {
      try {
        rmSync(persistedInputBundle.path, { force: true });
      } catch {
        // The database failure is the actionable error; leave cleanup to the
        // artifact audit if the local filesystem is concurrently unavailable.
      }
    }
    await releasePortableInvocation(reservation.reservationId);
    throw error;
  }
}

function hashRegisteredWorkflowDefinition(workflow: RegisteredWorkflowRow): string {
  return createHash("sha256").update(JSON.stringify({
    id: workflow.id,
    status: workflow.status,
    runner_kind: workflow.runner_kind,
    start_command_json: workflow.start_command_json,
    source_refs_json: workflow.source_refs_json,
    provenance_json: workflow.provenance_json
  })).digest("hex");
}

function hashRegisteredWorkflowSchedule(workflow: RegisteredWorkflowRow): string {
  return createHash("sha256").update(JSON.stringify({ schedule_json: workflow.schedule_json })).digest("hex");
}

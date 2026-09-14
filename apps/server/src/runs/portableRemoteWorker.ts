import { createHash } from "node:crypto";
import { dbBackend, execSql, execSqlAsync, insert, insertAsync, makeId, nowIso, querySql, querySqlAsync, runSqlTransaction, runSqlTransactionAsync, sqlValue, type SqlTransactionStep } from "../db/client.js";
import type { PortableBusinessEffectStage } from "./portableWorkflowEntrypoint.js";
import { getPortableExternalBusinessPlan, validatePortableBusinessInputBundle } from "./portableExternalBusinessPlan.js";
import { backupBusinessPayloadHash, isPortableLocalWorkflowId, obsidianBusinessPayloadHash } from "./portableLocalWorkflow.js";
import { DAILY_AI_RESEARCH_SYNC_WORKFLOW, DAILY_AI_RESEARCH_SYNC_SHEET, dailyAiResearchSyncBundleValid } from "./dailyAiResearchSourceSync.js";
import { normalizeGmailReviewResult } from "./gmailReviewResult.js";
import { syncTargetAdmissionFromReceipt, syncTargetAdmissionFromReceiptAsync } from "../jobApplications/targetAdmission.js";
import { listCompanyConnectionRefs } from "../automations/repository.js";
import {
  issuePortableExternalEffectAuthorityV1,
  validatePortableExternalEffectAuthorityV1,
  type PortableExternalEffectAuthorityV1
} from "./portableExternalEffectAuthority.js";
import {
  buildPortableExternalApprovalBinding,
  buildPortableTargetBoundApprovalReceipt,
  portableBusinessTargetDigest,
  portableExternalApprovalResourceLocks,
  validatePortableTargetBoundApprovalReceipt,
  type PortableTargetBoundApprovalReceiptV1
} from "./portableExternalApprovalBinding.js";
import {
  validateRegisteredRootAdmissionV1,
  type RegisteredRootAdmissionV1
} from "./registeredRootAdmission.js";

const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const ALLOWED_READ_ONLY_STAGES = new Set(["candidate_supply", "reference_readback"]);
const ALLOWED_EFFECT_STAGES = new Set(["one_candidate_submit", "publish", "business_execute"]);
const SECRET_KEY_PATTERN = /(token|cookie|password|secret|authorization|storage[_-]?state|credential|raw.?body|page.?body)/iu;
const READ_ONLY_PROOF_PENDING_BLOCKER = "portable_remote_read_only_business_completion_proof_pending";
const COMPANION_TASK_ID_PATTERN = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,179}$/u;
const PORTABLE_PREPARING_RECONCILIATION_AGE_MS = 10 * 60_000;
const PORTABLE_PREPARING_RECONCILIATION_BLOCKER = "portable_local_business_preparation_incomplete";
let backupFencingSequence = 0;
let backupEvidenceSaveBarrierForTests: (() => Promise<void>) | null = null;

export function setPortableBackupEvidenceSaveBarrierForTests(barrier: (() => Promise<void>) | null): void {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error("test_only_portable_backup_evidence_barrier");
  backupEvidenceSaveBarrierForTests = barrier;
}

function nextBackupFencingToken(): string {
  // The existing proofs.fencing_token column is PostgreSQL INTEGER.  Keep
  // the Backup-only wire value string-typed for the dedicated evidence
  // contract, but ensure its persisted representation is an integer.
  const base = Date.now() % 2_147_482_000;
  backupFencingSequence = (backupFencingSequence + 1) % 1000;
  return String(base + backupFencingSequence);
}

type PortableRemoteExecutionMode = "read_only" | "business_effect";
type PortableConnectorExecutionOwner = "zeabur_codex_app_server" | "mac_worker_explicit_connector_fallback";

export type PortableRemoteClaim = {
  run_id: string;
  company_id: string;
  workflow_id: string;
  step_id: string;
  source_trigger: string;
  idempotency_key: string;
  read_only_stage: "candidate_supply" | "reference_readback" | null;
  execution_mode: PortableRemoteExecutionMode;
  business_effect_stage: PortableBusinessEffectStage | null;
  approval_id: string | null;
  approval_receipt: PortableTargetBoundApprovalReceiptV1 | null;
  input_bundle: Record<string, unknown> | null;
  input_bundle_sha256: string | null;
  input_bundle_created_at: string | null;
  target_digest: string | null;
  effect_authority: PortableExternalEffectAuthorityV1 | null;
  task_id: string | null;
  worker_id: string;
  worker_instance_id: string | null;
  lease_expires_at: string;
  external_action_executed: false;
  browser_surface: "browser_use_cli" | "signed_chrome_extension_profile2" | "aos_chrome_companion_profile_instance";
  connector_execution_owner: PortableConnectorExecutionOwner;
  company_connection_verified: boolean;
  web_operation_backend: Record<string, unknown> | null;
  registered_root_admission: RegisteredRootAdmissionV1;
  evidence_only?: true;
  reconciliation_binding?: Record<string, unknown>;
};

export type PortableRemoteReceipt = {
  status: "complete" | "partial" | "blocked";
  exact_blocker: string | null;
  external_action_executed: boolean;
  browser_surface: "browser_use_cli" | "signed_chrome_extension_profile2" | "aos_chrome_companion_profile_instance" | "local_worker";
  connector_execution_owner: PortableConnectorExecutionOwner;
  workflow_id: string;
  run_id: string;
  step_id: string;
  cleanup_verified: boolean;
  readback_verified: boolean;
  effects_mode: PortableRemoteExecutionMode;
  read_only_stage_bound: boolean;
  business_effect_stage?: PortableBusinessEffectStage;
  same_run_receipt: boolean;
  business_proof_verified: boolean;
  read_only_proof_verified: boolean;
  target_digest?: string;
  external_executor_status: string;
  input_bundle_sha256?: string;
  adapter_result?: Record<string, unknown>;
  business_proofs?: Record<string, unknown>;
  same_run_source_sync?: boolean;
  web_operation_lifecycle?: Record<string, unknown>;
  approval_receipt?: PortableTargetBoundApprovalReceiptV1;
  effect_authority_id?: string;
  effect_authority_sha256?: string;
  safe_surface_handoff?: Record<string, unknown>;
  evidence_only?: boolean;
  new_effect?: boolean;
  provider_replayed?: boolean;
  reconciliation_binding?: Record<string, unknown>;
  original_timeout_receipt?: Record<string, unknown>;
  evidence?: Record<string, unknown>;
};

/** Backup post-effect recovery is evidence about an already-unknown effect,
 * not a normal business receipt. Keep its nullable effect state out of the
 * common worker receipt contract. */
export type PortableBackupEvidenceClaim = Omit<PortableRemoteClaim,
  "worker_instance_id" | "evidence_only" | "reconciliation_binding"> & {
  worker_instance_id: string;
  attempt_id: string;
  fencing_token: string;
  evidence_only: true;
  reconciliation_binding: Record<string, unknown>;
};

export type PortableBackupEvidenceReceipt = Omit<PortableRemoteReceipt,
  "external_action_executed" | "evidence_only" | "new_effect" | "provider_replayed"
  | "reconciliation_binding" | "original_timeout_receipt" | "evidence"> & {
  external_action_executed: boolean | null;
  evidence_only: true;
  new_effect: false;
  provider_replayed: false;
  reconciliation_binding: Record<string, unknown>;
  original_timeout_receipt: Record<string, unknown>;
  original_claim: Record<string, unknown>;
  evidence: Record<string, unknown>;
  raw_observations?: Record<string, unknown>;
  derived_completion_flags?: Record<string, boolean>;
  runner_receipt: Record<string, unknown>;
  business_completion_verified: boolean;
  attempt_id: string;
  fencing_token: string;
  artifact_uri?: string;
};

export type PortableBackupEvidenceRecordResult = {
  replayed: boolean;
  evidence_only: true;
  receipt: PortableBackupEvidenceReceipt;
  artifact_uri: string;
};

type RunRow = { id: string; company_id: string | null; status: string; metadata_json: string; created_at: string };
type StepRow = { id: string; name: string; status: string; lane_id: string | null; metadata_json: string };

const BACKUP_EVIDENCE_WORKFLOW = "daily-backup-safety-check";
const BACKUP_EVIDENCE_RECONCILIATION_SCHEMA = "aos.portable_backup_post_effect_reconciliation.v1";
const BACKUP_EVIDENCE_KEY = (runId: string) => `portable-backup-post-effect-${runId}`;

type PortableReceiptArtifact = {
  id: string;
  uri: string;
  contentText: string;
  checksumSha256: string;
  sizeBytes: number;
  createdAt: string;
};

function buildPortableReceiptArtifact(input: {
  companyId: string;
  workflowId: string;
  workerId: string;
  registeredRoot: RegisteredRootAdmissionV1;
  receipt: PortableRemoteReceipt | PortableBackupEvidenceReceipt;
  createdAt: string;
}): PortableReceiptArtifact {
  const artifact = {
    schema: "automation_os_portable_remote_worker_receipt.v1",
    ...input.receipt,
    worker_id: input.workerId,
    registered_root_id: input.registeredRoot.root_id,
    registered_root_digest: input.registeredRoot.root_digest,
    created_at: input.createdAt
  };
  const contentText = `${JSON.stringify(artifact, null, 2)}\n`;
  const checksumSha256 = createHash("sha256").update(contentText).digest("hex");
  const id = makeId("artifact");
  return {
    id,
    uri: `/api/v1/companies/${encodeURIComponent(input.companyId)}/artifacts/${encodeURIComponent(id)}`,
    contentText,
    checksumSha256,
    sizeBytes: Buffer.byteLength(contentText),
    createdAt: input.createdAt
  };
}

function portableReceiptArtifactInsertStep(input: {
  artifact: PortableReceiptArtifact;
  companyId: string;
  runId: string;
  stepId: string;
  workflowId: string;
  kind?: string;
  label?: string;
}): SqlTransactionStep {
  return {
    sql: `INSERT INTO run_artifacts
          (id, company_id, run_id, step_id, attempt_id, kind, label, mime_type, checksum_sha256, size_bytes, content_text, status, created_at, updated_at)
          VALUES (${sqlValue(input.artifact.id)}, ${sqlValue(input.companyId)}, ${sqlValue(input.runId)}, ${sqlValue(input.stepId)}, NULL,
                  ${sqlValue(input.kind ?? "portable_remote_worker_receipt")}, ${sqlValue(input.label ?? `${input.workflowId} remote Mac worker receipt`)}, 'application/json',
                  ${sqlValue(input.artifact.checksumSha256)}, ${input.artifact.sizeBytes}, ${sqlValue(input.artifact.contentText)}, 'available',
                  ${sqlValue(input.artifact.createdAt)}, ${sqlValue(input.artifact.createdAt)})`,
    expectChanges: 1
  };
}

export type PortableMacWorkerApprovalRecovery = {
  requeued: boolean;
  reason: string;
  approval_id?: string;
};

function parseRecord(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function workerId(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!WORKER_ID_PATTERN.test(normalized)) throw new Error("portable_remote_worker_id_invalid");
  return normalized;
}

function readOnlyStage(metadata: Record<string, unknown>): "candidate_supply" | "reference_readback" | null {
  const invocation = isObject(metadata.portable_workflow_invocation) ? metadata.portable_workflow_invocation : {};
  const worker = isObject(metadata.portable_worker) ? metadata.portable_worker : {};
  const value = invocation.read_only_stage ?? worker.read_only_stage ?? metadata.read_only_stage;
  return typeof value === "string" && ALLOWED_READ_ONLY_STAGES.has(value)
    ? value as "candidate_supply" | "reference_readback"
    : null;
}

function businessEffectStage(metadata: Record<string, unknown>): PortableBusinessEffectStage | null {
  const invocation = isObject(metadata.portable_workflow_invocation) ? metadata.portable_workflow_invocation : {};
  const worker = isObject(metadata.portable_worker) ? metadata.portable_worker : {};
  const value = invocation.effect_stage ?? worker.effect_stage ?? metadata.effect_stage;
  return typeof value === "string" && ALLOWED_EFFECT_STAGES.has(value)
    ? value as PortableBusinessEffectStage
    : null;
}

function workflowId(metadata: Record<string, unknown>): string {
  const invocation = isObject(metadata.portable_workflow_invocation) ? metadata.portable_workflow_invocation : {};
  const worker = isObject(metadata.portable_worker) ? metadata.portable_worker : {};
  const value = invocation.workflow_id ?? worker.workflow_id ?? metadata.workflow_id;
  return typeof value === "string" ? value.trim() : "";
}

function webOperationBackend(metadata: Record<string, unknown>): Record<string, unknown> | null {
  const raw = metadata.web_operation_backend;
  if (!isObject(raw)) return null;
  const requested = typeof raw.requested_backend === "string" ? raw.requested_backend : null;
  const resolved = typeof raw.resolved_backend === "string" ? raw.resolved_backend : null;
  const revision = Number.isSafeInteger(Number(raw.revision)) ? Number(raw.revision) : null;
  const source = typeof raw.source === "string" ? raw.source : null;
  const fallbackAllowed = typeof raw.fallback_allowed === "boolean" ? raw.fallback_allowed : null;
  const browserSurface = typeof raw.browser_surface === "string" ? raw.browser_surface : null;
  const profile = isObject(raw.chrome_profile) ? raw.chrome_profile : {};
  const profileId = typeof profile.id === "string" ? profile.id : null;
  const profileName = typeof profile.name === "string" ? profile.name : null;
  const profileDirectory = typeof profile.directory === "string" ? profile.directory : null;
  const profileSurface = typeof profile.surface === "string" ? profile.surface : null;
  return {
    ...(requested ? { requested_backend: requested } : {}),
    ...(resolved ? { resolved_backend: resolved } : {}),
    ...(revision !== null ? { revision } : {}),
    ...(source ? { source } : {}),
    ...(fallbackAllowed !== null ? { fallback_allowed: fallbackAllowed } : {}),
    ...(browserSurface ? { browser_surface: browserSurface } : {}),
    chrome_profile: {
      ...(profileId ? { id: profileId } : {}),
      ...(profileName ? { name: profileName } : {}),
      ...(profileDirectory ? { directory: profileDirectory } : {}),
      ...(profileSurface ? { surface: profileSurface } : {}),
    },
  };
}

function connectorExecutionOwner(metadata: Record<string, unknown>): PortableConnectorExecutionOwner {
  const invocation = isObject(metadata.portable_workflow_invocation) ? metadata.portable_workflow_invocation : {};
  const raw = metadata.connector_execution_owner ?? invocation.connector_execution_owner;
  return raw === "mac_worker_explicit_connector_fallback"
    ? "mac_worker_explicit_connector_fallback"
    : "zeabur_codex_app_server";
}

function companionTaskId(metadata: Record<string, unknown>): string | null {
  const invocation = isObject(metadata.portable_workflow_invocation) ? metadata.portable_workflow_invocation : {};
  const raw = metadata.companion_task_id ?? invocation.companion_task_id ?? invocation.task_id;
  const value = typeof raw === "string" ? raw.trim() : "";
  return COMPANION_TASK_ID_PATTERN.test(value) ? value : null;
}

function scheduledCompanionTaskId(runId: string): string {
  const candidate = `aos-scheduled-${runId.trim()}`;
  if (COMPANION_TASK_ID_PATTERN.test(candidate)) return candidate;
  return `aos-scheduled-${createHash("sha256").update(runId, "utf8").digest("hex")}`;
}

function browserSurfaceForBackend(backend: Record<string, unknown> | null): PortableRemoteClaim["browser_surface"] {
  const resolved = String(backend?.resolved_backend ?? backend?.requested_backend ?? "browser_use_cli");
  if (resolved === "chrome_plugin") {
    const surface = String(isObject(backend?.chrome_profile) ? backend?.chrome_profile.surface ?? "" : "");
    if (surface !== "signed_chrome_extension_profile2") throw new Error("portable_remote_chrome_profile_surface_invalid");
    return "signed_chrome_extension_profile2";
  }
  if (resolved === "aos_chrome_companion") return "aos_chrome_companion_profile_instance";
  if (resolved !== "browser_use_cli") throw new Error("portable_remote_web_operation_backend_invalid");
  return "browser_use_cli";
}

// Local Mac business adapters do not operate a browser.  Keep the approval
// and effect-authority contract on the neutral portable surface even when a
// stale/global web backend setting points at the Companion lane.
function portableBusinessBrowserSurface(metadata: Record<string, unknown>, workflow: string): PortableRemoteClaim["browser_surface"] {
  return isPortableLocalWorkflowId(workflow)
    ? "browser_use_cli"
    : browserSurfaceForBackend(webOperationBackend(metadata));
}

function registeredRootAdmission(run: RunRow, metadata: Record<string, unknown>, workflow: string): RegisteredRootAdmissionV1 {
  const value = metadata.registered_root_admission;
  const invocation = isObject(metadata.portable_workflow_invocation) ? metadata.portable_workflow_invocation : {};
  const registeredAutomationId = typeof invocation.registered_automation_id === "string"
    ? invocation.registered_automation_id
    : workflow;
  return validateRegisteredRootAdmissionV1(value, {
    registeredAutomationId,
    workflowId: workflow,
    runId: run.id
  });
}

function inputBundle(metadata: Record<string, unknown>): Record<string, unknown> | null {
  const bundle = isObject(metadata.portable_input_bundle) ? metadata.portable_input_bundle : {};
  const input = bundle.input;
  if (!isObject(input)) return null;
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_KEY_PATTERN.test(key)) throw new Error("portable_remote_input_bundle_secret_like_key");
    if (typeof value === "string" && value.length <= 1000) safe[key] = value;
    else if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) safe[key] = value;
    else throw new Error("portable_remote_input_bundle_invalid");
  }
  return safe;
}

function inputBundleSha256(metadata: Record<string, unknown>): string | null {
  const bundle = isObject(metadata.portable_input_bundle) ? metadata.portable_input_bundle : {};
  const value = bundle.sha256;
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value) ? value : null;
}

function inputBundleCreatedAt(metadata: Record<string, unknown>): string | null {
  const bundle = isObject(metadata.portable_input_bundle) ? metadata.portable_input_bundle : {};
  const value = bundle.created_at;
  return typeof value === "string" && value.trim() && Number.isFinite(Date.parse(value)) ? value : null;
}

function targetDigest(bundle: Record<string, unknown>): string {
  return portableBusinessTargetDigest(bundle);
}

function businessBundleReady(workflow: string, stage: PortableBusinessEffectStage, bundle: Record<string, unknown> | null): boolean {
  if (!bundle) return false;
  if (workflow === DAILY_AI_RESEARCH_SYNC_WORKFLOW) return stage === "business_execute" && dailyAiResearchSyncBundleValid(bundle);
  if (workflow === "daily-backup-safety-check") {
    return stage === "business_execute"
      && bundle.account_ref === "github:nick353/daily-workspace-backup"
      && bundle.target_key === "daily-workspace-backup:main"
      && bundle.payload_hash === backupBusinessPayloadHash()
      && typeof bundle.source_snapshot_id === "string"
      && bundle.source_snapshot_id.trim().length > 0;
  }
  if (workflow === "obsidian-project-memory-audit") {
    return stage === "business_execute"
      && bundle.account_ref === "github:nick353/obsidian-vault-backup"
      && bundle.target_key === "obsidian-vault-backup:main"
      && bundle.payload_hash === obsidianBusinessPayloadHash()
      && typeof bundle.source_snapshot_id === "string"
      && bundle.source_snapshot_id.trim().length > 0;
  }
  if (workflow === "job-application-manager" && stage !== "one_candidate_submit") return false;
  if (workflow === "daily-ai-research-publish-run" && stage !== "publish") return false;
  if (workflow === "nisenprints-daily-product-canva-printify-etsy-pinterest" && stage !== "business_execute") return false;
  if ((workflow === "sns-multi-poster-ukiyoe" || workflow === "x-authenticated-browser-lane") && stage !== "publish") return false;
  return validatePortableBusinessInputBundle(workflow, bundle).ok;
}

type ClaimAdmission = {
  executionMode: PortableRemoteExecutionMode;
  readOnlyStage: "candidate_supply" | "reference_readback" | null;
  businessEffectStage: PortableBusinessEffectStage | null;
  approvalId: string | null;
  approvalReceipt: PortableTargetBoundApprovalReceiptV1 | null;
  inputBundleSha256: string | null;
  targetDigest: string | null;
};

function idempotencyKey(metadata: Record<string, unknown>, runId: string, stepId: string): string {
  const invocation = isObject(metadata.portable_workflow_invocation) ? metadata.portable_workflow_invocation : {};
  return typeof invocation.idempotency_key === "string" && invocation.idempotency_key.trim()
    ? invocation.idempotency_key.trim()
    : `${runId}:${stepId}`;
}

function issueEffectAuthority(input: {
  run: RunRow;
  step: StepRow;
  metadata: Record<string, unknown>;
  workflow: string;
  admission: ClaimAdmission;
  leaseExpiresAt: string;
}): PortableExternalEffectAuthorityV1 | null {
  if (input.admission.executionMode !== "business_effect") return null;
  if (!input.admission.approvalId || !input.admission.inputBundleSha256 || !input.admission.targetDigest || !input.admission.businessEffectStage) {
    throw new Error("portable_effect_authority_inputs_missing");
  }
  const bundle = inputBundle(input.metadata);
  const payloadHash = bundle && typeof bundle.payload_hash === "string" && /^[a-f0-9]{64}$/u.test(bundle.payload_hash)
    ? bundle.payload_hash
    : "";
  if (!payloadHash) throw new Error("portable_effect_authority_payload_hash_missing");
  return issuePortableExternalEffectAuthorityV1({
    companyId: input.run.company_id || "",
    workflowId: input.workflow,
    runId: input.run.id,
    stepId: input.step.id,
    effectStage: input.admission.businessEffectStage,
    approvalId: input.admission.approvalId,
    idempotencyKey: idempotencyKey(input.metadata, input.run.id, input.step.id),
    targetDigest: input.admission.targetDigest,
    inputBundleSha256: input.admission.inputBundleSha256,
    payloadHash,
    browserSurface: portableBusinessBrowserSurface(input.metadata, input.workflow),
    leaseExpiresAt: input.leaseExpiresAt
  });
}

type PortableApprovalRow = {
  id: string;
  status: string;
  company_id: string | null;
  run_id: string | null;
  step_id: string | null;
  action_kind: string | null;
  policy_version: string | null;
  expires_at: string | null;
  decided_at: string | null;
  resource_locks_json: string;
};

function approvedBusinessAdmissionFromRows(input: {
  runId: string;
  companyId: string | null;
  workflow: string;
  bundleSha256: string;
  metadata: Record<string, unknown>;
  stepId: string;
}, rows: PortableApprovalRow[]): { id: string; receipt: PortableTargetBoundApprovalReceiptV1 } | null {
  const stepId = input.stepId.trim();
  if (!stepId || !input.companyId) return null;
  const invocation = isObject(input.metadata.portable_workflow_invocation) ? input.metadata.portable_workflow_invocation : {};
  const effectStage = typeof invocation.effect_stage === "string" ? invocation.effect_stage : "";
  const idempotencyKey = typeof invocation.idempotency_key === "string" ? invocation.idempotency_key : "";
  const bundle = inputBundle(input.metadata);
  if (!effectStage || !idempotencyKey || !bundle) return null;
  let binding;
  try {
    binding = buildPortableExternalApprovalBinding({
      companyId: input.companyId,
      workflowId: input.workflow,
      runId: input.runId,
      stepId,
      effectStage,
      idempotencyKey,
      inputBundleSha256: input.bundleSha256,
      inputBundle: bundle,
      browserSurface: portableBusinessBrowserSurface(input.metadata, input.workflow)
    });
  } catch {
    return null;
  }
  const locks = portableExternalApprovalResourceLocks({
    workflowId: input.workflow,
    inputBundleSha256: input.bundleSha256,
    targetDigest: binding.target_digest,
    idempotencyKey
  });
  for (const row of rows) {
    if (row.status !== "approved"
      || row.company_id !== input.companyId
      || row.run_id !== input.runId
      || row.step_id !== stepId
      || row.action_kind !== effectStage
      || row.policy_version !== "automation_os_portable_external_approval_binding.v1"
      || (row.expires_at && Date.parse(row.expires_at) <= Date.now())) continue;
    let list: unknown[] = [];
    try {
      const parsed = JSON.parse(row.resource_locks_json || "[]") as unknown;
      if (Array.isArray(parsed)) list = parsed;
    } catch { /* malformed approval locks are not eligible */ }
    if (!locks.every((lock) => list.includes(lock))) continue;
    const receipt = buildPortableTargetBoundApprovalReceipt({
      approvalId: row.id,
      approvalStatus: "approved",
      decidedAt: row.decided_at,
      binding
    });
    return { id: row.id, receipt };
  }
  return null;
}

function approvedBusinessAdmission(input: {
  runId: string;
  companyId: string | null;
  workflow: string;
  bundleSha256: string;
  metadata: Record<string, unknown>;
  stepId: string;
}): { id: string; receipt: PortableTargetBoundApprovalReceiptV1 } | null {
  const rows = querySql<PortableApprovalRow>(
    `SELECT id, status, company_id, run_id, step_id, action_kind, policy_version, expires_at, decided_at, resource_locks_json
       FROM approvals WHERE run_id=${sqlValue(input.runId)} ORDER BY created_at ASC`
  );
  return approvedBusinessAdmissionFromRows(input, rows);
}

async function approvedBusinessAdmissionAsync(input: {
  runId: string;
  companyId: string | null;
  workflow: string;
  bundleSha256: string;
  metadata: Record<string, unknown>;
  stepId: string;
}): Promise<{ id: string; receipt: PortableTargetBoundApprovalReceiptV1 } | null> {
  const rows = await querySqlAsync<PortableApprovalRow>(
    `SELECT id, status, company_id, run_id, step_id, action_kind, policy_version, expires_at, decided_at, resource_locks_json
       FROM approvals WHERE run_id=${sqlValue(input.runId)} ORDER BY created_at ASC`
  );
  return approvedBusinessAdmissionFromRows(input, rows);
}

async function approvedBusinessAdmissionFailureReasonAsync(input: {
  runId: string;
  companyId: string | null;
  workflow: string;
  bundleSha256: string;
  metadata: Record<string, unknown>;
  stepId: string;
}): Promise<string> {
  const approvalId = typeof input.metadata.approval_id === "string" ? input.metadata.approval_id.trim() : "";
  const row = (await querySqlAsync<PortableApprovalRow>(
    `SELECT id, status, company_id, run_id, step_id, action_kind, policy_version, expires_at, decided_at, resource_locks_json
       FROM approvals WHERE id=${sqlValue(approvalId)} AND run_id=${sqlValue(input.runId)} LIMIT 1`
  ))[0];
  if (!row) return "approval_row_not_found";
  if (row.status !== "approved") return `approval_row_status_${row.status || "missing"}`;
  if (row.company_id !== input.companyId) return "approval_row_company_mismatch";
  if (row.run_id !== input.runId) return "approval_row_run_mismatch";
  if (row.step_id !== input.stepId) return "approval_row_step_mismatch";
  const invocation = isObject(input.metadata.portable_workflow_invocation) ? input.metadata.portable_workflow_invocation : {};
  if (row.action_kind !== invocation.effect_stage) return "approval_row_action_mismatch";
  if (row.policy_version !== "automation_os_portable_external_approval_binding.v1") return "approval_row_policy_mismatch";
  if (!row.decided_at) return "approval_row_decision_time_missing";
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return "approval_row_expired";
  const bundle = inputBundle(input.metadata);
  const idempotencyKey = typeof invocation.idempotency_key === "string" ? invocation.idempotency_key : "";
  if (!bundle || !idempotencyKey || !input.companyId) return "approval_binding_input_missing";
  let binding;
  try {
    binding = buildPortableExternalApprovalBinding({
      companyId: input.companyId,
      workflowId: input.workflow,
      runId: input.runId,
      stepId: input.stepId,
      effectStage: typeof invocation.effect_stage === "string" ? invocation.effect_stage : "",
      idempotencyKey,
      inputBundleSha256: input.bundleSha256,
      inputBundle: bundle,
      browserSurface: portableBusinessBrowserSurface(input.metadata, input.workflow)
    });
  } catch {
    return "approval_binding_build_failed";
  }
  const locks = portableExternalApprovalResourceLocks({
    workflowId: input.workflow,
    inputBundleSha256: input.bundleSha256,
    targetDigest: binding.target_digest,
    idempotencyKey
  });
  let storedLocks: unknown[] = [];
  try {
    const parsed = JSON.parse(row.resource_locks_json || "[]") as unknown;
    if (Array.isArray(parsed)) storedLocks = parsed;
  } catch {
    return "approval_row_locks_invalid";
  }
  return locks.every((lock) => storedLocks.includes(lock)) ? "approval_row_contract_invalid" : "approval_row_lock_mismatch";
}

/**
 * Older PostgreSQL starts created the approval row before the target-bound
 * columns were added to the insert.  If the exact resource locks and same-run
 * target binding still match, repair only those missing columns after the
 * approval is already decided; any conflicting value fails closed.
 */
async function repairApprovedBusinessAdmissionAsync(input: {
  runId: string;
  companyId: string | null;
  workflow: string;
  bundleSha256: string;
  metadata: Record<string, unknown>;
  stepId: string;
}): Promise<"ok" | string> {
  if (!input.companyId) return "approval_company_missing";
  const invocation = isObject(input.metadata.portable_workflow_invocation) ? input.metadata.portable_workflow_invocation : {};
  const effectStage = typeof invocation.effect_stage === "string" ? invocation.effect_stage : "";
  const idempotencyKey = typeof invocation.idempotency_key === "string" ? invocation.idempotency_key : "";
  const bundle = inputBundle(input.metadata);
  const approvalId = typeof input.metadata.approval_id === "string" ? input.metadata.approval_id.trim() : "";
  if (!effectStage || !idempotencyKey || !bundle || !approvalId) return "approval_binding_input_missing";
  let binding;
  try {
    binding = buildPortableExternalApprovalBinding({
      companyId: input.companyId,
      workflowId: input.workflow,
      runId: input.runId,
      stepId: input.stepId,
      effectStage,
      idempotencyKey,
      inputBundleSha256: input.bundleSha256,
      inputBundle: bundle,
      browserSurface: portableBusinessBrowserSurface(input.metadata, input.workflow)
    });
  } catch {
    return "approval_binding_build_failed";
  }
  const locks = portableExternalApprovalResourceLocks({
    workflowId: input.workflow,
    inputBundleSha256: input.bundleSha256,
    targetDigest: binding.target_digest,
    idempotencyKey
  });
  const row = (await querySqlAsync<PortableApprovalRow & { target_account_ref_id: string | null; payload_hash: string | null }>(
    `SELECT id, status, company_id, run_id, step_id, action_kind, policy_version, expires_at, decided_at, resource_locks_json,
            target_account_ref_id, payload_hash
       FROM approvals WHERE id=${sqlValue(approvalId)} AND run_id=${sqlValue(input.runId)} LIMIT 1`
  ))[0];
  if (!row || row.status !== "approved" || row.company_id !== input.companyId || row.run_id !== input.runId) return "approval_row_not_same_run_approved";
  let storedLocks: unknown[] = [];
  try {
    const parsed = JSON.parse(row.resource_locks_json || "[]") as unknown;
    if (Array.isArray(parsed)) storedLocks = parsed;
  } catch {
    return "approval_row_locks_invalid";
  }
  const locksMatch = locks.every((lock) => storedLocks.includes(lock));
  const structuredFieldsEmpty = !row.step_id && !row.action_kind && !row.target_account_ref_id && !row.payload_hash && !row.policy_version;
  if (!locksMatch && !structuredFieldsEmpty) return "approval_row_lock_conflict";
  if (row.step_id && row.step_id !== input.stepId) return "approval_row_step_conflict";
  if (row.action_kind && row.action_kind !== effectStage) return "approval_row_action_conflict";
  if (row.policy_version && row.policy_version !== "automation_os_portable_external_approval_binding.v1") return "approval_row_policy_conflict";
  const accountRef = typeof bundle.account_ref === "string" ? bundle.account_ref : `company:${input.companyId}`;
  const payloadHash = typeof bundle.payload_hash === "string" && /^[a-f0-9]{64}$/u.test(bundle.payload_hash) ? bundle.payload_hash : null;
  if (row.target_account_ref_id && row.target_account_ref_id !== accountRef) return "approval_row_account_conflict";
  if (row.payload_hash && row.payload_hash !== payloadHash) return "approval_row_payload_conflict";
  // A repeated, explicit approval action is also the recovery point for a
  // same-run approval that expired while the worker was unavailable.  Keep
  // this narrow: the row must already be approved, same-run, target-bound,
  // lock-matching, and still effect-free (all checked above).  Do not create
  // a new approval or alter the target; only renew the exact approval lease
  // so the existing run can be requeued once.
  const approvalExpired = Boolean(row.expires_at && Date.parse(row.expires_at) <= Date.now());
  const expiresAt = approvalExpired || !row.expires_at
    ? new Date(Date.now() + 10 * 60_000).toISOString()
    : row.expires_at;
  await execSqlAsync(
    `UPDATE approvals SET step_id=${sqlValue(input.stepId)}, action_kind=${sqlValue(effectStage)},
            target_account_ref_id=${sqlValue(accountRef)}, payload_hash=${sqlValue(payloadHash)},
            policy_version=${sqlValue("automation_os_portable_external_approval_binding.v1")}, expires_at=${sqlValue(expiresAt)},
            resource_locks_json=${sqlValue(locks)}
       WHERE id=${sqlValue(row.id)} AND run_id=${sqlValue(input.runId)} AND company_id=${sqlValue(input.companyId)} AND status='approved'`
  );
  const confirmed = (await querySqlAsync<PortableApprovalRow>(
    `SELECT id, status, company_id, run_id, step_id, action_kind, policy_version, expires_at, decided_at, resource_locks_json
       FROM approvals WHERE id=${sqlValue(row.id)} AND run_id=${sqlValue(input.runId)} LIMIT 1`
  ))[0];
  let confirmedLocks: unknown[] = [];
  try {
    const parsed = JSON.parse(confirmed?.resource_locks_json || "[]") as unknown;
    if (Array.isArray(parsed)) confirmedLocks = parsed;
  } catch {
    return "approval_row_repair_readback_invalid";
  }
  return confirmed
    && confirmed.status === "approved"
    && confirmed.company_id === input.companyId
    && confirmed.run_id === input.runId
    && confirmed.step_id === input.stepId
    && confirmed.action_kind === effectStage
    && confirmed.policy_version === "automation_os_portable_external_approval_binding.v1"
    && locks.every((lock) => confirmedLocks.includes(lock))
    && confirmed.expires_at
    && Date.parse(confirmed.expires_at) > Date.now()
    ? "ok"
    : "approval_row_repair_not_confirmed";
}

/**
 * Restore a portable business run to the Mac worker queue after its exact,
 * target-bound approval is decided. Approval is still required here; this
 * helper only repairs the state transition that makes the approved run
 * claimable. It deliberately refuses read-only, local, legacy, terminal, or
 * already-effected runs.
 */
export function requeuePortableMacWorkerAfterApproval(runId: string): PortableMacWorkerApprovalRecovery {
  const run = querySql<RunRow & { execution_source: string }>(
    `SELECT id, company_id, status, metadata_json, created_at, execution_source FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`
  )[0];
  if (!run) return { requeued: false, reason: "run_not_found" };
  if (run.execution_source !== "automation-os") return { requeued: false, reason: "execution_source_not_portable" };
  if (!new Set(["blocked", "waiting_approval", "queued"]).has(run.status)) {
    return { requeued: false, reason: "run_not_recoverable" };
  }

  const metadata = parseRecord(run.metadata_json);
  if (metadata.worker_protocol !== "mac_worker_polling_required" || metadata.worker_mode !== "queued_for_mac_worker") {
    return { requeued: false, reason: "mac_worker_queue_binding_missing" };
  }
  if (metadata.external_action_executed === true) {
    return { requeued: false, reason: "external_effect_already_executed" };
  }
  const workflow = workflowId(metadata);
  const stage = businessEffectStage(metadata);
  const bundle = inputBundle(metadata);
  const bundleSha = inputBundleSha256(metadata);
  if (!workflow || !stage || !businessBundleReady(workflow, stage, bundle) || !bundleSha) {
    return { requeued: false, reason: "portable_business_admission_missing" };
  }
  const step = querySql<StepRow>(
    `SELECT id, name, status, lane_id, metadata_json FROM run_steps WHERE run_id=${sqlValue(runId)} AND status IN ('blocked', 'waiting_approval', 'queued') ORDER BY id ASC LIMIT 1`
  )[0];
  if (!step) return { requeued: false, reason: "claimable_step_missing" };
  const approval = approvedBusinessAdmission({
    runId,
    companyId: run.company_id,
    workflow,
    bundleSha256: bundleSha,
    metadata,
    stepId: step.id
  });
  if (!approval) return { requeued: false, reason: "approved_target_bound_lock_missing" };

  const now = nowIso();
  const stepMetadata = parseRecord(step.metadata_json);
  const runWorkerLoop = isObject(metadata.worker_loop) ? metadata.worker_loop : {};
  const runMacWorker = isObject(metadata.mac_worker) ? metadata.mac_worker : {};
  const nextRunMetadata = {
    ...metadata,
    exact_blocker: null,
    approval_status: "approved",
    approval_id: approval.id,
    portable_target_bound_approval_receipt: approval.receipt,
    external_action_executed: false,
    worker_loop: {
      ...runWorkerLoop,
      status: "waiting_for_pickup",
      launchReason: "approval_decided_requeued",
      queuedAt: now,
      approvalId: approval.id,
      requiredCommand: "npm run worker:loop:stored"
    },
    mac_worker: {
      ...runMacWorker,
      status: "waiting_for_pickup",
      launchReason: "approval_decided_requeued",
      queuedAt: now,
      approvalId: approval.id,
      requiredCommand: "npm run worker:loop:stored"
    }
  };
  const nextStepMetadata = {
    ...stepMetadata,
    exact_blocker: null,
    approval_status: "approved",
    approval_id: approval.id,
    portable_target_bound_approval_receipt: approval.receipt,
    worker_mode: "waiting_for_mac_worker",
    external_action_executed: false
  };

  execSql(
    `UPDATE runs SET status='queued', metadata_json=${sqlValue(nextRunMetadata)}, updated_at=${sqlValue(now)}
       WHERE id=${sqlValue(runId)} AND execution_source='automation-os' AND status IN ('blocked', 'waiting_approval', 'queued');
     UPDATE run_steps SET status='queued', started_at=NULL, completed_at=NULL, metadata_json=${sqlValue(nextStepMetadata)}
       WHERE id=${sqlValue(step.id)} AND status IN ('blocked', 'waiting_approval', 'queued');
     UPDATE lanes SET status='active', progress=0, health='good', current_task='waiting for Mac worker pickup', updated_at=${sqlValue(now)}
       WHERE id=${sqlValue(step.lane_id ?? "")};`
  );

  const confirmed = querySql<{ status: string; step_status: string }>(
    `SELECT runs.status, run_steps.status AS step_status FROM runs JOIN run_steps ON run_steps.run_id=runs.id
      WHERE runs.id=${sqlValue(runId)} AND run_steps.id=${sqlValue(step.id)} LIMIT 1`
  )[0];
  if (confirmed?.status !== "queued" || confirmed.step_status !== "queued") {
    return { requeued: false, reason: "approval_recovery_state_not_confirmed", approval_id: approval.id };
  }
  insert("worker_events", {
    id: makeId("evt"),
    company_id: run.company_id,
    run_id: runId,
    step_id: step.id,
    lane_id: step.lane_id,
    event_type: "approval_decided_requeued_for_mac_worker",
    message: "Approved portable business run requeued for Mac worker pickup",
    created_at: now,
    metadata_json: {
      workflow_id: workflow,
      effect_stage: stage,
      approval_id: approval.id,
      input_bundle_sha256: bundleSha,
      external_action_executed: false
    }
  });
  return { requeued: true, reason: "approval_decided_requeued", approval_id: approval.id };
}

/**
 * PostgreSQL-safe counterpart to the synchronous recovery above. Approval UI
 * requests use the async database boundary, so the recovery must use it too;
 * otherwise the durable approval row can become approved while the run's
 * target-bound receipt remains pending and invisible to the Mac worker claim.
 */
export async function requeuePortableMacWorkerAfterApprovalAsync(runId: string): Promise<PortableMacWorkerApprovalRecovery> {
  const run = (await querySqlAsync<RunRow & { execution_source: string }>(
    `SELECT id, company_id, status, metadata_json, created_at, execution_source FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`
  ))[0];
  if (!run) return { requeued: false, reason: "run_not_found" };
  if (run.execution_source !== "automation-os") return { requeued: false, reason: "execution_source_not_portable" };
  if (!new Set(["blocked", "waiting_approval", "queued"]).has(run.status)) {
    return { requeued: false, reason: "run_not_recoverable" };
  }

  const metadata = parseRecord(run.metadata_json);
  if (metadata.worker_protocol !== "mac_worker_polling_required" || metadata.worker_mode !== "queued_for_mac_worker") {
    return { requeued: false, reason: "mac_worker_queue_binding_missing" };
  }
  if (metadata.external_action_executed === true) {
    return { requeued: false, reason: "external_effect_already_executed" };
  }
  const workflow = workflowId(metadata);
  const stage = businessEffectStage(metadata);
  const bundle = inputBundle(metadata);
  const bundleSha = inputBundleSha256(metadata);
  if (!workflow || !stage || !businessBundleReady(workflow, stage, bundle) || !bundleSha) {
    return { requeued: false, reason: "portable_business_admission_missing" };
  }
  const step = (await querySqlAsync<StepRow>(
    `SELECT id, name, status, lane_id, metadata_json FROM run_steps WHERE run_id=${sqlValue(runId)} AND status IN ('blocked', 'waiting_approval', 'queued') ORDER BY id ASC LIMIT 1`
  ))[0];
  if (!step) return { requeued: false, reason: "claimable_step_missing" };
  const repairReason = await repairApprovedBusinessAdmissionAsync({
    runId,
    companyId: run.company_id,
    workflow,
    bundleSha256: bundleSha,
    metadata,
    stepId: step.id
  });
  if (repairReason !== "ok") return { requeued: false, reason: repairReason };
  const approval = await approvedBusinessAdmissionAsync({
    runId,
    companyId: run.company_id,
    workflow,
    bundleSha256: bundleSha,
    metadata,
    stepId: step.id
  });
  if (!approval) {
    return { requeued: false, reason: await approvedBusinessAdmissionFailureReasonAsync({ runId, companyId: run.company_id, workflow, bundleSha256: bundleSha, metadata, stepId: step.id }) };
  }

  const now = nowIso();
  const stepMetadata = parseRecord(step.metadata_json);
  const runWorkerLoop = isObject(metadata.worker_loop) ? metadata.worker_loop : {};
  const runMacWorker = isObject(metadata.mac_worker) ? metadata.mac_worker : {};
  const nextRunMetadata = {
    ...metadata,
    exact_blocker: null,
    approval_status: "approved",
    approval_id: approval.id,
    portable_target_bound_approval_receipt: approval.receipt,
    external_action_executed: false,
    worker_loop: {
      ...runWorkerLoop,
      status: "waiting_for_pickup",
      launchReason: "approval_decided_requeued",
      queuedAt: now,
      approvalId: approval.id,
      requiredCommand: "npm run worker:loop:stored"
    },
    mac_worker: {
      ...runMacWorker,
      status: "waiting_for_pickup",
      launchReason: "approval_decided_requeued",
      queuedAt: now,
      approvalId: approval.id,
      requiredCommand: "npm run worker:loop:stored"
    }
  };
  const nextStepMetadata = {
    ...stepMetadata,
    exact_blocker: null,
    approval_status: "approved",
    approval_id: approval.id,
    portable_target_bound_approval_receipt: approval.receipt,
    worker_mode: "waiting_for_mac_worker",
    external_action_executed: false
  };

  await runSqlTransactionAsync([
    {
      sql: `UPDATE runs SET status='queued', metadata_json=${sqlValue(nextRunMetadata)}, updated_at=${sqlValue(now)}
             WHERE id=${sqlValue(runId)} AND execution_source='automation-os' AND status IN ('blocked', 'waiting_approval', 'queued')`,
      expectChanges: 1
    },
    {
      sql: `UPDATE run_steps SET status='queued', started_at=NULL, completed_at=NULL, metadata_json=${sqlValue(nextStepMetadata)}
             WHERE id=${sqlValue(step.id)} AND status IN ('blocked', 'waiting_approval', 'queued')`,
      expectChanges: 1
    },
    {
      sql: `UPDATE lanes SET status='active', progress=0, health='good', current_task='waiting for Mac worker pickup', updated_at=${sqlValue(now)}
             WHERE id=${sqlValue(step.lane_id ?? "")}`
    }
  ]);

  const confirmed = (await querySqlAsync<{ status: string; step_status: string }>(
    `SELECT runs.status, run_steps.status AS step_status FROM runs JOIN run_steps ON run_steps.run_id=runs.id
      WHERE runs.id=${sqlValue(runId)} AND run_steps.id=${sqlValue(step.id)} LIMIT 1`
  ))[0];
  if (confirmed?.status !== "queued" || confirmed.step_status !== "queued") {
    return { requeued: false, reason: "approval_recovery_state_not_confirmed", approval_id: approval.id };
  }
  await runSqlTransactionAsync([{
    sql: `INSERT INTO worker_events
      (id, company_id, run_id, step_id, lane_id, event_type, message, created_at, metadata_json)
      VALUES (${sqlValue(makeId("evt"))}, ${sqlValue(run.company_id)}, ${sqlValue(runId)}, ${sqlValue(step.id)}, ${sqlValue(step.lane_id)},
              'approval_decided_requeued_for_mac_worker', 'Approved portable business run requeued for Mac worker pickup', ${sqlValue(now)},
              ${sqlValue({ workflow_id: workflow, effect_stage: stage, approval_id: approval.id, input_bundle_sha256: bundleSha, external_action_executed: false })})`,
    expectChanges: 1
  }]);
  return { requeued: true, reason: "approval_decided_requeued", approval_id: approval.id };
}

function claimAdmission(run: RunRow, metadata: Record<string, unknown>, workflow: string, stepId?: string): ClaimAdmission | null {
  const readOnly = readOnlyStage(metadata);
  if (readOnly) {
    // startPortableWorkflowRun persists the input artifact immediately after
    // the run row is created. Do not let a fast Mac poll claim the transient
    // row before the candidate-supply bundle and its digest are present.
    if (readOnly === "candidate_supply" && (!inputBundle(metadata) || !inputBundleSha256(metadata))) {
      return null;
    }
    return {
      executionMode: "read_only",
      readOnlyStage: readOnly,
      businessEffectStage: null,
      approvalId: null,
      approvalReceipt: null,
      inputBundleSha256: inputBundleSha256(metadata),
      targetDigest: null
    };
  }
  const stage = businessEffectStage(metadata);
  const bundle = inputBundle(metadata);
  const bundleSha = inputBundleSha256(metadata);
  if (!stage || !businessBundleReady(workflow, stage, bundle) || !bundleSha) {
    return null;
  }
  const approval = approvedBusinessAdmission({
    runId: run.id,
    companyId: run.company_id,
    workflow,
    bundleSha256: bundleSha,
    metadata,
    stepId: stepId || ""
  });
  if (!approval) {
    return null;
  }
  return {
    executionMode: "business_effect",
    readOnlyStage: null,
    businessEffectStage: stage,
    approvalId: approval.id,
    approvalReceipt: approval.receipt,
    inputBundleSha256: bundleSha,
    targetDigest: bundle ? targetDigest(bundle) : null
  };
}

async function claimAdmissionAsync(run: RunRow, metadata: Record<string, unknown>, workflow: string, stepId?: string): Promise<ClaimAdmission | null> {
  const readOnly = readOnlyStage(metadata);
  if (readOnly) {
    if (readOnly === "candidate_supply" && (!inputBundle(metadata) || !inputBundleSha256(metadata))) return null;
    return {
      executionMode: "read_only",
      readOnlyStage: readOnly,
      businessEffectStage: null,
      approvalId: null,
      approvalReceipt: null,
      inputBundleSha256: inputBundleSha256(metadata),
      targetDigest: null
    };
  }
  const stage = businessEffectStage(metadata);
  const bundle = inputBundle(metadata);
  const bundleSha = inputBundleSha256(metadata);
  if (!stage || !businessBundleReady(workflow, stage, bundle) || !bundleSha) return null;
  const approval = await approvedBusinessAdmissionAsync({
    runId: run.id,
    companyId: run.company_id,
    workflow,
    bundleSha256: bundleSha,
    metadata,
    stepId: stepId || ""
  });
  if (!approval) return null;
  return {
    executionMode: "business_effect",
    readOnlyStage: null,
    businessEffectStage: stage,
    approvalId: approval.id,
    approvalReceipt: approval.receipt,
    inputBundleSha256: bundleSha,
    targetDigest: bundle ? targetDigest(bundle) : null
  };
}

function reconcileUnboundCandidateSupply(run: RunRow, metadata: Record<string, unknown>): boolean {
  if (readOnlyStage(metadata) !== "candidate_supply") return false;
  let bundle: Record<string, unknown> | null;
  try {
    bundle = inputBundle(metadata);
  } catch {
    return false;
  }
  if (bundle && inputBundleSha256(metadata)) return false;
  const invocation = isObject(metadata.portable_workflow_invocation) ? metadata.portable_workflow_invocation : {};
  const worker = isObject(metadata.portable_worker) ? metadata.portable_worker : {};
  const timestamp = nowIso();
  const nextMetadata = {
    ...metadata,
    read_only_stage: "reference_readback",
    portable_workflow_invocation: { ...invocation, read_only_stage: "reference_readback" },
    portable_worker: { ...worker, read_only_stage: "reference_readback" },
    portable_read_only_stage_reconciled: true,
    portable_read_only_stage_reconciled_at: timestamp,
    worker_loop: { ...(isObject(metadata.worker_loop) ? metadata.worker_loop : {}), status: "waiting_for_pickup", readOnlyStageReconciledAt: timestamp },
    mac_worker: { ...(isObject(metadata.mac_worker) ? metadata.mac_worker : {}), status: "waiting_for_pickup", readOnlyStageReconciledAt: timestamp }
  };
  execSql(`UPDATE runs SET metadata_json=${sqlValue(nextMetadata)}, updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(run.id)} AND status IN ('queued', 'running', 'waiting_approval') AND metadata_json=${sqlValue(run.metadata_json)};`);
  return true;
}

function claimFromMetadata(input: { run: RunRow; step: StepRow; metadata: Record<string, unknown>; workerId: string; workerInstanceId?: string | null; leaseExpiresAt: string; admission: ClaimAdmission; registeredRoot: RegisteredRootAdmissionV1; effectAuthority?: PortableExternalEffectAuthorityV1 | null }): PortableRemoteClaim {
  const invocation = isObject(input.metadata.portable_workflow_invocation) ? input.metadata.portable_workflow_invocation : {};
  const sourceTrigger = typeof invocation.source_trigger === "string" ? invocation.source_trigger : "automation_os_scheduler";
  const key = typeof invocation.idempotency_key === "string" ? invocation.idempotency_key : `${input.run.id}:${input.step.id}`;
  const backend = webOperationBackend(input.metadata);
  const browserSurface = input.admission.executionMode === "business_effect"
    ? portableBusinessBrowserSurface(input.metadata, workflowId(input.metadata))
    : browserSurfaceForBackend(backend);
  return {
    run_id: input.run.id,
    company_id: input.run.company_id || "",
    workflow_id: workflowId(input.metadata),
    step_id: input.step.id,
    source_trigger: sourceTrigger,
    idempotency_key: key,
    read_only_stage: input.admission.readOnlyStage,
    execution_mode: input.admission.executionMode,
    business_effect_stage: input.admission.businessEffectStage,
    approval_id: input.admission.approvalId,
    approval_receipt: input.admission.approvalReceipt,
    input_bundle: inputBundle(input.metadata),
    input_bundle_sha256: input.admission.inputBundleSha256,
    input_bundle_created_at: inputBundleCreatedAt(input.metadata),
    target_digest: input.admission.targetDigest,
    effect_authority: input.effectAuthority ?? null,
    task_id: companionTaskId(input.metadata)
      ?? (browserSurface === "aos_chrome_companion_profile_instance" ? scheduledCompanionTaskId(input.run.id) : null),
    worker_id: input.workerId,
    worker_instance_id: input.workerInstanceId ?? null,
    lease_expires_at: input.leaseExpiresAt,
    external_action_executed: false,
    browser_surface: browserSurface,
    connector_execution_owner: connectorExecutionOwner(input.metadata),
    company_connection_verified: gmailCompanyConnectionVerified(input.run.company_id || ""),
    web_operation_backend: backend,
    registered_root_admission: input.registeredRoot
  };
}

function backupEvidenceClaimFromMetadata(input: {
  run: RunRow;
  step: StepRow;
  metadata: Record<string, unknown>;
  workerId: string;
  workerInstanceId: string | null;
  leaseExpiresAt: string;
  registeredRoot: RegisteredRootAdmissionV1;
  attemptId: string;
  fencingToken: string;
}): PortableBackupEvidenceClaim | null {
  const reconciliation = isObject(input.metadata.portable_post_effect_reconciliation)
    ? input.metadata.portable_post_effect_reconciliation : null;
  const originalClaim = isObject(input.metadata.remote_worker_claim) ? input.metadata.remote_worker_claim : null;
  const binding = reconciliation && isObject(reconciliation.original_claim) ? reconciliation.original_claim : null;
  if (!reconciliation || !originalClaim || !binding
    || reconciliation.schema !== BACKUP_EVIDENCE_RECONCILIATION_SCHEMA
    || !["queued", "blocked", "claimed"].includes(String(reconciliation.status))
    || reconciliation.original_run_id !== input.run.id
    || reconciliation.original_step_id !== input.step.id
    || originalClaim.run_id !== input.run.id || originalClaim.step_id !== input.step.id
    || originalClaim.workflow_id !== BACKUP_EVIDENCE_WORKFLOW
    || originalClaim.execution_mode !== "business_effect"
    || reconciliation.original_authority_id !== (isObject(originalClaim.portable_effect_authority) ? originalClaim.portable_effect_authority.authority_id : null)
    || typeof reconciliation.original_authority_sha256 !== "string"
    || input.metadata.remote_worker_receipt
    || input.metadata.external_action_executed === true) return null;
  if (!input.workerInstanceId) return null;
  const liveExpiry = Date.parse(String(reconciliation.lease_expires_at ?? ""));
  const active = reconciliation.status === "claimed" && Number.isFinite(liveExpiry) && liveExpiry > Date.now();
  if (active) {
    // A live evidence lease is fenced by both worker identity and instance.
    // A different process must wait; it may not adopt the lease by worker_id.
    if (reconciliation.worker_id !== input.workerId
      || reconciliation.worker_instance_id !== input.workerInstanceId) return null;
    if (typeof reconciliation.attempt_id !== "string" || typeof reconciliation.fencing_token !== "string") return null;
    input.attemptId = reconciliation.attempt_id;
    input.fencingToken = reconciliation.fencing_token;
    input.leaseExpiresAt = String(reconciliation.lease_expires_at);
  }
  const invocation = isObject(input.metadata.portable_workflow_invocation) ? input.metadata.portable_workflow_invocation : {};
  return {
    run_id: input.run.id,
    company_id: input.run.company_id || "",
    workflow_id: BACKUP_EVIDENCE_WORKFLOW,
    step_id: input.step.id,
    source_trigger: typeof invocation.source_trigger === "string" ? invocation.source_trigger : "owner_recovery_ui",
    idempotency_key: BACKUP_EVIDENCE_KEY(input.run.id),
    read_only_stage: null,
    execution_mode: "read_only",
    business_effect_stage: null,
    approval_id: null,
    approval_receipt: null,
    input_bundle: isObject(originalClaim.input_bundle) ? originalClaim.input_bundle : inputBundle(input.metadata),
    input_bundle_sha256: typeof originalClaim.input_bundle_sha256 === "string" ? originalClaim.input_bundle_sha256 : inputBundleSha256(input.metadata),
    input_bundle_created_at: typeof originalClaim.input_bundle_created_at === "string" ? originalClaim.input_bundle_created_at : inputBundleCreatedAt(input.metadata),
    target_digest: typeof originalClaim.target_digest === "string" ? originalClaim.target_digest : null,
    effect_authority: null,
    task_id: null,
    worker_id: input.workerId,
    worker_instance_id: input.workerInstanceId,
    attempt_id: input.attemptId,
    fencing_token: input.fencingToken,
    lease_expires_at: input.leaseExpiresAt,
    external_action_executed: false,
    browser_surface: "aos_chrome_companion_profile_instance",
    connector_execution_owner: "mac_worker_explicit_connector_fallback",
    company_connection_verified: false,
    web_operation_backend: null,
    registered_root_admission: input.registeredRoot,
    evidence_only: true,
    reconciliation_binding: { ...binding, original_timeout_artifact: reconciliation.original_timeout_artifact,
      original_authority_id: reconciliation.original_authority_id, original_authority_sha256: reconciliation.original_authority_sha256 }
  };
}

function reconciliationClaimUpdate(metadata: Record<string, unknown>, claim: PortableBackupEvidenceClaim, now: string) {
  const current = isObject(metadata.portable_post_effect_reconciliation) ? metadata.portable_post_effect_reconciliation : {};
  const currentAttempts = Array.isArray(current.attempts) ? current.attempts : [];
  const currentAttempt = isObject(currentAttempts[currentAttempts.length - 1]) ? currentAttempts[currentAttempts.length - 1] : null;
  const sameLiveAttempt = current.status === "claimed"
    && current.worker_id === claim.worker_id
    && current.worker_instance_id === claim.worker_instance_id
    && current.attempt_id === claim.attempt_id
    && current.fencing_token === claim.fencing_token;
  const attempts = sameLiveAttempt ? currentAttempts : [
    ...currentAttempts,
    ...(currentAttempt && currentAttempt.status === "claimed" ? [{ ...currentAttempt, status: "expired", expired_at: now }] : []),
    { attempt_id: claim.attempt_id, fencing_token: claim.fencing_token, worker_id: claim.worker_id,
      worker_instance_id: claim.worker_instance_id, claimed_at: now, lease_expires_at: claim.lease_expires_at,
      status: "claimed" }
  ];
  return { ...metadata, portable_post_effect_reconciliation: {
    ...current, status: "claimed", worker_id: claim.worker_id, worker_instance_id: claim.worker_instance_id,
    lease_expires_at: claim.lease_expires_at, claimed_at: sameLiveAttempt ? current.claimed_at : now,
    attempt_id: claim.attempt_id, fencing_token: claim.fencing_token, attempts,
    evidence_only: true, new_effect: false, provider_replayed: false
  } };
}

export function claimPortableBackupPostEffectReconciliation(input: { companyId: string; workerId: string; workerInstanceId?: string | null; requestedRunId?: string | null }): PortableBackupEvidenceClaim | null {
  const companyId = input.companyId.trim();
  const id = workerId(input.workerId);
  const instanceId = input.workerInstanceId ? workerId(input.workerInstanceId) : null;
  if (!instanceId) return null;
  const requested = input.requestedRunId?.trim() || null;
  const rows = querySql<RunRow>(`SELECT id, company_id, status, metadata_json, created_at FROM runs
    WHERE company_id=${sqlValue(companyId)} AND status IN ('blocked','failed','timed_out','running')
      ${requested ? `AND id=${sqlValue(requested)}` : ""} ORDER BY created_at ASC, id ASC LIMIT 100`);
  for (const run of rows) {
    const metadata = parseRecord(run.metadata_json);
    if (!isObject(metadata.portable_post_effect_reconciliation)) continue;
    const step = querySql<StepRow>(`SELECT id, name, status, lane_id, metadata_json FROM run_steps WHERE run_id=${sqlValue(run.id)} ORDER BY id ASC LIMIT 1`)[0];
    if (!step) continue;
    let root: RegisteredRootAdmissionV1;
    try { root = registeredRootAdmission(run, metadata, BACKUP_EVIDENCE_WORKFLOW); } catch { continue; }
    const leaseExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const candidate = backupEvidenceClaimFromMetadata({ run, step, metadata, workerId: id, workerInstanceId: instanceId,
      leaseExpiresAt, registeredRoot: root, attemptId: makeId("attempt"), fencingToken: nextBackupFencingToken() });
    if (!candidate) continue;
    const next = reconciliationClaimUpdate(metadata, candidate, nowIso());
    try {
      runSqlTransaction([{ sql: `UPDATE runs SET metadata_json=${sqlValue(next)}, updated_at=${sqlValue(nowIso())} WHERE id=${sqlValue(run.id)} AND company_id=${sqlValue(companyId)} AND metadata_json=${sqlValue(run.metadata_json)}`, expectChanges: 1 }]);
    } catch { continue; }
    const confirmed = querySql<RunRow>(`SELECT id, company_id, status, metadata_json, created_at FROM runs WHERE id=${sqlValue(run.id)} LIMIT 1`)[0];
    if (confirmed) {
      const confirmedClaim = backupEvidenceClaimFromMetadata({ run: confirmed, step, metadata: parseRecord(confirmed.metadata_json), workerId: id, workerInstanceId: instanceId,
        leaseExpiresAt, registeredRoot: root, attemptId: candidate.attempt_id, fencingToken: candidate.fencing_token });
      if (confirmedClaim) return confirmedClaim;
    }
  }
  return null;
}

export async function claimPortableBackupPostEffectReconciliationAsync(input: { companyId: string; workerId: string; workerInstanceId?: string | null; requestedRunId?: string | null }): Promise<PortableBackupEvidenceClaim | null> {
  const companyId = input.companyId.trim();
  const id = workerId(input.workerId);
  const instanceId = input.workerInstanceId ? workerId(input.workerInstanceId) : null;
  if (!instanceId) return null;
  const requested = input.requestedRunId?.trim() || null;
  const rows = await querySqlAsync<RunRow>(`SELECT id, company_id, status, metadata_json, created_at FROM runs
    WHERE company_id=${sqlValue(companyId)} AND status IN ('blocked','failed','timed_out','running')
      ${requested ? `AND id=${sqlValue(requested)}` : ""} ORDER BY created_at ASC, id ASC LIMIT 100`);
  for (const run of rows) {
    const metadata = parseRecord(run.metadata_json);
    if (!isObject(metadata.portable_post_effect_reconciliation)) continue;
    const step = (await querySqlAsync<StepRow>(`SELECT id, name, status, lane_id, metadata_json FROM run_steps WHERE run_id=${sqlValue(run.id)} ORDER BY id ASC LIMIT 1`))[0];
    if (!step) continue;
    let root: RegisteredRootAdmissionV1;
    try { root = registeredRootAdmission(run, metadata, BACKUP_EVIDENCE_WORKFLOW); } catch { continue; }
    const leaseExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const candidate = backupEvidenceClaimFromMetadata({ run, step, metadata, workerId: id, workerInstanceId: instanceId,
      leaseExpiresAt, registeredRoot: root, attemptId: makeId("attempt"), fencingToken: nextBackupFencingToken() });
    if (!candidate) continue;
    const now = nowIso();
    const next = reconciliationClaimUpdate(metadata, candidate, now);
    try {
      await runSqlTransactionAsync([{ sql: `UPDATE runs SET metadata_json=${sqlValue(next)}, updated_at=${sqlValue(now)} WHERE id=${sqlValue(run.id)} AND company_id=${sqlValue(companyId)} AND metadata_json=${sqlValue(run.metadata_json)}`, expectChanges: 1 }]);
    } catch { continue; }
    const confirmed = (await querySqlAsync<RunRow>(`SELECT id, company_id, status, metadata_json, created_at FROM runs WHERE id=${sqlValue(run.id)} LIMIT 1`))[0];
    if (confirmed) {
      const confirmedClaim = backupEvidenceClaimFromMetadata({ run: confirmed, step, metadata: parseRecord(confirmed.metadata_json), workerId: id, workerInstanceId: instanceId,
        leaseExpiresAt, registeredRoot: root, attemptId: candidate.attempt_id, fencingToken: candidate.fencing_token });
      if (confirmedClaim) return confirmedClaim;
    }
  }
  return null;
}

function gmailCompanyConnectionVerified(companyId: string): boolean {
  if (!companyId.trim()) return false;
  try {
    return listCompanyConnectionRefs(companyId).some((ref) => {
      const platform = ref.platform.trim().toLowerCase();
      return (platform === "gmail" || platform === "mail")
        && ref.status === "verified"
        && ref.verificationStatus === "verified"
        && ref.oauthState === "connected";
    });
  } catch {
    return false;
  }
}

/**
 * A worker receipt is terminal evidence for the portable lane. If an older
 * worker loop left the run in queued/running state after writing that
 * evidence, never reclaim it and never retry the external effect. Reconcile
 * no-effect receipts to a terminal blocked state so the queue can advance;
 * receipts that report an external effect stay visible for explicit proof
 * reconciliation and are skipped here.
 */
function reconcileExistingPortableWorkerReceipt(run: RunRow, metadata: Record<string, unknown>): boolean {
  const existing = isObject(metadata.remote_worker_receipt) ? metadata.remote_worker_receipt : null;
  if (!existing) return false;
  if (existing.external_action_executed === true) return true;

  // A verified read-only receipt is already a terminal success.  Older
  // reconciliation treated every no-effect receipt as blocked, which could
  // race a receipt write and leave a completed step under a blocked run.
  const verifiedReadOnlyReceipt = existing.status === "complete"
    && (existing.exact_blocker === null || existing.exact_blocker === undefined)
    && existing.read_only_proof_verified === true
    && existing.external_action_executed === false;
  if (verifiedReadOnlyReceipt) {
    const step = querySql<StepRow>(`
      SELECT id, name, status, lane_id, metadata_json
      FROM run_steps
      WHERE run_id=${sqlValue(run.id)} AND status IN ('queued', 'running', 'waiting_approval')
      ORDER BY id ASC LIMIT 1
    `)[0];
    const timestamp = nowIso();
    const workerLoop = isObject(metadata.worker_loop) ? metadata.worker_loop : {};
    const macWorker = isObject(metadata.mac_worker) ? metadata.mac_worker : {};
    const nextMetadata = {
      ...metadata,
      exact_blocker: null,
      external_action_executed: false,
      worker_loop: { ...workerLoop, status: "completed_readback", reconciledAt: timestamp },
      mac_worker: { ...macWorker, status: "completed_readback", reconciledAt: timestamp }
    };
    execSql(`UPDATE runs SET status='complete', metadata_json=${sqlValue(nextMetadata)}, updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(run.id)} AND status IN ('queued', 'running', 'waiting_approval');`);
    if (step) {
      execSql(`UPDATE run_steps SET status='completed', completed_at=${sqlValue(timestamp)}, metadata_json=${sqlValue({
        ...parseRecord(step.metadata_json),
        exact_blocker: null,
        external_action_executed: false,
        read_only_proof_verified: true,
        portable_remote_receipt_reconciled: true
      })} WHERE id=${sqlValue(step.id)} AND status IN ('queued', 'running', 'waiting_approval');`);
      if (step.lane_id) {
        execSql(`UPDATE lanes SET status='completed', progress=100, health='healthy', current_task='read-only receipt verified', updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(step.lane_id)};`);
      }
      insert("worker_events", {
        id: makeId("evt"),
        company_id: run.company_id,
        run_id: run.id,
        step_id: step.id,
        lane_id: step.lane_id,
        event_type: "portable_remote_receipt_reconciled_completed",
        message: "Verified read-only portable worker receipt preserved as terminal completion",
        created_at: timestamp,
        metadata_json: {
          exact_blocker: null,
          external_action_executed: false,
          receipt_status: "complete",
          read_only_proof_verified: true
        }
      });
    }
    return true;
  }

  const step = querySql<StepRow>(`
    SELECT id, name, status, lane_id, metadata_json
    FROM run_steps
    WHERE run_id=${sqlValue(run.id)} AND status IN ('queued', 'running', 'waiting_approval')
    ORDER BY id ASC LIMIT 1
  `)[0];
  const timestamp = nowIso();
  const exactBlocker = typeof existing.exact_blocker === "string" && existing.exact_blocker.trim()
    ? existing.exact_blocker.trim().slice(0, 240)
    : "portable_remote_receipt_already_recorded";
  const alreadyReconciled = metadata.portable_remote_receipt_reconciled === true;
  if (!alreadyReconciled) {
    const workerLoop = isObject(metadata.worker_loop) ? metadata.worker_loop : {};
    const macWorker = isObject(metadata.mac_worker) ? metadata.mac_worker : {};
    const nextMetadata = {
      ...metadata,
      exact_blocker: exactBlocker,
      external_action_executed: false,
      portable_remote_receipt_reconciled: true,
      portable_remote_receipt_reconciled_at: timestamp,
      worker_loop: { ...workerLoop, status: "reconciled_blocked_receipt", reconciledAt: timestamp },
      mac_worker: { ...macWorker, status: "reconciled_blocked_receipt", reconciledAt: timestamp }
    };
    execSql(`UPDATE runs SET status='blocked', metadata_json=${sqlValue(nextMetadata)}, updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(run.id)} AND status IN ('queued', 'running', 'waiting_approval');`);
    if (step) {
      execSql(`UPDATE run_steps SET status='blocked', completed_at=${sqlValue(timestamp)}, metadata_json=${sqlValue({
        ...parseRecord(step.metadata_json),
        exact_blocker: exactBlocker,
        external_action_executed: false,
        portable_remote_receipt_reconciled: true
      })} WHERE id=${sqlValue(step.id)} AND status IN ('queued', 'running', 'waiting_approval');`);
      if (step.lane_id) {
        execSql(`UPDATE lanes SET status='blocked', progress=50, health='blocked', current_task=${sqlValue(exactBlocker)}, updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(step.lane_id)};`);
      }
      insert("worker_events", {
        id: makeId("evt"),
        company_id: run.company_id,
        run_id: run.id,
        step_id: step.id,
        lane_id: step.lane_id,
        event_type: "portable_remote_receipt_reconciled",
        message: "Existing no-effect portable worker receipt reconciled; external retry suppressed",
        created_at: timestamp,
        metadata_json: {
          exact_blocker: exactBlocker,
          external_action_executed: false,
          receipt_status: typeof existing.status === "string" ? existing.status : "unknown",
          receipt_artifact_present: typeof existing.artifact_uri === "string" && existing.artifact_uri.length > 0
        }
      });
    }
  }
  return true;
}

/**
 * An expired claim without a receipt is not safe to replay.  This is the
 * recovery boundary for a worker that disappeared after claim admission: the
 * run is terminally blocked, but a missing business receipt is unknown, not
 * evidence of no effect. Only an explicitly read-only claim is effect-free.
 */
function expiredClaimEffectEvidence(claim: Record<string, unknown>, metadata: Record<string, unknown>, stepMetadata: Record<string, unknown>) {
  const positiveEffect = metadata.external_action_executed === true || stepMetadata.external_action_executed === true;
  const noEffect = !positiveEffect && claim.execution_mode === "read_only" && !businessEffectStage(metadata);
  return {
    external_action_executed: positiveEffect ? true : noEffect ? false : null,
    operation_effect_state: noEffect ? "none" : "unknown",
    reconciliation_required: !noEffect,
    no_replay: true,
    portable_remote_claim_reconciled: noEffect
  };
}

function reconcileExpiredPortableWorkerClaim(run: RunRow, metadata: Record<string, unknown>): boolean {
  const claim = isObject(metadata.remote_worker_claim) ? metadata.remote_worker_claim : null;
  if (!claim || typeof claim.lease_expires_at !== "string") return false;
  const leaseExpiresAt = Date.parse(claim.lease_expires_at);
  if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt > Date.now()) return false;
  const receipt = isObject(metadata.remote_worker_receipt) ? metadata.remote_worker_receipt : null;
  if (receipt) return true;

  const step = querySql<StepRow>(`
    SELECT id, name, status, lane_id, metadata_json
    FROM run_steps
    WHERE run_id=${sqlValue(run.id)} AND status IN ('queued', 'running', 'waiting_approval')
    ORDER BY id ASC LIMIT 1
  `)[0];
  const timestamp = nowIso();
  const exactBlocker = "portable_remote_claim_expired_without_receipt";
  const effectEvidence = expiredClaimEffectEvidence(claim, metadata, parseRecord(step?.metadata_json));
  const workerLoop = isObject(metadata.worker_loop) ? metadata.worker_loop : {};
  const macWorker = isObject(metadata.mac_worker) ? metadata.mac_worker : {};
  const nextMetadata = {
    ...metadata,
    exact_blocker: exactBlocker,
    ...effectEvidence,
    portable_remote_claim_reconciled_at: timestamp,
    worker_loop: { ...workerLoop, status: "expired_claim_blocked", reconciledAt: timestamp },
    mac_worker: { ...macWorker, status: "expired_claim_blocked", reconciledAt: timestamp }
  };
  execSql(`UPDATE runs SET status='blocked', metadata_json=${sqlValue(nextMetadata)}, updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(run.id)} AND status IN ('queued', 'running', 'waiting_approval');`);
  if (step) {
    execSql(`UPDATE run_steps SET status='blocked', completed_at=${sqlValue(timestamp)}, metadata_json=${sqlValue({
      ...parseRecord(step.metadata_json),
      exact_blocker: exactBlocker,
      ...effectEvidence
    })} WHERE id=${sqlValue(step.id)} AND status IN ('queued', 'running', 'waiting_approval');`);
    if (step.lane_id) {
      execSql(`UPDATE lanes SET status='blocked', progress=50, health='blocked', current_task=${sqlValue(exactBlocker)}, updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(step.lane_id)};`);
    }
    insert("worker_events", {
      id: makeId("evt"),
      company_id: run.company_id,
      run_id: run.id,
      step_id: step.id,
      lane_id: step.lane_id,
      event_type: "portable_remote_claim_expired_reconciled",
      message: "Expired portable worker claim blocked without replay; no receipt was recorded",
      created_at: timestamp,
      metadata_json: {
        exact_blocker: exactBlocker,
        ...effectEvidence,
        lease_expires_at: claim.lease_expires_at,
        receipt_present: false
      }
    });
  }
  // Only an explicit read-only claim can release a no-effect target gate.
  // Unknown business effects retain target ownership for reconciliation.
  if (effectEvidence.external_action_executed === false) syncTargetAdmissionFromReceipt({
    companyId: run.company_id ?? "",
    runId: run.id,
    status: "blocked",
    externalActionExecuted: false,
    sameRunSourceSync: false,
    readbackVerified: false,
    cleanupVerified: false
  });
  return true;
}

async function reconcileExpiredPortableWorkerClaimAsync(run: RunRow, metadata: Record<string, unknown>): Promise<boolean> {
  const claim = isObject(metadata.remote_worker_claim) ? metadata.remote_worker_claim : null;
  if (!claim || typeof claim.lease_expires_at !== "string") return false;
  const leaseExpiresAt = Date.parse(claim.lease_expires_at);
  if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt > Date.now()) return false;
  const receipt = isObject(metadata.remote_worker_receipt) ? metadata.remote_worker_receipt : null;
  if (receipt) return true;

  const step = (await querySqlAsync<StepRow>(`
    SELECT id, name, status, lane_id, metadata_json
    FROM run_steps
    WHERE run_id=${sqlValue(run.id)} AND status IN ('queued', 'running', 'waiting_approval')
    ORDER BY id ASC LIMIT 1
  `))[0];
  const timestamp = nowIso();
  const exactBlocker = "portable_remote_claim_expired_without_receipt";
  const effectEvidence = expiredClaimEffectEvidence(claim, metadata, parseRecord(step?.metadata_json));
  const workerLoop = isObject(metadata.worker_loop) ? metadata.worker_loop : {};
  const macWorker = isObject(metadata.mac_worker) ? metadata.mac_worker : {};
  const nextMetadata = {
    ...metadata,
    exact_blocker: exactBlocker,
    ...effectEvidence,
    portable_remote_claim_reconciled_at: timestamp,
    worker_loop: { ...workerLoop, status: "expired_claim_blocked", reconciledAt: timestamp },
    mac_worker: { ...macWorker, status: "expired_claim_blocked", reconciledAt: timestamp }
  };
  const steps: SqlTransactionStep[] = [{
    sql: `UPDATE runs SET status='blocked', metadata_json=${sqlValue(nextMetadata)}, updated_at=${sqlValue(timestamp)}
          WHERE id=${sqlValue(run.id)} AND status IN ('queued', 'running', 'waiting_approval')`,
    expectChanges: 1
  }];
  if (step) {
    steps.push({
      sql: `UPDATE run_steps SET status='blocked', completed_at=${sqlValue(timestamp)}, metadata_json=${sqlValue({
        ...parseRecord(step.metadata_json),
        exact_blocker: exactBlocker,
        ...effectEvidence
      })} WHERE id=${sqlValue(step.id)} AND status IN ('queued', 'running', 'waiting_approval')`
    });
    if (step.lane_id) {
      steps.push({
        sql: `UPDATE lanes SET status='blocked', progress=50, health='blocked', current_task=${sqlValue(exactBlocker)}, updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(step.lane_id)}`
      });
    }
    steps.push({
      sql: `INSERT INTO worker_events
        (id, company_id, run_id, step_id, lane_id, event_type, message, created_at, metadata_json)
        VALUES (${sqlValue(makeId("evt"))}, ${sqlValue(run.company_id)}, ${sqlValue(run.id)}, ${sqlValue(step.id)}, ${sqlValue(step.lane_id)},
                'portable_remote_claim_expired_reconciled', 'Expired portable worker claim blocked without replay; no receipt was recorded', ${sqlValue(timestamp)},
                ${sqlValue({ exact_blocker: exactBlocker, ...effectEvidence, lease_expires_at: claim.lease_expires_at, receipt_present: false })})`,
      expectChanges: 1
    });
  }
  await runSqlTransactionAsync(steps);
  if (effectEvidence.external_action_executed === false) await syncTargetAdmissionFromReceiptAsync({
    companyId: run.company_id ?? "",
    runId: run.id,
    status: "blocked",
    externalActionExecuted: false,
    sameRunSourceSync: false,
    readbackVerified: false,
    cleanupVerified: false
  });
  return true;
}

/**
 * An effectful PostgreSQL start is intentionally created as `preparing` while
 * its target-bound input bundle and approval row are assembled. If the HTTP
 * request dies in that narrow window, no worker can ever claim the row and it
 * would remain pending forever. After a bounded age, terminalize only the
 * exact no-effect shape: no approval, no worker claim, no receipt, and the
 * durable run flag still says that no external action occurred. A fresh
 * trigger must create a new idempotency lineage; this function never retries
 * or fabricates an approval.
 */
export async function reconcileStalePortablePreparingRunsAsync(input: {
  companyId: string;
  requestedRunId?: string | null;
  nowMs?: number;
  maxAgeMs?: number;
}): Promise<{ reconciled: number; run_ids: string[] }> {
  const companyId = input.companyId.trim();
  if (!companyId) throw new Error("company_id_required");
  const nowMs = Number.isFinite(input.nowMs) ? Number(input.nowMs) : Date.now();
  const maxAgeMs = Number.isFinite(input.maxAgeMs)
    ? Math.max(60_000, Number(input.maxAgeMs))
    : PORTABLE_PREPARING_RECONCILIATION_AGE_MS;
  const cutoff = new Date(nowMs - maxAgeMs).toISOString();
  const requested = input.requestedRunId?.trim() || null;
  const rows = await querySqlAsync<RunRow & { execution_source: string }>(`
    SELECT id, company_id, status, metadata_json, created_at, execution_source
    FROM runs
    WHERE status='preparing'
      AND execution_source='automation-os'
      AND quarantined=0
      AND company_id=${sqlValue(companyId)}
      AND created_at <= ${sqlValue(cutoff)}
      ${requested ? `AND id=${sqlValue(requested)}` : ""}
    ORDER BY created_at ASC, id ASC
    LIMIT 100
  `);
  const runIds: string[] = [];
  for (const run of rows) {
    const metadata = parseRecord(run.metadata_json);
    if (metadata.worker_protocol !== "mac_worker_polling_required"
      || metadata.worker_mode !== "queued_for_mac_worker"
      || metadata.external_action_executed === true
      || isObject(metadata.remote_worker_claim)
      || isObject(metadata.remote_worker_receipt)) continue;
    const workflow = workflowId(metadata);
    const stage = businessEffectStage(metadata);
    if (!workflow || !stage) continue;

    const approval = (await querySqlAsync<{ id: string }>(
      `SELECT id FROM approvals WHERE run_id=${sqlValue(run.id)} LIMIT 1`
    ))[0];
    if (approval) continue;

    const step = (await querySqlAsync<StepRow>(`
      SELECT id, name, status, lane_id, metadata_json
      FROM run_steps
      WHERE run_id=${sqlValue(run.id)} AND status='preparing'
      ORDER BY id ASC LIMIT 1
    `))[0];
    const timestamp = new Date(nowMs).toISOString();
    const runWorkerLoop = isObject(metadata.worker_loop) ? metadata.worker_loop : {};
    const runMacWorker = isObject(metadata.mac_worker) ? metadata.mac_worker : {};
    const nextMetadata = {
      ...metadata,
      exact_blocker: PORTABLE_PREPARING_RECONCILIATION_BLOCKER,
      external_action_executed: false,
      portable_preparation_reconciled: true,
      portable_preparation_reconciled_at: timestamp,
      portable_preparation_no_effect_verified: true,
      worker_loop: { ...runWorkerLoop, status: "preparation_incomplete_blocked", reconciledAt: timestamp },
      mac_worker: { ...runMacWorker, status: "preparation_incomplete_blocked", reconciledAt: timestamp },
    };
    const steps: SqlTransactionStep[] = [{
      sql: `UPDATE runs SET status='blocked', metadata_json=${sqlValue(nextMetadata)}, updated_at=${sqlValue(timestamp)}
            WHERE id=${sqlValue(run.id)} AND status='preparing' AND metadata_json=${sqlValue(run.metadata_json)}`,
      expectChanges: 1
    }];
    if (step) {
      steps.push({
        sql: `UPDATE run_steps SET status='blocked', completed_at=${sqlValue(timestamp)}, metadata_json=${sqlValue({
          ...parseRecord(step.metadata_json),
          exact_blocker: PORTABLE_PREPARING_RECONCILIATION_BLOCKER,
          external_action_executed: false,
          portable_preparation_reconciled: true,
          portable_preparation_no_effect_verified: true,
        })} WHERE id=${sqlValue(step.id)} AND status='preparing'`,
        expectChanges: 1
      });
      if (step.lane_id) {
        steps.push({
          sql: `UPDATE lanes SET status='blocked', progress=50, health='blocked', current_task=${sqlValue(PORTABLE_PREPARING_RECONCILIATION_BLOCKER)}, updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(step.lane_id)}`
        });
      }
      steps.push({
        sql: `INSERT INTO worker_events
          (id, company_id, run_id, step_id, lane_id, event_type, message, created_at, metadata_json)
          VALUES (${sqlValue(makeId("evt"))}, ${sqlValue(run.company_id)}, ${sqlValue(run.id)}, ${sqlValue(step.id)}, ${sqlValue(step.lane_id)},
                  'portable_local_preparation_reconciled', 'Stale portable business preparation blocked without replay; no approval or external effect existed', ${sqlValue(timestamp)},
                  ${sqlValue({
                    exact_blocker: PORTABLE_PREPARING_RECONCILIATION_BLOCKER,
                    workflow_id: workflow,
                    effect_stage: stage,
                    external_action_executed: false,
                    approval_present: false,
                    receipt_present: false,
                    preparation_age_ms: Math.max(0, nowMs - Date.parse(run.created_at)),
                  })})`,
        expectChanges: 1
      });
    }
    try {
      await runSqlTransactionAsync(steps);
    } catch (error) {
      // A concurrent preparation completion won the compare-and-set. Leave
      // that newer state untouched; the next poll will inspect it normally.
      if (error instanceof Error && error.message.startsWith("sql_transaction_expected_changes:")) continue;
      throw error;
    }
    try {
      await syncTargetAdmissionFromReceiptAsync({
        companyId: run.company_id ?? "",
        runId: run.id,
        status: "blocked",
        externalActionExecuted: false,
        sameRunSourceSync: false,
        readbackVerified: false,
        cleanupVerified: false
      });
    } catch {
      // This lineage has no target admission yet. The terminal run state is
      // authoritative; a missing optional ledger row must not strand the poll.
    }
    runIds.push(run.id);
  }
  return { reconciled: runIds.length, run_ids: runIds };
}

function registeredRootAdmissionBlocker(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^registered_root_admission_invalid:[A-Za-z0-9_:-]+$/u.test(message)
    ? message
    : "registered_root_admission_invalid";
}

/**
 * A queued run whose first-class root is missing, invalid, or expired can
 * never be claimed safely. Leaving it queued makes the UI report Pending
 * forever while every worker poll silently skips it. Reconcile only runs
 * that have no live worker claim, receipt, or observed external effect; a
 * fresh trigger must create a new root instead of replaying this lineage.
 */
function reconcileUnclaimableRegisteredRoot(
  run: RunRow,
  metadata: Record<string, unknown>,
  error: unknown,
): boolean {
  if (metadata.external_action_executed === true || isObject(metadata.remote_worker_receipt)) return false;
  const existingClaim = isObject(metadata.remote_worker_claim) ? metadata.remote_worker_claim : null;
  if (existingClaim && typeof existingClaim.lease_expires_at === "string") {
    const leaseExpiresAt = Date.parse(existingClaim.lease_expires_at);
    if (Number.isFinite(leaseExpiresAt) && leaseExpiresAt > Date.now()) return false;
  }

  const step = querySql<StepRow>(`
    SELECT id, name, status, lane_id, metadata_json
    FROM run_steps
    WHERE run_id=${sqlValue(run.id)} AND status IN ('queued', 'running', 'waiting_approval')
    ORDER BY id ASC LIMIT 1
  `)[0];
  const timestamp = nowIso();
  const exactBlocker = registeredRootAdmissionBlocker(error);
  const workerLoop = isObject(metadata.worker_loop) ? metadata.worker_loop : {};
  const macWorker = isObject(metadata.mac_worker) ? metadata.mac_worker : {};
  const nextMetadata = {
    ...metadata,
    exact_blocker: exactBlocker,
    external_action_executed: false,
    portable_registered_root_reconciled: true,
    portable_registered_root_reconciled_at: timestamp,
    worker_loop: { ...workerLoop, status: "unclaimable_registered_root_blocked", reconciledAt: timestamp },
    mac_worker: { ...macWorker, status: "unclaimable_registered_root_blocked", reconciledAt: timestamp },
  };
  execSql(`UPDATE runs SET status='blocked', metadata_json=${sqlValue(nextMetadata)}, updated_at=${sqlValue(timestamp)}
           WHERE id=${sqlValue(run.id)} AND status IN ('queued', 'running', 'waiting_approval')
             AND metadata_json=${sqlValue(run.metadata_json)};`);
  if (step) {
    execSql(`UPDATE run_steps SET status='blocked', completed_at=${sqlValue(timestamp)}, metadata_json=${sqlValue({
      ...parseRecord(step.metadata_json),
      exact_blocker: exactBlocker,
      external_action_executed: false,
      portable_registered_root_reconciled: true,
    })} WHERE id=${sqlValue(step.id)} AND status IN ('queued', 'running', 'waiting_approval');`);
    if (step.lane_id) {
      execSql(`UPDATE lanes SET status='blocked', progress=50, health='blocked', current_task=${sqlValue(exactBlocker)}, updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(step.lane_id)};`);
    }
    insert("worker_events", {
      id: makeId("evt"),
      company_id: run.company_id,
      run_id: run.id,
      step_id: step.id,
      lane_id: step.lane_id,
      event_type: "portable_remote_registered_root_reconciled",
      message: "Unclaimable registered root blocked without replay",
      created_at: timestamp,
      metadata_json: {
        exact_blocker: exactBlocker,
        external_action_executed: false,
        receipt_present: false,
      },
    });
  }
  syncTargetAdmissionFromReceipt({
    companyId: run.company_id ?? "",
    runId: run.id,
    status: "blocked",
    externalActionExecuted: false,
    sameRunSourceSync: false,
    readbackVerified: false,
    cleanupVerified: false,
  });
  return true;
}

export function claimPortableMacWorker(input: { companyId: string; workerId: string; workerInstanceId?: string | null; requestedRunId?: string | null }): PortableRemoteClaim | null {
  const companyId = input.companyId.trim();
  if (!companyId) throw new Error("company_id_required");
  const id = workerId(input.workerId);
  const instanceId = input.workerInstanceId ? workerId(input.workerInstanceId) : null;
  const requested = input.requestedRunId?.trim() || null;
  const rows = querySql<RunRow>(`
    SELECT id, company_id, status, metadata_json, created_at
    FROM runs
    WHERE status IN ('queued', 'running', 'waiting_approval')
      AND execution_source='automation-os'
      AND quarantined=0
      AND company_id=${sqlValue(companyId)}
      ${requested ? `AND id=${sqlValue(requested)}` : ""}
    ORDER BY created_at ASC, id ASC
    LIMIT 100
  `);
  for (const run of rows) {
    const metadata = parseRecord(run.metadata_json);
    if (metadata.worker_protocol !== "mac_worker_polling_required" || metadata.worker_mode !== "queued_for_mac_worker") {
      continue;
    }
    if (reconcileExistingPortableWorkerReceipt(run, metadata)) {
      continue;
    }
    if (reconcileExpiredPortableWorkerClaim(run, metadata)) {
      continue;
    }
    const workflow = workflowId(metadata);
    if (!workflow) continue;
    let registeredRoot: RegisteredRootAdmissionV1;
    try {
      registeredRoot = registeredRootAdmission(run, metadata, workflow);
    } catch (error) {
      // A run without a fresh AOS-owned root is never claimable. Do not
      // fabricate or replay a root for a historical run. Reconcile a
      // provably no-effect lineage so it cannot remain Pending forever; a
      // new trigger must create the next lineage.
      reconcileUnclaimableRegisteredRoot(run, metadata, error);
      continue;
    }
    if (reconcileUnboundCandidateSupply(run, metadata)) continue;
    const step = querySql<StepRow>(`
      SELECT id, name, status, lane_id, metadata_json
      FROM run_steps
      WHERE run_id=${sqlValue(run.id)} AND status IN ('queued', 'running', 'waiting_approval')
      ORDER BY id ASC LIMIT 1
    `)[0];
    if (!step) {
      continue;
    }
    const admission = claimAdmission(run, metadata, workflow, step.id);
    if (!admission) continue;
    const existingClaim = isObject(metadata.remote_worker_claim) ? metadata.remote_worker_claim : null;
    if (existingClaim && typeof existingClaim.lease_expires_at === "string" && Date.parse(existingClaim.lease_expires_at) > Date.now()) {
      if (existingClaim.worker_id !== id) continue;
      // A fresh worker process must never inherit a live claim from an older
      // process generation. The old worker may still be finishing an action;
      // let its lease/receipt boundary decide the outcome instead of replaying.
      if (instanceId && existingClaim.worker_instance_id !== instanceId) continue;
      const existingAuthority = isObject(existingClaim.portable_effect_authority)
        ? validatePortableExternalEffectAuthorityV1(existingClaim.portable_effect_authority, {
          company_id: companyId,
          workflow_id: workflow,
          run_id: run.id,
          step_id: step.id,
          approval_id: admission.approvalId ?? undefined,
          idempotency_key: idempotencyKey(metadata, run.id, step.id),
          target_digest: admission.targetDigest ?? undefined,
          input_bundle_sha256: admission.inputBundleSha256 ?? undefined,
          browser_surface: admission.executionMode === "business_effect"
            ? portableBusinessBrowserSurface(metadata, workflow)
            : browserSurfaceForBackend(webOperationBackend(metadata))
        })
        : null;
      if (admission.executionMode === "business_effect" && !existingAuthority) continue;
      return claimFromMetadata({
        run,
        step,
        metadata,
        workerId: id,
        workerInstanceId: instanceId,
        leaseExpiresAt: existingClaim.lease_expires_at,
        admission,
        registeredRoot,
        effectAuthority: existingAuthority
      });
    }
    const claimedAt = nowIso();
    const leaseExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const claimedBackend = webOperationBackend(metadata);
    const claimedBrowserSurface = admission.executionMode === "business_effect"
      ? portableBusinessBrowserSurface(metadata, workflow)
      : browserSurfaceForBackend(claimedBackend);
    let effectAuthority: PortableExternalEffectAuthorityV1 | null = null;
    try {
      effectAuthority = issueEffectAuthority({ run, step, metadata, workflow, admission, leaseExpiresAt });
    } catch {
      continue;
    }
    const updatedMetadata = {
      ...metadata,
      remote_worker_claim: {
        schema: "automation_os_portable_remote_worker_claim.v1",
        worker_id: id,
        ...(instanceId ? { worker_instance_id: instanceId } : {}),
        claimed_at: claimedAt,
        lease_expires_at: leaseExpiresAt,
        execution_mode: admission.executionMode,
        ...(admission.businessEffectStage ? { business_effect_stage: admission.businessEffectStage } : {}),
        ...(admission.approvalId ? { approval_id: admission.approvalId } : {}),
        ...(admission.approvalReceipt ? { approval_receipt: admission.approvalReceipt } : {}),
        ...(admission.inputBundleSha256 ? { input_bundle_sha256: admission.inputBundleSha256 } : {}),
        ...(inputBundleCreatedAt(metadata) ? { input_bundle_created_at: inputBundleCreatedAt(metadata) } : {}),
        ...(admission.targetDigest ? { target_digest: admission.targetDigest } : {}),
        browser_surface: claimedBrowserSurface,
        ...(claimedBackend ? { web_operation_backend: claimedBackend } : {}),
        registered_root_id: registeredRoot.root_id,
        registered_root_digest: registeredRoot.root_digest,
        ...(effectAuthority ? { portable_effect_authority: effectAuthority } : {})
      },
      worker_loop: { ...(isObject(metadata.worker_loop) ? metadata.worker_loop : {}), status: "claimed_by_mac_worker", claimedAt: claimedAt },
      mac_worker: { ...(isObject(metadata.mac_worker) ? metadata.mac_worker : {}), status: "claimed_by_mac_worker", workerId: id, claimedAt: claimedAt }
    };
    execSql(`UPDATE runs SET status='running', metadata_json=${sqlValue(updatedMetadata)}, updated_at=${sqlValue(claimedAt)} WHERE id=${sqlValue(run.id)} AND status IN ('queued', 'running', 'waiting_approval') AND metadata_json=${sqlValue(run.metadata_json)};`);
    const confirmed = querySql<RunRow>(`SELECT id, company_id, status, metadata_json, created_at FROM runs WHERE id=${sqlValue(run.id)} LIMIT 1`)[0];
    const confirmedMetadata = parseRecord(confirmed?.metadata_json);
    const confirmedClaim = isObject(confirmedMetadata.remote_worker_claim) ? confirmedMetadata.remote_worker_claim : {};
    if (!confirmed || confirmedClaim.worker_id !== id || confirmedClaim.claimed_at !== claimedAt) continue;
    let confirmedRoot: RegisteredRootAdmissionV1;
    try {
      confirmedRoot = registeredRootAdmission(confirmed, confirmedMetadata, workflow);
    } catch {
      continue;
    }
    const confirmedAdmission = claimAdmission(confirmed, confirmedMetadata, workflow, step.id);
    if (!confirmedAdmission) continue;
    const confirmedAuthority = isObject(confirmedClaim.portable_effect_authority)
      ? validatePortableExternalEffectAuthorityV1(confirmedClaim.portable_effect_authority, {
        company_id: companyId,
        workflow_id: workflow,
        run_id: confirmed.id,
        step_id: step.id,
        approval_id: confirmedAdmission.approvalId ?? undefined,
        idempotency_key: idempotencyKey(confirmedMetadata, confirmed.id, step.id),
        target_digest: confirmedAdmission.targetDigest ?? undefined,
        input_bundle_sha256: confirmedAdmission.inputBundleSha256 ?? undefined,
        browser_surface: confirmedAdmission.executionMode === "business_effect"
          ? portableBusinessBrowserSurface(confirmedMetadata, workflow)
          : browserSurfaceForBackend(webOperationBackend(confirmedMetadata))
      })
      : null;
    if (confirmedAdmission.executionMode === "business_effect" && !confirmedAuthority) continue;
    return claimFromMetadata({ run: confirmed, step, metadata: confirmedMetadata, workerId: id, workerInstanceId: instanceId, leaseExpiresAt, admission: confirmedAdmission, registeredRoot: confirmedRoot, effectAuthority: confirmedAuthority });
  }
  return null;
}

/**
 * HTTP-safe PostgreSQL counterpart to claimPortableMacWorker.  The legacy
 * synchronous function remains for SQLite/CLI compatibility; the local Mac
 * worker route must use the async pool so one slow database round trip cannot
 * freeze the control plane or turn a valid claim into a generic 500.
 */
export async function claimPortableMacWorkerAsync(input: { companyId: string; workerId: string; workerInstanceId?: string | null; requestedRunId?: string | null }): Promise<PortableRemoteClaim | null> {
  const companyId = input.companyId.trim();
  if (!companyId) throw new Error("company_id_required");
  const id = workerId(input.workerId);
  const instanceId = input.workerInstanceId ? workerId(input.workerInstanceId) : null;
  const requested = input.requestedRunId?.trim() || null;
  await reconcileStalePortablePreparingRunsAsync({ companyId, requestedRunId: requested });
  const rows = await querySqlAsync<RunRow>(`
    SELECT id, company_id, status, metadata_json, created_at
    FROM runs
    WHERE status IN ('queued', 'running', 'waiting_approval')
      AND execution_source='automation-os'
      AND quarantined=0
      AND company_id=${sqlValue(companyId)}
      ${requested ? `AND id=${sqlValue(requested)}` : ""}
    ORDER BY created_at ASC, id ASC
    LIMIT 100
  `);
  for (const run of rows) {
    const metadata = parseRecord(run.metadata_json);
    if (metadata.worker_protocol !== "mac_worker_polling_required" || metadata.worker_mode !== "queued_for_mac_worker") continue;
    if (isObject(metadata.remote_worker_receipt)) continue;
    if (await reconcileExpiredPortableWorkerClaimAsync(run, metadata)) continue;
    const workflow = workflowId(metadata);
    if (!workflow) continue;
    let registeredRoot: RegisteredRootAdmissionV1;
    try {
      registeredRoot = registeredRootAdmission(run, metadata, workflow);
    } catch {
      continue;
    }
    const step = (await querySqlAsync<StepRow>(`
      SELECT id, name, status, lane_id, metadata_json
      FROM run_steps
      WHERE run_id=${sqlValue(run.id)} AND status IN ('queued', 'running', 'waiting_approval')
      ORDER BY id ASC LIMIT 1
    `))[0];
    if (!step) continue;
    const admission = await claimAdmissionAsync(run, metadata, workflow, step.id);
    if (!admission) continue;
    const existingClaim = isObject(metadata.remote_worker_claim) ? metadata.remote_worker_claim : null;
    if (existingClaim && typeof existingClaim.lease_expires_at === "string" && Date.parse(existingClaim.lease_expires_at) > Date.now()) {
      if (existingClaim.worker_id !== id) continue;
      if (instanceId && existingClaim.worker_instance_id !== instanceId) continue;
      const existingAuthority = isObject(existingClaim.portable_effect_authority)
        ? validatePortableExternalEffectAuthorityV1(existingClaim.portable_effect_authority, {
          company_id: companyId,
          workflow_id: workflow,
          run_id: run.id,
          step_id: step.id,
          approval_id: admission.approvalId ?? undefined,
          idempotency_key: idempotencyKey(metadata, run.id, step.id),
          target_digest: admission.targetDigest ?? undefined,
          input_bundle_sha256: admission.inputBundleSha256 ?? undefined,
          browser_surface: admission.executionMode === "business_effect"
            ? portableBusinessBrowserSurface(metadata, workflow)
            : browserSurfaceForBackend(webOperationBackend(metadata))
        })
        : null;
      if (admission.executionMode === "business_effect" && !existingAuthority) continue;
      return claimFromMetadata({
        run,
        step,
        metadata,
        workerId: id,
        workerInstanceId: instanceId,
        leaseExpiresAt: existingClaim.lease_expires_at,
        admission,
        registeredRoot,
        effectAuthority: existingAuthority
      });
    }
    const claimedAt = nowIso();
    const leaseExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const claimedBackend = webOperationBackend(metadata);
    const claimedBrowserSurface = admission.executionMode === "business_effect"
      ? portableBusinessBrowserSurface(metadata, workflow)
      : browserSurfaceForBackend(claimedBackend);
    let effectAuthority: PortableExternalEffectAuthorityV1 | null = null;
    try {
      effectAuthority = issueEffectAuthority({ run, step, metadata, workflow, admission, leaseExpiresAt });
    } catch {
      continue;
    }
    const updatedMetadata = {
      ...metadata,
      remote_worker_claim: {
        schema: "automation_os_portable_remote_worker_claim.v1",
        worker_id: id,
        ...(instanceId ? { worker_instance_id: instanceId } : {}),
        claimed_at: claimedAt,
        lease_expires_at: leaseExpiresAt,
        execution_mode: admission.executionMode,
        ...(admission.businessEffectStage ? { business_effect_stage: admission.businessEffectStage } : {}),
        ...(admission.approvalId ? { approval_id: admission.approvalId } : {}),
        ...(admission.approvalReceipt ? { approval_receipt: admission.approvalReceipt } : {}),
        ...(admission.inputBundleSha256 ? { input_bundle_sha256: admission.inputBundleSha256 } : {}),
        ...(inputBundleCreatedAt(metadata) ? { input_bundle_created_at: inputBundleCreatedAt(metadata) } : {}),
        ...(admission.targetDigest ? { target_digest: admission.targetDigest } : {}),
        browser_surface: claimedBrowserSurface,
        ...(claimedBackend ? { web_operation_backend: claimedBackend } : {}),
        registered_root_id: registeredRoot.root_id,
        registered_root_digest: registeredRoot.root_digest,
        ...(effectAuthority ? { portable_effect_authority: effectAuthority } : {})
      },
      worker_loop: { ...(isObject(metadata.worker_loop) ? metadata.worker_loop : {}), status: "claimed_by_mac_worker", claimedAt },
      mac_worker: { ...(isObject(metadata.mac_worker) ? metadata.mac_worker : {}), status: "claimed_by_mac_worker", workerId: id, claimedAt }
    };
    await runSqlTransactionAsync([{
      sql: `UPDATE runs SET status='running', metadata_json=${sqlValue(updatedMetadata)}, updated_at=${sqlValue(claimedAt)}
            WHERE id=${sqlValue(run.id)} AND status IN ('queued', 'running', 'waiting_approval') AND metadata_json=${sqlValue(run.metadata_json)}`,
      expectChanges: 1
    }]);
    const confirmed = (await querySqlAsync<RunRow>(`SELECT id, company_id, status, metadata_json, created_at FROM runs WHERE id=${sqlValue(run.id)} LIMIT 1`))[0];
    const confirmedMetadata = parseRecord(confirmed?.metadata_json);
    const confirmedClaim = isObject(confirmedMetadata.remote_worker_claim) ? confirmedMetadata.remote_worker_claim : {};
    if (!confirmed || confirmedClaim.worker_id !== id || confirmedClaim.claimed_at !== claimedAt) continue;
    let confirmedRoot: RegisteredRootAdmissionV1;
    try {
      confirmedRoot = registeredRootAdmission(confirmed, confirmedMetadata, workflow);
    } catch {
      continue;
    }
    const confirmedAdmission = await claimAdmissionAsync(confirmed, confirmedMetadata, workflow, step.id);
    if (!confirmedAdmission) continue;
    const confirmedAuthority = isObject(confirmedClaim.portable_effect_authority)
      ? validatePortableExternalEffectAuthorityV1(confirmedClaim.portable_effect_authority, {
        company_id: companyId,
        workflow_id: workflow,
        run_id: confirmed.id,
        step_id: step.id,
        approval_id: confirmedAdmission.approvalId ?? undefined,
        idempotency_key: idempotencyKey(confirmedMetadata, confirmed.id, step.id),
        target_digest: confirmedAdmission.targetDigest ?? undefined,
        input_bundle_sha256: confirmedAdmission.inputBundleSha256 ?? undefined,
        browser_surface: confirmedAdmission.executionMode === "business_effect"
          ? portableBusinessBrowserSurface(confirmedMetadata, workflow)
          : browserSurfaceForBackend(webOperationBackend(confirmedMetadata))
      })
      : null;
    if (confirmedAdmission.executionMode === "business_effect" && !confirmedAuthority) continue;
    return claimFromMetadata({
      run: confirmed,
      step,
      metadata: confirmedMetadata,
      workerId: id,
      workerInstanceId: instanceId,
      leaseExpiresAt,
      admission: confirmedAdmission,
      registeredRoot: confirmedRoot,
      effectAuthority: confirmedAuthority
    });
  }
  return null;
}

type BusinessProofBinding = {
  companyId: string;
  runId: string;
  stepId: string;
  idempotencyKey: string;
  targetDigest: string | null;
  inputBundleSha256: string | null;
  sourceSnapshotId: string | null;
  payloadHash: string | null;
};

export function businessProofSatisfied(
  workflowId: string,
  input: Record<string, unknown>,
  adapterResult: Record<string, unknown>,
  expectedBinding?: BusinessProofBinding,
): boolean {
  if (workflowId === DAILY_AI_RESEARCH_SYNC_WORKFLOW) {
    if (!expectedBinding
      || !expectedBinding.companyId
      || !expectedBinding.runId
      || !expectedBinding.stepId
      || !expectedBinding.idempotencyKey
      || !expectedBinding.targetDigest
      || !expectedBinding.inputBundleSha256
      || !expectedBinding.sourceSnapshotId
      || !expectedBinding.payloadHash) return false;
    const receipt = isObject(input.runner_receipt) ? input.runner_receipt : {};
    const proofs = isObject(receipt.business_proofs) ? receipt.business_proofs : {};
    const mirror = isObject(receipt.mirror) ? receipt.mirror : {};
    const research = isObject(receipt.research) ? receipt.research : null;
    const metrics = research && isObject(research.metrics) ? research.metrics : null;
    const payloadHashBound = receipt.payload_hash === undefined
      || receipt.payload_hash === expectedBinding.payloadHash;
    const payloadDigestValid = receipt.payload_sha256 === undefined
      || (typeof receipt.payload_sha256 === "string" && /^[a-f0-9]{64}$/u.test(receipt.payload_sha256));
    const noPublication = metrics !== null
      && metrics.published === 0 && metrics.sheets_synced === 0 && metrics.auto_promoted === 0;
    return input.same_run_receipt === true && input.same_run_source_sync === true && input.cleanup_verified === true
      && input.readback_verified === true && input.external_action_executed === true
      && adapterResult.remote_verified === true
      && receipt.status === "complete" && receipt.exact_blocker === null
      && receipt.external_action_executed === true && receipt.readback_verified === true && receipt.cleanup_verified === true
      && receipt.company_id === expectedBinding.companyId && receipt.workflow_id === workflowId
      && receipt.run_id === expectedBinding.runId && receipt.step_id === expectedBinding.stepId
      && receipt.idempotency_key === expectedBinding.idempotencyKey
      && receipt.target_digest === expectedBinding.targetDigest
      && receipt.source_snapshot_id === expectedBinding.sourceSnapshotId
      && receipt.input_bundle_sha256 === expectedBinding.inputBundleSha256
      && payloadHashBound && payloadDigestValid
      && receipt.same_run_source_sync === true && receipt.full_publish_completed === false
      && receipt.generation_performed === false
      && noPublication
      && mirror.spreadsheet_id === DAILY_AI_RESEARCH_SYNC_SHEET
      && mirror.sheet_id === 1541274581 && mirror.mirror_column_count === 39
      && mirror.all_local_ids_and_columns_match === true && mirror.manual_views_match === true
      && proofs.research_queue === true && proofs.existing_sheet_mirror === true && proofs.all_mirror_columns === true
      && proofs.cleanup_receipt === true;
  }
  if (workflowId === "daily-backup-safety-check") {
    const runnerReceipt = isObject(input.runner_receipt) ? input.runner_receipt : null;
    const proofs = runnerReceipt && isObject(runnerReceipt.business_proofs) ? runnerReceipt.business_proofs : null;
    return input.same_run_receipt === true
      && input.same_run_source_sync === true
      && input.cleanup_verified === true
      && adapterResult.remote_verified === true
      && Boolean(proofs?.backup_snapshot === true)
      && Boolean(proofs?.backup_remote_push === true)
      && Boolean(proofs?.backup_state === true)
      && Boolean(proofs?.cleanup_receipt === true);
  }
  if (workflowId === "job-application-manager") {
    return adapterResult.state === "submitted_confirmed"
      && adapterResult.sync_ok === true
      && adapterResult.ledger_finalized === true;
  }
  if (workflowId === "obsidian-project-memory-audit") {
    const runnerReceipt = isObject(input.runner_receipt) ? input.runner_receipt : null;
    const proofs = runnerReceipt && isObject(runnerReceipt.business_proofs) ? runnerReceipt.business_proofs : null;
    return input.same_run_receipt === true
      && input.same_run_source_sync === true
      && input.cleanup_verified === true
      && adapterResult.remote_verified === true
      && proofs?.obsidian_maintenance === true
      && proofs?.obsidian_export === true
      && proofs?.obsidian_git_sync === true
      && proofs?.private_remote_parity === true
      && proofs?.cleanup_receipt === true;
  }
  const plan = getPortableExternalBusinessPlan(workflowId);
  const runnerReceipt = isObject(input.runner_receipt) ? input.runner_receipt : null;
  const proofs = runnerReceipt && isObject(runnerReceipt.business_proofs)
    ? runnerReceipt.business_proofs
    : null;
  // Daily AI and NisenPrints must provide workflow-owned business proof, not
  // merely a generic child receipt.  The adapter is responsible for deriving
  // these booleans from visible business readback; this layer only admits the
  // normalized contract and binds it to the current run.
  if (!plan || !runnerReceipt || !proofs || input.same_run_receipt !== true || input.cleanup_verified !== true) return false;
  if (runnerReceipt.same_run_source_sync !== true) return false;
  return plan.required_business_proofs.every((proof) => proofs[proof] === true
    || (isObject(proofs[proof]) && proofs[proof].verified === true));
}

function businessOperationKind(workflowId: string): "submit" | "publish" | "update" {
  return workflowId === DAILY_AI_RESEARCH_SYNC_WORKFLOW ? "update" : workflowId === "job-application-manager" ? "submit" : "publish";
}

function validateBusinessWebOperationLifecycle(input: unknown, expected: {
  workflowId: string;
  runId: string;
  stepId: string;
  idempotencyKey: string;
  targetDigest: string | null;
  payloadHash: string | null;
  externalActionExecuted: boolean;
}): { valid: boolean; complete: boolean; lifecycle: Record<string, unknown> } {
  const lifecycle = isObject(input) ? sanitizeRecord(input, 0) : {};
  const operation = businessOperationKind(expected.workflowId);
  const state = lifecycle.state;
  const valid = lifecycle.schema === "automation_os_web_operation_lifecycle.v1"
    && (state === "blocked" || state === "effect_unknown" || state === "completed" || state === "cleaned")
    && lifecycle.status === (state === "completed" || state === "cleaned" ? "complete" : "blocked")
    && lifecycle.run_id === expected.runId
    && lifecycle.step_id === expected.stepId
    && lifecycle.idempotency_key === expected.idempotencyKey
    && lifecycle.operation === operation
    && lifecycle.target_digest === expected.targetDigest
    && lifecycle.payload_hash === expected.payloadHash
    && lifecycle.external_action_executed === expected.externalActionExecuted
    && typeof lifecycle.same_run_receipt === "boolean"
    && typeof lifecycle.readback_verified === "boolean"
    && typeof lifecycle.cleanup_verified === "boolean"
    && lifecycle.no_replay === true;
  const complete = valid
    && lifecycle.status === "complete"
    && (state === "completed" || state === "cleaned")
    && expected.externalActionExecuted
    && lifecycle.same_run_receipt === true
    && lifecycle.readback_verified === true
    && lifecycle.cleanup_verified === true
    && lifecycle.exact_blocker === null;
  return { valid, complete, lifecycle };
}

type PortableEffectAuthorityReceiptExpectation = Partial<Pick<PortableExternalEffectAuthorityV1,
  "company_id" | "workflow_id" | "run_id" | "step_id" | "effect_stage" | "approval_id"
  | "idempotency_key" | "target_digest" | "input_bundle_sha256" | "browser_surface"
>>;

function resolvePortableReceiptEffectAuthority(input: unknown, value: unknown, expected: PortableEffectAuthorityReceiptExpectation): {
  authority: PortableExternalEffectAuthorityV1 | null;
  validationBlocker: string | null;
} {
  try {
    return {
      authority: validatePortableExternalEffectAuthorityV1(value, expected),
      validationBlocker: null
    };
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    // A worker may finish after the short-lived effect lease has expired. If
    // the worker explicitly reports a blocked, no-effect receipt, persist
    // that fact so the old run can be terminalized without replaying the
    // external action. Any reported effect, completed receipt, or different
    // authority failure remains fail-closed.
    const explicitNoEffectBlock = isObject(input)
      && input.status === "blocked"
      && input.external_action_executed === false;
    if (code === "portable_effect_authority_expired" && explicitNoEffectBlock) {
      return { authority: null, validationBlocker: code };
    }
    throw error;
  }
}

export function validSafeCompanionToOfficialHandoff(
  input: Record<string, unknown>,
  expected: { executionMode: PortableRemoteExecutionMode; browserSurface: PortableRemoteClaim["browser_surface"] },
): boolean {
  if (expected.executionMode !== "read_only"
    || expected.browserSurface !== "aos_chrome_companion_profile_instance"
    || input.browser_surface !== "signed_chrome_extension_profile2"
    || input.external_action_executed !== false
    || input.visual_readback_verified !== true) return false;
  const handoff = isObject(input.safe_surface_handoff) ? input.safe_surface_handoff : null;
  return Boolean(handoff
    && handoff.schema === "aos.safe_extension_surface_handoff.v1"
    && handoff.status === "completed"
    && handoff.direction === "one_way"
    && handoff.source_backend === "aos_chrome_companion"
    && handoff.source_surface === "aos_chrome_companion_profile_instance"
    && handoff.destination_backend === "chrome_plugin"
    && handoff.destination_surface === "signed_chrome_extension_profile2"
    && handoff.handoff_count === 1
    && handoff.max_handoffs === 1
    && handoff.external_action_executed === false
    && handoff.replay_allowed === false
    && handoff.source_no_effect_verified === true
    && handoff.source_cleanup_verified === true
    && handoff.destination_visual_verified === true
    && handoff.destination_cleanup_verified === true
    && handoff.destination_readback_verified === true);
}

/**
 * A Companion read-only attempt may have proven no effect and cleaned up
 * before the one-way official Extension handoff itself is blocked. Preserve
 * that terminal no-effect receipt instead of rejecting it because the child
 * normalized its last surface to the not-yet-verified destination.
 */
export function validBlockedSafeCompanionToOfficialHandoff(
  input: Record<string, unknown>,
  expected: { executionMode: PortableRemoteExecutionMode; browserSurface: PortableRemoteClaim["browser_surface"] },
): boolean {
  if (expected.executionMode !== "read_only"
    || expected.browserSurface !== "aos_chrome_companion_profile_instance"
    || input.browser_surface !== "signed_chrome_extension_profile2"
    || input.status !== "blocked"
    || input.external_action_executed !== false
    || input.visual_readback_verified === true) return false;
  const source = isObject(input.source_surface_receipt) ? input.source_surface_receipt : null;
  const handoff = isObject(input.safe_surface_handoff) ? input.safe_surface_handoff : null;
  return Boolean(source
    && source.external_action_executed === false
    && source.mutation_dispatch_attempted === false
    && source.mutation_dispatch_count === 0
    && source.operation_effect_state === "none"
    && source.reconciliation_required === false
    && source.cleanup_verified === true
    && handoff
    && handoff.schema === "aos.safe_extension_surface_handoff.v1"
    && handoff.status === "blocked"
    && handoff.direction === "one_way"
    && handoff.source_backend === "aos_chrome_companion"
    && handoff.source_surface === "aos_chrome_companion_profile_instance"
    && handoff.destination_backend === "chrome_plugin"
    && handoff.destination_surface === "signed_chrome_extension_profile2"
    && handoff.handoff_count === 1
    && handoff.max_handoffs === 1
    && handoff.external_action_executed === false
    && handoff.replay_allowed === false
    && handoff.source_no_effect_verified === true
    && handoff.source_cleanup_verified === true
    && handoff.destination_visual_verified !== true
    && handoff.destination_cleanup_verified !== true
    && handoff.destination_readback_verified !== true);
}

function safeReceipt(input: unknown, expected: {
  companyId: string;
  workflowId: string;
  runId: string;
  stepId: string;
  idempotencyKey: string;
  executionMode: PortableRemoteExecutionMode;
  readOnlyStage: "candidate_supply" | "reference_readback" | null;
  businessEffectStage: PortableBusinessEffectStage | null;
  targetDigest: string | null;
  sourceSnapshotId?: string | null;
  effectAuthority: PortableExternalEffectAuthorityV1 | null;
  effectAuthorityValidationBlocker?: string | null;
  approvalReceipt: PortableTargetBoundApprovalReceiptV1 | null;
  browserSurface: PortableRemoteClaim["browser_surface"];
  connectorExecutionOwner: PortableConnectorExecutionOwner;
}): PortableRemoteReceipt {
  if (!isObject(input)) throw new Error("portable_remote_receipt_invalid");
  const status = input.status === "complete" || input.status === "partial" || input.status === "blocked" ? input.status : "blocked";
  const exactBlocker = input.exact_blocker === null || input.exact_blocker === undefined ? null : String(input.exact_blocker).slice(0, 240);
  const localWorkflow = isPortableLocalWorkflowId(expected.workflowId);
  const safeSurfaceHandoff = validSafeCompanionToOfficialHandoff(input, expected);
  const blockedSafeSurfaceHandoff = validBlockedSafeCompanionToOfficialHandoff(input, expected);
  const browserSurface = input.browser_surface === expected.browserSurface
    ? expected.browserSurface
    : safeSurfaceHandoff
      ? "signed_chrome_extension_profile2"
      : blockedSafeSurfaceHandoff
        ? expected.browserSurface
    : localWorkflow && input.browser_surface === "local_worker"
      ? "local_worker"
      : null;
  if (!browserSurface) throw new Error("portable_remote_browser_surface_invalid");
  if (input.run_id !== expected.runId || input.step_id !== expected.stepId || input.workflow_id !== expected.workflowId) throw new Error("portable_remote_receipt_binding_mismatch");
  const adapterResult = isObject(input.adapter_result) ? sanitizeRecord(input.adapter_result, 0) : {};
  // The generic diagnostic depth/20-entry cap must not erase the bounded
  // Gmail result. No other workflow or arbitrary nested fields bypass it.
  if (expected.workflowId === "email-review-reply" && expected.executionMode === "read_only"
    && isObject(input.adapter_result) && isObject(input.adapter_result.local_receipt)) {
    const review = normalizeGmailReviewResult(input.adapter_result.local_receipt.review, { runId: expected.runId, companyId: expected.companyId });
    if (review) {
      const local = isObject(adapterResult.local_receipt) ? adapterResult.local_receipt : {};
      adapterResult.local_receipt = { ...local, review };
    }
  }
  const reportedExternal = input.external_action_executed === true;
  const sameRunReceipt = input.same_run_receipt === true;
  const cleanupVerified = input.cleanup_verified === true;
  const readbackVerified = input.readback_verified === true;
  const businessProofVerified = expected.executionMode === "business_effect"
    ? businessProofSatisfied(expected.workflowId, input, adapterResult, {
      companyId: expected.companyId,
      runId: expected.runId,
      stepId: expected.stepId,
      idempotencyKey: expected.idempotencyKey,
      targetDigest: expected.targetDigest,
      inputBundleSha256: expected.effectAuthority?.input_bundle_sha256 ?? null,
      sourceSnapshotId: expected.sourceSnapshotId ?? null,
      payloadHash: expected.effectAuthority?.payload_hash ?? null,
    })
    : false;
  const webOperationLifecycle = expected.executionMode === "business_effect"
    ? validateBusinessWebOperationLifecycle(input.web_operation_lifecycle, {
      workflowId: expected.workflowId,
      runId: expected.runId,
      stepId: expected.stepId,
      idempotencyKey: expected.idempotencyKey,
      targetDigest: expected.targetDigest,
      payloadHash: expected.effectAuthority?.payload_hash ?? null,
      externalActionExecuted: reportedExternal,
    })
    : null;
  let approvalReceiptValid = expected.executionMode !== "business_effect";
  let reportedApprovalReceipt: PortableTargetBoundApprovalReceiptV1 | null = null;
  if (expected.executionMode === "business_effect" && expected.approvalReceipt) {
    try {
      reportedApprovalReceipt = validatePortableTargetBoundApprovalReceipt(input.approval_receipt, {
        company_id: expected.approvalReceipt.binding.company_id,
        workflow_id: expected.workflowId,
        run_id: expected.runId,
        step_id: expected.approvalReceipt.binding.step_id,
        effect_stage: expected.businessEffectStage ?? undefined,
        idempotency_key: expected.approvalReceipt.binding.idempotency_key,
        input_bundle_sha256: expected.approvalReceipt.binding.input_bundle_sha256,
        target_digest: expected.targetDigest ?? undefined,
        browser_surface: expected.browserSurface
      });
      approvalReceiptValid = reportedApprovalReceipt.approval_id === expected.approvalReceipt.approval_id
        && reportedApprovalReceipt.binding_sha256 === expected.approvalReceipt.binding_sha256
        && reportedApprovalReceipt.binding.browser_surface === expected.browserSurface;
    } catch {
      approvalReceiptValid = false;
    }
  }
  const expectedEffectAuthoritySha256 = expected.effectAuthority
    ? createHash("sha256").update(`${JSON.stringify(expected.effectAuthority, null, 2)}\n`).digest("hex")
    : null;
  const reportedEffectsMode = input.effects_mode === "business_effect" || input.effects_mode === "read_only"
    ? input.effects_mode
    : null;
  if (reportedEffectsMode !== expected.executionMode) throw new Error("portable_remote_effects_mode_mismatch");
  if (expected.executionMode === "read_only" && reportedExternal) throw new Error("portable_remote_external_effect_reported");
  if (expected.executionMode === "read_only" && input.read_only_stage_bound !== true) throw new Error("portable_remote_read_only_stage_unbound");

  const nonEmptyPath = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;
  // Older Chrome Plugin runner generations normalized the terminal receipt's
  // bridge path at the outer receipt boundary only. Keep that same-run path
  // admissible while newer runners also copy it into adapter_result.
  const bridgeReceiptPath = nonEmptyPath(adapterResult.bridge_receipt_path)
    ? adapterResult.bridge_receipt_path
    : input.bridge_receipt_path;
  const localReadOnlyProofVerified = localWorkflow
    && status === "complete"
    && exactBlocker === null
    && reportedExternal === false
    && input.read_only_stage_bound === true
    && sameRunReceipt
    && readbackVerified
    && cleanupVerified
    && adapterResult.local_workflow_receipt === true
    && adapterResult.execution_surface === "mac_local_worker";
  const chromePluginCandidateSupplyProof = expected.executionMode === "read_only"
    && expected.readOnlyStage === "candidate_supply"
    && (expected.browserSurface === "signed_chrome_extension_profile2" || safeSurfaceHandoff)
    && status === "complete"
    && exactBlocker === null
    && reportedExternal === false
    && input.read_only_stage_bound === true
    && sameRunReceipt
    && readbackVerified
    && cleanupVerified
    && adapterResult.status === "ready"
    && adapterResult.read_only === true
    && adapterResult.browser_backend === "chrome_plugin"
    && adapterResult.browser_surface === "signed_chrome_extension_profile2"
    && Number.isSafeInteger(adapterResult.candidate_count)
    && Number.isSafeInteger(adapterResult.requested_count)
    && Number(adapterResult.candidate_count) >= Number(adapterResult.requested_count)
    && Number(adapterResult.requested_count) >= 0
    && nonEmptyPath(adapterResult.artifact_uri)
    && nonEmptyPath(bridgeReceiptPath)
    && nonEmptyPath(adapterResult.bridge_instance_id)
    && isObject(adapterResult.web_operation_backend_snapshot)
    && adapterResult.web_operation_backend_snapshot.resolved_backend === "chrome_plugin"
    && adapterResult.web_operation_backend_snapshot.exact_blocker === null
    && adapterResult.web_operation_backend_snapshot.fallback_allowed === false
    && isObject(adapterResult.tab_cleanup)
    && adapterResult.tab_cleanup.ok === true
    && adapterResult.cleanup_verified === true
    && adapterResult.readback_verified === true;
  const chromePluginReferenceReadbackProof = expected.executionMode === "read_only"
    && expected.readOnlyStage === "reference_readback"
    && (expected.browserSurface === "signed_chrome_extension_profile2" || safeSurfaceHandoff)
    // A prior verifier generation could attach this generic blocker after
    // the Chrome Plugin terminal receipt was already complete. Treat only
    // that verifier-generated blocker as recoverable; transport/auth/target
    // blockers remain fail-closed.
    && (exactBlocker === null || exactBlocker === READ_ONLY_PROOF_PENDING_BLOCKER)
    && (status === "complete" || adapterResult.status === "complete")
    && reportedExternal === false
    && input.read_only_stage_bound === true
    && sameRunReceipt
    && readbackVerified
    && cleanupVerified
    && adapterResult.status === "complete"
    && adapterResult.operation === "read"
    && adapterResult.browser_backend === "chrome_plugin"
    && adapterResult.browser_surface === "signed_chrome_extension_profile2"
    && nonEmptyPath(adapterResult.requested_origin)
    && nonEmptyPath(adapterResult.observed_origin)
    && adapterResult.hydration_ready === true
    && nonEmptyPath(bridgeReceiptPath)
    && nonEmptyPath(adapterResult.bridge_instance_id)
    && isObject(adapterResult.web_operation_backend_snapshot)
    && adapterResult.web_operation_backend_snapshot.resolved_backend === "chrome_plugin"
    && adapterResult.web_operation_backend_snapshot.exact_blocker === null
    && adapterResult.web_operation_backend_snapshot.fallback_allowed === false
    && isObject(adapterResult.tab_cleanup)
    && adapterResult.tab_cleanup.ok === true
    && adapterResult.tab_cleanup.cleanup_failed !== true
    && adapterResult.cleanup_verified === true
    && adapterResult.readback_verified === true;
  const companionReadOnlyProof = expected.executionMode === "read_only"
    && expected.readOnlyStage !== null
    && expected.browserSurface === "aos_chrome_companion_profile_instance"
    && status === "complete"
    && exactBlocker === null
    && reportedExternal === false
    && input.read_only_stage_bound === true
    && sameRunReceipt
    && readbackVerified
    && cleanupVerified
    && adapterResult.schema === "aos.chrome_companion_adapter.v1"
    && adapterResult.result === "verified"
    && adapterResult.execution_surface === "aos_chrome_companion_profile_instance"
    && isObject(adapterResult.target)
    && adapterResult.target.task_owned === true
    && Number.isSafeInteger(adapterResult.target.tab_id)
    && Number.isSafeInteger(adapterResult.target.window_id)
    && isObject(adapterResult.readback)
    && nonEmptyPath(adapterResult.readback.url)
    && isObject(adapterResult.visual_readback)
    && adapterResult.visual_readback.captured === true
    && typeof adapterResult.visual_readback.sha256 === "string"
    && /^[a-f0-9]{64}$/u.test(adapterResult.visual_readback.sha256)
    && adapterResult.visual_readback_verified === true
    && isObject(adapterResult.cleanup)
    && adapterResult.cleanup.session_closed === true
    && adapterResult.cleanup.lease_released_by_session_close === true
    && adapterResult.operation_effect_state === "none"
    && adapterResult.reconciliation_required === false
    && adapterResult.mutation_dispatch_attempted === false
    && adapterResult.mutation_dispatch_count === 0
    && adapterResult.replay_allowed === false
    && isObject(adapterResult.target_provision)
    && adapterResult.target_provision.signed_transaction === true
    && adapterResult.target_provision.external_action_executed === false;
  const readOnlyProofVerified = expected.executionMode === "read_only"
    && expected.readOnlyStage !== null
    && (localReadOnlyProofVerified || chromePluginCandidateSupplyProof || chromePluginReferenceReadbackProof || companionReadOnlyProof || (
      status === "complete"
      && exactBlocker === null
      && reportedExternal === false
      && input.read_only_stage_bound === true
      && sameRunReceipt
      && readbackVerified
      && cleanupVerified
      && (expected.readOnlyStage === "candidate_supply"
      ? adapterResult.stage === "job_candidate_supply"
        && adapterResult.status === "ready"
        && adapterResult.ready === true
        && adapterResult.read_only === true
        && Number.isSafeInteger(adapterResult.candidate_count)
        && Number.isSafeInteger(adapterResult.requested_count)
        && Number(adapterResult.candidate_count) >= 0
        && Number(adapterResult.requested_count) >= 0
        && Number(adapterResult.candidate_count) >= Number(adapterResult.requested_count)
        && nonEmptyPath(adapterResult.artifact_uri)
        && nonEmptyPath(adapterResult.browser_authority_path)
        && nonEmptyPath(adapterResult.browser_flow_receipt_path)
        && nonEmptyPath(adapterResult.browser_flow_manifest_path)
        && adapterResult.cleanup_verified === true
        && adapterResult.browser_flow_status === "finalized"
      : adapterResult.reference_readback === true
        && isObject(adapterResult.browser_runtime_readback)
        && adapterResult.browser_runtime_readback.cleanup_verified === true
        && nonEmptyPath(adapterResult.browser_runtime_readback.effective_session)
        && nonEmptyPath(adapterResult.browser_runtime_readback.profile_root)
        && Number(adapterResult.browser_runtime_readback.reserved_port) > 0
        && adapterResult.browser_runtime_readback.flow_status === "finalized"
    )));

  let normalizedStatus: PortableRemoteReceipt["status"] = status;
  let normalizedBlocker = exactBlocker;
  if (expected.executionMode === "business_effect") {
    if (input.business_effect_stage !== expected.businessEffectStage) throw new Error("portable_remote_business_stage_mismatch");
    if (input.target_digest !== expected.targetDigest) throw new Error("portable_remote_business_target_mismatch");
    const authorityBindingValid = Boolean(expected.effectAuthority
      && expectedEffectAuthoritySha256
      && input.effect_authority_id === expected.effectAuthority.authority_id
      && input.effect_authority_sha256 === expectedEffectAuthoritySha256);
    if (!approvalReceiptValid) {
      normalizedStatus = "blocked";
      normalizedBlocker = "portable_target_bound_approval_receipt_missing_or_invalid";
    } else if (!authorityBindingValid) {
      normalizedStatus = "blocked";
      normalizedBlocker = "portable_remote_effect_authority_receipt_binding_invalid";
    } else if (!webOperationLifecycle?.valid) {
      normalizedStatus = "blocked";
      normalizedBlocker = "portable_remote_web_operation_lifecycle_invalid";
    } else if (authorityBindingValid && reportedExternal && (!businessProofVerified || !sameRunReceipt || !cleanupVerified || !webOperationLifecycle.complete)) {
      normalizedStatus = "blocked";
      normalizedBlocker = "portable_remote_business_receipt_reconciliation_required";
    } else if (authorityBindingValid && reportedExternal && (normalizedStatus !== "complete" || normalizedBlocker)) {
      normalizedStatus = "blocked";
      normalizedBlocker = "portable_remote_business_receipt_reconciliation_required";
    } else if (authorityBindingValid && !reportedExternal && normalizedStatus === "complete" && !normalizedBlocker) {
      normalizedStatus = "blocked";
      normalizedBlocker = "portable_remote_business_effect_not_confirmed";
    }
    if (expected.effectAuthorityValidationBlocker && !reportedExternal) {
      normalizedStatus = "blocked";
      normalizedBlocker = expected.effectAuthorityValidationBlocker;
    }
  }
  const result: PortableRemoteReceipt = {
    status: normalizedStatus,
    exact_blocker: normalizedBlocker,
    external_action_executed: reportedExternal,
    browser_surface: browserSurface,
    connector_execution_owner: expected.connectorExecutionOwner,
    workflow_id: expected.workflowId,
    run_id: expected.runId,
    step_id: expected.stepId,
    cleanup_verified: cleanupVerified,
    readback_verified: readbackVerified,
    effects_mode: expected.executionMode,
    read_only_stage_bound: expected.executionMode === "read_only" && input.read_only_stage_bound === true,
    same_run_receipt: sameRunReceipt,
    business_proof_verified: businessProofVerified,
    read_only_proof_verified: readOnlyProofVerified,
    external_executor_status: typeof input.external_executor_status === "string" ? input.external_executor_status.slice(0, 240) : "unknown"
  };
  if (expected.businessEffectStage) result.business_effect_stage = expected.businessEffectStage;
  if (expected.targetDigest) result.target_digest = expected.targetDigest;
  if (expected.effectAuthority) result.effect_authority_id = expected.effectAuthority.authority_id;
  if (safeSurfaceHandoff && isObject(input.safe_surface_handoff)) {
    result.safe_surface_handoff = sanitizeRecord(input.safe_surface_handoff, 0);
  }
  if (typeof input.input_bundle_sha256 === "string" && /^[a-f0-9]{64}$/u.test(input.input_bundle_sha256)) result.input_bundle_sha256 = input.input_bundle_sha256;
  if (isObject(input.adapter_result)) result.adapter_result = adapterResult;
  if (reportedApprovalReceipt) result.approval_receipt = reportedApprovalReceipt;
  if (isObject(input.runner_receipt)) {
    const runnerReceipt = sanitizeRecord(input.runner_receipt, 0);
    if (isObject(runnerReceipt.business_proofs)) result.business_proofs = runnerReceipt.business_proofs;
    if (runnerReceipt.same_run_source_sync === true) result.same_run_source_sync = true;
  }
  if (webOperationLifecycle?.valid) result.web_operation_lifecycle = webOperationLifecycle.lifecycle;
  if (expected.executionMode === "read_only" && readOnlyProofVerified && result.status === "complete" && result.exact_blocker === READ_ONLY_PROOF_PENDING_BLOCKER) {
    result.exact_blocker = null;
  }
  if (expected.executionMode === "read_only" && !readOnlyProofVerified && !result.exact_blocker && result.status === "complete") {
    result.exact_blocker = READ_ONLY_PROOF_PENDING_BLOCKER;
  }
  return result;
}

function sanitizeRecord(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  if (depth > 3) return {};
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 60)) {
    if (SECRET_KEY_PATTERN.test(key)) continue;
    if (typeof raw === "string") result[key] = raw.slice(0, 1000);
    else if (typeof raw === "number" || typeof raw === "boolean" || raw === null) result[key] = raw;
    else if (isObject(raw)) result[key] = sanitizeRecord(raw, depth + 1);
    else if (Array.isArray(raw)) result[key] = raw.slice(0, 20).map((item) => typeof item === "string" ? item.slice(0, 300) : isObject(item) ? sanitizeRecord(item, depth + 1) : item);
  }
  return result;
}

function runtimeBindingForReceipt(
  stepMetadata: Record<string, unknown>,
  receipt: PortableRemoteReceipt,
): Record<string, unknown> | null {
  const existing = isObject(stepMetadata.service_readiness_runtime_binding)
    ? stepMetadata.service_readiness_runtime_binding
    : null;
  const adapterResult = isObject(receipt.adapter_result) ? receipt.adapter_result : null;
  const readback = adapterResult && isObject(adapterResult.browser_runtime_readback)
    ? adapterResult.browser_runtime_readback
    : null;
  if (!existing || !readback) return null;
  const effectiveSession = typeof readback.effective_session === "string"
    ? readback.effective_session.trim()
    : "";
  const profileRoot = typeof readback.profile_root === "string" && readback.profile_root.trim()
    ? readback.profile_root
    : existing.profile_root;
  const reservedPort = Number.isSafeInteger(Number(readback.reserved_port)) && Number(readback.reserved_port) > 0
    ? Number(readback.reserved_port)
    : existing.reserved_port;
  const verified = receipt.external_action_executed === false
    && effectiveSession.length > 0
    && readback.cleanup_verified === true;
  return {
    ...existing,
    effective_session_id: effectiveSession || existing.effective_session_id || null,
    profile_root: profileRoot,
    reserved_port: reservedPort,
    readback_status: verified ? "verified" : "blocked",
    status: verified ? "verified" : "blocked",
    exact_blocker: verified ? null : (existing.exact_blocker || "service_readiness_browser_use_runtime_readback_missing"),
    external_action_executed: receipt.external_action_executed,
  };
}

export function recordPortableMacWorkerReceipt(input: { companyId: string; workerId: string; workerInstanceId?: string | null; runId: string; receipt: unknown }): { replayed: boolean; receipt: PortableRemoteReceipt; artifact_uri: string } {
  const run = querySql<RunRow>(`SELECT id, company_id, status, metadata_json, created_at FROM runs WHERE id=${sqlValue(input.runId)} LIMIT 1`)[0];
  if (!run || run.company_id !== input.companyId) throw new Error("portable_remote_run_scope_mismatch");
  const metadata = parseRecord(run.metadata_json);
  const claim = isObject(metadata.remote_worker_claim) ? metadata.remote_worker_claim : {};
  if (claim.worker_id !== workerId(input.workerId)) throw new Error("portable_remote_worker_claim_mismatch");
  if (input.workerInstanceId && claim.worker_instance_id !== workerId(input.workerInstanceId)) throw new Error("portable_remote_worker_instance_mismatch");
  const workflowId = workflowIdFromMetadata(metadata);
  const registeredRoot = registeredRootAdmission(run, metadata, workflowId);
  if (claim.registered_root_id !== registeredRoot.root_id || claim.registered_root_digest !== registeredRoot.root_digest) {
    throw new Error("registered_root_admission_claim_mismatch");
  }
  const executionMode: PortableRemoteExecutionMode = claim.execution_mode === "business_effect" ? "business_effect" : "read_only";
  const effectStage = typeof claim.business_effect_stage === "string" && ALLOWED_EFFECT_STAGES.has(claim.business_effect_stage)
    ? claim.business_effect_stage as PortableBusinessEffectStage
    : null;
  const claimedTargetDigest = typeof claim.target_digest === "string" && /^[a-f0-9]{64}$/u.test(claim.target_digest)
    ? claim.target_digest
    : null;
  const step = querySql<StepRow>(`SELECT id, name, status, lane_id, metadata_json FROM run_steps WHERE run_id=${sqlValue(run.id)} ORDER BY id ASC LIMIT 1`)[0];
  if (!step) throw new Error("portable_remote_run_step_missing");
  const claimedBrowserSurface = claim.browser_surface === "signed_chrome_extension_profile2"
    ? "signed_chrome_extension_profile2"
    : claim.browser_surface === "browser_use_cli"
      ? "browser_use_cli"
      : executionMode === "business_effect"
        ? portableBusinessBrowserSurface(metadata, workflowId)
        : browserSurfaceForBackend(webOperationBackend(metadata));
  const effectAuthorityResolution = executionMode === "business_effect" && isObject(claim.portable_effect_authority)
    ? resolvePortableReceiptEffectAuthority(input.receipt, claim.portable_effect_authority, {
      company_id: input.companyId,
      workflow_id: workflowId,
      run_id: run.id,
      step_id: step?.id ?? "",
      approval_id: typeof claim.approval_id === "string" ? claim.approval_id : undefined,
      idempotency_key: idempotencyKey(metadata, run.id, step?.id ?? ""),
      target_digest: claimedTargetDigest ?? undefined,
      input_bundle_sha256: typeof claim.input_bundle_sha256 === "string" ? claim.input_bundle_sha256 : undefined,
      browser_surface: claimedBrowserSurface
    })
    : { authority: null, validationBlocker: null };
  const effectAuthority = effectAuthorityResolution.authority;
  const receipt = safeReceipt(input.receipt, {
    companyId: input.companyId,
    workflowId,
    runId: run.id,
    stepId: step.id,
    idempotencyKey: idempotencyKey(metadata, run.id, step.id),
    executionMode,
    readOnlyStage: readOnlyStage(metadata),
    businessEffectStage: effectStage,
    targetDigest: claimedTargetDigest,
    sourceSnapshotId: (() => {
      const bundle = inputBundle(metadata);
      return typeof bundle?.source_snapshot_id === "string" ? bundle.source_snapshot_id : null;
    })(),
    effectAuthority,
    effectAuthorityValidationBlocker: effectAuthorityResolution.validationBlocker,
    approvalReceipt: executionMode === "business_effect" && isObject(claim.approval_receipt)
      ? claim.approval_receipt as PortableTargetBoundApprovalReceiptV1
      : null,
    browserSurface: claimedBrowserSurface,
    connectorExecutionOwner: claim.connector_execution_owner === "mac_worker_explicit_connector_fallback"
      ? "mac_worker_explicit_connector_fallback"
      : "zeabur_codex_app_server"
  });
  const existing = isObject(metadata.remote_worker_receipt) ? metadata.remote_worker_receipt : null;
  if (existing) return { replayed: true, receipt: existing as PortableRemoteReceipt, artifact_uri: typeof existing.artifact_uri === "string" ? existing.artifact_uri : "" };
  const timestamp = nowIso();
  const durableArtifact = buildPortableReceiptArtifact({
    companyId: run.company_id,
    workflowId,
    workerId: workerId(input.workerId),
    registeredRoot,
    receipt,
    createdAt: timestamp
  });
  const artifactUri = durableArtifact.uri;
  const proofId = makeId("proof");
  const stepMetadata = parseRecord(step.metadata_json);
  const runtimeBinding = runtimeBindingForReceipt(stepMetadata, receipt);
  const merged = {
    ...metadata,
    remote_worker_receipt: { ...receipt, worker_id: workerId(input.workerId), artifact_uri: artifactUri },
    remote_worker_claim: { ...claim, completed_at: timestamp },
    exact_blocker: receipt.exact_blocker,
    external_action_executed: receipt.external_action_executed,
    worker_loop: { ...(isObject(metadata.worker_loop) ? metadata.worker_loop : {}), status: receipt.status === "complete" ? (executionMode === "business_effect" ? "completed_business_effect" : "completed_readback") : "blocked", completedAt: timestamp },
    mac_worker: { ...(isObject(metadata.mac_worker) ? metadata.mac_worker : {}), status: receipt.status === "complete" ? (executionMode === "business_effect" ? "completed_business_effect" : "completed_readback") : "blocked", completedAt: timestamp }
  };
  const completed = receipt.status === "complete"
    && receipt.exact_blocker === null
    && ((executionMode === "business_effect" && receipt.external_action_executed === true)
      || (executionMode === "read_only" && receipt.external_action_executed === false && receipt.read_only_proof_verified === true));
  const stepStatus = completed ? "completed" : "blocked";
  const runStatus = completed ? "complete" : "blocked";
  const localWorkflow = isPortableLocalWorkflowId(workflowId);
  const executionLabel = localWorkflow
    ? "portable_local_remote_mac_worker"
    : executionMode === "business_effect" ? "portable_external_remote_mac_worker_business" : "portable_external_remote_mac_worker";
  const proofSummary = completed
    ? executionMode === "business_effect"
      ? "complete: submitted/readback/cleanup proof verified"
      : localWorkflow
        ? "complete: Mac local read-only artifact/readback/cleanup proof verified"
        : "complete: read-only artifact/readback/cleanup proof verified"
    : `blocked: ${receipt.exact_blocker || "portable_remote_read_only_business_completion_proof_pending"}`;
  const steps: SqlTransactionStep[] = [
    portableReceiptArtifactInsertStep({ artifact: durableArtifact, companyId: run.company_id, runId: run.id, stepId: step.id, workflowId }),
    { sql: `UPDATE run_steps SET status=${sqlValue(stepStatus)}, completed_at=${sqlValue(timestamp)}, metadata_json=${sqlValue({ ...stepMetadata, ...(runtimeBinding ? { service_readiness_runtime_binding: runtimeBinding } : {}), exact_blocker: receipt.exact_blocker, external_action_executed: receipt.external_action_executed, read_only_proof_verified: receipt.read_only_proof_verified, execution_mode: executionLabel, portable_external_receipt: { ...receipt, worker_id: workerId(input.workerId), artifact_uri: artifactUri }, portable_external_artifact: artifactUri, proof_summary: proofSummary })} WHERE id=${sqlValue(step.id)};` },
  ];
  if (step.lane_id) steps.push({ sql: `UPDATE lanes SET status=${sqlValue(completed ? "completed" : "blocked")}, progress=${completed ? 100 : 50}, health=${sqlValue(completed ? "healthy" : "blocked")}, updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(step.lane_id)};` });
  steps.push(
    { sql: `UPDATE runs SET status=${sqlValue(runStatus)}, updated_at=${sqlValue(timestamp)}, metadata_json=${sqlValue(merged)} WHERE id=${sqlValue(run.id)};` },
    { sql: `INSERT INTO proofs (id, company_id, run_id, step_id, artifact_id, attempt_id, fencing_token, proof_type, label, uri, size_bytes, created_at, metadata_json)
            VALUES (${sqlValue(proofId)}, ${sqlValue(run.company_id)}, ${sqlValue(run.id)}, ${sqlValue(step.id)}, ${sqlValue(durableArtifact.id)}, NULL, NULL,
                    'worker_receipt', ${sqlValue(`${workflowId} remote Mac worker receipt`)}, ${sqlValue(artifactUri)}, ${durableArtifact.sizeBytes}, ${sqlValue(timestamp)},
                    ${sqlValue({ artifact_id: durableArtifact.id, checksum_sha256: durableArtifact.checksumSha256, mime_type: "application/json", execution_mode: executionLabel, registered_root_id: registeredRoot.root_id, registered_root_digest: registeredRoot.root_digest, external_action_executed: receipt.external_action_executed, exact_blocker: receipt.exact_blocker, business_proof_verified: receipt.business_proof_verified, read_only_proof_verified: receipt.read_only_proof_verified })})`, expectChanges: 1 },
    { sql: `INSERT INTO worker_events (id, run_id, step_id, lane_id, company_id, event_type, message, created_at, metadata_json)
            VALUES (${sqlValue(makeId("evt"))}, ${sqlValue(run.id)}, ${sqlValue(step.id)}, ${sqlValue(step.lane_id)}, ${sqlValue(run.company_id)}, ${sqlValue(completed ? "worker_completed" : "worker_blocked")}, ${sqlValue(proofSummary)}, ${sqlValue(timestamp)},
                    ${sqlValue({ worker_id: workerId(input.workerId), execution_mode: executionLabel, external_action_executed: receipt.external_action_executed, exact_blocker: receipt.exact_blocker, read_only_proof_verified: receipt.read_only_proof_verified })})`, expectChanges: 1 }
  );
  runSqlTransaction(steps);
  return { replayed: false, receipt, artifact_uri: artifactUri };
}

/**
 * Async HTTP-safe counterpart to recordPortableMacWorkerReceipt. The legacy
 * synchronous function remains for SQLite/CLI compatibility, while the
 * portable worker HTTP route uses this function for PostgreSQL so receipt
 * persistence cannot block the server event loop on spawnSync.
 */
export async function recordPortableMacWorkerReceiptAsync(input: { companyId: string; workerId: string; workerInstanceId?: string | null; runId: string; receipt: unknown }): Promise<{ replayed: boolean; receipt: PortableRemoteReceipt; artifact_uri: string }> {
  const run = (await querySqlAsync<RunRow>(`SELECT id, company_id, status, metadata_json, created_at FROM runs WHERE id=${sqlValue(input.runId)} LIMIT 1`))[0];
  if (!run || run.company_id !== input.companyId) throw new Error("portable_remote_run_scope_mismatch");
  const metadata = parseRecord(run.metadata_json);
  const claim = isObject(metadata.remote_worker_claim) ? metadata.remote_worker_claim : {};
  if (claim.worker_id !== workerId(input.workerId)) throw new Error("portable_remote_worker_claim_mismatch");
  if (input.workerInstanceId && claim.worker_instance_id !== workerId(input.workerInstanceId)) throw new Error("portable_remote_worker_instance_mismatch");
  const workflowId = workflowIdFromMetadata(metadata);
  const registeredRoot = registeredRootAdmission(run, metadata, workflowId);
  if (claim.registered_root_id !== registeredRoot.root_id || claim.registered_root_digest !== registeredRoot.root_digest) {
    throw new Error("registered_root_admission_claim_mismatch");
  }
  const executionMode: PortableRemoteExecutionMode = claim.execution_mode === "business_effect" ? "business_effect" : "read_only";
  const effectStage = typeof claim.business_effect_stage === "string" && ALLOWED_EFFECT_STAGES.has(claim.business_effect_stage)
    ? claim.business_effect_stage as PortableBusinessEffectStage
    : null;
  const claimedTargetDigest = typeof claim.target_digest === "string" && /^[a-f0-9]{64}$/u.test(claim.target_digest)
    ? claim.target_digest
    : null;
  const step = (await querySqlAsync<StepRow>(`SELECT id, name, status, lane_id, metadata_json FROM run_steps WHERE run_id=${sqlValue(run.id)} ORDER BY id ASC LIMIT 1`))[0];
  if (!step) throw new Error("portable_remote_run_step_missing");
  const claimedBrowserSurface = claim.browser_surface === "signed_chrome_extension_profile2"
    ? "signed_chrome_extension_profile2"
    : claim.browser_surface === "browser_use_cli"
      ? "browser_use_cli"
      : executionMode === "business_effect"
        ? portableBusinessBrowserSurface(metadata, workflowId)
        : browserSurfaceForBackend(webOperationBackend(metadata));
  const effectAuthorityResolution = executionMode === "business_effect" && isObject(claim.portable_effect_authority)
    ? resolvePortableReceiptEffectAuthority(input.receipt, claim.portable_effect_authority, {
      company_id: input.companyId,
      workflow_id: workflowId,
      run_id: run.id,
      step_id: step.id,
      approval_id: typeof claim.approval_id === "string" ? claim.approval_id : undefined,
      idempotency_key: idempotencyKey(metadata, run.id, step.id),
      target_digest: claimedTargetDigest ?? undefined,
      input_bundle_sha256: typeof claim.input_bundle_sha256 === "string" ? claim.input_bundle_sha256 : undefined,
      browser_surface: claimedBrowserSurface
    })
    : { authority: null, validationBlocker: null };
  const effectAuthority = effectAuthorityResolution.authority;
  const receipt = safeReceipt(input.receipt, {
    companyId: input.companyId,
    workflowId,
    runId: run.id,
    stepId: step.id,
    idempotencyKey: idempotencyKey(metadata, run.id, step.id),
    executionMode,
    readOnlyStage: readOnlyStage(metadata),
    businessEffectStage: effectStage,
    targetDigest: claimedTargetDigest,
    sourceSnapshotId: (() => {
      const bundle = inputBundle(metadata);
      return typeof bundle?.source_snapshot_id === "string" ? bundle.source_snapshot_id : null;
    })(),
    effectAuthority,
    effectAuthorityValidationBlocker: effectAuthorityResolution.validationBlocker,
    approvalReceipt: executionMode === "business_effect" && isObject(claim.approval_receipt)
      ? claim.approval_receipt as PortableTargetBoundApprovalReceiptV1
      : null,
    browserSurface: claimedBrowserSurface,
    connectorExecutionOwner: claim.connector_execution_owner === "mac_worker_explicit_connector_fallback"
      ? "mac_worker_explicit_connector_fallback"
      : "zeabur_codex_app_server"
  });
  const existing = isObject(metadata.remote_worker_receipt) ? metadata.remote_worker_receipt : null;
  if (existing) return { replayed: true, receipt: existing as PortableRemoteReceipt, artifact_uri: typeof existing.artifact_uri === "string" ? existing.artifact_uri : "" };
  const timestamp = nowIso();
  const durableArtifact = buildPortableReceiptArtifact({
    companyId: run.company_id,
    workflowId,
    workerId: workerId(input.workerId),
    registeredRoot,
    receipt,
    createdAt: timestamp
  });
  const artifactUri = durableArtifact.uri;
  const proofId = makeId("proof");
  const stepMetadata = parseRecord(step.metadata_json);
  const runtimeBinding = runtimeBindingForReceipt(stepMetadata, receipt);
  const merged = {
    ...metadata,
    remote_worker_receipt: { ...receipt, worker_id: workerId(input.workerId), artifact_uri: artifactUri },
    remote_worker_claim: { ...claim, completed_at: timestamp },
    exact_blocker: receipt.exact_blocker,
    external_action_executed: receipt.external_action_executed,
    worker_loop: { ...(isObject(metadata.worker_loop) ? metadata.worker_loop : {}), status: receipt.status === "complete" ? (executionMode === "business_effect" ? "completed_business_effect" : "completed_readback") : "blocked", completedAt: timestamp },
    mac_worker: { ...(isObject(metadata.mac_worker) ? metadata.mac_worker : {}), status: receipt.status === "complete" ? (executionMode === "business_effect" ? "completed_business_effect" : "completed_readback") : "blocked", completedAt: timestamp }
  };
  const completed = receipt.status === "complete"
    && receipt.exact_blocker === null
    && ((executionMode === "business_effect" && receipt.external_action_executed === true)
      || (executionMode === "read_only" && receipt.external_action_executed === false && receipt.read_only_proof_verified === true));
  const stepStatus = completed ? "completed" : "blocked";
  const runStatus = completed ? "complete" : "blocked";
  const localWorkflow = isPortableLocalWorkflowId(workflowId);
  const executionLabel = localWorkflow
    ? "portable_local_remote_mac_worker"
    : executionMode === "business_effect" ? "portable_external_remote_mac_worker_business" : "portable_external_remote_mac_worker";
  const proofSummary = completed
    ? executionMode === "business_effect"
      ? "complete: submitted/readback/cleanup proof verified"
      : localWorkflow
        ? "complete: Mac local read-only artifact/readback/cleanup proof verified"
        : "complete: read-only artifact/readback/cleanup proof verified"
    : `blocked: ${receipt.exact_blocker || "portable_remote_read_only_business_completion_proof_pending"}`;
  const steps = [
    portableReceiptArtifactInsertStep({ artifact: durableArtifact, companyId: run.company_id, runId: run.id, stepId: step.id, workflowId }),
    {
      sql: `UPDATE run_steps SET status=${sqlValue(stepStatus)}, completed_at=${sqlValue(timestamp)}, metadata_json=${sqlValue({ ...stepMetadata, ...(runtimeBinding ? { service_readiness_runtime_binding: runtimeBinding } : {}), exact_blocker: receipt.exact_blocker, external_action_executed: receipt.external_action_executed, read_only_proof_verified: receipt.read_only_proof_verified, execution_mode: executionLabel, portable_external_receipt: { ...receipt, worker_id: workerId(input.workerId), artifact_uri: artifactUri }, portable_external_artifact: artifactUri, proof_summary: proofSummary })} WHERE id=${sqlValue(step.id)};`
    }
  ];
  if (step.lane_id) {
    steps.push({ sql: `UPDATE lanes SET status=${sqlValue(completed ? "completed" : "blocked")}, progress=${completed ? 100 : 50}, health=${sqlValue(completed ? "healthy" : "blocked")}, updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(step.lane_id)};` });
  }
  steps.push({ sql: `UPDATE runs SET status=${sqlValue(runStatus)}, updated_at=${sqlValue(timestamp)}, metadata_json=${sqlValue(merged)} WHERE id=${sqlValue(run.id)};` });
  steps.push({ sql: `INSERT INTO proofs (id, company_id, run_id, step_id, artifact_id, attempt_id, fencing_token, proof_type, label, uri, size_bytes, created_at, metadata_json)
          VALUES (${sqlValue(proofId)}, ${sqlValue(run.company_id)}, ${sqlValue(run.id)}, ${sqlValue(step.id)}, ${sqlValue(durableArtifact.id)}, NULL, NULL,
                  'worker_receipt', ${sqlValue(`${workflowId} remote Mac worker receipt`)}, ${sqlValue(artifactUri)}, ${durableArtifact.sizeBytes}, ${sqlValue(timestamp)},
                  ${sqlValue({ artifact_id: durableArtifact.id, checksum_sha256: durableArtifact.checksumSha256, mime_type: "application/json", execution_mode: executionLabel, registered_root_id: registeredRoot.root_id, registered_root_digest: registeredRoot.root_digest, external_action_executed: receipt.external_action_executed, exact_blocker: receipt.exact_blocker, business_proof_verified: receipt.business_proof_verified, read_only_proof_verified: receipt.read_only_proof_verified })})`, expectChanges: 1 });
  steps.push({ sql: `INSERT INTO worker_events (id, run_id, step_id, lane_id, company_id, event_type, message, created_at, metadata_json) VALUES (${sqlValue(makeId("evt"))}, ${sqlValue(run.id)}, ${sqlValue(step.id)}, ${sqlValue(step.lane_id)}, ${sqlValue(run.company_id)}, ${sqlValue(completed ? "worker_completed" : "worker_blocked")}, ${sqlValue(proofSummary)}, ${sqlValue(timestamp)}, ${sqlValue({ worker_id: workerId(input.workerId), execution_mode: executionLabel, external_action_executed: receipt.external_action_executed, exact_blocker: receipt.exact_blocker, read_only_proof_verified: receipt.read_only_proof_verified })});` });
  await runSqlTransactionAsync(steps);
  return { replayed: false, receipt, artifact_uri: artifactUri };
}

function backupEvidenceVerified(receipt: Record<string, unknown>, reconciliation: Record<string, unknown>): boolean {
  const original = isObject(receipt.original_timeout_receipt) ? receipt.original_timeout_receipt : {};
  const evidence = isObject(receipt.evidence) ? receipt.evidence : {};
  const binding = isObject(receipt.reconciliation_binding) ? receipt.reconciliation_binding : {};
  const savedBinding = isObject(reconciliation.original_claim) ? reconciliation.original_claim : {};
  const commitsMatch = typeof evidence.commit === "string" && /^[a-f0-9]{40}$/u.test(evidence.commit)
    && evidence.remote_commit === evidence.commit;
  const originalTimeoutValid = original.artifact_name === "portable-local-worker-receipt.v1.json"
    && typeof original.sha256 === "string" && /^[a-f0-9]{64}$/u.test(original.sha256)
    && original.run_id === reconciliation.original_run_id
    && original.status === "blocked" && original.exact_blocker === "portable_local_child_deadline_exceeded"
    && original.external_action_executed === null && original.no_replay === true;
  const evidenceFlags = evidence.readback_verified === true && evidence.remote_parity === true
    && evidence.git_integrity_verified === true && evidence.restore_verified === true
    && evidence.cleanup_verified === true && evidence.manifest_source_count === 6
    && evidence.state_matches_snapshot_and_commit === true;
  const bindingFields = ["company_id", "run_id", "step_id", "workflow_id", "approval_id", "idempotency_key",
    "target_digest", "input_bundle_sha256", "account_ref", "target_key", "payload_hash", "source_snapshot_id",
    "registered_root_id", "registered_root_digest"];
  const bindingMatches = bindingFields.every((key) => Object.prototype.hasOwnProperty.call(binding, key)
    && Object.prototype.hasOwnProperty.call(savedBinding, key) && binding[key] === savedBinding[key]);
  const correlation = isObject(evidence.original_execution_summary) ? evidence.original_execution_summary : {};
  const originalClaim = isObject(receipt.original_claim) ? receipt.original_claim : {};
  const originalClaimValid = originalClaim.run_id === reconciliation.original_run_id
    && originalClaim.step_id === reconciliation.original_step_id
    && originalClaim.authority_id === reconciliation.original_authority_id
    && typeof originalClaim.sha256 === "string" && /^[a-f0-9]{64}$/u.test(originalClaim.sha256)
    && typeof originalClaim.authority_sha256 === "string" && originalClaim.authority_sha256 === reconciliation.original_authority_sha256;
  const correlationValid = correlation.correlation_method === "unique_success_in_original_claim_interval"
    && correlation.direct_child_link_verified === false
    && typeof correlation.interval_start === "string" && typeof correlation.interval_end === "string"
    && Number.isInteger(correlation.candidate_count) && correlation.candidate_count === 1
    && typeof correlation.sha256 === "string" && /^[a-f0-9]{64}$/u.test(correlation.sha256)
    && typeof correlation.snapshot_id === "string" && typeof correlation.backup_commit === "string"
    && /^[a-f0-9]{40}$/u.test(correlation.backup_commit)
    && evidence.snapshot_id === correlation.snapshot_id && evidence.commit === correlation.backup_commit;
  const attemptValid = typeof receipt.attempt_id === "string" && typeof receipt.fencing_token === "string"
    && receipt.attempt_id === reconciliation.attempt_id && receipt.fencing_token === reconciliation.fencing_token;
  return receipt.evidence_only === true && receipt.provider_replayed === false && receipt.new_effect === false
    && receipt.original_run_id === reconciliation.original_run_id
    && receipt.original_step_id === reconciliation.original_step_id
    && receipt.original_authority_id === reconciliation.original_authority_id
    && receipt.original_authority_sha256 === reconciliation.original_authority_sha256
    && originalTimeoutValid && originalClaimValid && evidenceFlags && commitsMatch && bindingMatches && correlationValid && attemptValid;
}

function backupEvidenceFinalizationSteps(input: {
  companyId: string;
  reconciliation: Record<string, unknown>;
  artifact: PortableReceiptArtifact;
  timestamp: string;
}): SqlTransactionStep[] {
  const binding = isObject(input.reconciliation.original_claim) ? input.reconciliation.original_claim : {};
  const steps: SqlTransactionStep[] = [];
  const operationKey = typeof binding.effect_operation_key === "string" ? binding.effect_operation_key : null;
  const originalRunId = typeof input.reconciliation.original_run_id === "string" ? input.reconciliation.original_run_id : null;
  if (!operationKey) throw new Error("portable_backup_effect_ledger_binding_missing");
  if (!originalRunId) throw new Error("portable_backup_original_run_binding_missing");
  steps.push({ sql: `UPDATE task_effect_ledger SET state='closed', external_action_executed=1, ambiguous=0, retry_forbidden=1,
    provider_receipt_hash=${sqlValue(input.artifact.checksumSha256)}, source_sync_hash=${sqlValue(input.artifact.checksumSha256)},
    reconciliation_hash=${sqlValue(input.artifact.checksumSha256)}, cleanup_hash=${sqlValue(input.artifact.checksumSha256)},
    exact_blocker=NULL, restart_point='closed', updated_at=${sqlValue(input.timestamp)}, closed_at=${sqlValue(input.timestamp)}
    WHERE company_id=${sqlValue(input.companyId)} AND operation_key=${sqlValue(operationKey)} AND workflow_id='daily-backup-safety-check' AND task_id=${sqlValue(originalRunId)} AND state <> 'closed'`, expectChanges: 1 });
  return steps;
}

function backupEvidenceLeasePredicate(reconciliation: Record<string, unknown>): string {
  const attemptId = sqlValue(typeof reconciliation.attempt_id === "string" ? reconciliation.attempt_id : null);
  const fencingToken = sqlValue(typeof reconciliation.fencing_token === "string" ? reconciliation.fencing_token : null);
  if (dbBackend === "postgres") {
    return ` AND (metadata_json::jsonb #>> '{portable_post_effect_reconciliation,attempt_id}')=${attemptId}
      AND (metadata_json::jsonb #>> '{portable_post_effect_reconciliation,fencing_token}')=${fencingToken}
      AND ((metadata_json::jsonb #>> '{portable_post_effect_reconciliation,lease_expires_at}')::timestamptz > clock_timestamp())`;
  }
  return ` AND json_extract(metadata_json, '$.portable_post_effect_reconciliation.attempt_id')=${attemptId}
    AND json_extract(metadata_json, '$.portable_post_effect_reconciliation.fencing_token')=${fencingToken}
    AND julianday(json_extract(metadata_json, '$.portable_post_effect_reconciliation.lease_expires_at')) > julianday('now')`;
}

export async function recordPortableBackupPostEffectEvidenceAsync(input: { companyId: string; workerId: string; workerInstanceId?: string | null; runId: string; receipt: unknown }): Promise<PortableBackupEvidenceRecordResult> {
  const run = (await querySqlAsync<RunRow>(`SELECT id, company_id, status, metadata_json, created_at FROM runs WHERE id=${sqlValue(input.runId)} LIMIT 1`))[0];
  if (!run || run.company_id !== input.companyId) throw new Error("portable_remote_run_scope_mismatch");
  const metadata = parseRecord(run.metadata_json);
  const reconciliation = isObject(metadata.portable_post_effect_reconciliation) ? metadata.portable_post_effect_reconciliation : null;
  const originalClaim = isObject(metadata.remote_worker_claim) ? metadata.remote_worker_claim : null;
  if (!reconciliation || !originalClaim || reconciliation.schema !== BACKUP_EVIDENCE_RECONCILIATION_SCHEMA
    || !["claimed", "queued", "blocked", "verified"].includes(String(reconciliation.status))) throw new Error("portable_backup_evidence_claim_missing");
  const id = workerId(input.workerId);
  const instanceId = input.workerInstanceId ? workerId(input.workerInstanceId) : null;
  if (!instanceId) throw new Error("portable_backup_evidence_worker_instance_required");
  if (reconciliation.worker_id !== id) throw new Error("portable_backup_evidence_worker_mismatch");
  if (reconciliation.worker_instance_id !== instanceId) throw new Error("portable_backup_evidence_worker_instance_mismatch");
  if (typeof reconciliation.attempt_id !== "string" || typeof reconciliation.fencing_token !== "string") throw new Error("portable_backup_evidence_fence_missing");
  if (reconciliation.status === "claimed") {
    const leaseExpiry = Date.parse(String(reconciliation.lease_expires_at ?? ""));
    if (!Number.isFinite(leaseExpiry) || leaseExpiry <= Date.now()) throw new Error("portable_backup_evidence_lease_expired");
  }
  const step = (await querySqlAsync<StepRow>(`SELECT id, name, status, lane_id, metadata_json FROM run_steps WHERE run_id=${sqlValue(run.id)} ORDER BY id ASC LIMIT 1`))[0];
  if (!step || reconciliation.original_step_id !== step.id || reconciliation.original_run_id !== run.id) throw new Error("portable_backup_evidence_original_run_mismatch");
  if (!isObject(input.receipt)) throw new Error("portable_backup_evidence_receipt_invalid");
  const reported = input.receipt as Record<string, unknown>;
  if (reported.attempt_id !== reconciliation.attempt_id || reported.fencing_token !== reconciliation.fencing_token) throw new Error("portable_backup_evidence_fence_mismatch");
  const verified = backupEvidenceVerified(reported, reconciliation);
  if (isObject(reconciliation.reconciled_receipt)) {
    const saved = reconciliation.reconciled_receipt;
    const sameEvidence = isObject(saved) && JSON.stringify(saved.evidence) === JSON.stringify(reported.evidence)
      && JSON.stringify(saved.reconciliation_binding) === JSON.stringify(reported.reconciliation_binding)
      && JSON.stringify(saved.original_timeout_receipt) === JSON.stringify(reported.original_timeout_receipt);
    if (!verified || !sameEvidence) throw new Error("portable_backup_evidence_conflict");
    return { replayed: true, evidence_only: true, receipt: reconciliation.reconciled_receipt as PortableBackupEvidenceReceipt, artifact_uri: String(reconciliation.reconciled_receipt.artifact_uri ?? "") };
  }
  if (reconciliation.status !== "claimed") throw new Error("portable_backup_evidence_claim_not_active");
  const original = isObject(reported.original_timeout_receipt)
    ? reported.original_timeout_receipt
    : (isObject(reconciliation.original_timeout_receipt) ? reconciliation.original_timeout_receipt : {});
  const evidence = isObject(reported.evidence) ? sanitizeRecord(reported.evidence, 0) : {};
  const blocker = verified ? null : (typeof reported.exact_blocker === "string" && reported.exact_blocker.trim() ? reported.exact_blocker.slice(0, 240) : "portable_backup_evidence_verification_failed");
  const originalBinding = isObject(reconciliation.original_claim) ? reconciliation.original_claim : {};
  const originalInput = isObject(originalClaim.input_bundle) ? originalClaim.input_bundle : inputBundle(metadata);
  const terminalReceipt: PortableBackupEvidenceReceipt = {
    status: verified ? "complete" : "blocked", exact_blocker: blocker,
    external_action_executed: verified ? true : null, browser_surface: "local_worker",
    connector_execution_owner: "mac_worker_explicit_connector_fallback", workflow_id: BACKUP_EVIDENCE_WORKFLOW,
    run_id: run.id, step_id: step.id, cleanup_verified: verified, readback_verified: verified,
    effects_mode: "business_effect", read_only_stage_bound: false, business_effect_stage: "business_execute",
    same_run_receipt: verified, business_completion_verified: verified, business_proof_verified: verified, read_only_proof_verified: false,
    target_digest: typeof originalClaim.target_digest === "string" ? originalClaim.target_digest : undefined,
    input_bundle_sha256: typeof originalClaim.input_bundle_sha256 === "string" ? originalClaim.input_bundle_sha256 : undefined,
    same_run_source_sync: verified, external_executor_status: "portable_backup_post_effect_evidence_verifier",
    evidence_only: true, new_effect: false, provider_replayed: false,
    reconciliation_binding: originalBinding, original_timeout_receipt: original,
    original_claim: isObject(reported.original_claim) ? reported.original_claim : {}, evidence,
    adapter_result: { remote_verified: verified, evidence_only: true, execution_surface: "mac_local_worker", evidence },
    business_proofs: { backup_snapshot: verified, backup_remote_push: verified, backup_state: verified, cleanup_receipt: verified },
    web_operation_lifecycle: { schema: "automation_os_web_operation_lifecycle.v1", state: verified ? "completed" : "blocked",
      status: verified ? "complete" : "blocked", run_id: run.id, step_id: step.id,
      idempotency_key: BACKUP_EVIDENCE_KEY(run.id), operation: "publish",
      target_digest: typeof originalClaim.target_digest === "string" ? originalClaim.target_digest : null,
      payload_hash: typeof originalInput?.payload_hash === "string" ? originalInput.payload_hash : null,
      external_action_executed: verified, same_run_receipt: verified, readback_verified: verified,
      cleanup_verified: verified, no_replay: true, exact_blocker: blocker },
    runner_receipt: { status: verified ? "complete" : "blocked", same_run_source_sync: verified,
      business_proofs: { backup_snapshot: verified, backup_remote_push: verified, backup_state: verified, cleanup_receipt: verified } }
    , attempt_id: reconciliation.attempt_id, fencing_token: reconciliation.fencing_token
  };
  const strictProof = verified && businessProofSatisfied(BACKUP_EVIDENCE_WORKFLOW, terminalReceipt as unknown as Record<string, unknown>,
    { remote_verified: true }, {
      companyId: run.company_id, runId: run.id, stepId: step.id,
      idempotencyKey: BACKUP_EVIDENCE_KEY(run.id), targetDigest: typeof originalClaim.target_digest === "string" ? originalClaim.target_digest : null,
      inputBundleSha256: typeof originalClaim.input_bundle_sha256 === "string" ? originalClaim.input_bundle_sha256 : null,
      sourceSnapshotId: typeof originalInput?.source_snapshot_id === "string" ? originalInput.source_snapshot_id : null,
      payloadHash: typeof originalInput?.payload_hash === "string" ? originalInput.payload_hash : null
    });
  if (verified && !strictProof) {
    terminalReceipt.exact_blocker = "portable_backup_business_proof_rejected";
  }
  const accepted = verified && strictProof;
  const normalizedBlocker = accepted ? null : terminalReceipt.exact_blocker;
  const derivedCompletionFlags = {
    readback_verified: accepted, cleanup_verified: accepted, same_run_receipt: accepted,
    same_run_source_sync: accepted, business_completion_verified: accepted, business_proof_verified: accepted
  };
  // Preserve the verifier's raw observations in `evidence`, but make every
  // completion-facing field derive from one accepted decision. This prevents
  // a contradictory blocked receipt with true runner/business flags.
  terminalReceipt.status = accepted ? "complete" : "blocked";
  terminalReceipt.exact_blocker = normalizedBlocker;
  terminalReceipt.external_action_executed = accepted ? true : null;
  terminalReceipt.cleanup_verified = accepted;
  terminalReceipt.readback_verified = accepted;
  terminalReceipt.same_run_receipt = accepted;
  terminalReceipt.same_run_source_sync = accepted;
  terminalReceipt.business_completion_verified = accepted;
  terminalReceipt.business_proof_verified = accepted;
  terminalReceipt.adapter_result = { remote_verified: accepted, evidence_only: true, execution_surface: "mac_local_worker", evidence };
  terminalReceipt.business_proofs = { backup_snapshot: accepted, backup_remote_push: accepted, backup_state: accepted, cleanup_receipt: accepted };
  terminalReceipt.runner_receipt = { status: accepted ? "complete" : "blocked", same_run_source_sync: accepted,
    business_proofs: { backup_snapshot: accepted, backup_remote_push: accepted, backup_state: accepted, cleanup_receipt: accepted } };
  terminalReceipt.web_operation_lifecycle = { schema: "automation_os_web_operation_lifecycle.v1", state: accepted ? "completed" : "blocked",
    status: accepted ? "complete" : "blocked", run_id: run.id, step_id: step.id, idempotency_key: BACKUP_EVIDENCE_KEY(run.id),
    operation: "publish", target_digest: typeof originalClaim.target_digest === "string" ? originalClaim.target_digest : null,
    payload_hash: typeof originalInput?.payload_hash === "string" ? originalInput.payload_hash : null,
    external_action_executed: accepted, same_run_receipt: accepted, readback_verified: accepted,
    cleanup_verified: accepted, no_replay: true, exact_blocker: normalizedBlocker };
  terminalReceipt.raw_observations = {
    reported_status: reported.status ?? null, reported_external_action_executed: reported.external_action_executed ?? null,
    reported_same_run_receipt: reported.same_run_receipt ?? null, reported_same_run_source_sync: reported.same_run_source_sync ?? null,
    reported_readback_verified: reported.readback_verified ?? null, reported_cleanup_verified: reported.cleanup_verified ?? null,
    reported_business_proof_verified: reported.business_proof_verified ?? null
  };
  terminalReceipt.derived_completion_flags = derivedCompletionFlags;
  const timestamp = nowIso();
  const durableArtifact = buildPortableReceiptArtifact({ companyId: run.company_id, workflowId: BACKUP_EVIDENCE_WORKFLOW, workerId: id,
    registeredRoot: registeredRootAdmission(run, metadata, BACKUP_EVIDENCE_WORKFLOW), receipt: terminalReceipt, createdAt: timestamp });
  const artifactUri = durableArtifact.uri;
  const savedReceipt = { ...terminalReceipt, artifact_uri: artifactUri };
  const finalBlocker = terminalReceipt.exact_blocker;
  const attempts = Array.isArray(reconciliation.attempts) ? reconciliation.attempts : [];
  const nextAttempts = attempts.map((attempt) => isObject(attempt) && attempt.attempt_id === reconciliation.attempt_id
    ? { ...attempt, status: accepted ? "completed" : "failed", completed_at: timestamp, exact_blocker: finalBlocker,
      ...(!accepted ? { artifact_uri: artifactUri, artifact_sha256: durableArtifact.checksumSha256 } : {}) } : attempt);
  const nextReconciliation = { ...reconciliation, status: accepted ? "verified" : "blocked", completed_at: accepted ? timestamp : undefined,
    exact_blocker: finalBlocker, ...(accepted ? { reconciled_receipt: savedReceipt } : {}), evidence, original_timeout_receipt: original,
    worker_id: id, worker_instance_id: instanceId, attempts: nextAttempts,
    ...(!accepted ? { last_failed_attempt: { attempt_id: reconciliation.attempt_id, fencing_token: reconciliation.fencing_token,
      artifact_uri: artifactUri, artifact_sha256: durableArtifact.checksumSha256 } } : {}) };
  const nextMetadata = { ...metadata, ...(accepted ? { remote_worker_receipt: savedReceipt, external_action_executed: true, business_completion_verified: true, exact_blocker: null } : { external_action_executed: null, exact_blocker: finalBlocker }),
    portable_post_effect_reconciliation: nextReconciliation,
    worker_loop: { ...(isObject(metadata.worker_loop) ? metadata.worker_loop : {}), status: accepted ? "completed_business_effect" : "blocked", completedAt: timestamp },
    mac_worker: { ...(isObject(metadata.mac_worker) ? metadata.mac_worker : {}), status: accepted ? "completed_business_effect" : "blocked", completedAt: timestamp } };
  if (backupEvidenceSaveBarrierForTests) await backupEvidenceSaveBarrierForTests();
  if (!accepted) {
    await runSqlTransactionAsync([
      portableReceiptArtifactInsertStep({ artifact: durableArtifact, companyId: run.company_id, runId: run.id, stepId: step.id,
        workflowId: BACKUP_EVIDENCE_WORKFLOW, kind: "portable_backup_evidence_attempt", label: "daily-backup-safety-check failed evidence attempt" }),
      { sql: `UPDATE runs SET status=${sqlValue(run.status)}, updated_at=${sqlValue(timestamp)}, metadata_json=${sqlValue(nextMetadata)} WHERE id=${sqlValue(run.id)} AND metadata_json=${sqlValue(run.metadata_json)}${backupEvidenceLeasePredicate(reconciliation)}`, expectChanges: 1 }
    ]);
    return { replayed: false, evidence_only: true, receipt: { ...terminalReceipt, artifact_uri: artifactUri }, artifact_uri: artifactUri };
  }
  const proofId = makeId("proof");
  const stepMetadata = parseRecord(step.metadata_json);
  const completed = accepted;
  await runSqlTransactionAsync([
    portableReceiptArtifactInsertStep({ artifact: durableArtifact, companyId: run.company_id, runId: run.id, stepId: step.id, workflowId: BACKUP_EVIDENCE_WORKFLOW }),
    { sql: `UPDATE run_steps SET status='completed', completed_at=${sqlValue(timestamp)}, metadata_json=${sqlValue({ ...stepMetadata, exact_blocker: null, external_action_executed: true, business_completion_verified: true, portable_post_effect_reconciliation: savedReceipt, portable_external_artifact: artifactUri, proof_summary: "complete: verified backup evidence readback" })} WHERE id=${sqlValue(step.id)}`, expectChanges: 1 },
    ...(step.lane_id ? [{ sql: `UPDATE lanes SET status=${sqlValue(completed ? "completed" : "blocked")}, progress=${completed ? 100 : 50}, health=${sqlValue(completed ? "healthy" : "blocked")}, current_task=${sqlValue(completed ? "backup evidence verified" : blocker || "backup evidence blocked")}, updated_at=${sqlValue(timestamp)} WHERE id=${sqlValue(step.lane_id)}` }] : []),
    { sql: `UPDATE runs SET status=${sqlValue(completed ? "complete" : "blocked")}, updated_at=${sqlValue(timestamp)}, metadata_json=${sqlValue(nextMetadata)} WHERE id=${sqlValue(run.id)} AND metadata_json=${sqlValue(run.metadata_json)}${backupEvidenceLeasePredicate(reconciliation)}`, expectChanges: 1 },
    { sql: `INSERT INTO proofs (id, company_id, run_id, step_id, artifact_id, attempt_id, fencing_token, proof_type, label, uri, size_bytes, created_at, metadata_json) VALUES (${sqlValue(proofId)}, ${sqlValue(run.company_id)}, ${sqlValue(run.id)}, ${sqlValue(step.id)}, ${sqlValue(durableArtifact.id)}, ${sqlValue(reconciliation.attempt_id)}, ${sqlValue(reconciliation.fencing_token)}, 'worker_receipt', ${sqlValue("daily-backup-safety-check post-effect evidence")}, ${sqlValue(artifactUri)}, ${durableArtifact.sizeBytes}, ${sqlValue(timestamp)}, ${sqlValue({ evidence_only: true, external_action_executed: true, exact_blocker: null })})`, expectChanges: 1 },
    { sql: `INSERT INTO worker_events (id, run_id, step_id, lane_id, company_id, event_type, message, created_at, metadata_json) VALUES (${sqlValue(makeId("evt"))}, ${sqlValue(run.id)}, ${sqlValue(step.id)}, ${sqlValue(step.lane_id)}, ${sqlValue(run.company_id)}, ${sqlValue(completed ? "portable_backup_post_effect_verified" : "portable_backup_post_effect_blocked")}, ${sqlValue(completed ? "Backup evidence-only verifier reconciled the original run" : blocker || "Backup evidence-only verifier blocked")}, ${sqlValue(timestamp)}, ${sqlValue({ evidence_only: true, external_action_executed: true, provider_replayed: false })})`, expectChanges: 1 },
    ...backupEvidenceFinalizationSteps({ companyId: run.company_id, reconciliation, artifact: durableArtifact, timestamp })
  ]);
  return { replayed: false, evidence_only: true, receipt: savedReceipt, artifact_uri: artifactUri };
}

function workflowIdFromMetadata(metadata: Record<string, unknown>): string {
  const invocation = isObject(metadata.portable_workflow_invocation) ? metadata.portable_workflow_invocation : {};
  const worker = isObject(metadata.portable_worker) ? metadata.portable_worker : {};
  const value = invocation.workflow_id ?? worker.workflow_id ?? metadata.workflow_id;
  return typeof value === "string" ? value.trim() : "";
}

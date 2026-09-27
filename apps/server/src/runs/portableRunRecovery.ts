import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import { basename } from "node:path";
import { makeId, nowIso, querySqlAsync, runSqlTransactionAsync, sqlValue } from "../db/client.js";
import { getAutomationRecordAsync } from "../automations/repository.js";
import { canonicalJson, hashIdempotencyRequest, runIdempotentSqlMutationAsync } from "../automations/idempotency.js";
import { isPortableLocalWorkflowId, localWorkflowIdForRegisteredAutomation,
  preparePortableLocalBackupBusinessAdmission, preparePortableLocalBackupRecoveryAdmission, preparePortableLocalObsidianBusinessAdmission,
  type PortableLocalBusinessAdmission, type PortableLocalWorkflowId } from "./portableLocalWorkflow.js";
import { backupDestination } from "./backupSnapshotReadback.js";
import { DAILY_AI_RESEARCH_SYNC_WORKFLOW, prepareDailyAiResearchSyncAdmission } from "./dailyAiResearchSourceSync.js";
import { portableRecoveryRunId, startPortableLocalWorkflowRun, type PortableLocalWorkflowStartInput } from "./portableLocalWorkflowEntrypoint.js";
import { startPortableWorkflowRun, type PortableBusinessEffectStage, type PortableWorkflowStartInput } from "./portableWorkflowEntrypoint.js";
import type { PortableWorkflowId } from "./portableWorkflowContract.js";
import { validateRegisteredRootAdmissionV1, type RegisteredRootAdmissionV1 } from "./registeredRootAdmission.js";

type Run = { id: string; company_id: string; automation_id: string | null; automation_version_id: string | null;
  status: string; execution_source: string; quarantined: number; updated_at: string; metadata_json: string };
type Scope = { companyId: string; runId: string };
type Binding = Record<string, unknown> & { schema: "aos.portable_run_recovery.v1"; origin: NonNullable<PortableLocalWorkflowStartInput["recoveryOrigin"]>;
  workflow_id: PortableWorkflowId; automation_id: string; automation_version_id: string; execution_mode: "read_only" | "business_effect";
  business_admission: PortableLocalBusinessAdmission | null; input_bundle?: Record<string, unknown> | null;
  web_operation_intent?: Record<string, unknown> | null; browser_surface_requirement?: PortableWorkflowStartInput["browserSurfaceRequirement"];
  companion_task_id?: string | null; child_run_id?: string; parent_readback_token: string; created_at: string };
const record = (value: unknown): Record<string, any> => {
  if (typeof value === "string") { try { return record(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
};
const scopeKey = (runId: string) => `portable-run-recovery:${runId}`;
const retryKey = (runId: string) => `portable-retry-${runId}`;
const backupEvidenceKey = (runId: string) => `portable-backup-post-effect-${runId}`;
const WEB_POST_EFFECT_WORKFLOWS = new Set(["sns-multi-poster-ukiyoe", "x-authenticated-browser-lane", "daily-ai-research-publish-run"]);
const backupEffectOperationKey = (runId: string) => `backup-effect-${createHash("sha256").update(runId).digest("hex")}`;
const preDispatchNoEffectKey = (runId: string) => `portable-pre-dispatch-no-effect-${runId}`;
const dailyAiHistoricalReconciliationKey = (runId: string) => `portable-daily-ai-historical-reconcile-${runId}`;
const backupLedgerHash = (value: unknown): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return /^[a-f0-9]{64}$/u.test(text) ? text : createHash("sha256").update(text).digest("hex");
};

/**
 * A business receipt may already exist when the local child timed out after
 * the effect boundary. It is safe to enqueue only this exact ambiguous
 * envelope for evidence-only reconciliation; it must never become a retry.
 */
function backupReceiptAllowsEvidence(receipt: Record<string, any>): boolean {
  const local = record(receipt.adapter_result).local_receipt;
  return receipt.status === "blocked"
    && receipt.exact_blocker === "portable_remote_business_receipt_reconciliation_required"
    && receipt.external_action_executed === true
    && receipt.readback_verified !== true
    && receipt.business_completion_verified !== true
    && local.operation_effect_state === "effect_unknown"
    && local.reconciliation_required === true;
}

export type PortableBackupPostEffectReconciliationResponse = {
  schema: "aos.portable_backup_post_effect_reconciliation.v1";
  company_id: string;
  run_id: string;
  step_id: string;
  workflow_id: "daily-backup-safety-check";
  status: "queued" | "claimed" | "verified" | "blocked";
  exact_blocker: string | null;
  evidence_only: true;
  new_effect: false;
  provider_replayed: false;
  original_run_id: string;
  original_timeout_artifact: string;
  original_authority_id: string;
  original_authority_sha256: string;
};

export type PortableWebPostEffectReconciliationResponse = {
  schema: "aos.portable_web_post_effect_reconciliation.v1";
  company_id: string;
  run_id: string;
  step_id: string;
  workflow_id: "sns-multi-poster-ukiyoe" | "x-authenticated-browser-lane" | "daily-ai-research-publish-run";
  status: "verified";
  exact_blocker: null;
  new_effect: false;
  provider_replayed: false;
  replayed?: boolean;
  historical_receipt_sha256?: string;
  provider_receipt: Record<string, unknown>;
  source_readback: Record<string, unknown>;
};

export type PortablePreDispatchNoEffectReconciliationResponse = {
  schema: "aos.portable_pre_dispatch_no_effect_reconciliation.v1";
  company_id: string;
  run_id: string;
  step_id: string;
  workflow_id: "daily-ai-research-publish-run";
  status: "verified";
  exact_blocker: "portable_pre_dispatch_no_effect_reconciled";
  evidence_only: true;
  new_effect: false;
  provider_replayed: false;
  mutation_dispatch_attempted: false;
  mutation_dispatch_count: 0;
  target_url: "https://x.com/compose/post";
  observed_at: string;
};

export type PortableDailyAiHistoricalReconciliationResponse = {
  schema: "aos.portable_daily_ai_historical_reconciliation.v1";
  company_id: string;
  run_id: string;
  step_id: string;
  workflow_id: "daily-ai-research-publish-run";
  status: "queued";
  exact_blocker: "portable_daily_ai_historical_evidence_pending";
  evidence_only: true;
  new_effect: false;
  provider_replayed: false;
  root_id: string;
  root_digest: string;
};

function preDispatchNoEffectCandidate(receipt: Record<string, any>): boolean {
  const adapterResult = record(receipt.adapter_result);
  const companionReceipt = record(receipt.adapter_receipt);
  const reconciliation = record(adapterResult.reconciliation ?? receipt.reconciliation);
  const status = record(reconciliation.status);
  const blocker = record(status.blocker);
  const details = record(blocker.details);
  const lifecycle = record(receipt.web_operation_lifecycle);
  const target = record(status.target);
  const companionActions = Array.isArray(companionReceipt.actions) ? companionReceipt.actions : [];
  const companionDispatchCount = Number(companionReceipt.dispatch_count);
  const companionMutationWasDispatched = companionActions.some((action: any) => {
    const result = record(action?.result);
    return action?.effect_class === "external_commit" || result.mutationDispatchAttempted === true;
  });
  const nestedEvidence = blocker.code === "page_execution_timeout"
    && details.mutationDispatchAttempted === false
    && Number(status.dispatch_count) === 0
    && target.targetKey === "url:https://x.com/compose/post"
    && lifecycle.no_replay === true;
  // The persisted portable receipt is intentionally depth-limited. When the
  // Companion diagnostic is deeper than that redacted envelope, bind the
  // same proof to the normalized business receipt and require the fresh
  // target evidence in requestPortablePreDispatchNoEffectReconciliation.
  const normalizedEvidence = receipt.exact_blocker === "portable_remote_business_receipt_reconciliation_required"
    && receipt.effects_mode === "business_effect"
    && receipt.business_effect_stage === "publish"
    // A depth-limited historical receipt may omit the nested timeout details,
    // but it must still carry an explicit zero-dispatch Companion envelope.
    // This prevents a dispatched provider click from being reclassified as
    // pre-dispatch no-effect merely because the business receipt is incomplete.
    && companionReceipt.schema === "aos.chrome_companion.transaction.v1"
    && companionDispatchCount === 0
    && companionMutationWasDispatched === false;
  return receipt.status === "blocked"
    && receipt.external_action_executed === true
    && receipt.cleanup_verified === true
    && receipt.same_run_receipt !== true
    && receipt.readback_verified !== true
    && receipt.business_proof_verified !== true
    && (nestedEvidence || normalizedEvidence);
}

function sameBinding(left: Record<string, any>, right: Record<string, any>): boolean {
  const fields = ["company_id", "run_id", "step_id", "workflow_id", "approval_id", "idempotency_key",
    "target_digest", "input_bundle_sha256", "account_ref", "target_key", "payload_hash", "source_snapshot_id",
    "registered_root_id", "registered_root_digest"];
  return fields.every((field) => (left[field] ?? null) === (right[field] ?? null));
}

async function loadContext(input: Scope) {
  const run = (await querySqlAsync<Run>(`SELECT id, company_id, automation_id, automation_version_id, status,
    execution_source, quarantined, updated_at, metadata_json FROM runs
    WHERE id=${sqlValue(input.runId)} AND company_id=${sqlValue(input.companyId)} LIMIT 1`))[0];
  if (!run) throw new Error("portable_recovery_run_not_found");
  const metadata = record(run.metadata_json);
  const steps = await querySqlAsync<{ id: string; status: string; lane_id: string | null; started_at: string | null; metadata_json: string }>(
    `SELECT id, status, lane_id, started_at, metadata_json FROM run_steps WHERE run_id=${sqlValue(run.id)} ORDER BY id`);
  const approvalRows = await querySqlAsync<Record<string, unknown>>(`SELECT id, status, run_id, company_id,
    action_kind, target_account_ref_id, payload_hash, policy_version, expires_at, decided_at, decision_revision
    FROM approvals WHERE run_id=${sqlValue(run.id)} AND company_id=${sqlValue(run.company_id)} ORDER BY created_at`);
  const automation = run.automation_id ? await getAutomationRecordAsync(run.company_id, run.automation_id, true) : undefined;
  const retryRow = (await querySqlAsync<{ response_json: string }>(`SELECT response_json FROM mvp_idempotency_keys
    WHERE company_id=${sqlValue(run.company_id)} AND scope=${sqlValue(scopeKey(run.id))}
      AND idempotency_key='retry' AND status='completed' LIMIT 1`))[0];
  const retryBinding = retryRow ? record(retryRow.response_json) as Binding : null;
  const childId = retryBinding ? (retryBinding.child_run_id ?? portableRecoveryRunId(retryBinding.origin)) : null;
  const child = childId ? (await querySqlAsync<{ id: string; status: string }>(`SELECT id, status FROM runs
    WHERE id=${sqlValue(childId)} AND company_id=${sqlValue(run.company_id)} LIMIT 1`))[0] : null;
  const workflowId = String(metadata.workflow_id ?? metadata.registered_workflow_id ?? "");
  const claim = record(metadata.remote_worker_claim);
  const receipt = record(metadata.remote_worker_receipt);
  const receiptLifecycle = record(receipt.web_operation_lifecycle);
  // Some historical Daily AI business Runs persisted the approval and the
  // publish receipt but omitted effect_stage. Preserve the approval boundary
  // when calculating whether a future retry needs a fresh approval.
  const business = metadata.effect_stage === "business_execute" || metadata.portable_worker?.mode === "business_effect"
    || metadata.portable_workflow_invocation?.effect_stage === "publish"
    || receipt.effects_mode === "business_effect" || receipt.business_effect_stage === "publish"
    || receiptLifecycle.operation === "publish"
    || approvalRows.some((approval) => approval.action_kind === "publish");
  const evidence = [metadata, ...steps.map((step) => record(step.metadata_json)), receipt];
  const positive = evidence.some((item) => item.external_action_executed === true);
  // A Daily AI run that has passed the exact pre-dispatch/no-effect proof is
  // still a supported registered web workflow. It must be retryable with a
  // fresh approval; otherwise the proof would leave the operator stranded
  // behind the generic "unsupported" blocker.
  const preDispatchNoEffectReconciled = workflowId === "daily-ai-research-publish-run"
    && record(metadata.portable_pre_dispatch_no_effect_reconciliation).schema
      === "aos.portable_pre_dispatch_no_effect_reconciliation.v1"
    && record(metadata.portable_pre_dispatch_no_effect_reconciliation).new_effect === false
    && metadata.external_action_executed === false;
  const webReconciliationWorkflow = WEB_POST_EFFECT_WORKFLOWS.has(workflowId)
    && (positive || preDispatchNoEffectReconciled);
  const supported = (isPortableLocalWorkflowId(workflowId)
    ? metadata.portable_worker?.local_worker === true
    : webReconciliationWorkflow)
    && run.execution_source === "automation-os" && Number(run.quarantined) === 0;
  const hasClaim = Boolean(metadata.remote_worker_claim);
  const hasReceipt = Boolean(metadata.remote_worker_receipt);
  const unknown = evidence.some((item) => item.external_action_executed === null
    || item.operation_effect_state === "unknown" || item.reconciliation_required === true);
  const leaseExpiry = Date.parse(String(claim.lease_expires_at ?? ""));
  const activeClaim = hasClaim && !claim.completed_at && (!Number.isFinite(leaseExpiry) || leaseExpiry > Date.now());
  const explicitReadOnly = !business && metadata.read_only_stage === "reference_readback";
  const noEffect = !positive && !unknown && (
    // Legacy queued read-only steps store the admission time in started_at.
    // The claim is the worker boundary; that old timestamp is not an effect.
    (!hasClaim && !hasReceipt && (explicitReadOnly || (business && steps.every((step) => !step.started_at)))
      && metadata.portable_worker?.external_action_executed === false)
    || (hasReceipt && receipt.external_action_executed === false && receipt.cleanup_verified === true)
    || (explicitReadOnly && !activeClaim && metadata.portable_remote_claim_reconciled === true
      && metadata.external_action_executed === false));
  const externalActionExecuted = positive ? true : noEffect ? false : null;
  const registrationMatches = Boolean(automation && !automation.archivedAt
    && automation.currentVersionId === run.automation_version_id
    && (localWorkflowIdForRegisteredAutomation(automation) === workflowId || webReconciliationWorkflow));
  const token = hashIdempotencyRequest({ run, steps, approvals: approvalRows,
    source: automation ? { id: automation.id, revision: automation.revision, version: automation.currentVersionId, archived: automation.archivedAt } : null });
  const commonBlocker = !supported ? "portable_recovery_workflow_unsupported"
    : positive ? "portable_recovery_effect_already_executed"
    : !noEffect ? "portable_recovery_effect_unconfirmed"
    : activeClaim ? "portable_recovery_worker_claim_active" : null;
  const cancelBlocker = commonBlocker ?? (hasClaim || hasReceipt || !["queued", "waiting_approval"].includes(run.status)
    ? "portable_recovery_run_not_cancellable" : null);
  const retryBlocker = commonBlocker ?? (!registrationMatches ? "portable_recovery_registration_changed"
    : !["blocked", "failed", "timed_out", "cancelled"].includes(run.status) ? "portable_recovery_run_not_retryable"
    : retryBinding ? (!child || child.status === "preparing" ? "portable_recovery_retry_preparing" : "portable_recovery_retry_already_prepared") : null);
  const inputBundle = record(record(metadata.portable_input_bundle).input);
  const backupReconciliation = record(metadata.portable_post_effect_reconciliation);
  const preDispatchNoEffectReconciliation = record(metadata.portable_pre_dispatch_no_effect_reconciliation);
  const view = { schema: "aos.portable_run_recovery.v1", company_id: run.company_id, run_id: run.id,
    automation_id: run.automation_id, automation_version_id: run.automation_version_id, workflow_id: workflowId,
    status: run.status, checked_at: nowIso(), updated_at: run.updated_at, readback_token: token,
    execution_mode: business ? "business_effect" : "read_only", external_action_executed: externalActionExecuted,
    claim_active: activeClaim, receipt_present: hasReceipt, registration_matches: registrationMatches,
    can_cancel: !cancelBlocker, cancel_blocker: cancelBlocker, can_retry: !retryBlocker, retry_blocker: retryBlocker,
    requires_fresh_approval: business, account_ref: inputBundle.account_ref ?? null, target_key: inputBundle.target_key ?? null,
    content_key: inputBundle.content_key ?? null,
    payload_hash: inputBundle.payload_hash ?? null, approvals: approvalRows,
    retry: retryBinding ? { run_id: childId, status: child?.status ?? "preparation_unconfirmed", created_at: retryBinding.created_at,
      result_confirmed: Boolean(child && child.status !== "preparing") } : null,
    parent_run_id: record(metadata.recovery_origin).parent_run_id ?? null };
  Object.assign(view, {
    backup_post_effect_reconciliation: backupReconciliation.schema === "aos.portable_backup_post_effect_reconciliation.v1"
      ? { schema: backupReconciliation.schema, status: backupReconciliation.status ?? "unknown",
          exact_blocker: backupReconciliation.exact_blocker ?? null, evidence_only: backupReconciliation.evidence_only === true,
          provider_replayed: backupReconciliation.provider_replayed === true, new_effect: backupReconciliation.new_effect === true }
      : null,
    can_reconcile_backup_evidence: workflowId === "daily-backup-safety-check" && business
      && Boolean(metadata.remote_worker_claim)
      && ((!hasReceipt && externalActionExecuted === null)
        || (hasReceipt && backupReceiptAllowsEvidence(receipt)))
      && backupReconciliation.status !== "verified",
    can_reconcile_web_post_effect: webReconciliationWorkflow && positive && hasReceipt
      && record(metadata.portable_web_post_effect_reconciliation).status !== "verified"
  });
  Object.assign(view, {
    can_reconcile_pre_dispatch_no_effect: workflowId === "daily-ai-research-publish-run" && hasReceipt
      && preDispatchNoEffectCandidate(receipt)
      && preDispatchNoEffectReconciliation.status !== "verified"
  });
  return { run, metadata, steps, approvalRows, automation, retryBinding, workflowId, business, inputBundle, token, view };
}

export async function readPortableRunRecovery(input: Scope) { return (await loadContext(input)).view; }

type DailyAiReconciliationContext = Record<string, string>;

const DAILY_AI_RECONCILIATION_CONTEXT_FIELDS = {
  company_id: ["company_id", "companyId", "company"],
  run_id: ["run_id", "runId", "run"],
  workflow_id: ["workflow_id", "workflowId", "workflow"],
  step_id: ["step_id", "stepId", "step"],
  owner_id: ["owner_id", "ownerId", "owner"],
  task_id: ["task_id", "taskId", "task"],
  session_id: ["session_id", "sessionId", "session"],
  lease_id: ["lease_id", "leaseId", "lease"],
  target_key: ["target_key", "targetKey", "target_id", "targetId", "target"],
} as const;

const DAILY_AI_RECONCILIATION_ID_FIELDS = Object.keys(DAILY_AI_RECONCILIATION_CONTEXT_FIELDS) as Array<keyof typeof DAILY_AI_RECONCILIATION_CONTEXT_FIELDS>;

function dailyAiContextRecords(value: unknown): Record<string, any>[] {
  const root = record(value);
  const nested = [
    root.effect_context, root.effectContext, root.context, root.binding, root.identity,
    root.operation, root.web_operation_lifecycle, root.adapter_result, root.adapter_receipt,
    root.reconciliation, root.target, root.session, root.tab, root.execution_context,
    record(root.adapter_receipt).reconciliation, record(root.adapter_receipt).session,
    record(root.adapter_receipt).tab, record(root.adapter_receipt).execution_context,
    record(root.adapter_receipt).reconciliation && record(root.adapter_receipt).reconciliation.status,
    record(root.adapter_receipt).reconciliation && record(root.adapter_receipt).reconciliation.status?.target,
    record(root.adapter_receipt).reconciliation && record(root.adapter_receipt).reconciliation.status?.tab,
  ].flatMap((candidate) => {
    const nestedRecord = record(candidate);
    return Object.keys(nestedRecord).length > 0 ? [nestedRecord] : [];
  });
  return [root, ...nested];
}

function dailyAiContextValue(values: unknown[], aliases: readonly string[]): string | undefined {
  for (const value of values) for (const candidate of dailyAiContextRecords(value)) {
    for (const alias of aliases) {
      const raw = candidate[alias];
      if (typeof raw === "string" && raw.trim()) return raw.trim();
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const nested = record(raw);
        for (const nestedKey of ["id", "key", "target_key", "targetKey"]) {
          if (typeof nested[nestedKey] === "string" && nested[nestedKey].trim()) return nested[nestedKey].trim();
        }
      }
    }
  }
  return undefined;
}

function dailyAiReconciliationContext(values: unknown[], inputBundle?: Record<string, any>): DailyAiReconciliationContext {
  const context: DailyAiReconciliationContext = {};
  for (const field of DAILY_AI_RECONCILIATION_ID_FIELDS) {
    const value = dailyAiContextValue(values, DAILY_AI_RECONCILIATION_CONTEXT_FIELDS[field]);
    if (value !== undefined) context[field] = value;
  }
  if (!context.target_key && typeof inputBundle?.target_key === "string" && inputBundle.target_key.trim()) {
    context.target_key = inputBundle.target_key.trim();
  }
  return context;
}

/**
 * Recover only the owner/task identity that the run itself persisted when a
 * depth-limited remote receipt omitted its adapter envelope.  The run and
 * workflow/step binding below are still constructed from the current Run and
 * step, while provider, target, payload and cleanup evidence remain subject
 * to the normal reconciliation validator.
 */
export function dailyAiPersistedEffectContext({ run, metadata, original, workflowId, stepId, inputBundle }: {
  run: Run; metadata: Record<string, any>; original: Record<string, any>; workflowId: string; stepId: string;
  inputBundle: Record<string, any>;
}): DailyAiReconciliationContext {
  const receiptContext = dailyAiReconciliationContext([original], inputBundle);
  const persistedExecutionContext = record(metadata.execution_context);
  const persistedInvocation = record(metadata.portable_workflow_invocation);
  const metadataRunIds = [persistedExecutionContext.run_id, persistedExecutionContext.runId,
    persistedInvocation.run_id, persistedInvocation.runId]
    .map((value) => typeof value === "string" ? value.trim() : "")
    .filter(Boolean);
  // If a nested metadata context explicitly names another run, do not use it
  // as a binding fallback. The outer metadata row is loaded by this exact Run
  // but an embedded foreign context must remain a hard mismatch.
  const metadataBelongsToRun = metadataRunIds.length > 0 && metadataRunIds.every((value) => value === run.id);
  const ownerId = receiptContext.owner_id
    || (metadataBelongsToRun && typeof persistedExecutionContext.owner_id === "string" ? persistedExecutionContext.owner_id.trim() : "");
  const taskId = receiptContext.task_id
    || (metadataBelongsToRun && typeof (persistedInvocation.companion_task_id ?? persistedInvocation.task_id) === "string"
      ? String(persistedInvocation.companion_task_id ?? persistedInvocation.task_id).trim() : "");
  return {
    company_id: run.company_id,
    run_id: run.id,
    workflow_id: workflowId,
    step_id: stepId,
    ...(ownerId ? { owner_id: ownerId } : {}),
    ...(taskId ? { task_id: taskId } : {}),
    target_key: inputBundle.target_key,
  };
}

function dailyAiRetainedResourcesEmpty(value: unknown): boolean {
  return value === false || value === ""
    || Array.isArray(value) && value.length === 0
    || Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0);
}

function dailyAiTerminalCleanupConfirmed(receipt: Record<string, any>): boolean {
  const cleanup = record(receipt.cleanup);
  const terminalValues = [
    receipt.terminal_cleanup_confirmed, receipt.cleanup_terminal_confirmed,
    cleanup.terminal_cleanup_confirmed, cleanup.cleanup_terminal_confirmed,
    receipt.terminal_cleanup, cleanup.terminal_cleanup,
  ];
  if (terminalValues.some((value) => value === true)) return true;
  const terminalStatuses = [
    receipt.terminal_cleanup_status, receipt.terminal_tab_cleanup,
    cleanup.terminal_cleanup_status, cleanup.terminal_tab_cleanup,
    ...terminalValues.filter((value) => typeof value === "string"),
  ];
  return terminalStatuses.some((value) => ["confirmed", "completed", "verified", "cleaned"].includes(String(value)));
}

function dailyAiSupplementalCleanupValid({ inputBundle, original, cleanupReceipt, effectContext }: {
  inputBundle: Record<string, any>; original: Record<string, any>; cleanupReceipt: unknown; effectContext?: unknown;
}): boolean {
  const cleanup = record(cleanupReceipt);
  if (Object.keys(cleanup).length === 0) return false;
  if (cleanup.schema !== "aos.chrome_companion.cleanup_receipt.v1"
    || cleanup.evidence_source !== "aos_chrome_companion_task_terminal_cleanup") return false;
  const originalContext = dailyAiReconciliationContext([original], inputBundle);
  const expectedContext = dailyAiReconciliationContext([effectContext, original], inputBundle);
  const cleanupContext = dailyAiReconciliationContext([cleanup], inputBundle);
  // A cleanup proof cannot repair a publish receipt whose original target
  // context disagrees with the immutable single-post input bundle.
  if (originalContext.target_key && originalContext.target_key !== inputBundle.target_key) return false;
  for (const field of DAILY_AI_RECONCILIATION_ID_FIELDS) {
    if (!expectedContext[field] || cleanupContext[field] !== expectedContext[field]) return false;
    if (originalContext[field] && originalContext[field] !== expectedContext[field]) return false;
  }
  const cleanupEvidence = record(cleanup.cleanup);
  const sessionClosed = cleanup.session_closed === true || cleanupEvidence.session_closed === true;
  const leaseReleased = cleanup.lease_released === true
    || cleanup.lease_released_by_session_close === true
    || cleanupEvidence.lease_released === true
    || cleanupEvidence.lease_released_by_session_close === true;
  const retainedValues = [
    cleanup.retained_resources, cleanup.resources_retained, cleanup.remaining_resources,
    cleanup.remaining_work_retained, cleanupEvidence.retained_resources, cleanupEvidence.resources_retained,
    cleanupEvidence.remaining_resources, cleanupEvidence.remaining_work_retained,
  ];
  const retainedFieldPresent = retainedValues.some((value) => value !== undefined);
  return sessionClosed && leaseReleased && retainedFieldPresent
    && retainedValues.filter((value) => value !== undefined).every(dailyAiRetainedResourcesEmpty)
    && dailyAiTerminalCleanupConfirmed(cleanup);
}

// Operator reconciliation is not a retroactive same-tab browser observation.
// Keep the original receipt and require the separately committed queue result.
export function validateDailyAiManualReconciliation({ inputBundle, original, providerUrl, sourceReadback, cleanupReceipt, effectContext }: {
  inputBundle: Record<string, any>; original: Record<string, any>; providerUrl: string; sourceReadback: Record<string, any>;
  cleanupReceipt?: unknown; effectContext?: unknown;
}) {
  const commit = record(sourceReadback.queue_commit);
  const url = new URL(providerUrl);
  const platform = String(inputBundle.target_key || "").endsWith(":linkedin") ? "linkedin" : "x";
  const xMatch = /^\/nichika2000823\/status\/([0-9]+)$/u.exec(url.pathname);
  const linkedinMatch = /^\/feed\/update\/urn:li:(activity|share):([0-9]+)$/u.exec(url.pathname);
  const expectedUrl = platform === "x"
    ? url.origin === "https://x.com" && Boolean(xMatch) && !url.search && !url.hash
    : url.origin === "https://www.linkedin.com" && Boolean(linkedinMatch) && !url.search && !url.hash;
  const expectedPostUrl = platform === "x" ? providerUrl : providerUrl;
  const expectedPostId = platform === "x" ? xMatch?.[1] : linkedinMatch?.[2];
  const afterUrl = platform === "x" ? commit.after?.x_post_url : commit.after?.linkedin_post_url;
  const afterId = platform === "x" ? commit.after?.x_post_id : commit.after?.linkedin_post_id;
  const supplementalCleanup = cleanupReceipt
    ?? sourceReadback.cleanup_receipt ?? sourceReadback.terminal_cleanup_receipt;
  const cleanupAccepted = original.cleanup_verified === true
    ? supplementalCleanup === undefined || dailyAiSupplementalCleanupValid({ inputBundle, original, cleanupReceipt: supplementalCleanup, effectContext })
    : dailyAiSupplementalCleanupValid({ inputBundle, original, cleanupReceipt: supplementalCleanup, effectContext });
  if (inputBundle.execution_scope !== "single_existing_post" || inputBundle.account_ref !== "daily_ai_social_readback"
    || inputBundle.target_key !== `${inputBundle.content_key}:${platform}` || !cleanupAccepted
    || !expectedUrl
    || commit.schema !== "aos.daily_ai_provider_queue_commit.v1" || commit.status !== "completed"
    || commit.content_key !== inputBundle.content_key || commit.platform !== platform
    || !/^[a-f0-9]{64}$/u.test(String(commit.row_checksum || ""))
    || afterUrl !== expectedPostUrl || afterId !== expectedPostId) {
    throw new Error("daily_ai_post_reconciliation_evidence_invalid");
  }
}

function storedHistoricalRootIdentity(metadata: Record<string, any>, run: Run, workflowId: string): RegisteredRootAdmissionV1 {
  const value = record(metadata.registered_root_admission);
  const issuedAt = Date.parse(String(value.issued_at || ""));
  if (!Number.isFinite(issuedAt)) throw new Error("portable_daily_ai_historical_root_missing");
  const invocation = record(metadata.portable_workflow_invocation);
  const registeredAutomationId = typeof invocation.registered_automation_id === "string"
    ? invocation.registered_automation_id : workflowId;
  // Validate every immutable root field and digest, but evaluate expiry at the
  // root's own issued_at. The returned value is provenance only; it is never
  // used as a new execution authority or extended in storage.
  return validateRegisteredRootAdmissionV1(value, {
    registeredAutomationId, workflowId, runId: run.id
  }, issuedAt);
}

/**
 * Admit one official, evidence-only Daily AI historical reconciliation request.
 * This is the only supported way to issue a fresh short-lived worker claim for
 * an old run whose original registered root has expired. It preserves the
 * stored root identity/digest and never creates a new business authority.
 */
export async function requestPortableDailyAiHistoricalReconciliation(input: Scope & {
  expectedReadbackToken: string;
  idempotencyKey: string;
}): Promise<{ replayed: boolean; response: PortableDailyAiHistoricalReconciliationResponse }> {
  const key = dailyAiHistoricalReconciliationKey(input.runId);
  if (input.idempotencyKey !== key) throw new Error("portable_daily_ai_historical_reconciliation_idempotency_binding_invalid");
  const context = await loadContext(input);
  const { run, metadata, steps, view, inputBundle } = context;
  if (context.workflowId !== "daily-ai-research-publish-run"
    || !context.business || (view as Record<string, any>).can_reconcile_web_post_effect !== true
    || inputBundle.execution_scope !== "single_existing_post"
    || inputBundle.account_ref !== "daily_ai_social_readback"
    || ![`${inputBundle.content_key}:x`, `${inputBundle.content_key}:linkedin`].includes(String(inputBundle.target_key))) {
    throw new Error("portable_daily_ai_historical_reconciliation_not_supported");
  }
  const existingKey = (await querySqlAsync<{ response_json: string; status: string }>(`SELECT response_json, status FROM mvp_idempotency_keys
    WHERE company_id=${sqlValue(run.company_id)} AND scope=${sqlValue(scopeKey(run.id))}
      AND idempotency_key=${sqlValue(key)} LIMIT 1`))[0];
  if (existingKey?.status === "pending") throw new Error("idempotency_request_pending");
  if (existingKey?.status === "completed") {
    const saved = record(existingKey.response_json);
    if (saved.schema === "aos.portable_daily_ai_historical_reconciliation.v1"
      && saved.company_id === run.company_id && saved.run_id === run.id
      && saved.workflow_id === context.workflowId && saved.evidence_only === true
      && saved.new_effect === false && saved.provider_replayed === false) {
      return { replayed: true, response: saved as PortableDailyAiHistoricalReconciliationResponse };
    }
    throw new Error("idempotency_response_invalid");
  }
  if (view.readback_token !== input.expectedReadbackToken) throw new Error("portable_recovery_readback_changed");
  const original = record(metadata.remote_worker_receipt);
  const claim = record(metadata.remote_worker_claim);
  const step = steps[0];
  const authority = record(claim.portable_effect_authority ?? claim.effect_authority);
  if (!step || claim.run_id !== run.id || claim.step_id !== step.id || claim.workflow_id !== context.workflowId
    || original.external_action_executed !== true || original.same_run_receipt === true
    || !authority.authority_id || authority.company_id !== run.company_id || authority.run_id !== run.id
    || authority.step_id !== step.id || authority.workflow_id !== context.workflowId) {
    throw new Error("portable_daily_ai_historical_reconciliation_binding_invalid");
  }
  const root = storedHistoricalRootIdentity(metadata, run, context.workflowId);
  const existingReconciliation = record(metadata.portable_daily_ai_post_effect_reconciliation);
  const retryAfter = Date.parse(String(existingReconciliation.retry_after || ""));
  if (existingReconciliation.status === "claimed" && Date.parse(String(existingReconciliation.lease_expires_at || "")) > Date.now()) {
    throw new Error("portable_daily_ai_historical_claim_active");
  }
  if (existingReconciliation.status === "blocked" && Number.isFinite(retryAfter) && retryAfter > Date.now()) {
    throw new Error("portable_daily_ai_historical_retry_after");
  }
  const existingRequest = record(metadata.portable_daily_ai_historical_reconciliation_request);
  if (existingRequest.schema === "aos.portable_daily_ai_historical_reconciliation.v1"
    && existingRequest.run_id === run.id && existingRequest.root_id === root.root_id
    && existingRequest.root_digest === root.root_digest && existingRequest.status === "queued") {
    return { replayed: true, response: existingRequest as PortableDailyAiHistoricalReconciliationResponse };
  }
  const now = nowIso();
  const response: PortableDailyAiHistoricalReconciliationResponse = {
    schema: "aos.portable_daily_ai_historical_reconciliation.v1",
    company_id: run.company_id, run_id: run.id, step_id: step.id,
    workflow_id: "daily-ai-research-publish-run", status: "queued",
    exact_blocker: "portable_daily_ai_historical_evidence_pending", evidence_only: true,
    new_effect: false, provider_replayed: false, root_id: root.root_id, root_digest: root.root_digest
  };
  const request = { company_id: run.company_id, run_id: run.id, action: "reconcile-daily-ai-post-effect",
    expected_readback_token: input.expectedReadbackToken, root_id: root.root_id, root_digest: root.root_digest };
  const nextMetadata = {
    ...metadata,
    portable_daily_ai_historical_reconciliation_request: {
      ...response, requested_at: now, idempotency_key: key,
      readback_token_sha256: createHash("sha256").update(input.expectedReadbackToken).digest("hex")
    },
    worker_loop: { ...record(metadata.worker_loop), status: "waiting_for_historical_readback", queuedAt: now },
    mac_worker: { ...record(metadata.mac_worker), status: "waiting_for_historical_readback", queuedAt: now }
  };
  const mutation = await runIdempotentSqlMutationAsync({
    companyId: run.company_id, scope: scopeKey(run.id), key, request, response,
    resourceSteps: [{
      sql: `UPDATE runs SET metadata_json=${sqlValue(nextMetadata)}, updated_at=${sqlValue(now)}
        WHERE id=${sqlValue(run.id)} AND company_id=${sqlValue(run.company_id)} AND metadata_json=${sqlValue(run.metadata_json)}`,
      expectChanges: 1
    }]
  });
  return { replayed: mutation.replayed, response: mutation.response as PortableDailyAiHistoricalReconciliationResponse };
}

/**
 * Close an already-dispatched SNS/X effect from same-target evidence. This is
 * evidence-only: it never invokes the provider and never creates a retry.
 */
export async function requestPortableWebPostEffectReconciliation(input: Scope & {
  expectedReadbackToken: string;
  idempotencyKey: string;
  providerReceipt: unknown;
  sourceReadback: unknown;
  historicalReceiptSha256?: string;
}): Promise<{ replayed: boolean; response: PortableWebPostEffectReconciliationResponse }> {
  const key = `portable-web-post-effect-${input.runId}`;
  if (input.idempotencyKey !== key) throw new Error("portable_web_post_effect_idempotency_binding_invalid");
  const context = await loadContext(input);
  const { run, metadata, steps, view, inputBundle } = context;
  if (!WEB_POST_EFFECT_WORKFLOWS.has(context.workflowId)) throw new Error("portable_web_post_effect_workflow_invalid");
  const claim = record(metadata.remote_worker_claim);
  const original = record(metadata.remote_worker_receipt);
  const authority = record(claim.portable_effect_authority ?? claim.effect_authority);
  const step = steps[0];
  if (!step || claim.run_id !== run.id || claim.step_id !== step.id || claim.workflow_id !== context.workflowId) {
    throw new Error("portable_web_post_effect_original_claim_missing");
  }
  const claimIdempotencyKey = typeof claim.idempotency_key === "string"
    ? claim.idempotency_key
    : authority.idempotency_key;
  if (!authority.authority_id || authority.company_id !== run.company_id
    || authority.workflow_id !== context.workflowId || authority.run_id !== run.id
    || authority.step_id !== step.id || authority.idempotency_key !== claimIdempotencyKey) {
    throw new Error("portable_web_post_effect_authority_binding_mismatch");
  }
  const providerReceipt = record(input.providerReceipt);
  const providerUrl = typeof providerReceipt.post_url === "string" ? providerReceipt.post_url : "";
  let parsedUrl: URL;
  try { parsedUrl = new URL(providerUrl); } catch { throw new Error("portable_web_post_effect_provider_url_invalid"); }
  const dailyTargetIsLinkedIn = String(inputBundle.target_key || "").endsWith(":linkedin");
  const allowedDailyUrl = dailyTargetIsLinkedIn
    ? parsedUrl.origin === "https://www.linkedin.com" && /^\/feed\/update\/urn:li:(?:activity|share):[0-9]+$/u.test(parsedUrl.pathname)
    : parsedUrl.origin === "https://x.com" && /^\/[^/]+\/status\/[0-9]+(?:$|[/?])/u.test(parsedUrl.pathname);
  if (!allowedDailyUrl) {
    throw new Error("portable_web_post_effect_provider_url_not_allowlisted");
  }
  const sourceReadback = record(input.sourceReadback);
  if (context.workflowId === "daily-ai-research-publish-run") {
    const effectContext = dailyAiPersistedEffectContext({
      run,
      metadata,
      original,
      workflowId: context.workflowId,
      stepId: step.id,
      inputBundle,
    });
    validateDailyAiManualReconciliation({
      inputBundle,
      original,
      providerUrl: parsedUrl.href,
      sourceReadback,
      effectContext,
    });
  }
  if (sourceReadback.post_url !== parsedUrl.href
    || sourceReadback.same_target !== true
    || sourceReadback.content_match !== true
    || sourceReadback.content_key !== inputBundle.content_key
    || sourceReadback.payload_hash !== authority.payload_hash) {
    throw new Error("portable_web_post_effect_source_readback_mismatch");
  }
  const existing = record(metadata.portable_web_post_effect_reconciliation);
  if (existing.status === "verified") {
    const saved = record(existing.response);
    // Replays arrive with the pre-reconciliation readback token, while the
    // persisted receipt now (correctly) has same_run_receipt=true.  Resolve
    // the durable result only after binding the request to this exact Run,
    // step, workflow, company, target, hash, and URL; do not re-run the
    // original-receipt "not reconcilable" guard on an already completed
    // reconciliation.
    const savedSource = record(saved.source_readback);
    const savedProvider = record(saved.provider_receipt);
    if (saved.schema === "aos.portable_web_post_effect_reconciliation.v1"
      && saved.company_id === run.company_id && saved.run_id === run.id && saved.step_id === step.id
      && saved.workflow_id === context.workflowId && saved.status === "verified"
      && saved.new_effect === false && saved.provider_replayed === false
      && (input.historicalReceiptSha256 === undefined || saved.historical_receipt_sha256 === input.historicalReceiptSha256)
      && savedProvider.post_url === parsedUrl.href && savedSource.post_url === parsedUrl.href
      && savedSource.content_key === inputBundle.content_key
      && savedSource.payload_hash === authority.payload_hash
      && savedSource.same_target === true && savedSource.content_match === true) {
      return { replayed: true, response: { ...saved, replayed: true } as PortableWebPostEffectReconciliationResponse };
    }
    throw new Error("portable_web_post_effect_reconciliation_conflict");
  }
  if (view.readback_token !== input.expectedReadbackToken) throw new Error("portable_recovery_readback_changed");
  if (original.external_action_executed !== true || original.same_run_receipt === true) {
    throw new Error("portable_web_post_effect_not_reconcilable");
  }
  const now = nowIso();
  const response: PortableWebPostEffectReconciliationResponse = {
    schema: "aos.portable_web_post_effect_reconciliation.v1",
    company_id: run.company_id,
    run_id: run.id,
    step_id: step.id,
    workflow_id: context.workflowId as PortableWebPostEffectReconciliationResponse["workflow_id"],
    status: "verified",
    exact_blocker: null,
    new_effect: false,
    provider_replayed: false,
    ...(input.historicalReceiptSha256 ? { historical_receipt_sha256: input.historicalReceiptSha256 } : {}),
    provider_receipt: { schema: "aos.sns.provider_receipt.v1", post_url: parsedUrl.href },
    source_readback: {
      schema: "aos.sns.source_of_truth_readback.v1",
      post_url: parsedUrl.href,
      same_target: true,
      content_match: true,
      content_key: inputBundle.content_key,
      payload_hash: authority.payload_hash,
      observed_at: typeof sourceReadback.observed_at === "string" ? sourceReadback.observed_at : now,
      ...(context.workflowId === "daily-ai-research-publish-run" ? {
        verification_basis: "operator_verified_post_and_canonical_queue",
        original_publish_same_tab: false,
        queue_commit: sourceReadback.queue_commit,
        ...(sourceReadback.cleanup_receipt || sourceReadback.terminal_cleanup_receipt
          ? { cleanup_receipt: sourceReadback.cleanup_receipt || sourceReadback.terminal_cleanup_receipt }
          : {}),
      } : {}),
    },
  };
  const baseLifecycle = record(original.web_operation_lifecycle);
  const reconciledReceipt = {
    ...original,
    run_id: run.id,
    step_id: step.id,
    workflow_id: context.workflowId,
    status: "complete",
    exact_blocker: null,
    business_completion_verified: true,
    business_proof_verified: true,
    same_run_receipt: true,
    same_run_source_sync: true,
    readback_verified: true,
    cleanup_verified: true,
    provider_receipt_trusted: true,
    provider_receipt: response.provider_receipt,
    adapter_result: {
      ...record(original.adapter_result),
      provider_receipt: response.provider_receipt,
      ...(context.workflowId === "daily-ai-research-publish-run" ? {
        provider_result: { verified: true, run_id: run.id, url: parsedUrl.href,
          verification_basis: "operator_verified_post_and_canonical_queue", original_publish_same_tab: false },
      } : {}),
      source_sync: { schema: "aos.sns.source_sync.v1", same_run: true, verified: true },
      reconciliation: { attempted: true, verified: true, replayed: false, basis: "same_run_provider_url_and_source_readback" },
      cleanup: { ...(record(original.adapter_result).cleanup || {}), verified: true },
    },
    web_operation_lifecycle: {
      ...baseLifecycle,
      state: "cleaned",
      status: "complete",
      exact_blocker: null,
      dispatch_state: "executed",
      same_run_receipt: true,
      readback_verified: true,
      cleanup_verified: true,
      no_replay: true,
    },
    portable_web_post_effect_reconciliation: response,
  };
  const nextMetadata = {
    ...metadata,
    original_remote_worker_receipt: metadata.original_remote_worker_receipt ?? original,
    remote_worker_receipt: reconciledReceipt,
    portable_web_post_effect_reconciliation: { ...response, response, verified_at: now },
    external_action_executed: true,
    business_completion_verified: true,
    exact_blocker: null,
    worker_loop: { ...(record(metadata.worker_loop)), status: "completed_business_effect", completedAt: now },
    mac_worker: { ...(record(metadata.mac_worker)), status: "completed_business_effect", completedAt: now },
  };
  const stepMetadata = record(step.metadata_json);
  await runSqlTransactionAsync([
    { sql: `UPDATE run_steps SET status='completed', completed_at=${sqlValue(now)}, metadata_json=${sqlValue({ ...stepMetadata, exact_blocker: null, external_action_executed: true, business_completion_verified: true, same_run_source_sync: true, readback_verified: true, cleanup_verified: true, portable_web_post_effect_reconciliation: response, portable_external_receipt: reconciledReceipt, proof_summary: 'complete: same-run SNS provider/source reconciliation' })} WHERE id=${sqlValue(step.id)}`, expectChanges: 1 },
    ...(step.lane_id ? [{ sql: `UPDATE lanes SET status='completed', progress=100, health='healthy', current_task='SNS provider/source reconciliation verified', updated_at=${sqlValue(now)} WHERE id=${sqlValue(step.lane_id)}` }] : []),
    { sql: `UPDATE runs SET status='complete', updated_at=${sqlValue(now)}, metadata_json=${sqlValue(nextMetadata)} WHERE id=${sqlValue(run.id)} AND company_id=${sqlValue(run.company_id)} AND metadata_json=${sqlValue(run.metadata_json)}`, expectChanges: 1 },
    { sql: `INSERT INTO proofs (id, company_id, run_id, step_id, artifact_id, attempt_id, fencing_token, proof_type, label, uri, size_bytes, created_at, metadata_json) VALUES (${sqlValue(makeId('proof'))}, ${sqlValue(run.company_id)}, ${sqlValue(run.id)}, ${sqlValue(step.id)}, NULL, NULL, NULL, 'provider_receipt', ${sqlValue(`${context.workflowId} same-run provider/source reconciliation`)}, ${sqlValue(parsedUrl.href)}, 0, ${sqlValue(now)}, ${sqlValue(response)})`, expectChanges: 1 },
    { sql: `INSERT INTO worker_events (id, run_id, step_id, lane_id, company_id, event_type, message, created_at, metadata_json) VALUES (${sqlValue(makeId('evt'))}, ${sqlValue(run.id)}, ${sqlValue(step.id)}, ${sqlValue(step.lane_id)}, ${sqlValue(run.company_id)}, 'portable_web_post_effect_reconciled', 'SNS provider/source readback reconciled without replay', ${sqlValue(now)}, ${sqlValue({ provider_replayed: false, same_run_receipt: true, cleanup_verified: true })})`, expectChanges: 1 },
  ]);
  return { replayed: false, response };
}

/**
 * Reconcile the exact pre-dispatch failure shape produced by the Companion
 * adapter.  This is an evidence-only state transition: it proves that the
 * focused provider mutation was never dispatched, preserves the original
 * receipt, and deliberately does not create a provider receipt or a retry.
 */
export async function requestPortablePreDispatchNoEffectReconciliation(input: Scope & {
  expectedReadbackToken: string;
  idempotencyKey: string;
  evidence: unknown;
}): Promise<{ replayed: boolean; response: PortablePreDispatchNoEffectReconciliationResponse }> {
  const key = preDispatchNoEffectKey(input.runId);
  if (input.idempotencyKey !== key) throw new Error("portable_pre_dispatch_no_effect_idempotency_binding_invalid");
  const context = await loadContext(input);
  const { run, metadata, steps, view } = context;
  if (context.workflowId !== "daily-ai-research-publish-run" || !context.business) {
    throw new Error("portable_pre_dispatch_no_effect_workflow_invalid");
  }
  const existingKey = (await querySqlAsync<{ response_json: string; status: string }>(`SELECT response_json, status FROM mvp_idempotency_keys
    WHERE company_id=${sqlValue(run.company_id)} AND scope=${sqlValue(scopeKey(run.id))}
      AND idempotency_key=${sqlValue(key)} LIMIT 1`))[0];
  if (existingKey?.status === "pending") throw new Error("idempotency_request_pending");
  if (existingKey?.status === "completed") {
    const saved = record(existingKey.response_json);
    if (saved.schema === "aos.portable_pre_dispatch_no_effect_reconciliation.v1"
      && saved.company_id === run.company_id && saved.run_id === run.id && saved.status === "verified"
      && saved.new_effect === false && saved.provider_replayed === false
      && saved.mutation_dispatch_attempted === false && Number(saved.mutation_dispatch_count) === 0) {
      return { replayed: true, response: saved as PortablePreDispatchNoEffectReconciliationResponse };
    }
    throw new Error("idempotency_response_invalid");
  }
  if (view.readback_token !== input.expectedReadbackToken) throw new Error("portable_recovery_readback_changed");
  const original = record(metadata.remote_worker_receipt);
  if (!preDispatchNoEffectCandidate(original)) throw new Error("portable_pre_dispatch_no_effect_not_proven");
  const step = steps[0];
  const claim = record(metadata.remote_worker_claim);
  const authority = record(claim.portable_effect_authority ?? claim.effect_authority);
  const claimRunId = claim.run_id ?? authority.run_id;
  const claimStepId = claim.step_id ?? authority.step_id;
  const claimWorkflowId = claim.workflow_id ?? authority.workflow_id;
  if (!step || claimRunId !== run.id || claimStepId !== step.id || claimWorkflowId !== context.workflowId) {
    throw new Error("portable_pre_dispatch_no_effect_original_claim_missing");
  }
  if (!authority.authority_id || authority.company_id !== run.company_id || authority.run_id !== run.id
    || authority.step_id !== step.id || authority.workflow_id !== context.workflowId) {
    throw new Error("portable_pre_dispatch_no_effect_authority_binding_mismatch");
  }
  const evidence = record(input.evidence);
  const freshTargetReadback = record(evidence.fresh_target_readback);
  if (evidence.schema !== "aos.chrome_companion.pre_dispatch_no_effect.v1"
    || evidence.run_id !== run.id
    || evidence.workflow_id !== context.workflowId
    || evidence.external_action_executed !== false
    || evidence.mutation_dispatch_attempted !== false
    || Number(evidence.mutation_dispatch_count) !== 0
    || evidence.provider_post_url != null
    || freshTargetReadback.url !== "https://x.com/compose/post"
    || freshTargetReadback.post_control_present !== true
    || freshTargetReadback.provider_post_url != null) {
    throw new Error("portable_pre_dispatch_no_effect_evidence_invalid");
  }
  const now = nowIso();
  const response: PortablePreDispatchNoEffectReconciliationResponse = {
    schema: "aos.portable_pre_dispatch_no_effect_reconciliation.v1",
    company_id: run.company_id,
    run_id: run.id,
    step_id: step.id,
    workflow_id: "daily-ai-research-publish-run",
    status: "verified",
    exact_blocker: "portable_pre_dispatch_no_effect_reconciled",
    evidence_only: true,
    new_effect: false,
    provider_replayed: false,
    mutation_dispatch_attempted: false,
    mutation_dispatch_count: 0,
    target_url: "https://x.com/compose/post",
    observed_at: typeof evidence.observed_at === "string" ? evidence.observed_at : now,
  };
  const originalAdapterResult = record(original.adapter_result);
  const originalLifecycle = record(original.web_operation_lifecycle);
  const reconciledReceipt = {
    ...original,
    run_id: run.id,
    step_id: step.id,
    workflow_id: context.workflowId,
    status: "blocked",
    exact_blocker: "portable_pre_dispatch_no_effect_reconciled",
    external_action_executed: false,
    business_completion_verified: false,
    business_proof_verified: false,
    same_run_receipt: false,
    same_run_source_sync: false,
    readback_verified: false,
    cleanup_verified: true,
    provider_receipt_trusted: false,
    provider_receipt: null,
    adapter_result: {
      ...originalAdapterResult,
      result: "blocked",
      external_action_executed: false,
      provider_receipt_trusted: false,
      reconciliation: {
        ...record(originalAdapterResult.reconciliation),
        attempted: true,
        verified: true,
        replayed: false,
        basis: "fresh_same_target_readback_without_mutation_dispatch",
        no_effect: true,
      },
      pre_dispatch_no_effect_reconciliation: response,
    },
    web_operation_lifecycle: {
      ...originalLifecycle,
      state: "cleaned",
      status: "blocked",
      exact_blocker: "portable_pre_dispatch_no_effect_reconciled",
      dispatch_state: "not_dispatched",
      dispatch_attempted: false,
      external_action_executed: false,
      same_run_receipt: false,
      readback_verified: false,
      cleanup_verified: true,
      no_replay: true,
    },
    portable_pre_dispatch_no_effect_reconciliation: response,
  };
  const nextMetadata = {
    ...metadata,
    original_remote_worker_receipt: metadata.original_remote_worker_receipt ?? original,
    remote_worker_receipt: reconciledReceipt,
    portable_pre_dispatch_no_effect_reconciliation: { ...response, response, verified_at: now },
    external_action_executed: false,
    business_completion_verified: false,
    exact_blocker: "portable_pre_dispatch_no_effect_reconciled",
    portable_remote_receipt_reconciled: true,
    portable_remote_receipt_reconciled_at: now,
    worker_loop: { ...record(metadata.worker_loop), status: "reconciled_pre_dispatch_no_effect", completedAt: now },
    mac_worker: { ...record(metadata.mac_worker), status: "reconciled_pre_dispatch_no_effect", completedAt: now },
  };
  const stepMetadata = record(step.metadata_json);
  const request = {
    company_id: run.company_id,
    run_id: run.id,
    action: "reconcile-pre-dispatch-no-effect",
    expected_readback_token: input.expectedReadbackToken,
    evidence: response,
  };
  const mutation = await runIdempotentSqlMutationAsync({
    companyId: run.company_id,
    scope: scopeKey(run.id),
    key,
    request,
    response,
    resourceSteps: [
      { sql: `UPDATE run_steps SET metadata_json=${sqlValue({
        ...stepMetadata,
        exact_blocker: "portable_pre_dispatch_no_effect_reconciled",
        external_action_executed: false,
        business_completion_verified: false,
        same_run_source_sync: false,
        readback_verified: false,
        cleanup_verified: true,
        portable_pre_dispatch_no_effect_reconciliation: response,
        portable_external_receipt: reconciledReceipt,
        proof_summary: "blocked: pre-dispatch no-effect verified without replay",
      })} WHERE id=${sqlValue(step.id)}`, expectChanges: 1 },
      { sql: `UPDATE runs SET status='blocked', updated_at=${sqlValue(now)}, metadata_json=${sqlValue(nextMetadata)}
        WHERE id=${sqlValue(run.id)} AND company_id=${sqlValue(run.company_id)} AND metadata_json=${sqlValue(run.metadata_json)}`, expectChanges: 1 },
      { sql: `INSERT INTO worker_events (id, run_id, step_id, lane_id, company_id, event_type, message, created_at, metadata_json)
        VALUES (${sqlValue(makeId("evt"))}, ${sqlValue(run.id)}, ${sqlValue(step.id)}, ${sqlValue(step.lane_id)}, ${sqlValue(run.company_id)},
          'portable_pre_dispatch_no_effect_reconciled', 'Pre-dispatch no-effect verified without provider replay', ${sqlValue(now)},
          ${sqlValue({ external_action_executed: false, mutation_dispatch_attempted: false, mutation_dispatch_count: 0, cleanup_verified: true })})`, expectChanges: 1 },
    ],
  });
  return { replayed: mutation.replayed, response: mutation.response };
}

/**
 * Queue a fixed Backup evidence read on the already registered Mac worker.
 * This is deliberately separate from retry: it never creates a child Run,
 * renews approval/authority, or changes the original business claim.
 */
export async function requestPortableBackupPostEffectReconciliation(input: Scope & {
  expectedReadbackToken: string;
  idempotencyKey: string;
}): Promise<{ replayed: boolean; response: PortableBackupPostEffectReconciliationResponse }> {
  if (input.idempotencyKey !== backupEvidenceKey(input.runId)) throw new Error("portable_backup_evidence_idempotency_binding_invalid");
  const context = await loadContext(input);
  const { run, metadata, steps, view } = context;
  if (context.workflowId !== "daily-backup-safety-check" || !context.business) throw new Error("portable_backup_evidence_workflow_invalid");
  const existingKey = (await querySqlAsync<{ response_json: string; status: string }>(`SELECT response_json, status FROM mvp_idempotency_keys
    WHERE company_id=${sqlValue(run.company_id)} AND scope=${sqlValue(scopeKey(run.id))}
      AND idempotency_key=${sqlValue(input.idempotencyKey)} LIMIT 1`))[0];
  const existingReconciliation = record(metadata.portable_post_effect_reconciliation);
  if (existingKey?.status === "pending") throw new Error("idempotency_request_pending");
  // The fixed recovery key identifies this one evidence request. Once the
  // request has been durably admitted, replay it even if a later evidence
  // attempt failed; a stale UI readback token must not turn an idempotent
  // duplicate into a conflicting request.
  if (existingKey?.status === "completed") {
    const saved = record(existingKey.response_json);
    if (saved.schema === "aos.portable_backup_post_effect_reconciliation.v1" && saved.original_run_id === run.id) {
      // A verifier failure is not a provider effect and may be resumed under
      // the same fixed evidence key. Preserve the original claim and failed
      // attempt history, but clear only the expired evidence lease.
      if (existingReconciliation.status === "blocked" && !existingReconciliation.reconciled_receipt
        && Object.keys(record(existingReconciliation.last_failed_attempt)).length > 0
        && Boolean(metadata.remote_worker_receipt)) {
        const { worker_id: _workerId, worker_instance_id: _workerInstanceId, lease_expires_at: _leaseExpiresAt,
          claimed_at: _claimedAt, attempt_id: _attemptId, fencing_token: _fencingToken, ...preserved } = existingReconciliation;
        const resumedAt = nowIso();
        await runSqlTransactionAsync([{
          sql: `UPDATE runs SET updated_at=${sqlValue(resumedAt)}, metadata_json=${sqlValue({
            ...metadata,
            portable_post_effect_reconciliation: {
              ...preserved, status: "queued", exact_blocker: "portable_backup_post_effect_evidence_pending",
              resumed_at: resumedAt, evidence_only: true, new_effect: false, provider_replayed: false
            }
          })} WHERE id=${sqlValue(run.id)} AND company_id=${sqlValue(run.company_id)} AND metadata_json=${sqlValue(run.metadata_json)}`,
          expectChanges: 1
        }]);
        return { replayed: false, response: {
          ...(saved as PortableBackupPostEffectReconciliationResponse),
          status: "queued", exact_blocker: "portable_backup_post_effect_evidence_pending",
          evidence_only: true, new_effect: false, provider_replayed: false
        } };
      }
      return { replayed: true, response: saved as PortableBackupPostEffectReconciliationResponse };
    }
    throw new Error("idempotency_response_invalid");
  }
  if (view.readback_token !== input.expectedReadbackToken) throw new Error("portable_recovery_readback_changed");
  const claim = record(metadata.remote_worker_claim);
  const authority = record(claim.portable_effect_authority ?? claim.effect_authority);
  const step = steps[0];
  // Claims written by the first scheduler/worker revision did not persist the
  // redundant run/step/workflow identity fields, but did persist the complete
  // effect authority. Allow evidence-only recovery for that legacy shape only
  // when the authority itself binds every identity to this exact Run.
  const claimRunId = claim.run_id ?? authority.run_id;
  const claimStepId = claim.step_id ?? authority.step_id;
  const claimWorkflowId = claim.workflow_id ?? authority.workflow_id;
  if (!step || claimRunId !== run.id || claimStepId !== step.id || claimWorkflowId !== context.workflowId) {
    throw new Error("portable_backup_evidence_original_claim_missing");
  }
  if (!authority.authority_id || !authority.schema) throw new Error("portable_backup_evidence_original_authority_missing");
  if (metadata.remote_worker_receipt && !backupReceiptAllowsEvidence(record(metadata.remote_worker_receipt))) {
    throw new Error("portable_backup_evidence_receipt_already_present");
  }
  const binding = {
    company_id: run.company_id,
    run_id: run.id,
    step_id: step.id,
    workflow_id: context.workflowId,
    approval_id: authority.approval_id ?? claim.approval_id ?? null,
    idempotency_key: authority.idempotency_key ?? claim.idempotency_key ?? null,
    target_digest: authority.target_digest ?? claim.target_digest ?? null,
    input_bundle_sha256: authority.input_bundle_sha256 ?? claim.input_bundle_sha256 ?? null,
    account_ref: context.inputBundle.account_ref ?? null,
    target_key: context.inputBundle.target_key ?? null,
    payload_hash: context.inputBundle.payload_hash ?? null,
    source_snapshot_id: context.inputBundle.source_snapshot_id ?? null,
    registered_root_id: record(metadata.registered_root_admission).root_id ?? null,
    registered_root_digest: record(metadata.registered_root_admission).root_digest ?? null,
    effect_operation_key: backupEffectOperationKey(run.id),
  };
  if (authority.company_id !== run.company_id || authority.workflow_id !== context.workflowId
    || authority.run_id !== run.id || authority.step_id !== step.id
    || (authority.approval_id ?? claim.approval_id ?? null) !== (claim.approval_id ?? null)
    || (claim.idempotency_key !== undefined && claim.idempotency_key !== null
      && (authority.idempotency_key ?? null) !== claim.idempotency_key)
    || (authority.target_digest ?? claim.target_digest ?? null) !== (claim.target_digest ?? null)
    || (authority.input_bundle_sha256 ?? claim.input_bundle_sha256 ?? null) !== (claim.input_bundle_sha256 ?? null)
    || (claim.idempotency_key !== undefined && claim.idempotency_key !== null
      && !sameBinding(binding, { ...binding, idempotency_key: claim.idempotency_key }))) {
    throw new Error("portable_backup_evidence_original_binding_mismatch");
  }
  const authoritySha = createHash("sha256").update(`${JSON.stringify(authority, null, 2)}\n`).digest("hex");
  const existing = existingReconciliation;
  if (existing.schema && (existing.original_run_id !== run.id || !sameBinding(record(existing.original_claim), binding))) {
    throw new Error("portable_backup_evidence_original_run_conflict");
  }
  const now = nowIso();
  const effectOperationKey = backupEffectOperationKey(run.id);
  const existingEffect = (await querySqlAsync<{ company_id: string; task_id: string; workflow_id: string; target_hash: string; payload_hash: string; audience_hash: string }>(
    `SELECT company_id, task_id, workflow_id, target_hash, payload_hash, audience_hash FROM task_effect_ledger
      WHERE operation_key=${sqlValue(effectOperationKey)} LIMIT 1`
  ))[0];
  const expectedLedger = {
    company_id: run.company_id,
    task_id: run.id,
    workflow_id: context.workflowId,
    target_hash: backupLedgerHash(binding.target_digest),
    payload_hash: backupLedgerHash(binding.payload_hash),
    audience_hash: backupLedgerHash(binding.account_ref)
  };
  if (existingEffect && Object.entries(expectedLedger).some(([key, value]) => existingEffect[key as keyof typeof existingEffect] !== value)) {
    throw new Error("portable_backup_effect_ledger_binding_conflict");
  }
  const request = {
    company_id: run.company_id, run_id: run.id, action: "reconcile-post-effect",
    expected_readback_token: input.expectedReadbackToken, binding
  };
  const response: PortableBackupPostEffectReconciliationResponse = {
    schema: "aos.portable_backup_post_effect_reconciliation.v1",
    company_id: run.company_id, run_id: run.id, step_id: step.id,
    workflow_id: "daily-backup-safety-check", status: "queued", exact_blocker: "portable_backup_post_effect_evidence_pending",
    evidence_only: true, new_effect: false, provider_replayed: false, original_run_id: run.id,
    original_timeout_artifact: "portable-local-worker-receipt.v1.json",
    original_authority_id: String(authority.authority_id), original_authority_sha256: authoritySha
  };
  const mutation = await runIdempotentSqlMutationAsync({
    companyId: run.company_id, scope: scopeKey(run.id), key: input.idempotencyKey,
    request, response,
    resourceSteps: [{
      sql: `INSERT INTO task_effect_ledger
        (operation_key, company_id, trace_id, task_id, workflow_id, target_hash, payload_hash, audience_hash, state,
         external_action_executed, ambiguous, retry_forbidden, provider_receipt_hash, source_sync_hash,
         reconciliation_hash, cleanup_hash, exact_blocker, restart_point, created_at, updated_at, closed_at)
        VALUES (${sqlValue(effectOperationKey)}, ${sqlValue(run.company_id)}, ${sqlValue(run.id)}, ${sqlValue(run.id)},
          ${sqlValue(context.workflowId)}, ${sqlValue(expectedLedger.target_hash)}, ${sqlValue(expectedLedger.payload_hash)},
          ${sqlValue(expectedLedger.audience_hash)}, 'intent', 1, 1, 1, NULL, NULL, NULL, NULL,
          'portable_local_child_deadline_exceeded', 'reconciliation_without_replay', ${sqlValue(now)}, ${sqlValue(now)}, NULL)
        ON CONFLICT(operation_key) DO NOTHING`
    }, {
      sql: `UPDATE runs SET metadata_json=${sqlValue({
        ...metadata,
        portable_post_effect_reconciliation: {
          schema: "aos.portable_backup_post_effect_reconciliation.v1",
          status: existing.status === "claimed" || existing.status === "verified" ? existing.status : "queued",
          requested_at: existing.requested_at ?? now,
          evidence_only: true,
          new_effect: false,
          provider_replayed: false,
          original_run_id: run.id,
          original_step_id: step.id,
          original_claim: binding,
          original_authority_id: authority.authority_id,
          original_authority_sha256: authoritySha,
          original_timeout_artifact: "portable-local-worker-receipt.v1.json",
          exact_blocker: existing.exact_blocker ?? "portable_backup_post_effect_evidence_pending",
          idempotency_key: input.idempotencyKey,
          ...(existing.worker_id ? { worker_id: existing.worker_id, worker_instance_id: existing.worker_instance_id, lease_expires_at: existing.lease_expires_at } : {})
        }
      })}, updated_at=${sqlValue(now)}
        WHERE id=${sqlValue(run.id)} AND company_id=${sqlValue(run.company_id)} AND metadata_json=${sqlValue(run.metadata_json)}`,
      expectChanges: 1
    }]
  });
  return { replayed: mutation.replayed, response: mutation.response };
}

export async function cancelPortableRun(input: Scope & { expectedReadbackToken: string }) {
  const context = await loadContext(input);
  const { run, metadata, token, view } = context;
  if (run.status === "cancelled" && metadata.stop_reason === "portable_run_cancelled") return { replayed: true, recovery: view };
  if (token !== input.expectedReadbackToken) throw new Error("portable_recovery_readback_changed");
  if (!view.can_cancel) throw new Error(view.cancel_blocker!);
  const now = nowIso();
  await runSqlTransactionAsync([
    { sql: `UPDATE runs SET status='cancelled', updated_at=${sqlValue(now)}, metadata_json=${sqlValue({ ...metadata,
        stop_reason: "portable_run_cancelled", exact_blocker: "portable_run_cancelled", external_action_executed: false })}
      WHERE id=${sqlValue(run.id)} AND company_id=${sqlValue(run.company_id)} AND status IN ('queued','waiting_approval')
        AND metadata_json=${sqlValue(run.metadata_json)}`, expectChanges: 1 },
    { sql: `UPDATE approvals SET status='cancelled', decision_note='Run cancelled before worker claim', decided_at=${sqlValue(now)},
        decision_revision=decision_revision+1
      WHERE company_id=${sqlValue(run.company_id)} AND run_id=${sqlValue(run.id)} AND status='pending'` },
    { sql: `UPDATE run_steps SET status='cancelled', completed_at=${sqlValue(now)}
      WHERE run_id=${sqlValue(run.id)} AND status IN ('queued','waiting_approval')` },
    { sql: `UPDATE lanes SET status='idle', health='cancelled', current_task='portable_run_cancelled', updated_at=${sqlValue(now)}
      WHERE run_id=${sqlValue(run.id)}` },
    { sql: `INSERT INTO worker_events (id, company_id, run_id, step_id, lane_id, event_type, message, created_at, metadata_json)
      VALUES (${sqlValue(makeId("evt"))}, ${sqlValue(run.company_id)}, ${sqlValue(run.id)}, NULL, NULL, 'portable_run_cancelled',
        'Unclaimed Run cancelled from company recovery', ${sqlValue(now)}, ${sqlValue({ external_action_executed: false })})` }
  ]);
  return { replayed: false, recovery: await readPortableRunRecovery(input) };
}

export async function retryPortableRun(input: Scope & { expectedReadbackToken: string; idempotencyKey: string }) {
  if (input.idempotencyKey !== retryKey(input.runId)) throw new Error("portable_recovery_idempotency_binding_invalid");
  const context = await loadContext(input);
  const { run, view, metadata } = context;
  // An uncertain HTTP response is resolved from the one durable binding. A
  // changed caller key never admits another retry of this parent Run.
  let binding = context.retryBinding;
  let replayed = Boolean(binding);
  if (!binding) {
    if (context.token !== input.expectedReadbackToken) throw new Error("portable_recovery_readback_changed");
    if (!view.can_retry) throw new Error(view.retry_blocker!);
    const createdAt = nowIso();
    const origin: Binding["origin"] = { schema: "aos.portable_run_recovery.v1", binding_id: makeId("recovery"),
      parent_run_id: run.id, company_id: run.company_id };
    let admission: PortableLocalBusinessAdmission | null = null;
    let inputBundle: Record<string, unknown> | null = null;
    let webOperationIntent: Record<string, unknown> | null = null;
    let browserSurfaceRequirement: PortableWorkflowStartInput["browserSurfaceRequirement"] = undefined;
    let companionTaskId: string | null = null;
    if (context.business) {
      if (isPortableLocalWorkflowId(context.workflowId)) {
        const scope = { companyId: run.company_id, dueKey: `retry-${origin.binding_id}`, scheduledFor: createdAt };
        admission = context.workflowId === DAILY_AI_RESEARCH_SYNC_WORKFLOW ? prepareDailyAiResearchSyncAdmission(scope)
          : context.workflowId === "daily-backup-safety-check" ? (() => {
            try {
              const snapshotId = basename(readlinkSync(`${backupDestination}/latest`));
              const originalCommit = execFileSync("git", ["-C", backupDestination, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 30_000 }).trim();
              if (snapshotId === "" || originalCommit === "") return preparePortableLocalBackupBusinessAdmission(scope);
              return preparePortableLocalBackupRecoveryAdmission({ ...scope, snapshotId, originalCommit, parentRunId: run.id });
            } catch {
              return preparePortableLocalBackupBusinessAdmission(scope);
            }
          })()
          : context.workflowId === "obsidian-project-memory-audit" ? preparePortableLocalObsidianBusinessAdmission(scope) : null;
        if (!admission || admission.status !== "ready" || !admission.inputBundle) throw new Error(admission?.exact_blocker ?? "portable_recovery_business_binding_missing");
        if (["account_ref", "target_key", "payload_hash"].some((key) => admission!.inputBundle![key] !== context.inputBundle[key])) {
          throw new Error("portable_recovery_fixed_target_changed");
        }
      } else {
        // Web business recovery keeps the original target envelope but creates
        // a new run-bound approval and fresh effect authority. The old browser
        // receipt is never reused as a provider result or as an approval.
        const originalInputBundle = context.inputBundle;
        if (!originalInputBundle || typeof originalInputBundle !== "object") throw new Error("portable_recovery_business_binding_missing");
        inputBundle = { ...originalInputBundle };
        if (["account_ref", "target_key", "content_key", "payload_hash", "source_snapshot_id"].some((key) => {
          const value = inputBundle![key];
          return typeof value !== "string" || !value.trim();
        })) throw new Error("portable_recovery_business_binding_missing");
        const invocation = record(metadata.portable_workflow_invocation);
        const rawIntent = record(invocation.web_operation_intent ?? metadata.web_operation_intent);
        webOperationIntent = Object.keys(rawIntent).length > 0 ? rawIntent : null;
        const rawSurface = String(invocation.browser_surface_requirement ?? "automatic");
        browserSurfaceRequirement = rawSurface === "companion_extension" ? "companion_extension" : "automatic";
        const rawTaskId = metadata.companion_task_id ?? invocation.companion_task_id ?? invocation.task_id;
        companionTaskId = typeof rawTaskId === "string" && rawTaskId.trim() ? rawTaskId.trim() : null;
      }
    }
    const candidate: Binding = { schema: "aos.portable_run_recovery.v1", origin,
      workflow_id: context.workflowId as PortableWorkflowId, automation_id: run.automation_id!,
      automation_version_id: run.automation_version_id!, execution_mode: context.business ? "business_effect" : "read_only",
      business_admission: admission, ...(inputBundle ? { input_bundle: inputBundle } : {}),
      ...(webOperationIntent ? { web_operation_intent: webOperationIntent } : {}),
      ...(browserSurfaceRequirement ? { browser_surface_requirement: browserSurfaceRequirement } : {}),
      ...(companionTaskId ? { companion_task_id: companionTaskId } : {}),
      parent_readback_token: context.token, created_at: createdAt };
    const reserved = await runIdempotentSqlMutationAsync<Binding>({ companyId: run.company_id, scope: scopeKey(run.id), key: "retry",
      request: { company_id: run.company_id, run_id: run.id, action: "retry" }, response: candidate,
      resourceSteps: [{ sql: `UPDATE runs SET status=status WHERE id=${sqlValue(run.id)} AND company_id=${sqlValue(run.company_id)}
        AND status=${sqlValue(run.status)} AND metadata_json=${sqlValue(run.metadata_json)}
        AND EXISTS (SELECT 1 FROM mvp_automations WHERE id=${sqlValue(run.automation_id)} AND company_id=${sqlValue(run.company_id)}
          AND current_version_id=${sqlValue(run.automation_version_id)} AND archived_at IS NULL)`, expectChanges: 1 }] });
    binding = reserved.response;
    replayed = reserved.replayed;
  }
  const childId = binding.child_run_id ?? portableRecoveryRunId(binding.origin);
  const child = (await querySqlAsync<{ id: string; status: string }>(`SELECT id, status FROM runs
    WHERE id=${sqlValue(childId)} AND company_id=${sqlValue(run.company_id)} LIMIT 1`))[0];
  if (child) return { replayed: true, recovery: await readPortableRunRecovery(input), retry_run: child };
  // Retry admission does not inherit standing or old per-Run approval. A
  // business retry obtains its own immutable target and fresh explicit approval.
  const started = isPortableLocalWorkflowId(binding.workflow_id)
    ? await startPortableLocalWorkflowRun({ companyId: run.company_id, workflowId: binding.workflow_id,
        sourceTrigger: "automation_os_ui", registeredAutomationId: binding.automation_id,
        registeredAutomationVersionId: binding.automation_version_id, idempotencyKey: `retry-${binding.origin.binding_id}`,
        recoveryOrigin: binding.origin,
        ...(binding.execution_mode === "business_effect" ? { effectStage: "business_execute" as const,
          inputBundle: binding.business_admission!.inputBundle, sourceSnapshot: binding.business_admission!.sourceSnapshot }
          : { readOnlyStage: "reference_readback" as const }) })
    : await startPortableWorkflowRun({ companyId: run.company_id, workflowId: binding.workflow_id,
        sourceTrigger: "automation_os_ui", registeredAutomationId: binding.automation_id,
        registeredAutomationVersionId: binding.automation_version_id, idempotencyKey: `retry-${binding.origin.binding_id}`,
        browserSurfaceRequirement: binding.browser_surface_requirement ?? "automatic",
        ...(binding.companion_task_id ? { companionTaskId: binding.companion_task_id } : {}),
        ...(binding.execution_mode === "business_effect"
          ? { effectStage: (record(metadata.portable_target_bound_approval_binding).effect_stage
              ?? metadata.effect_stage ?? "publish") as PortableBusinessEffectStage,
            inputBundle: binding.input_bundle ?? context.inputBundle,
            ...(binding.web_operation_intent ? { webOperationIntent: binding.web_operation_intent } : {}) }
          : { readOnlyStage: "reference_readback" as const }) });
  const childBinding = { ...binding, child_run_id: started.runId };
  if (!binding.child_run_id) {
    const stored = (await querySqlAsync<{ response_json: string }>(`SELECT response_json FROM mvp_idempotency_keys
      WHERE company_id=${sqlValue(run.company_id)} AND scope=${sqlValue(scopeKey(run.id))}
        AND idempotency_key='retry' AND status='completed' LIMIT 1`))[0];
    if (stored) {
      const storedBinding = record(stored.response_json);
      if (!storedBinding.child_run_id) {
        await runSqlTransactionAsync([{ sql: `UPDATE mvp_idempotency_keys
          SET response_json=${sqlValue(canonicalJson(childBinding))}, updated_at=${sqlValue(nowIso())}
          WHERE company_id=${sqlValue(run.company_id)} AND scope=${sqlValue(scopeKey(run.id))}
            AND idempotency_key='retry' AND status='completed'`, expectChanges: 1 }]);
      }
    }
  }
  return { replayed: replayed || started.replayed, recovery: await readPortableRunRecovery(input),
    retry_run: { id: started.runId, status: started.status } };
}

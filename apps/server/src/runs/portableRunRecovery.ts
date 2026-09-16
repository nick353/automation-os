import { createHash } from "node:crypto";
import { makeId, nowIso, querySqlAsync, runSqlTransactionAsync, sqlValue } from "../db/client.js";
import { getAutomationRecordAsync } from "../automations/repository.js";
import { hashIdempotencyRequest, runIdempotentSqlMutationAsync } from "../automations/idempotency.js";
import { isPortableLocalWorkflowId, localWorkflowIdForRegisteredAutomation,
  preparePortableLocalBackupBusinessAdmission, preparePortableLocalObsidianBusinessAdmission,
  type PortableLocalBusinessAdmission, type PortableLocalWorkflowId } from "./portableLocalWorkflow.js";
import { DAILY_AI_RESEARCH_SYNC_WORKFLOW, prepareDailyAiResearchSyncAdmission } from "./dailyAiResearchSourceSync.js";
import { portableRecoveryRunId, startPortableLocalWorkflowRun, type PortableLocalWorkflowStartInput } from "./portableLocalWorkflowEntrypoint.js";

type Run = { id: string; company_id: string; automation_id: string | null; automation_version_id: string | null;
  status: string; execution_source: string; quarantined: number; updated_at: string; metadata_json: string };
type Scope = { companyId: string; runId: string };
type Binding = Record<string, unknown> & { schema: "aos.portable_run_recovery.v1"; origin: NonNullable<PortableLocalWorkflowStartInput["recoveryOrigin"]>;
  workflow_id: PortableLocalWorkflowId; automation_id: string; automation_version_id: string; execution_mode: "read_only" | "business_effect";
  business_admission: PortableLocalBusinessAdmission | null; parent_readback_token: string; created_at: string };
const record = (value: unknown): Record<string, any> => {
  if (typeof value === "string") { try { return record(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
};
const scopeKey = (runId: string) => `portable-run-recovery:${runId}`;
const retryKey = (runId: string) => `portable-retry-${runId}`;
const backupEvidenceKey = (runId: string) => `portable-backup-post-effect-${runId}`;
const backupEffectOperationKey = (runId: string) => `backup-effect-${createHash("sha256").update(runId).digest("hex")}`;
const backupLedgerHash = (value: unknown): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return /^[a-f0-9]{64}$/u.test(text) ? text : createHash("sha256").update(text).digest("hex");
};

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
  const steps = await querySqlAsync<{ id: string; status: string; started_at: string | null; metadata_json: string }>(
    `SELECT id, status, started_at, metadata_json FROM run_steps WHERE run_id=${sqlValue(run.id)} ORDER BY id`);
  const approvalRows = await querySqlAsync<Record<string, unknown>>(`SELECT id, status, run_id, company_id,
    action_kind, target_account_ref_id, payload_hash, policy_version, expires_at, decided_at, decision_revision
    FROM approvals WHERE run_id=${sqlValue(run.id)} AND company_id=${sqlValue(run.company_id)} ORDER BY created_at`);
  const automation = run.automation_id ? await getAutomationRecordAsync(run.company_id, run.automation_id, true) : undefined;
  const retryRow = (await querySqlAsync<{ response_json: string }>(`SELECT response_json FROM mvp_idempotency_keys
    WHERE company_id=${sqlValue(run.company_id)} AND scope=${sqlValue(scopeKey(run.id))}
      AND idempotency_key='retry' AND status='completed' LIMIT 1`))[0];
  const retryBinding = retryRow ? record(retryRow.response_json) as Binding : null;
  const childId = retryBinding ? portableRecoveryRunId(retryBinding.origin) : null;
  const child = childId ? (await querySqlAsync<{ id: string; status: string }>(`SELECT id, status FROM runs
    WHERE id=${sqlValue(childId)} AND company_id=${sqlValue(run.company_id)} LIMIT 1`))[0] : null;
  const workflowId = String(metadata.workflow_id ?? metadata.registered_workflow_id ?? "");
  const supported = isPortableLocalWorkflowId(workflowId) && run.execution_source === "automation-os"
    && Number(run.quarantined) === 0 && metadata.portable_worker?.local_worker === true;
  const claim = record(metadata.remote_worker_claim);
  const receipt = record(metadata.remote_worker_receipt);
  const hasClaim = Boolean(metadata.remote_worker_claim);
  const hasReceipt = Boolean(metadata.remote_worker_receipt);
  const business = metadata.effect_stage === "business_execute" || metadata.portable_worker?.mode === "business_effect";
  const evidence = [metadata, ...steps.map((step) => record(step.metadata_json)), receipt];
  const positive = evidence.some((item) => item.external_action_executed === true);
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
    && localWorkflowIdForRegisteredAutomation(automation) === workflowId);
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
  const view = { schema: "aos.portable_run_recovery.v1", company_id: run.company_id, run_id: run.id,
    automation_id: run.automation_id, automation_version_id: run.automation_version_id, workflow_id: workflowId,
    status: run.status, checked_at: nowIso(), updated_at: run.updated_at, readback_token: token,
    execution_mode: business ? "business_effect" : "read_only", external_action_executed: externalActionExecuted,
    claim_active: activeClaim, receipt_present: hasReceipt, registration_matches: registrationMatches,
    can_cancel: !cancelBlocker, cancel_blocker: cancelBlocker, can_retry: !retryBlocker, retry_blocker: retryBlocker,
    requires_fresh_approval: business, account_ref: inputBundle.account_ref ?? null, target_key: inputBundle.target_key ?? null,
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
      && externalActionExecuted === null && !hasReceipt && Boolean(metadata.remote_worker_claim)
      && backupReconciliation.status !== "verified"
  });
  return { run, metadata, steps, approvalRows, automation, retryBinding, workflowId, business, inputBundle, token, view };
}

export async function readPortableRunRecovery(input: Scope) { return (await loadContext(input)).view; }

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
  if (metadata.remote_worker_receipt) throw new Error("portable_backup_evidence_receipt_already_present");
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
  const { run, view } = context;
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
    if (context.business) {
      const scope = { companyId: run.company_id, dueKey: `retry-${origin.binding_id}`, scheduledFor: createdAt };
      admission = context.workflowId === DAILY_AI_RESEARCH_SYNC_WORKFLOW ? prepareDailyAiResearchSyncAdmission(scope)
        : context.workflowId === "daily-backup-safety-check" ? preparePortableLocalBackupBusinessAdmission(scope)
        : context.workflowId === "obsidian-project-memory-audit" ? preparePortableLocalObsidianBusinessAdmission(scope) : null;
      if (!admission || admission.status !== "ready" || !admission.inputBundle) throw new Error(admission?.exact_blocker ?? "portable_recovery_business_binding_missing");
      if (["account_ref", "target_key", "payload_hash"].some((key) => admission!.inputBundle![key] !== context.inputBundle[key])) {
        throw new Error("portable_recovery_fixed_target_changed");
      }
    }
    const candidate: Binding = { schema: "aos.portable_run_recovery.v1", origin,
      workflow_id: context.workflowId as PortableLocalWorkflowId, automation_id: run.automation_id!,
      automation_version_id: run.automation_version_id!, execution_mode: context.business ? "business_effect" : "read_only",
      business_admission: admission, parent_readback_token: context.token, created_at: createdAt };
    const reserved = await runIdempotentSqlMutationAsync<Binding>({ companyId: run.company_id, scope: scopeKey(run.id), key: "retry",
      request: { company_id: run.company_id, run_id: run.id, action: "retry" }, response: candidate,
      resourceSteps: [{ sql: `UPDATE runs SET status=status WHERE id=${sqlValue(run.id)} AND company_id=${sqlValue(run.company_id)}
        AND status=${sqlValue(run.status)} AND metadata_json=${sqlValue(run.metadata_json)}
        AND EXISTS (SELECT 1 FROM mvp_automations WHERE id=${sqlValue(run.automation_id)} AND company_id=${sqlValue(run.company_id)}
          AND current_version_id=${sqlValue(run.automation_version_id)} AND archived_at IS NULL)`, expectChanges: 1 }] });
    binding = reserved.response;
    replayed = reserved.replayed;
  }
  const childId = portableRecoveryRunId(binding.origin);
  const child = (await querySqlAsync<{ id: string; status: string }>(`SELECT id, status FROM runs
    WHERE id=${sqlValue(childId)} AND company_id=${sqlValue(run.company_id)} LIMIT 1`))[0];
  if (child) return { replayed: true, recovery: await readPortableRunRecovery(input), retry_run: child };
  // Retry admission does not inherit standing or old per-Run approval. A
  // business retry obtains its own immutable target and fresh explicit approval.
  const started = await startPortableLocalWorkflowRun({ companyId: run.company_id, workflowId: binding.workflow_id,
    sourceTrigger: "automation_os_ui", registeredAutomationId: binding.automation_id,
    registeredAutomationVersionId: binding.automation_version_id, idempotencyKey: `retry-${binding.origin.binding_id}`,
    recoveryOrigin: binding.origin,
    ...(binding.execution_mode === "business_effect" ? { effectStage: "business_execute" as const,
      inputBundle: binding.business_admission!.inputBundle, sourceSnapshot: binding.business_admission!.sourceSnapshot }
      : { readOnlyStage: "reference_readback" as const }) });
  return { replayed: replayed || started.replayed, recovery: await readPortableRunRecovery(input),
    retry_run: { id: started.runId, status: started.status } };
}

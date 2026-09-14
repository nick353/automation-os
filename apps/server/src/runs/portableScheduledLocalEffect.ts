import { execSqlAsync, nowIso, querySqlAsync, runSqlTransactionAsync, sqlValue } from "../db/client.js";
import { requeuePortableMacWorkerAfterApprovalAsync } from "./portableRemoteWorker.js";
import { UNATTENDED_FIXED_LOCAL_EFFECT_POLICY, isPortableLocalWorkflowId, isDelegatedBackupSourceReadback } from "./portableLocalWorkflow.js";
import { DAILY_AI_RESEARCH_SYNC_WORKFLOW, DAILY_AI_RESEARCH_SYNC_POLICY, isDelegatedDailyAiResearchSyncSource } from "./dailyAiResearchSourceSync.js";

export type ScheduledLocalEffectAuthorizationResult = {
  authorized: boolean;
  exactBlocker: string | null;
  approvalId: string | null;
  requeued: boolean;
};

type RunRow = {
  id: string;
  company_id: string | null;
  status: string;
  execution_source: string;
  metadata_json: string;
};

/**
 * Convert the user's standing authorization for the two fixed local-only
 * registered workflows into the ordinary, target-bound approval that the Mac
 * worker already understands.  This is intentionally narrow: it accepts only
 * a scheduler-owned run, the explicit policy marker, and a fixed local bundle.
 * The separately authorized Daily AI mirror uses its own exact-account/Sheet
 * policy. Arbitrary browser/provider targets never enter this function.
 */
export async function authorizeScheduledLocalBusinessRun(input: {
  runId: string;
  companyId: string;
  workflowId: string;
}): Promise<ScheduledLocalEffectAuthorizationResult> {
  const run = (await querySqlAsync<RunRow>(
    `SELECT id, company_id, status, execution_source, metadata_json
       FROM runs WHERE id=${sqlValue(input.runId)} LIMIT 1`
  ))[0];
  if (!run) return blocked("scheduled_local_run_not_found");
  if (run.company_id !== input.companyId || run.execution_source !== "automation-os") {
    return blocked("scheduled_local_run_scope_invalid");
  }
  if (!isPortableLocalWorkflowId(input.workflowId)
    || (input.workflowId !== "daily-backup-safety-check" && input.workflowId !== "obsidian-project-memory-audit"
      && input.workflowId !== DAILY_AI_RESEARCH_SYNC_WORKFLOW)) {
    return blocked("scheduled_local_workflow_not_enabled");
  }
  const metadata = parseRecord(run.metadata_json);
  const expectedPolicy = input.workflowId === DAILY_AI_RESEARCH_SYNC_WORKFLOW ? DAILY_AI_RESEARCH_SYNC_POLICY : UNATTENDED_FIXED_LOCAL_EFFECT_POLICY;
  if (metadata.unattended_effect_policy !== expectedPolicy) {
    return blocked("scheduled_local_unattended_policy_missing");
  }
  const invocation = isObject(metadata.portable_workflow_invocation)
    ? metadata.portable_workflow_invocation
    : {};
  if (invocation.source_trigger !== "automation_os_scheduler" || invocation.workflow_id !== input.workflowId) {
    return blocked("scheduled_local_run_trigger_binding_invalid");
  }
  const inputBundle = isObject(metadata.portable_input_bundle)
    ? metadata.portable_input_bundle
    : {};
  if (!isObject(inputBundle.input) || typeof inputBundle.sha256 !== "string") {
    return blocked("scheduled_local_business_bundle_missing");
  }
  const sourceSnapshot = isObject(metadata.source_snapshot) ? metadata.source_snapshot : null;
  const delegatedBackup = input.workflowId === "daily-backup-safety-check" && sourceSnapshot
    && isDelegatedBackupSourceReadback(sourceSnapshot, inputBundle.input, input.companyId);
  const delegatedDailyAi = input.workflowId === DAILY_AI_RESEARCH_SYNC_WORKFLOW && sourceSnapshot
    && isDelegatedDailyAiResearchSyncSource(sourceSnapshot, inputBundle.input, input.companyId);
  if ((input.workflowId === DAILY_AI_RESEARCH_SYNC_WORKFLOW && !delegatedDailyAi)
    || !sourceSnapshot || sourceSnapshot.status !== "ready" || (!delegatedBackup && !delegatedDailyAi && sourceSnapshot.readback_verified !== true)
    || sourceSnapshot.external_action_executed !== false) {
    return blocked("scheduled_local_source_snapshot_not_ready");
  }
  const approval = (await querySqlAsync<{ id: string; status: string }>(
    `SELECT id, status FROM approvals WHERE run_id=${sqlValue(input.runId)} AND company_id=${sqlValue(input.companyId)} ORDER BY created_at ASC LIMIT 1`
  ))[0];
  if (!approval) return blocked("scheduled_local_approval_missing");
  if (approval.status === "pending") {
    const decidedAt = nowIso();
    try {
      await runSqlTransactionAsync([{
        sql: `UPDATE approvals
                 SET status='approved', decided_at=${sqlValue(decidedAt)},
                     decision_note=${sqlValue(input.workflowId === DAILY_AI_RESEARCH_SYNC_WORKFLOW
                       ? "User-authorized Daily AI research and fixed existing Sheet mirror; no generation or publication"
                       : "User-authorized unattended fixed local target")},
                     decision_revision=decision_revision+1
               WHERE id=${sqlValue(approval.id)} AND run_id=${sqlValue(input.runId)}
                 AND company_id=${sqlValue(input.companyId)} AND status='pending'
                 AND expires_at>${sqlValue(decidedAt)}`,
        expectChanges: 1
      }]);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("sql_transaction_expected_changes"))) throw error;
    }
  }
  const decided = (await querySqlAsync<{ id: string; status: string; decided_at: string | null }>(
    `SELECT id, status, decided_at FROM approvals WHERE id=${sqlValue(approval.id)} AND run_id=${sqlValue(input.runId)} AND company_id=${sqlValue(input.companyId)} LIMIT 1`
  ))[0];
  if (decided?.status !== "approved" || !decided.decided_at) return blocked("scheduled_local_approval_not_confirmed", approval.id);

  // The recovery helper re-derives the run-bound binding, fixed target, lock
  // set, approval receipt, and claimable state before the worker can run.
  const recovery = await requeuePortableMacWorkerAfterApprovalAsync(input.runId);
  if (!recovery.requeued) {
    return {
      authorized: false,
      exactBlocker: `scheduled_local_worker_requeue_failed:${recovery.reason}`,
      approvalId: approval.id,
      requeued: false
    };
  }
  return { authorized: true, exactBlocker: null, approvalId: recovery.approval_id ?? approval.id, requeued: true };
}

function blocked(exactBlocker: string, approvalId: string | null = null): ScheduledLocalEffectAuthorizationResult {
  return { authorized: false, exactBlocker, approvalId, requeued: false };
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseRecord(value: unknown): Record<string, any> {
  if (isObject(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

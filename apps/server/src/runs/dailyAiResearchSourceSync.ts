import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import type { PortableLocalBusinessAdmission, PortableLocalWorkflowBusinessReceipt } from "./portableLocalWorkflow.js";

export const DAILY_AI_RESEARCH_SYNC_WORKFLOW = "daily-ai-research-source-sync" as const;
export const DAILY_AI_RESEARCH_SYNC_POLICY = "user_authorized_daily_ai_existing_sheet.v1" as const;
export const DAILY_AI_RESEARCH_SYNC_COMPANY = "company_2560580981cedfd106b66245";
export const DAILY_AI_RESEARCH_SYNC_ACCOUNT = "google_service_account_sha256:921722539efe988ea7b2ea22a966d0d688f3629e13af368722ea60b173a7980d";
export const DAILY_AI_RESEARCH_SYNC_SHEET = "16W-IhCLb1ENizHLXT7afGQeQA-dqLh_2DYtkeeWeiho";
export const DAILY_AI_RESEARCH_SYNC_TARGET = `google_sheets:${DAILY_AI_RESEARCH_SYNC_SHEET}:queue:1541274581`;
const WORKSPACE = "/Users/nichikatanaka/Documents/New project";
const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/u;

export function dailyAiResearchSyncPayloadHash(): string {
  return hash({ workflow: DAILY_AI_RESEARCH_SYNC_WORKFLOW, operation: "research_and_existing_sheet_mirror",
    account_ref: DAILY_AI_RESEARCH_SYNC_ACCOUNT, target_key: DAILY_AI_RESEARCH_SYNC_TARGET,
    source_queue: `${WORKSPACE}/posting_queue.tsv`, max_drafts: 3, mirror_columns: 39,
    manual_views: ["publish_today", "engagement_review", "dashboard"], publish: false, generated_media: false });
}

function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export function dailyAiResearchSyncBundleValid(bundle: Record<string, unknown>): boolean {
  return Object.keys(bundle).length === 4
    && bundle.account_ref === DAILY_AI_RESEARCH_SYNC_ACCOUNT
    && bundle.target_key === DAILY_AI_RESEARCH_SYNC_TARGET
    && bundle.payload_hash === dailyAiResearchSyncPayloadHash()
    && typeof bundle.source_snapshot_id === "string" && HASH.test(bundle.source_snapshot_id);
}

/** Dispatch scope only. The cloud does not claim to have read the Mac queue. */
export function prepareDailyAiResearchSyncAdmission(input: {
  companyId: string; dueKey: string; scheduledFor: string;
}): PortableLocalBusinessAdmission {
  const valid = input.companyId === DAILY_AI_RESEARCH_SYNC_COMPANY && Boolean(input.dueKey.trim())
    && Number.isFinite(Date.parse(input.scheduledFor));
  const sourceSnapshotId = hash({ workflow: DAILY_AI_RESEARCH_SYNC_WORKFLOW, ...input,
    policy: DAILY_AI_RESEARCH_SYNC_POLICY, payload_hash: dailyAiResearchSyncPayloadHash() });
  const exactBlocker = valid ? null : "daily_ai_research_sync_schedule_binding_invalid";
  return {
    status: valid ? "ready" : "blocked", exact_blocker: exactBlocker,
    sourceSnapshot: {
      schema: "aos.portable_local_source_snapshot.v1", workflow_id: DAILY_AI_RESEARCH_SYNC_WORKFLOW,
      company_id: input.companyId, due_key: input.dueKey, scheduled_for: input.scheduledFor,
      source_snapshot_id: sourceSnapshotId, captured_at: new Date().toISOString(),
      status: valid ? "ready" : "blocked", readback_verified: false, exact_blocker: exactBlocker,
      external_action_executed: false,
      adapter_result: { source_readback_scope: "mac_worker_pre_effect", control_plane_readback_verified: false,
        pre_effect_queue_and_sheet_readback_required: true, fixed_existing_sheet: DAILY_AI_RESEARCH_SYNC_SHEET,
        account_ref: DAILY_AI_RESEARCH_SYNC_ACCOUNT, publish_allowed: false, generation_allowed: false }
    },
    inputBundle: valid ? { account_ref: DAILY_AI_RESEARCH_SYNC_ACCOUNT, target_key: DAILY_AI_RESEARCH_SYNC_TARGET,
      payload_hash: dailyAiResearchSyncPayloadHash(), source_snapshot_id: sourceSnapshotId } : null
  };
}

export function isDelegatedDailyAiResearchSyncSource(snapshot: Record<string, unknown>, bundle: Record<string, unknown>, companyId: string): boolean {
  const adapter = snapshot.adapter_result as Record<string, unknown> | undefined;
  if (companyId !== DAILY_AI_RESEARCH_SYNC_COMPANY || !dailyAiResearchSyncBundleValid(bundle)
    || snapshot.workflow_id !== DAILY_AI_RESEARCH_SYNC_WORKFLOW || snapshot.company_id !== companyId
    || snapshot.status !== "ready" || snapshot.readback_verified !== false || snapshot.external_action_executed !== false
    || adapter?.source_readback_scope !== "mac_worker_pre_effect" || adapter.control_plane_readback_verified !== false
    || adapter.pre_effect_queue_and_sheet_readback_required !== true || adapter.publish_allowed !== false
    || adapter.generation_allowed !== false || adapter.account_ref !== DAILY_AI_RESEARCH_SYNC_ACCOUNT
    || adapter.fixed_existing_sheet !== DAILY_AI_RESEARCH_SYNC_SHEET
    || typeof snapshot.due_key !== "string" || typeof snapshot.scheduled_for !== "string") return false;
  const expected = prepareDailyAiResearchSyncAdmission({ companyId, dueKey: snapshot.due_key, scheduledFor: snapshot.scheduled_for });
  return expected.status === "ready" && expected.sourceSnapshot.source_snapshot_id === snapshot.source_snapshot_id
    && bundle.source_snapshot_id === snapshot.source_snapshot_id;
}

type BusinessInput = {
  workflowId: string; workerRole?: string; companyId?: string; runId: string; stepId: string;
  idempotencyKey: string; targetDigest: string; inputBundleSha256: string;
  inputBundle: Record<string, unknown>; authorityExpiresAt: string;
};
type Executor = (binding: Record<string, string>) => Promise<Record<string, any>>;

async function executeFixedWorker(binding: Record<string, string>): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    // Async child execution leaves the resident worker heartbeat responsive.
    execFile("/Users/nichikatanaka/.local/bin/uv", ["run", "python", "-m", "social_flow.aos_research_source_sync",
      "--binding-json", JSON.stringify(binding)], { cwd: WORKSPACE, encoding: "utf8", timeout: 16 * 60_000,
      maxBuffer: 1024 * 1024, killSignal: "SIGTERM" }, (error, stdout) => {
      try { resolve(JSON.parse(stdout)); }
      catch {
        resolve({ status: "blocked", exact_blocker: "daily_ai_worker_receipt_unavailable",
          external_action_executed: !error || (error as NodeJS.ErrnoException).code !== "ENOENT",
          cleanup_verified: Boolean(error && (error as NodeJS.ErrnoException).code === "ENOENT"), operation_effect_state: "unknown" });
      }
    });
  });
}

export async function runDailyAiResearchSourceSyncBusiness(input: BusinessInput, execute: Executor = executeFixedWorker): Promise<PortableLocalWorkflowBusinessReceipt> {
  const blocked = (code: string, external = false, raw: Record<string, any> = {}): PortableLocalWorkflowBusinessReceipt => ({
    status: "blocked", exact_blocker: code, external_action_executed: external, workflow_id: DAILY_AI_RESEARCH_SYNC_WORKFLOW,
    read_only_stage_bound: false, readback_verified: false, cleanup_verified: external ? raw.cleanup_verified === true : raw.cleanup_verified !== false,
    business_completion_verified: false, same_run_receipt: raw.same_run_receipt === true, same_run_source_sync: false,
    adapter_result: { execution_surface: "mac_local_worker", operation: "research_and_existing_sheet_mirror",
      remote_verified: false, operation_effect_state: external ? "effect_unknown" : "none",
      reconciliation_required: external, full_publish_completed: false, artifact_path: raw.artifact_path ?? null },
    runner_receipt: raw
  });
  if (input.workerRole !== "mac") return blocked("mac_worker_required");
  if (input.workflowId !== DAILY_AI_RESEARCH_SYNC_WORKFLOW || input.companyId !== DAILY_AI_RESEARCH_SYNC_COMPANY) return blocked("daily_ai_research_sync_company_not_allowed");
  if (!dailyAiResearchSyncBundleValid(input.inputBundle) || !HASH.test(input.targetDigest)
    || !HASH.test(input.inputBundleSha256) || !ID.test(input.runId) || !ID.test(input.stepId)
    || !ID.test(input.idempotencyKey)) return blocked("daily_ai_research_sync_target_binding_invalid");
  if (!Number.isFinite(Date.parse(input.authorityExpiresAt)) || Date.parse(input.authorityExpiresAt) <= Date.now()) {
    return blocked("daily_ai_effect_authority_expired");
  }
  const binding = { company_id: input.companyId, run_id: input.runId, step_id: input.stepId,
    idempotency_key: input.idempotencyKey, target_digest: input.targetDigest, input_bundle_sha256: input.inputBundleSha256,
    source_snapshot_id: String(input.inputBundle.source_snapshot_id), authority_expires_at: input.authorityExpiresAt };
  let receipt: Record<string, any>;
  try { receipt = await execute(binding); }
  catch { return blocked("daily_ai_worker_receipt_unavailable", true, { cleanup_verified: false }); }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return blocked("daily_ai_worker_receipt_unavailable", true, { cleanup_verified: false });
  }
  const external = receipt.external_action_executed === true;
  const bound = receipt.workflow_id === DAILY_AI_RESEARCH_SYNC_WORKFLOW && receipt.company_id === input.companyId
    && receipt.run_id === input.runId && receipt.step_id === input.stepId && receipt.idempotency_key === input.idempotencyKey
    && receipt.target_digest === input.targetDigest && receipt.input_bundle_sha256 === input.inputBundleSha256
    && receipt.source_snapshot_id === input.inputBundle.source_snapshot_id;
  if (!bound) return blocked("daily_ai_worker_receipt_binding_invalid", external, receipt);
  const complete = receipt.status === "complete" && receipt.exact_blocker === null && external
    && receipt.same_run_receipt === true && receipt.same_run_source_sync === true && receipt.readback_verified === true
    && receipt.cleanup_verified === true && receipt.full_publish_completed === false && receipt.generation_performed === false
    && receipt.mirror?.spreadsheet_id === DAILY_AI_RESEARCH_SYNC_SHEET && receipt.mirror?.sheet_id === 1541274581
    && receipt.mirror?.mirror_column_count === 39 && receipt.mirror?.all_local_ids_and_columns_match === true
    && receipt.mirror?.manual_views_match === true
    && receipt.business_proofs?.research_queue === true && receipt.business_proofs?.existing_sheet_mirror === true
    && receipt.business_proofs?.all_mirror_columns === true && receipt.business_proofs?.cleanup_receipt === true;
  if (!complete) return blocked(String(receipt.exact_blocker ?? "daily_ai_research_sync_proof_incomplete"), external, receipt);
  return { status: "complete", exact_blocker: null, external_action_executed: true, workflow_id: DAILY_AI_RESEARCH_SYNC_WORKFLOW,
    read_only_stage_bound: false, readback_verified: true, cleanup_verified: true, business_completion_verified: true,
    same_run_receipt: true, same_run_source_sync: true, runner_receipt: receipt,
    adapter_result: { execution_surface: "mac_local_worker", operation: "research_and_existing_sheet_mirror", remote_verified: true,
      operation_effect_state: "completed", reconciliation_required: false, full_publish_completed: false,
      generation_performed: false, artifact_path: receipt.artifact_path, mirror: receipt.mirror, research: receipt.research } };
}

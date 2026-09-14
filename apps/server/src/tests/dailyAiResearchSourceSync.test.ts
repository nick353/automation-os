import assert from "node:assert/strict";
import test from "node:test";
import {
  DAILY_AI_RESEARCH_SYNC_WORKFLOW as workflowId, DAILY_AI_RESEARCH_SYNC_COMPANY as companyId,
  DAILY_AI_RESEARCH_SYNC_SHEET, DAILY_AI_RESEARCH_SYNC_TARGET, dailyAiResearchSyncBundleValid,
  dailyAiResearchSyncPayloadHash, prepareDailyAiResearchSyncAdmission,
  isDelegatedDailyAiResearchSyncSource, runDailyAiResearchSourceSyncBusiness
} from "../runs/dailyAiResearchSourceSync.js";

const admission = () => prepareDailyAiResearchSyncAdmission({ companyId, dueKey: "fixture:daily", scheduledFor: "2026-09-06T00:00:00Z" });
const input = () => ({ workflowId, companyId, workerRole: "mac", runId: "run_fixture", stepId: "step_fixture",
  idempotencyKey: "scheduler:fixture", targetDigest: "a".repeat(64), inputBundleSha256: "b".repeat(64),
  inputBundle: admission().inputBundle!, authorityExpiresAt: new Date(Date.now() + 540_000).toISOString() });
const workerReceipt = (binding: Record<string, string>): Record<string, any> => ({
  ...binding, workflow_id: workflowId, status: "complete", exact_blocker: null, external_action_executed: true,
  same_run_receipt: true, same_run_source_sync: true, readback_verified: true, cleanup_verified: true,
  full_publish_completed: false, generation_performed: false,
  mirror: { spreadsheet_id: DAILY_AI_RESEARCH_SYNC_SHEET, sheet_id: 1541274581,
    mirror_column_count: 39, all_local_ids_and_columns_match: true, manual_views_match: true },
  business_proofs: { research_queue: true, existing_sheet_mirror: true, all_mirror_columns: true, cleanup_receipt: true }
});

test("Daily AI admission binds one existing company/account/Sheet and leaves Mac readback pending", () => {
  const prepared = admission();
  assert.equal(prepared.status, "ready");
  assert.equal(prepared.sourceSnapshot.company_id, companyId);
  assert.equal(prepared.inputBundle?.target_key, DAILY_AI_RESEARCH_SYNC_TARGET);
  assert.equal(prepared.inputBundle?.payload_hash, dailyAiResearchSyncPayloadHash());
  assert.equal(prepared.sourceSnapshot.readback_verified, false);
  assert.equal(prepared.sourceSnapshot.external_action_executed, false);
  assert.equal(isDelegatedDailyAiResearchSyncSource(prepared.sourceSnapshot, prepared.inputBundle!, companyId), true);
  for (const change of [{ account_ref: "foreign" }, { target_key: "other-sheet" }, { payload_hash: "f".repeat(64) }, { extra: "publish" }]) {
    assert.equal(dailyAiResearchSyncBundleValid({ ...prepared.inputBundle, ...change }), false);
  }
  for (const change of [{ due_key: "other-due" }, { company_id: "foreign" }, { readback_verified: true }, { external_action_executed: true }, { scheduled_for: "invalid" }]) {
    assert.equal(isDelegatedDailyAiResearchSyncSource({ ...prepared.sourceSnapshot, ...change }, prepared.inputBundle!, companyId), false);
  }
  assert.equal(isDelegatedDailyAiResearchSyncSource(prepared.sourceSnapshot, { ...prepared.inputBundle, source_snapshot_id: "f".repeat(64) }, companyId), false);
  const foreignAdmission = prepareDailyAiResearchSyncAdmission({ companyId: "foreign", dueKey: "fixture", scheduledFor: "2026-09-06T00:00:00Z" });
  assert.equal(foreignAdmission.status, "blocked");
  assert.equal(foreignAdmission.exact_blocker, "daily_ai_research_sync_schedule_binding_invalid");
});

test("wrong host, scope, binding or expiry never dispatches the research worker", async () => {
  for (const [change, blocker] of [
    [{ workerRole: "cloud" }, "mac_worker_required"],
    [{ companyId: "foreign" }, "daily_ai_research_sync_company_not_allowed"],
    [{ workflowId: "daily-ai-research-publish-run" }, "daily_ai_research_sync_company_not_allowed"],
    [{ inputBundle: { ...admission().inputBundle, target_key: "foreign" } }, "daily_ai_research_sync_target_binding_invalid"],
    [{ targetDigest: "wrong" }, "daily_ai_research_sync_target_binding_invalid"],
    [{ authorityExpiresAt: "2020-01-01T00:00:00Z" }, "daily_ai_effect_authority_expired"],
    [{ runId: "../foreign" }, "daily_ai_research_sync_target_binding_invalid"]
  ] as const) {
    let dispatched = false;
    const result = await runDailyAiResearchSourceSyncBusiness({ ...input(), ...change }, async () => { dispatched = true; return {}; });
    assert.equal(dispatched, false);
    assert.equal(result.status, "blocked");
    assert.equal(result.exact_blocker, blocker);
    assert.equal(result.external_action_executed, false);
  }
});

test("injected asynchronous child wait completes only the scoped mirror and permits heartbeat progress", async () => {
  let childStarted = false;
  let childFinished = false;
  let releaseChild!: () => void;
  const childWait = new Promise<void>((resolve) => { releaseChild = () => { childFinished = true; resolve(); }; });
  const pending = runDailyAiResearchSourceSyncBusiness(input(), async (binding) => {
    childStarted = true;
    await childWait;
    assert.deepEqual(Object.keys(binding).sort(), ["company_id", "run_id", "step_id", "idempotency_key", "target_digest", "input_bundle_sha256", "source_snapshot_id", "authority_expires_at"].sort());
    return workerReceipt(binding);
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(childStarted, true);
  assert.equal(childFinished, false);
  releaseChild();
  const result = await pending;
  assert.equal(childFinished, true);
  assert.equal(result.status, "complete");
  assert.equal(result.business_completion_verified, true);
  assert.equal(result.external_action_executed, true);
  assert.equal(result.adapter_result.full_publish_completed, false);
  assert.equal(result.runner_receipt.full_publish_completed, false);
  assert.equal(result.runner_receipt.generation_performed, false);
});

test("foreign, incomplete, nine-column or publication receipts cannot become completion", async () => {
  const mutations = [
    (r: Record<string, any>) => { r.run_id = "foreign"; },
    (r: Record<string, any>) => { r.source_snapshot_id = "f".repeat(64); },
    (r: Record<string, any>) => { r.cleanup_verified = false; },
    (r: Record<string, any>) => { r.mirror.mirror_column_count = 9; },
    (r: Record<string, any>) => { r.mirror.manual_views_match = false; },
    (r: Record<string, any>) => { r.mirror.spreadsheet_id = "other"; },
    (r: Record<string, any>) => { r.full_publish_completed = true; },
    (r: Record<string, any>) => { r.generation_performed = true; },
    (r: Record<string, any>) => { r.business_proofs.research_queue = false; }
  ];
  for (const mutate of mutations) {
    const result = await runDailyAiResearchSourceSyncBusiness(input(), async (binding) => { const r = workerReceipt(binding); mutate(r); return r; });
    assert.equal(result.status, "blocked");
    assert.equal(result.business_completion_verified, false);
    assert.equal(result.external_action_executed, true);
    assert.equal(result.adapter_result.reconciliation_required, true);
  }
});

test("lost or malformed responses preserve unknown effects and unverified cleanup", async () => {
  for (const execute of [async () => { throw new Error("lost response"); }, async () => null as any,
    async () => ({ status: "blocked", external_action_executed: true })]) {
    const result = await runDailyAiResearchSourceSyncBusiness(input(), execute);
    assert.equal(result.status, "blocked");
    assert.equal(result.external_action_executed, true);
    assert.equal(result.cleanup_verified, false);
  }
});

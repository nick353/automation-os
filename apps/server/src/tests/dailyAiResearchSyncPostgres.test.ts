import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const postgresUrl = process.env.AUTOMATION_OS_TEST_POSTGRES_URL;
test("isolated PostgreSQL: scoped Daily AI schedule -> approval -> Mac claim -> same-run proof, without provider calls", {
  skip: postgresUrl ? false : "postgres_fixture_unavailable", timeout: 120_000
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "aos-daily-ai-pg-proof-"));
  process.env.AUTOMATION_OS_DATABASE_URL = postgresUrl;
  process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(root, "artifacts");
  process.env.AOS_WEB_OPERATION_BACKEND_CONFIG = join(root, "backend.json");
  process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "external";
  process.env.AUTOMATION_OS_WORKER_ROLE = "mac";
  process.env.NODE_TEST_CONTEXT = "1";
  const db = await import("../db/client.js");
  await db.initializePostgresSchemaAsync();
  const daily = await import("../runs/dailyAiResearchSourceSync.js");
  const { materializeDuePortableAutomationOccurrences: materialize } = await import("../runs/portableAutomationScheduler.js");
  const { claimPortableMacWorkerAsync: claimWorker, recordPortableMacWorkerReceiptAsync: recordReceipt } = await import("../runs/portableRemoteWorker.js");
  const { authorizeScheduledLocalBusinessRun: authorize } = await import("../runs/portableScheduledLocalEffect.js");
  const companyId = daily.DAILY_AI_RESEARCH_SYNC_COMPANY;
  const now = new Date().toISOString();
  const serviceUserId = "daily_fixture_service";
  db.insert("users", { id: serviceUserId, auth_provider: "service", auth_subject: serviceUserId, email: null,
    display_name: serviceUserId, kind: "service", status: "active", created_at: now, updated_at: now });
  db.insert("companies", { id: companyId, slug: "daily-fixture", name: "Isolated fixture", status: "active", created_at: now, updated_at: now });
  db.insert("company_memberships", { id: "daily_fixture_member", company_id: companyId, user_id: serviceUserId,
    role: "operator", status: "active", created_at: now, updated_at: now });

  for (const [suffix, policy] of [["wrong_policy", "user_authorized_fixed_local_target.v1"], ["fixed_sheet", daily.DAILY_AI_RESEARCH_SYNC_POLICY]]) {
    const automationId = `daily_fixture_${suffix}`;
    const versionId = `${automationId}_v1`;
    const scheduleId = `${automationId}_schedule`;
    const automation = { company_id: companyId, project_id: companyId, automation_type: "test", name: automationId,
      description: "No real provider execution", goal: "Fixture research mirror", schedule: "daily", cadence: "daily", lane: "local",
      risk_level: "low", approval_policy: "required_before_external_action", worker_command_kind: "daily_ai_research_sync_registered",
      create_approval: 0, status: "active", builder_spec_json: { schema: "aos.registered_automation_adoption.v1",
        canonicalWorkflowId: daily.DAILY_AI_RESEARCH_SYNC_WORKFLOW, browserSurface: "none", unattendedEffectPolicy: policy },
      created_at: now, updated_at: now };
    db.insert("mvp_automations", { id: automationId, ...automation, current_version_id: versionId, revision: 1, archived_at: null });
    db.insert("mvp_automation_versions", { id: versionId, ...automation, automation_id: automationId, revision: 1 });
    db.insert("mvp_automation_schedules", { id: scheduleId, company_id: companyId, project_id: companyId,
      automation_id: automationId, automation_version_id: versionId, kind: "daily", expression: "09:00", timezone: "Asia/Tokyo",
      enabled: 1, status: "active", revision: 1, next_run_at: now, created_at: now, updated_at: now });
    const created = await materialize({ companyId, serviceUserId, now });
    assert.deepEqual(created.blocked, []);
    assert.equal(created.runIds.length, 1);
    const runId = created.runIds[0];
    assert.deepEqual((await materialize({ companyId, serviceUserId, now })).runIds, []);
    const workerId = `fixture_worker_${suffix}`;
    const claim = await claimWorker({ companyId, workerId, requestedRunId: runId });
    assert.ok(claim);
    assert.equal(claim.workflow_id, daily.DAILY_AI_RESEARCH_SYNC_WORKFLOW);
    if (suffix === "wrong_policy") {
      assert.equal(claim.execution_mode, "read_only");
      assert.equal(claim.effect_authority, null);
      assert.equal((await authorize({ companyId, runId, workflowId: daily.DAILY_AI_RESEARCH_SYNC_WORKFLOW })).exactBlocker,
        "scheduled_local_unattended_policy_missing");
      continue;
    }
    assert.equal(claim.execution_mode, "business_effect");
    assert.ok(claim.effect_authority);
    assert.ok(claim.approval_receipt);
    assert.equal(claim.input_bundle?.target_key, daily.DAILY_AI_RESEARCH_SYNC_TARGET);
    // Existing local business approvals retain the legacy wire value; the
    // worker routes by the exact local workflow and emits local_worker proof.
    assert.equal(claim.browser_surface, "browser_use_cli");
    const local = await daily.runDailyAiResearchSourceSyncBusiness({ workflowId: claim.workflow_id, companyId, workerRole: "mac",
      runId, stepId: claim.step_id, idempotencyKey: claim.idempotency_key, targetDigest: claim.target_digest!,
      inputBundleSha256: claim.input_bundle_sha256!, inputBundle: claim.input_bundle!, authorityExpiresAt: claim.effect_authority.expires_at },
    async (binding) => ({ ...binding, workflow_id: claim.workflow_id, status: "complete", exact_blocker: null,
      external_action_executed: true, same_run_receipt: true, same_run_source_sync: true, readback_verified: true, cleanup_verified: true,
      full_publish_completed: false, generation_performed: false, mirror: { spreadsheet_id: daily.DAILY_AI_RESEARCH_SYNC_SHEET,
        sheet_id: 1541274581, mirror_column_count: 39, all_local_ids_and_columns_match: true, manual_views_match: true },
      business_proofs: { research_queue: true, existing_sheet_mirror: true, all_mirror_columns: true, cleanup_receipt: true } }));
    assert.equal(local.status, "complete");
    const receipt = { ...local, browser_surface: "local_worker", run_id: runId, step_id: claim.step_id,
      effects_mode: "business_effect", business_effect_stage: claim.business_effect_stage,
      target_digest: claim.target_digest, input_bundle_sha256: claim.input_bundle_sha256, approval_receipt: claim.approval_receipt,
      effect_authority_id: claim.effect_authority.authority_id,
      effect_authority_sha256: createHash("sha256").update(`${JSON.stringify(claim.effect_authority, null, 2)}\n`).digest("hex"),
      external_executor_status: "fixture_scoped_daily_mirror", web_operation_lifecycle: {
        schema: "automation_os_web_operation_lifecycle.v1", state: "completed", status: "complete", exact_blocker: null,
        run_id: runId, step_id: claim.step_id, idempotency_key: claim.idempotency_key, operation: "update",
        target_digest: claim.target_digest, payload_hash: claim.effect_authority.payload_hash,
        external_action_executed: true, same_run_receipt: true, readback_verified: true, cleanup_verified: true, no_replay: true } };
    const saved = await recordReceipt({ companyId, workerId, runId, receipt });
    assert.equal(saved.receipt.status, "complete");
    assert.equal(saved.receipt.business_proof_verified, true);
    assert.equal(saved.receipt.same_run_source_sync, true);
    assert.equal(saved.receipt.external_action_executed, true);
    const replayed = await recordReceipt({ companyId, workerId, runId, receipt });
    assert.equal(replayed.replayed, true);
    assert.equal(await claimWorker({ companyId, workerId, requestedRunId: runId }), null);
    const persisted = await db.querySqlAsync<{ status: string }>(`SELECT status FROM runs WHERE id=${db.sqlValue(runId)}`);
    assert.equal(persisted[0].status, "complete");
  }
});

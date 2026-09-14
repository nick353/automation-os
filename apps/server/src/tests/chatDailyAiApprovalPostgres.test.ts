import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const postgresUrl = process.env.AUTOMATION_OS_TEST_POSTGRES_URL;
test("isolated PostgreSQL: Chat Daily AI uses explicit immutable approval, single decision and no effect replay", {
  skip: postgresUrl ? false : "postgres_fixture_unavailable", timeout: 180_000
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aos-chat-daily-approval-pg-"));
  process.env.AUTOMATION_OS_DATABASE_URL = postgresUrl;
  process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(root, "artifacts");
  process.env.AUTOMATION_OS_SECRET_DIR = join(root, "secrets");
  process.env.AOS_WEB_OPERATION_BACKEND_CONFIG = join(root, "backend.json");
  process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "external";
  process.env.AUTOMATION_OS_WORKER_ROLE = "mac";
  process.env.AUTOMATION_OS_OWNER_USER_ID = "chat_daily_fixture_owner";
  process.env.NODE_TEST_CONTEXT = "1";
  const db = await import("../db/client.js");
  await db.initializePostgresSchemaAsync();
  const daily = await import("../runs/dailyAiResearchSourceSync.js");
  const actions = await import("../planner/chatWorkflowActions.js");
  const repository = await import("../automations/repository.js");
  const { enqueueCreatePlannerJobAsync } = await import("../planner/createPlannerJobs.js");
  const { claimPortableMacWorkerAsync: claimWorker, recordPortableMacWorkerReceiptAsync: recordReceipt } = await import("../runs/portableRemoteWorker.js");
  const companyId = daily.DAILY_AI_RESEARCH_SYNC_COMPANY;
  const actorUserId = process.env.AUTOMATION_OS_OWNER_USER_ID;
  const now = db.nowIso();
  await db.insertAsync("users", { id: actorUserId, auth_provider: "service", auth_subject: actorUserId, email: null,
    display_name: actorUserId, kind: "service", status: "active", created_at: now, updated_at: now });
  await db.insertAsync("companies", { id: companyId, slug: "chat-daily-fixture", name: "Isolated fixture", status: "active", created_at: now, updated_at: now });
  await db.insertAsync("company_memberships", { id: "chat_daily_fixture_member", company_id: companyId, user_id: actorUserId,
    role: "owner", status: "active", created_at: now, updated_at: now });
  const source = await repository.createAutomationRecordAsync({ companyId, actorUserId, definition: {
    automationType: "registered_workflow", name: "Fixture Daily AI", description: "No provider calls in this fixture",
    goal: "Research and fixed existing sheet mirror", lane: "local", riskLevel: "low", approvalPolicy: "required_before_external_action",
    workerCommandKind: "daily_ai_research_sync_registered", createApproval: false,
    builderSpec: { schema: "aos.registered_automation_adoption.v1", canonicalWorkflowId: daily.DAILY_AI_RESEARCH_SYNC_WORKFLOW,
      browserSurface: "none", unattendedEffectPolicy: daily.DAILY_AI_RESEARCH_SYNC_POLICY, stages: [{ id: "research_and_mirror" }] }
  } });
  const { app } = await import("../index.js");
  const request = (method: string, path: string, payload: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const body = method === "GET" ? "" : JSON.stringify(payload);
      const req = Readable.from(body ? [Buffer.from(body)] : []) as NodeJS.ReadableStream & { method?: string; url?: string; headers?: Record<string, string> };
      req.method = method; req.url = path;
      req.headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), ...headers };
      const res = { statusCode: 200, setHeader() { return this; }, getHeader() { return undefined; }, removeHeader() { return undefined; },
        end(chunk?: string | Buffer) { resolve({ status: this.statusCode, body: JSON.parse(String(chunk ?? "{}")) }); return this; } };
      (app as unknown as { handle(req: unknown, res: unknown, next: (error?: unknown) => void): void }).handle(req, res, reject);
    });
  const approvalFor = async (runId: string) => (await db.querySqlAsync<any>(
    `SELECT * FROM approvals WHERE run_id=${db.sqlValue(runId)} AND company_id=${db.sqlValue(companyId)} LIMIT 1`))[0];
  const runFor = async (runId: string) => (await db.querySqlAsync<any>(
    `SELECT * FROM runs WHERE id=${db.sqlValue(runId)} AND company_id=${db.sqlValue(companyId)} LIMIT 1`))[0];
  const expectedBinding = (approval: any) => Object.fromEntries(
    ["company_id", "run_id", "action_kind", "target_account_ref_id", "payload_hash", "policy_version", "expires_at"]
      .map((field) => [field, approval[field] ?? null]));
  const decide = (approval: any, decision = "approve", note = "Fixture approval memo") =>
    request("PATCH", `/api/mvp/approvals/${approval.id}`, { decision, note, expected_binding: expectedBinding(approval) });
  const prepare = async () => {
    const job = await enqueueCreatePlannerJobAsync({ messages: [{ role: "user", text: "Daily AIの調査と既存Sheets同期を今1回実行。生成・公開はしない" }], metadata: { actorUserId, companyIds: [companyId] } });
    await db.querySqlAsync(`UPDATE create_planner_jobs SET status='completed', result_json=${db.sqlValue({ title: "Fixture Daily AI", reply: "Fixed registered processing", openQuestions: [] })} WHERE id=${db.sqlValue(job.id)}`);
    const scope = { companyId, actorUserId, jobId: job.id };
    const option = (await actions.readChatWorkflowActions(scope)).options.find((item) => item.automation_id === source.id)!;
    assert.ok(option?.can_run_once);
    assert.equal(option.requires_approval, true);
    const input = { ...scope, action: "run_once" as const, automationId: option.automation_id,
      expectedRevision: option.automation_revision, definitionSha256: option.definition_sha256,
      idempotencyKey: `chat-workflow-${job.id}-run_once` };
    const started = await actions.executeChatWorkflowAction(input) as Record<string, any>;
    assert.equal(started.status, "run_admitted");
    assert.equal(started.run_status, "waiting_approval");
    assert.equal(started.business_completion_verified, false);
    return { scope, input, started, approval: await approvalFor(started.run_id) };
  };

  await t.test("manual Chat never inherits schedule approval; exact approval -> fake same-Run proof -> no reclaim", async () => {
    const { scope, input, started, approval } = await prepare();
    const before = await runFor(started.run_id);
    const metadata = JSON.parse(before.metadata_json);
    assert.equal(metadata.unattended_effect_policy, undefined);
    assert.equal(metadata.portable_workflow_invocation.source_trigger, "automation_os_ui");
    assert.equal(metadata.source_snapshot.adapter_result.admission_source, "automation_os_ui");
    assert.equal(approval.status, "pending");
    assert.equal(approval.requested_by, "control-panel");
    assert.equal(await claimWorker({ companyId, workerId: "fixture_daily_worker", requestedRunId: started.run_id }), null);
    const replay = await actions.executeChatWorkflowAction(input) as Record<string, any>;
    assert.equal(replay.run_id, started.run_id);
    const replayedMetadata = JSON.parse((await runFor(started.run_id)).metadata_json);
    assert.deepEqual(replayedMetadata.source_snapshot, metadata.source_snapshot);
    assert.equal((await approvalFor(started.run_id)).expires_at, approval.expires_at);
    assert.equal((await actions.readChatWorkflowActions(scope)).actions.length, 1);
    const approved = await decide(approval, "approve", "Memo edit only; fixed operation unchanged");
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const persisted = await approvalFor(started.run_id);
    assert.equal(persisted.status, "approved");
    assert.equal(persisted.payload_hash, approval.payload_hash);
    assert.equal(persisted.decision_note, "Memo edit only; fixed operation unchanged");
    const api = await request("GET", `/api/v1/companies/${companyId}/approvals`);
    assert.equal(api.status, 200);
    assert.equal(api.body.approvals.find((item: any) => item.id === approval.id).status, "approved");
    const claim = await claimWorker({ companyId, workerId: "fixture_daily_worker", requestedRunId: started.run_id });
    assert.ok(claim?.effect_authority && claim.approval_receipt);
    assert.equal(claim.execution_mode, "business_effect");
    assert.equal(claim.input_bundle?.target_key, daily.DAILY_AI_RESEARCH_SYNC_TARGET);
    const local = await daily.runDailyAiResearchSourceSyncBusiness({ workflowId: claim.workflow_id, companyId, workerRole: "mac",
      runId: claim.run_id, stepId: claim.step_id, idempotencyKey: claim.idempotency_key, targetDigest: claim.target_digest!,
      inputBundleSha256: claim.input_bundle_sha256!, inputBundle: claim.input_bundle!, authorityExpiresAt: claim.effect_authority.expires_at },
    async (binding) => ({ ...binding, workflow_id: claim.workflow_id, status: "complete", exact_blocker: null,
      external_action_executed: true, same_run_receipt: true, same_run_source_sync: true, readback_verified: true, cleanup_verified: true,
      full_publish_completed: false, generation_performed: false, mirror: { spreadsheet_id: daily.DAILY_AI_RESEARCH_SYNC_SHEET,
        sheet_id: 1541274581, mirror_column_count: 39, all_local_ids_and_columns_match: true, manual_views_match: true },
      business_proofs: { research_queue: true, existing_sheet_mirror: true, all_mirror_columns: true, cleanup_receipt: true } }));
    assert.equal(local.status, "complete");
    const receipt = { ...local, browser_surface: "local_worker", run_id: claim.run_id, step_id: claim.step_id,
      effects_mode: "business_effect", business_effect_stage: claim.business_effect_stage, target_digest: claim.target_digest,
      input_bundle_sha256: claim.input_bundle_sha256, approval_receipt: claim.approval_receipt,
      effect_authority_id: claim.effect_authority.authority_id,
      effect_authority_sha256: createHash("sha256").update(`${JSON.stringify(claim.effect_authority, null, 2)}\n`).digest("hex"),
      external_executor_status: "fixture_chat_daily_mirror", web_operation_lifecycle: {
        schema: "automation_os_web_operation_lifecycle.v1", state: "completed", status: "complete", exact_blocker: null,
        run_id: claim.run_id, step_id: claim.step_id, idempotency_key: claim.idempotency_key, operation: "update",
        target_digest: claim.target_digest, payload_hash: claim.effect_authority.payload_hash, external_action_executed: true,
        same_run_receipt: true, readback_verified: true, cleanup_verified: true, no_replay: true } };
    const recorded = await recordReceipt({ companyId, workerId: "fixture_daily_worker", runId: claim.run_id, receipt });
    assert.equal(recorded.receipt.business_proof_verified, true);
    assert.equal(recorded.receipt.same_run_source_sync, true);
    assert.equal((await recordReceipt({ companyId, workerId: "fixture_daily_worker", runId: claim.run_id, receipt })).replayed, true);
    assert.equal(await claimWorker({ companyId, workerId: "fixture_daily_worker", requestedRunId: claim.run_id }), null);
    assert.equal((await actions.executeChatWorkflowAction(input) as any).run_id, claim.run_id);
    assert.equal((await decide(approval)).status, 409);
    assert.equal((await runFor(claim.run_id)).status, "complete");
  });

  await t.test("reject stops unclaimed Run and steps; a repeated decision cannot change it", async () => {
    const { started, approval } = await prepare();
    assert.equal((await decide(approval, "reject")).status, 200);
    const run = await runFor(started.run_id);
    assert.equal(run.status, "blocked");
    assert.equal(JSON.parse(run.metadata_json).exact_blocker, "approval_rejected");
    assert.equal(JSON.parse(run.metadata_json).external_action_executed, false);
    const steps = await db.querySqlAsync<any>(`SELECT status FROM run_steps WHERE run_id=${db.sqlValue(run.id)}`);
    assert.ok(steps.length && steps.every((step) => step.status === "blocked"));
    assert.equal((await decide(approval)).status, 409);
    assert.equal(await claimWorker({ companyId, workerId: "fixture_rejected", requestedRunId: run.id }), null);
    assert.equal((await approvalFor(run.id)).status, "rejected");
  });

  await t.test("expired approval cannot be approved and a new request has a different binding", async () => {
    const { started, approval } = await prepare();
    await db.querySqlAsync(`UPDATE approvals SET expires_at='2020-01-01T00:00:00.000Z' WHERE id=${db.sqlValue(approval.id)}`);
    const expired = await approvalFor(started.run_id);
    const response = await decide(expired);
    assert.equal(response.status, 409);
    assert.equal(response.body.error, "approval_expired");
    assert.equal((await approvalFor(started.run_id)).status, "pending");
    assert.equal(await claimWorker({ companyId, workerId: "fixture_expired", requestedRunId: started.run_id }), null);
    const fresh = await prepare();
    assert.notEqual(fresh.started.run_id, started.run_id);
    assert.notEqual(fresh.approval.id, expired.id);
    assert.equal((await decide(fresh.approval, "reject")).status, 200);
  });

  await t.test("stale displayed payload is rejected; a changed Run payload is never executed under old approval", async () => {
    const { started, approval } = await prepare();
    await db.querySqlAsync(`UPDATE approvals SET payload_hash=${db.sqlValue("b".repeat(64))} WHERE id=${db.sqlValue(approval.id)}`);
    const stale = await decide(approval);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "approval_binding_changed");
    assert.equal((await approvalFor(started.run_id)).status, "pending");
    assert.equal((await decide(await approvalFor(started.run_id), "reject")).status, 200);
    const changed = await prepare();
    const run = await runFor(changed.started.run_id);
    const metadata = JSON.parse(run.metadata_json);
    metadata.portable_input_bundle.input.payload_hash = "c".repeat(64);
    await db.querySqlAsync(`UPDATE runs SET metadata_json=${db.sqlValue(metadata)} WHERE id=${db.sqlValue(run.id)}`);
    assert.equal((await decide(changed.approval)).status, 200);
    assert.equal(await claimWorker({ companyId, workerId: "fixture_changed", requestedRunId: run.id }), null);
    assert.notEqual((await runFor(run.id)).status, "complete");
  });

  await t.test("concurrent approve and reject have one winner, with no later overwrite", async () => {
    const { started, approval } = await prepare();
    const decisions = await Promise.all([decide(approval, "approve"), decide(approval, "reject")]);
    assert.equal(decisions.filter((result) => result.status === 200).length, 1);
    assert.equal(decisions.filter((result) => result.status === 409).length, 1);
    const expectedStatus = decisions[0].status === 200 ? "approved" : "rejected";
    assert.equal((await approvalFor(started.run_id)).status, expectedStatus);
    const retry = await decide(approval, expectedStatus === "approved" ? "reject" : "approve");
    assert.equal(retry.status, 409);
    assert.equal((await approvalFor(started.run_id)).status, expectedStatus);
  });

  await t.test("cancel stops only pre-effect work and preserves terminal or unknown-effect evidence", async () => {
    const fresh = await prepare();
    assert.equal((await request("POST", `/api/approvals/${fresh.approval.id}/cancel`)).status, 200);
    assert.equal((await runFor(fresh.started.run_id)).status, "cancelled");
    assert.equal(await claimWorker({ companyId, workerId: "fixture_cancelled", requestedRunId: fresh.started.run_id }), null);
    for (const [status, effect] of [["complete", true], ["blocked", null]] as const) {
      const previous = await prepare();
      const run = await runFor(previous.started.run_id);
      const metadata = { ...JSON.parse(run.metadata_json), external_action_executed: effect, exact_blocker: "fixture_existing_evidence" };
      await db.querySqlAsync(`UPDATE runs SET status=${db.sqlValue(status)}, metadata_json=${db.sqlValue(metadata)} WHERE id=${db.sqlValue(run.id)}`);
      assert.equal((await decide(previous.approval, "reject")).status, 200);
      const after = await runFor(run.id);
      assert.equal(after.status, status);
      assert.deepEqual(JSON.parse(after.metadata_json), metadata);
    }
  });

  await t.test("company and decision roles remain enforced", async () => {
    const fresh = await prepare();
    const wrongCompany = await request("PATCH", `/api/mvp/approvals/${fresh.approval.id}`, {
      decision: "approve", expected_binding: { ...expectedBinding(fresh.approval), company_id: "foreign_company" }
    });
    assert.equal(wrongCompany.status, 409);
    await db.querySqlAsync("UPDATE company_memberships SET role='viewer' WHERE id='chat_daily_fixture_member'");
    assert.notEqual((await decide(fresh.approval)).status, 200);
    assert.equal((await approvalFor(fresh.started.run_id)).status, "pending");
  });
});

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const postgresUrl = process.env.AUTOMATION_OS_TEST_POSTGRES_URL;
test("isolated PostgreSQL: Chat binds real read-only runners, saves inert drafts, and recovers the same Run after a lost completion update", {
  skip: postgresUrl ? false : "postgres_fixture_unavailable", timeout: 120_000
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "aos-chat-workflow-pg-proof-"));
  process.env.AUTOMATION_OS_DATABASE_URL = postgresUrl;
  process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(root, "artifacts");
  process.env.AUTOMATION_OS_SECRET_DIR = join(root, "secrets");
  process.env.AOS_WEB_OPERATION_BACKEND_CONFIG = join(root, "backend.json");
  process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "external";
  process.env.AUTOMATION_OS_WORKER_ROLE = "mac";
  process.env.AUTOMATION_OS_OWNER_USER_ID = "chat_fixture_operator";
  process.env.NODE_TEST_CONTEXT = "1";
  const db = await import("../db/client.js");
  await db.initializePostgresSchemaAsync();
  const plan = await import("../planner/chatWorkflowPlan.js");
  const actions = await import("../planner/chatWorkflowActions.js");
  const repository = await import("../automations/repository.js");
  const { enqueueCreatePlannerJobAsync } = await import("../planner/createPlannerJobs.js");
  const companyId = plan.CHAT_WORKFLOW_COMPANY;
  const actorUserId = process.env.AUTOMATION_OS_OWNER_USER_ID;
  const now = db.nowIso();
  await db.insertAsync("users", { id: actorUserId, auth_provider: "service", auth_subject: actorUserId, email: null,
    display_name: actorUserId, kind: "service", status: "active", created_at: now, updated_at: now });
  await db.insertAsync("companies", { id: companyId, slug: "chat-fixture", name: "Isolated Chat fixture", status: "active", created_at: now, updated_at: now });
  await db.insertAsync("company_memberships", { id: "chat_fixture_member", company_id: companyId, user_id: actorUserId,
    role: "operator", status: "active", created_at: now, updated_at: now });
  const source = await repository.createAutomationRecordAsync({ companyId, actorUserId, definition: {
    automationType: "registered_workflow", name: "Fixture Gmail", description: "No real provider call", goal: "Unsent review",
    lane: "local", riskLevel: "low", approvalPolicy: "required_before_external_action", workerCommandKind: "email_review_registered", createApproval: false,
    builderSpec: { schema: "aos.registered_automation_adoption.v1", canonicalWorkflowId: "email-review-reply", browserSurface: "none",
      connectorExecutionOwner: "zeabur", scope: { account_ref: "fixture_metadata_only", sends_email: false }, stages: [{ id: "gmail_metadata" }] }
  } });
  const sourceHash = plan.chatWorkflowHash(source);
  const completedJob = async (prompt: string) => {
    const job = await enqueueCreatePlannerJobAsync({ messages: [{ role: "user", text: prompt }], metadata: { actorUserId, companyIds: [companyId] } });
    await db.querySqlAsync(`UPDATE create_planner_jobs SET status='completed', result_json=${db.sqlValue({ title: "Fixture Chat workflow", reply: "Fixed registered processing", openQuestions: [] })}
      WHERE id=${db.sqlValue(job.id)}`);
    return { companyId, actorUserId, jobId: job.id };
  };
  const inputFor = async (scope: Awaited<ReturnType<typeof completedJob>>, action: "run_once" | "save_draft") => {
    const read = await actions.readChatWorkflowActions(scope);
    const option = read.options.find((item) => item.automation_id === source.id)!;
    assert.ok(option);
    return { ...scope, action, automationId: option.automation_id, expectedRevision: option.automation_revision,
      definitionSha256: option.definition_sha256, idempotencyKey: `chat-workflow-${scope.jobId}-${action}` };
  };
  const runScope = await completedJob("Gmailを確認して。送信はしない");
  const runInput = await inputFor(runScope, "run_once");
  await assert.rejects(actions.executeChatWorkflowAction({ ...runInput, expectedRevision: 99 }), /registration_changed/);
  await assert.rejects(actions.executeChatWorkflowAction({ ...runInput, idempotencyKey: "caller-selected-new-key" }), /idempotency_binding_invalid/);
  await assert.rejects(actions.readChatWorkflowActions({ ...runScope, actorUserId: "foreign" }), /job_scope_mismatch/);
  await assert.rejects(actions.readChatWorkflowActions({ ...runScope, companyId: "foreign" }), /job_scope_mismatch/);
  const started = await actions.executeChatWorkflowAction(runInput) as Record<string, any>;
  assert.equal(started.status, "run_admitted");
  assert.ok(started.run_id);
  assert.equal(started.business_completion_verified, false);
  const replay = await actions.executeChatWorkflowAction(runInput) as Record<string, any>;
  assert.equal(replay.run_id, started.run_id);
  assert.equal(replay.replayed, true);
  const rows = await db.querySqlAsync<{ id: string; automation_id: string; automation_version_id: string; metadata_json: string }>(
    `SELECT id, automation_id, automation_version_id, metadata_json FROM runs WHERE company_id=${db.sqlValue(companyId)}`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].automation_id, source.id);
  assert.equal(rows[0].automation_version_id, source.currentVersionId);
  const metadata = typeof rows[0].metadata_json === "string" ? JSON.parse(rows[0].metadata_json) : rows[0].metadata_json;
  assert.equal(metadata.registered_workflow_start.runnerKind, "email_review_registered");
  assert.equal(metadata.chat_origin.job_id, runScope.jobId);
  assert.equal(metadata.chat_origin.binding_id, started.binding_id);
  assert.equal(metadata.portable_worker.mode, "read_only");
  assert.equal(metadata.effect_stage, undefined);
  assert.equal((await actions.readChatWorkflowActions(runScope)).actions[0].binding_id, started.binding_id);

  const draftScope = await completedJob("Gmailの自動化を作って。保存だけ、実行しない");
  const draftInput = await inputFor(draftScope, "save_draft");
  const draft = await actions.executeChatWorkflowAction(draftInput) as Record<string, any>;
  const draftReplay = await actions.executeChatWorkflowAction(draftInput) as Record<string, any>;
  assert.equal(draft.status, "draft_saved");
  assert.equal(draftReplay.automation_id, draft.automation_id);
  assert.equal(draftReplay.replayed, true);
  const persistedDraft = await repository.getAutomationRecordAsync(companyId, draft.automation_id);
  assert.equal(persistedDraft?.status, "draft");
  assert.equal(persistedDraft?.workerCommandKind, "email_review_registered");
  assert.equal((persistedDraft?.builderSpec.chat_origin as Record<string, unknown>).source_automation_id, source.id);
  assert.deepEqual(await db.querySqlAsync(`SELECT id FROM mvp_automation_schedules WHERE automation_id=${db.sqlValue(draft.automation_id)}`), []);
  assert.deepEqual(await db.querySqlAsync(`SELECT id FROM runs WHERE automation_id=${db.sqlValue(draft.automation_id)}`), []);
  assert.equal(plan.chatWorkflowHash(await repository.getAutomationRecordAsync(companyId, source.id)), sourceHash);

  const lostScope = await completedJob("Gmailを1回確認して");
  const lostInput = await inputFor(lostScope, "run_once");
  // This fault exists only in this disposable DB: admission persists a Run,
  // then its invocation completion update fails. Never execute a provider.
  await db.querySqlAsync(`CREATE FUNCTION fixture_fail_chat_completion() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.status='completed' AND OLD.status='pending' AND NEW.idempotency_key LIKE 'chat-run-%'
      THEN RAISE EXCEPTION 'fixture_lost_completion_update'; END IF; RETURN NEW; END; $$`);
  await db.querySqlAsync(`CREATE TRIGGER fixture_chat_completion BEFORE UPDATE ON portable_workflow_invocations
    FOR EACH ROW EXECUTE FUNCTION fixture_fail_chat_completion()`);
  await assert.rejects(actions.executeChatWorkflowAction(lostInput), /fixture_lost_completion_update/);
  const recovered = (await actions.readChatWorkflowActions(lostScope)).actions[0] as Record<string, any>;
  assert.equal(recovered.status, "run_admitted");
  assert.ok(recovered.run_id);
  const countBefore = (await db.querySqlAsync(`SELECT id FROM runs WHERE company_id=${db.sqlValue(companyId)}`)).length;
  await db.querySqlAsync("DROP TRIGGER fixture_chat_completion ON portable_workflow_invocations");
  await db.querySqlAsync("DROP FUNCTION fixture_fail_chat_completion()");
  const sameAfterLoss = await actions.executeChatWorkflowAction(lostInput) as Record<string, any>;
  assert.equal(sameAfterLoss.run_id, recovered.run_id);
  assert.equal((await db.querySqlAsync(`SELECT id FROM runs WHERE company_id=${db.sqlValue(companyId)}`)).length, countBefore);

  const concurrentScope = await completedJob("Gmailを確認して");
  const concurrentInput = await inputFor(concurrentScope, "run_once");
  const concurrent = await Promise.allSettled([actions.executeChatWorkflowAction(concurrentInput), actions.executeChatWorkflowAction(concurrentInput)]);
  assert.ok(concurrent.some((result) => result.status === "fulfilled"));
  const concurrentRead = (await actions.readChatWorkflowActions(concurrentScope)).actions;
  assert.equal(concurrentRead.length, 1);
  assert.equal(concurrentRead[0].status, "run_admitted");
  assert.equal((await db.querySqlAsync(`SELECT id FROM runs WHERE company_id=${db.sqlValue(companyId)}`)).length, countBefore + 1);

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
  const route = `/api/v1/companies/${companyId}/chat-jobs/${runScope.jobId}/workflow-actions`;
  const apiRead = await request("GET", route);
  assert.equal(apiRead.status, 200);
  assert.equal(apiRead.body.actions[0].run_id, started.run_id);
  const apiReplay = await request("POST", route, { action: "run_once", automation_id: runInput.automationId,
    expected_revision: runInput.expectedRevision, definition_sha256: runInput.definitionSha256 }, { "idempotency-key": runInput.idempotencyKey });
  assert.equal(apiReplay.status, 202);
  assert.equal(apiReplay.body.run_id, started.run_id);
  assert.equal((await request("POST", route, { action: "run_once", injected_worker_command: "arbitrary" })).status, 400);
  assert.equal((await request("GET", route.replace(runScope.jobId, "missing_job"))).status, 404);
  await db.querySqlAsync(`UPDATE company_memberships SET role='viewer' WHERE id='chat_fixture_member'`);
  const viewerWrite = await request("POST", route, { action: "run_once", automation_id: runInput.automationId,
    expected_revision: runInput.expectedRevision, definition_sha256: runInput.definitionSha256 }, { "idempotency-key": runInput.idempotencyKey });
  assert.notEqual(viewerWrite.status, 202);
  assert.equal(viewerWrite.body.ok, false);
});

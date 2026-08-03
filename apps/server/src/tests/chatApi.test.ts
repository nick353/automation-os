import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { CodexAppServerClient } from "../codex/appServerClient.js";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-chat-api-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.AUTOMATION_OS_SECRET_DIR = join(tempRoot, "secrets");

const { app } = await import("../index.js");
const db = await import("../db/client.js");

test("POST /api/create/chat queues a project-scoped Codex App Server turn without exposing snapshot internals", async () => {
  db.initDb();
  db.resetDemoData();
  const now = db.nowIso();
  db.upsert("users", { id: "user_local_owner", auth_provider: "test", auth_subject: "user_local_owner", email: null, display_name: "Chat owner", kind: "human", status: "active", created_at: now, updated_at: now });
  db.upsert("companies", { id: "project-a", slug: "project-a", name: "Research Project", status: "active", created_at: now, updated_at: now });
  db.upsert("company_memberships", { id: "membership-chat", company_id: "project-a", user_id: "user_local_owner", role: "owner", status: "active", created_at: now, updated_at: now });

  const workerStatePath = join(tempRoot, "worker-state.json");
  writeFileSync(workerStatePath, JSON.stringify({
    status: "blocked",
    blocker: "stored_postgres_secret_invalid_url",
    reason: "template_reference_missing:POSTGRES_PASSWORD",
    nextAction: "有効なPostgreSQL接続を保存し直してください。"
  }));
  const previousWorkerStatePath = process.env.AUTOMATION_OS_WORKER_STATE_PATH;
  process.env.AUTOMATION_OS_WORKER_STATE_PATH = workerStatePath;
  let response: Awaited<ReturnType<typeof requestJson>>;
  try {
    response = await requestJson("POST", "/api/create/chat", {
      project_id: "project-a",
      currentDraft: "token=secret-planner-input",
      messages: [{ role: "user", text: "システム全体を確認して token=secret-planner-message" }]
    });
  } finally {
    if (previousWorkerStatePath === undefined) delete process.env.AUTOMATION_OS_WORKER_STATE_PATH;
    else process.env.AUTOMATION_OS_WORKER_STATE_PATH = previousWorkerStatePath;
  }
  assert.equal(response.status, 202);
  const body = JSON.parse(response.body) as { ok: boolean; job: { id: string; status: string; metadata: Record<string, unknown> }; worker_readback: { status: string; exactBlocker: string | null; nextAction: string | null } | null };
  assert.equal(body.ok, true);
  assert.equal(body.job.status, "queued");
  assert.equal(body.job.metadata.transport, "codex_app_server");
  assert.equal(body.job.metadata.route, "mac_worker_codex_app_server");
  assert.equal("streamText" in body.job.metadata, false);
  assert.equal(body.job.metadata.streamTextLength, 0);
  assert.equal(body.worker_readback?.status, "blocked");
  assert.equal(body.worker_readback?.exactBlocker, "stored_postgres_secret_invalid_url");
  assert.match(body.worker_readback?.nextAction ?? "", /PostgreSQL/u);
  assert.doesNotMatch(JSON.stringify(body), /template_reference_missing|POSTGRES_PASSWORD|secret-planner-message/u);
  const readback = await requestJson("GET", `/api/create/plan/jobs/${encodeURIComponent(body.job.id)}`);
  const readbackBody = JSON.parse(readback.body) as { job: { metadata: Record<string, unknown> } };
  assert.equal(readback.status, 200);
  assert.equal(readbackBody.job.metadata.transport, "codex_app_server");
  assert.equal("streamText" in readbackBody.job.metadata, false);
  assert.equal(JSON.stringify(readbackBody).includes("DATABASE_URL"), false);
  const stored = db.querySql<{ messages_json: string; current_draft: string }>("SELECT messages_json, current_draft FROM create_planner_jobs WHERE id=" + db.sqlValue(body.job.id))[0];
  assert.ok(stored);
  assert.equal(stored.messages_json.includes("secret-planner-message"), false);
  assert.equal(stored.current_draft.includes("secret-planner-input"), false);

  const foreignThread = await requestJson("POST", "/api/create/chat", {
    project_id: "project-a",
    codex_thread_id: "thread-from-another-scope",
    messages: [{ role: "user", text: "続き" }]
  });
  assert.equal(foreignThread.status, 404);
  assert.equal(JSON.parse(foreignThread.body).exactBlocker, "codex_thread_not_found");
});

test("GET /api/create/chat/threads returns only the actor/company-scoped redacted thread projection", async () => {
  const { enqueueCreatePlannerJob } = await import("../planner/createPlannerJobs.js");
  const job = enqueueCreatePlannerJob({
    messages: [
      { role: "user", text: "会社Aの会話 token=thread-secret-value" },
      { role: "assistant", text: "readbackを確認しました。" }
    ],
    metadata: {
      actorUserId: "user_local_owner",
      companyIds: ["project-a"],
      codexThreadId: "thread_project_a_history"
    }
  });
  enqueueCreatePlannerJob({
    messages: [{ role: "user", text: "会社Bの会話" }],
    metadata: {
      actorUserId: "user_local_owner",
      companyIds: ["project-b"],
      codexThreadId: "thread_project_b_history"
    }
  });

  const response = await requestJson("GET", "/api/create/chat/threads?project_id=project-a");
  assert.equal(response.status, 200, response.body);
  const body = JSON.parse(response.body) as { ok: boolean; threads: Array<{ threadId: string; messages: Array<{ text: string }> }> };
  assert.equal(body.ok, true);
  assert.equal(body.threads.length, 1);
  assert.equal(body.threads[0].threadId, "thread_project_a_history");
  assert.equal(JSON.stringify(body).includes("thread-secret-value"), false);
  assert.equal(body.threads[0].messages.some((message) => message.text.includes("[redacted")), true);
  assert.equal(JSON.stringify(body).includes("project_b_history"), false);
  assert.equal(job.status, "queued");
});

test("chat planner cancellation fences a queued job and preserves actor scope", async () => {
  db.initDb();
  const now = db.nowIso();
  db.upsert("users", { id: "user_local_owner", auth_provider: "test", auth_subject: "user_local_owner", email: null, display_name: "Chat owner", kind: "human", status: "active", created_at: now, updated_at: now });
  db.upsert("companies", { id: "project-chat-cancel", slug: "project-chat-cancel", name: "Chat Cancel Project", status: "active", created_at: now, updated_at: now });
  db.upsert("company_memberships", { id: "membership-chat-cancel", company_id: "project-chat-cancel", user_id: "user_local_owner", role: "owner", status: "active", created_at: now, updated_at: now });
  const { enqueueCreatePlannerJob, processQueuedCreatePlannerJobs } = await import("../planner/createPlannerJobs.js");
  const job = enqueueCreatePlannerJob({
    messages: [{ role: "user", text: "停止可能性を確認" }],
    metadata: { transport: "codex_app_server", actorUserId: "user_local_owner", companyIds: ["project-chat-cancel"] }
  });

  const cancelled = await requestJson("POST", `/api/create/plan/jobs/${encodeURIComponent(job.id)}/cancel`);
  assert.equal(cancelled.status, 200, cancelled.body);
  const cancelledBody = JSON.parse(cancelled.body) as { ok: boolean; external_action_executed: boolean; job: { status: string; exactBlocker?: string } };
  assert.equal(cancelledBody.ok, true);
  assert.equal(cancelledBody.external_action_executed, false);
  assert.equal(cancelledBody.job.status, "blocked");
  assert.equal(cancelledBody.job.exactBlocker, "chat_cancelled_by_user");

  const readback = await requestJson("GET", `/api/create/plan/jobs/${encodeURIComponent(job.id)}`);
  assert.equal(readback.status, 200, readback.body);
  assert.equal((JSON.parse(readback.body) as { job: { status: string; exactBlocker?: string } }).job.exactBlocker, "chat_cancelled_by_user");
  db.execSql("UPDATE create_planner_jobs SET status='blocked', exact_blocker='test_fixture_isolation' WHERE status='queued'");
  assert.deepEqual(await processQueuedCreatePlannerJobs(1, { workerId: "cancel-test" }), []);

  const secondCancel = await requestJson("POST", `/api/create/plan/jobs/${encodeURIComponent(job.id)}/cancel`);
  assert.equal(secondCancel.status, 409);
  assert.equal(JSON.parse(secondCancel.body).exactBlocker, "chat_job_not_cancellable");

  const previousActor = process.env.AUTOMATION_OS_OWNER_USER_ID;
  process.env.AUTOMATION_OS_OWNER_USER_ID = "user_other_actor";
  try {
    const foreignCancel = await requestJson("POST", `/api/create/plan/jobs/${encodeURIComponent(job.id)}/cancel`);
    assert.equal(foreignCancel.status, 404);
    assert.equal(JSON.parse(foreignCancel.body).exactBlocker, "create_planner_job_not_found");
  } finally {
    if (previousActor === undefined) delete process.env.AUTOMATION_OS_OWNER_USER_ID;
    else process.env.AUTOMATION_OS_OWNER_USER_ID = previousActor;
  }
});

test("named chat sessions stay actor/project scoped and preserve the App Server thread binding", async () => {
  db.initDb();
  db.execSql("UPDATE create_planner_jobs SET status='blocked' WHERE status='queued'");
  const now = db.nowIso();
  db.upsert("companies", { id: "project-named-a", slug: "project-named-a", name: "Named Project", status: "active", created_at: now, updated_at: now });
  db.upsert("company_memberships", { id: "membership-named-a", company_id: "project-named-a", user_id: "user_local_owner", role: "owner", status: "active", created_at: now, updated_at: now });

  const created = await requestJson("POST", "/api/create/chat/sessions", {
    project_id: "project-named-a",
    name: "顧客対応 token=session-name-secret"
  });
  assert.equal(created.status, 201, created.body);
  const createdBody = JSON.parse(created.body) as { session: { id: string; name: string; active: boolean; project_id: string } };
  assert.equal(createdBody.session.project_id, "project-named-a");
  assert.equal(createdBody.session.active, true);
  assert.doesNotMatch(createdBody.session.name, /session-name-secret/u);

  const second = await requestJson("POST", "/api/create/chat/sessions", { project_id: "project-named-a", name: "別の相談" });
  assert.equal(second.status, 201, second.body);
  const secondId = (JSON.parse(second.body) as { session: { id: string } }).session.id;
  const activated = await requestJson("POST", `/api/create/chat/sessions/${encodeURIComponent(secondId)}/activate`, { project_id: "project-named-a" });
  assert.equal(activated.status, 200, activated.body);
  assert.equal((JSON.parse(activated.body) as { session: { active: boolean } }).session.active, true);

  const renamed = await requestJson("PATCH", `/api/create/chat/sessions/${encodeURIComponent(createdBody.session.id)}`, {
    project_id: "project-named-a",
    name: "顧客対応 renamed"
  });
  assert.equal(renamed.status, 200, renamed.body);
  assert.equal((JSON.parse(renamed.body) as { session: { name: string } }).session.name, "顧客対応 renamed");

  const crossProject = await requestJson("GET", "/api/create/chat/sessions?project_id=project-not-owned");
  assert.equal(crossProject.status, 404);
  assert.equal(JSON.parse(crossProject.body).exactBlocker, "chat_session_not_found");

  const previousActor = process.env.AUTOMATION_OS_OWNER_USER_ID;
  process.env.AUTOMATION_OS_OWNER_USER_ID = "user_other_actor";
  try {
    const crossActor = await requestJson("GET", "/api/create/chat/sessions?project_id=project-named-a");
    assert.equal(crossActor.status, 404);
    assert.equal(JSON.parse(crossActor.body).exactBlocker, "chat_session_not_found");
  } finally {
    if (previousActor === undefined) delete process.env.AUTOMATION_OS_OWNER_USER_ID;
    else process.env.AUTOMATION_OS_OWNER_USER_ID = previousActor;
  }

  const previousRequireWrite = process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN;
  const previousWriteToken = process.env.AUTOMATION_OS_WRITE_TOKEN;
  process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN = "1";
  process.env.AUTOMATION_OS_WRITE_TOKEN = "named-session-write-token";
  try {
    const guardedMutation = await requestJson("POST", "/api/create/chat/sessions", { project_id: "project-named-a", name: "guarded session" });
    assert.equal(guardedMutation.status, 401);
    assert.equal(JSON.parse(guardedMutation.body).exactBlocker, "production_token_required");
  } finally {
    if (previousRequireWrite === undefined) delete process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN;
    else process.env.AUTOMATION_OS_REQUIRE_WRITE_TOKEN = previousRequireWrite;
    if (previousWriteToken === undefined) delete process.env.AUTOMATION_OS_WRITE_TOKEN;
    else process.env.AUTOMATION_OS_WRITE_TOKEN = previousWriteToken;
  }

  const queued = await requestJson("POST", "/api/create/chat", {
    project_id: "project-named-a",
    session_id: createdBody.session.id,
    messages: [{ role: "user", text: "同じ相談を続ける" }]
  });
  assert.equal(queued.status, 202, queued.body);
  const queuedBody = JSON.parse(queued.body) as { job: { id: string } };
  const queuedMetadata = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM create_planner_jobs WHERE id=${db.sqlValue(queuedBody.job.id)}`)[0];
  assert.equal(JSON.parse(queuedMetadata.metadata_json).chatSessionId, createdBody.session.id);

  const { processQueuedCreatePlannerJobs } = await import("../planner/createPlannerJobs.js");
  const fakeClient = {
    startOrResumeThread: async () => "thread_named_session",
    startTurn: async ({ threadId }: { threadId: string }) => ({
      threadId,
      turnId: "turn_named_session",
      status: "completed" as const,
      text: JSON.stringify({ intent: "answer_question", title: "named", reply: "続き", command: "", visibleSteps: [], backendChecks: [], answered: [], openQuestions: [], nextAction: "", executionDecision: "read_only", confidence: "high" }),
      structured: { intent: "answer_question", title: "named", reply: "続き", command: "", visibleSteps: [], backendChecks: [], answered: [], openQuestions: [], nextAction: "", executionDecision: "read_only", confidence: "high" },
      events: []
    })
  } as unknown as CodexAppServerClient;
  await processQueuedCreatePlannerJobs(1, { workerId: "named-session-test", appServerClient: fakeClient });
  const linked = db.querySql<{ codex_thread_id: string | null }>(`SELECT codex_thread_id FROM chat_sessions WHERE id=${db.sqlValue(createdBody.session.id)}`)[0];
  assert.equal(linked.codex_thread_id, "thread_named_session");
});

test("create planner jobs claim atomically and recover an expired Mac worker lease", async () => {
  db.initDb();
  db.resetDemoData();
  const { enqueueCreatePlannerJob, processQueuedCreatePlannerJobs } = await import("../planner/createPlannerJobs.js");
  const result = {
    intent: "answer_question",
    title: "並列claimの確認",
    reply: "同じ相談は一つのworkerだけが処理します。",
    command: "",
    visibleSteps: ["claim", "readback"],
    backendChecks: ["lease_owner", "attempt_count"],
    answered: ["重複実行"],
    openQuestions: [],
    nextAction: "readbackを確認します。",
    executionDecision: "read_only",
    confidence: "high"
  };
  const fakeClient = {
    startOrResumeThread: async () => "thread_lease_test",
    startTurn: async ({ threadId }: { threadId: string }) => ({
      threadId,
      turnId: "turn_lease_test",
      status: "completed" as const,
      text: JSON.stringify(result),
      structured: result,
      events: [{ method: "item/agentMessage/delta", delta: "event-secret-value", capturedAt: "2026-08-03T00:00:00.000Z" }]
    })
  } as unknown as CodexAppServerClient;

  const first = enqueueCreatePlannerJob({
    messages: [{ role: "user", text: "並列claimを確認" }],
    metadata: { transport: "codex_app_server", actorUserId: "user_local_owner", companyIds: ["project-a"] }
  });
  const second = enqueueCreatePlannerJob({
    messages: [{ role: "user", text: "もう一つの相談" }],
    metadata: { transport: "codex_app_server", actorUserId: "user_local_owner", companyIds: ["project-a"] }
  });
  const processed = await Promise.all([
    processQueuedCreatePlannerJobs(1, { workerId: "worker-a", appServerClient: fakeClient }),
    processQueuedCreatePlannerJobs(1, { workerId: "worker-b", appServerClient: fakeClient })
  ]);
  const processedIds = processed.flat().map((job) => job.id);
  assert.deepEqual(new Set(processedIds), new Set([first.id, second.id]));
  assert.equal(processed.flat().every((job) => job.status === "completed"), true);
  const leases = db.querySql<{ lease_owner: string | null; lease_expires_at: string | null; attempt_count: number }>(
    `SELECT lease_owner, lease_expires_at, attempt_count FROM create_planner_jobs WHERE id IN (${db.sqlValue(first.id)}, ${db.sqlValue(second.id)}) ORDER BY id`
  );
  assert.equal(leases.length, 2);
  assert.equal(leases.every((lease) => lease.lease_owner === null && lease.lease_expires_at === null && lease.attempt_count === 1), true);
  const persistedProgress = db.querySql<{ metadata_json: string }>(
    `SELECT metadata_json FROM create_planner_jobs WHERE id=${db.sqlValue(first.id)}`
  )[0];
  const persistedProgressMetadata = JSON.parse(persistedProgress.metadata_json) as Record<string, unknown>;
  assert.equal("streamText" in persistedProgressMetadata, false);
  assert.equal(typeof persistedProgressMetadata.streamTextLength, "number");
  assert.ok(Number(persistedProgressMetadata.streamTextLength) > 0);
  assert.equal(JSON.stringify(persistedProgressMetadata).includes("event-secret-value"), false);
  const processedReadback = await requestJson("GET", `/api/create/plan/jobs/${encodeURIComponent(first.id)}`);
  assert.equal(processedReadback.status, 200);
  assert.equal(processedReadback.body.includes("event-secret-value"), false);

  const stale = enqueueCreatePlannerJob({
    messages: [{ role: "user", text: "期限切れleaseを回復" }],
    metadata: { transport: "codex_app_server", actorUserId: "user_local_owner", companyIds: ["project-a"] }
  });
  db.execSql(`UPDATE create_planner_jobs SET status='running', lease_owner='dead-worker', lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=${db.sqlValue(stale.id)}`);
  const recovered = await processQueuedCreatePlannerJobs(1, { workerId: "worker-recovery", appServerClient: fakeClient });
  assert.equal(recovered[0]?.id, stale.id);
  assert.equal(recovered[0]?.status, "completed");
  const recoveredLease = db.querySql<{ attempt_count: number; lease_owner: string | null }>(`SELECT attempt_count, lease_owner FROM create_planner_jobs WHERE id=${db.sqlValue(stale.id)}`)[0];
  assert.deepEqual(recoveredLease, { attempt_count: 1, lease_owner: null });
});

test("Mac worker preserves a safe Codex App Server blocker for chat readback", async () => {
  db.initDb();
  db.resetDemoData();
  const { enqueueCreatePlannerJob, processQueuedCreatePlannerJobs } = await import("../planner/createPlannerJobs.js");
  const job = enqueueCreatePlannerJob({
    messages: [{ role: "user", text: "App Serverの接続状態を確認" }],
    metadata: { transport: "codex_app_server", actorUserId: "user_local_owner", companyIds: ["project-a"] }
  });
  const failingClient = {
    startOrResumeThread: async () => {
      throw new Error("codex_app_server_turn_timeout secret=must-not-escape");
    }
  } as unknown as CodexAppServerClient;

  const processed = await processQueuedCreatePlannerJobs(1, { workerId: "worker-blocked", appServerClient: failingClient });
  assert.equal(processed[0]?.id, job.id);
  assert.equal(processed[0]?.status, "blocked");
  assert.equal(processed[0]?.exactBlocker, "codex_app_server_turn_timeout");
  assert.doesNotMatch(JSON.stringify(processed[0]), /must-not-escape/u);
});

function requestJson(method: string, path: string, payload: Record<string, unknown> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const body = method === "GET" ? "" : JSON.stringify(payload);
    const req = Readable.from(body ? [Buffer.from(body)] : []) as NodeJS.ReadableStream & { method?: string; url?: string; headers?: Record<string, string> };
    req.method = method;
    req.url = path;
    req.headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) };
    const chunks: Buffer[] = [];
    const res = {
      statusCode: 200,
      setHeader() { return this; },
      getHeader() { return undefined; },
      removeHeader() { return undefined; },
      end(chunk?: string | Buffer) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        resolve({ status: this.statusCode, body: Buffer.concat(chunks).toString("utf8") });
        return this;
      }
    };
    (app as unknown as { handle(req: unknown, res: unknown, next: (error?: unknown) => void): void }).handle(req, res, reject);
  });
}

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync } from "node:fs";
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

  const response = await requestJson("POST", "/api/create/chat", {
    project_id: "project-a",
    currentDraft: "token=secret-planner-input",
    messages: [{ role: "user", text: "システム全体を確認して token=secret-planner-message" }]
  });
  assert.equal(response.status, 202);
  const body = JSON.parse(response.body) as { ok: boolean; job: { id: string; status: string; metadata: Record<string, unknown> } };
  assert.equal(body.ok, true);
  assert.equal(body.job.status, "queued");
  assert.equal(body.job.metadata.transport, "codex_app_server");
  assert.equal(body.job.metadata.route, "mac_worker_codex_app_server");
  const readback = await requestJson("GET", `/api/create/plan/jobs/${encodeURIComponent(body.job.id)}`);
  const readbackBody = JSON.parse(readback.body) as { job: { metadata: Record<string, unknown> } };
  assert.equal(readback.status, 200);
  assert.equal(readbackBody.job.metadata.transport, "codex_app_server");
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
      events: []
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

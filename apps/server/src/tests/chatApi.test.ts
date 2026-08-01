import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

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

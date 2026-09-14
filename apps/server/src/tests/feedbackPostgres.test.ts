import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const postgresUrl = process.env.AUTOMATION_OS_TEST_POSTGRES_URL;
test("isolated PostgreSQL: feedback persistence, artifact integrity and production readback", {
  skip: postgresUrl ? false : "postgres_fixture_unavailable", timeout: 180_000
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aos-feedback-pg-"));
  process.env.AUTOMATION_OS_DATABASE_URL = postgresUrl;
  process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(root, "artifacts");
  process.env.AUTOMATION_OS_SECRET_DIR = join(root, "secrets");
  process.env.AUTOMATION_OS_PORTABLE_REMOTE_ARTIFACT_ROOT = join(root, "worker");
  process.env.AOS_WEB_OPERATION_BACKEND_CONFIG = join(root, "backend.json");
  process.env.AUTOMATION_OS_READ_LIVE_PROCESS_TABLE = "0";
  process.env.AUTOMATION_OS_OWNER_USER_ID = "feedback_pg_actor";
  process.env.NODE_TEST_CONTEXT = "1";
  const db = await import("../db/client.js");
  await db.initializePostgresSchemaAsync();
  const actor = process.env.AUTOMATION_OS_OWNER_USER_ID;
  const now = db.nowIso();
  await db.insertAsync("users", { id: actor, auth_provider: "service", auth_subject: actor, email: null,
    display_name: actor, kind: "service", status: "active", created_at: now, updated_at: now });
  for (const [id, role] of [["feedback_pg_a", "owner"], ["feedback_pg_b", "owner"], ["feedback_pg_viewer", "viewer"]]) {
    await db.insertAsync("companies", { id, slug: id, name: id, status: "active", created_at: now, updated_at: now });
    await db.insertAsync("company_memberships", { id: `${id}_member`, company_id: id, user_id: actor, role, status: "active", created_at: now, updated_at: now });
  }
  const { app } = await import("../index.js");
  const request = (method: string, url: string, payload: Record<string, unknown> = {}) => new Promise<{ status: number; body: any; bytes: Buffer }>((resolve, reject) => {
    const body = method === "GET" ? "" : JSON.stringify(payload);
    const req = Readable.from(body ? [Buffer.from(body)] : []) as any;
    req.method = method; req.url = url;
    req.headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) };
    const res = { statusCode: 200, setHeader() { return this; }, getHeader() { return undefined; }, removeHeader() { return undefined; },
      end(chunk?: string | Buffer) { const bytes = Buffer.from(chunk ?? "{}"); let value: any = null; try { value = JSON.parse(bytes.toString()); } catch {} resolve({ status: this.statusCode, body: value, bytes }); return this; } };
    (app as any).handle(req, res, reject);
  });
  await t.test("with and without screenshot save atomically, read back, triage and retain exact image bytes", async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    for (const screenshot of [null, `data:image/jpeg;base64,${jpeg.toString("base64")}`]) {
      const feedbackId = screenshot ? "feedback_ui_00000000-0000-4000-8000-000000000001" : "feedback_ui_00000000-0000-4000-8000-000000000002";
      const saved = await request("POST", "/api/mvp/feedback", { feedback_id: feedbackId, company_id: "feedback_pg_a", comment: screenshot ? "image" : "text",
        screenshot_data_url: screenshot, sensitive_content_confirmed: true });
      assert.equal(saved.status, 201, JSON.stringify(saved.body));
      assert.equal(saved.body.external_action_executed, false);
      assert.equal(saved.body.inbox_forward.status, "local");
      assert.equal(saved.body.state, undefined);
      assert.equal(saved.body.feedback.id, feedbackId);
      const exact = await request("GET", `/api/mvp/feedback?company_id=feedback_pg_a&feedback_id=${feedbackId}`);
      assert.equal(exact.body.count, 1);
      assert.equal(exact.body.feedbacks[0].id, feedbackId);
      assert.equal((await request("GET", `/api/mvp/feedback?company_id=feedback_pg_b&feedback_id=${feedbackId}`)).body.count, 0);
      assert.notEqual((await request("POST", "/api/mvp/feedback", { feedback_id: feedbackId, company_id: "feedback_pg_a", comment: "duplicate" })).status, 201);
      const read = await request("GET", "/api/mvp/feedback?company_id=feedback_pg_a");
      assert.equal(read.status, 200, JSON.stringify(read.body));
      const row = read.body.feedbacks.find((item: any) => item.id === saved.body.feedback.id);
      assert.equal(row.comment, screenshot ? "image" : "text");
      assert.equal(row.has_screenshot, Boolean(screenshot));
      assert.equal((await request("PATCH", `/api/mvp/feedback/${row.feedback_id}`, { status: "triaged" })).status, 200);
      assert.equal((await request("GET", "/api/mvp/feedback?company_id=feedback_pg_a")).body.feedbacks.find((item: any) => item.id === row.id).status, "triaged");
      if (screenshot) {
        const image = await request("GET", saved.body.feedback.screenshot.view_url);
        assert.equal(image.status, 200, image.bytes.toString());
        assert.deepEqual(image.bytes, jpeg);
        const foreign = await request("GET", `/api/v1/companies/feedback_pg_b/feedback-artifacts/${row.screenshot_artifact_id}`);
        assert.equal(foreign.status, 404);
        await db.execSqlAsync(`UPDATE feedback_artifacts SET checksum_sha256='invalid' WHERE id=${db.sqlValue(row.screenshot_artifact_id)}`);
        assert.equal((await request("GET", saved.body.feedback.screenshot.view_url)).status, 409);
      }
    }
    assert.equal((await request("GET", "/api/mvp/feedback?company_id=feedback_pg_b")).body.count, 0);
  });
  await t.test("invalid and foreign requests never persist feedback or start business work", async () => {
    const bad = await request("POST", "/api/mvp/feedback", { company_id: "feedback_pg_a", comment: "invalid", sensitive_content_confirmed: true,
      screenshot_data_url: "data:image/svg+xml;base64,PHN2Zy8+" });
    assert.equal(bad.status, 415);
    const foreign = await request("POST", "/api/mvp/feedback", { company_id: "not_member", comment: "foreign" });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.error, "company_scope_forbidden");
    assert.equal(Number((await db.querySqlAsync<any>("SELECT count(*) AS count FROM mvp_feedback"))[0].count), 2);
    assert.equal(Number((await db.querySqlAsync<any>("SELECT count(*) AS count FROM feedback_artifacts"))[0].count), 1);
    for (const table of ["runs", "approvals", "mvp_automation_schedules"]) assert.equal(Number((await db.querySqlAsync<any>(`SELECT count(*) AS count FROM ${table}`))[0].count), 0);
  });
  await t.test("production runtime readback reports Postgres but never infers business completion", async () => {
    const read = await request("GET", "/api/v1/companies/feedback_pg_a/production/readback");
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.persistence.adapter, "postgres");
    assert.equal(read.body.readiness.goal_complete, null);
    assert.equal(read.body.external_action_executed, false);
    assert.equal(read.body.deployment.assets.webDistDir, undefined);
    assert.equal((await request("GET", "/api/v1/companies/feedback_pg_viewer/production/readback")).status, 404);
  });
});

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const postgresUrl = process.env.AUTOMATION_OS_TEST_POSTGRES_URL;
test("isolated PostgreSQL: profile HTTP save and projections preserve company, revision and concurrent edits", {
  skip: postgresUrl ? false : "postgres_fixture_unavailable", timeout: 120_000
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aos-profile-pg-"));
  process.env.AUTOMATION_OS_DATABASE_URL = postgresUrl;
  process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(root, "artifacts");
  process.env.AUTOMATION_OS_SECRET_DIR = join(root, "secrets");
  process.env.AUTOMATION_OS_PORTABLE_REMOTE_ARTIFACT_ROOT = join(root, "worker");
  process.env.AOS_WEB_OPERATION_BACKEND_CONFIG = join(root, "backend.json");
  process.env.AUTOMATION_OS_READ_LIVE_PROCESS_TABLE = "0";
  process.env.AUTOMATION_OS_OWNER_USER_ID = "profile_fixture_actor";
  process.env.NODE_TEST_CONTEXT = "1";
  const db = await import("../db/client.js");
  await db.initializePostgresSchemaAsync();
  const actor = process.env.AUTOMATION_OS_OWNER_USER_ID;
  const now = db.nowIso();
  await db.insertAsync("users", { id: actor, auth_provider: "service", auth_subject: actor, email: null,
    display_name: actor, kind: "service", status: "active", created_at: now, updated_at: now });
  for (const [id, role] of [["profile_a", "owner"], ["profile_b", "owner"], ["profile_viewer", "viewer"]]) {
    await db.insertAsync("companies", { id, slug: id, name: "Profile fixture", status: "active", created_at: now, updated_at: now });
    await db.insertAsync("company_memberships", { id: `${id}_member`, company_id: id, user_id: actor, role, status: "active", created_at: now, updated_at: now });
  }
  const { app } = await import("../index.js");
  const { readPostgresMvpState } = await import("../runs/postgresMvpState.js");
  const request = (method: string, company: string, payload: Record<string, unknown> = {}) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const body = method === "GET" ? "" : JSON.stringify(payload);
    const req = Readable.from(body ? [Buffer.from(body)] : []) as any;
    req.method = method; req.url = `/api/v1/companies/${company}/presentation-profile`;
    req.headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) };
    const res = { statusCode: 200, setHeader() { return this; }, getHeader() { return undefined; }, removeHeader() { return undefined; },
      end(chunk?: string | Buffer) { resolve({ status: this.statusCode, body: JSON.parse(String(chunk ?? "{}")) }); return this; } };
    (app as any).handle(req, res, reject);
  });
  const profile = { label: "会社の実績", kind: "operations", purpose: "", browserUseLane: "", stopBoundary: "",
    primaryMetrics: ["Run"], widgets: ["kpi", "timeline"], preferredGrouping: "day", explanation: "保存確認用" };
  await t.test("default GET then full UI payload save agrees with GET and all profile projections", async () => {
    const initial = await request("GET", "profile_a");
    assert.equal(initial.status, 200, JSON.stringify(initial.body));
    assert.equal(initial.body.revision, 0);
    const saved = await request("PUT", "profile_a", { profile });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.revision, 1);
    assert.equal(saved.body.external_action_executed, false);
    const read = await request("GET", "profile_a");
    assert.deepEqual(read.body.profile, saved.body.profile);
    for (const projection of ["full", "ui", "summary"] as const) {
      const state = await readPostgresMvpState({ companyId: "profile_a", actorUserId: actor, projection, forceFresh: true });
      const row = (state.presentation_profiles as any[])[0];
      assert.equal(row.id, "profile_a");
      for (const [key, value] of Object.entries(saved.body.profile)) assert.deepEqual(row[key], value, `${projection}:${key}`);
    }
  });
  await t.test("concurrent creation and update each commit once and stale PUT never increments revision", async () => {
    const created = await Promise.all([request("PUT", "profile_b", { profile }), request("PUT", "profile_b", { profile })]);
    assert.deepEqual(created.map((r) => r.status).sort(), [200, 409], JSON.stringify(created));
    const edited = await Promise.all([request("PUT", "profile_a", { expected_revision: 1, profile: { label: "A" } }),
      request("PUT", "profile_a", { expected_revision: 1, profile: { label: "B" } })]);
    assert.deepEqual(edited.map((r) => r.status).sort(), [200, 409], JSON.stringify(edited));
    const saved = await request("GET", "profile_a");
    assert.equal(saved.body.revision, 2);
    assert.deepEqual(saved.body.profile.widgets, profile.widgets);
    assert.equal((await request("PUT", "profile_a", { expected_revision: 1, profile: { label: "stale" } })).status, 409);
    assert.deepEqual((await request("GET", "profile_a")).body, saved.body);
    const count = await db.querySqlAsync<any>("SELECT count(*) AS count FROM company_audit_events WHERE entity_type='company_memory'");
    assert.equal(Number(count[0].count), 3);
  });
  await t.test("invalid, foreign and viewer writes do not change a profile or create any work", async () => {
    assert.equal((await request("PUT", "profile_a", { expected_revision: 2, profile: { label: "" } })).status, 400);
    assert.equal((await request("PUT", "profile_viewer", { profile })).status, 404);
    assert.equal((await request("GET", "not_member")).status, 404);
    const other = await request("GET", "profile_viewer");
    assert.equal(other.body.revision, 0);
    assert.equal((await request("GET", "profile_a")).body.revision, 2);
    for (const table of ["runs", "approvals", "mvp_automation_schedules"]) {
      assert.equal(Number((await db.querySqlAsync<any>(`SELECT count(*) AS count FROM ${table}`))[0].count), 0);
    }
  });
});

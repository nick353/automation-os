import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-company-brief-api-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.NODE_TEST_CONTEXT = "1";
process.env.AUTOMATION_OS_OWNER_USER_ID = "brief-api-owner-a";

const { app } = await import("../index.js");
const db = await import("../db/client.js");
const contracts = await import("../automations/contracts.js");
const automations = await import("../automations/repository.js");

test("GET /api/v1/companies/:companyId/brief is scoped, deterministic, and read-only", async () => {
  db.initDb();
  seedMembership("brief-api-company-a", "brief-api-owner-a", "owner");
  seedMembership("brief-api-company-b", "brief-api-owner-b", "owner");
  createAutomation("brief-api-company-a", "brief-api-owner-a", "Brief company A");
  createAutomation("brief-api-company-b", "brief-api-owner-b", "Brief company B");
  const before = db.querySql<{ count: number }>("SELECT COUNT(*) AS count FROM mvp_automations")[0]?.count;

  const morning = await requestJson("GET", "/api/v1/companies/brief-api-company-a/brief?brief_type=morning&business_date=2026-09-02&timezone=Asia%2FTokyo");
  assert.equal(morning.status, 200, morning.raw);
  assert.equal(morning.json.brief_type, "morning");
  assert.equal(morning.json.company_scope.company_id, "brief-api-company-a");
  assert.equal(morning.json.companies.length, 1);
  assert.equal(morning.json.companies[0].company_id, "brief-api-company-a");
  assert.match(morning.raw, /Brief company A/u);
  assert.doesNotMatch(morning.raw, /Brief company B/u);
  assert.equal(morning.json.read_only, true);
  assert.equal(morning.json.external_action_executed, false);

  const evening = await requestJson("GET", "/api/v1/companies/brief-api-company-a/brief?brief_type=evening&business_date=2026-09-02");
  assert.equal(evening.status, 200, evening.raw);
  assert.equal(evening.json.brief_type, "evening");
  assert.notEqual(evening.json.output_fingerprint, morning.json.output_fingerprint);

  const forbidden = await requestJson("GET", "/api/v1/companies/brief-api-company-b/brief?brief_type=morning&business_date=2026-09-02");
  assert.equal(forbidden.status, 404, forbidden.raw);
  assert.equal(forbidden.json.error, "company_scope_forbidden");

  const invalid = await requestJson("GET", "/api/v1/companies/brief-api-company-a/brief?brief_type=morning");
  assert.equal(invalid.status, 400, invalid.raw);
  assert.equal(invalid.json.exact_blocker, "business_date_required");

  const after = db.querySql<{ count: number }>("SELECT COUNT(*) AS count FROM mvp_automations")[0]?.count;
  assert.equal(after, before);
});

function createAutomation(companyId: string, ownerId: string, name: string) {
  return automations.createAutomationRecord({
    companyId,
    actorUserId: ownerId,
    definition: contracts.parseAutomationCreate({
      automation_type: "brief-api-test",
      name,
      description: name,
      goal: "Generate a read-only brief",
      lane: "local",
      risk_level: "low",
      approval_policy: "required_before_external_action",
      worker_command_kind: "safe_local_demo",
      create_approval: true,
      builder_spec: {}
    })
  });
}

function seedMembership(companyId: string, userId: string, role: "owner") {
  const timestamp = db.nowIso();
  db.upsert("users", { id: userId, auth_provider: "test", auth_subject: userId, email: null, display_name: userId, kind: "human", status: "active", created_at: timestamp, updated_at: timestamp });
  db.upsert("companies", { id: companyId, slug: companyId, name: companyId, status: "active", created_at: timestamp, updated_at: timestamp });
  db.upsert("company_memberships", { id: `membership_${companyId}_${userId}`, company_id: companyId, user_id: userId, role, status: "active", created_at: timestamp, updated_at: timestamp });
}

function requestJson(method: string, path: string) {
  return new Promise<{ status: number; raw: string; json: any }>((resolve, reject) => {
    const req = Readable.from([]) as NodeJS.ReadableStream & { method?: string; url?: string; headers?: Record<string, string> };
    req.method = method;
    req.url = path;
    req.headers = { "content-type": "application/json", "content-length": "0" };
    const chunks: Buffer[] = [];
    const res = {
      statusCode: 200,
      setHeader() { return this; },
      getHeader() { return undefined; },
      removeHeader() { return undefined; },
      end(chunk?: string | Buffer) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status: this.statusCode, raw, json: JSON.parse(raw) });
        return this;
      }
    };
    (app as unknown as { handle(req: unknown, res: unknown, next: (error?: unknown) => void): void }).handle(req, res, reject);
  });
}

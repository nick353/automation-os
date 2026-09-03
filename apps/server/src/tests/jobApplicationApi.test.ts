import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "automation-os-job-api-"));
process.env.AUTOMATION_OS_DB = join(root, "automation-os.sqlite");
process.env.AUTOMATION_OS_SECRET_DIR = join(root, "secrets");
process.env.AUTOMATION_OS_OWNER_USER_ID = "job-api-owner";
process.env.NODE_TEST_CONTEXT = "1";

const { app } = await import("../index.js");
const db = await import("../db/client.js");
db.initDb();

const now = Date.now();
db.execSql(`
  INSERT INTO users (id, auth_provider, auth_subject, email, display_name, kind, status, created_at, updated_at)
  VALUES ('job-api-owner', 'test', 'job-api-owner', NULL, 'Job API owner', 'human', 'active', datetime('now'), datetime('now'));
  INSERT INTO companies (id, slug, name, status, created_at, updated_at)
  VALUES ('job-api-company', 'job-api-company', 'Job API company', 'active', datetime('now'), datetime('now'));
  INSERT INTO company_memberships (id, company_id, user_id, role, status, created_at, updated_at)
  VALUES ('job-api-membership', 'job-api-company', 'job-api-owner', 'owner', 'active', datetime('now'), datetime('now'));
`);

test("candidate supply API persists classification, digest, and redacted mirror without external effect", async () => {
  const body = {
    candidate_key: "api-candidate-1",
    source_snapshot_id: "api-snapshot-1",
    source_snapshot_expires_at: new Date(now + 86_400_000).toISOString(),
    supply_run_id: "run_supply_api_1",
    job_url: "https://jobs.example.test/api/1",
    company_name: "API Example AI",
    role: "AI Marketing Lead",
    language: "en",
    salary_original_min: 5_000_000,
    salary_original_max: 7_000_000,
    salary_currency: "JPY",
    salary_source_url: "https://jobs.example.test/api/1#salary",
    salary_source_time: new Date(now).toISOString(),
    work_location: "remote_from_japan",
    work_authorization: "japan_visa",
    remote_mode: "remote"
  };
  const created = await requestJson("POST", "/api/v1/companies/job-api-company/job-application-candidate-supply", body, { "idempotency-key": "job-api-candidate-1" });
  assert.equal(created.status, 201, created.raw);
  assert.equal(created.json.candidate.status, "eligible");
  assert.equal(created.json.sheet_mirror.blocker, "sheets_connector_unverified");
  assert.equal(created.json.external_action_executed, false);
  assert.doesNotMatch(created.raw, /password|cookie|otp|token|secret/iu);

  const candidate = created.json.candidate;
  const populationAudit = await requestJson("POST", "/api/v1/companies/job-api-company/job-application-sheet-mirror-population-audit", {
    schema: "aos.job_application_sheet_mirror_sync.v1",
    spreadsheet_id: "sheet_api_123",
    sheet_id: "1255319564",
    sheet_name: "AOS候補",
    range: "A1:T2",
    readback_at: new Date().toISOString(),
    rows: [{
      row_number: 2,
      values: [candidate.candidateKey, candidate.sourceSnapshotId, candidate.sourceSnapshotExpiresAt, candidate.companyName, candidate.role, candidate.jobUrl, candidate.applicationUrl, candidate.language, candidate.remoteMode, candidate.workLocation, candidate.workAuthorization, candidate.salaryJpy, candidate.salaryOriginalMin, candidate.salaryOriginalMax, candidate.salaryCurrency, candidate.salaryPeriod, candidate.salarySourceUrl, candidate.status, candidate.blocker, candidate.nextAction]
    }]
  });
  assert.equal(populationAudit.status, 200, populationAudit.raw);
  assert.equal(populationAudit.json.audit.population_exact, true);
  assert.equal(populationAudit.json.audit.source_count, 1);
  assert.equal(populationAudit.json.external_action_executed, false);

  const synced = await requestJson("POST", "/api/v1/companies/job-api-company/job-application-sheet-mirror-sync", {
    schema: "aos.job_application_sheet_mirror_sync.v1",
    spreadsheet_id: "sheet_api_123",
    sheet_id: "1255319564",
    sheet_name: "AOS候補",
    range: "A1:T2",
    readback_at: new Date().toISOString(),
    rows: [{
      row_number: 2,
      values: [candidate.candidateKey, candidate.sourceSnapshotId, candidate.sourceSnapshotExpiresAt, candidate.companyName, candidate.role, candidate.jobUrl, candidate.applicationUrl, candidate.language, candidate.remoteMode, candidate.workLocation, candidate.workAuthorization, candidate.salaryJpy, candidate.salaryOriginalMin, candidate.salaryOriginalMax, candidate.salaryCurrency, candidate.salaryPeriod, candidate.salarySourceUrl, candidate.status, candidate.blocker, candidate.nextAction]
    }]
  }, { "idempotency-key": "job-api-candidate-sheet-sync-1" });
  assert.equal(synced.status, 201, synced.raw);
  assert.equal(synced.json.rows_synced, 1);
  assert.equal(synced.json.sync_status, "synced");
  assert.equal(synced.json.external_action_executed, false);

  const syncedReplay = await requestJson("POST", "/api/v1/companies/job-api-company/job-application-sheet-mirror-sync", {
    schema: "aos.job_application_sheet_mirror_sync.v1",
    spreadsheet_id: "sheet_api_123",
    sheet_id: "1255319564",
    sheet_name: "AOS候補",
    range: "A1:T2",
    readback_at: synced.json.readback_at,
    rows: [{
      row_number: 2,
      values: [candidate.candidateKey, candidate.sourceSnapshotId, candidate.sourceSnapshotExpiresAt, candidate.companyName, candidate.role, candidate.jobUrl, candidate.applicationUrl, candidate.language, candidate.remoteMode, candidate.workLocation, candidate.workAuthorization, candidate.salaryJpy, candidate.salaryOriginalMin, candidate.salaryOriginalMax, candidate.salaryCurrency, candidate.salaryPeriod, candidate.salarySourceUrl, candidate.status, candidate.blocker, candidate.nextAction]
    }]
  }, { "idempotency-key": "job-api-candidate-sheet-sync-1" });
  assert.equal(syncedReplay.status, 200, syncedReplay.raw);
  assert.equal(syncedReplay.json.replayed, true);

  const replayed = await requestJson("POST", "/api/v1/companies/job-api-company/job-application-candidate-supply", body, { "idempotency-key": "job-api-candidate-1-replay" });
  assert.equal(replayed.status, 200, replayed.raw);
  assert.equal(replayed.json.replayed, true);

  const digest = await requestJson("GET", "/api/v1/companies/job-api-company/job-application-digest?period=evening");
  assert.equal(digest.status, 200, digest.raw);
  assert.equal(digest.json.period, "evening");
  assert.equal(digest.json.digest.target, 20);
  assert.equal(digest.json.digest.candidate_count, 1);
  assert.equal(digest.json.digest.eligible_candidate_count, 1);
  assert.equal(digest.json.digest.sheet_sync_failed_count, 0);
  assert.equal(digest.json.digest.blockers.sheets_connector_unverified, undefined);
  assert.equal(digest.json.digest.external_action_executed, false);
});

test("candidate supply API records salary evidence blockers instead of treating missing salary as zero success", async () => {
  const response = await requestJson("POST", "/api/v1/companies/job-api-company/job-application-candidate-supply", {
    candidate_key: "api-candidate-missing-salary",
    source_snapshot_id: "api-snapshot-2",
    source_snapshot_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    supply_run_id: "run_supply_api_2",
    job_url: "https://jobs.example.test/api/2",
    company_name: "API Missing Salary",
    role: "Growth Marketer",
    language: "ja",
    salary_original_min: null,
    salary_currency: "JPY",
    work_location: "japan",
    work_authorization: "japan_visa",
    remote_mode: "hybrid"
  }, { "idempotency-key": "job-api-candidate-missing-salary" });
  assert.equal(response.status, 201, response.raw);
  assert.equal(response.json.candidate.status, "blocked");
  assert.equal(response.json.exact_blocker, "salary_evidence_missing");
  const supply = await requestJson("GET", "/api/v1/companies/job-api-company/job-application-candidate-supply");
  assert.equal(supply.status, 200, supply.raw);
  assert.equal(supply.json.digest.salary_evidence_missing_count, 1);
  assert.equal(supply.json.external_action_executed, false);
});

async function requestJson(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; raw: string; json: any }> {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const req = Readable.from(payload ? [Buffer.from(payload, "utf8")] : []) as NodeJS.ReadableStream & { method?: string; url?: string; headers?: Record<string, string> };
  req.method = method;
  req.url = path;
  req.headers = { ...(payload ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}), ...headers };
  const chunks: Buffer[] = [];
  return await new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: new Map<string, string>(),
      setHeader(name: string, value: string) { this.headers.set(name.toLowerCase(), value); return this; },
      getHeader(name: string) { return this.headers.get(name.toLowerCase()); },
      removeHeader(name: string) { this.headers.delete(name.toLowerCase()); },
      status(code: number) { this.statusCode = code; return this; },
      end(chunk?: string | Buffer) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status: this.statusCode, raw, json: JSON.parse(raw) });
      }
    };
    (app as unknown as { handle(req: unknown, res: unknown, next: (error?: unknown) => void): void }).handle(req, res, reject);
  });
}

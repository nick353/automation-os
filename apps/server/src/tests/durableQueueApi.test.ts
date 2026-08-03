import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-durable-queue-api-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
// Keep this durable-queue contract test independent from a host-owned local
// worker state file. The production API may surface that file, but this test
// asserts the tenant queue projection in isolation.
process.env.AUTOMATION_OS_WORKER_STATE_PATH = join(tempRoot, "worker-state-does-not-exist.json");
process.env.NODE_TEST_CONTEXT = "1";
process.env.AUTOMATION_OS_OWNER_USER_ID = "api_bootstrap_owner";

const { app } = await import("../index.js");
const { execSql, initDb, querySql, sqlValue } = await import("../db/client.js");
const { claimNextDurableJob, completeDurableDryRun } = await import("../runs/durableQueue.js");

initDb();

test("dry-run enqueue returns a durable job receipt and requires an idempotency key", async () => {
  resetState();
  seedMembership("api_company_a", "api_owner_a", "owner");
  setActor("api_owner_a");
  const automation = await createV1("api_company_a", "Company A automation", "durable-api-create-a");

  const missingKey = await requestJson(
    "POST",
    `/api/v1/companies/api_company_a/automations/${automation.id}/dry-runs`,
    { payload: "missing key" }
  );
  assert.equal(missingKey.status, 400, missingKey.raw);
  assert.equal(missingKey.json.error, "idempotency_key_required");

  const first = await requestJson(
    "POST",
    `/api/v1/companies/api_company_a/automations/${automation.id}/dry-runs`,
    { payload: "alpha" },
    { "idempotency-key": "dry-run-a" }
  );
  assert.equal(first.status, 202, first.raw);
  assert.equal(first.json.ok, true);
  assert.equal(first.json.dry_run, true);
  assert.equal(first.json.queued, true);
  assert.equal(first.json.external_action_executed, false);
  assert.equal(first.json.receipt.action, "automation.dry_run.enqueued");
  assert.equal(first.json.job.status, "queued");
  assert.equal(first.json.job.kind, "dry_run");
  assert.equal(first.json.job.company_id, "api_company_a");
  assert.equal(first.json.run.id, first.json.job.run_id);
  assert.equal(first.json.run.status, "queued");

  const jobId = first.json.job.id as string;
  const runId = first.json.job.run_id as string;
  assert.equal(countRows("durable_jobs", `company_id=${sqlValue("api_company_a")}`), 1);
  assert.equal(countRows("runs", `id=${sqlValue(runId)}`), 1);
  assert.equal(countRows("run_artifacts", `run_id=${sqlValue(runId)}`), 0);
  assert.equal(countRows("proofs", `run_id=${sqlValue(runId)}`), 0);
  assert.equal(
    querySql<{ payload_json: string; kind: string; status: string }>(
      `SELECT payload_json, kind, status FROM durable_jobs WHERE company_id=${sqlValue("api_company_a")} AND id=${sqlValue(jobId)} LIMIT 1`
    )[0].kind,
    "dry_run"
  );
  assert.match(
    querySql<{ payload_json: string }>(
      `SELECT payload_json FROM durable_jobs WHERE company_id=${sqlValue("api_company_a")} AND id=${sqlValue(jobId)} LIMIT 1`
    )[0].payload_json,
    /"external_action_allowed":false/
  );

  const replay = await requestJson(
    "POST",
    `/api/v1/companies/api_company_a/automations/${automation.id}/dry-runs`,
    { payload: "alpha" },
    { "idempotency-key": "dry-run-a" }
  );
  assert.equal(replay.status, 202, replay.raw);
  assert.equal(replay.json.job.id, jobId);
  assert.equal(countRows("durable_jobs", `company_id=${sqlValue("api_company_a")}`), 1);
});

test("jobs endpoints stay tenant-scoped and cancel uses durable queue error mapping", async () => {
  resetState();
  seedMembership("api_company_a", "api_owner_a", "owner");
  seedMembership("api_company_b", "api_owner_b", "owner");

  setActor("api_owner_a");
  const automationA = await createV1("api_company_a", "Company A automation", "durable-api-create-a");
  const dryRunA = await requestJson(
    "POST",
    `/api/v1/companies/api_company_a/automations/${automationA.id}/dry-runs`,
    { payload: "alpha" },
    { "idempotency-key": "dry-run-a" }
  );
  assert.equal(dryRunA.status, 202, dryRunA.raw);

  setActor("api_owner_b");
  const automationB = await createV1("api_company_b", "Company B automation", "durable-api-create-b");
  const dryRunB = await requestJson(
    "POST",
    `/api/v1/companies/api_company_b/automations/${automationB.id}/dry-runs`,
    { payload: "beta" },
    { "idempotency-key": "dry-run-b" }
  );
  assert.equal(dryRunB.status, 202, dryRunB.raw);

  setActor("api_owner_a");
  const listA = await requestJson("GET", "/api/v1/companies/api_company_a/jobs");
  assert.equal(listA.status, 200, listA.raw);
  assert.equal(listA.json.jobs.length, 1);
  assert.equal(listA.json.jobs[0].company_id, "api_company_a");
  assert.equal(listA.json.jobs[0].status, "queued");

  const readA = await requestJson("GET", `/api/v1/companies/api_company_a/jobs/${dryRunA.json.job.id}`);
  assert.equal(readA.status, 200, readA.raw);
  assert.equal(readA.json.job.id, dryRunA.json.job.id);
  assert.equal(readA.json.job.run_id, dryRunA.json.job.run_id);

  const foreignList = await requestJson("GET", "/api/v1/companies/api_company_b/jobs");
  assert.equal(foreignList.status, 404, foreignList.raw);
  assert.equal(foreignList.json.error, "company_not_found");

  const foreignRead = await requestJson("GET", `/api/v1/companies/api_company_b/jobs/${dryRunB.json.job.id}`);
  assert.equal(foreignRead.status, 404, foreignRead.raw);
  assert.equal(foreignRead.json.error, "durable_job_not_found");

  const cancelA = await requestJson("POST", `/api/v1/companies/api_company_a/jobs/${dryRunA.json.job.id}/cancel`);
  assert.equal(cancelA.status, 200, cancelA.raw);
  assert.equal(cancelA.json.job.status, "cancelled");
  assert.equal(cancelA.json.receipt.action, "durable_job.cancelled");

  const cancelAgain = await requestJson("POST", `/api/v1/companies/api_company_a/jobs/${dryRunA.json.job.id}/cancel`);
  assert.equal(cancelAgain.status, 409, cancelAgain.raw);
  assert.equal(cancelAgain.json.error, "durable_job_terminal");

  const postCancelRead = await requestJson("GET", `/api/v1/companies/api_company_a/jobs/${dryRunA.json.job.id}`);
  assert.equal(postCancelRead.status, 200, postCancelRead.raw);
  assert.equal(postCancelRead.json.job.status, "cancelled");
});

test("retry, artifact view, bound approval, and state readback use durable tenant data", async () => {
  resetState();
  seedMembership("api_company_wave3", "api_owner_wave3", "owner");
  seedServiceMembership("api_company_wave3", "api_service_wave3");
  setActor("api_owner_wave3");
  const automation = await createV1("api_company_wave3", "Wave3 automation", "wave3-create");
  const dryRun = await requestJson("POST", `/api/v1/companies/api_company_wave3/automations/${automation.id}/dry-runs`, {}, { "idempotency-key": "wave3-dry-run" });
  assert.equal(dryRun.status, 202, dryRun.raw);
  const claim = claimNextDurableJob({ companyId: "api_company_wave3", serviceUserId: "api_service_wave3", now: "2099-01-01T00:00:00.000Z", leaseMs: 60_000 });
  assert.ok(claim);
  const completed = completeDurableDryRun({ companyId: "api_company_wave3", jobId: claim.id, serviceUserId: "api_service_wave3", fencingToken: claim.fencingToken, result: { outcome: "ok" }, now: "2099-01-01T00:00:01.000Z" });
  const artifact = await request("GET", `/api/v1/companies/api_company_wave3/artifacts/${completed.artifactId}`);
  assert.equal(artifact.status, 200, artifact.body);
  assert.equal(JSON.parse(artifact.body).external_action_executed, false);
  assert.match(String(artifact.headers["x-artifact-sha256"]), /^[a-f0-9]{64}$/);
  assert.doesNotMatch(artifact.body, /\/Users\/|file:\/\//);

  const retryCandidate = await requestJson("POST", `/api/v1/companies/api_company_wave3/automations/${automation.id}/dry-runs`, {}, { "idempotency-key": "wave3-retry-candidate" });
  const retryJobId = retryCandidate.json.job.id as string;
  execSql(`UPDATE durable_jobs SET status='failed', last_error='test_failure' WHERE id=${sqlValue(retryJobId)}; UPDATE runs SET status='failed' WHERE id=${sqlValue(retryCandidate.json.job.run_id)};`);
  const missingRetryKey = await requestJson("POST", `/api/v1/companies/api_company_wave3/jobs/${retryJobId}/retry`);
  assert.equal(missingRetryKey.status, 400, missingRetryKey.raw);
  const retried = await requestJson("POST", `/api/v1/companies/api_company_wave3/jobs/${retryJobId}/retry`, {}, { "idempotency-key": "wave3-manual-retry" });
  assert.equal(retried.status, 200, retried.raw);
  assert.equal(retried.json.job.status, "queued");
  assert.equal(retried.json.job.automation_version_id, automation.current_version_id);

  const approvalCreate = await requestJson("POST", "/api/v1/companies/api_company_wave3/approvals", {
    job_id: retryJobId,
    title: "Publish exact payload",
    action_kind: "publish.post",
    payload_hash: "d".repeat(64),
    policy_version: "policy-v1",
    expires_at: "2099-12-31T00:00:00.000Z"
  });
  assert.equal(approvalCreate.status, 201, approvalCreate.raw);
  assert.equal(approvalCreate.json.approval.status, "pending");
  const approvalDecision = await requestJson("PATCH", `/api/v1/companies/api_company_wave3/approvals/${approvalCreate.json.approval.id}`, { decision: "approved" }, { "if-match": "1" });
  assert.equal(approvalDecision.status, 200, approvalDecision.raw);
  assert.equal(approvalDecision.json.approval.status, "approved");
  assert.equal(approvalDecision.json.approval.decision_revision, 2);

  const state = await requestJson("GET", "/api/mvp/state?company_id=api_company_wave3");
  assert.equal(state.status, 200, state.raw);
  assert.equal(state.json.jobs.length, 2);
  assert.ok(Array.isArray(state.json.job_attempts));
  assert.equal(state.json.worker.exact_blocker, null);
  assert.equal(state.json.worker.queue_depth, 1);
});

function resetState(): void {
  initDb();
  execSql(`
    DELETE FROM run_artifacts;
    DELETE FROM durable_job_attempts;
    DELETE FROM durable_jobs;
    DELETE FROM durable_schedule_occurrences;
    DELETE FROM durable_concurrency_slots;
    DELETE FROM mvp_idempotency_keys;
    DELETE FROM worker_events;
    DELETE FROM proofs;
    DELETE FROM approvals;
    DELETE FROM run_steps;
    DELETE FROM runs;
    DELETE FROM mvp_automation_schedules;
    DELETE FROM mvp_automation_versions;
    DELETE FROM mvp_automations;
    DELETE FROM company_audit_events;
    DELETE FROM company_memberships;
    DELETE FROM users;
    DELETE FROM companies;
  `);
}

function seedServiceMembership(companyId: string, userId: string): void {
  const timestamp = new Date().toISOString();
  execSql(`
    INSERT INTO users (id, auth_provider, auth_subject, email, display_name, kind, status, created_at, updated_at)
    VALUES (${sqlValue(userId)}, 'service', ${sqlValue(userId)}, NULL, ${sqlValue(userId)}, 'service', 'active', ${sqlValue(timestamp)}, ${sqlValue(timestamp)});
    INSERT INTO company_memberships (id, company_id, user_id, role, status, created_at, updated_at)
    VALUES (${sqlValue(`membership_${companyId}_${userId}`)}, ${sqlValue(companyId)}, ${sqlValue(userId)}, 'operator', 'active', ${sqlValue(timestamp)}, ${sqlValue(timestamp)});
  `);
}

function seedMembership(companyId: string, userId: string, role: "owner" | "admin" | "operator" | "viewer"): void {
  const timestamp = new Date().toISOString();
  execSql(`
    INSERT OR IGNORE INTO users (
      id, auth_provider, auth_subject, email, display_name, kind, status, created_at, updated_at
    ) VALUES (
      ${sqlValue(userId)}, 'test', ${sqlValue(userId)}, NULL, ${sqlValue(userId)}, 'human', 'active', ${sqlValue(timestamp)}, ${sqlValue(timestamp)}
    );
    INSERT OR IGNORE INTO companies (id, slug, name, status, created_at, updated_at)
    VALUES (${sqlValue(companyId)}, ${sqlValue(companyId)}, ${sqlValue(companyId)}, 'active', ${sqlValue(timestamp)}, ${sqlValue(timestamp)});
    INSERT OR IGNORE INTO company_memberships (id, company_id, user_id, role, status, created_at, updated_at)
    VALUES (
      ${sqlValue(`membership_${companyId}_${userId}`)}, ${sqlValue(companyId)}, ${sqlValue(userId)}, ${sqlValue(role)},
      'active', ${sqlValue(timestamp)}, ${sqlValue(timestamp)}
    );
  `);
}

function setActor(actorId: string): void {
  process.env.AUTOMATION_OS_OWNER_USER_ID = actorId;
}

function automationBody(name: string) {
  return {
    automation_type: "scheduled",
    name,
    description: `${name} description`,
    goal: `${name} goal`,
    lane: "local",
    risk_level: "high",
    approval_policy: "required_before_external_action",
    worker_command_kind: "safe_local_demo",
    create_approval: true,
    builder_spec: { source: "api-test" }
  };
}

async function createV1(companyId: string, name: string, idempotencyKey: string): Promise<any> {
  const response = await requestJson(
    "POST",
    `/api/v1/companies/${encodeURIComponent(companyId)}/automations`,
    automationBody(name),
    { "idempotency-key": idempotencyKey }
  );
  assert.equal(response.status, 201, response.raw);
  return response.json.automation;
}

function countRows(table: string, predicate: string): number {
  return Number(querySql<{ count: number }>(`SELECT count(*) AS count FROM ${table} WHERE ${predicate}`)[0].count);
}

async function requestJson(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<{ status: number; raw: string; json: any }> {
  const response = await request(method, path, body, extraHeaders);
  return { status: response.status, raw: response.body, json: JSON.parse(response.body) };
}

function request(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = Readable.from(payload ? [payload] : []) as NodeJS.ReadableStream & {
      method?: string;
      url?: string;
      headers?: Record<string, string>;
    };
    req.method = method;
    req.url = path;
    req.headers = {
      ...(payload ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}),
      ...extraHeaders
    };
    const chunks: Buffer[] = [];
    const headers = new Map<string, unknown>();
    const res = {
      statusCode: 200,
      setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); return this; },
      getHeader(name: string) { return headers.get(name.toLowerCase()); },
      removeHeader(name: string) { headers.delete(name.toLowerCase()); },
      end(chunk?: string | Buffer) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        resolve({ status: this.statusCode, body: Buffer.concat(chunks).toString("utf8"), headers: Object.fromEntries(headers) });
        return this;
      }
    };
    (app as unknown as { handle(req: unknown, res: unknown, next: (error?: unknown) => void): void }).handle(req, res, reject);
  });
}

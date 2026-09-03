import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-approval-rejection-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(tempRoot, "artifacts");
process.env.NODE_TEST_CONTEXT = "1";
process.env.AUTOMATION_OS_OWNER_USER_ID = "approval_rejection_owner";

const { app } = await import("../index.js");
const { execSql, nowIso, querySql, sqlValue } = await import("../db/client.js");
const { runWorkerCycle } = await import("../runs/workerEngine.js");

test("rejecting a stored approval blocks its waiting run before any external effect", async () => {
  const company = JSON.parse((await request("POST", "/api/companies", { name: "Approval rejection test" }, { "idempotency-key": "approval-rejection-company" })).body).company as { id: string };
  const now = nowIso();
  const runId = "run_approval_rejection_waiting";
  execSql(`
    INSERT INTO runs (id, company_id, name, objective, status, execution_source, metadata_json, created_at, updated_at)
    VALUES (${sqlValue(runId)}, ${sqlValue(company.id)}, 'approval rejection', 'approval rejection', 'waiting_approval', 'automation-os', ${sqlValue({ external_action_executed: false })}, ${sqlValue(now)}, ${sqlValue(now)});
  `);

  const created = await request("POST", "/api/mvp/approvals", {
    company_id: company.id,
    run_id: runId,
    title: "Reject this external effect"
  });
  assert.equal(created.status, 201, created.body);
  const approval = JSON.parse(created.body).approval as { id: string };

  const rejected = await request("PATCH", `/api/mvp/approvals/${approval.id}`, {
    decision: "reject",
    note: "E2E safety stop"
  });
  assert.equal(rejected.status, 200, rejected.body);
  const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  assert.equal(run.status, "blocked");
  assert.match(run.metadata_json, /approval_rejected/);
  assert.match(run.metadata_json, /external_action_executed/);
  assert.deepEqual(querySql<{ status: string }>(`SELECT status FROM approvals WHERE id=${sqlValue(approval.id)} LIMIT 1`)[0], { status: "rejected" });
  assert.equal(querySql<{ count: number }>(`SELECT count(*) AS count FROM worker_events WHERE run_id=${sqlValue(runId)} AND event_type='run_blocked'`)[0].count, 1);
});

test("official worker reconciliation blocks rejected approval steps and lanes", async () => {
  const company = querySql<{ id: string }>("SELECT id FROM companies ORDER BY created_at DESC LIMIT 1")[0];
  const runId = "run_worker_approval_rejection_waiting";
  const stepId = `${runId}_step_1`;
  const laneId = `${runId}_lane_1`;
  const approvalId = `${runId}_approval`;
  const now = nowIso();
  execSql(`
    INSERT INTO runs (id, company_id, name, objective, status, execution_source, quarantined, metadata_json, created_at, updated_at)
    VALUES (${sqlValue(runId)}, ${sqlValue(company.id)}, 'worker approval rejection', 'worker approval rejection', 'waiting_approval', 'automation-os', 0, ${sqlValue({ external_action_executed: false })}, ${sqlValue(now)}, ${sqlValue(now)});
    INSERT INTO lanes (id, run_id, role, cdp_port, profile_dir, workdir, status, current_task, progress, health, resource_locks_json, updated_at)
    VALUES (${sqlValue(laneId)}, ${sqlValue(runId)}, 'Local Worker', 0, '/tmp/approval-rejection-profile', '/tmp/approval-rejection-workdir', 'active', 'waiting', 0, 'good', '[]', ${sqlValue(now)});
    INSERT INTO run_steps (id, run_id, company_id, name, status, lane_id, started_at, completed_at, metadata_json)
    VALUES (${sqlValue(stepId)}, ${sqlValue(runId)}, ${sqlValue(company.id)}, 'worker approval rejection', 'waiting_approval', ${sqlValue(laneId)}, NULL, NULL, ${sqlValue({ requires_approval: true })});
    INSERT INTO approvals (id, company_id, run_id, step_id, title, requested_by, status, priority, approval_group_id, resource_locks_json, created_at, decided_at, decision_note)
    VALUES (${sqlValue(approvalId)}, ${sqlValue(company.id)}, ${sqlValue(runId)}, ${sqlValue(stepId)}, 'Rejected worker approval', 'test', 'rejected', 'high', ${sqlValue(`${runId}_group`)}, '[]', ${sqlValue(now)}, ${sqlValue(now)}, 'rejected');
  `);

  await runWorkerCycle(runId);

  assert.equal(querySql<{ status: string }>(`SELECT status FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0].status, "blocked");
  assert.equal(querySql<{ status: string }>(`SELECT status FROM run_steps WHERE id=${sqlValue(stepId)} LIMIT 1`)[0].status, "blocked");
  assert.equal(querySql<{ status: string; health: string }>(`SELECT status, health FROM lanes WHERE id=${sqlValue(laneId)} LIMIT 1`)[0].status, "blocked");
  assert.equal(querySql<{ health: string }>(`SELECT status, health FROM lanes WHERE id=${sqlValue(laneId)} LIMIT 1`)[0].health, "blocked");
  assert.equal(querySql<{ count: number }>(`SELECT count(*) AS count FROM worker_events WHERE run_id=${sqlValue(runId)} AND event_type='run_blocked'`)[0].count, 1);
});

function request(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = Readable.from(payload ? [Buffer.from(payload)] : []) as NodeJS.ReadableStream & {
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
        resolve({ status: this.statusCode, body: Buffer.concat(chunks).toString("utf8") });
        return this;
      }
    };
    (app as unknown as { handle(req: unknown, res: unknown, next: (error?: unknown) => void): void }).handle(req, res, reject);
  });
}

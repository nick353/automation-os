import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "aos-run-detail-projection-"));
process.env.AUTOMATION_OS_DB = join(root, "automation-os.sqlite");
process.env.AUTOMATION_OS_OWNER_USER_ID = "run_detail_projection_owner";
process.env.NODE_TEST_CONTEXT = "1";

const { app } = await import("../index.js");
const db = await import("../db/client.js");
const { portableBusinessTargetDigest } = await import("../runs/portableExternalApprovalBinding.js");

function request(method: string, path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = Readable.from([]) as NodeJS.ReadableStream & { method?: string; url?: string; headers?: Record<string, string> };
    req.method = method;
    req.url = path;
    req.headers = { "content-length": "0" };
    const res = {
      statusCode: 200,
      setHeader() { return this; },
      getHeader() { return undefined; },
      removeHeader() { return undefined; },
      end(chunk?: string | Buffer) {
        resolve({ status: this.statusCode, body: JSON.parse(String(chunk ?? "{}")) });
        return this;
      }
    };
    (app as unknown as { handle(req: unknown, res: unknown, next: (error?: unknown) => void): void }).handle(req, res, reject);
  });
}

function seedRun(): { companyId: string; runId: string; approvalId: string } {
  db.initDb();
  db.resetDemoData();
  const now = db.nowIso();
  const companyId = "run_detail_projection_company";
  const runId = "run_detail_projection_1";
  const approvalId = "approval_detail_projection_1";
  db.upsert("users", { id: "run_detail_projection_owner", auth_provider: "test", auth_subject: "run_detail_projection_owner",
    email: null, display_name: "Run detail owner", kind: "human", status: "active", created_at: now, updated_at: now });
  db.upsert("companies", { id: companyId, slug: companyId, name: "Run detail projection", status: "active", created_at: now, updated_at: now });
  db.upsert("company_memberships", { id: "run_detail_projection_membership", company_id: companyId,
    user_id: "run_detail_projection_owner", role: "owner", status: "active", created_at: now, updated_at: now });
  const input = { account_ref: "github:nick353/daily-workspace-backup", target_key: "daily-workspace-backup:main",
    payload_hash: "a".repeat(64), source_snapshot_id: "b".repeat(64) };
  const operation = "snapshot_and_private_git_push";
  const createdAt = "2026-09-11T01:00:00.000Z";
  const bundle = { schema: "automation_os_portable_workflow_input_bundle.v1", workflow_id: "daily-backup-safety-check",
    run_id: runId, input, created_at: createdAt };
  const bundleSha = createHash("sha256").update(`${JSON.stringify(bundle, null, 2)}\n`).digest("hex");
  const targetDigest = portableBusinessTargetDigest(input);
  const metadata = {
    approval_id: approvalId,
    effect_stage: "business_execute",
    portable_workflow_invocation: { workflow_id: "daily-backup-safety-check", effect_stage: "business_execute", operation },
    portable_input_bundle: { ...bundle, sha256: bundleSha },
    portable_target_bound_approval_binding: { schema: "aos.portable_external_approval_binding.v1", company_id: companyId,
      workflow_id: "daily-backup-safety-check", run_id: runId, input_bundle_sha256: bundleSha, target_digest: targetDigest,
      target: { account_ref: input.account_ref, target_key: input.target_key, source_snapshot_id: input.source_snapshot_id } },
    source_snapshot: { source_snapshot_id: input.source_snapshot_id, vault_path: "/Users/test/private-vault", repository: "https://example.invalid/private.git", branch: "main" },
    remote_worker_receipt: { run_id: runId, company_id: companyId, adapter_result: { operation, remote_verified: true } }
  };
  db.insert("runs", { id: runId, company_id: companyId, automation_id: "automation_detail_projection",
    automation_version_id: "automation_detail_projection_v1", name: "Run detail projection", status: "complete",
    objective: "same-run detail", created_at: now, updated_at: now, metadata_json: metadata,
    execution_source: "automation-os", quarantined: 0 });
  db.insert("approvals", { id: approvalId, company_id: companyId, run_id: runId, title: "Backup approval",
    requested_by: "run_detail_projection_owner", status: "approved", priority: "normal", approval_group_id: "detail-group",
    resource_locks_json: [], created_at: now, action_kind: "external", payload_hash: input.payload_hash });
  return { companyId, runId, approvalId };
}

test("authenticated company Run detail joins exact same-run approval and receipt into the UI projection", async () => {
  const { companyId, runId, approvalId } = seedRun();
  const response = await request("GET", `/api/v1/companies/${companyId}/runs/${runId}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const projection = response.body.run.portable_operation_projection;
  assert.equal(projection.same_run, true);
  assert.equal(projection.run_id, runId);
  assert.equal(projection.company_id, companyId);
  assert.equal(projection.approval_id, approvalId);
  assert.equal(projection.observed_results.status, "observed");
  assert.equal(projection.observed_results.operation, "snapshot_and_private_git_push");
  assert.equal(projection.planned_operation_scope.status, "planned");
  assert.equal(projection.planned_operation_scope.vault_path, "[redacted-path]");
  assert.equal(projection.planned_operation_scope.repository, "[redacted-url]");
  assert.doesNotMatch(JSON.stringify(response.body), /\/Users\/test\/private-vault|https:\/\/example\.invalid\/private\.git/u);
  assert.equal(projection.same_run, true);
  assert.equal(projection.run_id, runId);
  assert.equal(projection.company_id, companyId);
});

test("Run detail preserves missing operation scope and rejects a foreign company", async () => {
  const { companyId, runId } = seedRun();
  const raw = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(runId)} LIMIT 1`)[0];
  const metadata = JSON.parse(raw.metadata_json);
  delete metadata.portable_workflow_invocation.operation;
  db.execSql(`UPDATE runs SET metadata_json=${db.sqlValue(metadata)} WHERE id=${db.sqlValue(runId)}`);
  const response = await request("GET", `/api/v1/companies/${companyId}/runs/${runId}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.run.portable_operation_projection.same_run, true);
  assert.equal(response.body.run.portable_operation_projection.planned_operation_scope.status, "missing");
  assert.equal(response.body.run.portable_operation_projection.planned_operation_scope.operation, null);
  assert.equal((await request("GET", `/api/v1/companies/foreign-company/runs/${runId}`)).status, 404);
});

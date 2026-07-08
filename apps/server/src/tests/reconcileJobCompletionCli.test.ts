import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-job-reconcile-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
delete process.env.AUTOMATION_OS_DATABASE_URL;
delete process.env.DATABASE_URL;

const db = await import("../db/client.js");

test("job reconciliation CLI --commit records a new readback run without changing the blocked source run", () => {
  db.initDb();
  db.resetDemoData();
  const runDir = join(tempRoot, "job-run");
  const outDir = join(tempRoot, "reconciliation");
  mkdirSync(runDir, { recursive: true });
  writeJson(join(runDir, "submitted-count-by-bucket-summary.json"), {
    ok: true,
    run_id: "codex-app-job-application-manager-test",
    submitted_count_by_bucket: { japan_targeted: 21, overseas_global: 20 }
  });
  writeJson(join(runDir, "user-action-normalization-receipt.json"), {
    ok: true,
    final_user_action_count: 14,
    resolved_non_user_action_count: 36
  });
  writeJson(join(runDir, "completion-audit-after-user-action-normalization.json"), {
    ok: true,
    failed_checks: []
  });
  writeJson(join(runDir, "completion-audit-full-target-readback-now.json"), { ok: false });
  writeJson(join(runDir, "completion-audit-after-normalized-proof.json"), { ok: false });

  const now = db.nowIso();
  db.insert("runs", {
    id: "run_mqu3doqb_9n1c6a",
    name: "Job Application Manager registered workflow billing-only inbox readback",
    status: "blocked",
    objective: "historical blocked Job run",
    created_at: now,
    updated_at: now,
    metadata_json: {
      registeredWorkflowId: "job-application-manager",
      registered_workflow_id: "job-application-manager",
      proof_gate: { ok: false, missing: ["job_submit_registered_codex_execution"], present: [] }
    }
  });

  const output = execFileSync(
    process.execPath,
    ["apps/server/dist/cli/reconcileJobCompletion.js", `--run-dir=${runDir}`, `--out-dir=${outDir}`, "--commit"],
    {
      cwd: process.cwd(),
      env: { ...process.env, AUTOMATION_OS_DB: process.env.AUTOMATION_OS_DB ?? "" },
      encoding: "utf8"
    }
  );
  const body = JSON.parse(output) as { ok: boolean; committedRun: { runId: string; proofId: string } | null; receiptPath: string };
  assert.equal(body.ok, true);
  assert.ok(body.committedRun?.runId);
  assert.ok(body.committedRun?.proofId);
  const receipt = JSON.parse(readFileSync(body.receiptPath, "utf8")) as {
    automation_os_db_mutated: boolean;
    strict_registered_success_claimed: boolean;
  };
  assert.equal(receipt.automation_os_db_mutated, true);
  assert.equal(receipt.strict_registered_success_claimed, false);

  const sourceRun = db.querySql<{ status: string }>("SELECT status FROM runs WHERE id='run_mqu3doqb_9n1c6a'")[0];
  assert.equal(sourceRun.status, "blocked");
  const newRun = db.querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id='${body.committedRun.runId}'`)[0];
  assert.equal(newRun.status, "complete");
  const newRunMetadata = JSON.parse(newRun.metadata_json) as {
    reconciliation_of_run_id: string;
    additional_applications_submitted: boolean;
    strict_registered_success_claimed: boolean;
    proof_gate: { ok: boolean; present: string[] };
  };
  assert.equal(newRunMetadata.reconciliation_of_run_id, "run_mqu3doqb_9n1c6a");
  assert.equal(newRunMetadata.additional_applications_submitted, false);
  assert.equal(newRunMetadata.strict_registered_success_claimed, false);
  assert.equal(newRunMetadata.proof_gate.ok, true);
  assert.deepEqual(newRunMetadata.proof_gate.present, ["job_completion_reconciliation_readback"]);
  const proof = db.querySql<{ proof_type: string; uri: string }>(`SELECT proof_type, uri FROM proofs WHERE id='${body.committedRun.proofId}'`)[0];
  assert.equal(proof.proof_type, "job_completion_reconciliation_readback");
  assert.match(proof.uri, /job-completion-reconciliation-receipt\.json$/);
  const event = db.querySql<{ event_type: string }>(`SELECT event_type FROM worker_events WHERE run_id='${body.committedRun.runId}'`)[0];
  assert.equal(event.event_type, "worker_completed");
});

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-portable-external-approval-"));
const previous = {
  db: process.env.AUTOMATION_OS_DB,
  artifacts: process.env.AUTOMATION_OS_ARTIFACT_ROOT,
  mode: process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE,
  runner: process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER
};
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(tempRoot, "artifacts");
process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "external";
process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER = process.execPath;

const db = await import("../db/client.js");
const { initRegisteredWorkflows } = await import("../registeredWorkflows.js");
const { startPortableWorkflowRun } = await import("../runs/portableWorkflowEntrypoint.js");
const { runWorkerOnce } = await import("../runs/workerEngine.js");

test("portable external runs create an approval gate before invoking the adapter", async () => {
  db.initDb();
  initRegisteredWorkflows();
  const started = await startPortableWorkflowRun({
    workflowId: "job-application-manager",
    sourceTrigger: "automation_os_scheduler",
    idempotencyKey: "portable-external-approval-gate-test"
  });

  const processed = await runWorkerOnce(started.runId);
  assert.equal(processed.length, 1);
  const run = db.querySql<{ status: string; metadata_json: string }>(
    `SELECT status, metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`
  )[0];
  const approval = db.querySql<{ status: string }>(
    `SELECT status FROM approvals WHERE run_id=${db.sqlValue(started.runId)} ORDER BY created_at ASC LIMIT 1`
  )[0];
  const step = db.querySql<{ status: string; metadata_json: string }>(
    `SELECT status, metadata_json FROM run_steps WHERE run_id=${db.sqlValue(started.runId)} ORDER BY id ASC LIMIT 1`
  )[0];
  const stepMetadata = JSON.parse(step.metadata_json) as Record<string, unknown>;

  assert.equal(run.status, "waiting_approval");
  assert.equal(approval?.status, "pending");
  assert.equal(step.status, "waiting_approval");
  assert.equal(stepMetadata.requires_approval, true);
  assert.equal(stepMetadata.approval_required_reason, "portable_external_effect_policy_approval_required");
  assert.equal(stepMetadata.exact_blocker, "portable_external_approval_required");
  assert.equal(stepMetadata.external_action_executed, false);
});

test.after(() => {
  if (previous.db === undefined) delete process.env.AUTOMATION_OS_DB;
  else process.env.AUTOMATION_OS_DB = previous.db;
  if (previous.artifacts === undefined) delete process.env.AUTOMATION_OS_ARTIFACT_ROOT;
  else process.env.AUTOMATION_OS_ARTIFACT_ROOT = previous.artifacts;
  if (previous.mode === undefined) delete process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE;
  else process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = previous.mode;
  if (previous.runner === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
  else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER = previous.runner;
});

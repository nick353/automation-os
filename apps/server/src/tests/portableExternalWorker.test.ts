import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  runPortableExternalWorker,
  PORTABLE_EXTERNAL_ADAPTER_NOT_CONFIGURED,
  PORTABLE_EXTERNAL_APPROVAL_REQUIRED
} from "../runs/portableExternalWorker.js";

test("portable external worker fails closed when the Mac adapter is not configured", async () => {
  const previous = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
  delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
  try {
    const result = await runPortableExternalWorker({
      workflowId: "job-application-manager",
      runId: "run_external_worker_test",
      stepId: "run_external_worker_test_step_1",
      sourceTrigger: "codex_app_bridge",
      idempotencyKey: "external-worker-test",
      approvalGranted: true
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.exactBlocker, PORTABLE_EXTERNAL_ADAPTER_NOT_CONFIGURED);
    assert.equal(result.externalActionExecuted, false);
  } finally {
    if (previous === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER = previous;
  }
});

test("portable external worker requires approval before spawning the adapter", async () => {
  const previousRunner = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
  const previousEffects = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS;
  const root = mkdtempSync(join(tmpdir(), "automation-os-external-approval-"));
  const marker = join(root, "spawned.marker");
  const runner = join(root, "runner.mjs");
  writeFileSync(runner, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "spawned");\nconsole.log(JSON.stringify({status:"complete",exact_blocker:null,external_action_executed:true}));\n`);
  chmodSync(runner, 0o700);
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER = runner;
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS = "enabled";
  try {
    const blocked = await runPortableExternalWorker({
      workflowId: "job-application-manager",
      runId: "run_external_worker_approval_required",
      stepId: "run_external_worker_approval_required_step_1",
      sourceTrigger: "automation_os_scheduler",
      idempotencyKey: "external-worker-approval-required",
      approvalGranted: false
    });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.exactBlocker, PORTABLE_EXTERNAL_APPROVAL_REQUIRED);
    assert.equal(blocked.externalActionExecuted, false);
    assert.throws(() => readFileSync(marker, "utf8"));

    const approved = await runPortableExternalWorker({
      workflowId: "job-application-manager",
      runId: "run_external_worker_approval_granted",
      stepId: "run_external_worker_approval_granted_step_1",
      sourceTrigger: "automation_os_scheduler",
      idempotencyKey: "external-worker-approval-granted",
      approvalGranted: true
    });
    assert.equal(approved.status, "complete");
    assert.equal(approved.externalActionExecuted, true);
    assert.equal(readFileSync(marker, "utf8"), "spawned");
  } finally {
    if (previousRunner === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER = previousRunner;
    if (previousEffects === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS = previousEffects;
  }
});

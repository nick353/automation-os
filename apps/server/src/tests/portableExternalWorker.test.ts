import assert from "node:assert/strict";
import test from "node:test";
import { runPortableExternalWorker, PORTABLE_EXTERNAL_ADAPTER_NOT_CONFIGURED } from "../runs/portableExternalWorker.js";

test("portable external worker fails closed when the Mac adapter is not configured", async () => {
  const previous = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
  delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
  try {
    const result = await runPortableExternalWorker({
      workflowId: "job-application-manager",
      runId: "run_external_worker_test",
      stepId: "run_external_worker_test_step_1",
      sourceTrigger: "codex_app_bridge",
      idempotencyKey: "external-worker-test"
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.exactBlocker, PORTABLE_EXTERNAL_ADAPTER_NOT_CONFIGURED);
    assert.equal(result.externalActionExecuted, false);
  } finally {
    if (previous === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER = previous;
  }
});

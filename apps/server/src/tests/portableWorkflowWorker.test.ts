import assert from "node:assert/strict";
import test from "node:test";

import {
  PORTABLE_EXTERNAL_EFFECTS_DISABLED_BLOCKER,
  portableWorkerModeForAdapter,
  portableWorkflowIdForWorkerAdapter,
  runPortableWorkflowNoEffect
} from "../runs/portableWorkflowWorker.js";

test("portable worker adapters bind every fixed registered workflow to an App-independent contract", () => {
  assert.equal(portableWorkflowIdForWorkerAdapter("job_submit_registered"), "job-application-manager");
  assert.equal(portableWorkflowIdForWorkerAdapter("job_followup_registered"), "job-application-manager");
  assert.equal(portableWorkflowIdForWorkerAdapter("daily_ai_registered"), "daily-ai-research-publish-run");
  assert.equal(
    portableWorkflowIdForWorkerAdapter("nisenprints_registered"),
    "nisenprints-daily-product-canva-printify-etsy-pinterest"
  );
  assert.equal(portableWorkflowIdForWorkerAdapter("prompt_transfer_registered"), "prompt-transfer-ukiyoe");
  assert.equal(portableWorkflowIdForWorkerAdapter("sns_multi_poster_registered"), "sns-multi-poster-ukiyoe");
  assert.equal(portableWorkflowIdForWorkerAdapter("x_authenticated_browser_lane_registered"), "x-authenticated-browser-lane");
  assert.equal(portableWorkflowIdForWorkerAdapter("codex_cli"), null);
  assert.equal(portableWorkerModeForAdapter("daily_ai_registered"), "execute_daily_ai_registered");
  assert.equal(portableWorkerModeForAdapter("x_authenticated_browser_lane_registered"), "execute_x_authenticated_browser_lane_registered");
});

test("portable worker canary accepts real run ids and never starts browser, connector, or external effects", () => {
  const result = runPortableWorkflowNoEffect({
    runId: "run_test_123",
    workflowId: "job-application-manager",
    sourceTrigger: "automation_os_scheduler",
    idempotencyKey: "job-application-manager:run_test_123"
  });

  assert.equal(result.receipt.status, "completed");
  assert.equal(result.receipt.run_id, "run_test_123");
  assert.equal(result.receipt.browser_started, false);
  assert.equal(result.receipt.connector_called, false);
  assert.equal(result.receipt.external_action_executed, false);
  assert.equal(result.blocker, PORTABLE_EXTERNAL_EFFECTS_DISABLED_BLOCKER);
  assert.equal(result.external_action_executed, false);
});

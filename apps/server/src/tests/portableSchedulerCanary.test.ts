import assert from "node:assert/strict";
import test from "node:test";
import { runPortableSchedulerCanary } from "../runs/portableSchedulerCanary.js";

test("Automation OS scheduler canary binds every portable workflow without external effects", () => {
  const receipt = runPortableSchedulerCanary(new Date("2026-08-03T00:00:00.000Z"));
  assert.equal(receipt.schema, "automation_os_portable_scheduler_canary_v1");
  assert.equal(receipt.source_trigger, "automation_os_scheduler");
  assert.equal(receipt.checked, 3);
  assert.equal(receipt.completed, 3);
  assert.equal(receipt.browser_started, false);
  assert.equal(receipt.connector_called, false);
  assert.equal(receipt.external_action_executed, false);
  assert.equal(receipt.exact_blocker, null);
  assert.deepEqual(receipt.receipts.map((item) => item.stages), [
    ["manifest_validation", "run_binding", "readback", "cleanup"],
    ["manifest_validation", "run_binding", "readback", "cleanup"],
    ["manifest_validation", "run_binding", "readback", "cleanup"]
  ]);
});

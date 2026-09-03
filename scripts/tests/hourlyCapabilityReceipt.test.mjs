import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOURLY_STAGE_ORDER, recordHourlyCapabilityBlocker } from "../lib/hourly-capability-receipt.mjs";

function globals() {
  return {
    nodeRepl: {
      requestMeta: {
        "x-codex-turn-metadata": {
          thread_source: "automation",
          session_id: "session-capability-test",
          thread_id: "thread-capability-test",
          turn_id: "turn-capability-test",
        },
      },
    },
  };
}

test("records a host-bound pre-projection capability blocker with every stage deferred", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-hourly-capability-receipt-"));
  const result = recordHourlyCapabilityBlocker({ artifactRoot: root, globals: globals() });
  assert.equal(result.created, true);
  assert.equal(result.readback.status, "observed");
  const receipt = JSON.parse(fs.readFileSync(result.path, "utf8"));
  assert.equal(receipt.schema, "aos.companion_hourly_capability_blocker_receipt.v1");
  assert.equal(receipt.root.turnId, "turn-capability-test");
  assert.equal(receipt.capabilityCheck.projectionCreated, false);
  assert.equal(receipt.capabilityCheck.registeredRootInvoked, false);
  assert.equal(receipt.externalActionExecuted, false);
  assert.deepEqual(receipt.executionReceipt.stageOrder, HOURLY_STAGE_ORDER);
  assert.equal(Object.values(receipt.executionReceipt.stageReceipts).length, HOURLY_STAGE_ORDER.length);
  assert.equal(Object.values(receipt.executionReceipt.stageReceipts).every((stage) => stage.status === "deferred"), true);
  assert.equal(Object.values(receipt.executionReceipt.stageReceipts).some((stage) => stage.status === "not_run"), false);
});

test("does not replace an existing same-turn capability receipt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-hourly-capability-receipt-repeat-"));
  const first = recordHourlyCapabilityBlocker({ artifactRoot: root, globals: globals() });
  const second = recordHourlyCapabilityBlocker({ artifactRoot: root, globals: globals() });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.receiptDigest, first.receiptDigest);
  assert.equal(second.readback.receiptDigest, first.receiptDigest);
});

test("requires the official host identity for a capability receipt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-hourly-capability-receipt-identity-"));
  assert.throws(
    () => recordHourlyCapabilityBlocker({ artifactRoot: root, globals: {} }),
    /codex_app_registered_automation_identity_capability_unavailable/u,
  );
});

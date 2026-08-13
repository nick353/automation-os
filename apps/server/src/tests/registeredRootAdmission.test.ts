import assert from "node:assert/strict";
import test from "node:test";

import {
  createRegisteredRootAdmissionV1,
  validateRegisteredRootAdmissionV1
} from "../runs/registeredRootAdmission.js";
import { runPortableWorkerCanary } from "../runs/portableWorkerCanary.js";

const fingerprint = "a".repeat(64);

test("fresh registered root binds the registered automation to one run and remains read-only", () => {
  const root = createRegisteredRootAdmissionV1({
    registeredAutomationId: "automation-3",
    workflowId: "job-application-manager",
    runId: "run-root-canary",
    sourceTrigger: "codex_app_bridge",
    definitionFingerprint: fingerprint,
    now: "2026-08-13T05:00:00.000Z"
  });

  const validated = validateRegisteredRootAdmissionV1(root, {
    registeredAutomationId: "automation-3",
    workflowId: "job-application-manager",
    runId: "run-root-canary",
    sourceTrigger: "codex_app_bridge"
  }, Date.parse("2026-08-13T05:01:00.000Z"));

  assert.equal(validated.first_class_root, true);
  assert.equal(validated.owner, "automation_os_control_plane");
  assert.equal(validated.external_effect_authority, false);
  assert.equal(validated.external_action_executed, false);
  assert.equal(validated.root_id, root.root_id);
  assert.equal(validated.root_digest, root.root_digest);
});

test("root admission rejects cross-run tampering and expiry", () => {
  const root = createRegisteredRootAdmissionV1({
    registeredAutomationId: "daily-ai-research-publish-run",
    workflowId: "daily-ai-research-publish-run",
    runId: "run-root-tamper",
    sourceTrigger: "automation_os_scheduler",
    definitionFingerprint: fingerprint,
    now: "2026-08-13T05:00:00.000Z",
    ttlMs: 1_000
  });

  assert.throws(
    () => validateRegisteredRootAdmissionV1({ ...root, run_id: "foreign-run" }, { runId: root.run_id }, Date.parse("2026-08-13T05:00:00.100Z")),
    /root_digest_invalid/
  );
  assert.throws(
    () => validateRegisteredRootAdmissionV1(root, undefined, Date.parse("2026-08-13T05:00:02.000Z")),
    /expired/
  );
});

test("portable no-effect canary carries the same fresh root through its receipt", () => {
  const receipt = runPortableWorkerCanary({
    runId: "canary-registered-root",
    workflowId: "nisenprints-daily-product-canva-printify-etsy-pinterest",
    sourceTrigger: "automation_os_scheduler",
    idempotencyKey: "root-canary:1",
    registeredAutomationId: "nisenprints-daily-product-canva-printify-etsy-pinterest"
  });

  assert.equal(receipt.external_action_executed, false);
  assert.equal(receipt.browser_started, false);
  assert.equal(receipt.connector_called, false);
  assert.equal(receipt.registered_root_admission?.first_class_root, true);
  assert.equal(receipt.registered_root_admission?.run_id, receipt.run_id);
  assert.equal(receipt.registered_root_admission?.workflow_id, receipt.workflow_id);
  assert.equal(receipt.registered_root_admission?.external_effect_authority, false);
});

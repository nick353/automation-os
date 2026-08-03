import assert from "node:assert/strict";
import test from "node:test";

import { runPortableWorkerCanary } from "../runs/portableWorkerCanary.js";
import {
  createPortableRunManifestV1,
  portableWorkflowManifests,
  validatePortableRunManifestV1,
  validatePortableWorkflowManifestV1
} from "../runs/portableWorkflowContract.js";

test("portable workflow manifests are App-independent and use the canonical worker surfaces", () => {
  for (const manifest of Object.values(portableWorkflowManifests)) {
    assert.equal(validatePortableWorkflowManifestV1(manifest), manifest);
    assert.equal(manifest.execution.backend, "automation_os_worker");
    assert.equal(manifest.execution.browser_surface, "browser_use_cli");
    assert.equal(manifest.execution.connector_gateway, "mcp");
    assert.equal(manifest.execution.app_dependency, false);
  }
});

test("the same run contract binds from the App bridge and Automation OS scheduler", () => {
  const appRun = createPortableRunManifestV1({
    runId: "run-app-bridge",
    workflowId: "job-application-manager",
    sourceTrigger: "codex_app_bridge",
    idempotencyKey: "job-application-manager:canary"
  });
  const osRun = createPortableRunManifestV1({
    runId: "run-automation-os",
    workflowId: "job-application-manager",
    sourceTrigger: "automation_os_scheduler",
    idempotencyKey: "job-application-manager:canary"
  });

  assert.equal(appRun.workflow_id, osRun.workflow_id);
  assert.equal(appRun.execution_backend, osRun.execution_backend);
  assert.equal(appRun.idempotency_key, osRun.idempotency_key);
  assert.equal(appRun.external_action_allowed, false);
  assert.equal(osRun.external_action_allowed, false);
  assert.equal(appRun.app_dependency, false);
  assert.equal(osRun.app_dependency, false);
});

test("portable canary validates binding and proves no browser, connector, or external effect", () => {
  const receipt = runPortableWorkerCanary({
    runId: "run-portable-canary",
    workflowId: "daily-ai-research-publish-run",
    sourceTrigger: "automation_os_scheduler",
    idempotencyKey: "daily-ai-research-publish-run:canary"
  });

  assert.deepEqual(receipt.stages, ["manifest_validation", "run_binding", "readback", "cleanup"]);
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.browser_started, false);
  assert.equal(receipt.connector_called, false);
  assert.equal(receipt.external_action_executed, false);
  assert.equal(receipt.exact_blocker, null);
});

test("portable run manifests reject App controller and secret-bearing fields", () => {
  assert.throws(
    () => validatePortableRunManifestV1({
      schema: "automation_os_portable_run_manifest_v1",
      run_id: "run-invalid",
      workflow_id: "job-application-manager",
      source_trigger: "automation_os_scheduler",
      execution_backend: "automation_os_worker",
      idempotency_key: "invalid",
      external_action_allowed: false,
      app_dependency: false,
      controller_identity: "should-not-be-here"
    } as never),
    /controller_identity_forbidden/
  );
});

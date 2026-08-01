import assert from "node:assert/strict";
import test from "node:test";

import {
  IAB_EXTERNAL_EFFECT_CAPABILITY_BLOCKER,
  REFERENCE_WORKFLOW_ADMISSION_SCHEMA_V1,
  projectReferenceWorkflowAdmission
} from "../serviceReadiness/referenceWorkflowAdmission.js";

const workflows = [
  ["daily-ai", "daily_ai.workflow_contract.v1"],
  ["job-application-manager", "job_manager.workflow_contract.v1"],
  ["nisenprints", "nisenprints.service_readiness.v1"]
] as const;

test("projects every reference adapter as a non-live blocked admission when contract is absent", () => {
  for (const [workflow_id, contract_schema] of workflows) {
    const projection = projectReferenceWorkflowAdmission({ workflow_id });
    assert.equal(projection.schema, REFERENCE_WORKFLOW_ADMISSION_SCHEMA_V1);
    assert.equal(projection.workflow_id, workflow_id);
    assert.equal(projection.contract_schema, contract_schema);
    assert.equal(projection.adapter?.workflow_id, workflow_id);
    assert.equal(projection.browser_surface, "in_app_browser");
    assert.equal(projection.capability_mode, "read_only");
    assert.equal(projection.legacy_surfaces_forbidden, true);
    assert.equal(projection.prior_receipt_reuse, false);
    assert.equal(projection.external_action_executed, false);
    assert.equal(projection.contract_provided, false);
    assert.equal(projection.status, "blocked");
    assert.equal(projection.exact_blocker, IAB_EXTERNAL_EFFECT_CAPABILITY_BLOCKER);
    assert.deepEqual(projection.root_admission, {
      ok: false,
      status: "blocked",
      exact_blocker: IAB_EXTERNAL_EFFECT_CAPABILITY_BLOCKER
    });
  }
});

test("calls root admission only when a workflow contract is supplied", () => {
  const projection = projectReferenceWorkflowAdmission({
    workflow_id: "daily-ai",
    workflow_contract: { schema: "daily_ai.workflow_contract.v1" }
  });
  assert.equal(projection.contract_provided, true);
  assert.equal(projection.status, "blocked");
  assert.equal(projection.exact_blocker, "iab_root_stage_admission_root_binding_required");
  assert.equal(projection.root_admission.ok, false);
});

test("rejects unknown workflow projections without fabricating a capability", () => {
  const projection = projectReferenceWorkflowAdmission({ workflow_id: "unknown-workflow" });
  assert.equal(projection.adapter, null);
  assert.equal(projection.status, "blocked");
  assert.equal(projection.exact_blocker, "reference_workflow_admission_unknown_workflow");
  assert.equal(projection.external_action_executed, false);
  assert.equal(projection.legacy_surfaces_forbidden, true);
  assert.equal(projection.prior_receipt_reuse, false);
});

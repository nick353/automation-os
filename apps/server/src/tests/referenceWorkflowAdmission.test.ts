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
    assert.equal(projection.aos_workflow_adapter.status, "ready_for_preflight_no_effect");
    assert.equal(projection.aos_workflow_adapter.external_action_allowed, false);
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
  assert.equal(projection.aos_workflow_adapter.status, "blocked");
  assert.equal(projection.aos_workflow_adapter.exact_blocker, "workflow_adapter_unknown");
});

test("Browser Use admission exposes a normalized external intent without granting authority", async () => {
  const { projectReferenceBrowserUseWorkflowAdmission } = await import("../serviceReadiness/referenceWorkflowAdmission.js");
  const projection = projectReferenceBrowserUseWorkflowAdmission({
    workflow_id: "daily-ai",
    workflow_contract: {
      schema: "daily_ai.workflow_contract.v1",
      root_id: "root",
      workflow_id: "daily-ai",
      run_id: "run",
      stage_id: "publish",
      attempt_id: "attempt",
      fencing_token: 1,
      capability_id: "cap",
      turn_id: "turn",
      session_id: "session",
      nonce: "nonce",
      capability_mode: "external",
      provider: "linkedin",
      account_ref: "account",
      platform: "linkedin",
      queue_id: "queue",
      post_surface: "linkedin_feed",
      language: "en",
      visual_style: "decision_card",
      media_receipt_hash: "e".repeat(64),
      target_hash: "a".repeat(64),
      payload_hash: "b".repeat(64),
      effect_key: "daily-ai:linkedin:queue",
      effect_class: "external_non_idempotent",
      status: "running",
      external_action_executed: false,
      provider_receipt_hash: null,
      no_post: true,
      cleanup_receipt_hash: null,
      exact_blocker: null,
      safe_resume_step: null,
      blocker_owner: null
    }
  });
  assert.equal(projection.browser_surface, "browser_use_cli");
  assert.equal(projection.external_intent?.schema, "service_readiness_browser_use_external_intent.v1");
  assert.equal(projection.external_intent?.external_effect_ready, false);
  assert.equal(projection.external_intent?.authority_required, true);
  assert.equal(projection.external_intent?.exact_blocker, "daily_ai_linkedin_no_post_or_browser_use_cli_capability");
  assert.equal(projection.root_admission.exact_blocker, "daily_ai_linkedin_no_post_or_browser_use_cli_capability");
});

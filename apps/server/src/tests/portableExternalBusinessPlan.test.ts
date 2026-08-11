import test from "node:test";
import assert from "node:assert/strict";
import { getPortableExternalBusinessPlan, portableExternalBusinessPlans, PORTABLE_ACCOUNT_TARGET_PAYLOAD_RECEIPT_CONTRACT_SCHEMA_V1, PORTABLE_EXTERNAL_BUSINESS_PLAN_SCHEMA_V1, validatePortableBusinessInputBundle } from "../runs/portableExternalBusinessPlan.js";
import { admitWebOperationEffect, getWebOperationContract, resolveLiveSemanticTarget, validateWebOperationIntent } from "../runs/webOperationContract.js";

test("portable external business plans are provider-neutral and Browser Use CLI bound", () => {
  const plans = Object.values(portableExternalBusinessPlans);
  assert.equal(plans.length, 3);
  for (const plan of plans) {
    assert.equal(plan.schema, PORTABLE_EXTERNAL_BUSINESS_PLAN_SCHEMA_V1);
    assert.equal(plan.browser_surface, "browser_use_cli");
    assert.equal(plan.llm_provider_neutral, true);
    assert.equal(plan.app_dependency, false);
    assert.equal(plan.external_effect_policy, "approval_required");
    assert.ok(plan.stages.length > 0);
    assert.ok(plan.required_business_proofs.length > 0);
    assert.equal(plan.required_runner_contract.same_run_receipt, true);
    assert.equal(plan.required_runner_contract.web_operation_contract.schema, "automation_os_web_operation_contract.v1");
    assert.equal(plan.required_runner_contract.web_operation_contract.fixed_kernel.workflow_owned_persistent_profile, true);
    assert.equal(plan.required_runner_contract.web_operation_contract.adaptive_layer.site_playbook_role, "hint_only");
    assert.equal(plan.required_runner_contract.web_operation_contract.adaptive_layer.no_fixed_css_selector_authority, true);
    assert.deepEqual(plan.required_runner_contract.web_operation_contract.operation_model.intent_kinds, ["read", "create", "update", "publish", "submit", "delete"]);
    assert.equal(plan.required_runner_contract.web_operation_contract.operation_model.target_resolution, "live_semantic_candidate_unique_match");
    assert.equal(plan.account_target_payload_receipt_contract.schema, PORTABLE_ACCOUNT_TARGET_PAYLOAD_RECEIPT_CONTRACT_SCHEMA_V1);
    assert.ok(plan.account_target_payload_receipt_contract.account_fields.includes("company_id"));
    assert.ok(plan.account_target_payload_receipt_contract.target_fields.includes("target_digest"));
    assert.ok(plan.account_target_payload_receipt_contract.payload_fields.includes("input_bundle_sha256"));
    assert.ok(plan.account_target_payload_receipt_contract.receipt_fields.includes("cleanup_verified"));
    assert.ok(plan.account_target_payload_receipt_contract.same_run_bindings.includes("idempotency_key"));
    assert.ok(plan.account_target_payload_receipt_contract.required_input_fields.length > 0);
  }
});

test("common web operation intent resolves only one fresh semantic target", () => {
  const digest = "a".repeat(64);
  const readIntent = validateWebOperationIntent({
    schema: "automation_os_web_operation_intent.v1",
    operation: "read",
    run_id: "run-web-intent",
    step_id: "step-web-intent",
    idempotency_key: "web-intent-1",
    account_ref: "account-1",
    allowed_origins: ["https://example.com"],
    target: { semantic_query: "Publish" },
    payload_hash: null,
    approval_status: "not_required",
    authority_sha256: null,
    readback_required: true,
    no_replay: true,
  });
  const candidate = {
    schema: "automation_os_semantic_target_candidate.v1" as const,
    candidate_id: "cta-1",
    semantic_role: "primary_action",
    label: "Publish",
    target_digest: digest,
    source_state_digest: "b".repeat(64),
    origin: "https://example.com",
    visible: true,
    enabled: true,
  };
  const resolution = resolveLiveSemanticTarget({ intent: readIntent, candidates: [candidate] });
  assert.equal(resolution.status, "resolved");
  assert.deepEqual(admitWebOperationEffect({ intent: readIntent, resolution }), { status: "admitted" });
  const ambiguous = resolveLiveSemanticTarget({ intent: readIntent, candidates: [candidate, { ...candidate, candidate_id: "cta-2" }] });
  assert.equal(ambiguous.status, "blocked");
  assert.equal(ambiguous.exact_blocker, "web_operation_target_ambiguous");
  const effectIntent = validateWebOperationIntent({
    ...readIntent,
    operation: "publish",
    payload_hash: digest,
    approval_status: "pending",
    authority_sha256: digest,
  });
  assert.deepEqual(admitWebOperationEffect({ intent: effectIntent, resolution: resolveLiveSemanticTarget({ intent: effectIntent, candidates: [candidate] }) }), { status: "awaiting_approval", exact_blocker: "web_operation_approval_pending" });
  assert.throws(() => validateWebOperationIntent({ ...readIntent, target: { semantic_query: "Publish", css_selector: "button" } }), /web_operation_intent_fixed_target_rejected/);
  assert.equal(getWebOperationContract().operation_model.exploration_limits.max_steps, 32);
});

test("business input bundles fail closed until workflow account, target, and payload fields are bound", () => {
  assert.deepEqual(
    validatePortableBusinessInputBundle("daily-ai-research-publish-run", {
      account_ref: "daily-ai-account",
      target_key: "content-001",
      content_key: "content-001",
      source_snapshot_id: "snapshot-001",
    }),
    { ok: false, exact_blocker: "portable_business_daily_ai_input_payload_hash_missing" },
  );
  assert.deepEqual(
    validatePortableBusinessInputBundle("nisenprints-daily-product-canva-printify-etsy-pinterest", {
      account_ref: "nisenprints-account",
      target_key: "product-001",
      product_key: "product-001",
      asset_manifest_id: "manifest-001",
      payload_hash: "not-a-sha256",
      source_snapshot_id: "snapshot-001",
    }),
    { ok: false, exact_blocker: "portable_business_nisenprints_input_payload_hash_invalid" },
  );
  assert.deepEqual(
    validatePortableBusinessInputBundle("daily-ai-research-publish-run", {
      account_ref: "daily-ai-account",
      target_key: "content-001",
      content_key: "content-001",
      payload_hash: "a".repeat(64),
      source_snapshot_id: "snapshot-001",
    }),
    { ok: true },
  );
});

test("portable external business plan lookup returns a defensive copy", () => {
  const plan = getPortableExternalBusinessPlan("job-application-manager");
  assert.ok(plan);
  (plan.stages as string[]).push("test_only");
  assert.equal(getPortableExternalBusinessPlan("job-application-manager")?.stages.includes("test_only"), false);
  assert.equal(getPortableExternalBusinessPlan("unknown"), null);
});

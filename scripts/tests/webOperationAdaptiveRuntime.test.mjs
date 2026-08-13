import assert from "node:assert/strict";
import test from "node:test";

import {
  WEB_OPERATION_CONTRACT,
  admitWebOperationEffect,
  resolveLiveSemanticTarget,
  validateWebOperationContract,
  validateWebOperationIntent,
} from "../portable-business-action-plan.mjs";
import {
  WEB_OPERATION_DISPATCH_SCHEMA_V1,
  WEB_OPERATION_READBACK_SCHEMA_V1,
  admitWebOperationLifecycle,
  cleanupWebOperationLifecycle,
  createWebOperationLifecycle,
  dispatchWebOperationLifecycle,
  reconcileWebOperationLifecycle,
  webOperationLifecycleReceipt,
} from "../web-operation-lifecycle.mjs";

const digest = "a".repeat(64);

function intent(overrides = {}) {
  return validateWebOperationIntent({
    schema: "automation_os_web_operation_intent.v1",
    operation: "read",
    run_id: "run-web-runtime",
    step_id: "step-web-runtime",
    idempotency_key: "web-runtime-1",
    account_ref: "account-1",
    allowed_origins: ["https://example.com"],
    target: { semantic_query: "Publish" },
    payload_hash: null,
    approval_status: "not_required",
    authority_sha256: null,
    readback_required: true,
    no_replay: true,
    ...overrides,
  });
}

function candidate(candidateId = "cta-1") {
  return {
    schema: "automation_os_semantic_target_candidate.v1",
    candidate_id: candidateId,
    semantic_role: "primary_action",
    label: "Publish",
    target_digest: digest,
    source_state_digest: "b".repeat(64),
    origin: "https://example.com",
    visible: true,
    enabled: true,
  };
}

test("adaptive runtime resolves a unique semantic candidate", () => {
  const operation = intent();
  const resolution = resolveLiveSemanticTarget({ intent: operation, candidates: [candidate()] });
  assert.equal(resolution.status, "resolved");
  assert.deepEqual(admitWebOperationEffect({ intent: operation, resolution }), { status: "admitted" });
});

test("adaptive runtime stops on ambiguity and stale target evidence", () => {
  const operation = intent();
  assert.equal(resolveLiveSemanticTarget({ intent: operation, candidates: [candidate("cta-1"), candidate("cta-2")] }).exact_blocker, "web_operation_target_ambiguous");
  assert.equal(resolveLiveSemanticTarget({ intent: operation, candidates: [{ ...candidate(), origin: "https://other.example" }] }).exact_blocker, "web_operation_target_not_found");
  assert.throws(() => validateWebOperationIntent({ ...operation, target: { semantic_query: "Publish", css_selector: "button" } }), /web_operation_intent_fixed_target_rejected/);
  assert.throws(() => validateWebOperationIntent({ ...operation, allowed_origins: ["https://127.0.0.1"] }), /web_operation_origin_invalid/);
});

test("adaptive runtime matches descriptive semantic labels without weakening key or origin binding", () => {
  const operation = intent({ target: { semantic_query: "Publish" } });
  const descriptive = { ...candidate(), label: "Publish this post" };
  assert.equal(resolveLiveSemanticTarget({ intent: operation, candidates: [descriptive] }).status, "resolved");
  assert.equal(resolveLiveSemanticTarget({ intent: operation, candidates: [descriptive, { ...candidate(), candidate_id: "settings", label: "Publish settings" }] }).exact_blocker, "web_operation_target_ambiguous");

  const keyed = intent({ target: { semantic_query: "Publish", target_key: "cta-1" } });
  assert.equal(resolveLiveSemanticTarget({ intent: keyed, candidates: [{ ...candidate(), label: "Different live label" }] }).status, "resolved");
  assert.equal(resolveLiveSemanticTarget({ intent: keyed, candidates: [{ ...candidate(), candidate_id: "other", label: "Publish" }] }).exact_blocker, "web_operation_target_not_found");
  assert.equal(resolveLiveSemanticTarget({ intent: operation, candidates: [{ ...descriptive, href: "https://evil.example/publish" }] }).exact_blocker, "web_operation_target_not_found");
  const trailingSlash = resolveLiveSemanticTarget({ intent: operation, candidates: [{ ...descriptive, origin: "https://example.com/" }] });
  assert.equal(trailingSlash.status, "resolved");
  assert.equal(resolveLiveSemanticTarget({ intent: operation, candidates: [{ ...candidate(), label: "Button", accessible_name: "Publish" }] }).status, "resolved");
});

test("effectful intents distinguish approval-pending from admitted", () => {
  const operation = intent({
    operation: "publish",
    payload_hash: digest,
    authority_sha256: digest,
    approval_status: "pending",
  });
  const resolution = resolveLiveSemanticTarget({ intent: operation, candidates: [candidate()] });
  assert.deepEqual(admitWebOperationEffect({ intent: operation, resolution }), { status: "awaiting_approval", exact_blocker: "web_operation_approval_pending" });
  assert.deepEqual(admitWebOperationEffect({ intent: { ...operation, approval_status: "approved" }, resolution }), { status: "admitted" });
  assert.equal(WEB_OPERATION_CONTRACT.operation_model.unresolved_target_policy, "stop_or_clarify");
});

test("portable contract mirror validates the complete operation model", () => {
  assert.doesNotThrow(() => validateWebOperationContract(WEB_OPERATION_CONTRACT));
  assert.doesNotThrow(() => validateWebOperationContract({
    ...WEB_OPERATION_CONTRACT,
    fixed_kernel: {
      ...WEB_OPERATION_CONTRACT.fixed_kernel,
      fail_close_on: [
        "captcha",
        "otp",
        "identity_verification",
        "assessment",
        "unknown_high_impact_question",
        "payment",
        "tax",
        "banking",
        "ambiguous_external_effect",
      ],
    },
  }));
  assert.throws(() => validateWebOperationContract({ ...WEB_OPERATION_CONTRACT, operation_model: { ...WEB_OPERATION_CONTRACT.operation_model, target_resolution: "fixed_css_selector" } }), /web_operation_contract_operation_model_invalid/);
  assert.throws(() => validateWebOperationContract({ ...WEB_OPERATION_CONTRACT, fixed_kernel: { ...WEB_OPERATION_CONTRACT.fixed_kernel, unexpected_runtime_flag: true } }), /web_operation_contract_fixed_kernel_invalid/);
  assert.throws(() => validateWebOperationContract({ ...WEB_OPERATION_CONTRACT, operation_model: { ...WEB_OPERATION_CONTRACT.operation_model, exploration_limits: { ...WEB_OPERATION_CONTRACT.operation_model.exploration_limits, unexpected_limit: 1 } } }), /web_operation_contract_operation_model_invalid/);
});

test("common lifecycle completes a semantic publish only after same-run source readback and cleanup", () => {
  const operation = intent({ operation: "publish", payload_hash: digest, authority_sha256: digest, approval_status: "approved" });
  const resolution = resolveLiveSemanticTarget({ intent: operation, candidates: [candidate()] });
  let lifecycle = createWebOperationLifecycle({ intent: operation, resolution });
  lifecycle = admitWebOperationLifecycle({ lifecycle, intent: operation });
  lifecycle = dispatchWebOperationLifecycle({ lifecycle, intent: operation, dispatch: {
    schema: WEB_OPERATION_DISPATCH_SCHEMA_V1,
    run_id: operation.run_id,
    step_id: operation.step_id,
    idempotency_key: operation.idempotency_key,
    target_digest: digest,
    payload_hash: digest,
    state: "executed",
  } });
  lifecycle = reconcileWebOperationLifecycle({ lifecycle, intent: operation, readback: {
    schema: WEB_OPERATION_READBACK_SCHEMA_V1,
    run_id: operation.run_id,
    step_id: operation.step_id,
    idempotency_key: operation.idempotency_key,
    target_digest: digest,
    payload_hash: digest,
    source_state_digest: "c".repeat(64),
    outcome: "effect_confirmed",
    observed: "present",
    verified: true,
    same_run_source_sync: true,
  } });
  const beforeCleanup = webOperationLifecycleReceipt(lifecycle);
  assert.equal(beforeCleanup.status, "blocked");
  assert.equal(beforeCleanup.same_run_receipt, false);
  assert.equal(beforeCleanup.exact_blocker, "web_operation_cleanup_readback_missing");
  lifecycle = cleanupWebOperationLifecycle({ lifecycle, cleanupVerified: true });
  assert.equal(webOperationLifecycleReceipt(lifecycle).status, "complete");
  assert.equal(lifecycle.external_action_executed, true);
  assert.equal(lifecycle.cleanup_verified, true);
});

test("unknown external outcome never replays and can only be resolved by source-of-truth reconciliation", () => {
  const operation = intent({ operation: "submit", payload_hash: digest, authority_sha256: digest, approval_status: "approved" });
  const resolution = resolveLiveSemanticTarget({ intent: operation, candidates: [candidate()] });
  let lifecycle = admitWebOperationLifecycle({ lifecycle: createWebOperationLifecycle({ intent: operation, resolution }), intent: operation });
  lifecycle = dispatchWebOperationLifecycle({ lifecycle, intent: operation, dispatch: {
    schema: WEB_OPERATION_DISPATCH_SCHEMA_V1,
    run_id: operation.run_id,
    step_id: operation.step_id,
    idempotency_key: operation.idempotency_key,
    target_digest: digest,
    payload_hash: digest,
    state: "unknown",
  } });
  const cleaned = cleanupWebOperationLifecycle({ lifecycle, cleanupVerified: true });
  assert.equal(cleaned.state, "effect_unknown");
  assert.equal(webOperationLifecycleReceipt(cleaned).status, "blocked");
  assert.equal(cleaned.exact_blocker, "web_operation_external_effect_reconciliation_required");
  assert.throws(() => dispatchWebOperationLifecycle({ lifecycle: cleaned, intent: operation, dispatch: {
    schema: WEB_OPERATION_DISPATCH_SCHEMA_V1,
    run_id: operation.run_id,
    step_id: operation.step_id,
    idempotency_key: operation.idempotency_key,
    target_digest: digest,
    payload_hash: digest,
    state: "executed",
  } }), /web_operation_dispatch_not_admitted/);
  const reconciled = reconcileWebOperationLifecycle({ lifecycle: cleaned, intent: operation, readback: {
    schema: WEB_OPERATION_READBACK_SCHEMA_V1,
    run_id: operation.run_id,
    step_id: operation.step_id,
    idempotency_key: operation.idempotency_key,
    target_digest: digest,
    payload_hash: digest,
    source_state_digest: "d".repeat(64),
    outcome: "effect_confirmed",
    observed: "present",
    verified: true,
    same_run_source_sync: true,
  } });
  assert.equal(reconciled.state, "completed");
  assert.equal(reconciled.external_action_executed, false);
});

test("delete lifecycle requires an absent target and a fresh target for a no-dispatch retry", () => {
  const operation = intent({ operation: "delete", payload_hash: digest, authority_sha256: digest, approval_status: "approved" });
  const resolution = resolveLiveSemanticTarget({ intent: operation, candidates: [candidate()] });
  let lifecycle = admitWebOperationLifecycle({ lifecycle: createWebOperationLifecycle({ intent: operation, resolution }), intent: operation });
  lifecycle = dispatchWebOperationLifecycle({ lifecycle, intent: operation, dispatch: {
    schema: WEB_OPERATION_DISPATCH_SCHEMA_V1,
    run_id: operation.run_id,
    step_id: operation.step_id,
    idempotency_key: operation.idempotency_key,
    target_digest: digest,
    payload_hash: digest,
    state: "executed",
  } });
  lifecycle = reconcileWebOperationLifecycle({ lifecycle, intent: operation, readback: {
    schema: WEB_OPERATION_READBACK_SCHEMA_V1,
    run_id: operation.run_id,
    step_id: operation.step_id,
    idempotency_key: operation.idempotency_key,
    target_digest: digest,
    payload_hash: digest,
    source_state_digest: "e".repeat(64),
    outcome: "effect_confirmed",
    observed: "absent",
    verified: true,
    same_run_source_sync: true,
  } });
  assert.equal(lifecycle.state, "completed");
});

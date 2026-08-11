import assert from "node:assert/strict";
import test from "node:test";
import {
  WEB_OPERATION_DISPATCH_SCHEMA_V1,
  WEB_OPERATION_READBACK_SCHEMA_V1,
  admitWebOperationLifecycle,
  cleanupWebOperationLifecycle,
  createWebOperationLifecycle,
  dispatchWebOperationLifecycle,
  reconcileWebOperationLifecycle,
  webOperationLifecycleReceipt
} from "../runs/webOperationLifecycle.js";
import { getWebOperationContract, resolveLiveSemanticTarget, validateWebOperationContract, validateWebOperationIntent } from "../runs/webOperationContract.js";

const digest = "a".repeat(64);

function intent(overrides: Record<string, unknown> = {}) {
  return validateWebOperationIntent({
    schema: "automation_os_web_operation_intent.v1",
    operation: "publish",
    run_id: "run-web-lifecycle",
    step_id: "step-web-lifecycle",
    idempotency_key: "web-lifecycle-1",
    account_ref: "account-1",
    allowed_origins: ["https://example.com"],
    target: { semantic_query: "Publish" },
    payload_hash: digest,
    approval_status: "approved",
    authority_sha256: digest,
    readback_required: true,
    no_replay: true,
    ...overrides
  });
}

function candidate() {
  return {
    schema: "automation_os_semantic_target_candidate.v1" as const,
    candidate_id: "publish-1",
    semantic_role: "primary_action",
    label: "Publish",
    target_digest: digest,
    source_state_digest: "b".repeat(64),
    origin: "https://example.com",
    visible: true,
    enabled: true
  };
}

function dispatch(operation: ReturnType<typeof intent>, state: "executed" | "unknown" | "not_dispatched") {
  return {
    schema: WEB_OPERATION_DISPATCH_SCHEMA_V1,
    run_id: operation.run_id,
    step_id: operation.step_id,
    idempotency_key: operation.idempotency_key,
    target_digest: digest,
    payload_hash: digest,
    state
  };
}

function readback(operation: ReturnType<typeof intent>, outcome: "effect_confirmed" | "no_effect" | "unknown", observed: "present" | "absent" | "unchanged" = "present") {
  return {
    schema: WEB_OPERATION_READBACK_SCHEMA_V1,
    run_id: operation.run_id,
    step_id: operation.step_id,
    idempotency_key: operation.idempotency_key,
    target_digest: digest,
    payload_hash: digest,
    source_state_digest: "c".repeat(64),
    outcome,
    observed,
    verified: true as const,
    same_run_source_sync: true as const
  };
}

test("lifecycle reaches complete only after source readback and cleanup", () => {
  const operation = intent();
  const resolution = resolveLiveSemanticTarget({ intent: operation, candidates: [candidate()] });
  let lifecycle = createWebOperationLifecycle({ intent: operation, resolution });
  lifecycle = admitWebOperationLifecycle({ lifecycle, intent: operation });
  lifecycle = dispatchWebOperationLifecycle({ lifecycle, intent: operation, dispatch: dispatch(operation, "executed") });
  lifecycle = reconcileWebOperationLifecycle({ lifecycle, intent: operation, readback: readback(operation, "effect_confirmed") });
  const beforeCleanup = webOperationLifecycleReceipt(lifecycle);
  assert.equal(beforeCleanup.status, "blocked");
  assert.equal(beforeCleanup.same_run_receipt, false);
  assert.equal(beforeCleanup.exact_blocker, "web_operation_cleanup_readback_missing");
  lifecycle = cleanupWebOperationLifecycle({ lifecycle, cleanupVerified: true });
  assert.equal(webOperationLifecycleReceipt(lifecycle).status, "complete");
  assert.equal(lifecycle.external_action_executed, true);
  assert.equal(lifecycle.cleanup_verified, true);
});

test("approval pending, ambiguous target, unknown effect and no-dispatch are explicit non-success states", () => {
  const pending = intent({ approval_status: "pending" });
  const pendingResolution = resolveLiveSemanticTarget({ intent: pending, candidates: [candidate()] });
  const pendingLifecycle = admitWebOperationLifecycle({ lifecycle: createWebOperationLifecycle({ intent: pending, resolution: pendingResolution }), intent: pending });
  assert.equal(pendingLifecycle.state, "approval_pending");
  assert.equal(webOperationLifecycleReceipt(pendingLifecycle).status, "awaiting_approval");

  const ambiguous = resolveLiveSemanticTarget({ intent: pending, candidates: [candidate(), { ...candidate(), candidate_id: "publish-2" }] });
  const blocked = createWebOperationLifecycle({ intent: pending, resolution: ambiguous });
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.exact_blocker, "web_operation_target_ambiguous");

  let unknown = admitWebOperationLifecycle({ lifecycle: createWebOperationLifecycle({ intent: pending, resolution: pendingResolution }), intent: intent() });
  unknown = dispatchWebOperationLifecycle({ lifecycle: unknown, intent: intent(), dispatch: dispatch(intent(), "unknown") });
  unknown = cleanupWebOperationLifecycle({ lifecycle: unknown, cleanupVerified: true });
  assert.equal(unknown.state, "effect_unknown");
  assert.equal(webOperationLifecycleReceipt(unknown).status, "blocked");
  assert.throws(() => dispatchWebOperationLifecycle({ lifecycle: unknown, intent: intent(), dispatch: dispatch(intent(), "executed") }), /web_operation_dispatch_not_admitted/);

  let noDispatch = admitWebOperationLifecycle({ lifecycle: createWebOperationLifecycle({ intent: intent(), resolution: resolveLiveSemanticTarget({ intent: intent(), candidates: [candidate()] }) }), intent: intent() });
  noDispatch = dispatchWebOperationLifecycle({ lifecycle: noDispatch, intent: intent(), dispatch: dispatch(intent(), "not_dispatched") });
  assert.equal(noDispatch.external_action_executed, false);
  assert.equal(noDispatch.exact_blocker, "web_operation_no_effect_dispatched");
});

test("semantic target matching tolerates descriptive labels but keeps target keys and href origins authoritative", () => {
  const descriptive = intent({ target: { semantic_query: "公開" } });
  const descriptiveCandidate = { ...candidate(), label: "新規投稿を公開" };
  const resolved = resolveLiveSemanticTarget({ intent: descriptive, candidates: [descriptiveCandidate] });
  assert.equal(resolved.status, "resolved");

  const ambiguous = resolveLiveSemanticTarget({
    intent: descriptive,
    candidates: [descriptiveCandidate, { ...candidate(), candidate_id: "publish-settings", label: "公開設定" }]
  });
  assert.equal(ambiguous.status, "blocked");
  assert.equal(ambiguous.exact_blocker, "web_operation_target_ambiguous");

  const keyed = intent({ target: { semantic_query: "公開", target_key: "publish-1" } });
  const keyedResolution = resolveLiveSemanticTarget({ intent: keyed, candidates: [{ ...candidate(), label: "別の表示名" }] });
  assert.equal(keyedResolution.status, "resolved");
  const missingKey = resolveLiveSemanticTarget({ intent: keyed, candidates: [{ ...candidate(), candidate_id: "other", label: "公開" }] });
  assert.equal(missingKey.status, "blocked");
  assert.equal(missingKey.exact_blocker, "web_operation_target_not_found");

  const crossOrigin = resolveLiveSemanticTarget({ intent: descriptive, candidates: [{ ...descriptiveCandidate, href: "https://evil.example/publish" }] });
  assert.equal(crossOrigin.status, "blocked");
  assert.equal(crossOrigin.exact_blocker, "web_operation_target_not_found");
  assert.throws(() => validateWebOperationIntent({ ...descriptive, allowed_origins: ["https://127.0.0.1"] }), /web_operation_origin_invalid/);
  const trailingSlashCandidate = { ...descriptiveCandidate, origin: "https://example.com/" };
  const trailingSlashResolution = resolveLiveSemanticTarget({ intent: descriptive, candidates: [trailingSlashCandidate] });
  assert.equal(trailingSlashResolution.status, "resolved");
  assert.doesNotThrow(() => createWebOperationLifecycle({ intent: descriptive, resolution: trailingSlashResolution }));
});

test("semantic target resolution can use live accessible names without adopting a fixed locator", () => {
  const operation = intent({ target: { semantic_query: "公開" } });
  const resolved = resolveLiveSemanticTarget({
    intent: operation,
    candidates: [{ ...candidate(), label: "ボタン", accessible_name: "公開" }]
  });
  assert.equal(resolved.status, "resolved");
});

test("web operation contract validates the complete operation model", () => {
  const contract = getWebOperationContract();
  assert.doesNotThrow(() => validateWebOperationContract(contract));
  assert.throws(() => validateWebOperationContract({ ...contract, operation_model: { ...contract.operation_model, target_resolution: "fixed_css_selector" } }), /web_operation_contract_operation_model_target_resolution_invalid/);
  assert.throws(() => validateWebOperationContract({ ...contract, fixed_kernel: { ...contract.fixed_kernel, unexpected_runtime_flag: true } }), /web_operation_contract_fixed_kernel_invalid/);
  assert.throws(() => validateWebOperationContract({ ...contract, operation_model: { ...contract.operation_model, exploration_limits: { ...contract.operation_model.exploration_limits, unexpected_limit: 1 } } }), /web_operation_contract_operation_model_exploration_limits_invalid/);
});

test("delete requires absent source state and duplicate reconciliation does not replay", () => {
  const operation = intent({ operation: "delete" });
  let lifecycle = admitWebOperationLifecycle({ lifecycle: createWebOperationLifecycle({ intent: operation, resolution: resolveLiveSemanticTarget({ intent: operation, candidates: [candidate()] }) }), intent: operation });
  lifecycle = dispatchWebOperationLifecycle({ lifecycle, intent: operation, dispatch: dispatch(operation, "executed") });
  lifecycle = reconcileWebOperationLifecycle({ lifecycle, intent: operation, readback: readback(operation, "effect_confirmed", "absent") });
  const duplicate = reconcileWebOperationLifecycle({ lifecycle, intent: operation, readback: readback(operation, "effect_confirmed", "absent") });
  assert.equal(lifecycle.state, "completed");
  assert.deepEqual(duplicate, lifecycle);
});

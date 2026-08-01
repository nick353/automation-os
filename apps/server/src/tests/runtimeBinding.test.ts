import assert from "node:assert/strict";
import test from "node:test";

const binding = await import("../serviceReadiness/runtimeBinding.js");

const base = {
  root_id: binding.deriveServiceReadinessRootId("run-runtime-1"),
  workflow_id: "daily-ai",
  run_id: "run-runtime-1",
  stage_id: "stage-read-only",
  attempt_id: "attempt-runtime-1",
  fencing_token: 1,
  effect_key: null,
  capability_id: null,
  iab_identity: null
} as const;

test("runtime binding is deterministic and safe-stops without IAB identity", () => {
  const first = binding.buildServiceReadinessRuntimeBindingV1(base);
  const second = binding.buildServiceReadinessRuntimeBindingV1(base);
  assert.deepEqual(first, second);
  assert.equal(first.status, "blocked");
  assert.equal(first.exact_blocker, "in_app_browser_runtime_unavailable");
  assert.equal(first.external_action_executed, false);
  assert.equal(binding.validateServiceReadinessRuntimeBindingV1(first).ok, true);
  assert.equal(binding.referenceWorkflowIdFromMetadata({ registeredWorkflowId: "daily-ai-research-publish-run" }), "daily-ai");
  assert.equal(binding.referenceWorkflowIdFromMetadata({ registered_workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest" }), "nisenprints");
});

test("runtime binding accepts a fresh identity only with a bound effect key and capability", () => {
  const identity = {
    generation: "generation-1",
    project_id: "automation-os",
    thread_id: "thread-1",
    session_id: "session-1",
    turn_id: "turn-1",
    nonce: "nonce-1",
    stage: base.stage_id,
    attempt: base.fencing_token
  };
  const effectKey = "a".repeat(64);
  const value = binding.buildServiceReadinessRuntimeBindingV1({
    ...base,
    effect_key: effectKey,
    capability_id: "capability-1",
    iab_identity: identity
  });
  assert.equal(value.status, "bound");
  assert.equal(value.exact_blocker, null);
  assert.equal(binding.parseServiceReadinessRuntimeBindingV1(value).effect_key, effectKey);
});

test("runtime binding rejects legacy markers and cross-run/fence/effect mismatches", () => {
  assert.throws(
    () => binding.buildServiceReadinessRuntimeBindingV1({ ...base, legacy_markers: { old_receipt: "receipt" } }),
    /iab_external_effect_capability_not_implemented:old_receipt/
  );
  const value = binding.buildServiceReadinessRuntimeBindingV1(base);
  assert.throws(
    () => binding.assertServiceReadinessRuntimeBindingMatches(value, { ...base, run_id: "run-other" }),
    /service_readiness_runtime_binding_mismatch:run_id/
  );
  assert.throws(
    () => binding.assertServiceReadinessRuntimeBindingMatches(value, { ...base, fencing_token: 2 }),
    /service_readiness_runtime_binding_mismatch:fencing_token/
  );
  assert.throws(
    () => binding.assertServiceReadinessRuntimeBindingMatches(value, { ...base, effect_key: "b".repeat(64) }),
    /service_readiness_runtime_binding_mismatch:effect_key/
  );
});

test("Browser Use runtime binding is a separate strict discriminator with same-run identity", () => {
  const value = binding.buildServiceReadinessBrowserUseRuntimeBindingV1({
    root_id: base.root_id,
    workflow_id: "daily-ai",
    run_id: base.run_id,
    stage_id: base.stage_id,
    attempt_id: base.attempt_id,
    authority_digest: "a".repeat(64),
    requested_session_id: "requested-session-1",
    effective_session_id: "effective-session-1",
    profile_root: "/Users/nichikatanaka/.codex/browser-use/profiles/scheduled/daily-ai",
    reserved_port: 19880,
    lock_path: "/Users/nichikatanaka/.codex/browser-use/locks/run-runtime-1.lock",
    process_identity: "pid:123",
    readback_status: "verified",
    mode: "authorized"
  });
  assert.equal(value.surface, "browser_use_cli");
  assert.equal(value.status, "bound");
  assert.equal(binding.parseServiceReadinessBrowserUseRuntimeBindingV1(value).effective_session_id, "effective-session-1");
  assert.equal(binding.validateServiceReadinessBrowserUseRuntimeBindingV1(value).ok, true);
  assert.throws(
    () => binding.buildServiceReadinessBrowserUseRuntimeBindingV1({
      root_id: base.root_id,
      workflow_id: "daily-ai",
      run_id: base.run_id,
      stage_id: base.stage_id,
      attempt_id: base.attempt_id,
      authority_digest: "a".repeat(64),
      requested_session_id: "requested-session-1",
      effective_session_id: "effective-session-1",
      profile_root: "/Users/nichikatanaka/.codex/browser-use/profiles/scheduled-evil/daily-ai",
      reserved_port: 19880,
      lock_path: "/Users/nichikatanaka/.codex/browser-use/locks/run-runtime-1.lock",
      process_identity: "pid:123",
      readback_status: "verified",
      mode: "authorized"
    }),
    /browser_use_profile_invalid/
  );
  assert.throws(
    () => binding.parseServiceReadinessBrowserUseRuntimeBindingV1({ ...value, surface: "in_app_browser" }),
    /browser_use_binding_surface_invalid/
  );
});

test("authorized Browser Use adapter contract is explicit and pure", () => {
  const expected = {
    run_id: base.run_id,
    stage_id: base.stage_id,
    attempt_id: base.attempt_id,
    session_id: "session-authorized-1",
    authority_digest: "a".repeat(64),
    allowed_origin: "https://example.com"
  };
  const contract = binding.buildServiceReadinessBrowserUseAuthorizedAdapterContractV1(expected);
  assert.equal(contract.schema, "browser_use_authorized_adapter_contract.v1");
  assert.equal(binding.validateServiceReadinessBrowserUseAuthorizedAdapterContractV1(contract, expected).ok, true);
  for (const field of [
    "authorized_scheduled_lifecycle",
    "structured_start_descriptor",
    "pre_open_descriptor_validation",
    "run_stage_attempt_session_binding",
    "authority_digest_binding",
    "allowed_origin_action_binding",
    "artifact_binding",
    "runtime_home_binding",
    "bounded_result_format"
  ] as const) assert.equal(contract[field], true);
  const negative = [
    { ...contract, run_id: "run-other" },
    { ...contract, stage_id: "stage-other" },
    { ...contract, attempt_id: "attempt-other" },
    { ...contract, session_id: "session-other" },
    { ...contract, allowed_origin: "https://other.example" },
    { ...contract, authority_digest: "b".repeat(64) },
    { ...contract, structured_start_descriptor: false },
    { ...contract, legacy_surface: "playwright" },
    { ...contract, browser_surface: "in_app_browser" }
  ];
  for (const value of negative) {
    const result = binding.validateServiceReadinessBrowserUseAuthorizedAdapterContractV1(value, expected);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.exact_blocker, "p6_authorized_browser_use_cli_adapter_contract_unverified");
  }
  const missing = binding.validateServiceReadinessBrowserUseAuthorizedAdapterContractV1(undefined, expected);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.exact_blocker, "p6_authorized_browser_use_cli_adapter_contract_unverified");
});

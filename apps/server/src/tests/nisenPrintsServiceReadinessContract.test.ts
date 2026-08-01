import assert from "node:assert/strict";
import test from "node:test";

import {
  NISEN_PRINTS_SERVICE_READINESS_SCHEMA_V1,
  NisenPrintsEffectLedgerV1,
  parseNisenPrintsServiceReadinessContractV1,
  validateNisenPrintsServiceReadinessContractV1
} from "../serviceReadiness/workflowContracts/nisenPrints.js";

const hashes = {
  target: "a".repeat(64),
  asset: "b".repeat(64),
  pinterest: "c".repeat(64),
  provider: "d".repeat(64),
  cleanup: "e".repeat(64)
};

function baseContract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: NISEN_PRINTS_SERVICE_READINESS_SCHEMA_V1,
    root_id: "root-nisenprints",
    workflow_id: "nisenprints-workflow",
    run_id: "run-20260722-01",
    stage_id: "publish",
    attempt_id: "attempt-1",
    fencing_token: 1,
    capability_id: "capability-1",
    turn_id: "turn-1",
    session_id: "session-1",
    nonce: "nonce-1",
    capability_mode: "external",
    status: "succeeded",
    effect_class: "external_non_idempotent",
    store: "etsy",
    account_ref: "shop-a",
    mode: "full_publish",
    product_listing_target_hash: hashes.target,
    asset_media_hash: hashes.asset,
    pinterest_board_target_hash: hashes.pinterest,
    provider: "etsy",
    provider_receipt_hash: hashes.provider,
    effect_key: "nisenprints:etsy:listing-1",
    external_action_executed: true,
    duplicate_lock_key: "listing:listing-1:pin:pin-1",
    cleanup_receipt_hash: hashes.cleanup,
    exact_blocker: null,
    safe_restart: null,
    ...overrides
  };
}

test("accepts a complete full-publish contract and preserves target/media proofs", () => {
  const parsed = parseNisenPrintsServiceReadinessContractV1(baseContract());
  assert.equal(parsed.mode, "full_publish");
  assert.equal(parsed.product_listing_target_hash, hashes.target);
  assert.equal(parsed.asset_media_hash, hashes.asset);
  assert.equal(parsed.pinterest_board_target_hash, hashes.pinterest);
  assert.equal(parsed.provider_receipt_hash, hashes.provider);
});

test("accepts Etsy sync without an external effect or Pinterest target", () => {
  const parsed = parseNisenPrintsServiceReadinessContractV1(baseContract({
    mode: "etsy_sync",
    capability_mode: "read_only",
    effect_class: "internal_idempotent",
    status: "succeeded",
    provider: "etsy",
    provider_receipt_hash: null,
    pinterest_board_target_hash: null,
    external_action_executed: false,
    cleanup_receipt_hash: hashes.cleanup
  }));
  assert.equal(parsed.mode, "etsy_sync");
  assert.equal(parsed.external_action_executed, false);
  assert.equal(parsed.pinterest_board_target_hash, null);
});

test("accepts Printify recovery without a Pinterest target", () => {
  const parsed = parseNisenPrintsServiceReadinessContractV1(baseContract({
    mode: "printify_recovery",
    store: "printify",
    provider: "printify",
    status: "running",
    effect_class: "external_non_idempotent",
    provider_receipt_hash: null,
    pinterest_board_target_hash: null,
    external_action_executed: false,
    cleanup_receipt_hash: null
  }));
  assert.equal(parsed.status, "running");
  assert.equal(parsed.pinterest_board_target_hash, null);
});

test("requires a Pinterest board/target hash for full publish", () => {
  const result = validateNisenPrintsServiceReadinessContractV1(baseContract({ pinterest_board_target_hash: null }));
  assert.deepEqual(result, {
    ok: false,
    status: "blocked",
    exact_blocker: "nisenprints_full_publish_pinterest_target_required"
  });
});

test("requires a provider receipt for a confirmed external publish", () => {
  const result = validateNisenPrintsServiceReadinessContractV1(baseContract({ provider_receipt_hash: null }));
  assert.deepEqual(result, {
    ok: false,
    status: "blocked",
    exact_blocker: "service_readiness_external_success_provider_receipt_required"
  });
});

test("blocks Printify auth and reauth before any provider effect", () => {
  for (const blocker of ["printify_auth_required", "printify_reauth_required"]) {
    const parsed = parseNisenPrintsServiceReadinessContractV1(baseContract({
      mode: "printify_recovery",
      store: "printify",
      provider: "printify",
      status: "blocked",
      effect_class: "external_non_idempotent",
      provider_receipt_hash: null,
      pinterest_board_target_hash: null,
      external_action_executed: false,
      cleanup_receipt_hash: hashes.cleanup,
      exact_blocker: blocker,
      safe_restart: "reauth_printify_then_reconcile"
    }));
    assert.equal(parsed.exact_blocker, blocker);
    assert.equal(parsed.external_action_executed, false);
  }
  const result = validateNisenPrintsServiceReadinessContractV1(baseContract({
    mode: "printify_recovery",
    store: "printify",
    provider: "printify",
    status: "blocked",
    pinterest_board_target_hash: null,
    exact_blocker: "printify_auth_required",
    safe_restart: "reauth_printify",
    cleanup_receipt_hash: hashes.cleanup,
    provider_receipt_hash: hashes.provider
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.exact_blocker, "nisenprints_printify_auth_required_before_provider_effect");
});

test("normalizes an ambiguous provider result to reconciliation_required", () => {
  const parsed = parseNisenPrintsServiceReadinessContractV1(baseContract({
    status: "ambiguous",
    provider_receipt_hash: null,
    cleanup_receipt_hash: hashes.cleanup,
    exact_blocker: "provider_submit_readback_ambiguous",
    safe_restart: "reconcile_provider_receipt"
  }));
  assert.equal(parsed.status, "reconciliation_required");
});

test("rejects unknown fields and malformed hashes", () => {
  assert.throws(
    () => parseNisenPrintsServiceReadinessContractV1(baseContract({ unexpected: true })),
    /nisenprints_unknown_field:unexpected/
  );
  assert.throws(
    () => parseNisenPrintsServiceReadinessContractV1(baseContract({ asset_media_hash: "not-a-sha256" })),
    /service_readiness_payload_hash_invalid/
  );
});

test("rejects duplicate effect and listing/pin lock keys in the bounded ledger", () => {
  const ledger = new NisenPrintsEffectLedgerV1();
  const first = parseNisenPrintsServiceReadinessContractV1(baseContract(), { ledger });
  assert.equal(ledger.has(first.effect_key), true);
  const replay = validateNisenPrintsServiceReadinessContractV1(baseContract({
    effect_key: "nisenprints:etsy:listing-2",
    duplicate_lock_key: first.duplicate_lock_key
  }), { ledger });
  assert.deepEqual(replay, {
    ok: false,
    status: "blocked",
    exact_blocker: `nisenprints_duplicate_listing_or_pin_forbidden:${first.duplicate_lock_key}`
  });
  const effectReplay = validateNisenPrintsServiceReadinessContractV1(baseContract(), { ledger });
  assert.deepEqual(effectReplay, {
    ok: false,
    status: "blocked",
    exact_blocker: `nisenprints_effect_replay_forbidden:${first.effect_key}`
  });
});

test("enforces the configured effect-ledger bound", () => {
  const ledger = new NisenPrintsEffectLedgerV1(1);
  parseNisenPrintsServiceReadinessContractV1(baseContract(), { ledger });
  const result = validateNisenPrintsServiceReadinessContractV1(baseContract({
    effect_key: "nisenprints:etsy:listing-2",
    duplicate_lock_key: "listing:listing-2:pin:pin-2"
  }), { ledger });
  assert.deepEqual(result, {
    ok: false,
    status: "blocked",
    exact_blocker: "nisenprints_effect_ledger_bound_exceeded"
  });
});

test("matches an expected cleanup receipt before accepting terminal evidence", () => {
  const result = validateNisenPrintsServiceReadinessContractV1(baseContract(), {
    expected_cleanup_receipt_hash: "f".repeat(64)
  });
  assert.deepEqual(result, {
    ok: false,
    status: "blocked",
    exact_blocker: "service_readiness_cleanup_receipt_hash_mismatch"
  });
});

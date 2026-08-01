import assert from "node:assert/strict";
import test from "node:test";

import {
  ServiceReadinessContractError,
  ServiceReadinessEffectLedgerV1,
  parseServiceReadinessEvidenceV1,
  validateServiceReadinessEvidenceV1,
  type ServiceReadinessEvidenceV1
} from "../serviceReadiness/foundationContracts.js";

const hashes = {
  target: "a".repeat(64),
  payload: "b".repeat(64),
  provider: "c".repeat(64),
  cleanup: "d".repeat(64)
};

function baseEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "service_readiness.evidence.v1",
    root_id: "root-company-a",
    workflow_id: "daily-ai",
    run_id: "run-20260722-01",
    stage_id: "publish",
    attempt_id: "attempt-1",
    fencing_token: 1,
    capability_id: "capability-1",
    turn_id: "turn-1",
    session_id: "session-1",
    nonce: "nonce-1",
    capability_mode: "external",
    provider: "linkedin",
    account_ref: "account-page-a",
    target_hash: hashes.target,
    payload_hash: hashes.payload,
    effect_key: "linkedin:account-page-a:publish:payload-b",
    effect_class: "external_non_idempotent",
    status: "succeeded",
    external_action_executed: true,
    provider_receipt_hash: hashes.provider,
    cleanup_receipt_hash: hashes.cleanup,
    exact_blocker: null,
    safe_resume_step: null,
    ...overrides
  };
}

function identityOf(evidence: ServiceReadinessEvidenceV1) {
  return {
    root_id: evidence.root_id,
    workflow_id: evidence.workflow_id,
    run_id: evidence.run_id,
    stage_id: evidence.stage_id,
    attempt_id: evidence.attempt_id,
    fencing_token: evidence.fencing_token,
    capability_id: evidence.capability_id,
    turn_id: evidence.turn_id,
    session_id: evidence.session_id,
    nonce: evidence.nonce
  };
}

test("parses a valid external terminal evidence record", () => {
  const parsed = parseServiceReadinessEvidenceV1(baseEvidence());
  assert.equal(parsed.schema, "service_readiness.evidence.v1");
  assert.equal(parsed.status, "succeeded");
  assert.equal(parsed.external_action_executed, true);
  assert.equal(parsed.cleanup_receipt_hash, hashes.cleanup);
});

test("rejects a cross-binding identity mismatch", () => {
  const parsed = parseServiceReadinessEvidenceV1(baseEvidence());
  assert.throws(
    () => parseServiceReadinessEvidenceV1(baseEvidence({ run_id: "run-other" }), { expected_identity: identityOf(parsed) }),
    (error: unknown) => error instanceof ServiceReadinessContractError && error.code === "service_readiness_identity_mismatch:run_id"
  );
});

test("rejects duplicate and replayed effect keys through the bounded ledger", () => {
  const ledger = new ServiceReadinessEffectLedgerV1();
  const first = parseServiceReadinessEvidenceV1(baseEvidence(), { ledger });
  assert.equal(ledger.has(first.effect_key), true);
  assert.deepEqual(ledger.get(first.effect_key), first);
  const replay = validateServiceReadinessEvidenceV1(baseEvidence(), { ledger });
  assert.deepEqual(replay, {
    ok: false,
    status: "blocked",
    exact_blocker: `service_readiness_effect_replay_forbidden:${first.effect_key}`
  });
});

test("normalizes ambiguous external outcomes to reconciliation_required", () => {
  const parsed = parseServiceReadinessEvidenceV1(baseEvidence({
    status: "ambiguous",
    provider_receipt_hash: null,
    cleanup_receipt_hash: hashes.cleanup,
    exact_blocker: "provider_submit_readback_ambiguous",
    safe_resume_step: "reconcile_provider_receipt"
  }));
  assert.equal(parsed.status, "reconciliation_required");
  assert.equal(parsed.exact_blocker, "provider_submit_readback_ambiguous");
});

test("rejects a cleanup receipt hash that does not match the expected receipt", () => {
  assert.throws(
    () => parseServiceReadinessEvidenceV1(baseEvidence(), { expected_cleanup_receipt_hash: "e".repeat(64) }),
    (error: unknown) => error instanceof ServiceReadinessContractError && error.code === "service_readiness_cleanup_receipt_hash_mismatch"
  );
});

test("rejects malformed target, payload, and receipt hashes", () => {
  for (const [field, value] of [
    ["target_hash", "A".repeat(64)],
    ["payload_hash", "not-a-sha256"],
    ["provider_receipt_hash", "f".repeat(63)]
  ] as const) {
    assert.throws(
      () => parseServiceReadinessEvidenceV1(baseEvidence({ [field]: value })),
      ServiceReadinessContractError
    );
  }
});

test("read-only capabilities cannot claim an external action", () => {
  const result = validateServiceReadinessEvidenceV1(baseEvidence({
    capability_mode: "read_only",
    external_action_executed: true
  }));
  assert.deepEqual(result, {
    ok: false,
    status: "blocked",
    exact_blocker: "service_readiness_read_only_external_action_forbidden"
  });
});

test("rejects unknown fields and terminal evidence without cleanup", () => {
  assert.throws(
    () => parseServiceReadinessEvidenceV1(baseEvidence({ unexpected: true })),
    /service_readiness_unknown_field:unexpected/
  );
  assert.throws(
    () => parseServiceReadinessEvidenceV1(baseEvidence({ cleanup_receipt_hash: null })),
    /service_readiness_terminal_cleanup_required/
  );
});

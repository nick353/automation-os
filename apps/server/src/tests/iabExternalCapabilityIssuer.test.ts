import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { computeServiceReadinessEffectKey } from "../serviceReadiness/effectLedger.js";
import {
  createRootOwnedIabExternalCapabilityIssuerV1
} from "../serviceReadiness/iabExternalCapabilityIssuer.js";
import { signIabExternalCapabilityV1 } from "../serviceReadiness/iabExternalCapability.js";
import type { IabExternalExecutorBindingV1 } from "../serviceReadiness/iabExternalExecutor.js";

process.env.AUTOMATION_OS_IAB_CAPABILITY_SECRET = "test-only-iab-capability-secret-20260724-32-bytes";
const nowMs = Date.parse("2029-01-01T00:00:00.000Z");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function binding(): IabExternalExecutorBindingV1 {
  const targetHash = sha("target");
  const payloadHash = sha("payload");
  return {
    company_id: "company-issuer",
    service_user_id: "service-issuer",
    issuer_service_user_id: "service-issuer",
    iab_generation: "generation-issuer",
    iab_project_id: "project-issuer",
    iab_thread_id: "thread-issuer",
    job_id: "job-issuer",
    action_kind: "publish",
    policy_version: "policy-v1",
    manifest_hash: sha("manifest"),
    root_id: "root-issuer",
    workflow_id: "daily-ai",
    run_id: "run-issuer",
    stage_id: "publish",
    attempt_id: "attempt-issuer",
    fencing_token: 1,
    capability_id: "capability-issuer",
    turn_id: "turn-issuer",
    session_id: "session-issuer",
    nonce: "nonce-issuer",
    provider: "linkedin",
    account_ref: "account-issuer",
    target_hash: targetHash,
    payload_hash: payloadHash,
    effect_key: computeServiceReadinessEffectKey({
      company_id: "company-issuer",
      provider: "linkedin",
      account_ref: "account-issuer",
      target_hash: targetHash,
      payload_hash: payloadHash,
      effect_class: "external_non_idempotent"
    }),
    approval_id: "approval-issuer",
    approval_revision: 1,
    approval_payload_hash: payloadHash
  };
}

const identity = {
  generation: "generation-issuer",
  project_id: "project-issuer",
  thread_id: "thread-issuer",
  session_id: "session-issuer",
  turn_id: "turn-issuer",
  nonce: "nonce-issuer",
  stage: "publish",
  attempt: 1
} as const;

test("root issuer signs only a fresh runtime identity and returns a validated capability", async () => {
  const issuer = createRootOwnedIabExternalCapabilityIssuerV1({
    readCurrentIdentity: async () => identity
  });
  const result = await issuer.issue(binding(), nowMs);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.capability.iab_identity, identity);
  assert.equal(result.capability.external_action_executed, false);
  assert.equal(Date.parse(result.capability.expires_at) - Date.parse(result.capability.issued_at), 4 * 60 * 1000);
});

test("root issuer rejects caller/runtime identity drift before issuing", async () => {
  const issuer = createRootOwnedIabExternalCapabilityIssuerV1({
    readCurrentIdentity: async () => ({ ...identity, turn_id: "foreign-turn" })
  });
  const result = await issuer.issue(binding(), nowMs);
  assert.deepEqual(result, {
    ok: false,
    status: "blocked",
    exact_blocker: "iab_external_capability_issuer_identity_mismatch:turn_id"
  });
});

test("issuer preserves runtime-unavailable exact blocker and never fabricates a capability", async () => {
  const issuer = createRootOwnedIabExternalCapabilityIssuerV1({
    readCurrentIdentity: async () => { throw new Error("trusted_current_turn_iab_runtime_not_available"); }
  });
  const result = await issuer.issue(binding(), nowMs);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.exact_blocker, "trusted_current_turn_iab_runtime_not_available");
});

test("injected signer lets a secret-manager boundary own the signing key", async () => {
  let signed = false;
  const issuer = createRootOwnedIabExternalCapabilityIssuerV1({
    readCurrentIdentity: async () => identity,
    sign(value) {
      signed = true;
      return signIabExternalCapabilityV1(value);
    }
  });
  const result = await issuer.issue(binding(), nowMs);
  assert.equal(result.ok, true);
  assert.equal(signed, true);
});

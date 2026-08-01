import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { computeServiceReadinessEffectKey } from "../serviceReadiness/effectLedger.js";
import type { IabExternalCapabilityV1 } from "../serviceReadiness/iabExternalCapability.js";

process.env.AUTOMATION_OS_IAB_CAPABILITY_SECRET = "test-only-iab-capability-secret-20260724-32-bytes";
const capabilityModule = await import("../serviceReadiness/iabExternalCapability.js");
const {
  IAB_EXTERNAL_CAPABILITY_EXECUTOR_BLOCKER,
  IAB_EXTERNAL_CAPABILITY_SCHEMA_V1,
  signIabExternalCapabilityV1,
  validateIabExternalCapabilityV1
} = capabilityModule;

const now = Date.parse("2026-07-22T00:00:00.000Z");
const targetHash = createHash("sha256").update("target").digest("hex");
const payloadHash = createHash("sha256").update("payload").digest("hex");
const effectKey = computeServiceReadinessEffectKey({
  company_id: "company-1",
  provider: "linkedin",
  account_ref: "account-linkedin-1",
  target_hash: targetHash,
  payload_hash: payloadHash,
  effect_class: "external_non_idempotent"
});

function capability(overrides: Record<string, unknown> = {}) {
  const body: Omit<IabExternalCapabilityV1, "capability_mac"> = {
    schema: IAB_EXTERNAL_CAPABILITY_SCHEMA_V1,
    surface: "in_app_browser",
    company_id: "company-1",
    root_id: "root_service",
    issuer_service_user_id: "service-1",
    manifest_hash: "f".repeat(64),
    workflow_id: "daily-ai",
    run_id: "run_1",
    stage_id: "publish",
    attempt_id: "attempt_1",
    fencing_token: 1,
    capability_id: "cap_1",
    turn_id: "turn_1",
    session_id: "session_1",
    nonce: "nonce_1",
    iab_identity: {
      generation: "generation_1",
      project_id: "project_1",
      thread_id: "thread_1",
      session_id: "session_1",
      turn_id: "turn_1",
      nonce: "nonce_1",
      stage: "publish",
      attempt: 1
    },
    capability_mode: "external",
    effect_class: "external_non_idempotent",
    effect_key: effectKey,
    provider: "linkedin",
    account_ref: "account-linkedin-1",
    target_hash: targetHash,
    payload_hash: payloadHash,
    approval_id: "approval_1",
    approval_revision: 1,
    approval_payload_hash: payloadHash,
    issued_at: "2026-07-22T00:00:00.000Z",
    expires_at: "2026-07-22T00:04:00.000Z",
    external_action_executed: false,
    legacy_surfaces_forbidden: true,
    prior_receipt_reuse: false,
    ...overrides
  };
  return signIabExternalCapabilityV1(body);
}

function blocker(overrides: Record<string, unknown>, expected: string): void {
  const result = validateIabExternalCapabilityV1(capability(overrides), now);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.exact_blocker, expected);
}

test("validates a fresh approved external capability without granting execution", () => {
  const result = validateIabExternalCapabilityV1(capability(), now);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "validated");
  assert.equal(result.value.capability_mode, "external");
  assert.equal(result.value.external_action_executed, false);
  assert.equal(IAB_EXTERNAL_CAPABILITY_EXECUTOR_BLOCKER, "iab_external_effect_capability_not_implemented");
});

test("binds approval payload, provider effect key, and fresh IAB identity", () => {
  blocker({ approval_payload_hash: targetHash }, "iab_external_capability_approval_payload_hash_mismatch");
  blocker({ effect_key: "a".repeat(64) }, "iab_external_capability_effect_key_binding_mismatch");
  blocker({ iab_identity: { ...capability().iab_identity, attempt: 2 } }, "iab_external_capability_fencing_token_mismatch");
});

test("fails closed on expiry, stale legacy markers, and action claims", () => {
  blocker({ issued_at: "2026-07-21T23:55:00.000Z", expires_at: "2026-07-21T23:59:00.000Z" }, "iab_external_capability_expired");
  blocker({ prior_receipt_reuse: true }, "iab_external_capability_prior_receipt_reuse_forbidden");
  blocker({ external_action_executed: true }, "iab_external_capability_external_action_forbidden");
  const unknown = validateIabExternalCapabilityV1({ ...capability(), unexpected: true }, now);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.exact_blocker, "iab_external_capability_unknown_field:unexpected");
});

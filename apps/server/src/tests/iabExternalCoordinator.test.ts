import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { computeServiceReadinessEffectKey } from "../serviceReadiness/effectLedger.js";
import { createRootOwnedIabExternalCapabilityIssuerV1 } from "../serviceReadiness/iabExternalCapabilityIssuer.js";
import { createRootOwnedIabExternalCoordinatorV1 } from "../serviceReadiness/iabExternalCoordinator.js";
import type { IabExternalExecutorBindingV1, RootOwnedIabExternalAtomicGateV1, RootOwnedIabExternalRuntimeV1 } from "../serviceReadiness/iabExternalExecutor.js";

process.env.AUTOMATION_OS_IAB_CAPABILITY_SECRET = "test-only-iab-capability-secret-20260724-32-bytes";
const nowMs = Date.parse("2029-01-01T00:00:00.000Z");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function binding(): IabExternalExecutorBindingV1 {
  const targetHash = sha("coordinator-target");
  const payloadHash = sha("coordinator-payload");
  return {
    company_id: "company-coordinator",
    service_user_id: "service-coordinator",
    issuer_service_user_id: "service-coordinator",
    iab_generation: "generation-coordinator",
    iab_project_id: "project-coordinator",
    iab_thread_id: "thread-coordinator",
    job_id: "job-coordinator",
    action_kind: "publish",
    policy_version: "policy-v1",
    manifest_hash: sha("manifest-coordinator"),
    root_id: "root-coordinator",
    workflow_id: "daily-ai",
    run_id: "run-coordinator",
    stage_id: "publish",
    attempt_id: "attempt-coordinator",
    fencing_token: 1,
    capability_id: "capability-coordinator",
    turn_id: "turn-coordinator",
    session_id: "session-coordinator",
    nonce: "nonce-coordinator",
    provider: "linkedin",
    account_ref: "account-coordinator",
    target_hash: targetHash,
    payload_hash: payloadHash,
    effect_key: computeServiceReadinessEffectKey({ company_id: "company-coordinator", provider: "linkedin", account_ref: "account-coordinator", target_hash: targetHash, payload_hash: payloadHash, effect_class: "external_non_idempotent" }),
    approval_id: "approval-coordinator",
    approval_revision: 1,
    approval_payload_hash: payloadHash
  };
}

const identity = {
  generation: "generation-coordinator",
  project_id: "project-coordinator",
  thread_id: "thread-coordinator",
  session_id: "session-coordinator",
  turn_id: "turn-coordinator",
  nonce: "nonce-coordinator",
  stage: "publish",
  attempt: 1
} as const;

test("coordinator fails closed before runtime acquisition when approval readback is not current", async () => {
  let runtimeAcquired = false;
  let approvalRead = 0;
  const issuer = createRootOwnedIabExternalCapabilityIssuerV1({ readCurrentIdentity: async () => identity });
  const runtime: RootOwnedIabExternalRuntimeV1 = {
    async acquire() {
      runtimeAcquired = true;
      throw new Error("should_not_acquire");
    }
  };
  const gate: RootOwnedIabExternalAtomicGateV1 = {
    async assertApproval() {
      approvalRead += 1;
      throw new Error("iab_external_approval_readback_not_found");
    },
    async reserveAndConsume() { throw new Error("should_not_reserve"); },
    async transition() { throw new Error("should_not_transition"); }
  };
  const coordinator = createRootOwnedIabExternalCoordinatorV1({
    issuer,
    runtime,
    atomic_gate: gate,
    admission: { release_admission: "approved", workflow_status: "active", account_status: "verified", external_execution_authorized: true }
  });
  const result = await coordinator.execute({ binding: binding(), now_ms: nowMs });
  assert.equal(result.status, "blocked");
  assert.equal(result.exact_blocker, "iab_external_approval_readback_not_found");
  assert.equal(approvalRead, 1);
  assert.equal(runtimeAcquired, false);
});

test("coordinator constructor refuses activation without the release admission", () => {
  const issuer = createRootOwnedIabExternalCapabilityIssuerV1({ readCurrentIdentity: async () => identity });
  const runtime = {} as RootOwnedIabExternalRuntimeV1;
  const gate = {} as RootOwnedIabExternalAtomicGateV1;
  assert.throws(() => createRootOwnedIabExternalCoordinatorV1({
    issuer,
    runtime,
    atomic_gate: gate,
    admission: { release_admission: "approved", workflow_status: "paused" as never, account_status: "verified", external_execution_authorized: true }
  }), /canonical_registered_workflow_not_active/);
});

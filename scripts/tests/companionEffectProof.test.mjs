import assert from "node:assert/strict";
import test from "node:test";
import {
  signCompanionOperationEffectProof,
  verifyCompanionOperationEffectProof,
} from "../lib/companion-effect-proof.mjs";

test("AOS accepts only a signed Companion no-effect proof for source resume", () => {
  const secret = "shared-companion-proof-secret";
  const proof = signCompanionOperationEffectProof({
    taskId: "source-thread",
    runId: "run-1",
    ownerKey: "session-1",
    sessionId: "session-1",
    leaseId: null,
    generation: "gen-1",
    profileInstanceId: "profile-1",
    targetIdentity: {
      schema: "aos.chrome_companion.target_identity.v1",
      taskId: "source-thread",
      sessionId: "session-1",
      leaseId: null,
      generation: "gen-1",
      profileInstanceId: "profile-1",
      tabId: null,
      pageInstanceId: null,
      windowId: null,
      frameId: 0,
      origin: null,
    },
    operationId: null,
    idempotencyKey: "resume-proof-1",
    method: "task.prepare_resume",
    dispatchCount: 0,
    effectState: "no_dispatch",
    externalActionExecuted: false,
    mutationDispatchAttempted: false,
    cleanup: { state: "not_required", tabClosed: false },
    capabilityDigest: null,
    resultDigest: null,
    issuedAt: new Date().toISOString(),
    nonce: "proof-nonce-1",
  }, secret);
  const accepted = verifyCompanionOperationEffectProof(proof, {
    secret,
    expected: { taskId: "source-thread", runId: "run-1" },
  });
  assert.equal(accepted.effectState, "no_dispatch");
  assert.throws(() => verifyCompanionOperationEffectProof({ ...proof, externalActionExecuted: true }, {
    secret,
    expected: { taskId: "source-thread" },
  }), /signature_invalid|external_effect_present/u);
});

import crypto from "node:crypto";

export const COMPANION_EFFECT_PROOF_SCHEMA = "aos.chrome_companion.operation_effect_proof.v1";
export const COMPANION_EFFECT_STATES = Object.freeze([
  "no_dispatch",
  "known_no_effect",
  "known_effect",
  "unknown_effect",
]);

function canonical(value, context = "root") {
  if (value === undefined) return context === "object_value" ? undefined : "null";
  if (value === null || typeof value !== "object") {
    const rendered = JSON.stringify(value);
    return rendered === undefined ? (context === "object_value" ? undefined : "null") : rendered;
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, "array_item")).join(",")}]`;
  const fields = [];
  for (const key of Object.keys(value).sort()) {
    const rendered = canonical(value[key], "object_value");
    if (rendered !== undefined) fields.push(`${JSON.stringify(key)}:${rendered}`);
  }
  return `{${fields.join(",")}}`;
}

// The bridge's shared payload domain is intentionally kept as a small
// constant here so AOS can verify the proof without importing runtime code.
function bridgeDigest(secret, payload) {
  return crypto.createHmac("sha256", String(secret))
    .update(`aos.chrome_companion.payload.v1\0${canonical(payload)}`, "utf8")
    .digest("base64url");
}

function text(value, max = 512) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function normalizedProof(proof) {
  const source = proof && typeof proof === "object" && !Array.isArray(proof) ? proof : {};
  return {
    schema: source.schema ?? null,
    ownerKey: text(source.ownerKey),
    taskId: text(source.taskId),
    runId: text(source.runId),
    sessionId: text(source.sessionId),
    leaseId: text(source.leaseId),
    generation: text(source.generation),
    profileInstanceId: text(source.profileInstanceId),
    targetIdentity: source.targetIdentity && typeof source.targetIdentity === "object" ? source.targetIdentity : null,
    operationId: text(source.operationId),
    idempotencyKey: text(source.idempotencyKey),
    method: text(source.method),
    dispatchCount: Number.isSafeInteger(source.dispatchCount) ? source.dispatchCount : 0,
    effectState: COMPANION_EFFECT_STATES.includes(source.effectState) ? source.effectState : null,
    externalActionExecuted: source.externalActionExecuted === null ? null : source.externalActionExecuted === true,
    mutationDispatchAttempted: source.mutationDispatchAttempted === true,
    cleanup: source.cleanup && typeof source.cleanup === "object" ? source.cleanup : { state: "unknown", tabClosed: false },
    capabilityDigest: text(source.capabilityDigest, 128),
    resultDigest: text(source.resultDigest, 128),
    issuedAt: text(source.issuedAt, 64),
    nonce: text(source.nonce, 128),
  };
}

/**
 * Verify a Companion proof using the shared issuer/ledger secret.  This is a
 * structural acceptance check only; it never grants browser or provider
 * authority.  Unknown effects are intentionally rejected as a source-resume
 * proof because they still require reconciliation.
 */
export function verifyCompanionOperationEffectProof(proof, {
  secret,
  expected = {},
  allowKnownEffect = false,
} = {}) {
  if (!String(secret || "")) throw new Error("companion_effect_proof_secret_required");
  if (!proof || typeof proof !== "object" || proof.schema !== COMPANION_EFFECT_PROOF_SCHEMA) {
    throw new Error("companion_effect_proof_schema_invalid");
  }
  const { signature, ...rawPayload } = proof;
  const payload = normalizedProof(rawPayload);
  if (!payload.taskId || !payload.runId || !payload.ownerKey || !payload.sessionId || !payload.idempotencyKey || !payload.method) {
    throw new Error("companion_effect_proof_binding_required");
  }
  if (!COMPANION_EFFECT_STATES.includes(payload.effectState)) throw new Error("companion_effect_proof_effect_state_invalid");
  if (payload.effectState === "unknown_effect" || (payload.effectState === "known_effect" && !allowKnownEffect)) {
    throw new Error("companion_effect_proof_not_no_effect");
  }
  if (payload.externalActionExecuted !== false || payload.mutationDispatchAttempted !== false) {
    throw new Error("companion_effect_proof_external_effect_present");
  }
  for (const field of ["taskId", "runId", "ownerKey", "sessionId", "leaseId", "generation", "profileInstanceId", "idempotencyKey", "method", "effectState", "dispatchCount"]) {
    if (expected[field] !== undefined && expected[field] !== null && payload[field] !== expected[field]) {
      throw new Error(`companion_effect_proof_${field}_mismatch`);
    }
  }
  if (expected.targetIdentity && canonical(payload.targetIdentity) !== canonical(expected.targetIdentity)) {
    throw new Error("companion_effect_proof_target_identity_mismatch");
  }
  const provided = typeof signature === "string" ? signature : "";
  // Bridge proofs use this exact payload-domain prefix. Keep the alias above
  // for diagnostics while the verifier calls the canonical bridge function.
  const expectedSignature = bridgeDigest(secret, payload);
  if (!provided || provided.length !== expectedSignature.length
    || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expectedSignature))) {
    throw new Error("companion_effect_proof_signature_invalid");
  }
  const issuedAt = Date.parse(payload.issuedAt ?? "");
  if (!Number.isFinite(issuedAt) || issuedAt > Date.now() + 60_000) throw new Error("companion_effect_proof_time_invalid");
  return payload;
}

/** Test/helper signer with the same payload shape as the bridge. */
export function signCompanionOperationEffectProof(input, secret) {
  if (!String(secret || "")) throw new Error("companion_effect_proof_secret_required");
  const payload = { ...normalizedProof(input), schema: COMPANION_EFFECT_PROOF_SCHEMA };
  return { ...payload, signature: bridgeDigest(secret, payload) };
}

export { bridgeDigest as companionEffectProofDigest };

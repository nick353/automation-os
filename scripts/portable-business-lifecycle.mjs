import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const PORTABLE_BUSINESS_WEB_OPERATION_LIFECYCLE_SCHEMA = "automation_os_web_operation_lifecycle.v1";

const HASH = /^[a-f0-9]{64}$/u;
const ZERO_HASH = "0".repeat(64);

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/**
 * Read only the public binding fields of the AOS-issued effect authority.
 * The child runner must never copy the authority file into its receipt.
 */
export function readPortableBusinessEffectAuthority(input, environment = process.env) {
  const rawFile = String(environment.AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH || "").trim();
  const file = rawFile ? path.resolve(rawFile) : "";
  const expectedSha256 = String(environment.AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256 || "");
  if (!rawFile || !file || !fs.existsSync(file) || !HASH.test(expectedSha256)) throw new Error("portable_external_effect_authority_missing");
  const bytes = fs.readFileSync(file);
  if (digest(bytes) !== expectedSha256) throw new Error("portable_external_effect_authority_digest_invalid");
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("portable_external_effect_authority_invalid"); }
  const authority = safeRecord(value);
  if (!authority
    || authority.schema !== "automation_os_portable_external_effect_authority.v1"
    || authority.issued_by !== "automation_os_portable_controller"
    || !String(authority.authority_id || "")
    || authority.workflow_id !== input.workflow_id
    || authority.run_id !== input.run_id
    || authority.step_id !== input.step_id
    || authority.idempotency_key !== input.idempotency_key
    || authority.approval_status !== "approved"
    || authority.external_action_authorized !== true
    || Date.parse(String(authority.expires_at || "")) <= Date.now()
    || !HASH.test(String(authority.target_digest || ""))
    || (authority.payload_hash !== null && authority.payload_hash !== undefined && !HASH.test(String(authority.payload_hash)))) {
    throw new Error("portable_external_effect_authority_binding_invalid");
  }
  return {
    authority_id: String(authority.authority_id || ""),
    target_digest: String(authority.target_digest),
    payload_hash: authority.payload_hash === null || authority.payload_hash === undefined ? null : String(authority.payload_hash),
    authority_sha256: expectedSha256,
  };
}

/**
 * Build the child-side proof consumed by aos-portable-business-runner.mjs.
 * A clean lifecycle is emitted only when the effect, same-run receipt,
 * source readback, and cleanup are all independently observed.
 */
export function buildPortableBusinessWebOperationLifecycle(input) {
  const authority = safeRecord(input.authority);
  const externalActionExecuted = input.external_action_executed === true;
  const sameRunReceipt = input.same_run_receipt === true;
  const readbackVerified = input.readback_verified === true;
  const cleanupVerified = input.cleanup_verified === true;
  const sourceStateDigest = HASH.test(String(input.source_state_digest || ""))
    ? String(input.source_state_digest)
    : ZERO_HASH;
  const complete = externalActionExecuted
    && sameRunReceipt
    && readbackVerified
    && cleanupVerified
    && Boolean(authority && HASH.test(String(authority.target_digest || "")))
    && (authority?.payload_hash === null || authority?.payload_hash === undefined || HASH.test(String(authority.payload_hash)))
    && sourceStateDigest !== ZERO_HASH
    && !input.exact_blocker;
  const exactBlocker = complete
    ? null
    : String(input.exact_blocker || (externalActionExecuted
      ? "portable_external_business_lifecycle_proof_missing"
      : "portable_external_business_effect_not_confirmed"));
  return {
    schema: PORTABLE_BUSINESS_WEB_OPERATION_LIFECYCLE_SCHEMA,
    state: complete ? "cleaned" : externalActionExecuted ? "effect_unknown" : "blocked",
    status: complete ? "complete" : "blocked",
    exact_blocker: exactBlocker,
    restart_point: complete ? null : externalActionExecuted ? "same-run source-of-truth reconciliation; do not replay" : "fresh target-bound admission; use a new idempotency key for a new attempt",
    run_id: input.run_id,
    step_id: input.step_id,
    idempotency_key: input.idempotency_key,
    operation: input.operation,
    target_digest: authority?.target_digest || ZERO_HASH,
    payload_hash: authority?.payload_hash === undefined ? null : authority.payload_hash,
    authority_sha256: authority?.authority_sha256 || null,
    source_state_digest: sourceStateDigest,
    dispatch_state: externalActionExecuted ? "executed" : "not_attempted",
    dispatch_attempted: externalActionExecuted,
    external_action_executed: externalActionExecuted,
    same_run_receipt: sameRunReceipt,
    readback_verified: readbackVerified,
    cleanup_verified: cleanupVerified,
    no_replay: true,
  };
}

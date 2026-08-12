import { validateWebOperationIntent } from "./portable-business-action-plan.mjs";

export const WEB_OPERATION_LIFECYCLE_SCHEMA_V1 = "automation_os_web_operation_lifecycle.v1";
export const WEB_OPERATION_READBACK_SCHEMA_V1 = "automation_os_web_operation_source_readback.v1";
export const WEB_OPERATION_DISPATCH_SCHEMA_V1 = "automation_os_web_operation_dispatch.v1";

const HASH = /^[a-f0-9]{64}$/u;
const STATES = new Set(["target_resolved", "approval_pending", "admitted", "readback_required", "effect_unknown", "completed", "blocked", "cleaned"]);
const DISPATCH_STATES = new Set(["not_attempted", "not_dispatched", "executed", "unknown"]);
const READBACK_OUTCOMES = new Set(["effect_confirmed", "no_effect", "unknown"]);
const READBACK_OBSERVATIONS = new Set(["present", "absent", "unchanged"]);

function assertHash(value, code) {
  const normalized = String(value || "");
  if (!HASH.test(normalized)) throw new Error(code);
  return normalized;
}

function sameBinding(lifecycle, intent) {
  return lifecycle.run_id === intent.run_id
    && lifecycle.step_id === intent.step_id
    && lifecycle.idempotency_key === intent.idempotency_key
    && lifecycle.operation === intent.operation
    && lifecycle.account_ref === intent.account_ref
    && lifecycle.payload_hash === intent.payload_hash
    && lifecycle.authority_sha256 === intent.authority_sha256;
}

function assertLifecycle(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schema !== WEB_OPERATION_LIFECYCLE_SCHEMA_V1
    || !STATES.has(value.state)
    || !DISPATCH_STATES.has(value.dispatch_state)
    || value.no_replay !== true
    || typeof value.dispatch_attempted !== "boolean"
    || typeof value.external_action_executed !== "boolean"
    || typeof value.readback_verified !== "boolean"
    || typeof value.cleanup_verified !== "boolean") throw new Error("web_operation_lifecycle_invalid");
  assertHash(value.target_digest, "web_operation_lifecycle_target_digest_invalid");
  assertHash(value.source_state_digest, "web_operation_lifecycle_source_state_digest_invalid");
  if (value.payload_hash !== null) assertHash(value.payload_hash, "web_operation_lifecycle_payload_hash_invalid");
  if (value.authority_sha256 !== null) assertHash(value.authority_sha256, "web_operation_lifecycle_authority_invalid");
  return value;
}

function bindingFromCandidate(intent, candidate) {
  const targetDigest = assertHash(candidate?.target_digest, "web_operation_target_digest_invalid");
  const sourceStateDigest = assertHash(candidate?.source_state_digest, "web_operation_source_state_digest_invalid");
  let origin;
  try { origin = new URL(candidate.origin); } catch { throw new Error("web_operation_target_origin_mismatch"); }
  if (!intent.allowed_origins.includes(origin.origin)) throw new Error("web_operation_target_origin_mismatch");
  return { target_digest: targetDigest, source_state_digest: sourceStateDigest };
}

function baseLifecycle(intent, binding, state, exact_blocker = null, restart_point = null) {
  return {
    schema: WEB_OPERATION_LIFECYCLE_SCHEMA_V1,
    operation: intent.operation,
    run_id: intent.run_id,
    step_id: intent.step_id,
    idempotency_key: intent.idempotency_key,
    account_ref: intent.account_ref,
    ...binding,
    payload_hash: intent.payload_hash,
    authority_sha256: intent.authority_sha256,
    state,
    dispatch_state: "not_attempted",
    dispatch_attempted: false,
    external_action_executed: false,
    readback_verified: false,
    cleanup_verified: false,
    no_replay: true,
    exact_blocker,
    restart_point,
  };
}

export function createWebOperationLifecycle({ intent, resolution } = {}) {
  const validated = validateWebOperationIntent(intent);
  if (!resolution || resolution.status !== "resolved") {
    return baseLifecycle(validated, { target_digest: "0".repeat(64), source_state_digest: "0".repeat(64) }, "blocked", resolution?.exact_blocker || "web_operation_target_invalid", resolution?.restart_point || "fresh live semantic readback; do not reuse stale target evidence");
  }
  return baseLifecycle(validated, bindingFromCandidate(validated, resolution.candidate), "target_resolved");
}

export function admitWebOperationLifecycle({ lifecycle, intent } = {}) {
  const current = assertLifecycle(lifecycle);
  const validated = validateWebOperationIntent(intent);
  if (!sameBinding(current, validated)) throw new Error("web_operation_lifecycle_binding_mismatch");
  if (["blocked", "completed", "cleaned", "effect_unknown"].includes(current.state)) return current;
  if (!new Set(["target_resolved", "approval_pending"]).has(current.state)) throw new Error("web_operation_lifecycle_admission_state_invalid");
  if (validated.operation !== "read" && validated.approval_status === "pending") return { ...current, state: "approval_pending", exact_blocker: "web_operation_approval_pending", restart_point: "fresh approval readback; preserve target binding" };
  if (validated.operation !== "read" && validated.approval_status !== "approved") return { ...current, state: "blocked", exact_blocker: "web_operation_approval_required", restart_point: "fresh target readback after explicit approval" };
  return { ...current, state: "admitted", exact_blocker: null, restart_point: null };
}

export function dispatchWebOperationLifecycle({ lifecycle, intent, dispatch } = {}) {
  const current = assertLifecycle(lifecycle);
  const validated = validateWebOperationIntent(intent);
  if (!sameBinding(current, validated)) throw new Error("web_operation_lifecycle_binding_mismatch");
  if (!dispatch || dispatch.schema !== WEB_OPERATION_DISPATCH_SCHEMA_V1
    || dispatch.run_id !== current.run_id
    || dispatch.step_id !== current.step_id
    || dispatch.idempotency_key !== current.idempotency_key
    || dispatch.target_digest !== current.target_digest
    || dispatch.payload_hash !== current.payload_hash
    || !DISPATCH_STATES.has(dispatch.state)
    || dispatch.state === "not_attempted") throw new Error("web_operation_dispatch_binding_invalid");
  if (current.state !== "admitted") throw new Error("web_operation_dispatch_not_admitted");
  if (validated.operation === "read" && dispatch.state === "executed") throw new Error("web_operation_read_dispatch_forbidden");
  if (dispatch.state === "unknown") return { ...current, state: "effect_unknown", dispatch_state: "unknown", dispatch_attempted: true, exact_blocker: "web_operation_external_effect_reconciliation_required", restart_point: "same-run source-of-truth readback; do not replay" };
  if (dispatch.state === "not_dispatched") return { ...current, state: "blocked", dispatch_state: "not_dispatched", dispatch_attempted: true, exact_blocker: "web_operation_no_effect_dispatched", restart_point: "fresh target readback; a new idempotency key is required for a new attempt" };
  return { ...current, state: "readback_required", dispatch_state: "executed", dispatch_attempted: true, external_action_executed: true, exact_blocker: "web_operation_source_readback_required", restart_point: "same-run source-of-truth readback; do not replay" };
}

function expectedObservation(operation) { return operation === "delete" ? "absent" : "present"; }

export function reconcileWebOperationLifecycle({ lifecycle, intent, readback } = {}) {
  const current = assertLifecycle(lifecycle);
  const validated = validateWebOperationIntent(intent);
  if (!sameBinding(current, validated)) throw new Error("web_operation_lifecycle_binding_mismatch");
  if (!readback || readback.schema !== WEB_OPERATION_READBACK_SCHEMA_V1
    || readback.run_id !== current.run_id
    || readback.step_id !== current.step_id
    || readback.idempotency_key !== current.idempotency_key
    || readback.target_digest !== current.target_digest
    || readback.payload_hash !== current.payload_hash
    || !HASH.test(String(readback.source_state_digest || ""))
    || readback.verified !== true
    || readback.same_run_source_sync !== true
    || !READBACK_OUTCOMES.has(readback.outcome)
    || !READBACK_OBSERVATIONS.has(readback.observed)) throw new Error("web_operation_source_readback_invalid");
  if (!["readback_required", "effect_unknown"].includes(current.state)) {
    if (["completed", "cleaned"].includes(current.state)) return current;
    throw new Error("web_operation_source_readback_state_invalid");
  }
  if (readback.outcome === "effect_confirmed" && readback.observed === expectedObservation(validated.operation)) return { ...current, state: "completed", source_state_digest: readback.source_state_digest, readback_verified: true, exact_blocker: null, restart_point: null };
  if (readback.outcome === "no_effect" && current.dispatch_state === "not_dispatched") return { ...current, state: "blocked", source_state_digest: readback.source_state_digest, readback_verified: true, exact_blocker: "web_operation_no_effect_confirmed", restart_point: "fresh target readback; a new idempotency key is required for a new attempt" };
  return { ...current, state: "effect_unknown", source_state_digest: readback.source_state_digest, readback_verified: true, exact_blocker: "web_operation_source_readback_mismatch", restart_point: "reconcile current source of truth; do not replay" };
}

export function cleanupWebOperationLifecycle({ lifecycle, cleanupVerified } = {}) {
  const current = assertLifecycle(lifecycle);
  if (cleanupVerified !== true) return { ...current, cleanup_verified: false, exact_blocker: current.exact_blocker || "web_operation_cleanup_readback_missing", restart_point: "same-run terminal cleanup readback" };
  if (current.state === "effect_unknown") return { ...current, cleanup_verified: true, exact_blocker: current.exact_blocker || "web_operation_external_effect_reconciliation_required", restart_point: "source-of-truth reconciliation; do not replay" };
  if (!["completed", "blocked"].includes(current.state)) return { ...current, state: "blocked", cleanup_verified: true, exact_blocker: current.exact_blocker || "web_operation_cleanup_before_readback", restart_point: "resume from current lifecycle checkpoint; do not replay" };
  return { ...current, state: "cleaned", cleanup_verified: true };
}

export function webOperationLifecycleReceipt(lifecycle) {
  const current = assertLifecycle(lifecycle);
  const terminallyCleaned = current.state === "cleaned" && current.cleanup_verified === true;
  const status = terminallyCleaned ? "complete" : current.state === "approval_pending" ? "awaiting_approval" : "blocked";
  const exactBlocker = current.exact_blocker || (current.state === "completed" ? "web_operation_cleanup_readback_missing" : null);
  const restartPoint = current.restart_point || (current.state === "completed" ? "same-run terminal cleanup readback" : null);
  return {
    schema: WEB_OPERATION_LIFECYCLE_SCHEMA_V1,
    state: current.state,
    status,
    exact_blocker: exactBlocker,
    restart_point: restartPoint,
    run_id: current.run_id,
    step_id: current.step_id,
    idempotency_key: current.idempotency_key,
    operation: current.operation,
    target_digest: current.target_digest,
    payload_hash: current.payload_hash,
    external_action_executed: current.external_action_executed,
    same_run_receipt: terminallyCleaned,
    readback_verified: current.readback_verified,
    cleanup_verified: current.cleanup_verified,
    no_replay: true,
  };
}

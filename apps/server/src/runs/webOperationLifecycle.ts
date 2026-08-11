import {
  validateWebOperationIntent,
  type WebOperationIntentKind,
  type WebOperationIntentV1,
  type WebOperationTargetCandidateV1,
  type WebOperationTargetResolutionV1
} from "./webOperationContract.js";

export const WEB_OPERATION_LIFECYCLE_SCHEMA_V1 = "automation_os_web_operation_lifecycle.v1" as const;
export const WEB_OPERATION_READBACK_SCHEMA_V1 = "automation_os_web_operation_source_readback.v1" as const;
export const WEB_OPERATION_DISPATCH_SCHEMA_V1 = "automation_os_web_operation_dispatch.v1" as const;

const HASH = /^[a-f0-9]{64}$/u;

export type WebOperationLifecycleStateV1 =
  | "target_resolved"
  | "approval_pending"
  | "admitted"
  | "readback_required"
  | "effect_unknown"
  | "completed"
  | "blocked"
  | "cleaned";

export type WebOperationDispatchStateV1 = "not_attempted" | "not_dispatched" | "executed" | "unknown";
export type WebOperationReadbackOutcomeV1 = "effect_confirmed" | "no_effect" | "unknown";
export type WebOperationReadbackObservationV1 = "present" | "absent" | "unchanged";

export type WebOperationLifecycleV1 = {
  schema: typeof WEB_OPERATION_LIFECYCLE_SCHEMA_V1;
  operation: WebOperationIntentKind;
  run_id: string;
  step_id: string;
  idempotency_key: string;
  account_ref: string;
  target_digest: string;
  source_state_digest: string;
  payload_hash: string | null;
  authority_sha256: string | null;
  state: WebOperationLifecycleStateV1;
  dispatch_state: WebOperationDispatchStateV1;
  dispatch_attempted: boolean;
  external_action_executed: boolean;
  readback_verified: boolean;
  cleanup_verified: boolean;
  no_replay: true;
  exact_blocker: string | null;
  restart_point: string | null;
};

export type WebOperationDispatchV1 = {
  schema: typeof WEB_OPERATION_DISPATCH_SCHEMA_V1;
  run_id: string;
  step_id: string;
  idempotency_key: string;
  target_digest: string;
  payload_hash: string | null;
  state: Exclude<WebOperationDispatchStateV1, "not_attempted">;
};

export type WebOperationSourceReadbackV1 = {
  schema: typeof WEB_OPERATION_READBACK_SCHEMA_V1;
  run_id: string;
  step_id: string;
  idempotency_key: string;
  target_digest: string;
  payload_hash: string | null;
  source_state_digest: string;
  outcome: WebOperationReadbackOutcomeV1;
  observed: WebOperationReadbackObservationV1;
  verified: true;
  same_run_source_sync: true;
};

export type WebOperationLifecycleReceiptV1 = {
  schema: typeof WEB_OPERATION_LIFECYCLE_SCHEMA_V1;
  state: WebOperationLifecycleStateV1;
  status: "complete" | "awaiting_approval" | "blocked";
  exact_blocker: string | null;
  restart_point: string | null;
  run_id: string;
  step_id: string;
  idempotency_key: string;
  operation: WebOperationIntentKind;
  target_digest: string;
  payload_hash: string | null;
  external_action_executed: boolean;
  same_run_receipt: boolean;
  readback_verified: boolean;
  cleanup_verified: boolean;
  no_replay: true;
};

function sameBinding(lifecycle: WebOperationLifecycleV1, intent: WebOperationIntentV1): boolean {
  return lifecycle.run_id === intent.run_id
    && lifecycle.step_id === intent.step_id
    && lifecycle.idempotency_key === intent.idempotency_key
    && lifecycle.operation === intent.operation
    && lifecycle.account_ref === intent.account_ref
    && lifecycle.payload_hash === intent.payload_hash
    && lifecycle.authority_sha256 === intent.authority_sha256;
}

function assertHash(value: unknown, code: string): string {
  const normalized = String(value || "");
  if (!HASH.test(normalized)) throw new Error(code);
  return normalized;
}

function assertLifecycle(value: unknown): WebOperationLifecycleV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("web_operation_lifecycle_invalid");
  const lifecycle = value as WebOperationLifecycleV1;
  if (lifecycle.schema !== WEB_OPERATION_LIFECYCLE_SCHEMA_V1
    || !["target_resolved", "approval_pending", "admitted", "readback_required", "effect_unknown", "completed", "blocked", "cleaned"].includes(lifecycle.state)
    || !["not_attempted", "not_dispatched", "executed", "unknown"].includes(lifecycle.dispatch_state)
    || lifecycle.no_replay !== true
    || typeof lifecycle.dispatch_attempted !== "boolean"
    || typeof lifecycle.external_action_executed !== "boolean"
    || typeof lifecycle.readback_verified !== "boolean"
    || typeof lifecycle.cleanup_verified !== "boolean") {
    throw new Error("web_operation_lifecycle_invalid");
  }
  assertHash(lifecycle.target_digest, "web_operation_lifecycle_target_digest_invalid");
  assertHash(lifecycle.source_state_digest, "web_operation_lifecycle_source_state_digest_invalid");
  if (lifecycle.payload_hash !== null) assertHash(lifecycle.payload_hash, "web_operation_lifecycle_payload_hash_invalid");
  if (lifecycle.authority_sha256 !== null) assertHash(lifecycle.authority_sha256, "web_operation_lifecycle_authority_invalid");
  return lifecycle;
}

function bindingFromCandidate(intent: WebOperationIntentV1, candidate: WebOperationTargetCandidateV1): Pick<WebOperationLifecycleV1, "target_digest" | "source_state_digest"> {
  const targetDigest = assertHash(candidate.target_digest, "web_operation_target_digest_invalid");
  const sourceStateDigest = assertHash(candidate.source_state_digest, "web_operation_source_state_digest_invalid");
  let origin: URL;
  try { origin = new URL(candidate.origin); } catch { throw new Error("web_operation_target_origin_mismatch"); }
  if (!intent.allowed_origins.includes(origin.origin)) throw new Error("web_operation_target_origin_mismatch");
  return { target_digest: targetDigest, source_state_digest: sourceStateDigest };
}

function baseLifecycle(intent: WebOperationIntentV1, binding: Pick<WebOperationLifecycleV1, "target_digest" | "source_state_digest">, state: WebOperationLifecycleStateV1, exactBlocker: string | null = null, restartPoint: string | null = null): WebOperationLifecycleV1 {
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
    exact_blocker: exactBlocker,
    restart_point: restartPoint,
  };
}

export function createWebOperationLifecycle(input: {
  intent: WebOperationIntentV1;
  resolution: WebOperationTargetResolutionV1;
}): WebOperationLifecycleV1 {
  const intent = validateWebOperationIntent(input.intent);
  if (input.resolution.status !== "resolved") {
    return baseLifecycle(
      intent,
      { target_digest: "0".repeat(64), source_state_digest: "0".repeat(64) },
      "blocked",
      input.resolution.exact_blocker,
      input.resolution.restart_point,
    );
  }
  return baseLifecycle(intent, bindingFromCandidate(intent, input.resolution.candidate), "target_resolved");
}

export function admitWebOperationLifecycle(input: {
  lifecycle: WebOperationLifecycleV1;
  intent: WebOperationIntentV1;
}): WebOperationLifecycleV1 {
  const lifecycle = assertLifecycle(input.lifecycle);
  const intent = validateWebOperationIntent(input.intent);
  if (!sameBinding(lifecycle, intent)) throw new Error("web_operation_lifecycle_binding_mismatch");
  if (lifecycle.state === "blocked" || lifecycle.state === "completed" || lifecycle.state === "cleaned" || lifecycle.state === "effect_unknown") return lifecycle;
  if (lifecycle.state !== "target_resolved" && lifecycle.state !== "approval_pending") throw new Error("web_operation_lifecycle_admission_state_invalid");
  if (intent.operation !== "read" && intent.approval_status === "pending") {
    return { ...lifecycle, state: "approval_pending", exact_blocker: "web_operation_approval_pending", restart_point: "fresh approval readback; preserve target binding" };
  }
  if (intent.operation !== "read" && intent.approval_status !== "approved") {
    return { ...lifecycle, state: "blocked", exact_blocker: "web_operation_approval_required", restart_point: "fresh target readback after explicit approval" };
  }
  return { ...lifecycle, state: "admitted", exact_blocker: null, restart_point: null };
}

export function dispatchWebOperationLifecycle(input: {
  lifecycle: WebOperationLifecycleV1;
  intent: WebOperationIntentV1;
  dispatch: WebOperationDispatchV1;
}): WebOperationLifecycleV1 {
  const lifecycle = assertLifecycle(input.lifecycle);
  const intent = validateWebOperationIntent(input.intent);
  if (!sameBinding(lifecycle, intent)) throw new Error("web_operation_lifecycle_binding_mismatch");
  if (input.dispatch.schema !== WEB_OPERATION_DISPATCH_SCHEMA_V1
    || input.dispatch.run_id !== lifecycle.run_id
    || input.dispatch.step_id !== lifecycle.step_id
    || input.dispatch.idempotency_key !== lifecycle.idempotency_key
    || input.dispatch.target_digest !== lifecycle.target_digest
    || input.dispatch.payload_hash !== lifecycle.payload_hash) throw new Error("web_operation_dispatch_binding_invalid");
  if (lifecycle.state !== "admitted") throw new Error("web_operation_dispatch_not_admitted");
  if (intent.operation === "read" && input.dispatch.state === "executed") throw new Error("web_operation_read_dispatch_forbidden");
  if (input.dispatch.state === "unknown") {
    return { ...lifecycle, state: "effect_unknown", dispatch_state: "unknown", dispatch_attempted: true, exact_blocker: "web_operation_external_effect_reconciliation_required", restart_point: "same-run source-of-truth readback; do not replay" };
  }
  if (input.dispatch.state === "not_dispatched") {
    return { ...lifecycle, state: "blocked", dispatch_state: "not_dispatched", dispatch_attempted: true, exact_blocker: "web_operation_no_effect_dispatched", restart_point: "fresh target readback; a new idempotency key is required for a new attempt" };
  }
  return { ...lifecycle, state: "readback_required", dispatch_state: "executed", dispatch_attempted: true, external_action_executed: true, exact_blocker: "web_operation_source_readback_required", restart_point: "same-run source-of-truth readback; do not replay" };
}

function expectedObservation(operation: WebOperationIntentKind): WebOperationReadbackObservationV1 {
  return operation === "delete" ? "absent" : "present";
}

export function reconcileWebOperationLifecycle(input: {
  lifecycle: WebOperationLifecycleV1;
  intent: WebOperationIntentV1;
  readback: WebOperationSourceReadbackV1;
}): WebOperationLifecycleV1 {
  const lifecycle = assertLifecycle(input.lifecycle);
  const intent = validateWebOperationIntent(input.intent);
  if (!sameBinding(lifecycle, intent)) throw new Error("web_operation_lifecycle_binding_mismatch");
  const readback = input.readback;
  if (readback.schema !== WEB_OPERATION_READBACK_SCHEMA_V1
    || readback.run_id !== lifecycle.run_id
    || readback.step_id !== lifecycle.step_id
    || readback.idempotency_key !== lifecycle.idempotency_key
    || readback.target_digest !== lifecycle.target_digest
    || readback.payload_hash !== lifecycle.payload_hash
    || !HASH.test(readback.source_state_digest)
    || readback.verified !== true
    || readback.same_run_source_sync !== true
    || !["effect_confirmed", "no_effect", "unknown"].includes(readback.outcome)
    || !["present", "absent", "unchanged"].includes(readback.observed)) {
    throw new Error("web_operation_source_readback_invalid");
  }
  if (!["readback_required", "effect_unknown"].includes(lifecycle.state)) {
    if (lifecycle.state === "completed" || lifecycle.state === "cleaned") return lifecycle;
    throw new Error("web_operation_source_readback_state_invalid");
  }
  const expected = expectedObservation(intent.operation);
  const confirmed = readback.outcome === "effect_confirmed" && readback.observed === expected;
  if (confirmed) {
    return { ...lifecycle, state: "completed", source_state_digest: readback.source_state_digest, readback_verified: true, exact_blocker: null, restart_point: null };
  }
  if (readback.outcome === "no_effect" && lifecycle.dispatch_state === "not_dispatched") {
    return { ...lifecycle, state: "blocked", source_state_digest: readback.source_state_digest, readback_verified: true, exact_blocker: "web_operation_no_effect_confirmed", restart_point: "fresh target readback; a new idempotency key is required for a new attempt" };
  }
  return { ...lifecycle, state: "effect_unknown", source_state_digest: readback.source_state_digest, readback_verified: true, exact_blocker: "web_operation_source_readback_mismatch", restart_point: "reconcile current source of truth; do not replay" };
}

export function cleanupWebOperationLifecycle(input: { lifecycle: WebOperationLifecycleV1; cleanupVerified: boolean }): WebOperationLifecycleV1 {
  const lifecycle = assertLifecycle(input.lifecycle);
  if (input.cleanupVerified !== true) {
    return { ...lifecycle, cleanup_verified: false, exact_blocker: lifecycle.exact_blocker || "web_operation_cleanup_readback_missing", restart_point: "same-run terminal cleanup readback" };
  }
  if (lifecycle.state === "effect_unknown") {
    return { ...lifecycle, cleanup_verified: true, exact_blocker: lifecycle.exact_blocker || "web_operation_external_effect_reconciliation_required", restart_point: "source-of-truth reconciliation; do not replay" };
  }
  if (!["completed", "blocked"].includes(lifecycle.state)) {
    return { ...lifecycle, state: "blocked", cleanup_verified: true, exact_blocker: lifecycle.exact_blocker || "web_operation_cleanup_before_readback", restart_point: "resume from current lifecycle checkpoint; do not replay" };
  }
  return { ...lifecycle, state: "cleaned", cleanup_verified: true };
}

export function webOperationLifecycleReceipt(lifecycleInput: WebOperationLifecycleV1): WebOperationLifecycleReceiptV1 {
  const lifecycle = assertLifecycle(lifecycleInput);
  const terminallyCleaned = lifecycle.state === "cleaned" && lifecycle.cleanup_verified === true;
  const status = terminallyCleaned
    ? "complete"
    : lifecycle.state === "approval_pending"
      ? "awaiting_approval"
      : "blocked";
  const exactBlocker = lifecycle.exact_blocker
    || (lifecycle.state === "completed" ? "web_operation_cleanup_readback_missing" : null);
  const restartPoint = lifecycle.restart_point
    || (lifecycle.state === "completed" ? "same-run terminal cleanup readback" : null);
  return {
    schema: WEB_OPERATION_LIFECYCLE_SCHEMA_V1,
    state: lifecycle.state,
    status,
    exact_blocker: exactBlocker,
    restart_point: restartPoint,
    run_id: lifecycle.run_id,
    step_id: lifecycle.step_id,
    idempotency_key: lifecycle.idempotency_key,
    operation: lifecycle.operation,
    target_digest: lifecycle.target_digest,
    payload_hash: lifecycle.payload_hash,
    external_action_executed: lifecycle.external_action_executed,
    same_run_receipt: terminallyCleaned,
    readback_verified: lifecycle.readback_verified,
    cleanup_verified: lifecycle.cleanup_verified,
    no_replay: true,
  };
}

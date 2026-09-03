import { createHash } from "node:crypto";

import {
  createJobSourceResumeReceipt,
  validateJobSourceResumeReceipt,
} from "./job-resume-receipt.mjs";

/**
 * The resume controller deliberately owns no provider, browser, credential, or
 * authentication implementation.  It only turns a fresh readback into a
 * bounded decision and, when safe, calls the three callbacks supplied by the
 * caller in a fixed order.
 */

export const RESUME_CURRENT_TASK_SCHEMA = "resume_current_task_receipt.v1";
export const RESUME_CURRENT_TASK_RECEIPT_SCHEMA = RESUME_CURRENT_TASK_SCHEMA;

export const BLOCKER_PRIORITY = Object.freeze([
  "unknown_effect",
  "foreign_owner",
  "active_reconciliation",
  "human_auth_required",
  "provider_inactive",
  "handoff_gate_active",
  "stale_owner_recoverable",
  "ready",
]);

export const RESUME_BLOCKER_PRIORITY = BLOCKER_PRIORITY;

/**
 * Job continuation has two deliberately separate lanes:
 *
 * - `direct_application` is the normal same-thread application lane.  A stale
 *   Codex handoff receipt is context only and must not act as its authority.
 * - `source_return` is the exceptional lane used after a destination task has
 *   explicitly returned control to the source task.  That lane still requires
 *   the signed source-resume admission receipt.
 */
export const JOB_RESUME_LANES = Object.freeze({
  DIRECT_APPLICATION: "direct_application",
  SOURCE_RETURN: "source_return",
});

const SOURCE_RETURN_INTENTS = new Set([
  "source_return",
  "source_resume",
  "resume_source",
  "resume_in_source",
  "return_to_source",
  "return_no_output_to_source",
  "handoff_return",
  "return_requested",
]);

const BLOCKER_RANK = new Map(BLOCKER_PRIORITY.map((reason, index) => [reason, index]));

const REASON_ALIASES = new Map([
  ["unknown", "unknown_effect"],
  ["uncertain", "unknown_effect"],
  ["unknown_effect", "unknown_effect"],
  ["operation_effect_unknown", "unknown_effect"],
  ["external_action_unknown", "unknown_effect"],
  ["effect_unknown", "unknown_effect"],
  ["result_unknown", "unknown_effect"],
  ["unknown_result", "unknown_effect"],

  ["foreign_owner", "foreign_owner"],
  ["foreign_owner_authority_missing", "foreign_owner"],
  ["owner_mismatch", "foreign_owner"],
  ["ownership_mismatch", "foreign_owner"],
  ["not_owner", "foreign_owner"],

  ["active_reconciliation", "active_reconciliation"],
  ["reconciliation_required", "active_reconciliation"],
  ["reconciliation_pending", "active_reconciliation"],
  ["reconciliation_active", "active_reconciliation"],
  ["same_resource_reconciliation", "active_reconciliation"],

  ["human_auth_required", "human_auth_required"],
  ["human_authentication_required", "human_auth_required"],
  ["auth_required", "human_auth_required"],
  ["authentication_required", "human_auth_required"],
  ["login_required", "human_auth_required"],
  ["owner_sso_required", "human_auth_required"],

  ["provider_inactive", "provider_inactive"],
  ["provider_unavailable", "provider_inactive"],
  ["provider_not_ready", "provider_inactive"],
  ["provider_disabled", "provider_inactive"],

  ["handoff_gate_active", "handoff_gate_active"],
  ["source_session_handoff_gate_active", "handoff_gate_active"],
  ["handoff_active", "handoff_gate_active"],
  ["handoff_required", "handoff_gate_active"],

  ["stale_owner_recoverable", "stale_owner_recoverable"],
  ["stale_owner", "stale_owner_recoverable"],
  ["owner_stale", "stale_owner_recoverable"],
  ["stale_generation", "stale_owner_recoverable"],
]);

const SIGNAL_KEYS = Object.freeze({
  unknown_effect: [
    "unknown_effect", "unknownEffect", "operation_effect_unknown", "operationEffectUnknown",
    "effect_unknown", "effectUnknown", "external_action_unknown", "externalActionUnknown",
    "result_unknown", "resultUnknown", "effect_state_unknown", "effectStateUnknown",
    "effectKnown", "effect_known", "effectResolved", "effect_resolved", "effectStatusUnknown", "effect_status_unknown",
  ],
  foreign_owner: [
    "foreign_owner", "foreignOwner", "owner_mismatch", "ownerMismatch", "ownership_mismatch",
    "ownershipMismatch", "not_owner", "notOwner", "foreign", "foreignOwnership",
  ],
  active_reconciliation: [
    "active_reconciliation", "activeReconciliation", "reconciliation_required", "reconciliationRequired",
    "reconciliation_pending", "reconciliationPending", "reconciliation_active", "reconciliationActive",
    "same_resource_reconciliation", "sameResourceReconciliation",
    "reconciliation", "reconciliationActive", "reconciliation_active",
  ],
  human_auth_required: [
    "human_auth_required", "humanAuthRequired", "human_authentication_required", "humanAuthenticationRequired",
    "auth_required", "authRequired", "authentication_required", "authenticationRequired",
    "login_required", "loginRequired", "requires_human_auth", "requiresHumanAuth",
    "needs_human_auth", "needsHumanAuth", "owner_sso_required", "ownerSsoRequired",
  ],
  provider_inactive: [
    "provider_inactive", "providerInactive", "provider_disabled", "providerDisabled",
    "provider_unavailable", "providerUnavailable", "provider_not_ready", "providerNotReady", "providerActive", "provider_active",
  ],
  handoff_gate_active: [
    "handoff_gate_active", "handoffGateActive", "source_session_handoff_gate_active",
    "sourceSessionHandoffGateActive", "handoff_active", "handoffActive", "handoff_required", "handoffRequired",
  ],
  stale_owner_recoverable: [
    "stale_owner_recoverable", "staleOwnerRecoverable", "stale_owner", "staleOwner",
    "owner_stale", "ownerStale", "stale_generation", "staleGeneration",
  ],
});

const REASON_FIELDS = Object.freeze([
  "reason", "exact_reason", "exactReason", "exact_blocker", "exactBlocker", "blocker",
  "blocker_reason", "blockerReason", "resume_reason", "resumeReason", "failure_reason", "failureReason",
  "status", "state", "operation_status", "operationStatus", "readback_status", "readbackStatus",
  "effect_state", "effectState", "effect_status", "effectStatus", "provider_status", "providerStatus",
  "reconciliation_status", "reconciliationStatus", "handoff_status", "handoffStatus",
  "source_status", "sourceStatus", "implementation_allowed", "implementationAllowed",
  "external_effect_state", "externalEffectState", "external_action_state", "externalActionState",
  "reconciliation_state", "reconciliationState", "handoff_state", "handoffState",
]);

const localSeenByDependencyObject = new WeakMap();

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  return "";
}

function normalizedToken(value) {
  return stringValue(value)
    .replace(/[\s-]+/gu, "_")
    .replace(/([a-z])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .replace(/^:+|:+$/gu, "");
}

function sourceReturnIntent(value) {
  const token = normalizedToken(value);
  if (!token) return false;
  if (SOURCE_RETURN_INTENTS.has(token)) return true;
  return token.includes("resume_in_source")
    || token.includes("return_no_output_to_source")
    || token.includes("return_to_source")
    || token.includes("handoff_return");
}

function directJobApplicationLane(input) {
  if (!isRecord(input)) return false;
  const taskType = normalizedToken(input.taskType ?? input.task_type ?? input.workflow);
  const adapter = normalizedToken(input.adapter);
  const lane = normalizedToken(input.applicationResumeLane ?? input.application_resume_lane ?? input.resumeLane ?? input.resume_lane);
  const sourceResumeRequired = input.sourceResumeRequired ?? input.source_resume_required;
  const handoffGateActive = input.handoffGateActive ?? input.handoff_gate_active;
  return taskType === "job"
    && adapter === "job"
    && lane === JOB_RESUME_LANES.DIRECT_APPLICATION
    && sourceResumeRequired === false
    && handoffGateActive === false;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function bool(value) {
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  return new Set(["true", "yes", "active", "required", "pending", "blocked", "foreign", "unknown"]).has(
    normalizedToken(value),
  );
}

function falseValue(value) {
  if (value === false || value === 0) return true;
  if (typeof value !== "string") return false;
  return new Set(["false", "no", "inactive", "disabled", "none", "null"]).has(normalizedToken(value));
}

function canonicalReason(value) {
  const token = normalizedToken(value);
  if (!token) return null;
  if (REASON_ALIASES.has(token)) return REASON_ALIASES.get(token);

  // Exact blocker strings often carry a workflow prefix or a short detail.
  // Matching only known tokens keeps arbitrary status text from becoming a
  // blocker while still preserving the common AOS reason vocabulary.
  if (token.includes("unknown_effect") || token.includes("effect_unknown")) return "unknown_effect";
  if (token.includes("foreign_owner") || token.includes("owner_mismatch") || token.includes("ownership_mismatch")) return "foreign_owner";
  if (token.includes("reconciliation") && (token.includes("active") || token.includes("pending") || token.includes("required"))) {
    return "active_reconciliation";
  }
  if (token.includes("human_auth") || token.includes("authentication_required") || token.includes("login_required")) {
    return "human_auth_required";
  }
  if (token.includes("provider") && (token.includes("inactive") || token.includes("disabled") || token.includes("unavailable") || token.includes("not_ready"))) {
    return "provider_inactive";
  }
  if (token.includes("handoff") && (token.includes("gate") || token.includes("active") || token.includes("required"))) {
    return "handoff_gate_active";
  }
  if (token.includes("stale") && (token.includes("owner") || token.includes("generation"))) {
    return "stale_owner_recoverable";
  }
  return null;
}

function sourceNodes(input) {
  const nodes = [];
  const add = (value) => {
    if (!value || nodes.includes(value)) return;
    nodes.push(value);
  };

  add(input);
  for (const key of ["fresh", "freshReadback", "fresh_readback", "readback", "current", "currentReadback", "current_readback"]) {
    add(input?.[key]);
  }
  for (const root of [...nodes]) {
    if (!isRecord(root)) continue;
    for (const key of ["status", "identity", "ownership", "owner", "session", "reconciliation", "provider", "handoff", "effect", "auth", "authentication"]) {
      add(root[key]);
    }
  }
  // Include one additional level for the usual fresh.status / fresh.identity /
  // fresh.ownership shape without recursively walking arbitrary user data.
  for (const root of [...nodes]) {
    if (!isRecord(root)) continue;
    for (const value of Object.values(root)) {
      if (isRecord(value)) add(value);
    }
  }
  return nodes;
}

function explicitReasons(nodes) {
  const reasons = new Set();
  for (const node of nodes) {
    if (typeof node === "string") {
      const reason = canonicalReason(node);
      if (reason) reasons.add(reason);
      continue;
    }
    if (!isRecord(node)) continue;
    for (const field of REASON_FIELDS) {
      const reason = canonicalReason(node[field]);
      if (reason) reasons.add(reason);
    }
    for (const key of Object.keys(node)) {
      const reason = canonicalReason(key);
      if (reason && bool(node[key])) reasons.add(reason);
    }
    if (node.implementationAllowed === false || node.implementation_allowed === false) {
      reasons.add("handoff_gate_active");
    }
    const sourceStatus = normalizedToken(node.sourceStatus ?? node.source_status);
    if (["reconciliation_only", "return_requested", "handoff_active", "handoff_gate_active"].includes(sourceStatus)) {
      reasons.add("handoff_gate_active");
    }
  }
  return reasons;
}

function hasSignal(nodes, reason) {
  const keys = SIGNAL_KEYS[reason] || [];
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    for (const key of keys) {
      // These fields are positive health signals, so their truthy value must
      // never be interpreted as the corresponding blocker.  Handle them
      // before the generic boolean branch.
      if (reason === "unknown_effect" && ["effectKnown", "effect_known", "effectResolved", "effect_resolved"].includes(key)) {
        if (node[key] === false || falseValue(node[key])) return true;
        continue;
      }
      if (reason === "provider_inactive" && ["providerActive", "provider_active"].includes(key)) {
        if (node[key] === false || falseValue(node[key])) return true;
        continue;
      }
      if (bool(node[key])) return true;
    }
    if (reason === "unknown_effect" && ["externalActionExecuted", "external_action_executed"].some((key) => node[key] === null)) return true;
    if (reason === "provider_inactive" && isRecord(node.provider) && falseValue(node.provider.active ?? node.provider.isActive ?? node.provider.is_active)) return true;
    if (reason === "provider_inactive" && falseValue(node.active ?? node.isActive ?? node.is_active)) return true;
    if (reason === "provider_inactive"
      && ["provider", "provider_status", "service", "connector"].includes(normalizedToken(node.kind ?? node.type ?? node.name))
      && ["inactive", "disabled", "unavailable", "not_ready", "paused"].includes(normalizedToken(node.status ?? node.state))) return true;
    if (reason === "active_reconciliation" && isRecord(node.reconciliation)
      && (bool(node.reconciliation.active) || bool(node.reconciliation.pending) || bool(node.reconciliation.required))) return true;
    if (reason === "active_reconciliation"
      && ["reconciliation", "reconciliation_gate"].includes(normalizedToken(node.kind ?? node.type ?? node.name))
      && ["active", "pending", "required"].includes(normalizedToken(node.status ?? node.state))) return true;
    if (reason === "active_reconciliation"
      && (bool(node.active) || bool(node.pending) || bool(node.required))
      && (node.kind === "reconciliation" || node.type === "reconciliation" || node.name === "reconciliation")) return true;
    if (reason === "human_auth_required" && isRecord(node.auth ?? node.authentication)
      && (bool((node.auth ?? node.authentication).required) || bool((node.auth ?? node.authentication).human))) return true;
    if (reason === "human_auth_required"
      && ["auth", "authentication", "login", "identity"].includes(normalizedToken(node.kind ?? node.type ?? node.name))
      && ["required", "pending", "login_required", "authentication_required"].includes(normalizedToken(node.status ?? node.state))) return true;
    if (reason === "human_auth_required" && (bool(node.required) || bool(node.human))
      && (node.kind === "auth" || node.kind === "authentication" || node.type === "auth" || node.type === "authentication")) return true;
    if (reason === "handoff_gate_active" && isRecord(node.handoff)
      && (bool(node.handoff.active) || bool(node.handoff.required) || bool(node.handoff.gate))) return true;
    if (reason === "handoff_gate_active"
      && ["handoff", "handoff_gate", "source_handoff"].includes(normalizedToken(node.kind ?? node.type ?? node.name))
      && ["active", "pending", "required"].includes(normalizedToken(node.status ?? node.state))) return true;
    if (reason === "stale_owner_recoverable"
      && ["owner", "session", "lease", "generation"].includes(normalizedToken(node.kind ?? node.type ?? node.name))
      && ["stale", "stale_owner", "recoverable"].includes(normalizedToken(node.status ?? node.state))) return true;
    if (reason === "handoff_gate_active" && (bool(node.active) || bool(node.required) || bool(node.gate))
      && (node.kind === "handoff" || node.type === "handoff" || node.name === "handoff")) return true;
    if (reason === "stale_owner_recoverable" && (
      bool(node.stale)
      || falseValue(node.fresh)
      || falseValue(node.freshOwner)
      || falseValue(node.fresh_owner)
    )) return true;
  }
  return false;
}

function ownershipSignals(input, nodes) {
  if (hasSignal(nodes, "foreign_owner")) return true;
  const ownership = [input?.ownership, input?.fresh?.ownership, input?.freshOwnership, input?.fresh_ownership]
    .filter(isRecord);

  for (const value of ownership) {
    for (const key of ["owned", "isOwned", "ownerMatch", "owner_match", "sameOwner", "same_owner", "ownerVerified", "owner_verified", "ownershipVerified", "ownership_verified"]) {
      if (falseValue(value[key])) return true;
    }
    for (const key of ["status", "state", "role"]) {
      const token = normalizedToken(value[key]);
      if (["foreign", "foreign_owner", "not_owner", "mismatch"].includes(token)) return true;
    }
  }

  const identifiers = [
    [input?.identity, input?.ownership],
    [input?.fresh?.identity, input?.fresh?.ownership],
  ];
  for (const [identity, owner] of identifiers) {
    if (!isRecord(identity) || !isRecord(owner)) continue;
    const identityOwner = stringValue(identity.ownerId ?? identity.owner_id ?? identity.ownerRef ?? identity.owner_ref);
    const observedOwner = stringValue(owner.ownerId ?? owner.owner_id ?? owner.ownerRef ?? owner.owner_ref);
    if (identityOwner && observedOwner && identityOwner !== observedOwner) return true;
  }
  if (input?.ownerId && input?.currentOwnerId && String(input.ownerId) !== String(input.currentOwnerId)) return true;
  if (input?.owner_id && input?.current_owner_id && String(input.owner_id) !== String(input.current_owner_id)) return true;
  return false;
}

/**
 * Normalize all fresh readback signals to exactly one canonical reason.
 * Blockers are selected by BLOCKER_PRIORITY, never by input object order.
 */
export function normalizeBlockerReason(input = {}) {
  const nodes = sourceNodes(input);
  const reasons = explicitReasons(nodes);
  const directApplication = directJobApplicationLane(input);
  for (const key of ["fresh", "freshStatus", "fresh_status", "freshIdentity", "fresh_identity", "freshOwnership", "fresh_ownership"]) {
    if (input?.[key] === false || falseValue(input?.[key])) reasons.add("unknown_effect");
  }
  for (const reason of BLOCKER_PRIORITY) {
    if (reason === "ready") continue;
    // A direct application is allowed to continue in the current owner
    // thread.  Handoff metadata may still be present in the readback, but it
    // belongs to a separate source-return lane and must not block this lane.
    // Unknown effects, ownership, reconciliation, auth, and provider gates
    // remain in the normal priority order below.
    if (reason === "handoff_gate_active" && directApplication) continue;
    if (reasons.has(reason) || hasSignal(nodes, reason)) return reason;
    if (reason === "foreign_owner" && ownershipSignals(input, nodes)) return reason;
  }
  return "ready";
}

export const normalizeResumeBlockerReason = normalizeBlockerReason;
export const normalizeResumeBlocker = normalizeBlockerReason;
export const normalizeBlocker = normalizeBlockerReason;

export function selectResumeBlocker(input = {}) {
  const reason = normalizeBlockerReason(input);
  return {
    reason,
    priority: BLOCKER_RANK.get(reason),
    blocked: reason !== "ready",
  };
}

function resolveKeyParts(inputOrTaskId, generation, lastTerminalTurnId, resumeIntent) {
  if (arguments.length === 1 && isRecord(inputOrTaskId)) {
    const input = inputOrTaskId;
    return {
      taskId: input.taskId ?? input.task_id ?? input.task?.taskId ?? input.task?.task_id ?? "",
      generation: input.generation ?? input.runtimeGeneration ?? input.runtime_generation ?? input.task?.generation ?? "",
      lastTerminalTurnId: input.lastTerminalTurnId
        ?? input.last_terminal_turn_id
        ?? input.lastTerminalTurn
        ?? input.last_terminal_turn
        ?? input.task?.lastTerminalTurnId
        ?? "",
      resumeIntent: input.resumeIntent ?? input.resume_intent ?? input.resume?.intent ?? input.intent ?? "",
    };
  }
  return { taskId: inputOrTaskId ?? "", generation: generation ?? "", lastTerminalTurnId: lastTerminalTurnId ?? "", resumeIntent: resumeIntent ?? "" };
}

/**
 * Create a deterministic key from the four resume identity fields.  The
 * canonical JSON object makes object-valued resume intents stable regardless
 * of property insertion order.
 */
export function createResumeIdempotencyKey(inputOrTaskId, generation, lastTerminalTurnId, resumeIntent) {
  const parts = resolveKeyParts(...arguments);
  return createHash("sha256").update(stableJson({
    taskId: stringValue(parts.taskId),
    generation: stringValue(parts.generation),
    lastTerminalTurnId: stringValue(parts.lastTerminalTurnId),
    resumeIntent: parts.resumeIntent,
  }), "utf8").digest("hex");
}

export const buildResumeIdempotencyKey = createResumeIdempotencyKey;
export const resumeIdempotencyKey = createResumeIdempotencyKey;
export const idempotencyKeyForResume = createResumeIdempotencyKey;

function pick(input, ...keys) {
  for (const key of keys) {
    if (input?.[key] !== undefined && input?.[key] !== null) return input[key];
  }
  return undefined;
}

function freshReadbackMissing(input) {
  const status = pick(input, "status", "freshStatus", "fresh_status") ?? input?.fresh?.status;
  const identity = pick(input, "identity", "freshIdentity", "fresh_identity") ?? input?.fresh?.identity;
  const ownership = pick(input, "ownership", "freshOwnership", "fresh_ownership") ?? input?.fresh?.ownership;
  return [
    !isRecord(status) && "status",
    !isRecord(identity) && "identity",
    !isRecord(ownership) && "ownership",
  ].filter(Boolean);
}

function resumeContext(input, idempotencyKey) {
  const status = pick(input, "status", "freshStatus", "fresh_status") ?? input?.fresh?.status ?? null;
  const identity = pick(input, "identity", "freshIdentity", "fresh_identity") ?? input?.fresh?.identity ?? null;
  const ownership = pick(input, "ownership", "freshOwnership", "fresh_ownership") ?? input?.fresh?.ownership ?? null;
  const taskId = pick(input, "taskId", "task_id") ?? input?.task?.taskId ?? input?.task?.task_id ?? null;
  const generation = pick(input, "generation", "runtimeGeneration", "runtime_generation") ?? input?.fresh?.generation ?? null;
  const lastTerminalTurnId = pick(input, "lastTerminalTurnId", "last_terminal_turn_id", "lastTerminalTurn", "last_terminal_turn") ?? null;
  const resumeIntent = pick(input, "resumeIntent", "resume_intent") ?? input?.resume?.intent ?? input?.intent ?? null;
  const threadId = pick(input, "sourceThreadId", "source_thread_id", "threadId", "thread_id")
    ?? identity?.sourceThreadId
    ?? identity?.source_thread_id
    ?? identity?.threadId
    ?? identity?.thread_id
    ?? null;
  return {
    taskId,
    task_id: taskId,
    generation,
    runtime_generation: generation,
    lastTerminalTurnId,
    last_terminal_turn_id: lastTerminalTurnId,
    resumeIntent,
    resume_intent: resumeIntent,
    idempotencyKey,
    idempotency_key: idempotencyKey,
    sourceThreadId: threadId,
    source_thread_id: threadId,
    threadId,
    thread_id: threadId,
    status,
    identity,
    ownership,
    ownerOnly: true,
    owner_only: true,
  };
}

function dependencySet(deps) {
  if (!isRecord(deps)) return null;
  for (const key of ["processedKeys", "processed_keys", "completedKeys", "completed_keys", "idempotencyKeys", "idempotency_keys", "seenKeys", "seen_keys"]) {
    const value = deps[key];
    if (value && typeof value.has === "function" && typeof value.add === "function") return value;
  }
  return null;
}

async function invokeIdempotencyLookup(deps, key) {
  if (!isRecord(deps)) return false;
  for (const name of ["hasIdempotencyKey", "isIdempotencyKeyUsed", "isProcessed", "hasProcessed", "hasSeen", "isSeen"]) {
    if (typeof deps[name] !== "function") continue;
    return Boolean(await deps[name](key));
  }
  for (const storeName of ["idempotencyStore", "idempotency", "store"]) {
    const store = deps[storeName];
    if (!store) continue;
    for (const name of ["has", "hasKey", "contains", "isProcessed", "isSeen"]) {
      if (typeof store[name] === "function") return Boolean(await store[name](key));
    }
  }
  const set = dependencySet(deps);
  return Boolean(set?.has(key));
}

async function rememberIdempotencyKey(deps, key) {
  if (!isRecord(deps)) return;
  for (const name of ["rememberIdempotencyKey", "markIdempotencyKey", "recordIdempotencyKey", "markProcessed", "remember", "record"]) {
    if (typeof deps[name] !== "function") continue;
    await deps[name](key);
    return;
  }
  const set = dependencySet(deps);
  if (set) {
    set.add(key);
    return;
  }
  let local = localSeenByDependencyObject.get(deps);
  if (!local) {
    local = new Set();
    localSeenByDependencyObject.set(deps, local);
  }
  local.add(key);
}

async function previouslySeen(deps, key) {
  if (await invokeIdempotencyLookup(deps, key)) return true;
  if (!isRecord(deps)) return false;
  return Boolean(localSeenByDependencyObject.get(deps)?.has(key));
}

function callback(deps, names) {
  if (!isRecord(deps)) return null;
  for (const name of names) {
    if (typeof deps[name] === "function") return deps[name].bind(deps);
  }
  return null;
}

function blockedReceipt(context, reason, extras = {}) {
  return {
    schema: RESUME_CURRENT_TASK_SCHEMA,
    status: "blocked",
    outcome: "blocked",
    reason,
    exactBlocker: reason,
    exact_blocker: reason,
    idempotencyKey: context.idempotencyKey,
    idempotency_key: context.idempotencyKey,
    taskId: context.taskId,
    task_id: context.task_id,
    sideEffects: [],
    side_effects: [],
    externalActionExecuted: false,
    external_action_executed: false,
    ...extras,
  };
}

function callbackFailure(value) {
  if (value === false || value === null) return true;
  if (!isRecord(value)) return false;
  return value.ok === false || value.success === false || value.status === "blocked" || Boolean(value.error || value.exact_blocker || value.exactBlocker);
}

function failureReason(value, fallback) {
  if (isRecord(value)) {
    const reason = normalizeBlockerReason(value);
    if (reason !== "ready") return reason;
    const exact = stringValue(value.exact_blocker ?? value.exactBlocker ?? value.error);
    if (exact) return exact;
  }
  return fallback;
}

function normalizeSession(value) {
  if (!isRecord(value)) return value ?? null;
  return {
    ...value,
    sessionId: value.sessionId ?? value.session_id ?? value.id ?? null,
    session_id: value.session_id ?? value.sessionId ?? value.id ?? null,
    generation: value.generation ?? null,
  };
}

/**
 * Resume one current task from a fresh status/identity/ownership readback.
 * No provider/browser/auth operation is performed here; all runtime behavior
 * is represented by the three explicitly injected callbacks.
 */
export async function resumeCurrentTask(input = {}, deps = {}) {
  const source = isRecord(input) ? input : {};
  const key = createResumeIdempotencyKey(source);
  const context = resumeContext(source, key);
  const missingInput = ["taskId", "generation", "lastTerminalTurnId", "resumeIntent"].some((name) => {
    const value = name === "taskId" ? context.taskId
      : name === "generation" ? context.generation
        : name === "lastTerminalTurnId" ? context.lastTerminalTurnId : context.resumeIntent;
    return value === undefined || value === null || stringValue(value) === "";
  });

  // Missing resume identity is an unsafe unknown state.  It is represented by
  // the canonical blocker and never reaches a callback.
  if (missingInput) {
    return blockedReceipt(context, "unknown_effect", { inputError: "resume_identity_incomplete" });
  }

  const missingReadback = freshReadbackMissing(source);
  if (missingReadback.length) {
    return blockedReceipt(context, "unknown_effect", {
      inputError: "fresh_readback_incomplete",
      missingReadback,
      missing_readback: missingReadback,
    });
  }

  const reason = normalizeBlockerReason(source);
  if (reason !== "ready") return blockedReceipt(context, reason);

  if (await previouslySeen(deps, key)) {
    return {
      schema: RESUME_CURRENT_TASK_SCHEMA,
      status: "noop",
      outcome: "noop",
      reason: "idempotency_noop",
      exactBlocker: null,
      exact_blocker: null,
      idempotencyKey: key,
      idempotency_key: key,
      taskId: context.taskId,
      task_id: context.task_id,
      noOp: true,
      no_op: true,
      sideEffects: [],
      side_effects: [],
      externalActionExecuted: false,
      external_action_executed: false,
    };
  }

  const cleanup = callback(deps, [
    "cleanupOwnerOnly", "cleanup_owner_only", "ownerOnlyCleanup", "owner_only_cleanup", "cleanupOwner", "cleanup_owner",
  ]);
  const createSession = callback(deps, [
    "createFreshSession", "create_fresh_session", "createFreshOwnerSession", "create_fresh_owner_session",
    "freshSession", "fresh_session", "createSession", "create_session",
  ]);
  const sendContinuation = callback(deps, [
    "sendThreadContinuation", "send_thread_continuation", "sendSameThreadContinuation", "send_same_thread_continuation",
    "sendContinuation", "send_continuation", "continueSameThread", "continue_same_thread", "continueThread", "continue_thread",
  ]);
  const missingDependencies = [
    !cleanup && "cleanupOwnerOnly",
    !createSession && "createFreshSession",
    !sendContinuation && "sendThreadContinuation",
  ].filter(Boolean);
  if (missingDependencies.length) {
    return blockedReceipt(context, "unknown_effect", {
      inputError: "resume_dependencies_missing",
      missingDependencies,
      missing_dependencies: missingDependencies,
    });
  }

  const sideEffects = [];
  const cleanupResult = await cleanup({ ...context, stage: "cleanup_owner_only", ownerOnly: true, owner_only: true });
  sideEffects.push("cleanup_owner_only");
  if (callbackFailure(cleanupResult)) {
    return blockedReceipt(context, failureReason(cleanupResult, "cleanup_owner_only_failed"), {
      sideEffects,
      side_effects: sideEffects,
      partial: true,
      failedStage: "cleanup_owner_only",
      failed_stage: "cleanup_owner_only",
      cleanup: cleanupResult ?? null,
    });
  }

  const sessionResult = await createSession({
    ...context,
    stage: "create_fresh_session",
    fresh: true,
    freshSession: true,
    fresh_session: true,
  });
  sideEffects.push("create_fresh_session");
  if (callbackFailure(sessionResult)) {
    return blockedReceipt(context, failureReason(sessionResult, "fresh_session_creation_failed"), {
      sideEffects,
      side_effects: sideEffects,
      partial: true,
      failedStage: "create_fresh_session",
      failed_stage: "create_fresh_session",
      cleanup: cleanupResult ?? null,
      session: normalizeSession(sessionResult),
    });
  }

  const session = normalizeSession(sessionResult);
  const continuationResult = await sendContinuation({
    ...context,
    stage: "send_thread_continuation",
    sameThread: true,
    same_thread: true,
    sourceThreadOnly: true,
    source_thread_only: true,
    threadOnly: true,
    thread_only: true,
    session,
  });
  sideEffects.push("send_thread_continuation");
  if (callbackFailure(continuationResult)) {
    return blockedReceipt(context, failureReason(continuationResult, "thread_continuation_failed"), {
      sideEffects,
      side_effects: sideEffects,
      partial: true,
      failedStage: "send_thread_continuation",
      failed_stage: "send_thread_continuation",
      cleanup: cleanupResult ?? null,
      session,
      continuation: continuationResult ?? null,
    });
  }

  await rememberIdempotencyKey(deps, key);
  return {
    schema: RESUME_CURRENT_TASK_SCHEMA,
    status: "resumed",
    outcome: "resumed",
    reason: "ready",
    exactBlocker: null,
    exact_blocker: null,
    idempotencyKey: key,
    idempotency_key: key,
    taskId: context.taskId,
    task_id: context.task_id,
    generation: context.generation,
    runtime_generation: context.runtime_generation,
    sourceThreadId: context.sourceThreadId,
    source_thread_id: context.source_thread_id,
    threadId: context.threadId,
    thread_id: context.thread_id,
    sideEffects,
    side_effects: sideEffects,
    cleanup: cleanupResult ?? null,
    session,
    continuation: continuationResult ?? null,
    externalActionExecuted: false,
    external_action_executed: false,
  };
}

function adapterInput(input, patch) {
  const source = isRecord(input) ? { ...input } : {};
  return { ...source, ...patch };
}

function flag(value) {
  if (value === true || value === 1 || bool(value)) return true;
  if (value === false || value === 0 || falseValue(value)) return false;
  return null;
}

function heavyProviderInactive(input) {
  const source = isRecord(input) ? input : {};
  const provider = isRecord(source.provider) ? source.provider : {};
  const explicit = flag(source.providerInactive ?? source.provider_inactive
    ?? source.status?.provider_inactive ?? source.status?.providerInactive);
  if (explicit !== null) return explicit;
  const active = flag(source.providerActive ?? source.provider_active
    ?? source.status?.providerActive ?? source.status?.provider_active
    ?? provider.active ?? provider.isActive ?? provider.is_active);
  if (active !== null) return !active;
  const status = normalizedToken(source.providerStatus ?? source.provider_status ?? provider.status);
  if (["inactive", "disabled", "unavailable", "not_ready", "paused", "quota_exceeded", "exceed_egress_quota"].includes(status)) return true;
  // A task-specific adapter without a fresh provider observation remains
  // fail-closed; callers can explicitly pass providerActive=true to proceed.
  return true;
}

function authRequired(input) {
  const source = isRecord(input) ? input : {};
  const auth = isRecord(source.auth ?? source.authentication) ? (source.auth ?? source.authentication) : {};
  const explicit = flag(source.humanAuthRequired ?? source.human_auth_required
    ?? source.authRequired ?? source.auth_required
    ?? source.status?.human_auth_required ?? source.status?.humanAuthRequired);
  if (explicit !== null) return explicit;
  const authenticated = flag(source.authenticated ?? source.isAuthenticated ?? source.loggedIn
    ?? source.authenticated_user ?? auth.authenticated ?? auth.isAuthenticated ?? auth.is_authenticated);
  if (authenticated !== null) return !authenticated;
  const required = flag(auth.required ?? auth.human ?? source.status?.auth_required);
  if (required !== null) return required;
  // Without an explicit authenticated readback an auth adapter must wait for
  // the human boundary instead of attempting credentials itself.
  return true;
}

/** Job resumes may continue the source thread only; no destination thread is invented. */
export function jobTaskAdapter(input = {}) {
  const source = isRecord(input) ? input : {};
  const sourceThreadId = input?.sourceThreadId ?? input?.source_thread_id ?? input?.threadId ?? input?.thread_id ?? null;
  const sourceStatus = normalizedToken(source.sourceStatus ?? source.source_status ?? source.handoffStatus ?? source.handoff_status);
  const sourceResumeReceipt = source.sourceResumeReceipt ?? source.source_resume_receipt ?? null;
  const resumeIntent = source.resumeIntent ?? source.resume_intent ?? source.resume?.intent ?? source.intent;
  const resumeMode = source.resumeMode ?? source.resume_mode ?? source.applicationResumeLane ?? source.application_resume_lane;
  const resumeModeToken = normalizedToken(resumeMode);
  const explicitDirectApplication = resumeModeToken === JOB_RESUME_LANES.DIRECT_APPLICATION;
  const explicitSourceReturn = source.sourceReturnRequested === true || source.source_return_requested === true;
  const explicitSourceResumeRequired = source.requireSourceResumeReceipt === true
    || source.require_source_resume_receipt === true;
  const sourceReturnRequested = explicitSourceResumeRequired
    || (!explicitDirectApplication && (explicitSourceReturn
      || resumeModeToken === JOB_RESUME_LANES.SOURCE_RETURN
      || sourceReturnIntent(resumeIntent)));
  const requireSourceResumeReceipt = sourceReturnRequested;
  let sourceResumeReceiptValid = null;
  let sourceResumeReceiptError = null;
  if (sourceResumeReceipt) {
    try {
      validateJobSourceResumeReceipt(sourceResumeReceipt, {
        sourceThreadId,
        runId: source.runId ?? source.run_id,
        idempotencyKey: source.idempotencyKey ?? source.idempotency_key,
      });
      sourceResumeReceiptValid = true;
    } catch (error) {
      sourceResumeReceiptValid = false;
      sourceResumeReceiptError = error instanceof Error ? error.message : String(error);
    }
  }
  const sourceResumeReceiptBlocked = requireSourceResumeReceipt && sourceResumeReceiptValid !== true;
  // `implementation_allowed=false` belongs to the Codex source-return
  // transition.  It is not an authority requirement for a normal Companion
  // application in the current owner thread.  Only the explicit
  // source-return lane applies the handoff gate.
  const handoffBlocked = requireSourceResumeReceipt && (source.implementationAllowed === false
    || source.implementation_allowed === false
    || ["reconciliation_only", "return_requested", "handoff_active", "handoff_gate_active"].includes(sourceStatus)
    || sourceResumeReceiptBlocked);
  const applicationResumeLane = sourceReturnRequested
    ? JOB_RESUME_LANES.SOURCE_RETURN
    : JOB_RESUME_LANES.DIRECT_APPLICATION;
  return adapterInput(input, {
    taskType: "job",
    task_type: "job",
    adapter: "job",
    sourceThreadOnly: true,
    source_thread_only: true,
    threadOnly: true,
    thread_only: true,
    threadPolicy: "source_thread_only",
    thread_policy: "source_thread_only",
    applicationResumeLane,
    application_resume_lane: applicationResumeLane,
    resumeLane: applicationResumeLane,
    resume_lane: applicationResumeLane,
    sourceReturnRequested,
    source_return_requested: sourceReturnRequested,
    sourceResumeRequired: requireSourceResumeReceipt,
    source_resume_required: requireSourceResumeReceipt,
    // Keep the old handoff fields in the readback for diagnosis, but make the
    // lane decision explicit so stale source metadata cannot become an
    // application gate.  The strict source-return lane leaves this false.
    handoffMetadataIgnoredForApplication: !sourceReturnRequested,
    handoff_metadata_ignored_for_application: !sourceReturnRequested,
    sourceThreadId,
    source_thread_id: sourceThreadId,
    threadId: sourceThreadId,
    thread_id: sourceThreadId,
    sourceResumeReceipt,
    source_resume_receipt: sourceResumeReceipt,
    sourceResumeReceiptValid,
    source_resume_receipt_valid: sourceResumeReceiptValid,
    sourceResumeReceiptError,
    source_resume_receipt_error: sourceResumeReceiptError,
    requireSourceResumeReceipt,
    require_source_resume_receipt: requireSourceResumeReceipt,
    handoffGateActive: handoffBlocked,
    handoff_gate_active: handoffBlocked,
    resumeBlocker: handoffBlocked ? "handoff_gate_active" : null,
    resume_blocker: handoffBlocked ? "handoff_gate_active" : null,
  });
}

/**
 * Prepare the only supported Job continuation after a completed no-output
 * handoff return.  This is an admission receipt, not an application result.
 */
export function prepareJobSourceResume(input = {}, options = {}) {
  const source = isRecord(input) ? input : {};
  const receipt = createJobSourceResumeReceipt({
    ...source,
    ...options,
    handoffReceipt: options.handoffReceipt ?? options.handoff_receipt ?? source.handoffReceipt ?? source.handoff_receipt,
    runId: options.runId ?? options.run_id,
    idempotencyKey: options.idempotencyKey ?? options.idempotency_key,
    ownerTaskId: options.ownerTaskId ?? options.owner_task_id ?? source.ownerTaskId ?? source.owner_task_id,
    companionEffectProof: options.companionEffectProof ?? options.companion_effect_proof ?? source.companionEffectProof ?? source.companion_effect_proof,
    companionEffectProofSecret: options.companionEffectProofSecret ?? options.companion_effect_proof_secret ?? source.companionEffectProofSecret ?? source.companion_effect_proof_secret,
  });
  validateJobSourceResumeReceipt(receipt, {
    sourceThreadId: receipt.source_thread_id,
    runId: receipt.run_id,
    idempotencyKey: receipt.idempotency_key,
  });
  return jobTaskAdapter({
    ...source,
    taskType: "job",
    sourceThreadId: receipt.source_thread_id,
    sourceStatus: "source_resume_ready",
    source_status: "source_resume_ready",
    implementationAllowed: true,
    implementation_allowed: true,
    sourceResumeReceipt: receipt,
    source_resume_receipt: receipt,
    requireSourceResumeReceipt: true,
    require_source_resume_receipt: true,
    runId: receipt.run_id,
    run_id: receipt.run_id,
    idempotencyKey: receipt.idempotency_key,
    idempotency_key: receipt.idempotency_key,
  });
}

export { createJobSourceResumeReceipt, validateJobSourceResumeReceipt };

/** Heavy resumes remain stopped until the provider is active again. */
export function heavyTaskAdapter(input = {}) {
  const inactive = heavyProviderInactive(input);
  return adapterInput(input, {
    taskType: "heavy",
    task_type: "heavy",
    adapter: "heavy",
    providerInactive: inactive,
    provider_inactive: inactive,
    resumeBlocker: inactive ? "provider_inactive" : null,
    resume_blocker: inactive ? "provider_inactive" : null,
    exactBlocker: inactive ? "provider_inactive" : null,
    exact_blocker: inactive ? "provider_inactive" : null,
  });
}

/** Auth resumes wait for a human authentication boundary and do not call effects. */
export function authTaskAdapter(input = {}) {
  const required = authRequired(input);
  return adapterInput(input, {
    taskType: "auth",
    task_type: "auth",
    adapter: "auth",
    humanAuthRequired: required,
    human_auth_required: required,
    resumeBlocker: required ? "human_auth_required" : null,
    resume_blocker: required ? "human_auth_required" : null,
    exactBlocker: required ? "human_auth_required" : null,
    exact_blocker: required ? "human_auth_required" : null,
  });
}

/**
 * Notes are local/read-only resume records.  Return an explicit fresh owner run
 * descriptor so callers can hand it to a later owner-scoped stage.
 */
export function noteTaskAdapter(input = {}) {
  const source = isRecord(input) ? input : {};
  const ownerRun = {
    taskId: source.taskId ?? source.task_id ?? null,
    task_id: source.task_id ?? source.taskId ?? null,
    generation: source.generation ?? source.runtimeGeneration ?? source.runtime_generation ?? null,
    sourceThreadId: source.sourceThreadId ?? source.source_thread_id ?? source.threadId ?? source.thread_id ?? null,
    source_thread_id: source.source_thread_id ?? source.sourceThreadId ?? source.threadId ?? source.thread_id ?? null,
    ownerOnly: true,
    owner_only: true,
    fresh: true,
    freshOwnerRun: true,
    fresh_owner_run: true,
  };
  return adapterInput(input, {
    taskType: "note",
    task_type: "note",
    adapter: "note",
    freshOwnerRun: true,
    fresh_owner_run: true,
    ownerOnly: true,
    owner_only: true,
    run: "fresh_owner_run",
    resumeRun: "fresh_owner_run",
    resume_run: "fresh_owner_run",
    ownerRun,
    owner_run: ownerRun,
  });
}

export const jobAdapter = jobTaskAdapter;
export const heavyAdapter = heavyTaskAdapter;
export const authAdapter = authTaskAdapter;
export const noteAdapter = noteTaskAdapter;
export const taskAdapters = Object.freeze({
  job: jobTaskAdapter,
  heavy: heavyTaskAdapter,
  auth: authTaskAdapter,
  note: noteTaskAdapter,
});

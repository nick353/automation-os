import { createHash } from "node:crypto";

/**
 * The local AOS record is the execution source for a browser attempt.  It is
 * deliberately small: Codex App may display this record, but it is not
 * required to create, continue, or validate a normal Companion session.
 */
export const AOS_EXECUTION_CONTEXT_SCHEMA = "automation_os_execution_context.v1";
export const AOS_EXECUTION_CONTEXT_SOURCE = "aos_local";
export const AOS_EXECUTION_CONTEXT_DEFAULT_OWNER = "automation_os_local";

const ID = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,239}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const AUTHORITY_SCOPES = new Set(["same_owner", "external_effect", "owner_transfer"]);
const EFFECT_STATES = new Set(["none", "planned", "executing", "confirmed", "unknown", "reconciled", "closed"]);
const RECONCILIATION_STATES = new Set(["not_required", "clear", "pending"]);
const HANDOFF_STATES = new Set(["none", "pending", "completed", "blocked"]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value, field, { required = false, max = 240 } = {}) {
  const normalized = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  if (!normalized) {
    if (required) throw new Error(`aos_execution_context_${field}_required`);
    return null;
  }
  if (normalized.length > max || !ID.test(normalized)) throw new Error(`aos_execution_context_${field}_invalid`);
  return normalized;
}

function enumValue(value, values, field, fallback) {
  const normalized = String(value ?? fallback).trim();
  if (!values.has(normalized)) throw new Error(`aos_execution_context_${field}_invalid`);
  return normalized;
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function digestFor(context) {
  const { context_digest: _ignored, ...payload } = context;
  return sha256(canonical(payload));
}

function routeFor(input = {}) {
  const route = isRecord(input.route) ? input.route : {};
  const backend = text(route.backend ?? input.backend ?? "aos_chrome_companion", "route_backend", { required: true });
  const surface = text(route.surface ?? input.surface ?? "aos_chrome_companion_profile_instance", "route_surface", { required: true });
  return {
    controller: "automation_os",
    backend,
    surface,
  };
}

function deriveAuthorityScope(input, handoffState, effectState) {
  if (input.authority_scope || input.authorityScope) {
    return enumValue(input.authority_scope ?? input.authorityScope, AUTHORITY_SCOPES, "authority_scope", "same_owner");
  }
  if (handoffState !== "none") return "owner_transfer";
  if (["planned", "executing", "confirmed", "unknown", "reconciled"].includes(effectState)) return "external_effect";
  return "same_owner";
}

function normalizedInput(input = {}, environment = {}) {
  const runId = text(input.run_id ?? input.runId ?? environment.AOS_RUN_ID, "run_id", { required: true });
  const taskId = text(input.task_id ?? input.taskId ?? environment.AOS_TASK_ID ?? runId, "task_id", { required: true });
  const ownerId = text(input.owner_id ?? input.ownerId ?? environment.AOS_OWNER_ID ?? AOS_EXECUTION_CONTEXT_DEFAULT_OWNER, "owner_id", { required: true });
  const generation = text(input.generation ?? input.generation_id ?? environment.AOS_GENERATION ?? environment.AOS_CHROME_COMPANION_GENERATION, "generation");
  const handoffState = enumValue(input.handoff_state ?? input.handoffState, HANDOFF_STATES, "handoff_state", "none");
  const effectState = enumValue(input.effect_state ?? input.effectState, EFFECT_STATES, "effect_state", "none");
  const reconciliationState = enumValue(
    input.reconciliation_state ?? input.reconciliationState,
    RECONCILIATION_STATES,
    "reconciliation_state",
    effectState === "unknown" ? "pending" : "not_required",
  );
  return {
    schema: AOS_EXECUTION_CONTEXT_SCHEMA,
    source: AOS_EXECUTION_CONTEXT_SOURCE,
    app_dependency: false,
    run_id: runId,
    task_id: taskId,
    owner_id: ownerId,
    generation,
    route: routeFor(input),
    authority_scope: deriveAuthorityScope(input, handoffState, effectState),
    effect_state: effectState,
    reconciliation_state: reconciliationState,
    handoff_state: handoffState,
  };
}

/** Build the context that is persisted in a run or attached to a Companion receipt. */
export function buildAosExecutionContext(input = {}, environment = {}) {
  const context = normalizedInput(input, environment);
  return Object.freeze({ ...context, context_digest: digestFor(context) });
}

/** Validate a context received from a caller without treating it as authority. */
export function validateAosExecutionContext(value) {
  if (!isRecord(value) || value.schema !== AOS_EXECUTION_CONTEXT_SCHEMA || value.source !== AOS_EXECUTION_CONTEXT_SOURCE || value.app_dependency !== false) {
    throw new Error("aos_execution_context_schema_invalid");
  }
  if (!isRecord(value.route) || value.route.controller !== "automation_os") throw new Error("aos_execution_context_route_invalid");
  const context = normalizedInput(value);
  if (typeof value.context_digest !== "string" || !DIGEST.test(value.context_digest) || value.context_digest !== digestFor(context)) {
    throw new Error("aos_execution_context_digest_invalid");
  }
  return Object.freeze({ ...context, context_digest: value.context_digest });
}

/** Resolve a supplied context or create one from the local AOS run inputs. */
export function resolveAosExecutionContext(input = {}, environment = {}) {
  const supplied = input.execution_context ?? input.executionContext;
  if (supplied !== undefined && supplied !== null) return validateAosExecutionContext(supplied);
  return buildAosExecutionContext(input, environment);
}

/** Same-owner continuation is intentionally the fast path for normal work. */
export function canContinueAosExecution(value) {
  const context = validateAosExecutionContext(value);
  return context.authority_scope !== "owner_transfer"
    && context.handoff_state === "none"
    && context.reconciliation_state !== "pending"
    && context.effect_state !== "unknown";
}

/** Owner-transfer proof remains required only when ownership or reconciliation changes. */
export function requiresAosOwnerTransferProof(value) {
  const context = validateAosExecutionContext(value);
  return context.authority_scope === "owner_transfer"
    || context.handoff_state !== "none"
    || context.reconciliation_state === "pending"
    || context.effect_state === "unknown";
}

export function executionContextPolicy(value) {
  const context = validateAosExecutionContext(value);
  return Object.freeze({
    source: context.source,
    app_dependency: false,
    same_owner_continuation: canContinueAosExecution(context),
    owner_transfer_proof_required: requiresAosOwnerTransferProof(context),
    reconciliation_required: context.reconciliation_state === "pending" || context.effect_state === "unknown",
    replay_allowed: false,
  });
}

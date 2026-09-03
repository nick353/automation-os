import { createHash } from "node:crypto";

/**
 * A run-local execution context is the single source used to bind a task to
 * its route and lifecycle.  Codex App can render this value, but it is not a
 * runtime dependency for normal AOS/Companion work.
 */
export const AOS_EXECUTION_CONTEXT_SCHEMA_V1 = "automation_os_execution_context.v1" as const;
export const AOS_EXECUTION_CONTEXT_SOURCE = "aos_local" as const;
export const AOS_EXECUTION_CONTEXT_DEFAULT_OWNER = "automation_os_local" as const;

export type AOSExecutionAuthorityScope = "same_owner" | "external_effect" | "owner_transfer";
export type AOSExecutionEffectState = "none" | "planned" | "executing" | "confirmed" | "unknown" | "reconciled" | "closed";
export type AOSExecutionReconciliationState = "not_required" | "clear" | "pending";
export type AOSExecutionHandoffState = "none" | "pending" | "completed" | "blocked";

export type AOSExecutionContextV1 = {
  schema: typeof AOS_EXECUTION_CONTEXT_SCHEMA_V1;
  source: typeof AOS_EXECUTION_CONTEXT_SOURCE;
  app_dependency: false;
  run_id: string;
  task_id: string;
  owner_id: string;
  generation: string | null;
  route: { controller: "automation_os"; backend: string; surface: string };
  authority_scope: AOSExecutionAuthorityScope;
  effect_state: AOSExecutionEffectState;
  reconciliation_state: AOSExecutionReconciliationState;
  handoff_state: AOSExecutionHandoffState;
  context_digest: string;
};

type ContextInput = {
  runId?: string;
  run_id?: string;
  taskId?: string;
  task_id?: string;
  ownerId?: string;
  owner_id?: string;
  generation?: string | null;
  route?: { backend?: string; surface?: string; controller?: string };
  backend?: string;
  surface?: string;
  authorityScope?: AOSExecutionAuthorityScope;
  authority_scope?: AOSExecutionAuthorityScope;
  effectState?: AOSExecutionEffectState;
  effect_state?: AOSExecutionEffectState;
  reconciliationState?: AOSExecutionReconciliationState;
  reconciliation_state?: AOSExecutionReconciliationState;
  handoffState?: AOSExecutionHandoffState;
  handoff_state?: AOSExecutionHandoffState;
};

const ID = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,239}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const AUTHORITY_SCOPES: readonly AOSExecutionAuthorityScope[] = ["same_owner", "external_effect", "owner_transfer"];
const EFFECT_STATES: readonly AOSExecutionEffectState[] = ["none", "planned", "executing", "confirmed", "unknown", "reconciled", "closed"];
const RECONCILIATION_STATES: readonly AOSExecutionReconciliationState[] = ["not_required", "clear", "pending"];
const HANDOFF_STATES: readonly AOSExecutionHandoffState[] = ["none", "pending", "completed", "blocked"];

function value(value: unknown, field: string, required = false): string | null {
  const normalized = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  if (!normalized) {
    if (required) throw new Error(`aos_execution_context_${field}_required`);
    return null;
  }
  if (!ID.test(normalized)) throw new Error(`aos_execution_context_${field}_invalid`);
  return normalized;
}

function enumValue<T extends string>(candidate: unknown, allowed: readonly T[], field: string, fallback: T): T {
  const normalized = String(candidate ?? fallback).trim();
  if (!allowed.includes(normalized as T)) throw new Error(`aos_execution_context_${field}_invalid`);
  return normalized as T;
}

function canonical(input: unknown): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
  const record = input as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function digest(input: unknown): string {
  return createHash("sha256").update(canonical(input), "utf8").digest("hex");
}

function payloadWithoutDigest(context: Omit<AOSExecutionContextV1, "context_digest">): Omit<AOSExecutionContextV1, "context_digest"> {
  return context;
}

function contextDigest(context: Omit<AOSExecutionContextV1, "context_digest">): string {
  return digest(payloadWithoutDigest(context));
}

function normalizedContext(input: ContextInput): Omit<AOSExecutionContextV1, "context_digest"> {
  const runId = value(input.run_id ?? input.runId, "run_id", true)!;
  const taskId = value(input.task_id ?? input.taskId ?? runId, "task_id", true)!;
  const ownerId = value(input.owner_id ?? input.ownerId ?? AOS_EXECUTION_CONTEXT_DEFAULT_OWNER, "owner_id", true)!;
  const generation = value(input.generation, "generation");
  const route = input.route ?? {};
  const backend = value(route.backend ?? input.backend ?? "aos_chrome_companion", "route_backend", true)!;
  const surface = value(route.surface ?? input.surface ?? "aos_chrome_companion_profile_instance", "route_surface", true)!;
  const handoffState = enumValue(input.handoff_state ?? input.handoffState, HANDOFF_STATES, "handoff_state", "none");
  const effectState = enumValue(input.effect_state ?? input.effectState, EFFECT_STATES, "effect_state", "none");
  const reconciliationState = enumValue(
    input.reconciliation_state ?? input.reconciliationState,
    RECONCILIATION_STATES,
    "reconciliation_state",
    effectState === "unknown" ? "pending" : "not_required",
  );
  const authorityScope = input.authority_scope ?? input.authorityScope
    ?? (handoffState !== "none" ? "owner_transfer" : ["planned", "executing", "confirmed", "unknown", "reconciled"].includes(effectState) ? "external_effect" : "same_owner");
  return {
    schema: AOS_EXECUTION_CONTEXT_SCHEMA_V1,
    source: AOS_EXECUTION_CONTEXT_SOURCE,
    app_dependency: false,
    run_id: runId,
    task_id: taskId,
    owner_id: ownerId,
    generation,
    route: { controller: "automation_os", backend, surface },
    authority_scope: enumValue(authorityScope, AUTHORITY_SCOPES, "authority_scope", "same_owner"),
    effect_state: effectState,
    reconciliation_state: reconciliationState,
    handoff_state: handoffState,
  };
}

export function buildAosExecutionContext(input: ContextInput = {}): AOSExecutionContextV1 {
  const context = normalizedContext(input);
  return Object.freeze({ ...context, context_digest: contextDigest(context) });
}

export function validateAosExecutionContext(input: unknown): AOSExecutionContextV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("aos_execution_context_schema_invalid");
  const valueInput = input as Record<string, unknown>;
  if (valueInput.schema !== AOS_EXECUTION_CONTEXT_SCHEMA_V1 || valueInput.source !== AOS_EXECUTION_CONTEXT_SOURCE || valueInput.app_dependency !== false) {
    throw new Error("aos_execution_context_schema_invalid");
  }
  if (!valueInput.route || typeof valueInput.route !== "object" || Array.isArray(valueInput.route)
    || (valueInput.route as Record<string, unknown>).controller !== "automation_os") {
    throw new Error("aos_execution_context_route_invalid");
  }
  const context = normalizedContext(valueInput as ContextInput);
  if (!context.route || context.route.controller !== "automation_os") throw new Error("aos_execution_context_route_invalid");
  if (typeof valueInput.context_digest !== "string" || !DIGEST.test(valueInput.context_digest) || valueInput.context_digest !== contextDigest(context)) {
    throw new Error("aos_execution_context_digest_invalid");
  }
  return Object.freeze({ ...context, context_digest: valueInput.context_digest });
}

export function resolveAosExecutionContext(input: ContextInput & { execution_context?: unknown; executionContext?: unknown } = {}): AOSExecutionContextV1 {
  const supplied = input.execution_context ?? input.executionContext;
  return supplied === undefined || supplied === null
    ? buildAosExecutionContext(input)
    : validateAosExecutionContext(supplied);
}

export function canContinueAosExecution(input: AOSExecutionContextV1): boolean {
  const context = validateAosExecutionContext(input);
  return context.authority_scope !== "owner_transfer"
    && context.handoff_state === "none"
    && context.reconciliation_state !== "pending"
    && context.effect_state !== "unknown";
}

export function requiresAosOwnerTransferProof(input: AOSExecutionContextV1): boolean {
  const context = validateAosExecutionContext(input);
  return context.authority_scope === "owner_transfer"
    || context.handoff_state !== "none"
    || context.reconciliation_state === "pending"
    || context.effect_state === "unknown";
}

export function executionContextPolicy(input: AOSExecutionContextV1): {
  source: typeof AOS_EXECUTION_CONTEXT_SOURCE;
  app_dependency: false;
  same_owner_continuation: boolean;
  owner_transfer_proof_required: boolean;
  reconciliation_required: boolean;
  replay_allowed: false;
} {
  const context = validateAosExecutionContext(input);
  return {
    source: context.source,
    app_dependency: false,
    same_owner_continuation: canContinueAosExecution(context),
    owner_transfer_proof_required: requiresAosOwnerTransferProof(context),
    reconciliation_required: context.reconciliation_state === "pending" || context.effect_state === "unknown",
    replay_allowed: false,
  };
}

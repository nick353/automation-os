import { createHash } from "node:crypto";
import type {
  AutomationKernelCompatibilityProjectionV1,
  AutomationKernelDefinitionV1,
  AutomationKernelEffectClassV1,
  AutomationKernelEffectStateV1,
  AutomationKernelLogInputV1,
  AutomationKernelSnapshotV1
} from "./contracts.js";

export type AutomationKernelReducedTimelineEntryV1 = {
  schema_version: "automation_kernel.timeline.v1";
  kernel_id: string;
  sequence: number;
  entry_kind: "kernel_event" | "effect_receipt" | "heartbeat";
  previous_entry_hash: string;
  entry_hash: string;
  created_at: string;
  payload: Record<string, unknown>;
};

export class AutomationKernelReducerError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AutomationKernelReducerError";
  }
}

const blockedReceipts = new Set(["failed"]);

export function hashAutomationKernelValue(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function buildAutomationKernelTimelineEntry(input: {
  kernelId: string;
  sequence: number;
  entryKind: AutomationKernelReducedTimelineEntryV1["entry_kind"];
  previousEntryHash: string;
  createdAt: string;
  payload: Record<string, unknown>;
}): AutomationKernelReducedTimelineEntryV1 {
  const base = {
    schema_version: "automation_kernel.timeline.v1" as const,
    kernel_id: input.kernelId,
    sequence: input.sequence,
    entry_kind: input.entryKind,
    previous_entry_hash: input.previousEntryHash,
    created_at: input.createdAt,
    payload: input.payload
  };
  return {
    ...base,
    entry_hash: hashAutomationKernelValue(base)
  };
}

export function reduceAutomationKernelDefinitionV1(
  definition: AutomationKernelDefinitionV1,
  timeline: readonly AutomationKernelReducedTimelineEntryV1[]
): AutomationKernelSnapshotV1 {
  const effects = definition.effects.map((effect) => toEffectState(effect.effect_id, effect.effect_class, effect.summary, effect.payload));
  const effectIndex = new Map<string, number>(effects.map((effect, index) => [effect.effect_id, index]));
  let blockedEffectId: string | null = null;
  let exactBlocker: string | null = null;
  let eventCount = 0;
  let receiptCount = 0;
  let heartbeatCount = 0;
  let lastEntryHash = hashAutomationKernelValue(definition);
  let lastCreatedAt: string | null = null;
  let createdAt: string | null = null;

  for (const entry of timeline) {
    if (entry.kernel_id !== definition.kernel_id) throw new AutomationKernelReducerError("kernel_timeline_kernel_id_mismatch");
    if (entry.sequence < 1 || !Number.isSafeInteger(entry.sequence)) throw new AutomationKernelReducerError("kernel_timeline_sequence_invalid");
    if (entry.previous_entry_hash !== lastEntryHash) throw new AutomationKernelReducerError("kernel_timeline_previous_hash_mismatch");
    const expectedHash = hashAutomationKernelValue({
      schema_version: "automation_kernel.timeline.v1",
      kernel_id: definition.kernel_id,
      sequence: entry.sequence,
      entry_kind: entry.entry_kind,
      previous_entry_hash: entry.previous_entry_hash,
      created_at: entry.created_at,
      payload: entry.payload
    });
    if (entry.entry_hash !== expectedHash) throw new AutomationKernelReducerError("kernel_timeline_entry_hash_mismatch");
    lastEntryHash = entry.entry_hash;
    lastCreatedAt = entry.created_at;
    createdAt ??= entry.created_at;

    if (entry.entry_kind === "heartbeat") {
      heartbeatCount += 1;
      if (entry.payload.heartbeat_owner !== "caller") {
        blockedEffectId = blockedEffectId ?? null;
        exactBlocker = exactBlocker ?? "kernel_heartbeat_owner_invalid";
      }
      continue;
    }

    if (entry.entry_kind === "kernel_event") {
      eventCount += 1;
      const eventType = stringValue(entry.payload.event_type);
      if (eventType === "effect_claimed") {
        const effectId = stringValue(entry.payload.effect_id);
        const effect = effectById(effectIndex, effects, effectId);
        const unitId = optionalString(entry.payload.unit_id);
        const continuation = isContinuationEffect(effect);
        const replayable = continuation && effect.status === "claimed" && effect.active_unit_id === null && effect.last_outcome === "succeeded" && effect.stage_terminal === false;
        if (unitId && effect.unit_ids.includes(unitId)) {
          blockedEffectId ??= effectId;
          exactBlocker ??= `kernel_effect_unit_id_duplicate:${effectId}`;
          continue;
        }
        if (effect.status === "pending") {
          if (continuation && !unitId) {
            blockedEffectId ??= effectId;
            exactBlocker ??= `kernel_effect_unit_id_required:${effectId}`;
            continue;
          }
        } else if (!replayable) {
          blockedEffectId ??= effectId;
          exactBlocker ??= `kernel_effect_claim_conflict:${effectId}`;
          continue;
        }
        if (continuation && !unitId) {
          blockedEffectId ??= effectId;
          exactBlocker ??= `kernel_effect_unit_id_required:${effectId}`;
          continue;
        }
        effect.status = "claimed";
        effect.claim_id = stringValue(entry.payload.claim_id);
        effect.last_claimed_by = stringValue(entry.payload.claimed_by);
        effect.active_unit_id = unitId ?? null;
        effect.last_unit_id = unitId ?? effect.last_unit_id;
        if (unitId) effect.unit_ids = [...effect.unit_ids, unitId];
        continue;
      }
      if (eventType === "effect_reconciled") {
        const effectId = stringValue(entry.payload.effect_id);
        const effect = effectById(effectIndex, effects, effectId);
        if (effect.status !== "reconciliation_required") {
          blockedEffectId ??= effectId;
          exactBlocker ??= `kernel_reconciliation_without_ambiguity:${effectId}`;
          continue;
        }
        const resolution = stringValue(entry.payload.resolution);
        effect.resolution_id = stringValue(entry.payload.reconciliation_id);
        effect.status = resolution === "succeeded" ? "succeeded" : "failed";
        if (effect.status === "failed") {
          blockedEffectId ??= effectId;
          exactBlocker ??= effect.evidence_exact_blocker ?? `kernel_effect_failed:${effectId}`;
        }
        continue;
      }
      throw new AutomationKernelReducerError(`kernel_event_type_unknown:${eventType}`);
    }

    receiptCount += 1;
    const effectId = stringValue(entry.payload.effect_id);
    const effect = effectById(effectIndex, effects, effectId);
    const unitId = optionalString(entry.payload.unit_id);
    const stageTerminal = entry.payload.stage_terminal === undefined ? true : booleanValue(entry.payload.stage_terminal);
    if (effect.status === "pending") {
      blockedEffectId ??= effectId;
      exactBlocker ??= `kernel_receipt_without_claim:${effectId}`;
      continue;
    }
    if (unitId && effect.active_unit_id !== unitId) {
      blockedEffectId ??= effectId;
      exactBlocker ??= `kernel_receipt_without_active_unit:${effectId}`;
      continue;
    }
    if (isContinuationEffect(effect) && !unitId) {
      blockedEffectId ??= effectId;
      exactBlocker ??= `kernel_receipt_unit_id_required:${effectId}`;
      continue;
    }
    if (!isContinuationEffect(effect) && stageTerminal === false) {
      blockedEffectId ??= effectId;
      exactBlocker ??= `kernel_receipt_stage_terminal_required:${effectId}`;
      continue;
    }
    const outcome = stringValue(entry.payload.outcome) as "succeeded" | "failed" | "ambiguous";
    effect.receipt_id = stringValue(entry.payload.receipt_id);
    effect.external_action_executed = Boolean(entry.payload.external_action_executed);
    effect.last_outcome = outcome;
    effect.last_unit_id = unitId ?? effect.last_unit_id;
    effect.stage_terminal = stageTerminal;
    effect.evidence_exact_blocker = receiptExactBlocker(entry.payload) ?? effect.evidence_exact_blocker;
    effect.active_unit_id = null;
    if (outcome === "succeeded") {
      effect.status = stageTerminal === false ? "claimed" : "succeeded";
      continue;
    }
    if (outcome === "failed") {
      effect.status = "failed";
      blockedEffectId ??= effectId;
      exactBlocker ??= receiptExactBlocker(entry.payload) ?? `kernel_effect_failed:${effectId}`;
      continue;
    }
    const effectClass = stringValue(entry.payload.effect_class) as AutomationKernelEffectClassV1;
    if (effectClass === "external_non_idempotent") {
      effect.status = "reconciliation_required";
      exactBlocker = exactBlocker ?? receiptExactBlocker(entry.payload) ?? "kernel_external_ambiguous_reconciliation_required";
      continue;
    }
    effect.status = "failed";
    blockedEffectId ??= effectId;
    exactBlocker ??= receiptExactBlocker(entry.payload) ?? `kernel_internal_idempotent_ambiguous_receipt:${effectId}`;
  }

  const nextEffectId = computeNextClaimableEffectId(effects);
  const activeClaimedEffectId = effects.find((effect) => (
    effect.status === "claimed"
    && (!isContinuationEffect(effect) || effect.active_unit_id !== null)
  ))?.effect_id ?? null;
  const activeEffectId = activeClaimedEffectId
    ?? effects.find((effect) => effect.status === "reconciliation_required")?.effect_id
    ?? null;
  const claimedEffectIds = effects.filter((effect) => effect.status === "claimed" || effect.status === "reconciliation_required").map((effect) => effect.effect_id);
  const completedEffectIds = effects.filter((effect) => effect.status === "succeeded").map((effect) => effect.effect_id);
  const status = blockedEffectId
    ? "blocked"
    : effects.some((effect) => effect.status === "reconciliation_required")
      ? "reconciliation_required"
      : effects.every((effect) => effect.status === "succeeded")
        ? "complete"
        : claimedEffectIds.length > 0 || completedEffectIds.length > 0
          ? "running"
          : "ready";

  return {
    schema_version: "automation_kernel.snapshot.v1",
    kernel_id: definition.kernel_id,
    title: definition.title,
    heartbeat_owner: "caller",
    status,
    exact_blocker: blockedEffectId ? exactBlocker : status === "reconciliation_required" ? exactBlocker ?? "kernel_external_ambiguous_reconciliation_required" : null,
    definition_hash: hashAutomationKernelValue(definition),
    timeline_hash: lastEntryHash,
    next_effect_id: nextEffectId,
    active_effect_id: activeEffectId,
    claimed_effect_ids: [...claimedEffectIds],
    completed_effect_ids: [...completedEffectIds],
    effects,
    event_count: eventCount,
    receipt_count: receiptCount,
    heartbeat_count: heartbeatCount,
    created_at: createdAt,
    updated_at: lastCreatedAt ?? createdAt
  };
}

export function projectAutomationKernelSnapshotV1(snapshot: AutomationKernelSnapshotV1): AutomationKernelCompatibilityProjectionV1 {
  const missing = snapshot.effects.flatMap((effect) => {
    if (effect.status === "pending") return [`effect:${effect.effect_id}:pending`];
    if (effect.status === "failed") return [`effect:${effect.effect_id}:failed`];
    if (effect.status === "reconciliation_required") return [`effect:${effect.effect_id}:reconciliation_required`];
    return [];
  });
  const present = snapshot.effects.flatMap((effect) => {
    if (effect.status === "claimed") return [`effect:${effect.effect_id}:claimed`];
    if (effect.status === "succeeded") return [`effect:${effect.effect_id}:succeeded`];
    return [];
  });
  return {
    registered_status: snapshot.status === "complete" ? "complete" : "blocked",
    legacy_status: snapshot.status === "complete" ? "complete" : present.length > 0 ? "partial" : "blocked",
    proof_gate: {
      ok: snapshot.status === "complete",
      missing: snapshot.status === "complete" ? [] : missing.length > 0 ? missing : [snapshot.exact_blocker ?? "kernel_incomplete"],
      present
    },
    exact_blocker: snapshot.exact_blocker,
    kernel_status: snapshot.status
  };
}

function toEffectState(
  effectId: string,
  effectClass: AutomationKernelEffectClassV1,
  summary: string,
  payload: Record<string, unknown>
): AutomationKernelEffectStateV1 {
  return {
    effect_id: effectId,
    effect_class: effectClass,
    summary,
    payload,
    status: "pending",
    claim_id: null,
    receipt_id: null,
    resolution_id: null,
    last_outcome: null,
    last_claimed_by: null,
    external_action_executed: null,
    active_unit_id: null,
    unit_ids: [],
    last_unit_id: null,
    stage_terminal: null,
    evidence_exact_blocker: null
  };
}

function effectById(effectIndex: Map<string, number>, effects: AutomationKernelEffectStateV1[], effectId: string): AutomationKernelEffectStateV1 {
  const index = effectIndex.get(effectId);
  if (index === undefined) throw new AutomationKernelReducerError(`kernel_effect_unknown:${effectId}`);
  return effects[index]!;
}

function computeNextClaimableEffectId(effects: AutomationKernelEffectStateV1[]): string | null {
  let priorBlockingTerminal = false;
  for (const effect of effects) {
    if (effect.status === "succeeded") continue;
    if (effect.status === "failed" || effect.status === "reconciliation_required") {
      priorBlockingTerminal = true;
      continue;
    }
    if (effect.status === "claimed") {
      if (!isContinuationEffect(effect) || effect.active_unit_id !== null) return null;
      if (isReplayableContinuation(effect, priorBlockingTerminal)) return effect.effect_id;
      return null;
    }
    if (effect.status === "pending") {
      if (isClaimablePending(effect, priorBlockingTerminal)) return effect.effect_id;
      continue;
    }
  }
  return null;
}

function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new AutomationKernelReducerError("kernel_non_json_value");
      return input;
    }
    if (Array.isArray(input)) return input.map((item) => normalize(item));
    if (typeof input === "object") {
      if (seen.has(input)) throw new AutomationKernelReducerError("kernel_non_json_value");
      seen.add(input);
      const object = input as Record<string, unknown>;
      const normalized = Object.fromEntries(
        Object.keys(object)
          .filter((key) => object[key] !== undefined)
          .sort()
          .map((key) => [key, normalize(object[key])])
      );
      seen.delete(input);
      return normalized;
    }
    throw new AutomationKernelReducerError("kernel_non_json_value");
  };
  return JSON.stringify(normalize(value));
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new AutomationKernelReducerError("kernel_log_value_invalid");
  return value.trim();
}

function receiptExactBlocker(payload: Record<string, unknown>): string | null {
  const evidence = payload.evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return null;
  const value = (evidence as Record<string, unknown>).exact_blocker;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return stringValue(value);
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") throw new AutomationKernelReducerError("kernel_log_value_invalid");
  return value;
}

function isContinuationEffect(effect: AutomationKernelEffectStateV1): boolean {
  return effect.payload.continuation !== null && typeof effect.payload.continuation === "object";
}

function isAlwaysRunEffect(effect: AutomationKernelEffectStateV1): boolean {
  return effect.payload.always_run === true;
}

function isReplayableContinuation(effect: AutomationKernelEffectStateV1, priorBlockingTerminal: boolean): boolean {
  return isContinuationEffect(effect)
    && effect.status === "claimed"
    && effect.active_unit_id === null
    && effect.last_outcome === "succeeded"
    && effect.stage_terminal === false
    && (!priorBlockingTerminal || isAlwaysRunEffect(effect));
}

function isClaimablePending(effect: AutomationKernelEffectStateV1, priorBlockingTerminal: boolean): boolean {
  return effect.status === "pending" && (!priorBlockingTerminal || isAlwaysRunEffect(effect));
}

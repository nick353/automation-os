export type JsonObject = Record<string, unknown>;

export type AutomationKernelEffectClassV1 = "internal_idempotent" | "external_non_idempotent";
export type AutomationKernelReceiptOutcomeV1 = "succeeded" | "failed" | "ambiguous";

export type AutomationKernelDefinitionV1 = {
  schema_version: "automation_kernel.v1";
  kernel_id: string;
  title: string;
  heartbeat_owner: "caller";
  effects: AutomationKernelEffectDefinitionV1[];
  metadata: JsonObject;
};

export type AutomationKernelEffectDefinitionV1 = {
  effect_id: string;
  effect_class: AutomationKernelEffectClassV1;
  summary: string;
  payload: JsonObject;
};

export type AutomationKernelTimelineEntryV1 = {
  schema_version: "automation_kernel.timeline.v1";
  kernel_id: string;
  sequence: number;
  entry_kind: "kernel_event" | "effect_receipt" | "heartbeat";
  previous_entry_hash: string;
  entry_hash: string;
  created_at: string;
  payload: JsonObject;
};

export type AutomationKernelEventInputV1 =
  | {
      event_type: "effect_claimed";
      effect_id: string;
      claimed_by: string;
      claim_id: string;
      heartbeat_owner: "caller";
      unit_id?: string;
    }
  | {
      event_type: "effect_reconciled";
      effect_id: string;
      resolution: "succeeded" | "failed";
      reconciliation_id: string;
      claimed_by: string;
    }
  | {
      event_type: "heartbeat_recorded";
      heartbeat_owner: "caller";
      owner_token: string;
    };

export type AutomationKernelEffectReceiptInputV1 = {
  event_type: "effect_receipt_recorded";
  effect_id: string;
  receipt_id: string;
  effect_class: AutomationKernelEffectClassV1;
  outcome: AutomationKernelReceiptOutcomeV1;
  external_action_executed: boolean;
  summary: string;
  evidence: JsonObject;
  unit_id?: string;
  stage_terminal?: boolean;
};

export type AutomationKernelLogInputV1 = AutomationKernelEventInputV1 | AutomationKernelEffectReceiptInputV1;

export type AutomationKernelEffectStateV1 = {
  effect_id: string;
  effect_class: AutomationKernelEffectClassV1;
  summary: string;
  payload: JsonObject;
  status: "pending" | "claimed" | "succeeded" | "failed" | "reconciliation_required";
  claim_id: string | null;
  receipt_id: string | null;
  resolution_id: string | null;
  last_outcome: AutomationKernelReceiptOutcomeV1 | null;
  last_claimed_by: string | null;
  external_action_executed: boolean | null;
  active_unit_id: string | null;
  unit_ids: string[];
  last_unit_id: string | null;
  stage_terminal: boolean | null;
  evidence_exact_blocker: string | null;
};

export type AutomationKernelSnapshotV1 = {
  schema_version: "automation_kernel.snapshot.v1";
  kernel_id: string;
  title: string;
  heartbeat_owner: "caller";
  status: "ready" | "running" | "reconciliation_required" | "complete" | "blocked";
  exact_blocker: string | null;
  definition_hash: string;
  timeline_hash: string;
  next_effect_id: string | null;
  active_effect_id: string | null;
  claimed_effect_ids: string[];
  completed_effect_ids: string[];
  effects: AutomationKernelEffectStateV1[];
  event_count: number;
  receipt_count: number;
  heartbeat_count: number;
  created_at: string | null;
  updated_at: string | null;
};

export type AutomationKernelCompatibilityProjectionV1 = {
  registered_status: "complete" | "blocked";
  legacy_status: "complete" | "partial" | "blocked";
  proof_gate: {
    ok: boolean;
    missing: string[];
    present: string[];
  };
  exact_blocker: string | null;
  kernel_status: AutomationKernelSnapshotV1["status"];
};

export class AutomationKernelContractError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AutomationKernelContractError";
  }
}

const effectClassValues = new Set<AutomationKernelEffectClassV1>(["internal_idempotent", "external_non_idempotent"]);
const receiptOutcomeValues = new Set<AutomationKernelReceiptOutcomeV1>(["succeeded", "failed", "ambiguous"]);
const kernelIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,120}$/;

export function parseAutomationKernelDefinitionV1(value: unknown): AutomationKernelDefinitionV1 {
  const body = objectValue(value, "kernel_definition_required");
  rejectUnknownFields(body, new Set(["schema_version", "kernel_id", "title", "heartbeat_owner", "effects", "metadata"]), "kernel_definition_unknown_field");
  if (body.schema_version !== "automation_kernel.v1") throw new AutomationKernelContractError("kernel_definition_schema_version_invalid");
  const heartbeatOwner = stringValue(body.heartbeat_owner, "kernel_definition_heartbeat_owner");
  if (heartbeatOwner !== "caller") throw new AutomationKernelContractError("kernel_definition_heartbeat_owner_invalid");
  const effects = arrayValue(body.effects, "kernel_definition_effects");
  if (effects.length === 0) throw new AutomationKernelContractError("kernel_definition_effects_required");
  const parsedEffects = effects.map(parseAutomationKernelEffectDefinitionV1);
  const effectIds = parsedEffects.map((effect) => effect.effect_id);
  if (new Set(effectIds).size !== effectIds.length) throw new AutomationKernelContractError("kernel_definition_effect_id_duplicate");
  return {
    schema_version: "automation_kernel.v1",
    kernel_id: kernelId(body.kernel_id, "kernel_definition_kernel_id"),
    title: boundedString(body.title, "kernel_definition_title", 1, 160),
    heartbeat_owner: "caller",
    effects: parsedEffects,
    metadata: objectValue(body.metadata ?? {}, "kernel_definition_metadata_invalid")
  };
}

export function parseAutomationKernelEffectDefinitionV1(value: unknown): AutomationKernelEffectDefinitionV1 {
  const body = objectValue(value, "kernel_effect_definition_required");
  rejectUnknownFields(body, new Set(["effect_id", "effect_class", "summary", "payload"]), "kernel_effect_definition_unknown_field");
  const effectClass = stringValue(body.effect_class, "kernel_effect_definition_effect_class");
  if (!effectClassValues.has(effectClass as AutomationKernelEffectClassV1)) {
    throw new AutomationKernelContractError("kernel_effect_definition_effect_class_invalid");
  }
  return {
    effect_id: effectId(body.effect_id, "kernel_effect_definition_effect_id"),
    effect_class: effectClass as AutomationKernelEffectClassV1,
    summary: boundedString(body.summary, "kernel_effect_definition_summary", 1, 240),
    payload: objectValue(body.payload ?? {}, "kernel_effect_definition_payload_invalid")
  };
}

export function parseAutomationKernelEventInputV1(value: unknown): AutomationKernelEventInputV1 {
  const body = objectValue(value, "kernel_event_required");
  const eventType = stringValue(body.event_type, "kernel_event_type");
  if (eventType === "effect_claimed") {
    rejectUnknownFields(body, new Set(["event_type", "effect_id", "claimed_by", "claim_id", "heartbeat_owner", "unit_id"]), "kernel_event_unknown_field");
    return {
      event_type: "effect_claimed",
      effect_id: effectId(body.effect_id, "kernel_event_effect_id"),
      claimed_by: boundedString(body.claimed_by, "kernel_event_claimed_by", 1, 120),
      claim_id: stableId(body.claim_id, "kernel_event_claim_id"),
      heartbeat_owner: heartbeatOwner(body.heartbeat_owner),
      ...(body.unit_id === undefined ? {} : { unit_id: effectId(body.unit_id, "kernel_event_unit_id") })
    };
  }
  if (eventType === "effect_reconciled") {
    rejectUnknownFields(body, new Set(["event_type", "effect_id", "resolution", "reconciliation_id", "claimed_by"]), "kernel_event_unknown_field");
    const resolution = stringValue(body.resolution, "kernel_event_resolution");
    if (resolution !== "succeeded" && resolution !== "failed") throw new AutomationKernelContractError("kernel_event_resolution_invalid");
    return {
      event_type: "effect_reconciled",
      effect_id: effectId(body.effect_id, "kernel_event_effect_id"),
      resolution,
      reconciliation_id: stableId(body.reconciliation_id, "kernel_event_reconciliation_id"),
      claimed_by: boundedString(body.claimed_by, "kernel_event_claimed_by", 1, 120)
    };
  }
  if (eventType === "heartbeat_recorded") {
    rejectUnknownFields(body, new Set(["event_type", "heartbeat_owner", "owner_token"]), "kernel_event_unknown_field");
    return {
      event_type: "heartbeat_recorded",
      heartbeat_owner: heartbeatOwner(body.heartbeat_owner),
      owner_token: stableId(body.owner_token, "kernel_event_owner_token")
    };
  }
  throw new AutomationKernelContractError("kernel_event_type_invalid");
}

export function parseAutomationKernelEffectReceiptInputV1(value: unknown): AutomationKernelEffectReceiptInputV1 {
  const body = objectValue(value, "kernel_effect_receipt_required");
  rejectUnknownFields(body, new Set(["event_type", "effect_id", "receipt_id", "effect_class", "outcome", "external_action_executed", "summary", "evidence", "unit_id", "stage_terminal"]), "kernel_effect_receipt_unknown_field");
  if (body.event_type !== "effect_receipt_recorded") throw new AutomationKernelContractError("kernel_effect_receipt_event_type_invalid");
  const effectClass = stringValue(body.effect_class, "kernel_effect_receipt_effect_class");
  if (!effectClassValues.has(effectClass as AutomationKernelEffectClassV1)) {
    throw new AutomationKernelContractError("kernel_effect_receipt_effect_class_invalid");
  }
  const outcome = stringValue(body.outcome, "kernel_effect_receipt_outcome");
  if (!receiptOutcomeValues.has(outcome as AutomationKernelReceiptOutcomeV1)) {
    throw new AutomationKernelContractError("kernel_effect_receipt_outcome_invalid");
  }
  return {
    event_type: "effect_receipt_recorded",
    effect_id: effectId(body.effect_id, "kernel_effect_receipt_effect_id"),
    receipt_id: stableId(body.receipt_id, "kernel_effect_receipt_id"),
    effect_class: effectClass as AutomationKernelEffectClassV1,
    outcome: outcome as AutomationKernelReceiptOutcomeV1,
    external_action_executed: booleanValue(body.external_action_executed, "kernel_effect_receipt_external_action_executed"),
    summary: boundedString(body.summary, "kernel_effect_receipt_summary", 1, 240),
    evidence: objectValue(body.evidence ?? {}, "kernel_effect_receipt_evidence_invalid"),
    ...(body.unit_id === undefined ? {} : { unit_id: effectId(body.unit_id, "kernel_effect_receipt_unit_id") }),
    ...(body.stage_terminal === undefined ? {} : { stage_terminal: booleanValue(body.stage_terminal, "kernel_effect_receipt_stage_terminal_invalid") })
  };
}

export function parseAutomationKernelLogInputV1(value: unknown): AutomationKernelLogInputV1 {
  const body = objectValue(value, "kernel_log_required");
  if (body.event_type === "effect_receipt_recorded") return parseAutomationKernelEffectReceiptInputV1(body);
  return parseAutomationKernelEventInputV1(body);
}

export function kernelStatusToLegacyProjection(snapshot: AutomationKernelSnapshotV1): AutomationKernelCompatibilityProjectionV1 {
  const present = snapshot.effects.flatMap((effect) => {
    if (effect.status === "succeeded") return [`effect:${effect.effect_id}:succeeded`];
    if (effect.status === "reconciliation_required") return [`effect:${effect.effect_id}:reconciliation_required`];
    if (effect.status === "claimed") return [`effect:${effect.effect_id}:claimed`];
    return [];
  });
  const missing = snapshot.effects.flatMap((effect) => {
    if (effect.status === "pending") return [`effect:${effect.effect_id}:pending`];
    if (effect.status === "failed") return [`effect:${effect.effect_id}:failed`];
    if (effect.status === "reconciliation_required") return [`effect:${effect.effect_id}:reconciliation_required`];
    return [];
  });
  const registered_status = snapshot.status === "complete" ? "complete" : "blocked";
  const legacy_status = snapshot.status === "complete" ? "complete" : present.length > 0 ? "partial" : "blocked";
  return {
    registered_status,
    legacy_status,
    proof_gate: {
      ok: snapshot.status === "complete",
      missing: snapshot.status === "complete" ? [] : missing.length > 0 ? missing : [snapshot.exact_blocker ?? "kernel_incomplete"],
      present
    },
    exact_blocker: snapshot.exact_blocker,
    kernel_status: snapshot.status
  };
}

export function automationKernelSnapshotIsTerminal(snapshot: AutomationKernelSnapshotV1): boolean {
  return snapshot.status === "complete" || (snapshot.status === "blocked" && snapshot.next_effect_id === null);
}

function objectValue(value: unknown, code: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AutomationKernelContractError(code);
  return value as JsonObject;
}

function arrayValue(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) throw new AutomationKernelContractError(code);
  return value;
}

function rejectUnknownFields(body: JsonObject, allowed: Set<string>, code: string): void {
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) throw new AutomationKernelContractError(`${code}:${unknown.sort().join(",")}`);
}

function stringValue(value: unknown, code: string): string {
  if (typeof value !== "string") throw new AutomationKernelContractError(`${code}_invalid`);
  const normalized = value.trim();
  if (!normalized) throw new AutomationKernelContractError(`${code}_required`);
  return normalized;
}

function boundedString(value: unknown, code: string, min: number, max: number): string {
  const normalized = stringValue(value, code);
  if (normalized.length < min) throw new AutomationKernelContractError(`${code}_required`);
  if (normalized.length > max) throw new AutomationKernelContractError(`${code}_too_long`);
  return normalized;
}

function kernelId(value: unknown, code: string): string {
  const normalized = boundedString(value, code, 1, 120);
  if (!kernelIdPattern.test(normalized)) throw new AutomationKernelContractError(`${code}_invalid`);
  return normalized;
}

function effectId(value: unknown, code: string): string {
  const normalized = boundedString(value, code, 1, 160);
  if (!kernelIdPattern.test(normalized)) throw new AutomationKernelContractError(`${code}_invalid`);
  return normalized;
}

function stableId(value: unknown, code: string): string {
  return effectId(value, code);
}

function heartbeatOwner(value: unknown): "caller" {
  if (value !== "caller") throw new AutomationKernelContractError("kernel_heartbeat_owner_invalid");
  return "caller";
}

function booleanValue(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") throw new AutomationKernelContractError(code);
  return value;
}

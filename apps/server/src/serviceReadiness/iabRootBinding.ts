import type { IabIdentity } from "../browser/iabReadOnlyBridge.js";

/**
 * The service-level binding between a fresh In-App Browser identity and one
 * Automation OS stage.  This is intentionally a read-only contract for now:
 * the IAB bridge verifies a browser receipt but does not authorize an
 * external provider effect.
 */
export const IAB_ROOT_STAGE_BINDING_SCHEMA_V1 = "service_readiness_iab_root_binding.v1" as const;

export type IabRootStageBindingV1 = {
  schema: typeof IAB_ROOT_STAGE_BINDING_SCHEMA_V1;
  surface: "in_app_browser";
  root_id: string;
  workflow_id: string;
  run_id: string;
  stage_id: string;
  attempt_id: string;
  fencing_token: number;
  capability_id: string;
  turn_id: string;
  session_id: string;
  nonce: string;
  iab_identity: IabIdentity;
  capability_mode: "read_only";
  effect_class: "internal_idempotent";
  effect_key: string;
  external_action_executed: false;
  legacy_surfaces_forbidden: true;
  prior_receipt_reuse: false;
};

export type IabRootStageBindingValidationResultV1 =
  | { ok: true; status: "ok"; value: IabRootStageBindingV1 }
  | { ok: false; status: "blocked"; exact_blocker: string };

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const noncePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const allowedFields = new Set([
  "schema", "surface", "root_id", "workflow_id", "run_id", "stage_id", "attempt_id",
  "fencing_token", "capability_id", "turn_id", "session_id", "nonce", "iab_identity",
  "capability_mode", "effect_class", "effect_key", "external_action_executed",
  "legacy_surfaces_forbidden", "prior_receipt_reuse"
]);

function record(value: unknown, blocker: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(blocker);
  return value as Record<string, unknown>;
}
function identifier(value: unknown, blocker: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) throw new Error(blocker);
  return value;
}

function nonce(value: unknown, blocker: string): string {
  if (typeof value !== "string" || !noncePattern.test(value)) throw new Error(blocker);
  return value;
}

function iabIdentity(value: unknown): IabIdentity {
  const body = record(value, "iab_root_binding_iab_identity_invalid");
  const expected = new Set(["generation", "project_id", "thread_id", "session_id", "turn_id", "nonce", "stage", "attempt"]);
  for (const key of Object.keys(body)) {
    if (!expected.has(key)) throw new Error(`iab_root_binding_iab_identity_unknown_field:${key}`);
  }
  const result = {
    generation: identifier(body.generation, "iab_root_binding_iab_generation_invalid"),
    project_id: identifier(body.project_id, "iab_root_binding_iab_project_invalid"),
    thread_id: identifier(body.thread_id, "iab_root_binding_iab_thread_invalid"),
    session_id: identifier(body.session_id, "iab_root_binding_iab_session_invalid"),
    turn_id: identifier(body.turn_id, "iab_root_binding_iab_turn_invalid"),
    nonce: nonce(body.nonce, "iab_root_binding_iab_nonce_invalid"),
    stage: identifier(body.stage, "iab_root_binding_iab_stage_invalid"),
    attempt: body.attempt
  } satisfies Omit<IabIdentity, "attempt"> & { attempt: unknown };
  if (!Number.isSafeInteger(result.attempt) || Number(result.attempt) < 1 || Number(result.attempt) > 100000) {
    throw new Error("iab_root_binding_iab_attempt_invalid");
  }
  return { ...result, attempt: Number(result.attempt) };
}

function parse(value: unknown): IabRootStageBindingV1 {
  const body = record(value, "iab_root_binding_required");
  for (const key of Object.keys(body)) {
    if (!allowedFields.has(key)) throw new Error(`iab_root_binding_unknown_field:${key}`);
  }
  if (body.schema !== IAB_ROOT_STAGE_BINDING_SCHEMA_V1) throw new Error("iab_root_binding_schema_invalid");
  if (body.surface !== "in_app_browser") throw new Error("iab_root_binding_surface_invalid");
  if (body.capability_mode !== "read_only") throw new Error("iab_external_effect_capability_not_implemented");
  if (body.effect_class !== "internal_idempotent") throw new Error("iab_root_binding_effect_class_invalid");
  if (body.external_action_executed !== false) throw new Error("iab_root_binding_external_action_forbidden");
  if (body.legacy_surfaces_forbidden !== true) throw new Error("iab_root_binding_legacy_surface_guard_required");
  if (body.prior_receipt_reuse !== false) throw new Error("iab_root_binding_prior_receipt_reuse_forbidden");

  const normalized: Omit<IabRootStageBindingV1, "iab_identity"> = {
    schema: IAB_ROOT_STAGE_BINDING_SCHEMA_V1,
    surface: "in_app_browser",
    root_id: identifier(body.root_id, "iab_root_binding_root_id_invalid"),
    workflow_id: identifier(body.workflow_id, "iab_root_binding_workflow_id_invalid"),
    run_id: identifier(body.run_id, "iab_root_binding_run_id_invalid"),
    stage_id: identifier(body.stage_id, "iab_root_binding_stage_id_invalid"),
    attempt_id: identifier(body.attempt_id, "iab_root_binding_attempt_id_invalid"),
    fencing_token: body.fencing_token as number,
    capability_id: identifier(body.capability_id, "iab_root_binding_capability_id_invalid"),
    turn_id: identifier(body.turn_id, "iab_root_binding_turn_id_invalid"),
    session_id: identifier(body.session_id, "iab_root_binding_session_id_invalid"),
    nonce: nonce(body.nonce, "iab_root_binding_nonce_invalid"),
    capability_mode: "read_only",
    effect_class: "internal_idempotent",
    effect_key: body.effect_key as string,
    external_action_executed: false,
    legacy_surfaces_forbidden: true,
    prior_receipt_reuse: false
  };
  if (!Number.isSafeInteger(normalized.fencing_token) || normalized.fencing_token < 1 || normalized.fencing_token > 100000) {
    throw new Error("iab_root_binding_fencing_token_invalid");
  }
  if (typeof normalized.effect_key !== "string" || !hashPattern.test(normalized.effect_key)) {
    throw new Error("iab_root_binding_effect_key_invalid");
  }
  const identity = iabIdentity(body.iab_identity);
  if (identity.stage !== normalized.stage_id) throw new Error("iab_root_binding_stage_mismatch");
  if (identity.session_id !== normalized.session_id) throw new Error("iab_root_binding_session_mismatch");
  if (identity.turn_id !== normalized.turn_id) throw new Error("iab_root_binding_turn_mismatch");
  if (identity.nonce !== normalized.nonce) throw new Error("iab_root_binding_nonce_mismatch");
  if (identity.attempt !== normalized.fencing_token) throw new Error("iab_root_binding_fencing_token_mismatch");
  return { ...normalized, iab_identity: identity };
}

/** Parse a root-owned IAB binding, preserving an exact fail-closed blocker. */
export function parseIabRootStageBindingV1(value: unknown): IabRootStageBindingV1 {
  return parse(value);
}

export function validateIabRootStageBindingV1(value: unknown): IabRootStageBindingValidationResultV1 {
  try {
    return { ok: true, status: "ok", value: parse(value) };
  } catch (error) {
    return {
      ok: false,
      status: "blocked",
      exact_blocker: error instanceof Error ? error.message : "iab_root_binding_validation_failed"
    };
  }
}

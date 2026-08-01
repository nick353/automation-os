import { createHmac, timingSafeEqual } from "node:crypto";
import type { IabIdentity } from "../browser/iabReadOnlyBridge.js";
import { canonicalJson } from "../automations/idempotency.js";
import { computeServiceReadinessEffectKey } from "./effectLedger.js";

/**
 * Machine-readable shape for a future root-owned IAB external capability.
 *
 * This module deliberately only validates an approved, fresh capability
 * request.  It does not issue a browser handle, call a provider, or mark an
 * external action as executed.  Until a trusted IAB executor exists, callers
 * must keep the capability at `external_action_executed: false` and stop with
 * the exact executor blocker.
 */
export const IAB_EXTERNAL_CAPABILITY_SCHEMA_V1 = "service_readiness_iab_external_capability.v1" as const;
export const IAB_EXTERNAL_CAPABILITY_EXECUTOR_BLOCKER = "iab_external_effect_capability_not_implemented" as const;
export const IAB_EXTERNAL_CAPABILITY_SECRET_ENV = "AUTOMATION_OS_IAB_CAPABILITY_SECRET" as const;

export type IabExternalCapabilityV1 = {
  schema: typeof IAB_EXTERNAL_CAPABILITY_SCHEMA_V1;
  surface: "in_app_browser";
  company_id: string;
  root_id: string;
  issuer_service_user_id: string;
  manifest_hash: string;
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
  capability_mode: "external";
  effect_class: "external_non_idempotent";
  effect_key: string;
  provider: string;
  account_ref: string;
  target_hash: string;
  payload_hash: string;
  approval_id: string;
  approval_revision: number;
  approval_payload_hash: string;
  issued_at: string;
  expires_at: string;
  external_action_executed: false;
  legacy_surfaces_forbidden: true;
  prior_receipt_reuse: false;
  capability_mac: string;
};

export type IabExternalCapabilityValidationResultV1 =
  | { ok: true; status: "validated"; value: IabExternalCapabilityV1 }
  | { ok: false; status: "blocked"; exact_blocker: string };

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const noncePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const providerPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const allowedFields = new Set([
  "schema", "surface", "company_id", "root_id", "issuer_service_user_id", "manifest_hash", "workflow_id", "run_id", "stage_id", "attempt_id",
  "fencing_token", "capability_id", "turn_id", "session_id", "nonce", "iab_identity",
  "capability_mode", "effect_class", "effect_key", "provider", "account_ref", "target_hash",
  "payload_hash", "approval_id", "approval_revision", "approval_payload_hash", "issued_at",
  "expires_at", "external_action_executed", "legacy_surfaces_forbidden", "prior_receipt_reuse", "capability_mac"
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

function hash(value: unknown, blocker: string): string {
  if (typeof value !== "string" || !hashPattern.test(value)) throw new Error(blocker);
  return value;
}

function capabilitySecret(): string {
  const secret = process.env[IAB_EXTERNAL_CAPABILITY_SECRET_ENV];
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error("iab_external_capability_issuer_secret_missing");
  }
  return secret;
}

export function hashIabExternalCapabilityV1(
  capability: Omit<IabExternalCapabilityV1, "capability_mac">
): string {
  return createHmac("sha256", capabilitySecret()).update(canonicalJson(capability), "utf8").digest("hex");
}

export function signIabExternalCapabilityV1(
  capability: Omit<IabExternalCapabilityV1, "capability_mac">
): IabExternalCapabilityV1 {
  return { ...capability, capability_mac: hashIabExternalCapabilityV1(capability) };
}

function timestamp(value: unknown, blocker: string): { raw: string; ms: number } {
  if (typeof value !== "string" || !value.trim()) throw new Error(blocker);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(blocker);
  return { raw: value, ms };
}

function parseIabIdentity(value: unknown): IabIdentity {
  const body = record(value, "iab_external_capability_iab_identity_invalid");
  const expected = new Set(["generation", "project_id", "thread_id", "session_id", "turn_id", "nonce", "stage", "attempt"]);
  for (const key of Object.keys(body)) {
    if (!expected.has(key)) throw new Error(`iab_external_capability_iab_identity_unknown_field:${key}`);
  }
  const attempt = body.attempt;
  if (!Number.isSafeInteger(attempt) || Number(attempt) < 1 || Number(attempt) > 100000) {
    throw new Error("iab_external_capability_iab_attempt_invalid");
  }
  return {
    generation: identifier(body.generation, "iab_external_capability_iab_generation_invalid"),
    project_id: identifier(body.project_id, "iab_external_capability_iab_project_invalid"),
    thread_id: identifier(body.thread_id, "iab_external_capability_iab_thread_invalid"),
    session_id: identifier(body.session_id, "iab_external_capability_iab_session_invalid"),
    turn_id: identifier(body.turn_id, "iab_external_capability_iab_turn_invalid"),
    nonce: nonce(body.nonce, "iab_external_capability_iab_nonce_invalid"),
    stage: identifier(body.stage, "iab_external_capability_iab_stage_invalid"),
    attempt: Number(attempt)
  };
}

function parse(value: unknown, nowMs: number): IabExternalCapabilityV1 {
  const body = record(value, "iab_external_capability_required");
  for (const key of Object.keys(body)) {
    if (!allowedFields.has(key)) throw new Error(`iab_external_capability_unknown_field:${key}`);
  }
  if (body.schema !== IAB_EXTERNAL_CAPABILITY_SCHEMA_V1) throw new Error("iab_external_capability_schema_invalid");
  if (body.surface !== "in_app_browser") throw new Error("iab_external_capability_surface_invalid");
  if (body.capability_mode !== "external") throw new Error("iab_external_capability_mode_invalid");
  if (body.effect_class !== "external_non_idempotent") throw new Error("iab_external_capability_effect_class_invalid");
  if (body.external_action_executed !== false) throw new Error("iab_external_capability_external_action_forbidden");
  if (body.legacy_surfaces_forbidden !== true) throw new Error("iab_external_capability_legacy_surface_guard_required");
  if (body.prior_receipt_reuse !== false) throw new Error("iab_external_capability_prior_receipt_reuse_forbidden");

  const fencingToken = body.fencing_token;
  if (!Number.isSafeInteger(fencingToken) || Number(fencingToken) < 1 || Number(fencingToken) > 100000) {
    throw new Error("iab_external_capability_fencing_token_invalid");
  }
  const normalized = {
    schema: IAB_EXTERNAL_CAPABILITY_SCHEMA_V1,
    surface: "in_app_browser" as const,
    company_id: identifier(body.company_id, "iab_external_capability_company_id_invalid"),
    root_id: identifier(body.root_id, "iab_external_capability_root_id_invalid"),
    issuer_service_user_id: identifier(body.issuer_service_user_id, "iab_external_capability_issuer_service_user_id_invalid"),
    manifest_hash: hash(body.manifest_hash, "iab_external_capability_manifest_hash_invalid"),
    workflow_id: identifier(body.workflow_id, "iab_external_capability_workflow_id_invalid"),
    run_id: identifier(body.run_id, "iab_external_capability_run_id_invalid"),
    stage_id: identifier(body.stage_id, "iab_external_capability_stage_id_invalid"),
    attempt_id: identifier(body.attempt_id, "iab_external_capability_attempt_id_invalid"),
    fencing_token: Number(fencingToken),
    capability_id: identifier(body.capability_id, "iab_external_capability_id_invalid"),
    turn_id: identifier(body.turn_id, "iab_external_capability_turn_id_invalid"),
    session_id: identifier(body.session_id, "iab_external_capability_session_id_invalid"),
    nonce: nonce(body.nonce, "iab_external_capability_nonce_invalid"),
    capability_mode: "external" as const,
    effect_class: "external_non_idempotent" as const,
    effect_key: hash(body.effect_key, "iab_external_capability_effect_key_invalid"),
    provider: typeof body.provider === "string" && providerPattern.test(body.provider)
      ? body.provider
      : (() => { throw new Error("iab_external_capability_provider_invalid"); })(),
    account_ref: typeof body.account_ref === "string" && body.account_ref.length > 0 && body.account_ref.length <= 256
      ? body.account_ref
      : (() => { throw new Error("iab_external_capability_account_ref_invalid"); })(),
    target_hash: hash(body.target_hash, "iab_external_capability_target_hash_invalid"),
    payload_hash: hash(body.payload_hash, "iab_external_capability_payload_hash_invalid"),
    approval_id: identifier(body.approval_id, "iab_external_capability_approval_id_invalid"),
    approval_revision: Number(body.approval_revision),
    approval_payload_hash: hash(body.approval_payload_hash, "iab_external_capability_approval_payload_hash_invalid"),
    issued_at: timestamp(body.issued_at, "iab_external_capability_issued_at_invalid"),
    expires_at: timestamp(body.expires_at, "iab_external_capability_expires_at_invalid"),
    external_action_executed: false as const,
    legacy_surfaces_forbidden: true as const,
    prior_receipt_reuse: false as const,
    capability_mac: hash(body.capability_mac, "iab_external_capability_mac_invalid")
  };
  if (!Number.isSafeInteger(normalized.approval_revision) || normalized.approval_revision < 1 || normalized.approval_revision > 100000) {
    throw new Error("iab_external_capability_approval_revision_invalid");
  }
  if (normalized.approval_payload_hash !== normalized.payload_hash) {
    throw new Error("iab_external_capability_approval_payload_hash_mismatch");
  }
  if (normalized.expires_at.ms <= normalized.issued_at.ms) throw new Error("iab_external_capability_expiry_order_invalid");
  if (normalized.expires_at.ms - normalized.issued_at.ms > 5 * 60 * 1000) throw new Error("iab_external_capability_ttl_exceeded");
  if (normalized.issued_at.ms > nowMs + 5 * 60 * 1000) throw new Error("iab_external_capability_issued_at_future");
  if (normalized.expires_at.ms <= nowMs) throw new Error("iab_external_capability_expired");

  const identity = parseIabIdentity(body.iab_identity);
  if (identity.stage !== normalized.stage_id) throw new Error("iab_external_capability_stage_mismatch");
  if (identity.session_id !== normalized.session_id) throw new Error("iab_external_capability_session_mismatch");
  if (identity.turn_id !== normalized.turn_id) throw new Error("iab_external_capability_turn_mismatch");
  if (identity.nonce !== normalized.nonce) throw new Error("iab_external_capability_nonce_mismatch");
  if (identity.attempt !== normalized.fencing_token) throw new Error("iab_external_capability_fencing_token_mismatch");
  if (normalized.effect_key !== computeServiceReadinessEffectKey({
    company_id: normalized.company_id,
    provider: normalized.provider,
    account_ref: normalized.account_ref,
    target_hash: normalized.target_hash,
    payload_hash: normalized.payload_hash,
    effect_class: normalized.effect_class
  })) {
    throw new Error("iab_external_capability_effect_key_binding_mismatch");
  }
  const { capability_mac: normalizedMac, ...normalizedWithoutMac } = normalized;
  const signedPayload: Omit<IabExternalCapabilityV1, "capability_mac"> = {
    ...normalizedWithoutMac,
    issued_at: normalized.issued_at.raw,
    expires_at: normalized.expires_at.raw,
    iab_identity: identity
  };
  const expectedMac = hashIabExternalCapabilityV1(signedPayload);
  if (!timingSafeEqual(Buffer.from(expectedMac, "hex"), Buffer.from(normalizedMac, "hex"))) {
    throw new Error("iab_external_capability_server_authentication_mismatch");
  }
  return { ...signedPayload, capability_mac: normalizedMac };
}

/** Validate a future external capability without issuing or consuming it. */
export function validateIabExternalCapabilityV1(value: unknown, nowMs = Date.now()): IabExternalCapabilityValidationResultV1 {
  try {
    return { ok: true, status: "validated", value: parse(value, nowMs) };
  } catch (error) {
    return {
      ok: false,
      status: "blocked",
      exact_blocker: error instanceof Error ? error.message : "iab_external_capability_validation_failed"
    };
  }
}

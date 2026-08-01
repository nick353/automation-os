import {
  ServiceReadinessContractError,
  ServiceReadinessEffectLedgerV1,
  type ServiceReadinessEvidenceV1,
  type ServiceReadinessIdentityV1,
  type ServiceReadinessInputStatusV1,
  type ServiceReadinessStatusV1,
  parseServiceReadinessEvidenceV1
} from "../foundationContracts.js";

export const NISEN_PRINTS_SERVICE_READINESS_SCHEMA_V1 = "nisenprints.service_readiness.v1" as const;
export const NISEN_PRINTS_WORKFLOW_CONTRACT_SCHEMA_V1 = NISEN_PRINTS_SERVICE_READINESS_SCHEMA_V1;
export const NISEN_PRINTS_CONTRACT_SCHEMA_V1 = NISEN_PRINTS_SERVICE_READINESS_SCHEMA_V1;
export const NISEN_PRINTS_SCHEMA_V1 = NISEN_PRINTS_SERVICE_READINESS_SCHEMA_V1;

export type NisenPrintsModeV1 = "etsy_sync" | "printify_recovery" | "full_publish";

export type NisenPrintsServiceReadinessInputV1 = {
  schema: typeof NISEN_PRINTS_SERVICE_READINESS_SCHEMA_V1;
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
  capability_mode: "read_only" | "external";
  status: ServiceReadinessInputStatusV1;
  effect_class: "internal_idempotent" | "external_non_idempotent";
  store: string;
  account_ref: string;
  mode: NisenPrintsModeV1;
  product_listing_target_hash: string;
  asset_media_hash: string;
  pinterest_board_target_hash: string | null;
  provider: string;
  provider_receipt_hash: string | null;
  effect_key: string;
  external_action_executed: boolean;
  duplicate_lock_key: string;
  cleanup_receipt_hash: string | null;
  exact_blocker: string | null;
  safe_restart: string | null;
};

export type NisenPrintsServiceReadinessContractV1 = Omit<NisenPrintsServiceReadinessInputV1, "status" | "safe_restart"> & {
  status: ServiceReadinessStatusV1;
  safe_restart: string | null;
};

export type NisenPrintsServiceReadinessValidationOptionsV1 = {
  expected_identity?: ServiceReadinessIdentityV1;
  expected_cleanup_receipt_hash?: string | null;
  ledger?: NisenPrintsEffectLedgerV1 | ServiceReadinessEffectLedgerV1;
};

export type NisenPrintsServiceReadinessValidationSuccessV1 = {
  ok: true;
  status: "ok";
  value: NisenPrintsServiceReadinessContractV1;
};

export type NisenPrintsServiceReadinessValidationFailureV1 = {
  ok: false;
  status: "blocked";
  exact_blocker: string;
};

export type NisenPrintsServiceReadinessValidationResultV1 =
  | NisenPrintsServiceReadinessValidationSuccessV1
  | NisenPrintsServiceReadinessValidationFailureV1;

const modes = new Set<NisenPrintsModeV1>(["etsy_sync", "printify_recovery", "full_publish"]);
const allowedFields = new Set<string>([
  "schema",
  "root_id",
  "workflow_id",
  "run_id",
  "stage_id",
  "attempt_id",
  "fencing_token",
  "capability_id",
  "turn_id",
  "session_id",
  "nonce",
  "capability_mode",
  "status",
  "effect_class",
  "store",
  "account_ref",
  "mode",
  "product_listing_target_hash",
  "asset_media_hash",
  "pinterest_board_target_hash",
  "provider",
  "provider_receipt_hash",
  "effect_key",
  "external_action_executed",
  "duplicate_lock_key",
  "cleanup_receipt_hash",
  "exact_blocker",
  "safe_restart"
]);
const hashPattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const authBlockers = new Set(["printify_auth_required", "printify_reauth_required"]);
const requiredFields = [...allowedFields];

/**
 * A bounded, in-memory effect/duplicate lock ledger for one contract sequence.
 * It deliberately has no persistence or workflow/runtime side effects.
 */
export class NisenPrintsEffectLedgerV1 {
  private readonly effects = new Map<string, ServiceReadinessEvidenceV1>();
  private readonly duplicateLocks = new Set<string>();

  constructor(private readonly maxEntries = 128) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 4096) {
      throw new ServiceReadinessContractError("nisenprints_effect_ledger_bound_invalid");
    }
  }

  has(effectKey: string): boolean {
    return this.effects.has(effectKey);
  }

  get(effectKey: string): ServiceReadinessEvidenceV1 | undefined {
    return this.effects.get(effectKey);
  }

  hasDuplicateLock(lockKey: string): boolean {
    return this.duplicateLocks.has(lockKey);
  }

  record(evidence: ServiceReadinessEvidenceV1, duplicateLockKey: string): void {
    if (this.effects.has(evidence.effect_key)) {
      throw new ServiceReadinessContractError(`nisenprints_effect_replay_forbidden:${evidence.effect_key}`);
    }
    if (this.duplicateLocks.has(duplicateLockKey)) {
      throw new ServiceReadinessContractError(`nisenprints_duplicate_listing_or_pin_forbidden:${duplicateLockKey}`);
    }
    if (this.effects.size >= this.maxEntries) {
      throw new ServiceReadinessContractError("nisenprints_effect_ledger_bound_exceeded");
    }
    this.effects.set(evidence.effect_key, evidence);
    this.duplicateLocks.add(duplicateLockKey);
  }
}

export function parseNisenPrintsServiceReadinessContractV1(
  value: unknown,
  options: NisenPrintsServiceReadinessValidationOptionsV1 = {}
): NisenPrintsServiceReadinessContractV1 {
  const body = objectValue(value);
  rejectUnknownFields(body);
  requireFields(body);
  if (body.schema !== NISEN_PRINTS_SERVICE_READINESS_SCHEMA_V1) {
    throw new ServiceReadinessContractError("nisenprints_schema_invalid");
  }

  const mode = enumValue(body.mode, modes, "nisenprints_mode_invalid");
  const store = boundedIdentifier(body.store, "nisenprints_store_invalid");
  const duplicateLockKey = boundedIdentifier(body.duplicate_lock_key, "nisenprints_duplicate_lock_key_invalid");
  const pinterestTargetHash = nullableHash(body.pinterest_board_target_hash, "nisenprints_pinterest_target_hash_invalid");
  const providerReceiptHash = nullableHash(body.provider_receipt_hash, "nisenprints_provider_receipt_hash_invalid");
  const cleanupReceiptHash = nullableHash(body.cleanup_receipt_hash, "nisenprints_cleanup_receipt_hash_invalid");
  const exactBlocker = nullableText(body.exact_blocker, "nisenprints_exact_blocker_invalid");
  const safeRestart = nullableText(body.safe_restart, "nisenprints_safe_restart_invalid");
  const externalActionExecuted = booleanValue(body.external_action_executed, "nisenprints_external_action_executed_invalid");
  const rawStatus = enumValue(body.status, new Set<ServiceReadinessInputStatusV1>([
    "pending",
    "running",
    "succeeded",
    "failed",
    "blocked",
    "ambiguous",
    "reconciliation_required",
    "cancelled"
  ]), "nisenprints_status_invalid");

  validateModeRequirements({
    mode,
    provider: body.provider,
    pinterestTargetHash,
    providerReceiptHash,
    externalActionExecuted,
    rawStatus,
    exactBlocker,
    safeRestart
  });

  if (options.ledger) {
    if (options.ledger instanceof NisenPrintsEffectLedgerV1) {
      if (options.ledger.has(String(body.effect_key))) {
        throw new ServiceReadinessContractError(`nisenprints_effect_replay_forbidden:${String(body.effect_key)}`);
      }
      if (options.ledger.hasDuplicateLock(duplicateLockKey)) {
        throw new ServiceReadinessContractError(`nisenprints_duplicate_listing_or_pin_forbidden:${duplicateLockKey}`);
      }
    }
  }

  const foundationEvidence = parseServiceReadinessEvidenceV1(
    {
      schema: "service_readiness.evidence.v1",
      root_id: body.root_id,
      workflow_id: body.workflow_id,
      run_id: body.run_id,
      stage_id: body.stage_id,
      attempt_id: body.attempt_id,
      fencing_token: body.fencing_token,
      capability_id: body.capability_id,
      turn_id: body.turn_id,
      session_id: body.session_id,
      nonce: body.nonce,
      capability_mode: body.capability_mode,
      provider: body.provider,
      account_ref: body.account_ref,
      target_hash: body.product_listing_target_hash,
      payload_hash: body.asset_media_hash,
      effect_key: body.effect_key,
      effect_class: body.effect_class,
      status: rawStatus,
      external_action_executed: externalActionExecuted,
      provider_receipt_hash: providerReceiptHash,
      cleanup_receipt_hash: cleanupReceiptHash,
      exact_blocker: exactBlocker,
      safe_resume_step: safeRestart
    },
    {
      expected_identity: options.expected_identity,
      expected_cleanup_receipt_hash: options.expected_cleanup_receipt_hash
    }
  );

  const parsed: NisenPrintsServiceReadinessContractV1 = {
    schema: NISEN_PRINTS_SERVICE_READINESS_SCHEMA_V1,
    root_id: foundationEvidence.root_id,
    workflow_id: foundationEvidence.workflow_id,
    run_id: foundationEvidence.run_id,
    stage_id: foundationEvidence.stage_id,
    attempt_id: foundationEvidence.attempt_id,
    fencing_token: foundationEvidence.fencing_token,
    capability_id: foundationEvidence.capability_id,
    turn_id: foundationEvidence.turn_id,
    session_id: foundationEvidence.session_id,
    nonce: foundationEvidence.nonce,
    capability_mode: foundationEvidence.capability_mode,
    status: foundationEvidence.status,
    effect_class: foundationEvidence.effect_class,
    store,
    account_ref: foundationEvidence.account_ref,
    mode,
    product_listing_target_hash: foundationEvidence.target_hash,
    asset_media_hash: foundationEvidence.payload_hash,
    pinterest_board_target_hash: pinterestTargetHash,
    provider: foundationEvidence.provider,
    provider_receipt_hash: foundationEvidence.provider_receipt_hash,
    effect_key: foundationEvidence.effect_key,
    external_action_executed: foundationEvidence.external_action_executed,
    duplicate_lock_key: duplicateLockKey,
    cleanup_receipt_hash: foundationEvidence.cleanup_receipt_hash,
    exact_blocker: foundationEvidence.exact_blocker,
    safe_restart: foundationEvidence.safe_resume_step
  };
  if (options.ledger instanceof NisenPrintsEffectLedgerV1) {
    options.ledger.record(foundationEvidence, duplicateLockKey);
  } else {
    options.ledger?.record(foundationEvidence);
  }
  return parsed;
}

export function validateNisenPrintsServiceReadinessContractV1(
  value: unknown,
  options: NisenPrintsServiceReadinessValidationOptionsV1 = {}
): NisenPrintsServiceReadinessValidationResultV1 {
  try {
    return { ok: true, status: "ok", value: parseNisenPrintsServiceReadinessContractV1(value, options) };
  } catch (error) {
    const exactBlocker = error instanceof ServiceReadinessContractError ? error.code : "nisenprints_validation_failed";
    return { ok: false, status: "blocked", exact_blocker: exactBlocker };
  }
}

export const parseNisenPrintsWorkflowContractV1 = parseNisenPrintsServiceReadinessContractV1;
export const validateNisenPrintsWorkflowContractV1 = validateNisenPrintsServiceReadinessContractV1;
export const parseNisenPrintsContractV1 = parseNisenPrintsServiceReadinessContractV1;
export const validateNisenPrintsContractV1 = validateNisenPrintsServiceReadinessContractV1;

function validateModeRequirements(input: {
  mode: NisenPrintsModeV1;
  provider: unknown;
  pinterestTargetHash: string | null;
  providerReceiptHash: string | null;
  externalActionExecuted: boolean;
  rawStatus: ServiceReadinessInputStatusV1;
  exactBlocker: string | null;
  safeRestart: string | null;
}): void {
  const provider = boundedIdentifier(input.provider, "nisenprints_provider_invalid");
  if (input.mode === "etsy_sync") {
    if (input.pinterestTargetHash !== null) throw new ServiceReadinessContractError("nisenprints_etsy_sync_pinterest_target_forbidden");
    if (input.externalActionExecuted) throw new ServiceReadinessContractError("nisenprints_etsy_sync_external_action_forbidden");
    if (input.providerReceiptHash !== null) throw new ServiceReadinessContractError("nisenprints_etsy_sync_provider_receipt_forbidden");
  }
  if (input.mode === "printify_recovery" && input.pinterestTargetHash !== null) {
    throw new ServiceReadinessContractError("nisenprints_printify_recovery_pinterest_target_forbidden");
  }
  if (input.mode === "full_publish") {
    if (input.pinterestTargetHash === null) throw new ServiceReadinessContractError("nisenprints_full_publish_pinterest_target_required");
    if (input.rawStatus === "succeeded" && !input.externalActionExecuted) {
      throw new ServiceReadinessContractError("nisenprints_full_publish_external_action_required");
    }
  }
  if (input.providerReceiptHash !== null && !input.externalActionExecuted) {
    throw new ServiceReadinessContractError("nisenprints_provider_receipt_without_effect");
  }
  if (authBlockers.has(input.exactBlocker ?? "")) {
    if (provider !== "printify") throw new ServiceReadinessContractError("nisenprints_printify_auth_blocker_provider_invalid");
    if (input.rawStatus !== "blocked") throw new ServiceReadinessContractError("nisenprints_printify_auth_blocker_status_required");
    if (input.externalActionExecuted || input.providerReceiptHash !== null) {
      throw new ServiceReadinessContractError("nisenprints_printify_auth_required_before_provider_effect");
    }
    if (!input.safeRestart) throw new ServiceReadinessContractError("nisenprints_printify_auth_safe_restart_required");
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceReadinessContractError("nisenprints_evidence_required");
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(body: Record<string, unknown>): void {
  const unknown = Object.keys(body).filter((key) => !allowedFields.has(key));
  if (unknown.length > 0) throw new ServiceReadinessContractError(`nisenprints_unknown_field:${unknown.sort().join(",")}`);
}

function requireFields(body: Record<string, unknown>): void {
  const missing = requiredFields.filter((field) => !Object.prototype.hasOwnProperty.call(body, field));
  if (missing.length > 0) {
    throw new ServiceReadinessContractError(`nisenprints_required_field:${missing.join(",")}`);
  }
}

function boundedIdentifier(value: unknown, code: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) throw new ServiceReadinessContractError(code);
  return value;
}

function nullableText(value: unknown, code: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 240 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ServiceReadinessContractError(code);
  }
  return value;
}

function nullableHash(value: unknown, code: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !hashPattern.test(value)) throw new ServiceReadinessContractError(code);
  return value;
}

function booleanValue(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") throw new ServiceReadinessContractError(code);
  return value;
}

function enumValue<T extends string>(value: unknown, values: Set<T>, code: string): T {
  if (typeof value !== "string" || !values.has(value as T)) throw new ServiceReadinessContractError(code);
  return value as T;
}

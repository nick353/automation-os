export const SERVICE_READINESS_SCHEMA_V1 = "service_readiness.evidence.v1" as const;

export type ServiceReadinessEffectClassV1 = "internal_idempotent" | "external_non_idempotent";
export type ServiceReadinessCapabilityModeV1 = "read_only" | "external";
export type ServiceReadinessInputStatusV1 =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "ambiguous"
  | "reconciliation_required"
  | "cancelled";
export type ServiceReadinessStatusV1 = Exclude<ServiceReadinessInputStatusV1, "ambiguous">;

export type ServiceReadinessIdentityV1 = {
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
};

export type ServiceReadinessEvidenceV1 = ServiceReadinessIdentityV1 & {
  schema: typeof SERVICE_READINESS_SCHEMA_V1;
  /** Tenant binding is mandatory for external effects and optional for legacy internal evidence. */
  company_id?: string;
  capability_mode: ServiceReadinessCapabilityModeV1;
  provider: string;
  account_ref: string;
  target_hash: string;
  payload_hash: string;
  effect_key: string;
  effect_class: ServiceReadinessEffectClassV1;
  status: ServiceReadinessStatusV1;
  external_action_executed: boolean;
  provider_receipt_hash: string | null;
  cleanup_receipt_hash: string | null;
  exact_blocker: string | null;
  safe_resume_step: string | null;
};

export type ServiceReadinessValidationOptionsV1 = {
  expected_identity?: ServiceReadinessIdentityV1;
  expected_cleanup_receipt_hash?: string | null;
  ledger?: ServiceReadinessEffectLedgerV1;
};

export type ServiceReadinessValidationSuccessV1 = {
  ok: true;
  status: "ok";
  value: ServiceReadinessEvidenceV1;
};

export type ServiceReadinessValidationFailureV1 = {
  ok: false;
  status: "blocked";
  exact_blocker: string;
};

export type ServiceReadinessValidationResultV1 =
  | ServiceReadinessValidationSuccessV1
  | ServiceReadinessValidationFailureV1;

export class ServiceReadinessContractError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ServiceReadinessContractError";
  }
}

const effectClasses = new Set<ServiceReadinessEffectClassV1>([
  "internal_idempotent",
  "external_non_idempotent"
]);
const capabilityModes = new Set<ServiceReadinessCapabilityModeV1>(["read_only", "external"]);
const inputStatuses = new Set<ServiceReadinessInputStatusV1>([
  "pending",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "ambiguous",
  "reconciliation_required",
  "cancelled"
]);
const terminalStatuses = new Set<ServiceReadinessStatusV1>([
  "succeeded",
  "failed",
  "blocked",
  "reconciliation_required",
  "cancelled"
]);
const identityFields: ReadonlyArray<keyof ServiceReadinessIdentityV1> = [
  "root_id",
  "workflow_id",
  "run_id",
  "stage_id",
  "attempt_id",
  "fencing_token",
  "capability_id",
  "turn_id",
  "session_id",
  "nonce"
];
const allowedFields = new Set([
  "schema",
  ...identityFields,
  "company_id",
  "capability_mode",
  "provider",
  "account_ref",
  "target_hash",
  "payload_hash",
  "effect_key",
  "effect_class",
  "status",
  "external_action_executed",
  "provider_receipt_hash",
  "cleanup_receipt_hash",
  "exact_blocker",
  "safe_resume_step"
]);
const hashPattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/**
 * Parse and normalize one immutable service-readiness evidence record.
 *
 * This module intentionally has no runtime wiring or persistence.  A caller
 * may supply the optional in-memory ledger to reject a repeated effect key
 * while validating a bounded sequence in one process.
 */
export function parseServiceReadinessEvidenceV1(
  value: unknown,
  options: ServiceReadinessValidationOptionsV1 = {}
): ServiceReadinessEvidenceV1 {
  const body = objectValue(value, "service_readiness_evidence_required");
  rejectUnknownFields(body);
  if (body.schema !== SERVICE_READINESS_SCHEMA_V1) {
    throw new ServiceReadinessContractError("service_readiness_schema_invalid");
  }

  const identity = parseIdentity(body);
  if (options.expected_identity) assertServiceReadinessIdentityMatches(identity, options.expected_identity);

  const capabilityMode = enumValue(body.capability_mode, capabilityModes, "service_readiness_capability_mode_invalid");
  const effectClass = enumValue(body.effect_class, effectClasses, "service_readiness_effect_class_invalid");
  const rawStatus = enumValue(body.status, inputStatuses, "service_readiness_status_invalid");
  const status: ServiceReadinessStatusV1 = rawStatus === "ambiguous" ? "reconciliation_required" : rawStatus;
  const externalActionExecuted = booleanValue(body.external_action_executed, "service_readiness_external_action_executed_invalid");

  if (capabilityMode === "read_only" && externalActionExecuted) {
    throw new ServiceReadinessContractError("service_readiness_read_only_external_action_forbidden");
  }
  if (effectClass === "internal_idempotent" && externalActionExecuted) {
    throw new ServiceReadinessContractError("service_readiness_internal_effect_external_action_forbidden");
  }
  if (rawStatus === "ambiguous") {
    if (effectClass !== "external_non_idempotent") {
      throw new ServiceReadinessContractError("service_readiness_ambiguous_effect_class_invalid");
    }
    if (!externalActionExecuted) {
      throw new ServiceReadinessContractError("service_readiness_ambiguous_external_action_required");
    }
  }
  if (status === "reconciliation_required" && effectClass !== "external_non_idempotent") {
    throw new ServiceReadinessContractError("service_readiness_reconciliation_effect_class_invalid");
  }

  const providerReceiptHash = nullableHash(body.provider_receipt_hash, "service_readiness_provider_receipt_hash_invalid");
  const cleanupReceiptHash = nullableHash(body.cleanup_receipt_hash, "service_readiness_cleanup_receipt_hash_invalid");
  const expectedCleanup = options.expected_cleanup_receipt_hash;
  if (expectedCleanup !== undefined) {
    const normalizedExpected = nullableHash(expectedCleanup, "service_readiness_expected_cleanup_receipt_hash_invalid");
    if (cleanupReceiptHash !== normalizedExpected) {
      throw new ServiceReadinessContractError("service_readiness_cleanup_receipt_hash_mismatch");
    }
  }

  if (terminalStatuses.has(status) && !cleanupReceiptHash) {
    throw new ServiceReadinessContractError("service_readiness_terminal_cleanup_required");
  }
  if (!terminalStatuses.has(status) && cleanupReceiptHash) {
    throw new ServiceReadinessContractError("service_readiness_nonterminal_cleanup_forbidden");
  }

  const exactBlocker = nullableText(body.exact_blocker, "service_readiness_exact_blocker_invalid");
  const safeResumeStep = nullableText(body.safe_resume_step, "service_readiness_safe_resume_step_invalid");
  if (status === "succeeded" && (exactBlocker !== null || safeResumeStep !== null)) {
    throw new ServiceReadinessContractError("service_readiness_success_blocker_fields_forbidden");
  }
  if (status !== "pending" && status !== "running" && status !== "succeeded" && (!exactBlocker || !safeResumeStep)) {
    throw new ServiceReadinessContractError("service_readiness_terminal_blocker_resume_required");
  }
  if (status === "succeeded" && effectClass === "external_non_idempotent" && externalActionExecuted && !providerReceiptHash) {
    throw new ServiceReadinessContractError("service_readiness_external_success_provider_receipt_required");
  }

  const evidence: ServiceReadinessEvidenceV1 = {
    schema: SERVICE_READINESS_SCHEMA_V1,
    ...identity,
    ...(body.company_id === undefined ? {} : {
      company_id: boundedIdentifier(body.company_id, "service_readiness_company_id_invalid")
    }),
    capability_mode: capabilityMode,
    provider: boundedIdentifier(body.provider, "service_readiness_provider_invalid"),
    account_ref: boundedText(body.account_ref, "service_readiness_account_ref_invalid", 256),
    target_hash: hashValue(body.target_hash, "service_readiness_target_hash_invalid"),
    payload_hash: hashValue(body.payload_hash, "service_readiness_payload_hash_invalid"),
    effect_key: boundedIdentifier(body.effect_key, "service_readiness_effect_key_invalid"),
    effect_class: effectClass,
    status,
    external_action_executed: externalActionExecuted,
    provider_receipt_hash: providerReceiptHash,
    cleanup_receipt_hash: cleanupReceiptHash,
    exact_blocker: exactBlocker,
    safe_resume_step: safeResumeStep
  };
  options.ledger?.record(evidence);
  return evidence;
}

export function validateServiceReadinessEvidenceV1(
  value: unknown,
  options: ServiceReadinessValidationOptionsV1 = {}
): ServiceReadinessValidationResultV1 {
  try {
    return { ok: true, status: "ok", value: parseServiceReadinessEvidenceV1(value, options) };
  } catch (error) {
    const exactBlocker = error instanceof ServiceReadinessContractError ? error.code : "service_readiness_validation_failed";
    return { ok: false, status: "blocked", exact_blocker: exactBlocker };
  }
}

export function assertServiceReadinessIdentityMatches(
  actual: ServiceReadinessIdentityV1,
  expected: ServiceReadinessIdentityV1
): void {
  for (const field of identityFields) {
    if (actual[field] !== expected[field]) {
      throw new ServiceReadinessContractError(`service_readiness_identity_mismatch:${field}`);
    }
  }
}

export class ServiceReadinessEffectLedgerV1 {
  private readonly records = new Map<string, ServiceReadinessEvidenceV1>();

  has(effectKey: string): boolean {
    return this.records.has(effectKey);
  }

  get(effectKey: string): ServiceReadinessEvidenceV1 | undefined {
    return this.records.get(effectKey);
  }

  record(evidence: ServiceReadinessEvidenceV1): void {
    const existing = this.records.get(evidence.effect_key);
    if (existing) {
      throw new ServiceReadinessContractError(`service_readiness_effect_replay_forbidden:${evidence.effect_key}`);
    }
    this.records.set(evidence.effect_key, evidence);
  }
}

function parseIdentity(body: Record<string, unknown>): ServiceReadinessIdentityV1 {
  return {
    root_id: boundedIdentifier(body.root_id, "service_readiness_root_id_invalid"),
    workflow_id: boundedIdentifier(body.workflow_id, "service_readiness_workflow_id_invalid"),
    run_id: boundedIdentifier(body.run_id, "service_readiness_run_id_invalid"),
    stage_id: boundedIdentifier(body.stage_id, "service_readiness_stage_id_invalid"),
    attempt_id: boundedIdentifier(body.attempt_id, "service_readiness_attempt_id_invalid"),
    fencing_token: integerValue(body.fencing_token, "service_readiness_fencing_token_invalid"),
    capability_id: boundedIdentifier(body.capability_id, "service_readiness_capability_id_invalid"),
    turn_id: boundedIdentifier(body.turn_id, "service_readiness_turn_id_invalid"),
    session_id: boundedIdentifier(body.session_id, "service_readiness_session_id_invalid"),
    nonce: boundedIdentifier(body.nonce, "service_readiness_nonce_invalid")
  };
}

function objectValue(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ServiceReadinessContractError(code);
  return value as Record<string, unknown>;
}

function rejectUnknownFields(body: Record<string, unknown>): void {
  const unknown = Object.keys(body).filter((key) => !allowedFields.has(key));
  if (unknown.length > 0) {
    throw new ServiceReadinessContractError(`service_readiness_unknown_field:${unknown.sort().join(",")}`);
  }
}

function boundedIdentifier(value: unknown, code: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) throw new ServiceReadinessContractError(code);
  return value;
}

function boundedText(value: unknown, code: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ServiceReadinessContractError(code);
  }
  return value;
}

function nullableText(value: unknown, code: string): string | null {
  if (value === null || value === undefined) return null;
  return boundedText(value, code, 240);
}

function hashValue(value: unknown, code: string): string {
  if (typeof value !== "string" || !hashPattern.test(value)) throw new ServiceReadinessContractError(code);
  return value;
}

function nullableHash(value: unknown, code: string): string | null {
  if (value === null || value === undefined) return null;
  return hashValue(value, code);
}

function integerValue(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new ServiceReadinessContractError(code);
  return Number(value);
}

function booleanValue(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") throw new ServiceReadinessContractError(code);
  return value;
}

function enumValue<T extends string>(value: unknown, values: Set<T>, code: string): T {
  if (typeof value !== "string" || !values.has(value as T)) throw new ServiceReadinessContractError(code);
  return value as T;
}

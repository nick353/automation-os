import {
  SERVICE_READINESS_SCHEMA_V1,
  ServiceReadinessContractError,
  parseServiceReadinessEvidenceV1,
  type ServiceReadinessEvidenceV1,
  type ServiceReadinessIdentityV1,
  type ServiceReadinessValidationResultV1
} from "../foundationContracts.js";

/** Workflow-owned schema; the parser maps its foundation fields internally. */
export const DAILY_AI_WORKFLOW_CONTRACT_SCHEMA_V1 = "daily_ai.workflow_contract.v1" as const;
/** Backwards-readable aliases for callers that use the shorter contract name. */
export const DAILY_AI_CONTRACT_SCHEMA_V1 = DAILY_AI_WORKFLOW_CONTRACT_SCHEMA_V1;
export const DAILY_AI_SCHEMA_V1 = DAILY_AI_WORKFLOW_CONTRACT_SCHEMA_V1;

export type DailyAiPlatformV1 = "x" | "linkedin";
export type DailyAiLanguageV1 = "ja" | "en";

export type DailyAiWorkflowContractV1 = Omit<ServiceReadinessEvidenceV1, "schema"> & {
  schema: typeof DAILY_AI_WORKFLOW_CONTRACT_SCHEMA_V1;
  account_ref: string;
  platform: DailyAiPlatformV1;
  queue_id: string;
  post_surface: string;
  language: DailyAiLanguageV1;
  visual_style: string;
  media_receipt_hash: string;
  no_post: boolean;
  blocker_owner: string | null;
};

export type DailyAiWorkflowContractValidationOptionsV1 = {
  expected_identity?: ServiceReadinessIdentityV1;
  expected_cleanup_receipt_hash?: string | null;
  ledger?: DailyAiEffectLedgerV1;
};

export type DailyAiWorkflowContractValidationSuccessV1 = {
  ok: true;
  status: "ok";
  value: DailyAiWorkflowContractV1;
};

export type DailyAiWorkflowContractValidationFailureV1 = {
  ok: false;
  status: "blocked";
  exact_blocker: string;
};

export type DailyAiWorkflowContractValidationResultV1 =
  | DailyAiWorkflowContractValidationSuccessV1
  | DailyAiWorkflowContractValidationFailureV1;

export class DailyAiContractError extends ServiceReadinessContractError {
  constructor(code: string) {
    super(code);
    this.name = "DailyAiContractError";
  }
}

/** Bounded in-memory replay ledger for one contract sequence. */
export class DailyAiEffectLedgerV1 {
  private readonly records = new Map<string, ServiceReadinessEvidenceV1>();

  constructor(private readonly maxEntries = 128) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 4096) {
      throw new DailyAiContractError("daily_ai_effect_ledger_bound_invalid");
    }
  }

  has(effectKey: string): boolean {
    return this.records.has(effectKey);
  }

  get(effectKey: string): ServiceReadinessEvidenceV1 | undefined {
    return this.records.get(effectKey);
  }

  record(evidence: ServiceReadinessEvidenceV1): void {
    if (this.records.has(evidence.effect_key)) {
      throw new DailyAiContractError(`daily_ai_effect_replay_forbidden:${evidence.effect_key}`);
    }
    if (this.records.size >= this.maxEntries) {
      throw new DailyAiContractError("daily_ai_effect_ledger_bound_exceeded");
    }
    this.records.set(evidence.effect_key, evidence);
  }
}

const platformValues = new Set<DailyAiPlatformV1>(["x", "linkedin"]);
const languageValues = new Set<DailyAiLanguageV1>(["ja", "en"]);
const hashPattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const textHasControl = /[\u0000-\u001f\u007f]/;

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

const allowedFields = new Set<string>([
  "schema",
  ...identityFields,
  "capability_mode",
  "provider",
  "account_ref",
  "platform",
  "queue_id",
  "post_surface",
  "language",
  "visual_style",
  "media_receipt_hash",
  "target_hash",
  "payload_hash",
  "effect_key",
  "effect_class",
  "status",
  "external_action_executed",
  "provider_receipt_hash",
  "no_post",
  "cleanup_receipt_hash",
  "exact_blocker",
  "safe_resume_step",
  "blocker_owner"
]);

const requiredFields = [
  "schema",
  ...identityFields,
  "capability_mode",
  "provider",
  "account_ref",
  "platform",
  "queue_id",
  "post_surface",
  "language",
  "visual_style",
  "media_receipt_hash",
  "target_hash",
  "payload_hash",
  "effect_key",
  "effect_class",
  "status",
  "external_action_executed",
  "provider_receipt_hash",
  "no_post",
  "cleanup_receipt_hash",
  "exact_blocker",
  "safe_resume_step",
  "blocker_owner"
] as const;

/** Parse one Daily AI contract and, when supplied, record its effect key once. */
export function parseDailyAiWorkflowContractV1(
  value: unknown,
  options: DailyAiWorkflowContractValidationOptionsV1 = {}
): DailyAiWorkflowContractV1 {
  const body = objectValue(value);
  rejectUnknownFields(body);
  requireFields(body);
  if (body.schema !== DAILY_AI_WORKFLOW_CONTRACT_SCHEMA_V1) {
    throw new ServiceReadinessContractError("daily_ai_contract_schema_invalid");
  }

  const platform = enumValue(body.platform, platformValues, "daily_ai_platform_invalid");
  const language = enumValue(body.language, languageValues, "daily_ai_language_invalid");
  const expectedLanguage: DailyAiLanguageV1 = platform === "x" ? "ja" : "en";
  if (language !== expectedLanguage) {
    throw new ServiceReadinessContractError("daily_ai_platform_language_mismatch");
  }

  const noPost = booleanValue(body.no_post, "daily_ai_no_post_invalid");
  const externalActionExecuted = booleanValue(
    body.external_action_executed,
    "daily_ai_external_action_executed_invalid"
  );
  const providerReceiptHash = nullableHash(body.provider_receipt_hash, "daily_ai_provider_receipt_hash_invalid");
  if (noPost && externalActionExecuted) {
    throw new ServiceReadinessContractError("daily_ai_no_post_external_action_forbidden");
  }
  if (noPost && providerReceiptHash !== null) {
    throw new ServiceReadinessContractError("daily_ai_no_post_provider_receipt_forbidden");
  }
  if (!noPost && providerReceiptHash !== null && !externalActionExecuted) {
    throw new ServiceReadinessContractError("daily_ai_provider_receipt_without_effect");
  }

  const rawStatus = enumText(body.status, "daily_ai_status_required");
  const exactBlocker = nullableText(body.exact_blocker, "daily_ai_exact_blocker_invalid", 240);
  const blockerOwner = nullableText(body.blocker_owner, "daily_ai_blocker_owner_invalid", 160);
  if (exactBlocker === null && blockerOwner !== null) {
    throw new ServiceReadinessContractError("daily_ai_blocker_owner_without_blocker_forbidden");
  }
  if (exactBlocker !== null && blockerOwner === null) {
    throw new ServiceReadinessContractError("daily_ai_blocker_owner_required");
  }
  if (!noPost && rawStatus === "succeeded" && (!externalActionExecuted || providerReceiptHash === null)) {
    throw new ServiceReadinessContractError("daily_ai_success_receipt_or_external_action_missing");
  }

  const effectKey = boundedIdentifier(body.effect_key, "daily_ai_effect_key_invalid");
  if (options.ledger?.has(effectKey)) {
    throw new DailyAiContractError(`daily_ai_effect_replay_forbidden:${effectKey}`);
  }
  const queueId = boundedIdentifier(body.queue_id, "daily_ai_queue_id_invalid");
  const postSurface = boundedText(body.post_surface, "daily_ai_post_surface_invalid", 128);
  const visualStyle = boundedText(body.visual_style, "daily_ai_visual_style_invalid", 160);
  const mediaReceiptHash = hashValue(body.media_receipt_hash, "daily_ai_media_receipt_hash_invalid");

  const foundationEvidence = parseServiceReadinessEvidenceV1(
    {
      schema: SERVICE_READINESS_SCHEMA_V1,
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
      target_hash: body.target_hash,
      payload_hash: body.payload_hash,
      effect_key: body.effect_key,
      effect_class: body.effect_class,
      status: body.status,
      external_action_executed: externalActionExecuted,
      provider_receipt_hash: providerReceiptHash,
      cleanup_receipt_hash: body.cleanup_receipt_hash,
      exact_blocker: exactBlocker,
      safe_resume_step: body.safe_resume_step
    },
    {
      expected_identity: options.expected_identity,
      expected_cleanup_receipt_hash: options.expected_cleanup_receipt_hash
    }
  );
  options.ledger?.record(foundationEvidence);

  return {
    ...foundationEvidence,
    schema: DAILY_AI_WORKFLOW_CONTRACT_SCHEMA_V1,
    platform,
    queue_id: queueId,
    post_surface: postSurface,
    language,
    visual_style: visualStyle,
    media_receipt_hash: mediaReceiptHash,
    no_post: noPost,
    blocker_owner: blockerOwner
  };
}

export function validateDailyAiWorkflowContractV1(
  value: unknown,
  options: DailyAiWorkflowContractValidationOptionsV1 = {}
): DailyAiWorkflowContractValidationResultV1 {
  try {
    return { ok: true, status: "ok", value: parseDailyAiWorkflowContractV1(value, options) };
  } catch (error) {
    const exactBlocker = error instanceof ServiceReadinessContractError ? error.code : "daily_ai_contract_validation_failed";
    return { ok: false, status: "blocked", exact_blocker: exactBlocker };
  }
}

/** Adapter alias matching the foundation validator naming style. */
export const parseDailyAiContractV1 = parseDailyAiWorkflowContractV1;
export const validateDailyAiContractV1 = validateDailyAiWorkflowContractV1;

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceReadinessContractError("daily_ai_contract_required");
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(body: Record<string, unknown>): void {
  const unknown = Object.keys(body).filter((field) => !allowedFields.has(field));
  if (unknown.length > 0) {
    throw new ServiceReadinessContractError(`daily_ai_unknown_field:${unknown.sort().join(",")}`);
  }
}

function requireFields(body: Record<string, unknown>): void {
  const missing = requiredFields.filter((field) => !Object.prototype.hasOwnProperty.call(body, field));
  if (missing.length > 0) {
    throw new ServiceReadinessContractError(`daily_ai_required_field:${missing.join(",")}`);
  }
}

function enumValue<T extends string>(value: unknown, values: Set<T>, code: string): T {
  if (typeof value !== "string" || !values.has(value as T)) throw new ServiceReadinessContractError(code);
  return value as T;
}

function enumText(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) throw new ServiceReadinessContractError(code);
  return value;
}

function boundedIdentifier(value: unknown, code: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) throw new ServiceReadinessContractError(code);
  return value;
}

function boundedText(value: unknown, code: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || textHasControl.test(value)) {
    throw new ServiceReadinessContractError(code);
  }
  return value;
}

function nullableText(value: unknown, code: string, maxLength: number): string | null {
  if (value === null) return null;
  return boundedText(value, code, maxLength);
}

function hashValue(value: unknown, code: string): string {
  if (typeof value !== "string" || !hashPattern.test(value)) throw new ServiceReadinessContractError(code);
  return value;
}

function nullableHash(value: unknown, code: string): string | null {
  if (value === null) return null;
  return hashValue(value, code);
}

function booleanValue(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") throw new ServiceReadinessContractError(code);
  return value;
}

export type DailyAiValidationOptionsV1 = DailyAiWorkflowContractValidationOptionsV1;
export type DailyAiValidationResultV1 = DailyAiWorkflowContractValidationResultV1;
// Keep the foundation result in the adapter's public type surface for consumers that
// need to validate mapped evidence without coupling to its implementation.
export type DailyAiFoundationValidationResultV1 = ServiceReadinessValidationResultV1;

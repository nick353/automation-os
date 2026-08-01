import type { IabIdentity } from "../browser/iabReadOnlyBridge.js";
import { computeServiceReadinessEffectKey } from "./effectLedger.js";
import {
  IAB_ROOT_STAGE_BINDING_SCHEMA_V1,
  validateIabRootStageBindingV1,
  type IabRootStageBindingV1
} from "./iabRootBinding.js";
import {
  DAILY_AI_WORKFLOW_CONTRACT_SCHEMA_V1,
  JOB_MANAGER_WORKFLOW_CONTRACT_SCHEMA_V1,
  NISEN_PRINTS_SERVICE_READINESS_SCHEMA_V1,
  validateServiceReadinessContractV1,
  type ServiceReadinessContractValueV1
} from "./contractRegistry.js";
import type { ServiceReadinessIdentityV1 } from "./foundationContracts.js";

export const IAB_ROOT_STAGE_ADMISSION_SCHEMA_V1 = "service_readiness_iab_root_stage_admission.v1" as const;
export const IAB_EXTERNAL_EFFECT_CAPABILITY_BLOCKER = "iab_external_effect_capability_not_implemented" as const;

export type IabRootStageAdmissionInputV1 = {
  root_binding?: unknown;
  iab_root_binding?: unknown;
  root?: unknown;
  workflow_contract?: unknown;
  contract?: unknown;
  effect_key?: unknown;
  expected_cleanup_receipt_hash?: string | null;
};

export type IabRootStageAdmissionV1 = {
  schema: typeof IAB_ROOT_STAGE_ADMISSION_SCHEMA_V1;
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
  workflow_contract_schema: string;
  workflow_contract: ServiceReadinessContractValueV1;
  effect_key: string;
  capability_mode: "read_only";
  effect_class: "internal_idempotent";
  external_action_executed: false;
  legacy_surfaces_forbidden: true;
  prior_receipt_reuse: false;
};

export type IabRootStageAdmissionValidationResultV1 =
  | { ok: true; status: "ok"; value: IabRootStageAdmissionV1 }
  | { ok: false; status: "blocked"; exact_blocker: string };

class IabRootStageAdmissionError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "IabRootStageAdmissionError";
  }
}

const workflowSchemas: Set<string> = new Set([
  DAILY_AI_WORKFLOW_CONTRACT_SCHEMA_V1,
  JOB_MANAGER_WORKFLOW_CONTRACT_SCHEMA_V1,
  NISEN_PRINTS_SERVICE_READINESS_SCHEMA_V1
]);

const legacyMarkerFields = new Set([
  "browser_handle",
  "browser_surface",
  "browser_driver",
  "legacy_surface",
  "legacy_primary_surface",
  "legacy_primary_surfaces",
  "playwright",
  "playwright_cli",
  "browser_use",
  "chrome_extension",
  "old_receipt",
  "old_receipt_hash",
  "legacy_receipt",
  "receipt_reuse",
  "request_reuse_marker",
  "stale_request_id",
  "old_request_id"
]);

function record(value: unknown, blocker: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new IabRootStageAdmissionError(blocker);
  return value as Record<string, unknown>;
}

function requiredRecord(input: Record<string, unknown>, names: readonly string[], blocker: string): Record<string, unknown> {
  for (const name of names) {
    if (input[name] !== undefined) return record(input[name], blocker);
  }
  throw new IabRootStageAdmissionError(blocker);
}

function schemaOf(value: unknown): string {
  const body = record(value, "iab_root_stage_admission_contract_required");
  if (typeof body.schema !== "string" || body.schema.length === 0) {
    throw new IabRootStageAdmissionError("iab_root_stage_admission_contract_schema_required");
  }
  return body.schema;
}

function hasLegacyMarker(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((field) => legacyMarkerFields.has(field));
}

function assertNoLegacyMarkers(root: Record<string, unknown>, contract: Record<string, unknown>): void {
  if (hasLegacyMarker(root) || hasLegacyMarker(contract)) {
    throw new IabRootStageAdmissionError(IAB_EXTERNAL_EFFECT_CAPABILITY_BLOCKER);
  }
  if (root.surface !== "in_app_browser" || root.legacy_surfaces_forbidden !== true) {
    throw new IabRootStageAdmissionError(IAB_EXTERNAL_EFFECT_CAPABILITY_BLOCKER);
  }
  if (root.prior_receipt_reuse !== false || contract.prior_receipt_reuse !== undefined) {
    throw new IabRootStageAdmissionError(IAB_EXTERNAL_EFFECT_CAPABILITY_BLOCKER);
  }
}

function assertReadOnly(root: Record<string, unknown>, contract: Record<string, unknown>): void {
  if (root.capability_mode !== "read_only" || contract.capability_mode !== "read_only") {
    throw new IabRootStageAdmissionError(IAB_EXTERNAL_EFFECT_CAPABILITY_BLOCKER);
  }
  if (root.effect_class !== "internal_idempotent" || contract.effect_class !== "internal_idempotent") {
    throw new IabRootStageAdmissionError(IAB_EXTERNAL_EFFECT_CAPABILITY_BLOCKER);
  }
  if (root.external_action_executed !== false || contract.external_action_executed !== false) {
    throw new IabRootStageAdmissionError(IAB_EXTERNAL_EFFECT_CAPABILITY_BLOCKER);
  }
}

function assertAccountTargetPayloadReceipt(contract: Record<string, unknown>, schema: string): void {
  const fields = schema === NISEN_PRINTS_SERVICE_READINESS_SCHEMA_V1
    ? ["account_ref", "product_listing_target_hash", "asset_media_hash", "provider", "provider_receipt_hash"]
    : ["account_ref", "target_hash", "payload_hash", "provider", "provider_receipt_hash"];
  if (fields.some((field) => {
    const value = contract[field];
    return typeof value !== "string" || value.length === 0;
  })) {
    throw new IabRootStageAdmissionError(IAB_EXTERNAL_EFFECT_CAPABILITY_BLOCKER);
  }
}

function identityFromRoot(root: IabRootStageBindingV1): Record<string, unknown> {
  return {
    root_id: root.root_id,
    workflow_id: root.workflow_id,
    run_id: root.run_id,
    stage_id: root.stage_id,
    attempt_id: root.attempt_id,
    fencing_token: root.fencing_token,
    capability_id: root.capability_id,
    turn_id: root.turn_id,
    session_id: root.session_id,
    nonce: root.nonce
  };
}

function effectInputs(contract: Record<string, unknown>, schema: string): {
  provider: string;
  account_ref: string;
  target_hash: string;
  payload_hash: string;
  effect_class: "internal_idempotent" | "external_non_idempotent";
} {
  const target = schema === NISEN_PRINTS_SERVICE_READINESS_SCHEMA_V1 ? contract.product_listing_target_hash : contract.target_hash;
  const payload = schema === NISEN_PRINTS_SERVICE_READINESS_SCHEMA_V1 ? contract.asset_media_hash : contract.payload_hash;
  if (
    typeof contract.provider !== "string" ||
    typeof contract.account_ref !== "string" ||
    typeof target !== "string" ||
    typeof payload !== "string" ||
    (contract.effect_class !== "internal_idempotent" && contract.effect_class !== "external_non_idempotent")
  ) {
    throw new IabRootStageAdmissionError(IAB_EXTERNAL_EFFECT_CAPABILITY_BLOCKER);
  }
  return {
    provider: contract.provider,
    account_ref: contract.account_ref,
    target_hash: target,
    payload_hash: payload,
    effect_class: contract.effect_class
  };
}

function parseAdmission(input: unknown): IabRootStageAdmissionV1 {
  const body = record(input, "iab_root_stage_admission_required");
  const rootBody = requiredRecord(body, ["root_binding", "iab_root_binding", "root"], "iab_root_stage_admission_root_binding_required");
  const contractBody = requiredRecord(body, ["workflow_contract", "contract"], "iab_root_stage_admission_workflow_contract_required");
  assertNoLegacyMarkers(rootBody, contractBody);
  const contractSchema = schemaOf(contractBody);
  if (!workflowSchemas.has(contractSchema)) {
    throw new IabRootStageAdmissionError("iab_root_stage_admission_workflow_contract_schema_invalid");
  }

  const rootResult = validateIabRootStageBindingV1(rootBody);
  if (!rootResult.ok) {
    if (rootResult.exact_blocker === "iab_root_binding_external_action_forbidden" ||
        rootResult.exact_blocker === "iab_root_binding_effect_class_invalid" ||
        rootResult.exact_blocker === "iab_external_effect_capability_not_implemented") {
      throw new IabRootStageAdmissionError(IAB_EXTERNAL_EFFECT_CAPABILITY_BLOCKER);
    }
    throw new IabRootStageAdmissionError(rootResult.exact_blocker);
  }
  const root = rootResult.value;
  assertReadOnly(rootBody, contractBody);
  assertAccountTargetPayloadReceipt(contractBody, contractSchema);

  const effectInput = effectInputs(contractBody, contractSchema);
  const computedEffectKey = computeServiceReadinessEffectKey(effectInput);
  const suppliedEffectKey = body.effect_key ?? root.effect_key;
  if (suppliedEffectKey !== computedEffectKey || root.effect_key !== computedEffectKey) {
    throw new IabRootStageAdmissionError("iab_root_stage_admission_effect_key_binding_mismatch");
  }

  const expectedIdentity = identityFromRoot(root) as ServiceReadinessIdentityV1;
  const validationOptions: {
    expected_identity: ServiceReadinessIdentityV1;
    expected_cleanup_receipt_hash?: string | null;
  } = { expected_identity: expectedIdentity };
  const expectedCleanup = body.expected_cleanup_receipt_hash;
  if (expectedCleanup !== undefined) {
    if (expectedCleanup !== null && typeof expectedCleanup !== "string") {
      throw new IabRootStageAdmissionError("iab_root_stage_admission_cleanup_option_invalid");
    }
    validationOptions.expected_cleanup_receipt_hash = expectedCleanup;
  }
  const contractResult = validateServiceReadinessContractV1(contractBody, validationOptions);
  if (!contractResult.ok) throw new IabRootStageAdmissionError(contractResult.exact_blocker);

  return {
    schema: IAB_ROOT_STAGE_ADMISSION_SCHEMA_V1,
    surface: "in_app_browser",
    root_id: root.root_id,
    workflow_id: root.workflow_id,
    run_id: root.run_id,
    stage_id: root.stage_id,
    attempt_id: root.attempt_id,
    fencing_token: root.fencing_token,
    capability_id: root.capability_id,
    turn_id: root.turn_id,
    session_id: root.session_id,
    nonce: root.nonce,
    iab_identity: root.iab_identity,
    workflow_contract_schema: contractSchema,
    workflow_contract: contractResult.value,
    effect_key: computedEffectKey,
    capability_mode: "read_only",
    effect_class: "internal_idempotent",
    external_action_executed: false,
    legacy_surfaces_forbidden: true,
    prior_receipt_reuse: false
  };
}

/** Pure, non-live admission parser. It never grants or consumes a capability. */
export function parseIabRootStageAdmissionV1(input: IabRootStageAdmissionInputV1): IabRootStageAdmissionV1 {
  return parseAdmission(input);
}

export function validateIabRootStageAdmissionV1(input: unknown): IabRootStageAdmissionValidationResultV1 {
  try {
    return { ok: true, status: "ok", value: parseAdmission(input) };
  } catch (error) {
    return {
      ok: false,
      status: "blocked",
      exact_blocker: error instanceof IabRootStageAdmissionError
        ? error.code
        : error instanceof Error
          ? error.message
          : "iab_root_stage_admission_validation_failed"
    };
  }
}

export const admitIabRootStageV1 = parseIabRootStageAdmissionV1;
export const validateRootStageAdmissionV1 = validateIabRootStageAdmissionV1;

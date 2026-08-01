import {
  SERVICE_READINESS_SCHEMA_V1,
  ServiceReadinessContractError,
  type ServiceReadinessEffectLedgerV1,
  type ServiceReadinessIdentityV1,
  type ServiceReadinessValidationOptionsV1,
  parseServiceReadinessEvidenceV1,
  validateServiceReadinessEvidenceV1
} from "./foundationContracts.js";
import {
  COMPANY_RELEASE_READINESS_SCHEMA_V1,
  parseCompanyReleaseReadinessV1,
  validateCompanyReleaseReadinessV1,
  type CompanyReleaseReadinessV1
} from "./companyReleaseReadiness.js";
import {
  COMPANY_RELEASE_EVIDENCE_SCHEMA_V1,
  parseCompanyReleaseEvidenceV1,
  validateCompanyReleaseEvidenceV1,
  type CompanyReleaseEvidenceV1,
  type CompanyReleaseEvidenceValidationOptionsV1
} from "./releaseEvidence.js";
import {
  DAILY_AI_WORKFLOW_CONTRACT_SCHEMA_V1,
  parseDailyAiWorkflowContractV1,
  validateDailyAiWorkflowContractV1,
  type DailyAiEffectLedgerV1,
  type DailyAiWorkflowContractV1,
  type DailyAiWorkflowContractValidationOptionsV1
} from "./workflowContracts/dailyAi.js";
import {
  JOB_MANAGER_WORKFLOW_CONTRACT_SCHEMA_V1,
  parseJobManagerWorkflowContractV1,
  validateJobManagerWorkflowContractV1,
  type JobManagerEffectLedgerV1,
  type JobManagerValidationOptionsV1,
  type JobManagerWorkflowContractV1
} from "./workflowContracts/jobManager.js";
import {
  NISEN_PRINTS_SERVICE_READINESS_SCHEMA_V1,
  parseNisenPrintsServiceReadinessContractV1,
  validateNisenPrintsServiceReadinessContractV1,
  type NisenPrintsEffectLedgerV1,
  type NisenPrintsServiceReadinessContractV1,
  type NisenPrintsServiceReadinessValidationOptionsV1
} from "./workflowContracts/nisenPrints.js";

export {
  COMPANY_RELEASE_READINESS_SCHEMA_V1,
  COMPANY_RELEASE_EVIDENCE_SCHEMA_V1,
  DAILY_AI_WORKFLOW_CONTRACT_SCHEMA_V1,
  JOB_MANAGER_WORKFLOW_CONTRACT_SCHEMA_V1,
  NISEN_PRINTS_SERVICE_READINESS_SCHEMA_V1,
  SERVICE_READINESS_SCHEMA_V1
};

/** The only schemas admitted by this integration boundary. */
export type ServiceReadinessContractSchemaV1 =
  | typeof DAILY_AI_WORKFLOW_CONTRACT_SCHEMA_V1
  | typeof JOB_MANAGER_WORKFLOW_CONTRACT_SCHEMA_V1
  | typeof NISEN_PRINTS_SERVICE_READINESS_SCHEMA_V1
  | typeof SERVICE_READINESS_SCHEMA_V1
  | typeof COMPANY_RELEASE_READINESS_SCHEMA_V1
  | typeof COMPANY_RELEASE_EVIDENCE_SCHEMA_V1;

export const SERVICE_READINESS_CONTRACT_SCHEMAS_V1: readonly ServiceReadinessContractSchemaV1[] = [
  DAILY_AI_WORKFLOW_CONTRACT_SCHEMA_V1,
  JOB_MANAGER_WORKFLOW_CONTRACT_SCHEMA_V1,
  NISEN_PRINTS_SERVICE_READINESS_SCHEMA_V1,
  SERVICE_READINESS_SCHEMA_V1,
  COMPANY_RELEASE_READINESS_SCHEMA_V1,
  COMPANY_RELEASE_EVIDENCE_SCHEMA_V1
] as const;

export type ServiceReadinessContractValueV1 =
  | DailyAiWorkflowContractV1
  | JobManagerWorkflowContractV1
  | NisenPrintsServiceReadinessContractV1
  | ReturnType<typeof parseServiceReadinessEvidenceV1>
  | CompanyReleaseReadinessV1
  | CompanyReleaseEvidenceV1;

/**
 * An approved capability is intentionally only a description.  The registry
 * never invokes it, acquires a browser, or performs an external effect.  A
 * real external transition belongs to the root-owned IAB executor and must
 * not be inferred from this description object.
 */
export type ApprovedExternalCapabilityV1 = {
  approved: true;
  capability_id: string;
};

export type ServiceReadinessExecutionPolicyV1 =
  | {
      mode: "no_effect";
      exact_blocker: "external_effect_capability_unavailable";
    }
  | {
      mode: "external_effect";
      exact_blocker: null;
      capability_id: string;
    };

export type ServiceReadinessContractRegistryOptionsV1 = {
  expected_identity?: ServiceReadinessIdentityV1;
  expected_cleanup_receipt_hash?: string | null;
  /** Job Manager's additional target binding, when the caller has one. */
  expected_target_url?: string;
  ledger?:
    | ServiceReadinessEffectLedgerV1
    | DailyAiEffectLedgerV1
    | JobManagerEffectLedgerV1
    | NisenPrintsEffectLedgerV1;
  approved_external_capability?: ApprovedExternalCapabilityV1;
  release_evidence?: CompanyReleaseEvidenceValidationOptionsV1;
};

export type ServiceReadinessContractRegistrySuccessV1<T extends ServiceReadinessContractValueV1 = ServiceReadinessContractValueV1> = {
  ok: true;
  status: "ok";
  schema: ServiceReadinessContractSchemaV1;
  value: T;
  execution_policy: ServiceReadinessExecutionPolicyV1;
};

export type ServiceReadinessContractRegistryFailureV1 = {
  ok: false;
  status: "blocked";
  schema?: string;
  exact_blocker: string;
  blocker_owner?: string | null;
  safe_resume_step?: string | null;
  execution_policy: ServiceReadinessExecutionPolicyV1;
};

export type ServiceReadinessContractRegistryResultV1 =
  | ServiceReadinessContractRegistrySuccessV1
  | ServiceReadinessContractRegistryFailureV1;

const noEffectPolicy = (): ServiceReadinessExecutionPolicyV1 => ({
  mode: "no_effect",
  exact_blocker: "external_effect_capability_unavailable"
});

function executionPolicy(
  options: ServiceReadinessContractRegistryOptionsV1,
  value?: ServiceReadinessContractValueV1
): ServiceReadinessExecutionPolicyV1 {
  if (
    value &&
    "schema" in value &&
    (value.schema === COMPANY_RELEASE_READINESS_SCHEMA_V1 || value.schema === COMPANY_RELEASE_EVIDENCE_SCHEMA_V1)
  ) {
    return noEffectPolicy();
  }
  // `approved_external_capability` is a read-only description for diagnostics
  // and contract routing.  Until a trusted root-owned executor supplies a
  // fresh, identity-bound IAB capability, returning external_effect here would
  // be a fail-open execution claim.
  return noEffectPolicy();
}

function bodyAndSchema(value: unknown): { body: Record<string, unknown>; schema: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ServiceReadinessContractError("service_readiness_contract_required");
  }
  const body = value as Record<string, unknown>;
  if (typeof body.schema !== "string" || body.schema.length === 0) {
    throw new ServiceReadinessContractError("service_readiness_schema_required");
  }
  return { body, schema: body.schema };
}

function supportedSchema(schema: string): schema is ServiceReadinessContractSchemaV1 {
  return (SERVICE_READINESS_CONTRACT_SCHEMAS_V1 as readonly string[]).includes(schema);
}

function parseBySchema(
  schema: ServiceReadinessContractSchemaV1,
  value: unknown,
  options: ServiceReadinessContractRegistryOptionsV1
): ServiceReadinessContractValueV1 {
  switch (schema) {
    case DAILY_AI_WORKFLOW_CONTRACT_SCHEMA_V1:
      return parseDailyAiWorkflowContractV1(value, options as DailyAiWorkflowContractValidationOptionsV1);
    case JOB_MANAGER_WORKFLOW_CONTRACT_SCHEMA_V1:
      return parseJobManagerWorkflowContractV1(value, options as JobManagerValidationOptionsV1);
    case NISEN_PRINTS_SERVICE_READINESS_SCHEMA_V1:
      return parseNisenPrintsServiceReadinessContractV1(value, options as NisenPrintsServiceReadinessValidationOptionsV1);
    case SERVICE_READINESS_SCHEMA_V1:
      return parseServiceReadinessEvidenceV1(value, options as ServiceReadinessValidationOptionsV1);
    case COMPANY_RELEASE_READINESS_SCHEMA_V1:
      return parseCompanyReleaseReadinessV1(value);
    case COMPANY_RELEASE_EVIDENCE_SCHEMA_V1:
      return parseCompanyReleaseEvidenceV1(value, options.release_evidence);
  }
}

/** Parse and route one supported contract without any runtime side effects. */
export function parseServiceReadinessContractV1(
  value: unknown,
  options: ServiceReadinessContractRegistryOptionsV1 = {}
): ServiceReadinessContractValueV1 {
  const { schema } = bodyAndSchema(value);
  if (!supportedSchema(schema)) {
    throw new ServiceReadinessContractError("service_readiness_unknown_schema");
  }
  return parseBySchema(schema, value, options);
}

function validateBySchema(
  schema: ServiceReadinessContractSchemaV1,
  value: unknown,
  options: ServiceReadinessContractRegistryOptionsV1
): ServiceReadinessContractRegistryResultV1 {
  switch (schema) {
    case DAILY_AI_WORKFLOW_CONTRACT_SCHEMA_V1:
      return validateDailyAiWorkflowContractV1(value, options as DailyAiWorkflowContractValidationOptionsV1) as ServiceReadinessContractRegistryResultV1;
    case JOB_MANAGER_WORKFLOW_CONTRACT_SCHEMA_V1:
      return validateJobManagerWorkflowContractV1(value, options as JobManagerValidationOptionsV1) as ServiceReadinessContractRegistryResultV1;
    case NISEN_PRINTS_SERVICE_READINESS_SCHEMA_V1:
      return validateNisenPrintsServiceReadinessContractV1(value, options as NisenPrintsServiceReadinessValidationOptionsV1) as ServiceReadinessContractRegistryResultV1;
    case SERVICE_READINESS_SCHEMA_V1:
      return validateServiceReadinessEvidenceV1(value, options as ServiceReadinessValidationOptionsV1) as ServiceReadinessContractRegistryResultV1;
    case COMPANY_RELEASE_READINESS_SCHEMA_V1:
      return validateCompanyReleaseReadinessV1(value) as ServiceReadinessContractRegistryResultV1;
    case COMPANY_RELEASE_EVIDENCE_SCHEMA_V1:
      return validateCompanyReleaseEvidenceV1(value, options.release_evidence) as ServiceReadinessContractRegistryResultV1;
  }
}

/** Validate and route one supported contract, preserving exact blockers. */
export function validateServiceReadinessContractV1(
  value: unknown,
  options: ServiceReadinessContractRegistryOptionsV1 = {}
): ServiceReadinessContractRegistryResultV1 {
  let schema: string | undefined;
  try {
    const inspected = bodyAndSchema(value);
    schema = inspected.schema;
    if (!supportedSchema(schema)) {
      return {
        ok: false,
        status: "blocked",
        schema,
        exact_blocker: "service_readiness_unknown_schema",
        execution_policy: noEffectPolicy()
      };
    }
    const result = validateBySchema(schema, value, options);
    if (result.ok) {
      return {
        ...result,
        schema,
        execution_policy: executionPolicy(options, result.value)
      };
    }
    return {
      ...result,
      schema,
      execution_policy: noEffectPolicy()
    };
  } catch (error) {
    const exact_blocker = error instanceof ServiceReadinessContractError ? error.code : "service_readiness_contract_validation_failed";
    return {
      ok: false,
      status: "blocked",
      ...(schema ? { schema } : {}),
      exact_blocker,
      execution_policy: noEffectPolicy()
    };
  }
}

export const parseContractV1 = parseServiceReadinessContractV1;
export const validateContractV1 = validateServiceReadinessContractV1;
export const parseServiceReadinessContractRegistryV1 = parseServiceReadinessContractV1;
export const validateServiceReadinessContractRegistryV1 = validateServiceReadinessContractV1;

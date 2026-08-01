import {
  readReferenceIabWorkflowAdaptersV1,
  type ReferenceIabWorkflowAdapterV1
} from "./workflowAdapters.js";
import {
  IAB_EXTERNAL_EFFECT_CAPABILITY_BLOCKER,
  validateIabRootStageAdmissionV1,
  type IabRootStageAdmissionInputV1,
  type IabRootStageAdmissionValidationResultV1
} from "./rootStageAdmission.js";

export { IAB_EXTERNAL_EFFECT_CAPABILITY_BLOCKER };

export const REFERENCE_WORKFLOW_ADMISSION_SCHEMA_V1 = "service_readiness_reference_workflow_admission.v1" as const;

export type ReferenceWorkflowAdmissionInputV1 = {
  workflow_id: string;
  root_binding?: unknown;
  iab_root_binding?: unknown;
  root?: unknown;
  workflow_contract?: unknown;
  contract?: unknown;
  effect_key?: unknown;
  expected_cleanup_receipt_hash?: string | null;
};

export type ReferenceWorkflowAdmissionProjectionV1 = {
  schema: typeof REFERENCE_WORKFLOW_ADMISSION_SCHEMA_V1;
  workflow_id: string;
  contract_schema: string;
  adapter: ReferenceIabWorkflowAdapterV1 | null;
  browser_surface: "in_app_browser";
  legacy_surfaces_forbidden: true;
  prior_receipt_reuse: false;
  capability_mode: "read_only";
  external_action_executed: false;
  contract_provided: boolean;
  status: "blocked" | "admitted";
  exact_blocker: string | null;
  root_admission: IabRootStageAdmissionValidationResultV1;
};

function noContractAdmission(): IabRootStageAdmissionValidationResultV1 {
  return {
    ok: false,
    status: "blocked",
    exact_blocker: IAB_EXTERNAL_EFFECT_CAPABILITY_BLOCKER
  };
}

function contractWasProvided(input: ReferenceWorkflowAdmissionInputV1): boolean {
  return input.workflow_contract !== undefined || input.contract !== undefined;
}

/**
 * Project one owner-facing adapter and, only when a contract is supplied,
 * validate its fresh root-bound admission.  This helper is non-live: it does
 * not grant/consume a capability or call a browser, provider, connector, or
 * durable ledger.
 */
export function projectReferenceWorkflowAdmission(
  input: ReferenceWorkflowAdmissionInputV1
): ReferenceWorkflowAdmissionProjectionV1 {
  const adapter = readReferenceIabWorkflowAdaptersV1().find((candidate) => candidate.workflow_id === input.workflow_id);
  if (!adapter) {
    const rootAdmission = {
      ok: false as const,
      status: "blocked" as const,
      exact_blocker: "reference_workflow_admission_unknown_workflow"
    };
    return {
      schema: REFERENCE_WORKFLOW_ADMISSION_SCHEMA_V1,
      workflow_id: input.workflow_id,
      contract_schema: "unknown",
      adapter: null,
      browser_surface: "in_app_browser",
      legacy_surfaces_forbidden: true,
      prior_receipt_reuse: false,
      capability_mode: "read_only",
      external_action_executed: false,
      contract_provided: contractWasProvided(input),
      status: "blocked",
      exact_blocker: rootAdmission.exact_blocker,
      root_admission: rootAdmission
    };
  }

  const rootAdmission = contractWasProvided(input)
    ? validateIabRootStageAdmissionV1({
        root_binding: input.root_binding ?? input.iab_root_binding ?? input.root,
        workflow_contract: input.workflow_contract ?? input.contract,
        effect_key: input.effect_key,
        expected_cleanup_receipt_hash: input.expected_cleanup_receipt_hash
      } satisfies IabRootStageAdmissionInputV1)
    : noContractAdmission();

  const contractSchema = contractWasProvided(input) && input.workflow_contract && typeof input.workflow_contract === "object"
    ? String((input.workflow_contract as Record<string, unknown>).schema ?? adapter.contract_schema)
    : adapter.contract_schema;
  return {
    schema: REFERENCE_WORKFLOW_ADMISSION_SCHEMA_V1,
    workflow_id: adapter.workflow_id,
    contract_schema: contractSchema,
    adapter: { ...adapter },
    browser_surface: "in_app_browser",
    legacy_surfaces_forbidden: true,
    prior_receipt_reuse: false,
    capability_mode: "read_only",
    external_action_executed: false,
    contract_provided: contractWasProvided(input),
    status: rootAdmission.ok ? "admitted" : "blocked",
    exact_blocker: rootAdmission.ok ? null : rootAdmission.exact_blocker,
    root_admission: rootAdmission
  };
}

export const buildReferenceWorkflowAdmission = projectReferenceWorkflowAdmission;
export const createReferenceWorkflowAdmissionMetadata = projectReferenceWorkflowAdmission;

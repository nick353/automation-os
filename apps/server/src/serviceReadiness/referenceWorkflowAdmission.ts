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
import {
  workflowAdapterIdForReferenceWorkflow,
  workflowAdapterReadback
} from "../providers/workflowAdapterRegistry.js";
import {
  prepareReferenceBrowserUseExternalIntentV1
} from "./workflowAdapters.js";
import {
  readReferenceAosChromeCompanionWorkflowAdaptersV1,
  type ReferenceAosChromeCompanionWorkflowAdapterV1
} from "./workflowAdapters.js";

export { IAB_EXTERNAL_EFFECT_CAPABILITY_BLOCKER };

export const REFERENCE_WORKFLOW_ADMISSION_SCHEMA_V1 = "service_readiness_reference_workflow_admission.v1" as const;
export const REFERENCE_BROWSER_USE_WORKFLOW_ADMISSION_SCHEMA_V1 = "service_readiness_aos_chrome_companion_reference_workflow_admission.v1" as const;
export const REFERENCE_COMPANION_WORKFLOW_ADMISSION_SCHEMA_V1 = REFERENCE_BROWSER_USE_WORKFLOW_ADMISSION_SCHEMA_V1;

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
  aos_workflow_adapter: Record<string, unknown>;
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
      root_admission: rootAdmission,
      aos_workflow_adapter: workflowAdapterReadback(input.workflow_id)
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
    root_admission: rootAdmission,
    aos_workflow_adapter: workflowAdapterReadback(workflowAdapterIdForReferenceWorkflow(adapter.workflow_id) ?? adapter.workflow_id)
  };
}

export const buildReferenceWorkflowAdmission = projectReferenceWorkflowAdmission;
export const createReferenceWorkflowAdmissionMetadata = projectReferenceWorkflowAdmission;

export type ReferenceBrowserUseWorkflowAdmissionProjectionV1 = {
  schema: typeof REFERENCE_BROWSER_USE_WORKFLOW_ADMISSION_SCHEMA_V1;
  workflow_id: string;
  contract_schema: string;
  adapter: ReferenceAosChromeCompanionWorkflowAdapterV1 | null;
  browser_surface: "aos_chrome_companion_profile_instance";
  legacy_surfaces_forbidden: true;
  prior_receipt_reuse: false;
  capability_mode: "read_only";
  external_action_executed: false;
  contract_provided: boolean;
  status: "blocked";
  exact_blocker: string;
  root_admission: {
    ok: false;
    status: "blocked";
    exact_blocker: string;
  };
  aos_workflow_adapter: Record<string, unknown>;
  external_intent: Record<string, unknown> | null;
};

/**
 * Current reference-canary admission projection. The historical IAB and
 * Browser Use projections remain readable for old artifacts, but current
 * reference workflows use the task-owned AOS Chrome Companion surface.
 * This projection is deliberately non-live and stops until a fresh same-run
 * task authority/readback is supplied.
 */
export function projectReferenceBrowserUseWorkflowAdmission(
  input: ReferenceWorkflowAdmissionInputV1
): ReferenceBrowserUseWorkflowAdmissionProjectionV1 {
  const adapter = readReferenceAosChromeCompanionWorkflowAdaptersV1().find((candidate) => candidate.workflow_id === input.workflow_id) ?? null;
  const contractProvided = contractWasProvided(input);
  const externalIntent = adapter && contractProvided
    ? prepareReferenceBrowserUseExternalIntentV1({
      workflow_id: input.workflow_id as "daily-ai" | "job-application-manager" | "nisenprints",
      contract: input.workflow_contract ?? input.contract
    })
    : null;
  const exactBlocker = !adapter
    ? "reference_workflow_admission_unknown_workflow"
    : externalIntent?.status === "blocked"
      ? (externalIntent.exact_blocker?.replaceAll("browser_use_cli", "aos_chrome_companion") ?? "aos_chrome_companion_external_contract_invalid")
      : "aos_chrome_companion_task_id_missing";
  const normalizedExternalIntent = externalIntent
    ? {
        ...externalIntent,
        schema: "service_readiness_aos_chrome_companion_external_intent.v1",
        browser_surface: "aos_chrome_companion_profile_instance",
        exact_blocker: externalIntent.exact_blocker?.replaceAll("browser_use_cli", "aos_chrome_companion") ?? null,
        safe_resume_step: externalIntent.safe_resume_step?.replaceAll("browser_use_cli", "aos_chrome_companion") ?? null
      }
    : null;
  return {
    schema: REFERENCE_BROWSER_USE_WORKFLOW_ADMISSION_SCHEMA_V1,
    workflow_id: input.workflow_id,
    contract_schema: adapter?.workflow_id === "daily-ai"
      ? "daily_ai.workflow_contract.v1"
      : adapter?.workflow_id === "job-application-manager"
        ? "job_manager.workflow_contract.v1"
        : adapter?.workflow_id === "nisenprints"
          ? "nisenprints.service_readiness.v1"
          : "unknown",
    adapter,
    browser_surface: "aos_chrome_companion_profile_instance",
    legacy_surfaces_forbidden: true,
    prior_receipt_reuse: false,
    capability_mode: "read_only",
    external_action_executed: false,
    contract_provided: contractProvided,
    status: "blocked",
    exact_blocker: exactBlocker,
    root_admission: {
      ok: false,
      status: "blocked",
      exact_blocker: exactBlocker
    },
    aos_workflow_adapter: workflowAdapterReadback(workflowAdapterIdForReferenceWorkflow(input.workflow_id) ?? input.workflow_id),
    external_intent: normalizedExternalIntent
  };
}

export const buildReferenceBrowserUseWorkflowAdmission = projectReferenceBrowserUseWorkflowAdmission;

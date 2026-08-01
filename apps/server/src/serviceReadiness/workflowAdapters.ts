import {
  IAB_EXTERNAL_CAPABILITY_SCHEMA_V1
} from "./iabExternalCapability.js";
import { parseDailyAiWorkflowContractV1 } from "./workflowContracts/dailyAi.js";
import { parseJobManagerWorkflowContractV1 } from "./workflowContracts/jobManager.js";
import { parseNisenPrintsServiceReadinessContractV1 } from "./workflowContracts/nisenPrints.js";

/**
 * Owner-facing, non-executing projection of the reference workflow adapter
 * boundary.  The entries describe what the service is allowed to call; they
 * do not grant a browser capability or assert provider authentication.
 */
export const REFERENCE_IAB_WORKFLOW_ADAPTER_SCHEMA_V1 = "service_readiness_iab_workflow_adapter.v1" as const;
export const REFERENCE_BROWSER_USE_WORKFLOW_ADAPTER_SCHEMA_V1 = "service_readiness_browser_use_workflow_adapter.v1" as const;

export type ReferenceBrowserUseWorkflowAdapterV1 = {
  schema: typeof REFERENCE_BROWSER_USE_WORKFLOW_ADAPTER_SCHEMA_V1;
  workflow_id: "daily-ai" | "job-application-manager" | "nisenprints";
  browser_surface: "browser_use_cli";
  adapter_entrypoint: "/Users/nichikatanaka/.codex/skills/automation-kernel-run/scripts/browser-use-cli-stage-adapter.mjs";
  helper_path: "/Users/nichikatanaka/.local/bin/codex-browser-use";
  runtime_config_path: "/Users/nichikatanaka/.codex/browser-use/browser-use-runtime.toml";
  no_fallback: true;
  receipt_discriminator: "browser_use_cli_stage_observation.v1";
  iab_receipt_substitution: "forbidden";
  status: "configured";
};

const browserUseAdapters: readonly ReferenceBrowserUseWorkflowAdapterV1[] = ( [
  "daily-ai",
  "job-application-manager",
  "nisenprints"
] as const).map((workflow_id) => ({
  schema: REFERENCE_BROWSER_USE_WORKFLOW_ADAPTER_SCHEMA_V1,
  workflow_id,
  browser_surface: "browser_use_cli",
  adapter_entrypoint: "/Users/nichikatanaka/.codex/skills/automation-kernel-run/scripts/browser-use-cli-stage-adapter.mjs",
  helper_path: "/Users/nichikatanaka/.local/bin/codex-browser-use",
  runtime_config_path: "/Users/nichikatanaka/.codex/browser-use/browser-use-runtime.toml",
  no_fallback: true,
  receipt_discriminator: "browser_use_cli_stage_observation.v1",
  iab_receipt_substitution: "forbidden",
  status: "configured"
})) as ReferenceBrowserUseWorkflowAdapterV1[];

export function readReferenceBrowserUseWorkflowAdaptersV1(): ReferenceBrowserUseWorkflowAdapterV1[] {
  return browserUseAdapters.map((adapter) => ({ ...adapter }));
}

export type ReferenceIabWorkflowAdapterV1 = {
  schema: typeof REFERENCE_IAB_WORKFLOW_ADAPTER_SCHEMA_V1;
  workflow_id: "daily-ai" | "job-application-manager" | "nisenprints";
  contract_schema: string;
  browser_surface: "in_app_browser";
  legacy_primary_surfaces: "forbidden";
  capability_mode: "read_only";
  external_action_executed: false;
  external_capability_contract: typeof IAB_EXTERNAL_CAPABILITY_SCHEMA_V1;
  /** The sibling contract is implemented locally, but the trusted runtime is not injected. */
  local_executor_contract: "implemented";
  runtime_injected: false;
  external_effect_ready: false;
  external_executor_status: "not_implemented";
  account_target_payload_receipt_contract: "schema_defined_not_populated";
  status: "blocked";
  exact_blocker: "iab_external_effect_capability_not_implemented";
  safe_resume_step: string;
};

const adapters: readonly ReferenceIabWorkflowAdapterV1[] = [
  {
    schema: REFERENCE_IAB_WORKFLOW_ADAPTER_SCHEMA_V1,
    workflow_id: "daily-ai",
    contract_schema: "daily_ai.workflow_contract.v1",
    browser_surface: "in_app_browser",
    legacy_primary_surfaces: "forbidden",
    capability_mode: "read_only",
    external_action_executed: false,
    external_capability_contract: IAB_EXTERNAL_CAPABILITY_SCHEMA_V1,
    local_executor_contract: "implemented",
    runtime_injected: false,
    external_effect_ready: false,
    external_executor_status: "not_implemented",
    account_target_payload_receipt_contract: "schema_defined_not_populated",
    status: "blocked",
    exact_blocker: "iab_external_effect_capability_not_implemented",
    safe_resume_step: "bind Daily AI account/target/payload/provider receipt contract, then obtain an approved IAB external executor"
  },
  {
    schema: REFERENCE_IAB_WORKFLOW_ADAPTER_SCHEMA_V1,
    workflow_id: "job-application-manager",
    contract_schema: "job_manager.workflow_contract.v1",
    browser_surface: "in_app_browser",
    legacy_primary_surfaces: "forbidden",
    capability_mode: "read_only",
    external_action_executed: false,
    external_capability_contract: IAB_EXTERNAL_CAPABILITY_SCHEMA_V1,
    local_executor_contract: "implemented",
    runtime_injected: false,
    external_effect_ready: false,
    external_executor_status: "not_implemented",
    account_target_payload_receipt_contract: "schema_defined_not_populated",
    status: "blocked",
    exact_blocker: "iab_external_effect_capability_not_implemented",
    safe_resume_step: "bind Job Manager account/target/payload/provider receipt contract and Gmail capture, then obtain an approved IAB external executor"
  },
  {
    schema: REFERENCE_IAB_WORKFLOW_ADAPTER_SCHEMA_V1,
    workflow_id: "nisenprints",
    contract_schema: "nisenprints.service_readiness.v1",
    browser_surface: "in_app_browser",
    legacy_primary_surfaces: "forbidden",
    capability_mode: "read_only",
    external_action_executed: false,
    external_capability_contract: IAB_EXTERNAL_CAPABILITY_SCHEMA_V1,
    local_executor_contract: "implemented",
    runtime_injected: false,
    external_effect_ready: false,
    external_executor_status: "not_implemented",
    account_target_payload_receipt_contract: "schema_defined_not_populated",
    status: "blocked",
    exact_blocker: "iab_external_effect_capability_not_implemented",
    safe_resume_step: "bind Etsy/Printify/Pinterest account/target/payload/provider receipt contract and reauthenticate providers, then obtain an approved IAB external executor"
  }
] as const;

/** Return a fresh copy so callers cannot mutate the static policy projection. */
export function readReferenceIabWorkflowAdaptersV1(): ReferenceIabWorkflowAdapterV1[] {
  return adapters.map((adapter) => ({ ...adapter }));
}

export const getReferenceIabWorkflowAdapters = readReferenceIabWorkflowAdaptersV1;
export const getReferenceBrowserUseWorkflowAdapters = readReferenceBrowserUseWorkflowAdaptersV1;

export type PreparedReferenceIabExternalIntentV1 = {
  schema: "service_readiness_iab_external_intent.v1";
  workflow_id: "daily-ai" | "job-application-manager" | "nisenprints";
  provider: string;
  account_ref: string;
  target_hash: string;
  payload_hash: string;
  effect_key: string;
  external_action_executed: false;
  status: "ready" | "blocked";
  exact_blocker: string | null;
  safe_resume_step: string | null;
};

function blockedIntent(workflowId: PreparedReferenceIabExternalIntentV1["workflow_id"], exactBlocker: string, safeResumeStep = "repair_workflow_contract_before_external_admission"): PreparedReferenceIabExternalIntentV1 {
  return {
    schema: "service_readiness_iab_external_intent.v1",
    workflow_id: workflowId,
    provider: "",
    account_ref: "",
    target_hash: "",
    payload_hash: "",
    effect_key: "",
    external_action_executed: false,
    status: "blocked",
    exact_blocker: exactBlocker,
    safe_resume_step: safeResumeStep
  };
}

/**
 * Normalize one workflow-owned contract into the shared external queue
 * boundary.  This is preparation only: it never issues a capability, claims
 * an IAB tab, calls a provider, or marks an effect executed.
 */
export function prepareReferenceIabExternalIntentV1(input: {
  workflow_id: PreparedReferenceIabExternalIntentV1["workflow_id"];
  contract: unknown;
}): PreparedReferenceIabExternalIntentV1 {
  try {
    if (input.workflow_id === "daily-ai") {
      const parsed = parseDailyAiWorkflowContractV1(input.contract);
      if (parsed.capability_mode !== "external" || parsed.effect_class !== "external_non_idempotent") return blockedIntent(input.workflow_id, "iab_external_workflow_external_mode_required");
      if (parsed.no_post) return blockedIntent(input.workflow_id, "daily_ai_linkedin_no_post_or_iab_capability", "obtain_approved_linkedin_iab_capability_or_keep_no_post");
      if (parsed.external_action_executed) return blockedIntent(input.workflow_id, "external_effect_already_executed_reuse_forbidden", "reconcile_existing_provider_receipt");
      return {
        schema: "service_readiness_iab_external_intent.v1",
        workflow_id: input.workflow_id,
        provider: parsed.provider,
        account_ref: parsed.account_ref,
        target_hash: parsed.target_hash,
        payload_hash: parsed.payload_hash,
        effect_key: parsed.effect_key,
        external_action_executed: false,
        status: "ready",
        exact_blocker: null,
        safe_resume_step: null
      };
    }
    if (input.workflow_id === "job-application-manager") {
      const parsed = parseJobManagerWorkflowContractV1(input.contract);
      if (parsed.capture_blocker) return blockedIntent(input.workflow_id, parsed.capture_blocker, "resolve_gmail_or_thread_identity_capture_before_external_admission");
      if (parsed.capability_mode !== "external" || parsed.effect_class !== "external_non_idempotent") return blockedIntent(input.workflow_id, "iab_external_workflow_external_mode_required");
      if (parsed.external_action_executed || parsed.submitted_confirmed) return blockedIntent(input.workflow_id, "external_effect_already_executed_reuse_forbidden", "reconcile_existing_application_receipt");
      return {
        schema: "service_readiness_iab_external_intent.v1",
        workflow_id: input.workflow_id,
        provider: parsed.provider,
        account_ref: parsed.account_ref,
        target_hash: parsed.target_hash,
        payload_hash: parsed.payload_hash,
        effect_key: parsed.effect_key,
        external_action_executed: false,
        status: "ready",
        exact_blocker: null,
        safe_resume_step: null
      };
    }
    const parsed = parseNisenPrintsServiceReadinessContractV1(input.contract);
    if (parsed.mode === "etsy_sync" || parsed.capability_mode !== "external" || parsed.effect_class !== "external_non_idempotent") return blockedIntent(input.workflow_id, "nisenprints_external_mode_required");
    if (parsed.exact_blocker === "printify_auth_required" || parsed.exact_blocker === "printify_reauth_required") return blockedIntent(input.workflow_id, parsed.exact_blocker, "reauth_printify_then_reconcile");
    if (parsed.external_action_executed) return blockedIntent(input.workflow_id, "external_effect_already_executed_reuse_forbidden", "reconcile_existing_listing_receipt");
    return {
      schema: "service_readiness_iab_external_intent.v1",
      workflow_id: input.workflow_id,
      provider: parsed.provider,
      account_ref: parsed.account_ref,
      target_hash: parsed.product_listing_target_hash,
      payload_hash: parsed.asset_media_hash,
      effect_key: parsed.effect_key,
      external_action_executed: false,
      status: "ready",
      exact_blocker: null,
      safe_resume_step: null
    };
  } catch (error) {
    return blockedIntent(input.workflow_id, error instanceof Error ? error.message : "workflow_external_contract_invalid");
  }
}

import type { PortableWorkflowId } from "./portableWorkflowContract.js";
import { getWebOperationContract, validateWebOperationContract, type WebOperationContractV1 } from "./webOperationContract.js";

export const PORTABLE_EXTERNAL_BUSINESS_PLAN_SCHEMA_V1 = "automation_os_portable_external_business_plan.v1" as const;
export const PORTABLE_ACCOUNT_TARGET_PAYLOAD_RECEIPT_CONTRACT_SCHEMA_V1 = "automation_os_account_target_payload_receipt_contract.v1" as const;

export type PortableAccountTargetPayloadReceiptContractV1 = {
  schema: typeof PORTABLE_ACCOUNT_TARGET_PAYLOAD_RECEIPT_CONTRACT_SCHEMA_V1;
  account_fields: readonly string[];
  target_fields: readonly string[];
  payload_fields: readonly string[];
  receipt_fields: readonly string[];
  same_run_bindings: readonly string[];
  required_input_fields: readonly string[];
};

export type PortableExternalBusinessPlanV1 = {
  schema: typeof PORTABLE_EXTERNAL_BUSINESS_PLAN_SCHEMA_V1;
  workflow_id: Extract<PortableWorkflowId, "job-application-manager" | "daily-ai-research-publish-run" | "nisenprints-daily-product-canva-printify-etsy-pinterest">;
  runner_key: "job_application" | "daily_ai" | "nisenprints";
  browser_surface: "browser_use_cli";
  llm_provider_neutral: true;
  app_dependency: false;
  external_effect_policy: "approval_required";
  stages: readonly string[];
  required_business_proofs: readonly string[];
  hard_stops: readonly string[];
  account_target_payload_receipt_contract: PortableAccountTargetPayloadReceiptContractV1;
  required_runner_contract: {
    current_run_bound: true;
    fresh_authority: true;
    same_run_idempotency: true;
    same_run_receipt: true;
    cleanup_readback: true;
    web_operation_contract: WebOperationContractV1;
  };
};

const commonHardStops = [
  "browser_use_cli_authority_missing",
  "authentication_required",
  "captcha_otp_security_code",
  "ambiguous_external_effect",
  "cleanup_readback_missing",
] as const;

const commonRunnerContract = Object.freeze({
  current_run_bound: true as const,
  fresh_authority: true as const,
  same_run_idempotency: true as const,
  same_run_receipt: true as const,
  cleanup_readback: true as const,
  web_operation_contract: getWebOperationContract(),
});

const commonAccountTargetPayloadReceiptContract = Object.freeze({
  schema: PORTABLE_ACCOUNT_TARGET_PAYLOAD_RECEIPT_CONTRACT_SCHEMA_V1,
  account_fields: ["company_id", "workflow_id", "account_ref"],
  target_fields: ["target_key", "target_digest", "source_snapshot_id"],
  payload_fields: ["payload_hash", "input_bundle_sha256", "idempotency_key"],
  receipt_fields: ["run_id", "step_id", "same_run_receipt", "readback_verified", "cleanup_verified", "external_action_executed", "exact_blocker"],
  same_run_bindings: ["run_id", "step_id", "idempotency_key", "input_bundle_sha256", "target_digest"],
});

export const portableExternalBusinessPlans: Record<PortableExternalBusinessPlanV1["workflow_id"], PortableExternalBusinessPlanV1> = {
  "job-application-manager": {
    schema: PORTABLE_EXTERNAL_BUSINESS_PLAN_SCHEMA_V1,
    workflow_id: "job-application-manager",
    runner_key: "job_application",
    browser_surface: "browser_use_cli",
    llm_provider_neutral: true,
    app_dependency: false,
    external_effect_policy: "approval_required",
    stages: ["source_readback", "candidate_supply", "browser_preflight", "one_candidate_submit", "same_run_sync_readback", "cleanup"],
    required_business_proofs: ["submitted_confirmed", "same_run_source_of_truth_readback", "cleanup_receipt"],
    hard_stops: [...commonHardStops, "unknown_required_personal_fact", "assessment_or_identity_gate", "missing_visible_submission_success"],
    account_target_payload_receipt_contract: {
      ...commonAccountTargetPayloadReceiptContract,
      required_input_fields: ["account_ref", "job_url", "application_url", "candidate_key", "bucket", "sequence", "attempt", "source_snapshot_id", "supply_run_id", "payload_hash"],
    },
    required_runner_contract: commonRunnerContract,
  },
  "daily-ai-research-publish-run": {
    schema: PORTABLE_EXTERNAL_BUSINESS_PLAN_SCHEMA_V1,
    workflow_id: "daily-ai-research-publish-run",
    runner_key: "daily_ai",
    browser_surface: "browser_use_cli",
    llm_provider_neutral: true,
    app_dependency: false,
    external_effect_policy: "approval_required",
    stages: ["research_queue_refresh", "pre_entry_readiness", "browser_preflight", "publish", "feed_study", "engagement", "postflight_sync", "cleanup"],
    required_business_proofs: ["publish_url_or_exact_blocker", "feed_study_or_exact_blocker", "engagement_or_no_candidate_proof", "queue_sync", "cleanup_receipt"],
    hard_stops: [...commonHardStops, "language_mismatch", "media_receipt_missing", "publish_readback_missing", "engagement_readback_missing"],
    account_target_payload_receipt_contract: {
      ...commonAccountTargetPayloadReceiptContract,
      required_input_fields: ["account_ref", "target_key", "content_key", "payload_hash", "source_snapshot_id"],
    },
    required_runner_contract: commonRunnerContract,
  },
  "nisenprints-daily-product-canva-printify-etsy-pinterest": {
    schema: PORTABLE_EXTERNAL_BUSINESS_PLAN_SCHEMA_V1,
    workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest",
    runner_key: "nisenprints",
    browser_surface: "browser_use_cli",
    llm_provider_neutral: true,
    app_dependency: false,
    external_effect_policy: "approval_required",
    stages: ["prepare_context", "browser_preflight", "runway_generate", "canva_preflight", "canva_transaction", "canva_commit_export", "canva_artifact_gate", "canva_verify", "printify_product_copy", "printify_publish", "etsy_listing_discovery", "etsy_media_repair", "pinterest_queue", "pinterest_post", "strict_completion", "cleanup"],
    required_business_proofs: ["generation_manifest", "etsy_listing", "pinterest_pin_url", "etsy_visit_site_match", "cleanup_receipt"],
    hard_stops: [...commonHardStops, "provider_auth_required", "listing_or_pin_duplicate", "asset_artifact_missing", "link_target_mismatch"],
    account_target_payload_receipt_contract: {
      ...commonAccountTargetPayloadReceiptContract,
      required_input_fields: ["account_ref", "target_key", "product_key", "asset_manifest_id", "payload_hash", "source_snapshot_id"],
    },
    required_runner_contract: commonRunnerContract,
  },
};

export function getPortableExternalBusinessPlan(workflowId: string): PortableExternalBusinessPlanV1 | null {
  const plan = portableExternalBusinessPlans[workflowId as PortableExternalBusinessPlanV1["workflow_id"]];
  return plan ? {
    ...plan,
    stages: [...plan.stages],
    required_business_proofs: [...plan.required_business_proofs],
    hard_stops: [...plan.hard_stops],
    required_runner_contract: {
      ...plan.required_runner_contract,
      web_operation_contract: getWebOperationContract(),
    },
  } : null;
}

export function validatePortableExternalBusinessPlan(plan: PortableExternalBusinessPlanV1): PortableExternalBusinessPlanV1 {
  if (plan.schema !== PORTABLE_EXTERNAL_BUSINESS_PLAN_SCHEMA_V1) throw new Error("portable_external_business_plan_schema_invalid");
  if (plan.browser_surface !== "browser_use_cli") throw new Error("portable_external_business_plan_browser_surface_invalid");
  if (plan.llm_provider_neutral !== true || plan.app_dependency !== false) throw new Error("portable_external_business_plan_dependency_invalid");
  if (plan.external_effect_policy !== "approval_required") throw new Error("portable_external_business_plan_effect_policy_invalid");
  if (!plan.runner_key || !plan.stages.length || !plan.required_business_proofs.length) throw new Error("portable_external_business_plan_incomplete");
  const binding = plan.account_target_payload_receipt_contract;
  if (binding.schema !== PORTABLE_ACCOUNT_TARGET_PAYLOAD_RECEIPT_CONTRACT_SCHEMA_V1
    || !binding.account_fields.length
    || !binding.target_fields.length
    || !binding.payload_fields.length
    || !binding.receipt_fields.length
    || !binding.same_run_bindings.includes("run_id")
    || !binding.same_run_bindings.includes("idempotency_key")
    || !binding.required_input_fields.length) {
    throw new Error("portable_external_business_plan_binding_contract_invalid");
  }
  if (plan.required_runner_contract.current_run_bound !== true || plan.required_runner_contract.fresh_authority !== true || plan.required_runner_contract.same_run_idempotency !== true || plan.required_runner_contract.same_run_receipt !== true || plan.required_runner_contract.cleanup_readback !== true) {
    throw new Error("portable_external_business_plan_runner_contract_invalid");
  }
  validateWebOperationContract(plan.required_runner_contract.web_operation_contract);
  return plan;
}

export function validatePortableBusinessInputBundle(workflowId: string, bundle: Record<string, unknown> | null): { ok: true } | { ok: false; exact_blocker: string } {
  const plan = getPortableExternalBusinessPlan(workflowId);
  if (!plan) return { ok: false, exact_blocker: "portable_business_workflow_plan_missing" };
  if (!bundle) return { ok: false, exact_blocker: `portable_business_${plan.runner_key}_input_bundle_missing` };
  for (const field of plan.account_target_payload_receipt_contract.required_input_fields) {
    const value = bundle[field];
    if (typeof value !== "string" && typeof value !== "number") {
      return { ok: false, exact_blocker: `portable_business_${plan.runner_key}_input_${field}_missing` };
    }
    if (typeof value === "string" && !value.trim()) {
      return { ok: false, exact_blocker: `portable_business_${plan.runner_key}_input_${field}_missing` };
    }
  }
  if (plan.account_target_payload_receipt_contract.required_input_fields.includes("payload_hash")
    && !/^[a-f0-9]{64}$/u.test(String(bundle.payload_hash ?? ""))) {
    return { ok: false, exact_blocker: `portable_business_${plan.runner_key}_input_payload_hash_invalid` };
  }
  return { ok: true };
}

for (const plan of Object.values(portableExternalBusinessPlans)) validatePortableExternalBusinessPlan(plan);

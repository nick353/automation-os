/**
 * AOS-owned workflow adapter registry.
 *
 * This is the provider-neutral execution plan for every registered workflow.
 * It deliberately describes stages and proof contracts without granting
 * provider credentials or external-effect authority. A provider
 * implementation may be selected later, but the control plane keeps
 * ownership of run binding, idempotency, approvals, and readback.
 */

import { WEB_OPERATION_CONTRACT_SCHEMA_V1 } from "../runs/webOperationContract.js";

export const WORKFLOW_ADAPTER_REGISTRY_SCHEMA = "aos.workflow_adapter_registry.v1" as const;

export type WorkflowAdapterWorkflowId =
  | "daily-ai-research-publish-run"
  | "job-application-manager"
  | "nisenprints-daily-product-canva-printify-etsy-pinterest"
  | "email-review-reply"
  | "daily-backup-safety-check"
  | "obsidian-project-memory-audit";

export type WorkflowAdapterKind =
  | "daily_ai_registered"
  | "job_submit_registered"
  | "nisenprints_registered"
  | "email_review_registered"
  | "local_backup_registered"
  | "obsidian_audit_registered";
export type WorkflowAdapterEffectClass = "internal_idempotent" | "external_non_idempotent";
export type WorkflowAdapterStageKind = "read" | "admission" | "effect" | "readback" | "cleanup";

export type WorkflowProviderAdapter = {
  id: string;
  provider: string;
  capability: string;
  browser_surface: "browser_use_cli" | "none";
  required_readback: string[];
  external_action_allowed: false;
};

export type WorkflowAdapterStage = {
  id: string;
  kind: WorkflowAdapterStageKind;
  effect_class: WorkflowAdapterEffectClass;
  provider_adapter_ids: string[];
  required_proof: string[];
  external_action_allowed: false;
};

export type WorkflowAdapterDefinition = {
  schema: typeof WORKFLOW_ADAPTER_REGISTRY_SCHEMA;
  workflow_id: WorkflowAdapterWorkflowId;
  adapter: WorkflowAdapterKind;
  browser_surface: "browser_use_cli" | "none";
  web_operation_contract_binding: WorkflowWebOperationContractBinding | null;
  execution_authority: "automation_os_control_plane";
  provider_selectable: boolean;
  codex_is_not_authority: true;
  default_mode: "preflight_no_effect";
  external_action_default: false;
  provider_adapters: WorkflowProviderAdapter[];
  stages: WorkflowAdapterStage[];
  exact_blockers: string[];
};

export type WorkflowWebOperationContractBinding = {
  schema: typeof WEB_OPERATION_CONTRACT_SCHEMA_V1;
  adaptive_target_resolution: "live_semantic_candidate_unique_match";
  fixed_locator_authority: false;
  fixed_playbook_authority: false;
  provider_neutral: true;
};

export type WorkflowAdapterContractValidation = {
  ok: boolean;
  status: "ready_for_preflight_no_effect" | "blocked";
  exact_blocker: string | null;
  errors: string[];
};

const controlPlaneAdapter: WorkflowProviderAdapter = {
  id: "aos-control-plane",
  provider: "aos.control_plane",
  capability: "run_binding_and_readback",
  browser_surface: "none",
  required_readback: ["run_id", "company_id", "request_hash", "idempotency_key"],
  external_action_allowed: false
};

const browserUseAdapter: WorkflowProviderAdapter = {
  id: "browser-use-cli",
  provider: "browser_use_cli",
  capability: "same_session_readback",
  browser_surface: "browser_use_cli",
  required_readback: ["current_run_authority", "profile_port_lease", "same_session_state", "cleanup_receipt"],
  external_action_allowed: false
};

const browserWebOperationContractBinding: WorkflowWebOperationContractBinding = Object.freeze({
  schema: WEB_OPERATION_CONTRACT_SCHEMA_V1,
  adaptive_target_resolution: "live_semantic_candidate_unique_match",
  fixed_locator_authority: false,
  fixed_playbook_authority: false,
  provider_neutral: true
});

const definitions: readonly WorkflowAdapterDefinition[] = [
  {
    schema: WORKFLOW_ADAPTER_REGISTRY_SCHEMA,
    workflow_id: "daily-ai-research-publish-run",
    adapter: "daily_ai_registered",
    browser_surface: "browser_use_cli",
    web_operation_contract_binding: browserWebOperationContractBinding,
    execution_authority: "automation_os_control_plane",
    provider_selectable: true,
    codex_is_not_authority: true,
    default_mode: "preflight_no_effect",
    external_action_default: false,
    provider_adapters: [
      controlPlaneAdapter,
      browserUseAdapter,
      {
        id: "runway-mcp",
        provider: "runway_mcp",
        capability: "media_generation_receipt",
        browser_surface: "none",
        required_readback: ["queue_id", "platform", "language", "media_receipt_hash"],
        external_action_allowed: false
      },
      {
        id: "social-platform",
        provider: "social_platform",
        capability: "publish_and_platform_readback",
        browser_surface: "browser_use_cli",
        required_readback: ["same_run_publish_receipt", "published_url", "platform_reflection"],
        external_action_allowed: false
      }
    ],
    stages: [
      { id: "research_queue_refresh", kind: "read", effect_class: "internal_idempotent", provider_adapter_ids: ["aos-control-plane"], required_proof: ["source_snapshot", "local_queue_readback"], external_action_allowed: false },
      { id: "media_readiness", kind: "admission", effect_class: "internal_idempotent", provider_adapter_ids: ["runway-mcp"], required_proof: ["provider_media_receipt"], external_action_allowed: false },
      { id: "browser_no_post_qa", kind: "admission", effect_class: "internal_idempotent", provider_adapter_ids: ["browser-use-cli"], required_proof: ["browser_use_cli_canary", "visual_qa_pass"], external_action_allowed: false },
      { id: "publish", kind: "effect", effect_class: "external_non_idempotent", provider_adapter_ids: ["social-platform"], required_proof: ["approval_binding", "same_run_publish_receipt"], external_action_allowed: false },
      { id: "feed_study_and_engagement", kind: "effect", effect_class: "external_non_idempotent", provider_adapter_ids: ["social-platform"], required_proof: ["approval_binding", "platform_readback", "bounded_action_receipts"], external_action_allowed: false },
      { id: "queue_and_sheets_sync", kind: "readback", effect_class: "internal_idempotent", provider_adapter_ids: ["aos-control-plane"], required_proof: ["source_of_truth_sync"], external_action_allowed: false },
      { id: "cleanup", kind: "cleanup", effect_class: "internal_idempotent", provider_adapter_ids: ["browser-use-cli", "aos-control-plane"], required_proof: ["browser_cleanup", "automation_kernel_result.v2"], external_action_allowed: false }
    ],
    exact_blockers: ["runway_mcp_result_handoff_missing", "browser_use_cli_authority_missing", "publish_readback_missing", "ambiguous_external_effect"]
  },
  {
    schema: WORKFLOW_ADAPTER_REGISTRY_SCHEMA,
    workflow_id: "job-application-manager",
    adapter: "job_submit_registered",
    browser_surface: "browser_use_cli",
    web_operation_contract_binding: browserWebOperationContractBinding,
    execution_authority: "automation_os_control_plane",
    provider_selectable: true,
    codex_is_not_authority: true,
    default_mode: "preflight_no_effect",
    external_action_default: false,
    provider_adapters: [
      controlPlaneAdapter,
      browserUseAdapter,
      {
        id: "job-board",
        provider: "job_board",
        capability: "candidate_discovery_and_submit_readback",
        browser_surface: "browser_use_cli",
        required_readback: ["candidate_id", "visible_submission_confirmation", "submitted_receipt"],
        external_action_allowed: false
      },
      {
        id: "gmail-capture",
        provider: "gmail",
        capability: "summary_first_capture",
        browser_surface: "none",
        required_readback: ["gmail_summary_capture.v1", "same_run_message_identity"],
        external_action_allowed: false
      }
    ],
    stages: [
      { id: "source_snapshot", kind: "read", effect_class: "internal_idempotent", provider_adapter_ids: ["aos-control-plane"], required_proof: ["source_snapshot.v1"], external_action_allowed: false },
      { id: "candidate_supply", kind: "read", effect_class: "internal_idempotent", provider_adapter_ids: ["job-board"], required_proof: ["candidate_supply.v1", "dedupe_readback"], external_action_allowed: false },
      { id: "identity_admission", kind: "admission", effect_class: "internal_idempotent", provider_adapter_ids: ["aos-control-plane"], required_proof: ["applicant_profile_hash", "identity_capability_readback", "current_run_binding"], external_action_allowed: false },
      { id: "browser_admission", kind: "admission", effect_class: "internal_idempotent", provider_adapter_ids: ["browser-use-cli"], required_proof: ["browser_use_cli_authority", "profile_port_lease", "same_run_readback"], external_action_allowed: false },
      { id: "candidate_submit", kind: "effect", effect_class: "external_non_idempotent", provider_adapter_ids: ["job-board"], required_proof: ["approval_binding", "one_candidate_idempotency", "visible_submission_confirmation"], external_action_allowed: false },
      { id: "submit_readback", kind: "readback", effect_class: "internal_idempotent", provider_adapter_ids: ["job-board"], required_proof: ["source_of_truth_readback", "same_run_receipt"], external_action_allowed: false },
      { id: "ledger_sync", kind: "readback", effect_class: "internal_idempotent", provider_adapter_ids: ["aos-control-plane"], required_proof: ["opportunity_ledger_append", "submitted_confirmed_or_pending_confirmation"], external_action_allowed: false },
      { id: "cleanup", kind: "cleanup", effect_class: "internal_idempotent", provider_adapter_ids: ["browser-use-cli", "aos-control-plane"], required_proof: ["flow_lease_cleanup", "run_terminal_artifact", "automation_kernel_result.v2"], external_action_allowed: false }
    ],
    exact_blockers: ["identity_capability_unavailable", "browser_use_cli_authority_missing", "applicant_unknown_required_fact", "captcha_or_otp_required", "submit_readback_missing"]
  },
  {
    schema: WORKFLOW_ADAPTER_REGISTRY_SCHEMA,
    workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest",
    adapter: "nisenprints_registered",
    browser_surface: "browser_use_cli",
    web_operation_contract_binding: browserWebOperationContractBinding,
    execution_authority: "automation_os_control_plane",
    provider_selectable: true,
    codex_is_not_authority: true,
    default_mode: "preflight_no_effect",
    external_action_default: false,
    provider_adapters: [
      controlPlaneAdapter,
      browserUseAdapter,
      {
        id: "canva",
        provider: "canva",
        capability: "asset_generation_and_export",
        browser_surface: "browser_use_cli",
        required_readback: ["asset_hash", "export_artifact"],
        external_action_allowed: false
      },
      {
        id: "printify",
        provider: "printify",
        capability: "product_copy_and_publish_readback",
        browser_surface: "browser_use_cli",
        required_readback: ["provider_product_id", "provider_receipt_hash"],
        external_action_allowed: false
      },
      {
        id: "etsy",
        provider: "etsy",
        capability: "listing_snapshot_and_link_readback",
        browser_surface: "browser_use_cli",
        required_readback: ["etsy_listing_id", "etsy_listing_url"],
        external_action_allowed: false
      },
      {
        id: "pinterest",
        provider: "pinterest",
        capability: "pin_publish_and_etsy_link_readback",
        browser_surface: "browser_use_cli",
        required_readback: ["pinterest_pin_url", "pin_to_etsy_url_match"],
        external_action_allowed: false
      }
    ],
    stages: [
      { id: "listing_snapshot", kind: "read", effect_class: "internal_idempotent", provider_adapter_ids: ["etsy"], required_proof: ["etsy_listing_snapshot"], external_action_allowed: false },
      { id: "asset_and_provider_admission", kind: "admission", effect_class: "internal_idempotent", provider_adapter_ids: ["canva", "printify", "etsy", "pinterest"], required_proof: ["current_provider_auth", "asset_hash"], external_action_allowed: false },
      { id: "provider_mutations", kind: "effect", effect_class: "external_non_idempotent", provider_adapter_ids: ["canva", "printify"], required_proof: ["approval_binding", "provider_idempotency"], external_action_allowed: false },
      { id: "etsy_and_pinterest_publish", kind: "effect", effect_class: "external_non_idempotent", provider_adapter_ids: ["etsy", "pinterest"], required_proof: ["approval_binding", "visible_publish_receipt"], external_action_allowed: false },
      { id: "product_link_readback", kind: "readback", effect_class: "internal_idempotent", provider_adapter_ids: ["etsy", "pinterest"], required_proof: ["pin_to_etsy_url_match"], external_action_allowed: false },
      { id: "source_sync", kind: "readback", effect_class: "internal_idempotent", provider_adapter_ids: ["aos-control-plane"], required_proof: ["queue_status_sync"], external_action_allowed: false },
      { id: "cleanup", kind: "cleanup", effect_class: "internal_idempotent", provider_adapter_ids: ["browser-use-cli", "aos-control-plane"], required_proof: ["browser_cleanup", "automation_kernel_result.v2"], external_action_allowed: false }
    ],
    exact_blockers: ["browser_use_cli_authority_missing", "provider_auth_missing", "provider_idempotency_missing", "publish_readback_missing", "etsy_url_mismatch"]
  },
  {
    schema: WORKFLOW_ADAPTER_REGISTRY_SCHEMA,
    workflow_id: "email-review-reply",
    adapter: "email_review_registered",
    browser_surface: "none",
    web_operation_contract_binding: null,
    execution_authority: "automation_os_control_plane",
    provider_selectable: true,
    codex_is_not_authority: true,
    default_mode: "preflight_no_effect",
    external_action_default: false,
    provider_adapters: [
      controlPlaneAdapter,
      {
        id: "gmail-connector",
        provider: "gmail",
        capability: "summary_first_capture_and_same_run_readback",
        browser_surface: "none",
        required_readback: ["gmail_summary_capture.v1", "same_run_message_or_event_readback"],
        external_action_allowed: false
      }
    ],
    stages: [
      { id: "newest_100_snapshot", kind: "read", effect_class: "internal_idempotent", provider_adapter_ids: ["gmail-connector"], required_proof: ["gmail_summary_capture.v1"], external_action_allowed: false },
      { id: "individual_classification", kind: "read", effect_class: "internal_idempotent", provider_adapter_ids: ["aos-control-plane"], required_proof: ["classification_ledger"], external_action_allowed: false },
      { id: "reply_draft", kind: "readback", effect_class: "internal_idempotent", provider_adapter_ids: ["aos-control-plane"], required_proof: ["draft_candidate_hash"], external_action_allowed: false },
      { id: "reply_or_calendar_approval", kind: "admission", effect_class: "external_non_idempotent", provider_adapter_ids: ["aos-control-plane"], required_proof: ["approval_binding", "candidate_expiry"], external_action_allowed: false },
      { id: "send_or_create_event", kind: "effect", effect_class: "external_non_idempotent", provider_adapter_ids: ["gmail-connector"], required_proof: ["approval_binding", "approved_exact_candidate", "provider_receipt"], external_action_allowed: false },
      { id: "connector_readback", kind: "readback", effect_class: "internal_idempotent", provider_adapter_ids: ["gmail-connector"], required_proof: ["same_run_message_or_event_readback"], external_action_allowed: false },
      { id: "cleanup", kind: "cleanup", effect_class: "internal_idempotent", provider_adapter_ids: ["aos-control-plane"], required_proof: ["safe_capture_cleanup", "automation_kernel_result.v2"], external_action_allowed: false }
    ],
    exact_blockers: ["gmail_connector_context_isolation_unavailable", "gmail_connector_response_capture_unavailable", "approval_expired", "recipient_or_event_hash_mismatch", "ambiguous_send_readback"]
  },
  {
    schema: WORKFLOW_ADAPTER_REGISTRY_SCHEMA,
    workflow_id: "daily-backup-safety-check",
    adapter: "local_backup_registered",
    browser_surface: "none",
    web_operation_contract_binding: null,
    execution_authority: "automation_os_control_plane",
    provider_selectable: false,
    codex_is_not_authority: true,
    default_mode: "preflight_no_effect",
    external_action_default: false,
    provider_adapters: [
      controlPlaneAdapter,
      {
        id: "local-filesystem",
        provider: "automation_os_local_filesystem",
        capability: "fixture_scoped_snapshot_integrity_and_restore_readback",
        browser_surface: "none",
        required_readback: ["snapshot_artifact", "checksum_and_manifest", "cleanup_proof"],
        external_action_allowed: false
      }
    ],
    stages: [
      { id: "source_snapshot", kind: "read", effect_class: "internal_idempotent", provider_adapter_ids: ["local-filesystem"], required_proof: ["local_source_readback"], external_action_allowed: false },
      { id: "backup_snapshot", kind: "effect", effect_class: "internal_idempotent", provider_adapter_ids: ["local-filesystem"], required_proof: ["snapshot_artifact"], external_action_allowed: false },
      { id: "integrity_readback", kind: "readback", effect_class: "internal_idempotent", provider_adapter_ids: ["local-filesystem"], required_proof: ["checksum_and_manifest"], external_action_allowed: false },
      { id: "cleanup", kind: "cleanup", effect_class: "internal_idempotent", provider_adapter_ids: ["aos-control-plane", "local-filesystem"], required_proof: ["automation_kernel_result.v2", "cleanup_proof"], external_action_allowed: false }
    ],
    exact_blockers: ["backup_source_unavailable", "backup_integrity_mismatch", "automation_kernel_result_missing", "local_backup_effect_requires_explicit_approval"]
  },
  {
    schema: WORKFLOW_ADAPTER_REGISTRY_SCHEMA,
    workflow_id: "obsidian-project-memory-audit",
    adapter: "obsidian_audit_registered",
    browser_surface: "none",
    web_operation_contract_binding: null,
    execution_authority: "automation_os_control_plane",
    provider_selectable: false,
    codex_is_not_authority: true,
    default_mode: "preflight_no_effect",
    external_action_default: false,
    provider_adapters: [
      controlPlaneAdapter,
      {
        id: "obsidian-project-memory",
        provider: "obsidian_project_memory",
        capability: "authority_resolution_unresolved_only_audit_and_run_artifact",
        browser_surface: "none",
        required_readback: ["project_authority_readback", "unresolved_only_audit", "cleanup_proof"],
        external_action_allowed: false
      }
    ],
    stages: [
      { id: "project_resolution", kind: "read", effect_class: "internal_idempotent", provider_adapter_ids: ["obsidian-project-memory"], required_proof: ["project_authority_readback"], external_action_allowed: false },
      { id: "audit", kind: "read", effect_class: "internal_idempotent", provider_adapter_ids: ["obsidian-project-memory"], required_proof: ["unresolved_only_audit"], external_action_allowed: false },
      { id: "artifact_write", kind: "effect", effect_class: "internal_idempotent", provider_adapter_ids: ["obsidian-project-memory"], required_proof: ["run_owned_state_artifact"], external_action_allowed: false },
      { id: "git_sync_if_approved", kind: "effect", effect_class: "external_non_idempotent", provider_adapter_ids: ["aos-control-plane"], required_proof: ["approval_binding", "git_readback"], external_action_allowed: false },
      { id: "cleanup", kind: "cleanup", effect_class: "internal_idempotent", provider_adapter_ids: ["aos-control-plane", "obsidian-project-memory"], required_proof: ["automation_kernel_result.v2", "cleanup_proof"], external_action_allowed: false }
    ],
    exact_blockers: ["project_authority_missing", "unresolved_only_audit_failed", "obsidian_write_lock_unavailable", "git_sync_approval_missing"]
  }
];

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function listWorkflowAdapterDefinitions(): WorkflowAdapterDefinition[] {
  return definitions.map(clone);
}

export function getWorkflowAdapterDefinition(workflowId: string): WorkflowAdapterDefinition | undefined {
  const definition = definitions.find((item) => item.workflow_id === workflowId);
  return definition ? clone(definition) : undefined;
}

/**
 * Validate the provider-neutral contract before a workflow can be handed to
 * any provider runner.  This is intentionally structural: it never checks
 * provider credentials and never grants external-effect authority.
 */
export function validateWorkflowAdapterContract(
  definition: WorkflowAdapterDefinition
): WorkflowAdapterContractValidation {
  const errors: string[] = [];
  const providerIds = new Set(definition.provider_adapters.map((provider) => provider.id));
  const stageIds = new Set<string>();

  if (definition.browser_surface !== "browser_use_cli" && definition.browser_surface !== "none") errors.push("browser_surface_not_canonical");
  if (definition.browser_surface === "browser_use_cli") {
    const binding = definition.web_operation_contract_binding;
    if (!binding
      || binding.schema !== WEB_OPERATION_CONTRACT_SCHEMA_V1
      || binding.adaptive_target_resolution !== "live_semantic_candidate_unique_match"
      || binding.fixed_locator_authority !== false
      || binding.fixed_playbook_authority !== false
      || binding.provider_neutral !== true) errors.push("browser_web_operation_contract_binding_invalid");
  } else if (definition.web_operation_contract_binding !== null) {
    errors.push("non_browser_web_operation_contract_binding_present");
  }
  if (definition.execution_authority !== "automation_os_control_plane") errors.push("execution_authority_not_aos");
  if (definition.codex_is_not_authority !== true) errors.push("codex_authority_not_disabled");
  if (definition.default_mode !== "preflight_no_effect") errors.push("default_mode_not_no_effect");
  if (definition.external_action_default !== false) errors.push("external_action_default_enabled");
  if (definition.provider_adapters.some((provider) => provider.external_action_allowed !== false)) {
    errors.push("provider_external_action_enabled");
  }

  for (const stage of definition.stages) {
    if (stageIds.has(stage.id)) errors.push(`duplicate_stage:${stage.id}`);
    stageIds.add(stage.id);
    if (stage.external_action_allowed !== false) errors.push(`stage_external_action_enabled:${stage.id}`);
    if (stage.provider_adapter_ids.some((providerId) => !providerIds.has(providerId))) {
      errors.push(`stage_provider_binding_missing:${stage.id}`);
    }
    if (stage.required_proof.length === 0) errors.push(`stage_required_proof_missing:${stage.id}`);
    if (stage.effect_class === "external_non_idempotent" && !stage.required_proof.includes("approval_binding")) {
      errors.push(`effect_stage_approval_binding_missing:${stage.id}`);
    }
  }

  const cleanup = definition.stages.find((stage) => stage.kind === "cleanup");
  if (!cleanup) errors.push("cleanup_stage_missing");
  else if (!cleanup.required_proof.includes("automation_kernel_result.v2")) errors.push("cleanup_kernel_result_missing");

  const validation: WorkflowAdapterContractValidation = {
    ok: errors.length === 0,
    status: errors.length === 0 ? "ready_for_preflight_no_effect" : "blocked",
    exact_blocker: errors.length === 0 ? null : "workflow_adapter_contract_invalid",
    errors
  };
  return validation;
}

export function workflowAdapterIdForReferenceWorkflow(workflowId: string): WorkflowAdapterWorkflowId | undefined {
  const mapped: Record<string, WorkflowAdapterWorkflowId> = {
    "daily-ai": "daily-ai-research-publish-run",
    "job-application-manager": "job-application-manager",
    nisenprints: "nisenprints-daily-product-canva-printify-etsy-pinterest",
    "email-review": "email-review-reply",
    "daily-backup": "daily-backup-safety-check",
    obsidian: "obsidian-project-memory-audit"
  };
  return mapped[workflowId];
}

export function workflowAdapterReadback(workflowId: string): Record<string, unknown> {
  const definition = getWorkflowAdapterDefinition(workflowId);
  if (!definition) {
    return {
      schema: WORKFLOW_ADAPTER_REGISTRY_SCHEMA,
      workflow_id: workflowId,
      status: "blocked",
      exact_blocker: "workflow_adapter_unknown",
      external_action_allowed: false
    };
  }
  const contract = validateWorkflowAdapterContract(definition);
  return {
    schema: WORKFLOW_ADAPTER_REGISTRY_SCHEMA,
    workflow_id: definition.workflow_id,
    adapter: definition.adapter,
    status: contract.status,
    exact_blocker: contract.exact_blocker,
    contract_validation: contract,
    execution_authority: definition.execution_authority,
    provider_selectable: definition.provider_selectable,
    codex_is_not_authority: definition.codex_is_not_authority,
    default_mode: definition.default_mode,
    web_operation_contract_binding: definition.web_operation_contract_binding
      ? { ...definition.web_operation_contract_binding }
      : null,
    external_action_allowed: false,
    provider_adapters: definition.provider_adapters.map((item) => ({
      id: item.id,
      provider: item.provider,
      capability: item.capability,
      browser_surface: item.browser_surface,
      required_readback: [...item.required_readback],
      external_action_allowed: false
    })),
    provider_adapter_ids: definition.provider_adapters.map((item) => item.id),
    stages: definition.stages.map((item) => ({
      id: item.id,
      kind: item.kind,
      effect_class: item.effect_class,
      provider_adapter_ids: [...item.provider_adapter_ids],
      required_proof: [...item.required_proof],
      approval_required: item.effect_class === "external_non_idempotent",
      external_action_allowed: false
    })),
    stage_ids: definition.stages.map((item) => item.id),
    effect_stage_ids: definition.stages.filter((item) => item.effect_class === "external_non_idempotent").map((item) => item.id),
    live_effects_ready: false,
    exact_blockers: [...definition.exact_blockers]
  };
}

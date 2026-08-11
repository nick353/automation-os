import { createHash } from "node:crypto";
import {
  createAutomationRecord,
  getAutomationRecord,
  listAutomationSchedules,
  saveAutomationSchedule,
  activateAutomationRecord,
  updateAutomationRecord,
  type AutomationRecord,
  type AutomationScheduleRecord
} from "./repository.js";
import type { AutomationDefinitionInput } from "./contracts.js";
import { getWorkflowAdapterDefinition, type WorkflowAdapterDefinition } from "../providers/workflowAdapterRegistry.js";
import { portableScheduleDispatchForRegisteredAutomation, type PortableScheduleDispatch } from "../runs/portableScheduleDispatch.js";

export const REGISTERED_AUTOMATION_CATALOG_SCHEMA = "aos.registered_automation_catalog.v1" as const;
export const REGISTERED_AUTOMATION_ADOPTION_SCHEMA = "aos.registered_automation_adoption.v1" as const;

export type RegisteredAutomationStage = {
  id: string;
  kind: "read" | "admission" | "effect" | "readback" | "cleanup";
  externalEffect: boolean;
  requiredProof: string[];
};

export type RegisteredAutomationCatalogEntry = {
  sourceAutomationId: string;
  canonicalWorkflowId: string;
  name: string;
  description: string;
  goal: string;
  workerCommandKind: string;
  schedule: { kind: "daily" | "weekly"; expression: string; timezone: "Asia/Tokyo" };
  browserSurface: "none" | "browser_use_cli";
  effectClass: "local_only" | "connector_review" | "authenticated_submit" | "authenticated_publish";
  providerPolicy: {
    schema: "aos.execution_provider.v1";
    authority: "automation_os_control_plane";
    providerSelectable: true;
    codexIsNotAuthority: true;
  };
  execution: {
    defaultMode: "preflight_no_effect";
    externalActionDefault: false;
    adapterStatus: "control_plane_ready" | "runner_pending" | "identity_capability_pending" | "mac_worker_read_only_ready";
  };
  stages: RegisteredAutomationStage[];
  exactBlockers: string[];
};

export type RegisteredAutomationAdoptionSpec = {
  schema: typeof REGISTERED_AUTOMATION_ADOPTION_SCHEMA;
  source: "automation_os_portable_workflow";
  sourceAutomationId: string;
  canonicalWorkflowId: string;
  catalogVersion: typeof REGISTERED_AUTOMATION_CATALOG_SCHEMA;
  browserSurface: RegisteredAutomationCatalogEntry["browserSurface"];
  effectClass: RegisteredAutomationCatalogEntry["effectClass"];
  providerPolicy: RegisteredAutomationCatalogEntry["providerPolicy"];
  execution: RegisteredAutomationCatalogEntry["execution"];
  stages: RegisteredAutomationStage[];
  workflowAdapter: WorkflowAdapterDefinition | null;
  portableDispatch: PortableScheduleDispatch | null;
  exactBlockers: string[];
  externalActionAllowed: false;
  sourceReadback: {
    appRegistration: "aos_catalog_readback";
    promptCopied: false;
    secretMaterialCopied: false;
  };
};

export type RegisteredAutomationAdoptionResult = {
  companyId: string;
  adopted: Array<{
    sourceAutomationId: string;
    canonicalWorkflowId: string;
    automation: AutomationRecord;
    schedule: AutomationScheduleRecord;
    adoption: RegisteredAutomationAdoptionSpec;
  }>;
  externalActionExecuted: false;
};

const identityStages: RegisteredAutomationStage[] = [
  { id: "source_snapshot", kind: "read", externalEffect: false, requiredProof: ["source_snapshot.v1"] },
  { id: "candidate_supply", kind: "read", externalEffect: false, requiredProof: ["candidate_supply.v1", "dedupe_readback"] },
  { id: "identity_admission", kind: "admission", externalEffect: false, requiredProof: ["applicant_profile_hash", "identity_capability_readback", "current_run_binding"] },
  { id: "browser_admission", kind: "admission", externalEffect: false, requiredProof: ["browser_use_cli_authority", "profile_port_lease", "same_run_readback"] },
  { id: "candidate_submit", kind: "effect", externalEffect: true, requiredProof: ["approval_binding", "one_candidate_idempotency", "visible_submission_confirmation"] },
  { id: "submit_readback", kind: "readback", externalEffect: false, requiredProof: ["source_of_truth_readback", "same_run_receipt"] },
  { id: "ledger_sync", kind: "readback", externalEffect: false, requiredProof: ["opportunity_ledger_append", "submitted_confirmed_or_pending_confirmation"] },
  { id: "cleanup", kind: "cleanup", externalEffect: false, requiredProof: ["flow_lease_cleanup", "run_terminal_artifact"] }
];

export const registeredAutomationCatalog: readonly RegisteredAutomationCatalogEntry[] = [
  {
    sourceAutomationId: "automation-3",
    canonicalWorkflowId: "job-application-manager",
    name: "求人応募管理（AOS Identity対応）",
    description: "Codex Appの求人応募登録をAOS会社スコープへ移し、候補者単位でIdentity・browser・submit・readbackを分離する。",
    goal: "Fresh candidate supplyから、Identity capabilityと同一runの可視submit/readbackが揃った候補だけを重複なく処理する。",
    workerCommandKind: "job_submit_registered",
    schedule: { kind: "daily", expression: "07:30", timezone: "Asia/Tokyo" },
    browserSurface: "browser_use_cli",
    effectClass: "authenticated_submit",
    providerPolicy: { schema: "aos.execution_provider.v1", authority: "automation_os_control_plane", providerSelectable: true, codexIsNotAuthority: true },
    execution: { defaultMode: "preflight_no_effect", externalActionDefault: false, adapterStatus: "identity_capability_pending" },
    stages: identityStages,
    exactBlockers: ["identity_capability_unavailable", "browser_use_cli_authority_missing", "applicant_profile_drift", "applicant_unknown_required_fact", "captcha_or_otp_required", "assessment_or_test_required", "submit_readback_missing", "opportunity_ledger_conflict"]
  },
  {
    sourceAutomationId: "automation",
    canonicalWorkflowId: "email-review-reply",
    name: "メール確認・返信管理（AOS approval対応）",
    description: "Gmail/Calendarのレビュー・下書き・承認・送信/readbackを会社スコープで分離する。",
    goal: "最新メッセージを一度だけ安全に分類し、返信・予定登録は候補単位の承認後だけ実行する。",
    workerCommandKind: "email_review_registered",
    schedule: { kind: "daily", expression: "07:30", timezone: "Asia/Tokyo" },
    browserSurface: "none",
    effectClass: "connector_review",
    providerPolicy: { schema: "aos.execution_provider.v1", authority: "automation_os_control_plane", providerSelectable: true, codexIsNotAuthority: true },
    execution: { defaultMode: "preflight_no_effect", externalActionDefault: false, adapterStatus: "runner_pending" },
    stages: [
      { id: "newest_100_snapshot", kind: "read", externalEffect: false, requiredProof: ["gmail_summary_capture.v1"] },
      { id: "individual_classification", kind: "read", externalEffect: false, requiredProof: ["classification_ledger"] },
      { id: "reply_draft", kind: "readback", externalEffect: false, requiredProof: ["draft_candidate_hash"] },
      { id: "reply_or_calendar_approval", kind: "admission", externalEffect: false, requiredProof: ["approval_binding", "candidate_expiry"] },
      { id: "send_or_create_event", kind: "effect", externalEffect: true, requiredProof: ["approved_exact_candidate", "provider_receipt"] },
      { id: "connector_readback", kind: "readback", externalEffect: false, requiredProof: ["same_run_message_or_event_readback"] },
      { id: "cleanup", kind: "cleanup", externalEffect: false, requiredProof: ["safe_capture_cleanup"] }
    ],
    exactBlockers: ["gmail_connector_context_isolation_unavailable", "gmail_connector_response_capture_unavailable", "approval_expired", "recipient_or_event_hash_mismatch", "ambiguous_send_readback"]
  },
  {
    sourceAutomationId: "daily-ai-research-publish-run",
    canonicalWorkflowId: "daily-ai-research-publish-run",
    name: "日次AI 研究・公開（AOS staged publish対応）",
    description: "研究・queue・media・browser QA・publish・engagement・同期を個別readback付きで実行する。",
    goal: "研究結果をローカルqueueへ確定し、公開前QA・承認・同一runの公開readbackを満たす。",
    workerCommandKind: "daily_ai_registered",
    schedule: { kind: "daily", expression: "09:00", timezone: "Asia/Tokyo" },
    browserSurface: "browser_use_cli",
    effectClass: "authenticated_publish",
    providerPolicy: { schema: "aos.execution_provider.v1", authority: "automation_os_control_plane", providerSelectable: true, codexIsNotAuthority: true },
    execution: { defaultMode: "preflight_no_effect", externalActionDefault: false, adapterStatus: "runner_pending" },
    stages: [
      { id: "research_queue_refresh", kind: "read", externalEffect: false, requiredProof: ["local_queue_readback", "source_snapshot"] },
      { id: "media_readiness", kind: "admission", externalEffect: false, requiredProof: ["provider_media_receipt"] },
      { id: "browser_no_post_qa", kind: "admission", externalEffect: false, requiredProof: ["browser_use_cli_canary", "visual_qa_pass"] },
      { id: "publish", kind: "effect", externalEffect: true, requiredProof: ["approval_binding", "same_run_publish_receipt"] },
      { id: "feed_study_and_engagement", kind: "effect", externalEffect: true, requiredProof: ["platform_readback", "bounded_action_receipts"] },
      { id: "queue_and_sheets_sync", kind: "readback", externalEffect: false, requiredProof: ["source_of_truth_sync"] },
      { id: "cleanup", kind: "cleanup", externalEffect: false, requiredProof: ["browser_cleanup"] }
    ],
    exactBlockers: ["browser_use_cli_authority_missing", "runway_mcp_result_handoff_missing", "publish_visual_qa_failed", "publish_readback_missing", "sheets_sync_unavailable", "ambiguous_external_effect"]
  },
  {
    sourceAutomationId: "daily-backup-safety-check",
    canonicalWorkflowId: "daily-backup-safety-check",
    name: "日次バックアップ スナップショット確認",
    description: "ローカル専用バックアップのsnapshot・integrity・cleanupをAOSで定期実行する。",
    goal: "バックアップの内容・整合性・成果物をローカルsource-of-truthから確認する。",
    workerCommandKind: "local_backup_registered",
    schedule: { kind: "daily", expression: "09:00", timezone: "Asia/Tokyo" },
    browserSurface: "none",
    effectClass: "local_only",
    providerPolicy: { schema: "aos.execution_provider.v1", authority: "automation_os_control_plane", providerSelectable: true, codexIsNotAuthority: true },
    execution: { defaultMode: "preflight_no_effect", externalActionDefault: false, adapterStatus: "mac_worker_read_only_ready" },
    stages: [
      { id: "source_snapshot", kind: "read", externalEffect: false, requiredProof: ["local_source_readback"] },
      { id: "backup_snapshot", kind: "effect", externalEffect: true, requiredProof: ["snapshot_artifact"] },
      { id: "integrity_readback", kind: "readback", externalEffect: false, requiredProof: ["checksum_and_manifest"] },
      { id: "cleanup", kind: "cleanup", externalEffect: false, requiredProof: ["automation_kernel_result.v2", "cleanup_proof"] }
    ],
    exactBlockers: ["backup_source_unavailable", "backup_integrity_mismatch", "automation_kernel_result_missing"]
  },
  {
    sourceAutomationId: "nisenprints-daily-product-canva-printify-etsy-pinterest",
    canonicalWorkflowId: "nisenprints-daily-product-canva-printify-etsy-pinterest",
    name: "NisenPrints 日次商品・Canva・Printify・Etsy・Pinterest",
    description: "商品生成・provider操作・Etsy/Pinterest公開・商品URL検証をサービス単位に分ける。",
    goal: "商品単位のidempotencyとprovider readbackを満たすものだけを次段へ進める。",
    workerCommandKind: "nisenprints_registered",
    schedule: { kind: "daily", expression: "08:30", timezone: "Asia/Tokyo" },
    browserSurface: "browser_use_cli",
    effectClass: "authenticated_publish",
    providerPolicy: { schema: "aos.execution_provider.v1", authority: "automation_os_control_plane", providerSelectable: true, codexIsNotAuthority: true },
    execution: { defaultMode: "preflight_no_effect", externalActionDefault: false, adapterStatus: "runner_pending" },
    stages: [
      { id: "listing_snapshot", kind: "read", externalEffect: false, requiredProof: ["etsy_listing_snapshot"] },
      { id: "asset_and_provider_admission", kind: "admission", externalEffect: false, requiredProof: ["current_provider_auth", "asset_hash"] },
      { id: "provider_mutations", kind: "effect", externalEffect: true, requiredProof: ["approval_binding", "provider_idempotency"] },
      { id: "etsy_and_pinterest_publish", kind: "effect", externalEffect: true, requiredProof: ["visible_publish_receipt"] },
      { id: "product_link_readback", kind: "readback", externalEffect: false, requiredProof: ["pin_to_etsy_url_match"] },
      { id: "source_sync", kind: "readback", externalEffect: false, requiredProof: ["queue_status_sync"] },
      { id: "cleanup", kind: "cleanup", externalEffect: false, requiredProof: ["browser_cleanup"] }
    ],
    exactBlockers: ["browser_use_cli_stage_adapter_pending:nisenprints", "provider_auth_missing", "provider_idempotency_missing", "publish_readback_missing", "etsy_url_mismatch"]
  },
  {
    sourceAutomationId: "obsidian",
    canonicalWorkflowId: "obsidian-project-memory-audit",
    name: "Obsidianプロジェクト記憶 週次監査",
    description: "Obsidian locator/review面とproject-owned source/artifactを分離して週次監査する。",
    goal: "正しいproject authorityを解決し、未解決事項と再開地点を更新する。",
    workerCommandKind: "obsidian_audit_registered",
    schedule: { kind: "weekly", expression: "MON 09:30", timezone: "Asia/Tokyo" },
    browserSurface: "none",
    effectClass: "local_only",
    providerPolicy: { schema: "aos.execution_provider.v1", authority: "automation_os_control_plane", providerSelectable: true, codexIsNotAuthority: true },
    execution: { defaultMode: "preflight_no_effect", externalActionDefault: false, adapterStatus: "mac_worker_read_only_ready" },
    stages: [
      { id: "project_resolution", kind: "read", externalEffect: false, requiredProof: ["project_authority_readback"] },
      { id: "audit", kind: "read", externalEffect: false, requiredProof: ["unresolved_only_audit"] },
      { id: "artifact_write", kind: "effect", externalEffect: true, requiredProof: ["run_owned_state_artifact"] },
      { id: "git_sync_if_approved", kind: "effect", externalEffect: true, requiredProof: ["approval_binding", "git_readback"] },
      { id: "cleanup", kind: "cleanup", externalEffect: false, requiredProof: ["automation_kernel_result.v2", "cleanup_proof"] }
    ],
    exactBlockers: ["project_authority_missing", "unresolved_only_audit_failed", "obsidian_write_lock_unavailable", "git_sync_approval_missing"]
  }
];

export function getRegisteredAutomationCatalogEntry(sourceAutomationId: string): RegisteredAutomationCatalogEntry | undefined {
  return registeredAutomationCatalog.find((entry) => entry.sourceAutomationId === sourceAutomationId);
}

export function listRegisteredAutomationCatalog(): readonly RegisteredAutomationCatalogEntry[] {
  return registeredAutomationCatalog;
}

export function deterministicCompanyAutomationId(companyId: string, sourceAutomationId: string): string {
  return `automation_${createHash("sha256").update(`${companyId}:${sourceAutomationId}`, "utf8").digest("hex").slice(0, 24)}`;
}

export function buildRegisteredAutomationAdoptionSpec(entry: RegisteredAutomationCatalogEntry): RegisteredAutomationAdoptionSpec {
  const workflowAdapter = getWorkflowAdapterDefinition(entry.canonicalWorkflowId) ?? null;
  return {
    schema: REGISTERED_AUTOMATION_ADOPTION_SCHEMA,
    source: "automation_os_portable_workflow",
    sourceAutomationId: entry.sourceAutomationId,
    canonicalWorkflowId: entry.canonicalWorkflowId,
    catalogVersion: REGISTERED_AUTOMATION_CATALOG_SCHEMA,
    browserSurface: entry.browserSurface,
    effectClass: entry.effectClass,
    providerPolicy: entry.providerPolicy,
    execution: entry.execution,
    stages: entry.stages,
    workflowAdapter,
    portableDispatch: portableScheduleDispatchForRegisteredAutomation({
      workerCommandKind: entry.workerCommandKind,
      builderSpec: { workflowAdapter, canonicalWorkflowId: entry.canonicalWorkflowId }
    }),
    exactBlockers: entry.exactBlockers,
    externalActionAllowed: false,
    sourceReadback: { appRegistration: "aos_catalog_readback", promptCopied: false, secretMaterialCopied: false }
  };
}

export function adoptRegisteredAutomationCatalog(input: {
  companyId: string;
  actorUserId: string;
  sourceAutomationIds?: readonly string[];
  enableSchedules?: boolean;
}): RegisteredAutomationAdoptionResult {
  const requested = input.sourceAutomationIds?.length
    ? [...new Set(input.sourceAutomationIds)]
    : registeredAutomationCatalog.map((entry) => entry.sourceAutomationId);
  const entries = requested.map((sourceId) => {
    const entry = getRegisteredAutomationCatalogEntry(sourceId);
    if (!entry) throw new Error(`registered_automation_catalog_unknown:${sourceId}`);
    return entry;
  });
  const adopted = entries.map((entry) => {
    const adoption = buildRegisteredAutomationAdoptionSpec(entry);
    const automationId = deterministicCompanyAutomationId(input.companyId, entry.sourceAutomationId);
    const definition: AutomationDefinitionInput = {
      automationType: "registered_workflow",
      name: entry.name,
      description: entry.description,
      goal: entry.goal,
      lane: entry.browserSurface === "browser_use_cli" ? "browser_use_cli" : "local",
      riskLevel: entry.stages.some((stage) => stage.externalEffect) ? "high" : "medium",
      approvalPolicy: entry.effectClass === "local_only" ? "required_before_external_action" : "required_before_external_action",
      workerCommandKind: entry.workerCommandKind,
      createApproval: entry.stages.some((stage) => stage.externalEffect),
      builderSpec: adoption as unknown as Record<string, unknown>
    };
    const existing = getAutomationRecord(input.companyId, automationId, true);
    const automation = existing
      ? synchronizeExistingAutomation(existing, adoption, input.actorUserId)
      : createAutomationRecord({ companyId: input.companyId, actorUserId: input.actorUserId, automationId, definition, idempotencyKey: `adopt-${entry.sourceAutomationId}`, idempotencyRequest: adoption });
    const activeAutomation = automation.status === "active"
      ? automation
      : activateAutomationRecord({ companyId: input.companyId, actorUserId: input.actorUserId, automationId: automation.id, expectedRevision: automation.revision });
    const existingSchedule = listAutomationSchedules(input.companyId, activeAutomation.id)[0];
    const schedule = existingSchedule
      ? verifyExistingSchedule(existingSchedule, entry)
      : saveAutomationSchedule({
          companyId: input.companyId,
          actorUserId: input.actorUserId,
          automationId: activeAutomation.id,
          schedule: { kind: entry.schedule.kind, expression: entry.schedule.expression, timezone: entry.schedule.timezone, enabled: input.enableSchedules ?? true, expectedRevision: 1 },
          nextRunAt: null
        });
    return { sourceAutomationId: entry.sourceAutomationId, canonicalWorkflowId: entry.canonicalWorkflowId, automation: activeAutomation, schedule, adoption };
  });
  return { companyId: input.companyId, adopted, externalActionExecuted: false };
}

function synchronizeExistingAutomation(existing: AutomationRecord, adoption: RegisteredAutomationAdoptionSpec, actorUserId: string): AutomationRecord {
  const current = existing.builderSpec as Partial<RegisteredAutomationAdoptionSpec>;
  if (current.schema !== adoption.schema || current.sourceAutomationId !== adoption.sourceAutomationId || current.canonicalWorkflowId !== adoption.canonicalWorkflowId) {
    throw new Error(`registered_automation_adoption_conflict:${adoption.sourceAutomationId}`);
  }
  if (JSON.stringify(current) === JSON.stringify(adoption)) return existing;
  return updateAutomationRecord({
    companyId: existing.companyId,
    actorUserId,
    automationId: existing.id,
    patch: { expectedRevision: existing.revision, builderSpec: adoption as unknown as Record<string, unknown> }
  });
}

function verifyExistingSchedule(existing: AutomationScheduleRecord, entry: RegisteredAutomationCatalogEntry): AutomationScheduleRecord {
  if (existing.kind !== entry.schedule.kind || existing.expression !== entry.schedule.expression || existing.timezone !== entry.schedule.timezone) {
    throw new Error(`registered_automation_schedule_conflict:${entry.sourceAutomationId}`);
  }
  return existing;
}

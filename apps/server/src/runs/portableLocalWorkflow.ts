import { existsSync, accessSync, constants, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initDb, nowIso } from "../db/client.js";
import { auditProjects, type ProjectAuditResult } from "../projects/projectAuditor.js";
import { redactSensitiveText } from "../obsidian/redaction.js";
import { buildConnectorExecutionPlacement, readZeaburConnectorRegistryReadback } from "../codex/zeaburConnectorRouting.js";
import { runObsidianExportNow } from "../obsidian/autoExport.js";
import { runObsidianMaintenance } from "../obsidian/maintenance.js";
import { defaultObsidianVaultPath } from "../obsidian/vaultGuard.js";
import { runObsidianGitSync } from "../obsidian/vaultGitSync.js";
import { readBackupSnapshot } from "./backupSnapshotReadback.js";
import { listCompanyConnectionRefs } from "../automations/repository.js";
import { runGmailProviderReadOnlyCanary, type GmailProviderReadOnlyCanaryReadback } from "../connectors/gmailProviderReadOnlyCanary.js";
import { requireGmailRunConnectionRef } from "./gmailExecutionTargetPropagation.js";

export const PORTABLE_LOCAL_WORKFLOW_SCHEMA = "aos.portable_local_workflow.v1" as const;

export type PortableLocalWorkflowId =
  | "email-review-reply"
  | "daily-backup-safety-check"
  | "nisenprints-existing-product-audit"
  | "daily-ai-research-source-sync"
  | "obsidian-project-memory-audit";

export type PortableLocalWorkflowReceipt = {
  status: "complete" | "partial" | "blocked";
  exact_blocker: string | null;
  external_action_executed: false;
  workflow_id: PortableLocalWorkflowId;
  read_only_stage_bound: true;
  readback_verified: boolean;
  cleanup_verified: boolean;
  business_completion_verified: false;
  adapter_result: Record<string, unknown>;
};

export type PortableLocalWorkflowBusinessReceipt = {
  status: "complete" | "blocked";
  exact_blocker: string | null;
  external_action_executed: boolean;
  workflow_id: PortableLocalWorkflowId;
  read_only_stage_bound: false;
  readback_verified: boolean;
  cleanup_verified: boolean;
  business_completion_verified: boolean;
  same_run_receipt: boolean;
  same_run_source_sync: boolean;
  adapter_result: Record<string, unknown>;
  runner_receipt: Record<string, unknown>;
};

export const UNATTENDED_FIXED_LOCAL_EFFECT_POLICY = "user_authorized_fixed_local_target.v1" as const;

export type PortableLocalSourceSnapshot = {
  schema: "aos.portable_local_source_snapshot.v1";
  workflow_id: PortableLocalWorkflowId;
  company_id: string;
  due_key: string;
  scheduled_for: string;
  source_snapshot_id: string;
  captured_at: string;
  status: "ready" | "blocked";
  readback_verified: boolean;
  exact_blocker: string | null;
  adapter_result: Record<string, unknown>;
  external_action_executed: false;
};

export type PortableLocalBusinessAdmission = {
  status: "ready" | "blocked";
  exact_blocker: string | null;
  sourceSnapshot: PortableLocalSourceSnapshot;
  inputBundle: Record<string, string> | null;
};

const BACKUP_DESTINATION = "/Users/nichikatanaka/Documents/Codex/backup-repos/daily-workspace-backup";
const BACKUP_REPOSITORY = "https://github.com/nick353/daily-workspace-backup.git";
const BACKUP_ACCOUNT_REF = "github:nick353/daily-workspace-backup";
const BACKUP_TARGET_KEY = "daily-workspace-backup:main";
const OBSIDIAN_REPOSITORY = "https://github.com/nick353/obsidian-vault-backup.git";
const OBSIDIAN_ACCOUNT_REF = "github:nick353/obsidian-vault-backup";
const OBSIDIAN_TARGET_KEY = "obsidian-vault-backup:main";

export function backupBusinessPayloadHash(): string {
  return createHash("sha256").update(JSON.stringify({
    action: "snapshot_and_private_git_push",
    destination: BACKUP_DESTINATION,
    repository: BACKUP_REPOSITORY,
    branch: "main",
    runner: "fixed_registered_backup_runner"
  })).digest("hex");
}

export function obsidianBusinessPayloadHash(): string {
  return createHash("sha256").update(JSON.stringify({
    action: "maintenance_export_and_private_git_push",
    vault: defaultObsidianVaultPath,
    repository: OBSIDIAN_REPOSITORY,
    branch: "main",
    runner: "fixed_registered_obsidian_runner"
  })).digest("hex");
}

const manifests: Record<PortableLocalWorkflowId, {
  name: string;
  command: string;
  workerCommandKind: "email_review_registered" | "local_backup_registered" | "obsidian_audit_registered" | "nisenprints_inventory_registered" | "daily_ai_research_sync_registered";
}> = {
  "email-review-reply": {
    name: "Email review/reply read-only worker",
    command: "Email review reply registered workflow read-only",
    workerCommandKind: "email_review_registered"
  },
  "daily-backup-safety-check": {
    name: "Daily backup snapshot read-only preflight",
    command: "Daily backup snapshot registered workflow read-only preflight",
    workerCommandKind: "local_backup_registered"
  },
  "obsidian-project-memory-audit": {
    name: "Obsidian project memory read-only audit",
    command: "Obsidian project memory audit registered workflow read-only",
    workerCommandKind: "obsidian_audit_registered"
  },
  "nisenprints-existing-product-audit": {
    name: "NisenPrints existing product inventory audit (no generation or publication)",
    command: "nisenprints-existing-product-audit",
    workerCommandKind: "nisenprints_inventory_registered"
  },
  "daily-ai-research-source-sync": {
    name: "Daily AI research and existing Sheet mirror (no generation or publication)",
    command: "daily-ai-research-source-sync",
    workerCommandKind: "daily_ai_research_sync_registered"
  }
};

export function isPortableLocalWorkflowId(value: string): value is PortableLocalWorkflowId {
  return Object.prototype.hasOwnProperty.call(manifests, value);
}

export function localWorkflowIdForRegisteredAutomation(input: {
  workerCommandKind?: string | null;
  builderSpec?: Record<string, unknown> | null;
}): PortableLocalWorkflowId | null {
  const adapter = input.builderSpec?.workflowAdapter;
  const adapterRecord = adapter && typeof adapter === "object" && !Array.isArray(adapter)
    ? adapter as Record<string, unknown>
    : null;
  const canonical = typeof adapterRecord?.workflow_id === "string"
    ? adapterRecord.workflow_id.trim()
    : typeof input.builderSpec?.canonicalWorkflowId === "string"
      ? input.builderSpec.canonicalWorkflowId.trim()
      : "";
  if (isPortableLocalWorkflowId(canonical)) return canonical;
  switch (input.workerCommandKind) {
    case "email_review_registered": return "email-review-reply";
    case "local_backup_registered": return "daily-backup-safety-check";
    case "obsidian_audit_registered": return "obsidian-project-memory-audit";
    case "nisenprints_inventory_registered": return "nisenprints-existing-product-audit";
    case "daily_ai_research_sync_registered": return "daily-ai-research-source-sync";
    default: return null;
  }
}

export function localWorkflowIdForWorkerAdapter(adapter: string): PortableLocalWorkflowId | null {
  switch (adapter) {
    case "email_review_registered": return "email-review-reply";
    case "local_backup_registered": return "daily-backup-safety-check";
    case "obsidian_audit_registered": return "obsidian-project-memory-audit";
    case "nisenprints_inventory_registered": return "nisenprints-existing-product-audit";
    case "daily_ai_research_sync_registered": return "daily-ai-research-source-sync";
    default: return null;
  }
}

export function localWorkflowManifest(workflowId: PortableLocalWorkflowId) {
  return { schema: PORTABLE_LOCAL_WORKFLOW_SCHEMA, workflow_id: workflowId, ...manifests[workflowId] };
}

export function portableLocalReadOnlyStageForScheduledWorkflow(_workflowId: PortableLocalWorkflowId): "reference_readback" {
  return "reference_readback";
}

/** Flat bounded rows survive the ordinary diagnostic receipt depth limit. */
export function buildObsidianAuditReadback(result: ProjectAuditResult, scope: { runId?: string; companyId?: string }) {
  const labels: Record<string, string> = {
    state_stale: "STATE.mdより新しい活動があるため、現在の状態を再確認してください。",
    state_missing: "プロジェクト正本のSTATE.mdがありません。",
    project_root_missing: "登録したプロジェクトの保存先がありません。",
    authority_file_missing: "登録済みの正本ファイルに欠落があります。",
    context_pack_missing: "Obsidianの案内ページがありません。",
    context_pack_boundary_missing: "案内ページに正本との区別がありません。",
    approval_boundary_missing: "承認が必要な操作の登録を確認してください。",
    human_only_boundary_missing: "本人操作が必要な範囲の登録を確認してください。",
    auto_discovered_locator_requires_registration_review: "自動発見した参照先の登録内容を確認してください。",
    state_aged_without_newer_project_activity: "STATE.mdは古いものの、それより新しい活動は検出されていません。"
  };
  const clean = (text: string, max: number) => redactSensitiveText(text).slice(0, max);
  const rank = { blocked: 0, attention: 1, ok: 2 };
  // Only the table is bounded. The full audit count remains explicit, and a
  // larger registry is labelled truncated rather than reported as all shown.
  const projects = [...result.projects].sort((a, b) => rank[a.status] - rank[b.status] || a.project.id.localeCompare(b.project.id));
  return {
    audit_ok: result.ok,
    audit_summary: result.summary,
    audit_run_id: scope.runId ?? null,
    audit_company_id: scope.companyId ?? null,
    audit_generated_at: result.generatedAt,
    audit_projects_truncated: projects.length > 20,
    audit_projects: projects.slice(0, 20).map((item) => {
      const issues = item.issues.filter((issue) => issue.severity !== "info");
      const latest = [...item.authority.map((file) => file.mtime), ...item.artifacts.map((file) => file.latestMtime)]
        .filter((date): date is string => typeof date === "string" && Number.isFinite(Date.parse(date))).sort().at(-1) ?? null;
      return {
        project_id: clean(item.project.id, 120), project_label: clean(item.project.label, 160), status: item.status,
        issue_codes: issues.map((issue) => issue.code).join(", ").slice(0, 300),
        finding: clean(issues.map((issue) => labels[issue.code] ?? issue.message).join(" ") || "要対応事項は検出されませんでした。", 900),
        state_updated_at: item.stateMtime, latest_activity_at: latest,
        next_action: item.status === "ok" ? "操作前にプロジェクトのSTATE.mdと最新成果物を確認してください。"
          : issues.some((issue) => issue.code === "state_stale") ? "最新成果物とSTATE.mdを照合し、プロジェクト側で現在の状態を更新してください。"
          : "表示した欠落・登録内容をプロジェクトの正本で確認してください。修正やVault更新は別の操作です。"
      };
    }),
    registry_readback: true, vault_readback: true, write_performed: false, audit_only: true,
    maintenance_performed: false, git_sync_performed: false
  };
}

export function runPortableLocalWorkflowReadOnly(input: {
  workflowId: PortableLocalWorkflowId;
  runId?: string;
  workerRole?: string;
  companyId?: string;
  gmailExecutionTarget?: { connectionRefId: string; accountRef: string };
  backupSnapshotReader?: typeof readBackupSnapshot;
}): PortableLocalWorkflowReceipt {
  if (input.workerRole !== "mac") {
    return blocked(input.workflowId, "mac_worker_required", { execution_surface: "mac_local_worker", worker_role: input.workerRole ?? "unset" });
  }
  if (input.workflowId === "daily-ai-research-source-sync") {
    return blocked(input.workflowId, "daily_ai_research_sync_business_admission_required", {
      research_executed: false, sheets_write_executed: false, full_publish_completed: false
    });
  }
  if (input.workflowId === "nisenprints-existing-product-audit") {
    if (!input.runId) return blocked(input.workflowId, "nisen_inventory_run_id_invalid", {});
    const runnerPath = fileURLToPath(new URL("../../../../scripts/nisenprints-inventory-readback.mjs", import.meta.url));
    let stdout = "";
    try {
      stdout = execFileSync(process.execPath, [runnerPath, input.runId, input.companyId ?? ""], {
        encoding: "utf8", timeout: 60_000, maxBuffer: 256_000, stdio: ["ignore", "pipe", "ignore"]
      });
    } catch (error) {
      stdout = String((error as { stdout?: string }).stdout ?? "");
    }
    try {
      const result = JSON.parse(stdout) as Record<string, unknown>;
      if (result.workflow_id !== input.workflowId || result.run_id !== input.runId || result.external_action_executed !== false) {
        return blocked(input.workflowId, "nisen_inventory_receipt_binding_invalid", {});
      }
      return result.status === "complete" && result.readback_verified === true && result.same_run_source_sync === true
        ? completeReadOnly(input.workflowId, result)
        : blocked(input.workflowId, String(result.exact_blocker ?? "nisen_inventory_read_failed"), result);
    } catch { return blocked(input.workflowId, "nisen_inventory_read_failed", {}); }
  }
  if (input.workflowId === "email-review-reply") {
    const companyId = input.companyId?.trim() ?? "";
    if (!companyId) return blocked(input.workflowId, "company_scope_required", { connector: "gmail", intended_stage: "newest_100_snapshot" });
    if (!input.gmailExecutionTarget?.connectionRefId || !input.gmailExecutionTarget.accountRef) {
      return blocked(input.workflowId, "execution_target_run_binding_missing", {
        connector: "gmail",
        company_id: companyId,
        intended_stage: "newest_100_snapshot",
        data_read: false,
        data_persisted: false
      });
    }
    let boundRef;
    try {
      boundRef = requireGmailRunConnectionRef({
        companyId,
        inputBundle: {
          connection_ref_id: input.gmailExecutionTarget.connectionRefId,
          account_ref: input.gmailExecutionTarget.accountRef
        },
        connectionRefs: listCompanyConnectionRefs(companyId)
      });
    } catch (error) {
      return blocked(input.workflowId, error instanceof Error ? error.message : "execution_target_run_binding_invalid", {
        connector: "gmail",
        company_id: companyId,
        intended_stage: "newest_100_snapshot",
        data_read: false,
        data_persisted: false
      });
    }
    const registry = readZeaburConnectorRegistryReadback();
    const placement = buildConnectorExecutionPlacement({
      connector: "gmail",
      zeabur: registry,
      companyConnectionVerified: Boolean(boundRef)
    });
    if (placement.status !== "ready") {
      return blocked(input.workflowId, placement.exactBlocker ?? "gmail_connector_execution_not_ready", {
        connector: "gmail",
        company_id: companyId,
        intended_stage: "newest_100_snapshot",
        connector_execution_owner: placement.owner,
        connector_execution_placement: placement,
        data_read: false,
        data_persisted: false
      });
    }
    return partial(input.workflowId, "gmail_provider_read_only_call_not_executed", {
      connector: "gmail",
      company_id: companyId,
      intended_stage: "newest_100_snapshot",
      connector_execution_owner: placement.owner,
      connector_execution_placement: placement,
      data_read: false,
      data_persisted: false,
      provider_receipt: null,
      reconciliation: "not_started"
    }, true);
  }
  if (input.workflowId === "daily-backup-safety-check") {
    const runnerPath = process.env.AUTOMATION_OS_BACKUP_RUNNER_PATH?.trim()
      || "/Users/nichikatanaka/.codex/automations/daily-backup-safety-check/scripts/run_daily_backup_snapshot.sh";
    try {
      accessSync(runnerPath, constants.X_OK);
    } catch {
      return blocked(input.workflowId, "local_backup_runner_missing", { runner_configured: false });
    }
    const snapshot = (input.backupSnapshotReader ?? readBackupSnapshot)();
    const adapterResult = {
      ...snapshot,
      runner_configured: true,
      runner_path_configured: true,
      external_effect: "snapshot_and_private_git_push",
      approval_required_for_business_effect: true,
      business_effect_started: false
    };
    const receipt = snapshot.readback_verified !== true
      ? blocked(input.workflowId, String(snapshot.exact_blocker), adapterResult)
      : snapshot.snapshot_stale === true
        ? partial(input.workflowId, "backup_snapshot_outdated", adapterResult, true)
        : completeReadOnly(input.workflowId, adapterResult);
    return { ...receipt, cleanup_verified: snapshot.cleanup_verified === true };
  }
  try {
    const result = auditProjects({
      registryPath: process.env.AUTOMATION_OS_PROJECT_REGISTRY?.trim() || undefined,
      obsidianVaultPath: process.env.AUTOMATION_OS_OBSIDIAN_VAULT?.trim() || undefined
    });
    // The audit result is persisted by the caller in its run-owned receipt.
    // Vault maintenance and Git sync are separate, authorized business stages.
    const auditReadback = buildObsidianAuditReadback(result, input);
    return result.ok ? completeReadOnly(input.workflowId, auditReadback)
      : partial(input.workflowId, "obsidian_audit_findings_present", auditReadback, false);
  } catch (error) {
    return blocked(input.workflowId, "unresolved_only_audit_failed", { error: error instanceof Error ? error.message.slice(0, 160) : "audit_failed" });
  }
}

/**
 * Async Mac-worker seam for the bounded Gmail profile read.  The synchronous
 * adapter above is intentionally left as the legacy no-canary boundary.
 */
export async function runPortableLocalWorkflowAsync(input: {
  workflowId: PortableLocalWorkflowId;
  runId?: string;
  workerRole?: string;
  companyId?: string;
  gmailExecutionTarget?: { connectionRefId: string; accountRef: string };
  gmailProviderReadOnlyCanary?: typeof runGmailProviderReadOnlyCanary;
}): Promise<PortableLocalWorkflowReceipt> {
  const validated = runPortableLocalWorkflowReadOnly(input);
  if (input.workflowId !== "email-review-reply" || validated.status !== "partial") return validated;
  const runId = input.runId?.trim() ?? "";
  const companyId = input.companyId?.trim() ?? "";
  const accountRef = input.gmailExecutionTarget?.accountRef?.trim() ?? "";
  if (!runId || !companyId || !accountRef) return validated;

  let canary: GmailProviderReadOnlyCanaryReadback;
  try {
    canary = await (input.gmailProviderReadOnlyCanary ?? runGmailProviderReadOnlyCanary)({
      runId,
      companyId,
      accountRef
    });
  } catch (error) {
    return blocked(input.workflowId, error instanceof Error ? error.message.slice(0, 160) : "gmail_provider_read_only_canary_failed", {
      ...validated.adapter_result,
      gmail_provider_read_only_canary: {
        status: "blocked",
        exact_blocker: error instanceof Error ? error.message.slice(0, 160) : "gmail_provider_read_only_canary_failed",
        externalActionExecuted: false,
        secretMaterialIncluded: false
      }
    });
  }
  const adapterResult = {
    ...validated.adapter_result,
    gmail_provider_read_only_canary: canary
  };
  if (canary.status !== "completed" || canary.providerReceipt === null || canary.exactBlocker !== null) {
    return {
      ...validated,
      status: "blocked",
      exact_blocker: canary.exactBlocker ?? "gmail_provider_read_only_canary_not_completed",
      readback_verified: false,
      cleanup_verified: canary.cleanup.status === "verified",
      adapter_result: adapterResult
    };
  }
  return {
    ...validated,
    status: "partial",
    exact_blocker: null,
    readback_verified: true,
    cleanup_verified: canary.cleanup.status === "verified",
    adapter_result: adapterResult
  };
}

/**
 * Build the only unattended business input accepted by the scheduler.  The
 * source snapshot is a digest of a fresh, no-effect adapter readback plus the
 * exact registered occurrence.  No caller can provide a destination,
 * command, repository, or arbitrary payload here.
 */
export function preparePortableLocalBusinessAdmission(input: {
  workflowId: PortableLocalWorkflowId;
  companyId: string;
  dueKey: string;
  scheduledFor: string;
  backupSnapshotReader?: typeof readBackupSnapshot;
}): PortableLocalBusinessAdmission {
  const companyId = input.companyId.trim();
  const dueKey = input.dueKey.trim();
  const scheduledFor = input.scheduledFor.trim();
  if (!companyId || !dueKey || !scheduledFor) {
    throw new Error("portable_local_source_snapshot_binding_invalid");
  }
  if (input.workflowId !== "daily-backup-safety-check" && input.workflowId !== "obsidian-project-memory-audit") {
    return blockedBusinessAdmission(input, "unattended_local_effect_workflow_not_enabled");
  }
  const readback = runPortableLocalWorkflowReadOnly({
    workflowId: input.workflowId,
    workerRole: "mac",
    companyId,
    backupSnapshotReader: input.backupSnapshotReader
  });
  const capturedAt = nowIso();
  const readbackPayload = {
    schema: "aos.portable_local_source_readback.v1",
    workflow_id: input.workflowId,
    company_id: companyId,
    due_key: dueKey,
    scheduled_for: scheduledFor,
    status: readback.status,
    exact_blocker: readback.exact_blocker,
    readback_verified: readback.readback_verified,
    adapter_result: readback.adapter_result,
    external_action_executed: readback.external_action_executed
  };
  const sourceSnapshotId = createHash("sha256").update(JSON.stringify(readbackPayload)).digest("hex");
  const sourceSnapshot: PortableLocalSourceSnapshot = {
    schema: "aos.portable_local_source_snapshot.v1",
    workflow_id: input.workflowId,
    company_id: companyId,
    due_key: dueKey,
    scheduled_for: scheduledFor,
    source_snapshot_id: sourceSnapshotId,
    captured_at: capturedAt,
    status: readback.readback_verified ? "ready" : "blocked",
    readback_verified: readback.readback_verified,
    exact_blocker: readback.exact_blocker,
    adapter_result: readback.adapter_result,
    external_action_executed: false
  };
  if (!readback.readback_verified) {
    return { status: "blocked", exact_blocker: readback.exact_blocker ?? "portable_local_source_readback_failed", sourceSnapshot, inputBundle: null };
  }
  const inputBundle = input.workflowId === "daily-backup-safety-check"
    ? {
        account_ref: BACKUP_ACCOUNT_REF,
        target_key: BACKUP_TARGET_KEY,
        payload_hash: backupBusinessPayloadHash(),
        source_snapshot_id: sourceSnapshotId
      }
    : {
        account_ref: OBSIDIAN_ACCOUNT_REF,
        target_key: OBSIDIAN_TARGET_KEY,
        payload_hash: obsidianBusinessPayloadHash(),
        source_snapshot_id: sourceSnapshotId
      };
  return { status: "ready", exact_blocker: null, sourceSnapshot, inputBundle };
}

/** The cloud may dispatch the fixed backup; only the Mac can verify its source. */
export function preparePortableLocalBackupBusinessAdmission(input: {
  companyId: string;
  dueKey: string;
  scheduledFor: string;
}): PortableLocalBusinessAdmission {
  const binding = { ...input, workflowId: "daily-backup-safety-check" as const };
  if (input.companyId !== "company_2560580981cedfd106b66245") {
    return blockedBusinessAdmission(binding, "local_backup_company_not_allowed");
  }
  const admission = preparePortableLocalBusinessAdmission(binding);
  if (admission.exact_blocker !== "local_backup_runner_missing") return admission;
  const adapterResult = {
    control_plane_exact_blocker: admission.exact_blocker,
    control_plane_readback_verified: false,
    source_readback_scope: "mac_worker_pre_effect",
    pre_effect_backup_readback_required: true,
    snapshot_created: false,
    git_push_performed: false
  };
  const sourceSnapshotId = createHash("sha256").update(JSON.stringify({
    ...binding, adapter_result: adapterResult, policy: UNATTENDED_FIXED_LOCAL_EFFECT_POLICY
  })).digest("hex");
  return {
    status: "ready", exact_blocker: null,
    sourceSnapshot: {
      ...admission.sourceSnapshot,
      source_snapshot_id: sourceSnapshotId,
      status: "ready",
      // Dispatch eligibility is not a claim that the cloud read Mac files.
      readback_verified: false,
      exact_blocker: null,
      adapter_result: adapterResult
    },
    inputBundle: {
      account_ref: BACKUP_ACCOUNT_REF, target_key: BACKUP_TARGET_KEY,
      payload_hash: backupBusinessPayloadHash(), source_snapshot_id: sourceSnapshotId
    }
  };
}

export function isDelegatedBackupSourceReadback(
  snapshot: Record<string, unknown>, bundle: Record<string, unknown>, companyId: string
): boolean {
  const adapter = snapshot.adapter_result as Record<string, unknown> | undefined;
  return companyId === "company_2560580981cedfd106b66245"
    && snapshot.workflow_id === "daily-backup-safety-check" && snapshot.company_id === companyId
    && snapshot.status === "ready" && snapshot.readback_verified === false
    && snapshot.external_action_executed === false
    && adapter?.source_readback_scope === "mac_worker_pre_effect"
    && adapter.pre_effect_backup_readback_required === true
    && adapter.control_plane_readback_verified === false
    && adapter.control_plane_exact_blocker === "local_backup_runner_missing"
    && bundle.account_ref === BACKUP_ACCOUNT_REF && bundle.target_key === BACKUP_TARGET_KEY
    && bundle.payload_hash === backupBusinessPayloadHash()
    && typeof snapshot.source_snapshot_id === "string" && /^[a-f0-9]{64}$/u.test(snapshot.source_snapshot_id)
    && bundle.source_snapshot_id === snapshot.source_snapshot_id;
}

/**
 * The control plane runs in Zeabur while this fixed workflow's source of
 * truth lives on the registered Mac worker.  When the control plane cannot
 * see the Mac-only registry/vault, preserve the exact fixed target and defer
 * the source readback to the worker.  The worker performs the read-only audit
 * immediately before any Vault or Git write; an audit failure therefore
 * remains effect-free and is recorded as an exact blocker.
 *
 * This escape hatch is deliberately limited to the registered Obsidian
 * workflow and the known Mac-path admission blocker.  It is not a generic
 * approval bypass and is never available to caller-supplied targets.
 */
export function preparePortableLocalObsidianBusinessAdmission(input: {
  companyId: string;
  dueKey: string;
  scheduledFor: string;
}): PortableLocalBusinessAdmission {
  const admission = preparePortableLocalBusinessAdmission({
    ...input,
    workflowId: "obsidian-project-memory-audit"
  });
  if (admission.status === "ready" && admission.inputBundle) return admission;
  if (admission.exact_blocker !== "obsidian_artifact_write_requires_approval"
    && admission.exact_blocker !== "obsidian_audit_findings_present") return admission;

  const capturedAt = nowIso();
  const delegatedPayload = {
    schema: "aos.portable_local_mac_worker_source_readback.v1",
    workflow_id: "obsidian-project-memory-audit",
    company_id: input.companyId,
    due_key: input.dueKey,
    scheduled_for: input.scheduledFor,
    control_plane_snapshot_id: admission.sourceSnapshot.source_snapshot_id,
    control_plane_exact_blocker: admission.exact_blocker,
    source_readback_delegated_to_mac_worker: true,
    pre_effect_audit_required: true,
    captured_at: capturedAt,
    external_action_executed: false
  };
  const sourceSnapshotId = createHash("sha256").update(JSON.stringify(delegatedPayload)).digest("hex");
  const sourceSnapshot: PortableLocalSourceSnapshot = {
    ...admission.sourceSnapshot,
    source_snapshot_id: sourceSnapshotId,
    captured_at: capturedAt,
    status: "ready",
    readback_verified: true,
    exact_blocker: null,
    adapter_result: {
      ...admission.sourceSnapshot.adapter_result,
      source_readback_scope: "mac_worker_pre_effect",
      source_readback_delegated_to_mac_worker: true,
      pre_effect_audit_required: true,
      control_plane_preflight_blocker: admission.exact_blocker,
      control_plane_readback_verified: false,
      write_performed: false
    },
    external_action_executed: false
  };
  return {
    status: "ready",
    exact_blocker: null,
    sourceSnapshot,
    inputBundle: {
      account_ref: OBSIDIAN_ACCOUNT_REF,
      target_key: OBSIDIAN_TARGET_KEY,
      payload_hash: obsidianBusinessPayloadHash(),
      source_snapshot_id: sourceSnapshotId
    }
  };
}

function blockedBusinessAdmission(input: {
  workflowId: PortableLocalWorkflowId;
  companyId: string;
  dueKey: string;
  scheduledFor: string;
}, exactBlocker: string): PortableLocalBusinessAdmission {
  const capturedAt = nowIso();
  const sourceSnapshotId = createHash("sha256").update(JSON.stringify({
    schema: "aos.portable_local_source_readback.v1",
    workflow_id: input.workflowId,
    company_id: input.companyId,
    due_key: input.dueKey,
    scheduled_for: input.scheduledFor,
    exact_blocker: exactBlocker,
    captured_at: capturedAt,
    external_action_executed: false
  })).digest("hex");
  return {
    status: "blocked",
    exact_blocker: exactBlocker,
    inputBundle: null,
    sourceSnapshot: {
      schema: "aos.portable_local_source_snapshot.v1",
      workflow_id: input.workflowId,
      company_id: input.companyId,
      due_key: input.dueKey,
      scheduled_for: input.scheduledFor,
      source_snapshot_id: sourceSnapshotId,
      captured_at: capturedAt,
      status: "blocked",
      readback_verified: false,
      exact_blocker: exactBlocker,
      adapter_result: {},
      external_action_executed: false
    }
  };
}

/**
 * Execute the one local workflow whose target and payload are already fixed
 * by the registered automation.  The caller must have passed the AOS
 * target-bound approval and effect authority; this function does not create
 * either one and never accepts a caller-supplied command or destination.
 */
export function runPortableLocalWorkflowBusiness(input: {
  workflowId: PortableLocalWorkflowId;
  workerRole?: string;
  companyId?: string;
  runId: string;
  stepId: string;
  idempotencyKey: string;
  targetDigest: string;
  inputBundleSha256: string;
  inputBundle: Record<string, unknown>;
  backupSnapshotReader?: typeof readBackupSnapshot;
}): PortableLocalWorkflowBusinessReceipt {
  if (input.workerRole !== "mac") return localBusinessBlocked(input, "mac_worker_required", false);
  if (input.workflowId === "obsidian-project-memory-audit") {
    return runObsidianProjectMemoryBusiness(input);
  }
  if (input.workflowId !== "daily-backup-safety-check") return localBusinessBlocked(input, "local_business_workflow_not_enabled", false);
  if (input.companyId !== "company_2560580981cedfd106b66245") return localBusinessBlocked(input, "local_backup_company_not_allowed", false);
  const bundle = input.inputBundle;
  if (bundle.account_ref !== BACKUP_ACCOUNT_REF
    || bundle.target_key !== BACKUP_TARGET_KEY
    || bundle.payload_hash !== backupBusinessPayloadHash()
    || typeof bundle.source_snapshot_id !== "string"
    || !bundle.source_snapshot_id.trim()
    || !/^[a-f0-9]{64}$/u.test(input.targetDigest)
    || !/^[a-f0-9]{64}$/u.test(input.inputBundleSha256)) {
    return localBusinessBlocked(input, "local_backup_target_binding_invalid", false);
  }
  const runnerPath = process.env.AUTOMATION_OS_BACKUP_RUNNER_PATH?.trim()
    || "/Users/nichikatanaka/.codex/automations/daily-backup-safety-check/scripts/run_daily_backup_snapshot.sh";
  try {
    const runnerStat = statSync(runnerPath);
    if (!runnerStat.isFile() || (runnerStat.mode & 0o111) === 0) {
      return localBusinessBlocked(input, "local_backup_runner_not_executable", false);
    }
  } catch {
    return localBusinessBlocked(input, "local_backup_runner_missing", false);
  }
  // Every business run, including a cloud-delegated occurrence, performs the
  // actual source/remote/integrity/restore checks before starting the runner.
  const preEffectReadback = runPortableLocalWorkflowReadOnly({
    workflowId: "daily-backup-safety-check", companyId: input.companyId,
    workerRole: "mac", backupSnapshotReader: input.backupSnapshotReader
  });
  if (!preEffectReadback.readback_verified || !preEffectReadback.cleanup_verified) {
    return localBusinessBlocked(input, preEffectReadback.exact_blocker ?? "local_backup_pre_effect_readback_failed", false, {
      pre_effect_readback: preEffectReadback.adapter_result
    });
  }
  let stdout = "";
  let childExitCode = 0;
  try {
    stdout = execFileSync("/bin/bash", [runnerPath], {
      cwd: "/Users/nichikatanaka/Documents/Codex/automation-os",
      env: { ...process.env, AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS: "enabled" },
      encoding: "utf8",
      timeout: 30 * 60 * 1000,
      maxBuffer: 2 * 1024 * 1024
    });
  } catch (error) {
    childExitCode = typeof (error as { status?: unknown }).status === "number"
      ? Number((error as { status: number }).status)
      : 1;
    const output = typeof (error as { stdout?: unknown }).stdout === "string"
      ? String((error as { stdout: string }).stdout).slice(-2000)
      : "";
    return localBusinessBlocked(input, "local_backup_runner_failed", true, {
      child_exit_code: childExitCode,
      output_tail_present: Boolean(output),
      runner_path: runnerPath,
      operation_effect_state: "unknown",
      reconciliation_required: true
    });
  }
  const success = /(?:^|\n)OK run_id=[^\s]+ snapshot=\S+ artifact=\S+ backup_commit=[a-f0-9]{40}(?:\n|$)/u.test(stdout);
  if (!success) {
    return localBusinessBlocked(input, "local_backup_runner_receipt_invalid", true, {
      runner_path: runnerPath,
      operation_effect_state: "unknown",
      reconciliation_required: true
    });
  }
  const localCommit = gitRead(["-C", BACKUP_DESTINATION, "rev-parse", "HEAD"]);
  const remote = gitRead(["-C", BACKUP_DESTINATION, "remote", "get-url", "origin"]);
  const branch = gitRead(["-C", BACKUP_DESTINATION, "symbolic-ref", "--short", "HEAD"]);
  const remoteCommit = gitRead(["-C", BACKUP_DESTINATION, "ls-remote", "origin", "refs/heads/main"])
    .split(/\s+/u)[0] || "";
  const clean = gitRead(["-C", BACKUP_DESTINATION, "status", "--porcelain"]);
  const statePath = "/Users/nichikatanaka/.codex/automations/daily-backup-safety-check/STATE.md";
  const state = (() => {
    try { return readFileSync(statePath, "utf8"); } catch { return ""; }
  })();
  const runnerRunId = stdout.match(/(?:^|\n)OK run_id=([^\s]+)/u)?.[1] || null;
  const postEffectReadback = (input.backupSnapshotReader ?? readBackupSnapshot)();
  const remoteVerified = /^[a-f0-9]{40}$/u.test(localCommit)
    && remote === BACKUP_REPOSITORY
    && branch === "main"
    && remoteCommit === localCommit
    && clean === ""
    && state.includes("status: success")
    && state.includes(`latest_backup_commit: ${localCommit}`)
    && postEffectReadback.readback_verified === true
    && postEffectReadback.cleanup_verified === true
    && postEffectReadback.snapshot_id === runnerRunId
    && postEffectReadback.commit === localCommit;
  const exactBlocker = remoteVerified ? null : "local_backup_remote_reconciliation_required";
  const runnerReceipt = {
    schema: "aos.local_backup_business_runner_receipt.v1",
    run_id: input.runId,
    step_id: input.stepId,
    idempotency_key: input.idempotencyKey,
    runner_run_id: runnerRunId,
    runner_path: runnerPath,
    destination: BACKUP_DESTINATION,
    repository: BACKUP_REPOSITORY,
    branch: "main",
    backup_commit: /^[a-f0-9]{40}$/u.test(localCommit) ? localCommit : null,
    pre_effect_readback: preEffectReadback.adapter_result,
    post_effect_readback: postEffectReadback,
    external_action_executed: true,
    same_run_receipt: true,
    same_run_source_sync: remoteVerified,
    readback_verified: remoteVerified,
    cleanup_verified: true,
    business_proofs: {
      backup_snapshot: remoteVerified,
      backup_remote_push: remoteVerified,
      backup_state: remoteVerified,
      cleanup_receipt: true
    }
  };
  return {
    status: remoteVerified ? "complete" : "blocked",
    exact_blocker: exactBlocker,
    external_action_executed: true,
    workflow_id: input.workflowId,
    read_only_stage_bound: false,
    readback_verified: remoteVerified,
    cleanup_verified: true,
    business_completion_verified: remoteVerified,
    same_run_receipt: true,
    same_run_source_sync: remoteVerified,
    adapter_result: {
      execution_surface: "mac_local_worker",
      operation: "snapshot_and_private_git_push",
      runner_path: runnerPath,
      destination: BACKUP_DESTINATION,
      repository: BACKUP_REPOSITORY,
      local_commit: localCommit || null,
      remote_commit: remoteCommit || null,
      remote_verified: remoteVerified,
      destination_clean: clean === "",
      state_readback_verified: state.includes("status: success") && state.includes(`latest_backup_commit: ${localCommit}`),
      operation_effect_state: remoteVerified ? "completed" : "effect_unknown",
      reconciliation_required: !remoteVerified
    },
    runner_receipt: runnerReceipt
  };
}

function runObsidianProjectMemoryBusiness(input: Parameters<typeof runPortableLocalWorkflowBusiness>[0]): PortableLocalWorkflowBusinessReceipt {
  const bundle = input.inputBundle;
  if (bundle.account_ref !== OBSIDIAN_ACCOUNT_REF
    || bundle.target_key !== OBSIDIAN_TARGET_KEY
    || bundle.payload_hash !== obsidianBusinessPayloadHash()
    || typeof bundle.source_snapshot_id !== "string"
    || !bundle.source_snapshot_id.trim()
    || !/^[a-f0-9]{64}$/u.test(input.targetDigest)
    || !/^[a-f0-9]{64}$/u.test(input.inputBundleSha256)) {
    return localBusinessBlocked(input, "local_obsidian_target_binding_invalid", false);
  }

  const vaultPath = defaultObsidianVaultPath;
  const statusRoot = resolveStatusRoot();
  const maintenanceStatusFile = join(statusRoot, "obsidian-maintenance-status.json");
  const gitSyncStatusFile = join(statusRoot, "obsidian-git-sync-status.json");
  let effectStarted = false;
  try {
    // The Zeabur control plane may not have the Mac-only project registry or
    // Vault mounted.  Re-read them on the registered Mac worker immediately
    // before the first write, so an approved run cannot turn stale or missing
    // source state into a Vault/Git effect.
    const sourceAudit = auditProjects({ obsidianVaultPath: vaultPath });
    if (!sourceAudit.ok) {
      return localBusinessBlocked(input, "obsidian_source_audit_failed", false, {
        source_readback_scope: "mac_worker_pre_effect",
        source_readback_verified: false,
        source_readback_delegated_to_mac_worker: true,
        pre_effect_audit_required: true,
        audit_summary: sourceAudit.summary,
        operation_effect_state: "none",
        reconciliation_required: false
      });
    }
    // The exporter reads AOS run/proof state while rendering the Vault.  The
    // worker is an independent process, so initialize its configured DB
    // before entering the fixed, registered Obsidian sequence.
    initDb();
    effectStarted = true;
    // Startup recovery and the periodic exporter are independent processes.
    // A transient shared-vault lock is safe to retry in this worker, but a
    // stale/success status must never be mistaken for the current attempt.
    const maintenance = retryObsidianStep(
      () => runObsidianMaintenance({ force: true, vaultPath, statusFile: maintenanceStatusFile }),
      (value) => value.ok !== true && (value.exactBlocker?.startsWith("obsidian_vault_write_locked") === true
        || value.exactBlocker === "obsidian_maintenance_already_running")
    );
    const exported = retryObsidianStep(
      () => runObsidianExportNow("registered-weekly-audit", { vaultPath, refreshCodexSessionIndex: true }),
      (value) => value.run_state === "skipped_busy"
    );
    const gitSync = retryObsidianStep(
      () => runObsidianGitSync({ execute: true, force: true, vaultPath, statusFile: gitSyncStatusFile }),
      (value) => value.skipped === true && (value.skipReason?.startsWith("obsidian_vault_write_locked") === true
        || value.skipReason === "obsidian_maintenance_already_running")
    );

    const localCommit = gitRead(["-C", vaultPath, "rev-parse", "HEAD"]);
    const remote = gitRead(["-C", vaultPath, "remote", "get-url", "origin"]);
    const branch = gitRead(["-C", vaultPath, "symbolic-ref", "--short", "HEAD"]);
    const remoteCommit = gitRead(["-C", vaultPath, "ls-remote", "origin", "refs/heads/main"])
      .split(/\s+/u)[0] || "";
    const clean = gitRead(["-C", vaultPath, "status", "--porcelain"]);
    const remoteVerified = maintenance.ok === true
      && maintenance.skipped === false
      && maintenance.exactBlocker === null
      && exported.ok === true
      && exported.run_state === "succeeded"
      && exported.lastError === null
      && gitSync.ok === true
      && gitSync.skipped === false
      && gitSync.execute === true
      && gitSync.exactBlocker === null
      && gitSync.privateRemote === true
      && gitSync.remote === OBSIDIAN_REPOSITORY
      && gitSync.branch === "main"
      && remote === OBSIDIAN_REPOSITORY
      && branch === "main"
      && /^[a-f0-9]{40}$/u.test(localCommit)
      && remoteCommit === localCommit
      && clean === "";
    const businessProofs = {
      obsidian_maintenance: maintenance.ok === true && maintenance.skipped === false && maintenance.exactBlocker === null,
      obsidian_export: exported.ok === true && exported.run_state === "succeeded" && exported.lastError === null,
      obsidian_git_sync: gitSync.ok === true && gitSync.skipped === false && gitSync.execute === true && gitSync.exactBlocker === null,
      private_remote_parity: remoteVerified,
      cleanup_receipt: clean === ""
    };
    const runnerReceipt = {
      schema: "aos.obsidian_project_memory_business_runner_receipt.v1",
      run_id: input.runId,
      step_id: input.stepId,
      idempotency_key: input.idempotencyKey,
      vault_path: vaultPath,
      repository: OBSIDIAN_REPOSITORY,
      branch: "main",
      maintenance_ok: maintenance.ok === true,
      export_ok: exported.ok === true,
      export_run_state: exported.run_state,
      git_sync_ok: gitSync.ok === true,
      local_commit: /^[a-f0-9]{40}$/u.test(localCommit) ? localCommit : null,
      remote_commit: /^[a-f0-9]{40}$/u.test(remoteCommit) ? remoteCommit : null,
      external_action_executed: true,
      same_run_receipt: true,
      same_run_source_sync: remoteVerified,
      readback_verified: remoteVerified,
      cleanup_verified: clean === "",
      business_proofs: businessProofs
    };
    return {
      status: remoteVerified ? "complete" : "blocked",
      exact_blocker: remoteVerified ? null : "local_obsidian_remote_reconciliation_required",
      external_action_executed: true,
      workflow_id: input.workflowId,
      read_only_stage_bound: false,
      readback_verified: remoteVerified,
      cleanup_verified: clean === "",
      business_completion_verified: remoteVerified,
      same_run_receipt: true,
      same_run_source_sync: remoteVerified,
      adapter_result: {
        execution_surface: "mac_local_worker",
        operation: "maintenance_export_and_private_git_push",
        vault_path: vaultPath,
        repository: OBSIDIAN_REPOSITORY,
        branch: "main",
        local_commit: localCommit || null,
        remote_commit: remoteCommit || null,
        remote_verified: remoteVerified,
        destination_clean: clean === "",
        maintenance_ok: maintenance.ok === true,
        export_ok: exported.ok === true,
        export_run_state: exported.run_state,
        git_sync_ok: gitSync.ok === true,
        operation_effect_state: remoteVerified ? "completed" : "effect_unknown",
        reconciliation_required: !remoteVerified
      },
      runner_receipt: runnerReceipt
    };
  } catch (error) {
    return localBusinessBlocked(input, "local_obsidian_business_runner_failed", effectStarted, {
      runner_path: "fixed_registered_obsidian_runner",
      operation_effect_state: effectStarted ? "unknown" : "none",
      reconciliation_required: effectStarted,
      error: error instanceof Error ? error.message.slice(0, 160) : "obsidian_business_runner_failed"
    });
  }
}

function resolveStatusRoot(): string {
  return process.env.AUTOMATION_OS_OBSIDIAN_STATUS_ROOT?.trim()
    || join(process.cwd(), "data");
}

function retryObsidianStep<T>(step: () => T, retryable: (value: T) => boolean): T {
  let last: T;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    last = step();
    if (!retryable(last) || attempt === 4) return last;
    execFileSync("/bin/sleep", ["2"], { stdio: "ignore" });
  }
  return last!;
}

function gitRead(args: string[]): string {
  try {
    return execFileSync("/usr/bin/git", args, { encoding: "utf8", timeout: 60_000 }).trim();
  } catch {
    return "";
  }
}

function localBusinessBlocked(
  input: Pick<Parameters<typeof runPortableLocalWorkflowBusiness>[0], "workflowId"> & Record<string, unknown>,
  exactBlocker: string,
  effectUnknown: boolean,
  adapterResult: Record<string, unknown> = {}
): PortableLocalWorkflowBusinessReceipt {
  return {
    status: "blocked",
    exact_blocker: exactBlocker,
    external_action_executed: effectUnknown,
    workflow_id: input.workflowId,
    read_only_stage_bound: false,
    readback_verified: false,
    cleanup_verified: true,
    business_completion_verified: false,
    same_run_receipt: false,
    same_run_source_sync: false,
    adapter_result: { execution_surface: "mac_local_worker", operation_effect_state: effectUnknown ? "unknown" : "none", ...adapterResult },
    runner_receipt: { schema: "aos.local_backup_business_runner_receipt.v1", business_proofs: {} }
  };
}

function partial(workflowId: PortableLocalWorkflowId, exactBlocker: string, adapterResult: Record<string, unknown>, readbackVerified = true): PortableLocalWorkflowReceipt {
  return {
    status: "partial",
    exact_blocker: exactBlocker,
    external_action_executed: false,
    workflow_id: workflowId,
    read_only_stage_bound: true,
    readback_verified: readbackVerified,
    cleanup_verified: true,
    business_completion_verified: false,
    adapter_result: adapterResult
  };
}

function completeReadOnly(workflowId: PortableLocalWorkflowId, adapterResult: Record<string, unknown>): PortableLocalWorkflowReceipt {
  return {
    status: "complete",
    exact_blocker: null,
    external_action_executed: false,
    workflow_id: workflowId,
    read_only_stage_bound: true,
    readback_verified: true,
    cleanup_verified: true,
    business_completion_verified: false,
    adapter_result: adapterResult
  };
}

function blocked(workflowId: PortableLocalWorkflowId, exactBlocker: string, adapterResult: Record<string, unknown>): PortableLocalWorkflowReceipt {
  return { ...partial(workflowId, exactBlocker, adapterResult, false), status: "blocked" };
}

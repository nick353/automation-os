import { existsSync, accessSync, constants } from "node:fs";
import { auditProjects } from "../projects/projectAuditor.js";

export const PORTABLE_LOCAL_WORKFLOW_SCHEMA = "aos.portable_local_workflow.v1" as const;

export type PortableLocalWorkflowId =
  | "email-review-reply"
  | "daily-backup-safety-check"
  | "obsidian-project-memory-audit";

export type PortableLocalWorkflowReceipt = {
  status: "complete" | "partial" | "blocked";
  exact_blocker: string | null;
  external_action_executed: false;
  workflow_id: PortableLocalWorkflowId;
  read_only_stage_bound: true;
  readback_verified: boolean;
  cleanup_verified: true;
  business_completion_verified: false;
  adapter_result: Record<string, unknown>;
};

const manifests: Record<PortableLocalWorkflowId, {
  name: string;
  command: string;
  workerCommandKind: "email_review_registered" | "local_backup_registered" | "obsidian_audit_registered";
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
    default: return null;
  }
}

export function localWorkflowIdForWorkerAdapter(adapter: string): PortableLocalWorkflowId | null {
  switch (adapter) {
    case "email_review_registered": return "email-review-reply";
    case "local_backup_registered": return "daily-backup-safety-check";
    case "obsidian_audit_registered": return "obsidian-project-memory-audit";
    default: return null;
  }
}

export function localWorkflowManifest(workflowId: PortableLocalWorkflowId) {
  return { schema: PORTABLE_LOCAL_WORKFLOW_SCHEMA, workflow_id: workflowId, ...manifests[workflowId] };
}

export function portableLocalReadOnlyStageForScheduledWorkflow(_workflowId: PortableLocalWorkflowId): "reference_readback" {
  return "reference_readback";
}

export function runPortableLocalWorkflowReadOnly(input: {
  workflowId: PortableLocalWorkflowId;
  workerRole?: string;
}): PortableLocalWorkflowReceipt {
  if (input.workerRole !== "mac") {
    return blocked(input.workflowId, "mac_worker_required", { execution_surface: "mac_local_worker", worker_role: input.workerRole ?? "unset" });
  }
  if (input.workflowId === "email-review-reply") {
    return blocked(input.workflowId, "gmail_connector_context_isolation_unavailable", { connector: "gmail", intended_stage: "newest_100_snapshot" });
  }
  if (input.workflowId === "daily-backup-safety-check") {
    const runnerPath = process.env.AUTOMATION_OS_BACKUP_RUNNER_PATH?.trim()
      || "/Users/nichikatanaka/.codex/automations/daily-backup-safety-check/scripts/run_daily_backup_snapshot.sh";
    try {
      accessSync(runnerPath, constants.X_OK);
    } catch {
      return blocked(input.workflowId, "local_backup_runner_missing", { runner_configured: false });
    }
    return partial(input.workflowId, "local_backup_effect_requires_explicit_approval", {
      runner_configured: true,
      runner_path_configured: true,
      external_effect: "snapshot_and_private_git_push",
      preflight_only: true
    });
  }
  try {
    const result = auditProjects({
      registryPath: process.env.AUTOMATION_OS_PROJECT_REGISTRY?.trim() || undefined,
      obsidianVaultPath: process.env.AUTOMATION_OS_OBSIDIAN_VAULT?.trim() || undefined
    });
    return partial(input.workflowId, "obsidian_artifact_write_requires_approval", {
      audit_ok: result.ok,
      audit_summary: result.summary,
      registry_readback: true,
      vault_readback: true,
      write_performed: false
    }, result.ok);
  } catch (error) {
    return blocked(input.workflowId, "unresolved_only_audit_failed", { error: error instanceof Error ? error.message.slice(0, 160) : "audit_failed" });
  }
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

function blocked(workflowId: PortableLocalWorkflowId, exactBlocker: string, adapterResult: Record<string, unknown>): PortableLocalWorkflowReceipt {
  return { ...partial(workflowId, exactBlocker, adapterResult, false), status: "blocked" };
}

import { initDb, querySql } from "../db/client.js";
import {
  fixedRegisteredWorkflows,
  getRegisteredWorkflowStartCommand,
  initRegisteredWorkflows,
  type RegisteredWorkflowRow
} from "../registeredWorkflows.js";
import { startCommandRun } from "./workerEngine.js";
import { PORTABLE_EXECUTION_SOURCE } from "./portableWorkerIsolation.js";
import { portableWorkflowIdForWorkerAdapter, portableWorkerExecutionMode } from "./portableWorkflowWorker.js";
import {
  type PortableTrigger,
  type PortableWorkflowId
} from "./portableWorkflowContract.js";

export type PortableWorkflowStartInput = {
  workflowId: PortableWorkflowId;
  sourceTrigger: PortableTrigger;
  idempotencyKey: string;
  /**
   * Optional viewer/company scope for interactive starts. Global scheduler
   * starts intentionally omit it; App bridge starts must bind it so the run
   * is visible in the same company-scoped readback that accepted it.
   */
  companyId?: string | null;
};

export type PortableWorkflowStartResult = {
  runId: string;
  replayed: boolean;
  workflowId: PortableWorkflowId;
  sourceTrigger: PortableTrigger;
  idempotencyKey: string;
  status?: string;
};

const portableTriggers = new Set<PortableTrigger>(["automation_os_scheduler", "codex_app_bridge", "launchd", "github_actions"]);

export function isPortableWorkflowTrigger(value: string): value is PortableTrigger {
  return portableTriggers.has(value as PortableTrigger);
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function portableInvocationMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const value = metadata.portable_workflow_invocation;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function findExistingPortableRun(input: PortableWorkflowStartInput): { id: string; status: string } | undefined {
  const rows = querySql<{ id: string; status: string; metadata_json: string }>(`
    SELECT id, status, metadata_json
    FROM runs
    WHERE execution_source='${PORTABLE_EXECUTION_SOURCE}' AND quarantined=0
    ORDER BY created_at DESC
    LIMIT 500
  `);
  return rows.find((row) => {
    const invocation = portableInvocationMetadata(parseMetadata(row.metadata_json));
    return invocation.workflow_id === input.workflowId
      && invocation.source_trigger === input.sourceTrigger
      && invocation.idempotency_key === input.idempotencyKey;
  });
}

function getPortableRegisteredWorkflow(workflowId: PortableWorkflowId): RegisteredWorkflowRow {
  const workflow = initRegisteredWorkflows().find((row) => row.id === workflowId);
  if (!workflow) throw new Error("portable_registered_workflow_missing");
  if (!fixedRegisteredWorkflows.some((fixed) => fixed.id === workflow.id && fixed.runnerKind === workflow.runner_kind)) {
    throw new Error("portable_registered_workflow_not_fixed");
  }
  if (workflow.company_id) throw new Error("portable_workflow_company_scope_unsupported");
  if (portableWorkflowIdForWorkerAdapter(workflow.runner_kind) !== workflowId) {
    throw new Error("portable_registered_runner_binding_mismatch");
  }
  return workflow;
}

export async function startPortableWorkflowRun(input: PortableWorkflowStartInput): Promise<PortableWorkflowStartResult> {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey) throw new Error("portable_idempotency_key_required");
  if (!isPortableWorkflowTrigger(input.sourceTrigger)) throw new Error("portable_source_trigger_invalid");
  initDb();
  const workflow = getPortableRegisteredWorkflow(input.workflowId);
  const normalizedInput = { ...input, idempotencyKey };
  const existing = findExistingPortableRun(normalizedInput);
  if (existing) {
    return {
      runId: existing.id,
      replayed: true,
      workflowId: input.workflowId,
      sourceTrigger: input.sourceTrigger,
      idempotencyKey,
      status: existing.status
    };
  }
  const command = getRegisteredWorkflowStartCommand(workflow.id);
  if (!command) throw new Error("portable_registered_start_command_missing");
  const source = input.sourceTrigger === "automation_os_scheduler" ? "scheduler" as const : "manual" as const;
  const result = await startCommandRun(command, {
    deferWorker: true,
    ...(input.companyId !== undefined ? { companyId: input.companyId } : {}),
    metadata: {
      registeredWorkflowId: workflow.id,
      registered_workflow_id: workflow.id,
      workflowId: workflow.id,
      workflow_id: workflow.id,
      registered_workflow_start: {
        source,
        runnerKind: workflow.runner_kind,
        workflow_id: workflow.id,
        portable: true
      },
      portable_workflow_invocation: {
        schema: "automation_os_portable_workflow_invocation_v1",
        workflow_id: input.workflowId,
        source_trigger: input.sourceTrigger,
        idempotency_key: idempotencyKey,
        app_dependency: false,
        external_action_executed: false
      },
      portable_worker: {
        mode: portableWorkerExecutionMode(),
        workflow_id: workflow.id,
        external_adapter_configured: Boolean(process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER?.trim()),
        external_action_executed: false
      }
    }
  });
  return {
    runId: result.runId,
    replayed: false,
    workflowId: input.workflowId,
    sourceTrigger: input.sourceTrigger,
    idempotencyKey,
    status: typeof result.run.status === "string" ? result.run.status : undefined
  };
}

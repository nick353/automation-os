import { portableWorkflowManifests, type PortableWorkflowId } from "./portableWorkflowContract.js";
import { localWorkflowIdForRegisteredAutomation, type PortableLocalWorkflowId } from "./portableLocalWorkflow.js";

export const PORTABLE_SCHEDULE_DISPATCH_SCHEMA = "aos.portable_schedule_dispatch.v1" as const;

export type PortableScheduleDispatch = {
  schema: typeof PORTABLE_SCHEDULE_DISPATCH_SCHEMA;
  workflow_id: PortableWorkflowId | PortableLocalWorkflowId;
  queue: "aos_portable_workflow_run_queue";
  worker_protocol: "mac_worker_polling_required";
  execution_backend: "automation_os_worker";
  browser_surface: "none" | "browser_use_cli";
  operation_surface: "mac_local_worker" | "browser_use_cli";
  app_dependency: false;
  codex_is_not_authority: true;
  external_action_default: false;
};

type RegisteredAutomationLike = {
  workerCommandKind?: string | null;
  builderSpec?: Record<string, unknown> | null;
};

function workflowIdFromBuilderSpec(builderSpec: Record<string, unknown> | null | undefined): string {
  const adapter = builderSpec?.workflowAdapter;
  if (adapter && typeof adapter === "object" && !Array.isArray(adapter)) {
    const workflowId = (adapter as Record<string, unknown>).workflow_id;
    if (typeof workflowId === "string") return workflowId.trim();
  }
  const canonical = builderSpec?.canonicalWorkflowId;
  return typeof canonical === "string" ? canonical.trim() : "";
}

/**
 * Resolve only the AOS catalog's already-known portable browser workflows.
 * Caller-supplied workflow ids are never accepted as a schedule authority.
 */
export function portableWorkflowIdForRegisteredAutomation(input: RegisteredAutomationLike): PortableWorkflowId | null {
  const workflowId = workflowIdFromBuilderSpec(input.builderSpec);
  if (!workflowId || !Object.prototype.hasOwnProperty.call(portableWorkflowManifests, workflowId)) return null;
  const manifest = portableWorkflowManifests[workflowId as PortableWorkflowId];
  if (manifest.execution.browser_surface !== "browser_use_cli" || manifest.execution.app_dependency !== false) return null;
  return workflowId as PortableWorkflowId;
}

export function portableLocalWorkflowIdForRegisteredAutomation(input: RegisteredAutomationLike): PortableLocalWorkflowId | null {
  return localWorkflowIdForRegisteredAutomation(input);
}

export function portableScheduleDispatchForRegisteredAutomation(input: RegisteredAutomationLike): PortableScheduleDispatch | null {
  const workflowId = portableWorkflowIdForRegisteredAutomation(input);
  if (workflowId) {
    return {
      schema: PORTABLE_SCHEDULE_DISPATCH_SCHEMA,
      workflow_id: workflowId,
      queue: "aos_portable_workflow_run_queue",
      worker_protocol: "mac_worker_polling_required",
      execution_backend: "automation_os_worker",
      browser_surface: "browser_use_cli",
      operation_surface: "browser_use_cli",
      app_dependency: false,
      codex_is_not_authority: true,
      external_action_default: false
    };
  }
  const localWorkflowId = portableLocalWorkflowIdForRegisteredAutomation(input);
  if (!localWorkflowId) return null;
  return {
    schema: PORTABLE_SCHEDULE_DISPATCH_SCHEMA,
    workflow_id: localWorkflowId,
    queue: "aos_portable_workflow_run_queue",
    worker_protocol: "mac_worker_polling_required",
    execution_backend: "automation_os_worker",
    browser_surface: "none",
    operation_surface: "mac_local_worker",
    app_dependency: false,
    codex_is_not_authority: true,
    external_action_default: false
  };
}

export function portableReadOnlyStageForScheduledWorkflow(workflowId: PortableWorkflowId): "candidate_supply" | "reference_readback" {
  // Scheduled runs remain no-effect. Job may collect candidate supply; the
  // publish-oriented workflows stay at reference readback until a fresh,
  // approved target bundle is supplied by a later stage.
  return workflowId === "job-application-manager" ? "candidate_supply" : "reference_readback";
}

export function portableScheduleDueKey(scheduleId: string, scheduledFor: string): string {
  return `${scheduleId}:${scheduledFor}`;
}

export function portableScheduleIdempotencyKey(companyId: string, scheduleId: string, scheduledFor: string): string {
  return `scheduler:${companyId}:${portableScheduleDueKey(scheduleId, scheduledFor)}`;
}

import { portableWorkflowManifests, type PortableWorkflowId } from "./portableWorkflowContract.js";
import { localWorkflowIdForRegisteredAutomation, type PortableLocalWorkflowId } from "./portableLocalWorkflow.js";

export const PORTABLE_SCHEDULE_DISPATCH_SCHEMA = "aos.portable_schedule_dispatch.v1" as const;

export type PortableScheduleDispatch = {
  schema: typeof PORTABLE_SCHEDULE_DISPATCH_SCHEMA;
  workflow_id: PortableWorkflowId | PortableLocalWorkflowId;
  queue: "aos_portable_workflow_run_queue";
  worker_protocol: "mac_worker_polling_required";
  execution_backend: "automation_os_worker";
  browser_surface: "none" | "aos_chrome_companion_profile_instance";
  browser_runtime: "none" | "aos_chrome_companion";
  connector_execution_owner: "none" | "zeabur_codex_app_server" | "mac_worker_explicit_connector_fallback";
  operation_surface: "mac_local_worker" | "aos_chrome_companion_profile_instance";
  app_dependency: false;
  codex_is_not_authority: true;
  external_action_default: false;
};

export type PortableConnectorExecutionOwner = "zeabur_codex_app_server" | "mac_worker_explicit_connector_fallback";
export type PortableBrowserSurfaceRequirement = "automatic" | "official_extension" | "companion_extension" | "browser_use_cli";

type RegisteredAutomationLike = {
  workerCommandKind?: string | null;
  builderSpec?: Record<string, unknown> | null;
  browserSurfaceRequirement?: PortableBrowserSurfaceRequirement | null;
};

const PORTABLE_WORKFLOW_BY_WORKER_COMMAND: Record<string, PortableWorkflowId> = {
  job_submit_registered: "job-application-manager",
  daily_ai_registered: "daily-ai-research-publish-run",
  nisenprints_registered: "nisenprints-daily-product-canva-printify-etsy-pinterest"
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

function workflowIdFromRegisteredAutomation(input: RegisteredAutomationLike): string {
  const fromBuilderSpec = workflowIdFromBuilderSpec(input.builderSpec);
  if (fromBuilderSpec) return fromBuilderSpec;
  const workerCommandKind = typeof input.workerCommandKind === "string" ? input.workerCommandKind.trim() : "";
  return PORTABLE_WORKFLOW_BY_WORKER_COMMAND[workerCommandKind] ?? "";
}

export function connectorExecutionOwnerForRegisteredAutomation(input: RegisteredAutomationLike): PortableConnectorExecutionOwner {
  const routing = input.builderSpec?.connectorExecution;
  if (routing && typeof routing === "object" && !Array.isArray(routing)) {
    const owner = (routing as Record<string, unknown>).owner;
    if (owner === "mac_worker_explicit_connector_fallback") return owner;
  }
  return "zeabur_codex_app_server";
}

/**
 * Registered definitions may carry an explicit surface requirement, but an
 * automatic requirement must remain automatic so the current AOS UI backend
 * setting is resolved for every scheduled run. The catalog's historical
 * Companion surface is descriptive metadata, not an execution override.
 */
export function browserSurfaceRequirementForRegisteredAutomation(
  input: RegisteredAutomationLike,
): PortableBrowserSurfaceRequirement | undefined {
  const direct = normalizedBrowserSurfaceRequirement(input.browserSurfaceRequirement);
  if (direct !== undefined) {
    return direct;
  }
  const fromBuilderSpec = normalizedBrowserSurfaceRequirement(input.builderSpec?.browserSurfaceRequirement);
  if (fromBuilderSpec !== undefined) {
    return fromBuilderSpec;
  }
  const browserSurface = input.builderSpec?.browserSurface;
  if (browserSurface === undefined || browserSurface === null || browserSurface === "none") return undefined;
  if (browserSurface === "aos_chrome_companion_profile_instance" || browserSurface === "browser_use_cli") return "automatic";
  throw new Error("portable_registered_browser_surface_invalid");
}

function normalizedBrowserSurfaceRequirement(value: unknown): PortableBrowserSurfaceRequirement | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "automatic" || value === "official_extension" || value === "companion_extension" || value === "browser_use_cli") return value;
  throw new Error("portable_registered_browser_surface_requirement_invalid");
}

/**
 * Resolve only the AOS catalog's already-known portable browser workflows.
 * Caller-supplied workflow ids are never accepted as a schedule authority.
 */
export function portableWorkflowIdForRegisteredAutomation(input: RegisteredAutomationLike): PortableWorkflowId | null {
  // An explicit inventory worker is local even when an older definition still
  // carries the publication canonical workflow in its builder spec.
  if (input.workerCommandKind?.trim() === "nisenprints_inventory_registered") return null;
  const workflowId = workflowIdFromRegisteredAutomation(input);
  if (!workflowId || !Object.prototype.hasOwnProperty.call(portableWorkflowManifests, workflowId)) return null;
  const manifest = portableWorkflowManifests[workflowId as PortableWorkflowId];
  if (manifest.execution.browser_surface !== "aos_chrome_companion_profile_instance" || manifest.execution.browser_runtime !== "aos_chrome_companion" || manifest.execution.app_dependency !== false) return null;
  return workflowId as PortableWorkflowId;
}

export function portableLocalWorkflowIdForRegisteredAutomation(input: RegisteredAutomationLike): PortableLocalWorkflowId | null {
  return localWorkflowIdForRegisteredAutomation(input);
}

export function portableScheduleDispatchForRegisteredAutomation(input: RegisteredAutomationLike): PortableScheduleDispatch | null {
  const workflowId = portableWorkflowIdForRegisteredAutomation(input);
  if (workflowId) {
    const manifest = portableWorkflowManifests[workflowId];
    const connectorOwner = connectorExecutionOwnerForRegisteredAutomation(input);
    return {
      schema: PORTABLE_SCHEDULE_DISPATCH_SCHEMA,
      workflow_id: workflowId,
      queue: "aos_portable_workflow_run_queue",
      worker_protocol: "mac_worker_polling_required",
      execution_backend: "automation_os_worker",
      browser_surface: manifest.execution.browser_surface,
      browser_runtime: manifest.execution.browser_runtime,
      connector_execution_owner: connectorOwner,
      operation_surface: manifest.execution.browser_surface,
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
    browser_runtime: "none",
    connector_execution_owner: "none",
    operation_surface: "mac_local_worker",
    app_dependency: false,
    codex_is_not_authority: true,
    external_action_default: false
  };
}

export function portableReadOnlyStageForScheduledWorkflow(
  workflowId: PortableWorkflowId,
  options: { hasInputBundle?: boolean } = {}
): "candidate_supply" | "reference_readback" {
  // A candidate-supply run is only claimable when its run-bound input bundle
  // is present. Codex App's provider-neutral trigger intentionally supplies no
  // bundle, so it must enter the terminal no-effect reference readback lane;
  // otherwise the Mac worker correctly refuses the claim forever.
  return workflowId === "job-application-manager" && options.hasInputBundle === true
    ? "candidate_supply"
    : "reference_readback";
}

export function portableScheduleDueKey(scheduleId: string, scheduledFor: string): string {
  return `${scheduleId}:${scheduledFor}`;
}

export function portableScheduleIdempotencyKey(companyId: string, scheduleId: string, scheduledFor: string): string {
  return `scheduler:${companyId}:${portableScheduleDueKey(scheduleId, scheduledFor)}`;
}

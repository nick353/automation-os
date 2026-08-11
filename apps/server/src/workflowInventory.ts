import { listRegisteredAutomationCatalog } from "./automations/registeredCatalog.js";
import { listWorkflowAdapterDefinitions } from "./providers/workflowAdapterRegistry.js";
import { registeredBrowserLanes, type RegisteredBrowserLane } from "./runs/laneManager.js";
import { portableWorkflowManifests } from "./runs/portableWorkflowContract.js";
import { fixedRegisteredWorkflows } from "./registeredWorkflows.js";

export const REGISTERED_WORKFLOW_INVENTORY_SCHEMA = "aos.registered_workflow_inventory.v1" as const;

type WorkflowSetName =
  | "registered_browser_workflows"
  | "portable_workflows"
  | "company_automation_catalog_workflows"
  | "workflow_adapter_registry_workflows"
  | "browser_lane_workflows";

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].sort();
}

function difference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function overlap(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function assertUnique(name: WorkflowSetName, values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`registered_workflow_inventory_duplicate:${name}`);
  }
}

export type RegisteredWorkflowInventoryReadback = {
  schema: typeof REGISTERED_WORKFLOW_INVENTORY_SCHEMA;
  status: "ok";
  interpretation: {
    registered_browser_workflows: string;
    company_automation_catalog_workflows: string;
    browser_lane_workflows: string;
  };
  sets: Record<WorkflowSetName, string[]>;
  relationships: {
    browser_and_catalog_overlap: string[];
    browser_only: string[];
    catalog_only: string[];
    lane_only: string[];
    browser_and_portable_match: boolean;
    catalog_and_adapter_match: boolean;
  };
  browser_lane_bindings: Array<{
    lane_id: string;
    workflow_id: string;
    runner_kind: string;
    canonical_browser_surface: "browser_use_cli";
    visibility: RegisteredBrowserLane["laneVisibility"];
    lifecycle: string;
    profile_ref: string;
    profile_name: string;
    reserved_port: number;
    port_status: "reserved";
    ownership: "workflow_owned";
    binding_status: "registered";
    live_readback_status: "not_claimed";
  }>;
  external_action_executed: false;
};

/**
 * The project has intentionally different registries. Keep them explicit so
 * a dashboard or worker cannot silently treat every "six workflows" phrase as
 * the same execution set.
 */
export function buildRegisteredWorkflowInventoryReadback(): RegisteredWorkflowInventoryReadback {
  const sets: Record<WorkflowSetName, string[]> = {
    registered_browser_workflows: sortedUnique(fixedRegisteredWorkflows.map((workflow) => workflow.id)),
    portable_workflows: sortedUnique(Object.keys(portableWorkflowManifests)),
    company_automation_catalog_workflows: sortedUnique(listRegisteredAutomationCatalog().map((workflow) => workflow.canonicalWorkflowId)),
    workflow_adapter_registry_workflows: sortedUnique(listWorkflowAdapterDefinitions().map((workflow) => workflow.workflow_id)),
    browser_lane_workflows: sortedUnique(registeredBrowserLanes.map((lane) => lane.workflowId))
  };

  (Object.entries(sets) as Array<[WorkflowSetName, string[]]>).forEach(([name, values]) => assertUnique(name, values));

  const browserAndPortableMatch = JSON.stringify(sets.registered_browser_workflows) === JSON.stringify(sets.portable_workflows);
  const catalogAndAdapterMatch = JSON.stringify(sets.company_automation_catalog_workflows) === JSON.stringify(sets.workflow_adapter_registry_workflows);
  if (!browserAndPortableMatch || !catalogAndAdapterMatch) {
    throw new Error("registered_workflow_inventory_internal_registry_mismatch");
  }

  return {
    schema: REGISTERED_WORKFLOW_INVENTORY_SCHEMA,
    status: "ok",
    interpretation: {
      registered_browser_workflows: "Browser Use CLI/portable execution registry (6 fixed workflows)",
      company_automation_catalog_workflows: "Company adoption catalog and adapter registry (6 workflows; includes local-only entries)",
      browser_lane_workflows: "Browser Use lane inventory (7 workflows; includes temporary YouTube transcript lane)"
    },
    sets,
    relationships: {
      browser_and_catalog_overlap: overlap(sets.registered_browser_workflows, sets.company_automation_catalog_workflows),
      browser_only: difference(sets.registered_browser_workflows, sets.company_automation_catalog_workflows),
      catalog_only: difference(sets.company_automation_catalog_workflows, sets.registered_browser_workflows),
      lane_only: difference(sets.browser_lane_workflows, sets.registered_browser_workflows),
      browser_and_portable_match: browserAndPortableMatch,
      catalog_and_adapter_match: catalogAndAdapterMatch
    },
    browser_lane_bindings: registeredBrowserLanes.map((lane) => ({
      lane_id: lane.id,
      workflow_id: lane.workflowId,
      runner_kind: lane.runnerKind,
      canonical_browser_surface: "browser_use_cli" as const,
      visibility: lane.laneVisibility,
      lifecycle: lane.lifecycle,
      profile_ref: publicProfileRef(lane.profileDir),
      profile_name: publicProfileRef(lane.profileDir).split("/").at(-1) ?? publicProfileRef(lane.profileDir),
      reserved_port: lane.reservedPort,
      port_status: "reserved" as const,
      ownership: "workflow_owned" as const,
      binding_status: "registered" as const,
      live_readback_status: "not_claimed" as const
    })),
    external_action_executed: false
  };
}

function publicProfileRef(profileDir: string): string {
  const normalized = profileDir.replaceAll("\\", "/");
  const marker = "/profiles/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex >= 0) return normalized.slice(markerIndex + marker.length);
  return normalized.split("/").filter(Boolean).at(-1) ?? "unknown";
}

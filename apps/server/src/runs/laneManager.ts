import { makeId } from "../db/client.js";
import {
  BROWSER_USE_SCHEDULED_PROFILE_ROOT,
  BROWSER_USE_SINGLE_USE_PROFILE_ROOT,
  BROWSER_USE_TEMPORARY_PROFILE_ROOT
} from "../serviceReadiness/browserUseCanonical.js";
import {
  assertBrowserUseLaneBinding,
  browserUseLaneFor,
  BROWSER_USE_LIFECYCLE_PORT_RANGES,
  profileRootForLifecycle,
  type BrowserUseLifecycle
} from "../serviceReadiness/browserUseLifecycle.js";
import { WEB_OPERATION_CONTRACT_SCHEMA_V1 } from "./webOperationContract.js";

export { BROWSER_USE_LIFECYCLE_PORT_RANGES } from "../serviceReadiness/browserUseLifecycle.js";
export type { BrowserUseLifecycle } from "../serviceReadiness/browserUseLifecycle.js";

export type TaskIntent = {
  id?: string;
  name: string;
  role?: string;
  resources?: string[];
  dangerousAction?: boolean;
};

export type LaneAllocation = {
  id: string;
  taskId: string;
  role: string;
  cdpPort: number;
  profileDir: string;
  workdir: string;
  browserUseSession: string;
  browserUseCdpUrl: string;
  browserUseProfile: string;
  profileStrategy: "browser_use_cli_lifecycle";
  laneVisibility: "visible" | "hidden" | "headless";
  status: "active" | "idle" | "blocked";
  resourceLocks: string[];
  collisionWith: string[];
  lifecycle: BrowserUseLifecycle;
  webOperationContract: typeof WEB_OPERATION_CONTRACT_SCHEMA_V1;
};

export type LanePlan = {
  lanes: LaneAllocation[];
  collisions: Array<{ resource: string; taskIds: string[] }>;
};

export type RegisteredBrowserLane = {
  id: string;
  workflowId: string;
  runnerKind: string;
  cdpPort: number;
  profileDir: string;
  workdir: string;
  browserUseSession: string;
  browserUseCdpUrl: string;
  browserUseProfile: string;
  profileStrategy: "browser_use_cli_lifecycle";
  laneVisibility: "visible" | "hidden" | "headless";
  cleanupStrategy: "port_and_profile_owned_processes";
  browserSurface: "browser_use_cli";
  lifecycle: BrowserUseLifecycle;
  reservedPort: number;
  webOperationContract: typeof WEB_OPERATION_CONTRACT_SCHEMA_V1;
};

export const registeredBrowserLanes: RegisteredBrowserLane[] = [
  registeredLane({
    id: "job-application-manager-browser-use-cli-scheduled",
    workflowId: "job-application-manager",
    runnerKind: "job_manager_registered",
    reservedPort: 19881,
    profileDir: `${BROWSER_USE_SCHEDULED_PROFILE_ROOT}/automation-3`,
    lifecycle: "scheduled",
    laneVisibility: "visible"
  }),
  registeredLane({
    id: "daily-ai-browser-use-cli-scheduled",
    workflowId: "daily-ai-research-publish-run",
    runnerKind: "daily_ai_registered",
    reservedPort: 19882,
    profileDir: `${BROWSER_USE_SCHEDULED_PROFILE_ROOT}/daily-ai`,
    lifecycle: "scheduled",
    laneVisibility: "headless"
  }),
  registeredLane({
    id: "nisenprints-browser-use-cli-scheduled",
    workflowId: "nisenprints-daily-product-canva-printify-etsy-pinterest",
    runnerKind: "nisenprints_registered",
    reservedPort: 19884,
    profileDir: `${BROWSER_USE_SCHEDULED_PROFILE_ROOT}/nisenprints`,
    lifecycle: "scheduled",
    laneVisibility: "headless"
  }),
  registeredLane({
    id: "x-learning-browser-use-cli-scheduled",
    workflowId: "x-authenticated-browser-lane",
    runnerKind: "x_authenticated_browser_lane_registered",
    reservedPort: 19885,
    profileDir: `${BROWSER_USE_SCHEDULED_PROFILE_ROOT}/x-authenticated-browser-lane`,
    lifecycle: "scheduled",
    laneVisibility: "visible"
  }),
  registeredLane({
    id: "youtube-visible-transcript-browser-use-cli-temporary",
    workflowId: "youtube-visible-transcript-capture",
    runnerKind: "youtube_transcript_registered",
    reservedPort: 20080,
    profileDir: `${BROWSER_USE_TEMPORARY_PROFILE_ROOT}/youtube-visible-transcript`,
    lifecycle: "temporary",
    laneVisibility: "visible"
  }),
  registeredLane({
    id: "prompt-transfer-ukiyoe-browser-use-cli-single-use",
    workflowId: "prompt-transfer-ukiyoe",
    runnerKind: "prompt_transfer_registered",
    reservedPort: 19981,
    profileDir: `${BROWSER_USE_SINGLE_USE_PROFILE_ROOT}/prompt-transfer-ukiyoe`,
    lifecycle: "single_use",
    laneVisibility: "headless"
  }),
  registeredLane({
    id: "sns-multi-poster-ukiyoe-browser-use-cli-temporary",
    workflowId: "sns-multi-poster-ukiyoe",
    runnerKind: "sns_multi_poster_registered",
    reservedPort: 20081,
    profileDir: `${BROWSER_USE_TEMPORARY_PROFILE_ROOT}/sns-multi-poster-ukiyoe`,
    lifecycle: "temporary",
    laneVisibility: "visible"
  })
];

assertRegisteredBrowserLaneRegistry();

export function detectResourceCollisions(tasks: TaskIntent[]): LanePlan["collisions"] {
  const usage = new Map<string, string[]>();
  for (const task of tasks) {
    const taskId = task.id ?? task.name;
    for (const resource of task.resources ?? []) {
      const current = usage.get(resource) ?? [];
      current.push(taskId);
      usage.set(resource, current);
    }
  }
  return [...usage.entries()]
    .filter(([, taskIds]) => taskIds.length > 1)
    .map(([resource, taskIds]) => ({ resource, taskIds }));
}

export function allocateParallelLanes(
  tasks: TaskIntent[],
  options: { basePort?: number; profileRoot?: string; workdirRoot?: string; lifecycle?: BrowserUseLifecycle } = {}
): LanePlan {
  const explicitlyAllocated = options.basePort !== undefined || options.profileRoot !== undefined || options.lifecycle !== undefined;
  const lifecycle = options.lifecycle ?? "single_use";
  const range = BROWSER_USE_LIFECYCLE_PORT_RANGES[lifecycle];
  const basePort = options.basePort ?? range.min;
  const profileRoot = options.profileRoot ?? profileRootForLifecycle(lifecycle);
  const workdirRoot = options.workdirRoot ?? "/tmp/automation-os/workdirs";
  if (explicitlyAllocated && (basePort < range.min || basePort > range.max || basePort + Math.max(tasks.length - 1, 0) > range.max)) {
    throw new Error(`browser_use_${lifecycle}_port_range_exhausted`);
  }
  const plannedTasks = tasks.map((task) => ({ ...task, id: task.id ?? makeId("task") }));
  const collisions = detectResourceCollisions(plannedTasks);
  const usedAutomaticPorts = new Map<BrowserUseLifecycle, Set<number>>();

  const lanes = plannedTasks.map((task, index): LaneAllocation => {
    const taskId = task.id!;
    const collisionWith = collisions
      .filter((collision) => collision.taskIds.includes(taskId))
      .map((collision) => collision.resource);
    const taskLifecycle = explicitlyAllocated ? lifecycle : lifecycleForTask(task);
    const taskWorkflowId = workflowIdForTask(task);
    let automaticBinding = browserUseLaneFor({ lifecycle: taskLifecycle, ownerKey: taskId, workflowId: taskWorkflowId });
    if (!explicitlyAllocated) {
      const usedPorts = usedAutomaticPorts.get(taskLifecycle) ?? new Set<number>();
      if (usedPorts.has(automaticBinding.reserved_port)) {
        if (automaticBinding.allocation === "workflow_reserved") {
          throw new Error(`browser_use_${taskLifecycle}_reserved_port_collision`);
        }
        const rangeSize = rangeForLifecycle(taskLifecycle).max - rangeForLifecycle(taskLifecycle).min + 1;
        let reassignedPort: number | undefined;
        for (let offset = 1; offset <= rangeSize; offset += 1) {
          const candidate = rangeForLifecycle(taskLifecycle).min + ((automaticBinding.reserved_port - rangeForLifecycle(taskLifecycle).min + offset) % rangeSize);
          if (!usedPorts.has(candidate)) {
            reassignedPort = candidate;
            break;
          }
        }
        if (reassignedPort === undefined) throw new Error(`browser_use_${taskLifecycle}_port_range_exhausted`);
        automaticBinding = { ...automaticBinding, reserved_port: reassignedPort };
      }
      usedPorts.add(automaticBinding.reserved_port);
      usedAutomaticPorts.set(taskLifecycle, usedPorts);
    }
    const reservedPort = explicitlyAllocated ? basePort + index : automaticBinding.reserved_port;
    const automaticProfile = explicitlyAllocated ? `${profileRoot}/${taskId}` : automaticBinding.profile_dir;
    const automaticSession = explicitlyAllocated ? `browser-use-${safeLaneToken(taskId)}` : automaticBinding.session;
    return {
      id: `lane-${index + 1}`,
      taskId,
      role: task.role ?? task.name,
      cdpPort: reservedPort,
      profileDir: automaticProfile,
      workdir: `${workdirRoot}/${taskId}`,
      browserUseSession: automaticSession,
      browserUseCdpUrl: `http://127.0.0.1:${reservedPort}`,
      browserUseProfile: automaticProfile,
      profileStrategy: "browser_use_cli_lifecycle",
      laneVisibility: "visible",
      status: collisionWith.length > 0 ? "blocked" : "active",
      resourceLocks: task.resources ?? [],
      collisionWith,
      lifecycle: taskLifecycle,
      webOperationContract: WEB_OPERATION_CONTRACT_SCHEMA_V1
    };
  });

  return { lanes, collisions };
}

function rangeForLifecycle(lifecycle: BrowserUseLifecycle): { min: number; max: number } {
  return BROWSER_USE_LIFECYCLE_PORT_RANGES[lifecycle];
}

export function canParallelCommit(approvalGranted: boolean, collisions: LanePlan["collisions"]): boolean {
  return approvalGranted;
}

export function registeredBrowserLaneForWorkflow(workflowId: string): RegisteredBrowserLane | undefined {
  return registeredBrowserLanes.find((lane) => lane.workflowId === workflowId);
}

export function registeredBrowserLaneForRunnerKind(runnerKind: string): RegisteredBrowserLane | undefined {
  return registeredBrowserLanes.find((lane) => lane.runnerKind === runnerKind);
}

export function visibleBrowserLaneForRecordReplay(lane: RegisteredBrowserLane | undefined): RegisteredBrowserLane | undefined {
  if (!lane || process.env.AUTOMATION_OS_DAILY_AI_VISIBLE_BROWSER !== "1") return lane;
  if (lane.runnerKind !== "daily_ai_registered") return lane;
  return { ...lane, laneVisibility: "visible" };
}

export function assertRegisteredBrowserLaneRegistry(): void {
  assertUniqueRegisteredLaneValue("cdpPort", registeredBrowserLanes.map((lane) => String(lane.cdpPort)));
  assertUniqueRegisteredLaneValue("profileDir", registeredBrowserLanes.map((lane) => lane.profileDir));
  assertUniqueRegisteredLaneValue("workflowId", registeredBrowserLanes.map((lane) => lane.workflowId));
  for (const lane of registeredBrowserLanes) {
    const range = BROWSER_USE_LIFECYCLE_PORT_RANGES[lane.lifecycle];
    if (lane.reservedPort < range.min || lane.reservedPort > range.max) {
      throw new Error(`registered_browser_lane_${lane.workflowId}_lifecycle_port_invalid`);
    }
    if (lane.browserSurface !== "browser_use_cli") {
      throw new Error(`registered_browser_lane_${lane.workflowId}_surface_invalid`);
    }
    if (lane.webOperationContract !== WEB_OPERATION_CONTRACT_SCHEMA_V1) {
      throw new Error(`registered_browser_lane_${lane.workflowId}_web_operation_contract_invalid`);
    }
  }
}

function safeLaneToken(value: string): string {
  return value.replace(/[^0-9A-Za-z_.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "task";
}

function lifecycleForTask(task: TaskIntent): BrowserUseLifecycle {
  const haystack = `${task.name} ${(task.resources ?? []).join(" ")}`.toLowerCase();
  if (/temporary|handoff|short-lived|一時/.test(haystack)) return "temporary";
  if (scheduledWorkflowIdForTask(task) || /定期|recurring|scheduled/.test(haystack)) {
    return "scheduled";
  }
  return "single_use";
}

function workflowIdForTask(task: TaskIntent): string {
  const scheduledWorkflowId = scheduledWorkflowIdForTask(task);
  if (scheduledWorkflowId) return scheduledWorkflowId;
  return task.id ?? task.name;
}

/**
 * Registered workflow commands are human-readable and do not always carry the
 * canonical hyphenated workflow id. Resolve those aliases before allocating a
 * lane so profile ownership remains the primary identity and the fixed port is
 * only a derived routing field.
 */
function scheduledWorkflowIdForTask(task: TaskIntent): string | undefined {
  const haystack = `${task.name} ${(task.resources ?? []).join(" ")}`.toLowerCase();
  if (/job-application-manager|job application manager|job manager/.test(haystack)) return "job-application-manager";
  if (/daily-ai-research-publish-run|daily ai/.test(haystack)) return "daily-ai-research-publish-run";
  if (/nisenprints-daily-product-canva-printify-etsy-pinterest|nisenprints/.test(haystack)) return "nisenprints-daily-product-canva-printify-etsy-pinterest";
  if (/x-authenticated-browser-lane|x(?:\.com)? authenticated browser lane/.test(haystack)) return "x-authenticated-browser-lane";
  return undefined;
}

function registeredLane(input: {
  id: string;
  workflowId: string;
  runnerKind: string;
  reservedPort: number;
  profileDir: string;
  lifecycle: BrowserUseLifecycle;
  laneVisibility: RegisteredBrowserLane["laneVisibility"];
}): RegisteredBrowserLane {
  const token = safeLaneToken(input.id);
  const binding = browserUseLaneFor({ lifecycle: input.lifecycle, ownerKey: input.id, workflowId: input.workflowId });
  assertBrowserUseLaneBinding(binding);
  if (binding.reserved_port !== input.reservedPort || binding.profile_dir !== input.profileDir) {
    throw new Error(`registered_browser_lane_${input.workflowId}_binding_drift`);
  }
  return {
    ...input,
    cdpPort: input.reservedPort,
    workdir: `/tmp/automation-os/registered-workdirs/${token}`,
    browserUseSession: `registered-${token}`,
    browserUseCdpUrl: `http://127.0.0.1:${input.reservedPort}`,
    browserUseProfile: input.profileDir,
    profileStrategy: "browser_use_cli_lifecycle",
    cleanupStrategy: "port_and_profile_owned_processes",
    browserSurface: "browser_use_cli",
    reservedPort: input.reservedPort,
    webOperationContract: WEB_OPERATION_CONTRACT_SCHEMA_V1
  };
}

function assertUniqueRegisteredLaneValue(label: string, values: string[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  if (duplicates.size > 0) {
    throw new Error(`registered_browser_lane_${label}_duplicate:${[...duplicates].join(",")}`);
  }
}

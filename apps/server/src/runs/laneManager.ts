import { makeId } from "../db/client.js";

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
  profileStrategy: "cdp_profile_lane";
  laneVisibility: "visible" | "hidden" | "headless";
  status: "active" | "idle" | "blocked";
  resourceLocks: string[];
  collisionWith: string[];
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
  profileStrategy: "cdp_profile_lane";
  laneVisibility: "visible" | "hidden" | "headless";
  cleanupStrategy: "port_and_profile_owned_processes";
};

export const registeredBrowserLanes: RegisteredBrowserLane[] = [
  registeredLane({
    id: "daily-ai-playwright-cli",
    workflowId: "daily-ai-research-publish-run",
    runnerKind: "daily_ai_registered",
    cdpPort: 9333,
    profileDir: "/Users/nichikatanaka/.daily-ai-playwright-chrome",
    laneVisibility: "headless"
  }),
  registeredLane({
    id: "nisenprints-playwright-cli",
    workflowId: "nisenprints-daily-product-canva-printify-etsy-pinterest",
    runnerKind: "nisenprints_registered",
    cdpPort: 9335,
    profileDir: "/Users/nichikatanaka/.nisenprints-playwright-chrome",
    laneVisibility: "headless"
  }),
  registeredLane({
    id: "x-learning-authenticated-cdp",
    workflowId: "x-authenticated-browser-lane",
    runnerKind: "x_authenticated_browser_lane_registered",
    cdpPort: 9336,
    profileDir: "/Users/nichikatanaka/.x-learning-playwright-chrome",
    laneVisibility: "visible"
  }),
  registeredLane({
    id: "youtube-visible-transcript-cdp",
    workflowId: "youtube-visible-transcript-capture",
    runnerKind: "youtube_transcript_registered",
    cdpPort: 9337,
    profileDir: "/Users/nichikatanaka/.youtube-transcript-playwright-chrome",
    laneVisibility: "visible"
  }),
  registeredLane({
    id: "prompt-transfer-ukiyoe-playwright",
    workflowId: "prompt-transfer-ukiyoe",
    runnerKind: "prompt_transfer_registered",
    cdpPort: 9338,
    profileDir: "/Users/nichikatanaka/.prompt-transfer-ukiyoe-playwright-chrome",
    laneVisibility: "headless"
  }),
  registeredLane({
    id: "sns-multi-poster-ukiyoe-playwright",
    workflowId: "sns-multi-poster-ukiyoe",
    runnerKind: "sns_multi_poster_registered",
    cdpPort: 9339,
    profileDir: "/Users/nichikatanaka/.sns-multi-poster-ukiyoe-playwright-chrome",
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
  options: { basePort?: number; profileRoot?: string; workdirRoot?: string } = {}
): LanePlan {
  const basePort = options.basePort ?? 9445;
  const profileRoot = options.profileRoot ?? "/tmp/automation-os/profiles";
  const workdirRoot = options.workdirRoot ?? "/tmp/automation-os/workdirs";
  const plannedTasks = tasks.map((task) => ({ ...task, id: task.id ?? makeId("task") }));
  const collisions = detectResourceCollisions(plannedTasks);

  const lanes = plannedTasks.map((task, index): LaneAllocation => {
    const taskId = task.id!;
    const collisionWith = collisions
      .filter((collision) => collision.taskIds.includes(taskId))
      .map((collision) => collision.resource);
    return {
      id: `lane-${index + 1}`,
      taskId,
      role: task.role ?? task.name,
      cdpPort: basePort + index,
      profileDir: `${profileRoot}/${taskId}`,
      workdir: `${workdirRoot}/${taskId}`,
      browserUseSession: `browser-use-${safeLaneToken(taskId)}`,
      browserUseCdpUrl: `http://127.0.0.1:${basePort + index}`,
      browserUseProfile: `${profileRoot}/${taskId}`,
      profileStrategy: "cdp_profile_lane",
      laneVisibility: "visible",
      status: collisionWith.length > 0 ? "blocked" : "active",
      resourceLocks: task.resources ?? [],
      collisionWith
    };
  });

  return { lanes, collisions };
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
}

function safeLaneToken(value: string): string {
  return value.replace(/[^0-9A-Za-z_.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "task";
}

function registeredLane(input: {
  id: string;
  workflowId: string;
  runnerKind: string;
  cdpPort: number;
  profileDir: string;
  laneVisibility: RegisteredBrowserLane["laneVisibility"];
}): RegisteredBrowserLane {
  const token = safeLaneToken(input.id);
  return {
    ...input,
    workdir: `/tmp/automation-os/registered-workdirs/${token}`,
    browserUseSession: `registered-${token}`,
    browserUseCdpUrl: `http://127.0.0.1:${input.cdpPort}`,
    browserUseProfile: input.profileDir,
    profileStrategy: "cdp_profile_lane",
    cleanupStrategy: "port_and_profile_owned_processes"
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

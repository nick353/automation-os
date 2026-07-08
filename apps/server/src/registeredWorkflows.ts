import { execSql, nowIso, querySql, sqlValue, upsert } from "./db/client.js";
import type { ResearchPlanSnapshot } from "./planner/researchPlanner.js";

export type RegisteredRunnerStatus = "connected" | "registered_runner_pending";

export type RunnerSafetyContract = {
  version: "runner_safety_contract_v1";
  kind: "billing_only_external_action_policy";
  publicKind: "billing_only_hard_stop";
  publicLabel: "課金停止" | "記録";
  externalActionBoundary: "billing_purchase_payment_checkout_hard_stop";
  defaultHardStops: Array<"billing" | "purchase" | "payment" | "checkout">;
  humanInputRequiredWithEvidence: Array<"captcha" | "otp" | "security_code" | "identity_verification">;
  approvedExternalActions: Array<"post" | "save" | "send" | "submit" | "publish">;
  externalActionExecutedByRehearsal: false;
};

export type RegisteredWorkflowDefinition = {
  id: string;
  name: string;
  status: "active";
  runnerStatus: RegisteredRunnerStatus;
  runnerKind:
    | "daily_ai_registered"
    | "nisenprints_registered"
    | "job_submit_registered"
    | "job_followup_registered"
    | "prompt_transfer_registered"
    | "sns_multi_poster_registered"
    | "x_authenticated_browser_lane_registered";
  projectRoot: string;
  startCommand: {
    command: string;
    source: "fixed_automation_os_entrypoint" | "skill" | "native";
  };
  schedule: {
    kind: "cron";
    rrule: string;
  };
  sourceRefs: Array<{
    type: "automation_toml" | "skill" | "native";
    path: string;
    legacyAutomationId?: string;
    skillName?: string;
    nativeSurface?: string;
  }>;
  provenance: {
    source: "fixed_native_registration";
    legacyAutomationId?: string;
    automationTomlPath?: string;
    skillName?: string;
    nativeSurface?: string;
    approvalBoundary?: "billing_purchase_payment_hard_stop" | "billing_purchase_payment_checkout_hard_stop";
    completionBoundary?:
      | "approved_publish_requires_readback"
      | "approved_submit_requires_readback"
      | "approved_send_requires_readback"
      | "sheets_save_requires_readback"
      | "approved_external_post_or_human_input_evidence"
      | "approved_x_action_or_callable_surface_human_input_evidence";
    safetyContract: RunnerSafetyContract;
    codexAppContinuousSync: false;
  };
};

export type ResearchPlanRegisteredWorkflow = {
  id: string;
  name: string;
  status: "active";
  runnerStatus: "connected";
  runnerKind: "research_plan_registered";
  projectRoot: string;
  startCommand: {
    command: string;
    source: "research_plan";
    researchPlanId: string;
    visibleFlow: string[];
  };
  schedule: {
    kind: "cron";
    rrule: string;
    timezone: string;
    label: string;
  };
  sourceRefs: Array<{
    type: "research_plan";
    path: string;
    researchPlanId: string;
  }>;
  provenance: {
    source: "research_plan_regularized";
    researchPlanId: string;
    demoCheckId: string | null;
    codexAppContinuousSync: true;
    snapshotRole: "scheduled_entry_not_completion_proof";
  };
};

export type RegisteredWorkflowRow = {
  id: string;
  name: string;
  status: string;
  runner_status: string;
  runner_kind: string;
  project_root: string;
  start_command_json: string;
  schedule_json: string;
  source_refs_json: string;
  provenance_json: string;
  created_at: string;
  updated_at: string;
};

export type RegisteredWorkflowScheduleFrequency = "daily" | "weekly";

export type RegisteredWorkflowScheduleOverride = {
  frequency: RegisteredWorkflowScheduleFrequency;
  time: string;
  days?: string[];
  updatedAt?: string;
};

const automationsRoot = "/Users/nichikatanaka/.codex/automations";
const newProjectRoot = "/Users/nichikatanaka/Documents/New project";
const skillsRoot = "/Users/nichikatanaka/.agents/skills";
const weekdayOrder = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const weekdayLabels: Record<string, string> = {
  SU: "日",
  MO: "月",
  TU: "火",
  WE: "水",
  TH: "木",
  FR: "金",
  SA: "土"
};
const legacySplitJobWorkflowIds = ["job-application-daily-submit-queue", "job-application-follow-up-inbox-2"];

function automationTomlPath(id: string): string {
  return `${automationsRoot}/${id}/automation.toml`;
}

function fixedWorkflow(input: {
  id: string;
  name: string;
  runnerStatus: RegisteredRunnerStatus;
  runnerKind: RegisteredWorkflowDefinition["runnerKind"];
  projectRoot: string;
  startCommand: string;
  rrule: string;
  startCommandSource?: RegisteredWorkflowDefinition["startCommand"]["source"];
  sourceRefs?: RegisteredWorkflowDefinition["sourceRefs"];
  provenance?: Partial<RegisteredWorkflowDefinition["provenance"]>;
}): RegisteredWorkflowDefinition {
  const path = automationTomlPath(input.id);
  const sourceRefs = input.sourceRefs ?? [{ type: "automation_toml" as const, path, legacyAutomationId: input.id }];
  return {
    id: input.id,
    name: input.name,
    status: "active",
    runnerStatus: input.runnerStatus,
    runnerKind: input.runnerKind,
    projectRoot: input.projectRoot,
    startCommand: {
      command: input.startCommand,
      source: input.startCommandSource ?? "fixed_automation_os_entrypoint"
    },
    schedule: { kind: "cron", rrule: input.rrule },
    sourceRefs,
    provenance: {
      source: "fixed_native_registration",
      legacyAutomationId: input.id,
      automationTomlPath: path,
      safetyContract: runnerSafetyContract(input.provenance?.completionBoundary),
      codexAppContinuousSync: false,
      ...(input.provenance ?? {})
    }
  };
}

function runnerSafetyContract(_completionBoundary: RegisteredWorkflowDefinition["provenance"]["completionBoundary"]): RunnerSafetyContract {
  return {
    version: "runner_safety_contract_v1",
    kind: "billing_only_external_action_policy",
    publicKind: "billing_only_hard_stop",
    publicLabel: "課金停止",
    externalActionBoundary: "billing_purchase_payment_checkout_hard_stop",
    defaultHardStops: ["billing", "purchase", "payment", "checkout"],
    humanInputRequiredWithEvidence: ["captcha", "otp", "security_code", "identity_verification"],
    approvedExternalActions: ["post", "save", "send", "submit", "publish"],
    externalActionExecutedByRehearsal: false
  };
}

export const fixedRegisteredWorkflows: RegisteredWorkflowDefinition[] = [
  fixedWorkflow({
    id: "daily-ai-research-publish-run",
    name: "Daily AI Research + Publish Run",
    runnerStatus: "connected",
    runnerKind: "daily_ai_registered",
    projectRoot: newProjectRoot,
    startCommand: "Daily AI registered workflow run full flow",
    rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
    provenance: {
      approvalBoundary: "billing_purchase_payment_checkout_hard_stop",
      completionBoundary: "approved_publish_requires_readback"
    }
  }),
  fixedWorkflow({
    id: "nisenprints-daily-product-canva-printify-etsy-pinterest",
    name: "NisenPrints Daily Product + Canva + Printify + Etsy + Pinterest",
    runnerStatus: "connected",
    runnerKind: "nisenprints_registered",
    projectRoot: "/Users/nichikatanaka/Documents/Etsy",
    startCommand: "NisenPrints registered workflow billing-only proof gate full publish",
    rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=30;BYSECOND=0",
    provenance: {
      approvalBoundary: "billing_purchase_payment_checkout_hard_stop",
      completionBoundary: "approved_publish_requires_readback"
    }
  }),
  fixedWorkflow({
    id: "job-application-manager",
    name: "Job Application Manager",
    runnerStatus: "connected",
    runnerKind: "job_submit_registered",
    projectRoot: newProjectRoot,
    startCommand: "Job Application Manager registered workflow billing-only inbox readback and submit",
    rrule: "RRULE:FREQ=WEEKLY;BYHOUR=7;BYMINUTE=30;BYDAY=SU,MO,TU,WE,TH,FR,SA",
    sourceRefs: [{ type: "automation_toml", path: automationTomlPath("job-application-manager"), legacyAutomationId: "job-application-manager" }],
    provenance: {
      legacyAutomationId: "job-application-manager",
      automationTomlPath: automationTomlPath("job-application-manager"),
      approvalBoundary: "billing_purchase_payment_checkout_hard_stop",
      completionBoundary: "approved_submit_requires_readback"
    }
  }),
  fixedWorkflow({
    id: "prompt-transfer-ukiyoe",
    name: "Prompt Transfer Ukiyoe",
    runnerStatus: "connected",
    runnerKind: "prompt_transfer_registered",
    projectRoot: "/Users/nichikatanaka/.agents/skills/prompt-transfer-ukiyoe",
    startCommand: "Prompt Transfer Ukiyoe registered workflow billing-only save sheets",
    startCommandSource: "skill",
    rrule: "FREQ=DAILY;BYHOUR=7;BYMINUTE=45;BYSECOND=0",
    sourceRefs: [
      {
        type: "skill",
        path: `${skillsRoot}/prompt-transfer-ukiyoe/SKILL.md`,
        legacyAutomationId: "prompt-transfer-ukiyoe",
        skillName: "prompt-transfer-ukiyoe"
      },
      {
        type: "skill",
        path: `${skillsRoot}/prompt-transfer/SKILL.md`,
        skillName: "prompt-transfer"
      }
    ],
    provenance: {
      skillName: "prompt-transfer-ukiyoe",
      approvalBoundary: "billing_purchase_payment_checkout_hard_stop",
      completionBoundary: "sheets_save_requires_readback"
    }
  }),
  fixedWorkflow({
    id: "sns-multi-poster-ukiyoe",
    name: "SNS Multi Poster Ukiyoe",
    runnerStatus: "connected",
    runnerKind: "sns_multi_poster_registered",
    projectRoot: "/Users/nichikatanaka/.agents/skills/sns-multi-poster-ukiyoe",
    startCommand: "SNS Multi Poster Ukiyoe registered workflow billing-only post publish",
    startCommandSource: "skill",
    rrule: "FREQ=DAILY;BYHOUR=18;BYMINUTE=0;BYSECOND=0",
    sourceRefs: [
      {
        type: "skill",
        path: `${skillsRoot}/sns-multi-poster-ukiyoe/SKILL.md`,
        legacyAutomationId: "sns-multi-poster-ukiyoe",
        skillName: "sns-multi-poster-ukiyoe"
      },
      {
        type: "skill",
        path: `${skillsRoot}/sns-multi-poster/SKILL.md`,
        skillName: "sns-multi-poster"
      }
    ],
    provenance: {
      skillName: "sns-multi-poster-ukiyoe",
      approvalBoundary: "billing_purchase_payment_checkout_hard_stop",
      completionBoundary: "approved_external_post_or_human_input_evidence"
    }
  }),
  fixedWorkflow({
    id: "x-authenticated-browser-lane",
    name: "X Authenticated Browser Lane",
    runnerStatus: "connected",
    runnerKind: "x_authenticated_browser_lane_registered",
    projectRoot: "/Users/nichikatanaka",
    startCommand: "X authenticated browser lane registered workflow billing-only x.com save lane proof",
    startCommandSource: "native",
    rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=0;BYSECOND=0",
    sourceRefs: [
      {
        type: "native",
        path: "automation-os:native:x-authenticated-browser-lane",
        legacyAutomationId: "x-authenticated-browser-lane",
        nativeSurface: "x_authenticated_browser_lane"
      }
    ],
    provenance: {
      nativeSurface: "x_authenticated_browser_lane",
      approvalBoundary: "billing_purchase_payment_checkout_hard_stop",
      completionBoundary: "approved_x_action_or_callable_surface_human_input_evidence"
    }
  })
];

type StoredWorkflowFields = Pick<
  RegisteredWorkflowRow,
  | "id"
  | "name"
  | "status"
  | "runner_status"
  | "runner_kind"
  | "project_root"
  | "start_command_json"
  | "schedule_json"
  | "source_refs_json"
  | "provenance_json"
>;

function storedWorkflowFields(workflow: RegisteredWorkflowDefinition): StoredWorkflowFields {
  return {
    id: workflow.id,
    name: workflow.name,
    status: workflow.status,
    runner_status: workflow.runnerStatus,
    runner_kind: workflow.runnerKind,
    project_root: workflow.projectRoot,
    start_command_json: JSON.stringify(workflow.startCommand),
    schedule_json: JSON.stringify(workflow.schedule),
    source_refs_json: JSON.stringify(workflow.sourceRefs),
    provenance_json: JSON.stringify(workflow.provenance)
  };
}

function storedResearchPlanWorkflowFields(workflow: ResearchPlanRegisteredWorkflow): StoredWorkflowFields {
  return {
    id: workflow.id,
    name: workflow.name,
    status: workflow.status,
    runner_status: workflow.runnerStatus,
    runner_kind: workflow.runnerKind,
    project_root: workflow.projectRoot,
    start_command_json: JSON.stringify(workflow.startCommand),
    schedule_json: JSON.stringify(workflow.schedule),
    source_refs_json: JSON.stringify(workflow.sourceRefs),
    provenance_json: JSON.stringify(workflow.provenance)
  };
}

function mergeRuntimeProvenance(expectedJson: string, existingJson?: string) {
  const expected = parseJson<Record<string, unknown>>(expectedJson, {});
  const existing = parseJson<Record<string, unknown>>(existingJson ?? "{}", {});
  return {
    ...expected,
    ...(existing.scheduler ? { scheduler: existing.scheduler } : {}),
    ...(existing.scheduleControl ? { scheduleControl: existing.scheduleControl } : {})
  };
}

function withRuntimeProvenance(expected: StoredWorkflowFields, existing?: RegisteredWorkflowRow): StoredWorkflowFields {
  if (!existing) return expected;
  return {
    ...expected,
    status: String(existing.status).toLowerCase() === "inactive" ? existing.status : expected.status,
    provenance_json: JSON.stringify(mergeRuntimeProvenance(expected.provenance_json, existing.provenance_json))
  };
}

function workflowMatchesDefinition(existing: RegisteredWorkflowRow, expected: StoredWorkflowFields): boolean {
  return Object.entries(expected).every(([key, value]) => existing[key as keyof StoredWorkflowFields] === value);
}

export function refreshRegisteredWorkflows(definitions: RegisteredWorkflowDefinition[] = fixedRegisteredWorkflows): RegisteredWorkflowRow[] {
  const now = nowIso();
  if (definitions.some((workflow) => workflow.id === "job-application-manager")) {
    execSql(`DELETE FROM registered_workflows WHERE id IN (${legacySplitJobWorkflowIds.map((id) => sqlValue(id)).join(", ")});`);
  }
  const existingRows = definitions.length
    ? querySql<RegisteredWorkflowRow>(`SELECT * FROM registered_workflows WHERE id IN (${definitions.map((workflow) => sqlValue(workflow.id)).join(", ")});`)
    : [];
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  for (const workflow of definitions) {
    const existing = existingById.get(workflow.id);
    const expected = withRuntimeProvenance(storedWorkflowFields(workflow), existing);
    if (existing && workflowMatchesDefinition(existing, expected)) {
      continue;
    }
    upsert("registered_workflows", {
      ...expected,
      created_at: existing?.created_at ?? now,
      updated_at: now
    });
  }
  return listRegisteredWorkflows();
}

export function listRegisteredWorkflows(): RegisteredWorkflowRow[] {
  return querySql<RegisteredWorkflowRow>(`
    SELECT *
    FROM registered_workflows
    ORDER BY
      CASE runner_status
        WHEN 'connected' THEN 0
        WHEN 'registered_runner_pending' THEN 1
        ELSE 2
      END,
      id ASC;
  `);
}

export function getRegisteredWorkflow(id: string): RegisteredWorkflowRow | undefined {
  return querySql<RegisteredWorkflowRow>(`SELECT * FROM registered_workflows WHERE id=${sqlValue(id)} LIMIT 1;`)[0];
}

export function isRegisteredWorkflowSchedulePaused(workflow: Pick<RegisteredWorkflowRow, "provenance_json">): boolean {
  const provenance = parseJson<{ scheduleControl?: { paused?: unknown } }>(workflow.provenance_json, {});
  return provenance.scheduleControl?.paused === true;
}

export function getRegisteredWorkflowScheduleOverride(workflow: Pick<RegisteredWorkflowRow, "provenance_json">): RegisteredWorkflowScheduleOverride | undefined {
  const provenance = parseJson<{ scheduleControl?: { scheduleOverride?: unknown } }>(workflow.provenance_json, {});
  return normalizeScheduleOverride(provenance.scheduleControl?.scheduleOverride);
}

export function getRegisteredWorkflowEffectiveSchedule(workflow: Pick<RegisteredWorkflowRow, "schedule_json" | "provenance_json">): { rrule: string; label: string } {
  const override = getRegisteredWorkflowScheduleOverride(workflow);
  if (override) return scheduleOverrideToEffectiveSchedule(override);
  const schedule = parseJson<{ label?: unknown; rrule?: unknown }>(workflow.schedule_json, {});
  const rrule = typeof schedule.rrule === "string" ? schedule.rrule : "";
  const label = typeof schedule.label === "string" && schedule.label.trim()
    ? schedule.label
    : publicScheduleLabel(rrule);
  return { rrule, label };
}

export function setRegisteredWorkflowSchedulePaused(id: string, paused: boolean): RegisteredWorkflowRow | undefined {
  const workflow = getRegisteredWorkflow(id);
  if (!workflow) return undefined;
  const provenance = parseJson<Record<string, unknown>>(workflow.provenance_json, {});
  const scheduleControl = typeof provenance.scheduleControl === "object" && provenance.scheduleControl
    ? provenance.scheduleControl as Record<string, unknown>
    : {};
  const now = nowIso();
  upsert("registered_workflows", {
    ...workflow,
    provenance_json: {
      ...provenance,
      scheduleControl: {
        ...scheduleControl,
        paused,
        ...(paused ? { pausedAt: now } : { resumedAt: now })
      }
    },
    updated_at: now
  });
  return getRegisteredWorkflow(id);
}

export function setRegisteredWorkflowScheduleOverride(id: string, input: unknown): RegisteredWorkflowRow | undefined {
  const workflow = getRegisteredWorkflow(id);
  if (!workflow) return undefined;
  const scheduleOverride = parseScheduleOverrideInput(input);
  const provenance = parseJson<Record<string, unknown>>(workflow.provenance_json, {});
  const scheduleControl = typeof provenance.scheduleControl === "object" && provenance.scheduleControl
    ? provenance.scheduleControl as Record<string, unknown>
    : {};
  const now = nowIso();
  upsert("registered_workflows", {
    ...workflow,
    provenance_json: {
      ...provenance,
      scheduleControl: {
        ...scheduleControl,
        scheduleOverride: {
          ...scheduleOverride,
          updatedAt: now
        }
      }
    },
    updated_at: now
  });
  return getRegisteredWorkflow(id);
}

export function researchPlanRegisteredWorkflowId(planId: string): string {
  const safePlanId = planId.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "research-plan";
  return `research-plan-${safePlanId}`.slice(0, 120);
}

export function registerResearchPlanWorkflow(plan: ResearchPlanSnapshot, rrule = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0"): RegisteredWorkflowRow {
  const now = nowIso();
  const workflow: ResearchPlanRegisteredWorkflow = {
    id: researchPlanRegisteredWorkflowId(plan.id),
    name: plan.title || plan.command,
    status: "active",
    runnerStatus: "connected",
    runnerKind: "research_plan_registered",
    projectRoot: "/Users/nichikatanaka/Documents/Codex/automation-os",
    startCommand: {
      command: plan.command,
      source: "research_plan",
      researchPlanId: plan.id,
      visibleFlow: plan.visibleFlow
    },
    schedule: {
      kind: "cron",
      rrule,
      timezone: "Asia/Taipei",
      label: dailyRruleLabel(rrule)
    },
    sourceRefs: [{ type: "research_plan", path: `research_plans:${plan.id}`, researchPlanId: plan.id }],
    provenance: {
      source: "research_plan_regularized",
      researchPlanId: plan.id,
      demoCheckId: plan.demoCheckId,
      codexAppContinuousSync: true,
      snapshotRole: "scheduled_entry_not_completion_proof"
    }
  };
  const existing = getRegisteredWorkflow(workflow.id);
  const expected = withRuntimeProvenance(storedResearchPlanWorkflowFields(workflow), existing);
  upsert("registered_workflows", {
    ...expected,
    created_at: existing?.created_at ?? now,
    updated_at: now
  });
  return getRegisteredWorkflow(workflow.id) as RegisteredWorkflowRow;
}

function dailyRruleLabel(rrule: string): string {
  return publicScheduleLabel(rrule);
}

export function listOrSeedRegisteredWorkflows(): RegisteredWorkflowRow[] {
  return refreshRegisteredWorkflows();
}

export function initRegisteredWorkflows(): RegisteredWorkflowRow[] {
  return listOrSeedRegisteredWorkflows();
}

export function findFixedRegisteredWorkflow(id: string): RegisteredWorkflowDefinition | undefined {
  return fixedRegisteredWorkflows.find((workflow) => workflow.id === id);
}

export function getRegisteredWorkflowStartCommand(id: string): string | undefined {
  const fixedCommand = findFixedRegisteredWorkflow(id)?.startCommand.command;
  if (fixedCommand) return fixedCommand;
  const workflow = getRegisteredWorkflow(id);
  if (!workflow || workflow.runner_kind !== "research_plan_registered") return undefined;
  const startCommand = parseJson<{ command?: unknown }>(workflow.start_command_json, {});
  return typeof startCommand.command === "string" ? startCommand.command : undefined;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseScheduleOverrideInput(input: unknown): RegisteredWorkflowScheduleOverride {
  const value = typeof input === "object" && input ? input as Record<string, unknown> : {};
  const frequency = value.frequency === "daily" || value.frequency === "weekly" ? value.frequency : undefined;
  if (!frequency) throw new Error("invalid_schedule_frequency");
  const time = typeof value.time === "string" ? value.time.trim() : "";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("invalid_schedule_time");
  const days = normalizeScheduleDays(value.days);
  return {
    frequency,
    time,
    ...(frequency === "weekly" && days.length > 0 ? { days } : {})
  };
}

function normalizeScheduleOverride(input: unknown): RegisteredWorkflowScheduleOverride | undefined {
  try {
    return parseScheduleOverrideInput(input);
  } catch {
    return undefined;
  }
}

function normalizeScheduleDays(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const normalized = input
    .map((day) => String(day).trim().toUpperCase())
    .filter((day): day is typeof weekdayOrder[number] => weekdayOrder.includes(day as typeof weekdayOrder[number]));
  return [...new Set(normalized)].sort((a, b) => weekdayOrder.indexOf(a as typeof weekdayOrder[number]) - weekdayOrder.indexOf(b as typeof weekdayOrder[number]));
}

function scheduleOverrideToEffectiveSchedule(override: RegisteredWorkflowScheduleOverride): { rrule: string; label: string } {
  const [hour, minute] = override.time.split(":");
  const byTime = `BYHOUR=${Number(hour)};BYMINUTE=${Number(minute)};BYSECOND=0`;
  if (override.frequency === "weekly") {
    const days = override.days?.length ? override.days : undefined;
    return {
      rrule: `FREQ=WEEKLY;${byTime}${days ? `;BYDAY=${days.join(",")}` : ""}`,
      label: `毎週 ${override.time}${days ? ` ${days.map((day) => weekdayLabels[day] ?? day).join("")}` : ""}`
    };
  }
  return {
    rrule: `FREQ=DAILY;${byTime}`,
    label: `毎日 ${override.time}`
  };
}

function publicScheduleLabel(rrule: string) {
  const hour = Number(rrule.match(/BYHOUR=(\d{1,2})/)?.[1] ?? NaN);
  const minute = Number(rrule.match(/BYMINUTE=(\d{1,2})/)?.[1] ?? 0);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return "登録済み";
  }
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  const byDay = rrule.match(/BYDAY=([A-Z,]+)/)?.[1]?.split(",").filter(Boolean) ?? [];
  if (/FREQ=WEEKLY/.test(rrule) && !/BYDAY=SU,MO,TU,WE,TH,FR,SA/.test(rrule)) {
    return `毎週 ${time}${byDay.length ? ` ${byDay.map((day) => weekdayLabels[day] ?? day).join("")}` : ""}`;
  }
  return `毎日 ${time}`;
}

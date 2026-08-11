import { nowIso, querySql, sqlValue } from "../db/client.js";
import { requireExistingServiceIdentity } from "../companies/repository.js";
import { materializeDueAutomationOccurrences } from "./automationScheduler.js";
import { materializeDuePortableAutomationOccurrences } from "./portableAutomationScheduler.js";
import type { DurableScheduleOccurrence } from "./durableQueue.js";

export type DurableAutomationSchedulerOnceResult = {
  schema: "aos.durable_scheduler_tick.v1";
  status: "idle" | "completed" | "blocked";
  checkedAt: string;
  serviceUserConfigured: boolean;
  checkedCompanyIds: string[];
  initializedScheduleIds: string[];
  handledScheduleIds: string[];
  occurrences: DurableScheduleOccurrence[];
  portableRunIds: string[];
  portableScheduleIds: string[];
  portableWorkflowIds: string[];
  localWorkflowIds: string[];
  skippedCompanyIds: string[];
  exactBlocker: string | null;
  externalActionExecuted: false;
  nextAction: string;
};

export type DurableSchedulerOwner = "server" | "worker";

export function durableSchedulerOwner(env: NodeJS.ProcessEnv = process.env): DurableSchedulerOwner {
  return env.AUTOMATION_OS_DURABLE_SCHEDULER_OWNER?.trim().toLowerCase() === "worker" ? "worker" : "server";
}

type SchedulerInput = {
  serviceUserId?: string;
  now?: string;
  limit?: number;
};

/**
 * AOS-owned scheduler tick. It only materializes due work into the durable
 * queue; a worker/provider is a separate consumer and is never called here.
 */
export async function runDurableAutomationSchedulerOnce(input: SchedulerInput = {}): Promise<DurableAutomationSchedulerOnceResult> {
  const checkedAt = normalizedTime(input.now ?? nowIso());
  const companyIds = listActiveScheduledCompanyIds();
  const configuredServiceUserId = (input.serviceUserId ?? process.env.AUTOMATION_OS_DURABLE_SERVICE_USER_ID ?? "").trim();
  const base = {
    schema: "aos.durable_scheduler_tick.v1" as const,
    checkedAt,
    serviceUserConfigured: Boolean(configuredServiceUserId),
    checkedCompanyIds: companyIds,
    initializedScheduleIds: [] as string[],
    handledScheduleIds: [] as string[],
    occurrences: [] as DurableScheduleOccurrence[],
    portableRunIds: [] as string[],
    portableScheduleIds: [] as string[],
    portableWorkflowIds: [] as string[],
    localWorkflowIds: [] as string[],
    skippedCompanyIds: [] as string[],
    externalActionExecuted: false as const
  };
  if (companyIds.length === 0) {
    return {
      ...base,
      status: "idle",
      exactBlocker: null,
      nextAction: "activeな定期スケジュールはありません。"
    };
  }
  if (!configuredServiceUserId) {
    return {
      ...base,
      status: "blocked",
      exactBlocker: "durable_scheduler_service_user_id_missing",
      nextAction: "operator権限を持つservice userをAUTOMATION_OS_DURABLE_SERVICE_USER_IDへ設定してください。"
    };
  }
  try {
    requireExistingServiceIdentity(configuredServiceUserId);
  } catch {
    return {
      ...base,
      status: "blocked",
      exactBlocker: "durable_scheduler_service_user_id_invalid",
      nextAction: "設定したservice userのactive service identityを確認してください。"
    };
  }
  const authorizedCompanyIds = new Set(listServiceUserCompanyIds(configuredServiceUserId));
  const unscopedCompany = companyIds.find((companyId) => !authorizedCompanyIds.has(companyId));
  if (unscopedCompany) {
    return {
      ...base,
      status: "blocked",
      exactBlocker: "durable_scheduler_service_user_scope_incomplete",
      nextAction: `service userへcompany ${unscopedCompany} のoperator membershipを付与するか、正しいscheduler identityを設定してください。`
    };
  }
  const limit = boundedLimit(input.limit ?? 100);
  const blockers: string[] = [];
  for (const companyId of companyIds) {
    try {
      const portable = await materializeDuePortableAutomationOccurrences({
        companyId,
        serviceUserId: configuredServiceUserId,
        now: checkedAt,
        limit
      });
      base.initializedScheduleIds.push(...portable.initializedScheduleIds);
      base.handledScheduleIds.push(...portable.handledScheduleIds);
      base.portableRunIds.push(...portable.runIds);
      base.portableScheduleIds.push(...portable.portableScheduleIds);
      base.portableWorkflowIds.push(...portable.workflowIds);
      base.localWorkflowIds.push(...portable.localWorkflowIds);
      blockers.push(...portable.blocked.map((item) => item.exactBlocker));
      const result = materializeDueAutomationOccurrences({
        companyId,
        serviceUserId: configuredServiceUserId,
        now: checkedAt,
        limit,
        excludeScheduleIds: portable.handledScheduleIds
      });
      base.initializedScheduleIds.push(...result.initializedScheduleIds);
      base.occurrences.push(...result.occurrences);
    } catch (error) {
      const exactBlocker = error instanceof Error ? error.message : "durable_scheduler_company_tick_failed";
      // Another AOS scheduler or worker may win the schedule CAS. That is a
      // normal duplicate-tick outcome and must not be reported as a run.
      if (exactBlocker === "automation_schedule_revision_or_due_conflict") {
        base.skippedCompanyIds.push(companyId);
      } else {
        blockers.push(exactBlocker);
        base.skippedCompanyIds.push(companyId);
      }
    }
  }
  const exactBlocker = blockers[0] ?? null;
  return {
    ...base,
    status: exactBlocker ? "blocked" : "completed",
    exactBlocker,
    nextAction: exactBlocker
      ? "exact blockerをreadbackしてから、同じtickを盲目的に再試行せず設定または依存を修正してください。"
      : base.occurrences.length > 0
        ? "durable queueへmaterializeしました。worker/providerはqueueをclaimして結果をreadbackします。"
        : base.portableRunIds.length > 0
          ? "AOS portable Mac-worker queueへmaterializeしました。Mac workerがclaimしてreadbackします。"
        : "dueな定期実行はありません。次のscheduler tickを待ちます。"
  };
}

function listActiveScheduledCompanyIds(): string[] {
  return querySql<{ company_id: string }>(`
    SELECT DISTINCT schedule.company_id
    FROM mvp_automation_schedules schedule
    JOIN mvp_automations automation
      ON automation.id=schedule.automation_id AND automation.company_id=schedule.company_id
    WHERE schedule.enabled=1 AND schedule.status='active' AND schedule.kind!='manual'
      AND automation.status='active'
    ORDER BY schedule.company_id
  `).map((row) => row.company_id);
}

function listServiceUserCompanyIds(serviceUserId: string): string[] {
  return querySql<{ company_id: string }>(`
    SELECT membership.company_id
    FROM company_memberships membership
    JOIN users ON users.id=membership.user_id
    JOIN companies ON companies.id=membership.company_id
    WHERE membership.user_id=${sqlValue(serviceUserId)}
      AND membership.role='operator' AND membership.status='active'
      AND users.status='active' AND users.kind='service' AND companies.status!='archived'
    ORDER BY membership.company_id
  `).map((row) => row.company_id);
}

function normalizedTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("durable_scheduler_time_invalid");
  return new Date(timestamp).toISOString();
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) throw new Error("durable_scheduler_limit_invalid");
  return value;
}

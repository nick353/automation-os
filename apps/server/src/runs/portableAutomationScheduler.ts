import { nowIso, querySql, runSqlTransaction, sqlValue } from "../db/client.js";
import { requireExistingCompanyAccess, requireExistingServiceIdentity } from "../companies/repository.js";
import { startPortableWorkflowRun } from "./portableWorkflowEntrypoint.js";
import { computeNextAutomationOccurrence } from "./automationScheduler.js";
import {
  portableReadOnlyStageForScheduledWorkflow,
  portableScheduleDueKey,
  portableScheduleIdempotencyKey,
  portableWorkflowIdForRegisteredAutomation,
  portableLocalWorkflowIdForRegisteredAutomation
} from "./portableScheduleDispatch.js";
import type { PortableWorkflowId } from "./portableWorkflowContract.js";
import { portableLocalReadOnlyStageForScheduledWorkflow, type PortableLocalWorkflowId } from "./portableLocalWorkflow.js";
import { startPortableLocalWorkflowRun } from "./portableLocalWorkflowEntrypoint.js";

type PortableScheduleRow = {
  id: string;
  company_id: string;
  automation_id: string;
  automation_version_id: string;
  kind: "manual" | "daily" | "weekly" | "cron";
  expression: string | null;
  timezone: string;
  revision: number;
  next_run_at: string | null;
  updated_at: string;
  worker_command_kind: string;
  builder_spec_json: string;
};

export type PortableAutomationSchedulerResult = {
  initializedScheduleIds: string[];
  handledScheduleIds: string[];
  portableScheduleIds: string[];
  runIds: string[];
  workflowIds: PortableWorkflowId[];
  localWorkflowIds: PortableLocalWorkflowId[];
  blocked: Array<{ scheduleId: string; workflowId: string | null; exactBlocker: string }>;
};

/**
 * Materialize AOS-owned registered browser schedules directly into the
 * portable Mac-worker run queue. This is separate from the generic durable
 * dry-run materializer so a scheduled Web workflow cannot silently fall back
 * to a Codex/root-owned runner.
 */
export async function materializeDuePortableAutomationOccurrences(input: {
  companyId: string;
  serviceUserId: string;
  now?: string;
  limit?: number;
}): Promise<PortableAutomationSchedulerResult> {
  const companyId = required(input.companyId, "company_id_required");
  const serviceUserId = required(input.serviceUserId, "service_user_id_required");
  requireExistingServiceIdentity(serviceUserId);
  requireExistingCompanyAccess(companyId, ["operator"], serviceUserId);
  const now = normalizedTime(input.now ?? nowIso(), "scheduler_time_invalid");
  const limit = boundedLimit(input.limit ?? 100);
  const result: PortableAutomationSchedulerResult = {
    initializedScheduleIds: [],
    handledScheduleIds: [],
    portableScheduleIds: [],
    runIds: [],
    workflowIds: [],
    localWorkflowIds: [],
    blocked: []
  };
  const rows = querySql<PortableScheduleRow>(`
    SELECT schedule.id, schedule.company_id, schedule.automation_id, schedule.automation_version_id,
           schedule.kind, schedule.expression, schedule.timezone, schedule.revision,
           schedule.next_run_at, schedule.updated_at,
           automation.worker_command_kind, automation.builder_spec_json
    FROM mvp_automation_schedules schedule
    JOIN mvp_automations automation
      ON automation.id=schedule.automation_id AND automation.company_id=schedule.company_id
    WHERE schedule.company_id=${sqlValue(companyId)} AND schedule.enabled=1 AND schedule.status='active'
      AND automation.status='active' AND schedule.kind!='manual'
    ORDER BY COALESCE(schedule.next_run_at, schedule.updated_at) ASC, schedule.id ASC
    LIMIT ${limit}
  `);

  for (const row of rows) {
    const builderSpec = parseObject(row.builder_spec_json);
    const workflowId = portableWorkflowIdForRegisteredAutomation({
      workerCommandKind: row.worker_command_kind,
      builderSpec
    });
    const localWorkflowId = portableLocalWorkflowIdForRegisteredAutomation({
      workerCommandKind: row.worker_command_kind,
      builderSpec
    });
    const isRegisteredAdoption = builderSpec.schema === "aos.registered_automation_adoption.v1";
    if (!workflowId && !localWorkflowId) {
      if (isRegisteredAdoption) {
        if (!row.next_run_at) {
          const nextRunAt = computeNextAutomationOccurrence(row, now);
          try {
            runSqlTransaction([{
              sql: `UPDATE mvp_automation_schedules SET next_run_at=${sqlValue(nextRunAt)}, updated_at=${sqlValue(now)}
                    WHERE id=${sqlValue(row.id)} AND company_id=${sqlValue(companyId)}
                      AND enabled=1 AND status='active' AND revision=${row.revision} AND next_run_at IS NULL`,
              expectChanges: 1
            }]);
            result.initializedScheduleIds.push(row.id);
          } catch (error) {
            if (!(error instanceof Error && error.message.includes("sql_transaction_expected_changes"))) throw error;
          }
          continue;
        }
        if (Date.parse(normalizedTime(row.next_run_at, "scheduler_next_run_time_invalid")) <= Date.parse(now)) {
          result.handledScheduleIds.push(row.id);
          result.blocked.push({
            scheduleId: row.id,
            workflowId: null,
            exactBlocker: `portable_registered_adapter_missing:${row.worker_command_kind || "worker_command_kind_missing"}`
          });
        }
      }
      continue;
    }
    result.handledScheduleIds.push(row.id);
    result.portableScheduleIds.push(row.id);
    if (!row.next_run_at) {
      const nextRunAt = computeNextAutomationOccurrence(row, now);
      try {
        runSqlTransaction([{
          sql: `UPDATE mvp_automation_schedules SET next_run_at=${sqlValue(nextRunAt)}, updated_at=${sqlValue(now)}
                WHERE id=${sqlValue(row.id)} AND company_id=${sqlValue(companyId)}
                  AND enabled=1 AND status='active' AND revision=${row.revision} AND next_run_at IS NULL`,
          expectChanges: 1
        }]);
        result.initializedScheduleIds.push(row.id);
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("sql_transaction_expected_changes"))) throw error;
      }
      continue;
    }
    const scheduledFor = normalizedTime(row.next_run_at, "scheduler_next_run_time_invalid");
    if (Date.parse(scheduledFor) > Date.parse(now)) continue;
    const nextRunAt = computeNextAutomationOccurrence(row, scheduledFor);
    const dueKey = portableScheduleDueKey(row.id, scheduledFor);
    const idempotencyKey = portableScheduleIdempotencyKey(companyId, row.id, scheduledFor);
    try {
      const started = workflowId
        ? await startPortableWorkflowRun({
            workflowId,
            sourceTrigger: "automation_os_scheduler",
            idempotencyKey,
            companyId,
            dueKey,
            readOnlyStage: portableReadOnlyStageForScheduledWorkflow(workflowId)
          })
        : await startPortableLocalWorkflowRun({
            workflowId: localWorkflowId!,
            sourceTrigger: "automation_os_scheduler",
            idempotencyKey,
            companyId,
            dueKey,
            readOnlyStage: portableLocalReadOnlyStageForScheduledWorkflow(localWorkflowId!)
          });
      runSqlTransaction([{
        sql: `UPDATE mvp_automation_schedules SET last_run_at=${sqlValue(scheduledFor)}, next_run_at=${sqlValue(nextRunAt)}, updated_at=${sqlValue(now)}
              WHERE id=${sqlValue(row.id)} AND company_id=${sqlValue(companyId)}
                AND enabled=1 AND status='active' AND revision=${row.revision} AND next_run_at=${sqlValue(scheduledFor)}`,
        expectChanges: 1
      }]);
      result.runIds.push(started.runId);
      if (workflowId) result.workflowIds.push(workflowId);
      else result.localWorkflowIds.push(localWorkflowId!);
    } catch (error) {
      result.blocked.push({
        scheduleId: row.id,
        workflowId: workflowId ?? localWorkflowId,
        exactBlocker: error instanceof Error ? error.message.slice(0, 240) : "portable_scheduler_dispatch_failed"
      });
    }
  }
  return result;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizedTime(value: string, code: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(code);
  return new Date(timestamp).toISOString();
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) throw new Error("scheduler_limit_invalid");
  return value;
}

function required(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(code);
  return normalized;
}

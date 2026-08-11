import { nowIso, querySql, runSqlTransaction, sqlValue } from "../db/client.js";
import { requireExistingCompanyAccess, requireExistingServiceIdentity } from "../companies/repository.js";
import { materializeDurableScheduleOccurrence, type DurableScheduleOccurrence } from "./durableQueue.js";

type ScheduleRow = {
  id: string;
  company_id: string;
  kind: "manual" | "daily" | "weekly" | "cron";
  expression: string | null;
  timezone: string;
  revision: number;
  next_run_at: string | null;
  updated_at: string;
};

export class AutomationSchedulerError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "AutomationSchedulerError";
  }
}

export function materializeDueAutomationOccurrences(input: {
  companyId: string;
  serviceUserId: string;
  now?: string;
  limit?: number;
  excludeScheduleIds?: readonly string[];
}): { initializedScheduleIds: string[]; occurrences: DurableScheduleOccurrence[] } {
  const companyId = required(input.companyId, "company_id_required");
  const serviceUserId = required(input.serviceUserId, "service_user_id_required");
  requireExistingServiceIdentity(serviceUserId);
  requireExistingCompanyAccess(companyId, ["operator"], serviceUserId);
  const now = normalizedTime(input.now ?? nowIso(), "scheduler_time_invalid");
  const limit = boundedLimit(input.limit ?? 100);
  const initializedScheduleIds: string[] = [];
  const occurrences: DurableScheduleOccurrence[] = [];
  const excludedScheduleIds = new Set(input.excludeScheduleIds ?? []);

  const schedules = querySql<ScheduleRow>(`
    SELECT schedule.id, schedule.company_id, schedule.kind, schedule.expression, schedule.timezone, schedule.revision,
           schedule.next_run_at, schedule.updated_at
    FROM mvp_automation_schedules schedule
    JOIN mvp_automations automation
      ON automation.id=schedule.automation_id AND automation.company_id=schedule.company_id
    WHERE schedule.company_id=${sqlValue(companyId)} AND schedule.enabled=1 AND schedule.status='active'
      AND automation.status='active' AND schedule.kind!='manual'
    ORDER BY COALESCE(schedule.next_run_at, schedule.updated_at) ASC, schedule.id ASC
    LIMIT ${limit}
  `);

  for (const schedule of schedules) {
    if (excludedScheduleIds.has(schedule.id)) continue;
    if (!schedule.next_run_at) {
      const nextRunAt = computeNextAutomationOccurrence(schedule, now);
      try {
        runSqlTransaction([{
          sql: `UPDATE mvp_automation_schedules SET next_run_at=${sqlValue(nextRunAt)}, updated_at=${sqlValue(now)}
                WHERE id=${sqlValue(schedule.id)} AND company_id=${sqlValue(companyId)}
                  AND enabled=1 AND status='active' AND revision=${schedule.revision} AND next_run_at IS NULL`,
          expectChanges: 1
        }]);
        initializedScheduleIds.push(schedule.id);
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("sql_transaction_expected_changes"))) throw error;
      }
      continue;
    }
    const dueAt = normalizedTime(schedule.next_run_at, "scheduler_next_run_time_invalid");
    if (Date.parse(dueAt) > Date.parse(now)) continue;
    const nextRunAt = computeNextAutomationOccurrence(schedule, dueAt);
    const materialized = materializeDurableScheduleOccurrence({
      companyId,
      serviceUserId,
      scheduleId: schedule.id,
      scheduledFor: dueAt,
      expectedScheduleRevision: schedule.revision,
      nextRunAt,
      payload: { scheduler_source: "durable_scheduler" }
    });
    occurrences.push(materialized.occurrence);
  }
  return { initializedScheduleIds, occurrences };
}

export function computeNextAutomationOccurrence(
  schedule: Pick<ScheduleRow, "kind" | "expression" | "timezone">,
  after: string
): string {
  const afterTime = Date.parse(normalizedTime(after, "scheduler_after_time_invalid"));
  const expression = required(schedule.expression ?? "", "scheduler_expression_required");
  const cron = schedule.kind === "daily"
    ? dailyToCron(expression)
    : schedule.kind === "weekly"
      ? weeklyToCron(expression)
      : schedule.kind === "cron"
        ? expression
        : (() => { throw new AutomationSchedulerError("scheduler_manual_has_no_occurrence"); })();
  const fields = parseCron(cron);
  validateTimezone(schedule.timezone);
  let candidate = Math.floor(afterTime / 60_000) * 60_000 + 60_000;
  const max = candidate + 370 * 24 * 60 * 60_000;
  for (; candidate <= max; candidate += 60_000) {
    const parts = zonedParts(new Date(candidate), schedule.timezone);
    if (matchesField(fields.minute, parts.minute, 0, 59)
      && matchesField(fields.hour, parts.hour, 0, 23)
      && matchesField(fields.day, parts.day, 1, 31)
      && matchesField(fields.month, parts.month, 1, 12)
      && matchesField(fields.weekday, parts.weekday, 0, 6)) {
      return new Date(candidate).toISOString();
    }
  }
  throw new AutomationSchedulerError("scheduler_next_occurrence_not_found");
}

function dailyToCron(expression: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(expression.trim());
  if (!match) throw new AutomationSchedulerError("scheduler_daily_expression_invalid");
  return `${Number(match[2])} ${Number(match[1])} * * *`;
}

function weeklyToCron(expression: string): string {
  const match = /^(SUN|MON|TUE|WED|THU|FRI|SAT)\s+(\d{1,2}):(\d{2})$/i.exec(expression.trim());
  if (!match) throw new AutomationSchedulerError("scheduler_weekly_expression_invalid");
  const weekday = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"].indexOf(match[1].toUpperCase());
  return `${Number(match[3])} ${Number(match[2])} * * ${weekday}`;
}

function parseCron(expression: string): { minute: string; hour: string; day: string; month: string; weekday: string } {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new AutomationSchedulerError("scheduler_cron_expression_invalid");
  return { minute: fields[0], hour: fields[1], day: fields[2], month: fields[3], weekday: fields[4] };
}

function matchesField(expression: string, value: number, min: number, max: number): boolean {
  return expression.split(",").some((part) => {
    const token = part.trim();
    if (token === "*") return true;
    const stepMatch = /^\*\/(\d+)$/.exec(token);
    if (stepMatch) {
      const step = Number(stepMatch[1]);
      if (!Number.isSafeInteger(step) || step < 1) throw new AutomationSchedulerError("scheduler_cron_expression_invalid");
      return (value - min) % step === 0;
    }
    const rangeMatch = /^(\d+)-(\d+)$/.exec(token);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start < min || end > max || start > end) throw new AutomationSchedulerError("scheduler_cron_expression_invalid");
      return value >= start && value <= end;
    }
    const exact = Number(token);
    if (!/^\d+$/.test(token) || exact < min || exact > max) throw new AutomationSchedulerError("scheduler_cron_expression_invalid");
    return value === exact;
  });
}

function zonedParts(date: Date, timezone: string): { minute: number; hour: number; day: number; month: number; weekday: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour12: false,
    hourCycle: "h23",
    minute: "2-digit",
    hour: "2-digit",
    day: "2-digit",
    month: "2-digit",
    weekday: "short"
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  return { minute: Number(parts.minute), hour: Number(parts.hour), day: Number(parts.day), month: Number(parts.month), weekday };
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new AutomationSchedulerError("scheduler_timezone_invalid");
  }
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) throw new AutomationSchedulerError("scheduler_limit_invalid");
  return value;
}

function normalizedTime(value: string, code: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new AutomationSchedulerError(code);
  return new Date(timestamp).toISOString();
}

function required(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) throw new AutomationSchedulerError(code);
  return normalized;
}

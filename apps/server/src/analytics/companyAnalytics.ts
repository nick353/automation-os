import { querySql, sqlValue } from "../db/client.js";

export class CompanyAnalyticsError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "CompanyAnalyticsError";
  }
}

type JobRow = {
  id: string;
  automation_id: string;
  status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type ApprovalRow = {
  id: string;
  job_id: string;
  status: string;
  created_at: string;
  decided_at: string | null;
  updated_at?: string | null;
};

type AutomationRow = { id: string; name: string };

export type CompanyAnalyticsQuery = {
  companyId: string;
  from: string;
  to: string;
  automationId?: string | null;
};

const terminalStatuses = new Set(["completed", "failed", "cancelled", "timed_out", "reconciliation_required"]);

export function buildCompanyAnalytics(input: CompanyAnalyticsQuery) {
  const companyId = required(input.companyId, "company_id_required");
  const from = normalizedTimestamp(input.from, "analytics_from_invalid");
  const to = normalizedTimestamp(input.to, "analytics_to_invalid");
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (fromMs > toMs) throw new CompanyAnalyticsError("analytics_range_invalid");
  if (toMs - fromMs > 366 * 24 * 60 * 60 * 1000) throw new CompanyAnalyticsError("analytics_range_too_large");
  const automationId = input.automationId ? required(input.automationId, "analytics_automation_id_invalid") : null;
  const automationPredicate = automationId ? ` AND automation_id=${sqlValue(automationId)}` : "";

  const jobs = querySql<JobRow>(`
    SELECT id, automation_id, status, last_error, created_at, updated_at
    FROM durable_jobs
    WHERE company_id=${sqlValue(companyId)}
      AND created_at>=${sqlValue(from)} AND created_at<=${sqlValue(to)}${automationPredicate}
    ORDER BY created_at ASC, id ASC
  `);
  const jobIds = jobs.map((job) => sqlValue(job.id));
  const approvals = jobIds.length > 0 ? querySql<ApprovalRow>(`
    SELECT id, job_id, status, created_at, decided_at
    FROM approvals
    WHERE company_id=${sqlValue(companyId)} AND job_id IN (${jobIds.join(", ")})
    ORDER BY created_at ASC, id ASC
  `) : [];
  const automationIds = [...new Set(jobs.map((job) => job.automation_id))];
  const automations = automationIds.length > 0 ? querySql<AutomationRow>(`
    SELECT id, name FROM mvp_automations
    WHERE company_id=${sqlValue(companyId)} AND id IN (${automationIds.map(sqlValue).join(", ")})
  `) : [];
  const automationNames = new Map(automations.map((item) => [item.id, item.name]));
  const legacyAutomationPredicate = automationId ? ` AND legacy_run.automation_id=${sqlValue(automationId)}` : "";
  const excludedLegacyRuns = Number(querySql<{ count: number }>(`
    SELECT COUNT(*) AS count FROM runs legacy_run
    WHERE legacy_run.company_id=${sqlValue(companyId)}
      AND legacy_run.created_at>=${sqlValue(from)} AND legacy_run.created_at<=${sqlValue(to)}${legacyAutomationPredicate}
      AND NOT EXISTS (
        SELECT 1 FROM durable_jobs durable_job
        WHERE durable_job.company_id=legacy_run.company_id AND durable_job.run_id=legacy_run.id
      )
  `)[0]?.count ?? 0);

  const outcomes = countOutcomes(jobs);
  const completionRate = jobs.length > 0 ? round(outcomes.completed / jobs.length, 4) : null;
  const durations = jobs
    .filter((job) => terminalStatuses.has(job.status))
    .map((job) => durationMs(job.created_at, job.updated_at))
    .filter((value): value is number => value !== null);
  const approvalLatencies = approvals
    .map((approval) => approval.decided_at ? durationMs(approval.created_at, approval.decided_at) : null)
    .filter((value): value is number => value !== null);
  const failureCategories = countFailureCategories(jobs);
  const byDate = aggregateJobs(jobs, (job) => job.created_at.slice(0, 10)).map(([date, rows]) => ({
    date,
    total_jobs: rows.length,
    completed_jobs: rows.filter((job) => job.status === "completed").length,
    failed_jobs: rows.filter((job) => job.status !== "completed" && terminalStatuses.has(job.status)).length
  }));
  const byAutomation = aggregateJobs(jobs, (job) => job.automation_id).map(([id, rows]) => ({
    automation_id: id,
    automation_name: automationNames.get(id) ?? "Archived automation",
    total_jobs: rows.length,
    completed_jobs: rows.filter((job) => job.status === "completed").length,
    completion_rate: rows.length ? round(rows.filter((job) => job.status === "completed").length / rows.length, 4) : null,
    last_updated_at: latestTimestamp(rows.map((job) => job.updated_at))
  }));
  const lastUpdatedAt = latestTimestamp([
    ...jobs.map((job) => job.updated_at),
    ...approvals.map((approval) => approval.decided_at ?? approval.created_at)
  ]);
  const dataState = jobs.length === 0 && approvals.length === 0
    ? "empty"
    : "partial";

  return {
    company_id: companyId,
    query: { from, to, automation_id: automationId },
    data_state: dataState,
    last_updated_at: lastUpdatedAt,
    event_contracts: [
      { type: "outcome", source: "durable_jobs.status", availability: jobs.length ? "available" : "empty" },
      { type: "duration", source: "durable_jobs.created_at,updated_at", availability: durations.length ? "available" : "empty" },
      { type: "approval_latency", source: "approvals.created_at,decided_at", availability: approvalLatencies.length ? "available" : "empty" },
      { type: "failure_category", source: "durable_jobs.status,last_error", availability: failureCategories.total ? "available" : "empty" },
      { type: "cost", source: null, availability: "unavailable", reason: "cost_event_source_not_configured" },
      { type: "time_saved", source: null, availability: "unavailable", reason: "time_saved_event_source_not_configured" },
      { type: "sla", source: null, availability: "unavailable", reason: "sla_target_not_configured" }
    ],
    metrics: {
      outcome: {
        availability: jobs.length ? "available" : "empty",
        unit: "jobs",
        numerator: outcomes.completed,
        denominator: jobs.length,
        completion_rate: completionRate,
        statuses: outcomes
      },
      duration: durationMetric(durations),
      approval_latency: durationMetric(approvalLatencies),
      failure_categories: { availability: failureCategories.total ? "available" : "empty", unit: "jobs", ...failureCategories },
      cost: unavailableMetric("currency", "cost_event_source_not_configured"),
      time_saved: unavailableMetric("milliseconds", "time_saved_event_source_not_configured"),
      sla: unavailableMetric("ratio", "sla_target_not_configured")
    },
    by_date: byDate,
    by_automation: byAutomation,
    provenance: [
      { source: "durable_jobs", row_count: jobs.length, last_updated_at: latestTimestamp(jobs.map((job) => job.updated_at)) },
      { source: "approvals", row_count: approvals.length, last_updated_at: latestTimestamp(approvals.map((approval) => approval.decided_at ?? approval.created_at)) },
      { source: "legacy_runs", row_count: excludedLegacyRuns, included: false, reason: "no_durable_job_lineage" }
    ],
    completeness: {
      included_durable_jobs: jobs.length,
      excluded_legacy_runs: excludedLegacyRuns,
      unavailable_metrics: ["cost", "time_saved", "sla"]
    }
  };
}

function countOutcomes(jobs: JobRow[]) {
  const counts: Record<string, number> = { queued: 0, leased: 0, completed: 0, failed: 0, cancelled: 0, timed_out: 0, reconciliation_required: 0, unknown: 0 };
  for (const job of jobs) {
    if (Object.prototype.hasOwnProperty.call(counts, job.status)) counts[job.status] += 1;
    else counts.unknown += 1;
  }
  return counts;
}

function countFailureCategories(jobs: JobRow[]) {
  const categories = new Map<string, number>();
  for (const job of jobs) {
    if (job.status === "completed" || job.status === "queued" || job.status === "leased") continue;
    const category = failureCategory(job);
    categories.set(category, (categories.get(category) ?? 0) + 1);
  }
  const rows = [...categories.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([category, count]) => ({ category, count }));
  return { total: rows.reduce((sum, row) => sum + row.count, 0), categories: rows };
}

function failureCategory(job: JobRow) {
  if (job.status === "cancelled") return "cancelled";
  if (job.status === "timed_out") return "timeout";
  if (job.status === "reconciliation_required") return "reconciliation_required";
  const error = String(job.last_error ?? "").toLowerCase();
  if (error.includes("approval")) return "approval";
  if (error.includes("auth") || error.includes("credential") || error.includes("login")) return "authorization";
  if (error.includes("network") || error.includes("browser") || error.includes("integration")) return "integration";
  return error ? "execution" : "unknown";
}

function durationMetric(values: number[]) {
  if (!values.length) return { availability: "empty", unit: "milliseconds", sample_size: 0, average: null, p50: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    availability: "available",
    unit: "milliseconds",
    sample_size: sorted.length,
    average: Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95)
  };
}

function unavailableMetric(unit: string, reason: string) {
  return { availability: "unavailable", unit, value: null, reason };
}

function percentile(sorted: number[], ratio: number) {
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? null;
}

function durationMs(from: string, to: string) {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function aggregateJobs(jobs: JobRow[], key: (job: JobRow) => string) {
  const groups = new Map<string, JobRow[]>();
  for (const job of jobs) groups.set(key(job), [...(groups.get(key(job)) ?? []), job]);
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function latestTimestamp(values: Array<string | null | undefined>) {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
}

function normalizedTimestamp(value: string, code: string) {
  const raw = required(value, code);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) throw new CompanyAnalyticsError(code);
  return new Date(timestamp).toISOString();
}

function required(value: string, code: string) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 256) throw new CompanyAnalyticsError(code);
  return normalized;
}

function round(value: number, places: number) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

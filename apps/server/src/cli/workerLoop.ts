import { initDb, nowIso, querySql, sqlValue, upsert } from "../db/client.js";
import { processQueuedCreatePlannerJobs } from "../planner/createPlannerJobs.js";
import { runWorkerOnce } from "../runs/workerEngine.js";
import { materializeDueAutomationOccurrences } from "../runs/automationScheduler.js";
import { runDurableDryRunWorkerOnce } from "../runs/durableDryRunWorker.js";
import { runDurableExternalWorkerOnce } from "../runs/durableExternalWorker.js";
import { hostname } from "node:os";

const intervalMs = boundedNumber(readArgValue("--interval-ms") ?? process.env.AUTOMATION_OS_WORKER_LOOP_INTERVAL_MS, 30_000, {
  min: 1_000,
  max: 10 * 60_000
});
const runId = readArgValue("--run-id");
const durableServiceUserId = (readArgValue("--durable-service-user-id") ?? process.env.AUTOMATION_OS_DURABLE_SERVICE_USER_ID ?? "").trim();
const maxCycles = boundedNumber(readArgValue("--max-cycles") ?? process.env.AUTOMATION_OS_WORKER_LOOP_MAX_CYCLES, Number.POSITIVE_INFINITY, {
  min: 1,
  max: Number.POSITIVE_INFINITY
});

let stopping = false;
let fatalBlocker: string | null = null;
let lastProcessed = 0;
let lastPlannerJobsProcessed = 0;
let lastRunIds: string[] = [];
let lastPlannerJobIds: string[] = [];
let lastDurableJobIds: string[] = [];
let lastDurableExternalJobIds: string[] = [];
let lastDurableExternalBlockers: string[] = [];

process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

initDb();
const initialDurableCoverageBlocker = runId ? null : durableWorkerCoverageBlocker(durableServiceUserId);
if (initialDurableCoverageBlocker) {
  const blocker = initialDurableCoverageBlocker;
  writeWorkerHeartbeat("blocked", "Durable worker identityが未設定のため停止しました", {
    lifecycle: "blocked",
    cycle: 0,
    processed: 0,
    blocker,
    nextAction: "activeなoperator service userをAUTOMATION_OS_DURABLE_SERVICE_USER_IDまたは--durable-service-user-idで指定してください。"
  });
  console.error(JSON.stringify({ event: "worker_loop_blocked", blocker, durableServiceUserConfigured: false }));
  process.exit(1);
}
writeWorkerHeartbeat("running", "Mac workerを開始しました", {
  lifecycle: "started",
  cycle: 0,
  processed: 0
});

console.log(JSON.stringify({
  event: "worker_loop_started",
  intervalMs,
  runId: runId ?? null,
  maxCycles: Number.isFinite(maxCycles) ? maxCycles : null,
  codexBin: process.env.AUTOMATION_OS_CHILD_CODEX_BIN ?? process.env.AUTOMATION_OS_CODEX_BIN ?? "codex",
  plannerProvider: process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER ?? "auto",
  usesApiKey: Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY),
  durableServiceUserConfigured: Boolean(durableServiceUserId)
}));

for (let cycle = 1; !stopping && cycle <= maxCycles; cycle += 1) {
  const startedAt = new Date().toISOString();
  try {
    if (!runId) {
      const coverageBlocker = durableWorkerCoverageBlocker(durableServiceUserId);
      if (coverageBlocker) throw new Error(coverageBlocker);
    }
    const summaries = await runWorkerOnce(runId);
    const durableResults = runId || !durableServiceUserId
      ? []
      : await Promise.all(listDurableWorkerCompanyIds(durableServiceUserId).map(async (companyId) => {
          const scheduler = materializeDueAutomationOccurrences({ companyId, serviceUserId: durableServiceUserId, now: startedAt });
          const worker = runDurableDryRunWorkerOnce({ companyId, serviceUserId: durableServiceUserId, now: startedAt });
          const externalWorker = await runDurableExternalWorkerOnce({ companyId, serviceUserId: durableServiceUserId, now: startedAt });
          return { companyId, scheduler, worker, externalWorker };
        }));
    const plannerJobs = runId ? [] : await processQueuedCreatePlannerJobs(1);
    lastProcessed = summaries.length;
    lastPlannerJobsProcessed = plannerJobs.length;
    lastRunIds = summaries.map((summary) => String(summary.runId ?? "")).filter(Boolean).slice(0, 10);
    lastPlannerJobIds = plannerJobs.map((job) => job.id);
    lastDurableJobIds = durableResults.flatMap((result) => result.worker.status === "completed" ? [result.worker.job.id] : []);
    lastDurableExternalJobIds = durableResults.flatMap((result) => result.externalWorker.status === "completed" ? [result.externalWorker.job?.id ?? ""].filter(Boolean) : []);
    lastDurableExternalBlockers = durableResults.flatMap((result) => result.externalWorker.exactBlocker ? [result.externalWorker.exactBlocker] : []);
    const totalProcessed = lastProcessed + lastPlannerJobsProcessed + lastDurableJobIds.length + lastDurableExternalJobIds.length;
    const heartbeatSummary = totalProcessed
      ? `${totalProcessed}件の処理を確認しました`
      : lastDurableExternalBlockers.length
        ? `外部queueは安全停止中です（${lastDurableExternalBlockers.join(", ")}）`
        : "待機中です";
    writeWorkerHeartbeat("ok", heartbeatSummary, {
      lifecycle: "running",
      cycle,
      processed: lastProcessed,
      plannerJobsProcessed: lastPlannerJobsProcessed,
      durableJobsProcessed: lastDurableJobIds.length,
      runIds: lastRunIds,
      plannerJobIds: lastPlannerJobIds,
      durableJobIds: lastDurableJobIds,
      durableExternalJobIds: lastDurableExternalJobIds,
      durableExternalBlockers: lastDurableExternalBlockers
    });
    console.log(JSON.stringify({
      event: "worker_cycle_completed",
      cycle,
      startedAt,
      completedAt: new Date().toISOString(),
      runId: runId ?? null,
      processed: totalProcessed,
      runProcessed: lastProcessed,
      plannerJobsProcessed: lastPlannerJobsProcessed,
      summaries,
      plannerJobs: plannerJobs.map((job) => ({
        id: job.id,
        status: job.status,
        exactBlocker: job.exactBlocker ?? null
      })),
        durable: durableResults.map((result) => ({
        companyId: result.companyId,
        initializedSchedules: result.scheduler.initializedScheduleIds.length,
        materializedOccurrences: result.scheduler.occurrences.length,
          workerStatus: result.worker.status,
          jobId: result.worker.status === "completed" ? result.worker.job.id : null,
          externalWorkerStatus: result.externalWorker.status,
          externalJobId: result.externalWorker.job?.id ?? null,
          externalExactBlocker: result.externalWorker.exactBlocker,
          externalActionExecuted: result.externalWorker.externalActionExecuted
        }))
    }));
  } catch (error) {
    const blocker = error instanceof Error ? error.message : "worker_loop_failed";
    lastProcessed = 0;
    lastPlannerJobsProcessed = 0;
    lastRunIds = [];
    lastPlannerJobIds = [];
    lastDurableJobIds = [];
    lastDurableExternalJobIds = [];
    lastDurableExternalBlockers = [];
    writeWorkerHeartbeat("blocked", "Mac workerの確認が止まりました", {
      lifecycle: "blocked",
      cycle,
      processed: 0,
      blocker
    });
    console.error(JSON.stringify({
      event: "worker_cycle_failed",
      cycle,
      startedAt,
      failedAt: new Date().toISOString(),
      runId: runId ?? null,
      blocker
    }));
    if (blocker.startsWith("durable_service_user_")) {
      fatalBlocker = blocker;
      stopping = true;
      process.exitCode = 1;
    }
  }
  if (stopping || cycle >= maxCycles) break;
  await sleep(intervalMs);
}

writeWorkerHeartbeat(fatalBlocker ? "blocked" : "idle", fatalBlocker ? "Durable worker identityの検証に失敗して停止しました" : "Mac workerを停止しました", {
  lifecycle: "stopped",
  cycle: null,
  processed: lastProcessed,
  plannerJobsProcessed: lastPlannerJobsProcessed,
  runIds: lastRunIds,
  plannerJobIds: lastPlannerJobIds,
  durableJobIds: lastDurableJobIds,
  durableExternalJobIds: lastDurableExternalJobIds,
  durableExternalBlockers: lastDurableExternalBlockers,
  blocker: fatalBlocker
});

function listDurableWorkerCompanyIds(serviceUserId: string): string[] {
  return querySql<{ company_id: string }>(`
    SELECT membership.company_id
    FROM company_memberships membership
    JOIN users ON users.id=membership.user_id
    JOIN companies ON companies.id=membership.company_id
    WHERE membership.user_id=${sqlValue(serviceUserId)} AND membership.role='operator'
      AND membership.status='active' AND users.status='active' AND users.kind='service'
      AND companies.status!='archived'
    ORDER BY membership.company_id
  `).map((row) => row.company_id);
}

function durableWorkerCoverageBlocker(serviceUserId: string): string | null {
  const requiredCompanyIds = listDurableWorkCompanyIds();
  if (requiredCompanyIds.length === 0) return null;
  if (!serviceUserId) return "durable_service_user_id_missing_with_pending_work";
  const authorizedCompanyIds = new Set(listDurableWorkerCompanyIds(serviceUserId));
  if (authorizedCompanyIds.size === 0) return "durable_service_user_invalid_or_unscoped_for_pending_work";
  if (requiredCompanyIds.some((companyId) => !authorizedCompanyIds.has(companyId))) {
    return "durable_service_user_scope_incomplete_for_pending_work";
  }
  return null;
}

function listDurableWorkCompanyIds(): string[] {
  return querySql<{ company_id: string }>(`
    SELECT company_id FROM durable_jobs
    WHERE status IN ('queued', 'leased', 'reconciliation_required')
    UNION
    SELECT schedule.company_id
    FROM mvp_automation_schedules schedule
    JOIN mvp_automations automation
      ON automation.id=schedule.automation_id AND automation.company_id=schedule.company_id
    WHERE schedule.enabled=1 AND schedule.status='active' AND schedule.kind!='manual'
      AND automation.status='active'
    ORDER BY company_id
  `).map((row) => row.company_id);
}
console.log(JSON.stringify({ event: "worker_loop_stopped", stoppedAt: new Date().toISOString() }));

function writeWorkerHeartbeat(status: "running" | "ok" | "blocked" | "idle", summary: string, extra: Record<string, unknown>) {
  const createdAt = nowIso();
  upsert("system_checks", {
    id: "local_codex_worker_heartbeat",
    kind: "local_codex_worker",
    status,
    target_url: null,
    summary,
    artifact_uri: null,
    created_at: createdAt,
    metadata_json: {
      intervalMs,
      runId: runId ?? null,
      maxCycles: Number.isFinite(maxCycles) ? maxCycles : null,
      host: hostname(),
      codexBin: process.env.AUTOMATION_OS_CHILD_CODEX_BIN ?? process.env.AUTOMATION_OS_CODEX_BIN ?? "codex",
      plannerProvider: process.env.AUTOMATION_OS_CREATE_PLANNER_PROVIDER ?? "auto",
      usesApiKey: Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY),
      pid: process.pid,
      ...extra,
      updatedAt: createdAt
    }
  });
}

function readArgValue(name: string) {
  const match = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return match?.slice(name.length + 1);
}

function boundedNumber(value: string | undefined, fallback: number, bounds: { min: number; max: number }) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(bounds.min, Math.min(bounds.max, parsed));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

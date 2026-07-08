import { initDb, nowIso, upsert } from "../db/client.js";
import { processQueuedCreatePlannerJobs } from "../planner/createPlannerJobs.js";
import { runWorkerOnce } from "../runs/workerEngine.js";
import { hostname } from "node:os";

const intervalMs = boundedNumber(readArgValue("--interval-ms") ?? process.env.AUTOMATION_OS_WORKER_LOOP_INTERVAL_MS, 30_000, {
  min: 1_000,
  max: 10 * 60_000
});
const runId = readArgValue("--run-id");
const maxCycles = boundedNumber(readArgValue("--max-cycles") ?? process.env.AUTOMATION_OS_WORKER_LOOP_MAX_CYCLES, Number.POSITIVE_INFINITY, {
  min: 1,
  max: Number.POSITIVE_INFINITY
});

let stopping = false;
let lastProcessed = 0;
let lastPlannerJobsProcessed = 0;
let lastRunIds: string[] = [];
let lastPlannerJobIds: string[] = [];

process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

initDb();
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
  usesApiKey: Boolean(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY)
}));

for (let cycle = 1; !stopping && cycle <= maxCycles; cycle += 1) {
  const startedAt = new Date().toISOString();
  try {
    const summaries = await runWorkerOnce(runId);
    const plannerJobs = runId ? [] : await processQueuedCreatePlannerJobs(1);
    lastProcessed = summaries.length;
    lastPlannerJobsProcessed = plannerJobs.length;
    lastRunIds = summaries.map((summary) => String(summary.runId ?? "")).filter(Boolean).slice(0, 10);
    lastPlannerJobIds = plannerJobs.map((job) => job.id);
    const totalProcessed = lastProcessed + lastPlannerJobsProcessed;
    writeWorkerHeartbeat("ok", totalProcessed ? `${totalProcessed}件の処理を確認しました` : "待機中です", {
      lifecycle: "running",
      cycle,
      processed: lastProcessed,
      plannerJobsProcessed: lastPlannerJobsProcessed,
      runIds: lastRunIds,
      plannerJobIds: lastPlannerJobIds
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
      }))
    }));
  } catch (error) {
    lastProcessed = 0;
    lastPlannerJobsProcessed = 0;
    lastRunIds = [];
    lastPlannerJobIds = [];
    writeWorkerHeartbeat("blocked", "Mac workerの確認が止まりました", {
      lifecycle: "blocked",
      cycle,
      processed: 0,
      blocker: error instanceof Error ? error.message : "worker_loop_failed"
    });
    console.error(JSON.stringify({
      event: "worker_cycle_failed",
      cycle,
      startedAt,
      failedAt: new Date().toISOString(),
      runId: runId ?? null,
      blocker: error instanceof Error ? error.message : "worker_loop_failed"
    }));
  }
  if (stopping || cycle >= maxCycles) break;
  await sleep(intervalMs);
}

writeWorkerHeartbeat("idle", "Mac workerを停止しました", {
  lifecycle: "stopped",
  cycle: null,
  processed: lastProcessed,
  plannerJobsProcessed: lastPlannerJobsProcessed,
  runIds: lastRunIds,
  plannerJobIds: lastPlannerJobIds
});
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

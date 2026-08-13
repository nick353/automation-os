import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dbBackend, initDb, querySqlBatch, sqlValue } from "../db/client.js";
import { redactWorkerOutput, safeWorkerEnvironment } from "../security/processEnvironment.js";
import { startCommandRun } from "../runs/workerEngine.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(readArgValue("--out-dir") ?? `/tmp/automation-os-production-worker-pickup-proof-${new Date().toISOString().replaceAll(":", "-")}`);
const command = readArgValue("--command") ?? "本番Mac worker pickup proof 記録だけ";
const databaseConfigured = Boolean(process.env.AUTOMATION_OS_DATABASE_URL || process.env.DATABASE_URL || process.env.POSTGRES_URI);
const workerTimeoutMs = boundedNumber(
  readArgValue("--worker-timeout-ms") ?? process.env.AUTOMATION_OS_WORKER_PICKUP_PROOF_TIMEOUT_MS,
  120_000,
  { min: 5_000, max: 10 * 60_000 }
);

mkdirSync(outDir, { recursive: true });

if (!databaseConfigured) {
  finish({
    ok: false,
    blocker: "production_database_url_missing",
    nextAction: "ローカルshellに本番PostgreSQLのDATABASE_URL、AUTOMATION_OS_DATABASE_URL、またはlinked serviceのPOSTGRES_URIを設定してから再実行してください。",
    database: { backend: dbBackend, configured: false }
  }, 2);
}

if (dbBackend !== "postgres") {
  finish({
    ok: false,
    blocker: "production_database_backend_not_postgres",
    nextAction: "本番pickup proofはPostgreSQL backendでだけ実行してください。",
    database: { backend: dbBackend, configured: databaseConfigured }
  }, 2);
}

initDb();

const created = await startCommandRun(command, {
  deferWorker: true,
  metadata: {
    production_worker_pickup_proof: true,
    worker_mode: "receipt_only",
    proof_goal: "production_db_local_mac_worker_pickup",
    source: "workerProductionPickupProof"
  }
});

const workerLoopPath = join(moduleDir, "workerLoop.js");
const childDatabaseUrl = process.env.AUTOMATION_OS_DATABASE_URL ?? process.env.DATABASE_URL ?? process.env.POSTGRES_URI;
const worker = spawnSync(process.execPath, [workerLoopPath, `--run-id=${created.runId}`, "--max-cycles=1", "--interval-ms=1000"], {
  cwd: process.cwd(),
  env: safeWorkerEnvironment(process.env, {
    databaseUrl: childDatabaseUrl,
    overrides: {
      AUTOMATION_OS_ENV_ROLE: "production"
    }
  }),
  encoding: "utf8",
  maxBuffer: 1024 * 1024,
  timeout: workerTimeoutMs
});

const [heartbeatRows, runRows, stepRows] = querySqlBatch([
  `SELECT id, status, summary, metadata_json FROM system_checks WHERE id='local_codex_worker_heartbeat' LIMIT 1`,
  `SELECT id, status, metadata_json FROM runs WHERE id=${sqlValue(created.runId)} LIMIT 1`,
  `SELECT id, status, metadata_json FROM run_steps WHERE run_id=${sqlValue(created.runId)} ORDER BY id`
]);
const heartbeat = heartbeatRows[0] as { id: string; status: string; summary: string; metadata_json: string } | undefined;
const run = runRows[0] as { id: string; status: string; metadata_json: string } | undefined;
const steps = stepRows as Array<{ id: string; status: string; metadata_json: string }>;
const heartbeatMetadata = parseJsonObject(heartbeat?.metadata_json);
const processed = typeof heartbeatMetadata.processed === "number" ? heartbeatMetadata.processed : 0;
const runIds = Array.isArray(heartbeatMetadata.runIds) ? heartbeatMetadata.runIds.map(String) : [];
const ok = worker.status === 0 && processed >= 1 && runIds.includes(created.runId) && steps.some((step) => step.status === "completed");
const workerErrorCode = worker.error && "code" in worker.error
  ? String((worker.error as NodeJS.ErrnoException).code)
  : null;
const timedOut = workerErrorCode === "ETIMEDOUT";

finish({
  ok,
  blocker: ok ? null : timedOut ? "production_worker_pickup_child_timeout" : "production_worker_pickup_not_confirmed",
  createdRunId: created.runId,
  command: redactWorkerOutput(command, 1_000),
  database: { backend: dbBackend, configured: true },
  worker: {
    status: worker.status,
    signal: worker.signal,
    timedOut,
    timeoutMs: workerTimeoutMs,
    errorCode: workerErrorCode,
    stdoutTail: redactWorkerOutput(tail(worker.stdout)),
    stderrTail: redactWorkerOutput(tail(worker.stderr))
  },
  heartbeat: heartbeat
    ? {
        id: heartbeat.id,
        status: heartbeat.status,
        summary: heartbeat.summary,
        metadata: {
          lifecycle: heartbeatMetadata.lifecycle ?? null,
          processed,
          runIds,
          updatedAt: heartbeatMetadata.updatedAt ?? null,
          usesApiKey: Boolean(heartbeatMetadata.usesApiKey)
        }
      }
    : null,
  run: run ? { id: run.id, status: run.status } : null,
  steps: steps.map((step) => ({ id: step.id, status: step.status })),
  nextAction: ok
    ? "本番DashboardでMac workerの処理件数と対象runを確認してください。"
    : timedOut
      ? "worker loopの停止原因を確認し、同じproofを即時再実行せずにログとDB readbackを確認してください。"
      : "worker stdout/stderr tailとDB readbackを確認してください。"
}, ok ? 0 : 1);

function finish(summary: Record<string, unknown>, code: number): never {
  const outPath = join(outDir, "summary.json");
  writeFileSync(outPath, JSON.stringify({ ...summary, outDir, writtenAt: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ ...summary, outDir, summaryPath: outPath }, null, 2));
  process.exit(code);
}

function readArgValue(name: string) {
  const match = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return match?.slice(name.length + 1);
}

function parseJsonObject(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function tail(value: string | null | undefined, limit = 8000) {
  const text = value ?? "";
  return text.length > limit ? text.slice(-limit) : text;
}

function boundedNumber(value: string | undefined, fallback: number, bounds: { min: number; max: number }) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(bounds.min, Math.min(bounds.max, parsed));
}

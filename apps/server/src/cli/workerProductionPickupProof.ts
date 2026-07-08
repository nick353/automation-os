import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dbBackend, initDb, querySql, sqlValue } from "../db/client.js";
import { startCommandRun } from "../runs/workerEngine.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(readArgValue("--out-dir") ?? `/tmp/automation-os-production-worker-pickup-proof-${new Date().toISOString().replaceAll(":", "-")}`);
const command = readArgValue("--command") ?? "本番Mac worker pickup proof 記録だけ";
const databaseConfigured = Boolean(process.env.AUTOMATION_OS_DATABASE_URL || process.env.DATABASE_URL);

mkdirSync(outDir, { recursive: true });

if (!databaseConfigured) {
  finish({
    ok: false,
    blocker: "production_database_url_missing",
    nextAction: "ローカルshellに本番PostgreSQLのDATABASE_URLまたはAUTOMATION_OS_DATABASE_URLを設定してから再実行してください。",
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
const worker = spawnSync(process.execPath, [workerLoopPath, `--run-id=${created.runId}`, "--max-cycles=1", "--interval-ms=1000"], {
  cwd: process.cwd(),
  env: process.env,
  encoding: "utf8",
  maxBuffer: 1024 * 1024
});

const heartbeat = querySql<{ id: string; status: string; summary: string; metadata_json: string }>(
  `SELECT id, status, summary, metadata_json FROM system_checks WHERE id='local_codex_worker_heartbeat' LIMIT 1`
)[0];
const run = querySql<{ id: string; status: string; metadata_json: string }>(
  `SELECT id, status, metadata_json FROM runs WHERE id=${sqlValue(created.runId)} LIMIT 1`
)[0];
const steps = querySql<{ id: string; status: string; metadata_json: string }>(
  `SELECT id, status, metadata_json FROM run_steps WHERE run_id=${sqlValue(created.runId)} ORDER BY id`
);
const heartbeatMetadata = parseJsonObject(heartbeat?.metadata_json);
const processed = typeof heartbeatMetadata.processed === "number" ? heartbeatMetadata.processed : 0;
const runIds = Array.isArray(heartbeatMetadata.runIds) ? heartbeatMetadata.runIds.map(String) : [];
const ok = worker.status === 0 && processed >= 1 && runIds.includes(created.runId) && steps.some((step) => step.status === "completed");

finish({
  ok,
  blocker: ok ? null : "production_worker_pickup_not_confirmed",
  createdRunId: created.runId,
  command,
  database: { backend: dbBackend, configured: true },
  worker: {
    status: worker.status,
    signal: worker.signal,
    stdoutTail: tail(worker.stdout),
    stderrTail: tail(worker.stderr)
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
  nextAction: ok ? "本番DashboardでMac workerの処理件数と対象runを確認してください。" : "worker stdout/stderr tailとDB readbackを確認してください。"
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

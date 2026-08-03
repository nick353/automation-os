import { spawn } from "node:child_process";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readStoredSecretByKind } from "../secrets/secretStore.js";
import { safeWorkerEnvironment } from "../security/processEnvironment.js";
import { validatePostgresUrl } from "./postgresUrlValidation.js";
import { workerChildSpawnFailureSummary } from "./workerProductionErrors.js";

const mode = readArgValue("--mode") ?? "proof";
const statePath = process.env.AUTOMATION_OS_WORKER_STATE_PATH
  ?? resolve(process.cwd(), "data/state/automation-os-worker.json");
let childTimer: NodeJS.Timeout | undefined;

let databaseUrl: string | undefined;
try {
  databaseUrl = readStoredSecretByKind("postgres");
} catch {
  finishBlocked({
    blocker: "stored_postgres_secret_read_failed",
    // Storage/decryption errors can contain provider- or credential-derived
    // text. Keep the worker readback actionable without echoing the exception.
    reason: "secret_store_unavailable",
    nextAction: "Automation OSのsecret storeを確認してからworkerを再起動してください。secret値は表示しません。",
    secret: { kind: "postgres", configured: false }
  });
}

if (!databaseUrl) {
  finishBlocked({
    blocker: "stored_postgres_secret_missing",
    nextAction: "Automation OSに本番PostgreSQL接続を保存してから再実行してください。例: Createやtop barに `DATABASE_URL=postgresql://...` を貼ると値は保存され、画面には表示されません。",
    secret: { kind: "postgres", configured: false }
  });
}

const databaseUrlValidation = validatePostgresUrl(databaseUrl);
if (!databaseUrlValidation.ok) {
  finishBlocked({
    blocker: "stored_postgres_secret_invalid_url",
    reason: databaseUrlValidation.reason,
    nextAction: "Automation OSに有効な本番PostgreSQL接続を保存し直してからworkerを再起動してください。保存済みsecret値は表示しません。",
    secret: { kind: "postgres", configured: true, validUrl: false }
  });
}
const validatedDatabaseUrl = databaseUrlValidation.value;

if (mode === "loop") {
  const globalServiceUserId = process.env.AUTOMATION_OS_GLOBAL_SYSTEM_SERVICE_USER_ID?.trim() ?? "";
  const durableServiceUserId = process.env.AUTOMATION_OS_DURABLE_SERVICE_USER_ID?.trim() ?? "";
  if (!globalServiceUserId && !durableServiceUserId) {
    finishBlocked({
      blocker: "worker_service_identity_missing",
      nextAction: "Automation OSのactiveなservice identityをAUTOMATION_OS_GLOBAL_SYSTEM_SERVICE_USER_IDまたはAUTOMATION_OS_DURABLE_SERVICE_USER_IDに設定してからworkerを再起動してください。identity値はログへ出しません。",
      serviceIdentity: { configured: false }
    });
  }
}

const args = mode === "loop"
  ? ["apps/server/dist/cli/workerLoop.js", ...forwardedArgs()]
  : ["apps/server/dist/cli/workerProductionPickupProof.js", ...forwardedArgs()];
const proofTimeoutMs = mode === "proof"
  ? boundedNumber(readArgValue("--worker-timeout-ms") ?? process.env.AUTOMATION_OS_WORKER_PICKUP_PROOF_TIMEOUT_MS, 120_000, {
      min: 5_000,
      max: 10 * 60_000
    })
  : null;

const child = spawn(process.execPath, args, {
  cwd: process.cwd(),
  env: safeWorkerEnvironment(process.env, {
    databaseUrl: validatedDatabaseUrl,
    overrides: {
      // Keep the stored-secret worker on the production startup policy path;
      // the child must not silently inherit legacy SQLite semantics.
      AUTOMATION_OS_ENV_ROLE: "production",
      AUTOMATION_OS_ASSUME_EXISTING_POSTGRES_SCHEMA: process.env.AUTOMATION_OS_ASSUME_EXISTING_POSTGRES_SCHEMA ?? "1",
      AUTOMATION_OS_PORTABLE_WORKER_MODE: process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE ?? "canary"
    }
  }),
  stdio: ["ignore", "inherit", "inherit"]
});

let childTimedOut = false;
if (proofTimeoutMs !== null) {
  childTimer = setTimeout(() => {
    childTimedOut = true;
    if (childIsAlive()) child.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (childIsAlive()) child.kill("SIGKILL");
    }, 2_000);
    killTimer.unref();
  }, proofTimeoutMs + 30_000);
}

writeState({
  ok: true,
  status: "running",
  blocker: null,
  mode,
  childPid: child.pid ?? null
});

const relay = (signal: NodeJS.Signals) => {
  if (childIsAlive()) child.kill(signal);
};
process.once("SIGTERM", () => relay("SIGTERM"));
process.once("SIGINT", () => relay("SIGINT"));

child.once("error", (error) => {
  void error;
  finish(workerChildSpawnFailureSummary(mode), 1);
});

child.once("exit", (code, signal) => {
  if (childTimer) clearTimeout(childTimer);
  const exitCode = code ?? (signal ? 1 : 0);
  finish({
    ok: exitCode === 0,
    status: exitCode === 0 ? "stopped" : "blocked",
    blocker: exitCode === 0 ? null : childTimedOut ? "worker_child_timeout" : "worker_child_exited_nonzero",
    mode,
    timeoutMs: proofTimeoutMs,
    timedOut: childTimedOut,
    childExitCode: code,
    childSignal: signal
  }, exitCode);
});

function forwardedArgs() {
  return process.argv.slice(2).filter((arg) => !arg.startsWith("--mode="));
}

function readArgValue(name: string) {
  const match = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return match?.slice(name.length + 1);
}

function childIsAlive() {
  return child.exitCode === null && child.signalCode === null;
}

function finishBlocked(summary: Record<string, unknown>): never {
  finish({ ok: false, status: "blocked", ...summary, mode }, 1);
}

function finish(summary: Record<string, unknown>, code: number): never {
  if (childTimer) clearTimeout(childTimer);
  const record = writeState(summary);
  console.log(JSON.stringify(record));
  process.exit(code);
}

function boundedNumber(value: string | undefined, fallback: number, bounds: { min: number; max: number }) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(bounds.min, Math.min(bounds.max, parsed));
}

function writeState(summary: Record<string, unknown>) {
  const record = {
    schema_version: 1,
    updated_at: new Date().toISOString(),
    pid: process.pid,
    ...summary
  };
  mkdirSync(dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.${process.pid}.tmp`;
  const fd = openSync(tempPath, "w", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, statePath);
  return record;
}

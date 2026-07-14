import { spawn } from "node:child_process";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readStoredSecretByKind } from "../secrets/secretStore.js";
import { validatePostgresUrl } from "./postgresUrlValidation.js";

const mode = readArgValue("--mode") ?? "proof";
const statePath = process.env.AUTOMATION_OS_WORKER_STATE_PATH
  ?? resolve(process.cwd(), "data/state/automation-os-worker.json");

let databaseUrl: string | undefined;
try {
  databaseUrl = readStoredSecretByKind("postgres");
} catch (error) {
  finishBlocked({
    blocker: "stored_postgres_secret_read_failed",
    reason: error instanceof Error ? error.message : String(error),
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

const args = mode === "loop"
  ? ["apps/server/dist/cli/workerLoop.js", ...forwardedArgs()]
  : ["apps/server/dist/cli/workerProductionPickupProof.js", ...forwardedArgs()];

const child = spawn(process.execPath, args, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    AUTOMATION_OS_DATABASE_URL: validatedDatabaseUrl,
    DATABASE_URL: validatedDatabaseUrl,
    AUTOMATION_OS_ASSUME_EXISTING_POSTGRES_SCHEMA: process.env.AUTOMATION_OS_ASSUME_EXISTING_POSTGRES_SCHEMA ?? "1"
  },
  stdio: ["ignore", "inherit", "inherit"]
});

writeState({
  ok: true,
  status: "running",
  blocker: null,
  mode,
  childPid: child.pid ?? null
});

const relay = (signal: NodeJS.Signals) => {
  if (!child.killed) child.kill(signal);
};
process.once("SIGTERM", () => relay("SIGTERM"));
process.once("SIGINT", () => relay("SIGINT"));

child.once("error", (error) => {
  finish({
    ok: false,
    status: "blocked",
    blocker: "worker_child_spawn_failed",
    reason: error.message,
    mode
  }, 1);
});

child.once("exit", (code, signal) => {
  const exitCode = code ?? (signal ? 1 : 0);
  finish({
    ok: exitCode === 0,
    status: exitCode === 0 ? "stopped" : "blocked",
    blocker: exitCode === 0 ? null : "worker_child_exited_nonzero",
    mode,
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

function finishBlocked(summary: Record<string, unknown>): never {
  finish({ ok: false, status: "blocked", ...summary, mode }, 0);
}

function finish(summary: Record<string, unknown>, code: number): never {
  const record = writeState(summary);
  console.log(JSON.stringify(record));
  process.exit(code);
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

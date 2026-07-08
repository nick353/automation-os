import { spawnSync } from "node:child_process";
import { readStoredSecretByKind } from "../secrets/secretStore.js";
import { validatePostgresUrl } from "./postgresUrlValidation.js";

const mode = readArgValue("--mode") ?? "proof";
const databaseUrl = readStoredSecretByKind("postgres");

if (!databaseUrl) {
  finish({
    ok: false,
    blocker: "stored_postgres_secret_missing",
    nextAction: "Automation OSに本番PostgreSQL接続を保存してから再実行してください。例: Createやtop barに `DATABASE_URL=postgresql://...` を貼ると値は保存され、画面には表示されません。",
    secret: { kind: "postgres", configured: false }
  }, 2);
}

const databaseUrlValidation = validatePostgresUrl(databaseUrl);
if (!databaseUrlValidation.ok) {
  finish({
    ok: false,
    blocker: "stored_postgres_secret_invalid_url",
    reason: databaseUrlValidation.reason,
    nextAction: "Automation OSに有効な本番PostgreSQL接続を保存し直してからworkerを再起動してください。保存済みsecret値は表示しません。",
    secret: { kind: "postgres", configured: true, validUrl: false }
  }, 2);
}
const validatedDatabaseUrl = databaseUrlValidation.value;

const args = mode === "loop"
  ? ["apps/server/dist/cli/workerLoop.js", ...forwardedArgs()]
  : ["apps/server/dist/cli/workerProductionPickupProof.js", ...forwardedArgs()];

const child = spawnSync(process.execPath, args, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    AUTOMATION_OS_DATABASE_URL: validatedDatabaseUrl,
    DATABASE_URL: validatedDatabaseUrl,
    AUTOMATION_OS_ASSUME_EXISTING_POSTGRES_SCHEMA: process.env.AUTOMATION_OS_ASSUME_EXISTING_POSTGRES_SCHEMA ?? "1"
  },
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  maxBuffer: 1024 * 1024
});

if (child.stdout) process.stdout.write(child.stdout);
if (child.stderr) process.stderr.write(child.stderr);
process.exit(child.status ?? (child.signal ? 1 : 0));

function forwardedArgs() {
  return process.argv.slice(2).filter((arg) => !arg.startsWith("--mode="));
}

function readArgValue(name: string) {
  const match = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return match?.slice(name.length + 1);
}

function finish(summary: Record<string, unknown>, code: number): never {
  console.log(JSON.stringify(summary, null, 2));
  process.exit(code);
}

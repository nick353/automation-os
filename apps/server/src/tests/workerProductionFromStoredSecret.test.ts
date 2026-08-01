import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-worker-production-stored-secret-"));
const secretDir = join(tempRoot, "secrets");
const statePath = join(tempRoot, "worker-state.json");

process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.AUTOMATION_OS_SECRET_DIR = secretDir;
process.env.AUTOMATION_OS_WORKER_STATE_PATH = statePath;
delete process.env.AUTOMATION_OS_DATABASE_URL;
delete process.env.DATABASE_URL;

test("workerProductionFromStoredSecret exits non-zero when the postgres secret is missing", () => {
  const result = spawnSync(
    process.execPath,
    ["apps/server/dist/cli/workerProductionFromStoredSecret.js", "--mode=proof"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AUTOMATION_OS_DB: process.env.AUTOMATION_OS_DB ?? "",
        AUTOMATION_OS_SECRET_DIR: process.env.AUTOMATION_OS_SECRET_DIR ?? "",
        AUTOMATION_OS_WORKER_STATE_PATH: statePath
      },
      encoding: "utf8"
    }
  );

  assert.equal(result.status, 1);
  const stdout = JSON.parse(result.stdout.trim()) as {
    ok: boolean;
    status: string;
    blocker: string;
    secret: { kind: string; configured: boolean };
  };
  assert.equal(stdout.ok, false);
  assert.equal(stdout.status, "blocked");
  assert.equal(stdout.blocker, "stored_postgres_secret_missing");
  assert.equal(stdout.secret.kind, "postgres");
  assert.equal(stdout.secret.configured, false);
  assert.equal(existsSync(statePath), true);

  const state = JSON.parse(readFileSync(statePath, "utf8")) as {
    ok: boolean;
    status: string;
    blocker: string;
  };
  assert.equal(state.ok, false);
  assert.equal(state.status, "blocked");
  assert.equal(state.blocker, "stored_postgres_secret_missing");
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { workerChildSpawnFailureSummary } from "../cli/workerProductionErrors.js";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-worker-production-stored-secret-"));
const secretDir = join(tempRoot, "secrets");
const statePath = join(tempRoot, "worker-state.json");

process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.AUTOMATION_OS_SECRET_DIR = secretDir;
process.env.AUTOMATION_OS_WORKER_STATE_PATH = statePath;
delete process.env.AUTOMATION_OS_DATABASE_URL;
delete process.env.DATABASE_URL;

const db = await import("../db/client.js");
const secrets = await import("../secrets/secretStore.js");

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

test("workerProductionFromStoredSecret does not echo secret-store exceptions", () => {
  db.initDb();
  mkdirSync(secretDir, { recursive: true });
  const storageRef = join(secretDir, "corrupt-secret.json");
  writeFileSync(storageRef, "{\"not_a_valid_secret_payload\":\"credential-like-text\"}\n", { mode: 0o600 });
  db.upsert("stored_secrets", {
    id: "secret_postgres_api_key",
    company_id: null,
    kind: "postgres",
    label: "本番PostgreSQL接続",
    storage_ref: storageRef,
    masked_value: "保存済み（値は非表示）",
    fingerprint: "test-fingerprint",
    created_at: db.nowIso(),
    updated_at: db.nowIso(),
    metadata_json: { state: "stored", availableToRunner: true }
  });

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
  assert.equal(result.stdout.includes("credential-like-text"), false);
  const stdout = JSON.parse(result.stdout.trim()) as { blocker: string; reason: string };
  assert.equal(stdout.blocker, "stored_postgres_secret_read_failed");
  assert.equal(stdout.reason, "secret_store_unavailable");
});

test("worker child spawn failure summary is stable and secret-free", () => {
  const summary = workerChildSpawnFailureSummary("proof");
  assert.deepEqual(summary, {
    ok: false,
    status: "blocked",
    blocker: "worker_child_spawn_failed",
    reason: "worker_child_spawn_failed",
    mode: "proof"
  });
  assert.doesNotMatch(JSON.stringify(summary), /credential-like-text|DATABASE_URL|\/Users\/private\/config/u);
});

test("workerProductionFromStoredSecret blocks unresolved postgres templates before spawning", () => {
  const template = "postgresql://${POSTGRES_USERNAME}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DATABASE}";
  secrets.saveSecretsFromMessage(`DATABASE_URL=${template}`);
  const templateKeys = ["POSTGRES_USERNAME", "POSTGRES_PASSWORD", "POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_DATABASE"] as const;
  const previous = Object.fromEntries(templateKeys.map((key) => [key, process.env[key]]));
  for (const key of templateKeys) delete process.env[key];
  try {
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
    assert.doesNotMatch(result.stdout, /postgresql:\/\/|credential-like-text/iu);
    const stdout = JSON.parse(result.stdout.trim()) as { blocker: string; reason: string; secret: { configured: boolean; validUrl: boolean } };
    assert.equal(stdout.blocker, "stored_postgres_secret_invalid_url");
    assert.match(stdout.reason, /^template_reference_missing:/u);
    assert.equal(stdout.secret.configured, true);
    assert.equal(stdout.secret.validUrl, false);
  } finally {
    for (const key of templateKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

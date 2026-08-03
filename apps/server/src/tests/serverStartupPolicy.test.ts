import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { evaluateServerStartupPolicy } from "../cli/serverStartupPolicy.js";

function env(overrides: Record<string, string | undefined> = {}) {
  const result: NodeJS.ProcessEnv = {
    AUTOMATION_OS_ENV_ROLE: undefined,
    AUTOMATION_OS_DATABASE_URL: undefined,
    DATABASE_URL: undefined,
    ...overrides
  };
  for (const [key, value] of Object.entries(result)) {
    if (value === undefined) delete result[key];
  }
  return result;
}

test("unset role preserves legacy startup behavior", () => {
  assert.deepEqual(evaluateServerStartupPolicy(env()), {
    ok: true,
    role: "legacy",
    databaseAuthority: "legacy",
    databaseSource: null
  });
});

test("recovery role preserves explicit local fallback behavior", () => {
  assert.deepEqual(evaluateServerStartupPolicy(env({ AUTOMATION_OS_ENV_ROLE: "recovery" })), {
    ok: true,
    role: "recovery",
    databaseAuthority: "legacy",
    databaseSource: null
  });
});

test("production fails closed before a database backend can be selected", () => {
  const result = evaluateServerStartupPolicy(env({ AUTOMATION_OS_ENV_ROLE: "production" }));
  assert.deepEqual(result, {
    ok: false,
    role: "production",
    exactBlocker: "production_postgres_configuration_missing"
  });
});

test("production rejects malformed PostgreSQL configuration without echoing it", () => {
  const secret = "https://operator:never-log-this@db.example.invalid:5432/automation_os";
  const result = evaluateServerStartupPolicy(env({
    AUTOMATION_OS_ENV_ROLE: "production",
    AUTOMATION_OS_DATABASE_URL: secret
  }));
  assert.equal(result.ok, false);
  assert.equal(result.exactBlocker, "production_postgres_configuration_invalid");
  assert.doesNotMatch(JSON.stringify(result), /never-log-this|db\.example\.invalid/u);
});

test("production uses the canonical Automation OS URL before DATABASE_URL", () => {
  const result = evaluateServerStartupPolicy(env({
    AUTOMATION_OS_ENV_ROLE: "production",
    AUTOMATION_OS_DATABASE_URL: "postgresql://user:password@db.example.invalid:5432/automation_os",
    DATABASE_URL: "postgresql://other:password@other.example.invalid:5432/automation_os"
  }));
  assert.deepEqual(result, {
    ok: true,
    role: "production",
    databaseAuthority: "postgres_required",
    databaseSource: "AUTOMATION_OS_DATABASE_URL"
  });
});

test("direct database imports reject production SQLite before initialization", () => {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "await import('./apps/server/dist/db/client.js')"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AUTOMATION_OS_ENV_ROLE: "production",
        AUTOMATION_OS_DATABASE_URL: undefined,
        DATABASE_URL: undefined,
        AUTOMATION_OS_DB: `/tmp/automation-os-direct-production-${process.pid}.sqlite`
      },
      encoding: "utf8"
    }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /production_postgres_configuration_missing/u);
  assert.doesNotMatch(result.stderr, /postgresql:\/\/|DATABASE_URL=/iu);
});

test("direct database imports reject an invalid non-empty environment role", () => {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "await import('./apps/server/dist/db/client.js')"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AUTOMATION_OS_ENV_ROLE: "unexpected",
        AUTOMATION_OS_DATABASE_URL: undefined,
        DATABASE_URL: undefined,
        AUTOMATION_OS_DB: `/tmp/automation-os-direct-invalid-role-${process.pid}.sqlite`
      },
      encoding: "utf8"
    }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /automation_os_env_role_invalid/u);
  assert.doesNotMatch(result.stderr, /postgresql:\/\/|DATABASE_URL=/iu);
});

test("production accepts a template URL using the supplied environment", () => {
  const result = evaluateServerStartupPolicy(env({
    AUTOMATION_OS_ENV_ROLE: "production",
    DATABASE_URL: "postgresql://${POSTGRES_USERNAME}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DATABASE}",
    POSTGRES_USERNAME: "user",
    POSTGRES_PASSWORD: "password",
    POSTGRES_HOST: "db.example.invalid",
    POSTGRES_PORT: "5432",
    POSTGRES_DATABASE: "automation_os"
  }));
  assert.deepEqual(result, {
    ok: true,
    role: "production",
    databaseAuthority: "postgres_required",
    databaseSource: "DATABASE_URL"
  });
});

test("unknown roles fail closed instead of falling back", () => {
  const result = evaluateServerStartupPolicy(env({ AUTOMATION_OS_ENV_ROLE: "Production" }));
  assert.deepEqual(result, {
    ok: false,
    role: "Production",
    exactBlocker: "automation_os_env_role_invalid"
  });
});

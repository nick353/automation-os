import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { redactWorkerOutput, resolveWorkerWorkspacePath, safeWorkerEnvironment } from "../security/processEnvironment.js";

test("safe worker environment omits inherited secret-shaped variables", () => {
  const env = safeWorkerEnvironment({
    PATH: "/bin",
    HOME: "/tmp/home",
    AUTOMATION_OS_WRITE_TOKEN: "fixture-write-token",
    OPENAI_API_KEY: "fixture-api-key",
    POSTGRES_PASSWORD: "fixture-postgres-password",
    AWS_SECRET_ACCESS_KEY: "fixture-aws-secret",
    AUTOMATION_OS_CUSTOM_SECRET: "fixture-custom-secret",
    DATABASE_URL: "postgres://fixture:password@example.invalid/db",
    CODEX_CLI_PATH: "/opt/codex/bin/codex",
    BROWSER_USE_CLI_HELPER: "/tmp/source-codex-browser-use",
    AUTOMATION_OS_SECRET_DIR: "/tmp/automation-os-secrets",
    AUTOMATION_OS_DB: "/tmp/automation-os.sqlite"
  });

  assert.equal(env.PATH, "/bin");
  assert.equal(env.AUTOMATION_OS_SECRET_DIR, "/tmp/automation-os-secrets");
  assert.equal(env.AUTOMATION_OS_DB, "/tmp/automation-os.sqlite");
  assert.equal(env.CODEX_CLI_PATH, "/opt/codex/bin/codex");
  assert.equal(env.BROWSER_USE_CLI_HELPER, "/tmp/source-codex-browser-use");
  assert.equal(env.AUTOMATION_OS_WRITE_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.POSTGRES_PASSWORD, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.AUTOMATION_OS_CUSTOM_SECRET, undefined);
  assert.equal(env.DATABASE_URL, undefined);
});

test("stored database URL is injected only when explicitly bound to the worker", () => {
  const env = safeWorkerEnvironment(
    { PATH: "/bin", DATABASE_URL: "postgres://inherited:password@example.invalid/db" },
    {
      databaseUrl: "postgres://bound:password@example.invalid/db",
      overrides: {
        AUTOMATION_OS_BROWSER_SURFACE: "browser_use_cli",
        AUTOMATION_OS_WRITE_TOKEN: "fixture-write-token",
        DATABASE_URL: "postgres://override:password@example.invalid/db",
        AUTOMATION_OS_DATABASE_URL: "postgres://override:password@example.invalid/db"
      }
    }
  );

  assert.equal(env.AUTOMATION_OS_DATABASE_URL, "postgres://bound:password@example.invalid/db");
  assert.equal(env.DATABASE_URL, "postgres://bound:password@example.invalid/db");
  assert.equal(env.AUTOMATION_OS_BROWSER_SURFACE, "browser_use_cli");
  assert.equal(env.AUTOMATION_OS_WRITE_TOKEN, undefined);
});

test("job business no-launch preflight flag crosses the safe worker boundary", () => {
  const env = safeWorkerEnvironment({
    PATH: "/bin",
    AUTOMATION_OS_PORTABLE_BUSINESS_NO_LAUNCH: "1",
    AUTOMATION_OS_PORTABLE_EXTERNAL_INPUT_BUNDLE_PATH: "/tmp/run/portable-input-bundle.v1.json",
  });

  assert.equal(env.AUTOMATION_OS_PORTABLE_BUSINESS_NO_LAUNCH, "1");
  assert.equal(env.AUTOMATION_OS_PORTABLE_EXTERNAL_INPUT_BUNDLE_PATH, "/tmp/run/portable-input-bundle.v1.json");
});

test("stored production worker can bind the explicit production startup role", () => {
  const env = safeWorkerEnvironment(
    { PATH: "/bin", AUTOMATION_OS_ENV_ROLE: "recovery" },
    {
      databaseUrl: "postgres://bound:password@example.invalid/db",
      overrides: { AUTOMATION_OS_ENV_ROLE: "production" }
    }
  );

  assert.equal(env.AUTOMATION_OS_ENV_ROLE, "production");
  assert.equal(env.AUTOMATION_OS_DATABASE_URL, "postgres://bound:password@example.invalid/db");
  assert.equal(env.DATABASE_URL, "postgres://bound:password@example.invalid/db");
});

test("durable-only worker lane crosses the safe child boundary", () => {
  const env = safeWorkerEnvironment({
    PATH: "/bin",
    AUTOMATION_OS_WORKER_DURABLE_ONLY: "1"
  });

  assert.equal(env.AUTOMATION_OS_WORKER_DURABLE_ONLY, "1");
});

test("worker output redaction removes credential values before persistence", () => {
  const output = redactWorkerOutput(Buffer.from([
    "AUTOMATION_OS_DATABASE_URL=postgres://user:password@example.invalid/db",
    "DATABASE_URL=postgres://user:password@example.invalid/db",
    "password=fixture-password token=fixture-token"
  ].join("\n")));
  assert.doesNotMatch(output, /password@example|fixture-password|fixture-token/u);
  assert.match(output, /AUTOMATION_OS_DATABASE_URL=\[redacted\]/u);
  assert.match(output, /DATABASE_URL=\[redacted\]/u);
  assert.doesNotMatch(output, /fixture-password|fixture-token/u);
});

test("worker workspace path resolves symlinks and rejects traversal outside the root", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-os-worker-root-"));
  const outside = mkdtempSync(join(tmpdir(), "automation-os-worker-outside-"));
  const link = join(root, "escape");
  symlinkSync(outside, link, "dir");

  assert.equal(resolveWorkerWorkspacePath(root, root), realpathSync(root));
  assert.throws(() => resolveWorkerWorkspacePath(join(root, ".."), root), /worker_cwd_outside_workspace/u);
  assert.throws(() => resolveWorkerWorkspacePath(link, root), /worker_cwd_outside_workspace/u);
  assert.throws(() => resolveWorkerWorkspacePath(root, join(root, "missing")), /worker_workspace_root_invalid/u);
});

test("safe worker environment canonicalizes the child Codex cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-os-worker-env-root-"));
  const child = safeWorkerEnvironment({
    PATH: "/bin",
    AUTOMATION_OS_WORKER_WORKSPACE_ROOT: root,
    AUTOMATION_OS_CHILD_CODEX_CWD: root
  });

  assert.equal(child.AUTOMATION_OS_WORKER_WORKSPACE_ROOT, realpathSync(root));
  assert.equal(child.AUTOMATION_OS_CHILD_CODEX_CWD, realpathSync(root));
});

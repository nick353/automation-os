import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// @ts-ignore - runtime imports the shared QA helper directly from scripts/.
import { buildReadbackContextOptions, buildReadbackHeaders, readProductionReadToken, readProductionReadTokenStatus } from "../../../../scripts/productionReadbackAuth.mjs";

test("production readback auth helper reads an explicit read token and ignores write token fallback", () => {
  const env = {
    AUTOMATION_OS_WRITE_TOKEN: "write-token",
    AUTOMATION_OS_READ_TOKEN: "read-token",
    AUTOMATION_OS_QA_READ_TOKEN: "qa-read-token",
    AUTOMATION_OS_REPLAY_READ_TOKEN: "replay-read-token"
  } as NodeJS.ProcessEnv;

  assert.equal(readProductionReadToken(env), "read-token");
  assert.deepEqual(buildReadbackHeaders("read-token"), { "x-automation-os-token": "read-token" });
  assert.deepEqual(buildReadbackHeaders(""), {});
  assert.deepEqual(buildReadbackContextOptions("read-token"), {
    extraHTTPHeaders: { "x-automation-os-token": "read-token" }
  });
  assert.deepEqual(buildReadbackContextOptions(""), {});
});

test("production readback auth helper falls back through read-only env names without using the write token", () => {
  const env = {
    AUTOMATION_OS_WRITE_TOKEN: "write-token",
    AUTOMATION_OS_QA_READ_TOKEN: "qa-read-token",
    AUTOMATION_OS_REPLAY_READ_TOKEN: "replay-read-token"
  } as NodeJS.ProcessEnv;

  assert.equal(readProductionReadToken(env), "qa-read-token");
});

test("production readback auth helper accepts an owner-only token file without exposing its value", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-os-read-token-file-"));
  const tokenPath = join(root, "read-token");
  writeFileSync(tokenPath, "file-read-token\n", { mode: 0o600 });
  chmodSync(tokenPath, 0o600);

  const env = { AUTOMATION_OS_READ_TOKEN_FILE: tokenPath } as NodeJS.ProcessEnv;
  assert.equal(readProductionReadToken(env), "file-read-token");
  assert.deepEqual(readProductionReadTokenStatus(env), {
    available: true,
    source: "file",
    exactBlocker: null
  });
  assert.doesNotMatch(JSON.stringify(readProductionReadTokenStatus(env)), /file-read-token/);
});

test("production readback auth helper rejects symlink and group-readable token files", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-os-read-token-file-invalid-"));
  const target = join(root, "target");
  const link = join(root, "link");
  writeFileSync(target, "file-read-token\n", { mode: 0o600 });
  chmodSync(target, 0o600);
  symlinkSync(target, link);

  const symlinkStatus = readProductionReadTokenStatus({ AUTOMATION_OS_READ_TOKEN_FILE: link } as NodeJS.ProcessEnv);
  assert.equal(symlinkStatus.available, false);
  assert.equal(symlinkStatus.exactBlocker, "production_read_token_file_permissions_invalid");

  chmodSync(target, 0o640);
  const modeStatus = readProductionReadTokenStatus({ AUTOMATION_OS_READ_TOKEN_FILE: target } as NodeJS.ProcessEnv);
  assert.equal(modeStatus.available, false);
  assert.equal(modeStatus.exactBlocker, "production_read_token_file_permissions_invalid");
});

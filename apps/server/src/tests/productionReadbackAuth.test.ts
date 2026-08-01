import assert from "node:assert/strict";
import test from "node:test";
// @ts-ignore - runtime imports the shared QA helper directly from scripts/.
import { buildReadbackContextOptions, buildReadbackHeaders, readProductionReadToken } from "../../../../scripts/productionReadbackAuth.mjs";

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

import assert from "node:assert/strict";
import test from "node:test";
import {
  runMvpStateInChild,
  type MvpStateExecFile,
  type MvpStateExecFileOptions
} from "../runs/mvpStateProcess.js";

const state = { company_scope: { enforced: true, company_ids: ["company_a"] } };

test("mvp state child passes the requested company scope and returns readback", async () => {
  let options: MvpStateExecFileOptions | undefined;
  const execFileImpl: MvpStateExecFile = (_command, args, nextOptions, callback) => {
    options = nextOptions;
    assert.equal(args.at(-1)?.endsWith("mvpStateReadOnce.js"), true);
    callback(null, JSON.stringify({ ok: true, state }) + "\n", "");
  };

  const outcome = await runMvpStateInChild({
    companyId: "company_a",
    execFileImpl,
    fileExists: (path) => path.endsWith("mvpStateReadOnce.js")
  });

  assert.deepEqual(outcome, { status: "completed", exactBlocker: null, state });
  assert.equal(options?.env.AUTOMATION_OS_MVP_STATE_COMPANY_ID, "company_a");
  assert.equal(options?.env.AUTOMATION_OS_POSTGRES_SCHEMA_ASSUMED_CURRENT, "1");
});

test("mvp state child converts a database timeout into an exact blocker", async () => {
  const execFileImpl: MvpStateExecFile = (_command, _args, _options, callback) => {
    callback({ code: "ETIMEDOUT", killed: true, signal: "SIGTERM" }, "", "secret-looking stderr");
  };

  const outcome = await runMvpStateInChild({ execFileImpl, fileExists: () => true });

  assert.deepEqual(outcome, { status: "blocked", exactBlocker: "mvp_state_child_timeout" });
});

test("mvp state child fails closed on scope errors, malformed output, and missing CLI", async () => {
  const scope = await runMvpStateInChild({
    execFileImpl: (_command, _args, _options, callback) => callback(null, JSON.stringify({ ok: false, exactBlocker: "company_scope_forbidden" }), ""),
    fileExists: () => true
  });
  const malformed = await runMvpStateInChild({
    execFileImpl: (_command, _args, _options, callback) => callback(null, "not-json\n", ""),
    fileExists: () => true
  });
  const missing = await runMvpStateInChild({ fileExists: () => false });

  assert.deepEqual(scope, { status: "blocked", exactBlocker: "company_scope_forbidden" });
  assert.deepEqual(malformed, { status: "blocked", exactBlocker: "mvp_state_child_invalid_output" });
  assert.deepEqual(missing, { status: "blocked", exactBlocker: "mvp_state_cli_missing" });
});

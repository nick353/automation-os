import assert from "node:assert/strict";
import test from "node:test";
import {
  runResearchPlanSchedulerInChild,
  type SchedulerExecFile,
  type SchedulerExecFileOptions
} from "../runs/researchPlanSchedulerProcess.js";

const result = {
  checked: 1,
  started: 0,
  skipped: 1,
  blocked: 0,
  runIds: [],
  blockedWorkflowIds: [],
  blockedDueKeys: [],
  blockers: []
};

test("scheduler child passes bounded scope and timestamp without echoing payload secrets", async () => {
  let command = "";
  let args: string[] = [];
  let options: SchedulerExecFileOptions | undefined;
  const execFileImpl: SchedulerExecFile = (nextCommand, nextArgs, nextOptions, callback) => {
    command = nextCommand;
    args = nextArgs;
    options = nextOptions;
    callback(null, `${JSON.stringify({ ok: true, result })}\n`, "");
  };

  const outcome = await runResearchPlanSchedulerInChild({
    now: new Date("2026-08-06T12:00:00.000Z"),
    allowedCompanyIds: ["company_a"],
    scopeRoles: ["owner", "admin"],
    execFileImpl,
    fileExists: (path) => path.endsWith("researchPlanSchedulerOnce.js")
  });

  assert.equal(outcome.status, "completed");
  assert.deepEqual(outcome.result, result);
  assert.equal(command, process.execPath);
  assert.equal(args.at(-1)?.endsWith("researchPlanSchedulerOnce.js"), true);
  assert.equal(options?.env.AUTOMATION_OS_SCHEDULER_NOW, "2026-08-06T12:00:00.000Z");
  assert.equal(options?.env.AUTOMATION_OS_SCHEDULER_ALLOWED_COMPANY_IDS, '["company_a"]');
  assert.equal(options?.env.AUTOMATION_OS_SCHEDULER_SCOPE_ROLES, "owner,admin");
  assert.equal(options?.env.AUTOMATION_OS_POSTGRES_SCHEMA_ASSUMED_CURRENT, "1");
  assert.equal("OPENAI_API_KEY" in outcome, false);
});

test("scheduler child converts a timeout into an exact safe blocker", async () => {
  const execFileImpl: SchedulerExecFile = (_command, _args, _options, callback) => {
    callback({ code: "ETIMEDOUT", killed: true, signal: "SIGTERM" }, "", "secret-looking stderr");
  };

  const outcome = await runResearchPlanSchedulerInChild({ execFileImpl, fileExists: () => true, timeoutMs: 2_000 });

  assert.deepEqual(outcome, { status: "blocked", exactBlocker: "research_plan_scheduler_child_timeout" });
});

test("scheduler child does not treat a nonzero child as a successful payload", async () => {
  const execFileImpl: SchedulerExecFile = (_command, _args, _options, callback) => {
    callback({ code: 1 }, JSON.stringify({ ok: true, result }), "database URL must not surface");
  };

  const outcome = await runResearchPlanSchedulerInChild({ execFileImpl, fileExists: () => true });

  assert.deepEqual(outcome, { status: "blocked", exactBlocker: "research_plan_scheduler_child_exit_nonzero" });
});

test("scheduler child rejects malformed output and missing CLI", async () => {
  const malformed = await runResearchPlanSchedulerInChild({
    execFileImpl: (_command, _args, _options, callback) => callback(null, "not-json\n", ""),
    fileExists: () => true
  });
  const missing = await runResearchPlanSchedulerInChild({ fileExists: () => false });

  assert.deepEqual(malformed, { status: "blocked", exactBlocker: "research_plan_scheduler_child_invalid_output" });
  assert.deepEqual(missing, { status: "blocked", exactBlocker: "research_plan_scheduler_cli_missing" });
});

test("scheduler child preserves a safe child scope blocker", async () => {
  const outcome = await runResearchPlanSchedulerInChild({
    execFileImpl: (_command, _args, _options, callback) => callback(null, JSON.stringify({ ok: false, exactBlocker: "company_scope_forbidden" }), ""),
    fileExists: () => true
  });

  assert.deepEqual(outcome, { status: "blocked", exactBlocker: "company_scope_forbidden" });
});

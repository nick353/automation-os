import assert from "node:assert/strict";
import test from "node:test";
import { runNaturalSchedulerSoak } from "../runs/naturalSchedulerSoak.js";
import type { DurableAutomationSchedulerOnceResult } from "../runs/durableAutomationScheduler.js";

function tickResult(input: {
  checkedAt: string;
  status?: DurableAutomationSchedulerOnceResult["status"];
  runId?: string;
  exactBlocker?: string | null;
}): DurableAutomationSchedulerOnceResult {
  return {
    schema: "aos.durable_scheduler_tick.v1",
    status: input.status ?? "completed",
    checkedAt: input.checkedAt,
    serviceUserConfigured: true,
    checkedCompanyIds: ["company_one"],
    initializedScheduleIds: [],
    handledScheduleIds: [],
    occurrences: [],
    portableRunIds: input.runId ? [input.runId] : [],
    portableScheduleIds: [],
    portableWorkflowIds: [],
    localWorkflowIds: [],
    skippedCompanyIds: [],
    serviceUserSource: "sole_company_operator",
    exactBlocker: input.exactBlocker ?? null,
    externalActionExecuted: false,
    nextAction: "test"
  };
}

test("natural scheduler soak runs bounded real ticks and records unique run ids", async () => {
  let calls = 0;
  const result = await runNaturalSchedulerSoak({
    companyId: "company_one",
    cycles: 3,
    intervalMs: 0,
    runTick: async ({ now }) => {
      calls += 1;
      return tickResult({ checkedAt: now ?? "", runId: `run-${calls}` });
    }
  });

  assert.equal(calls, 3);
  assert.equal(result.status, "completed");
  assert.equal(result.completedCycles, 3);
  assert.deepEqual(result.runIds, ["run-1", "run-2", "run-3"]);
  assert.deepEqual(result.duplicateRunIds, []);
  assert.equal(result.externalActionExecuted, false);
});

test("natural scheduler soak stops on the first exact blocker without replay", async () => {
  let calls = 0;
  const result = await runNaturalSchedulerSoak({
    companyId: "company_one",
    cycles: 5,
    intervalMs: 0,
    runTick: async ({ now }) => {
      calls += 1;
      return tickResult({
        checkedAt: now ?? "",
        status: "blocked",
        exactBlocker: "service_user_scope_incomplete"
      });
    }
  });

  assert.equal(calls, 1);
  assert.equal(result.status, "blocked");
  assert.equal(result.completedCycles, 1);
  assert.equal(result.exactBlocker, "service_user_scope_incomplete");
  assert.equal(result.nextAction.includes("再送"), true);
});

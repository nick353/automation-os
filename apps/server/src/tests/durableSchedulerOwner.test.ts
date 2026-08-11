import assert from "node:assert/strict";
import test from "node:test";
import { durableSchedulerOwner } from "../runs/durableAutomationScheduler.js";

test("durable scheduler keeps server as the safe default", () => {
  assert.equal(durableSchedulerOwner({}), "server");
  assert.equal(durableSchedulerOwner({ AUTOMATION_OS_DURABLE_SCHEDULER_OWNER: "server" }), "server");
});

test("worker launch configuration can explicitly own durable scheduling", () => {
  assert.equal(durableSchedulerOwner({ AUTOMATION_OS_DURABLE_SCHEDULER_OWNER: "worker" }), "worker");
  assert.equal(durableSchedulerOwner({ AUTOMATION_OS_DURABLE_SCHEDULER_OWNER: " WORKER " }), "worker");
});

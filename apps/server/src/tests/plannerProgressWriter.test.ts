import assert from "node:assert/strict";
import test from "node:test";
import { createPlannerProgressWriter } from "../planner/createPlannerJobs.js";

test("slow progress storage does not block event intake and coalesces the latest state", async () => {
  const writes: number[] = [];
  let release!: () => void;
  const firstWrite = new Promise<void>((resolve) => { release = resolve; });
  const writer = createPlannerProgressWriter(async (metadata) => {
    writes.push(Number(metadata.sequence));
    if (writes.length === 1) await firstWrite;
  });
  writer.enqueue({ sequence: 1 });
  for (let sequence = 2; sequence <= 1_000; sequence++) writer.enqueue({ sequence });
  assert.deepEqual(writes, [1]);
  let flushed = false;
  const flush = writer.flush().then(() => { flushed = true; });
  await Promise.resolve();
  assert.equal(flushed, false);
  release();
  await flush;
  assert.deepEqual(writes, [1, 1_000]);
  writer.enqueue({ sequence: 1_001 });
  await writer.flush();
  assert.deepEqual(writes, [1, 1_000, 1_001]);
});

test("a failed advisory progress write does not drop the next or final snapshot", async () => {
  const writes: number[] = [];
  const writer = createPlannerProgressWriter(async (metadata) => {
    writes.push(Number(metadata.sequence));
    if (writes.length === 1) throw new Error("fixture database timeout");
  });
  writer.enqueue({ sequence: 1 });
  writer.enqueue({ sequence: 2 });
  await writer.flush();
  assert.deepEqual(writes, [1, 2]);
});

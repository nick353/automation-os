import assert from "node:assert/strict";
import test from "node:test";
import { decomposeGoal } from "../planner/decompose.js";

test("decomposes goal into parallel-safe tasks with resources", () => {
  const tasks = decomposeGoal("Daily AI publish, Runway MCPで動画生成, Calendar保存");
  assert.equal(tasks.length, 3);
  assert.equal(tasks.every((task) => task.parallelSafe), true);
  assert.ok(tasks[0].resources.includes("social_publish"));
  assert.ok(tasks[1].resources.includes("runway_mcp"));
  assert.ok(tasks[2].resources.includes("calendar_write"));
});

test("merges response-only conditions into the previous actionable task", () => {
  const tasks = decomposeGoal("Codexでdocs/10-obsidian-export.md存在確認のみ。存在したら1文で終了。");

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].name, "Codexでdocs/10-obsidian-export.md存在確認のみ。存在したら1文で終了");
  assert.deepEqual(tasks[0].resources, ["local_worker"]);
});

test("does not split a Japanese comma inside a single QA task", () => {
  const tasks = decomposeGoal("QA用に、ユーザーがクリックする範囲だけを安全に洗い出したい");

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].name, "QA用に、ユーザーがクリックする範囲だけを安全に洗い出したい");
  assert.deepEqual(tasks[0].resources, ["local_worker"]);
});

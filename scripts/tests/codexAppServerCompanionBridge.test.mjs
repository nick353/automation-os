import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCompanionThreadProjection,
  classifyThreadExecutionBoundary,
  createCompanionThreadBridge,
  latestAssistantMessage,
} from "../lib/codex-app-server-companion-bridge.mjs";
import { createThreadAlias } from "../lib/thread-readback-projection.mjs";

function thread(id, overrides = {}) {
  return {
    id,
    ephemeral: false,
    parentThreadId: null,
    agentNickname: null,
    agentRole: null,
    source: "vscode",
    status: { type: "notLoaded" },
    updatedAt: 1788450000,
    ...overrides,
  };
}

test("does not depend on an undeclared process global in the node_repl callback boundary", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "../lib/codex-app-server-companion-bridge.mjs"), "utf8");
  assert.match(source, /const currentProcess = globalThis\.process;/u);
  assert.doesNotMatch(source, /typeof process\?\.execPath/u);
});

test("builds a bounded allowlisted projection from official App Server rows", () => {
  const first = thread("01a00000-0000-7000-8000-000000000001", { status: { type: "idle" } });
  const second = thread("01a00000-0000-7000-8000-000000000002", { status: { type: "active" } });
  const deepReadbacks = new Map([
    [first.id, { thread: { ...first, turns: [{ id: "turn-1", status: "completed" }] } }],
    [second.id, { thread: { ...second, turns: [{ id: "turn-2", status: "inProgress" }] } }],
  ]);
  const projection = buildCompanionThreadProjection({
    threads: [first, second],
    deepReadbacks,
    rootRunId: "root-run",
    childAuditId: "child-audit",
    maxDeepReads: 2,
  });
  assert.equal(projection.counts.listSucceeded, 1);
  assert.equal(projection.counts.lightweightRequested, 2);
  assert.equal(projection.counts.deepSucceeded, 2);
  assert.equal(projection.records.every((record) => /^t-[a-f0-9]{24}$/u.test(record.alias)), true);
  assert.equal(projection.records.some((record) => record.state.latestTurnStatus === "completed"), true);
});

test("treats an in-progress newest turn as busy even when task metadata says notLoaded", () => {
  const boundary = classifyThreadExecutionBoundary({
    status: { type: "notLoaded" },
    turns: [{ id: "turn-live", status: "inProgress" }],
  });
  assert.deepEqual(boundary, {
    taskStatus: "notLoaded",
    latestTurnStatus: "inProgress",
    active: true,
    exactBlocker: "codex_app_thread_active_boundary_required",
  });
});

test("keeps an idle completed turn eligible for a message boundary", () => {
  const boundary = classifyThreadExecutionBoundary({
    status: { type: "idle" },
    turns: [{ id: "turn-done", status: "completed" }],
  });
  assert.deepEqual(boundary, {
    taskStatus: "idle",
    latestTurnStatus: "completed",
    active: false,
    exactBlocker: null,
  });
});

test("recognizes the newest turn as the authoritative completed turn for readback", () => {
  const target = thread("01a00000-0000-7000-8000-000000000006", { status: { type: "notLoaded" } });
  const projection = buildCompanionThreadProjection({
    threads: [target],
    deepReadbacks: new Map([[target.id, {
      thread: {
        ...target,
        turns: [{
          id: "turn-new",
          status: "completed",
          items: [{ type: "agentMessage", text: "Goal予算へ到達したため、E2Eは未実施です。" }],
        }],
      },
    }]]),
    rootRunId: "root-run-budget",
    childAuditId: "child-audit-budget",
    maxDeepReads: 1,
  });
  const deepRecord = projection.records.find((record) => record.readClass === "deep");
  assert.equal(deepRecord?.state.latestTurnStatus, "completed");
  assert.equal(latestAssistantMessage({ turns: [{ items: [{ type: "agentMessage", text: "Goal予算へ到達したため、E2Eは未実施です。" }] }] }), "Goal予算へ到達したため、E2Eは未実施です。");
});

test("passes the official turn-page order through the bridge readback", () => {
  const target = thread("01a00000-0000-7000-8000-000000000005", { status: { type: "idle" } });
  const projection = buildCompanionThreadProjection({
    threads: [target],
    deepReadbacks: new Map([[target.id, {
      thread: {
        ...target,
        turns: [
          { id: "turn-old", status: "completed" },
          { id: "turn-new", status: "inProgress" },
        ],
      },
      turnPage: {
        order: "oldest_first",
        data: [],
      },
    }]]),
    rootRunId: "root-run-ordered",
    childAuditId: "child-audit-ordered",
    maxDeepReads: 1,
  });
  const deepRecord = projection.records.find((record) => record.readClass === "deep");
  assert.equal(deepRecord?.state.latestTurnStatus, "inProgress");
});

test("filters agent children and excludes them from projection", () => {
  const userThread = thread("01a00000-0000-7000-8000-000000000003");
  const childThread = thread("01a00000-0000-7000-8000-000000000004", {
    parentThreadId: userThread.id,
    source: { subAgent: "review" },
  });
  const projection = buildCompanionThreadProjection({
    threads: [userThread, childThread],
    rootRunId: "root-run",
    childAuditId: "child-audit",
  });
  assert.deepEqual(projection.records.map((record) => record.alias), [createThreadAlias(userThread.id)]);
});

test("keeps all listed tasks and their bounded deep reads within the projection limit", () => {
  const threads = Array.from({ length: 128 }, (_, index) => thread(`01a00000-0000-7000-8000-${String(index).padStart(12, "0")}`));
  const deepReadbacks = new Map(threads.map((item, index) => [item.id, {
    thread: {
      ...item,
      turns: [{ id: `turn-${index}`, status: "completed" }],
    },
  }]));
  const projection = buildCompanionThreadProjection({
    threads,
    deepReadbacks,
    rootRunId: "root-run",
    childAuditId: "child-audit",
    maxDeepReads: 128,
  });
  assert.equal(projection.records.length, 256);
  assert.equal(projection.counts.deepAttempted, 128);
  assert.equal(projection.limits.listTruncated, false);
});

test("hands the continuation to a detached worker with the task cwd", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-app-server-bridge-"));
  const binary = path.join(root, "fake-app-server.mjs");
  const recordFile = path.join(root, "requests.jsonl");
  const threadId = "01a00000-0000-7000-8000-000000000007";
  fs.writeFileSync(binary, `#!/usr/bin/env node
const recordFile = ${JSON.stringify(recordFile)};
const threadId = ${JSON.stringify(threadId)};
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
function thread() {
  return { id: threadId, cwd: "/tmp/listed-cwd", status: { type: "notLoaded" }, updatedAt: 1788450000 };
}
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") reply(request.id, {});
    else if (request.method === "thread/list") reply(request.id, { data: [thread()] });
    else if (request.method === "thread/read") reply(request.id, { thread: thread() });
    else if (request.method === "thread/turns/list") reply(request.id, { data: [{ id: "turn-1", status: "completed" }] });
  }
});
`, "utf8");
  fs.chmodSync(binary, 0o700);

  const bridge = await createCompanionThreadBridge({
    binary,
    rootRunId: "bridge-cwd-test",
    maxRecords: 1,
    maxDeepReads: 1,
    continuationWorkerRoot: root,
    continuationWorkerLauncher: ({ job }) => {
      fs.appendFileSync(recordFile, JSON.stringify({ method: "worker/start", job }) + "\n");
      return { pid: 123 };
    },
  });
  try {
    const result = await bridge.sendMessage({
      threadId,
      cwd: "/tmp/request-cwd",
      prompt: "continue",
    });
    assert.equal(result.status, "accepted");
    const requests = fs.readFileSync(recordFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(requests.map((request) => request.method), ["worker/start"]);
    assert.equal(requests[0].job.cwd, "/tmp/request-cwd");
    assert.equal(requests[0].job.threadId, threadId);
    assert.equal(result.workerJobId, requests[0].job.jobId);
  } finally {
    bridge.close();
  }
});

test("reads a detached worker completion without relying on the controller connection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-app-server-worker-readback-"));
  const binary = path.join(root, "fake-app-server.mjs");
  const threadId = "01a00000-0000-7000-8000-000000000009";
  fs.writeFileSync(binary, `#!/usr/bin/env node
const threadId = ${JSON.stringify(threadId)};
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") reply(request.id, {});
    else if (request.method === "thread/list") reply(request.id, { data: [{ id: threadId, status: { type: "notLoaded" }, updatedAt: 1788450000 }] });
    else if (request.method === "thread/read") reply(request.id, { thread: { id: threadId, status: { type: "notLoaded" }, updatedAt: 1788450000 } });
    else if (request.method === "thread/turns/list") reply(request.id, { data: [{ id: "turn-1", status: "completed" }] });
  }
});
`, "utf8");
  fs.chmodSync(binary, 0o700);
  const bridge = await createCompanionThreadBridge({
    binary,
    rootRunId: "bridge-worker-readback-test",
    maxRecords: 1,
    maxDeepReads: 1,
    continuationWorkerRoot: root,
    continuationWorkerLauncher: ({ job }) => {
      setTimeout(() => fs.writeFileSync(job.resultPath, JSON.stringify({
        schema: "aos.codex_app_server_continuation_result.v1",
        jobId: job.jobId,
        threadId,
        idempotencyKey: job.idempotencyKey,
        status: "completed",
        turnId: "turn-worker",
        turnStatus: "completed",
        exactBlocker: null,
        externalActionExecuted: false,
      })), 10);
      return { pid: 456 };
    },
  });
  try {
    const sent = await bridge.sendMessage({
      threadId,
      cwd: "/tmp/request-cwd",
      prompt: "continue",
      idempotencyKey: "aos-hourly:worker-readback",
    });
    const completed = await bridge.waitForCompletion({
      threadId,
      idempotencyKey: "aos-hourly:worker-readback",
      timeoutMs: 1_000,
    });
    assert.equal(sent.status, "accepted");
    assert.equal(completed.status, "completed");
    assert.equal(completed.turnId, "turn-worker");
  } finally {
    bridge.close();
  }
});

test("maps an active-writer worker rejection to a known active boundary", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-app-server-active-writer-result-"));
  const binary = path.join(root, "fake-app-server.mjs");
  const threadId = "01a00000-0000-7000-8000-000000000010";
  fs.writeFileSync(binary, `#!/usr/bin/env node
const threadId = ${JSON.stringify(threadId)};
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") reply(request.id, {});
    else if (request.method === "thread/list") reply(request.id, { data: [{ id: threadId, status: { type: "notLoaded" }, updatedAt: 1788450000 }] });
    else if (request.method === "thread/read") reply(request.id, { thread: { id: threadId, status: { type: "notLoaded" }, updatedAt: 1788450000 } });
    else if (request.method === "thread/turns/list") reply(request.id, { data: [{ id: "turn-1", status: "completed" }] });
  }
});
`, "utf8");
  fs.chmodSync(binary, 0o700);
  const bridge = await createCompanionThreadBridge({
    binary,
    rootRunId: "bridge-active-writer-result-test",
    maxRecords: 1,
    maxDeepReads: 1,
    continuationWorkerRoot: root,
    continuationWorkerLauncher: ({ job }) => {
      fs.writeFileSync(job.resultPath, JSON.stringify({
        schema: "aos.codex_app_server_continuation_result.v1",
        jobId: job.jobId,
        threadId,
        idempotencyKey: job.idempotencyKey,
        status: "failed",
        turnId: null,
        exactBlocker: "codex_app_server_protocol_error:thread/resume",
        preDispatchNoEffect: true,
        error: { method: "thread/resume", message: "thread already has an active writer" },
        externalActionExecuted: false,
      }));
      return { pid: 789 };
    },
  });
  try {
    const sent = await bridge.sendMessage({ threadId, prompt: "continue", idempotencyKey: "aos-hourly:active-writer" });
    const completion = await bridge.waitForCompletion({ threadId, idempotencyKey: "aos-hourly:active-writer", timeoutMs: 1_000 });
    assert.equal(sent.status, "accepted");
    assert.equal(completion.status, "failed");
    assert.equal(completion.exact_blocker, "codex_app_thread_active_boundary_required");
    assert.equal(completion.activeExecutionBoundary, true);
    assert.equal(completion.preDispatchNoEffect, true);
  } finally {
    bridge.close();
  }
});

test("does not launch a worker when the fresh boundary is active", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-app-server-active-writer-"));
  const binary = path.join(root, "fake-app-server.mjs");
  const recordFile = path.join(root, "requests.jsonl");
  const threadId = "01a00000-0000-7000-8000-000000000008";
  fs.writeFileSync(binary, `#!/usr/bin/env node
import fs from "node:fs";
const recordFile = ${JSON.stringify(recordFile)};
const threadId = ${JSON.stringify(threadId)};
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
function errorReply(id, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\\n");
}
function thread() {
  return { id: threadId, cwd: "/tmp/listed-cwd", status: { type: "notLoaded" }, updatedAt: 1788450000 };
}
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") reply(request.id, {});
    else if (request.method === "thread/list") reply(request.id, { data: [thread()] });
    else if (request.method === "thread/read") reply(request.id, { thread: thread() });
    else if (request.method === "thread/turns/list") reply(request.id, { data: [{ id: "turn-1", status: "inProgress" }] });
  }
});
`, "utf8");
  fs.chmodSync(binary, 0o700);

  const bridge = await createCompanionThreadBridge({
    binary,
    rootRunId: "bridge-active-writer-test",
    maxRecords: 1,
    maxDeepReads: 1,
    continuationWorkerRoot: root,
    continuationWorkerLauncher: () => {
      fs.appendFileSync(recordFile, JSON.stringify({ method: "worker/start" }) + "\n");
      return { pid: 123 };
    },
  });
  try {
    await assert.rejects(
      () => bridge.sendMessage({ threadId, cwd: "/tmp/request-cwd", prompt: "continue" }),
      (error) => error?.exact_blocker === "codex_app_thread_active_boundary_required",
    );
    const requests = fs.existsSync(recordFile)
      ? fs.readFileSync(recordFile, "utf8").trim().split("\\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
    assert.deepEqual(requests.map((request) => request.method), []);
  } finally {
    bridge.close();
  }
});

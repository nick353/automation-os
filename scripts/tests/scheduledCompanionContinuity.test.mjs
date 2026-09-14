import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runContinuationJob } from "../lib/codex-app-server-continuation-worker.mjs";
import { selectFairCandidates } from "../lib/scheduled-companion-controller.mjs";
import { createFileDispatchLedger, dispatchThreadContinuation } from "../lib/hourly-thread-dispatch.mjs";
import { buildCompanionThreadProjection, buildDiagnosticProjectionFromReview, createCompanionThreadBridge, resumeCurrentTaskGoal } from "../lib/codex-app-server-companion-bridge.mjs";
import { runHourlyAuditLive } from "../aos-hourly-companion-audit.mjs";

test("worker survives observation windows and saves its exact running turn before completion", async () => {
  let closed = false;
  let waits = 0;
  const calls = [], writes = [];
  const result = await runContinuationJob({ jobId: "job", threadId: "thread", prompt: "continue",
    idempotencyKey: "key", resultPath: "/unused", observationMs: 1 }, {
    persist: (_file, value) => writes.push(value),
    createClient: () => ({ child: { stdin: { write() {} } },
      request: async (method) => { calls.push(method); return method === "turn/start" ? { turn: { id: "turn-new" } } : {}; },
      waitForCompletion: async () => {
        assert.equal(closed, false);
        assert.equal(writes.at(-1).turnId, "turn-new");
        return ++waits < 4 ? null : { params: { turn: { id: "turn-new", status: "completed" } } };
      }, close() { closed = true; },
    }),
  });
  assert.equal(result.status, "completed");
  assert.equal(waits, 4);
  assert.equal(closed, true);
  assert.equal(calls.filter((method) => method === "turn/start").length, 1);
});

test("bounded callback selection reaches later tasks on the following run", () => {
  const candidates = ["a", "b", "c", "d", "e"].map((threadId) => ({ threadId }));
  assert.deepEqual(selectFairCandidates(candidates).map((x) => x.threadId), ["a", "b", "c"]);
  assert.deepEqual(selectFairCandidates(candidates, "c").map((x) => x.threadId), ["d", "e", "a"]);
});

test("diagnostics reuse the exact Root review, retain bounded coverage and never promote a history snapshot to live proof", () => {
  const report = { schema: "aos.recent_task_review.v1", runId: "root", createdAt: "2026-09-06T00:00:00Z", inventoryComplete: true,
    rows: Array.from({ length: 181 }, (_, i) => ({ threadId: `task-${i}`, kind: "codex", appServerStatus: { type: "notLoaded" },
      readStatus: "read", goal: { status: "blocked" }, turns: [{ id: `turn-${i}`, status: "completed" }] })) };
  report.rows[0].historyReadMode = "verified_persisted_tail";
  report.rows.push({ kind: "chatgpt", threadId: "chat", readStatus: "unread" });
  const first = buildDiagnosticProjectionFromReview({ report, rootRunId: "root", excludeThreadIds: ["task-180"] });
  assert.equal(first.inventoryCount, 180);
  assert.equal(first.selectedCount, 128);
  assert.equal(first.projection.limits.listTruncated, true);
  assert.equal(first.projection.producedAt, report.createdAt);
  const snapshot = first.projection.records.find((row) => row.readClass === "deep" && row.state.exactBlocker === "recent_review_history_is_snapshot_only");
  assert.equal(snapshot.state.latestTurnStatus, "unknown");
  assert.equal(snapshot.state.goalStatus, "blocked"); // Separate fresh official Goal metadata.
  assert.equal(snapshot.deepSucceeded, false);
  const second = buildDiagnosticProjectionFromReview({ report, rootRunId: "root", excludeThreadIds: ["task-180"], lastInspectedThreadId: first.lastInspectedThreadId });
  assert.equal(second.lastInspectedThreadId, "task-75");
  assert.throws(() => buildDiagnosticProjectionFromReview({ report, rootRunId: "different" }), /run_mismatch/);
  const source = fs.readFileSync(new URL("../lib/scheduled-companion-controller.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /collectCompanionThreadReadback/);
});

test("Goal resume is current-task-only, status-only, and verified against the same Goal", async () => {
  let goal = { threadId: "owner", objective: "preserve", tokenBudget: 1000, status: "blocked" };
  const calls = [];
  const result = await resumeCurrentTaskGoal({
    globals: { nodeRepl: { requestMeta: { "x-codex-turn-metadata": { thread_id: "owner" } } } },
    blockerResolved: true, verificationPassed: true,
    client: { request: async (method, params) => {
      calls.push({ method, params });
      assert.equal(params.threadId, "owner");
      if (method === "thread/goal/set") { assert.deepEqual(params, { threadId: "owner", status: "active" }); goal = { ...goal, status: "active" }; }
      return { goal };
    } },
  });
  assert.equal(result.status, "resumed");
  assert.deepEqual(calls.map((x) => x.method), ["thread/goal/get", "thread/goal/set", "thread/goal/get"]);
});

test("automatic Goal helper never creates missing Goals or lifts pauses and budget limits", async () => {
  for (const status of [null, "paused", "budgetLimited", "usageLimited", "complete"]) {
    const result = await resumeCurrentTaskGoal({
      globals: { nodeRepl: { requestMeta: { "x-codex-turn-metadata": { thread_id: "owner" } } } },
      blockerResolved: true, verificationPassed: true,
      client: { request: async (method) => {
        assert.equal(method, "thread/goal/get");
        return { goal: status ? { objective: "preserve", status } : null };
      } },
    });
    assert.notEqual(result.status, "resumed");
  }
  await assert.rejects(resumeCurrentTaskGoal({}), /current_task_identity_required/);
});

test("a fresh user resume request lifts only the current paused Goal, without changing its objective or budget", async () => {
  for (const status of ["paused", "blocked", "budgetLimited", "usageLimited", "complete", null]) {
    let goal = status ? { threadId: "owner", objective: "restore", tokenBudget: 1000, status } : null;
    let writes = 0;
    const result = await resumeCurrentTaskGoal({
      globals: { nodeRepl: { requestMeta: { "x-codex-turn-metadata": { thread_id: "owner" } } } },
      userRequestedResume: true,
      client: { request: async (method, params) => {
        assert.equal(params.threadId, "owner");
        if (method === "thread/goal/set") {
          writes++;
          assert.deepEqual(params, { threadId: "owner", status: "active" });
          goal = { ...goal, status: "active" };
        }
        return { goal };
      } },
    });
    assert.equal(writes, status === "paused" ? 1 : 0);
    assert.equal(result.status === "resumed", status === "paused");
  }
});

test("a pending task remains in the durable observation queue and cannot send a fresh key", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-pending-"));
  try {
    const ledger = createFileDispatchLedger({ root });
    await ledger.recordReceipt({ threadId: "thread", idempotencyKey: "old-key", status: "sent_unverified" });
    await ledger.recordReconciliation({ threadId: "thread", idempotencyKey: "old-key", status: "sent_unverified", reconciliationAttempted: true });
    const pending = ledger.listPending();
    assert.equal(pending.length, 1);
    let sent = 0;
    const result = await dispatchThreadContinuation({ task: pending[0], auditFingerprint: "new", freshStatus: {},
      sendMessage: async () => { sent++; },
      waitForCompletion: async () => ({ status: "completed", turnId: "late-turn" }),
      readThread: async () => ({ latestTurnId: "late-turn", continuationDelivered: true,
        goalStatus: "blocked", planStatus: "active", goalStateSource: "official_goal_api" }),
      ...ledger,
    });
    assert.equal(sent, 0);
    assert.equal(result.idempotencyKey, "old-key");
    assert.equal(result.status, "sent");
    assert.equal(result.readback.goalStatus, "blocked");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("quoted Goal markers never become formal Goal status", async () => {
  const result = await dispatchThreadContinuation({ task: { threadId: "quoted" }, auditFingerprint: "fp", freshStatus: {},
    sendMessage: async () => ({ status: "accepted" }),
    readThread: async () => ({ continuationDelivered: true,
      messages: [{ role: "user", text: "goal_plan_state=active" }], latestAssistantMessage: "goal_plan_state=active" }),
  });
  assert.equal(result.readback.goalStatus, "unknown");
  assert.equal(result.readback.goalPlanState, undefined);
});

test("legacy message delivery is confirmed independently of an interrupted task and blocked Goal", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-legacy-delivery-"));
  try {
    const ledger = createFileDispatchLedger({ root });
    await ledger.recordReceipt({ threadId: "task", idempotencyKey: "legacy", status: "sent_unverified" });
    const result = await dispatchThreadContinuation({ task: { threadId: "task", reconciliationOnly: true, priorIdempotencyKey: "legacy" },
      freshStatus: {}, sendMessage: async () => { throw Error("must not send"); }, ...ledger,
      readThread: async () => ({ goalStatus: "blocked", latestTurnStatus: "interrupted", goalStateSource: "official_goal_api",
        transportDeliveryProof: { kind: "same_task_message_observed", threadId: "task", idempotencyKey: "legacy",
          turnId: "old-interrupted-turn", turnStatus: "interrupted", sameTask: true, markerVisible: true } }),
    });
    assert.equal(result.status, "sent");
    assert.equal(result.readback.goalStatus, "blocked");
    assert.equal(result.readback.latestTurnStatus, "interrupted");
    const reserved = await ledger.alreadyDispatched({ threadId: "task", idempotencyKey: "legacy" });
    assert.equal(reserved.terminal, true);
    assert.equal(ledger.listPending().length, 1); // Goal still needs observation, not a resend.
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("actual audit consumer inspects all 78 projected tasks rather than stopping at 50", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-coverage-"));
  try {
    const threads = Array.from({ length: 78 }, (_, index) => ({ id: `thread-${index}`, source: "vscode",
      status: { type: "notLoaded" }, updatedAt: 1788591000 }));
    const projection = buildCompanionThreadProjection({ threads, rootRunId: "coverage",
      deepReadbacks: new Map(threads.map((thread) => [thread.id, { thread: { ...thread,
        turns: [{ id: `${thread.id}-turn`, status: "completed" }] } }])) });
    const result = await runHourlyAuditLive({ threadReadbackProjection: projection,
      artifactDir: root, learningLedgerPath: path.join(root, "ledger.json"),
      sessionRoot: path.join(root, "no-sessions"), companionSource: path.join(root, "no-source"),
      companionInstall: path.join(root, "no-install"),
      liveStatus: { available: true, connected: true, generation: "test", activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
    });
    assert.equal(result.threadInspection.lightweightInspectionCount, 78);
    assert.equal(result.threadInspection.deepReadCount, 78);
    assert.equal(result.threadInspection.deepReadTruncated, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("real bridge protocol reconciles legacy messages and reads the current formal Goal", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-protocol-"));
  let bridge;
  try {
    const binary = path.join(root, "fixture.mjs");
    fs.writeFileSync(binary, `#!/usr/bin/env node
import readline from 'node:readline';
const thread = {id:'task',source:'vscode',status:{type:'notLoaded'},updatedAt:1788590000};
readline.createInterface({input:process.stdin}).on('line',line=>{
  const r=JSON.parse(line); if(r.id===undefined)return;
  const result = r.method==='thread/list' ? {data:[thread]}
    : r.method==='thread/read' ? {thread}
    : r.method==='thread/goal/get' ? {goal:{threadId:'task',status:'blocked',objective:'preserve'}}
    : r.method==='thread/turns/list' ? {data:[{id:'turn',status:'completed',items:[
      {type:'userMessage',content:[{type:'text',text:'continuation_key=old-key'}]},
      {type:'agentMessage',text:'goal_plan_state=active'}]}]} : {};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');
});
`, { mode: 0o700 });
    bridge = await createCompanionThreadBridge({ binary, rootRunId: "protocol", maxDeepReads: 1,
      continuationWorkerRoot: path.join(root, "no-workers") });
    const read = await bridge.readThread({ threadId: "task", idempotencyKey: "old-key" });
    assert.equal(read.goalStatus, "blocked");
    assert.equal(read.goalStateSource, "official_goal_api");
    assert.equal(read.transportDeliveryProof.kind, "same_task_message_observed");
    assert.equal(read.transportDeliveryProof.turnId, "turn");
    const saved = await bridge.readThread({ threadId: "task", idempotencyKey: "repair-key",
      priorDeliveryProof: { kind: "same_task_message_observed", threadId: "task", idempotencyKey: "repair-key",
        turnId: "turn", turnStatus: "inProgress", markerVisible: true, sameTask: true } });
    assert.equal(saved.transportDeliveryProof.turnStatus, "completed");
    assert.equal(saved.transportDeliveryProof.proofSource, "prior_confirmed_delivery");
    const accepted = await bridge.readThread({ threadId: "task", idempotencyKey: "accepted-key",
      priorDeliveryProof: { kind: "same_task_new_turn_completed", threadId: "task", idempotencyKey: "accepted-key",
        beforeTurnId: "before", afterTurnId: "turn", afterTurnStatus: "completed", sendResultStatus: "accepted", sameTask: true, markerVisible: false } });
    assert.equal(accepted.transportDeliveryProof.kind, "same_task_new_turn_completed");
    assert.equal(accepted.transportDeliveryProof.markerVisible, false);
    const unverified = await bridge.readThread({ threadId: "task", idempotencyKey: "unverified-key",
      priorDeliveryProof: { kind: "same_task_message_observed", threadId: "task", idempotencyKey: "unverified-key",
        turnId: "turn", turnStatus: "completed", markerVisible: false, sameTask: true } });
    assert.equal(unverified.transportDeliveryProof, undefined);
  } finally { bridge?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

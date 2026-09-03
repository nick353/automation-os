import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  buildContinuationIdempotencyKey,
  buildContinuationMessage,
  createFileDispatchLedger,
  dispatchThreadContinuation,
  dispatchThreadContinuations,
} from "../lib/hourly-thread-dispatch.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("builds a stable continuation key and preserves the one-next-action baton", () => {
  const task = { taskId: "task-1", threadId: "thread-1", goalId: "goal-1", planId: "plan-1", taskType: "note" };
  const first = buildContinuationIdempotencyKey({ task, auditFingerprint: "fp", generation: "gen-1", nextAction: "read back" });
  const second = buildContinuationIdempotencyKey({ task, auditFingerprint: "fp", generation: "gen-1", nextAction: "read back" });
  assert.equal(first, second);
  assert.notEqual(
    first,
    buildContinuationIdempotencyKey({
      task: { ...task, targetIdentity: { sessionId: "session-2", pageInstanceId: "page-2" } },
      auditFingerprint: "fp",
      generation: "gen-1",
      nextAction: "read back",
    }),
  );
  const message = buildContinuationMessage({
    task,
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    executionReceipt: {
      schema: "aos.companion_hourly_execution_receipt.v1",
      status: "completed",
      stages: {
        fresh_status: { status: "completed" },
        same_run_real_e2e: { status: "completed" },
      },
    },
    nextAction: "read back",
    proof: ["same-run E2E passed"],
    stopConditions: ["unknown effect"],
  });
  assert.match(message, /goal=goal-1 plan=plan-1/u);
  assert.match(message, /One next action now: read back/u);
  assert.match(message, /same-run E2E passed/u);
  assert.match(message, /execution_receipt schema=aos\.companion_hourly_execution_receipt\.v1 status=completed/u);
  assert.match(message, /target_identity task=task-1 session=unknown lease=unknown/u);
  assert.match(message, /Goal\/Plan confirmation: use this task's own exposed Goal\/Plan readback/u);
  assert.match(message, /A delivered message alone is not Goal\/Plan proof/u);
  assert.ok(message.length <= 6_000);
});

test("adds task-owned Companion relay instructions to the same-thread message", () => {
  const message = buildContinuationMessage({
    task: { taskId: "task-relay", threadId: "thread-relay", goalId: "goal-relay", planId: "plan-relay" },
    lane: "task_owned_companion_relay",
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    nextAction: "resume the existing Goal after the local repair",
  });
  assert.match(message, /Task-owned Companion relay/u);
  assert.match(message, /This task is now the owner/u);
  assert.match(message, /Do not adopt foreign resources/u);
});

test("sends one existing-thread continuation and distinguishes readback from completion", async () => {
  const calls = [];
  const result = await dispatchThreadContinuation({
    task: { threadId: "thread-1", hostId: "local", goalId: "goal-1", planId: "plan-1" },
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue the existing plan",
    sendMessage: async (request) => { calls.push(request); return { status: "accepted" }; },
    readThread: async () => ({ deliveryConfirmed: true, continuationTurnId: "turn-2", status: "active" }),
  });
  assert.equal(result.status, "sent");
  assert.equal(result.external_action_executed, false);
  assert.equal(result.readback.status, "observed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].threadId, "thread-1");
  assert.match(calls[0].prompt, /continuation_key=aos-hourly:/u);
  assert.match(calls[0].prompt, /continue the existing plan/u);
});

test("suppresses duplicate continuations within one batch", async () => {
  let sends = 0;
  const result = await dispatchThreadContinuations({
    tasks: [
      { threadId: "thread-1", goalId: "goal-1" },
      { threadId: "thread-1", goalId: "goal-1" },
    ],
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => { sends += 1; return { status: "accepted" }; },
  });
  assert.equal(sends, 1);
  assert.equal(result.results[0].status, "sent_unverified");
  assert.equal(result.results[1].status, "duplicate_suppressed");
});

test("does not treat a successful thread read as delivery without proof", async () => {
  const result = await dispatchThreadContinuation({
    task: { threadId: "thread-readback-only" },
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => ({ status: "accepted" }),
    readThread: async () => ({ status: "active", turns: [] }),
  });
  assert.equal(result.status, "sent_unverified");
  assert.equal(result.exact_blocker, "thread_send_delivery_not_confirmed");
  assert.equal(result.replay_allowed, false);
});

test("matches the continuation marker in the same-task readback", async () => {
  let continuationKey = null;
  const result = await dispatchThreadContinuation({
    task: { threadId: "thread-marker-proof" },
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async ({ idempotencyKey }) => {
      continuationKey = idempotencyKey;
      return { status: "accepted" };
    },
    readThread: async () => ({
      status: "active",
      turns: [{ items: [{ type: "userMessage", text: `Hourly continuation_key=${continuationKey}` }] }],
    }),
  });
  assert.equal(result.status, "sent");
  assert.equal(result.readback.status, "observed");
  assert.equal(result.exact_blocker, null);
});

test("matches a continuation marker nested in the official App functionCallOutput", async () => {
  let continuationKey = null;
  const result = await dispatchThreadContinuation({
    task: { threadId: "thread-official-delegation-output" },
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async ({ idempotencyKey }) => {
      continuationKey = idempotencyKey;
      return { status: "accepted" };
    },
    readThread: async () => ({
      content: [{
        type: "text",
        text: JSON.stringify({
          turns: [{
            items: [{
              type: "functionCallOutput",
              name: "send_message_to_thread",
              output: { text: `<codex_delegation> continuation_key=${continuationKey}` },
            }],
          }],
        }),
      }],
    }),
  });
  assert.equal(result.status, "sent");
  assert.equal(result.readback.status, "observed");
  assert.equal(result.exact_blocker, null);
});

test("preserves explicit Goal/Plan state from the same-task readback", async () => {
  const result = await dispatchThreadContinuation({
    task: { threadId: "thread-goal-state" },
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue the existing Goal",
    sendMessage: async () => ({ status: "accepted" }),
    readThread: async () => ({
      deliveryConfirmed: true,
      continuationTurnId: "turn-2",
      goal_plan_state: "active",
      status: "active",
    }),
  });
  assert.equal(result.status, "sent");
  assert.equal(result.readback.goalPlanState, "active");
});

test("keeps an accepted send unverified when Codex thread readback is unavailable", async () => {
  const result = await dispatchThreadContinuation({
    task: { threadId: "thread-1" },
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    nextAction: "read back",
    sendMessage: async () => ({ status: "accepted" }),
    readThread: async () => ({ isError: true, error: "No Codex thread found" }),
  });
  assert.equal(result.status, "sent_unverified");
  assert.equal(result.exact_blocker, "No Codex thread found");
  assert.equal(result.external_action_executed, false);
});

test("persists dispatch intent before sending and records the terminal receipt", async () => {
  const events = [];
  const result = await dispatchThreadContinuation({
    task: { threadId: "thread-1" },
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    recordIntent: async (intent) => { events.push(`intent:${intent.phase}`); return { ok: true }; },
    sendMessage: async () => { events.push("send"); return { status: "accepted" }; },
    readThread: async () => { events.push("readback"); return { deliveryConfirmed: true, continuationTurnId: "turn-2", status: "active" }; },
    recordReceipt: async (receipt) => { events.push(`receipt:${receipt.phase}`); return { ok: true }; },
  });
  assert.equal(result.status, "sent");
  assert.deepEqual(events, ["intent:intent", "send", "readback", "receipt:receipt"]);
});

test("does not send when immutable dispatch intent cannot be persisted", async () => {
  let sends = 0;
  const result = await dispatchThreadContinuation({
    task: { threadId: "thread-1" },
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    recordIntent: async () => ({ ok: false, exact_blocker: "ledger_busy" }),
    sendMessage: async () => { sends += 1; return { status: "accepted" }; },
  });
  assert.equal(sends, 0);
  assert.equal(result.status, "deferred");
  assert.equal(result.exact_blocker, "ledger_busy");
});

test("turns host resolution errors into a bounded deferred result", async () => {
  let sends = 0;
  const result = await dispatchThreadContinuation({
    task: { threadId: "thread-1" },
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    resolveHostId: async () => { throw new Error("host_unavailable"); },
    sendMessage: async () => { sends += 1; return { status: "accepted" }; },
  });
  assert.equal(sends, 0);
  assert.equal(result.status, "deferred");
  assert.equal(result.exact_blocker, "host_unavailable");
});

test("records an uncertain timeout as unverified and never treats it as a safe replay", async () => {
  const receipts = [];
  const result = await dispatchThreadContinuation({
    task: { threadId: "thread-1" },
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => { throw Object.assign(new Error("bridge timed out"), { code: "broker_request_timeout" }); },
    recordReceipt: async (receipt) => { receipts.push(receipt); return { ok: true }; },
  });
  assert.equal(result.status, "sent_unverified");
  assert.equal(result.exact_blocker, "broker_request_timeout");
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].phase, "receipt");
});

test("reconciles an uncertain send once and never sends the same key again", async () => {
  let sends = 0;
  let readbacks = 0;
  const result = await dispatchThreadContinuation({
    task: { threadId: "thread-unknown-send" },
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => {
      sends += 1;
      throw Object.assign(new Error("bridge timed out"), { code: "broker_request_timeout" });
    },
    readThread: async ({ reason }) => {
      readbacks += 1;
      assert.equal(reason, "uncertain_send_no_replay");
      return { deliveryConfirmed: true, continuationTurnId: "turn-2", status: "active" };
    },
  });
  assert.equal(sends, 1);
  assert.equal(readbacks, 1);
  assert.equal(result.status, "sent");
  assert.equal(result.replay_allowed, false);
  assert.equal(result.exact_blocker, null);
});

test("classifies an explicit unknown send response as sent_unverified after one readback", async () => {
  let sends = 0;
  let readbacks = 0;
  const result = await dispatchThreadContinuation({
    task: { threadId: "thread-unknown-response" },
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => { sends += 1; return { status: "unknown" }; },
    readThread: async () => { readbacks += 1; return { isError: true, error: "readback unavailable" }; },
  });
  assert.equal(sends, 1);
  assert.equal(readbacks, 1);
  assert.equal(result.status, "sent_unverified");
  assert.equal(result.exact_blocker, "readback unavailable");
  assert.equal(result.replay_allowed, false);
});

test("file dispatch ledger reserves a key before send and suppresses a later replay", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hourly-thread-ledger-"));
  const ledger = createFileDispatchLedger({ root, runId: "run-1" });
  let sends = 0;
  const options = {
    task: { threadId: "thread-1" },
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    alreadyDispatched: ledger.alreadyDispatched,
    recordIntent: ledger.recordIntent,
    recordReceipt: ledger.recordReceipt,
    sendMessage: async () => { sends += 1; throw Object.assign(new Error("bridge timed out"), { code: "broker_request_timeout" }); },
  };
  const first = await dispatchThreadContinuation(options);
  const second = await dispatchThreadContinuation(options);
  assert.equal(first.status, "sent_unverified");
  assert.equal(second.status, "duplicate_suppressed");
  assert.equal(sends, 1);
  assert.equal(fs.readdirSync(ledger.paths.intentDir).length, 1);
  assert.equal(fs.readdirSync(ledger.paths.receiptDir).length, 1);
});

test("global file ledger suppresses the same key across scheduler runs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hourly-thread-global-ledger-"));
  const firstLedger = createFileDispatchLedger({ root, runId: "run-1" });
  const secondLedger = createFileDispatchLedger({ root, runId: "run-2" });
  const base = {
    task: { threadId: "thread-1" },
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => ({ status: "accepted" }),
  };
  const first = await dispatchThreadContinuation({
    ...base,
    alreadyDispatched: firstLedger.alreadyDispatched,
    recordIntent: firstLedger.recordIntent,
    recordReceipt: firstLedger.recordReceipt,
  });
  const second = await dispatchThreadContinuation({
    ...base,
    alreadyDispatched: secondLedger.alreadyDispatched,
    recordIntent: secondLedger.recordIntent,
    recordReceipt: secondLedger.recordReceipt,
  });
  assert.equal(first.status, "sent_unverified");
  assert.equal(second.status, "duplicate_suppressed");
  assert.equal(firstLedger.scope, "global");
  assert.equal(secondLedger.scope, "global");
  assert.equal(fs.readdirSync(firstLedger.paths.intentDir).length, 1);
  assert.equal(fs.existsSync(path.join(root, "run-2")), false);
});

test("reconciles a persisted uncertain intent on the next run without resending", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hourly-thread-reconciliation-"));
  const firstLedger = createFileDispatchLedger({ root, runId: "run-1" });
  const secondLedger = createFileDispatchLedger({ root, runId: "run-2" });
  let sends = 0;
  const base = {
    task: { threadId: "thread-uncertain", hostId: "local" },
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => { sends += 1; return { status: "unknown" }; },
  };
  const first = await dispatchThreadContinuation({
    ...base,
    readThread: async () => ({ isError: true, error: "readback unavailable" }),
    alreadyDispatched: firstLedger.alreadyDispatched,
    recordIntent: firstLedger.recordIntent,
    recordReceipt: firstLedger.recordReceipt,
    recordReconciliation: firstLedger.recordReconciliation,
  });
  assert.equal(first.status, "sent_unverified");
  const second = await dispatchThreadContinuation({
    ...base,
    sendMessage: async () => { throw new Error("must not resend"); },
    readThread: async ({ threadId, hostId, idempotencyKey, reason }) => {
      assert.equal(threadId, "thread-uncertain");
      assert.equal(hostId, "local");
      assert.match(idempotencyKey, /^aos-hourly:/u);
      assert.equal(reason, "uncertain_send_no_replay");
      return { deliveryConfirmed: true, continuationTurnId: "turn-2", status: "observed" };
    },
    alreadyDispatched: secondLedger.alreadyDispatched,
    recordIntent: secondLedger.recordIntent,
    recordReceipt: secondLedger.recordReceipt,
    recordReconciliation: secondLedger.recordReconciliation,
  });
  assert.equal(second.status, "sent");
  assert.equal(second.replay_allowed, false);
  assert.equal(sends, 1);
  assert.equal(fs.readdirSync(firstLedger.paths.receiptDir).length, 1);
  assert.equal(fs.readdirSync(secondLedger.paths.reconciliationDir).length, 1);
  const third = await dispatchThreadContinuation({
    ...base,
    sendMessage: async () => { throw new Error("must not resend"); },
    readThread: async () => { throw new Error("must not read after reconciled"); },
    alreadyDispatched: firstLedger.alreadyDispatched,
    recordIntent: firstLedger.recordIntent,
    recordReceipt: firstLedger.recordReceipt,
    recordReconciliation: firstLedger.recordReconciliation,
  });
  assert.equal(third.status, "duplicate_suppressed");
});

test("does not send when the dedupe ledger cannot be read", async () => {
  let sends = 0;
  const result = await dispatchThreadContinuation({
    task: { threadId: "thread-1" },
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    alreadyDispatched: async () => { throw new Error("ledger_unavailable"); },
    sendMessage: async () => { sends += 1; return { status: "accepted" }; },
  });
  assert.equal(sends, 0);
  assert.equal(result.status, "deferred");
  assert.equal(result.exact_blocker, "ledger_unavailable");
});

test("does not send when a dedupe entry is not a regular file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hourly-thread-ledger-entry-"));
  const ledger = createFileDispatchLedger({ root, runId: "run-1" });
  const key = buildContinuationIdempotencyKey({ task: { threadId: "thread-1" }, auditFingerprint: "fp", generation: "gen-1", nextAction: "continue" });
  const entryPath = path.join(ledger.paths.intentDir, `${crypto.createHash("sha256").update(key).digest("hex")}.json`);
  fs.mkdirSync(entryPath, { recursive: true });
  let sends = 0;
  const result = await dispatchThreadContinuation({
    task: { threadId: "thread-1" },
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    alreadyDispatched: ledger.alreadyDispatched,
    sendMessage: async () => { sends += 1; return { status: "accepted" }; },
  });
  assert.equal(sends, 0);
  assert.equal(result.status, "deferred");
  assert.equal(result.exact_blocker, "thread_dispatch_ledger_entry_not_a_file");
});

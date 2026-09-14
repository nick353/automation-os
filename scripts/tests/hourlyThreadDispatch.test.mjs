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
  assert.match(message, /Required final state line: include one literal line/u);
  assert.match(message, /goal_plan_state=active exact_blocker=none/u);
  assert.match(message, /Allowed goal_plan_state values are active, continued, in_progress, resumed, running, verified, blocked, and unknown/u);
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

test("passes the existing task cwd through the continuation send boundary", async () => {
  let request = null;
  const result = await dispatchThreadContinuation({
    task: { threadId: "thread-cwd", hostId: "local", cwd: "/tmp/task-cwd" },
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async (value) => { request = value; return { status: "accepted" }; },
    readThread: async () => ({ deliveryConfirmed: true, continuationTurnId: "turn-2", status: "active" }),
  });
  assert.equal(result.status, "sent");
  assert.equal(request?.cwd, "/tmp/task-cwd");
});

test("records a detached worker thread/resume failure as a pre-dispatch no-effect", async () => {
  let recorded = null;
  let reads = 0;
  const result = await dispatchThreadContinuation({
    task: { threadId: "thread-worker-resume-failure", hostId: "local" },
    auditFingerprint: "fp-worker-resume-failure",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => ({
      status: "accepted",
      workerJobId: "worker-1",
      afterStatus: "active",
      afterLatestTurnStatus: "inProgress",
    }),
    waitForCompletion: async () => ({
      status: "failed",
      turnId: null,
      exact_blocker: "codex_app_server_protocol_error:thread/resume",
      preDispatchNoEffect: true,
      result: {
        status: "failed",
        turnId: null,
        exactBlocker: "codex_app_server_protocol_error:thread/resume",
        preDispatchNoEffect: true,
        error: {
          method: "thread/resume",
          code: "-32600",
          message: "thread cannot be resumed from the current server state",
        },
        externalActionExecuted: false,
      },
    }),
    readThread: async () => {
      reads += 1;
      throw new Error("must not read after a known pre-dispatch failure");
    },
    recordReceipt: async (value) => { recorded = value; return { ok: true }; },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.exact_blocker, "codex_app_server_protocol_error:thread/resume");
  assert.equal(result.pre_dispatch_no_effect, true);
  assert.equal(result.replay_allowed, false);
  assert.equal(result.external_action_executed, false);
  assert.equal(reads, 0);
  assert.equal(recorded?.pre_dispatch_no_effect, true);
});

test("rechecks the same task before classifying a bare thread/resume failure", async () => {
  let reads = 0;
  let recorded = null;
  const result = await dispatchThreadContinuation({
    task: { threadId: "thread-worker-resume-race", hostId: "local", latestTurnId: "turn-old", latestTurnStatus: "interrupted" },
    auditFingerprint: "fp-worker-resume-race",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => ({
      status: "accepted",
      workerJobId: "worker-race",
      afterStatus: "active",
      afterLatestTurnStatus: "inProgress",
    }),
    waitForCompletion: async () => ({
      status: "failed",
      turnId: null,
      exact_blocker: "codex_app_server_protocol_error:thread/resume",
      preDispatchNoEffect: true,
      result: {
        status: "failed",
        turnId: null,
        exactBlocker: "codex_app_server_protocol_error:thread/resume",
        preDispatchNoEffect: true,
        externalActionExecuted: false,
      },
    }),
    readThread: async ({ threadId, reason }) => {
      reads += 1;
      assert.equal(threadId, "thread-worker-resume-race");
      assert.equal(reason, "active_boundary_recheck_after_thread_resume_no_effect");
      return { status: "active", latestTurnStatus: "inProgress", latestTurnId: "turn-live" };
    },
    recordReceipt: async (value) => { recorded = value; return { ok: true }; },
  });
  assert.equal(result.status, "deferred");
  assert.equal(result.exact_blocker, "codex_app_thread_active_boundary_required");
  assert.equal(result.active_execution_boundary, true);
  assert.equal(result.observed_turn_id, "turn-live");
  assert.equal(result.pre_dispatch_no_effect, true);
  assert.equal(result.replay_allowed, false);
  assert.equal(reads, 1);
  assert.equal(recorded?.active_execution_boundary, true);
});

test("suppresses an active-writer boundary for the same turn and reopens on a new turn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hourly-thread-active-writer-boundary-"));
  const firstLedger = createFileDispatchLedger({ root, runId: "run-1" });
  const secondLedger = createFileDispatchLedger({ root, runId: "run-2" });
  const thirdLedger = createFileDispatchLedger({ root, runId: "run-3" });
  let sends = 0;
  const first = await dispatchThreadContinuation({
    task: { threadId: "thread-active-writer", hostId: "local", latestTurnId: "turn-1", latestTurnStatus: "interrupted" },
    auditFingerprint: "fp-active-writer-1",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue the existing Goal",
    sendMessage: async () => {
      sends += 1;
      return { status: "accepted", afterStatus: "active", afterLatestTurnStatus: "inProgress" };
    },
    waitForCompletion: async () => ({
      status: "failed",
      turnId: null,
      exact_blocker: "codex_app_server_protocol_error:thread/resume",
      activeExecutionBoundary: true,
      preDispatchNoEffect: true,
      result: {
        status: "failed",
        turnId: null,
        exactBlocker: "codex_app_server_protocol_error:thread/resume",
        activeExecutionBoundary: true,
        preDispatchNoEffect: true,
        error: { method: "thread/resume", message: "thread already has an active writer" },
        externalActionExecuted: false,
      },
    }),
    alreadyDispatched: firstLedger.alreadyDispatched,
    recordIntent: firstLedger.recordIntent,
    recordReceipt: firstLedger.recordReceipt,
  });
  assert.equal(first.status, "deferred");
  assert.equal(first.exact_blocker, "codex_app_thread_active_boundary_required");
  assert.equal(first.active_execution_boundary, true);
  assert.equal(first.pre_dispatch_no_effect, true);
  assert.equal(sends, 1);

  const sameTurn = await dispatchThreadContinuation({
    task: { threadId: "thread-active-writer", hostId: "local", latestTurnId: "turn-1", latestTurnStatus: "interrupted" },
    auditFingerprint: "fp-active-writer-2",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue the existing Goal",
    sendMessage: async () => { sends += 1; throw new Error("must not send while the observed turn is unchanged"); },
    alreadyDispatched: secondLedger.alreadyDispatched,
    recordIntent: secondLedger.recordIntent,
    recordReceipt: secondLedger.recordReceipt,
  });
  assert.equal(sameTurn.status, "deferred");
  assert.equal(sameTurn.exact_blocker, "codex_app_thread_active_boundary_required");
  assert.equal(sends, 1);

  const newTurn = await dispatchThreadContinuation({
    task: { threadId: "thread-active-writer", hostId: "local", latestTurnId: "turn-2", latestTurnStatus: "interrupted" },
    auditFingerprint: "fp-active-writer-3",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue the existing Goal",
    sendMessage: async () => { sends += 1; return { status: "accepted" }; },
    alreadyDispatched: thirdLedger.alreadyDispatched,
    recordIntent: thirdLedger.recordIntent,
    recordReceipt: thirdLedger.recordReceipt,
  });
  assert.equal(newTurn.status, "sent_unverified");
  assert.equal(sends, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("preserves protocol error details without changing the exact blocker", async () => {
  let receipt = null;
  const result = await dispatchThreadContinuation({
    task: { threadId: "thread-protocol-error", hostId: "local" },
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => {
      throw Object.assign(new Error("codex_app_server_protocol_error:thread/resume"), {
        details: { message: "thread is not resumable in this server state" },
      });
    },
    recordReceipt: async (value) => { receipt = value; return { ok: true }; },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.exact_blocker, "codex_app_server_protocol_error:thread/resume");
  assert.equal(result.sendError?.message, "thread is not resumable in this server state");
  assert.equal(receipt?.sendError?.message, "thread is not resumable in this server state");
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

test("does not treat an idempotency key stored only in metadata as delivery proof", async () => {
  let continuationKey = null;
  const result = await dispatchThreadContinuation({
    task: { threadId: "thread-metadata-only-proof" },
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async ({ idempotencyKey }) => {
      continuationKey = idempotencyKey;
      return { idempotencyKey, ok: true };
    },
    readThread: async () => ({
      status: "idle",
      metadata: { idempotencyKey: continuationKey },
      turns: [],
    }),
  });
  assert.equal(result.status, "sent_unverified");
  assert.equal(result.exact_blocker, "thread_send_delivery_not_confirmed");
  assert.equal(result.replay_allowed, false);
});

test("does not treat an old continuation marker as delivery after a worker completion", async () => {
  let continuationKey = null;
  const result = await dispatchThreadContinuation({
    task: { threadId: "thread-stale-marker-production" },
    auditFingerprint: "fp-stale-marker-production",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async ({ idempotencyKey }) => {
      continuationKey = idempotencyKey;
      return {
        status: "accepted",
        beforeTurnId: "turn-old",
        afterStatus: "active",
        afterLatestTurnStatus: "inProgress",
      };
    },
    waitForCompletion: async () => ({ status: "completed", turnId: "turn-new" }),
    readThread: async () => ({
      status: "notLoaded",
      latestTurnId: "turn-old",
      latestTurnStatus: "completed",
      turns: [{ id: "turn-old", status: "completed", items: [{ type: "userMessage", text: `continuation_key=${continuationKey}` }] }],
    }),
  });
  assert.equal(result.status, "sent_unverified");
  assert.equal(result.exact_blocker, "thread_send_delivery_not_confirmed");
  assert.equal(result.readback.status, "unavailable");
  assert.equal(result.replay_allowed, false);
});

test("accepts an explicit same-task completed-turn transport proof without claiming Goal resumption", async () => {
  let continuationKey = null;
  const result = await dispatchThreadContinuation({
    task: { threadId: "thread-turn-proof" },
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async ({ idempotencyKey }) => {
      continuationKey = idempotencyKey;
      return { status: "accepted" };
    },
    readThread: async () => ({
      status: "idle",
      transportDeliveryProof: {
        kind: "same_task_new_turn_completed",
        idempotencyKey: continuationKey,
        threadId: "thread-turn-proof",
        sendResultStatus: "accepted",
        beforeTurnId: "turn-before",
        afterTurnId: "turn-after",
        afterTurnStatus: "completed",
        sameTask: true,
        markerVisible: false,
      },
    }),
  });
  assert.equal(result.status, "sent");
  assert.equal(result.readback.status, "observed");
  assert.equal(result.readback.deliveryProof.kind, "same_task_new_turn_completed");
  assert.equal(result.readback.deliveryProof.markerVisible, false);
  assert.equal(result.readback.goalPlanState, undefined);
});

test("waits once for an in-progress destination turn and records completed transport proof", async () => {
  let waits = 0;
  const result = await dispatchThreadContinuation({
    task: { threadId: "thread-wait-once" },
    auditFingerprint: "fp-wait-once",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => ({
      status: "accepted",
      beforeTurnId: "turn-before",
      afterTurnId: "turn-after",
      afterStatus: "active",
      afterLatestTurnStatus: "inProgress",
      sameTask: true,
    }),
    waitForCompletion: async ({ threadId, timeoutMs }) => {
      waits += 1;
      assert.equal(threadId, "thread-wait-once");
      assert.equal(timeoutMs, 30_000);
      return { status: "completed", threadId };
    },
    readThread: async () => ({
      status: "idle",
      latestTurnId: "turn-after",
      latestTurnStatus: "completed",
      sameTask: true,
    }),
  });
  assert.equal(waits, 1);
  assert.equal(result.status, "sent");
  assert.equal(result.completionWait.status, "completed");
  assert.equal(result.readback.deliveryProof.kind, "same_task_new_turn_completed");
  assert.equal(result.readback.deliveryProof.afterTurnId, "turn-after");
});

test("waits once when the immediate readback still shows the prior interrupted turn", async () => {
  let waits = 0;
  const result = await dispatchThreadContinuation({
    task: { threadId: "thread-stale-interrupted-projection" },
    auditFingerprint: "fp-stale-interrupted-projection",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => ({
      status: "accepted",
      beforeTurnId: "turn-before",
      afterTurnId: "turn-started",
      afterStatus: "notLoaded",
      afterLatestTurnStatus: "interrupted",
      sameTask: true,
    }),
    waitForCompletion: async ({ threadId, turnId, timeoutMs }) => {
      waits += 1;
      assert.equal(threadId, "thread-stale-interrupted-projection");
      assert.equal(turnId, "turn-started");
      assert.equal(timeoutMs, 30_000);
      return { status: "completed", threadId, turnId };
    },
    readThread: async () => ({
      status: "idle",
      latestTurnId: "turn-started",
      latestTurnStatus: "completed",
      sameTask: true,
    }),
  });
  assert.equal(waits, 1);
  assert.equal(result.status, "sent");
  assert.equal(result.completionWait.turnId, "turn-started");
  assert.equal(result.readback.deliveryProof.afterTurnId, "turn-started");
});

test("rejects a completed-turn transport proof for the wrong task or unchanged turn", async () => {
  const result = await dispatchThreadContinuation({
    task: { threadId: "thread-turn-proof-reject" },
    auditFingerprint: "fp",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async ({ idempotencyKey }) => ({ status: "accepted", idempotencyKey }),
    readThread: async () => ({
      status: "idle",
      transportDeliveryProof: {
        kind: "same_task_new_turn_completed",
        idempotencyKey: "wrong-key",
        threadId: "other-thread",
        sendResultStatus: "accepted",
        beforeTurnId: "turn-same",
        afterTurnId: "turn-same",
        afterTurnStatus: "completed",
        sameTask: true,
      },
    }),
  });
  assert.equal(result.status, "sent_unverified");
  assert.equal(result.exact_blocker, "thread_send_delivery_not_confirmed");
  assert.equal(result.replay_allowed, false);
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
    readThread: async ({ idempotencyKey, reason }) => {
      readbacks += 1;
      assert.equal(reason, "uncertain_send_no_replay");
      return {
        transportDeliveryProof: {
          kind: "same_task_new_turn_completed",
          idempotencyKey,
          threadId: "thread-unknown-send",
          sendResultStatus: "accepted",
          beforeTurnId: "turn-1",
          afterTurnId: "turn-2",
          afterTurnStatus: "completed",
          sameTask: true,
        },
      };
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

test("retries one known pre-dispatch failure with a new key and preserves the old receipt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hourly-thread-no-effect-retry-"));
  const ledger = createFileDispatchLedger({ root, runId: "run-1" });
  const task = { threadId: "thread-no-effect-retry", hostId: "local" };
  const oldKey = buildContinuationIdempotencyKey({
    task,
    auditFingerprint: "fp-no-effect",
    generation: "gen-1",
    nextAction: "continue",
  });
  await ledger.recordReceipt({
    task,
    threadId: task.threadId,
    idempotencyKey: oldKey,
    status: "failed",
    exact_blocker: "process is not defined",
    external_action_executed: false,
  });
  const seen = await ledger.alreadyDispatched({ idempotencyKey: oldKey, threadId: task.threadId });
  assert.equal(seen.retryableNoEffect, true);

  const sentKeys = [];
  const options = {
    task,
    auditFingerprint: "fp-no-effect",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async ({ idempotencyKey }) => {
      sentKeys.push(idempotencyKey);
      return { status: "accepted" };
    },
    alreadyDispatched: ledger.alreadyDispatched,
    recordIntent: ledger.recordIntent,
    recordReceipt: ledger.recordReceipt,
  };
  const first = await dispatchThreadContinuation(options);
  assert.equal(first.status, "sent_unverified");
  assert.equal(first.retry_of_idempotency_key, oldKey);
  assert.equal(sentKeys.length, 1);
  assert.equal(sentKeys[0], `${oldKey}:retry-no-effect`);

  const second = await dispatchThreadContinuation({
    ...options,
    sendMessage: async () => { throw new Error("must not retry the retry key"); },
  });
  assert.equal(second.status, "duplicate_suppressed");
  assert.equal(sentKeys.length, 1);
  const oldReceipt = JSON.parse(fs.readFileSync(
    path.join(ledger.paths.receiptDir, `${crypto.createHash("sha256").update(oldKey).digest("hex")}.json`),
    "utf8",
  ));
  assert.equal(oldReceipt.status, "failed");
  assert.equal(oldReceipt.exactBlocker, "process is not defined");
});

test("does not retry an unallowlisted failed dispatch even when it has no external effect", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hourly-thread-unknown-failure-"));
  const ledger = createFileDispatchLedger({ root, runId: "run-1" });
  const task = { threadId: "thread-unknown-failure", hostId: "local" };
  const key = buildContinuationIdempotencyKey({
    task,
    auditFingerprint: "fp-unknown-failure",
    generation: "gen-1",
    nextAction: "continue",
  });
  await ledger.recordReceipt({
    task,
    threadId: task.threadId,
    idempotencyKey: key,
    status: "failed",
    exact_blocker: "provider_limit",
    external_action_executed: false,
  });
  let sends = 0;
  const result = await dispatchThreadContinuation({
    task,
    auditFingerprint: "fp-unknown-failure",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => { sends += 1; return { status: "accepted" }; },
    alreadyDispatched: ledger.alreadyDispatched,
  });
  assert.equal(result.status, "duplicate_suppressed");
  assert.equal(sends, 0);
});

test("suppresses a new key when the same task is still on a confirmed continuation turn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hourly-thread-confirmed-turn-"));
  const firstLedger = createFileDispatchLedger({ root, runId: "run-1" });
  const secondLedger = createFileDispatchLedger({ root, runId: "run-2" });
  let sends = 0;
  const first = await dispatchThreadContinuation({
    task: { threadId: "thread-confirmed", hostId: "local" },
    auditFingerprint: "fp-old",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => { sends += 1; return { status: "accepted", beforeTurnId: "turn-1", afterTurnId: "turn-2", afterLatestTurnStatus: "completed" }; },
    readThread: async () => ({ status: "observed", deliveryConfirmed: true, latestTurnId: "turn-2", latestTurnStatus: "completed", sameTask: true }),
    alreadyDispatched: firstLedger.alreadyDispatched,
    recordIntent: firstLedger.recordIntent,
    recordReceipt: firstLedger.recordReceipt,
  });
  assert.equal(first.status, "sent");
  const second = await dispatchThreadContinuation({
    task: { threadId: "thread-confirmed", hostId: "local", latestTurnId: "turn-2" },
    auditFingerprint: "fp-new",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => { sends += 1; throw new Error("must not send a second continuation"); },
    readThread: async () => { throw new Error("must not read after same-turn suppression"); },
    alreadyDispatched: secondLedger.alreadyDispatched,
    recordIntent: secondLedger.recordIntent,
    recordReceipt: secondLedger.recordReceipt,
  });
  assert.equal(second.status, "duplicate_suppressed");
  assert.equal(sends, 1);
});

test("allows one fresh continuation when the previously confirmed turn is explicitly interrupted", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hourly-thread-interrupted-confirmed-turn-"));
  const firstLedger = createFileDispatchLedger({ root, runId: "run-1" });
  const secondLedger = createFileDispatchLedger({ root, runId: "run-2" });
  let sends = 0;
  const first = await dispatchThreadContinuation({
    task: { threadId: "thread-interrupted-confirmed", hostId: "local" },
    auditFingerprint: "fp-old",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue the existing Goal",
    sendMessage: async () => {
      sends += 1;
      return { status: "accepted", beforeTurnId: "turn-1", afterTurnId: "turn-2", afterLatestTurnStatus: "completed" };
    },
    readThread: async () => ({ status: "observed", deliveryConfirmed: true, latestTurnId: "turn-2", latestTurnStatus: "completed", sameTask: true }),
    alreadyDispatched: firstLedger.alreadyDispatched,
    recordIntent: firstLedger.recordIntent,
    recordReceipt: firstLedger.recordReceipt,
  });
  assert.equal(first.status, "sent");

  const second = await dispatchThreadContinuation({
    task: { threadId: "thread-interrupted-confirmed", hostId: "local", latestTurnId: "turn-2", latestTurnStatus: "interrupted" },
    auditFingerprint: "fp-new",
    freshStatus: { generation: "gen-1" },
    nextAction: "fresh task-owned readback and continue the existing Goal",
    sendMessage: async () => { sends += 1; return { status: "accepted" }; },
    alreadyDispatched: secondLedger.alreadyDispatched,
    recordIntent: secondLedger.recordIntent,
    recordReceipt: secondLedger.recordReceipt,
  });
  assert.equal(second.status, "sent_unverified");
  assert.equal(sends, 2);
  assert.notEqual(second.idempotencyKey, first.idempotencyKey);
  fs.rmSync(root, { recursive: true, force: true });
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
      return {
        transportDeliveryProof: {
          kind: "same_task_new_turn_completed",
          idempotencyKey,
          threadId: "thread-uncertain",
          sendResultStatus: "accepted",
          beforeTurnId: "turn-1",
          afterTurnId: "turn-2",
          afterTurnStatus: "completed",
          sameTask: true,
        },
      };
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

test("keeps reconciling a delayed completion across runs without resending", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hourly-thread-reconciliation-wait-"));
  const firstLedger = createFileDispatchLedger({ root, runId: "run-1" });
  const secondLedger = createFileDispatchLedger({ root, runId: "run-2" });
  const thirdLedger = createFileDispatchLedger({ root, runId: "run-3" });
  let sends = 0;
  let waits = 0;
  let reads = 0;
  const base = {
    task: { threadId: "thread-uncertain-wait", hostId: "local" },
    auditFingerprint: "fp-wait-reconciliation",
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
    waitForCompletion: async ({ threadId, hostId, idempotencyKey, timeoutMs, reason }) => {
      waits += 1;
      assert.equal(threadId, "thread-uncertain-wait");
      assert.equal(hostId, "local");
      assert.match(idempotencyKey, /^aos-hourly:/u);
      assert.equal(timeoutMs, 30_000);
      assert.equal(reason, "uncertain_send_reconciliation_no_replay");
      return { status: "timeout", exact_blocker: "turn_completion_not_observed" };
    },
    readThread: async ({ reason }) => {
      reads += 1;
      assert.equal(reason, "uncertain_send_no_replay");
      return { isError: true, error: "still unavailable" };
    },
    alreadyDispatched: secondLedger.alreadyDispatched,
    recordIntent: secondLedger.recordIntent,
    recordReceipt: secondLedger.recordReceipt,
    recordReconciliation: secondLedger.recordReconciliation,
  });
  assert.equal(second.status, "sent_unverified");
  assert.equal(second.reconciliationAttempted, true);
  assert.equal(second.completionWait.status, "timeout");
  assert.equal(waits, 1);
  assert.equal(reads, 1);
  const third = await dispatchThreadContinuation({
    ...base,
    sendMessage: async () => { throw new Error("must not resend"); },
    waitForCompletion: async () => { waits += 1; return { status: "completed", turnId: "turn-late" }; },
    readThread: async () => { reads += 1; return { latestTurnId: "turn-late", continuationDelivered: true }; },
    alreadyDispatched: thirdLedger.alreadyDispatched,
    recordIntent: thirdLedger.recordIntent,
    recordReceipt: thirdLedger.recordReceipt,
    recordReconciliation: thirdLedger.recordReconciliation,
  });
  assert.equal(third.status, "sent");
  assert.equal(waits, 2);
  assert.equal(reads, 2);
  assert.equal(sends, 1);
});

test("turns an old unverified send into a retryable no-effect receipt when worker resume failed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hourly-thread-worker-resume-reconciliation-"));
  const firstLedger = createFileDispatchLedger({ root, runId: "run-1" });
  const secondLedger = createFileDispatchLedger({ root, runId: "run-2" });
  let sends = 0;
  let reads = 0;
  const first = await dispatchThreadContinuation({
    task: { threadId: "thread-worker-resume-reconciliation", hostId: "local" },
    auditFingerprint: "fp-old-worker-resume",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => { sends += 1; return { status: "unknown" }; },
    readThread: async () => ({ isError: true, error: "readback unavailable" }),
    alreadyDispatched: firstLedger.alreadyDispatched,
    recordIntent: firstLedger.recordIntent,
    recordReceipt: firstLedger.recordReceipt,
    recordReconciliation: firstLedger.recordReconciliation,
  });
  assert.equal(first.status, "sent_unverified");

  const second = await dispatchThreadContinuation({
    task: { threadId: "thread-worker-resume-reconciliation", hostId: "local" },
    auditFingerprint: "fp-new-worker-resume",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => { sends += 1; throw new Error("must not send before reconciliation"); },
    waitForCompletion: async () => ({
      status: "failed",
      turnId: null,
      exact_blocker: "codex_app_server_protocol_error:thread/resume",
      preDispatchNoEffect: true,
      result: {
        status: "failed",
        turnId: null,
        exactBlocker: "codex_app_server_protocol_error:thread/resume",
        preDispatchNoEffect: true,
        error: {
          method: "thread/resume",
          code: "-32600",
          message: "thread cannot be resumed from the current server state",
        },
        externalActionExecuted: false,
      },
    }),
    readThread: async () => { reads += 1; throw new Error("must not read after known no-effect"); },
    alreadyDispatched: secondLedger.alreadyDispatched,
    recordIntent: secondLedger.recordIntent,
    recordReceipt: secondLedger.recordReceipt,
    recordReconciliation: secondLedger.recordReconciliation,
  });
  assert.equal(second.status, "failed");
  assert.equal(second.exact_blocker, "codex_app_server_protocol_error:thread/resume");
  assert.equal(second.pre_dispatch_no_effect, true);
  assert.equal(second.reconciliationAttempted, true);
  assert.equal(second.replay_allowed, false);
  assert.equal(sends, 1);
  assert.equal(reads, 0);
  const reconciliationFiles = fs.readdirSync(secondLedger.paths.reconciliationDir);
  assert.equal(reconciliationFiles.length, 1);
  const reconciliation = JSON.parse(fs.readFileSync(path.join(secondLedger.paths.reconciliationDir, reconciliationFiles[0]), "utf8"));
  assert.deepEqual(reconciliation.workerError, {
    method: "thread/resume",
    code: "-32600",
    message: "thread cannot be resumed from the current server state",
  });
});

test("reclassifies a legacy resume failure during reconciliation when the task is active", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hourly-thread-worker-resume-active-reconciliation-"));
  const firstLedger = createFileDispatchLedger({ root, runId: "run-1" });
  const secondLedger = createFileDispatchLedger({ root, runId: "run-2" });
  let sends = 0;
  let reads = 0;
  const first = await dispatchThreadContinuation({
    task: { threadId: "thread-worker-resume-active-reconciliation", hostId: "local" },
    auditFingerprint: "fp-old-active-reconciliation",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => { sends += 1; return { status: "unknown" }; },
    readThread: async () => ({ isError: true, error: "readback unavailable" }),
    alreadyDispatched: firstLedger.alreadyDispatched,
    recordIntent: firstLedger.recordIntent,
    recordReceipt: firstLedger.recordReceipt,
    recordReconciliation: firstLedger.recordReconciliation,
  });
  assert.equal(first.status, "sent_unverified");

  const second = await dispatchThreadContinuation({
    task: { threadId: "thread-worker-resume-active-reconciliation", hostId: "local" },
    auditFingerprint: "fp-new-active-reconciliation",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => { sends += 1; throw new Error("must not send during reconciliation"); },
    waitForCompletion: async () => ({
      status: "failed",
      turnId: null,
      exact_blocker: "codex_app_server_protocol_error:thread/resume",
      preDispatchNoEffect: true,
      result: {
        status: "failed",
        turnId: null,
        exactBlocker: "codex_app_server_protocol_error:thread/resume",
        preDispatchNoEffect: true,
        externalActionExecuted: false,
      },
    }),
    readThread: async ({ reason }) => {
      reads += 1;
      assert.equal(reason, "active_boundary_recheck_after_thread_resume_no_effect");
      return { status: "active", latestTurnStatus: "inProgress", latestTurnId: "turn-live" };
    },
    alreadyDispatched: secondLedger.alreadyDispatched,
    recordIntent: secondLedger.recordIntent,
    recordReceipt: secondLedger.recordReceipt,
    recordReconciliation: secondLedger.recordReconciliation,
  });
  assert.equal(second.status, "deferred");
  assert.equal(second.exact_blocker, "codex_app_thread_active_boundary_required");
  assert.equal(second.active_execution_boundary, true);
  assert.equal(second.observed_turn_id, "turn-live");
  assert.equal(second.reconciliationAttempted, true);
  assert.equal(second.pre_dispatch_no_effect, true);
  assert.equal(second.replay_allowed, false);
  assert.equal(sends, 1);
  assert.equal(reads, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("reconciles a prior unverified same-task send before considering a new key", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hourly-thread-unresolved-same-task-"));
  const firstLedger = createFileDispatchLedger({ root, runId: "run-1" });
  const secondLedger = createFileDispatchLedger({ root, runId: "run-2" });
  const thirdLedger = createFileDispatchLedger({ root, runId: "run-3" });
  let sends = 0;
  let waits = 0;
  let reads = 0;
  const first = await dispatchThreadContinuation({
    task: { threadId: "thread-unresolved-same-task", hostId: "local" },
    auditFingerprint: "fp-old",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => { sends += 1; return { status: "unknown" }; },
    readThread: async () => ({ isError: true, error: "readback unavailable" }),
    alreadyDispatched: firstLedger.alreadyDispatched,
    recordIntent: firstLedger.recordIntent,
    recordReceipt: firstLedger.recordReceipt,
    recordReconciliation: firstLedger.recordReconciliation,
  });
  assert.equal(first.status, "sent_unverified");
  const second = await dispatchThreadContinuation({
    task: { threadId: "thread-unresolved-same-task", hostId: "local" },
    auditFingerprint: "fp-new",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => { sends += 1; throw new Error("must not send a new key"); },
    waitForCompletion: async ({ threadId, idempotencyKey, timeoutMs, reason }) => {
      waits += 1;
      assert.equal(threadId, "thread-unresolved-same-task");
      assert.equal(idempotencyKey, first.idempotencyKey);
      assert.equal(timeoutMs, 30_000);
      assert.equal(reason, "uncertain_send_reconciliation_no_replay");
      return { status: "timeout", exact_blocker: "turn_completion_not_observed" };
    },
    readThread: async ({ threadId, idempotencyKey, reason }) => {
      reads += 1;
      assert.equal(threadId, "thread-unresolved-same-task");
      assert.equal(idempotencyKey, first.idempotencyKey);
      assert.equal(reason, "uncertain_send_no_replay");
      return { isError: true, error: "readback unavailable" };
    },
    alreadyDispatched: secondLedger.alreadyDispatched,
    recordIntent: secondLedger.recordIntent,
    recordReceipt: secondLedger.recordReceipt,
    recordReconciliation: secondLedger.recordReconciliation,
  });
  assert.equal(second.status, "sent_unverified");
  assert.equal(second.reconciliationAttempted, true);
  assert.equal(second.exact_blocker, "readback unavailable");
  assert.equal(second.replay_allowed, false);
  assert.equal(second.idempotencyKey, first.idempotencyKey);
  assert.equal(waits, 1);
  assert.equal(reads, 1);
  assert.equal(sends, 1);
  const third = await dispatchThreadContinuation({
    task: { threadId: "thread-unresolved-same-task", hostId: "local" },
    auditFingerprint: "fp-newer",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => { sends += 1; throw new Error("must not resend after reconciliation"); },
    waitForCompletion: async () => { waits += 1; return { status: "timeout" }; },
    readThread: async () => { reads += 1; return { latestTurnId: "still-old" }; },
    alreadyDispatched: thirdLedger.alreadyDispatched,
    recordIntent: thirdLedger.recordIntent,
    recordReceipt: thirdLedger.recordReceipt,
    recordReconciliation: thirdLedger.recordReconciliation,
  });
  assert.equal(third.status, "sent_unverified");
  assert.equal(third.exact_blocker, "thread_send_delivery_not_confirmed");
  assert.equal(waits, 2);
  assert.equal(reads, 2);
  assert.equal(sends, 1);
});

test("rechecks an older unresolved key when a newer key was already reconciled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hourly-thread-late-marker-reconciliation-"));
  const ledger = createFileDispatchLedger({ root, runId: "run-1" });
  const task = { threadId: "thread-late-marker-reconciliation", hostId: "local" };
  const olderKey = buildContinuationIdempotencyKey({
    task,
    auditFingerprint: "fp-older",
    generation: "gen-1",
    nextAction: "continue",
  });
  const newerKey = buildContinuationIdempotencyKey({
    task,
    auditFingerprint: "fp-newer",
    generation: "gen-1",
    nextAction: "continue",
  });
  await ledger.recordReceipt({
    threadId: task.threadId,
    idempotencyKey: olderKey,
    status: "sent_unverified",
  });
  await ledger.recordReceipt({
    threadId: task.threadId,
    idempotencyKey: newerKey,
    status: "sent_unverified",
    reconciliationAttempted: true,
  });

  let sends = 0;
  let reads = 0;
  const result = await dispatchThreadContinuation({
    task,
    auditFingerprint: "fp-current",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => { sends += 1; throw new Error("must not resend any unresolved key"); },
    readThread: async ({ idempotencyKey, reason }) => {
      reads += 1;
      assert.equal(idempotencyKey, olderKey);
      assert.equal(reason, "uncertain_send_no_replay");
      return {
        latestTurnId: "turn-late-marker",
        latestTurnStatus: "completed",
        transportDeliveryProof: {
          kind: "same_task_new_turn_completed",
          idempotencyKey,
          threadId: task.threadId,
          sendResultStatus: "accepted",
          beforeTurnId: "turn-before",
          afterTurnId: "turn-late-marker",
          afterTurnStatus: "completed",
          sameTask: true,
        },
      };
    },
    alreadyDispatched: ledger.alreadyDispatched,
    recordIntent: ledger.recordIntent,
    recordReceipt: ledger.recordReceipt,
    recordReconciliation: ledger.recordReconciliation,
  });
  assert.equal(result.status, "sent");
  assert.equal(result.idempotencyKey, olderKey);
  assert.equal(result.replay_allowed, false);
  assert.equal(sends, 0);
  assert.equal(reads, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("reconciles a weak prior delivery before suppressing a later key", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hourly-thread-confirmed-id-backfill-"));
  const firstLedger = createFileDispatchLedger({ root, runId: "run-1" });
  const secondLedger = createFileDispatchLedger({ root, runId: "run-2" });
  const thirdLedger = createFileDispatchLedger({ root, runId: "run-3" });
  let sends = 0;
  let reads = 0;
  const first = await dispatchThreadContinuation({
    task: { threadId: "thread-confirmed-id-backfill", hostId: "local" },
    auditFingerprint: "fp-old",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => { sends += 1; return { status: "unknown" }; },
    readThread: async () => ({ deliveryConfirmed: true, status: "observed" }),
    alreadyDispatched: firstLedger.alreadyDispatched,
    recordIntent: firstLedger.recordIntent,
    recordReceipt: firstLedger.recordReceipt,
    recordReconciliation: firstLedger.recordReconciliation,
  });
  assert.equal(first.status, "sent_unverified");

  const second = await dispatchThreadContinuation({
    task: { threadId: "thread-confirmed-id-backfill", hostId: "local", latestTurnId: "turn-2" },
    auditFingerprint: "fp-new",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => { sends += 1; throw new Error("must not resend"); },
    readThread: async ({ idempotencyKey, reason }) => {
      reads += 1;
      assert.equal(idempotencyKey, first.idempotencyKey);
      assert.equal(reason, "uncertain_send_no_replay");
      return {
        latestTurnId: "turn-2",
        latestTurnStatus: "completed",
        transportDeliveryProof: {
          kind: "same_task_new_turn_completed",
          idempotencyKey,
          threadId: "thread-confirmed-id-backfill",
          sendResultStatus: "accepted",
          beforeTurnId: "turn-1",
          afterTurnId: "turn-2",
          afterTurnStatus: "completed",
          sameTask: true,
        },
      };
    },
    alreadyDispatched: secondLedger.alreadyDispatched,
    recordIntent: secondLedger.recordIntent,
    recordReceipt: secondLedger.recordReceipt,
    recordReconciliation: secondLedger.recordReconciliation,
  });
  assert.equal(second.status, "sent");
  assert.equal(second.reconciliationAttempted, true);

  const third = await dispatchThreadContinuation({
    task: { threadId: "thread-confirmed-id-backfill", hostId: "local", latestTurnId: "turn-2" },
    auditFingerprint: "fp-newer",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => { sends += 1; throw new Error("must not send after confirmed backfill"); },
    readThread: async () => { reads += 1; throw new Error("must not read after confirmed backfill"); },
    alreadyDispatched: thirdLedger.alreadyDispatched,
    recordIntent: thirdLedger.recordIntent,
    recordReceipt: thirdLedger.recordReceipt,
    recordReconciliation: thirdLedger.recordReconciliation,
  });
  assert.equal(third.status, "duplicate_suppressed");
  assert.equal(sends, 1);
  assert.equal(reads, 1);
});

test("does not let an older unresolved key override a later confirmed task event", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hourly-thread-latest-task-event-"));
  const ledger = createFileDispatchLedger({ root, runId: "run-1" });
  const task = { threadId: "thread-latest-task-event", hostId: "local" };
  const old = await dispatchThreadContinuation({
    task,
    auditFingerprint: "fp-old",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => ({ status: "unknown" }),
    readThread: async () => ({ isError: true, error: "old readback unavailable" }),
    alreadyDispatched: ledger.alreadyDispatched,
    recordIntent: ledger.recordIntent,
    recordReceipt: ledger.recordReceipt,
  });
  assert.equal(old.status, "sent_unverified");
  const confirmedKey = buildContinuationIdempotencyKey({
    task,
    auditFingerprint: "fp-confirmed",
    generation: "gen-1",
    nextAction: "continue",
  });
  await ledger.recordReceipt({
    threadId: task.threadId,
    idempotencyKey: confirmedKey,
    status: "sent",
    readback: {
      status: "observed",
      latestTurnId: "turn-2",
      transportDeliveryProof: {
        kind: "same_task_new_turn_completed",
        idempotencyKey: confirmedKey,
        threadId: task.threadId,
        sendResultStatus: "accepted",
        beforeTurnId: "turn-1",
        afterTurnId: "turn-2",
        afterTurnStatus: "completed",
        sameTask: true,
      },
    },
  });
  let sends = 0;
  let reads = 0;
  const result = await dispatchThreadContinuation({
    task: { ...task, latestTurnId: "turn-2" },
    auditFingerprint: "fp-newer",
    freshStatus: { generation: "gen-1" },
    nextAction: "continue",
    sendMessage: async () => { sends += 1; throw new Error("must not send past confirmed event"); },
    readThread: async () => { reads += 1; throw new Error("must not read past confirmed event"); },
    alreadyDispatched: ledger.alreadyDispatched,
    recordIntent: ledger.recordIntent,
    recordReceipt: ledger.recordReceipt,
  });
  assert.equal(result.status, "duplicate_suppressed");
  assert.equal(sends, 0);
  assert.equal(reads, 0);
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

test("later read failure cannot erase exact-key delivery or freeze a different repaired action", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hourly-thread-monotonic-delivery-"));
  const ledger = createFileDispatchLedger({ root });
  const threadId = "thread", idempotencyKey = "confirmed-key";
  await ledger.recordReceipt({ threadId, idempotencyKey, status: "sent", readback: {
    goalStatus: "active", goalReadback: "present", transportDeliveryProof: {
      kind: "same_task_message_observed", threadId, idempotencyKey, turnId: "delivered-turn",
      turnStatus: "completed", sameTask: true, markerVisible: true,
    },
  } });
  await ledger.recordReconciliation({ threadId, idempotencyKey, status: "sent_unverified",
    readback: { goalStatus: "blocked", goalReadback: "present" } });
  const seen = await ledger.alreadyDispatched({ threadId, idempotencyKey, currentTurnId: "later-turn", currentTurnStatus: "completed" });
  assert.equal(seen.terminal, true);
  assert.equal(seen.status, "sent");
  assert.equal(seen.reconciliation.goalStatus, "blocked");
  assert.equal(seen.reconciliation.latestObservationStatus, "sent_unverified");
  assert.equal(await ledger.alreadyDispatched({ threadId, idempotencyKey: "new-repair-key", currentTurnId: "later-turn", currentTurnStatus: "completed" }), false);
  // A genuinely unconfirmed, distinct dispatch still prevents another key.
  await ledger.recordReceipt({ threadId, idempotencyKey: "unknown-key", status: "sent_unverified" });
  const held = await ledger.alreadyDispatched({ threadId, idempotencyKey: "new-repair-key", currentTurnId: "later-turn", currentTurnStatus: "completed" });
  assert.equal(held.reconciliationKey, "unknown-key");
  assert.ok(ledger.listPending().some((entry) => entry.priorIdempotencyKey === "confirmed-key"));
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

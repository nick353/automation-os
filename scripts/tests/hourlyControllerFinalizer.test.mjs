import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { finalizeHourlyControllerReceipt } from "../lib/hourly-controller-finalizer.mjs";
import { finalizeCurrentRootHourlyController } from "/Users/nichikatanaka/.codex/skills/automation-kernel-run/scripts/current-root-execute-adapter.mjs";

test("does not depend on an undeclared process global in the Root callback boundary", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "../lib/hourly-controller-finalizer.mjs"), "utf8");
  assert.match(source, /const currentProcess = globalThis\.process;/u);
  assert.doesNotMatch(source, /process\.pid/u);
});

test("finalizes through the current-root adapter when the process global is absent", async () => {
  const fixtureData = fixture();
  const originalProcess = globalThis.process;
  try {
    delete globalThis.process;
    const result = await finalizeCurrentRootHourlyController({
      auditPath: fixtureData.auditPath,
      globals: fixtureData.globals,
      controllerOutcome: {
        schema: "aos.companion_hourly_controller.v1",
        status: "deferred",
        auditFingerprint: "a".repeat(64),
        exact_blocker: "send_result_unknown",
        actions: ["blocker_progress"],
        freshStatus: { connected: true, generation: "gen-test", activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
        blockerProgress: { reason: "send_result_unknown", status: "deferred", attempted: true, resumeAllowed: false, exact_blocker: "send_result_unknown" },
        next_action_now: "retain the idempotency key and do not resend",
        resume_trigger: "same-task readback exposes accepted delivery or definitive no-delivery",
        external_action_executed: false,
      },
      callbackEvidence: [{
        stage: "blocker_progress",
        tool: "mcp__codex_app__read_thread",
        threadId: "thread-target",
        status: "observed",
        exact_blocker: "send_result_unknown",
        result: { status: "observed", external_action_executed: false },
      }],
    });
    assert.equal(result.created, true);
    assert.equal(result.executionReceipt.status, "deferred");
    assert.equal(typeof globalThis.process, "undefined");
  } finally {
    globalThis.process = originalProcess;
    fs.rmSync(fixtureData.root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-controller-finalizer-"));
  const auditPath = path.join(root, "aos-hourly-companion-audit.v1.json");
  const verifierPath = path.join(root, "aos-hourly-companion-audit.verifier.v1.json");
  const statePath = path.join(root, "STATE.md");
  const audit = {
    schema: "aos.hourly_companion_audit.v1",
    runId: "aos-companion-test-1",
    auditFingerprint: "a".repeat(64),
    immutableArtifactPath: path.join(root, "immutable.json"),
    verifierArtifactPath: verifierPath,
    executionReceipt: { rootActionRequired: true },
    threadInspection: {
      schema: "aos.companion_thread_inspection.v1",
      source: "codex_app_thread_list",
      mode: "lightweight_all_then_deep_read_candidates",
      listedCount: 3,
      eligibleTaskCount: 2,
      skippedNonUserOwnedCount: 1,
      lightweightInspectionCount: 2,
      lightweightReadCount: 2,
      deepReadCandidateCount: 1,
      deepReadAttemptedCount: 1,
      deepReadCount: 1,
      deepReadTruncated: false,
    },
  };
  fs.writeFileSync(auditPath, JSON.stringify(audit));
  fs.writeFileSync(verifierPath, "{}");
  fs.writeFileSync(statePath, "# AOS Companion state\n\nUpdated: old\n\n## Existing history\n\n- preserve this content\n", { mode: 0o600 });
  const globals = {
    nodeRepl: {
      requestMeta: {
        "x-codex-turn-metadata": {
          thread_source: "automation",
          session_id: "session-test",
          thread_id: "thread-test",
          turn_id: "turn-test",
          turn_trigger: "automation",
        },
      },
    },
  };
  return { root, auditPath, verifierPath, statePath, globals };
}

test("natural deferred verification remains deferred through compacting and finalization", () => {
  for (const activeLeaseCount of [2, 0]) {
    const data = fixture();
    try {
      const result = finalizeHourlyControllerReceipt({ ...data,
        controllerOutcome: { status: "deferred", actions: ["verification"], auditFingerprint: "a".repeat(64),
          exact_blocker: "companion_installed_artifact_drift", external_action_executed: false,
          freshStatus: { connected: true, generation: "gen-test", activeLeaseCount, pendingCount: 0, queueCount: 0, activeReconciliationCount: null },
          verification: { status: "deferred", continuationAllowed: false } },
        callbackEvidence: [{ stage: "diagnostic_readback", tool: "read_only_audit", status: "observed" }] });
      const receipt = JSON.parse(fs.readFileSync(result.path));
      assert.equal(receipt.controller.freshStatus.activeReconciliationCount, null);
      assert.equal(receipt.executionReceipt.stageReceipts.focused_verification.status, "deferred");
      assert.equal(receipt.executionReceipt.stageReceipts.idle_reconciled_check.status, "deferred");
      assert.equal(receipt.executionReceipt.complete, false);
    } finally { fs.rmSync(data.root, { recursive: true, force: true }); }
  }
});

test("finalizes a completed controller from actual callback/readback evidence", () => {
  const fixtureData = fixture();
  const result = finalizeHourlyControllerReceipt({
    ...fixtureData,
    controllerOutcome: {
      schema: "aos.companion_hourly_controller.v1",
      status: "completed",
      auditFingerprint: "a".repeat(64),
      actions: ["continuation"],
      freshStatus: { connected: true, generation: "gen-test", activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
      continuations: [{
        threadId: "thread-target",
        idempotencyKey: "aos-hourly:test",
        result: {
          status: "sent",
          readback: {
            status: "observed",
            goal_plan_state: "active",
            deliveryProof: {
              kind: "same_task_new_turn_completed",
              beforeTurnId: "turn-before",
              afterTurnId: "turn-after",
              afterTurnStatus: "completed",
              markerVisible: false,
            },
          },
          external_action_executed: false,
        },
      }],
      external_action_executed: false,
    },
    callbackEvidence: [{
      stage: "continuation",
      tool: "mcp__codex_app__send_message_to_thread",
      threadId: "thread-target",
      status: "sent",
      result: { status: "sent", readback: { status: "observed", goal_plan_state: "active" }, external_action_executed: false },
    }],
  });
  assert.equal(result.created, true);
  assert.equal(result.executionReceipt.complete, true);
  const receipt = JSON.parse(fs.readFileSync(result.path, "utf8"));
  assert.equal(receipt.root.turnId, "turn-test");
  assert.equal(receipt.root.turnTrigger, "automation");
  assert.equal(receipt.callbackEvidence[0].tool, "mcp__codex_app__send_message_to_thread");
  assert.equal(receipt.controller.continuations[0].result.deliveryProof.kind, "same_task_new_turn_completed");
  assert.equal(receipt.controller.continuations[0].result.deliveryProof.markerVisible, false);
  assert.equal(receipt.executionReceipt.stageReceipts.thread_inventory.status, "completed");
  assert.equal(receipt.executionReceipt.stageReceipts.lightweight_thread_inspection.readbackCount, 2);
  assert.equal(receipt.executionReceipt.stageReceipts.deep_read_selection.readCount, 1);
  for (const stage of Object.values(receipt.executionReceipt.stageReceipts)) {
    assert.notEqual(stage.status, "not_run");
  }
  assert.equal(receipt.executionReceipt.stageReceipts.bounded_repair.status, "not_applicable");
  assert.equal(result.stateSync.status, "synchronized");
  const state = fs.readFileSync(fixtureData.statePath, "utf8");
  assert.match(state, /latest_run_id: aos-companion-test-1/u);
  assert.match(state, /not_run_stage_count: 0/u);
  assert.match(state, /preserve this content/u);
  const updated = JSON.parse(fs.readFileSync(fixtureData.auditPath, "utf8"));
  assert.equal(updated.executionReceipt.complete, true);
  assert.equal(updated.controllerReceiptPath, result.path);
  for (const stage of Object.values(updated.executionReceipt.stageReceipts)) {
    assert.notEqual(stage.status, "not_run");
  }
  const verifier = JSON.parse(fs.readFileSync(fixtureData.verifierPath, "utf8"));
  assert.equal(verifier.stateSync.status, "synchronized");
  for (const stage of Object.values(verifier.executionReceipt.stageReceipts)) {
    assert.notEqual(stage.status, "not_run");
  }
});

test("records downstream stages as deferred instead of leaving them not_run", () => {
  const fixtureData = fixture();
  const result = finalizeHourlyControllerReceipt({
    ...fixtureData,
    controllerOutcome: {
      schema: "aos.companion_hourly_controller.v1",
      status: "deferred",
      auditFingerprint: "a".repeat(64),
      exact_blocker: "send_result_unknown",
      actions: ["blocker_progress"],
      freshStatus: { connected: true, generation: "gen-test", activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
      blockerProgress: { reason: "send_result_unknown", status: "deferred", attempted: true, resumeAllowed: false, exact_blocker: "send_result_unknown" },
      next_action_now: "retain the idempotency key and do not resend",
      resume_trigger: "same-task readback exposes accepted delivery or definitive no-delivery",
      external_action_executed: false,
    },
    callbackEvidence: [
      {
        stage: "fresh_status",
        tool: "mcp__aos_chrome_companion__companion_status",
        threadId: "thread-root",
        status: "observed",
        result: { status: "observed", external_action_executed: false },
      },
      {
        stage: "blocker_progress",
        tool: "mcp__codex_app__read_thread",
        threadId: "thread-target",
        status: "observed",
        exact_blocker: "send_result_unknown",
        result: { status: "observed", external_action_executed: false },
      },
    ],
  });
  assert.equal(result.created, true);
  assert.equal(result.executionReceipt.status, "deferred");
  assert.equal(result.executionReceipt.stageReceipts.thread_inventory.status, "completed");
  assert.equal(result.executionReceipt.stageReceipts.generalize_root_cause.status, "deferred");
  assert.equal(result.executionReceipt.stageReceipts.signed_refresh.status, "deferred");
  assert.equal(result.executionReceipt.stageReceipts.one_continuation_per_eligible_task.status, "deferred");
  assert.equal(result.executionReceipt.stageReceipts.readback.status, "deferred");
  assert.equal(result.stateSync.status, "synchronized");
  assert.match(fs.readFileSync(fixtureData.statePath, "utf8"), /latest_exact_blocker: send_result_unknown/u);
  for (const stage of Object.values(result.executionReceipt.stageReceipts)) {
    assert.notEqual(stage.status, "not_run");
  }
});

test("does not finalize completion without same-task readback", () => {
  const fixtureData = fixture();
  assert.throws(() => finalizeHourlyControllerReceipt({
    ...fixtureData,
    controllerOutcome: {
      schema: "aos.companion_hourly_controller.v1",
      status: "completed",
      auditFingerprint: "a".repeat(64),
      actions: ["continuation"],
      freshStatus: { connected: true, generation: "gen-test", activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
      continuations: [{ threadId: "thread-target", result: { status: "sent", external_action_executed: false } }],
    },
    callbackEvidence: [{ stage: "continuation", tool: "mcp__codex_app__send_message_to_thread", threadId: "thread-target", status: "sent" }],
  }), /hourly_controller_continuation_readback_required/u);
});

test("does not claim Goal/Plan reactivation from delivery proof alone", () => {
  const fixtureData = fixture();
  assert.throws(() => finalizeHourlyControllerReceipt({
    ...fixtureData,
    controllerOutcome: {
      schema: "aos.companion_hourly_controller.v1",
      status: "completed",
      auditFingerprint: "a".repeat(64),
      actions: ["continuation"],
      freshStatus: { connected: true, generation: "gen-test", activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
      continuations: [{ threadId: "thread-target", result: { status: "sent", readback: { status: "observed" }, external_action_executed: false } }],
      external_action_executed: false,
    },
    callbackEvidence: [{
      stage: "continuation",
      tool: "mcp__codex_app__send_message_to_thread",
      threadId: "thread-target",
      status: "sent",
      result: { status: "sent", readback: { status: "observed" }, external_action_executed: false },
    }],
}), /hourly_controller_goal_plan_readback_required/u);
});

test("preserves direct scheduled-controller continuation results", () => {
  const fixtureData = fixture();
  const result = finalizeHourlyControllerReceipt({
    ...fixtureData,
    controllerOutcome: {
      schema: "aos.companion_hourly_controller.v1",
      status: "completed",
      auditFingerprint: "a".repeat(64),
      actions: ["continuation"],
      freshStatus: { connected: true, generation: "gen-test", activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
      // This is the shape returned by scheduled-companion-controller.mjs.
      continuations: [{
        threadId: "thread-target",
        idempotencyKey: "aos-hourly:direct",
        status: "sent",
        readback: {
          status: "observed",
          goal_plan_state: "active",
          deliveryProof: { kind: "same_task_new_turn_completed", markerVisible: false },
        },
        external_action_executed: false,
      }],
      external_action_executed: false,
    },
    callbackEvidence: [{
      stage: "continuation",
      tool: "mcp__codex_app__send_message_to_thread",
      threadId: "thread-target",
      status: "sent",
      result: { status: "sent", readback: { status: "observed", goal_plan_state: "active" }, external_action_executed: false },
    }],
  });
  const receipt = JSON.parse(fs.readFileSync(result.path, "utf8"));
  assert.equal(result.executionReceipt.complete, true);
  assert.equal(receipt.controller.continuations[0].threadId, "thread-target");
  assert.equal(receipt.controller.continuations[0].idempotencyKey, "aos-hourly:direct");
  assert.equal(receipt.controller.continuations[0].result.status, "sent");
  assert.equal(receipt.controller.continuations[0].result.goalPlanState, "active");
  assert.equal(receipt.controller.continuations[0].result.deliveryProof.kind, "same_task_new_turn_completed");
});

test("does not finalize a callback gap while an official-App-only candidate is exposed", () => {
  const fixtureData = fixture();
  const audit = JSON.parse(fs.readFileSync(fixtureData.auditPath, "utf8"));
  audit.officialAppOnlyContinuationCandidates = [{
    threadId: "official-only-task",
    owner: "user",
    currentTaskReadback: true,
    resumeAssessment: { reason: "ready" },
  }];
  fs.writeFileSync(fixtureData.auditPath, JSON.stringify(audit));
  assert.throws(() => finalizeHourlyControllerReceipt({
    ...fixtureData,
    controllerOutcome: {
      schema: "aos.companion_hourly_controller.v1",
      status: "deferred",
      auditFingerprint: "a".repeat(64),
      exact_blocker: "cross_task_companion_callback_unavailable",
      actions: ["blocker_progress"],
      freshStatus: { connected: true, generation: "gen-test", activeLeaseCount: 2, pendingCount: 0, queueCount: 0 },
      blockerProgress: { reason: "cross_task_companion_callback_unavailable", status: "deferred", attempted: true, resumeAllowed: false },
      external_action_executed: false,
    },
    callbackEvidence: [{
      stage: "blocker_progress",
      tool: "mcp__codex_app__read_thread",
      threadId: "unrelated-task",
      status: "observed",
      result: { status: "observed", external_action_executed: false },
    }],
  }), /hourly_controller_official_app_only_continuation_required/u);
});

test("does not finalize a callback gap while a task-owned relay candidate is exposed", () => {
  const fixtureData = fixture();
  const audit = JSON.parse(fs.readFileSync(fixtureData.auditPath, "utf8"));
  audit.taskOwnedContinuationCandidates = [{
    threadId: "task-owned-relay",
    owner: "user",
    currentTaskReadback: true,
    requiresTaskOwnedCompanionCallback: true,
    resumeAssessment: { reason: "stale_owner_recoverable" },
  }];
  fs.writeFileSync(fixtureData.auditPath, JSON.stringify(audit));
  assert.throws(() => finalizeHourlyControllerReceipt({
    ...fixtureData,
    controllerOutcome: {
      schema: "aos.companion_hourly_controller.v1",
      status: "deferred",
      auditFingerprint: "a".repeat(64),
      exact_blocker: "cross_task_companion_callback_unavailable",
      actions: ["blocker_progress"],
      freshStatus: { connected: true, generation: "gen-test", activeLeaseCount: 2, pendingCount: 0, queueCount: 0 },
      blockerProgress: { reason: "cross_task_companion_callback_unavailable", status: "deferred", attempted: true, resumeAllowed: false },
      external_action_executed: false,
    },
    callbackEvidence: [{
      stage: "blocker_progress",
      tool: "mcp__codex_app__read_thread",
      threadId: "unrelated-task",
      status: "observed",
      result: { status: "observed", external_action_executed: false },
    }],
  }), /hourly_controller_official_app_only_continuation_required/u);
});

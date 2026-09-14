import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAuditExecutionReceipt, buildAuditFingerprint, buildAuditSummary, buildBlockerProgressPlan, buildProactiveRepairPlan, buildRepairPlan, buildResumeAssessment, buildThreadInspectionPlan, buildVerifierProjection, classifyOperationalBlocker, classifyThreadTail, collectRecentUserSessions, confirmSoftAnomalyFindings, inspectRecentUserThreads, readLiveCompanionStatus, recordCompanionLearningOutcome, runBoundedHourlyController, runHourlyAudit, runHourlyAuditLive, runSameRunCompanionRepairLoop, selectDeepReadCandidates } from "../aos-hourly-companion-audit.mjs";
import { createThreadAlias, createThreadReadbackProjection } from "../lib/thread-readback-projection.mjs";
import { buildControllerExecutionReceipt } from "../aos-hourly-companion-audit.mjs";

test("does not promote deferred compact verification or a busy/unknown status to completed proof", () => {
  const input = { status: "deferred", actions: ["verification"],
    exact_blocker: "companion_installed_artifact_drift",
    verification: { resultStatus: "deferred", continuationAllowed: false },
    freshStatus: { connected: true, activeLeaseCount: 2, pendingCount: 0, queueCount: 0, activeReconciliationCount: null } };
  const stages = buildControllerExecutionReceipt(input).stageReceipts;
  assert.equal(stages.focused_verification.status, "deferred");
  assert.equal(stages.idle_reconciled_check.status, "deferred");
  for (const resultStatus of ["failed", "blocked", "passed", "deferred", "unknown"]) {
    const actual = buildControllerExecutionReceipt({ ...input, verification: { resultStatus } }).stageReceipts.focused_verification.status;
    assert.equal(actual, ["failed", "blocked"].includes(resultStatus) ? "failed" : resultStatus === "passed" ? "completed" : "deferred");
  }
  const idle = { connected: true, activeLeaseCount: 0, pendingCount: 0, queueCount: 0, activeReconciliationCount: 0 };
  assert.equal(buildControllerExecutionReceipt({ freshStatus: idle }).stageReceipts.idle_reconciled_check.status, "completed");
  for (const field of ["activeLeaseCount", "pendingCount", "queueCount", "activeReconciliationCount"]) {
    for (const value of [null, undefined, 1, "0"]) {
      assert.equal(buildControllerExecutionReceipt({ freshStatus: { ...idle, [field]: value } }).stageReceipts.idle_reconciled_check.status, "deferred");
    }
  }
});

test("classifies Companion timeout and ownership markers without treating auth as a repair candidate", () => {
  const companion = classifyThreadTail("session_not_owned after iframe frame origin mismatch; pending operation=1; timeout");
  assert.equal(companion.companionIssue, true);
  assert.equal(companion.userHelpRequired, false);
  assert.equal(companion.blocked, false);
  assert.equal(companion.stateScope, "live_candidate");

  const auth = classifyThreadTail("CAPTCHA is rendered and OTP is required; status=blocked");
  assert.equal(auth.companionIssue, false);
  assert.equal(auth.userHelpRequired, true);
  assert.equal(auth.blocked, true);
  assert.equal(auth.stateScope, "live_candidate");
});

test("keeps explicitly interrupted turns in a paused scope", () => {
  const paused = classifyThreadTail("<turn_aborted> user interrupted the turn after a Companion timeout");
  assert.equal(paused.interrupted, true);
  assert.equal(paused.stateScope, "paused");
  assert.equal(buildRepairPlan(paused).disposition, "paused");
  assert.equal(buildResumeAssessment(paused).reason, "interrupted");
});

test("classifies serialized Goal blocked status from the normalized session line", () => {
  const objective = "x".repeat(160);
  const blocked = classifyThreadTail(JSON.stringify({
    type: "event_msg",
    payload: {
      type: "thread_goal_updated",
      goal: { objective, status: "blocked" },
    },
  }));
  assert.equal(blocked.blocked, true);
  assert.equal(buildRepairPlan(blocked).disposition, "blocked");
  assert.equal(buildResumeAssessment(blocked).reason, "task_blocked");
});

test("does not promote policy prose into a live blocker", () => {
  const policy = classifyThreadTail("Never replay unknown effect; do not stop for a CAPTCHA string alone; Companion timeout recovery is bounded.");
  assert.equal(policy.userHelpRequired, false);
  assert.equal(policy.companionIssue, false);
});

test("ignores injected Goal continuation context when classifying a task tail", () => {
  const injected = JSON.stringify({
    payload: {
      type: "message",
      content: [{
        text: "<codex_internal_context source=\"goal\">\n"
          + "objective: keep the Goal active; status=blocked, timeout, blocked, CAPTCHA, interrupted, and Companion errors are policy terms.\n"
          + "</codex_internal_context>",
      }],
    },
  });
  const result = classifyThreadTail(injected);
  assert.equal(result.companionIssue, false);
  assert.deepEqual(result.companionMarkers, []);
  assert.equal(result.userHelpRequired, false);
  assert.equal(result.blocked, false);
  assert.equal(result.completed, false);
  assert.equal(result.interrupted, false);
});

test("does not classify assistant status prose as a new task incident", () => {
  const assistantReport = JSON.stringify({
    payload: {
      type: "message",
      role: "assistant",
      content: [{ text: "Companion timeout is blocked and the previous attempt was interrupted." }],
    },
  });
  const result = classifyThreadTail(assistantReport);
  assert.equal(result.companionIssue, false);
  assert.deepEqual(result.companionMarkers, []);
  assert.equal(result.blocked, false);
  assert.equal(result.interrupted, false);
});

test("ignores captured exec wrappers instead of treating their stdout as task evidence", () => {
  const wrapped = JSON.stringify({
    payload: {
      type: "custom_tool_call_output",
      output: [
        { type: "input_text", text: "Script completed\\nOutput:" },
        { type: "input_text", text: "result: blocked; Companion timeout; previous assistant report" },
      ],
    },
  });
  const result = classifyThreadTail(wrapped);
  assert.equal(result.companionIssue, false);
  assert.equal(result.blocked, false);
});

test("drops a partial JSONL tail record before classifying recent user sessions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-partial-session-tail-"));
  const sessionFile = path.join(root, "session.jsonl");
  const sessionId = "01partial-tail-session";
  fs.writeFileSync(sessionFile, [
    JSON.stringify({
      type: "session_meta",
      payload: {
        thread_source: "user",
        session_id: sessionId,
        cwd: root,
        timestamp: "2026-09-03T00:00:00.000Z",
      },
    }),
    `{"payload":{"type":"message","role":"assistant","content":[{"text":"${"x".repeat(60_000)} status=blocked Companion timeout"}]}}`,
    JSON.stringify({
      payload: {
        type: "message",
        role: "assistant",
        content: [{ text: "Companion timeout was only a prior report." }],
      },
    }),
  ].join("\n") + "\n");
  const [session] = collectRecentUserSessions({ sessionRoot: root, recentDays: 0 })
    .filter((item) => item.threadId === sessionId);
  assert.ok(session);
  assert.equal(session.companionIssue, false);
  assert.equal(session.blocked, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("reports recent-tail soft anomalies separately from hard repair candidates", () => {
  const observed = classifyThreadTail([
    "Scope drifted from the requested target and unrelated work was performed.",
    "最初の試行は timeout で失敗した。",
    "再試行後の結果: 成功して完了した。",
    "status: retry 2 after reconnect; the connection was unstable.",
    "進捗: 実装完了; 検証: 未確認; 次のアクション: 未定",
  ].join("\n"));
  const types = observed.softAnomalies.map((item) => item.type);
  assert.deepEqual(types, [
    "intent_drift",
    "recovered_near_miss",
    "unstable_behavior",
    "progress_verification_next_action_gap",
  ]);
  for (const anomaly of observed.softAnomalies) {
    assert.equal(anomaly.disposition, "report_only");
    assert.equal(anomaly.actionability, "review_only");
    assert.equal(anomaly.automaticRepairCandidate, false);
    assert.equal(anomaly.repairCandidate, false);
    assert.ok(anomaly.evidence.length >= 1);
    assert.match(anomaly.evidence[0].locator, /^thread_tail:line_/u);
  }

  const sameLineRecovery = classifyThreadTail("最初の試行は timeout で失敗したが、再試行後の結果: 成功");
  assert.ok(sameLineRecovery.softAnomalies.some((item) => item.type === "recovered_near_miss"));
});

test("detects small workflow deviation and one observed web-operation wobble", () => {
  const observed = classifyThreadTail([
    "The browser click did not work on the first attempt, but no external submission occurred.",
    "The page looked slightly off from the requested target; status: continuing.",
  ].join("\n"));
  const types = observed.softAnomalies.map((item) => item.type);
  assert.ok(types.includes("web_operation_friction"));
  assert.ok(types.includes("workflow_deviation"));
  assert.equal(observed.companionIssue, false);
  assert.ok(observed.softAnomalies.every((item) => item.disposition === "report_only"));
});

test("requires fresh root evidence before a confirmed soft anomaly becomes a proactive repair", () => {
  const confirmed = {
    threadId: "thread-visual-near-miss",
    softAnomalyConfirmed: true,
    softAnomalyType: "unstable_behavior",
    proactiveCompanionLocal: true,
    proactiveRepairReady: true,
    playbookId: "visual_operation_stability",
  };
  assert.equal(buildProactiveRepairPlan({
    ...confirmed,
    proactiveRepairReady: false,
  }), null);
  const plan = buildProactiveRepairPlan(confirmed);
  assert.equal(plan.schema, "aos.companion_proactive_repair.v1");
  assert.equal(plan.automatic, true);
  assert.equal(plan.playbookId, "visual_operation_stability");
  assert.match(plan.nextAction, /visualProof/u);

  const summary = buildAuditSummary({
    now: "2026-08-31T03:00:00.000Z",
    recentDays: 0,
    sessionRoot: fs.mkdtempSync(path.join(os.tmpdir(), "aos-proactive-session-root-")),
    companionSource: path.join(os.tmpdir(), "missing-companion-source"),
    companionInstall: path.join(os.tmpdir(), "missing-companion-install"),
    artifactDir: path.join(os.tmpdir(), "aos-proactive-summary-test"),
    proactiveRepairCandidates: [confirmed],
  });
  assert.equal(summary.repairCandidates.length, 1);
  assert.equal(summary.repairCandidates[0].proactive, true);
  assert.equal(summary.repairCandidates[0].repairPlan.playbookId, "visual_operation_stability");
  assert.equal(summary.controller.interactionPolicy.operationMode, "visual_first_for_click_hover_scroll_controls");
  assert.equal(summary.controller.interactionPolicy.inputMode, "preserve_semantic_native_input_path");
});

test("inspects every authoritative recent task lightly and deep-reads only selected candidates", async () => {
  const light = [];
  const deep = [];
  const tasks = [
    { threadId: "healthy", owner: "user", status: "idle", revision: "r1", updatedAt: "2026-08-31T00:00:00.000Z" },
    { threadId: "changed", owner: "user", status: "idle", revision: "r2", updatedAt: "2026-08-31T00:05:00.000Z" },
    { threadId: "stalled", owner: "user", status: "running", revision: "r3", updatedAt: "2026-08-30T23:00:00.000Z" },
    { threadId: "automation", owner: "automation", status: "running", revision: "r9", updatedAt: "2026-08-31T00:05:00.000Z" },
  ];
  const previous = [
    { threadId: "healthy", owner: "user", status: "idle", revision: "r1", updatedAt: "2026-08-31T00:00:00.000Z", lastSeenAt: "2026-08-31T00:10:00.000Z" },
    { threadId: "changed", owner: "user", status: "idle", revision: "r1", updatedAt: "2026-08-31T00:00:00.000Z", lastSeenAt: "2026-08-31T00:10:00.000Z" },
    { threadId: "stalled", owner: "user", status: "running", revision: "r3", updatedAt: "2026-08-30T23:00:00.000Z", lastSeenAt: "2026-08-31T00:10:00.000Z" },
  ];
  const plan = buildThreadInspectionPlan({
    tasks,
    previousInspections: previous,
    previousInspectionRunAt: "2026-08-31T00:10:00.000Z",
    now: Date.parse("2026-08-31T01:00:00.000Z"),
  });
  assert.equal(plan.mode, "lightweight_all_then_deep_read_candidates");
  assert.equal(plan.eligibleTaskCount, 3);
  const result = await inspectRecentUserThreads({
    tasks,
    previousInspections: previous,
    previousInspectionRunAt: "2026-08-31T00:10:00.000Z",
    now: Date.parse("2026-08-31T01:00:00.000Z"),
    inspectThread: async (input) => {
      light.push(input);
      return { threadStatus: input.task.status, revision: input.task.revision };
    },
    readThread: async (input) => {
      deep.push(input);
      return { status: "completed" };
    },
  });
  assert.equal(result.eligibleTaskCount, 3);
  assert.equal(result.skippedNonUserOwnedCount, 1);
  assert.equal(result.lightweightInspectionCount, 3);
  assert.equal(result.lightweightReadCount, 3);
  assert.equal(result.deepReadCandidateCount, 2);
  assert.equal(result.deepReadCount, 2);
  assert.deepEqual(light.map((item) => item.threadId), ["healthy", "changed", "stalled"]);
  assert.deepEqual(deep.map((item) => item.threadId), ["changed", "stalled"]);
  assert.equal(light.every((item) => item.turnLimit === 1 && item.includeOutputs === false), true);
  assert.equal(deep.every((item) => item.turnLimit === 8 && item.includeOutputs === true), true);
  assert.deepEqual(selectDeepReadCandidates(tasks, {
    previousInspections: previous,
    previousInspectionRunAt: "2026-08-31T00:10:00.000Z",
    now: Date.parse("2026-08-31T01:00:00.000Z"),
  }).map((item) => item.threadId), ["changed", "stalled"]);
});

test("deep-reads stable active tasks and carries deep blocker state into the record", async () => {
  const deep = [];
  const result = await inspectRecentUserThreads({
    tasks: [{
      threadId: "active-stable",
      owner: "user",
      status: "active",
      revision: "r1",
      updatedAt: "2026-08-31T00:00:00.000Z",
    }],
    previousInspections: [{
      threadId: "active-stable",
      owner: "user",
      status: "active",
      revision: "r1",
      updatedAt: "2026-08-31T00:00:00.000Z",
      lastSeenAt: "2026-08-31T00:10:00.000Z",
    }],
    previousInspectionRunAt: "2026-08-31T00:10:00.000Z",
    now: Date.parse("2026-08-31T01:00:00.000Z"),
    inspectThread: async () => ({
      status: "active",
      owner: "user",
      revision: "r1",
      updatedAt: "2026-08-31T00:00:00.000Z",
    }),
    readThread: async (input) => {
      deep.push(input);
      return {
        status: "active",
        owner: "user",
        exactBlocker: "page_execution_timeout",
      };
    },
  });
  assert.equal(result.deepReadCandidateCount, 1);
  assert.equal(result.deepReadCount, 1);
  assert.deepEqual(deep.map((input) => input.threadId), ["active-stable"]);
  assert.equal(result.records[0].active, true);
  assert.equal(result.records[0].exactBlocker, "page_execution_timeout");
  assert.equal(result.records[0].deepRead.status, "observed");
});

test("uses lightweight readback fields when selecting same-run deep-read candidates", async () => {
  const deep = [];
  const result = await inspectRecentUserThreads({
    tasks: [{ threadId: "thread-readback", owner: "user", status: "idle", revision: "r1", updatedAt: "2026-08-31T00:00:00.000Z" }],
    previousInspections: [{
      threadId: "thread-readback",
      owner: "user",
      status: "idle",
      revision: "r1",
      updatedAt: "2026-08-31T00:00:00.000Z",
      lastSeenAt: "2026-08-31T00:10:00.000Z",
    }],
    previousInspectionRunAt: "2026-08-31T00:10:00.000Z",
    now: Date.parse("2026-08-31T01:00:00.000Z"),
    inspectThread: async () => ({
      status: "running",
      owner: "user",
      revision: "r2",
      updatedAt: "2026-08-31T00:55:00.000Z",
      generation: "gen-readback",
      actionable: true,
      stalled: true,
    }),
    readThread: async (input) => {
      deep.push(input);
      return { status: "running" };
    },
  });
  assert.equal(result.lightweightReadCount, 1);
  assert.equal(result.deepReadCandidateCount, 1);
  assert.equal(result.deepReadCount, 1);
  assert.deepEqual(deep.map((input) => input.threadId), ["thread-readback"]);
  assert.equal(result.records[0].status, "running");
  assert.equal(result.records[0].revision, "r2");
  assert.equal(result.records[0].actionable, true);
  assert.equal(result.records[0].stalled, true);
  assert.equal(result.records[0].deepReadEligible, true);
});

test("normalizes official App Unix-second timestamps before change and stall detection", () => {
  const timestampSeconds = 1788378031;
  const timestampIso = new Date(timestampSeconds * 1000).toISOString();
  const stable = buildThreadInspectionPlan({
    tasks: [{ threadId: "unix-seconds-stable", owner: "user", status: "idle", updatedAt: timestampSeconds }],
    previousInspections: [{
      threadId: "unix-seconds-stable",
      owner: "user",
      status: "idle",
      revision: timestampIso,
      updatedAt: timestampIso,
      lastSeenAt: "2026-09-03T04:40:00.000Z",
    }],
    previousInspectionRunAt: "2026-09-03T04:40:00.000Z",
    now: timestampSeconds * 1000 + 60_000,
  });
  assert.equal(stable.records[0].updatedAt, timestampIso);
  assert.equal(stable.records[0].revision, timestampIso);
  assert.equal(stable.records[0].changed, false);
  assert.equal(stable.records[0].deepReadEligible, false);

  const stalled = buildThreadInspectionPlan({
    tasks: [{ threadId: "unix-seconds-stalled", owner: "user", status: "active", updatedAt: timestampSeconds - 7_200 }],
    now: timestampSeconds * 1000,
    stalledTaskThresholdMs: 300_000,
  });
  assert.equal(stalled.records[0].stalled, true);
  assert.deepEqual(stalled.records[0].deepReadReasons, ["changed", "stalled", "active"]);
});

test("does not trust a contradictory automation owner over a userOwned flag", () => {
  const plan = buildThreadInspectionPlan({
    tasks: [{ threadId: "automation-owned", userOwned: true, owner: "automation", status: "running" }],
  });
  assert.equal(plan.eligibleTaskCount, 0);
  assert.equal(plan.skippedNonUserOwnedCount, 1);
});

test("keeps first soft anomaly review-only and confirms only stable consecutive evidence", () => {
  const finding = { threadId: "thread-soft", type: "unstable_behavior", owner: "user", generation: "gen-1", evidence: [] };
  const first = confirmSoftAnomalyFindings([finding], { runs: [], softConfirmations: {} }, { now: "2026-08-31T00:00:00.000Z" })[0];
  assert.equal(first.confirmationCount, 1);
  assert.equal(first.confirmed, false);
  assert.equal(first.deepReadEligible, false);
  assert.equal(first.escalationAllowed, false);
  assert.equal(first.disposition, "report_only");

  const second = confirmSoftAnomalyFindings([finding], {
    runs: [{ softAnomalyKeys: ["thread-soft:unstable_behavior"] }],
    softConfirmations: {
      "thread-soft:unstable_behavior": { count: 1, owner: "user", generation: "gen-1" },
    },
  }, { now: "2026-08-31T01:00:00.000Z" })[0];
  assert.equal(second.confirmationCount, 2);
  assert.equal(second.confirmed, true);
  assert.equal(second.deepReadEligible, true);
  assert.equal(second.automaticRepairCandidate, false);
  assert.equal(second.escalationAllowed, false);

  const generationChanged = confirmSoftAnomalyFindings([{ ...finding, generation: "gen-2" }], {
    runs: [{ softAnomalyKeys: ["thread-soft:unstable_behavior"] }],
    softConfirmations: {
      "thread-soft:unstable_behavior": { count: 1, owner: "user", generation: "gen-1" },
    },
  }, { now: "2026-08-31T02:00:00.000Z" })[0];
  assert.equal(generationChanged.confirmationCount, 1);
  assert.equal(generationChanged.confirmed, false);
  assert.match(generationChanged.confirmation.reason, /generation_changed/u);
});

test("includes soft findings from recent completed and live threads without promoting them to repair", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-companion-soft-history-"));
  const sessionRoot = path.join(root, "sessions");
  fs.mkdirSync(sessionRoot, { recursive: true });
  const writeSession = (name, id, status) => {
    fs.writeFileSync(path.join(sessionRoot, name), [
      JSON.stringify({ type: "session_meta", payload: { thread_source: "user", session_id: id, cwd: root, timestamp: "2026-08-31T00:00:00.000Z" } }),
      JSON.stringify({ type: "event_msg", message: `progress: implementation complete; verification: unverified; next action: unclear; status: ${status}` }),
    ].join("\n") + "\n");
  };
  writeSession("history.jsonl", "thread-soft-history", "completed");
  writeSession("live.jsonl", "thread-soft-live", "running");

  const summary = buildAuditSummary({
    now: "2026-08-31T01:00:00.000Z",
    sessionRoot,
    companionSource: path.join(root, "missing-source"),
    companionInstall: path.join(root, "missing-install"),
    artifactDir: path.join(root, "artifact"),
    recentDays: 0,
  });
  assert.equal(summary.softAnomalyCount, 2);
  assert.equal(summary.softAnomalySessionCount, 2);
  assert.deepEqual(summary.softAnomalyFindings.map((item) => item.threadId), ["thread-soft-history", "thread-soft-live"]);
  assert.equal(summary.softAnomalyFindings.every((item) => item.disposition === "report_only"), true);
  assert.deepEqual(summary.repairCandidates, []);
  assert.deepEqual(summary.liveCandidates.map((item) => item.threadId), ["thread-soft-live"]);
  assert.deepEqual(summary.historicalSessions.map((item) => item.threadId), ["thread-soft-history"]);
});

test("does not turn instructions or tool schema into soft anomalies", () => {
  const policy = classifyThreadTail([
    "If the scope diverges from the request, never replay and report only.",
    "When a retry succeeds after a timeout, do not infer a recovered near-miss.",
    "Do not infer a progress/verification/next action gap from policy prose.",
    "exec tool declaration: declare const tools: { mcp__aos_chrome_companion__companion_status(args: {}): Promise<CallToolResult>; };",
    "<entry access=\"write\"><path>/tmp/unrelated-instruction</path></entry><environment_context>",
  ].join("\n"));
  assert.deepEqual(policy.softAnomalies, []);

  const unrelated = classifyThreadTail([
    "外付けキーボードを再接続してください。",
    "Bluetoothを再接続して、もう一度入力してください。",
  ].join("\n"));
  assert.deepEqual(unrelated.softAnomalies, []);
});

test("does not attribute distant or hyphenated scheduler text to Companion", () => {
  const serializedOutput = classifyThreadTail([
    "aos-companion hourly audit completed with external_action_executed=false",
    `${"x".repeat(320)} blocked`,
  ].join(" "));
  assert.equal(serializedOutput.companionIssue, false);
  assert.deepEqual(serializedOutput.companionMarkers, []);

  const healthy = classifyThreadTail("Companion is connected=true; no blocker is present and the task is ready.");
  assert.equal(healthy.companionIssue, false);

  const toolSchema = classifyThreadTail(
    "The tool description mentions Companion pending operation handling. exec tool declaration: declare const tools: { mcp__aos_chrome_companion__companion_status(args: {}): Promise<CallToolResult>; };",
  );
  assert.equal(toolSchema.companionIssue, false);

  const routeConfig = classifyThreadTail(
    "Only when the stage requires a web UI, use the Mac Chrome Plugin with signed Chrome Extension Profile 2: backend=chrome_plugin, browser_surface=signed_chrome_extension_profile2.",
  );
  assert.equal(routeConfig.companionIssue, false);

  const toolList = classifyThreadTail(
    `Script completed Output: [{"name":"mcp__aos_chrome_companion__companion_status","description":"Use Companion and never replay operation_effect_unknown."}]`,
  );
  assert.equal(toolList.companionIssue, false);

  const schedulerPayload = classifyThreadTail(
    `Script failed Output: {"promptLength":7264,"fields":{"projectId":"local","prompt":"CONNECTOR_PRIORITY_V1 chrome_plugin timeout policy"}}`,
  );
  assert.equal(schedulerPayload.companionIssue, false);

  const observed = classifyThreadTail("Companion timeout before dispatch; status=blocked");
  assert.equal(observed.companionIssue, true);
  assert.deepEqual(observed.companionMarkers, ["timeout"]);
});

test("classifies structured target binding and semantic snapshot failures", () => {
  const target = classifyThreadTail("transaction_action_target_page_mismatch: task/session/pageInstance target mismatch; status=failed");
  assert.equal(target.companionIssue, true);
  assert.equal(target.companionMarkers.includes("transaction_action_target_page_mismatch"), true);
  assert.equal(buildRepairPlan(target).playbookId, "target_binding");
  assert.equal(buildResumeAssessment(target).reason, "foreign_owner");

  const snapshot = classifyThreadTail("semantic_snapshot_empty after page.snapshot; status=failed");
  assert.equal(snapshot.companionIssue, true);
  assert.equal(buildRepairPlan(snapshot).playbookId, "frame_or_locator_readback");
});

test("requires an observed human action before classifying OTP/CAPTCHA help", () => {
  const keywordOnly = classifyThreadTail("The runbook mentions OTP/CAPTCHA handling; no visible widget is present and no user action is required.");
  assert.equal(keywordOnly.userHelpRequired, false);
  assert.deepEqual(keywordOnly.userHelpMarkers, []);

  const visibleChallenge = classifyThreadTail("A visible hCaptcha widget is waiting for user action; status=awaiting_user");
  assert.equal(visibleChallenge.userHelpRequired, true);
  assert.deepEqual(visibleChallenge.userHelpMarkers, ["captcha", "hcaptcha"]);
});

test("compacts tool payload noise out of the latest session summary", () => {
  const noisy = classifyThreadTail([
    "result: blocked",
    `dataBase64: ${"A".repeat(400)}`,
    'internal_chat_message_metadata_passthrough: {"turn_id":"secret"}',
    "remaining blocker: visible CAPTCHA widget requires user action",
    "next action: wait for user",
  ].join("\n"));
  assert.match(noisy.latestSummary, /remaining blocker/iu);
  assert.match(noisy.latestSummary, /next action/iu);
  assert.doesNotMatch(noisy.latestSummary, /dataBase64|internal_chat_message_metadata_passthrough/iu);
  assert.ok(noisy.latestSummary.length <= 600);
});

test("builds a read-only, no-effect audit contract", () => {
  const summary = buildAuditSummary({
    now: "2026-08-27T00:00:00.000Z",
    sessionRoot: "/path/that/does/not/exist",
    companionSource: "/path/that/does/not/exist/source",
    companionInstall: "/path/that/does/not/exist/install",
    artifactDir: "/tmp/aos-hourly-companion-audit-test",
  });
  assert.equal(summary.schema, "aos.hourly_companion_audit.v1");
  assert.equal(summary.readOnly, true);
  assert.equal(summary.externalActionExecuted, false);
  assert.equal(summary.controller.implementationContract.discoveryIsNotTerminal, true);
  assert.equal(summary.controller.implementationContract.runtimeReflectionTool, "companion_refresh_extension");
  assert.equal(summary.controller.implementationContract.continuation, "one send-or-queue message per eligible user task (active or inactive) after fresh readback; record sent, queued, and deferred IDs with reasons");
  assert.equal(summary.controller.implementationContract.continuationTransportProof.kind, "same_task_new_turn_completed");
  assert.deepEqual(summary.controller.implementationContract.continuationTransportProof.doesNotProve, [
    "continuation marker visibility",
    "Goal/Plan resumption",
    "business completion",
  ]);
  assert.equal(summary.controller.implementationContract.activeTaskDelivery, "queue at the next message boundary; never interrupt an executing turn or browser operation");
  assert.deepEqual(summary.controller.implementationContract.runtimeReflectionProof, [
    "result=reflected",
    "freshStatus.connected=true",
    "generation changed",
    "old sessions/leases discarded",
  ]);
  assert.equal(summary.controller.schedulingPolicy.unchangedTick, "lightweight_thread_inspection_then_heartbeat");
  assert.equal(summary.controller.schedulingPolicy.lightweightInspection, "all recent authoritative user-owned tasks once per tick");
  assert.equal(summary.controller.schedulingPolicy.noChangeMustNotCreateTask, true);
  assert.equal(summary.controller.resumeController.planIsReadOnly, true);
  assert.equal(summary.controller.resumeController.implementationModule, "scripts/lib/resume-controller.mjs");
  assert.match(summary.controller.resumeController.planEntrypoint, /resume-current-task\.mjs/);
  assert.equal(summary.controller.implementationContract.verifierInput, "aos-hourly-companion-audit.verifier.v1.json");
  assert.equal(summary.controller.implementationContract.verifierInputMaxBytes, 32_000);
  assert.equal(summary.controller.implementationContract.parallelReadOnlyCanaryCommand, "npm run canary:parallel:readonly");
  assert.equal(summary.controller.implementationContract.parallelReadOnlyCanaryCwd, "/path/that/does/not/exist/source");
  assert.equal(summary.controller.implementationContract.parallelReadOnlyCanaryMode, "broker_fixture_no_browser_mutation");
  assert.match(summary.controller.implementationContract.parallelReadOnlyCanarySafety, /no browser tabs/);
  assert.deepEqual(summary.controller.implementationContract.requiredChecks, [
    "npm run schema:check",
    "node --check for changed JavaScript modules",
    "nearest focused test",
    "representative normal-path canary",
    "npm run canary:parallel:readonly",
  ]);
  assert.deepEqual(summary.sessions, []);
});

test("writes an immutable per-run audit artifact in addition to the latest projection", () => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-hourly-immutable-artifact-"));
  const result = runHourlyAudit({
    now: "2026-08-31T00:00:00.000Z",
    sessionRoot: "/path/that/does/not/exist",
    companionSource: "/path/that/does/not/exist/source",
    companionInstall: "/path/that/does/not/exist/install",
    artifactDir,
    learningLedgerPath: path.join(artifactDir, "learning-ledger.v1.json"),
  });
  assert.equal(fs.existsSync(result.artifactPath), true);
  assert.equal(fs.existsSync(result.verifierArtifactPath), true);
  assert.equal(fs.existsSync(result.immutableArtifactPath), true);
  assert.equal(fs.existsSync(result.immutableVerifierArtifactPath), true);
  const immutable = JSON.parse(fs.readFileSync(result.immutableArtifactPath, "utf8"));
  assert.equal(immutable.runId, result.runId);
  assert.equal(fs.statSync(result.immutableArtifactPath).mode & 0o777, 0o600);
  assert.equal(result.executionReceipt.schema, "aos.companion_hourly_execution_receipt.v1");
  assert.equal(result.executionReceipt.status, "inspected");
  assert.equal(result.executionReceipt.complete, false);
  assert.equal(result.executionReceipt.stageReceipts.bounded_repair.status, "not_run");
});

test("read-only audit receipt marks a heartbeat without claiming execution", () => {
  const receipt = buildAuditExecutionReceipt({
    runId: "run-1",
    schedulerDecision: "heartbeat_only",
    summary: {
      liveCompanion: { available: true, generation: "gen-1", activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
      exactBlocker: null,
    },
  });
  assert.equal(receipt.status, "heartbeat_only");
  assert.equal(receipt.stageReceipts.fresh_status.status, "completed");
  assert.equal(receipt.stageReceipts.bounded_repair.status, "not_run");
  assert.equal(receipt.externalActionExecuted, false);
});

test("read-only audit receipt explicitly requires the official App root when candidates remain", () => {
  const receipt = buildAuditExecutionReceipt({
    runId: "run-root-action-required",
    schedulerDecision: "inspect_and_repair",
    summary: {
      liveCompanion: { available: true, generation: "gen-1", activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
      repairCandidates: [{ threadId: "opaque-candidate", blocked: true }],
    },
  });
  assert.equal(receipt.rootActionRequired, true);
  assert.equal(receipt.rootAction.schema, "aos.companion_root_action_required.v1");
  assert.equal(receipt.rootAction.mode, "official_codex_app_tools");
  assert.equal(receipt.rootAction.candidateCount, 1);
  assert.equal(receipt.rootAction.aliasesAndLocalHistoryAreNotSendTargets, true);
  assert.equal(receipt.rootAction.crossTaskCompanionOperationsForbidden, true);
  assert.deepEqual(receipt.rootAction.sequence.slice(0, 2), [
    "fresh official list_threads/read_thread with real threadId and hostId",
    "same-task status/owner/effect readback",
  ]);
});

test("requires the official App root for blocker, stalled, or deep-read signals even without a repair playbook", () => {
  const receipt = buildAuditExecutionReceipt({
    runId: "run-root-action-for-blocker",
    schedulerDecision: "inspect_and_repair",
    summary: {
      liveCompanion: { available: true, generation: "gen-1", activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
      repairCandidates: [],
      threadReadbackBlockerCandidates: [{ threadId: "opaque-blocked-task", exactBlocker: "send_result_unknown" }],
      changeDetection: { stalledTaskCount: 0 },
      threadInspection: { deepReadCandidateCount: 0 },
      softAnomalyDeepReadCandidateCount: 0,
    },
  });
  assert.equal(receipt.rootActionRequired, true);
  assert.equal(receipt.rootAction.candidateCount, 0);
  assert.equal(receipt.rootAction.blockerCandidateCount, 1);
  assert.equal(receipt.rootAction.deepReadCandidateCount, 0);
});

test("keeps a partial thread readback task-level and continues the audit", () => {
  const receipt = buildAuditExecutionReceipt({
    runId: "run-incomplete-readback",
    schedulerDecision: "inspect_and_repair",
    summary: {
      liveCompanion: { available: true, generation: "gen-1", activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
      threadInspection: {
        listedCount: 2,
        eligibleTaskCount: 2,
        lightweightInspectionCount: 2,
        lightweightReadCount: 1,
        deepReadCandidateCount: 1,
        deepReadAttemptedCount: 0,
        deepReadCount: 0,
      },
    },
  });
  assert.equal(receipt.status, "inspected");
  assert.equal(receipt.complete, false);
  assert.equal(receipt.exactBlocker, null);
  assert.equal(receipt.stageReceipts.lightweight_thread_inspection.status, "completed");
  assert.equal(receipt.stageReceipts.lightweight_thread_inspection.deferredTaskCount, 0);
});

test("keeps a partial official-App readback failure as an actionable task blocker", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-partial-official-readback-"));
  const summary = buildAuditSummary({
    now: "2026-09-03T00:00:00.000Z",
    sessionRoot: path.join(root, "sessions"),
    artifactDir: path.join(root, "artifact"),
    companionSource: path.join(root, "missing-source"),
    companionInstall: path.join(root, "missing-install"),
    liveStatus: { connected: true, generation: "gen-1", exactTabLeaseCount: 0, pendingOperationCount: 0, queueCount: 0 },
    threadInspection: {
      schema: "aos.companion_thread_inspection.v1",
      source: "codex_app_thread_list",
      listedCount: 2,
      eligibleTaskCount: 2,
      lightweightInspectionCount: 2,
      lightweightReadCount: 1,
      deepReadCandidateCount: 0,
      records: [
        {
          threadId: "failed-readback-task",
          owner: "user",
          status: "active",
          goalStatus: "unknown",
          planStatus: "unknown",
          exactBlocker: null,
          deepReadEligible: false,
          lightweight: { status: "failed", exactBlocker: "thread_readback_unavailable" },
          deepRead: { status: "not_run", exactBlocker: "not_a_deep_read_candidate" },
        },
        {
          threadId: "healthy-readback-task",
          owner: "user",
          status: "idle",
          goalStatus: "active",
          planStatus: "active",
          exactBlocker: null,
          deepReadEligible: false,
          lightweight: { status: "observed" },
          deepRead: { status: "not_run", exactBlocker: "not_a_deep_read_candidate" },
        },
      ],
    },
  });

  const candidate = summary.threadReadbackBlockerCandidates.find((item) => item.threadId === "failed-readback-task");
  assert.ok(candidate);
  assert.equal(candidate.exactBlocker, "thread_readback_unavailable");
  assert.equal(candidate.blocked, true);
  assert.equal(candidate.blockerProgress.reason, "thread_readback_unavailable");
  assert.equal(candidate.blockerProgress.replayAllowed, false);
  assert.equal(summary.repairCandidates.some((item) => item.threadId === "failed-readback-task"), true);
  const receipt = buildAuditExecutionReceipt({
    runId: "partial-official-readback-receipt",
    schedulerDecision: "inspect_and_repair",
    summary,
  });
  assert.equal(receipt.rootActionRequired, true);
  assert.equal(receipt.rootAction.blockerCandidateCount, 1);
});

test("blocks the audit only when every lightweight task read fails", () => {
  const receipt = buildAuditExecutionReceipt({
    runId: "run-all-readback-failed",
    schedulerDecision: "inspect_and_repair",
    summary: {
      liveCompanion: { available: true, generation: "gen-1", activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
      threadInspection: {
        listedCount: 2,
        eligibleTaskCount: 2,
        lightweightInspectionCount: 2,
        lightweightReadCount: 0,
        deepReadCandidateCount: 0,
        deepReadAttemptedCount: 0,
        deepReadCount: 0,
      },
    },
  });
  assert.equal(receipt.status, "blocked");
  assert.equal(receipt.complete, false);
  assert.equal(receipt.exactBlocker, "codex_app_thread_readback_all_failed");
  assert.equal(receipt.stageReceipts.lightweight_thread_inspection.status, "deferred");
});

test("consumes a bounded root readback projection and records real lightweight/deep reads", async () => {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "aos-hourly-projection-"));
  const alias = createThreadAlias("thread-readback-projection");
  const projection = createThreadReadbackProjection({
    automationId: "aos-companion-2",
    rootRunId: "root-run-1",
    childAuditId: "child-audit-1",
    lightweight: [{
      alias,
      outcome: "success",
      state: {
        taskStatus: "idle",
        latestTurnStatus: "completed",
        goalStatus: "active",
        planStatus: "active",
        owner: "user",
        userOwned: true,
        actionable: true,
        stalled: false,
        changed: true,
        revision: "rev-1",
        updatedAt: "2026-09-01T11:59:00.000Z",
        generation: "gen-1",
        exactBlocker: null,
        softAnomalyTypes: [],
      },
    }],
    deep: [{ alias, outcome: "success" }],
  });
  try {
    const result = await runHourlyAuditLive({
      now: "2026-09-01T12:00:00.000Z",
      sessionRoot: "/path/that/does/not/exist",
      companionSource: "/path/that/does/not/exist/source",
      companionInstall: "/path/that/does/not/exist/install",
      artifactDir,
      learningLedgerPath: path.join(artifactDir, "learning-ledger.v1.json"),
      liveStatus: { available: true, connected: true, generation: "gen-1", activeLeaseCount: 0, pendingCount: 0, queueCount: 0, activeReconciliationCount: 0, activeTaskTabCount: 0 },
      threadReadbackProjection: projection,
    });
    assert.equal(result.threadReadbackProjection.projectionDigest, projection.projectionDigest);
    assert.equal(result.threadInspection.lightweightInspectionCount, 1);
    assert.equal(result.threadInspection.lightweightReadCount, 1);
    assert.equal(result.threadInspection.deepReadCandidateCount, 1);
    assert.equal(result.threadInspection.deepReadAttemptedCount, 1);
    assert.equal(result.threadInspection.deepReadCount, 1);
    assert.equal(result.executionReceipt.exactBlocker, null);
  } finally {
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});

test("promotes a notLoaded interrupted task after the projection deep read", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-hourly-notloaded-relay-"));
  const sessionRoot = path.join(root, "sessions");
  const artifactDir = path.join(root, "artifact");
  const threadId = "01f22222222222222222222222222222";
  const alias = createThreadAlias(threadId);
  fs.mkdirSync(sessionRoot, { recursive: true });
  fs.writeFileSync(path.join(sessionRoot, "paused.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { thread_source: "user", session_id: threadId, cwd: root, timestamp: "2026-09-05T00:00:00.000Z" } }),
    JSON.stringify({ type: "event_msg", message: "<turn_aborted> the existing Goal was interrupted before completion" }),
  ].join("\n") + "\n");

  const projection = createThreadReadbackProjection({
    automationId: "aos-companion-2",
    rootRunId: "root-notloaded-relay",
    childAuditId: "child-notloaded-relay",
    lightweight: [{
      alias,
      outcome: "success",
      state: {
        taskStatus: "notLoaded",
        latestTurnStatus: "unknown",
        goalStatus: "unknown",
        planStatus: "unknown",
        owner: "user",
        userOwned: true,
        actionable: false,
        stalled: false,
        changed: false,
        revision: "rev-light",
        updatedAt: "2026-09-05T00:00:00.000Z",
        generation: null,
        exactBlocker: null,
        softAnomalyTypes: [],
      },
    }],
    deep: [{
      alias,
      outcome: "success",
      state: {
        taskStatus: "notLoaded",
        latestTurnStatus: "interrupted",
        goalStatus: "active",
        planStatus: "active",
        owner: "user",
        userOwned: true,
        actionable: false,
        stalled: false,
        changed: false,
        revision: "rev-deep",
        updatedAt: "2026-09-05T00:00:01.000Z",
        generation: null,
        exactBlocker: null,
        softAnomalyTypes: [],
      },
    }],
  });

  try {
    const result = await runHourlyAuditLive({
      now: "2026-09-05T00:01:00.000Z",
      sessionRoot,
      artifactDir,
      learningLedgerPath: path.join(root, "learning-ledger.v1.json"),
      companionSource: path.join(root, "missing-source"),
      companionInstall: path.join(root, "missing-install"),
      liveStatus: { available: true, connected: true, generation: "gen-current", activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
      threadReadbackProjection: projection,
    });

    assert.equal(result.threadInspection.deepReadCandidateCount, 1);
    assert.equal(result.threadInspection.deepReadCount, 1);
    assert.deepEqual(result.officialAppOnlyContinuationCandidates.map((item) => item.threadId), [threadId]);
    assert.equal(result.officialAppOnlyContinuationCandidates[0].officialLatestTurnStatus, "interrupted");
    assert.equal(result.officialAppOnlyContinuationCandidates[0].resumeAssessment.state, "ready");
    assert.equal(result.officialAppOnlyContinuationCandidates[0].resumeAssessment.automaticActionAllowed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("merges a fresh live Companion status into the hourly signal", () => {
  const summary = buildAuditSummary({
    now: "2026-08-31T00:00:00.000Z",
    sessionRoot: "/path/that/does/not/exist",
    companionSource: "/path/that/does/not/exist/source",
    companionInstall: "/path/that/does/not/exist/install",
    artifactDir: "/tmp/aos-hourly-companion-live-status-test",
    liveStatus: {
      available: true,
      status: {
        connected: true,
        generation: "generation-live",
        reconciliationPendingActiveCount: 7,
        activeTaskTabCount: 7,
        exactTabLeaseCount: 0,
        pendingOperationCount: 0,
        queueCount: 0,
      },
    },
  });
  assert.equal(summary.liveCompanion.available, true);
  assert.equal(summary.liveCompanion.activeReconciliationCount, 7);
  assert.equal(summary.exactBlocker, "active_reconciliation");
  assert.equal(summary.companionIssueCount, 1);
  assert.match(summary.nextAction, /reconciliation readback/u);
  assert.notEqual(buildAuditFingerprint(summary), buildAuditFingerprint({ ...summary, liveCompanion: { ...summary.liveCompanion, activeReconciliationCount: 0 }, exactBlocker: null }));
});

test("derives live connectivity and generation from broker profile status", () => {
  const summary = buildAuditSummary({
    now: "2026-08-31T00:00:00.000Z",
    sessionRoot: "/path/that/does/not/exist",
    companionSource: "/path/that/does/not/exist/source",
    companionInstall: "/path/that/does/not/exist/install",
    artifactDir: "/tmp/aos-hourly-companion-profile-status-test",
    liveStatus: {
      available: true,
      status: {
        profiles: [{ connected: true, generation: "generation-from-profile" }],
        taskTabs: [],
      },
    },
  });
  assert.equal(summary.liveCompanion.connected, true);
  assert.equal(summary.liveCompanion.generation, "generation-from-profile");
  assert.equal(summary.liveCompanion.exactBlocker, null);
});

test("uses the broker's canonical exactTabLeaseCount for idle gating", async () => {
  const result = await runBoundedHourlyController({
    summary: { auditFingerprint: "canonical-lease-count" },
    freshStatus: {
      connected: true,
      generation: "generation-live",
      exactTabLeaseCount: 1,
      pendingOperationCount: 0,
      queueCount: 0,
      reconciliationPendingActiveCount: 0,
    },
  });
  assert.equal(result.status, "deferred");
  assert.equal(result.exact_blocker, "companion_idle_reconciled_boundary_required");
  assert.equal(result.freshStatus.activeLeaseCount, 1);
});

test("reports a disconnected Companion before the idle boundary", async () => {
  const result = await runBoundedHourlyController({
    summary: { auditFingerprint: "disconnected-companion" },
    freshStatus: {
      connected: false,
      generation: null,
      activeLeaseCount: 0,
      pendingCount: 0,
      queueCount: 0,
    },
  });
  assert.equal(result.status, "deferred");
  assert.equal(result.exact_blocker, "companion_disconnected");
  assert.equal(result.executionReceipt.stageReceipts.fresh_status.status, "completed");
  assert.equal(result.executionReceipt.stageReceipts.idle_reconciled_check.status, "deferred");
  assert.equal(result.executionReceipt.stageReceipts.signed_refresh.status, "not_run");
});

test("does not treat ownerless retained tabs from an older broker as active work", () => {
  const summary = buildAuditSummary({
    now: "2026-08-31T00:00:00.000Z",
    sessionRoot: "/path/that/does/not/exist",
    companionSource: "/path/that/does/not/exist/source",
    companionInstall: "/path/that/does/not/exist/install",
    artifactDir: "/tmp/aos-hourly-companion-ownerless-status-test",
    liveStatus: {
      available: true,
      status: {
        profiles: [{ connected: true, generation: "generation-live" }],
        logicalSessions: [],
        exactTabLeases: [],
        pendingOperations: [],
        reconciliationGate: { active: true, activeCount: 7, blocksOn: "legacy_all_records" },
        activeTaskTabCount: 7,
        taskTabs: [{
          profileInstanceId: "profile-live",
          tabId: 11,
          sessionId: "session-gone",
          taskId: "task-old",
          runId: "run-old",
          lifecycleState: "reconciliation_required",
          tabDisposition: "retained",
          userHelpRequired: false,
        }],
      },
    },
  });
  assert.equal(summary.liveCompanion.activeReconciliationCount, 0);
  assert.equal(summary.liveCompanion.activeTaskTabCount, 0);
  assert.equal(summary.liveCompanion.exactBlocker, null);
});

test("live Companion status reader is read-only and reports a missing source explicitly", async () => {
  const result = await readLiveCompanionStatus({ sourceRoot: "/path/that/does/not/exist" });
  assert.equal(result.available, false);
  assert.equal(result.exactBlocker, "companion_client_source_missing");
});

test("reports Companion source/install artifact drift without mutating either tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-companion-audit-"));
  const source = path.join(root, "source");
  const installed = path.join(root, "installed");
  for (const tree of [source, installed]) {
    fs.mkdirSync(path.join(tree, "extension"), { recursive: true });
    fs.mkdirSync(path.join(tree, "src", "broker"), { recursive: true });
    fs.mkdirSync(path.join(tree, "src", "mcp"), { recursive: true });
    fs.mkdirSync(path.join(tree, "plugins", "aos-chrome-companion", "skills", "aos-chrome-companion"), { recursive: true });
  }
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ version: "0.3.2" }));
  fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify({ version: "0.3.2" }));
  fs.writeFileSync(path.join(source, "extension", "service-worker.js"), "new-runtime");
  fs.writeFileSync(path.join(installed, "extension", "service-worker.js"), "old-runtime");
  fs.writeFileSync(path.join(source, "extension", "operation-schema.generated.js"), "schema");
  fs.writeFileSync(path.join(installed, "extension", "operation-schema.generated.js"), "schema");
  for (const tree of [source, installed]) {
    fs.writeFileSync(path.join(tree, "src", "broker", "broker.mjs"), "broker");
    fs.writeFileSync(path.join(tree, "src", "mcp", "server.mjs"), "mcp");
    fs.writeFileSync(path.join(tree, "plugins", "aos-chrome-companion", "skills", "aos-chrome-companion", "SKILL.md"), "skill");
  }

  const summary = buildAuditSummary({
    now: "2026-08-27T00:00:00.000Z",
    sessionRoot: path.join(root, "sessions"),
    companionSource: source,
    companionInstall: installed,
    artifactDir: path.join(root, "artifact"),
  });
  assert.equal(summary.companionArtifacts.match, false);
  assert.deepEqual(summary.companionArtifacts.mismatches, ["extension/service-worker.js"]);
  assert.equal(summary.exactBlocker, "companion_installed_artifact_drift");
  assert.equal(fs.readFileSync(path.join(installed, "extension", "service-worker.js"), "utf8"), "old-runtime");
});

test("includes the resident broker in runtime drift detection", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-companion-broker-drift-"));
  const source = path.join(root, "source");
  const installed = path.join(root, "installed");
  for (const tree of [source, installed]) {
    fs.mkdirSync(path.join(tree, "extension"), { recursive: true });
    fs.mkdirSync(path.join(tree, "src", "broker"), { recursive: true });
    fs.mkdirSync(path.join(tree, "src", "mcp"), { recursive: true });
    fs.mkdirSync(path.join(tree, "plugins", "aos-chrome-companion", "skills", "aos-chrome-companion"), { recursive: true });
    fs.writeFileSync(path.join(tree, "package.json"), JSON.stringify({ version: "0.3.2" }));
    fs.writeFileSync(path.join(tree, "extension", "service-worker.js"), "same");
    fs.writeFileSync(path.join(tree, "extension", "operation-schema.generated.js"), "same");
    fs.writeFileSync(path.join(tree, "src", "mcp", "server.mjs"), "same");
    fs.writeFileSync(path.join(tree, "plugins", "aos-chrome-companion", "skills", "aos-chrome-companion", "SKILL.md"), "same");
  }
  fs.writeFileSync(path.join(source, "src", "broker", "broker.mjs"), "target-lane-v2");
  fs.writeFileSync(path.join(installed, "src", "broker", "broker.mjs"), "target-lane-v1");

  const summary = buildAuditSummary({
    now: "2026-08-29T00:00:00.000Z",
    sessionRoot: path.join(root, "sessions"),
    companionSource: source,
    companionInstall: installed,
    artifactDir: path.join(root, "artifact"),
  });
  assert.equal(summary.companionArtifacts.match, false);
  assert.deepEqual(summary.companionArtifacts.mismatches, ["src/broker/broker.mjs"]);
  assert.equal(summary.exactBlocker, "companion_installed_artifact_drift");
});

test("separates completed history from live repair candidates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-companion-history-scope-"));
  const sessionRoot = path.join(root, "sessions");
  fs.mkdirSync(sessionRoot, { recursive: true });
  const writeSession = (name, id, message) => {
    fs.writeFileSync(path.join(sessionRoot, name), [
      JSON.stringify({ type: "session_meta", payload: { thread_source: "user", session_id: id, cwd: root, timestamp: "2026-08-27T00:00:00.000Z" } }),
      JSON.stringify({ type: "event_msg", message }),
    ].join("\n") + "\n");
  };
  writeSession("history.jsonl", "thread-history", "Companion timeout; status: completed");
  writeSession("live.jsonl", "thread-live", "Companion timeout; status: blocked");

  const summary = buildAuditSummary({
    now: "2026-08-27T00:00:00.000Z",
    sessionRoot,
    companionSource: path.join(root, "missing-source"),
    companionInstall: path.join(root, "missing-install"),
    artifactDir: path.join(root, "artifact"),
    recentDays: 0,
  });
  assert.equal(summary.liveCandidateSessionCount, 1);
  assert.equal(summary.historicalSessionCount, 1);
  assert.equal(summary.companionIssueCount, 1);
  assert.equal(summary.historicalCompanionIssueCount, 1);
  assert.deepEqual(summary.liveCandidates.map((item) => item.threadId), ["thread-live"]);
  assert.deepEqual(summary.historicalSessions.map((item) => item.threadId), ["thread-history"]);
  assert.deepEqual(summary.repairCandidates.map((item) => item.threadId), ["thread-live"]);
  assert.equal(summary.repairPlans.find((item) => item.threadId === "thread-history").disposition, "completed");
});

test("fresh App task readback reopens a stale completed index and preserves the real thread id", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-current-task-authority-"));
  const sessionRoot = path.join(root, "sessions");
  fs.mkdirSync(sessionRoot, { recursive: true });
  const threadId = "01a03e41-2ba0-76d3-8e5f-6f5ac3b0a0b4";
  fs.writeFileSync(path.join(sessionRoot, "note.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { thread_source: "user", session_id: threadId, cwd: root, timestamp: "2026-09-01T00:00:00.000Z" } }),
    JSON.stringify({ type: "event_msg", message: "result: completed; status: blocked; remaining blocker: companion_page_selectText_not_exposed_in_authorized_transaction_schema" }),
  ].join("\n") + "\n");

  const summary = buildAuditSummary({
    now: "2026-09-02T01:00:00.000Z",
    recentDays: 0,
    sessionRoot,
    artifactDir: path.join(root, "artifact"),
    companionSource: "/Users/nichikatanaka/Documents/Codex/aos-chrome-bridge",
    companionInstall: "/Users/nichikatanaka/Library/Application Support/AOS Chrome Companion/app",
    liveStatus: { connected: true, generation: "gen-current", capabilities: ["page.selectText"] },
    recentTasks: [{
      threadId: `t-${threadId.replaceAll("-", "").slice(0, 24)}`,
      owner: "user",
      status: "notLoaded",
      latestTurnStatus: "interrupted",
      changed: false,
    }],
  });

  const task = summary.sessions.find((item) => item.threadId === threadId);
  assert.ok(task);
  assert.equal(task.currentTaskReadback, true);
  assert.equal(task.completed, false);
  assert.equal(task.resumeEligibleAfterProof, true);
  assert.equal(summary.liveCandidates.some((item) => item.threadId === threadId), true);
  assert.equal(summary.repairCandidates.some((item) => item.threadId === threadId), true);
  assert.equal(summary.repairPlans.find((item) => item.threadId === threadId)?.disposition, "capability_reflected_resume");
  assert.equal(summary.repairCandidates.find((item) => item.threadId === threadId)?.currentCapabilityAvailable, true);
});

test("exposes fresh ready tasks as official-App-only continuation candidates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-official-app-only-candidate-"));
  const sessionRoot = path.join(root, "sessions");
  fs.mkdirSync(sessionRoot, { recursive: true });
  const threadId = "01aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  fs.writeFileSync(path.join(sessionRoot, "ready.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { thread_source: "user", session_id: threadId, cwd: root, timestamp: "2026-09-02T00:00:00.000Z" } }),
    JSON.stringify({ type: "event_msg", message: "continue the existing Goal from the next planned step" }),
  ].join("\n") + "\n");

  const summary = buildAuditSummary({
    now: "2026-09-03T00:00:00.000Z",
    recentDays: 0,
    sessionRoot,
    artifactDir: path.join(root, "artifact"),
    companionSource: path.join(root, "missing-source"),
    companionInstall: path.join(root, "missing-install"),
    liveStatus: { connected: true, generation: "gen-current" },
    recentTasks: [{
      threadId: `t-${threadId.replaceAll("-", "").slice(0, 24)}`,
      owner: "user",
      status: "idle",
      latestTurnStatus: "completed",
    }],
  });

  assert.equal(summary.officialAppOnlyContinuationCandidateCount, 1);
  assert.deepEqual(summary.officialAppOnlyContinuationCandidates.map((item) => item.threadId), [threadId]);
  assert.equal(summary.officialAppOnlyContinuationCandidates[0].threadAlias, createThreadAlias(threadId));
  assert.equal(summary.officialAppOnlyContinuationCandidates[0].currentTaskReadback, true);
  const receipt = buildAuditExecutionReceipt({
    runId: "official-app-only-receipt",
    schedulerDecision: "inspect_and_repair",
    summary,
  });
  assert.equal(receipt.rootActionRequired, true);
  assert.equal(receipt.rootAction.officialAppOnlyContinuationCandidateCount, 1);
});

test("keeps an active task eligible at a completed-turn message boundary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-official-active-boundary-"));
  const sessionRoot = path.join(root, "sessions");
  fs.mkdirSync(sessionRoot, { recursive: true });
  const threadId = "01ababababababababababababababab";
  fs.writeFileSync(path.join(sessionRoot, "active-boundary.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { thread_source: "user", session_id: threadId, cwd: root, timestamp: "2026-09-02T00:00:00.000Z" } }),
    JSON.stringify({ type: "event_msg", message: "continue the existing Goal at the next message boundary" }),
  ].join("\n") + "\n");

  const summary = buildAuditSummary({
    now: "2026-09-03T00:00:00.000Z",
    recentDays: 0,
    sessionRoot,
    artifactDir: path.join(root, "artifact"),
    companionSource: path.join(root, "missing-source"),
    companionInstall: path.join(root, "missing-install"),
    liveStatus: { connected: true, generation: "gen-current" },
    recentTasks: [{
      threadId: `t-${threadId.replaceAll("-", "").slice(0, 24)}`,
      owner: "user",
      status: "active",
      latestTurnStatus: "completed",
    }],
  });

  assert.deepEqual(summary.officialAppOnlyContinuationCandidates.map((item) => item.threadId), [threadId]);
});

test("exposes an inactive Companion task as a task-owned relay candidate", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-task-owned-relay-candidate-"));
  const sessionRoot = path.join(root, "sessions");
  fs.mkdirSync(sessionRoot, { recursive: true });
  const threadId = "01bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  fs.writeFileSync(path.join(sessionRoot, "companion-timeout.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { thread_source: "user", session_id: threadId, cwd: root, timestamp: "2026-09-02T00:00:00.000Z" } }),
    JSON.stringify({ type: "event_msg", message: "Companion timeout occurred; continue the existing Goal after a fresh owner readback" }),
  ].join("\n") + "\n");

  const summary = buildAuditSummary({
    now: "2026-09-03T00:00:00.000Z",
    recentDays: 0,
    sessionRoot,
    artifactDir: path.join(root, "artifact"),
    companionSource: path.join(root, "missing-source"),
    companionInstall: path.join(root, "missing-install"),
    liveStatus: { connected: true, generation: "gen-current" },
    recentTasks: [{
      threadId: `t-${threadId.replaceAll("-", "").slice(0, 24)}`,
      hostId: "local",
      owner: "user",
      status: "notLoaded",
      latestTurnStatus: "unknown",
      goalStatus: "active",
      planStatus: "active",
    }],
  });

  assert.equal(summary.officialAppOnlyContinuationCandidateCount, 0);
  assert.equal(summary.taskOwnedContinuationCandidateCount, 1);
  assert.deepEqual(summary.taskOwnedContinuationCandidates.map((item) => item.threadId), [threadId]);
  assert.equal(summary.taskOwnedContinuationCandidates[0].threadAlias, createThreadAlias(threadId));
  assert.equal(summary.taskOwnedContinuationCandidates[0].hostId, "local");
  assert.equal(summary.taskOwnedContinuationCandidates[0].requiresTaskOwnedCompanionCallback, true);
  const receipt = buildAuditExecutionReceipt({
    runId: "task-owned-relay-receipt",
    schedulerDecision: "inspect_and_repair",
    summary,
  });
  assert.equal(receipt.rootActionRequired, true);
  assert.equal(receipt.rootAction.taskOwnedContinuationCandidateCount, 1);
});

test("keeps the real task ID, opaque alias, and host on repair candidates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-repair-candidate-identities-"));
  const sessionRoot = path.join(root, "sessions");
  fs.mkdirSync(sessionRoot, { recursive: true });
  const threadId = "01cccccccccccccccccccccccccccccc";
  fs.writeFileSync(path.join(sessionRoot, "candidate.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { thread_source: "user", session_id: threadId, cwd: root, timestamp: "2026-09-02T00:00:00.000Z" } }),
    JSON.stringify({ type: "event_msg", message: "Companion timeout occurred; continue the existing Goal after a fresh owner readback" }),
  ].join("\n") + "\n");

  const summary = buildAuditSummary({
    now: "2026-09-03T00:00:00.000Z",
    recentDays: 0,
    sessionRoot,
    artifactDir: path.join(root, "artifact"),
    companionSource: path.join(root, "missing-source"),
    companionInstall: path.join(root, "missing-install"),
    liveStatus: { connected: true, generation: "gen-current" },
    recentTasks: [{
      threadId: `t-${threadId.replaceAll("-", "").slice(0, 24)}`,
      hostId: "local",
      owner: "user",
      status: "notLoaded",
      latestTurnStatus: "unknown",
      goalStatus: "active",
      planStatus: "active",
    }],
  });

  const candidate = summary.repairCandidates.find((item) => item.threadId === threadId);
  assert.ok(candidate);
  assert.equal(candidate.threadAlias, createThreadAlias(threadId));
  assert.equal(candidate.hostId, "local");
  assert.equal(summary.taskOwnedContinuationCandidateCount, 1);
  assert.equal(summary.taskOwnedContinuationCandidates[0].relayRequiresFreshOfficialReadback, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("does not expose active or unknown-effect Companion tasks as task-owned relays", () => {
  const makeSummary = (suffix, recentTask) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `aos-task-owned-relay-${suffix}-`));
    const sessionRoot = path.join(root, "sessions");
    fs.mkdirSync(sessionRoot, { recursive: true });
    const threadId = `01${suffix.repeat(32).slice(0, 32)}`;
    fs.writeFileSync(path.join(sessionRoot, `${suffix}.jsonl`), [
      JSON.stringify({ type: "session_meta", payload: { thread_source: "user", session_id: threadId, cwd: root, timestamp: "2026-09-02T00:00:00.000Z" } }),
      JSON.stringify({ type: "event_msg", message: recentTask.signal }),
    ].join("\n") + "\n");
    return buildAuditSummary({
      now: "2026-09-03T00:00:00.000Z",
      recentDays: 0,
      sessionRoot,
      artifactDir: path.join(root, "artifact"),
      companionSource: path.join(root, "missing-source"),
      companionInstall: path.join(root, "missing-install"),
      liveStatus: { connected: true, generation: "gen-current" },
      recentTasks: [{
        threadId: `t-${threadId.replaceAll("-", "").slice(0, 24)}`,
        hostId: "local",
        owner: "user",
        status: recentTask.status,
        latestTurnStatus: recentTask.latestTurnStatus,
        goalStatus: "active",
        planStatus: "active",
      }],
    });
  };

  const active = makeSummary("c", {
    signal: "Companion timeout occurred while the task is still running",
    status: "active",
    latestTurnStatus: "inProgress",
  });
  assert.equal(active.taskOwnedContinuationCandidateCount, 0);

  const unknownEffect = makeSummary("d", {
    signal: "Companion timeout; operation_effect_unknown; do not replay",
    status: "idle",
    latestTurnStatus: "completed",
  });
  assert.equal(unknownEffect.taskOwnedContinuationCandidateCount, 0);
});

test("exposes an inactive capability-missing task for destination-owned repair", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-capability-relay-candidate-"));
  const sessionRoot = path.join(root, "sessions");
  fs.mkdirSync(sessionRoot, { recursive: true });
  const threadId = "01eeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  fs.writeFileSync(path.join(sessionRoot, "capability.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { thread_source: "user", session_id: threadId, cwd: root, timestamp: "2026-09-02T00:00:00.000Z" } }),
    JSON.stringify({ type: "event_msg", message: "Companion page.selectText capability_missing; status: failed; destination task must repair its own adapter" }),
  ].join("\n") + "\n");

  const summary = buildAuditSummary({
    now: "2026-09-03T00:00:00.000Z",
    recentDays: 0,
    sessionRoot,
    artifactDir: path.join(root, "artifact"),
    companionSource: path.join(root, "missing-source"),
    companionInstall: path.join(root, "missing-install"),
    liveStatus: { connected: true, generation: "gen-current" },
    recentTasks: [{
      threadId: `t-${threadId.replaceAll("-", "").slice(0, 24)}`,
      hostId: "local",
      owner: "user",
      status: "idle",
      latestTurnStatus: "completed",
      goalStatus: "active",
      planStatus: "active",
    }],
  });

  assert.equal(summary.taskOwnedContinuationCandidateCount, 1);
  assert.equal(summary.taskOwnedContinuationCandidates[0].threadId, threadId);
  assert.equal(summary.taskOwnedContinuationCandidates[0].requiresTaskOwnedCompanionCallback, true);
});

test("selects notLoaded official tasks for a bounded deep read", () => {
  const plan = buildThreadInspectionPlan({
    source: "codex_app_thread_list",
    tasks: [{
      threadId: "01ffffffffffffffffffffffffffffff",
      owner: "user",
      status: "notLoaded",
      latestTurnStatus: "unknown",
    }],
  });

  assert.equal(plan.deepReadCandidateCount, 1);
  assert.ok(plan.deepReadCandidates[0].reasons.includes("not_loaded"));
});

test("keeps a notLoaded signal after lightweight readback so the deep read runs", async () => {
  const light = [];
  const deep = [];
  const result = await inspectRecentUserThreads({
    tasks: [{ threadId: "notloaded-after-light", owner: "user", status: "notLoaded", latestTurnStatus: "unknown" }],
    inspectThread: async (input) => {
      light.push(input);
      return { status: "notLoaded", latestTurnStatus: "unknown" };
    },
    readThread: async (input) => {
      deep.push(input);
      return { status: "notLoaded", latestTurnStatus: "interrupted", goalStatus: "active", planStatus: "active" };
    },
    now: Date.parse("2026-09-05T00:00:00.000Z"),
  });

  assert.deepEqual(light.map((input) => input.threadId), ["notloaded-after-light"]);
  assert.deepEqual(deep.map((input) => input.threadId), ["notloaded-after-light"]);
  assert.equal(result.deepReadCandidateCount, 1);
  assert.equal(result.deepReadAttemptedCount, 1);
  assert.equal(result.deepReadCount, 1);
  assert.equal(result.records[0].deepRead.status, "observed");
  assert.equal(result.records[0].latestTurnStatus, "interrupted");
});

test("relays an officially proven interrupted capability checkpoint to its own task Root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-interrupted-capability-relay-"));
  const sessionRoot = path.join(root, "sessions");
  fs.mkdirSync(sessionRoot, { recursive: true });
  const threadId = "01f11111111111111111111111111111";
  fs.writeFileSync(path.join(sessionRoot, "capability-interrupted.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { thread_source: "user", session_id: threadId, cwd: root, timestamp: "2026-09-01T00:00:00.000Z" } }),
    JSON.stringify({ type: "event_msg", message: "<turn_aborted> Companion capability_missing; resume the existing Goal after current-generation verification" }),
  ].join("\n") + "\n");

  const summary = buildAuditSummary({
    now: "2026-09-03T00:00:00.000Z",
    recentDays: 0,
    sessionRoot,
    artifactDir: path.join(root, "artifact"),
    companionSource: path.join(root, "missing-source"),
    companionInstall: path.join(root, "missing-install"),
    liveStatus: { connected: true, generation: "gen-current", capabilities: [] },
    recentTasks: [{
      threadId: `t-${threadId.replaceAll("-", "").slice(0, 24)}`,
      hostId: "local",
      owner: "user",
      status: "notLoaded",
      latestTurnStatus: "interrupted",
      goalStatus: "unknown",
      planStatus: "unknown",
    }],
    threadInspection: {
      schema: "aos.companion_thread_inspection.v1",
      source: "codex_app_thread_list",
      mode: "lightweight_all_then_deep_read_candidates",
      listedCount: 1,
      eligibleTaskCount: 1,
      skippedNonUserOwnedCount: 0,
      lightweightInspectionCount: 1,
      lightweightReadCount: 1,
      deepReadCandidateCount: 1,
      deepReadAttemptedCount: 1,
      deepReadCount: 1,
      deepReadTruncated: false,
      records: [{
        threadId: `t-${threadId.replaceAll("-", "").slice(0, 24)}`,
        hostId: "local",
        owner: "user",
        status: "notloaded",
        latestTurnStatus: "interrupted",
        goalStatus: "unknown",
        planStatus: "unknown",
        exactBlocker: null,
        actionable: false,
        stalled: false,
        lightweight: { status: "observed" },
        deepRead: { status: "observed" },
      }],
    },
  });

  assert.equal(summary.taskOwnedContinuationCandidateCount, 1);
  assert.equal(summary.taskOwnedContinuationCandidates[0].threadId, threadId);
  assert.equal(summary.taskOwnedContinuationCandidates[0].relayReason, "capability_missing");
  assert.equal(summary.taskOwnedContinuationCandidates[0].requiresTaskOwnedCompanionCallback, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("promotes a fresh user-owned interrupted ready task into the resume queue", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-interrupted-ready-task-"));
  const sessionRoot = path.join(root, "sessions");
  const threadId = "01a03e41-2ba0-76d3-8e5f-6f5ac3b0a0b4";
  fs.mkdirSync(sessionRoot, { recursive: true });
  fs.writeFileSync(path.join(sessionRoot, "note.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { thread_source: "user", session_id: threadId, cwd: root, timestamp: "2026-09-01T00:00:00.000Z" } }),
    JSON.stringify({ type: "event_msg", message: "<turn_aborted> the previous turn stopped before the existing Goal was complete" }),
  ].join("\n") + "\n");

  const summary = buildAuditSummary({
    now: "2026-09-03T00:00:00.000Z",
    recentDays: 0,
    sessionRoot,
    artifactDir: path.join(root, "artifact"),
    companionSource: "/Users/nichikatanaka/Documents/Codex/aos-chrome-bridge",
    companionInstall: "/Users/nichikatanaka/Library/Application Support/AOS Chrome Companion/app",
    liveStatus: { connected: true, generation: "gen-current", capabilities: [] },
    recentTasks: [{
      threadId: `t-${threadId.replaceAll("-", "").slice(0, 24)}`,
      owner: "user",
      status: "idle",
      latestTurnStatus: "interrupted",
      goalStatus: "active",
      planStatus: "active",
      changed: false,
    }],
  });

  const task = summary.sessions.find((item) => item.threadId === threadId);
  assert.ok(task);
  assert.equal(task.interrupted, true);
  assert.equal(task.resumeEligibleAfterProof, true);
  assert.equal(task.stateScope, "live_candidate");
  assert.equal(summary.liveCandidates.some((item) => item.threadId === threadId), true);
  assert.equal(summary.repairCandidates.some((item) => item.threadId === threadId), true);
  assert.equal(summary.officialAppOnlyContinuationCandidateCount, 1);
  assert.deepEqual(summary.officialAppOnlyContinuationCandidates.map((item) => item.threadId), [threadId]);
});

test("does not send an official continuation into an active in-progress task", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-official-active-task-"));
  const sessionRoot = path.join(root, "sessions");
  fs.mkdirSync(sessionRoot, { recursive: true });
  const threadId = "01cccccccccccccccccccccccccccccc";
  fs.writeFileSync(path.join(sessionRoot, "active.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { thread_source: "user", session_id: threadId, cwd: root, timestamp: "2026-09-02T00:00:00.000Z" } }),
    JSON.stringify({ type: "event_msg", message: "continue the existing Goal" }),
  ].join("\n") + "\n");

  const summary = buildAuditSummary({
    now: "2026-09-03T00:00:00.000Z",
    recentDays: 0,
    sessionRoot,
    artifactDir: path.join(root, "artifact"),
    companionSource: path.join(root, "missing-source"),
    companionInstall: path.join(root, "missing-install"),
    liveStatus: { connected: true, generation: "gen-current" },
    recentTasks: [{
      threadId: `t-${threadId.replaceAll("-", "").slice(0, 24)}`,
      owner: "user",
      status: "active",
      latestTurnStatus: "inProgress",
      goalStatus: "unknown",
      planStatus: "unknown",
    }],
  });

  assert.equal(summary.officialAppOnlyContinuationCandidateCount, 0);
});

test("does not reopen a genuinely completed session just because App inventory still lists it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-current-complete-task-"));
  const sessionRoot = path.join(root, "sessions");
  fs.mkdirSync(sessionRoot, { recursive: true });
  const threadId = "01a03e41-2ba0-76d3-8e5f-6f5ac3b0a0b4";
  fs.writeFileSync(path.join(sessionRoot, "complete.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { thread_source: "user", session_id: threadId, cwd: root, timestamp: "2026-09-01T00:00:00.000Z" } }),
    JSON.stringify({ type: "event_msg", message: "result: completed; status: completed" }),
  ].join("\n") + "\n");

  const summary = buildAuditSummary({
    now: "2026-09-02T01:00:00.000Z",
    recentDays: 0,
    sessionRoot,
    artifactDir: path.join(root, "artifact"),
    companionSource: path.join(root, "missing-source"),
    companionInstall: path.join(root, "missing-install"),
    recentTasks: [{
      threadId: `t-${threadId.replaceAll("-", "").slice(0, 24)}`,
      owner: "user",
      status: "notLoaded",
      latestTurnStatus: "completed",
      goalStatus: "complete",
      planStatus: "complete",
      changed: false,
    }],
  });

  const task = summary.sessions.find((item) => item.threadId === threadId);
  assert.ok(task);
  assert.equal(task.currentTaskReadback, true);
  assert.equal(task.completed, true);
  assert.equal(task.stateScope, "history");
  assert.equal(summary.liveCandidates.some((item) => item.threadId === threadId), false);
  assert.equal(summary.repairCandidates.some((item) => item.threadId === threadId), false);
});

test("excludes the scheduler's own thread from live counts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-companion-self-audit-"));
  const sessionRoot = path.join(root, "sessions");
  fs.mkdirSync(sessionRoot, { recursive: true });
  const writeSession = (name, id, message) => {
    fs.writeFileSync(path.join(sessionRoot, name), [
      JSON.stringify({ type: "session_meta", payload: { thread_source: "user", session_id: id, cwd: root, timestamp: "2026-08-27T00:00:00.000Z" } }),
      JSON.stringify({ type: "event_msg", message }),
    ].join("\n") + "\n");
  };
  writeSession("self.jsonl", "thread-self", "Companion timeout; status: blocked");
  writeSession("user.jsonl", "thread-user", "Companion timeout; status: blocked");
  const previous = process.env.CODEX_THREAD_ID;
  process.env.CODEX_THREAD_ID = "thread-self";
  try {
    const summary = buildAuditSummary({
      now: "2026-08-27T00:00:00.000Z",
      sessionRoot,
      companionSource: path.join(root, "missing-source"),
      companionInstall: path.join(root, "missing-install"),
      artifactDir: path.join(root, "artifact"),
      recentDays: 0,
    });
    assert.equal(summary.excludedCurrentThreadId, "thread-self");
    assert.deepEqual(summary.sessions.map((item) => item.threadId), ["thread-user"]);
    assert.equal(summary.companionIssueCount, 1);
  } finally {
    if (previous === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = previous;
  }
});

test("excludes registered automation transcripts from user-task audit candidates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-companion-automation-scope-"));
  const sessionRoot = path.join(root, "sessions");
  fs.mkdirSync(sessionRoot, { recursive: true });
  const writeSession = (name, id, threadSource, message) => {
    fs.writeFileSync(path.join(sessionRoot, name), [
      JSON.stringify({ type: "session_meta", payload: { thread_source: threadSource, source: "vscode", session_id: id, cwd: root, timestamp: "2026-08-30T00:00:00.000Z" } }),
      JSON.stringify({ type: "event_msg", message }),
    ].join("\n") + "\n");
  };
  writeSession("automation.jsonl", "automation-controller", "automation", "Automation: AOS毎時Companion監査 timeout reconciliation_required status: blocked");
  writeSession("user.jsonl", "user-task", "user", "Companion timeout before dispatch; status: blocked");

  const summary = buildAuditSummary({
    now: "2026-08-30T00:00:00.000Z",
    sessionRoot,
    companionSource: path.join(root, "missing-source"),
    companionInstall: path.join(root, "missing-install"),
    artifactDir: path.join(root, "artifact"),
    recentDays: 0,
  });
  assert.deepEqual(summary.sessions.map((item) => item.threadId), ["user-task"]);
  assert.equal(summary.recentUserSessionCount, 1);
  assert.equal(summary.companionIssueCount, 1);
});

test("completed history does not change the live repair fingerprint", () => {
  const live = { threadId: "thread-live", stateScope: "live_candidate", companionMarkers: ["timeout"], userHelpMarkers: [], blocked: true, completed: false };
  const history = { threadId: "thread-history", stateScope: "history", companionMarkers: ["timeout"], userHelpMarkers: [], blocked: true, completed: true };
  const base = {
    source: { package: { sha256: "source" } },
    installed: { package: { sha256: "installed" } },
    companionArtifacts: { match: false },
    liveCandidateSessionCount: 1,
    recentUserSessionCount: 1,
    companionIssueCount: 1,
    userHelpRequiredCount: 0,
    blockedCount: 1,
    sessions: [live],
  };
  const withHistory = { ...base, recentUserSessionCount: 2, historicalSessionCount: 1, sessions: [live, history] };
  assert.equal(buildAuditFingerprint(base), buildAuditFingerprint(withHistory));
});

test("maps known failures to bounded playbooks and preserves human gates", () => {
  const timeout = classifyThreadTail("stale_generation after timeout");
  const timeoutPlan = buildRepairPlan(timeout);
  assert.equal(timeoutPlan.playbookId, "stale_connection_generation");
  assert.equal(timeoutPlan.automatic, true);
  assert.match(timeoutPlan.nextAction, /fresh Companion status/u);

  const unknown = classifyThreadTail("operation_effect_unknown after timeout");
  const unknownPlan = buildRepairPlan(unknown);
  assert.equal(unknownPlan.playbookId, "signed_reconciliation");
  assert.match(unknownPlan.nextAction, /never replay/u);

  const userHelp = classifyThreadTail("visible hCaptcha widget requires user action");
  const userHelpPlan = buildRepairPlan(userHelp);
  assert.equal(userHelpPlan.disposition, "user_help_required");
  assert.equal(userHelpPlan.automatic, false);
});

test("creates a task-level progress plan for ownership, target, capability, and effect blockers", () => {
  assert.equal(classifyOperationalBlocker({ exactBlocker: "session_not_owned" }), "foreign_owner");
  assert.equal(classifyOperationalBlocker({ exactBlocker: "transaction_action_target_page_mismatch" }), "target_mismatch");
  assert.equal(classifyOperationalBlocker({ exactBlocker: "chrome_profile2_preflight_backend_mismatch" }), "capability_missing");
  assert.equal(classifyOperationalBlocker({ exactBlocker: "operation_effect_unknown" }), "unknown_effect");
  assert.equal(classifyOperationalBlocker({ exactBlocker: "sent_unverified" }), "send_result_unknown");
  assert.equal(classifyOperationalBlocker({ exactBlocker: "lightchain_permission_denied" }), "external_service_limit");

  const foreign = buildBlockerProgressPlan({ threadId: "foreign-task", exactBlocker: "session_not_owned" });
  assert.equal(foreign.schema, "aos.companion_blocker_progress.v1");
  assert.equal(foreign.automaticActionAllowed, false);
  assert.equal(foreign.replayAllowed, false);
  assert.match(foreign.progressAttemptNow, /do not adopt/u);

  const capability = buildRepairPlan({ blocked: true, exactBlocker: "capability_not_supported" });
  assert.equal(capability.disposition, "blocked");
  assert.equal(capability.blockerProgress.reason, "capability_missing");
  assert.match(capability.nextAction, /adapter/u);

  const providerGate = buildRepairPlan({ blocked: true, exactBlocker: "exceed_egress_quota" });
  assert.equal(providerGate.disposition, "blocked");
  assert.equal(providerGate.blockerProgress.reason, "external_service_limit");
  assert.equal(providerGate.blockerProgress.replayAllowed, false);
});

test("reclassifies a historical capability blocker when the current generation already advertises it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-capability-reflected-"));
  const source = path.join(root, "source");
  const installed = path.join(root, "installed");
  for (const tree of [source, installed]) {
    fs.mkdirSync(path.join(tree, "extension"), { recursive: true });
    fs.writeFileSync(path.join(tree, "package.json"), JSON.stringify({ version: "0.3.2" }));
    fs.writeFileSync(path.join(tree, "extension", "operation-schema.generated.json"), JSON.stringify({
      capabilities: ["page.selectText"],
      authorizedTransactionMethods: ["page.selectText"],
    }));
    fs.writeFileSync(path.join(tree, "extension", "service-worker.js"), "same");
    fs.writeFileSync(path.join(tree, "extension", "operation-schema.generated.js"), "same");
    fs.mkdirSync(path.join(tree, "src", "broker"), { recursive: true });
    fs.mkdirSync(path.join(tree, "src", "mcp"), { recursive: true });
    fs.mkdirSync(path.join(tree, "plugins", "aos-chrome-companion", "skills", "aos-chrome-companion"), { recursive: true });
    fs.writeFileSync(path.join(tree, "src", "broker", "broker.mjs"), "same");
    fs.writeFileSync(path.join(tree, "src", "mcp", "server.mjs"), "same");
    fs.writeFileSync(path.join(tree, "plugins", "aos-chrome-companion", "skills", "aos-chrome-companion", "SKILL.md"), "same");
  }
  const summary = buildAuditSummary({
    now: "2026-09-02T00:00:00.000Z",
    sessionRoot: path.join(root, "sessions"),
    companionSource: source,
    companionInstall: installed,
    artifactDir: path.join(root, "artifact"),
    liveStatus: {
      available: true,
      status: {
        profiles: [{ connected: true, generation: "gen-current", capabilities: ["page.selectText"] }],
        logicalSessions: [],
        exactTabLeases: [],
        pendingOperations: [],
        reconciliationGate: { activeCount: 0 },
      },
    },
    threadInspection: {
      listedCount: 1,
      eligibleTaskCount: 1,
      lightweightInspectionCount: 1,
      lightweightReadCount: 1,
      records: [{
        threadId: "note-task",
        owner: "user",
        status: "idle",
        goalStatus: "blocked",
        planStatus: "blocked",
        exactBlocker: "companion_page_selectText_not_exposed_in_authorized_transaction_schema",
        lightweight: { status: "observed" },
        deepRead: { status: "observed" },
      }],
    },
  });
  const candidate = summary.repairCandidates.find((item) => item.threadId === "note-task");
  assert.equal(candidate.repairPlan.disposition, "capability_reflected_resume");
  assert.equal(candidate.repairPlan.automatic, false);
  assert.equal(candidate.repairPlan.blockerProgress.runtimeCapabilityVerified, true);
  assert.equal(candidate.currentCapabilityAvailable, true);
});

test("normalizes hourly session observations to one resume reason", () => {
  assert.equal(buildResumeAssessment({ userHelpRequired: true, companionMarkers: ["timeout"], latestSummary: "" }).reason, "human_auth_required");
  assert.equal(buildResumeAssessment({ userHelpRequired: false, companionMarkers: ["operation_effect_unknown", "session_not_owned"], latestSummary: "" }).reason, "unknown_effect");
  assert.equal(buildResumeAssessment({ userHelpRequired: false, companionMarkers: ["session_not_owned"], latestSummary: "" }).reason, "foreign_owner");
  assert.equal(buildResumeAssessment({ userHelpRequired: false, companionMarkers: [], latestSummary: "source_session_handoff_gate_active" }).reason, "handoff_gate_active");
  assert.equal(buildResumeAssessment({ userHelpRequired: false, companionMarkers: [], latestSummary: "" }).reason, "ready");
});

test("records a bounded learning ledger without claiming business completion", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-companion-ledger-"));
  const sessionRoot = path.join(root, "sessions");
  const ledgerPath = path.join(root, "learning-ledger.v1.json");
  const artifactDir = path.join(root, "artifact");
  fs.mkdirSync(sessionRoot, { recursive: true });
  const sessionFile = path.join(sessionRoot, "thread.jsonl");
  fs.writeFileSync(sessionFile, [
    JSON.stringify({ type: "session_meta", payload: { thread_source: "user", session_id: "thread-ledger", cwd: root, timestamp: "2026-08-27T00:00:00.000Z" } }),
    JSON.stringify({ type: "event_msg", message: "Companion timeout stale_generation" }),
  ].join("\n") + "\n");

  const result = runHourlyAudit({
    now: "2026-08-27T00:00:00.000Z",
    sessionRoot,
    companionSource: path.join(root, "missing-source"),
    companionInstall: path.join(root, "missing-install"),
    artifactDir,
    learningLedgerPath: ledgerPath,
    recentDays: 0,
  });
  assert.equal(result.externalActionExecuted, false);
  assert.equal(result.controller.mutationPerformed, false);
  assert.equal(result.learning.observationCount > 0, true);
  assert.equal(result.changeDetection.changedSincePreviousRun, true);
  assert.equal(result.controller.schedulerDecision, "inspect_and_repair");
  assert.equal(fs.existsSync(ledgerPath), true);
  const firstLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(firstLedger.schema, "aos.companion_learning_ledger.v1");
  const firstTimeoutCount = firstLedger.observations["marker:timeout"].count;
  const second = runHourlyAudit({
    now: "2026-08-27T01:00:00.000Z",
    sessionRoot,
    companionSource: path.join(root, "missing-source"),
    companionInstall: path.join(root, "missing-install"),
    artifactDir,
    learningLedgerPath: ledgerPath,
    recentDays: 0,
  });
  const secondLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(second.learning.recentRunCount, 2);
  assert.equal(secondLedger.observations["marker:timeout"].count, firstTimeoutCount);
  assert.equal(second.changeDetection.changedSincePreviousRun, false);
  assert.equal(second.changeDetection.noChangeRunCount, 1);
  assert.equal(second.changeDetection.heartbeatOnly, false);
  assert.equal(second.changeDetection.deepReadCandidateCount, 1);
  assert.equal(second.controller.schedulerDecision, "inspect_and_repair");
  assert.equal(fs.existsSync(path.join(artifactDir, "aos-hourly-companion-audit.verifier.v1.json")), true);
  const projection = JSON.parse(fs.readFileSync(path.join(artifactDir, "aos-hourly-companion-audit.verifier.v1.json"), "utf8"));
  assert.equal(projection.schema, "aos.hourly_companion_audit.verifier.v1");
  assert.equal(projection.candidates[0].resumeAssessment.reason, "stale_owner_recoverable");
  assert.ok(Buffer.byteLength(JSON.stringify(projection), "utf8") <= 32_000);
});

test("promotes only three independent novel signals to a human-reviewed playbook proposal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-companion-learning-promotion-"));
  const sessionRoot = path.join(root, "sessions");
  const ledgerPath = path.join(root, "learning-ledger.v1.json");
  const artifactDir = path.join(root, "artifact");
  fs.mkdirSync(sessionRoot, { recursive: true });
  const sessionFile = path.join(sessionRoot, "thread.jsonl");
  const writeObservation = (index) => {
    const observedAt = new Date(Date.parse("2026-08-27T00:00:00.000Z") + index * 60 * 60_000);
    fs.writeFileSync(sessionFile, [
      JSON.stringify({ type: "session_meta", payload: { thread_source: "user", session_id: "thread-novel", cwd: root, timestamp: observedAt.toISOString() } }),
      JSON.stringify({ type: "event_msg", message: `Companion custom adapter error occurrence-${index}` }),
    ].join("\n") + "\n");
    fs.utimesSync(sessionFile, observedAt, observedAt);
    return runHourlyAudit({
      now: observedAt.toISOString(),
      sessionRoot,
      companionSource: path.join(root, "missing-source"),
      companionInstall: path.join(root, "missing-install"),
      artifactDir,
      learningLedgerPath: ledgerPath,
      recentDays: 0,
    });
  };

  const first = writeObservation(0);
  assert.equal(first.learning.proposedPlaybookCount, 0);
  const second = writeObservation(1);
  assert.equal(second.learning.proposedPlaybookCount, 0);
  const third = writeObservation(2);
  assert.equal(third.learning.proposedPlaybookCount, 1);
  const proposal = third.learning.proposedPlaybooks[0];
  assert.equal(proposal.independentReproductionCount, 3);
  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.activationStatus, "human_approval_required");
  assert.equal(proposal.automatic, false);
  assert.equal(proposal.successRate.value, null);
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.equal(ledger.protocol.automaticActivation, false);
  assert.equal(ledger.learningOutcomes.length, 3);
  assert.equal(ledger.learningOutcomes.every((outcome) => outcome.verification.status === "not_run"), true);
});

test("records a verified controller outcome without activating a new playbook", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-companion-learning-outcome-"));
  const sessionRoot = path.join(root, "sessions");
  const ledgerPath = path.join(root, "learning-ledger.v1.json");
  const artifactDir = path.join(root, "artifact");
  fs.mkdirSync(sessionRoot, { recursive: true });
  const sessionFile = path.join(sessionRoot, "thread.jsonl");
  fs.writeFileSync(sessionFile, [
    JSON.stringify({ type: "session_meta", payload: { thread_source: "user", session_id: "thread-verified", cwd: root, timestamp: "2026-08-27T00:00:00.000Z" } }),
    JSON.stringify({ type: "event_msg", message: "Companion timeout" }),
  ].join("\n") + "\n");
  const summary = runHourlyAudit({
    now: "2026-08-27T00:00:00.000Z",
    sessionRoot,
    companionSource: path.join(root, "missing-source"),
    companionInstall: path.join(root, "missing-install"),
    artifactDir,
    learningLedgerPath: ledgerPath,
    recentDays: 0,
  });
  const controller = await runSameRunCompanionRepairLoop({
    summary,
    freshStatus: { connected: true, activeLeaseCount: 0, pendingCount: 0, queueCount: 0, generation: "gen-before" },
    repair: async () => ({ status: "passed", external_action_executed: false }),
    verify: async () => ({ status: "passed", external_action_executed: false, freshStatus: { connected: true, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 } }),
    refresh: async () => ({ status: "reflected", reflected: true, generation: "gen-after", external_action_executed: false }),
    e2e: async () => ({ status: "verified", sameRunE2E: true, external_action_executed: false }),
    learningLedgerPath: ledgerPath,
  });
  assert.equal(controller.learning.verifiedOutcomeCount, 1);
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  const outcome = ledger.learningOutcomes.find((entry) => entry.evidence.sourceThreadId === "thread-verified");
  assert.equal(outcome.verification.status, "passed");
  assert.equal(outcome.verification.sameRunE2E, true);
  assert.equal(outcome.successRate.value, null);
  assert.equal(ledger.playbookProposals.length, 0);
});

test("runs lightweight inspection and bounded deep health inspection on an unchanged active thread", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-companion-lightweight-heartbeat-"));
  const sessionRoot = path.join(root, "sessions");
  const ledgerPath = path.join(root, "learning-ledger.v1.json");
  const artifactDir = path.join(root, "artifact");
  fs.mkdirSync(sessionRoot, { recursive: true });
  fs.writeFileSync(path.join(sessionRoot, "thread.jsonl"), [
    JSON.stringify({ type: "session_meta", payload: { thread_source: "user", session_id: "thread-healthy", cwd: root, timestamp: "2026-08-27T00:00:00.000Z" } }),
    JSON.stringify({ type: "event_msg", message: "status: ready" }),
  ].join("\n") + "\n");

  runHourlyAudit({
    now: "2026-08-27T00:00:00.000Z",
    sessionRoot,
    companionSource: path.join(root, "missing-source"),
    companionInstall: path.join(root, "missing-install"),
    artifactDir,
    learningLedgerPath: ledgerPath,
    recentDays: 0,
  });
  const second = runHourlyAudit({
    now: "2026-08-27T01:00:00.000Z",
    sessionRoot,
    companionSource: path.join(root, "missing-source"),
    companionInstall: path.join(root, "missing-install"),
    artifactDir,
    learningLedgerPath: ledgerPath,
    recentDays: 0,
  });
  assert.equal(second.changeDetection.heartbeatOnly, false);
  assert.equal(second.threadInspection.eligibleTaskCount, 1);
  assert.equal(second.threadInspection.lightweightInspectionCount, 1);
  assert.equal(second.threadInspection.deepReadCandidateCount, 1);
  assert.equal(second.threadInspection.records[0].lightweight.status, "metadata_only");
  assert.equal(second.executionReceipt.stageReceipts.lightweight_thread_inspection.inspectedCount, 1);
  assert.equal(second.executionReceipt.stageReceipts.deep_read_selection.candidateCount, 1);
});

test("live audit records App task inspections and bounded deep reads", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-companion-live-thread-inspection-"));
  const light = [];
  const deep = [];
  const result = await runHourlyAuditLive({
    now: "2026-08-31T00:00:00.000Z",
    liveStatus: {
      available: true,
      status: { connected: true, generation: "gen-live", exactTabLeaseCount: 0, pendingOperationCount: 0, queueCount: 0 },
    },
    recentTasks: [
      { threadId: "live-healthy", owner: "user", status: "idle", revision: "1", updatedAt: "2026-08-30T23:59:00.000Z" },
      { threadId: "live-actionable", owner: "user", status: "needs_attention", revision: "1", updatedAt: "2026-08-30T23:59:00.000Z" },
      { threadId: "live-automation", owner: "automation", status: "running", revision: "1", updatedAt: "2026-08-31T00:00:00.000Z" },
    ],
    inspectThread: async (input) => { light.push(input); return { status: "idle", revision: input.task.revision }; },
    readThread: async (input) => { deep.push(input); return { status: "completed", generation: "gen-live" }; },
    artifactDir: path.join(root, "artifact"),
    learningLedgerPath: path.join(root, "learning-ledger.v1.json"),
    sessionRoot: path.join(root, "sessions"),
    companionSource: path.join(root, "missing-source"),
    companionInstall: path.join(root, "missing-install"),
  });
  assert.equal(result.threadInspection.listedCount, 3);
  assert.equal(result.threadInspection.eligibleTaskCount, 2);
  assert.equal(result.threadInspection.lightweightReadCount, 2);
  assert.equal(result.threadInspection.deepReadCandidateCount, 2);
  assert.equal(result.threadInspection.deepReadCount, 2);
  assert.deepEqual(light.map((input) => input.threadId), ["live-healthy", "live-actionable"]);
  assert.deepEqual(deep.map((input) => input.threadId), ["live-healthy", "live-actionable"]);
  assert.equal(result.externalActionExecuted, false);
});

test("bounds verifier projections without dropping the audit decision", () => {
  const summary = {
    auditedAt: "2026-08-27T00:00:00.000Z",
    auditFingerprint: "fingerprint",
    readOnly: true,
    externalActionExecuted: false,
    recentUserSessionCount: 200,
    liveCandidateSessionCount: 200,
    companionIssueCount: 200,
    userHelpRequiredCount: 0,
    blockedCount: 200,
    exactBlocker: "bounded_test",
    nextAction: "wait",
    liveCandidates: Array.from({ length: 200 }, (_, index) => ({
      threadId: `thread-${index}`,
      companionMarkers: ["timeout"],
      userHelpMarkers: [],
      blocked: true,
      completed: false,
      latestSummary: `remaining blocker: ${"x".repeat(500)}`,
    })),
  };
  const projection = buildVerifierProjection(summary, { maxBytes: 4_000 });
  assert.equal(projection.exactBlocker, "bounded_test");
  assert.equal(projection.candidatesTruncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(projection), "utf8") <= 32_000);
});

test("hourly controller keeps an unchanged tick to a heartbeat with no callbacks", async () => {
  const events = [];
  const result = await runBoundedHourlyController({
    summary: { auditFingerprint: "same", changeDetection: { heartbeatOnly: true } },
    repair: () => events.push("repair"),
    refresh: () => events.push("refresh"),
    continueTask: () => events.push("continue"),
  });
  assert.equal(result.schema, "aos.companion_hourly_controller.v1");
  assert.equal(result.status, "heartbeat_only");
  assert.equal(result.external_action_executed, false);
  assert.deepEqual(result.actions, []);
  assert.deepEqual(events, []);
});

test("hourly controller escapes heartbeat-only mode for a stalled live task", async () => {
  let freshReads = 0;
  const result = await runBoundedHourlyController({
    summary: {
      auditFingerprint: "same-stalled",
      changeDetection: { heartbeatOnly: true },
      liveCandidates: [{
        threadId: "stalled-task",
        completed: false,
        userHelpRequired: false,
        companionIssue: true,
        resumeAssessment: { reason: "stale_owner_recoverable" },
        lastProgressAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      }],
    },
    readStatus: async () => {
      freshReads += 1;
      return { connected: true, unknown_effect: false, foreign_owner: false, active_reconciliation: false, human_auth_required: false, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 };
    },
    eligibleTasks: [],
  });
  assert.equal(result.status, "inspected");
  assert.equal(freshReads, 1);
  assert.equal(result.stalledTasks.length, 1);
  assert.match(result.progress_attempt_now, /fresh status\/readback/u);
});

test("does not escalate blocked tasks as stalled work", async () => {
  let freshReads = 0;
  const result = await runBoundedHourlyController({
    summary: {
      auditFingerprint: "same-blocked",
      changeDetection: { heartbeatOnly: true },
      liveCandidates: [{
        threadId: "blocked-task",
        completed: false,
        blocked: true,
        userHelpRequired: false,
        lastProgressAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      }],
    },
    readStatus: async () => {
      freshReads += 1;
      return { connected: true, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 };
    },
  });
  assert.equal(result.status, "heartbeat_only");
  assert.equal(result.stalledTasks.length, 0);
  assert.equal(freshReads, 0);
});

test("does not treat an old healthy session log as stalled work", async () => {
  let freshReads = 0;
  const result = await runBoundedHourlyController({
    summary: {
      auditFingerprint: "same-healthy-old",
      changeDetection: { heartbeatOnly: true },
      liveCandidates: [{
        threadId: "old-healthy-task",
        completed: false,
        userHelpRequired: false,
        companionIssue: false,
        lastProgressAt: new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString(),
      }],
    },
    readStatus: async () => {
      freshReads += 1;
      return { connected: true, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 };
    },
  });
  assert.equal(result.status, "heartbeat_only");
  assert.equal(result.stalledTasks.length, 0);
  assert.equal(freshReads, 0);
});

test("hourly controller preserves hard safety blockers and independent progress", async () => {
  const events = [];
  const result = await runBoundedHourlyController({
    summary: { auditFingerprint: "blocked", repairCandidates: [{ threadId: "task-1", repairPlan: { automatic: true, playbookId: "target_binding" } }] },
    freshStatus: { connected: true, unknown_effect: true, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
    repair: () => events.push("repair"),
    refresh: () => events.push("refresh"),
    continueTask: () => events.push("continue"),
  });
  assert.equal(result.status, "deferred");
  assert.equal(result.exact_blocker, "unknown_effect");
  assert.match(result.result, /Hard safety boundary/u);
  assert.equal(result.fallback_or_independent_work, "continue read-only audit and unrelated owner-scoped tasks");
  assert.deepEqual(events, []);
});

test("hourly controller can probe an unknown effect once without replaying it", async () => {
  let probes = 0;
  const result = await runBoundedHourlyController({
    summary: { auditFingerprint: "unknown-probe", repairCandidates: [] },
    freshStatus: { connected: true, unknown_effect: true, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
    reconcileUnknown: async () => {
      probes += 1;
      return { status: "recorded", external_action_executed: false, effect_state: "unknown_effect" };
    },
  });
  assert.equal(result.status, "reconciliation_probe");
  assert.equal(probes, 1);
  assert.equal(result.reconciliationFingerprint, "unknown-probe");
  assert.match(result.result, /not replayed/u);
});

test("task-level unknown effect resumes only after explicit no-effect proof", async () => {
  let probes = 0;
  let continued = 0;
  const summary = {
    auditFingerprint: "task-unknown-effect",
    repairCandidates: [{ threadId: "blocked-task", blocked: true, exactBlocker: "operation_effect_unknown" }],
    liveCandidates: [{ threadId: "blocked-task", blocked: true, completed: false, userHelpRequired: false, resumeAssessment: { reason: "task_blocked" } }],
  };
  const result = await runBoundedHourlyController({
    summary,
    freshStatus: { connected: true, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
    reconcileUnknown: async () => {
      probes += 1;
      return {
        status: "reconciled",
        effect_state: "known_no_effect",
        resumeAllowed: true,
        freshStatus: { connected: true, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
      };
    },
    eligibleTasks: summary.liveCandidates,
    continueTask: async () => { continued += 1; return { status: "queued", external_action_executed: false }; },
  });
  assert.equal(probes, 1);
  assert.equal(continued, 1);
  assert.equal(result.blockerProgress.status, "reconciled");
  assert.equal(result.continuations.length, 1);
  assert.equal(result.external_action_executed, false);
});

test("foreign owner progress stays deferred until owner and target proof are explicit", async () => {
  let probes = 0;
  const result = await runBoundedHourlyController({
    summary: {
      auditFingerprint: "foreign-owner-task",
      repairCandidates: [{ threadId: "foreign-task", blocked: true, exactBlocker: "session_not_owned" }],
    },
    freshStatus: { connected: true, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
    progressBlocked: async () => { probes += 1; return { status: "observed", ownerVerified: false, targetVerified: false, external_action_executed: false }; },
  });
  assert.equal(probes, 1);
  assert.equal(result.status, "deferred");
  assert.equal(result.exact_blocker, "foreign_owner");
  assert.equal(result.blockerProgress.replayAllowed, false);
});

test("clears a thread readback blocker only after same-task readback proof", async () => {
  let probes = 0;
  const summary = {
    auditFingerprint: "thread-readback-recovery",
    repairCandidates: [{ threadId: "readback-task", blocked: true, exactBlocker: "thread_readback_unavailable" }],
    liveCandidates: [{ threadId: "readback-task", completed: false, userHelpRequired: false, resumeAssessment: { reason: "task_blocked" } }],
  };
  const result = await runBoundedHourlyController({
    summary,
    freshStatus: { connected: true, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
    progressBlocked: async () => {
      probes += 1;
      return {
        status: "observed",
        readbackStatus: "observed",
        readbackVerified: true,
        sameTask: true,
        threadId: "readback-task",
        resumeAllowed: true,
        external_action_executed: false,
        freshStatus: { connected: true, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
      };
    },
    eligibleTasks: summary.liveCandidates,
    continueTask: async () => ({ status: "queued", external_action_executed: false }),
  });
  assert.equal(probes, 1);
  assert.equal(result.status, "completed");
  assert.equal(result.blockerProgress.status, "reconciled");
  assert.equal(result.continuations.length, 1);
});

test("hourly controller runs one repair, focused verification, reflected refresh, then one continuation per eligible task", async () => {
  const events = [];
  const status = { connected: true, unknown_effect: false, foreign_owner: false, active_reconciliation: false, human_auth_required: false, activeLeaseCount: 0, pendingCount: 0, queueCount: 0, generation: "gen-before" };
  const summary = {
    auditFingerprint: "changed",
    repairCandidates: [{
      threadId: "task-1",
      taskType: "job",
      repairPlan: { automatic: true, playbookId: "frame_or_locator_readback", nextAction: "semantic and visual readback" },
    }],
    liveCandidates: [
      { threadId: "task-1", taskType: "job", completed: false, userHelpRequired: false, resumeAssessment: { reason: "ready" } },
      { threadId: "task-2", taskType: "note", completed: false, userHelpRequired: false, resumeAssessment: { reason: "ready" } },
      { threadId: "task-auth", taskType: "job", completed: false, userHelpRequired: true, resumeAssessment: { reason: "human_auth_required" } },
    ],
  };
  const result = await runBoundedHourlyController({
    summary,
    freshStatus: status,
    repair: async () => { events.push("repair"); return { status: "passed", external_action_executed: false }; },
    verify: async () => { events.push("verify"); return { status: "passed", continuationAllowed: true, freshStatus: { ...status, generation: "gen-verified" } }; },
    refresh: async () => { events.push("refresh"); return { status: "reflected", reflected: true, generation: "gen-after", external_action_executed: false }; },
    continueTask: async ({ task }) => { events.push(`continue:${task.threadId}`); return { status: "queued", external_action_executed: false }; },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.actions, ["repair", "verification", "refresh", "continuation", "continuation"]);
  assert.deepEqual(events, ["repair", "verify", "refresh", "continue:task-1", "continue:task-2"]);
  assert.equal(result.refresh.reflected, true);
  assert.equal(result.continuations.length, 2);
  assert.equal(result.external_action_executed, false);
  assert.equal(result.executionReceipt.schema, "aos.companion_hourly_execution_receipt.v1");
  assert.equal(result.executionReceipt.complete, true);
  assert.equal(result.executionReceipt.stages.bounded_repair.status, "completed");
  assert.equal(result.executionReceipt.stages.signed_refresh.status, "completed");
  assert.equal(result.executionReceipt.stages.one_continuation_per_eligible_task.attempted, 2);
});

test("hourly controller consumes the task-owned relay queue and preserves its lane", async () => {
  const calls = [];
  const threadId = "task-owned-relay-controller";
  const result = await runBoundedHourlyController({
    summary: {
      auditFingerprint: "task-owned-relay-controller",
      liveCandidates: [],
      taskOwnedContinuationCandidates: [{
        threadId,
        hostId: "local",
        owner: "user",
        currentTaskReadback: true,
        officialTaskStatus: "idle",
        officialLatestTurnStatus: "completed",
        requiresTaskOwnedCompanionCallback: true,
        relayMode: "same_task_root_companion_repair_or_resume",
        relayReason: "capability_missing",
        relayRequiresFreshOfficialReadback: true,
        stateScope: "live_candidate",
      }],
    },
    freshStatus: { connected: true, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
    continueTask: async (request) => {
      calls.push(request);
      return { status: "queued", external_action_executed: false };
    },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(calls.map((call) => ({
    stage: call.stage,
    lane: call.lane,
    threadId: call.task.threadId,
    sourceThreadOnly: call.sourceThreadOnly,
    requiresTaskOwnedCompanionCallback: call.requiresTaskOwnedCompanionCallback,
    relayRequiresFreshOfficialReadback: call.relayRequiresFreshOfficialReadback,
  })), [{
    stage: "continuation",
    lane: "task_owned_companion_relay",
    threadId,
    sourceThreadOnly: true,
    requiresTaskOwnedCompanionCallback: true,
    relayRequiresFreshOfficialReadback: true,
  }]);
  assert.equal(result.continuations.length, 1);
});

test("resumes a stalled existing Goal after same-run repair and E2E readback", async () => {
  const events = [];
  const status = { connected: true, unknown_effect: false, foreign_owner: false, active_reconciliation: false, human_auth_required: false, activeLeaseCount: 0, pendingCount: 0, queueCount: 0, generation: "gen-before" };
  const summary = {
    auditFingerprint: "stalled-goal",
    repairCandidates: [{
      threadId: "stalled-goal-task",
      repairPlan: { automatic: true, playbookId: "stale_connection_generation", nextAction: "fresh status and generation rebind" },
    }],
    liveCandidates: [{
      threadId: "stalled-goal-task",
      taskType: "note",
      completed: false,
      userHelpRequired: false,
      companionIssue: true,
      companionMarkers: ["timeout"],
      resumeAssessment: { reason: "stale_owner_recoverable" },
    }],
  };
  const result = await runSameRunCompanionRepairLoop({
    summary,
    freshStatus: status,
    repair: async () => ({ status: "passed", external_action_executed: false }),
    verify: async () => ({ status: "passed", external_action_executed: false, freshStatus: { ...status, generation: "gen-verified" } }),
    refresh: async () => ({ status: "reflected", reflected: true, generation: "gen-after", external_action_executed: false }),
    e2e: async () => ({ status: "verified", sameRunE2E: true, external_action_executed: false }),
    continueTask: async ({ stage, task }) => { events.push({ stage, threadId: task.threadId }); return { status: "queued", external_action_executed: false }; },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(events, [{ stage: "continuation_after_same_run_e2e", threadId: "stalled-goal-task" }]);
  assert.equal(result.continuations.length, 1);
});

test("revalidates a historical capability blocker and continues the same Goal", async () => {
  const events = [];
  const status = {
    connected: true,
    generation: "gen-current",
    unknown_effect: false,
    foreign_owner: false,
    active_reconciliation: false,
    human_auth_required: false,
    activeLeaseCount: 0,
    pendingCount: 0,
    queueCount: 0,
  };
  const summary = {
    auditFingerprint: "capability-reflected-goal",
    repairCandidates: [{
      threadId: "note-task",
      blocked: true,
      exactBlocker: "companion_page_selectText_not_exposed_in_authorized_transaction_schema",
      repairPlan: {
        disposition: "capability_reflected_resume",
        automatic: false,
        playbookId: "capability_adapter_repair",
      },
    }],
    liveCandidates: [{
      threadId: "note-task",
      taskType: "note",
      blocked: true,
      completed: false,
      userHelpRequired: false,
      resumeAssessment: { reason: "task_blocked" },
    }],
  };
  const result = await runBoundedHourlyController({
    summary,
    freshStatus: status,
    progressBlocked: async ({ blocker }) => {
      events.push(`revalidate:${blocker}`);
      return {
        status: "verified",
        resumeAllowed: true,
        capabilityVerified: true,
        schemaParity: true,
        canaryPassed: true,
        installedGenerationVerified: true,
        freshStatus: status,
      };
    },
    continueTask: async ({ task }) => {
      events.push(`continue:${task.threadId}`);
      return { status: "queued", external_action_executed: false };
    },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(events, [
    "revalidate:capability_missing",
    "continue:note-task",
  ]);
  assert.equal(result.blockerProgress.status, "reconciled");
  assert.equal(result.blockerProgress.resumeAllowed, true);
  assert.equal(result.continuations.length, 1);
  assert.equal(result.external_action_executed, false);
});

test("hourly controller does not replay a repair for the same audit fingerprint", async () => {
  const events = [];
  const result = await runBoundedHourlyController({
    summary: {
      auditFingerprint: "same",
      repairCandidates: [{ threadId: "task-1", repairPlan: { automatic: true, playbookId: "stale_connection_generation" } }],
    },
    freshStatus: { connected: true, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
    readStatus: async () => ({ connected: true, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 }),
    previousController: { repairFingerprint: "same" },
    repair: () => events.push("repair"),
  });
  assert.equal(result.status, "inspected");
  assert.deepEqual(result.actions, []);
  assert.deepEqual(events, []);
});

test("same-run repair loop verifies the reflected Extension with E2E before continuation", async () => {
  const events = [];
  const status = { connected: true, generation: "gen-before", unknown_effect: false, foreign_owner: false, active_reconciliation: false, human_auth_required: false, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 };
  const result = await runSameRunCompanionRepairLoop({
    summary: {
      auditFingerprint: "same-run-success",
      repairCandidates: [{ threadId: "task-1", repairPlan: { automatic: true, playbookId: "target_binding" } }],
      liveCandidates: [{ threadId: "task-1", taskType: "note", completed: false, userHelpRequired: false, resumeAssessment: { reason: "ready" } }],
    },
    freshStatus: status,
    repair: async ({ stage }) => { events.push(stage); return { status: "passed", external_action_executed: false }; },
    verify: async ({ stage }) => { events.push(stage); return { status: "passed", freshStatus: status }; },
    refresh: async ({ stage }) => { events.push(stage); return { status: "reflected", reflected: true, generation: "gen-after", external_action_executed: false }; },
    e2e: async ({ stage }) => { events.push(stage); return { status: "verified", sameRunE2E: true, freshStatus: status, external_action_executed: false }; },
    continueTask: async ({ stage }) => { events.push(stage); return { status: "queued", external_action_executed: false }; },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.sameRunRepairLoop.passed, true);
  assert.equal(result.sameRunRepairLoop.cycles.length, 1);
  assert.equal(result.sameRunRepairLoop.cycles[0].e2e.status, "verified");
  assert.deepEqual(events, ["bounded_repair", "focused_verification", "signed_refresh", "same_run_e2e", "continuation_after_same_run_e2e"]);
  assert.equal(result.external_action_executed, false);
});

test("same-run repair loop applies a distinct repair after a failed E2E and passes on the next cycle", async () => {
  const events = [];
  const status = { connected: true, generation: "gen", unknown_effect: false, foreign_owner: false, active_reconciliation: false, human_auth_required: false, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 };
  let e2eAttempts = 0;
  let repairCycle = null;
  let previousAttempt = null;
  const result = await runSameRunCompanionRepairLoop({
    summary: {
      auditFingerprint: "same-run-repair-again",
      repairCandidates: [{ threadId: "task-1", repairPlan: { automatic: true, playbookId: "frame_or_locator_readback" } }],
    },
    freshStatus: status,
    readStatus: async ({ stage, cycle }) => { events.push(`${stage}:${cycle}`); return status; },
    repair: async ({ cycle, previousAttempt: attempt }) => {
      repairCycle = cycle;
      previousAttempt = attempt;
      events.push(`repair:${cycle}`);
      return { status: "passed", external_action_executed: false };
    },
    verify: async ({ stage }) => { events.push(stage); return { status: "passed", freshStatus: status }; },
    refresh: async ({ stage }) => { events.push(stage); return { status: "reflected", reflected: true, external_action_executed: false }; },
    e2e: async ({ stage }) => {
      events.push(stage);
      e2eAttempts += 1;
      return e2eAttempts === 1
        ? { status: "failed", failureFingerprint: "e2e-fp-1", generalizedCause: "semantic locator selected a stale page instance", nextRepairPlan: { automatic: true, playbookId: "target_binding" }, external_action_executed: false }
        : { status: "verified", sameRunE2E: true, freshStatus: status, external_action_executed: false };
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.sameRunRepairLoop.passed, true);
  assert.equal(result.sameRunRepairLoop.cycles.length, 2);
  assert.deepEqual(result.sameRunRepairLoop.failureFingerprints, ["e2e-fp-1"]);
  assert.equal(repairCycle, 2);
  assert.equal(previousAttempt.generalizedCause, "semantic locator selected a stale page instance");
  assert.equal(e2eAttempts, 2);
  assert.equal(events.filter((event) => event.startsWith("repair:")).length, 2);
});

test("same-run repair loop refuses duplicate E2E failure fingerprints", async () => {
  let repairs = 0;
  let e2eAttempts = 0;
  const result = await runSameRunCompanionRepairLoop({
    summary: {
      auditFingerprint: "same-run-duplicate",
      repairCandidates: [{ threadId: "task-1", repairPlan: { automatic: true, playbookId: "target_binding" } }],
    },
    freshStatus: { connected: true, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
    readStatus: async () => ({ connected: true, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 }),
    repair: async () => { repairs += 1; return { status: "passed", external_action_executed: false }; },
    verify: async () => ({ status: "passed", freshStatus: { connected: true, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 } }),
    refresh: async () => ({ status: "reflected", reflected: true, external_action_executed: false }),
    e2e: async () => {
      e2eAttempts += 1;
      return { status: "failed", failureFingerprint: "same-fp", generalizedCause: "same root cause", external_action_executed: false };
    },
  });
  assert.equal(result.status, "deferred");
  assert.equal(result.exact_blocker, "same_run_e2e_duplicate_failure_fingerprint");
  assert.equal(repairs, 2);
  assert.equal(e2eAttempts, 2);
  assert.equal(result.sameRunRepairLoop.cycles.length, 2);
});

test("same-run repair loop requires an E2E callback after a repair", async () => {
  const result = await runSameRunCompanionRepairLoop({
    summary: {
      auditFingerprint: "same-run-missing-e2e",
      repairCandidates: [{ threadId: "task-1", repairPlan: { automatic: true, playbookId: "target_binding" } }],
    },
    freshStatus: { connected: true, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
    repair: async () => ({ status: "passed", external_action_executed: false }),
    verify: async () => ({ status: "passed", freshStatus: { connected: true, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 } }),
    refresh: async () => ({ status: "reflected", reflected: true, external_action_executed: false }),
  });
  assert.equal(result.status, "deferred");
  assert.equal(result.exact_blocker, "same_run_e2e_callback_required");
  assert.equal(result.sameRunRepairLoop.passed, false);
});

test("same-run repair loop withholds E2E when the signed Extension refresh is deferred", async () => {
  let e2eAttempts = 0;
  const result = await runSameRunCompanionRepairLoop({
    summary: {
      auditFingerprint: "same-run-refresh-deferred",
      repairCandidates: [{ threadId: "task-1", repairPlan: { automatic: true, playbookId: "target_binding" } }],
    },
    freshStatus: { connected: true, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
    repair: async () => ({ status: "passed", external_action_executed: false }),
    verify: async () => ({ status: "passed", freshStatus: { connected: true, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 } }),
    refresh: async () => ({ status: "deferred", exact_blocker: "logical_sessions_active", external_action_executed: false }),
    e2e: async () => { e2eAttempts += 1; return { status: "verified", sameRunE2E: true, external_action_executed: false }; },
  });
  assert.equal(result.status, "deferred");
  assert.equal(result.exact_blocker, "logical_sessions_active");
  assert.equal(e2eAttempts, 0);
  assert.equal(result.sameRunRepairLoop.passed, false);
});

test("same-run refresh deferral does not freeze an unrelated ready task", async () => {
  const events = [];
  const result = await runSameRunCompanionRepairLoop({
    summary: {
      auditFingerprint: "same-run-independent-lane",
      repairCandidates: [{
        threadId: "companion-task",
        repairPlan: { automatic: true, playbookId: "target_binding" },
      }],
      liveCandidates: [
        {
          threadId: "companion-task",
          completed: false,
          companionIssue: true,
          userHelpRequired: false,
          resumeAssessment: { reason: "stale_owner_recoverable" },
        },
        {
          threadId: "independent-task",
          taskType: "note",
          completed: false,
          companionIssue: false,
          userHelpRequired: false,
          resumeAssessment: { reason: "ready" },
        },
      ],
    },
    eligibleTasks: [
      {
        threadId: "companion-task",
        completed: false,
        companionIssue: true,
        userHelpRequired: false,
        resumeAssessment: { reason: "stale_owner_recoverable" },
      },
      {
        threadId: "independent-task",
        taskType: "note",
        completed: false,
        companionIssue: false,
        userHelpRequired: false,
        resumeAssessment: { reason: "ready" },
      },
    ],
    freshStatus: { connected: true, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 },
    repair: async () => ({ status: "passed", external_action_executed: false }),
    verify: async () => ({ status: "passed", freshStatus: { connected: true, activeLeaseCount: 0, pendingCount: 0, queueCount: 0 } }),
    refresh: async () => ({ status: "deferred", exact_blocker: "logical_sessions_active", external_action_executed: false }),
    e2e: async () => { throw new Error("E2E must not run before reflection"); },
    continueTask: async ({ stage, lane, task }) => {
      events.push({ stage, lane, threadId: task.threadId });
      return { status: "queued", external_action_executed: false };
    },
  });
  assert.equal(result.status, "deferred");
  assert.equal(result.exact_blocker, "logical_sessions_active");
  assert.deepEqual(events, [{ stage: "independent_continuation", lane: "independent", threadId: "independent-task" }]);
  assert.deepEqual(result.independentContinuationPlan, [{ threadId: "independent-task", lane: "independent", sourceThreadOnly: false }]);
  assert.equal(result.independentContinuations.length, 1);
  assert.equal(result.executionReceipt.stages.one_continuation_per_eligible_task.status, "completed");
});

test("hard safety state on one task still permits an unrelated ready continuation", async () => {
  const events = [];
  const result = await runSameRunCompanionRepairLoop({
    summary: {
      auditFingerprint: "hard-blocker-independent-lane",
      repairCandidates: [{
        threadId: "reconciliation-task",
        repairPlan: { automatic: true, playbookId: "signed_reconciliation" },
      }],
      liveCandidates: [
        {
          threadId: "reconciliation-task",
          completed: false,
          companionIssue: true,
          userHelpRequired: false,
          resumeAssessment: { reason: "unknown_effect" },
        },
        {
          threadId: "ready-task",
          taskType: "note",
          completed: false,
          companionIssue: false,
          userHelpRequired: false,
          resumeAssessment: { reason: "ready" },
        },
      ],
    },
    eligibleTasks: [
      { threadId: "reconciliation-task", completed: false, companionIssue: true, userHelpRequired: false, resumeAssessment: { reason: "unknown_effect" } },
      { threadId: "ready-task", taskType: "note", completed: false, companionIssue: false, userHelpRequired: false, resumeAssessment: { reason: "ready" } },
    ],
    freshStatus: {
      connected: true,
      unknownEffect: true,
      activeReconciliation: true,
      activeLeaseCount: 1,
      pendingCount: 0,
      queueCount: 0,
    },
    continueTask: async ({ stage, lane, task }) => {
      events.push({ stage, lane, threadId: task.threadId });
      return { status: "queued", external_action_executed: false };
    },
  });
  assert.equal(result.status, "deferred");
  assert.equal(result.exact_blocker, "unknown_effect");
  assert.deepEqual(events, [{ stage: "independent_continuation", lane: "independent", threadId: "ready-task" }]);
});

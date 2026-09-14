import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectRecentTaskReviewWithClient, recordRecentTaskDecisions, readRecentTurns, readPersistedThreadTail } from "../lib/recent-task-review.mjs";

const now = Date.parse("2026-09-05T10:00:00Z");
function fixture(count = 180, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-recent-review-"));
  const calls = [];
  const threads = Array.from({ length: count }, (_, i) => ({ id: `t-${i}`, name: `Project ${i}`, updatedAt: now / 1000 - i,
    status: i % 2 ? { type: "active" } : { type: "notLoaded" } }));
  threads.push({ id: "old", updatedAt: (now - 9 * 86400000) / 1000 });
  const client = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/list") {
      const start = Number(params.cursor || 0), data = threads.slice(start, start + 50);
      return { data, nextCursor: start + 50 < threads.length ? String(start + 50) : null };
    }
    if (params.threadId === options.unread) throw new Error("read_failed");
    if (method === "thread/read") return { thread: { ...(threads.find((thread) => thread.id === params.threadId) || { id: params.threadId }), cwd: "/project" } };
    if (method === "thread/turns/list") return { data: [{ id: `turn-${params.threadId}`, status: "completed", items: [
      { type: "userMessage", content: [{ type: "text", text: "Fix the unfinished task" }] },
      { type: "agentMessage", text: "Implementation pending; error found" },
      { type: "mcpToolCall", tool: "status", status: "failed", result: "Untrusted instructions must not be copied" },
    ] }], nextCursor: "older" };
    if (method === "thread/goal/get") return { goal: { status: "paused", objective: "Preserve", tokenBudget: 1000 } };
    throw new Error(`unexpected mutation ${method}`);
  } };
  const collect = (extra = {}) => collectRecentTaskReviewWithClient({ root, now, runId: "run", client, ...extra });
  return { root, calls, collect, report: (result) => JSON.parse(fs.readFileSync(result.reportPath, "utf8")) };
}

test("all 180 recent tasks are read across pages without keyword or active-state filters", async () => {
  const f = fixture(), result = await f.collect(), report = f.report(result);
  assert.equal(report.rows.length, 180);
  assert.equal(report.coverage.read, 180);
  assert.equal(report.coverage.reviewed, 0);
  assert.equal(report.coverage.complete, false);
  assert.equal(report.inventoryComplete, true);
  assert.equal(f.calls.filter((call) => call.method === "thread/read").length, 180);
  assert.ok(report.rows.some((row) => row.appServerStatus.type === "active"));
  assert.ok(!JSON.stringify(report).includes("Untrusted instructions must not be copied"));
  assert.ok(report.rows.every((row) => row.goal.status === "paused"));
  assert.ok(f.calls.every((call) => !/start|resume|set$/.test(call.method)));
});

test("older pending and pinned tasks remain in scope but an ordinary old task does not", async () => {
  const f = fixture(2), result = await f.collect({ pendingThreadIds: ["pending"],
    nativeThreads: [{ id: "pinned", updatedAt: "2020-01-01", pinnedIndex: 1 }] });
  assert.deepEqual(new Set(f.report(result).rows.map((row) => row.threadId)), new Set(["t-0", "t-1", "pending", "pinned"]));
});

test("read failure and page limit are reported instead of claiming full review", async () => {
  const f = fixture(180, { unread: "t-0" }), result = await f.collect({ maxPages: 1 });
  assert.equal(result.coverage.unread, 1);
  assert.equal(result.coverage.inventoryComplete, false);
  assert.ok(f.report(result).inventoryErrors.includes("recent_review_page_limit_reached"));
  assert.throws(() => recordRecentTaskDecisions({ root: f.root, reportPath: result.reportPath,
    entries: [{ threadId: "t-0", decision: "completed", reason: "guess", evidence: "none" }] }), /unread_cannot/);
});

test("each task needs an evidence-backed judgment; resolved work leaves carryover", async () => {
  const f = fixture(2), result = await f.collect({ nativeInventoryComplete: true });
  const coverage = recordRecentTaskDecisions({ root: f.root, reportPath: result.reportPath, entries: [
    { threadId: "t-0", decision: "completed", reason: "User requested a report and it was delivered", evidence: "report readback",
      completion: { request: "Deliver the diagnostic report", outcome: "Report readback contains the requested cause and next action", evidence: "report readback" } },
    { threadId: "t-1", decision: "repair_needed", reason: "Confirmed local defect", evidence: "turn-t-1", nextAction: "Focused regression" },
  ] });
  assert.equal(coverage.complete, true);
  const pending = JSON.parse(fs.readFileSync(path.join(f.root, "pending.json"), "utf8"));
  assert.deepEqual(Object.keys(pending), ["t-1"]);
  const next = await f.collect({ runId: "next", now: now + 20 * 86400000 });
  assert.deepEqual(f.report(next).rows.map((row) => row.threadId), ["t-1"]);
});

test("native read evidence fills ChatGPT/unavailable App Server rows without hiding original failure", async () => {
  const f = fixture(1, { unread: "chat" }), result = await f.collect({ nativeInventoryComplete: true,
    nativeThreads: [{ id: "chat", kind: "chatgpt", updatedAt: new Date(now).toISOString() }] });
  const coverage = recordRecentTaskDecisions({ root: f.root, reportPath: result.reportPath, entries: [
    { threadId: "chat", decision: "no_action", reason: "Answer delivered", evidence: "native read", nativeReadEvidence: { source: "read_thread", latestTurnId: "chat-turn" } },
  ] });
  assert.equal(coverage.unread, 0);
  assert.equal(coverage.complete, false);
  assert.equal(f.report(result).rows.find((row) => row.threadId === "chat").readError, "read_failed");
});

test("the scheduled entrypoint collects broad review and never dispatches by a separate App Server idle snapshot", () => {
  const source = fs.readFileSync(new URL("../lib/scheduled-companion-controller.mjs", import.meta.url), "utf8");
  assert.match(source, /await collectRecentTaskReview\(/);
  assert.match(source, /continuationTransport: "native_desktop_only"/);
  assert.doesNotMatch(source, /processCandidate|dispatchThreadContinuation|bridge\.sendMessage/);
  assert.match(source, /export async function finalizeScheduledCompanionReview/);
  const collection = source.slice(source.indexOf("async function runCompanionDiagnostic"), source.indexOf("export async function finalizeScheduledCompanionReview"));
  assert.doesNotMatch(collection, /await finalizeCurrentRootHourlyController/);
  assert.doesNotMatch(source, /findPendingAudit/);
});

test("normal recent reads use summaries instead of full tool-heavy turns", async () => {
  const f = fixture(2);
  await f.collect();
  assert.ok(f.calls.filter((c) => c.method === "thread/turns/list").every((c) => c.params.itemsView === "summary"));
});

test("latest-turn order is explicit and message phases survive summary compaction", async () => {
  const f = fixture(1), result = await f.collect();
  assert.equal(f.report(result).rows[0].turnsOrder, "newest_first");
  assert.equal(f.report(result).rows[0].latestTurnId, "turn-t-0");
  const recent = await readRecentTurns({ request: async () => ({ data: [
    { id: "new", status: "completed", items: [{ id: "progress", type: "agentMessage", phase: "commentary", text: "Working on the next item" }] },
    { id: "old", status: "completed", items: [{ id: "answer", type: "agentMessage", phase: "final_answer", text: "Earlier question answered" }] },
  ] }) }, "task");
  assert.equal(recent.turns[0].id, "new");
  assert.equal(recent.turns[0].messages[0].phase, "commentary");
  assert.equal(recent.turns[1].messages[0].id, "answer");
});

test("generic completion claims retain unresolved tasks, including snapshot progress", async () => {
  const f = fixture(3), result = await f.collect();
  const report = f.report(result);
  report.rows[0].historyReadMode = "verified_persisted_tail";
  report.rows[0].historyEvidence = { snapshotOnly: true };
  report.rows[0].turns = [{ id: null, status: "unknown", messages: [
    { role: "user", text: "Continue the application" }, { role: "assistant", text: "Reading the form, then I will fill the missing fields" },
  ] }];
  fs.writeFileSync(result.reportPath, JSON.stringify(report));
  recordRecentTaskDecisions({ root: f.root, reportPath: result.reportPath, entries: [
    { threadId: "t-0", decision: "completed", reason: "Substantive answer, no remaining action evidenced", evidence: "snapshot" },
    { threadId: "t-1", decision: "completed", reason: "Turn completed", evidence: "turn-t-1", completion: { request: "Fix", outcome: "Done", evidence: " " } },
    { threadId: "t-2", decision: "completed", reason: "The requested explanation was delivered", evidence: "answer",
      completion: { request: "Explain the observed error without changing anything", outcome: "Answer explains its cause and safe next step", evidence: "read-only answer" } },
  ] });
  const rows = f.report(result).rows;
  assert.deepEqual(rows.map((r) => r.decision.decision), ["needs_context", "needs_context", "completed"]);
  assert.equal(rows[0].decision.rejectedDecision, "completed");
  assert.match(rows[0].decision.nextAction, /turns\[0\]/);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(f.root, "pending.json")))), ["t-0", "t-1"]);
});

test("a giant turn timeout changes to bounded item read and does not invent turn status", async () => {
  const calls = [];
  const result = await readRecentTurns({ request: async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/turns/list") throw new Error("summary_timeout");
    return { data: [
      { turnId: "turn", item: { type: "agentMessage", text: "Fix remains pending" } },
      { turnId: "turn", item: { type: "userMessage", content: [{ type: "text", text: "Fix this" }] } },
    ], nextCursor: "items-next" };
  } }, "large");
  assert.equal(result.historyReadMode, "bounded_items");
  assert.equal(result.historyPartial, true);
  assert.equal(result.turns[0].status, "unknown");
  assert.deepEqual(result.turns[0].messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(result.readAttempts[0].error, "summary_timeout");
  assert.equal(calls.length, 2);
});

test("an unsupported items store uses a one-turn fallback and retains the failed attempts", async () => {
  const calls = [];
  const result = await readRecentTurns({ request: async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/items/list") throw new Error("store_unsupported");
    if (params.itemsView === "summary") throw new Error("summary_failed");
    return { data: [{ id: "last", status: "completed", items: [{ type: "agentMessage", text: "Result" }] }], nextCursor: "older" };
  } }, "large");
  assert.equal(calls.at(-1).params.limit, 1);
  assert.equal(result.historyReadMode, "single_full_turn_fallback");
  assert.equal(result.readAttempts.length, 2);
  assert.equal(result.olderTurnsCursor, "older");
});

test("blocked Goal alone cannot be classified as an external dependency", async () => {
  const f = fixture(2), result = await f.collect();
  recordRecentTaskDecisions({ root: f.root, reportPath: result.reportPath, entries: [
    { threadId: "t-0", decision: "external_dependency", reason: "Goal blocked", evidence: "goal" },
    { threadId: "t-1", decision: "external_dependency", reason: "Provider sign in requires the user", evidence: "login screen",
      nextAction: "User signs in", dependency: { kind: "authentication", condition: "provider login required", evidence: "same-task login screen" } },
  ] });
  const rows = f.report(result).rows;
  assert.equal(rows[0].decision.decision, "needs_context");
  assert.match(rows[0].decision.diagnosisWarning, /cause_evidence_not_goal_status/);
  assert.equal(rows[1].decision.decision, "external_dependency");
  recordRecentTaskDecisions({ root: f.root, reportPath: result.reportPath, entries: [
    { threadId: "t-0", decision: "repair_needed", reason: "Repeated transaction_action_target_page_mismatch in the current document",
      evidence: "same-task failing operation", nextAction: "Inspect the binding implementation with its existing owner" },
  ] });
  assert.equal(f.report(result).rows[0].decision.decision, "repair_needed");
});

test("a repeated context gap requires a different concrete read, without blocking independent rows", async () => {
  const f = fixture(1), entry = { threadId: "t-0", decision: "needs_context", reason: "Missing outcome", evidence: "turn", nextAction: "Read again next tick" };
  const first = await f.collect();
  recordRecentTaskDecisions({ root: f.root, reportPath: first.reportPath, entries: [entry] });
  const second = await f.collect({ runId: "second" });
  recordRecentTaskDecisions({ root: f.root, reportPath: second.reportPath, entries: [entry] });
  const decision = f.report(second).rows[0].decision;
  assert.equal(decision.consecutiveUnchanged, 1);
  assert.match(decision.followupRequired, /Change the read unit/);
});

test("rewriting the proposed next action does not erase an unchanged context gap", async () => {
  const f = fixture(2);
  try {
    for (let cycle = 0; cycle < 3; cycle++) {
      const result = await f.collect({ runId: `context-cycle-${cycle}` });
      recordRecentTaskDecisions({ root: f.root, reportPath: result.reportPath, entries: [
        { threadId: "t-0", decision: "needs_context", reason: "The same task outcome is still missing",
          evidence: `current-report-${cycle}`, nextAction: `Rephrased proposed read ${cycle}` },
        { threadId: "t-1", decision: "healthy", reason: "The existing owner is working", evidence: `live-owner-${cycle}` },
      ] });
      const [pending, healthy] = f.report(result).rows.map((row) => row.decision);
      assert.equal(pending.consecutiveUnchanged, cycle);
      assert.equal(Boolean(pending.followupRequired), cycle > 0);
      assert.equal(healthy.decision, "healthy");
      assert.equal(healthy.consecutiveUnchanged, 0);
      assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(f.root, "pending.json")))), ["t-0"]);
    }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("a changed cause resets repetition even with the same next action and drops inherited followup", async () => {
  const f = fixture(1);
  try {
    const entry = { threadId: "t-0", decision: "needs_context", reason: "First missing outcome", evidence: "first", nextAction: "Read the owner evidence" };
    const first = await f.collect();
    recordRecentTaskDecisions({ root: f.root, reportPath: first.reportPath, entries: [entry] });
    const second = await f.collect({ runId: "second" });
    recordRecentTaskDecisions({ root: f.root, reportPath: second.reportPath, entries: [entry] });
    const previous = f.report(second).rows[0].decision;
    assert.ok(previous.followupRequired);
    const third = await f.collect({ runId: "third" });
    recordRecentTaskDecisions({ root: f.root, reportPath: third.reportPath,
      entries: [{ ...previous, reason: "The first outcome is resolved; a different request now needs context", evidence: "new-request" }] });
    const changed = f.report(third).rows[0].decision;
    assert.equal(changed.consecutiveUnchanged, 0);
    assert.equal(changed.followupRequired, undefined);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("changed dependency conditions and resolved decisions do not inherit a repeated-context warning", async () => {
  const f = fixture(2);
  try {
    const entry = { threadId: "t-0", decision: "external_dependency", reason: "Provider condition is pending",
      evidence: "provider-readback", nextAction: "Read provider state",
      dependency: { kind: "authentication", condition: "login required", evidence: "login page" } };
    const first = await f.collect();
    recordRecentTaskDecisions({ root: f.root, reportPath: first.reportPath, entries: [entry,
      { threadId: "t-1", decision: "needs_context", reason: "Missing answer", evidence: "request", nextAction: "Read answer" }] });
    const second = await f.collect({ runId: "second" });
    recordRecentTaskDecisions({ root: f.root, reportPath: second.reportPath, entries: [
      { ...entry, dependency: { kind: "human_verification", condition: "CAPTCHA required", evidence: "challenge page" } },
      { threadId: "t-1", decision: "completed", reason: "The requested answer is present", evidence: "answer",
        followupRequired: "Old warning copied from a previous report",
        completion: { request: "Explain the issue", outcome: "Explanation delivered", evidence: "answer" } },
    ] });
    for (const row of f.report(second).rows) {
      assert.equal(row.decision.consecutiveUnchanged, 0);
      assert.equal(row.decision.followupRequired, undefined);
    }
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(f.root, "pending.json")))), ["t-0"]);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("bounded legacy history validates identity, skips tool payloads, and never claims live status", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-tail-test-"));
  const file = path.join(root, "task.jsonl");
  const message = (role, text, channel = null) => JSON.stringify({ timestamp: "2026-09-05T12:00:00Z", type: "response_item",
    payload: { type: "message", role, channel, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
  try {
    fs.writeFileSync(file, [JSON.stringify({ type: "session_meta", payload: { id: "task" } }),
      message("user", "日本語の依頼"),
      JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(5 * 1024 * 1024) } }),
      message("user", "<environment_context>host</environment_context>"),
      message("user", "<recommended_plugins>plugins</recommended_plugins>"),
      message("user", "# AGENTS.md instructions\n\n<INSTRUCTIONS>rules</INSTRUCTIONS>\n<environment_context>host</environment_context>"),
      message("assistant", "Private reasoning must be omitted", "analysis"),
      message("assistant", "次の操作が未完了", "final"), ""].join("\n"));
    const result = readPersistedThreadTail({ threadId: "task", historyPath: file });
    assert.equal(result.turns[0].status, "unknown");
    assert.equal(result.turns[0].id, null);
    assert.equal(result.historyEvidence.snapshotOnly, true);
    assert.deepEqual(result.turns[0].messages.map((m) => m.text), ["日本語の依頼", "次の操作が未完了"]);
    assert.throws(() => readPersistedThreadTail({ threadId: "other", historyPath: file }), /identity_mismatch/);
    const bounded = readPersistedThreadTail({ threadId: "task", historyPath: file, maxBytes: 1024 });
    assert.equal(bounded.historyContextIncomplete, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("old index metadata cannot hide recent legacy activity after the date cutoff", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-stale-index-"));
  const file = path.join(root, "history.jsonl");
  fs.writeFileSync(file, "{}\n");
  fs.utimesSync(file, now / 1000, now / 1000);
  const old = { updatedAt: (now - 30 * 86400000) / 1000 };
  const client = { request: async (method, params) => {
    if (method === "thread/list") return params.cursor ? { data: [{ ...old, id: "recent-file", path: file }] }
      : { data: [{ ...old, id: "old" }], nextCursor: "second" };
    if (method === "thread/read") return { thread: { id: params.threadId } };
    if (method === "thread/goal/get") return { goal: null };
    return { data: [] };
  } };
  try {
    const result = await collectRecentTaskReviewWithClient({ root, now, runId: "stale-index", client });
    const report = JSON.parse(fs.readFileSync(result.reportPath));
    assert.equal(report.pages, 2);
    assert.deepEqual(report.rows.map((r) => r.threadId), ["recent-file"]);
    assert.equal(report.rows[0].historyUpdatedAt, new Date(now).toISOString());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("empty summaries change read units and never count as reviewed history", async () => {
  const result = await readRecentTurns({ request: async (method) => method === "thread/items/list" ? { data: [
    { turnId: "current", item: { type: "userMessage", content: [{ type: "text", text: "Continue the actual work" }] } },
  ] } : { data: [] } }, "task");
  assert.equal(result.historyReadMode, "bounded_items");
  assert.equal(result.turns[0].id, "current");
  assert.equal(result.readAttempts[0].error, "recent_review_turn_page_has_no_messages");
  await assert.rejects(readRecentTurns({ request: async () => ({ data: [] }) }, "task"), (error) => {
    assert.equal(error.readAttempts.length, 3);
    return /no_messages/.test(error.message);
  });
});

test("a mismatched thread response is kept unread and its Goal is not queried", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-identity-test-"));
  const calls = [];
  try {
    const result = await collectRecentTaskReviewWithClient({ root, now, runId: "identity", client: { request: async (method) => {
      calls.push(method);
      return method === "thread/list" ? { data: [{ id: "expected", updatedAt: now }] } : { thread: { id: "foreign" } };
    } } });
    const report = JSON.parse(fs.readFileSync(result.reportPath));
    assert.equal(report.coverage.unread, 1);
    assert.equal(report.rows[0].readError, "recent_review_thread_identity_mismatch");
    assert.deepEqual(calls, ["thread/list", "thread/read"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function publicHistory(file, id) {
  fs.writeFileSync(file, [JSON.stringify({ type: "session_meta", payload: { id } }),
    JSON.stringify({ timestamp: new Date(now).toISOString(), type: "response_item", payload: { type: "message", role: "user",
      content: [{ type: "input_text", text: "The latest request" }] } }),
    JSON.stringify({ timestamp: new Date(now + 1).toISOString(), type: "response_item", payload: { type: "message", role: "assistant", channel: "commentary",
      content: [{ type: "output_text", text: "The new work remains pending" }] } }), ""].join("\n"));
  fs.utimesSync(file, now / 1000, now / 1000);
}

test("small persisted history replaces stale index content without claiming Desktop liveness", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-fresh-history-"));
  const file = path.join(root, "task.jsonl");
  try {
    publicHistory(file, "task");
    let calls = 0;
    const result = await readRecentTurns({ request: async () => { calls++; throw new Error("old index must not override current history"); } }, "task",
      { historyPath: file, indexedUpdatedAt: now - 60000 });
    assert.equal(calls, 0);
    assert.equal(result.historySelectionReason, "persisted_activity_newer_than_index");
    assert.equal(result.turns[0].messages.at(-1).text, "The new work remains pending");
    assert.equal(result.turns[0].status, "unknown");
    assert.equal(result.historyEvidence.snapshotOnly, true);
    const fallback = await readRecentTurns({ request: async () => ({ data: [] }) }, "task", { historyPath: file });
    assert.equal(fallback.historySelectionReason, "official_history_queries_failed");
    assert.equal(fallback.readAttempts.length, 3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Goal absence and read failure retain prior observation without recreating a Goal", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aos-goal-observation-"));
  let goalMode = "active";
  const calls = [];
  const client = { request: async (method) => {
    calls.push(method);
    if (method === "thread/list") return { data: [{ id: "task", updatedAt: now }] };
    if (method === "thread/read") return { thread: { id: "task" } };
    if (method === "thread/goal/get") {
      if (goalMode === "error") throw new Error("goal_tool_unavailable");
      return { goal: goalMode === "active" ? { status: "active", objective: "Finish" } : null };
    }
    return { data: [{ id: "turn", items: [{ type: "userMessage", content: [{ type: "text", text: "Keep going" }] }] }] };
  } };
  try {
    for (const mode of ["active", "none", "error"]) {
      goalMode = mode;
      const result = await collectRecentTaskReviewWithClient({ root, now, runId: mode, client });
      const row = JSON.parse(fs.readFileSync(result.reportPath)).rows[0];
      assert.equal(row.goalReadStatus, { active: "observed", none: "absence_unconfirmed", error: "unavailable" }[mode]);
      assert.equal(row.goalObservation.goal.status, "active");
      recordRecentTaskDecisions({ root, reportPath: result.reportPath, entries: [{ threadId: "task", decision: "needs_context",
        reason: "Latest outcome needs verification", evidence: "turn" }] });
    }
    assert.ok(calls.every((method) => ["thread/list", "thread/read", "thread/goal/get", "thread/turns/list"].includes(method)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("empty or foreign native evidence cannot clear an unread task", async () => {
  const f = fixture(1, { unread: "t-0" });
  try {
    const result = await f.collect();
    for (const nativeReadEvidence of [{}, { source: "read_thread", latestTurnId: "other-turn", threadId: "foreign" }]) {
      assert.throws(() => recordRecentTaskDecisions({ root: f.root, reportPath: result.reportPath, entries: [{
        threadId: "t-0", decision: "no_action", reason: "Done", evidence: "native read", nativeReadEvidence,
      }] }), /native_read_evidence_invalid/);
    }
    assert.equal(f.report(result).coverage.unread, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

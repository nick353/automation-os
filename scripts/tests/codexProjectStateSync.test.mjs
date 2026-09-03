import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { main as syncMain } from "../codex-project-state-sync.mjs";
import {
  atomicWriteJson,
  buildLedger,
  executePreparedHandoff,
  extractPlanFromToolInput,
  handoffPressureTriggers,
  loadPolicy,
  prepareHandoffPackets,
  reconcilePendingHandoffs,
  readSourceHandoffState,
  recordHooklessTurnObservations,
} from "../lib/codex-project-state.mjs";

function writeJsonLines(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function message(timestamp, role, value, phase = null) {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text: value }],
      ...(phase ? { phase } : {}),
    },
  };
}

function event(timestamp, type) {
  return { timestamp, type: "event_msg", payload: { type } };
}

function completedEvent(timestamp, lastAgentMessage, turnId = "turn-terminal") {
  return {
    timestamp,
    type: "event_msg",
    payload: { type: "task_complete", turn_id: turnId, last_agent_message: lastAgentMessage },
  };
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-project-state-test-"));
  const projectA = path.join(root, "project-a");
  const projectB = path.join(root, "project-b");
  const outputDir = path.join(root, "ledger");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  fs.writeFileSync(path.join(projectA, "GOAL.md"), "# Goal\nShip the project safely.\n");
  fs.writeFileSync(path.join(projectA, "Plan.md"), "# Plan\n- [x] Inspect current state\n- [ ] Finish verification\n");
  fs.writeFileSync(path.join(projectA, "STATE.md"), "# State\n**next action:** Finish verification.\n**remaining blocker:** test_fixture_pending\n");
  fs.writeFileSync(path.join(projectB, "STATE.md"), "# State\nWaiting for active work.\n");

  const completedRollout = path.join(root, "completed.jsonl");
  const activeRollout = path.join(root, "active.jsonl");
  const ambiguousRollout = path.join(root, "ambiguous.jsonl");
  writeJsonLines(completedRollout, [
    event("2026-08-20T00:00:00.000Z", "task_started"),
    message("2026-08-20T00:00:01.000Z", "developer", "DO_NOT_STORE_DEVELOPER_TEXT"),
    message("2026-08-20T00:00:02.000Z", "user", "Continue project A with api_key=super-secret-value-123456"),
    {
      timestamp: "2026-08-20T00:00:03.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        input: "const p = await tools.update_plan({ explanation: \"current plan\", plan: [{ step: \"Inspect current state\", status: \"completed\" }, { step: \"Finish verification\", status: \"pending\" }] });",
      },
    },
    message("2026-08-20T00:00:04.000Z", "assistant", "result complete\nremaining blocker: test_fixture_pending\nnext action: Finish verification.\nexternal_action_executed=false", "final_answer"),
    event("2026-08-20T00:00:05.000Z", "task_complete"),
  ]);
  writeJsonLines(activeRollout, [
    event("2026-08-21T00:00:00.000Z", "task_started"),
    message("2026-08-21T00:00:01.000Z", "user", "Active work"),
  ]);
  writeJsonLines(ambiguousRollout, [
    event("2026-08-19T00:00:00.000Z", "task_started"),
    message("2026-08-19T00:00:01.000Z", "user", `${projectA} and ${projectB}`),
    message("2026-08-19T00:00:02.000Z", "assistant", "No project selected", "final_answer"),
    event("2026-08-19T00:00:03.000Z", "task_complete"),
  ]);

  const databasePath = path.join(root, "state.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT,
      preview TEXT,
      cwd TEXT,
      rollout_path TEXT,
      created_at_ms INTEGER,
      updated_at_ms INTEGER,
      created_at INTEGER,
      updated_at INTEGER,
      tokens_used INTEGER,
      source TEXT,
      thread_source TEXT,
      archived INTEGER,
      archived_at INTEGER,
      is_pinned INTEGER,
      project_id TEXT
    );
  `);
  const insert = database.prepare(`
    INSERT INTO threads (id,title,preview,cwd,rollout_path,created_at_ms,updated_at_ms,created_at,updated_at,tokens_used,source,thread_source,archived,archived_at,is_pinned,project_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const old = Date.now() - 24 * 60 * 60_000;
  insert.run("thread-completed", "Completed", "Completed", projectA, completedRollout, old, old, 0, 0, 20_000, "vscode", "user", 0, null, 0, "local-project-a");
  insert.run("thread-active", "Active", "Active", projectB, activeRollout, old, old, 0, 0, 20_000, "vscode", "user", 0, null, 0, null);
  insert.run("thread-ambiguous", "Ambiguous", "Ambiguous", root, ambiguousRollout, old, old, 0, 0, 20_000, "vscode", "user", 0, null, 0, null);
  database.close();

  const policyPath = path.join(root, "policy.json");
  fs.writeFileSync(policyPath, JSON.stringify({
    schema: "codex_project_state_policy.v1",
    state_db: databasePath,
    output_dir: outputDir,
    max_threads: 20,
    recent_days: 30,
    rollout_tail_bytes: 1024 * 1024,
    max_authority_file_bytes: 1024 * 1024,
    task_retention: {
      archive_tasks: false,
      keep_source_visible: true,
    },
    handoff: {
      enabled: true,
      mode: "prepare_only",
      automatic_thread_creation: false,
      max_per_run: 1,
      fallback_min_duration_minutes: 120,
      fallback_min_context_ratio: 0.5,
      min_rollout_bytes: 65536,
      min_context_ratio: 0.72,
      min_total_tokens: 10000,
      categories: ["manual"],
      require_project: true,
      require_complete_plan: true,
      protected_thread_ids: [],
      read_formal_goal: true,
      title_suffix: "引き継ぎ",
    },
    project_roots: [
      { id: "a", label: "Project A", root: projectA, authority_files: ["GOAL.md", "Plan.md", "STATE.md"] },
      { id: "b", label: "Project B", root: projectB, authority_files: ["STATE.md"] },
    ],
  }));
  return { root, outputDir, policyPath, databasePath, completedRollout };
}

test("extracts a complete update_plan without evaluating transcript JavaScript", () => {
  const plan = extractPlanFromToolInput("await tools.update_plan({ plan: [{ step: \"One\", status: \"completed\" }, { step: \"Two\", status: \"in_progress\" }] })");
  assert.deepEqual(plan.steps, [
    { step: "One", status: "completed" },
    { step: "Two", status: "in_progress" },
  ]);
});

test("elapsed time alone never triggers handoff pressure", () => {
  const policy = {
    handoff: {
      fallback_min_duration_minutes: 120,
      fallback_min_context_ratio: 0.5,
      min_rollout_bytes: 4 * 1024 * 1024,
      min_context_ratio: 0.72,
      min_total_tokens: 250_000,
    },
  };
  const thread = { created_at_ms: 0, updated_at_ms: 3 * 60 * 60_000, tokens_used: 0 };
  const rollout = { rollout_size_bytes: 0, context_pressure_ratio: 0.49, latest_total_tokens: 0 };
  assert.deepEqual(handoffPressureTriggers(thread, rollout, policy), []);
});

test("two hours plus fifty percent context triggers the fallback", () => {
  const policy = {
    handoff: {
      fallback_min_duration_minutes: 120,
      fallback_min_context_ratio: 0.5,
      min_rollout_bytes: 4 * 1024 * 1024,
      min_context_ratio: 0.72,
      min_total_tokens: 250_000,
    },
  };
  const thread = { created_at_ms: 0, updated_at_ms: 120 * 60_000, tokens_used: 0 };
  const rollout = { rollout_size_bytes: 0, context_pressure_ratio: 0.5, latest_total_tokens: 0 };
  assert.deepEqual(handoffPressureTriggers(thread, rollout, policy), ["long_duration_with_moderate_context"]);
});

test("fallback rejects either operand immediately below its boundary", () => {
  const policy = {
    handoff: {
      fallback_min_duration_minutes: 120,
      fallback_min_context_ratio: 0.5,
      min_rollout_bytes: 4 * 1024 * 1024,
      min_context_ratio: 0.72,
      min_total_tokens: 250_000,
    },
  };
  const rollout = { rollout_size_bytes: 0, context_pressure_ratio: 0.5, latest_total_tokens: 0 };
  assert.deepEqual(handoffPressureTriggers(
    { created_at_ms: 0, updated_at_ms: 119 * 60_000, tokens_used: 0 },
    rollout,
    policy,
  ), []);
  assert.deepEqual(handoffPressureTriggers(
    { created_at_ms: 0, updated_at_ms: 120 * 60_000, tokens_used: 0 },
    { ...rollout, context_pressure_ratio: 0.499 },
    policy,
  ), []);
});

test("normal pressure thresholds reject just-below values and accept exact values independently", () => {
  const policy = {
    handoff: {
      fallback_min_duration_minutes: 120,
      fallback_min_context_ratio: 0.5,
      min_rollout_bytes: 4 * 1024 * 1024,
      min_context_ratio: 0.72,
      min_total_tokens: 250_000,
    },
  };
  const shortThread = { created_at_ms: 0, updated_at_ms: 60_000, tokens_used: 249_999 };
  const below = { rollout_size_bytes: (4 * 1024 * 1024) - 1, context_pressure_ratio: 0.7199, latest_total_tokens: 0 };
  assert.deepEqual(handoffPressureTriggers(shortThread, below, policy), []);
  assert.deepEqual(handoffPressureTriggers(shortThread, { ...below, rollout_size_bytes: 4 * 1024 * 1024 }, policy), ["large_rollout"]);
  assert.deepEqual(handoffPressureTriggers(shortThread, { ...below, context_pressure_ratio: 0.72 }, policy), ["context_pressure"]);
  assert.deepEqual(handoffPressureTriggers({ ...shortThread, tokens_used: 250_000 }, below, policy), ["high_token_usage"]);
});

test("high pressure signals still trigger without waiting two hours", () => {
  const policy = {
    handoff: {
      fallback_min_duration_minutes: 120,
      fallback_min_context_ratio: 0.5,
      min_rollout_bytes: 4 * 1024 * 1024,
      min_context_ratio: 0.72,
      min_total_tokens: 250_000,
    },
  };
  const thread = { created_at_ms: 0, updated_at_ms: 15 * 60_000, tokens_used: 250_000 };
  const rollout = { rollout_size_bytes: 4 * 1024 * 1024, context_pressure_ratio: 0.72, latest_total_tokens: 0 };
  assert.deepEqual(handoffPressureTriggers(thread, rollout, policy), [
    "large_rollout",
    "context_pressure",
    "high_token_usage",
  ]);
});

test("builds a hookless bounded ledger and excludes active or ambiguous threads from handoff", () => {
  const fixture = createFixture();
  const policy = loadPolicy(fixture.policyPath);
  const previousHookEvent = process.env.CODEX_HOOK_EVENT;
  delete process.env.CODEX_HOOK_EVENT;
  try {
    const ledger = buildLedger(policy, { currentThreadId: "different-thread" });
    assert.equal(ledger.inputs.hooks_used, false);
    assert.equal(ledger.inputs.thread_activation_used, false);
    assert.equal(ledger.counts.threads, 3);
    const completed = ledger.threads.find((item) => item.thread_id === "thread-completed");
    const active = ledger.threads.find((item) => item.thread_id === "thread-active");
    const ambiguous = ledger.threads.find((item) => item.thread_id === "thread-ambiguous");
    assert.equal(completed.project.id, "a");
    assert.equal(completed.projection.plan.steps.length, 2);
    assert.equal(completed.projection.next_action, "Finish verification");
    assert.equal(completed.projection.external_effect_state, "observed_false");
    assert.equal(ledger.policy.archive_tasks, false);
    assert.equal(completed.handoff.eligible, true);
    assert.equal(completed.handoff.source_task_retention, "keep_visible_never_archive");
    assert.equal(active.runtime.active_turn_detected, true);
    assert.equal(active.handoff.eligible, false);
    assert.ok(active.handoff.reasons.includes("active_turn_detected"));
    assert.equal(ambiguous.project_assignment.status, "needs_review");
    assert.equal(ambiguous.handoff.eligible, false);
    const serialized = JSON.stringify(ledger);
    assert.equal(serialized.includes("DO_NOT_STORE_DEVELOPER_TEXT"), false);
    assert.equal(serialized.includes("super-secret-value-123456"), false);
    assert.equal(serialized.includes("[REDACTED]"), true);
    const target = path.join(fixture.outputDir, "ledger.json");
    atomicWriteJson(target, ledger);
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  } finally {
    if (previousHookEvent === undefined) delete process.env.CODEX_HOOK_EVENT;
    else process.env.CODEX_HOOK_EVENT = previousHookEvent;
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a grown rollout invalidates reuse and rebuilds plan and blockers from the latest safe terminal turn", () => {
  const fixture = createFixture();
  try {
    const policy = loadPolicy(fixture.policyPath);
    const initial = buildLedger(policy, { currentThreadId: "different-thread" });
    const previous = initial.threads.find((item) => item.thread_id === "thread-completed");
    const terminal = [
      "## result",
      "The audit found follow-up work.",
      "## remaining blocker",
      "fresh_terminal_blocker",
      "## next action",
      "1. Rebuild the current plan",
      "2. Verify the rebuilt projection",
    ].join("\n");
    fs.appendFileSync(fixture.completedRollout, [
      event("2026-08-22T00:00:00.000Z", "task_started"),
      message("2026-08-22T00:00:01.000Z", "user", "Use only the newest terminal state"),
      completedEvent("2026-08-22T00:00:05.000Z", terminal, "turn-new-terminal"),
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const refreshed = buildLedger(policy, { currentThreadId: "different-thread", previousLedger: initial });
    const current = refreshed.threads.find((item) => item.thread_id === "thread-completed");
    assert.equal(current.projection_reused, false);
    assert.ok(current.source.rollout_size_bytes > previous.source.rollout_size_bytes);
    assert.equal(current.runtime.latest_turn_id, "turn-new-terminal");
    assert.equal(current.projection.latest_user_intent, "Use only the newest terminal state");
    assert.equal(current.projection.plan.source, "safe_terminal_reconstruction");
    assert.equal(current.projection.plan_complete, true);
    assert.deepEqual(current.projection.unfinished, [
      "Rebuild the current plan",
      "Verify the rebuilt projection",
    ]);
    assert.ok(current.projection.completed.includes("Inspect current state"));
    assert.deepEqual(current.projection.blockers, ["fresh_terminal_blocker"]);
    assert.equal(current.projection.blockers.includes("test_fixture_pending"), false);
    assert.equal(current.projection.next_action, "Rebuild the current plan");
    assert.equal(current.projection.external_effect_state, "observed_false");
    assert.equal(current.projection.external_effect_basis, "latest_turn_no_tool_calls");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a single terminal next action reconciles without dropping the rest of the prior plan", () => {
  const fixture = createFixture();
  try {
    fs.appendFileSync(fixture.completedRollout, [
      event("2026-08-22T00:00:00.000Z", "task_started"),
      message("2026-08-22T00:00:01.000Z", "user", "Keep the complete plan"),
      completedEvent("2026-08-22T00:00:05.000Z", "## next action\nRun the focused verification", "turn-single-next"),
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const ledger = buildLedger(loadPolicy(fixture.policyPath), { currentThreadId: "different-thread" });
    const current = ledger.threads.find((item) => item.thread_id === "thread-completed");
    assert.equal(current.projection.plan.source, "safe_terminal_reconciliation");
    assert.equal(current.projection.plan_complete, true);
    assert.deepEqual(current.projection.plan.steps, [
      { step: "Inspect current state", status: "completed" },
      { step: "Finish verification", status: "pending" },
      { step: "Run the focused verification", status: "pending" },
    ]);
    assert.equal(current.projection.next_action, "Run the focused verification");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("mechanical read-only evidence yields external false while non-read-only evidence stays unknown", () => {
  const fixture = createFixture();
  try {
    writeJsonLines(fixture.completedRollout, [
      event("2026-08-22T00:00:00.000Z", "task_started"),
      message("2026-08-22T00:00:01.000Z", "user", "Inspect status only"),
      {
        timestamp: "2026-08-22T00:00:02.000Z",
        type: "response_item",
        payload: { type: "custom_tool_call", name: "exec", input: "await tools.mcp__status__read({})" },
      },
      {
        timestamp: "2026-08-22T00:00:03.000Z",
        type: "event_msg",
        payload: { type: "mcp_tool_call_end", read_only_hint: true, invocation: { server: "status", tool: "read" } },
      },
      completedEvent("2026-08-22T00:00:04.000Z", "## next action\n1. Review the status", "turn-read-only"),
    ]);
    const policy = loadPolicy(fixture.policyPath);
    const readOnlyLedger = buildLedger(policy, { currentThreadId: "different-thread" });
    const readOnly = readOnlyLedger.threads.find((item) => item.thread_id === "thread-completed");
    assert.equal(readOnly.projection.external_effect_state, "observed_false");
    assert.equal(readOnly.projection.external_effect_basis, "latest_turn_mechanically_read_only");

    fs.appendFileSync(fixture.completedRollout, [
      event("2026-08-23T00:00:00.000Z", "task_started"),
      message("2026-08-23T00:00:01.000Z", "user", "Attempt a mutable operation"),
      {
        timestamp: "2026-08-23T00:00:02.000Z",
        type: "response_item",
        payload: { type: "custom_tool_call", name: "exec", input: "await tools.mcp__status__update({})" },
      },
      {
        timestamp: "2026-08-23T00:00:03.000Z",
        type: "event_msg",
        payload: { type: "mcp_tool_call_end", read_only_hint: false, invocation: { server: "status", tool: "update" } },
      },
      completedEvent("2026-08-23T00:00:04.000Z", "## next action\n1. Reconcile the operation", "turn-mutable"),
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const mutableLedger = buildLedger(policy, { currentThreadId: "different-thread", previousLedger: readOnlyLedger });
    const mutable = mutableLedger.threads.find((item) => item.thread_id === "thread-completed");
    assert.equal(mutable.projection.external_effect_state, "unknown");
    assert.equal(mutable.projection.external_effect_basis, "non_read_only_tool_observed");
    assert.equal(mutable.handoff.execution_requires_reconciliation, true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("prepares a complete private packet without creating, activating, or archiving a task", async () => {
  const fixture = createFixture();
  try {
    const policy = loadPolicy(fixture.policyPath);
    const ledger = buildLedger(policy, { currentThreadId: "different-thread" });
    const calls = [];
    const client = {
      async request(method, params) {
        calls.push({ method, params });
        assert.equal(method, "thread/goal/get");
        return { goal: { objective: "Ship the project safely.", status: "active", tokenBudget: 5000 } };
      },
    };
    const prepared = await prepareHandoffPackets(policy, ledger, { client });
    assert.equal(prepared.prepared, 1);
    assert.equal(prepared.execution_eligible, 1);
    assert.deepEqual(calls.map((item) => item.method), ["thread/goal/get"]);
    const packetPath = prepared.packets[0].packet_path;
    const packet = JSON.parse(fs.readFileSync(packetPath, "utf8"));
    assert.equal(fs.statSync(packetPath).mode & 0o777, 0o600);
    assert.equal(packet.schema, "codex_hookless_handoff_packet.v1");
    assert.equal(packet.source_task_retention, "keep_visible_never_archive");
    assert.equal(packet.destination_contract.creation_method, "thread/start");
    assert.equal(packet.destination_contract.fork_allowed, false);
    assert.equal(packet.destination_contract.source_archive_allowed, false);
    assert.equal(packet.destination_contract.browser_route_bootstrap.route_authority, "adaptive_two_extension_resolver");
    assert.equal(packet.destination_contract.browser_route_bootstrap.selector_backend_role, "preferred_backend_not_final_route");
    assert.equal(packet.destination_contract.browser_route_bootstrap.decision_scope, "browser_stage");
    assert.equal(packet.destination_contract.browser_route_bootstrap.read_before_browser_skill_or_preflight, true);
    assert.equal(packet.destination_contract.browser_route_bootstrap.nested_chrome_profile_surface_role, "profile_metadata_only_not_route_authority");
    assert.deepEqual(packet.destination_contract.browser_route_bootstrap.decision_precedence, [
      "explicit_user_or_workflow_requirement",
      "active_run_or_owned_tab_continuity",
      "official_surface_or_proof_requirement",
      "effectful_workflow_adapter_availability",
      "companion_for_normal_new_browser_stage",
    ]);
    assert.equal(packet.destination_contract.browser_route_bootstrap.stage_rules.normal_or_read_only, "aos_chrome_companion");
    assert.equal(packet.destination_contract.browser_route_bootstrap.stage_rules.official_surface_or_proof, "chrome_plugin");
    assert.equal(packet.destination_contract.browser_route_bootstrap.stage_rules.registered_effect, "use_immutable_aos_browser_route_decision_v2");
    assert.equal(packet.destination_contract.browser_route_bootstrap.stage_rules.missing_effectful_adapter, "block_before_dispatch");
    assert.equal(packet.destination_contract.browser_route_bootstrap.preserve_active_run_backend, true);
    assert.equal(packet.destination_contract.browser_route_bootstrap.post_dispatch_fallback_allowed, false);
    assert.equal(packet.destination_contract.browser_route_bootstrap.reroute_after_terminal_no_effect_only, true);
    assert.equal(packet.source_continuation_contract.after_destination_claim, "reconciliation_only");
    assert.equal(packet.source_continuation_contract.after_destination_ready, "handoff_completed");
    assert.equal(packet.source_continuation_contract.implementation_allowed_after_destination_claim, false);
    assert.equal(packet.plan_complete, true);
    assert.deepEqual(packet.plan_status_counts, { blocked: 0, completed: 1, in_progress: 0, pending: 1 });
    assert.equal(packet.next_action, "Finish verification");
    assert.equal(packet.external_effect_ledger[0].state, "observed_false");
    assert.equal(JSON.stringify(packet).includes("super-secret-value-123456"), false);
    assert.equal(ledger.threads.find((item) => item.thread_id === "thread-completed").handoff.prepared, true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an execution-ineligible candidate does not starve the next candidate", async () => {
  const fixture = createFixture();
  try {
    const policy = loadPolicy(fixture.policyPath);
    policy.handoff.max_per_run = 1;
    policy.handoff.candidate_scan_limit = 10;
    const ledger = buildLedger(policy, { currentThreadId: "different-thread" });
    const template = ledger.threads.find((item) => item.thread_id === "thread-completed");
    const blocked = structuredClone(template);
    blocked.thread_id = "candidate-blocked";
    const ready = structuredClone(template);
    ready.thread_id = "candidate-ready";
    ledger.threads = [blocked, ready];
    const requested = [];
    const prepared = await prepareHandoffPackets(policy, ledger, {
      client: {
        async request(method, params) {
          assert.equal(method, "thread/goal/get");
          requested.push(params.threadId);
          if (params.threadId === "candidate-blocked") throw new Error("goal-read-unavailable");
          return { goal: null };
        },
      },
    });
    assert.deepEqual(requested, ["candidate-blocked", "candidate-ready"]);
    assert.equal(prepared.candidate_pool, 2);
    assert.equal(prepared.attempted, 2);
    assert.equal(prepared.prepared, 2);
    assert.equal(prepared.skipped_execution_ineligible, 1);
    assert.equal(prepared.execution_eligible, 1);
    assert.equal(prepared.packets[0].execution_eligible, false);
    assert.equal(prepared.packets[1].source_thread_id, "candidate-ready");
    assert.equal(prepared.packets[1].execution_eligible, true);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("the current task is never selected for handoff", () => {
  const fixture = createFixture();
  try {
    const ledger = buildLedger(loadPolicy(fixture.policyPath), { currentThreadId: "thread-completed" });
    const current = ledger.threads.find((item) => item.thread_id === "thread-completed");
    assert.equal(current.handoff.eligible, false);
    assert.ok(current.handoff.reasons.includes("current_thread"));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("automatic execution is fail-closed until policy explicitly enables it", async () => {
  const fixture = createFixture();
  try {
    const policy = loadPolicy(fixture.policyPath);
    const ledger = buildLedger(policy, { currentThreadId: "different-thread" });
    const prepared = await prepareHandoffPackets(policy, ledger, {
      client: { request: async () => ({ goal: null }) },
    });
    await assert.rejects(
      () => executePreparedHandoff(policy, prepared.packets[0].packet_path, { client: { request: async () => assert.fail("must not call app-server") } }),
      /codex_hookless_handoff_automatic_creation_disabled/u,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("automatic mode uses one historyless thread/start flow and never archives the source", async () => {
  const fixture = createFixture();
  try {
    const policy = loadPolicy(fixture.policyPath);
    const ledger = buildLedger(policy, { currentThreadId: "different-thread" });
    const prepared = await prepareHandoffPackets(policy, ledger, {
      client: { request: async () => ({ goal: { objective: "Ship the project safely.", status: "active", tokenBudget: 5000 } }) },
    });
    policy.handoff.mode = "automatic";
    policy.handoff.automatic_thread_creation = true;
    const methods = [];
    const goalSets = [];
    let continuationText = "";
    let completionWaited = false;
    const client = {
      async request(method, params) {
        methods.push(method);
        if (method === "thread/start") return { thread: { id: "destination-thread", turns: [] } };
        if (method === "thread/read") return { thread: { id: "destination-thread", turns: [] } };
        if (method === "thread/goal/get") {
          if (params.threadId === "thread-completed") {
            return { goal: { objective: "Ship the project safely.", status: "active", tokenBudget: 5000 } };
          }
          return { goal: { objective: "Ship the project safely.", status: "active", tokenBudget: 5000 } };
        }
        if (method === "turn/start") {
          continuationText = params.input?.[0]?.text || "";
          return { turn: { id: "destination-turn" } };
        }
        if (method === "thread/goal/set") {
          goalSets.push(params);
          return {};
        }
        if (method === "thread/name/set") return {};
        assert.fail(`unexpected method: ${method} ${JSON.stringify(params)}`);
      },
      async waitForNotification(predicate) {
        const notification = {
          method: "turn/completed",
          params: {
            threadId: "destination-thread",
            turn: { id: "destination-turn", status: "completed" },
          },
        };
        assert.equal(predicate(notification), true);
        completionWaited = true;
        return notification;
      },
    };
    const receipt = await executePreparedHandoff(policy, prepared.packets[0].packet_path, { client });
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.destination_ready, true);
    assert.equal(receipt.historyless_verified, true);
    assert.equal(receipt.continuation_status, "completed");
    assert.equal(completionWaited, true);
    assert.equal(receipt.source_task_archived, false);
    assert.equal(receipt.source_task_visible, true);
    assert.equal(receipt.source_status, "handoff_completed");
    assert.equal(receipt.implementation_allowed, false);
    assert.equal(receipt.source_goal_stopped, true);
    assert.equal(receipt.source_execution, "handoff_stopped");
    assert.equal(receipt.source_goal_close.status, "verified");
    assert.equal(receipt.source_goal_close.readback.status, "active");
    assert.equal(goalSets.length, 1);
    assert.equal(goalSets[0].threadId, "destination-thread");
    assert.equal(goalSets[0].status, "active");
    assert.equal(receipt.next_action, "Finish verification");
    assert.match(continuationText, /fresh-read/u);
    assert.match(continuationText, /アクション/u);
    assert.deepEqual(methods, [
      "thread/goal/get",
      "thread/start",
      "thread/read",
      "thread/name/set",
      "thread/goal/set",
      "thread/goal/get",
      "turn/start",
    ]);
    assert.equal(methods.some((method) => method.includes("archive")), false);
    const sourceState = readSourceHandoffState(policy, "thread-completed");
    assert.equal(sourceState.source_status, "handoff_completed");
    assert.equal(sourceState.implementation_allowed, false);
    const refreshed = buildLedger(policy, { currentThreadId: "different-thread", previousLedger: ledger });
    const source = refreshed.threads.find((item) => item.thread_id === "thread-completed");
    assert.equal(source.handoff.eligible, false);
    assert.ok(source.handoff.reasons.includes("source_handoff_completed"));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("source Goal close failure stops before destination creation or continuation", async () => {
  const fixture = createFixture();
  try {
    const policy = loadPolicy(fixture.policyPath);
    const ledger = buildLedger(policy, { currentThreadId: "different-thread" });
    const prepared = await prepareHandoffPackets(policy, ledger, {
      client: { request: async () => ({ goal: { objective: "Ship the project safely.", status: "active", tokenBudget: 5000 } }) },
    });
    policy.handoff.mode = "automatic";
    policy.handoff.automatic_thread_creation = true;
    const methods = [];
    const receipt = await executePreparedHandoff(policy, prepared.packets[0].packet_path, {
      client: {
        async request(method, params) {
          methods.push({ method, params });
          if (method === "thread/goal/set") return {};
          if (method === "thread/goal/get") {
            return { goal: { objective: "Different source objective.", status: "active", tokenBudget: 5000 } };
          }
          assert.fail(`must not reach destination method: ${method}`);
        },
      },
    });
    assert.equal(receipt.status, "reconciliation_required");
    assert.equal(receipt.source_status, "reconciliation_only");
    assert.equal(receipt.implementation_allowed, false);
    assert.equal(receipt.exact_blocker, "codex_hookless_handoff_source_goal_readback_mismatch");
    assert.equal(methods.some(({ method }) => method === "thread/start"), false);
    assert.equal(methods.some(({ method }) => method === "turn/start"), false);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a claimed empty destination is reconciled without creating a second task", async () => {
  const fixture = createFixture();
  try {
    const policy = loadPolicy(fixture.policyPath);
    const ledger = buildLedger(policy, { currentThreadId: "different-thread" });
    const prepared = await prepareHandoffPackets(policy, ledger, {
      client: { request: async () => ({ goal: null }) },
    });
    policy.handoff.mode = "automatic";
    policy.handoff.automatic_thread_creation = true;
    const firstMethods = [];
    const firstReceipt = await executePreparedHandoff(policy, prepared.packets[0].packet_path, {
      client: {
        async request(method) {
          firstMethods.push(method);
          if (method === "thread/start") return { thread: { id: "existing-empty-destination" } };
          if (method === "thread/read") throw new Error("eventual-consistency-read-failed");
          assert.fail(`unexpected first-pass method: ${method}`);
        },
      },
    });
    assert.equal(firstReceipt.status, "reconciliation_required");
    assert.equal(firstReceipt.source_status, "reconciliation_only");
    assert.equal(firstReceipt.implementation_allowed, false);
    assert.equal(firstReceipt.destination_thread_id, "existing-empty-destination");
    assert.equal(firstMethods.filter((method) => method === "thread/start").length, 1);

    let scannedPacketPath = null;
    const pending = await reconcilePendingHandoffs(policy, {
      execute: async (_currentPolicy, packetPath) => {
        scannedPacketPath = packetPath;
        return { status: "reconciliation_required", packet_path: packetPath };
      },
    });
    assert.equal(pending.attempted, 1);
    assert.equal(pending.completed, 0);
    assert.equal(fs.realpathSync(scannedPacketPath), fs.realpathSync(prepared.packets[0].packet_path));

    const secondMethods = [];
    let continuationInput = null;
    const secondReceipt = await executePreparedHandoff(policy, prepared.packets[0].packet_path, {
      client: {
        async request(method, params) {
          secondMethods.push(method);
          if (method === "thread/resume") return { thread: { id: "existing-empty-destination" } };
          if (method === "thread/read") return { thread: { id: "existing-empty-destination", turns: [] } };
          if (method === "thread/name/set") return {};
          if (method === "thread/goal/get") return { goal: null };
          if (method === "turn/start") {
            continuationInput = params.input;
            return { turn: { id: "destination-turn" } };
          }
          assert.fail(`unexpected reconciliation method: ${method}`);
        },
      },
    });
    assert.equal(secondReceipt.status, "completed");
    assert.equal(secondReceipt.destination_ready, true);
    assert.equal(secondReceipt.source_task_archived, false);
    assert.equal(secondReceipt.source_status, "handoff_completed");
    assert.equal(secondReceipt.implementation_allowed, false);
    assert.equal(secondMethods.includes("thread/start"), false);
    assert.deepEqual(continuationInput?.[0]?.text_elements, []);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an unknown thread/start effect makes the source reconciliation-only and suppresses replay", async () => {
  const fixture = createFixture();
  try {
    const policy = loadPolicy(fixture.policyPath);
    const ledger = buildLedger(policy, { currentThreadId: "different-thread" });
    const prepared = await prepareHandoffPackets(policy, ledger, {
      client: { request: async () => ({ goal: null }) },
    });
    policy.handoff.mode = "automatic";
    policy.handoff.automatic_thread_creation = true;
    let starts = 0;
    const first = await executePreparedHandoff(policy, prepared.packets[0].packet_path, {
      client: {
        async request(method) {
          if (method === "thread/start") {
            starts += 1;
            throw new Error("transport-ended-after-dispatch");
          }
          assert.fail(`unexpected first request: ${method}`);
        },
      },
    });
    assert.equal(first.status, "reconciliation_required");
    assert.equal(first.source_status, "reconciliation_only");
    assert.equal(first.implementation_allowed, false);
    assert.equal(starts, 1);
    const second = await executePreparedHandoff(policy, prepared.packets[0].packet_path, {
      client: { request: async () => assert.fail("must not replay thread/start") },
    });
    assert.equal(second.status, "reconciliation_required");
    assert.equal(second.source_status, "reconciliation_only");
    assert.equal(second.implementation_allowed, false);
    assert.equal(starts, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("hookless turn observer bootstraps without replay and emits bounded secret-free future observations", () => {
  const fixture = createFixture();
  try {
    const raw = JSON.parse(fs.readFileSync(fixture.policyPath, "utf8"));
    raw.hookless_observer = {
      enabled: true,
      events_path: path.join(fixture.root, "operational-memory", "auto-events.jsonl"),
      state_path: path.join(fixture.root, "operational-memory", "turn-observer-state.json"),
      max_events_per_run: 10,
    };
    const expectedRoot = path.join(os.homedir(), ".codex", "operational-memory");
    raw.hookless_observer.events_path = path.join(expectedRoot, `fixture-${path.basename(fixture.root)}-events.jsonl`);
    raw.hookless_observer.state_path = path.join(expectedRoot, `fixture-${path.basename(fixture.root)}-state.json`);
    raw.hookless_observer.outcomes_dir = path.join(expectedRoot, `fixture-${path.basename(fixture.root)}-outcomes`);
    fs.writeFileSync(fixture.policyPath, JSON.stringify(raw));
    const policy = loadPolicy(fixture.policyPath);
    const ledger = buildLedger(policy, { currentThreadId: "different-thread" });
    const first = recordHooklessTurnObservations(policy, ledger);
    assert.equal(first.bootstrapped, true);
    assert.equal(first.observed, 0);
    assert.equal(first.outcome_receipts_created, 0);
    const state = JSON.parse(fs.readFileSync(policy.hookless_observer.state_path, "utf8"));
    state.watermarks["thread-completed"] = { updated_at_ms: 0, task_completed_count: 0 };
    atomicWriteJson(policy.hookless_observer.state_path, state);
    const second = recordHooklessTurnObservations(policy, ledger);
    assert.equal(second.bootstrapped, false);
    assert.equal(second.observed, 1);
    assert.equal(second.outcome_receipts_created, 1);
    assert.equal(second.outcome_receipts_existing, 0);
    const events = fs.readFileSync(policy.hookless_observer.events_path, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, "turn");
    assert.equal(events[0].raw_prompt_stored, false);
    assert.equal(events[0].raw_transcript_stored, false);
    assert.equal(events[0].business_completion, "unknown");
    assert.deepEqual(events[0].prompt_terms, []);
    assert.equal(JSON.stringify(events[0]).includes("super-secret-value-123456"), false);
    assert.equal(events[0].outcome_id.startsWith("turn:thread-completed:"), true);
    const outcome = JSON.parse(fs.readFileSync(second.outcome_receipt_paths[0], "utf8"));
    assert.equal(fs.statSync(second.outcome_receipt_paths[0]).mode & 0o777, 0o600);
    assert.equal(outcome.schema, "codex_operational_turn_outcome.v1");
    assert.equal(outcome.raw_prompt_stored, false);
    assert.equal(outcome.raw_transcript_stored, false);
    assert.equal(outcome.business_completion, "unknown");
    assert.equal(outcome.same_run, false);
    assert.equal(outcome.external_action_executed, false);
    assert.equal(JSON.stringify(outcome).includes("super-secret-value-123456"), false);

    const replayState = JSON.parse(fs.readFileSync(policy.hookless_observer.state_path, "utf8"));
    replayState.watermarks["thread-completed"] = { updated_at_ms: 0, task_completed_count: 0 };
    atomicWriteJson(policy.hookless_observer.state_path, replayState);
    const replay = recordHooklessTurnObservations(policy, ledger);
    assert.equal(replay.outcome_receipts_created, 0);
    assert.equal(replay.outcome_receipts_existing, 1);
    assert.equal(fs.readdirSync(path.dirname(second.outcome_receipt_paths[0])).length, 1);
    fs.rmSync(policy.hookless_observer.events_path, { force: true });
    fs.rmSync(policy.hookless_observer.state_path, { force: true });
    fs.rmSync(policy.hookless_observer.outcomes_dir, { recursive: true, force: true });
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("archive capability and hook dependencies are absent from the executable service", () => {
  const sourceFiles = [
    new URL("../codex-project-state-sync.mjs", import.meta.url),
    new URL("../lib/codex-project-state.mjs", import.meta.url),
  ];
  const source = sourceFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  assert.equal(source.includes("thread/archive"), false);
  assert.equal(source.includes("--archive-eligible"), false);
  assert.equal(source.includes("archiveEligibleThreads"), false);
  assert.equal(/from\s+["'][^"']*hooks\//u.test(source), false);
  assert.equal(source.includes("CODEX_HOOK_"), false);
});

test("the former archive CLI option is rejected before policy or state access", async () => {
  await assert.rejects(
    () => syncMain(["--archive-eligible"]),
    /codex_project_state_argument_invalid:--archive-eligible/u,
  );
});

test("archive-enabled policy is rejected", () => {
  const fixture = createFixture();
  try {
    const raw = JSON.parse(fs.readFileSync(fixture.policyPath, "utf8"));
    raw.archive = { enabled: true };
    fs.writeFileSync(fixture.policyPath, JSON.stringify(raw));
    assert.throws(() => loadPolicy(fixture.policyPath), /codex_project_state_archive_forbidden/u);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

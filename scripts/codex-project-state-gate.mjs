#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPolicy, readSourceHandoffState } from "./lib/codex-project-state.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--thread-id") { args.threadId = argv[++index]; continue; }
    if (value === "--policy") { args.policy = argv[++index]; continue; }
    throw new Error(`codex_project_state_gate_argument_invalid:${value}`);
  }
  return args;
}

export function evaluateSourceHandoffGate(policy, threadId) {
  const currentThreadId = String(threadId || "").trim();
  if (!currentThreadId) throw new Error("codex_project_state_gate_thread_id_required");
  const state = readSourceHandoffState(policy, currentThreadId);
  return {
    ok: state.implementation_allowed === true,
    schema: "codex_hookless_source_gate.v1",
    current_thread_id: currentThreadId,
    source_status: state.source_status,
    implementation_allowed: state.implementation_allowed,
    destination_thread_id: state.destination_thread_id,
    source_task_visible: state.source_task_visible,
    source_task_archived: state.source_task_archived,
    resume_state: state.source_status === "source_resume_ready"
      ? "ready"
      : state.source_status === "reconciliation_only"
        ? "handoff_gate_active"
        : "not_requested",
    resume_idempotency_key: state.resume_idempotency_key || null,
    handoff_suppressed: state.handoff_suppressed === true,
    handoff_suppression_reason: state.handoff_suppression_reason || null,
    allowed_actions: state.implementation_allowed
      ? ["normal_scoped_work"]
      : ["source_status_readback", "reconciliation", "destination_resume"],
    exact_blocker: state.implementation_allowed
      ? null
      : "source_session_handoff_gate_active",
  };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const policyPath = path.resolve(args.policy || path.join(thisDir, "..", "data", "codex-project-state-policy.json"));
  const policy = loadPolicy(policyPath);
  const result = evaluateSourceHandoffGate(policy, args.threadId || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.implementation_allowed) process.exitCode = 42;
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      schema: "codex_hookless_source_gate.v1",
      implementation_allowed: false,
      exact_blocker: String(error?.message || error).slice(0, 500),
    })}\n`);
    process.exitCode = 1;
  }
}

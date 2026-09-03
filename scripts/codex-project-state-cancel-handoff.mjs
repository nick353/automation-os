#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cancelSourceHandoff,
  loadPolicy,
} from "./lib/codex-project-state.mjs";

function parseArgs(argv) {
  const args = { userRequested: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--thread-id") { args.threadId = argv[++index]; continue; }
    if (value === "--expected-destination-thread-id") { args.expectedDestinationThreadId = argv[++index]; continue; }
    if (value === "--destination-state") { args.destinationState = argv[++index]; continue; }
    if (value === "--external-effect-state") { args.externalEffectState = argv[++index]; continue; }
    if (value === "--reason") { args.reason = argv[++index]; continue; }
    if (value === "--policy") { args.policy = argv[++index]; continue; }
    if (value === "--user-requested") { args.userRequested = true; continue; }
    throw new Error(`codex_project_state_cancel_argument_invalid:${value}`);
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const policyPath = path.resolve(args.policy || path.join(thisDir, "..", "data", "codex-project-state-policy.json"));
  const policy = loadPolicy(policyPath);
  const receipt = cancelSourceHandoff(policy, args.threadId, args);
  const result = {
    ok: true,
    schema: "codex_hookless_handoff_cancellation_result.v1",
    source_thread_id: receipt.source_thread_id,
    destination_thread_id: receipt.destination_thread_id,
    status: receipt.status,
    source_status: receipt.source_status,
    implementation_allowed: receipt.implementation_allowed,
    source_task_archived: receipt.source_task_archived,
    source_task_visible: receipt.source_task_visible,
    handoff_suppressed: true,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      schema: "codex_hookless_handoff_cancellation_result.v1",
      exact_blocker: String(error?.message || error).slice(0, 500),
    })}\n`);
    process.exitCode = 1;
  }
}

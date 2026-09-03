#!/usr/bin/env node

/**
 * Read-only entrypoint for the common current-task resume controller.
 *
 * The hourly audit and a manually requested resume can both call this command
 * with the same fresh readback.  It deliberately does not guess runtime
 * callbacks, open a browser, send a Codex turn, or mutate a provider.  A
 * trusted owner runtime may use the returned plan and inject the callbacks to
 * `resumeCurrentTask` after its own fresh status/authority checks.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createResumeIdempotencyKey,
  jobTaskAdapter,
  selectResumeBlocker,
} from "./lib/resume-controller.mjs";

const ADAPTER_POLICIES = Object.freeze({
  job: {
    sourceThreadOnly: true,
    threadPolicy: "source_thread_only",
    // Normal applications run in the current owner thread through Companion.
    // The signed receipt is only for an explicit destination -> source return.
    handoffPolicy: "source_return_only",
    applicationResumeLane: "direct_application",
    applicationAuthority: "companion_local_owner_run",
    sourceResumeReceipt: "required_only_for_source_return",
  },
  heavy: {
    sourceThreadOnly: false,
    threadPolicy: "current_owner_thread",
    providerGate: "provider_inactive",
  },
  auth: {
    sourceThreadOnly: false,
    threadPolicy: "current_owner_thread",
    humanGate: "human_auth_required",
  },
  note: {
    sourceThreadOnly: false,
    threadPolicy: "current_owner_thread",
    runPolicy: "fresh_owner_run",
  },
});

function parseArgs(argv) {
  const args = { taskType: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--input") { args.input = argv[++index]; continue; }
    if (token === "--task-type") { args.taskType = argv[++index]; continue; }
    if (token === "--output") { args.output = argv[++index]; continue; }
    if (token === "--help" || token === "-h") { args.help = true; continue; }
    throw new Error(`resume_current_task_argument_invalid:${token}`);
  }
  return args;
}

function readInput(file, stdin = "") {
  const raw = file ? fs.readFileSync(path.resolve(file), "utf8") : stdin;
  if (!String(raw || "").trim()) throw new Error("resume_current_task_input_required");
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("resume_current_task_input_json_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("resume_current_task_input_object_required");
  }
  return value;
}

function identityMissing(input) {
  const aliases = {
    taskId: ["taskId", "task_id"],
    generation: ["generation", "runtimeGeneration", "runtime_generation"],
    lastTerminalTurnId: ["lastTerminalTurnId", "last_terminal_turn_id", "lastTerminalTurn", "last_terminal_turn"],
    resumeIntent: ["resumeIntent", "resume_intent", "intent"],
  };
  const missing = Object.entries(aliases)
    .filter(([, keys]) => !keys.some((key) => input[key] !== undefined && input[key] !== null && String(input[key]).trim()))
    .map(([key]) => key);
  const status = input.status ?? input.freshStatus ?? input.fresh_status ?? input.fresh?.status;
  const identity = input.identity ?? input.freshIdentity ?? input.fresh_identity ?? input.fresh?.identity;
  const ownership = input.ownership ?? input.freshOwnership ?? input.fresh_ownership ?? input.fresh?.ownership;
  if (!status || typeof status !== "object" || Array.isArray(status)) missing.push("status");
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) missing.push("identity");
  if (!ownership || typeof ownership !== "object" || Array.isArray(ownership)) missing.push("ownership");
  return missing;
}

function taskType(input, explicit) {
  const value = String(explicit || input.taskType || input.task_type || input.workflow || "").trim().toLowerCase();
  return ADAPTER_POLICIES[value] ? value : "generic";
}

export function buildResumePlan(input, explicitTaskType = null) {
  const missing = identityMissing(input);
  const type = taskType(input, explicitTaskType);
  const adaptedInput = type === "job" ? jobTaskAdapter(input) : input;
  const adapter = ADAPTER_POLICIES[type] || {
    sourceThreadOnly: false,
    threadPolicy: "current_owner_thread",
  };
  const idempotencyKey = createResumeIdempotencyKey(input);
  const selected = missing.length > 0
    ? { reason: "unknown_effect", priority: 0, blocked: true }
    : selectResumeBlocker(adaptedInput);
  const eligible = !selected.blocked;
  return {
    schema: "resume_current_task_plan.v1",
    decision: eligible ? "eligible" : "blocked",
    reason: selected.reason,
    exact_blocker: eligible ? null : selected.reason,
    priority: selected.priority,
    task_type: type,
    adapter,
    task_id: input.taskId ?? input.task_id ?? null,
    source_thread_id: input.sourceThreadId ?? input.source_thread_id ?? input.threadId ?? input.thread_id ?? null,
    generation: input.generation ?? input.runtimeGeneration ?? input.runtime_generation ?? null,
    last_terminal_turn_id: input.lastTerminalTurnId ?? input.last_terminal_turn_id ?? input.lastTerminalTurn ?? input.last_terminal_turn ?? null,
    resume_intent: input.resumeIntent ?? input.resume_intent ?? input.intent ?? null,
    idempotency_key: idempotencyKey,
    identity_complete: missing.length === 0,
    missing_identity_fields: missing,
    source_task_visible: true,
    source_task_archived: false,
    destination_thread_id: input.destinationThreadId ?? input.destination_thread_id ?? null,
    planned_side_effect_order: eligible
      ? ["cleanup_owner_only", "create_fresh_session", "send_thread_continuation"]
      : [],
    same_thread_only: adapter.sourceThreadOnly === true,
    runtime_callbacks_required: eligible,
    owner_only: true,
    ...(type === "job" && adaptedInput.sourceResumeReceiptValid !== null
      ? { source_resume_receipt_valid: adaptedInput.sourceResumeReceiptValid }
      : {}),
    ...(type === "job" && adaptedInput.sourceResumeReceiptError
      ? { source_resume_receipt_error: adaptedInput.sourceResumeReceiptError }
      : {}),
    ...(type === "job"
      ? {
        application_resume_lane: adaptedInput.applicationResumeLane,
        source_return_requested: adaptedInput.sourceReturnRequested,
        source_resume_required: adaptedInput.sourceResumeRequired,
        handoff_metadata_ignored_for_application: adaptedInput.handoffMetadataIgnoredForApplication,
      }
      : {}),
    external_action_executed: false,
    read_only: true,
  };
}

function printHelp() {
  return "Usage: node scripts/resume-current-task.mjs --input <fresh-readback.json> [--task-type job|heavy|auth|note]";
}

export function main(argv = process.argv.slice(2), env = process.env, io = process) {
  const args = parseArgs(argv);
  if (args.help) {
    io.stdout.write(`${printHelp()}\n`);
    return { ok: true, help: true };
  }
  const stdin = env.RESUME_CURRENT_TASK_STDIN || "";
  const input = readInput(args.input, stdin);
  const result = buildResumePlan(input, args.taskType);
  const output = `${JSON.stringify(result)}\n`;
  if (args.output) {
    const destination = path.resolve(args.output);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, output, { mode: 0o600 });
    fs.chmodSync(destination, 0o600);
  }
  io.stdout.write(output);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      schema: "resume_current_task_plan.v1",
      decision: "blocked",
      reason: "unknown_effect",
      exact_blocker: String(error?.message || error).slice(0, 500),
      external_action_executed: false,
      read_only: true,
    })}\n`);
    process.exitCode = 1;
  }
}

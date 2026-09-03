#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPolicy,
  returnCompletedNoOutputHandoff,
  resumeSourceHandoff,
} from "./lib/codex-project-state.mjs";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--thread-id") { args.threadId = argv[++index]; continue; }
    if (value === "--expected-destination-thread-id") { args.expectedDestinationThreadId = argv[++index]; continue; }
    if (value === "--destination-state") { args.destinationState = argv[++index]; continue; }
    if (value === "--external-effect-state") { args.externalEffectState = argv[++index]; continue; }
    if (value === "--reconciliation-state") { args.reconciliationState = argv[++index]; continue; }
    if (value === "--owner-task-id") { args.ownerTaskId = argv[++index]; continue; }
    if (value === "--generation") { args.generation = argv[++index]; continue; }
    if (value === "--expected-generation") { args.expectedGeneration = argv[++index]; continue; }
    if (value === "--authority-digest") { args.authorityDigest = argv[++index]; continue; }
    if (value === "--idempotency-key") { args.idempotencyKey = argv[++index]; continue; }
    if (value === "--last-terminal-turn-id") { args.lastTerminalTurnId = argv[++index]; continue; }
    if (value === "--reason") { args.reason = argv[++index]; continue; }
    if (value === "--policy") { args.policy = argv[++index]; continue; }
    if (value === "--owner-proof-env") { args.ownerProofEnv = argv[++index]; continue; }
    if (value === "--owner-secret-env") { args.ownerSecretEnv = argv[++index]; continue; }
    if (value === "--destination-no-output-proof-env") { args.destinationNoOutputProofEnv = argv[++index]; continue; }
    if (value === "--destination-owner-task-id") { args.destinationOwnerTaskId = argv[++index]; continue; }
    if (value === "--companion-effect-proof-env") { args.companionEffectProofEnv = argv[++index]; continue; }
    if (value === "--companion-effect-proof-secret-env") { args.companionEffectProofSecretEnv = argv[++index]; continue; }
    if (value === "--completed-no-output") { args.completedNoOutput = true; continue; }
    throw new Error(`codex_project_state_resume_source_argument_invalid:${value}`);
  }
  return args;
}

function readOwnerProof(env, name) {
  const raw = env[name];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { throw new Error("codex_source_resume_owner_proof_json_invalid"); }
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const policyPath = path.resolve(args.policy || path.join(thisDir, "..", "data", "codex-project-state-policy.json"));
  const policy = loadPolicy(policyPath);
  const ownerProofEnv = args.ownerProofEnv || "CODEX_RESUME_OWNER_PROOF";
  const ownerSecretEnv = args.ownerSecretEnv || "CODEX_RESUME_OWNER_SECRET";
  const threadId = args.threadId || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID;
  const destinationNoOutputProofEnv = args.destinationNoOutputProofEnv || "CODEX_DESTINATION_NO_OUTPUT_PROOF";
  const destinationNoOutputProof = readOwnerProof(env, destinationNoOutputProofEnv);
  const companionEffectProofEnv = args.companionEffectProofEnv || "CODEX_COMPANION_EFFECT_PROOF";
  const companionEffectProof = readOwnerProof(env, companionEffectProofEnv);
  const companionEffectProofSecretEnv = args.companionEffectProofSecretEnv || "CODEX_COMPANION_EFFECT_PROOF_SECRET";
  const common = {
    expectedDestinationThreadId: args.expectedDestinationThreadId,
    destinationState: args.destinationState,
    externalEffectState: args.externalEffectState,
    reconciliationState: args.reconciliationState,
    ownerTaskId: args.ownerTaskId || env.CODEX_THREAD_ID || env.CODEX_SESSION_ID,
    ownerProof: readOwnerProof(env, ownerProofEnv),
    ownerSecret: env[ownerSecretEnv],
    generation: args.generation,
    expectedGeneration: args.expectedGeneration ?? null,
    authorityDigest: args.authorityDigest,
    idempotencyKey: args.idempotencyKey,
    lastTerminalTurnId: args.lastTerminalTurnId,
    reason: args.reason,
  };
  const receipt = args.completedNoOutput || destinationNoOutputProof
    ? returnCompletedNoOutputHandoff(policy, threadId, {
      ...common,
      destinationNoOutputProof,
    destinationOwnerTaskId: args.destinationOwnerTaskId,
      companionEffectProof,
      companionEffectProofSecret: env[companionEffectProofSecretEnv],
    })
    : resumeSourceHandoff(policy, threadId, {
      ...common,
      companionEffectProof,
      companionEffectProofSecret: env[companionEffectProofSecretEnv],
    });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    schema: "codex_source_resume_result.v1",
    status: receipt.status,
    source_status: receipt.source_status,
    implementation_allowed: receipt.implementation_allowed,
    source_thread_id: receipt.source_thread_id,
    destination_thread_id: receipt.destination_thread_id,
    source_task_archived: receipt.source_task_archived,
    source_task_visible: receipt.source_task_visible,
    resume_idempotency_key: receipt.resume_idempotency_key,
    handoff_suppressed: receipt.handoff_suppressed === true,
    owner_proof_verified: receipt.resume_authority?.proof_verified === true,
    destination_no_output_verified: receipt.destination_no_output_verified === true,
  })}\n`);
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      schema: "codex_source_resume_result.v1",
      exact_blocker: String(error?.message || error).slice(0, 500),
      source_task_archived: false,
      source_task_visible: true,
    })}\n`);
    process.exitCode = 1;
  }
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  BLOCKER_PRIORITY,
  authTaskAdapter,
  createResumeIdempotencyKey,
  heavyTaskAdapter,
  jobTaskAdapter,
  normalizeBlockerReason,
  noteTaskAdapter,
  prepareJobSourceResume,
  resumeCurrentTask,
} from "../lib/resume-controller.mjs";

function baseInput(overrides = {}) {
  return {
    taskId: "task-resume-test",
    generation: "generation-1",
    lastTerminalTurnId: "turn-terminal-1",
    resumeIntent: "continue-current-task",
    sourceThreadId: "thread-source-1",
    status: {
      unknown_effect: false,
      active_reconciliation: false,
      provider_inactive: false,
      handoff_gate_active: false,
      stale_owner_recoverable: false,
    },
    identity: { ownerId: "owner-1" },
    ownership: { owned: true, ownerId: "owner-1" },
    ...overrides,
  };
}

function deps(events = [], processedKeys = new Set()) {
  return {
    processedKeys,
    cleanupOwnerOnly(payload) {
      events.push(["cleanup", payload.stage, payload.ownerOnly]);
      return { status: "ok", receipt: "cleanup" };
    },
    createFreshSession(payload) {
      events.push(["session", payload.stage, payload.freshSession]);
      return { sessionId: "session-fresh-1", generation: "generation-1" };
    },
    sendThreadContinuation(payload) {
      events.push(["continuation", payload.stage, payload.threadId, payload.sameThread]);
      return { status: "sent", threadId: payload.threadId };
    },
  };
}

test("blocker normalization chooses the documented single reason by priority", () => {
  assert.deepEqual(BLOCKER_PRIORITY, [
    "unknown_effect",
    "foreign_owner",
    "active_reconciliation",
    "human_auth_required",
    "provider_inactive",
    "handoff_gate_active",
    "stale_owner_recoverable",
    "ready",
  ]);

  const signals = [
    ["unknown_effect", { status: { unknown_effect: true } }],
    ["foreign_owner", { ownership: { owned: false } }],
    ["active_reconciliation", { status: { active_reconciliation: true } }],
    ["human_auth_required", { status: { human_auth_required: true } }],
    ["provider_inactive", { status: { provider_inactive: true } }],
    ["handoff_gate_active", { status: { handoff_gate_active: true } }],
    ["stale_owner_recoverable", { status: { stale_owner_recoverable: true } }],
    ["ready", { status: { ready: true }, ownership: { owned: true } }],
  ];
  for (const [expected, input] of signals) assert.equal(normalizeBlockerReason(input), expected);

  assert.equal(normalizeBlockerReason({
    status: { provider_inactive: true, human_auth_required: true, unknown_effect: true },
    ownership: { owned: false },
  }), "unknown_effect");
  assert.equal(normalizeBlockerReason({
    status: { provider_inactive: true, human_auth_required: true },
    ownership: { owned: false },
  }), "foreign_owner");

  // Positive readback fields mean the gate is healthy; they must not create a
  // blocker merely because their names contain "effect" or "provider".
  assert.equal(normalizeBlockerReason({
    status: { effectKnown: true, providerActive: true },
    ownership: { owned: true },
  }), "ready");
  assert.equal(normalizeBlockerReason({
    status: { effectResolved: true, provider_active: true },
    ownership: { owned: true },
  }), "ready");
  assert.equal(normalizeBlockerReason({
    status: { effectKnown: false },
    ownership: { owned: true },
  }), "unknown_effect");
  assert.equal(normalizeBlockerReason({
    status: { providerActive: false },
    ownership: { owned: true },
  }), "provider_inactive");
  assert.equal(normalizeBlockerReason({
    status: "active",
    identity: { ownerId: "owner-1" },
    ownership: { owned: true },
  }), "ready");
  assert.equal(normalizeBlockerReason({
    status: "pending",
    identity: { ownerId: "owner-1" },
    ownership: { owned: true },
  }), "ready");
  assert.equal(normalizeBlockerReason({
    status: { status: "pending", kind: "reconciliation" },
    identity: { ownerId: "owner-1" },
    ownership: { owned: true },
  }), "active_reconciliation");
  assert.equal(normalizeBlockerReason({
    status: { external_effect_state: "unknown" },
    identity: { ownerId: "owner-1" },
    ownership: { owned: true },
  }), "unknown_effect");
});

test("resume idempotency key is deterministic and changes when an identity part changes", () => {
  const input = baseInput();
  const first = createResumeIdempotencyKey(input);
  const second = createResumeIdempotencyKey({ ...input, status: { unknown_effect: false } });
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/u);
  assert.equal(first, createHash("sha256").update(JSON.stringify({
    generation: input.generation,
    lastTerminalTurnId: input.lastTerminalTurnId,
    resumeIntent: input.resumeIntent,
    taskId: input.taskId,
  })).digest("hex"));
  assert.notEqual(first, createResumeIdempotencyKey({ ...input, generation: "generation-2" }));
  assert.notEqual(first, createResumeIdempotencyKey({ ...input, resumeIntent: "inspect-only" }));
});

test("blocked fresh readback returns a receipt without invoking side-effect callbacks", async () => {
  const events = [];
  const input = baseInput({ status: { unknown_effect: true }, ownership: { owned: false } });
  const result = await resumeCurrentTask(input, deps(events));
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "unknown_effect");
  assert.equal(result.external_action_executed, false);
  assert.deepEqual(result.sideEffects, []);
  assert.deepEqual(events, []);
});

test("incomplete status, identity, or ownership readback never reaches callbacks", async () => {
  const events = [];
  const result = await resumeCurrentTask({
    taskId: "task-resume-test",
    generation: "generation-1",
    lastTerminalTurnId: "turn-terminal-1",
    resumeIntent: "continue-current-task",
    status: {},
  }, deps(events));
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "unknown_effect");
  assert.deepEqual(result.missing_readback, ["identity", "ownership"]);
  assert.deepEqual(events, []);
});

test("ready resume performs owner cleanup, fresh session, and same-thread continuation in order", async () => {
  const events = [];
  const result = await resumeCurrentTask(baseInput(), deps(events));
  assert.equal(result.status, "resumed");
  assert.equal(result.reason, "ready");
  assert.deepEqual(result.sideEffects, ["cleanup_owner_only", "create_fresh_session", "send_thread_continuation"]);
  assert.deepEqual(events, [
    ["cleanup", "cleanup_owner_only", true],
    ["session", "create_fresh_session", true],
    ["continuation", "send_thread_continuation", "thread-source-1", true],
  ]);
});

test("a source-resumed Job uses the same bounded sequence without inventing a destination", async () => {
  const events = [];
  const result = await resumeCurrentTask(jobTaskAdapter(baseInput({ sourceThreadId: "thread-job" })), deps(events));
  assert.equal(result.status, "resumed");
  assert.deepEqual(events[2], ["continuation", "send_thread_continuation", "thread-job", true]);
});

test("a repeated ready key is a no-op and does not repeat any callback", async () => {
  const events = [];
  const sharedDeps = deps(events);
  const input = baseInput();
  const first = await resumeCurrentTask(input, sharedDeps);
  const second = await resumeCurrentTask(input, sharedDeps);
  assert.equal(first.status, "resumed");
  assert.equal(second.status, "noop");
  assert.equal(second.reason, "idempotency_noop");
  assert.equal(events.length, 3);
});

test("task adapters preserve the safety-specific resume boundary", () => {
  const job = jobTaskAdapter({ sourceThreadId: "thread-job" });
  assert.equal(job.sourceThreadOnly, true);
  assert.equal(job.threadPolicy, "source_thread_only");
  assert.equal(job.threadId, "thread-job");
  assert.equal(job.applicationResumeLane, "direct_application");
  assert.equal(job.sourceResumeRequired, false);
  assert.equal(job.handoffMetadataIgnoredForApplication, true);
  // A stale source-return field must not stop an ordinary Companion
  // application in the current owner thread.
  const direct = jobTaskAdapter({ sourceThreadId: "thread-job", implementation_allowed: false });
  assert.equal(direct.handoffGateActive, false);
  assert.equal(normalizeBlockerReason(direct), "ready");
  assert.equal(normalizeBlockerReason(jobTaskAdapter({ sourceThreadId: "thread-job", source_status: "source_resume_ready" })), "ready");
  assert.equal(normalizeBlockerReason({ source_status: "reconciliation_only", implementation_allowed: false }), "handoff_gate_active");

  // The same metadata remains a blocker when the caller explicitly requests
  // the source-return lane.
  const sourceReturn = jobTaskAdapter({
    sourceThreadId: "thread-job",
    source_status: "handoff_active",
    implementation_allowed: false,
    resumeIntent: "return_no_output_to_source",
  });
  assert.equal(sourceReturn.applicationResumeLane, "source_return");
  assert.equal(sourceReturn.sourceResumeRequired, true);
  assert.equal(normalizeBlockerReason(sourceReturn), "handoff_gate_active");

  // An old source-return intent can be present in a copied readback.  The
  // current caller may explicitly select the normal Companion lane without
  // changing or deleting that historical context.
  const explicitDirect = jobTaskAdapter({
    sourceThreadId: "thread-job",
    source_status: "handoff_completed",
    implementation_allowed: false,
    resumeIntent: "return_no_output_to_source",
    applicationResumeLane: "direct_application",
  });
  assert.equal(explicitDirect.applicationResumeLane, "direct_application");
  assert.equal(explicitDirect.sourceResumeRequired, false);
  assert.equal(normalizeBlockerReason(explicitDirect), "ready");

  // Direct applications still stop for real effect uncertainty; only the
  // unrelated handoff gate is ignored.
  assert.equal(normalizeBlockerReason(jobTaskAdapter({
    sourceThreadId: "thread-job",
    implementation_allowed: false,
    status: { unknown_effect: true },
  })), "unknown_effect");

  assert.equal(normalizeBlockerReason(heavyTaskAdapter()), "provider_inactive");
  assert.equal(normalizeBlockerReason(authTaskAdapter()), "human_auth_required");
  assert.equal(normalizeBlockerReason(heavyTaskAdapter({ providerActive: true })), "ready");
  assert.equal(normalizeBlockerReason(authTaskAdapter({ authenticated: true })), "ready");

  const note = noteTaskAdapter({ taskId: "note-1", generation: "generation-note", sourceThreadId: "thread-note" });
  assert.equal(note.freshOwnerRun, true);
  assert.equal(note.ownerOnly, true);
  assert.deepEqual(note.ownerRun, {
    taskId: "note-1",
    task_id: "note-1",
    generation: "generation-note",
    sourceThreadId: "thread-note",
    source_thread_id: "thread-note",
    ownerOnly: true,
    owner_only: true,
    fresh: true,
    freshOwnerRun: true,
    fresh_owner_run: true,
  });
});

test("Job source resume requires a fresh source-only admission receipt when requested", () => {
  const handoffReceipt = {
    schema: "codex_hookless_handoff_receipt.v1",
    status: "returned_to_source",
    source_status: "source_resume_ready",
    implementation_allowed: true,
    source_thread_id: "thread-job",
    destination_thread_id: "thread-destination",
    resume_idempotency_key: "resume-key-1",
    resume_authority: { proof_verified: true },
  };
  const adapter = prepareJobSourceResume({
    sourceThreadId: "thread-job",
    handoffReceipt,
  }, {
    runId: "job-run-fresh-1",
    idempotencyKey: "job-idempotency-1",
  });
  assert.equal(adapter.handoffGateActive, false);
  assert.equal(adapter.sourceResumeReceiptValid, true);
  assert.equal(adapter.sourceResumeReceipt.source_thread_only, true);
  assert.equal(adapter.sourceResumeReceipt.destination_continuation_allowed, false);
  assert.equal(adapter.sourceResumeReceipt.external_action_executed, false);
  assert.equal(adapter.sourceResumeReceipt.application_submitted, false);
  assert.equal(adapter.sourceResumeReceipt.sheet_write_performed, false);
  assert.equal(adapter.sourceResumeReceipt.run_id, "job-run-fresh-1");
  assert.equal(adapter.sourceResumeReceipt.idempotency_key, "job-idempotency-1");

  const blocked = jobTaskAdapter({
    sourceThreadId: "thread-job",
    sourceStatus: "source_resume_ready",
    implementationAllowed: true,
    requireSourceResumeReceipt: true,
  });
  assert.equal(blocked.sourceResumeReceiptValid, null);
  assert.equal(blocked.applicationResumeLane, "source_return");
  assert.equal(normalizeBlockerReason(blocked), "handoff_gate_active");
});

test("Job source resume rejects a receipt that invents destination continuation or effects", () => {
  const invalid = jobTaskAdapter({
    sourceThreadId: "thread-job",
    sourceStatus: "source_resume_ready",
    implementationAllowed: true,
    requireSourceResumeReceipt: true,
    sourceResumeReceipt: {
      schema: "aos.job.source_resume_receipt.v1",
      status: "ready",
      task_type: "job",
      source_thread_id: "thread-job",
      owner_task_id: "thread-job",
      source_thread_only: true,
      destination_continuation_allowed: true,
      destination_continuation_dispatched: false,
      external_action_executed: false,
      application_submitted: false,
      sheet_write_performed: false,
      owner_proof_verified: true,
    },
  });
  assert.equal(invalid.sourceResumeReceiptValid, false);
  assert.equal(invalid.sourceResumeReceiptError, "aos_job_source_resume_destination_continuation_forbidden");
  assert.equal(invalid.applicationResumeLane, "source_return");
  assert.equal(normalizeBlockerReason(invalid), "handoff_gate_active");
});

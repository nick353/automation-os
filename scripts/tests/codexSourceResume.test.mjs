import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  evaluateSourceHandoffGate,
} from "../codex-project-state-gate.mjs";
import {
  resumeSourceHandoff,
  returnCompletedNoOutputHandoff,
  signDestinationNoOutputProof,
  signSourceResumeAuthority,
  sourceResumeIdempotencyKey,
} from "../lib/codex-project-state.mjs";

function fixture() {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-source-resume."));
  const source = "source-thread";
  const destination = "destination-thread";
  fs.mkdirSync(path.join(outputDir, "handoff-claims"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(outputDir, "handoff-receipts"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(outputDir, "handoff-claims", `${source}.json`), JSON.stringify({
    schema: "codex_hookless_handoff_claim.v1",
    source_thread_id: source,
    destination_thread_id: destination,
    state: "continuation_dispatched",
    generation: "gen-1",
    authority_digest: "a".repeat(64),
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(outputDir, "handoff-receipts", `${source}.json`), JSON.stringify({
    schema: "codex_hookless_handoff_receipt.v1",
    status: "reconciliation_required",
    source_status: "reconciliation_only",
    implementation_allowed: false,
    source_thread_id: source,
    destination_thread_id: destination,
    destination_ready: false,
    generation: "gen-1",
    authority_digest: "a".repeat(64),
  }), { mode: 0o600 });
  return { outputDir, source, destination, policy: { output_dir: outputDir } };
}

test("returns an existing handoff to the source only with a matching owner proof", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.outputDir, { recursive: true, force: true }));
  const idempotencyKey = sourceResumeIdempotencyKey({ sourceThreadId: f.source, generation: "gen-1", lastTerminalTurnId: "turn-1" });
  const proof = signSourceResumeAuthority({
    sourceThreadId: f.source,
    ownerTaskId: f.source,
    destinationThreadId: f.destination,
    generation: "gen-1",
    authorityDigest: "a".repeat(64),
    idempotencyKey,
  }, "test-owner-secret");
  const receipt = resumeSourceHandoff(f.policy, f.source, {
    expectedDestinationThreadId: f.destination,
    destinationState: "idle_interrupted",
    externalEffectState: "observed_false",
    reconciliationState: "clear",
    ownerTaskId: f.source,
    ownerProof: proof,
    ownerSecret: "test-owner-secret",
    generation: "gen-1",
    authorityDigest: "a".repeat(64),
    idempotencyKey,
  });
  assert.equal(receipt.status, "returned_to_source");
  assert.equal(receipt.source_status, "source_resume_ready");
  assert.equal(receipt.implementation_allowed, true);
  assert.equal(receipt.handoff_suppressed, true);
  assert.equal(receipt.resume_authority.proof_verified, true);
  assert.equal("signature" in receipt.resume_authority, false);
  assert.equal(receipt.source_task_archived, false);
  assert.equal(receipt.source_task_visible, true);
  const gate = evaluateSourceHandoffGate(f.policy, f.source);
  assert.equal(gate.implementation_allowed, true);
  assert.equal(gate.source_status, "source_resume_ready");
  assert.equal(gate.resume_state, "ready");
  assert.equal(gate.resume_idempotency_key, idempotencyKey);
  assert.equal(gate.handoff_suppression_reason, "returned_to_source");

  const replay = resumeSourceHandoff(f.policy, f.source, {
    expectedDestinationThreadId: f.destination,
    destinationState: "idle_interrupted",
    externalEffectState: "observed_false",
    reconciliationState: "clear",
    ownerTaskId: f.source,
    ownerProof: proof,
    ownerSecret: "test-owner-secret",
    generation: "gen-1",
    authorityDigest: "a".repeat(64),
    idempotencyKey,
  });
  assert.equal(replay.returned_to_source_at, receipt.returned_to_source_at);
});

test("source return fails closed for ownership, destination, effect, and signature mismatches", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.outputDir, { recursive: true, force: true }));
  const idempotencyKey = sourceResumeIdempotencyKey({ sourceThreadId: f.source, generation: "gen-1" });
  const proof = signSourceResumeAuthority({
    sourceThreadId: f.source,
    ownerTaskId: f.source,
    destinationThreadId: f.destination,
    generation: "gen-1",
    authorityDigest: "a".repeat(64),
    idempotencyKey,
  }, "test-owner-secret");
  assert.throws(() => resumeSourceHandoff(f.policy, f.source, {
    expectedDestinationThreadId: f.destination,
    destinationState: "idle_interrupted",
    externalEffectState: "observed_false",
    reconciliationState: "clear",
    ownerTaskId: "foreign-thread",
    ownerProof: proof,
    ownerSecret: "test-owner-secret",
    idempotencyKey,
  }), /owner_task_mismatch/);
  assert.throws(() => resumeSourceHandoff(f.policy, f.source, {
    expectedDestinationThreadId: f.destination,
    destinationState: "active",
    externalEffectState: "observed_false",
    reconciliationState: "clear",
    ownerTaskId: f.source,
    ownerProof: proof,
    ownerSecret: "test-owner-secret",
    idempotencyKey,
  }), /destination_not_terminal/);
  assert.throws(() => resumeSourceHandoff(f.policy, f.source, {
    expectedDestinationThreadId: f.destination,
    destinationState: "idle_interrupted",
    externalEffectState: "unknown",
    reconciliationState: "clear",
    ownerTaskId: f.source,
    ownerProof: proof,
    ownerSecret: "test-owner-secret",
    idempotencyKey,
  }), /external_effect_reconciliation_required/);
  assert.throws(() => resumeSourceHandoff(f.policy, f.source, {
    expectedDestinationThreadId: f.destination,
    destinationState: "idle_interrupted",
    externalEffectState: "observed_false",
    reconciliationState: "clear",
    ownerTaskId: f.source,
    ownerProof: { ...proof, signature: "0".repeat(64) },
    ownerSecret: "test-owner-secret",
    idempotencyKey,
  }), /signature_invalid/);
});

test("a crash after return_requested is recoverable with the same signed key", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.outputDir, { recursive: true, force: true }));
  const idempotencyKey = sourceResumeIdempotencyKey({ sourceThreadId: f.source, generation: "gen-1" });
  const proof = signSourceResumeAuthority({
    sourceThreadId: f.source,
    ownerTaskId: f.source,
    destinationThreadId: f.destination,
    generation: "gen-1",
    authorityDigest: "a".repeat(64),
    idempotencyKey,
  }, "test-owner-secret");
  const receiptPath = path.join(f.outputDir, "handoff-receipts", `${f.source}.json`);
  const pending = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  pending.status = "return_requested";
  pending.resume_idempotency_key = idempotencyKey;
  fs.writeFileSync(receiptPath, JSON.stringify(pending), { mode: 0o600 });
  const recovered = resumeSourceHandoff(f.policy, f.source, {
    expectedDestinationThreadId: f.destination,
    destinationState: "idle_interrupted",
    externalEffectState: "observed_false",
    reconciliationState: "clear",
    ownerTaskId: f.source,
    ownerProof: proof,
    ownerSecret: "test-owner-secret",
    idempotencyKey,
  });
  assert.equal(recovered.status, "returned_to_source");
  assert.equal(recovered.resume_idempotency_key, idempotencyKey);
});

test("completed destination with a signed no-output readback returns to the source", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.outputDir, { recursive: true, force: true }));
  const claimPath = path.join(f.outputDir, "handoff-claims", `${f.source}.json`);
  const receiptPath = path.join(f.outputDir, "handoff-receipts", `${f.source}.json`);
  fs.writeFileSync(claimPath, JSON.stringify({
    schema: "codex_hookless_handoff_claim.v1",
    source_thread_id: f.source,
    destination_thread_id: f.destination,
    state: "completed",
    generation: "gen-1",
    authority_digest: "a".repeat(64),
  }), { mode: 0o600 });
  fs.writeFileSync(receiptPath, JSON.stringify({
    schema: "codex_hookless_handoff_receipt.v1",
    status: "completed",
    source_status: "handoff_completed",
    implementation_allowed: false,
    source_thread_id: f.source,
    destination_thread_id: f.destination,
    destination_ready: true,
    continuation_dispatched: true,
    continuation_turn_id: "destination-turn",
    continuation_status: "completed",
    generation: "gen-1",
    authority_digest: "a".repeat(64),
  }), { mode: 0o600 });
  const idempotencyKey = sourceResumeIdempotencyKey({ sourceThreadId: f.source, generation: "gen-1", lastTerminalTurnId: "destination-turn", resumeIntent: "return_no_output_to_source" });
  const sourceProof = signSourceResumeAuthority({
    sourceThreadId: f.source,
    ownerTaskId: f.source,
    destinationThreadId: f.destination,
    generation: "gen-1",
    authorityDigest: "a".repeat(64),
    idempotencyKey,
  }, "test-owner-secret");
  const destinationProof = signDestinationNoOutputProof({
    sourceThreadId: f.source,
    destinationThreadId: f.destination,
    ownerTaskId: f.destination,
    continuationTurnId: "destination-turn",
    destinationState: "idle_interrupted",
    turnStatus: "completed",
    outputState: "no_output",
    assistantItemCount: 0,
    externalEffectState: "observed_false",
    reconciliationState: "clear",
    generation: "gen-1",
    authorityDigest: "a".repeat(64),
    readbackDigest: "d".repeat(64),
    idempotencyKey,
  }, "test-owner-secret");
  const returned = returnCompletedNoOutputHandoff(f.policy, f.source, {
    expectedDestinationThreadId: f.destination,
    destinationNoOutputProof: destinationProof,
    ownerTaskId: f.source,
    ownerProof: sourceProof,
    ownerSecret: "test-owner-secret",
    generation: "gen-1",
    authorityDigest: "a".repeat(64),
    idempotencyKey,
  });
  assert.equal(returned.status, "returned_to_source");
  assert.equal(returned.source_status, "source_resume_ready");
  assert.equal(returned.implementation_allowed, true);
  assert.equal(returned.destination_no_output_verified, true);
  assert.equal(returned.destination_ready, false);
  assert.equal(returned.handoff_suppression_reason, "destination_no_output_returned_to_source");
  assert.equal(returned.destination_no_output_proof.signature, undefined);
  const gate = evaluateSourceHandoffGate(f.policy, f.source);
  assert.equal(gate.implementation_allowed, true);
  assert.equal(gate.resume_state, "ready");
  assert.equal(gate.resume_idempotency_key, idempotencyKey);
  const replay = returnCompletedNoOutputHandoff(f.policy, f.source, {
    expectedDestinationThreadId: f.destination,
    destinationNoOutputProof: destinationProof,
    ownerTaskId: f.source,
    ownerProof: sourceProof,
    ownerSecret: "test-owner-secret",
    generation: "gen-1",
    authorityDigest: "a".repeat(64),
    idempotencyKey,
  });
  assert.equal(replay.returned_to_source_at, returned.returned_to_source_at);
});

test("no-output return rejects output-bearing or unsigned destination readbacks", (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.outputDir, { recursive: true, force: true }));
  const claimPath = path.join(f.outputDir, "handoff-claims", `${f.source}.json`);
  const receiptPath = path.join(f.outputDir, "handoff-receipts", `${f.source}.json`);
  fs.writeFileSync(claimPath, JSON.stringify({ schema: "codex_hookless_handoff_claim.v1", source_thread_id: f.source, destination_thread_id: f.destination, state: "completed", generation: "gen-1", authority_digest: "a".repeat(64) }), { mode: 0o600 });
  fs.writeFileSync(receiptPath, JSON.stringify({ schema: "codex_hookless_handoff_receipt.v1", status: "completed", source_thread_id: f.source, destination_thread_id: f.destination, destination_ready: true, continuation_turn_id: "destination-turn", generation: "gen-1", authority_digest: "a".repeat(64) }), { mode: 0o600 });
  const key = sourceResumeIdempotencyKey({ sourceThreadId: f.source, generation: "gen-1", lastTerminalTurnId: "destination-turn", resumeIntent: "return_no_output_to_source" });
  const sourceProof = signSourceResumeAuthority({ sourceThreadId: f.source, ownerTaskId: f.source, destinationThreadId: f.destination, generation: "gen-1", authorityDigest: "a".repeat(64), idempotencyKey: key }, "test-owner-secret");
  const outputProof = signDestinationNoOutputProof({ sourceThreadId: f.source, destinationThreadId: f.destination, ownerTaskId: f.destination, continuationTurnId: "destination-turn", destinationState: "idle_interrupted", turnStatus: "completed", outputState: "no_output", assistantItemCount: 0, externalEffectState: "observed_false", reconciliationState: "clear", generation: "gen-1", authorityDigest: "a".repeat(64), readbackDigest: "d".repeat(64), idempotencyKey: key }, "test-owner-secret");
  assert.throws(() => returnCompletedNoOutputHandoff(f.policy, f.source, { expectedDestinationThreadId: f.destination, destinationNoOutputProof: { ...outputProof, assistant_item_count: 1 }, ownerTaskId: f.source, ownerProof: sourceProof, ownerSecret: "test-owner-secret", generation: "gen-1", authorityDigest: "a".repeat(64), idempotencyKey: key }), /assistant_item_count_mismatch|output_present/u);
  assert.throws(() => returnCompletedNoOutputHandoff(f.policy, f.source, { expectedDestinationThreadId: f.destination, destinationNoOutputProof: { ...outputProof, signature: "0".repeat(64) }, ownerTaskId: f.source, ownerProof: sourceProof, ownerSecret: "test-owner-secret", generation: "gen-1", authorityDigest: "a".repeat(64), idempotencyKey: key }), /proof_signature_invalid/u);
});

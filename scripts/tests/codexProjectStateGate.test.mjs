import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateSourceHandoffGate } from "../codex-project-state-gate.mjs";
import { cancelSourceHandoff } from "../lib/codex-project-state.mjs";

test("source handoff gate allows active tasks and blocks implementation after destination claim", (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-source-gate."));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const policy = { output_dir: outputDir };

  const active = evaluateSourceHandoffGate(policy, "active-thread");
  assert.equal(active.implementation_allowed, true);
  assert.equal(active.source_status, "active");

  const claimsDir = path.join(outputDir, "handoff-claims");
  fs.mkdirSync(claimsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(claimsDir, "source-thread.json"), JSON.stringify({
    schema: "codex_hookless_handoff_claim.v1",
    source_thread_id: "source-thread",
    destination_thread_id: "destination-thread",
    state: "destination_created",
  }), { mode: 0o600 });
  const claimed = evaluateSourceHandoffGate(policy, "source-thread");
  assert.equal(claimed.implementation_allowed, false);
  assert.equal(claimed.source_status, "reconciliation_only");
  assert.equal(claimed.destination_thread_id, "destination-thread");
  assert.equal(claimed.exact_blocker, "source_session_handoff_gate_active");

  const receiptsDir = path.join(outputDir, "handoff-receipts");
  fs.mkdirSync(receiptsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(receiptsDir, "completed-source.json"), JSON.stringify({
    schema: "codex_hookless_handoff_receipt.v1",
    status: "completed",
    source_thread_id: "completed-source",
    destination_thread_id: "completed-destination",
  }), { mode: 0o600 });
  const completed = evaluateSourceHandoffGate(policy, "completed-source");
  assert.equal(completed.implementation_allowed, false);
  assert.equal(completed.source_status, "handoff_completed");
  assert.equal(completed.destination_thread_id, "completed-destination");
});

test("an explicit no-effect user cancellation reactivates the source and suppresses another handoff", (t) => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-source-cancel."));
  t.after(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const policy = { output_dir: outputDir };
  const sourceThreadId = "source-thread";
  const destinationThreadId = "destination-thread";
  const claimsDir = path.join(outputDir, "handoff-claims");
  const receiptsDir = path.join(outputDir, "handoff-receipts");
  fs.mkdirSync(claimsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(receiptsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(claimsDir, `${sourceThreadId}.json`), JSON.stringify({
    schema: "codex_hookless_handoff_claim.v1",
    source_thread_id: sourceThreadId,
    destination_thread_id: destinationThreadId,
    state: "continuation_dispatched",
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(receiptsDir, `${sourceThreadId}.json`), JSON.stringify({
    schema: "codex_hookless_handoff_receipt.v1",
    status: "reconciliation_required",
    source_status: "reconciliation_only",
    implementation_allowed: false,
    source_thread_id: sourceThreadId,
    destination_thread_id: destinationThreadId,
    destination_ready: false,
  }), { mode: 0o600 });

  const receipt = cancelSourceHandoff(policy, sourceThreadId, {
    expectedDestinationThreadId: destinationThreadId,
    destinationState: "idle_interrupted",
    externalEffectState: "observed_false",
    userRequested: true,
    reason: "Continue here without handoff.",
  });
  assert.equal(receipt.status, "cancelled_by_user");
  assert.equal(receipt.implementation_allowed, true);

  const gate = evaluateSourceHandoffGate(policy, sourceThreadId);
  assert.equal(gate.source_status, "active");
  assert.equal(gate.implementation_allowed, true);
  assert.equal(gate.handoff_suppressed, true);
  assert.equal(gate.handoff_suppression_reason, "cancelled_by_user");
});

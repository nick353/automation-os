import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateCanaryReceipts } from "../browserUseCanaryReceipt.mjs";

const runId = "automation-os-iab-p5-browser-use-test";
const requestedSession = "automation-os-iab-automation-os-iab-p5-browser-use-test";
const effectiveSession = "automation-os-iab-automa-test";

function receiptFile(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-use-receipt-test-"));
  const file = path.join(dir, "receipt.json");
  const receipt = {
    schema: "browser-use-receipt.v1",
    run_id: runId,
    requested_session: requestedSession,
    session: effectiveSession,
    port: 19980,
    pid: 12345,
    start_time: "2026-07-27T00:00:00Z",
    finalized: true,
    authority_summary: { side_effect_scope: "bounded_recording" },
    exit: { code: 0, exact_blocker: null },
    paths: { profile: `/Users/nichikatanaka/.browser-use-cli/profiles/single-use/${runId}-uuid` },
    cleanup: { status: "cleaned", profile_removed: true, download_dir_removed: true, locks_removed: ["profile", "port"], locks_retained: [] },
    guard_readback: { preflight: true, post_command_state_readback: true },
    ...overrides,
  };
  fs.writeFileSync(file, `${JSON.stringify(receipt)}\n`);
  return file;
}

function validate(receipts, finalPath) {
  return validateCanaryReceipts({
    receipts,
    expectedRunId: runId,
    expectedRequestedSession: requestedSession,
    expectedEffectiveSession: effectiveSession,
    expectedPort: 19980,
    expectedFinalPath: finalPath,
    expectedProfile: `/Users/nichikatanaka/.browser-use-cli/profiles/single-use/${runId}-uuid`,
    expectedPid: 12345,
  });
}

test("accepts allowed intermediate events plus exactly one bound final receipt", () => {
  const finalPath = receiptFile();
  const result = validate([
    { phase: "start", finalized: false },
    { phase: "open", finalized: false },
    { phase: "readback", finalized: false },
    { phase: "finalize", finalized: true, receipt_path: finalPath },
  ], finalPath);
  assert.equal(result.ok, true);
  assert.equal(result.terminal_receipt_count, 1);
});

test("rejects missing final receipt path", () => {
  const result = validate([
    { phase: "start", finalized: false },
    { phase: "open", finalized: false },
    { phase: "readback", finalized: false },
    { phase: "finalize", finalized: true },
  ], "");
  assert.equal(result.ok, false);
  assert.equal(result.exact_blocker, "browser_use_canary_final_receipt_missing");
});

test("rejects duplicate final receipts", () => {
  const first = receiptFile();
  const second = receiptFile();
  const result = validate([
    { phase: "start", finalized: false },
    { phase: "open", finalized: false },
    { phase: "readback", finalized: false },
    { phase: "finalize", finalized: true, receipt_path: first },
    { phase: "finalize", finalized: true, receipt_path: second },
  ], first);
  assert.equal(result.ok, false);
  assert.equal(result.exact_blocker, "browser_use_canary_duplicate_final_receipt");
});

test("rejects a receipt path on a nonterminal event", () => {
  const finalPath = receiptFile();
  const result = validate([
    { phase: "start", finalized: false },
    { phase: "open", finalized: false },
    { phase: "readback", finalized: false, receipt_path: finalPath },
    { phase: "finalize", finalized: true, receipt_path: finalPath },
  ], finalPath);
  assert.equal(result.ok, false);
  assert.equal(result.exact_blocker, "browser_use_canary_receipt_binding_failed");
  assert.equal(result.checks[0].exact_blocker, "browser_use_canary_receipt_event_invalid");
});

test("rejects wrong requested-session binding", () => {
  const finalPath = receiptFile({ requested_session: "wrong-session" });
  const result = validate([
    { phase: "start", finalized: false },
    { phase: "open", finalized: false },
    { phase: "readback", finalized: false },
    { phase: "finalize", finalized: true, receipt_path: finalPath },
  ], finalPath);
  assert.equal(result.ok, false);
  assert.equal(result.exact_blocker, "browser_use_canary_receipt_binding_failed");
  assert.equal(result.checks[0].exact_blocker, "browser_use_canary_receipt_session_binding_failed");
});

test("rejects unknown and out-of-order lifecycle events", () => {
  const finalPath = receiptFile();
  for (const receipts of [
    [{ phase: "start", finalized: false }, { phase: "readback", finalized: false }, { phase: "open", finalized: false }, { phase: "finalize", finalized: true, receipt_path: finalPath }],
    [{ phase: "start", finalized: false }, { phase: "open", finalized: false }, { phase: "mystery", finalized: false }, { phase: "finalize", finalized: true, receipt_path: finalPath }],
    [{ phase: "start", finalized: false }, { phase: "open", finalized: false }, { phase: "readback", finalized: false }, { phase: "finalize", finalized: true, receipt_path: finalPath }, { phase: "readback", finalized: false }],
  ]) {
    const result = validate(receipts, finalPath);
    assert.equal(result.ok, false);
    assert.equal(result.exact_blocker, "browser_use_canary_receipt_lifecycle_invalid");
  }
});

test("rejects descriptor profile or pid drift", () => {
  const finalPath = receiptFile({ pid: 54321 });
  const result = validate([{ phase: "start", finalized: false }, { phase: "open", finalized: false }, { phase: "readback", finalized: false }, { phase: "finalize", finalized: true, receipt_path: finalPath }], finalPath);
  assert.equal(result.ok, false);
  assert.equal(result.exact_blocker, "browser_use_canary_receipt_binding_failed");
});

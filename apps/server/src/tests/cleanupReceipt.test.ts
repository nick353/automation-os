import assert from "node:assert/strict";
import test from "node:test";
import {
  assertServiceReadinessCleanupReceiptMatches,
  buildServiceReadinessCleanupReceiptV1,
  buildServiceReadinessBrowserUseCleanupReceiptV1,
  hashServiceReadinessCleanupReceiptV1,
  parseServiceReadinessBrowserUseCleanupReceiptV1,
  validateServiceReadinessCleanupReceiptV1
} from "../serviceReadiness/cleanupReceipt.js";

const base = {
  root_id: "root-cleanup-1",
  workflow_id: "daily-ai" as const,
  run_id: "run-cleanup-1",
  stage_id: "pre_browser_readiness",
  attempt_id: "attempt-cleanup-1",
  fencing_token: 1,
  artifact_uri: "file:///tmp/cleanup-receipt.json",
  created_at: "2026-07-22T12:00:00.000Z"
};

test("builds and validates a read-only no-residual cleanup receipt", () => {
  const receipt = buildServiceReadinessCleanupReceiptV1(base);
  const result = validateServiceReadinessCleanupReceiptV1(receipt);
  assert.equal(result.ok, true);
  assert.equal(hashServiceReadinessCleanupReceiptV1(receipt).length, 64);
  if (result.ok) assert.equal(result.value.external_action_executed, false);
});

test("rejects incomplete, legacy, and cross-run cleanup evidence", () => {
  const receipt = buildServiceReadinessCleanupReceiptV1(base);
  const incomplete = validateServiceReadinessCleanupReceiptV1({ ...receipt, no_residual_processes: false });
  assert.equal(incomplete.ok, false);
  if (!incomplete.ok) assert.equal(incomplete.exact_blocker, "service_readiness_cleanup_incomplete");
  const legacy = validateServiceReadinessCleanupReceiptV1({ ...receipt, chrome_extension: true });
  assert.equal(legacy.ok, false);
  if (!legacy.ok) assert.match(legacy.exact_blocker, /unknown_field/);
  assert.throws(
    () => assertServiceReadinessCleanupReceiptMatches(receipt, { ...base, run_id: "run-other" }),
    /binding_mismatch:run_id/
  );
});

test("Browser Use cleanup proof requires finalized readback and owned lifecycle identity", () => {
  const receipt = buildServiceReadinessBrowserUseCleanupReceiptV1({
    root_id: "root-cleanup-browser-use",
    workflow_id: "daily-ai",
    run_id: "run-cleanup-browser-use",
    stage_id: "browser-stage",
    attempt_id: "attempt-browser-use",
    authority_digest: "a".repeat(64),
    requested_session_id: "requested-session",
    effective_session_id: "effective-session",
    profile_root: "/Users/nichikatanaka/.browser-use-cli/profiles/scheduled/daily-ai",
    reserved_port: 19880,
    lock_path: "/Users/nichikatanaka/.browser-use-cli/locks/run-cleanup-browser-use.lock",
    process_identity: "pid:456",
    artifact_uri: "file:///tmp/browser-use-cleanup-receipt.json",
    created_at: "2026-07-22T12:00:00.000Z"
  });
  assert.equal(receipt.surface, "browser_use_cli");
  assert.equal(parseServiceReadinessBrowserUseCleanupReceiptV1(receipt).readback_status, "verified");
  assert.throws(() => parseServiceReadinessBrowserUseCleanupReceiptV1({ ...receipt, readback_status: "missing" }), /browser_use_cleanup_incomplete/);
  assert.throws(() => parseServiceReadinessBrowserUseCleanupReceiptV1({ ...receipt, surface: "in_app_browser" }), /browser_use_cleanup_surface_invalid/);
});

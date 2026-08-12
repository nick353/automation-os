import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const python = "/Users/nichikatanaka/Documents/New project/.venv/bin/python";
const helper = "/Users/nichikatanaka/Documents/New project/scripts/job_applications/opportunity_ledger_browser_submit.py";

function invoke(root, operation, claimId) {
  const ledger = join(root, "opportunity-status-ledger.jsonl");
  const result = spawnSync(python, [
    helper,
    "--operation", operation,
    "--ledger-path", ledger,
    "--opportunity-key", "opp-test-ledger-boundary",
    "--claim-id", claimId,
    "--company", "Example Co",
    "--role", "Marketing Manager",
    "--source-url", "https://www.linkedin.com/jobs/view/123/",
    "--source-snapshot-id", "snapshot-test",
    ...(operation === "reconcile_not_submitted" ? ["--reconciliation-basis", "authoritative_readback_not_submitted"] : []),
  ], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(result.stdout.split(/\r?\n/u).filter(Boolean).length, 1, result.stderr);
  return { status: result.status, readback: JSON.parse(result.stdout.trim()) };
}

test("official Opportunity Ledger boundary performs fresh classification, atomic claim, and idempotent finalize", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-opportunity-ledger-boundary-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const claimId = "run_test_ledger_boundary:japan_targeted:opp-test-ledger-boundary";
  const claimed = invoke(root, "claim", claimId);
  assert.equal(claimed.status, 0);
  assert.equal(claimed.readback.status, "claimed");
  assert.equal(claimed.readback.gate.fresh_read, true);

  const claimedAgain = invoke(root, "claim", claimId);
  assert.equal(claimedAgain.status, 0);
  assert.equal(claimedAgain.readback.idempotent, true);

  const finalized = invoke(root, "finalize", claimId);
  assert.equal(finalized.status, 0);
  assert.equal(finalized.readback.status, "submitted_confirmed");

  const finalizedAgain = invoke(root, "finalize", claimId);
  assert.equal(finalizedAgain.status, 0);
  assert.equal(finalizedAgain.readback.idempotent, true);
  const rows = readFileSync(join(root, "opportunity-status-ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row.status), ["discovered", "claimed", "submitted_confirmed"]);
  assert.equal(rows.at(-1).claim_id, claimId);
});

test("official Opportunity Ledger boundary reconciles a pre-browser claim before a fresh retry", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-opportunity-ledger-reconcile-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const firstClaim = "run_test_ledger_reconcile:first:japan_targeted:opp-test-ledger-boundary";
  const secondClaim = "run_test_ledger_reconcile:second:japan_targeted:opp-test-ledger-boundary";
  const claimed = invoke(root, "claim", firstClaim);
  assert.equal(claimed.status, 0);
  const reconciled = invoke(root, "reconcile_not_submitted", `${firstClaim}:reconcile`);
  assert.equal(reconciled.status, 0);
  assert.equal(reconciled.readback.status, "discovered");
  const freshClaim = invoke(root, "claim", secondClaim);
  assert.equal(freshClaim.status, 0);
  assert.equal(freshClaim.readback.status, "claimed");
  const rows = readFileSync(join(root, "opportunity-status-ledger.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row.status), ["discovered", "claimed", "discovered", "classified", "claimed"]);
});

test("Job business wrapper accepts AOS underscore run identities before its no-launch gate", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-job-business-underscore-"));
  const runId = "run_job_business_underscore";
  const bundleDir = join(root, runId);
  mkdirSync(bundleDir, { recursive: true, mode: 0o700 });
  const bundlePath = join(bundleDir, "portable-input-bundle.v1.json");
  writeFileSync(bundlePath, `${JSON.stringify({
    schema: "automation_os_portable_workflow_input_bundle.v1",
    workflow_id: "job-application-manager",
    run_id: runId,
    input: {
      job_url: "https://www.linkedin.com/jobs/view/123/",
      application_url: "https://www.linkedin.com/jobs/view/123/",
      candidate_key: "opp-test-underscore",
      bucket: "japan_targeted",
      sequence: 1,
      attempt: 1,
      source_snapshot_id: "snapshot-test",
      supply_run_id: "run_supply_underscore",
      company: "Example Co",
      role: "Marketing Manager",
    },
  }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(bundlePath, 0o600);
  const result = spawnSync(process.execPath, [
    "/Users/nichikatanaka/Documents/New project/scripts/browser_use/job_manager_browser_use_cli_business_runner.mjs",
    "--workflow-id", "job-application-manager",
    "--run-id", runId,
    "--step-id", "step_job_business_underscore",
    "--source-trigger", "automation_os_scheduler",
    "--idempotency-key", "idempotency_job_business_underscore",
  ], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      AUTOMATION_OS_ARTIFACT_ROOT: root,
      AUTOMATION_OS_PORTABLE_BUSINESS_NO_LAUNCH: "1",
      AUTOMATION_OS_PORTABLE_BUSINESS_INPUT_BUNDLE_PATH: bundlePath,
    },
  });
  assert.equal(result.status, 1, result.stderr);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.exact_blocker, "job_manager_browser_use_cli_no_launch_canary");
  assert.equal(receipt.external_action_executed, false);
});

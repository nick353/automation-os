import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const RUNNER = "/Users/nichikatanaka/Documents/New project/scripts/run_sns_multi_poster_chrome_plugin_registered.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function targetDigest(bundle) {
  const keys = [
    "account_ref", "target_key", "payload_hash", "content_key", "product_key", "asset_manifest_id",
    "job_url", "job_id", "application_url", "candidate_key", "bucket", "sequence", "attempt",
    "source_snapshot_id", "source_snapshot_expires_at", "supply_run_id", "company", "role", "audience",
    "resume_locale", "resume_sha256", "owner_ref", "authority_ref", "input_bundle_ref", "target_digest", "source_state_digest",
  ];
  return sha256(JSON.stringify(Object.fromEntries(keys.filter((key) => key in bundle).map((key) => [key, bundle[key]]))));
}

function fixture(workflowId = "sns-multi-poster-ukiyoe") {
  const root = mkdtempSync(join(tmpdir(), "aos-sns-chrome-plugin-runner-"));
  const runId = "run_sns_chrome_fixture";
  const stepId = "step_sns_chrome_fixture";
  const payloadHash = "a".repeat(64);
  const bundle = {
    account_ref: "sns-account",
    target_key: "content-001:x",
    content_key: "content-001",
    payload_hash: payloadHash,
    source_snapshot_id: "snapshot-001",
  };
  const bundleBytes = Buffer.from(`${JSON.stringify({ schema: "automation_os_portable_workflow_input_bundle.v1", workflow_id: workflowId, run_id: runId, input: bundle })}\n`);
  const bundlePath = join(root, "bundle.json");
  writeFileSync(bundlePath, bundleBytes, { mode: 0o600 });
  chmodSync(bundlePath, 0o600);
  const idempotencyKey = "sns-chrome-fixture-idempotency";
  const authority = {
    schema: "automation_os_portable_external_effect_authority.v1",
    authority_id: "",
    issued_by: "automation_os_portable_controller",
    company_id: "company-sns-test",
    workflow_id: workflowId,
    run_id: runId,
    step_id: stepId,
    effect_stage: "one_candidate_publish",
    effect_class: "external_non_idempotent",
    browser_surface: "signed_chrome_extension_profile2",
    approval_id: "approval-sns-fixture",
    approval_status: "approved",
    idempotency_key: idempotencyKey,
    external_action_authorized: true,
    first_class_root_required: false,
    app_dependency: false,
    reconciliation_required: true,
    reconciliation_owner: "automation_os_portable_controller",
    no_auto_retry: true,
    target_digest: targetDigest(bundle),
    input_bundle_sha256: sha256(bundleBytes),
    payload_hash: payloadHash,
    issued_at: new Date(Date.now() - 1_000).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    timeout_ms: 60_000,
    timeout_controller: "automation_os_portable_controller",
  };
  authority.authority_id = `portable-effect-${sha256([
    authority.company_id, authority.workflow_id, authority.run_id, authority.step_id,
    authority.effect_stage, authority.approval_id, authority.idempotency_key,
    authority.target_digest, authority.input_bundle_sha256,
  ].join("\u001f")).slice(0, 32)}`;
  const authorityBytes = `${JSON.stringify(authority)}\n`;
  const authorityPath = join(root, "authority.json");
  writeFileSync(authorityPath, authorityBytes, { mode: 0o600 });
  chmodSync(authorityPath, 0o600);
  const queuePath = join(root, "posting_queue.tsv");
  writeFileSync(queuePath, [
    "id\tcontent_key\tpayload_hash\tx_text\tmedia_plan\treview_notes\tquality_score\tkeep_priority\tstatus",
    `content-001:x\tcontent-001\t${payloadHash}\tこれは検証用の日本語投稿です\tX自作判断カード型\tChrome Extension Profile 2 publish candidate\t10\tship_now\tapproved`,
    "",
  ].join("\n"), { mode: 0o600 });
  chmodSync(queuePath, 0o600);
  return { root, runId, stepId, authorityPath, bundlePath, queuePath, authoritySha: sha256(authorityBytes) };
}

test("SNS Chrome Plugin registered runner dry-run stops before bridge/effect", () => {
  const value = fixture();
  const result = spawnSync(process.execPath, [RUNNER,
    "--workflow-id", "sns-multi-poster-ukiyoe",
    "--run-id", value.runId,
    "--step-id", value.stepId,
    "--source-trigger", "automation_os_ui",
    "--idempotency-key", "sns-chrome-fixture-idempotency",
  ], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      AOS_WEB_OPERATION_BACKEND: "chrome_plugin",
      AOS_CHROME_PROFILE_SURFACE: "signed_chrome_extension_profile2",
      AOS_CHROME_PLUGIN_DRY_RUN: "1",
      AOS_CHROME_PLUGIN_PROJECT_ROOT: "/Users/nichikatanaka/Documents/New project",
      AOS_SNS_PUBLISH_QUEUE_PATH: value.queuePath,
      AUTOMATION_OS_PORTABLE_BUSINESS_INPUT_BUNDLE_PATH: value.bundlePath,
      AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH: value.authorityPath,
      AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256: value.authoritySha,
    },
  });
  assert.equal(result.stderr, "");
  assert.equal(result.status, 1, result.stdout);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.status, "blocked");
  assert.equal(receipt.exact_blocker, "chrome_plugin_sns_dry_run_no_external_effect");
  assert.equal(receipt.external_action_executed, false);
  assert.equal(receipt.browser_surface, "signed_chrome_extension_profile2");
  assert.equal(receipt.cleanup_verified, true);
  assert.equal(receipt.runner_receipt.dry_run, true);
});

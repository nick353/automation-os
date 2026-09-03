import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const RUNNER = join(ROOT, "scripts", "aos-job-chrome-plugin-business-runner.mjs");

function digest(value) { return createHash("sha256").update(value).digest("hex"); }

function jobTargetDigest(bundle) {
  const keys = [
    "account_ref", "target_key", "payload_hash", "content_key", "product_key", "asset_manifest_id",
    "job_url", "job_id", "application_url", "candidate_key", "bucket", "sequence", "attempt",
    "source_snapshot_id", "source_snapshot_expires_at", "supply_run_id", "company", "role", "audience",
    "resume_locale", "resume_sha256", "owner_ref", "authority_ref", "input_bundle_ref", "target_digest", "source_state_digest",
  ];
  return digest(JSON.stringify(Object.fromEntries(keys.filter((key) => key in bundle).map((key) => [key, bundle[key]]))));
}

test("Job Chrome Plugin bridge client closes stdin without spawnSync deadlock", () => {
  const source = readFileSync(RUNNER, "utf8");
  assert.match(source, /function runBridgeClient\(mode, payload, environment\)/u);
  assert.match(source, /child\.stdin\.end\(JSON\.stringify\(payload\)\)/u);
  assert.doesNotMatch(source, /const bridge = spawnSync\(process\.execPath, \[BRIDGE_CLIENT, mode\]/u);
  assert.match(source, /targetScopedAction: false/u);
  assert.match(source, /target_scoped_action: false/u);
  assert.match(source, /chromePluginInitialPath: true/u);
  assert.match(source, /chrome_plugin_initial_path: true/u);
  assert.match(source, /normalizeChromeOperationV1Payload/u);
  assert.match(source, /chromeOperationId: CHROME_OPERATION_V1_ID/u);
});

test("Job Chrome Plugin blocker readback preserves the bridge exact blocker", () => {
  const source = readFileSync("/Users/nichikatanaka/Documents/New project/scripts/browser_use/chrome_extension_trusted_bridge_client.mjs", "utf8");
  assert.match(source, /blocker_reason: String\(exactBlocker \|\| "trusted_runner_bridge_unavailable"\)/u);
  assert.match(source, /Restore an admitted foreground executor/u);
});

test("Job Chrome Plugin runner reports missing authority before ledger or bridge work", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-job-chrome-plugin-boundary-"));
  const runId = "run_job_chrome_plugin_authority_missing";
  const stepId = "step_job_chrome_plugin_authority_missing";
  const bundlePath = join(root, "input-bundle.json");
  writeFileSync(bundlePath, `${JSON.stringify({
    schema: "automation_os_portable_workflow_input_bundle.v1",
    workflow_id: "job-application-manager",
    run_id: runId,
    input: {
      job_url: "https://example.com/job/qa",
      candidate_key: "qa-candidate",
      bucket: "qa",
      sequence: 1,
      attempt: 1,
      source_snapshot_id: "qa-source",
      supply_run_id: "qa-supply"
    }
  })}\n`, { mode: 0o600 });
  const result = spawnSync(process.execPath, [
    RUNNER,
    "--workflow-id", "job-application-manager",
    "--run-id", runId,
    "--step-id", stepId,
    "--source-trigger", "focused_test",
    "--idempotency-key", `${runId}:idempotency`,
  ], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: process.env.PATH,
      AOS_WEB_OPERATION_BACKEND: "chrome_plugin",
      AUTOMATION_OS_PORTABLE_EXTERNAL_INPUT_BUNDLE_PATH: bundlePath,
      AUTOMATION_OS_ARTIFACT_ROOT: root,
    },
  });
  assert.equal(result.status, 1, result.stderr);
  const readback = JSON.parse(result.stdout.trim());
  assert.equal(readback.status, "blocked");
  assert.equal(readback.exact_blocker, "job_chrome_plugin_effect_authority_missing");
  assert.equal(readback.browser_surface, "signed_chrome_extension_profile2");
  assert.equal(readback.external_action_executed, false);
  assert.equal(readback.same_run_receipt, false);
  assert.equal(readback.chrome_operation.id, "chrome_operation_v1");
  assert.equal(readback.chrome_operation.name, "Chrome操作 バージョン1");
});

test("Job Chrome Plugin runner accepts zero-based first candidate sequence", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-job-chrome-plugin-sequence-zero-"));
  const runId = "run_job_chrome_plugin_sequence_zero";
  const stepId = "step_job_chrome_plugin_sequence_zero";
  const bundlePath = join(root, "input-bundle.json");
  writeFileSync(bundlePath, `${JSON.stringify({
    schema: "automation_os_portable_workflow_input_bundle.v1",
    workflow_id: "job-application-manager",
    run_id: runId,
    input: {
      job_url: "https://example.com/job/qa",
      candidate_key: "qa-candidate",
      bucket: "overseas_global",
      sequence: 0,
      attempt: 1,
      source_snapshot_id: "qa-source",
      supply_run_id: "qa-supply",
    },
  })}\n`, { mode: 0o600 });
  const result = spawnSync(process.execPath, [
    RUNNER,
    "--workflow-id", "job-application-manager",
    "--run-id", runId,
    "--step-id", stepId,
    "--source-trigger", "focused_test",
    "--idempotency-key", `${runId}:idempotency`,
  ], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: process.env.PATH,
      AOS_WEB_OPERATION_BACKEND: "chrome_plugin",
      AUTOMATION_OS_PORTABLE_EXTERNAL_INPUT_BUNDLE_PATH: bundlePath,
      AUTOMATION_OS_ARTIFACT_ROOT: root,
    },
  });
  assert.equal(result.status, 1, result.stderr);
  const readback = JSON.parse(result.stdout.trim());
  assert.equal(readback.exact_blocker, "job_chrome_plugin_effect_authority_missing");
  assert.notEqual(readback.exact_blocker, "job_chrome_plugin_candidate_binding_invalid");
  assert.equal(readback.external_action_executed, false);
});

test("Job Chrome Plugin runner rejects idempotency drift before ledger or bridge work", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-job-chrome-plugin-authority-binding-"));
  const runId = "run_job_chrome_plugin_authority_binding";
  const stepId = "step_job_chrome_plugin_authority_binding";
  const idempotencyKey = `${runId}:idempotency`;
  const bundle = {
    account_ref: "linkedin-test",
    job_url: "https://example.com/job/qa",
    application_url: "https://example.com/job/qa/apply",
    candidate_key: "qa-candidate",
    bucket: "qa",
    sequence: 1,
    attempt: 1,
    source_snapshot_id: "qa-source",
    supply_run_id: "qa-supply",
    payload_hash: "a".repeat(64),
  };
  const bundleBytes = Buffer.from(`${JSON.stringify({
    schema: "automation_os_portable_workflow_input_bundle.v1",
    workflow_id: "job-application-manager",
    run_id: runId,
    input: bundle,
  })}\n`);
  const bundlePath = join(root, "input-bundle.json");
  writeFileSync(bundlePath, bundleBytes, { mode: 0o600 });
  chmodSync(bundlePath, 0o600);
  const authority = {
    schema: "automation_os_portable_external_effect_authority.v1",
    issued_by: "automation_os_portable_controller",
    company_id: "company-test",
    workflow_id: "job-application-manager",
    run_id: runId,
    step_id: stepId,
    effect_stage: "one_candidate_submit",
    effect_class: "external_non_idempotent",
    browser_surface: "signed_chrome_extension_profile2",
    approval_id: "approval-test",
    approval_status: "approved",
    idempotency_key: "different-idempotency",
    target_digest: jobTargetDigest(bundle),
    input_bundle_sha256: digest(bundleBytes),
    payload_hash: bundle.payload_hash,
    issued_at: new Date(Date.now() - 1_000).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    timeout_ms: 60_000,
    timeout_controller: "automation_os_portable_controller",
    reconciliation_required: true,
    reconciliation_owner: "automation_os_portable_controller",
    no_auto_retry: true,
    first_class_root_required: false,
    app_dependency: false,
    external_action_authorized: true,
  };
  authority.authority_id = `portable-effect-${digest([
    authority.company_id, authority.workflow_id, authority.run_id, authority.step_id,
    authority.effect_stage, authority.approval_id, authority.idempotency_key,
    authority.target_digest, authority.input_bundle_sha256,
  ].join("\u001f")).slice(0, 32)}`;
  const authorityBytes = Buffer.from(`${JSON.stringify(authority)}\n`);
  const authorityPath = join(root, "authority.json");
  writeFileSync(authorityPath, authorityBytes, { mode: 0o600 });
  chmodSync(authorityPath, 0o600);
  const result = spawnSync(process.execPath, [
    RUNNER,
    "--workflow-id", "job-application-manager",
    "--run-id", runId,
    "--step-id", stepId,
    "--source-trigger", "focused_test",
    "--idempotency-key", idempotencyKey,
  ], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: process.env.PATH,
      AOS_WEB_OPERATION_BACKEND: "chrome_plugin",
      AUTOMATION_OS_PORTABLE_EXTERNAL_INPUT_BUNDLE_PATH: bundlePath,
      AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH: authorityPath,
      AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256: digest(authorityBytes),
      AUTOMATION_OS_ARTIFACT_ROOT: root,
    },
  });
  assert.equal(result.status, 1, result.stderr);
  const readback = JSON.parse(result.stdout.trim());
  assert.equal(readback.exact_blocker, "job_chrome_plugin_effect_authority_binding_invalid");
  assert.equal(readback.external_action_executed, false);
  assert.equal(readback.same_run_receipt, false);
});

test("Job Chrome Plugin runner tolerates bounded controller-worker clock skew", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-job-chrome-plugin-clock-skew-"));
  const runId = "run_job_chrome_plugin_clock_skew";
  const stepId = "step_job_chrome_plugin_clock_skew";
  const idempotencyKey = `${runId}:idempotency`;
  const bundle = {
    account_ref: "chrome-profile2-test",
    job_url: "https://example.com/job/qa",
    application_url: "https://example.com/job/qa/apply",
    candidate_key: "qa-candidate-clock-skew",
    bucket: "qa",
    sequence: 1,
    attempt: 1,
    source_snapshot_id: "qa-source",
    supply_run_id: "qa-supply",
    payload_hash: "b".repeat(64),
  };
  const bundleBytes = Buffer.from(`${JSON.stringify({
    schema: "automation_os_portable_workflow_input_bundle.v1",
    workflow_id: "job-application-manager",
    run_id: runId,
    input: bundle,
  })}\n`);
  const bundlePath = join(root, "input-bundle.json");
  writeFileSync(bundlePath, bundleBytes, { mode: 0o600 });
  chmodSync(bundlePath, 0o600);
  const authority = {
    schema: "automation_os_portable_external_effect_authority.v1",
    issued_by: "automation_os_portable_controller",
    company_id: "company-test",
    workflow_id: "job-application-manager",
    run_id: runId,
    step_id: stepId,
    effect_stage: "one_candidate_submit",
    effect_class: "external_non_idempotent",
    browser_surface: "signed_chrome_extension_profile2",
    approval_id: "approval-clock-skew",
    approval_status: "approved",
    idempotency_key: idempotencyKey,
    target_digest: jobTargetDigest(bundle),
    input_bundle_sha256: digest(bundleBytes),
    payload_hash: bundle.payload_hash,
    issued_at: new Date(Date.now() + 5_000).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    timeout_ms: 60_000,
    timeout_controller: "automation_os_portable_controller",
    reconciliation_required: true,
    reconciliation_owner: "automation_os_portable_controller",
    no_auto_retry: true,
    first_class_root_required: false,
    app_dependency: false,
    external_action_authorized: true,
  };
  authority.authority_id = `portable-effect-${digest([
    authority.company_id, authority.workflow_id, authority.run_id, authority.step_id,
    authority.effect_stage, authority.approval_id, authority.idempotency_key,
    authority.target_digest, authority.input_bundle_sha256,
  ].join("\u001f")).slice(0, 32)}`;
  const authorityBytes = Buffer.from(`${JSON.stringify(authority)}\n`);
  const authorityPath = join(root, "authority.json");
  writeFileSync(authorityPath, authorityBytes, { mode: 0o600 });
  chmodSync(authorityPath, 0o600);
  const result = spawnSync(process.execPath, [
    RUNNER,
    "--workflow-id", "job-application-manager",
    "--run-id", runId,
    "--step-id", stepId,
    "--source-trigger", "focused_test",
    "--idempotency-key", idempotencyKey,
  ], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: process.env.PATH,
      AOS_WEB_OPERATION_BACKEND: "chrome_plugin",
      AUTOMATION_OS_PORTABLE_EXTERNAL_INPUT_BUNDLE_PATH: bundlePath,
      AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH: authorityPath,
      AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256: digest(authorityBytes),
      AUTOMATION_OS_ARTIFACT_ROOT: root,
    },
  });
  assert.equal(result.status, 1, result.stderr);
  const readback = JSON.parse(result.stdout.trim());
  assert.equal(readback.exact_blocker, "portable_external_action_plan_missing");
  assert.notEqual(readback.exact_blocker, "job_chrome_plugin_effect_authority_binding_invalid");
  assert.equal(readback.external_action_executed, false);
});

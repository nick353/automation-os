import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getWebOperationContract } from "../runs/webOperationContract.js";

const runner = join(process.cwd(), "scripts", "aos-portable-business-runner.mjs");
const baseArgs = [
  "--workflow-id", "job-application-manager",
  "--run-id", "business_runner_test_run",
  "--step-id", "business_runner_test_step",
  "--source-trigger", "automation_os_ui",
  "--idempotency-key", "business-runner-test-key",
];

function run(env: NodeJS.ProcessEnv) {
  try {
    const output = execFileSync(process.execPath, [runner, ...baseArgs], { env: { ...process.env, ...env }, encoding: "utf8" });
    return JSON.parse(output.trim()) as Record<string, unknown>;
  } catch (error) {
    const output = String((error as { stdout?: string }).stdout || "").trim();
    return JSON.parse(output) as Record<string, unknown>;
  }
}

function admission(root: string) {
  const value = {
    schema: "automation_os_portable_external_admission.v1",
    workflow_id: "job-application-manager",
    run_id: "business_runner_test_run",
    step_id: "business_runner_test_step",
    approval_status: "approved",
    browser_surface: "browser_use_cli",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const bytes = `${JSON.stringify(value)}\n`;
  const path = join(root, "admission.json");
  writeFileSync(path, bytes, { mode: 0o600 });
  return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function actionPlan(root: string) {
  const value = {
    schema: "automation_os_portable_external_action_plan.v1",
    issued_by: "automation_os_worker",
    workflow_id: "job-application-manager",
    runner_key: "job_application",
    run_id: "business_runner_test_run",
    step_id: "business_runner_test_step",
    source_trigger: "automation_os_ui",
    idempotency_key: "business-runner-test-key",
    browser_surface: "browser_use_cli",
    external_effect_policy: "approved",
    approval_status: "approved",
    allowed_stages: ["source_readback", "candidate_supply", "browser_preflight", "one_candidate_submit", "same_run_sync_readback", "cleanup"],
    required_business_proofs: ["submitted_confirmed", "same_run_source_of_truth_readback", "cleanup_receipt"],
    web_operation_contract: getWebOperationContract(),
    input_bundle_sha256: null,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const bytes = `${JSON.stringify(value)}\n`;
  const path = join(root, "action-plan.json");
  writeFileSync(path, bytes, { mode: 0o600 });
  return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function effectAuthority(root: string) {
  const value = {
    schema: "automation_os_portable_external_effect_authority.v1",
    authority_id: "portable-effect-business-runner-test-authority",
    issued_by: "automation_os_portable_controller",
    company_id: "company-1",
    workflow_id: "job-application-manager",
    run_id: "business_runner_test_run",
    step_id: "business_runner_test_step",
    effect_stage: "one_candidate_submit",
    effect_class: "external_non_idempotent",
    browser_surface: "browser_use_cli",
    approval_id: "approval-business-runner-test",
    approval_status: "approved",
    idempotency_key: "business-runner-test-key",
    target_digest: "a".repeat(64),
    input_bundle_sha256: "b".repeat(64),
    payload_hash: null,
    issued_at: new Date().toISOString(),
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
  const bytes = `${JSON.stringify(value)}\n`;
  const path = join(root, "effect-authority.json");
  writeFileSync(path, bytes, { mode: 0o600 });
  return {
    AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_REQUIRED: "1",
    AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH: path,
    AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256: createHash("sha256").update(bytes).digest("hex"),
    AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_ID: value.authority_id,
  };
}

test("business runner is disabled unless the explicit external-effect switch is enabled", () => {
  const result = run({ AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS: "0", AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL: "approved" });
  assert.equal(result.exact_blocker, "portable_external_effects_disabled");
  assert.equal(result.external_action_executed, false);
});

test("business runner requires a configured workflow runner after approval", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-business-runner-plan-"));
  const bound = admission(root);
  const planned = actionPlan(root);
  const authority = effectAuthority(root);
  const result = run({
    AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS: "enabled",
    AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL: "approved",
    AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_PATH: bound.path,
    AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_SHA256: bound.sha256,
    AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_PATH: planned.path,
    AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_SHA256: planned.sha256,
    AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_JOB_APPLICATION: "",
    ...authority,
  });
  assert.equal(result.exact_blocker, "portable_external_business_runner_not_configured");
  assert.equal(result.external_action_executed, false);
});

test("business runner derives only the canonical job runner from an explicit project root", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-business-runner-root-binding-"));
  const bound = admission(root);
  const planned = actionPlan(root);
  const authority = effectAuthority(root);
  const result = run({
    AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS: "enabled",
    AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL: "approved",
    AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_PATH: bound.path,
    AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_SHA256: bound.sha256,
    AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_PATH: planned.path,
    AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_SHA256: planned.sha256,
    AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_JOB_APPLICATION: "",
    AUTOMATION_OS_BROWSER_USE_PROJECT_ROOT: "/Users/nichikatanaka/Documents/New project",
    AUTOMATION_OS_PORTABLE_BUSINESS_NO_LAUNCH: "1",
    ...authority,
  });
  assert.notEqual(result.exact_blocker, "portable_external_business_runner_not_configured");
  assert.equal(result.external_action_executed, false);
});

test("configured business runner must return same-run receipt and cleanup proof", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-business-runner-configured-"));
  const bound = admission(root);
  const planned = actionPlan(root);
  const authority = effectAuthority(root);
  const fake = join(root, "fake-runner.mjs");
  writeFileSync(fake, `#!/usr/bin/env node
// browser_use_cli stage-adapter binding
process.stdout.write(JSON.stringify({
  status: "complete",
  exact_blocker: null,
  external_action_executed: true,
  browser_surface: "browser_use_cli",
  run_id: process.env.AUTOMATION_OS_PORTABLE_BUSINESS_RUN_ID,
  same_run_receipt: true,
  cleanup_verified: true,
  adapter_result: { state: "submitted_confirmed", sync_ok: true, ledger_finalized: true },
  web_operation_lifecycle: {
    schema: "automation_os_web_operation_lifecycle.v1",
    state: "cleaned",
    status: "complete",
    exact_blocker: null,
    run_id: process.env.AUTOMATION_OS_PORTABLE_BUSINESS_RUN_ID,
    step_id: process.env.AUTOMATION_OS_PORTABLE_BUSINESS_STEP_ID,
    idempotency_key: "business-runner-test-key",
    operation: "submit",
    target_digest: "${"a".repeat(64)}",
    payload_hash: null,
    source_state_digest: "${"d".repeat(64)}",
    dispatch_state: "executed",
    dispatch_attempted: true,
    external_action_executed: true,
    same_run_receipt: true,
    readback_verified: true,
    cleanup_verified: true,
    no_replay: true
  }
})+"\\n");
`, { mode: 0o700 });
  chmodSync(fake, 0o700);
  const result = run({
    AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS: "enabled",
    AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL: "approved",
    AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_PATH: bound.path,
    AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_SHA256: bound.sha256,
    AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_PATH: planned.path,
    AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_SHA256: planned.sha256,
    AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_JOB_APPLICATION: fake,
    ...authority,
  });
  assert.equal(result.status, "complete");
  assert.equal(result.external_action_executed, true);
  assert.equal((result.web_operation_lifecycle as Record<string, unknown>)?.schema, "automation_os_web_operation_lifecycle.v1");
  assert.equal((result.web_operation_lifecycle as Record<string, unknown>)?.state, "cleaned");
  assert.equal((result.web_operation_lifecycle as Record<string, unknown>)?.readback_verified, true);
});

test("business runner rejects a renamed legacy browser surface before spawning it", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-business-runner-surface-"));
  const bound = admission(root);
  const planned = actionPlan(root);
  const authority = effectAuthority(root);
  const forbidden = join(root, "renamed-runner.mjs");
  const marker = join(root, "spawned.marker");
  writeFileSync(forbidden, `#!/usr/bin/env node\n// browser_use_cli marker is intentionally present but this is a Playwright fallback\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "spawned");\nconsole.log(JSON.stringify({status:"complete",external_action_executed:true,browser_surface:"browser_use_cli",run_id:process.env.AUTOMATION_OS_PORTABLE_BUSINESS_RUN_ID,same_run_receipt:true,cleanup_verified:true}));\n`, { mode: 0o700 });
  chmodSync(forbidden, 0o700);
  const result = run({
    AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS: "enabled",
    AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL: "approved",
    AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_PATH: bound.path,
    AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_SHA256: bound.sha256,
    AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_PATH: planned.path,
    AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_SHA256: planned.sha256,
    AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_JOB_APPLICATION: forbidden,
    ...authority,
  });
  assert.equal(result.exact_blocker, "portable_external_business_runner_forbidden_browser_surface");
  assert.equal(result.external_action_executed, false);
});

test("business runner requires AOS portable effect authority even when approval and effects are enabled", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-business-runner-authority-required-"));
  const bound = admission(root);
  const planned = actionPlan(root);
  const marker = join(root, "should-not-spawn.marker");
  const fake = join(root, "fake-runner.mjs");
  writeFileSync(fake, `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "spawned");\n`, { mode: 0o700 });
  chmodSync(fake, 0o700);
  const result = run({
    AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS: "enabled",
    AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL: "approved",
    AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_PATH: bound.path,
    AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_SHA256: bound.sha256,
    AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_PATH: planned.path,
    AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_SHA256: planned.sha256,
    AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_JOB_APPLICATION: fake,
  });
  assert.equal(result.exact_blocker, "portable_external_effect_authority_missing");
  assert.equal(result.external_action_executed, false);
  assert.throws(() => readFileSync(marker, "utf8"));
});

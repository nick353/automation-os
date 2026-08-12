import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WEB_OPERATION_CONTRACT } from "../portable-business-action-plan.mjs";

const runnerPath = new URL("../aos-nisenprints-business-runner.mjs", import.meta.url);

function admission(root, runId, stepId) {
  const payload = {
    schema: "automation_os_portable_external_admission.v1",
    workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest",
    run_id: runId,
    step_id: stepId,
    source_trigger: "automation_os_scheduler",
    idempotency_key: `${runId}-idempotency`,
    browser_surface: "browser_use_cli",
    approval_status: "approved",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const bytes = `${JSON.stringify(payload, null, 2)}\n`;
  const file = join(root, "admission.json");
  writeFileSync(file, bytes, { mode: 0o600 });
  return { file, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function effectAuthority(root, runId, stepId) {
  const value = {
    schema: "automation_os_portable_external_effect_authority.v1",
    authority_id: "authority_nisenprints_business_contract",
    issued_by: "automation_os_portable_controller",
    company_id: "company_1",
    workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest",
    run_id: runId,
    step_id: stepId,
    effect_stage: "business_effect",
    effect_class: "external_non_idempotent",
    approval_status: "approved",
    idempotency_key: `${runId}-idempotency`,
    target_digest: "a".repeat(64),
    input_bundle_sha256: "b".repeat(64),
    payload_hash: "c".repeat(64),
    external_action_authorized: true,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const file = join(root, "effect-authority.json");
  writeFileSync(file, bytes, { mode: 0o600 });
  return { file, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function invoke({ noLaunch = false, readOnlyStage = "", rootRunner = "" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "aos-nisenprints-business-runner-"));
  const runId = "run_nisenprints_business_contract";
  const stepId = "step_nisenprints_business_contract";
  const current = admission(root, runId, stepId);
  const authority = effectAuthority(root, runId, stepId);
  const result = spawnSync(process.execPath, [
    runnerPath.pathname,
    "--workflow-id", "nisenprints-daily-product-canva-printify-etsy-pinterest",
    "--run-id", runId,
    "--step-id", stepId,
    "--source-trigger", "automation_os_scheduler",
    "--idempotency-key", `${runId}-idempotency`,
  ], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      AUTOMATION_OS_ARTIFACT_ROOT: root,
      AUTOMATION_OS_PORTABLE_BUSINESS_ADMISSION_PATH: current.file,
      AUTOMATION_OS_PORTABLE_BUSINESS_ADMISSION_SHA256: current.sha256,
      ...(noLaunch ? { AUTOMATION_OS_PORTABLE_BUSINESS_NO_LAUNCH: "1" } : {}),
      ...(readOnlyStage ? { AUTOMATION_OS_PORTABLE_EXTERNAL_READ_ONLY_STAGE: readOnlyStage } : {}),
      ...(rootRunner ? { AUTOMATION_OS_NISENPRINTS_BROWSER_USE_RUNNER: rootRunner } : {}),
      AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH: authority.file,
      AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256: authority.sha256,
    },
  });
  assert.equal(result.stdout.split(/\r?\n/u).filter(Boolean).length, 1, result.stderr);
  return { status: result.status, receipt: JSON.parse(result.stdout.trim()) };
}

function addActionPlan(root, runId, stepId) {
  const runRoot = join(root, runId);
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  const payload = {
    schema: "automation_os_portable_external_action_plan.v1",
    issued_by: "automation_os_worker",
    workflow_id: "nisenprints-daily-product-canva-printify-etsy-pinterest",
    runner_key: "nisenprints",
    run_id: runId,
    step_id: stepId,
    source_trigger: "automation_os_scheduler",
    idempotency_key: `${runId}-idempotency`,
    browser_surface: "browser_use_cli",
    external_effect_policy: "approved",
    approval_status: "approved",
    allowed_stages: ["prepare_context", "browser_preflight", "runway_generate", "canva_preflight", "canva_transaction", "canva_commit_export", "canva_artifact_gate", "canva_verify", "printify_product_copy", "printify_publish", "etsy_listing_discovery", "etsy_media_repair", "pinterest_queue", "pinterest_post", "strict_completion", "cleanup"],
    required_business_proofs: ["generation_manifest", "etsy_listing", "pinterest_pin_url", "etsy_visit_site_match", "cleanup_receipt"],
    web_operation_contract: WEB_OPERATION_CONTRACT,
    input_bundle_sha256: null,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const bytes = `${JSON.stringify(payload, null, 2)}\n`;
  const file = join(runRoot, "portable-external-action-plan.v1.json");
  writeFileSync(file, bytes, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { file, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function stubRootRunner(root, runId, includeProofs = false) {
  const cleanup = join(root, runId, "cleanup.json");
  const resultPath = join(root, runId, "result.json");
  writeFileSync(cleanup, `${JSON.stringify({ schema: "automation_kernel_cleanup_proof.v1", cleanup_complete: true, residual_owned_processes: 0 })}\n`, { mode: 0o600 });
  writeFileSync(resultPath, "{}\n", { mode: 0o600 });
  const runner = join(root, "stub-root-runner.mjs");
  const proofFields = includeProofs
    ? ", business_proofs: { generation_manifest: true, etsy_listing: true, pinterest_pin_url: true, etsy_visit_site_match: true, cleanup_receipt: true }, same_run_source_sync: true"
    : "";
  writeFileSync(runner, `// browser-use-cli stage-adapter\nexport async function runRegisteredAutomation() { if (process.env.NISENPRINTS_BROWSER_USE_CLI_PORT !== "19884") throw new Error("port_not_bound"); return { result_path: ${JSON.stringify(resultPath)}, result: { schema: "automation_kernel_result.v2", run_id: ${JSON.stringify(runId)}, terminal_status: "succeeded", exact_blocker: null, cleanup_proof: ${JSON.stringify(cleanup)}, stage_results: [{ details: { external_intent_observed: true } }]${proofFields} } }; }\n`, { mode: 0o700 });
  chmodSync(runner, 0o700);
  return runner;
}

test("NisenPrints business wrapper preserves the no-launch boundary", () => {
  const { status, receipt } = invoke({ noLaunch: true });
  assert.equal(status, 1);
  assert.equal(receipt.exact_blocker, "nisenprints_browser_use_cli_no_launch_canary");
  assert.equal(receipt.external_action_executed, false);
  assert.equal(receipt.browser_surface, "browser_use_cli");
});

test("NisenPrints business wrapper fails closed without the same-run action plan", () => {
  const { status, receipt } = invoke();
  assert.equal(status, 1);
  assert.equal(receipt.exact_blocker, "portable_external_action_plan_missing");
  assert.equal(receipt.external_action_executed, false);
});

test("NisenPrints business wrapper can enter the approved root runner after plan readback", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-nisenprints-approved-plan-"));
  const runId = "run_nisenprints_business_contract";
  const stepId = "step_nisenprints_business_contract";
  const plan = addActionPlan(root, runId, stepId);
  const stub = stubRootRunner(root, runId);
  const current = admission(root, runId, stepId);
  const authority = effectAuthority(root, runId, stepId);
  const result = spawnSync(process.execPath, [
    runnerPath.pathname,
    "--workflow-id", "nisenprints-daily-product-canva-printify-etsy-pinterest",
    "--run-id", runId,
    "--step-id", stepId,
    "--source-trigger", "automation_os_scheduler",
    "--idempotency-key", `${runId}-idempotency`,
  ], { encoding: "utf8", env: { PATH: process.env.PATH, AUTOMATION_OS_ARTIFACT_ROOT: root, AUTOMATION_OS_PORTABLE_BUSINESS_ADMISSION_PATH: current.file, AUTOMATION_OS_PORTABLE_BUSINESS_ADMISSION_SHA256: current.sha256, AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_PATH: plan.file, AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_SHA256: plan.sha256, AUTOMATION_OS_NISENPRINTS_BROWSER_USE_RUNNER: stub, AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH: authority.file, AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256: authority.sha256 } });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.external_action_executed, true);
  assert.equal(receipt.same_run_receipt, true);
  assert.equal(receipt.cleanup_verified, true);
});

test("NisenPrints business wrapper preserves explicit root business proofs and same-run sync", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-nisenprints-proof-propagation-"));
  const runId = "run_nisenprints_business_contract";
  const stepId = "step_nisenprints_business_contract";
  const plan = addActionPlan(root, runId, stepId);
  const stub = stubRootRunner(root, runId, true);
  const current = admission(root, runId, stepId);
  const authority = effectAuthority(root, runId, stepId);
  const result = spawnSync(process.execPath, [
    runnerPath.pathname,
    "--workflow-id", "nisenprints-daily-product-canva-printify-etsy-pinterest",
    "--run-id", runId,
    "--step-id", stepId,
    "--source-trigger", "automation_os_scheduler",
    "--idempotency-key", `${runId}-idempotency`,
  ], { encoding: "utf8", env: { PATH: process.env.PATH, AUTOMATION_OS_ARTIFACT_ROOT: root, AUTOMATION_OS_PORTABLE_BUSINESS_ADMISSION_PATH: current.file, AUTOMATION_OS_PORTABLE_BUSINESS_ADMISSION_SHA256: current.sha256, AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_PATH: plan.file, AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_SHA256: plan.sha256, AUTOMATION_OS_NISENPRINTS_BROWSER_USE_RUNNER: stub, AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH: authority.file, AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256: authority.sha256 } });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout.trim());
  assert.deepEqual(receipt.runner_receipt.business_proofs, { generation_manifest: true, etsy_listing: true, pinterest_pin_url: true, etsy_visit_site_match: true, cleanup_receipt: true });
  assert.equal(receipt.runner_receipt.same_run_source_sync, true);
});

test("NisenPrints business wrapper reports a configured root runner that is unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-nisenprints-missing-root-"));
  const missing = join(root, "missing-runner.mjs");
  const { status, receipt } = invoke({ rootRunner: missing });
  assert.equal(status, 1);
  assert.equal(receipt.exact_blocker, "nisenprints_browser_use_cli_root_runner_missing");
  assert.equal(receipt.external_action_executed, false);
});

test("root runner accepts only the AOS scheduled port override", () => {
  const source = readFileSync("/Users/nichikatanaka/Documents/Etsy/.codex/automation-kernel/runners/nisenprints-daily-product-canva-printify-etsy-pinterest.mjs", "utf8");
  assert.match(source, /NISENPRINTS_BROWSER_USE_CLI_PORT/u);
  assert.match(source, /19880/u);
});

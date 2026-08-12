import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WEB_OPERATION_CONTRACT, readPortableBusinessActionPlan } from "../portable-business-action-plan.mjs";

const runnerPath = new URL("../aos-daily-ai-business-runner.mjs", import.meta.url);

function admission(root, runId, stepId) {
  const payload = {
    schema: "automation_os_portable_external_admission.v1",
    workflow_id: "daily-ai-research-publish-run",
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
    authority_id: "authority_daily_ai_business_contract",
    issued_by: "automation_os_portable_controller",
    company_id: "company_1",
    workflow_id: "daily-ai-research-publish-run",
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

function actionPlan(root, runId, stepId) {
  const runRoot = join(root, runId);
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  const payload = {
    schema: "automation_os_portable_external_action_plan.v1",
    issued_by: "automation_os_worker",
    workflow_id: "daily-ai-research-publish-run",
    runner_key: "daily_ai",
    run_id: runId,
    step_id: stepId,
    source_trigger: "automation_os_scheduler",
    idempotency_key: `${runId}-idempotency`,
    browser_surface: "browser_use_cli",
    external_effect_policy: "approved",
    approval_status: "approved",
    allowed_stages: ["research_queue_refresh", "pre_entry_readiness", "browser_preflight", "publish", "feed_study", "engagement", "postflight_sync", "cleanup"],
    required_business_proofs: ["publish_url_or_exact_blocker", "feed_study_or_exact_blocker", "engagement_or_no_candidate_proof", "queue_sync", "cleanup_receipt"],
    web_operation_contract: WEB_OPERATION_CONTRACT,
    input_bundle_sha256: null,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const bytes = `${JSON.stringify(payload, null, 2)}\n`;
  const file = join(runRoot, "portable-external-action-plan.v1.json");
  writeFileSync(file, bytes, { mode: 0o600 });
  return { file, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function stubRunner(root) {
  const runner = join(root, "stub-daily-runner.mjs");
  writeFileSync(runner, `// browser-use-cli stage-adapter\nimport { mkdirSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nconst runId = process.env.DAILY_AI_CLI_RUN_ID;\nconst outputDir = process.env.DAILY_AI_CLI_OUTPUT_DIR;\nmkdirSync(outputDir, { recursive: true });\nconst summaryPath = join(outputDir, "registered-browser-summary.json");\nwriteFileSync(summaryPath, JSON.stringify({ run_id: runId, direct_publish: { receipts: [{ post_url: "https://x.com/example/status/1" }] }, post_publish_feed_study: { artifact: "feed.json" }, direct_engagement: { no_candidate_proof: true }, postflight_sync: { run_id: runId, status: "completed", queue_readback: { sha256: "${"a".repeat(64)}" } }, cleanup_proof: { cleanup_verified: true } }));\nconsole.log(JSON.stringify({ schema: "daily_ai_browser_use_cli_registered_runner_result.v1", run_id: runId, status: "complete", exact_blocker: null, browser_surface: "browser_use_cli", external_action_executed: true, same_run_receipt: true, cleanup_verified: true, summary_path: summaryPath }));\n`, { mode: 0o700 });
  return runner;
}

test("Daily AI wrapper propagates summary business proofs and same-run source sync", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-daily-ai-proof-propagation-"));
  const runId = "run_daily_ai_business_contract";
  const stepId = "step_daily_ai_business_contract";
  const current = admission(root, runId, stepId);
  const authority = effectAuthority(root, runId, stepId);
  const plan = actionPlan(root, runId, stepId);
  assert.doesNotThrow(() => readPortableBusinessActionPlan({ workflowId: "daily-ai-research-publish-run", runId, stepId, sourceTrigger: "automation_os_scheduler", idempotencyKey: `${runId}-idempotency`, environment: { AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_PATH: plan.file, AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_SHA256: plan.sha256 } }));
  const runner = stubRunner(root);
  const result = spawnSync(process.execPath, [
    runnerPath.pathname,
    "--workflow-id", "daily-ai-research-publish-run",
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
      AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_PATH: plan.file,
      AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_SHA256: plan.sha256,
      AUTOMATION_OS_DAILY_AI_BROWSER_USE_RUNNER: runner,
      AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH: authority.file,
      AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256: authority.sha256,
    },
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const receipt = JSON.parse(result.stdout.trim());
  assert.deepEqual(receipt.runner_receipt.business_proofs, {
    publish_url_or_exact_blocker: true,
    feed_study_or_exact_blocker: true,
    engagement_or_no_candidate_proof: true,
    queue_sync: true,
    cleanup_receipt: true,
  });
  assert.equal(receipt.runner_receipt.same_run_source_sync, true);
});

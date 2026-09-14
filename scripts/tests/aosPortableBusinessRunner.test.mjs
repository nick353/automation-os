import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { buildBusinessWebOperationLifecycle, businessRunnerBindingEnvironment, runChild, runnerFor, selectedBackend, selectedBrowserSurface, selectedBrowserSurfaceMismatch } from "../aos-portable-business-runner.mjs";
import { WEB_OPERATION_CONTRACT } from "../portable-business-action-plan.mjs";

const ROOT = process.cwd();
const RUNNER = join(ROOT, "scripts", "aos-portable-business-runner.mjs");
const WORKFLOWS = Object.freeze({
  "daily-ai-research-publish-run": {
    key: "DAILY_AI",
    runnerKey: "daily_ai",
    stages: ["research_queue_refresh", "pre_entry_readiness", "browser_preflight", "publish", "feed_study", "engagement", "postflight_sync", "cleanup"],
    proofs: ["publish_url_or_exact_blocker", "feed_study_or_exact_blocker", "engagement_or_no_candidate_proof", "queue_sync", "cleanup_receipt"],
    blocker: "daily_ai_browser_use_cli_no_launch_canary",
  },
  "nisenprints-daily-product-canva-printify-etsy-pinterest": {
    key: "NISENPRINTS",
    runnerKey: "nisenprints",
    stages: ["prepare_context", "browser_preflight", "runway_generate", "canva_preflight", "canva_transaction", "canva_commit_export", "canva_artifact_gate", "canva_verify", "printify_product_copy", "printify_publish", "etsy_listing_discovery", "etsy_media_repair", "pinterest_queue", "pinterest_post", "strict_completion", "cleanup"],
    proofs: ["generation_manifest", "etsy_listing", "pinterest_pin_url", "etsy_visit_site_match", "cleanup_receipt"],
    blocker: "nisenprints_browser_use_cli_no_launch_canary",
  },
  "sns-multi-poster-ukiyoe": {
    key: "SNS_MULTI_POSTER",
    runnerKey: "sns_multi_poster",
    stages: ["source_readback", "account_preflight", "browser_preflight", "one_candidate_publish", "same_run_sync_readback", "cleanup"],
    proofs: ["published_url_or_exact_blocker", "same_run_source_of_truth_readback", "cleanup_receipt"],
    blocker: "sns_browser_use_cli_input_bundle_missing",
  },
  "x-authenticated-browser-lane": {
    key: "X_AUTHENTICATED_BROWSER_LANE",
    runnerKey: "x_authenticated_browser_lane",
    stages: ["source_readback", "account_preflight", "browser_preflight", "one_candidate_publish", "same_run_sync_readback", "cleanup"],
    proofs: ["published_url_or_exact_blocker", "same_run_source_of_truth_readback", "cleanup_receipt"],
    blocker: "x_browser_use_cli_input_bundle_missing",
  },
});

test("Chrome Plugin/Profile 2 is the safe default when no backend is injected", () => {
  assert.equal(selectedBackend({}), "chrome_plugin");
  assert.equal(selectedBrowserSurface({}), "signed_chrome_extension_profile2");
  assert.equal(selectedBrowserSurfaceMismatch({}), null);
});

test("AOS Chrome Companion is recognized without becoming an implicit effectful fallback", () => {
  const environment = { AOS_WEB_OPERATION_BACKEND: "aos_chrome_companion" };
  assert.equal(selectedBackend(environment), "aos_chrome_companion");
  assert.equal(selectedBrowserSurface(environment), "aos_chrome_companion_profile_instance");
  assert.equal(selectedBrowserSurfaceMismatch(environment), null);
  const result = spawnSync(process.execPath, [RUNNER,
    "--workflow-id", "daily-ai-research-publish-run",
    "--run-id", "run_companion_no_effect_admission",
    "--step-id", "step_companion_no_effect_admission",
    "--source-trigger", "automation_os_ui",
    "--idempotency-key", "companion-no-effect-admission",
  ], { encoding: "utf8", env: { PATH: process.env.PATH, ...environment } });
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.stderr, "");
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.browser_surface, "aos_chrome_companion_profile_instance");
  assert.equal(receipt.exact_blocker, "portable_external_effects_disabled");
  assert.equal(receipt.external_action_executed, false);
});

test("Chrome Plugin/Profile 2 fails closed when the selector surface mismatches", () => {
  const environment = {
    AOS_WEB_OPERATION_BACKEND: "chrome_plugin",
    AOS_CHROME_PROFILE_SURFACE: "browser_use_cli",
  };
  assert.equal(selectedBrowserSurface(environment), "browser_use_cli");
  assert.equal(selectedBrowserSurfaceMismatch(environment), "portable_external_business_surface_mismatch");

  const result = spawnSync(process.execPath, [RUNNER,
    "--workflow-id", "daily-ai-research-publish-run",
    "--run-id", "run_chrome_surface_mismatch",
    "--step-id", "step_chrome_surface_mismatch",
    "--source-trigger", "automation_os_scheduler",
    "--idempotency-key", "chrome-surface-mismatch-idempotency",
  ], { encoding: "utf8", env: { PATH: process.env.PATH, ...environment } });
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.stderr, "");
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.exact_blocker, "portable_external_business_surface_mismatch");
  assert.equal(receipt.external_action_executed, false);
  assert.deepEqual(receipt.binding_readback, {
    selected_browser_surface: "browser_use_cli",
    expected_browser_surface: "signed_chrome_extension_profile2",
  });
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundFiles(root, workflowId, runId, stepId, idempotencyKey, browserSurface = "browser_use_cli", backend = browserSurface) {
  const spec = WORKFLOWS[workflowId];
  const admissionValue = {
    schema: "automation_os_portable_external_admission.v1",
    workflow_id: workflowId,
    run_id: runId,
    step_id: stepId,
    source_trigger: "automation_os_scheduler",
    idempotency_key: idempotencyKey,
    audience: "portable_external_runner",
    browser_surface: browserSurface,
    approval_status: "approved",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const admissionBytes = `${JSON.stringify(admissionValue, null, 2)}\n`;
  const admissionPath = join(root, `${workflowId}-admission.json`);
  writeFileSync(admissionPath, admissionBytes, { mode: 0o600 });

  mkdirSync(join(root, runId), { recursive: true, mode: 0o700 });
  const actionPlanValue = {
    schema: "automation_os_portable_external_action_plan.v1",
    issued_by: "automation_os_worker",
    workflow_id: workflowId,
    runner_key: spec.runnerKey,
    run_id: runId,
    step_id: stepId,
    source_trigger: "automation_os_scheduler",
    idempotency_key: idempotencyKey,
    web_operation_backend: backend,
    web_operation_backend_revision: 1,
    browser_surface: browserSurface,
    external_effect_policy: "approved",
    approval_status: "approved",
    allowed_stages: spec.stages,
    required_business_proofs: spec.proofs,
    web_operation_contract: WEB_OPERATION_CONTRACT,
    input_bundle_sha256: null,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const actionPlanBytes = `${JSON.stringify(actionPlanValue, null, 2)}\n`;
  const actionPlanPath = join(root, runId, "portable-external-action-plan.v1.json");
  writeFileSync(actionPlanPath, actionPlanBytes, { mode: 0o600 });

  const authorityValue = {
    schema: "automation_os_portable_external_effect_authority.v1",
    authority_id: `portable-default-binding-${workflowId}`,
    issued_by: "automation_os_portable_controller",
    company_id: "company_1",
    workflow_id: workflowId,
    run_id: runId,
    step_id: stepId,
    effect_stage: "business_effect",
    effect_class: "external_non_idempotent",
    approval_id: "approval_default_binding",
    approval_status: "approved",
    idempotency_key: idempotencyKey,
    target_digest: "a".repeat(64),
    input_bundle_sha256: "b".repeat(64),
    payload_hash: "c".repeat(64),
    external_action_authorized: true,
    first_class_root_required: false,
    timeout_controller: "automation_os_portable_controller",
    reconciliation_required: true,
    reconciliation_owner: "automation_os_portable_controller",
    no_auto_retry: true,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const authorityBytes = `${JSON.stringify(authorityValue, null, 2)}\n`;
  const authorityPath = join(root, runId, "portable-effect-authority.v1.json");
  writeFileSync(authorityPath, authorityBytes, { mode: 0o600 });
  return {
    admissionPath,
    admissionSha256: sha256(admissionBytes),
    actionPlanPath,
    actionPlanSha256: sha256(actionPlanBytes),
    authorityPath,
    authoritySha256: sha256(authorityBytes),
    authorityId: authorityValue.authority_id,
  };
}

function invokeNoLaunch(workflowId) {
  const root = mkdtempSync(join(tmpdir(), "aos-portable-business-default-binding-"));
  const runId = `run_${WORKFLOWS[workflowId].key.toLowerCase()}_default_binding`;
  const stepId = `step_${WORKFLOWS[workflowId].key.toLowerCase()}_default_binding`;
  const idempotencyKey = `${runId}-idempotency`;
  const files = boundFiles(root, workflowId, runId, stepId, idempotencyKey);
  const result = spawnSync(process.execPath, [RUNNER,
    "--workflow-id", workflowId,
    "--run-id", runId,
    "--step-id", stepId,
    "--source-trigger", "automation_os_scheduler",
    "--idempotency-key", idempotencyKey,
  ], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      AUTOMATION_OS_REPO_ROOT: ROOT,
      AUTOMATION_OS_ARTIFACT_ROOT: root,
      AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS: "enabled",
      AOS_WEB_OPERATION_BACKEND: "browser_use_cli",
      AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL: "approved",
      AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_PATH: files.admissionPath,
      AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_SHA256: files.admissionSha256,
      AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_PATH: files.actionPlanPath,
      AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_SHA256: files.actionPlanSha256,
      AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH: files.authorityPath,
      AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256: files.authoritySha256,
      AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_ID: files.authorityId,
      AUTOMATION_OS_PORTABLE_BUSINESS_NO_LAUNCH: "1",
    },
  });
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout.trim());
}

test("clean worker binding resolves both workflow-specific AOS business runners", () => {
  const environment = { AUTOMATION_OS_REPO_ROOT: ROOT, AOS_WEB_OPERATION_BACKEND: "browser_use_cli" };
  assert.equal(runnerFor("daily-ai-research-publish-run", environment), join(ROOT, "scripts", "aos-daily-ai-business-runner.mjs"));
  assert.equal(runnerFor("nisenprints-daily-product-canva-printify-etsy-pinterest", environment), join(ROOT, "scripts", "aos-nisenprints-business-runner.mjs"));
  const binding = businessRunnerBindingEnvironment(environment);
  assert.equal(binding.AOS_WEB_OPERATION_BACKEND, "browser_use_cli");
  assert.equal(binding.AUTOMATION_OS_BROWSER_DRIVER, "browser_use_cli");
  assert.equal(binding.AUTOMATION_OS_BROWSER_SURFACE, "browser_use_cli");
  assert.equal(binding.AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_DAILY_AI, join(ROOT, "scripts", "aos-daily-ai-business-runner.mjs"));
  assert.equal(binding.AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_NISENPRINTS, join(ROOT, "scripts", "aos-nisenprints-business-runner.mjs"));
});

test("Browser Use CLI X workflow resolves its own registered runner", () => {
  const projectRoot = "/tmp/browser-use-project";
  assert.equal(
    runnerFor("x-authenticated-browser-lane", {
      AUTOMATION_OS_BROWSER_USE_PROJECT_ROOT: projectRoot,
      AOS_WEB_OPERATION_BACKEND: "browser_use_cli",
    }),
    join(projectRoot, "scripts", "run_x_authenticated_browser_lane_browser_use_cli.mjs"),
  );
});

test("Browser Use CLI SNS workflow resolves its own registered runner", () => {
  const projectRoot = "/tmp/browser-use-project";
  assert.equal(
    runnerFor("sns-multi-poster-ukiyoe", {
      AUTOMATION_OS_BROWSER_USE_PROJECT_ROOT: projectRoot,
      AOS_WEB_OPERATION_BACKEND: "browser_use_cli",
    }),
    join(projectRoot, "scripts", "run_sns_multi_poster_ukiyoe_browser_use_cli.mjs"),
  );
});

test("Chrome Plugin worker binding cannot inherit the Browser Use job runner", () => {
  const environment = {
    AUTOMATION_OS_REPO_ROOT: ROOT,
    AOS_WEB_OPERATION_BACKEND: "chrome_plugin",
    AUTOMATION_OS_BROWSER_USE_PROJECT_ROOT: "/tmp/browser-use-project",
    AUTOMATION_OS_CHROME_PLUGIN_PROJECT_ROOT: "/tmp/chrome-plugin-project",
    AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_JOB_APPLICATION: "/tmp/browser-use-project/scripts/browser_use/job_manager_browser_use_cli_business_runner.mjs",
  };
  assert.equal(
    runnerFor("job-application-manager", environment),
    join(ROOT, "scripts", "aos-job-chrome-plugin-business-runner.mjs"),
  );
  assert.equal(
    runnerFor("daily-ai-research-publish-run", environment),
    join("/tmp/chrome-plugin-project", "scripts", "run_daily_ai_chrome_plugin_registered.mjs"),
  );
  assert.equal(
    runnerFor("sns-multi-poster-ukiyoe", environment),
    join("/tmp/chrome-plugin-project", "scripts", "run_sns_multi_poster_chrome_plugin_registered.mjs"),
  );
  assert.equal(
    runnerFor("x-authenticated-browser-lane", environment),
    join("/tmp/chrome-plugin-project", "scripts", "run_sns_multi_poster_chrome_plugin_registered.mjs"),
  );
  assert.equal(
    runnerFor("prompt-transfer-ukiyoe", environment),
    join("/tmp/chrome-plugin-project", "scripts", "run_prompt_transfer_chrome_plugin_registered.mjs"),
  );
  assert.equal(
    runnerFor("nisenprints-daily-product-canva-printify-etsy-pinterest", environment),
    join("/tmp/chrome-plugin-project", "scripts", "run_nisenprints_chrome_plugin_registered.mjs"),
  );
  assert.equal(
    runnerFor("daily-ai-research-publish-run", { AUTOMATION_OS_REPO_ROOT: ROOT, AOS_WEB_OPERATION_BACKEND: "playwright" }),
    join(ROOT, "scripts", "aos-playwright-business-runner.mjs"),
  );
  const binding = businessRunnerBindingEnvironment(environment);
  assert.equal(binding.AUTOMATION_OS_CHROME_PLUGIN_PROJECT_ROOT, "/tmp/chrome-plugin-project");
  assert.equal(binding.AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_JOB_APPLICATION, undefined);
});

test("generic web-operation intent dispatches Daily AI and NisenPrints through the common AOS runner", () => {
  for (const workflowId of Object.keys(WORKFLOWS)) {
    const root = mkdtempSync(join(tmpdir(), "aos-generic-web-operation-dispatch-"));
    const repoRoot = join(root, "repo");
    const genericRunner = join(repoRoot, "scripts", "aos-portable-browser-use-runner.mjs");
    mkdirSync(join(repoRoot, "scripts"), { recursive: true, mode: 0o700 });
    writeFileSync(
      genericRunner,
      '#!/usr/bin/env node\n// codex-browser-use common semantic batch runner\nprocess.stdout.write(JSON.stringify({status:"complete",exact_blocker:null,external_action_executed:false,browser_surface:"browser_use_cli",run_id:process.env.AUTOMATION_OS_PORTABLE_BUSINESS_RUN_ID,same_run_receipt:true,cleanup_verified:true,web_operation_lifecycle:{status:"complete",exact_blocker:null}})+"\\n");\n',
      { mode: 0o700 },
    );
    chmodSync(genericRunner, 0o700);

    const runId = `run_generic_web_${WORKFLOWS[workflowId].key.toLowerCase()}`;
    const stepId = `step_generic_web_${WORKFLOWS[workflowId].key.toLowerCase()}`;
    const idempotencyKey = `${runId}-idempotency`;
    const files = boundFiles(root, workflowId, runId, stepId, idempotencyKey);
    const intentPath = join(root, runId, "web-operation-intent.v1.json");
    const intentBytes = `${JSON.stringify({
      schema: "automation_os_web_operation_intent.v1",
      operation: "read",
      workflow_id: workflowId,
      run_id: runId,
      step_id: stepId,
      source_trigger: "automation_os_scheduler",
      idempotency_key: idempotencyKey,
      account_ref: workflowId === "daily-ai-research-publish-run" ? "daily_ai_social_readback" : "nisenprints_authenticated_workflow",
      allowed_origins: [workflowId === "daily-ai-research-publish-run" ? "https://x.com" : "https://www.canva.com"],
      entry_url: workflowId === "daily-ai-research-publish-run" ? "https://x.com/home" : "https://www.canva.com/",
      target: { semantic_query: "アカウント" },
      approval_status: "not_required",
      readback_required: true,
      no_replay: true,
    })}\n`;
    writeFileSync(intentPath, intentBytes, { mode: 0o600 });

    const result = spawnSync(process.execPath, [RUNNER,
      "--workflow-id", workflowId,
      "--run-id", runId,
      "--step-id", stepId,
      "--source-trigger", "automation_os_scheduler",
      "--idempotency-key", idempotencyKey,
    ], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        AUTOMATION_OS_REPO_ROOT: repoRoot,
        AUTOMATION_OS_ARTIFACT_ROOT: root,
        AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS: "enabled",
        AOS_WEB_OPERATION_BACKEND: "browser_use_cli",
        AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_DAILY_AI: genericRunner,
        AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL: "approved",
        AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_PATH: files.admissionPath,
        AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_SHA256: files.admissionSha256,
        AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_PATH: files.actionPlanPath,
        AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_SHA256: files.actionPlanSha256,
        AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH: files.authorityPath,
        AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256: files.authoritySha256,
        AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_ID: files.authorityId,
        AUTOMATION_OS_PORTABLE_WEB_OPERATION_INTENT_PATH: intentPath,
        AUTOMATION_OS_PORTABLE_WEB_OPERATION_INTENT_SHA256: sha256(intentBytes),
      },
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const receipt = JSON.parse(result.stdout.trim());
    assert.equal(receipt.status, "complete");
    assert.equal(receipt.external_action_executed, false);
    assert.equal(receipt.runner_receipt.generic_web_operation, true);
    assert.equal(receipt.web_operation_lifecycle.status, "complete");
  }
});

test("business runner binds the canonical package Browser Use helper during installed-helper drift", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "aos-browser-use-helper-binding-"));
  const helperPath = join(projectRoot, "browser-use-cli", "bin", "codex-browser-use");
  mkdirSync(join(projectRoot, "browser-use-cli", "bin"), { recursive: true, mode: 0o700 });
  writeFileSync(helperPath, "#!/usr/bin/env python3\n", { mode: 0o700 });
  const binding = businessRunnerBindingEnvironment({ AUTOMATION_OS_BROWSER_USE_PROJECT_ROOT: projectRoot });
  assert.equal(binding.BROWSER_USE_CLI_HELPER, helperPath);
});

test("Playwright selection reaches its workflow-owned entrypoint and remains effect-blocked", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-playwright-entrypoint-only-"));
  const workflowId = "daily-ai-research-publish-run";
  const runId = "run_playwright_entrypoint_only";
  const stepId = "step_playwright_entrypoint_only";
  const idempotencyKey = `${runId}-idempotency`;
  const files = boundFiles(root, workflowId, runId, stepId, idempotencyKey, "playwright", "playwright");
  const result = spawnSync(process.execPath, [RUNNER,
    "--workflow-id", workflowId,
    "--run-id", runId,
    "--step-id", stepId,
    "--source-trigger", "automation_os_scheduler",
    "--idempotency-key", idempotencyKey,
  ], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      AUTOMATION_OS_REPO_ROOT: ROOT,
      AUTOMATION_OS_ARTIFACT_ROOT: root,
      AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS: "enabled",
      AOS_WEB_OPERATION_BACKEND: "playwright",
      AOS_WEB_OPERATION_BACKEND_REVISION: "1",
      AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL: "approved",
      AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_PATH: files.admissionPath,
      AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_SHA256: files.admissionSha256,
      AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_PATH: files.actionPlanPath,
      AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_SHA256: files.actionPlanSha256,
      AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH: files.authorityPath,
      AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256: files.authoritySha256,
      AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_ID: files.authorityId,
    },
  });
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.browser_surface, "playwright");
  assert.equal(receipt.exact_blocker, "playwright_effect_stages_not_implemented");
  assert.equal(receipt.external_action_executed, false);
  assert.equal(receipt.workflow_id, workflowId);
  assert.equal(receipt.run_id, runId);
  assert.equal(receipt.step_id, stepId);
});

test("flat business receipt cannot claim external completion without a strict lifecycle proof", () => {
  const input = {
    workflow_id: "daily-ai-research-publish-run",
    run_id: "run_flat_receipt_lifecycle_guard",
    step_id: "step_flat_receipt_lifecycle_guard",
    idempotency_key: "flat-receipt-lifecycle-guard"
  };
  const authority = {
    target_digest: "a".repeat(64),
    payload_hash: "b".repeat(64)
  };
  const receipt = {
    status: "complete",
    exact_blocker: null,
    run_id: input.run_id,
    external_action_executed: true,
    same_run_receipt: true,
    cleanup_verified: true,
    runner_receipt: { same_run_source_sync: true, business_proofs: {} }
  };
  const lifecycle = buildBusinessWebOperationLifecycle({ input, receipt, authority, externalActionExecuted: true });
  assert.equal(lifecycle.status, "blocked");
  assert.equal(lifecycle.state, "effect_unknown");
  assert.equal(lifecycle.exact_blocker, "portable_external_business_lifecycle_proof_missing");
  assert.equal(lifecycle.lifecycle_proof_verified, false);
});

test("Playwright entrypoint exposes an explicit no-fallback capability receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-playwright-entrypoint-receipt-"));
  const runId = "run_playwright_capability_receipt";
  const stepId = "step_playwright_capability_receipt";
  const result = spawnSync(process.execPath, [join(ROOT, "scripts", "aos-playwright-business-runner.mjs")], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      AUTOMATION_OS_PORTABLE_BUSINESS_RUN_ID: runId,
      AUTOMATION_OS_PORTABLE_BUSINESS_STEP_ID: stepId,
      AUTOMATION_OS_PORTABLE_BUSINESS_WORKFLOW_ID: "daily-ai-research-publish-run",
      AUTOMATION_OS_ARTIFACT_ROOT: root,
    },
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.equal(result.stderr, "");
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.status, "blocked");
  assert.equal(receipt.exact_blocker, "playwright_effect_stages_not_implemented");
  assert.equal(receipt.external_action_executed, false);
  assert.equal(receipt.browser_surface, "playwright");
  assert.equal(receipt.run_id, runId);
  assert.equal(receipt.step_id, stepId);
  assert.equal(receipt.same_run_receipt, false);
  assert.equal(receipt.cleanup_verified, true);
  assert.deepEqual(receipt.runner_receipt && {
    adapter_mode: receipt.runner_receipt.adapter_mode,
    effect_stages_implemented: receipt.runner_receipt.effect_stages_implemented,
    browser_session_started: receipt.runner_receipt.browser_session_started,
    cleanup_verified: receipt.runner_receipt.cleanup_verified,
    fallback_allowed: receipt.runner_receipt.fallback_allowed,
  }, {
    adapter_mode: "entrypoint_only",
    effect_stages_implemented: false,
    browser_session_started: false,
    cleanup_verified: true,
    fallback_allowed: false,
  });
});

test("strict lifecycle proof is required before a business effect can be complete", () => {
  const input = {
    workflow_id: "daily-ai-research-publish-run",
    run_id: "run_strict_lifecycle_guard",
    step_id: "step_strict_lifecycle_guard",
    idempotency_key: "strict-lifecycle-guard"
  };
  const authority = {
    target_digest: "c".repeat(64),
    payload_hash: "d".repeat(64)
  };
  const receipt = {
    status: "complete",
    exact_blocker: null,
    run_id: input.run_id,
    external_action_executed: true,
    same_run_receipt: true,
    cleanup_verified: true,
    runner_receipt: { same_run_source_sync: true, business_proofs: {} },
    web_operation_lifecycle: {
      schema: "automation_os_web_operation_lifecycle.v1",
      state: "cleaned",
      status: "complete",
      exact_blocker: null,
      run_id: input.run_id,
      step_id: input.step_id,
      idempotency_key: input.idempotency_key,
      operation: "publish",
      target_digest: authority.target_digest,
      payload_hash: authority.payload_hash,
      source_state_digest: "e".repeat(64),
      dispatch_state: "executed",
      dispatch_attempted: true,
      external_action_executed: true,
      same_run_receipt: true,
      readback_verified: true,
      cleanup_verified: true,
      no_replay: true
    }
  };
  const lifecycle = buildBusinessWebOperationLifecycle({ input, receipt, authority, externalActionExecuted: true });
  assert.equal(lifecycle.status, "complete");
  assert.equal(lifecycle.state, "cleaned");
  assert.equal(lifecycle.exact_blocker, null);
  assert.equal(lifecycle.lifecycle_proof_verified, true);
});

test("business runner child timeout cleans up its owned descendant group", async () => {
  const previousTimeout = process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_TIMEOUT_MS;
  const root = mkdtempSync(join(tmpdir(), "aos-business-process-group-timeout-"));
  const pidPath = join(root, "descendant.pid");
  const runner = join(root, "timeout-runner.mjs");
  writeFileSync(runner, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const descendant = spawn(process.execPath, ["--input-type=module", "--eval", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidPath)}, String(descendant.pid));
setInterval(() => {}, 60000);
`, { mode: 0o700 });
  chmodSync(runner, 0o700);
  process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_TIMEOUT_MS = "10000";
  let descendantPid = null;
  try {
    const result = await runChild(runner, {
      workflow_id: "daily-ai-research-publish-run",
      run_id: "run_business_process_group_timeout",
      step_id: "step_business_process_group_timeout",
      source_trigger: "automation_os_scheduler",
      idempotency_key: "business-process-group-timeout",
      admission: { path: join(root, "admission.json"), sha256: "a".repeat(64) }
    });
    descendantPid = Number(readFileSync(pidPath, "utf8"));
    assert.equal(result.timeout, true);
    assert.equal(result.processGroupCleanup?.attempted, true);
    assert.equal(result.processGroupCleanup?.verified, true);
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        process.kill(descendantPid, 0);
        await delay(25);
      } catch {
        break;
      }
    }
    assert.throws(() => process.kill(descendantPid, 0));
  } finally {
    if (descendantPid) {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* fixture already exited */ }
    }
    if (previousTimeout === undefined) delete process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_TIMEOUT_MS;
    else process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_TIMEOUT_MS = previousTimeout;
  }
});

for (const [workflowId, spec] of Object.entries(WORKFLOWS)) {
  test(`generic runner reaches ${workflowId} adapter in no-effect mode`, () => {
    const receipt = invokeNoLaunch(workflowId);
    assert.equal(receipt.exact_blocker, spec.blocker);
    assert.equal(receipt.external_action_executed, false);
    assert.equal(receipt.browser_surface, "browser_use_cli");
    assert.equal(receipt.app_dependency, false);
  });
}

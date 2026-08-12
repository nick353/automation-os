import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { portableBusinessPlanForWorkflow } from "../portable-business-action-plan.mjs";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const BROWSER_RUNNER = join(ROOT, "scripts", "aos-portable-browser-use-runner.mjs");
const BUSINESS_RUNNER = join(ROOT, "scripts", "aos-portable-business-runner.mjs");
const ADAPTER = join(ROOT, "scripts", "tests", "fixtures", "web-operation-effect-adapter.mjs");
const ORIGIN = "https://fixture.example.com";
const WORKFLOW_ID = "daily-ai-research-publish-run";
const SOURCE_STATE_DIGEST = sha256("fixture-source-state");

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function writeJson(filePath, value) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(resolve(filePath, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, bytes, { encoding: "utf8", mode: 0o600 });
  chmodSync(filePath, 0o600);
  return { path: filePath, sha256: sha256(bytes) };
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function targetTextFor(operation) {
  return {
    create: "Create",
    update: "Save",
    publish: "Publish",
    submit: "Submit",
    delete: "Delete",
  }[operation];
}

function fixtureIntent({ root, operation, runId = `entrypoint-${operation}`, sourceStateDigest = SOURCE_STATE_DIGEST, accountRef = "fixture-account", authorityApproval = "approved" } = {}) {
  const stepId = `entrypoint-${operation}-step`;
  const sourceTrigger = "fixture-e2e";
  const idempotencyKey = `entrypoint-${operation}-idempotency`;
  const targetText = targetTextFor(operation);
  const payload = operation === "create" || operation === "update" ? { text: `${operation} fixture content` } : {};
  const payloadHash = sha256(JSON.stringify(payload));
  const targetDigest = sha256(targetText);
  const actionPlan = {
    schema: "automation_os_web_operation_action_plan.v1",
    steps: [
      ...(Object.keys(payload).length ? [{ action: "fill_target", target: { semantic_query: "Content" }, payload_key: "text" }] : []),
      { action: "click_target", target: { semantic_query: targetText } },
    ],
    payload,
    payload_hash: payloadHash,
    readback: { semantic_query: operation === "delete" ? "Existing record" : `${targetText} record`, expected: operation === "delete" ? "absent" : "present" },
  };
  const runRoot = join(root, runId);
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  const authorityBody = {
    schema: "automation_os_portable_external_effect_authority.v1",
    authority_id: `entrypoint-authority-${operation}`,
    issued_by: "automation_os_portable_controller",
    company_id: "fixture-company",
    workflow_id: WORKFLOW_ID,
    run_id: runId,
    step_id: stepId,
    effect_stage: "web_operation_effect",
    effect_class: "external_non_idempotent",
    browser_surface: "browser_use_cli",
    approval_id: `entrypoint-approval-${operation}`,
    approval_status: authorityApproval,
    idempotency_key: idempotencyKey,
    target_digest: targetDigest,
    input_bundle_sha256: sha256(`${runId}:fixture-input`),
    payload_hash: payloadHash,
    issued_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    timeout_ms: 60_000,
    timeout_controller: "automation_os_portable_controller",
    reconciliation_required: true,
    reconciliation_owner: "automation_os_portable_controller",
    no_auto_retry: true,
    first_class_root_required: false,
    app_dependency: false,
    external_action_authorized: true,
  };
  const authority = writeJson(join(runRoot, "portable-effect-authority.v1.json"), authorityBody);
  const intent = {
    schema: "automation_os_web_operation_intent.v1",
    browser_surface: "browser_use_cli",
    operation,
    workflow_id: WORKFLOW_ID,
    run_id: runId,
    step_id: stepId,
    source_trigger: sourceTrigger,
    idempotency_key: idempotencyKey,
    account_ref: accountRef,
    allowed_origins: [ORIGIN],
    entry_url: `${ORIGIN}/app`,
    target: { semantic_query: targetText },
    target_binding: { target_digest: targetDigest, source_state_digest: sourceStateDigest },
    action_plan: actionPlan,
    payload_hash: payloadHash,
    approval_status: authorityApproval,
    authority_sha256: authority.sha256,
    readback_required: true,
    no_replay: true,
  };
  const intentFile = writeJson(join(runRoot, "web-operation-intent.v1.json"), intent);
  const admission = writeJson(join(runRoot, "portable-external-admission.v1.json"), {
    schema: "automation_os_portable_external_admission.v1",
    workflow_id: WORKFLOW_ID,
    run_id: runId,
    step_id: stepId,
    source_trigger: sourceTrigger,
    idempotency_key: idempotencyKey,
    approval_status: "approved",
    effect_class: "external_non_idempotent",
    browser_surface: "browser_use_cli",
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  const plan = portableBusinessPlanForWorkflow(WORKFLOW_ID);
  const actionPlanFile = writeJson(join(runRoot, "portable-business-action-plan.v1.json"), {
    schema: "automation_os_portable_external_action_plan.v1",
    version: "1",
    runner_key: plan.runner_key,
    workflow_id: WORKFLOW_ID,
    run_id: runId,
    step_id: stepId,
    source_trigger: sourceTrigger,
    idempotency_key: idempotencyKey,
    browser_surface: "browser_use_cli",
    external_effect_policy: "approved",
    approval_status: "approved",
    allowed_stages: plan.stages,
    required_business_proofs: plan.required_business_proofs,
    input_bundle_sha256: null,
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    web_operation_contract: plan.web_operation_contract,
  });
  return {
    root,
    runRoot,
    runId,
    stepId,
    sourceTrigger,
    idempotencyKey,
    authority,
    intentFile,
    admission,
    actionPlanFile,
    intent,
  };
}

function baseEnvironment(root, routePath) {
  return {
    AUTOMATION_OS_ARTIFACT_ROOT: root,
    AUTOMATION_OS_WEB_OPERATION_ROUTES_PATH: routePath,
    AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS: "enabled",
    AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL: "approved",
    AUTOMATION_OS_BROWSER_SURFACE: "browser_use_cli",
    AUTOMATION_OS_BROWSER_NO_FALLBACK: "1",
    AUTOMATION_OS_BROWSER_REQUIRED: "1",
    CODEX_BROWSER_USE_TEST_SEAM: "1",
    AUTOMATION_OS_WEB_OPERATION_TEST_ADAPTER: ADAPTER,
    AUTOMATION_OS_PORTABLE_EXTERNAL_TIMEOUT_MS: "10000",
    AUTOMATION_OS_PORTABLE_EXTERNAL_WORKDIR: root,
  };
}

function operationEnvironment(fixture, root, routePath, extras = {}) {
  return {
    ...baseEnvironment(root, routePath),
    AUTOMATION_OS_PORTABLE_WEB_OPERATION_INTENT_PATH: fixture.intentFile.path,
    AUTOMATION_OS_PORTABLE_WEB_OPERATION_INTENT_SHA256: fixture.intentFile.sha256,
    AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_PATH: fixture.admission.path,
    AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_SHA256: fixture.admission.sha256,
    AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH: fixture.authority.path,
    AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256: fixture.authority.sha256,
    AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_ID: readJson(fixture.authority.path).authority_id,
    AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_PATH: fixture.actionPlanFile.path,
    AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_SHA256: fixture.actionPlanFile.sha256,
    ...extras,
  };
}

function spawnJson(command, args, environment) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [command, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`fixture_child_timeout:${command}`));
    }, 20_000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      const lines = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
      let value = null;
      for (const line of lines.reverse()) {
        try { value = JSON.parse(line); break; } catch { /* continue to the last JSON line */ }
      }
      resolveResult({ code, signal, stdout, stderr, value });
    });
  });
}

function makeRouteRegistry(root, routes = [{ account_ref: "fixture-account", automation_id: "fixture-web", stage_id: "fixture-web-effect", allowed_origins: [ORIGIN], account_identity: "fixture-account", port: 19885 }]) {
  return writeJson(join(root, "web-operation-routes.v1.json"), {
    schema: "automation_os_web_operation_route_registry.v1",
    routes,
  });
}

function runnerArgs(fixture) {
  return [
    "--workflow-id", WORKFLOW_ID,
    "--run-id", fixture.runId,
    "--step-id", fixture.stepId,
    "--source-trigger", fixture.sourceTrigger,
    "--idempotency-key", fixture.idempotencyKey,
  ];
}

test("canonical Browser Use CLI entrypoint executes every generic operation with semantic targets and cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "aos-web-operation-entrypoint-"));
  try {
    const route = makeRouteRegistry(root);
    for (const operation of ["create", "update", "publish", "submit", "delete"]) {
      const fixture = fixtureIntent({ root, operation });
      const result = await spawnJson(BROWSER_RUNNER, runnerArgs(fixture), operationEnvironment(fixture, root, route.path));
      assert.equal(result.code, 0, `${operation}: ${JSON.stringify(result.value)} stdout=${result.stdout} stderr=${result.stderr}`);
      assert.equal(result.value?.status, "complete", operation);
      assert.equal(result.value?.operation, operation, operation);
      assert.equal(result.value?.external_action_executed, true, operation);
      assert.equal(result.value?.same_run_receipt, true, operation);
      assert.equal(result.value?.cleanup_verified, true, operation);
      assert.equal(result.value?.readback_verified, true, operation);
      assert.equal(result.value?.source_state_digest, fixture.intent.target_binding.source_state_digest, operation);
      assert.equal(result.value?.web_operation_lifecycle?.state, "cleaned", operation);
      assert.equal(result.value?.web_operation_lifecycle?.no_replay, true, operation);
      const claim = readJson(join(fixture.runRoot, "web-operation-effect-claim.v1.json"));
      assert.equal(claim.lifecycle_state, "cleaned", operation);
      assert.equal(claim.external_action_executed, true, operation);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generic business runner delegates to the canonical entrypoint and preserves the lifecycle receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "aos-web-operation-business-entrypoint-"));
  try {
    const route = makeRouteRegistry(root);
    const fixture = fixtureIntent({ root, operation: "publish", runId: "business-entrypoint-publish" });
    const result = await spawnJson(BUSINESS_RUNNER, runnerArgs(fixture), operationEnvironment(fixture, root, route.path));
    assert.equal(result.code, 0, `${JSON.stringify(result.value)} stdout=${result.stdout} stderr=${result.stderr}`);
    assert.equal(result.value?.status, "complete");
    assert.equal(result.value?.external_action_executed, true);
    assert.equal(result.value?.web_operation_lifecycle?.state, "cleaned");
    assert.equal(result.value?.web_operation_lifecycle?.same_run_receipt, true);
    assert.equal(result.value?.runner_receipt?.generic_web_operation, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same idempotency key never replays an already completed generic effect", async () => {
  const root = mkdtempSync(join(tmpdir(), "aos-web-operation-duplicate-"));
  try {
    const route = makeRouteRegistry(root);
    const fixture = fixtureIntent({ root, operation: "publish", runId: "duplicate-entrypoint-publish" });
    const environment = operationEnvironment(fixture, root, route.path);
    const first = await spawnJson(BROWSER_RUNNER, runnerArgs(fixture), environment);
    assert.equal(first.code, 0);
    const second = await spawnJson(BROWSER_RUNNER, runnerArgs(fixture), environment);
    assert.equal(second.code, 1);
    assert.equal(second.value?.exact_blocker, "portable_external_web_operation_duplicate_idempotency_key");
    assert.equal(second.value?.external_action_executed, true);
    assert.equal(second.value?.same_run_receipt, false);
    assert.equal(second.value?.web_operation_lifecycle?.no_replay, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("effect interruption returns effect_unknown, persists reconciliation state, and does not replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "aos-web-operation-unknown-"));
  try {
    const route = makeRouteRegistry(root);
    const fixture = fixtureIntent({ root, operation: "publish", runId: "unknown-entrypoint-publish" });
    const environment = operationEnvironment(fixture, root, route.path, { AUTOMATION_OS_WEB_OPERATION_FIXTURE_FAIL_AFTER_EFFECT: "1" });
    const result = await spawnJson(BROWSER_RUNNER, runnerArgs(fixture), environment);
    assert.equal(result.code, 1);
    assert.equal(result.value?.external_action_executed, true);
    assert.equal(result.value?.same_run_receipt, false);
    assert.equal(result.value?.cleanup_verified, true);
    assert.equal(result.value?.web_operation_lifecycle?.state, "effect_unknown");
    assert.equal(result.value?.web_operation_lifecycle?.no_replay, true);
    assert.equal(readJson(join(fixture.runRoot, "web-operation-effect-claim.v1.json")).lifecycle_state, "effect_unknown");
    const second = await spawnJson(BROWSER_RUNNER, runnerArgs(fixture), operationEnvironment(fixture, root, route.path));
    assert.equal(second.code, 1);
    assert.equal(second.value?.exact_blocker, "portable_external_web_operation_duplicate_idempotency_key");
    assert.equal(second.value?.external_action_executed, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pre-dispatch source-state mismatch, private-origin route, public effect, and pending approval fail closed", async () => {
  const root = mkdtempSync(join(tmpdir(), "aos-web-operation-negative-"));
  try {
    const validRoute = makeRouteRegistry(root);
    const stale = fixtureIntent({ root, operation: "update", runId: "stale-entrypoint-update", sourceStateDigest: sha256("stale-source-state") });
    const staleResult = await spawnJson(BROWSER_RUNNER, runnerArgs(stale), operationEnvironment(stale, root, validRoute.path));
    assert.equal(staleResult.code, 1);
    assert.equal(staleResult.value?.exact_blocker, "web_operation_source_state_binding_mismatch");
    assert.equal(staleResult.value?.external_action_executed, false);

    const privateRoute = makeRouteRegistry(root, [{ account_ref: "fixture-account", automation_id: "fixture-web", stage_id: "fixture-web-effect", allowed_origins: ["http://127.0.0.1"], account_identity: "fixture-account", port: 19885 }]);
    const privateOrigin = fixtureIntent({ root, operation: "create", runId: "private-route-create" });
    const privateResult = await spawnJson(BROWSER_RUNNER, runnerArgs(privateOrigin), operationEnvironment(privateOrigin, root, privateRoute.path));
    assert.equal(privateResult.code, 1);
    assert.equal(privateResult.value?.exact_blocker, "portable_external_web_operation_route_registry_origin_invalid");

    const publicRoute = makeRouteRegistry(root);
    const publicEffect = fixtureIntent({ root, operation: "publish", runId: "public-effect-publish", accountRef: "public" });
    const publicResult = await spawnJson(BROWSER_RUNNER, runnerArgs(publicEffect), operationEnvironment(publicEffect, root, publicRoute.path));
    assert.equal(publicResult.code, 1);
    assert.equal(publicResult.value?.exact_blocker, "portable_external_web_operation_effect_public_forbidden");
    assert.equal(publicResult.value?.external_action_executed, false);

    const pending = fixtureIntent({ root, operation: "submit", runId: "pending-submit", authorityApproval: "pending" });
    const pendingResult = await spawnJson(BROWSER_RUNNER, runnerArgs(pending), operationEnvironment(pending, root, validRoute.path));
    assert.equal(pendingResult.code, 1);
    assert.equal(pendingResult.value?.exact_blocker, "portable_external_web_operation_approval_required");
    assert.equal(pendingResult.value?.external_action_executed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

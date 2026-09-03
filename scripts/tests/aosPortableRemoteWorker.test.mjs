import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import test from "node:test";
import { bindBusinessReceiptToClaim, buildPortableProtectedReadback, buildZeaburConnectorRegistryReadback, claimBrowserEnvironment, createAdmission, createEffectAuthorityFile, createInputBundle, effectAuthorityFromClaim, fixedChromePluginProfile2BlockerForClaim, initialPortableWorkerTargetStatuses, mergePortableRemoteWorkerStatus, normalizePortableRemoteRunnerReceipt, persistPortableProtectedReadback, portableQueueTargets, portableRemoteErrorCode, portableRemoteHttpTimeoutMs, readChromePluginWorkerReadback, requestPortableRemoteJson, runCodexAppListReadback, runZeaburServiceExec, shouldEmitPortableRemoteResult } from "../aos-portable-remote-worker.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runWorker(env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/aos-portable-remote-worker.mjs", ...args], {
      cwd: new URL("../..", import.meta.url),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test("Zeabur reports unauthenticated Codex status as a valid readback, not transport failure", () => {
  const result = runZeaburServiceExec(["codex", "login", "status"], {
    runner: () => ({ status: 1, stdout: "Not logged in\n", stderr: "" })
  });
  assert.deepEqual(result, { ok: true, stdout: "Not logged in\n", exactBlocker: null });
});

test("Zeabur non-login command failures remain readback blockers", () => {
  const result = runZeaburServiceExec(["codex", "mcp", "list", "--json"], {
    runner: () => ({ status: 1, stdout: "", stderr: "command failed" })
  });
  assert.deepEqual(result, { ok: false, stdout: "", exactBlocker: "zeabur_service_exec_readback_failed" });
});

test("Zeabur service exec preserves a 401 as a CLI authentication blocker", () => {
  const result = runZeaburServiceExec(["codex", "mcp", "list", "--json"], {
    runner: () => ({ status: 1, stdout: "", stderr: "execute command failed: 401 Unauthorized" })
  });
  assert.deepEqual(result, { ok: false, stdout: "", exactBlocker: "zeabur_cli_authentication_unavailable" });
});

test("Zeabur registry keeps Not logged in as the unauthenticated state", () => {
  const registry = buildZeaburConnectorRegistryReadback({
    login: "not_logged_in",
    installed: [{ name: "gmail", installed: true }],
    available: [],
    mcp: [],
  });
  assert.equal(registry.appServer.codexLogin, "not_logged_in");
  assert.equal(registry.exactBlocker, "zeabur_codex_app_server_login_not_verified");
});

test("Codex app list readback is sanitized and does not persist URLs", () => {
  const result = runCodexAppListReadback({
    runner: (_command, args) => ({
      status: 0,
      stdout: JSON.stringify({ ok: true, apps: [{ id: "gmail-app", name: "Gmail", isAccessible: true, isEnabled: true, installUrl: "https://secret.example.test/?token=redacted" }] }),
      stderr: "",
      args,
    }),
  });
  assert.deepEqual(result, {
    ok: true,
    apps: [{ id: "gmail-app", name: "Gmail", isAccessible: true, isEnabled: true }],
    exactBlocker: null,
  });
});

test("Verified official Gmail app access clears the plugin auth blocker", () => {
  const registry = buildZeaburConnectorRegistryReadback({
    login: "logged_in",
    installed: [{ name: "gmail", installed: true }],
    available: [],
    mcp: [],
    appReadback: { ok: true, apps: [{ id: "gmail-app", name: "Gmail", isAccessible: true, isEnabled: true }] },
  });
  assert.equal(registry.connectorAuth.gmail, "verified");
  assert.equal(registry.connectorAccess.stateReadbackAvailable, true);
  assert.equal(registry.exactBlocker, null);
});

test("Official Google Drive app display name matches the hyphenated plugin name", () => {
  const registry = buildZeaburConnectorRegistryReadback({
    login: "logged_in",
    installed: [{ name: "google-drive", installed: true }],
    available: [],
    mcp: [],
    appReadback: { ok: true, apps: [{ id: "drive-app", name: "Google Drive", isAccessible: true, isEnabled: true }] },
  });
  assert.equal(registry.connectorAuth["google-drive"], "verified");
  assert.equal(registry.pluginRegistry.installed[0].authStatus, "verified");
});

test("Unavailable official app access fails closed before connector auth", () => {
  const registry = buildZeaburConnectorRegistryReadback({
    login: "logged_in",
    installed: [{ name: "gmail", installed: true }],
    available: [],
    mcp: [],
    appReadback: { ok: false, apps: [], exactBlocker: "codex_app_server_app_list_readback_timeout" },
  });
  assert.equal(registry.connectorAuth.gmail, "unverified");
  assert.equal(registry.exactBlocker, "zeabur_connector_access_readback_failed");
});

test("Chrome Plugin claim preserves the selected backend revision for action-plan binding", () => {
  const environment = claimBrowserEnvironment({
    browser_surface: "signed_chrome_extension_profile2",
    web_operation_backend: {
      requested_backend: "chrome_plugin",
      resolved_backend: "chrome_plugin",
      source: "aos_global_setting",
      fallback_allowed: false,
      revision: 8,
      chrome_profile: { id: "profile2", name: "Profile 2", directory: "Profile 2", surface: "signed_chrome_extension_profile2" }
    }
  });
  assert.equal(environment.AOS_WEB_OPERATION_BACKEND, "chrome_plugin");
  assert.equal(environment.AOS_WEB_OPERATION_BACKEND_REVISION, "8");
  assert.equal(environment.AOS_WEB_OPERATION_BACKEND_SOURCE, "aos_global_setting");
  assert.equal(environment.AOS_WEB_OPERATION_BACKEND_FALLBACK_ALLOWED, "false");
  assert.equal(environment.AOS_CHROME_PROFILE_SURFACE, "signed_chrome_extension_profile2");
  assert.match(environment.AOS_CHROME_PLUGIN_READBACK_PATH, /aos-company1-profile2-bridge-readback-v2\.json$/u);
  assert.match(environment.AOS_CHROME_PLUGIN_BACKGROUND_READ_ONLY_CAPABILITY_PATH, /aos-chrome-plugin-background-read-only-capability\.v1\.json$/u);
});

test("AOS Chrome Companion claims stay on Companion and clear ambient task ownership", () => {
  const environment = claimBrowserEnvironment({
    browser_surface: "aos_chrome_companion_profile_instance",
    task_id: "task_companion_readback_20260826",
    web_operation_backend: {
      requested_backend: "aos_chrome_companion",
      resolved_backend: "aos_chrome_companion",
      companion_profile_instance_id: "profile_companion_test",
    },
  });
  assert.equal(environment.AUTOMATION_OS_BROWSER_SURFACE, "aos_chrome_companion_profile_instance");
  assert.equal(environment.AOS_WEB_OPERATION_BACKEND, "aos_chrome_companion");
  assert.equal(environment.AUTOMATION_OS_BROWSER_DRIVER, "aos_chrome_companion");
  assert.equal(environment.AOS_CHROME_COMPANION_TASK_ID, "task_companion_readback_20260826");
  assert.equal(environment.AOS_CHROME_COMPANION_PROFILE_INSTANCE_ID, "profile_companion_test");

  const missingTask = claimBrowserEnvironment({
    browser_surface: "aos_chrome_companion_profile_instance",
    web_operation_backend: { resolved_backend: "aos_chrome_companion" },
  });
  assert.equal(missingTask.AOS_WEB_OPERATION_BACKEND, "aos_chrome_companion");
  assert.equal(missingTask.AOS_CHROME_COMPANION_TASK_ID, "");
});

test("Job Application Manager accepts the canonical Browser Use CLI and preserves legacy Profile 2 compatibility", () => {
  assert.equal(fixedChromePluginProfile2BlockerForClaim({ workflow_id: "job-application-manager", browser_surface: "browser_use_cli" }), null);
  assert.equal(fixedChromePluginProfile2BlockerForClaim({ workflow_id: "job-application-manager", browser_surface: "signed_chrome_extension_profile2" }), null);
  assert.equal(fixedChromePluginProfile2BlockerForClaim({ workflow_id: "job-application-manager", execution_mode: "read_only", browser_surface: "aos_chrome_companion_profile_instance" }), null);
  assert.equal(fixedChromePluginProfile2BlockerForClaim({ workflow_id: "job-application-manager", execution_mode: "business_effect", browser_surface: "aos_chrome_companion_profile_instance" }), "chrome_plugin_profile2_fixed_old_run_surface_mismatch");
  assert.equal(fixedChromePluginProfile2BlockerForClaim({ workflow_id: "daily-ai-research-publish-run", browser_surface: "browser_use_cli" }), null);
});

test("portable queue authorities keep local UI runs claimable without leaking the remote token", () => {
  const targets = portableQueueTargets({
    AUTOMATION_OS_PORTABLE_QUEUE_AUTHORITY: "remote_and_local",
    AUTOMATION_OS_PORTABLE_REMOTE_URL: "https://remote.example.test",
    AUTOMATION_OS_PORTABLE_REMOTE_COMPANY_ID: "company_queue_authority_regression",
    AUTOMATION_OS_PORTABLE_REMOTE_TOKEN: "remote-token-must-stay-remote",
    AUTOMATION_OS_PORTABLE_LOCAL_QUEUE_URL: "http://127.0.0.1:8787",
    AUTOMATION_OS_PORTABLE_LOCAL_QUEUE_COMPANY_ID: "project-a",
  });
  assert.deepEqual(targets.map(({ kind, baseUrl, companyId }) => ({ kind, baseUrl, companyId })), [
    { kind: "remote", baseUrl: "https://remote.example.test", companyId: "company_queue_authority_regression" },
    { kind: "local", baseUrl: "http://127.0.0.1:8787", companyId: "project-a" },
  ]);
  assert.equal(targets[0].token, "remote-token-must-stay-remote");
  assert.equal(targets[1].token, "");
});

test("local queue authority fails closed when its company scope is not explicit", () => {
  assert.throws(() => portableQueueTargets({
    AUTOMATION_OS_PORTABLE_QUEUE_AUTHORITY: "local",
    AUTOMATION_OS_PORTABLE_LOCAL_QUEUE_URL: "http://127.0.0.1:8787",
  }), /portable_local_queue_company_id_missing/u);
});

test("local setup collision is reported once as a no-effect portable receipt", async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), "aos-portable-remote-worker-test-"));
  const runId = "run_remote_setup_collision_regression";
  const stepId = `${runId}_step_1`;
  const idempotencyKey = "portable-remote-setup-collision-regression";
  const admissionName = `portable-external-admission-${sha256(`${runId}:${stepId}:${idempotencyKey}`).slice(0, 24)}.json`;
  const runRoot = join(artifactRoot, runId);
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(runRoot, admissionName), "{}\n", { mode: 0o600 });

  const claim = {
    run_id: runId,
    company_id: "company_remote_setup_collision_regression",
    workflow_id: "job-application-manager",
    step_id: stepId,
    source_trigger: "automation_os_scheduler",
    idempotency_key: idempotencyKey,
    read_only_stage: "candidate_supply",
    execution_mode: "read_only",
    business_effect_stage: null,
    approval_id: null,
    input_bundle: {
      source_snapshot_id: "snapshot-remote-setup-collision-regression",
      supply_run_id: "supply-remote-setup-collision-regression",
      bucket: "japan_targeted",
      remaining: 0,
      margin: 0,
    },
    input_bundle_sha256: null,
    target_digest: null,
    worker_id: "mac-remote-setup-collision-regression",
    lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
    external_action_executed: false,
    browser_surface: "signed_chrome_extension_profile2",
  };
  let receiptBody = null;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/portable-worker/claim") {
      response.end(JSON.stringify({ ok: true, claimed: true, external_action_executed: false, run: claim }));
      return;
    }
    if (request.url === `/api/portable-worker/${runId}/receipt`) {
      receiptBody = JSON.parse(body);
      response.end(JSON.stringify({ ok: true, replayed: false, receipt: receiptBody.receipt, artifact_uri: "file:///redacted/receipt.json", external_action_executed: false }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ ok: false }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const result = await runWorker({
      AUTOMATION_OS_PORTABLE_REMOTE_TOKEN: "test-token-not-logged",
      AUTOMATION_OS_PORTABLE_REMOTE_URL: `http://127.0.0.1:${address.port}`,
      AUTOMATION_OS_PORTABLE_REMOTE_COMPANY_ID: claim.company_id,
      AUTOMATION_OS_PORTABLE_REMOTE_WORKER_ID: claim.worker_id,
      AUTOMATION_OS_PORTABLE_REMOTE_ARTIFACT_ROOT: artifactRoot,
    }, ["--once"]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout.trim());
    assert.deepEqual(output, {
      status: "blocked",
      run_id: runId,
      workflow_id: claim.workflow_id,
      step_id: stepId,
      exact_blocker: "portable_remote_immutable_collision",
      external_action_executed: false,
      browser_surface: "signed_chrome_extension_profile2",
      cleanup_verified: false,
      readback_verified: false,
      remote_replayed: false,
      child_exit_code: null,
      child_signal: null,
    });
    assert.equal(receiptBody?.receipt?.exact_blocker, "portable_remote_immutable_collision");
    assert.equal(receiptBody?.receipt?.external_action_executed, false);
    assert.equal(receiptBody?.receipt?.effects_mode, "read_only");
  } finally {
    server.close();
    await once(server, "close").catch(() => {});
  }
});

test("Mac remote worker copies canonical input bundle bytes when the remote artifact root differs", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-portable-remote-worker-input-bundle-source-"));
  const runId = "run_remote_input_bundle_source_regression";
  const canonicalRunRoot = join(root, "data", "artifacts", runId);
  const remoteArtifactRoot = join(root, "data", "artifacts", "portable-remote-worker");
  const remoteRunRoot = join(remoteArtifactRoot, runId);
  mkdirSync(canonicalRunRoot, { recursive: true, mode: 0o700 });
  mkdirSync(remoteRunRoot, { recursive: true, mode: 0o700 });
  const input = {
    account_ref: "linkedin_authenticated_job_manager",
    target_key: "job_target_remote_input_bundle_source_regression",
    job_id: "4452349913",
    candidate_key: "job_target_remote_input_bundle_source_regression",
    bucket: "japan_targeted",
    sequence: 1,
    attempt: 4,
    source_snapshot_id: "linkedin-snapshot-remote-input-bundle-source-regression",
  };
  const canonicalBytes = `${JSON.stringify({
    schema: "automation_os_portable_workflow_input_bundle.v1",
    workflow_id: "job-application-manager",
    run_id: runId,
    created_at: "2026-08-17T00:00:00.000Z",
    input,
  }, null, 2)}\n`;
  const sourcePath = join(canonicalRunRoot, "portable-input-bundle.v1.json");
  writeFileSync(sourcePath, canonicalBytes, { mode: 0o600 });
  const claim = { run_id: runId, workflow_id: "job-application-manager", input_bundle: input, input_bundle_sha256: sha256(canonicalBytes) };
  const materialized = createInputBundle(claim, remoteRunRoot, { repoRoot: root, artifactRoot: remoteArtifactRoot });
  assert.equal(readFileSync(materialized.path, "utf8"), canonicalBytes);
  assert.equal(materialized.sha256, claim.input_bundle_sha256);
});

test("Mac worker reconstructs canonical input bundle bytes from the server creation timestamp when the server artifact root is unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-portable-remote-worker-input-bundle-created-at-"));
  const runId = "run_remote_input_bundle_created_at_regression";
  const remoteArtifactRoot = join(root, "remote-artifacts", "portable-remote-worker");
  const remoteRunRoot = join(remoteArtifactRoot, runId);
  mkdirSync(remoteRunRoot, { recursive: true, mode: 0o700 });
  const input = {
    source_snapshot_id: "linkedin-snapshot-created-at-regression",
    supply_run_id: "supply-created-at-regression",
    bucket: "japan_targeted",
    remaining: 1,
    margin: 1,
  };
  const createdAt = "2026-08-18T00:00:00.000Z";
  const canonicalBytes = `${JSON.stringify({
    schema: "automation_os_portable_workflow_input_bundle.v1",
    workflow_id: "job-application-manager",
    run_id: runId,
    input,
    created_at: createdAt,
  }, null, 2)}\n`;
  const claim = {
    run_id: runId,
    workflow_id: "job-application-manager",
    input_bundle: input,
    input_bundle_sha256: sha256(canonicalBytes),
    input_bundle_created_at: createdAt,
  };
  const materialized = createInputBundle(claim, remoteRunRoot, {
    repoRoot: join(root, "repo-without-server-artifacts"),
    artifactRoot: remoteArtifactRoot,
  });
  assert.equal(readFileSync(materialized.path, "utf8"), canonicalBytes);
  assert.equal(materialized.sha256, claim.input_bundle_sha256);
});

test("resident remote worker dispatches registered local workflows to the Mac local adapter", async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), "aos-portable-local-worker-test-"));
  const runId = "run_remote_local_workflow_regression";
  const stepId = `${runId}_step_1`;
  const claim = {
    run_id: runId,
    company_id: "company_remote_local_workflow_regression",
    workflow_id: "daily-backup-safety-check",
    step_id: stepId,
    source_trigger: "automation_os_scheduler",
    idempotency_key: "portable-remote-local-workflow-regression",
    read_only_stage: "reference_readback",
    execution_mode: "read_only",
    business_effect_stage: null,
    approval_id: null,
    input_bundle: null,
    input_bundle_sha256: null,
    target_digest: null,
    worker_id: "mac-remote-local-workflow-regression",
    lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
    external_action_executed: false,
    browser_surface: "browser_use_cli",
  };
  let receiptBody = null;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/portable-worker/claim") {
      response.end(JSON.stringify({ ok: true, claimed: true, external_action_executed: false, run: claim }));
      return;
    }
    if (request.url === `/api/portable-worker/${runId}/receipt`) {
      receiptBody = JSON.parse(body);
      response.end(JSON.stringify({ ok: true, replayed: false, receipt: receiptBody.receipt, artifact_uri: "file:///redacted/receipt.json", external_action_executed: false }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ ok: false }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const result = await runWorker({
      AUTOMATION_OS_PORTABLE_REMOTE_TOKEN: "test-token-not-logged",
      AUTOMATION_OS_PORTABLE_REMOTE_URL: `http://127.0.0.1:${address.port}`,
      AUTOMATION_OS_PORTABLE_REMOTE_COMPANY_ID: claim.company_id,
      AUTOMATION_OS_PORTABLE_REMOTE_WORKER_ID: claim.worker_id,
      AUTOMATION_OS_PORTABLE_REMOTE_ARTIFACT_ROOT: artifactRoot,
      AUTOMATION_OS_WORKER_ROLE: "mac",
    }, ["--once"]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output.workflow_id, claim.workflow_id);
    // The fixed runner is present in the real worker environment, so the
    // read-only adapter may legitimately complete its preflight.  Keep the
    // fallback blockers for isolated fixtures where that runner is absent.
    assert.ok([null, "local_backup_runner_missing", "local_backup_effect_requires_explicit_approval"].includes(output.exact_blocker));
    assert.equal(output.external_action_executed, false);
    assert.equal(output.browser_surface, "local_worker");
    assert.equal(receiptBody?.receipt?.browser_surface, "local_worker");
    assert.equal(receiptBody?.receipt?.adapter_result?.execution_surface, "mac_local_worker");
  } finally {
    server.close();
    await once(server, "close").catch(() => {});
  }
});

test("resident worker suppresses idle poll receipts while once mode remains observable", () => {
  assert.equal(shouldEmitPortableRemoteResult({ status: "idle" }, { logIdle: false }), false);
  assert.equal(shouldEmitPortableRemoteResult({ status: "idle" }, { logIdle: true }), true);
  assert.equal(shouldEmitPortableRemoteResult({ status: "idle" }, { force: true, logIdle: false }), true);
  assert.equal(shouldEmitPortableRemoteResult({ status: "blocked" }, { logIdle: false }), true);
});

test("generic child failures are normalized into claim-bound no-effect receipts", () => {
  const claim = {
    workflow_id: "job-application-manager",
    run_id: "run_remote_receipt_envelope_regression",
    step_id: "run_remote_receipt_envelope_regression_step_1",
    execution_mode: "read_only",
    browser_surface: "signed_chrome_extension_profile2",
    web_operation_backend: {
      resolved_backend: "chrome_plugin",
      revision: 19,
      chrome_profile: { id: "profile2", name: "Profile 2", directory: "Profile 2", surface: "signed_chrome_extension_profile2" },
    },
  };
  const normalized = normalizePortableRemoteRunnerReceipt(claim, {
    status: "blocked",
    exact_blocker: "trusted_chrome_runtime_unavailable",
    external_action_executed: false,
  });
  assert.deepEqual(normalized, {
    status: "blocked",
    exact_blocker: "trusted_chrome_runtime_unavailable",
    external_action_executed: false,
    browser_surface: "signed_chrome_extension_profile2",
    workflow_id: claim.workflow_id,
    run_id: claim.run_id,
    step_id: claim.step_id,
    cleanup_verified: false,
    readback_verified: false,
    effects_mode: "read_only",
    read_only_stage_bound: true,
    same_run_receipt: false,
    business_proof_verified: false,
    external_executor_status: "portable_remote_runner_failed",
  });
});

test("protected readback persists only the server-accepted redacted same-run receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-portable-protected-readback-test-"));
  const claim = {
    job_id: "job_protected_readback_regression",
    workflow_id: "job-application-manager",
    run_id: "run_protected_readback_regression",
    step_id: "run_protected_readback_regression_step_1",
    browser_surface: "signed_chrome_extension_profile2",
    web_operation_backend: {
      resolved_backend: "chrome_plugin",
      revision: 29,
      chrome_profile: { id: "profile2", name: "Profile 2", directory: "Profile 2", surface: "signed_chrome_extension_profile2" },
    },
  };
  const localReceipt = {
    status: "complete",
    run_id: claim.run_id,
    step_id: claim.step_id,
    external_action_executed: false,
    browser_surface: claim.browser_surface,
    cleanup_verified: true,
    readback_verified: true,
    read_only_proof_verified: true,
    same_run_receipt: true,
    adapter_result: { token: "must-not-be-persisted", page_body: "must-not-be-persisted" },
  };
  const completion = {
    ok: true,
    receipt: { ...localReceipt, external_executor_status: "chrome_plugin_read_only_readback_completed" },
    artifact_uri: "/api/v1/companies/company/artifacts/artifact_protected_readback_regression",
  };
  const projected = buildPortableProtectedReadback(claim, localReceipt, completion);
  assert.equal(projected.protected_readback.status, "verified");
  assert.equal(projected.protected_readback.server_receipt_accepted, true);
  assert.equal(projected.external_action_executed, false);
  assert.equal(projected.browser_surface, "signed_chrome_extension_profile2");
  assert.equal(projected.backend, "chrome_plugin");
  assert.equal(projected.profile_id, "profile2");
  assert.equal(projected.protected_readback.secrets_present, false);
  const persisted = persistPortableProtectedReadback(claim, localReceipt, completion, root);
  const bytes = readFileSync(persisted.artifact_path, "utf8");
  assert.equal(JSON.parse(bytes).schema, "aos.portable_remote_worker_protected_readback.v1");
  assert.doesNotMatch(bytes, /must-not-be-persisted/u);
  assert.doesNotMatch(bytes, /artifact_uri/u);
});

test("worker heartbeat Chrome projection separates foreground lease from target-scoped readiness", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-chrome-worker-readback-test-"));
  const readbackPath = join(root, "bridge.json");
  writeFileSync(readbackPath, JSON.stringify({
    schema: "aos.chrome_plugin_bridge_readback.v2",
    status: "blocked",
    exact_blocker: "chrome_plugin_foreground_executor_lease_expired",
    operation_ready: true,
    operation_status: "ready",
    operation_exact_blocker: null,
    bridge_instance_id: "-7424-4c88-b483-91644aa4ea4d",
    browser: { id: "-7424-4c88-b483-91644aa4ea4d", type: "extension", metadata: { profileName: "Nicky", profileOrdering: "2" } },
    bridge_owner: {
      schema: "aos.chrome_plugin_bridge_owner.v1",
      owner_id: "chrome-plugin-owner-test",
      bridge_instance_id: "-7424-4c88-b483-91644aa4ea4d",
      session_id: "session-test",
      thread_id: "thread-test",
      turn_id: "turn-test",
      status: "bridge_only",
      foreground_executor_ready: false,
      exact_blocker: "chrome_plugin_foreground_executor_lease_expired",
      updated_at: "2026-08-21T08:23:08.847Z"
    },
    last_seen_at: "2026-08-21T08:23:08.847Z"
  }) + "\n", { mode: 0o600 });
  const readback = readChromePluginWorkerReadback(readbackPath);
  assert.equal(readback?.target_scoped_ready, true);
  assert.equal(readback?.operation_ready, true);
  assert.equal(readback?.browser?.profile_ordering, "2");
  assert.equal(readback?.bridge_owner?.status, "bridge_only");
});

test("remote HTTP requests are bounded and convert an abort into an exact blocker", async () => {
  assert.equal(portableRemoteHttpTimeoutMs(0), 1_000);
  assert.equal(portableRemoteHttpTimeoutMs(999_999), 120_000);
  assert.equal(portableRemoteHttpTimeoutMs("invalid"), 15_000);
  const server = createServer((_request, _response) => {
    // Deliberately never complete this response; the worker must not hang.
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await assert.rejects(
      requestPortableRemoteJson(`http://127.0.0.1:${address.port}/heartbeat`, "test-token-not-logged", {}, { timeoutMs: 1_000 }),
      (error) => error instanceof Error && error.message === "portable_remote_http_timeout"
    );
  } finally {
    server.close();
    await once(server, "close").catch(() => {});
  }
});

test("local worker transport marks only loopback requests without forwarding a remote token", async () => {
  let requestHeaders = null;
  const server = createServer(async (request, response) => {
    requestHeaders = request.headers;
    for await (const _chunk of request) { /* drain */ }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true, external_action_executed: false }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await requestPortableRemoteJson(`http://127.0.0.1:${address.port}/api/portable-worker/heartbeat`, "", {}, { localWorker: true, companyId: "company-local" });
    assert.equal(requestHeaders?.["x-automation-os-local-worker"], "1");
    assert.equal(requestHeaders?.["x-automation-os-token"], undefined);
    assert.equal(requestHeaders?.["x-automation-os-company-id"], "company-local");
  } finally {
    server.close();
    await once(server, "close").catch(() => {});
  }
});

test("remote worker status classification never exposes transport error text", () => {
  assert.equal(portableRemoteErrorCode(new Error("portable_remote_http_timeout")), "portable_remote_http_timeout");
  assert.equal(portableRemoteErrorCode(new Error("portable_remote_http_401")), "portable_remote_http_401");
  assert.equal(portableRemoteErrorCode(new Error("fetch failed with token=secret")), "portable_remote_http_failed");
});

test("heartbeat status updates preserve the latest claim state", () => {
  const merged = mergePortableRemoteWorkerStatus({
    claim_status: "idle",
    last_claim_at: "2026-08-11T11:11:05.344Z",
    heartbeat_status: "ok",
  }, {
    status: "heartbeat_ok",
    heartbeat_status: "ok",
    last_successful_heartbeat_at: "2026-08-11T11:11:06.001Z",
  });
  assert.equal(merged.claim_status, "idle");
  assert.equal(merged.last_claim_at, "2026-08-11T11:11:05.344Z");
  assert.equal(merged.last_successful_heartbeat_at, "2026-08-11T11:11:06.001Z");
});

test("loopback target status cannot overwrite the primary remote heartbeat", () => {
  const remoteKey = "remote:https://automation.example:company_remote";
  const localKey = "local:http://127.0.0.1:8787:company_local";
  const remote = mergePortableRemoteWorkerStatus({
    status: "starting",
    heartbeat_status: "unknown",
    target_statuses: {},
  }, {
    status: "heartbeat_ok",
    exact_blocker: null,
    heartbeat_status: "ok",
    heartbeat_exact_blocker: null,
    heartbeat_at: "2026-08-17T00:15:00.000Z",
  }, { targetKey: remoteKey, primary: true });
  const afterLocalFailure = mergePortableRemoteWorkerStatus(remote, {
    status: "claim_blocked",
    exact_blocker: "portable_remote_http_failed",
    heartbeat_status: "blocked",
    heartbeat_exact_blocker: "portable_remote_http_failed",
  }, { targetKey: localKey, primary: false });
  assert.equal(afterLocalFailure.status, "heartbeat_ok");
  assert.equal(afterLocalFailure.heartbeat_status, "ok");
  assert.equal(afterLocalFailure.heartbeat_exact_blocker, null);
  assert.equal(afterLocalFailure.target_statuses[remoteKey].heartbeat_status, "ok");
  assert.equal(afterLocalFailure.target_statuses[localKey].heartbeat_status, "blocked");
  assert.equal(afterLocalFailure.target_statuses[localKey].exact_blocker, "portable_remote_http_failed");
});

test("fresh worker generations reset target readback to the configured authorities", () => {
  const targets = [
    { kind: "remote", baseUrl: "https://automation.example", companyId: "company_remote" },
    { kind: "local", baseUrl: "http://127.0.0.1:8787", companyId: "company_local_current" },
  ];
  const fresh = initialPortableWorkerTargetStatuses(targets);
  const merged = mergePortableRemoteWorkerStatus({
    target_statuses: {
      "local:http://127.0.0.1:8787:company_local_old": { status: "claimed", claim_status: "claimed" },
    },
  }, {
    status: "starting",
    target_statuses: fresh,
  });
  assert.deepEqual(Object.keys(merged.target_statuses), [
    "remote:https://automation.example:company_remote",
    "local:http://127.0.0.1:8787:company_local_current",
  ]);
  assert.equal(merged.target_statuses["local:http://127.0.0.1:8787:company_local_current"].claim_status, "unknown");
});

test("same portable worker claim reuses a valid admission instead of rewriting its time-bound receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-portable-remote-worker-admission-reuse-"));
  const claim = {
    run_id: "run_remote_admission_reuse_regression",
    company_id: "company_remote_admission_reuse_regression",
    workflow_id: "job-application-manager",
    step_id: "run_remote_admission_reuse_regression_step_1",
    source_trigger: "automation_os_scheduler",
    idempotency_key: "portable-remote-admission-reuse-regression",
    read_only_stage: "candidate_supply",
    execution_mode: "read_only",
    business_effect_stage: null,
    approval_id: null,
    input_bundle: null,
    input_bundle_sha256: null,
    target_digest: null,
    worker_id: "mac-remote-admission-reuse-regression",
    lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
    external_action_executed: false,
    browser_surface: "browser_use_cli",
  };

  const first = createAdmission(claim, root);
  const second = createAdmission(claim, root);
  assert.equal(second.path, first.path);
  assert.equal(second.sha256, first.sha256);
});

test("portable effect authority is normalized from the claim and materialized for the child runner", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-portable-remote-worker-authority-handoff-"));
  const runId = "run_remote_authority_handoff_regression";
  const stepId = `${runId}_step_1`;
  const authorityInputs = {
    company_id: "company_remote_authority_handoff_regression",
    workflow_id: "job-application-manager",
    run_id: runId,
    step_id: stepId,
    effect_stage: "one_candidate_submit",
    approval_id: "approval_remote_authority_handoff_regression",
    idempotency_key: "portable-remote-authority-handoff-regression",
    target_digest: "a".repeat(64),
    input_bundle_sha256: "b".repeat(64),
  };
  const authority = {
    schema: "automation_os_portable_external_effect_authority.v1",
    authority_id: `portable-effect-${sha256([
      authorityInputs.company_id,
      authorityInputs.workflow_id,
      authorityInputs.run_id,
      authorityInputs.step_id,
      authorityInputs.effect_stage,
      authorityInputs.approval_id,
      authorityInputs.idempotency_key,
      authorityInputs.target_digest,
      authorityInputs.input_bundle_sha256,
    ].join("\u001f")).slice(0, 32)}`,
    issued_by: "automation_os_portable_controller",
    ...authorityInputs,
    effect_class: "external_non_idempotent",
    approval_status: "approved",
    external_action_authorized: true,
    first_class_root_required: false,
    timeout_controller: "automation_os_portable_controller",
    reconciliation_required: true,
    reconciliation_owner: "automation_os_portable_controller",
    no_auto_retry: true,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  };
  const claim = {
    ...authorityInputs,
    execution_mode: "business_effect",
    portable_effect_authority: authority,
  };

  assert.equal(effectAuthorityFromClaim(claim), authority);
  const materialized = createEffectAuthorityFile(claim, root);
  assert.ok(materialized);
  assert.equal(existsSync(materialized.path), true);
  assert.equal(readFileSync(materialized.path, "utf8"), `${JSON.stringify(authority, null, 2)}\n`);
  assert.equal(materialized.sha256, sha256(readFileSync(materialized.path)));
});

test("business receipt is bound to the current AOS target-bound approval receipt", () => {
  const approvalReceipt = {
    schema: "automation_os_portable_target_bound_approval_receipt.v1",
    approval_id: "approval_receipt_handoff_regression",
    approval_status: "approved",
    binding_sha256: "c".repeat(64),
    binding: {
      schema: "automation_os_portable_external_approval_binding.v1",
      company_id: "company_receipt_handoff_regression",
      workflow_id: "job-application-manager",
      run_id: "run_receipt_handoff_regression",
      step_id: "run_receipt_handoff_regression_step_1",
      effect_stage: "one_candidate_submit",
      idempotency_key: "receipt-handoff-regression",
      input_bundle_sha256: "d".repeat(64),
      target_digest: "e".repeat(64),
      binding_sha256: "c".repeat(64),
    },
  };
  const claim = { execution_mode: "business_effect", approval_receipt: approvalReceipt };
  const childReceipt = { status: "complete", external_action_executed: true, approval_receipt: null };
  const bound = bindBusinessReceiptToClaim(claim, childReceipt);
  assert.equal(bound.approval_receipt, approvalReceipt);
  assert.equal(bound.external_action_executed, true);
  assert.equal(bindBusinessReceiptToClaim({ execution_mode: "read_only" }, childReceipt), childReceipt);
});

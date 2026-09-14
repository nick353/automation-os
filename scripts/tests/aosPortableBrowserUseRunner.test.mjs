import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PORTABLE_EXTERNAL_ACTION_PLAN_REQUIRED,
  PORTABLE_EXTERNAL_READ_ONLY_BUSINESS_PROOF_PENDING,
  PORTABLE_EXTERNAL_READ_ONLY_ROUTE_NOT_CONFIGURED,
  parsePortableRunnerArgs,
  readChromePluginProfile2LastUsedFromLocalState,
  readChromePluginBackgroundReadOnlyCapability,
  chromePluginReadbackPathForEnvironment,
  chromePluginBridgeUrlFromReadback,
  assertChromePluginBridgeReadbackValue,
  refreshChromePluginBridgeReadback,
  issueReadOnlyAuthority,
  readAdmission,
  routeForWorkflow,
  runChromePluginBridgeClient,
  runAosChromeCompanionReadOnlyWorkflow,
  runReadOnlyWorkflow,
} from "../aos-portable-browser-use-runner.mjs";

test("Chrome Plugin background read-only capability is private, expiring, and Profile 2-bound", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-chrome-plugin-background-capability-test-"));
  const capabilityPath = join(root, "capability.json");
  const token = "runner-background-capability-token";
  const capability = {
    schema: "aos.chrome_plugin_background_read_only_capability.v1",
    audience: "aos_portable_remote_worker",
    capability_id: createHash("sha256").update(token).digest("hex"),
    token,
    bridge_instance_id: "bridge-test",
    browser_backend: "chrome_plugin",
    browser_surface: "signed_chrome_extension_profile2",
    read_only: true,
    external_action_allowed: false,
    expires_at: new Date(20_000).toISOString(),
  };
  writeFileSync(capabilityPath, `${JSON.stringify(capability)}\n`, { mode: 0o600 });
  const read = readChromePluginBackgroundReadOnlyCapability({ AOS_CHROME_PLUGIN_BACKGROUND_READ_ONLY_CAPABILITY_PATH: capabilityPath }, { now: 10_000 });
  assert.equal(read.capability_id, capability.capability_id);
  assert.equal(read.bridge_instance_id, "bridge-test");
  assert.throws(
    () => readChromePluginBackgroundReadOnlyCapability({ AOS_CHROME_PLUGIN_BACKGROUND_READ_ONLY_CAPABILITY_PATH: capabilityPath }, { now: 20_001 }),
    /chrome_plugin_background_read_only_capability_missing|chrome_plugin_background_read_only_capability_invalid/u,
  );
});

test("Chrome Plugin Profile 2 authority accepts the official Local State last-used proof when bridge metadata is stale", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-chrome-profile2-local-state-test-"));
  const localStatePath = join(root, "Local State");
  writeFileSync(localStatePath, `${JSON.stringify({
    profile: {
      last_used: "Profile 2",
      profiles_order: ["Default", "Profile 2"],
      info_cache: { "Profile 2": { name: "Nicky" } },
    },
  })}\n`, { mode: 0o600 });
  assert.equal(
    readChromePluginProfile2LastUsedFromLocalState({
      AOS_CHROME_PLUGIN_LOCAL_STATE_PATH: localStatePath,
      AOS_CHROME_PROFILE_DIRECTORY: "Profile 2",
    }),
    true,
  );
  assert.equal(
    readChromePluginProfile2LastUsedFromLocalState({
      AOS_CHROME_PLUGIN_LOCAL_STATE_PATH: localStatePath,
      AOS_CHROME_PROFILE_DIRECTORY: "Profile 1",
    }),
    false,
  );
});

test("Chrome Plugin bridge accepts an owned loopback port and rejects non-loopback URLs", () => {
  assert.equal(
    chromePluginBridgeUrlFromReadback({ bridge_url: "http://127.0.0.1:58743" }),
    "http://127.0.0.1:58743",
  );
  assert.equal(
    chromePluginBridgeUrlFromReadback(
      { bridge_url: "http://127.0.0.1:58743" },
      { AOS_CHROME_PLUGIN_BRIDGE_PORT: "58743" },
    ),
    "http://127.0.0.1:58743",
  );
  assert.throws(
    () => chromePluginBridgeUrlFromReadback({ bridge_url: "http://127.0.0.1:58743" }, { AOS_CHROME_PLUGIN_BRIDGE_PORT: "58737" }),
    /chrome_plugin_bridge_port_binding_invalid/u,
  );
  assert.throws(
    () => chromePluginBridgeUrlFromReadback({ bridge_url: "http://192.168.1.10:58743" }),
    /chrome_plugin_bridge_url_not_loopback/u,
  );
});

test("portable Chrome Plugin runner defaults to the worker-owned Profile 2 readback path", () => {
  assert.equal(
    chromePluginReadbackPathForEnvironment({ HOME: "/tmp/aos-home" }),
    "/tmp/aos-home/.social-flow/aos-company1-profile2-bridge-readback-v2.json",
  );
});

test("Chrome Plugin refresh officially rebinds a stopped worker readback to the current same-port owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "aos-chrome-plugin-rebind-test-"));
  const workerReadbackPath = join(root, "aos-company1-profile2-bridge-readback-v2.json");
  const oldBridgeInstanceId = "bridge-stopped-worker-owner";
  const newBridgeInstanceId = "bridge-current-foreground-owner";
  const server = createServer((_request, response) => {
    const bridgePort = (server.address()).port;
    const now = new Date().toISOString();
    const freshReadback = {
      schema: "aos.chrome_plugin_bridge_readback.v2",
      status: "ready",
      backend: "chrome_extension_trusted_bridge",
      bridge_instance_id: newBridgeInstanceId,
      bridge_url: `http://127.0.0.1:${bridgePort}`,
      browser_execution_authority: "read_only_admission",
      browser_execution_disabled: false,
      browser: {
        id: "chrome-profile2-current",
        name: "Chrome",
        type: "extension",
        metadata: {
          extensionId: "hehggadaopoacecdllhhajmbjkdcmajg",
          extensionInstanceId: "extension-instance-current",
          profileName: "Nicky",
          profileOrdering: "2",
          profileIsLastUsed: "true",
        },
      },
      operation_ready: true,
      operation_status: "read_only_ready",
      operation_exact_blocker: null,
      selected_tab: { id: "selected-tab-current", url: "http://127.0.0.1:5173/#/runs" },
      visibility: { capability_id: "visibility", advertised: false, state: null },
      capability_ids: [],
      bridge_owner: {
        schema: "aos.chrome_plugin_bridge_owner.v1",
        owner_id: `chrome-plugin-owner-${newBridgeInstanceId}`,
        pid: null,
        bridge_instance_id: newBridgeInstanceId,
        session_id: "session-current",
        thread_id: "thread-current",
        turn_id: "turn-current",
        status: "foreground_ready",
        foreground_executor_ready: true,
        exact_blocker: null,
        started_at: now,
        updated_at: now,
      },
      writer_lease: {
        schema: "chrome_extension_profile2_writer_lease.v1",
        profile_surface: "signed_chrome_extension_profile2",
        profile_ordering: 2,
        status: "idle",
        poisoned: false,
        exact_blocker: null,
        updated_at: null,
      },
      exact_blocker: null,
      last_seen_at: now,
      refresh_status: "ready",
      refresh_exact_blocker: null,
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      backend: "chrome_extension_trusted_bridge",
      url: `http://127.0.0.1:${bridgePort}`,
      bridge_instance_id: newBridgeInstanceId,
      browser_readback: freshReadback,
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const bridgePort = server.address().port;
  writeFileSync(workerReadbackPath, `${JSON.stringify({
    schema: "aos.chrome_plugin_bridge_readback.v2",
    status: "stopped",
    backend: "chrome_extension_trusted_bridge",
    bridge_instance_id: oldBridgeInstanceId,
    bridge_url: `http://127.0.0.1:${bridgePort}`,
    browser_execution_authority: "read_only_admission",
    browser_execution_disabled: false,
    browser: { id: "chrome-profile2-old", type: "extension", metadata: { profileOrdering: "2", profileIsLastUsed: "true" } },
    bridge_owner: {
      schema: "aos.chrome_plugin_bridge_owner.v1",
      owner_id: `chrome-plugin-owner-${oldBridgeInstanceId}`,
      bridge_instance_id: oldBridgeInstanceId,
      status: "stopped",
      foreground_executor_ready: false,
      exact_blocker: "chrome_extension_bridge_stopped",
      updated_at: new Date(Date.now() - 60_000).toISOString(),
    },
    last_seen_at: new Date(Date.now() - 60_000).toISOString(),
    exact_blocker: "chrome_extension_bridge_stopped",
    refresh_status: "blocked",
    refresh_exact_blocker: "chrome_extension_bridge_stopped",
  })}\n`, { mode: 0o600 });
  const environment = {
    AOS_CHROME_PLUGIN_READBACK_PATH: workerReadbackPath,
    AOS_CHROME_PLUGIN_BRIDGE_PORT: String(bridgePort),
  };
  try {
    const refreshed = await refreshChromePluginBridgeReadback(environment);
    assert.equal(refreshed.rebound, true);
    assert.equal(refreshed.previous_bridge_instance_id, oldBridgeInstanceId);
    assert.equal(refreshed.bridge_instance_id, newBridgeInstanceId);
    const persisted = JSON.parse(readFileSync(workerReadbackPath, "utf8"));
    assert.equal(persisted.status, "ready");
    assert.equal(persisted.bridge_instance_id, newBridgeInstanceId);
    assert.equal(persisted.bridge_owner.bridge_instance_id, newBridgeInstanceId);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("Chrome Plugin refresh refuses to overwrite a different live foreground owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "aos-chrome-plugin-rebind-conflict-test-"));
  const workerReadbackPath = join(root, "bridge.json");
  const oldBridgeInstanceId = "bridge-live-worker-owner";
  const newBridgeInstanceId = "bridge-other-foreground-owner";
  const now = new Date().toISOString();
  const server = createServer((_request, response) => {
    const bridgePort = server.address().port;
    const freshReadback = {
      schema: "aos.chrome_plugin_bridge_readback.v2",
      status: "ready",
      backend: "chrome_extension_trusted_bridge",
      bridge_instance_id: newBridgeInstanceId,
      bridge_url: `http://127.0.0.1:${bridgePort}`,
      browser_execution_authority: "general",
      browser_execution_disabled: false,
      browser: { id: "chrome-profile2-current", type: "extension", metadata: { profileOrdering: "2", profileIsLastUsed: "true" } },
      operation_ready: true,
      operation_status: "ready",
      selected_tab: { id: "selected-tab-current", url: "https://example.test/" },
      bridge_owner: {
        schema: "aos.chrome_plugin_bridge_owner.v1",
        owner_id: `chrome-plugin-owner-${newBridgeInstanceId}`,
        bridge_instance_id: newBridgeInstanceId,
        session_id: "session-current",
        thread_id: "thread-current",
        turn_id: "turn-current",
        status: "foreground_ready",
        foreground_executor_ready: true,
        exact_blocker: null,
        started_at: now,
        updated_at: now,
      },
      last_seen_at: now,
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, backend: "chrome_extension_trusted_bridge", url: freshReadback.bridge_url, bridge_instance_id: newBridgeInstanceId, browser_readback: freshReadback }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const bridgePort = server.address().port;
  writeFileSync(workerReadbackPath, `${JSON.stringify({
    schema: "aos.chrome_plugin_bridge_readback.v2",
    status: "ready",
    backend: "chrome_extension_trusted_bridge",
    bridge_instance_id: oldBridgeInstanceId,
    bridge_url: `http://127.0.0.1:${bridgePort}`,
    browser_execution_authority: "general",
    browser_execution_disabled: false,
    browser: { id: "chrome-profile2-old", type: "extension", metadata: { profileOrdering: "2", profileIsLastUsed: "true" } },
    operation_ready: true,
    operation_status: "ready",
    selected_tab: { id: "selected-tab-old", url: "https://example.test/" },
    bridge_owner: {
      schema: "aos.chrome_plugin_bridge_owner.v1",
      owner_id: `chrome-plugin-owner-${oldBridgeInstanceId}`,
      bridge_instance_id: oldBridgeInstanceId,
      session_id: "session-old",
      thread_id: "thread-old",
      turn_id: "turn-old",
      status: "foreground_ready",
      foreground_executor_ready: true,
      exact_blocker: null,
      started_at: now,
      updated_at: now,
    },
    last_seen_at: now,
  })}\n`, { mode: 0o600 });
  try {
    await assert.rejects(
      () => refreshChromePluginBridgeReadback({ AOS_CHROME_PLUGIN_READBACK_PATH: workerReadbackPath, AOS_CHROME_PLUGIN_BRIDGE_PORT: String(bridgePort) }),
      /chrome_plugin_bridge_rebind_conflict/u,
    );
    const persisted = JSON.parse(readFileSync(workerReadbackPath, "utf8"));
    assert.equal(persisted.bridge_instance_id, oldBridgeInstanceId);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("read-only authority uses the canonical Browser Use approval token", () => {
  const source = readFileSync(fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url)), "utf8");
  assert.match(source, /side_effect_scope: "read_only_preflight"[\s\S]{0,240}approval: "approved"/u);
  assert.doesNotMatch(source, /approval: "approved_read_only"/u);
});

test("read-only admission accepts not_required while effect admission still requires approved", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-read-only-admission-test-"));
  const admissionPath = join(root, "admission.json");
  const base = {
    schema: "automation_os_portable_external_admission.v1",
    workflow_id: "daily-ai-research-publish-run",
    run_id: "run-read-only-admission",
    step_id: "step-read-only-admission",
    source_trigger: "automation_os_ui",
    idempotency_key: "read-only-admission",
    effect_class: "external_non_idempotent",
    browser_surface: "aos_chrome_companion_profile_instance",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const bytes = `${JSON.stringify({ ...base, approval_status: "not_required" }, null, 2)}\n`;
  writeFileSync(admissionPath, bytes, { mode: 0o600 });
  const input = {
    workflow_id: base.workflow_id,
    run_id: base.run_id,
    step_id: base.step_id,
    source_trigger: base.source_trigger,
    idempotency_key: base.idempotency_key,
  };
  const environment = {
    AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_PATH: admissionPath,
    AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_SHA256: createHash("sha256").update(bytes).digest("hex"),
    AUTOMATION_OS_PORTABLE_EXTERNAL_READ_ONLY_STAGE: "reference_readback",
    AOS_WEB_OPERATION_BACKEND: "aos_chrome_companion",
  };
  assert.equal(readAdmission(input, environment).value.approval_status, "not_required");
  assert.throws(
    () => readAdmission(input, { ...environment, AUTOMATION_OS_PORTABLE_EXTERNAL_READ_ONLY_STAGE: "" }),
    /portable_external_admission_invalid/u,
  );
});

test("read-only authority uses the Goal session binding instead of a separate preflight session", () => {
  const source = readFileSync(fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url)), "utf8");
  assert.match(source, /session: goalSessionFor\(input, route\)/u);
  assert.equal(
    source.includes("session: `aos-${sha256Bytes(`${input.run_id}:${route.stage_id}`).slice(0, 20)}-preflight`"),
    false,
  );
});

test("read-only authority re-entry is idempotent within one run but rejects rebinding", () => {
  const root = mkdtempSync(join(tmpdir(), "aos-read-only-authority-reentry-test-"));
  const route = routeForWorkflow("job-application-manager");
  const input = {
    run_id: "run_read_only_authority_reentry",
    step_id: "run_read_only_authority_reentry_step_1",
    workflow_id: "job-application-manager",
    source_trigger: "automation_os_ui",
    idempotency_key: "read-only-authority-reentry",
    admission: { sha256: "a".repeat(64) },
  };
  const environment = { AOS_WEB_OPERATION_BACKEND: "chrome_plugin" };
  const first = issueReadOnlyAuthority({ route, input, runRoot: root, environment });
  const second = issueReadOnlyAuthority({ route, input, runRoot: root, environment });
  assert.equal(second.path, first.path);
  assert.equal(second.sha256, first.sha256);
  assert.throws(
    () => issueReadOnlyAuthority({
      route,
      input: { ...input, run_id: "run_read_only_authority_rebound" },
      runRoot: root,
      environment,
    }),
    /portable_external_authority_immutable_collision/u,
  );
});

test("screenshotPath is declared and bound to the run-owned recording directory before use", () => {
  const source = readFileSync(fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url)), "utf8");
  const declaration = source.indexOf('let screenshotPath = "";');
  const runOwnedAssignment = source.indexOf('screenshotPath = path.join(flow.recording_dir, "aos-readback.png");');
  const screenshotCommand = source.indexOf('["screenshot", screenshotPath]');
  const receiptReference = source.indexOf('screenshot_path: fs.existsSync(screenshotPath) ? screenshotPath : "",');
  assert.ok(declaration >= 0, "screenshotPath declaration must remain present");
  assert.ok(runOwnedAssignment > declaration, "screenshotPath must be generated after flow creation");
  assert.ok(screenshotCommand > runOwnedAssignment, "screenshot command must use the run-owned path");
  assert.ok(receiptReference > screenshotCommand, "receipt must reference the same declared path");
  assert.match(source, /path\.join\(flow\.recording_dir, "aos-readback\.png"\)/u);
});

test("AOS owns explicit read-only routes and lane bindings", () => {
  assert.equal(routeForWorkflow("job-application-manager").automation_id, "automation-3");
  assert.equal(routeForWorkflow("daily-ai-research-publish-run").port, 19882);
  assert.equal(routeForWorkflow("nisenprints-daily-product-canva-printify-etsy-pinterest").port, 19884);
  assert.equal(routeForWorkflow("nisenprints-daily-product-canva-printify-etsy-pinterest").target_url, "https://www.canva.com/");
  assert.equal(routeForWorkflow("prompt-transfer-ukiyoe").target_url, "https://docs.google.com/document/d/1j2lsvr1zJs9k9cCkLGeGF-soZZSGuY2p0tQ6wJp8S0s/edit?tab=t.0");
  assert.equal(routeForWorkflow("sns-multi-poster-ukiyoe").target_url, "https://x.com/home");
  assert.equal(routeForWorkflow("x-authenticated-browser-lane").target_url, "https://x.com/home");
  assert.equal(routeForWorkflow("unknown-workflow"), null);
});

test("portable runner rejects malformed bindings before any browser command", () => {
  assert.throws(
    () => parsePortableRunnerArgs(["--workflow-id", "job-application-manager", "--run-id", "../outside"]),
    /portable_external_run_id_invalid/,
  );
});

test("enabled effects stop at action-plan gate without launching Browser Use CLI", () => {
  const runnerPath = fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [
    runnerPath,
    "--workflow-id", "job-application-manager",
    "--run-id", "run-action-plan-gate",
    "--step-id", "step-action-plan-gate",
    "--source-trigger", "automation_os_scheduler",
    "--idempotency-key", "action-plan-gate",
  ], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS: "enabled",
      AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL: "approved",
    },
  });
  assert.equal(result.status, 1);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.exact_blocker, PORTABLE_EXTERNAL_ACTION_PLAN_REQUIRED);
  assert.equal(receipt.external_action_executed, false);
});

test("read-only mode requires a fresh AOS admission and does not invent an unsupported route", () => {
  const runnerPath = fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "aos-portable-runner-test-"));
  const admissionPath = join(root, "admission.json");
  const payload = {
    schema: "automation_os_portable_external_admission.v1",
    workflow_id: "unknown-workflow",
    run_id: "run-unsupported-route",
    step_id: "step-unsupported-route",
    source_trigger: "automation_os_scheduler",
    idempotency_key: "unsupported-route",
    effect_class: "external_non_idempotent",
    browser_surface: "browser_use_cli",
    approval_status: "approved",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const bytes = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(admissionPath, bytes, { mode: 0o600 });
  const result = spawnSync(process.execPath, [
    runnerPath,
    "--workflow-id", payload.workflow_id,
    "--run-id", payload.run_id,
    "--step-id", payload.step_id,
    "--source-trigger", payload.source_trigger,
    "--idempotency-key", payload.idempotency_key,
  ], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      AUTOMATION_OS_ARTIFACT_ROOT: root,
      AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS: "read_only",
      AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL: "approved",
      AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_PATH: admissionPath,
      AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_SHA256: createHash("sha256").update(bytes).digest("hex"),
    },
  });
  assert.equal(result.status, 1);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.exact_blocker, `${PORTABLE_EXTERNAL_READ_ONLY_ROUTE_NOT_CONFIGURED}:unknown-workflow`);
  assert.equal(receipt.external_action_executed, false);
});

test("Playwright read-only selection fails closed instead of falling through to Browser Use CLI", () => {
  const runnerPath = fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "aos-playwright-read-only-runner-test-"));
  const admissionPath = join(root, "admission.json");
  const payload = {
    schema: "automation_os_portable_external_admission.v1",
    workflow_id: "job-application-manager",
    run_id: "run-playwright-read-only",
    step_id: "step-playwright-read-only",
    source_trigger: "automation_os_scheduler",
    idempotency_key: "playwright-read-only",
    effect_class: "external_non_idempotent",
    browser_surface: "playwright",
    approval_status: "approved",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const bytes = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(admissionPath, bytes, { mode: 0o600 });
  const result = spawnSync(process.execPath, [
    runnerPath,
    "--workflow-id", payload.workflow_id,
    "--run-id", payload.run_id,
    "--step-id", payload.step_id,
    "--source-trigger", payload.source_trigger,
    "--idempotency-key", payload.idempotency_key,
  ], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS: "read_only",
      AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL: "approved",
      AOS_WEB_OPERATION_BACKEND: "playwright",
      AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_PATH: admissionPath,
      AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_SHA256: createHash("sha256").update(bytes).digest("hex"),
    },
  });
  assert.equal(result.status, 1);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.exact_blocker, "portable_external_read_only_backend_not_implemented:playwright");
  assert.equal(receipt.browser_surface, "playwright");
  assert.equal(receipt.external_action_executed, false);
});

test("candidate-supply read-only shortfall remains partial and cannot become business completion", () => {
  assert.equal(PORTABLE_EXTERNAL_READ_ONLY_BUSINESS_PROOF_PENDING, "portable_external_read_only_business_completion_proof_pending");
});

test("Chrome Plugin selection fails closed before any Browser Use CLI fallback when Profile 2 bridge readback is unavailable", () => {
  const runnerPath = fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url));
  const artifactRoot = mkdtempSync(join(tmpdir(), "aos-chrome-plugin-runner-test-"));
  const runId = "run-chrome-plugin-bridge-missing";
  const stepId = "job_candidate_supply";
  const runRoot = join(artifactRoot, runId);
  const admission = {
    schema: "automation_os_portable_external_admission.v1",
    workflow_id: "job-application-manager",
    run_id: runId,
    step_id: stepId,
    source_trigger: "automation_os_scheduler",
    idempotency_key: "chrome-plugin-bridge-missing",
    effect_class: "external_non_idempotent",
    browser_surface: "signed_chrome_extension_profile2",
    approval_status: "approved",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const admissionPath = join(runRoot, "admission.json");
  const bundlePath = join(runRoot, "portable-input-bundle.v1.json");
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  const admissionBytes = `${JSON.stringify(admission, null, 2)}\n`;
  writeFileSync(admissionPath, admissionBytes, { mode: 0o600 });
  writeFileSync(bundlePath, `${JSON.stringify({
    schema: "automation_os_portable_workflow_input_bundle.v1",
    workflow_id: admission.workflow_id,
    run_id: runId,
    input: { source_snapshot_id: "snapshot-chrome-plugin", supply_run_id: "supply-chrome-plugin", bucket: "japan_targeted", remaining: 1, margin: 0 },
  }, null, 2)}\n`, { mode: 0o600 });
  const result = spawnSync(process.execPath, [
    runnerPath,
    "--workflow-id", admission.workflow_id,
    "--run-id", runId,
    "--step-id", stepId,
    "--source-trigger", admission.source_trigger,
    "--idempotency-key", admission.idempotency_key,
  ], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: artifactRoot,
      AOS_WEB_OPERATION_BACKEND: "chrome_plugin",
      AOS_WEB_OPERATION_BACKEND_REVISION: "19",
      AOS_WEB_OPERATION_BACKEND_SOURCE: "aos_global_setting",
      AOS_WEB_OPERATION_BACKEND_FALLBACK_ALLOWED: "false",
      AOS_CHROME_PROFILE_ID: "profile2",
      AOS_CHROME_PROFILE_NAME: "Profile 2",
      AOS_CHROME_PROFILE_DIRECTORY: "Profile 2",
      AOS_CHROME_PROFILE_SURFACE: "signed_chrome_extension_profile2",
      AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS: "read_only",
      AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL: "approved",
      AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_PATH: admissionPath,
      AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_SHA256: createHash("sha256").update(admissionBytes).digest("hex"),
      AUTOMATION_OS_PORTABLE_EXTERNAL_INPUT_BUNDLE_PATH: bundlePath,
      AUTOMATION_OS_ARTIFACT_ROOT: artifactRoot,
      AOS_CHROME_PLUGIN_READBACK_PATH: join(artifactRoot, "missing-bridge-readback.json"),
    },
  });
  assert.equal(result.status, 1);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.browser_surface, "signed_chrome_extension_profile2");
  assert.equal(receipt.external_action_executed, false);
  assert.equal(receipt.exact_blocker, "chrome_plugin_bridge_refresh_failed:chrome_plugin_bridge_readback_missing");
});

test("Chrome Plugin read-only refuses to synthesize a run snapshot from incomplete environment state", async () => {
  const result = await runReadOnlyWorkflow({
    workflow_id: "job-application-manager",
    run_id: "run-chrome-plugin-snapshot-missing",
    step_id: "readback",
    source_trigger: "test",
    idempotency_key: "snapshot-missing",
  }, {
    AOS_WEB_OPERATION_BACKEND: "chrome_plugin",
    AOS_CHROME_PROFILE_SURFACE: "signed_chrome_extension_profile2",
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.exact_blocker, "chrome_plugin_backend_snapshot_missing");
  assert.equal(result.external_action_executed, false);
});

test("Companion read-only does not require a Chrome Plugin backend snapshot", async () => {
  let companionCalls = 0;
  let officialCalls = 0;
  const result = await runReadOnlyWorkflow({
    workflow_id: "job-application-manager",
    run_id: "run-companion-without-plugin-snapshot",
    step_id: "reference_readback",
    source_trigger: "test",
    idempotency_key: "companion-without-plugin-snapshot",
  }, {
    AOS_WEB_OPERATION_BACKEND: "aos_chrome_companion",
  }, {
    companionWorkflow: async () => {
      companionCalls += 1;
      return {
        status: "complete",
        browser_backend: "aos_chrome_companion",
        browser_surface: "aos_chrome_companion_profile_instance",
        external_action_executed: false,
        cleanup_verified: true,
        readback_verified: true,
        read_only_stage_bound: true,
        same_run_receipt: true,
      };
    },
    officialWorkflow: async () => {
      officialCalls += 1;
      return { status: "blocked", exact_blocker: "must_not_handoff" };
    },
  });
  assert.equal(result.status, "complete");
  assert.equal(result.exact_blocker, undefined);
  assert.equal(result.external_action_executed, false);
  assert.equal(companionCalls, 1);
  assert.equal(officialCalls, 0);
});

test("AOS Chrome Companion read-only runner uses the exact task id and closes the broker client", async () => {
  const calls = [];
  let clientClosed = false;
  const adapterModule = {
    async loadCompanionBrokerClient() {
      return {
        async close() { clientClosed = true; },
      };
    },
    async executeAosChromeCompanionReadOnly(input, { client }) {
      calls.push({ input, client });
      return {
        result: "verified",
        target: { task_owned: true },
        readback: { url: "https://x.com/home" },
        visual_readback: { captured: true, sha256: "a".repeat(64) },
        visual_readback_verified: true,
        cleanup: { session_closed: true, lease_released_by_session_close: true },
        external_action_executed: false,
      };
    },
  };
  const result = await runAosChromeCompanionReadOnlyWorkflow({
    workflow_id: "daily-ai-research-publish-run",
    run_id: "run-companion-read-only",
    step_id: "readback",
  }, {
    AOS_WEB_OPERATION_BACKEND: "aos_chrome_companion",
    AOS_CHROME_COMPANION_TASK_ID: "task-owner-exact",
  }, { adapterModule });

  assert.equal(result.status, "complete");
  assert.equal(result.browser_backend, "aos_chrome_companion");
  assert.equal(result.browser_surface, "aos_chrome_companion_profile_instance");
  assert.equal(result.external_action_executed, false);
  assert.equal(result.cleanup_verified, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.taskId, "task-owner-exact");
  assert.equal(calls[0].input.target.url, "https://x.com/home");
  assert.equal(clientClosed, true);
});

test("AOS Chrome Companion read-only runner rejects a verified receipt without task ownership", async () => {
  const result = await runAosChromeCompanionReadOnlyWorkflow({
    workflow_id: "daily-ai-research-publish-run",
    run_id: "run-companion-unowned-receipt",
    step_id: "readback",
  }, {
    AOS_WEB_OPERATION_BACKEND: "aos_chrome_companion",
    AOS_CHROME_COMPANION_TASK_ID: "task-owner-exact",
  }, {
    adapterModule: {
      async loadCompanionBrokerClient() {
        return { async close() {} };
      },
      async executeAosChromeCompanionReadOnly() {
        return {
          result: "verified",
          readback: { url: "https://x.com/home" },
          visual_readback: { captured: true, sha256: "a".repeat(64) },
          visual_readback_verified: true,
          cleanup: { session_closed: true, lease_released_by_session_close: true },
          external_action_executed: false,
        };
      },
    },
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.exact_blocker, "aos_chrome_companion_target_not_task_owned");
  assert.equal(result.external_action_executed, false);
});

test("AOS Chrome Companion read-only runner fails closed without an explicit task id", async () => {
  const result = await runAosChromeCompanionReadOnlyWorkflow({
    workflow_id: "daily-ai-research-publish-run",
    run_id: "run-companion-missing-task",
    step_id: "readback",
  }, { AOS_WEB_OPERATION_BACKEND: "aos_chrome_companion" }, {
    adapterModule: {
      async loadCompanionBrokerClient() { throw new Error("must not load Companion without task id"); },
    },
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.exact_blocker, "aos_chrome_companion_task_id_missing");
  assert.equal(result.external_action_executed, false);
});

test("read-only runner performs one Companion-to-official handoff after proven no-effect failure", async () => {
  let officialCalls = 0;
  const result = await runReadOnlyWorkflow({
    workflow_id: "daily-ai-research-publish-run",
    run_id: "run-safe-surface-handoff",
    step_id: "reference_readback",
    source_trigger: "test",
    idempotency_key: "safe-handoff-1",
  }, {
    AOS_WEB_OPERATION_BACKEND: "aos_chrome_companion",
    AOS_WEB_OPERATION_BACKEND_REVISION: "31",
    AOS_WEB_OPERATION_BACKEND_SOURCE: "aos_global_setting",
    AOS_WEB_OPERATION_BACKEND_FALLBACK_ALLOWED: "false",
    AOS_CHROME_PROFILE_ID: "profile2",
    AOS_CHROME_PROFILE_NAME: "Profile 2",
    AOS_CHROME_PROFILE_DIRECTORY: "Profile 2",
    AOS_CHROME_PROFILE_SURFACE: "aos_chrome_companion_profile_instance",
  }, {
    companionWorkflow: async () => ({
      status: "blocked",
      exact_blocker: "companion_profile_not_connected",
      external_action_executed: false,
      browser_backend: "aos_chrome_companion",
      browser_surface: "aos_chrome_companion_profile_instance",
      cleanup_verified: true,
      effects_mode: "read_only",
      read_only_stage_bound: true,
      mutation_dispatch_attempted: false,
      mutation_dispatch_count: 0,
      operation_effect_state: "none",
      reconciliation_required: false,
    }),
    officialWorkflow: async (_input, environment) => {
      officialCalls += 1;
      assert.equal(environment.AOS_WEB_OPERATION_BACKEND, "chrome_plugin");
      assert.equal(environment.AOS_CHROME_PROFILE_SURFACE, "signed_chrome_extension_profile2");
      return {
        status: "complete",
        exact_blocker: null,
        external_action_executed: false,
        browser_backend: "chrome_plugin",
        browser_surface: "signed_chrome_extension_profile2",
        cleanup_verified: true,
        readback_verified: true,
        visual_readback_verified: true,
      };
    },
  });
  assert.equal(officialCalls, 1);
  assert.equal(result.status, "complete");
  assert.equal(result.browser_surface, "signed_chrome_extension_profile2");
  assert.equal(result.safe_surface_handoff.status, "completed");
  assert.equal(result.safe_surface_handoff.handoff_count, 1);
  assert.equal(result.safe_surface_handoff.transition_visible, true);
  assert.equal(result.safe_surface_handoff.transition_label, "Companion → Codex Extension");
  assert.match(result.safe_surface_handoff.user_message, /Companion → Codex Extension/u);
});

test("read-only runner visibly hands unsupported Companion dropdown preflight to the official Extension once", async () => {
  let officialCalls = 0;
  const result = await runReadOnlyWorkflow({
    workflow_id: "job-application-manager",
    run_id: "run-dropdown-handoff",
    step_id: "application_form_control_preflight",
    source_trigger: "test",
    idempotency_key: "dropdown-handoff-1",
  }, {
    AOS_WEB_OPERATION_BACKEND: "aos_chrome_companion",
    AOS_WEB_OPERATION_BACKEND_REVISION: "31",
    AOS_WEB_OPERATION_BACKEND_SOURCE: "aos_global_setting",
    AOS_WEB_OPERATION_BACKEND_FALLBACK_ALLOWED: "false",
    AOS_CHROME_PROFILE_ID: "profile2",
    AOS_CHROME_PROFILE_NAME: "Profile 2",
    AOS_CHROME_PROFILE_DIRECTORY: "Profile 2",
    AOS_CHROME_PROFILE_SURFACE: "aos_chrome_companion_profile_instance",
  }, {
    companionWorkflow: async () => ({
      status: "blocked",
      exact_blocker: "companion_dropdown_control_unsupported",
      external_action_executed: false,
      browser_backend: "aos_chrome_companion",
      browser_surface: "aos_chrome_companion_profile_instance",
      cleanup_verified: true,
      effects_mode: "read_only",
      read_only_stage_bound: true,
      mutation_dispatch_attempted: false,
      mutation_dispatch_count: 0,
      operation_effect_state: "none",
      reconciliation_required: false,
    }),
    officialWorkflow: async () => {
      officialCalls += 1;
      return {
        status: "complete",
        exact_blocker: null,
        external_action_executed: false,
        browser_backend: "chrome_plugin",
        browser_surface: "signed_chrome_extension_profile2",
        cleanup_verified: true,
        readback_verified: true,
        visual_readback_verified: true,
      };
    },
  });
  assert.equal(officialCalls, 1);
  assert.equal(result.safe_surface_handoff.status, "completed");
  assert.equal(result.safe_surface_handoff.transition_reason, "companion_dropdown_control_unsupported");
  assert.equal(result.safe_surface_handoff.transition_visible, true);
});

test("read-only runner does not hand off auth or unknown-effect failures", async () => {
  for (const companionResult of [
    {
      exact_blocker: "auth_blocked:login_required",
      operation_effect_state: "none",
      reconciliation_required: false,
    },
    {
      exact_blocker: "operation_effect_unknown",
      operation_effect_state: "unknown",
      reconciliation_required: true,
    },
  ]) {
    let officialCalls = 0;
    const result = await runReadOnlyWorkflow({
      workflow_id: "daily-ai-research-publish-run",
      run_id: `run-no-handoff-${officialCalls}`,
      step_id: "reference_readback",
      source_trigger: "test",
      idempotency_key: "no-handoff",
    }, { AOS_WEB_OPERATION_BACKEND: "aos_chrome_companion" }, {
      companionWorkflow: async () => ({
        status: "blocked",
        external_action_executed: false,
        browser_backend: "aos_chrome_companion",
        browser_surface: "aos_chrome_companion_profile_instance",
        cleanup_verified: true,
        effects_mode: "read_only",
        read_only_stage_bound: true,
        mutation_dispatch_attempted: false,
        mutation_dispatch_count: 0,
        ...companionResult,
      }),
      officialWorkflow: async () => { officialCalls += 1; return {}; },
    });
    assert.equal(officialCalls, 0);
    assert.equal(result.status, "blocked");
    assert.equal(result.safe_surface_handoff.status, "blocked");
  }
});

test("Chrome Plugin read-only request carries an immutable backend snapshot contract", () => {
  const runnerSource = readFileSync(fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url)), "utf8");
  assert.match(runnerSource, /web_operation_backend_snapshot/u);
  assert.match(runnerSource, /requested_backend: "chrome_plugin"/u);
  assert.match(runnerSource, /AOS_WEB_OPERATION_BACKEND_FALLBACK_ALLOWED/u);
  assert.match(runnerSource, /chrome_plugin_backend_snapshot_missing/u);
});

test("Chrome Plugin handoff route is explicit and does not reuse the Browser Use CLI candidate adapter", () => {
  const runnerSource = readFileSync(fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url)), "utf8");
  const bridgeSource = readFileSync(fileURLToPath(new URL("../../../../New project/scripts/browser_use/chrome_extension_trusted_bridge_server.mjs", import.meta.url)), "utf8");
  assert.match(runnerSource, /runChromePluginReadOnlyWorkflow/u);
  assert.match(runnerSource, /aos-read-only-handoff/u);
  assert.match(runnerSource, /browser_surface: CHROME_PLUGIN_BROWSER_SURFACE/u);
  assert.match(runnerSource, /executeAosPortableReadOnlyHandoff/u);
  assert.match(bridgeSource, /AOS_PORTABLE_READ_ONLY_HANDOFF_SCHEMA/u);
  assert.match(bridgeSource, /chrome_plugin_read_only_handoff_requires_active_call/u);
  assert.match(bridgeSource, /withChromeExtensionRequestLifecycle/u);
  assert.match(bridgeSource, /tabs\.finalize/u);
});

test("Chrome Plugin direct bridge timeout fails closed before the Node REPL wall-clock reset", async () => {
  const previousBridge = globalThis.__socialFlowChromeExtensionBridge;
  const previousNodeRepl = globalThis.nodeRepl;
  globalThis.__socialFlowChromeExtensionBridge = {
    executeAosPortableReadOnlyHandoff: () => new Promise(() => {}),
  };
  globalThis.nodeRepl = { requestMeta: {} };
  try {
    const startedAt = Date.now();
    const response = await runChromePluginBridgeClient({
      payload: { schema: "aos.chrome_plugin_read_only_handoff.v1" },
      environment: { SOCIAL_FLOW_CHROME_EXTENSION_BRIDGE_IN_PROCESS_TIMEOUT_MS: "100" },
    });
    assert.ok(Date.now() - startedAt < 1_000, "direct bridge must not wait for the outer REPL timeout");
    assert.equal(response.direct, true);
    assert.equal(response.code, 2);
    assert.equal(response.error, "chrome_plugin_direct_bridge_timeout");
    assert.equal(response.result, null);
  } finally {
    if (previousBridge === undefined) delete globalThis.__socialFlowChromeExtensionBridge;
    else globalThis.__socialFlowChromeExtensionBridge = previousBridge;
    if (previousNodeRepl === undefined) delete globalThis.nodeRepl;
    else globalThis.nodeRepl = previousNodeRepl;
  }
});

test("Chrome Plugin read-only worker uses target-scoped readback and keeps selected-tab recovery separate", () => {
  const source = readFileSync(fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url)), "utf8");
  assert.match(source, /let targetScopedReadback = true;/u);
  assert.match(source, /targetScopedReadback/u);
  assert.match(source, /chrome_selected_tab_readback_invalid/u);
  assert.match(source, /chrome_plugin_foreground_executor_lease_expired/u);
  assert.match(source, /chrome_foreground_activation_capability_unavailable/u);
  assert.match(source, /target_scoped_readback: targetScopedReadback/u);
  assert.match(source, /provision_target_if_missing: targetScopedReadback === true/u);
  assert.match(source, /target_tab: input\?\.target_tab/u);
  assert.match(source, /target-scoped[\s\S]{0,180}fresh openTabs/u);
  assert.match(source, /function assertChromePluginBridgeReadbackValue\([\s\S]{0,180}targetScopedReadback = false/u);
  assert.match(source, /targetScopedReadback \|\| String\(selectedTab\?\.id/u);
  assert.match(source, /!targetScopedReadback && \(\s*!Number\.isFinite\(ownerUpdatedAt\)/u);
  assert.match(source, /bridgeReadback = await refreshChromePluginBridgeReadback\(environment, \{ targetScopedReadback: true \}\);/u);
  assert.match(source, /targetScopedReadback = true;/u);
});

test("Chrome Plugin target-scoped read-only admits a fresh selected-tab blocker without synthesizing foreground readiness", () => {
  const now = new Date().toISOString();
  const value = {
    schema: "aos.chrome_plugin_bridge_readback.v2",
    status: "blocked",
    backend: "chrome_extension_trusted_bridge",
    bridge_instance_id: "bridge-target-scoped-selected-blocker",
    bridge_url: "http://127.0.0.1:58744",
    browser_execution_authority: "read_only_admission",
    browser_execution_disabled: false,
    browser: {
      id: "chrome-profile2-target-scoped",
      type: "extension",
      metadata: { profileOrdering: "2", profileIsLastUsed: "true" },
    },
    operation_ready: false,
    operation_status: "blocked",
    operation_exact_blocker: "chrome_selected_tab_readback_invalid",
    selected_tab: null,
    bridge_owner: {
      schema: "aos.chrome_plugin_bridge_owner.v1",
      owner_id: "chrome-plugin-owner-target-scoped-selected-blocker",
      bridge_instance_id: "bridge-target-scoped-selected-blocker",
      session_id: "session-target-scoped",
      thread_id: "thread-target-scoped",
      turn_id: "turn-target-scoped",
      status: "bridge_only",
      foreground_executor_ready: false,
      exact_blocker: "chrome_selected_tab_readback_invalid",
      updated_at: now,
    },
    exact_blocker: "chrome_selected_tab_readback_invalid",
    last_seen_at: now,
  };
  assertChromePluginBridgeReadbackValue(value, { AOS_CHROME_PLUGIN_PROFILE_DIRECTORY: "Profile 2" }, { targetScopedReadback: true });
  assert.throws(
    () => assertChromePluginBridgeReadbackValue(value, { AOS_CHROME_PLUGIN_PROFILE_DIRECTORY: "Profile 2" }),
    /chrome_selected_tab_readback_invalid/u,
  );
});

test("Chrome Plugin target-scoped read-only keeps missing foreground capability isolated to the foreground plane", () => {
  const now = new Date().toISOString();
  const value = {
    schema: "aos.chrome_plugin_bridge_readback.v2",
    status: "blocked",
    backend: "chrome_extension_trusted_bridge",
    bridge_instance_id: "bridge-target-scoped-capability-blocker",
    bridge_url: "http://127.0.0.1:58744",
    browser_execution_authority: "read_only_admission",
    browser_execution_disabled: false,
    browser: {
      id: "chrome-profile2-target-scoped-capability-blocker",
      type: "extension",
      metadata: { profileOrdering: "2", profileIsLastUsed: "true" },
    },
    operation_ready: false,
    operation_status: "blocked",
    operation_exact_blocker: "chrome_foreground_activation_capability_unavailable",
    selected_tab: null,
    bridge_owner: {
      schema: "aos.chrome_plugin_bridge_owner.v1",
      owner_id: "chrome-plugin-owner-target-scoped-capability-blocker",
      bridge_instance_id: "bridge-target-scoped-capability-blocker",
      session_id: "session-target-scoped-capability-blocker",
      thread_id: "thread-target-scoped-capability-blocker",
      turn_id: "turn-target-scoped-capability-blocker",
      status: "bridge_only",
      foreground_executor_ready: false,
      exact_blocker: "chrome_foreground_activation_capability_unavailable",
      updated_at: now,
    },
    exact_blocker: "chrome_foreground_activation_capability_unavailable",
    last_seen_at: now,
  };
  assert.doesNotThrow(() => assertChromePluginBridgeReadbackValue(
    value,
    { AOS_CHROME_PLUGIN_PROFILE_DIRECTORY: "Profile 2" },
    { targetScopedReadback: true },
  ));
  assert.throws(
    () => assertChromePluginBridgeReadbackValue(value, { AOS_CHROME_PLUGIN_PROFILE_DIRECTORY: "Profile 2" }),
    /chrome_foreground_activation_capability_unavailable/u,
  );
});

test("Chrome Plugin target-scoped read-only accepts the official target_scoped_ready operation state", () => {
  const now = new Date().toISOString();
  const value = {
    schema: "aos.chrome_plugin_bridge_readback.v2",
    status: "ready",
    backend: "chrome_extension_trusted_bridge",
    bridge_instance_id: "bridge-target-scoped-ready",
    bridge_url: "http://127.0.0.1:58744",
    browser_execution_authority: "read_only_admission",
    browser_execution_disabled: false,
    browser: {
      id: "chrome-profile2-target-scoped-ready",
      type: "extension",
      metadata: { profileOrdering: "2", profileIsLastUsed: "true" },
    },
    operation_ready: true,
    operation_status: "target_scoped_ready",
    operation_exact_blocker: null,
    selected_tab: null,
    bridge_owner: {
      schema: "aos.chrome_plugin_bridge_owner.v1",
      owner_id: "chrome-plugin-owner-target-scoped-ready",
      bridge_instance_id: "bridge-target-scoped-ready",
      session_id: "session-target-scoped-ready",
      thread_id: "thread-target-scoped-ready",
      turn_id: "turn-target-scoped-ready",
      status: "bridge_only",
      foreground_executor_ready: false,
      exact_blocker: null,
      updated_at: now,
    },
    exact_blocker: null,
    last_seen_at: now,
  };
  assert.doesNotThrow(() => assertChromePluginBridgeReadbackValue(
    value,
    { AOS_CHROME_PLUGIN_PROFILE_DIRECTORY: "Profile 2" },
    { targetScopedReadback: true },
  ));
});

test("Chrome Plugin runner preserves the bridge terminal receipt as bridge_receipt_path", () => {
  const source = readFileSync(fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url)), "utf8");
  assert.match(source, /const bridgeReceiptPath = String\([\s\S]{0,520}handoff_receipt_path/u);
  assert.match(source, /response\.result\?\.handoff_receipt_path/u);
  assert.match(source, /result\.handoff_receipt_path/u);
  assert.match(source, /adapter_result:\s*\{[\s\S]{0,900}bridge_receipt_path: bridgeReceiptPath/u);
  assert.match(source, /cleanup_failed: result\.tab_cleanup\?\.cleanup_failed === true/u);
  assert.match(source, /read_only_proof_verified: ready/u);
});

test("reference readback completes only after readback and cleanup, without business proof", () => {
  const source = readFileSync(fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url)), "utf8");
  assert.match(source, /const referenceReadback = environment\.AUTOMATION_OS_PORTABLE_EXTERNAL_READ_ONLY_STAGE === REFERENCE_READBACK_STAGE/u);
  assert.match(source, /finalizedResult\?\.finalized !== true[\s\S]{0,260}referenceReadback[\s\S]{0,120}\? null/u);
  assert.match(source, /status: exactBlocker === null \? "complete"/u);
  assert.match(source, /external_executor_status: referenceReadback \? "reference_readback_completed"/u);
  assert.match(source, /reference_readback: referenceReadback/u);
});

test("Job candidate supply is an AOS-owned Browser Use CLI read-only stage", () => {
  const source = readFileSync(fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url)), "utf8");
  assert.match(source, /job_candidate_supply/u);
  assert.match(source, /JOB_CANDIDATE_SUPPLY_STAGE\s*=\s*["']candidate_supply["']/u);
  assert.match(source, /REFERENCE_READBACK_STAGE\s*=\s*["']reference_readback["']/u);
  assert.match(source, /AUTOMATION_OS_PORTABLE_EXTERNAL_READ_ONLY_STAGE\s*===\s*JOB_CANDIDATE_SUPPLY_STAGE/u);
  assert.match(source, /\[JOB_CANDIDATE_SUPPLY_STAGE, REFERENCE_READBACK_STAGE\]\.?includes\(/u);
  assert.match(source, /: ready\s*\n\s*\? null\s*\n\s*:\s*PORTABLE_EXTERNAL_READ_ONLY_BUSINESS_PROOF_PENDING/u);
  assert.match(source, /read_only_stage_bound:\s*true/u);
  assert.match(source, /same_run_receipt:\s*ready/u);
  assert.match(source, /job_manager_browser_use_cli_candidate_supply_adapter\.mjs/u);
  assert.match(source, /portable_external_browser_use_cli_noncanonical_helper/u);
  assert.match(source, /portableBrowserUsePaths\(environment\)/u);
  assert.match(source, /const helper = paths\.helper/u);
  assert.doesNotMatch(source, /JOB_CANDIDATE_SUPPLY_PACKAGE_HELPER/u);
  assert.match(source, /browserFlowFinalize: true/u);
  assert.match(source, /external_action_executed: false/u);
  assert.doesNotMatch(source, /runJobManagerBrowserUseCliSubmit/u);
});

test("read-only routes use adapter-allowlisted captured URL and title probes", async () => {
  const source = readFileSync(fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url)), "utf8");
  assert.match(source, /\["eval", "location\.href"\]/u);
  assert.match(source, /\["eval", "document\.title"\]/u);
  assert.match(source, /\["get", "url"\]/u);
  assert.match(source, /\["get", "title"\]/u);
});

test("read-only navigation allows the canonical helper to reconcile same-origin login redirects", () => {
  const source = readFileSync(fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url)), "utf8");
  assert.match(source, /\["open", route\.target_url\]/u);
  assert.match(source, /same-origin[\s\S]{0,40}authenticated route/u);
});

test("read-only Browser Use runtime readback is returned to the AOS binding boundary", () => {
  const source = readFileSync(fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url)), "utf8");
  const runtimeReadback = source.indexOf("const browserRuntimeReadback = {");
  const adapterResult = source.indexOf("browser_runtime_readback: browserRuntimeReadback");
  const effectiveSession = source.indexOf("effective_session: String(flow.contract?.effective_session || flow.session || \"\")");
  const cleanup = source.indexOf("cleanup_verified: finalizedResult?.finalized === true");
  assert.ok(runtimeReadback >= 0, "read-only runner must construct runtime readback");
  assert.ok(effectiveSession > runtimeReadback, "effective session must come from the live flow contract");
  assert.ok(cleanup > runtimeReadback, "runtime readback must bind cleanup proof");
  assert.ok(adapterResult > cleanup, "runtime readback must cross the adapter_result boundary");
});

test("adaptive semantic target readback advances beyond the completed batch sequence", () => {
  const source = readFileSync(fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url)), "utf8");
  assert.match(
    source,
    /targetText: intent\.target\.semantic_query,[\s\S]{0,180}actionSequence: Number\(flow\.contract\?\.action_sequence \|\| 0\) \+ 1/u,
  );
});

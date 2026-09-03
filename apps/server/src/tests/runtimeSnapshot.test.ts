import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildBrowserOperationalReadback, buildBrowserUseRuntimeSnapshot, buildBrowserUseRuntimeSnapshotAsync } from "../browser/runtimeSnapshot.js";
import { buildBrowserRuntimeProcessReadback, buildBrowserRuntimeProcessReadbackAsync } from "../browser/liveResourceReadback.js";

const originalRole = process.env.AUTOMATION_OS_RUNTIME_ROLE;
const originalVerified = process.env.AUTOMATION_OS_BROWSER_USE_RUNTIME_VERIFIED;
const originalChromeReadbackPath = process.env.AOS_CHROME_PLUGIN_READBACK_PATH;

function restoreEnvironment() {
  if (originalRole === undefined) delete process.env.AUTOMATION_OS_RUNTIME_ROLE;
  else process.env.AUTOMATION_OS_RUNTIME_ROLE = originalRole;
  if (originalVerified === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_RUNTIME_VERIFIED;
  else process.env.AUTOMATION_OS_BROWSER_USE_RUNTIME_VERIFIED = originalVerified;
  if (originalChromeReadbackPath === undefined) delete process.env.AOS_CHROME_PLUGIN_READBACK_PATH;
  else process.env.AOS_CHROME_PLUGIN_READBACK_PATH = originalChromeReadbackPath;
}

test.afterEach(restoreEnvironment);

test("control-plane Browser Use projection waits for Mac worker readback instead of checking a worker-local helper", () => {
  delete process.env.AUTOMATION_OS_RUNTIME_ROLE;
  delete process.env.AUTOMATION_OS_BROWSER_USE_RUNTIME_VERIFIED;

  const snapshot = buildBrowserUseRuntimeSnapshot();

  assert.equal(snapshot.runtimeRole, "control_plane");
  assert.equal(snapshot.status, "readback_pending");
  assert.equal(snapshot.exactBlocker, "browser_use_worker_readback_pending");
  assert.equal(snapshot.readbackStatus, "pending");
  assert.match(snapshot.summary, /control plane/);
  assert.equal("helperPath" in snapshot, false);
  assert.equal(snapshot.processReadback.schema, "aos.browser_runtime_process_readback.v1");
  assert.equal(snapshot.operationalReadback.schema, "aos.browser_operational_readback.v1");
  assert.equal(snapshot.operationalReadback.scope, "current_control_plane_snapshot");
  assert.equal(snapshot.operationalReadback.authentication.status, "unknown");
  assert.equal(snapshot.operationalReadback.authentication.exactBlocker, "browser_use_authentication_screen_readback_required");
  assert.equal(snapshot.operationalReadback.externalEffect.status, "not_verified");
  assert.equal(snapshot.operationalReadback.externalEffect.externalActionExecuted, false);
  assert.equal(snapshot.operationalReadback.businessCompletion.status, "not_claimed");
  assert.equal(snapshot.operationalReadback.businessCompletion.businessCompletionVerified, false);
  assert.equal(snapshot.operationalReadback.receipt.status, "not_claimed");
  assert.equal(snapshot.operationalReadback.sourceSync.status, "not_claimed");
  assert.equal(snapshot.operationalReadback.capturedAt, snapshot.processReadback.capturedAt);
  const firstProcess = snapshot.processReadback.browserProcesses[0];
  if (firstProcess) {
    assert.equal("command" in firstProcess, false);
    assert.equal("profilePath" in firstProcess, false);
  }
  assert.equal(snapshot.processReadback.externalActionExecuted, false);

  for (const lane of snapshot.lanes) {
    const laneReadback = snapshot.processReadback.registeredLanes.find((item) => item.laneId === lane.id);
    const expectedStatus = snapshot.processReadback.status === "unavailable"
      ? "unavailable"
      : laneReadback?.processStatus ?? "unavailable";
    assert.equal(lane.processReadbackStatus, expectedStatus);
    assert.equal(lane.processReadbackCapturedAt, snapshot.processReadback.capturedAt);
    assert.equal(lane.processPid, laneReadback?.matchingPid ?? laneReadback?.mismatchPid ?? null);
  }

  const bindings = new Map(snapshot.lanes.map((lane) => [lane.workflowId, lane]));
  assert.deepEqual(
    [
      [bindings.get("job-application-manager")?.profileRef, bindings.get("job-application-manager")?.reservedPort],
      [bindings.get("daily-ai-research-publish-run")?.profileRef, bindings.get("daily-ai-research-publish-run")?.reservedPort],
      [bindings.get("nisenprints-daily-product-canva-printify-etsy-pinterest")?.profileRef, bindings.get("nisenprints-daily-product-canva-printify-etsy-pinterest")?.reservedPort]
    ],
    [
      ["scheduled/automation-3", 19881],
      ["scheduled/daily-ai", 19882],
      ["scheduled/nisenprints", 19884]
    ]
  );
  assert.ok(snapshot.lanes.every((lane) => !("profileDir" in lane) && !("lockPath" in lane) && !("browserUseCdpUrl" in lane)));
  assert.ok(snapshot.lanes.every((lane) => lane.liveReadbackStatus === "not_claimed"));
  assert.ok(!JSON.stringify(snapshot.operationalReadback).match(/(cookie|token|password|secret|authorization|storageState|profilePath|lockPath|cdp)/iu));
});

test("Mac worker Browser Use projection is verified only after explicit local readback", () => {
  process.env.AUTOMATION_OS_RUNTIME_ROLE = "mac_worker";
  process.env.AUTOMATION_OS_BROWSER_USE_RUNTIME_VERIFIED = "1";

  const snapshot = buildBrowserUseRuntimeSnapshot();

  assert.equal(snapshot.runtimeRole, "mac_worker");
  assert.equal(snapshot.status, "verified");
  assert.equal(snapshot.exactBlocker, null);
  assert.equal(snapshot.readbackStatus, "verified");
});

test("Mac worker Browser Use projection blocks without explicit verification", () => {
  process.env.AUTOMATION_OS_RUNTIME_ROLE = "mac_worker";
  delete process.env.AUTOMATION_OS_BROWSER_USE_RUNTIME_VERIFIED;

  const snapshot = buildBrowserUseRuntimeSnapshot();

  assert.equal(snapshot.runtimeRole, "mac_worker");
  assert.equal(snapshot.status, "blocked");
  assert.equal(snapshot.exactBlocker, "browser_use_runtime_not_verified");
  assert.equal(snapshot.readbackStatus, "pending");
});

test("selected Chrome Plugin backend projects its fresh Profile 2 bridge readback", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "aos-runtime-chrome-plugin-"));
  const readbackPath = join(tempRoot, "bridge.json");
  process.env.AOS_CHROME_PLUGIN_READBACK_PATH = readbackPath;
  writeFileSync(readbackPath, JSON.stringify({
    schema: "aos.chrome_plugin_bridge_readback.v2",
    status: "ready",
    bridge_instance_id: "bridge-runtime-test",
    bridge_owner: { schema: "aos.chrome_plugin_bridge_owner.v1", owner_id: "owner-runtime-test", pid: 1234, bridge_instance_id: "bridge-runtime-test", session_id: "runtime-session", thread_id: "runtime-thread", turn_id: "runtime-turn", status: "foreground_ready", foreground_executor_ready: true, updated_at: new Date().toISOString() },
    bridge_url: "http://127.0.0.1:58737",
    browser_execution_authority: "general",
    browser_execution_disabled: false,
    browser: {
      id: "chrome-runtime-test",
      type: "extension",
      metadata: { profileOrdering: "2", profileName: "Nicky", profileIsLastUsed: "true" }
    },
    operation_ready: true,
    operation_status: "ready",
    operation_exact_blocker: null,
    selected_tab: { id: "runtime-selected-tab", url: "https://example.test/" },
    visibility: { capability_id: "visibility", advertised: true, state: true },
    last_seen_at: new Date().toISOString()
  }) + "\n", { mode: 0o600 });
  chmodSync(readbackPath, 0o600);
  try {
    const snapshot = buildBrowserUseRuntimeSnapshot({ selectedBackend: "chrome_plugin" });
    assert.equal(snapshot.backend, "chrome_plugin");
    assert.equal(snapshot.surface, "signed_chrome_extension_profile2");
    assert.equal(snapshot.helper, "chrome_extension_trusted_bridge");
    assert.equal(snapshot.status, "verified");
    assert.equal(snapshot.exactBlocker, null);
    assert.equal(snapshot.chromePluginReadback?.browser?.metadata.profileOrdering, "2");
    assert.equal(snapshot.chromePluginLane?.blockingScope, null);
    assert.equal(snapshot.chromePluginLane?.independentLanesAllowed, true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("AOS Chrome Companion backend projects its concrete Companion surface", () => {
  const snapshot = buildBrowserUseRuntimeSnapshot({ selectedBackend: "aos_chrome_companion" });

  assert.equal(snapshot.backend, "aos_chrome_companion");
  assert.equal(snapshot.surface, "aos_chrome_companion_profile_instance");
  assert.equal(snapshot.status, "readback_pending");
  assert.equal(snapshot.fallbackPolicy, "no_implicit_surface_switch");
});

test("target-scoped Chrome Plugin snapshot stays usable when selected tab is unavailable", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "aos-runtime-chrome-plugin-target-scoped-"));
  const readbackPath = join(tempRoot, "bridge.json");
  process.env.AOS_CHROME_PLUGIN_READBACK_PATH = readbackPath;
  writeFileSync(readbackPath, JSON.stringify({
    schema: "aos.chrome_plugin_bridge_readback.v2",
    status: "blocked",
    bridge_instance_id: "bridge-target-scoped-runtime",
    bridge_url: "http://127.0.0.1:58744",
    browser_execution_authority: "read_only_admission",
    browser_execution_disabled: false,
    browser: { id: "chrome-target-scoped-runtime", type: "extension", metadata: { profileOrdering: "2" } },
    bridge_owner: { schema: "aos.chrome_plugin_bridge_owner.v1", owner_id: "owner-target-scoped-runtime", pid: null, bridge_instance_id: "bridge-target-scoped-runtime", session_id: "runtime-session", thread_id: "runtime-thread", turn_id: "runtime-turn", status: "bridge_only", foreground_executor_ready: false, exact_blocker: "chrome_selected_tab_readback_invalid", updated_at: new Date().toISOString() },
    operation_ready: false,
    operation_status: "blocked",
    operation_exact_blocker: "chrome_selected_tab_readback_invalid",
    selected_tab: null,
    exact_blocker: "chrome_selected_tab_readback_invalid",
    last_seen_at: new Date().toISOString()
  }) + "\n", { mode: 0o600 });
  chmodSync(readbackPath, 0o600);
  try {
    const snapshot = buildBrowserUseRuntimeSnapshot({ selectedBackend: "chrome_plugin", targetScopedReadback: true });
    assert.equal(snapshot.status, "verified");
    assert.equal(snapshot.exactBlocker, null);
    assert.equal(snapshot.operationReady, true);
    assert.equal(snapshot.chromePluginReadback?.readbackScope, "target_scoped");
    assert.equal(snapshot.chromePluginReadback?.selectedTab, null);
    assert.equal(snapshot.chromePluginLane?.independentLanesAllowed, true);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Chrome Plugin runtime snapshot uses worker heartbeat projection instead of hosted loopback", () => {
  const snapshot = buildBrowserUseRuntimeSnapshot({
    selectedBackend: "chrome_plugin",
    targetScopedReadback: true,
    remoteChromePluginReadback: {
      schema: "aos.portable_worker_chrome_plugin_readback.v1",
      status: "blocked",
      exact_blocker: "chrome_plugin_foreground_executor_lease_expired",
      target_scoped_ready: true,
      target_scoped_exact_blocker: null,
      operation_ready: true,
      operation_status: "ready",
      operation_exact_blocker: null,
      bridge_instance_id: "-7424-4c88-b483-91644aa4ea4d",
      last_seen_at: new Date().toISOString(),
      browser: { id: "-7424-4c88-b483-91644aa4ea4d", type: "extension", profile_name: "Nicky", profile_ordering: "2" },
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
        updated_at: new Date().toISOString()
      }
    }
  });
  assert.equal(snapshot.status, "verified");
  assert.equal(snapshot.exactBlocker, null);
  assert.equal(snapshot.chromePluginReadback?.readbackScope, "target_scoped");
  assert.equal(snapshot.chromePluginReadback?.operationReady, true);
  assert.equal(snapshot.chromePluginReadback?.bridgeUrl, null);
});

test("async selected Chrome Plugin snapshot refreshes the same bridge before freshness evaluation", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "aos-runtime-chrome-plugin-async-"));
  const readbackPath = join(tempRoot, "bridge.json");
  process.env.AOS_CHROME_PLUGIN_READBACK_PATH = readbackPath;
  const server = createServer((_request, response) => {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const bridgeUrl = `http://127.0.0.1:${address.port}`;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      url: bridgeUrl,
      bridge_instance_id: "bridge-async-refresh",
      browser_readback: {
        schema: "aos.chrome_plugin_bridge_readback.v2",
        status: "ready",
        bridge_instance_id: "bridge-async-refresh",
        bridge_owner: { schema: "aos.chrome_plugin_bridge_owner.v1", owner_id: "owner-async-refresh", pid: 1234, bridge_instance_id: "bridge-async-refresh", session_id: "runtime-session", thread_id: "runtime-thread", turn_id: "runtime-turn", status: "foreground_ready", foreground_executor_ready: true, updated_at: new Date().toISOString() },
        bridge_url: bridgeUrl,
        browser_execution_authority: "general",
        browser_execution_disabled: false,
        browser: { id: "chrome-async-refresh", type: "extension", metadata: { profileOrdering: "2" } },
        operation_ready: true,
        operation_status: "ready",
        operation_exact_blocker: null,
        selected_tab: { id: "async-selected-tab", url: "https://example.test/" },
        visibility: { capability_id: "visibility", advertised: true, state: true },
        refresh_status: "ready",
        refresh_exact_blocker: null,
        last_seen_at: new Date().toISOString()
      }
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const bridgeUrl = `http://127.0.0.1:${address.port}`;
  writeFileSync(readbackPath, JSON.stringify({
    schema: "aos.chrome_plugin_bridge_readback.v2",
    status: "ready",
    bridge_instance_id: "bridge-async-refresh",
    bridge_owner: { schema: "aos.chrome_plugin_bridge_owner.v1", owner_id: "owner-async-refresh", pid: 1234, bridge_instance_id: "bridge-async-refresh", session_id: "runtime-session", thread_id: "runtime-thread", turn_id: "runtime-turn", status: "foreground_ready", foreground_executor_ready: true, updated_at: new Date().toISOString() },
    bridge_url: bridgeUrl,
    browser_execution_authority: "general",
    browser_execution_disabled: false,
    browser: { id: "chrome-async-refresh", type: "extension", metadata: { profileOrdering: "2" } },
    operation_ready: true,
    operation_status: "ready",
    operation_exact_blocker: null,
    selected_tab: { id: "async-selected-tab", url: "https://example.test/" },
    visibility: { capability_id: "visibility", advertised: true, state: true },
    last_seen_at: "2026-08-14T00:00:00.000Z"
  }) + "\n", { mode: 0o600 });
  chmodSync(readbackPath, 0o600);
  try {
    const snapshot = await buildBrowserUseRuntimeSnapshotAsync({ selectedBackend: "chrome_plugin" });
    assert.equal(snapshot.backend, "chrome_plugin");
    assert.equal(snapshot.status, "verified");
    assert.equal(snapshot.exactBlocker, null);
    assert.equal(snapshot.chromePluginReadback?.status, "ready");
    assert.equal(snapshot.chromePluginReadback?.bridgeInstanceId, "bridge-async-refresh");
    assert.equal(snapshot.chromePluginReadback?.refreshStatus, "ready");
    assert.equal(snapshot.chromePluginReadback?.refreshExactBlocker, null);
    assert.notEqual(snapshot.chromePluginReadback?.capturedAt, "2026-08-14T00:00:00.000Z");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("operational readback never promotes healthy worker transport or foreign process presence", () => {
  const processReadback = buildBrowserRuntimeProcessReadback({
    capturedAt: "2026-08-11T13:40:00.000Z",
    psOutput: [
      "47153 1 /usr/local/bin/aos-portable-remote-worker.mjs",
      "46982 1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=20092 --user-data-dir=/Users/owner/.browser-use-cli/profiles/temporary/foreign-run"
    ].join("\n"),
    envOutputByPid: {
      "47153": "AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS=read_only AUTOMATION_OS_PORTABLE_WORKER_MODE=external AUTOMATION_OS_WORKER_DURABLE_ONLY=1"
    },
    workerStatusOutput: JSON.stringify({
      schema: "aos.portable_remote_worker_status.v1",
      heartbeat_status: "ok",
      heartbeat_exact_blocker: null,
      heartbeat_at: "2026-08-11T13:39:59.000Z",
      last_successful_heartbeat_at: "2026-08-11T13:39:59.000Z",
      last_attempt_at: "2026-08-11T13:39:59.000Z",
      claim_status: "claimed",
      generation_started_at: "2026-08-11T13:30:00.000Z",
      updated_at: "2026-08-11T13:39:59.000Z",
      pid: 47153
    })
  });

  const readback = buildBrowserOperationalReadback(processReadback);

  assert.equal(processReadback.exactBlocker, "browser_use_unregistered_live_process");
  assert.equal(readback.worker.processStatus, "present");
  assert.equal(readback.worker.heartbeatStatus, "ok");
  assert.equal(readback.worker.claimStatus, "claimed");
  assert.equal(readback.authentication.status, "unknown");
  assert.equal(readback.externalEffect.status, "not_verified");
  assert.equal(readback.externalEffect.externalActionExecuted, false);
  assert.equal(readback.businessCompletion.status, "not_claimed");
  assert.equal(readback.businessCompletion.businessCompletionVerified, false);
  assert.equal(readback.receipt.status, "not_claimed");
  assert.equal(readback.sourceSync.status, "not_claimed");
  assert.equal(readback.worker.receiptStatus, "not_claimed");
  assert.equal(readback.worker.sourceSyncStatus, "not_claimed");
  assert.equal(readback.worker.exactBlocker, "browser_use_unregistered_live_process");
});

test("async Browser Use process readback preserves profile/port scope without a synchronous process probe", async () => {
  const options = {
    capturedAt: "2026-08-11T13:40:00.000Z",
    psOutput: "47153 1 /usr/local/bin/aos-portable-remote-worker.mjs",
    envOutputByPid: {
      "47153": "AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS=read_only AUTOMATION_OS_PORTABLE_WORKER_MODE=external AUTOMATION_OS_WORKER_DURABLE_ONLY=1 AUTOMATION_OS_PORTABLE_REMOTE_WORKER_ID=worker-1 AUTOMATION_OS_PORTABLE_REMOTE_URL=https://automation-os.zeabur.app AUTOMATION_OS_PORTABLE_REMOTE_COMPANY_ID=company_1"
    },
    controlPlaneCompanyIds: ["company_1"]
  };
  const [syncReadback, asyncReadback] = await Promise.all([
    Promise.resolve(buildBrowserRuntimeProcessReadback(options)),
    buildBrowserRuntimeProcessReadbackAsync(options)
  ]);
  assert.deepEqual(asyncReadback, syncReadback);

  process.env.AUTOMATION_OS_RUNTIME_ROLE = "control_plane";
  const snapshot = await buildBrowserUseRuntimeSnapshotAsync({ controlPlaneCompanyIds: ["company_1"] });
  assert.equal(snapshot.runtimeRole, "control_plane");
  assert.equal(snapshot.processReadback.schema, "aos.browser_runtime_process_readback.v1");
});

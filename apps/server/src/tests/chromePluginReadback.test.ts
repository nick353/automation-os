import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  chromePluginReadbackFromPortableWorkerHeartbeat,
  chromePluginReadbackPathForEnvironment,
  readChromePluginReadback,
  refreshChromePluginReadback,
} from "../browser/chromePluginReadback.js";

const tempRoot = mkdtempSync(join(tmpdir(), "aos-chrome-plugin-readback-"));
const readbackPath = join(tempRoot, "bridge.json");
const previousPath = process.env.AOS_CHROME_PLUGIN_READBACK_PATH;
const previousPort = process.env.AOS_CHROME_PLUGIN_BRIDGE_PORT;

function writeReadback(value: Record<string, unknown>) {
  const bridgeInstanceId = String(value.bridge_instance_id || "test-bridge");
  const normalized = value.bridge_owner === undefined
    ? {
        bridge_owner: {
          schema: "aos.chrome_plugin_bridge_owner.v1",
          owner_id: `owner-${bridgeInstanceId}`,
          pid: 1234,
          bridge_instance_id: bridgeInstanceId,
          session_id: "session-test",
          thread_id: "thread-test",
          turn_id: "turn-test",
          status: "foreground_ready",
          foreground_executor_ready: true,
          exact_blocker: null,
          started_at: "2026-08-14T00:00:00.000Z",
          updated_at: "2026-08-14T00:00:05.000Z",
        },
        operation_ready: true,
        operation_status: "ready",
        operation_exact_blocker: null,
        selected_tab: { id: "selected-tab-test", url: "https://example.test/" },
        visibility: { capability_id: "visibility", advertised: true, state: true },
        ...value,
      }
    : value;
  writeFileSync(readbackPath, `${JSON.stringify(normalized)}\n`, { mode: 0o600 });
  chmodSync(readbackPath, 0o600);
}

function ownerFor(bridgeInstanceId: string, updatedAt = new Date().toISOString()) {
  return {
    schema: "aos.chrome_plugin_bridge_owner.v1",
    owner_id: `owner-${bridgeInstanceId}`,
    pid: 1234,
    bridge_instance_id: bridgeInstanceId,
    session_id: "session-test",
    thread_id: "thread-test",
    turn_id: "turn-test",
    status: "foreground_ready",
    foreground_executor_ready: true,
    exact_blocker: null,
    started_at: "2026-08-14T00:00:00.000Z",
    updated_at: updatedAt,
  };
}

test.after(() => {
  if (previousPath === undefined) delete process.env.AOS_CHROME_PLUGIN_READBACK_PATH;
  else process.env.AOS_CHROME_PLUGIN_READBACK_PATH = previousPath;
  if (previousPort === undefined) delete process.env.AOS_CHROME_PLUGIN_BRIDGE_PORT;
  else process.env.AOS_CHROME_PLUGIN_BRIDGE_PORT = previousPort;
});

test("AOS server defaults to the worker-owned Profile 2 readback path", () => {
  assert.equal(
    chromePluginReadbackPathForEnvironment({ HOME: "/tmp/aos-home" }),
    "/tmp/aos-home/.social-flow/aos-company1-profile2-bridge-readback-v2.json",
  );
  assert.equal(
    chromePluginReadbackPathForEnvironment({
      HOME: "/tmp/aos-home",
      AOS_CHROME_PLUGIN_READBACK_PATH: "/tmp/explicit/bridge.json",
    }),
    "/tmp/explicit/bridge.json",
  );
});

test("trusted Chrome bridge Profile 2 readback is ready only with fresh extension identity", () => {
  process.env.AOS_CHROME_PLUGIN_READBACK_PATH = readbackPath;
  const now = Date.parse("2026-08-14T00:00:10.000Z");
  writeReadback({
    schema: "aos.chrome_plugin_bridge_readback.v2",
    status: "ready",
    backend: "chrome_extension_trusted_bridge",
    bridge_instance_id: "bridge-1",
    bridge_url: "http://127.0.0.1:58737",
    browser_execution_authority: "general",
    browser_execution_disabled: false,
    browser: {
      id: "chrome-backend-1",
      name: "Chrome",
      type: "extension",
      metadata: {
        extensionId: "extension-1",
        extensionInstanceId: "instance-1",
        profileName: "Nicky",
        profileOrdering: "2",
        profileIsLastUsed: "true",
      },
    },
    last_seen_at: "2026-08-14T00:00:00.000Z",
    writer_lease: {
      schema: "chrome_extension_profile2_writer_lease.v1",
      profile_surface: "signed_chrome_extension_profile2",
      profile_ordering: 2,
      status: "held",
      poisoned: false,
      exact_blocker: null,
      updated_at: "2026-08-14T00:00:05.000Z",
    },
  });
  const readback = readChromePluginReadback(now);
  assert.equal(readback.status, "ready");
  assert.equal(readback.exactBlocker, null);
  assert.equal(readback.browser?.metadata.profileOrdering, "2");
  assert.equal(readback.browser?.metadata.extensionInstanceId, "instance-1");
  assert.equal(readback.writerLease?.status, "held");
  assert.equal(readback.writerLease?.profileOrdering, 2);
  assert.equal(readback.writerLease?.poisoned, false);
});

test("hosted control plane can project target-scoped Profile 2 readback from worker heartbeat", () => {
  const readback = chromePluginReadbackFromPortableWorkerHeartbeat({
    schema: "aos.portable_worker_chrome_plugin_readback.v1",
    status: "blocked",
    exact_blocker: "chrome_plugin_foreground_executor_lease_expired",
    target_scoped_ready: true,
    target_scoped_exact_blocker: null,
    operation_ready: true,
    operation_status: "ready",
    operation_exact_blocker: null,
    bridge_instance_id: "-7424-4c88-b483-91644aa4ea4d",
    last_seen_at: "2026-08-21T08:23:08.847Z",
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
      updated_at: "2026-08-21T08:23:08.847Z"
    }
  }, Date.parse("2026-08-21T08:23:20.000Z"));
  assert.equal(readback.status, "ready");
  assert.equal(readback.exactBlocker, null);
  assert.equal(readback.operationReady, true);
  assert.equal(readback.readbackScope, "target_scoped");
  assert.equal(readback.bridgeUrl, null);
  assert.equal(readback.browser?.metadata.profileOrdering, "2");
  assert.equal(readback.bridgeOwner?.status, "bridge_only");
});

test("general Chrome Plugin transport does not require recording visibility", () => {
  process.env.AOS_CHROME_PLUGIN_READBACK_PATH = readbackPath;
  writeReadback({
    schema: "aos.chrome_plugin_bridge_readback.v2",
    status: "ready",
    bridge_instance_id: "bridge-transport-only",
    bridge_url: "http://127.0.0.1:58737",
    browser_execution_authority: "general",
    browser_execution_disabled: false,
    browser: {
      id: "chrome-backend-transport-only",
      name: "Chrome",
      type: "extension",
      metadata: {
        profileName: "Nicky",
        profileOrdering: "2",
        profileIsLastUsed: "true",
      },
    },
    operation_ready: true,
    operation_status: "ready",
    operation_exact_blocker: null,
    selected_tab: { id: "selected-tab-transport-only", url: "about:blank" },
    visibility: { capability_id: "visibility", advertised: false, state: null },
    last_seen_at: "2026-08-14T00:00:00.000Z",
  });
  const readback = readChromePluginReadback(Date.parse("2026-08-14T00:00:10.000Z"));
  assert.equal(readback.status, "ready");
  assert.equal(readback.operationReady, true);
  assert.equal(readback.operationStatus, "ready");
  assert.equal(readback.visibility?.advertised, false);
  assert.equal(readback.exactBlocker, null);
});

test("target-scoped Chrome Plugin readback admits a selected-tab blocker without foreground readiness", () => {
  process.env.AOS_CHROME_PLUGIN_READBACK_PATH = readbackPath;
  const bridgeInstanceId = "bridge-target-scoped";
  writeReadback({
    schema: "aos.chrome_plugin_bridge_readback.v2",
    status: "blocked",
    bridge_instance_id: bridgeInstanceId,
    bridge_url: "http://127.0.0.1:58737",
    browser_execution_authority: "target_scoped_business",
    browser_execution_disabled: false,
    browser: { id: "chrome-target-scoped", name: "Chrome", type: "extension", metadata: { profileOrdering: "2" } },
    bridge_owner: {
      ...ownerFor(bridgeInstanceId),
      status: "bridge_only",
      foreground_executor_ready: false,
      exact_blocker: "chrome_selected_tab_readback_invalid",
    },
    operation_ready: false,
    operation_status: "blocked",
    operation_exact_blocker: "chrome_selected_tab_readback_invalid",
    selected_tab: null,
    exact_blocker: "chrome_selected_tab_readback_invalid",
    last_seen_at: new Date().toISOString(),
  });
  const foreground = readChromePluginReadback(Date.now());
  assert.equal(foreground.status, "blocked");
  assert.equal(foreground.operationReady, false);
  assert.equal(foreground.readbackScope, "foreground");

  const targetScoped = readChromePluginReadback(Date.now(), { targetScopedReadback: true });
  assert.equal(targetScoped.status, "ready");
  assert.equal(targetScoped.exactBlocker, null);
  assert.equal(targetScoped.operationReady, true);
  assert.equal(targetScoped.readbackScope, "target_scoped");
  assert.equal(targetScoped.selectedTab, null);
  assert.equal(targetScoped.operationExactBlocker, "chrome_selected_tab_readback_invalid");
  assert.equal(targetScoped.bridgeOwner?.status, "bridge_only");
});

test("target-scoped Chrome Plugin readback isolates missing foreground capability", () => {
  process.env.AOS_CHROME_PLUGIN_READBACK_PATH = readbackPath;
  const bridgeInstanceId = "bridge-target-scoped-capability";
  const blocker = "chrome_foreground_activation_capability_unavailable";
  writeReadback({
    schema: "aos.chrome_plugin_bridge_readback.v2",
    status: "blocked",
    bridge_instance_id: bridgeInstanceId,
    bridge_url: "http://127.0.0.1:58737",
    browser_execution_authority: "read_only_admission",
    browser_execution_disabled: false,
    browser: { id: "chrome-target-scoped-capability", name: "Chrome", type: "extension", metadata: { profileOrdering: "2" } },
    bridge_owner: {
      ...ownerFor(bridgeInstanceId),
      status: "bridge_only",
      foreground_executor_ready: false,
      exact_blocker: blocker,
    },
    operation_ready: false,
    operation_status: "blocked",
    operation_exact_blocker: blocker,
    selected_tab: null,
    exact_blocker: blocker,
    last_seen_at: new Date().toISOString(),
  });
  const foreground = readChromePluginReadback(Date.now());
  assert.equal(foreground.status, "blocked");
  assert.equal(foreground.operationReady, false);
  assert.equal(foreground.failurePlane, "foreground");

  const targetScoped = readChromePluginReadback(Date.now(), { targetScopedReadback: true });
  assert.equal(targetScoped.status, "ready");
  assert.equal(targetScoped.exactBlocker, null);
  assert.equal(targetScoped.operationReady, true);
  assert.equal(targetScoped.readbackScope, "target_scoped");
  assert.equal(targetScoped.selectedTab, null);
  assert.equal(targetScoped.operationExactBlocker, blocker);
  assert.equal(targetScoped.bridgeOwner?.status, "bridge_only");
});

test("target-scoped Chrome Plugin readback accepts the official target_scoped_ready operation state", () => {
  process.env.AOS_CHROME_PLUGIN_READBACK_PATH = readbackPath;
  const bridgeInstanceId = "bridge-target-scoped-ready";
  const now = new Date().toISOString();
  writeReadback({
    schema: "aos.chrome_plugin_bridge_readback.v2",
    status: "ready",
    bridge_instance_id: bridgeInstanceId,
    bridge_url: "http://127.0.0.1:58737",
    browser_execution_authority: "target_scoped_business",
    browser_execution_disabled: false,
    browser: {
      id: "chrome-target-scoped-ready",
      name: "Chrome",
      type: "extension",
      metadata: { profileOrdering: "2", profileIsLastUsed: "true" },
    },
    bridge_owner: {
      ...ownerFor(bridgeInstanceId, now),
      status: "bridge_only",
      foreground_executor_ready: false,
      exact_blocker: null,
    },
    operation_ready: true,
    operation_status: "target_scoped_ready",
    operation_exact_blocker: null,
    selected_tab: null,
    exact_blocker: null,
    last_seen_at: now,
  });
  const readback = readChromePluginReadback(Date.now(), { targetScopedReadback: true });
  assert.equal(readback.status, "ready");
  assert.equal(readback.exactBlocker, null);
  assert.equal(readback.operationReady, true);
  assert.equal(readback.operationStatus, "target_scoped_ready");
  assert.equal(readback.readbackScope, "target_scoped");
  assert.equal(readback.selectedTab, null);
});

test("trusted Chrome bridge readback refuses bridge-only liveness without a foreground owner", () => {
  process.env.AOS_CHROME_PLUGIN_READBACK_PATH = readbackPath;
  writeReadback({
    schema: "aos.chrome_plugin_bridge_readback.v2",
    status: "ready",
    bridge_instance_id: "bridge-only",
    bridge_owner: {
      schema: "aos.chrome_plugin_bridge_owner.v1",
      owner_id: "owner-bridge-only",
      pid: 1234,
      bridge_instance_id: "bridge-only",
      session_id: "session-bridge-only",
      thread_id: "thread-bridge-only",
      turn_id: "turn-bridge-only",
      status: "bridge_only",
      foreground_executor_ready: false,
      exact_blocker: "chrome_plugin_foreground_executor_not_admitted",
      updated_at: new Date().toISOString(),
    },
    browser_execution_disabled: false,
    browser: { id: "chrome-backend-only", type: "extension", metadata: { profileOrdering: "2" } },
    last_seen_at: new Date().toISOString(),
  });
  const readback = readChromePluginReadback(Date.now());
  assert.equal(readback.status, "blocked");
  assert.equal(readback.exactBlocker, "chrome_plugin_foreground_executor_not_admitted");
  assert.equal(readback.bridgeOwner?.foregroundExecutorReady, false);
});

test("trusted Chrome bridge accepts a metadata-only foreground owner without a process PID", () => {
  process.env.AOS_CHROME_PLUGIN_READBACK_PATH = readbackPath;
  const bridgeInstanceId = "bridge-no-pid";
  writeReadback({
    schema: "aos.chrome_plugin_bridge_readback.v2",
    status: "ready",
    backend: "chrome_extension_trusted_bridge",
    bridge_instance_id: bridgeInstanceId,
    bridge_url: "http://127.0.0.1:58737",
    browser_execution_authority: "general",
    browser_execution_disabled: false,
    bridge_owner: {
      ...ownerFor(bridgeInstanceId),
      pid: null,
    },
    browser: { id: "chrome-backend-no-pid", type: "extension", metadata: { profileOrdering: "2" } },
    operation_ready: true,
    operation_status: "ready",
    operation_exact_blocker: null,
    selected_tab: { id: "selected-no-pid", url: "https://example.test/" },
    visibility: { capability_id: "visibility", advertised: true, state: true },
    last_seen_at: new Date().toISOString(),
  });
  const readback = readChromePluginReadback(Date.now());
  assert.equal(readback.status, "ready");
  assert.equal(readback.bridgeOwner?.pid, null);
});

test("trusted Chrome bridge readback fails closed after its freshness window", () => {
  process.env.AOS_CHROME_PLUGIN_READBACK_PATH = readbackPath;
  writeReadback({
    schema: "aos.chrome_plugin_bridge_readback.v2",
    status: "ready",
    bridge_instance_id: "bridge-stale",
    browser_execution_disabled: false,
    browser: { id: "chrome-backend-stale", type: "extension", metadata: { profileOrdering: "2" } },
    last_seen_at: "2026-08-14T00:00:00.000Z",
  });
  const readback = readChromePluginReadback(Date.parse("2026-08-14T00:01:00.000Z"));
  assert.equal(readback.status, "stale");
  assert.equal(readback.exactBlocker, "chrome_extension_bridge_readback_stale");
  assert.equal(readback.operationReady, false);
  assert.equal(readback.operationStatus, "blocked");
  assert.equal(readback.failurePlane, "transport");
  assert.equal(readback.blockingScope, "chrome_plugin_lane");
  assert.equal(readback.independentLanesAllowed, true);
});

test("async MVP readback refreshes an existing loopback trusted bridge before reading freshness", async () => {
  process.env.AOS_CHROME_PLUGIN_READBACK_PATH = readbackPath;
  const server = createServer((_request, response) => {
    const bridgePort = (server.address() as { port: number }).port;
    const freshReadback = {
      schema: "aos.chrome_plugin_bridge_readback.v2",
      status: "ready",
      backend: "chrome_extension_trusted_bridge",
      bridge_instance_id: "bridge-refresh",
      bridge_url: `http://127.0.0.1:${bridgePort}`,
      bridge_owner: ownerFor("bridge-refresh"),
      browser_execution_authority: "general",
      browser_execution_disabled: false,
      browser: { id: "chrome-refresh", name: "Chrome", type: "extension", metadata: { profileOrdering: "2" } },
      operation_ready: true,
      operation_status: "ready",
      operation_exact_blocker: null,
      selected_tab: { id: "selected-refresh", url: "https://example.test/" },
      visibility: { capability_id: "visibility", advertised: true, state: true },
      last_seen_at: new Date().toISOString(),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      backend: "chrome_extension_trusted_bridge",
      url: `http://127.0.0.1:${bridgePort}`,
      bridge_instance_id: "bridge-refresh",
      browser_readback: freshReadback,
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  writeReadback({
    schema: "aos.chrome_plugin_bridge_readback.v2",
    status: "ready",
    backend: "chrome_extension_trusted_bridge",
    bridge_instance_id: "bridge-refresh",
    bridge_url: `http://127.0.0.1:${address.port}`,
    browser_execution_authority: "general",
    browser_execution_disabled: false,
    browser: { id: "chrome-refresh", name: "Chrome", type: "extension", metadata: { profileOrdering: "2" } },
    last_seen_at: "2026-08-14T00:00:00.000Z",
  });
  try {
    const readback = await refreshChromePluginReadback({ timeoutMs: 1000 });
    assert.equal(readback.status, "ready");
    assert.equal(readback.exactBlocker, null);
    assert.equal(readback.bridgeInstanceId, "bridge-refresh");
    assert.ok(readback.capturedAt);
    assert.notEqual(readback.capturedAt, "2026-08-14T00:00:00.000Z");
    assert.equal(readback.path, readbackPath);
    assert.equal(readChromePluginReadback(Date.parse("2026-08-14T00:01:00.000Z")).status, "stale");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("async MVP readback uses the dedicated Profile 2 port when bridge URL is omitted", async () => {
  process.env.AOS_CHROME_PLUGIN_READBACK_PATH = readbackPath;
  const server = createServer((_request, response) => {
    const bridgePort = (server.address() as { port: number }).port;
    const freshReadback = {
      schema: "aos.chrome_plugin_bridge_readback.v2",
      status: "ready",
      backend: "chrome_extension_trusted_bridge",
      bridge_instance_id: "bridge-default-port",
      bridge_url: `http://127.0.0.1:${bridgePort}`,
      bridge_owner: ownerFor("bridge-default-port"),
      browser_execution_authority: "read_only_admission",
      browser_execution_disabled: false,
      browser: { id: "chrome-default-port", name: "Chrome", type: "extension", metadata: { profileOrdering: "2" } },
      operation_ready: true,
      operation_status: "read_only_ready",
      operation_exact_blocker: null,
      selected_tab: { id: "selected-default-port", url: "https://example.test/" },
      last_seen_at: new Date().toISOString(),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      url: `http://127.0.0.1:${bridgePort}`,
      bridge_instance_id: "bridge-default-port",
      browser_readback: freshReadback,
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  process.env.AOS_CHROME_PLUGIN_BRIDGE_PORT = String(address.port);
  writeReadback({
    schema: "aos.chrome_plugin_bridge_readback.v2",
    status: "ready",
    backend: "chrome_extension_trusted_bridge",
    bridge_instance_id: "bridge-default-port",
    browser_execution_authority: "read_only_admission",
    browser_execution_disabled: false,
    browser: { id: "chrome-default-port", name: "Chrome", type: "extension", metadata: { profileOrdering: "2" } },
    last_seen_at: "2026-08-14T00:00:00.000Z",
  });
  try {
    const readback = await refreshChromePluginReadback({ timeoutMs: 1000 });
    assert.equal(readback.status, "ready");
    assert.equal(readback.exactBlocker, null);
    assert.equal(readback.bridgeInstanceId, "bridge-default-port");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("async MVP readback preserves the bridge active-call freshness blocker", async () => {
  process.env.AOS_CHROME_PLUGIN_READBACK_PATH = readbackPath;
  const server = createServer((_request, response) => {
    const bridgePort = (server.address() as { port: number }).port;
    const staleReadback = {
      schema: "aos.chrome_plugin_bridge_readback.v2",
      status: "ready",
      bridge_instance_id: "bridge-inactive-call",
      bridge_url: `http://127.0.0.1:${bridgePort}`,
      bridge_owner: ownerFor("bridge-inactive-call", "2026-08-14T00:00:00.000Z"),
      browser_execution_authority: "general",
      browser_execution_disabled: false,
      browser: { id: "chrome-inactive-call", type: "extension", metadata: { profileOrdering: "2" } },
      last_seen_at: "2026-08-14T00:00:00.000Z",
      refresh_status: "blocked",
      refresh_exact_blocker: "chrome_extension_bridge_refresh_requires_active_call",
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      url: `http://127.0.0.1:${bridgePort}`,
      bridge_instance_id: "bridge-inactive-call",
      browser_readback: staleReadback,
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  writeReadback({
    schema: "aos.chrome_plugin_bridge_readback.v2",
    status: "ready",
    bridge_instance_id: "bridge-inactive-call",
    bridge_url: `http://127.0.0.1:${address.port}`,
    browser_execution_authority: "general",
    browser_execution_disabled: false,
    browser: { id: "chrome-inactive-call", type: "extension", metadata: { profileOrdering: "2" } },
    last_seen_at: "2026-08-14T00:00:00.000Z",
  });
  try {
    const readback = await refreshChromePluginReadback({ timeoutMs: 1000 });
    assert.equal(readback.status, "stale");
    assert.equal(readback.exactBlocker, "chrome_extension_bridge_refresh_requires_active_call");
    assert.equal(readback.refreshStatus, "blocked");
    assert.equal(readback.refreshExactBlocker, "chrome_extension_bridge_refresh_requires_active_call");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("async MVP readback fails closed immediately when the fresh bridge file outlives its process", async () => {
  process.env.AOS_CHROME_PLUGIN_READBACK_PATH = readbackPath;
  writeReadback({
    schema: "aos.chrome_plugin_bridge_readback.v2",
    status: "ready",
    backend: "chrome_extension_trusted_bridge",
    bridge_instance_id: "bridge-gone",
    bridge_url: "http://127.0.0.1:1",
    browser_execution_authority: "general",
    browser_execution_disabled: false,
    browser: { id: "chrome-gone", name: "Chrome", type: "extension", metadata: { profileOrdering: "2" } },
    last_seen_at: new Date().toISOString(),
  });
  const readback = await refreshChromePluginReadback({ timeoutMs: 100 });
  assert.equal(readback.status, "stale");
  assert.equal(readback.exactBlocker, "chrome_extension_bridge_unreachable");
  assert.equal(readback.refreshStatus, "blocked");
  assert.equal(readback.refreshExactBlocker, "chrome_extension_bridge_unreachable");
  assert.equal(readback.operationReady, false);
  assert.equal(readback.operationStatus, "blocked");
  assert.equal(readback.blockingScope, "chrome_plugin_lane");
  assert.equal(readback.independentLanesAllowed, true);
});

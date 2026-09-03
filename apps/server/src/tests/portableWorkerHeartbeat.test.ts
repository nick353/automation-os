import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPortableWorkerHeartbeat,
  portableWorkerHeartbeatId,
  resolvePortableWorkerHeartbeatAt,
  validatePortableWorkerHeartbeat
} from "../runs/portableWorkerHeartbeat.js";

test("portable worker heartbeat validates bounded identity and no-effect fields", () => {
  const result = validatePortableWorkerHeartbeat({ worker_id: "mac-test.local", status: "running", queue_depth: 7 });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, { workerId: "mac-test.local", status: "running", queueDepth: 7, exactBlocker: null, chromePluginReadback: null });
  }
  assert.match(portableWorkerHeartbeatId("company_test", "mac-test.local"), /^portable_mac_worker_heartbeat_[a-f0-9]{40}$/u);
});

test("portable worker heartbeat accepts only the bounded Profile 2 readback projection", () => {
  const result = validatePortableWorkerHeartbeat({
    worker_id: "mac-test.local",
    status: "running",
    queue_depth: null,
    chrome_plugin_readback: {
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
    }
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.chromePluginReadback?.target_scoped_ready, true);
    assert.equal(result.value.chromePluginReadback?.browser?.profile_ordering, "2");
  }
  assert.deepEqual(validatePortableWorkerHeartbeat({
    worker_id: "mac-test.local",
    status: "running",
    chrome_plugin_readback: { schema: "wrong" }
  }), { ok: false, exactBlocker: "portable_worker_heartbeat_chrome_readback_invalid" });
});

test("portable worker heartbeat rejects malformed or effect-like inputs", () => {
  assert.deepEqual(validatePortableWorkerHeartbeat({ worker_id: "", status: "running" }), { ok: false, exactBlocker: "portable_worker_heartbeat_worker_id_invalid" });
  assert.deepEqual(validatePortableWorkerHeartbeat({ worker_id: "mac-test", status: "submit" }), { ok: false, exactBlocker: "portable_worker_heartbeat_status_invalid" });
  assert.deepEqual(validatePortableWorkerHeartbeat({ worker_id: "mac-test", status: "idle", queue_depth: -1 }), { ok: false, exactBlocker: "portable_worker_heartbeat_queue_depth_invalid" });
});

test("portable worker heartbeat readback distinguishes fresh, stale, and future timestamps", () => {
  const nowMs = Date.parse("2026-08-11T10:00:00.000Z");
  assert.deepEqual(classifyPortableWorkerHeartbeat({
    heartbeatAt: "2026-08-11T09:59:00.000Z",
    nowMs,
    staleAfterSeconds: 300
  }), {
    heartbeatAt: "2026-08-11T09:59:00.000Z",
    heartbeatAgeSeconds: 60,
    heartbeatFresh: true,
    readbackStatus: "fresh_portable_worker_heartbeat",
    exactBlocker: null
  });
  assert.equal(classifyPortableWorkerHeartbeat({
    heartbeatAt: "2026-08-11T09:50:00.000Z",
    nowMs,
    staleAfterSeconds: 300
  }).exactBlocker, "portable_worker_heartbeat_stale");
  assert.equal(classifyPortableWorkerHeartbeat({
    heartbeatAt: "2026-08-11T10:01:00.000Z",
    nowMs,
    staleAfterSeconds: 300
  }).exactBlocker, "portable_worker_heartbeat_timestamp_future");
});

test("live worker transport heartbeat takes precedence over stale persisted state", () => {
  assert.equal(resolvePortableWorkerHeartbeatAt({
    liveLastSuccessfulHeartbeatAt: "2026-08-12T01:02:32.256Z",
    liveHeartbeatAt: "2026-08-12T01:02:32.256Z",
    persistedHeartbeatAt: "2026-08-09T23:37:13.015Z"
  }), "2026-08-12T01:02:32.256Z");
  assert.equal(resolvePortableWorkerHeartbeatAt({
    liveLastSuccessfulHeartbeatAt: null,
    liveHeartbeatAt: null,
    persistedHeartbeatAt: "2026-08-09T23:37:13.015Z"
  }), "2026-08-09T23:37:13.015Z");
  assert.equal(resolvePortableWorkerHeartbeatAt({
    liveLastSuccessfulHeartbeatAt: "not-a-timestamp",
    liveHeartbeatAt: null,
    persistedHeartbeatAt: null
  }), null);
});

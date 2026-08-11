import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPortableWorkerHeartbeat,
  portableWorkerHeartbeatId,
  validatePortableWorkerHeartbeat
} from "../runs/portableWorkerHeartbeat.js";

test("portable worker heartbeat validates bounded identity and no-effect fields", () => {
  const result = validatePortableWorkerHeartbeat({ worker_id: "mac-test.local", status: "running", queue_depth: 7 });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, { workerId: "mac-test.local", status: "running", queueDepth: 7, exactBlocker: null });
  }
  assert.match(portableWorkerHeartbeatId("company_test", "mac-test.local"), /^portable_mac_worker_heartbeat_[a-f0-9]{40}$/u);
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

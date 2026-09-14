import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyPortableWorkerHeartbeat,
  matchesPortableWorkerHeartbeatBinding,
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
  assert.equal(validatePortableWorkerHeartbeat({
    schema: "aos.portable_worker_heartbeat.v1",
    worker_id: "mac-test.local",
    status: "idle",
    queue_depth: null,
    exact_blocker: "",
    company_id: "",
    worker_instance_id: "",
    generation_id: "",
    observed_at: ""
  }).ok, true);
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

test("portable worker heartbeat preserves a bound generation and safe runtime observation", () => {
  const observedAt = "2026-09-08T01:02:03.000Z";
  const result = validatePortableWorkerHeartbeat({
    schema: "aos.portable_worker_heartbeat.v2",
    company_id: "company_heartbeat_contract",
    worker_id: "mac-heartbeat-contract",
    worker_instance_id: "instance-heartbeat-contract",
    generation: "generation-heartbeat-contract",
    observed_at: observedAt,
    status: "idle",
    queue_depth: 0,
    exact_blocker: null,
    run_id: null,
    runtime_observation: {
      schema: "aos.portable_worker_runtime_observation.v1",
      status: "idle",
      observed_at: observedAt,
      run_id: null,
      browser_use: {
        runtime_status: "unobserved",
        process: { status: "unobserved", pid: null, process_count: null, profile_ref: null, port: null },
        room: null,
        transport: { status: "unobserved", last_seen_at: null }
      }
    },
    transport_ack: {
      schema: "aos.portable_worker_heartbeat_transport_ack.v1",
      status: "acknowledged",
      observed_at: observedAt,
      ack_at: observedAt,
      worker_instance_id: "instance-heartbeat-contract",
      generation: "generation-heartbeat-contract",
      binding_status: "verified"
    }
  }, {
    expectedCompanyId: "company_heartbeat_contract",
    expectedWorkerId: "mac-heartbeat-contract",
    expectedWorkerInstanceId: "instance-heartbeat-contract",
    expectedGeneration: "generation-heartbeat-contract"
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.companyId, "company_heartbeat_contract");
    assert.equal(result.value.workerInstanceId, "instance-heartbeat-contract");
    assert.equal(result.value.generation, "generation-heartbeat-contract");
    assert.equal(result.value.observedAt, observedAt);
    assert.equal(result.value.runtimeObservation?.status, "idle");
    assert.equal(result.value.runtimeObservation?.runId, null);
    assert.equal(result.value.runtimeObservation?.browserUse?.room, null);
    assert.equal(result.value.transportAck?.bindingStatus, "verified");
  }
});

test("portable worker heartbeat requires company scope for v2 and supports partial binding checks", () => {
  const observedAt = "2026-09-08T01:02:03.000Z";
  assert.deepEqual(validatePortableWorkerHeartbeat({
    schema: "aos.portable_worker_heartbeat.v2",
    worker_id: "mac-heartbeat-contract",
    worker_instance_id: "instance-heartbeat-contract",
    generation: "generation-heartbeat-contract",
    observed_at: observedAt,
    status: "idle",
    queue_depth: null,
    run_id: null
  }), {
    ok: false,
    exactBlocker: "portable_worker_heartbeat_observation_metadata_incomplete"
  });
  assert.equal(validatePortableWorkerHeartbeat({
    worker_id: "mac-heartbeat-contract",
    status: "running",
    queue_depth: 0
  }, { expectedWorkerId: "mac-heartbeat-contract" }).ok, true);
  assert.equal(validatePortableWorkerHeartbeat({
    worker_id: "mac-heartbeat-contract",
    status: "running",
    queue_depth: 0
  }, { expectedWorkerId: "other-worker" }).ok, false);
  assert.equal(matchesPortableWorkerHeartbeatBinding({
    companyId: "company-1",
    workerId: "worker-1",
    workerInstanceId: "instance-1",
    generation: "generation-1"
  }, {
    company_id: "company-1",
    worker_id: "worker-1",
    worker_instance_id: "instance-1",
    generation_id: "generation-1"
  }), true);
});

test("portable worker heartbeat rejects idle run bindings and arbitrary or secret-like fields", () => {
  const base = {
    worker_id: "mac-heartbeat-contract",
    worker_instance_id: "instance-heartbeat-contract",
    generation: "generation-heartbeat-contract",
    observed_at: "2026-09-08T01:02:03.000Z",
    status: "idle",
    queue_depth: 0,
    run_id: null
  } as const;
  assert.deepEqual(validatePortableWorkerHeartbeat({ ...base, run_id: "run-must-be-null-while-idle" }), {
    ok: false,
    exactBlocker: "portable_worker_heartbeat_idle_run_binding_invalid"
  });
  assert.deepEqual(validatePortableWorkerHeartbeat({ ...base, path: "/Users/private" }), {
    ok: false,
    exactBlocker: "portable_worker_heartbeat_field_invalid"
  });
  assert.deepEqual(validatePortableWorkerHeartbeat({
    ...base,
    runtime_observation: {
      schema: "aos.portable_worker_runtime_observation.v1",
      status: "idle",
      observed_at: base.observed_at,
      run_id: null,
      browser_use: {
        runtime_status: "absent",
        process: { status: "absent", pid: null, process_count: 0, profile_ref: null, port: null, url: "https://private" },
        room: null
      }
    }
  }), {
    ok: false,
    exactBlocker: "portable_worker_heartbeat_runtime_observation_invalid"
  });
  assert.deepEqual(validatePortableWorkerHeartbeat({
    ...base,
    transport_ack: {
      schema: "aos.portable_worker_heartbeat_transport_ack.v1",
      status: "acknowledged",
      observed_at: base.observed_at,
      ack_at: base.observed_at,
      worker_instance_id: base.worker_instance_id,
      generation: base.generation,
      binding_status: "verified",
      secret: "must-not-cross"
    }
  }), {
    ok: false,
    exactBlocker: "portable_worker_heartbeat_transport_ack_invalid"
  });
});

test("portable worker heartbeat binding is a pure company, worker, instance, and generation match", () => {
  const expected = {
    companyId: "company-1",
    workerId: "worker-1",
    workerInstanceId: "instance-1",
    generation: "generation-1"
  };
  assert.equal(matchesPortableWorkerHeartbeatBinding(expected, {
    company_id: "company-1",
    worker_id: "worker-1",
    worker_instance_id: "instance-1",
    generation: "generation-1"
  }), true);
  assert.equal(matchesPortableWorkerHeartbeatBinding(expected, {
    company_id: "company-1",
    worker_id: "worker-1",
    worker_instance_id: "instance-2",
    generation: "generation-1"
  }), false);
  assert.equal(matchesPortableWorkerHeartbeatBinding(expected, {
    companyId: "company-1",
    workerId: "worker-1",
    workerInstanceId: "instance-1",
    generation: "generation-2"
  }), false);
});

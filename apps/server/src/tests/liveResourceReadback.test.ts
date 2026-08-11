import assert from "node:assert/strict";
import test from "node:test";

import { buildBrowserRuntimeProcessReadback } from "../browser/liveResourceReadback.js";

test("same-host Browser Use process readback maps profile/port and keeps unregistered resources fail-closed", () => {
  const readback = buildBrowserRuntimeProcessReadback({
    capturedAt: "2026-08-11T18:00:00.000Z",
    psOutput: [
      "4101 1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=19882 --user-data-dir=/Users/operator/.browser-use-cli/profiles/scheduled/daily-ai",
      "4102 1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=20092 --user-data-dir=/Users/operator/.browser-use-cli/profiles/temporary/foreign-readback",
      "4103 1 /usr/local/bin/node /Users/operator/Documents/automation-os/scripts/aos-portable-remote-worker.mjs",
    ].join("\n"),
    envOutputByPid: {
      "4103": "AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS=read_only AUTOMATION_OS_PORTABLE_WORKER_MODE=external AUTOMATION_OS_WORKER_DURABLE_ONLY=1 AUTOMATION_OS_PORTABLE_REMOTE_URL=https://worker.example/path?token=sentinel AUTOMATION_OS_PORTABLE_REMOTE_COMPANY_ID=company_test AUTOMATION_OS_PORTABLE_REMOTE_WORKER_ID=mac-test",
    },
    workerStatusOutput: JSON.stringify({
      schema: "aos.portable_remote_worker_status.v1",
      worker_id: "mac-test",
      pid: 4103,
      remote_origin: "https://automation-os.example",
      effects: "read_only",
      status: "idle",
      heartbeat_status: "ok",
      heartbeat_exact_blocker: null,
      heartbeat_at: "2026-08-11T17:59:55.000Z",
      last_successful_heartbeat_at: "2026-08-11T17:59:55.000Z",
      last_attempt_at: "2026-08-11T17:59:55.000Z",
      claim_status: "idle",
      generation_started_at: "2026-08-11T17:58:00.000Z",
      updated_at: "2026-08-11T17:59:55.000Z"
    }),
    controlPlaneCompanyIds: ["company_test"]
  });

  assert.equal(readback.status, "available");
  assert.equal(readback.source, "same_host_ps");
  assert.equal(readback.capturedAt, "2026-08-11T18:00:00.000Z");
  assert.equal(readback.exactBlocker, "browser_use_unregistered_live_process");
  assert.equal(readback.unregisteredBrowserProcessCount, 1);
  assert.equal(readback.browserProcesses[0]?.profileRef, "scheduled/daily-ai");
  assert.equal(readback.browserProcesses[0]?.port, 19882);
  assert.equal(readback.browserProcesses[0]?.bindingStatus, "registered");
  assert.equal(readback.browserProcesses[1]?.profileRef, "temporary/foreign-readback");
  assert.equal(readback.browserProcesses[1]?.port, 20092);
  assert.equal(readback.browserProcesses[1]?.bindingStatus, "unregistered");
  assert.equal(readback.portableRemoteWorker.status, "present");
  assert.equal(readback.portableRemoteWorker.effects, "read_only");
  assert.equal(readback.portableRemoteWorker.mode, "external");
  assert.equal(readback.portableRemoteWorker.durableOnly, true);
  assert.equal(readback.portableRemoteWorker.transportReadback.status, "available");
  assert.equal(readback.portableRemoteWorker.transportReadback.heartbeatStatus, "ok");
  assert.equal(readback.portableRemoteWorker.transportReadback.claimStatus, "idle");
  assert.equal(readback.portableRemoteWorker.transportReadback.lastSuccessfulHeartbeatAt, "2026-08-11T17:59:55.000Z");
  assert.equal(readback.portableRemoteWorker.scopeReadback.status, "matched");
  assert.equal(readback.portableRemoteWorker.scopeReadback.alignmentDecisionRequired, false);
  assert.deepEqual(readback.portableRemoteWorker.scopeReadback.alignmentCandidates.map((candidate) => candidate.scope), ["control_plane_queue", "portable_remote_worker"]);
  assert.deepEqual(readback.portableRemoteWorker.scopeReadback.alignmentCandidates.map((candidate) => candidate.status), ["observed", "observed"]);
  assert.deepEqual(readback.portableRemoteWorker.scopeReadback.controlPlaneCompanyIds, ["company_test"]);
  assert.deepEqual(readback.portableRemoteWorker.scopeReadback.remoteWorkerCompanyIds, ["company_test"]);
  assert.equal(readback.portableRemoteWorker.processes[0]?.remoteOrigin, "https://worker.example");
  assert.doesNotMatch(JSON.stringify(readback), /token=sentinel|operator|user-data-dir|Contents\/MacOS/u);
});

test("remote worker scope mismatch is exposed as a queue blocker without exposing credentials", () => {
  const readback = buildBrowserRuntimeProcessReadback({
    capturedAt: "2026-08-11T18:03:00.000Z",
    psOutput: "4301 1 /usr/local/bin/node /Users/operator/Documents/automation-os/scripts/aos-portable-remote-worker.mjs",
    envOutputByPid: {
      "4301": "AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS=read_only AUTOMATION_OS_PORTABLE_WORKER_MODE=external AUTOMATION_OS_WORKER_DURABLE_ONLY=1 AUTOMATION_OS_PORTABLE_REMOTE_URL=https://automation-os.zeabur.app/api?token=sentinel AUTOMATION_OS_PORTABLE_REMOTE_COMPANY_ID=company_remote AUTOMATION_OS_PORTABLE_REMOTE_WORKER_ID=mac-test"
    },
    workerStatusOutput: JSON.stringify({
      schema: "aos.portable_remote_worker_status.v1",
      worker_id: "mac-test",
      pid: 4301,
      remote_origin: "https://automation-os.zeabur.app",
      effects: "read_only",
      heartbeat_status: "ok",
      heartbeat_at: "2026-08-11T18:02:59.000Z",
      last_successful_heartbeat_at: "2026-08-11T18:02:59.000Z",
      claim_status: "idle",
      updated_at: "2026-08-11T18:02:59.000Z"
    }),
    controlPlaneCompanyIds: ["company_local"]
  });

  assert.equal(readback.portableRemoteWorker.scopeReadback.status, "mismatch");
  assert.equal(readback.portableRemoteWorker.scopeReadback.alignmentDecisionRequired, true);
  assert.equal(readback.portableRemoteWorker.scopeReadback.exactBlocker, "portable_worker_company_scope_mismatch");
  assert.deepEqual(readback.portableRemoteWorker.scopeReadback.alignmentCandidates, [
    { scope: "control_plane_queue", status: "observed", companyIds: ["company_local"], origins: [], workerIds: [] },
    { scope: "portable_remote_worker", status: "observed", companyIds: ["company_remote"], origins: ["https://automation-os.zeabur.app"], workerIds: ["mac-test"] }
  ]);
  assert.equal(readback.portableRemoteWorker.processes[0]?.remoteCompanyId, "company_remote");
  assert.equal(readback.portableRemoteWorker.processes[0]?.remoteOrigin, "https://automation-os.zeabur.app");
  assert.doesNotMatch(JSON.stringify(readback), /token=sentinel|operator|user-data-dir/u);
});

test("empty same-host process readback distinguishes no process from unavailable readback", () => {
  const empty = buildBrowserRuntimeProcessReadback({ psOutput: "", capturedAt: "2026-08-11T18:01:00.000Z" });
  assert.equal(empty.status, "available");
  assert.equal(empty.browserProcesses.length, 0);
  assert.equal(empty.portableRemoteWorker.status, "absent");
  assert.equal(empty.exactBlocker, null);

  const unavailable = buildBrowserRuntimeProcessReadback({ psOutput: null, capturedAt: "2026-08-11T18:02:00.000Z" });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.exactBlocker, "browser_use_same_host_process_readback_unavailable");
  assert.equal(unavailable.externalActionExecuted, false);
});

test("server projections can disable host process enumeration for hermetic tests", () => {
  const readback = buildBrowserRuntimeProcessReadback({
    readLiveProcessTable: false,
    capturedAt: "2026-08-11T18:04:00.000Z"
  });

  assert.equal(readback.status, "available");
  assert.equal(readback.source, "same_host_ps");
  assert.deepEqual(readback.browserProcesses, []);
  assert.equal(readback.portableRemoteWorker.status, "absent");
  assert.equal(readback.exactBlocker, null);
});

test("profile or port drift is reported as binding mismatch instead of being claimed as a registered lane", () => {
  const readback = buildBrowserRuntimeProcessReadback({
    psOutput: "4201 1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-port=19882 --user-data-dir=/Users/operator/.browser-use-cli/profiles/scheduled/other-profile",
  });

  assert.equal(readback.exactBlocker, "browser_use_live_process_binding_mismatch");
  assert.equal(readback.bindingMismatchCount, 1);
  assert.equal(readback.browserProcesses[0]?.bindingStatus, "binding_mismatch");
  assert.equal(readback.registeredLanes.find((lane) => lane.reservedPort === 19882)?.processStatus, "binding_mismatch");
});

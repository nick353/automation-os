import assert from "node:assert/strict";
import test from "node:test";
import { buildBrowserOperationalReadback, buildBrowserUseRuntimeSnapshot, buildBrowserUseRuntimeSnapshotAsync } from "../browser/runtimeSnapshot.js";
import { buildBrowserRuntimeProcessReadback, buildBrowserRuntimeProcessReadbackAsync } from "../browser/liveResourceReadback.js";

const originalRole = process.env.AUTOMATION_OS_RUNTIME_ROLE;
const originalVerified = process.env.AUTOMATION_OS_BROWSER_USE_RUNTIME_VERIFIED;

function restoreEnvironment() {
  if (originalRole === undefined) delete process.env.AUTOMATION_OS_RUNTIME_ROLE;
  else process.env.AUTOMATION_OS_RUNTIME_ROLE = originalRole;
  if (originalVerified === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_RUNTIME_VERIFIED;
  else process.env.AUTOMATION_OS_BROWSER_USE_RUNTIME_VERIFIED = originalVerified;
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

import assert from "node:assert/strict";
import test from "node:test";
import { buildBrowserUseRuntimeSnapshot } from "../browser/runtimeSnapshot.js";

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

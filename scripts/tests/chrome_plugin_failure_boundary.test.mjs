import assert from "node:assert/strict";
import test from "node:test";

import { classifyChromePluginFailure, chromePluginRecoveryReentryPlan } from "../chrome-plugin-failure-boundary.mjs";

test("host runtime failures terminalize before Chrome transport recovery", () => {
  const result = classifyChromePluginFailure(new Error("ReferenceError: agent is not defined"));
  assert.equal(result.exact_blocker, "chrome_plugin_runtime_host_environment_missing");
  assert.equal(result.failure_plane, "runtime_host");
  assert.equal(result.retry_allowed, false);
  assert.equal(result.recovery_boundary, "official_trusted_runtime");
});

test("bridge refusal is distinct from a browser tab transport failure", () => {
  const result = classifyChromePluginFailure(new Error("connect ECONNREFUSED 127.0.0.1:58744"));
  assert.equal(result.exact_blocker, "chrome_plugin_bridge_endpoint_not_listening");
  assert.equal(result.failure_plane, "bridge_lifecycle");
  assert.equal(result.retry_allowed, false);
});

test("browser transport failure keeps a fresh-client recovery boundary", () => {
  const result = classifyChromePluginFailure(new Error("Browser is not available: stale-binding"));
  assert.equal(result.exact_blocker, "chrome_plugin_transport_unavailable");
  assert.equal(result.failure_plane, "transport");
  assert.equal(result.recovery_boundary, "fresh_browser_client");
  assert.equal(result.recovery_reentry, "fresh_profile2_admission_then_resume_pending_target");
});

test("a recovered bridge re-enters a retained pending target once without replaying effects", () => {
  const result = chromePluginRecoveryReentryPlan({
    previousFailure: { exact_blocker: "chrome_plugin_bridge_endpoint_not_listening" },
    currentReadback: { status: "ready", operationReady: true, exactBlocker: null },
  });
  assert.deepEqual(result, {
    state: "reentry_ready",
    action: "fresh_profile2_admission_then_resume_pending_target",
    replay_external_effect: false,
    previous_blocker: "chrome_plugin_bridge_endpoint_not_listening",
    exact_blocker: null,
  });
});

test("reentry stays pending when the fresh readback is still blocked", () => {
  const result = chromePluginRecoveryReentryPlan({
    previousFailure: "chrome_plugin_transport_unavailable",
    currentReadback: { status: "blocked", operationReady: false, exactBlocker: "chrome_extension_bridge_unreachable" },
  });
  assert.equal(result.state, "recovery_pending");
  assert.equal(result.exact_blocker, "chrome_extension_bridge_unreachable");
  assert.equal(result.replay_external_effect, false);
});

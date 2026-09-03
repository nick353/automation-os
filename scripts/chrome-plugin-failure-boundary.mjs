/**
 * Failure-plane normalization shared by AOS Chrome Plugin callers.
 *
 * This module classifies the boundary that failed; it never retries, starts a
 * bridge, or changes Chrome state. Host/runtime and bridge endpoint failures
 * must not be mistaken for a page timeout or repaired by reacquiring tabs.
 */

function rawMessage(error) {
  const seen = new Set();
  const messages = [];
  let current = error;
  while (current && !seen.has(current) && messages.length < 6) {
    seen.add(current);
    const message = String(current?.message || current || "").trim();
    if (message) messages.push(message);
    current = current?.cause || null;
  }
  return messages.join(" | ").replace(/\s+/gu, " ").slice(0, 400);
}

export function chromePluginRecoveryReentryPlan({
  previousFailure = null,
  currentReadback = null,
  reentryAttempted = false,
} = {}) {
  const previousBlocker = String(previousFailure?.exact_blocker || previousFailure || "").trim();
  const currentReady = currentReadback?.status === "ready"
    && currentReadback?.operationReady === true
    && !currentReadback?.exactBlocker;
  if (currentReady && !reentryAttempted) {
    return Object.freeze({
      state: "reentry_ready",
      action: "fresh_profile2_admission_then_resume_pending_target",
      replay_external_effect: false,
      previous_blocker: previousBlocker || null,
      exact_blocker: null,
    });
  }
  if (currentReady && reentryAttempted) {
    return Object.freeze({
      state: "recovery_pending",
      action: "retain_candidate_and_require_new_state_change",
      replay_external_effect: false,
      previous_blocker: previousBlocker || null,
      exact_blocker: "chrome_plugin_reentry_already_consumed",
    });
  }
  return Object.freeze({
    state: "recovery_pending",
    action: "retain_candidate_and_wait_for_fresh_official_readback",
    replay_external_effect: false,
    previous_blocker: previousBlocker || null,
    exact_blocker: String(currentReadback?.exactBlocker || "chrome_plugin_fresh_readback_required"),
  });
}

export function classifyChromePluginFailure(error) {
  const rawError = rawMessage(error);
  const lower = rawError.toLowerCase();
  if (/(?:agent|process) is not defined|browser_client_not_trusted_or_missing|runtime_host_environment_missing/u.test(lower)) {
    return Object.freeze({
      exact_blocker: "chrome_plugin_runtime_host_environment_missing",
      failure_plane: "runtime_host",
      raw_error: rawError,
      recovery_boundary: "official_trusted_runtime",
      retry_allowed: false,
      recovery_reentry: "fresh_official_runtime_then_resume_pending_target",
      replay_external_effect: false,
    });
  }
  if (/(?:econnrefused|connection refused|bridge endpoint.*not listening|bridge.*endpoint.*unavailable)/u.test(lower)) {
    return Object.freeze({
      exact_blocker: "chrome_plugin_bridge_endpoint_not_listening",
      failure_plane: "bridge_lifecycle",
      raw_error: rawError,
      recovery_boundary: "official_bridge_state_change",
      retry_allowed: false,
      recovery_reentry: "fresh_bridge_readback_then_resume_pending_target",
      replay_external_effect: false,
    });
  }
  if (/chrome_plugin_bridge_client_timeout|bridge client timeout/u.test(lower)) {
    return Object.freeze({
      exact_blocker: "chrome_plugin_bridge_client_timeout",
      failure_plane: "bridge_lifecycle",
      raw_error: rawError,
      recovery_boundary: "fresh_bridge_readback",
      retry_allowed: false,
      recovery_reentry: "fresh_bridge_readback_then_resume_pending_target",
      replay_external_effect: false,
    });
  }
  if (/browser is not available|native pipe|socket.*closed|transport.*closed/u.test(lower)) {
    return Object.freeze({
      exact_blocker: "chrome_plugin_transport_unavailable",
      failure_plane: "transport",
      raw_error: rawError,
      recovery_boundary: "fresh_browser_client",
      retry_allowed: false,
      recovery_reentry: "fresh_profile2_admission_then_resume_pending_target",
      replay_external_effect: false,
    });
  }
  return Object.freeze({
    exact_blocker: String(error?.exact_blocker || error?.message || error || "chrome_plugin_failure").trim().slice(0, 240),
    failure_plane: "unknown",
    raw_error: rawError,
    recovery_boundary: "caller_specific",
    retry_allowed: false,
    recovery_reentry: "retain_pending_until_fresh_readback",
    replay_external_effect: false,
  });
}

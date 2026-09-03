#!/usr/bin/env node

import { readLiveCompanionStatus } from "./aos-hourly-companion-audit.mjs";

const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};

function countFrom(source, scalarKeys, arrayKeys) {
  for (const key of scalarKeys) {
    if (source?.[key] !== undefined && source?.[key] !== null) return finite(source[key]);
  }
  for (const key of arrayKeys) {
    if (Array.isArray(source?.[key])) return source[key].length;
  }
  return 0;
}

function readback(live) {
  if (live?.available !== true) {
    return {
      schema: "aos.chrome_companion.live_canary.v1",
      result: "blocked",
      read_only: true,
      external_action_executed: false,
      mutation_dispatch_count: 0,
      exact_blocker: String(live?.exactBlocker || "companion_status_unavailable"),
    };
  }

  const status = live.status && typeof live.status === "object" ? live.status : {};
  const profiles = Array.isArray(status.profiles) ? status.profiles : [];
  const connectedProfiles = profiles.filter((profile) => profile?.connected === true || profile?.connected === "true");
  const registrationFailures = Array.isArray(status.profileRegistrationFailures)
    ? status.profileRegistrationFailures.length
    : 0;
  const exactBlocker = connectedProfiles.length !== 1
    ? "companion_profile_selection_not_exactly_one_connected"
    : registrationFailures > 0
      ? "companion_profile_registration_failed"
      : null;

  return {
    schema: "aos.chrome_companion.live_canary.v1",
    result: exactBlocker ? "blocked" : "passed_read_only",
    read_only: true,
    external_action_executed: false,
    mutation_dispatch_count: 0,
    source: String(live.source || "resident_companion_broker"),
    profile_count: profiles.length,
    connected_profile_count: connectedProfiles.length,
    connected_generations: connectedProfiles.map((profile) => String(profile?.generation || "")).filter(Boolean),
    profile_registration_failure_count: registrationFailures,
    active_lease_count: countFrom(status,
      ["exactTabLeaseCount", "exact_tab_lease_count", "activeLeaseCount", "active_lease_count", "leaseCount", "lease_count"],
      ["exactTabLeases"]),
    pending_operation_count: countFrom(status,
      ["pendingCount", "pending_count", "pendingOperationCount", "pending_operation_count"],
      ["pendingOperations"]),
    queue_count: countFrom(status, ["queueCount", "queue_count", "queuedCount", "queued_count"], ["queue"]),
    task_tab_count: countFrom(status, ["activeTaskTabCount", "active_task_tab_count"], ["taskTabs"]),
    connection: live.connection && typeof live.connection === "object"
      ? {
        connected: live.connection.connected === true,
        connection_generation: finite(live.connection.connectionGeneration),
      }
      : null,
    exact_blocker: exactBlocker,
  };
}

try {
  const live = await readLiveCompanionStatus({
    sourceRoot: process.env.AOS_CHROME_COMPANION_SOURCE || undefined,
    env: process.env,
    timeoutMs: 5_000,
  });
  const result = readback(live);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.result === "passed_read_only" ? 0 : 2;
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    schema: "aos.chrome_companion.live_canary.v1",
    result: "blocked",
    read_only: true,
    external_action_executed: false,
    mutation_dispatch_count: 0,
    exact_blocker: String(error?.code || "companion_live_canary_failed"),
  }, null, 2)}\n`);
  process.exitCode = 2;
}

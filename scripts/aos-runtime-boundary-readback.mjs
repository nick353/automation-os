#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runtimeBoundaryNextAction } from "./lib/runtime-boundary-route.mjs";

const repoRoot = resolve(process.env.AUTOMATION_OS_REPO_ROOT || process.cwd());
const expectedServerEffects = "read_only";
const expectedWorkerEffects = "enabled";
const generatedAt = new Date().toISOString();

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function shellDefaultReadback(path) {
  const text = readText(path);
  if (text === null) return { path, exists: false };
  const dynamicRunnerSelection = /unset AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER AUTOMATION_OS_PORTABLE_EXTERNAL_DEFAULT_RUNNER/u.test(text);
  const effects = text.match(/AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS=.*?\$\{AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS:-([^}]+)\}/u)?.[1] ?? null;
  const legacyRunner = /portable-external-runner\.mjs/u.test(text);
  const enabledEffects = /AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS=.*?enabled/u.test(text);
  return {
    path,
    exists: true,
    dynamicRunnerSelection,
    readOnlyDefault: effects === "read_only",
    effectsDefault: effects,
    legacyRunnerReference: legacyRunner,
    enabledEffectsReference: enabledEffects
  };
}

function launchdReadback(path, expectsDynamicSelection = true) {
  const text = readText(path);
  if (text === null) return { path, exists: false };
  const effects = text.match(/<key>AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS<\/key>\s*<string>([^<]+)<\/string>/u)?.[1] ?? null;
  return {
    path,
    exists: true,
    dynamicRunnerSelection: expectsDynamicSelection ? !text.includes("AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER") : null,
    readOnlyDefault: effects === "read_only",
    effectsDefault: effects,
    delegatesToInstalledHelper: expectsDynamicSelection ? null : text.includes("Library/Application Support/Automation OS/start-automation-os-server.sh"),
    legacyRunnerReference: text.includes("portable-external-runner.mjs"),
    enabledEffectsReference: text.includes("<string>enabled</string>")
  };
}

function processIds() {
  try {
    const output = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
    return output
      .split("\n")
      .map((line) => line.trim())
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.+)$/u);
        return match ? { pid: Number(match[1]), command: match[2] } : null;
      })
      .map((entry) => entry ? { ...entry, processKind: runtimeProcessKind(entry.command) } : null)
      .filter((entry) => entry && entry.processKind);
  } catch {
    return [];
  }
}

function runtimeProcessKind(command) {
  if (/aos-portable-remote-worker\.mjs/u.test(command)) return "portable_remote_worker";
  if (/apps\/server\/dist\/index\.js/u.test(command)) return "control_plane_server";
  if (/apps\/server\/dist\/cli\/workerLoop\.js/u.test(command)) return "local_worker_loop";
  return null;
}

function processEnvReadback(pid, command, processKind) {
  try {
    const output = execFileSync("ps", ["eww", "-p", String(pid)], { encoding: "utf8" });
    const read = (key) => output.match(new RegExp(`(?:^|\\s)${key}=([^\\s]*)`, "u"))?.[1] ?? null;
    return {
      pid,
      processKind,
      command,
      runner: read("AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER"),
      effects: read("AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS"),
      workerMode: read("AUTOMATION_OS_PORTABLE_WORKER_MODE"),
      port: read("AUTOMATION_OS_PORT")
    };
  } catch {
    return { pid, processKind, command, readbackError: "process_env_readback_failed" };
  }
}

const installedRoot = resolve(process.env.AUTOMATION_OS_INSTALLED_HELPER_ROOT || `${process.env.HOME || ""}/Library/Application Support/Automation OS`);
const selectorPath = resolve(process.env.AUTOMATION_OS_SELECTOR_PATH || `${process.env.HOME || ""}/.social-flow/web-operation-backend.json`);
const source = {
  server: shellDefaultReadback(resolve(repoRoot, "scripts/start-automation-os-server.sh")),
  worker: shellDefaultReadback(resolve(repoRoot, "scripts/start-automation-os-worker.sh"))
};
const installed = {
  server: shellDefaultReadback(resolve(installedRoot, "start-automation-os-server.sh")),
  worker: shellDefaultReadback(resolve(installedRoot, "start-automation-os-worker.sh"))
};
const launchd = {
  server: launchdReadback(resolve(repoRoot, "ops/launchd/com.nichikatanaka.automation-os.plist"), false),
  worker: launchdReadback(resolve(repoRoot, "ops/launchd/com.nichikatanaka.automation-os-worker.plist"))
};
const live = processIds().map((entry) => processEnvReadback(entry.pid, entry.command, entry.processKind));

const staticEntries = [
  ["server_helper", source.server],
  ["worker_helper", source.worker],
  ["server_launchd", launchd.server],
  ["worker_launchd", launchd.worker],
  ["server_installed_helper", installed.server],
  ["worker_installed_helper", installed.worker]
];
const staticMismatch = staticEntries.some(([role, entry]) => {
  if (!entry.exists || entry.delegatesToInstalledHelper === false || entry.dynamicRunnerSelection === false || entry.legacyRunnerReference) return true;
  if (role === "server_launchd") return entry.enabledEffectsReference === true;
  const expectedEffects = role.startsWith("worker") ? expectedWorkerEffects : expectedServerEffects;
  return entry.effectsDefault !== expectedEffects || (role.startsWith("server") && entry.enabledEffectsReference === true);
});
const staleLive = live.some((entry) => {
  if (Boolean(entry.runner)) return true;
  if (!entry.effects) return false;
  const expectedEffects = entry.processKind === "portable_remote_worker" ? expectedWorkerEffects : expectedServerEffects;
  return entry.effects !== expectedEffects;
});
const exactBlocker = staticMismatch
  ? "automation_os_startup_boundary_drift"
  : staleLive
    ? "registered_worker_runtime_stale_unsafe_runner_boundary"
    : null;

const result = {
  schema: "automation_os_runtime_boundary_readback.v1",
  generated_at: generatedAt,
  expected: {
    runner_selection: "aos_resolver_dynamic",
    server_effects: expectedServerEffects,
    worker_effects: expectedWorkerEffects
  },
  source,
  installed,
  launchd,
  live_processes: live,
  decision: exactBlocker ? "blocked_no_registered_external_canary" : "ready_for_authorized_admission",
  exact_blocker: exactBlocker,
  external_action_executed: false,
  secret_values_read: false,
  next_action: exactBlocker
    ? staticMismatch
      ? "Synchronize the installed helper/launchd boundary from the project source, then fresh-read before any worker relaunch."
      : "At an authorized maintenance window, relaunch the stale server/worker and fresh-read the new process environment before one registered read-only preflight."
    : runtimeBoundaryNextAction(selectorPath)
};

console.log(JSON.stringify(result, null, 2));
process.exitCode = exactBlocker ? 2 : 0;

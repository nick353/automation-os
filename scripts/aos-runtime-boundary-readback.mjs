#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(process.env.AUTOMATION_OS_REPO_ROOT || process.cwd());
const expectedEffects = "read_only";
const generatedAt = new Date().toISOString();

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function shellDefaultReadback(path) {
  const text = readText(path);
  if (text === null) return { path, exists: false };
  const dynamicRunnerSelection = /unset AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER AUTOMATION_OS_PORTABLE_EXTERNAL_DEFAULT_RUNNER/u.test(text);
  const effects = text.match(/AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS=.*?read_only/u)?.[0] ?? null;
  const legacyRunner = /portable-external-runner\.mjs/u.test(text);
  const enabledEffects = /AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS=.*?enabled/u.test(text);
  return {
    path,
    exists: true,
    dynamicRunnerSelection,
    readOnlyDefault: Boolean(effects),
    legacyRunnerReference: legacyRunner,
    enabledEffectsReference: enabledEffects
  };
}

function launchdReadback(path, expectsDynamicSelection = true) {
  const text = readText(path);
  if (text === null) return { path, exists: false };
  return {
    path,
    exists: true,
    dynamicRunnerSelection: expectsDynamicSelection ? !text.includes("AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER") : null,
    readOnlyDefault: expectsDynamicSelection ? text.includes("<string>read_only</string>") : null,
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

const staticEntries = [...Object.values(source), ...Object.values(launchd), ...Object.values(installed)];
const staticMismatch = staticEntries.some((entry) =>
  (!entry.exists || entry.delegatesToInstalledHelper === false || entry.dynamicRunnerSelection === false || entry.readOnlyDefault === false || entry.legacyRunnerReference || entry.enabledEffectsReference)
);
const staleLive = live.some((entry) => Boolean(entry.runner) || entry.effects && entry.effects !== expectedEffects);
const exactBlocker = staticMismatch
  ? "automation_os_startup_boundary_drift"
  : staleLive
    ? "registered_worker_runtime_stale_unsafe_runner_boundary"
    : null;

const result = {
  schema: "automation_os_runtime_boundary_readback.v1",
  generated_at: generatedAt,
  expected: { runner_selection: "aos_resolver_dynamic", effects: expectedEffects },
  source,
  installed,
  launchd,
  live_processes: live,
  decision: exactBlocker ? "blocked_no_registered_external_canary" : "ready_for_authorized_read_only_admission",
  exact_blocker: exactBlocker,
  external_action_executed: false,
  secret_values_read: false,
  next_action: exactBlocker
    ? staticMismatch
      ? "Synchronize the installed helper/launchd boundary from the project source, then fresh-read before any worker relaunch."
      : "At an authorized maintenance window, relaunch the stale server/worker and fresh-read the new process environment before one registered read-only preflight."
    : "Use the official registered read-only admission and retain same-run Browser Use receipt/readback/cleanup."
};

console.log(JSON.stringify(result, null, 2));
process.exitCode = exactBlocker ? 2 : 0;

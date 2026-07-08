import { spawnSync } from "node:child_process";

import { registeredBrowserLanes } from "../runs/laneManager.js";

export type ProcessRow = {
  pid: number;
  ppid: number;
  pgid: number;
  etime: string;
  ageSeconds: number | null;
  command: string;
};

export type ManagedProcessMatch = ProcessRow & {
  reason: string;
  laneId?: string;
  visibleLane: boolean;
};

export type ProcessCleanupResult = {
  status: "ok" | "blocked";
  mode: "scan" | "cleanup";
  maxAgeSeconds: number;
  includeVisibleLanes: boolean;
  matched: ManagedProcessMatch[];
  terminated: Array<{ pid: number; signal: NodeJS.Signals; ok: boolean; error?: string }>;
  remaining: ManagedProcessMatch[];
  exactBlocker?: string;
};

const defaultMaxAgeSeconds = 6 * 60 * 60;
const currentPid = process.pid;
type KillProbeSignal = NodeJS.Signals | 0;

export function parsePsRows(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      etime: match[4],
      ageSeconds: parseEtimeSeconds(match[4]),
      command: match[5]
    });
  }
  return rows.filter((row) => Number.isFinite(row.pid));
}

export function parseEtimeSeconds(value: string): number | null {
  const match = value.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  return (((days * 24 + hours) * 60 + minutes) * 60) + seconds;
}

export function findAutomationManagedProcesses(
  rows: ProcessRow[],
  options: { maxAgeSeconds?: number; includeVisibleLanes?: boolean } = {}
): ManagedProcessMatch[] {
  const maxAgeSeconds = options.maxAgeSeconds ?? defaultMaxAgeSeconds;
  const includeVisibleLanes = options.includeVisibleLanes === true;
  const matches: ManagedProcessMatch[] = [];

  for (const row of rows) {
    if (row.pid === currentPid) continue;
    const lane = registeredBrowserLanes.find((candidate) => commandOwnsLane(row.command, candidate));
    if (lane) {
      const visibleLane = lane.laneVisibility === "visible";
      if (visibleLane && !includeVisibleLanes) continue;
      if (row.ageSeconds !== null && row.ageSeconds < maxAgeSeconds) continue;
      matches.push({ ...row, reason: "registered_browser_lane", laneId: lane.id, visibleLane });
      continue;
    }

    const tempReason = temporaryAutomationProcessReason(row.command);
    if (!tempReason) continue;
    if (row.ageSeconds !== null && row.ageSeconds < maxAgeSeconds) continue;
    matches.push({ ...row, reason: tempReason, visibleLane: false });
  }

  return matches.sort((a, b) => a.pid - b.pid);
}

export function cleanupAutomationManagedProcesses(options: {
  psOutput?: string;
  maxAgeSeconds?: number;
  includeVisibleLanes?: boolean;
  dryRun?: boolean;
  killImpl?: (pid: number, signal: KillProbeSignal) => void;
  sleepImpl?: (ms: number) => void;
} = {}): ProcessCleanupResult {
  const maxAgeSeconds = options.maxAgeSeconds ?? defaultMaxAgeSeconds;
  const includeVisibleLanes = options.includeVisibleLanes === true;
  const psOutput = options.psOutput ?? readProcessTable();
  const rows = parsePsRows(psOutput);
  const matched = findAutomationManagedProcesses(rows, { maxAgeSeconds, includeVisibleLanes });
  const terminated: ProcessCleanupResult["terminated"] = [];
  const killImpl = options.killImpl ?? ((pid, signal) => process.kill(pid, signal));
  const sleepImpl = options.sleepImpl ?? sleepSync;

  if (!options.dryRun) {
    for (const row of matched) {
      try {
        killImpl(row.pid, "SIGTERM");
        terminated.push({ pid: row.pid, signal: "SIGTERM", ok: true });
      } catch (error) {
        terminated.push({ pid: row.pid, signal: "SIGTERM", ok: false, error: errorMessage(error) });
      }
    }
    if (matched.length > 0) sleepImpl(1200);
    for (const row of matched) {
      if (!isAlive(row.pid, killImpl)) continue;
      try {
        killImpl(row.pid, "SIGKILL");
        terminated.push({ pid: row.pid, signal: "SIGKILL", ok: true });
      } catch (error) {
        terminated.push({ pid: row.pid, signal: "SIGKILL", ok: false, error: errorMessage(error) });
      }
    }
  }

  const remaining = options.dryRun
    ? matched
    : findAutomationManagedProcesses(parsePsRows(readProcessTable()), { maxAgeSeconds, includeVisibleLanes });

  return {
    status: remaining.length === 0 ? "ok" : "blocked",
    mode: options.dryRun ? "scan" : "cleanup",
    maxAgeSeconds,
    includeVisibleLanes,
    matched,
    terminated,
    remaining,
    ...(remaining.length > 0 ? { exactBlocker: "automation_os_managed_process_cleanup_incomplete" } : {})
  };
}

function commandOwnsLane(command: string, lane: (typeof registeredBrowserLanes)[number]): boolean {
  return command.includes(`--user-data-dir=${lane.profileDir}`) ||
    command.includes(lane.profileDir) ||
    (command.includes(`--remote-debugging-port=${lane.cdpPort}`) && /Google Chrome|Chromium|chrome/i.test(command));
}

function temporaryAutomationProcessReason(command: string): string | null {
  if (command.includes("playwright-core/lib/entry/cliDaemon.js") && /\baos-[0-9A-Za-z_.-]+/.test(command)) {
    return "stale_playwright_cli_daemon";
  }
  if (command.includes("playwright_chromiumdev_profile-")) return "stale_playwright_temp_chrome";
  if (command.includes("automation-os-browser-use-auto-cdp-")) return "stale_browser_use_auto_cdp";
  if (command.includes("browser-use-user-data-dir-") && command.includes("automation-os")) return "stale_browser_use_temp_chrome";
  if (command.includes("playwright-mcp") && command.includes("/.npm/_npx/")) return "stale_playwright_mcp";
  return null;
}

function readProcessTable(): string {
  const result = spawnSync("ps", ["axww", "-o", "pid=,ppid=,pgid=,etime=,command="], { encoding: "utf8" });
  return String(result.stdout || "");
}

function isAlive(pid: number, killImpl: (pid: number, signal: KillProbeSignal) => void): boolean {
  try {
    killImpl(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

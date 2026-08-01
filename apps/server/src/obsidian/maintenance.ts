import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { auditProjects, resolveProjectRegistryPath, writeProjectAuditStatus } from "../projects/projectAuditor.js";
import { syncDiscoveredProjects, type ProjectDiscoveryResult } from "../projects/projectDiscovery.js";
import { runSecondBrainProcessor, type SecondBrainProcessorResult } from "./secondBrainProcessor.js";
import { defaultObsidianVaultPath } from "./vaultGuard.js";
import { archiveStaleUntitledBases, type VaultHygieneResult } from "./vaultHygiene.js";

export type ObsidianMaintenanceResult = {
  ok: boolean;
  skipped: boolean;
  exactBlocker: string | null;
  startedAt: string;
  completedAt: string;
  statusFile: string;
  registryPath: string;
  discovery?: ProjectDiscoveryResult;
  collector?: {
    ok: boolean;
    projects: number;
    generatedFiles: number;
    removedStaleContextPacks: number;
    error?: string;
  };
  secondBrainDryRun?: SecondBrainProcessorResult;
  secondBrainApply?: SecondBrainProcessorResult;
  vaultHygiene?: VaultHygieneResult;
  projectAudit?: ReturnType<typeof auditProjects>["summary"];
};

export type ObsidianMaintenanceOptions = {
  force?: boolean;
  vaultPath?: string;
  registryPath?: string;
  statusFile?: string;
  collectorPath?: string;
  intervalMs?: number;
  maxCanaryUpdates?: number;
};

const defaultIntervalMs = 30 * 60 * 1000;

export function runObsidianMaintenance(options: ObsidianMaintenanceOptions = {}): ObsidianMaintenanceResult {
  const startedAt = new Date().toISOString();
  const statusFile = resolve(options.statusFile ?? process.env.AUTOMATION_OS_OBSIDIAN_MAINTENANCE_STATUS_FILE ?? join(process.cwd(), "data", "obsidian-maintenance-status.json"));
  const registryPath = resolveProjectRegistryPath(options.registryPath);
  const vaultPath = resolve(options.vaultPath ?? process.env.AUTOMATION_OS_OBSIDIAN_VAULT ?? defaultObsidianVaultPath);
  const intervalMs = options.intervalMs ?? maintenanceIntervalMs();
  const previous = readStatus(statusFile);
  if (!options.force && previous?.completedAt && Date.now() - Date.parse(previous.completedAt) < intervalMs) {
    return {
      ...previous,
      skipped: true,
      exactBlocker: null,
      startedAt,
      completedAt: new Date().toISOString(),
      statusFile,
      registryPath
    };
  }

  const processLock = `${statusFile}.lock`;
  let releaseProcessLock: (() => void) | undefined;
  try {
    releaseProcessLock = acquireProcessLock(processLock);
  } catch {
    return persistStatus(statusFile, {
      ok: false,
      skipped: true,
      exactBlocker: "obsidian_maintenance_already_running",
      startedAt,
      completedAt: new Date().toISOString(),
      statusFile,
      registryPath
    });
  }

  try {
    const discovery = syncDiscoveredProjects({ registryPath, vaultPath, write: true, generatedAt: startedAt });
    const collector = runCollector({
      collectorPath: options.collectorPath,
      registryPath,
      vaultPath
    });
    const vaultHygiene = archiveStaleUntitledBases({ vaultPath });
    const secondBrainDryRun = runSecondBrainProcessor({ vaultPath, apply: false, processedAt: startedAt });
    const maxCanaryUpdates = options.maxCanaryUpdates ?? 5;
    let secondBrainApply: SecondBrainProcessorResult | undefined;
    let exactBlocker: string | null = null;
    if (!vaultHygiene.ok) {
      exactBlocker = vaultHygiene.exactBlocker ?? "obsidian_vault_hygiene_failed";
    } else if (!secondBrainDryRun.ok || secondBrainDryRun.blocked > 0) {
      exactBlocker = "second_brain_dry_run_blocked";
    } else if (secondBrainDryRun.wouldUpdate > maxCanaryUpdates) {
      exactBlocker = `second_brain_canary_limit_exceeded:${secondBrainDryRun.wouldUpdate}`;
    } else {
      secondBrainApply = runSecondBrainProcessor({ vaultPath, apply: true, processedAt: startedAt });
      if (!secondBrainApply.ok || secondBrainApply.blocked > 0) exactBlocker = "second_brain_apply_blocked";
    }

    const projectAudit = auditProjects({ registryPath, obsidianVaultPath: vaultPath, generatedAt: startedAt });
    writeProjectAuditStatus(projectAudit);
    if (!collector.ok && !exactBlocker) exactBlocker = collector.error ?? "project_handoff_collector_failed";
    const result: ObsidianMaintenanceResult = {
      ok: exactBlocker === null,
      skipped: false,
      exactBlocker,
      startedAt,
      completedAt: new Date().toISOString(),
      statusFile,
      registryPath,
      discovery,
      collector,
      vaultHygiene,
      secondBrainDryRun,
      secondBrainApply,
      projectAudit: projectAudit.summary
    };
    return persistStatus(statusFile, result);
  } catch (error) {
    return persistStatus(statusFile, {
      ok: false,
      skipped: false,
      exactBlocker: sanitizeError(error),
      startedAt,
      completedAt: new Date().toISOString(),
      statusFile,
      registryPath
    });
  } finally {
    releaseProcessLock?.();
  }
}

function acquireProcessLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    let record: { pid?: number; acquiredAt?: string } | null = null;
    try {
      record = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; acquiredAt?: string };
    } catch {
      record = null;
    }
    const pid = record?.pid;
    const hasPid = typeof pid === "number";
    const live = hasPid && processIsAlive(pid);
    const ageMs = Date.now() - statSync(path).mtimeMs;
    if (!live && (hasPid || ageMs >= 60 * 60 * 1000)) unlinkSync(path);
  }
  const acquiredAt = new Date().toISOString();
  const fd = openSync(path, "wx", 0o600);
  writeFileSync(fd, `${JSON.stringify({ pid: process.pid, acquiredAt })}\n`, "utf8");
  closeSync(fd);
  return () => {
    try {
      const current = JSON.parse(readFileSync(path, "utf8")) as { pid?: number; acquiredAt?: string };
      if (current.pid === process.pid && current.acquiredAt === acquiredAt) unlinkSync(path);
    } catch {
      // Best-effort cleanup only.
    }
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runCollector(input: { collectorPath?: string; registryPath: string; vaultPath: string }): NonNullable<ObsidianMaintenanceResult["collector"]> {
  const collectorPath = resolve(input.collectorPath ?? process.env.AUTOMATION_OS_PROJECT_HANDOFF_COLLECTOR ?? join(homedir(), ".codex", "hooks", "project-handoff-collector.mjs"));
  if (!existsSync(collectorPath)) return { ok: false, projects: 0, generatedFiles: 0, removedStaleContextPacks: 0, error: "project_handoff_collector_missing" };
  const result = spawnSync(process.execPath, [collectorPath], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 5 * 60 * 1000,
    env: {
      ...process.env,
      AUTOMATION_OS_PROJECT_REGISTRY: input.registryPath,
      PROJECT_HANDOFF_OBSIDIAN_VAULT: input.vaultPath,
      PROJECT_HANDOFF_ENABLE_DISCOVERY: "0",
      PROJECT_HANDOFF_WRITE_MEMORY_NOTE: "0",
      PROJECT_HANDOFF_STRICT: "1"
    }
  });
  if (result.status !== 0) {
    return {
      ok: false,
      projects: 0,
      generatedFiles: 0,
      removedStaleContextPacks: 0,
      error: result.error ? sanitizeError(result.error) : `project_handoff_collector_exit_${result.status ?? "unknown"}`
    };
  }
  try {
    const parsed = JSON.parse(result.stdout) as {
      ok?: boolean;
      projects?: unknown[];
      generatedFiles?: unknown[];
      removedStaleContextPacks?: unknown[];
    };
    return {
      ok: parsed.ok === true,
      projects: Array.isArray(parsed.projects) ? parsed.projects.length : 0,
      generatedFiles: Array.isArray(parsed.generatedFiles) ? parsed.generatedFiles.length : 0,
      removedStaleContextPacks: Array.isArray(parsed.removedStaleContextPacks) ? parsed.removedStaleContextPacks.length : 0,
      error: parsed.ok === true ? undefined : "project_handoff_collector_readback_failed"
    };
  } catch {
    return { ok: false, projects: 0, generatedFiles: 0, removedStaleContextPacks: 0, error: "project_handoff_collector_invalid_json" };
  }
}

function maintenanceIntervalMs(): number {
  const parsed = Number(process.env.AUTOMATION_OS_OBSIDIAN_MAINTENANCE_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultIntervalMs;
}

function readStatus(path: string): ObsidianMaintenanceResult | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ObsidianMaintenanceResult;
  } catch {
    return null;
  }
}

function persistStatus(path: string, result: ObsidianMaintenanceResult): ObsidianMaintenanceResult {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  renameSync(tmpPath, path);
  return result;
}

function sanitizeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value
    .replace(/https?:\/\/[^\s]+/g, "[redacted_url]")
    .replace(/(token|secret|password|passwd|api[_ -]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 400);
}

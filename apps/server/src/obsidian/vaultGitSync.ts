import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

import { defaultObsidianVaultPath } from "./vaultGuard.js";
import { withVaultWriteLockSync } from "./vaultWriteLock.js";

export type ObsidianGitSyncResult = {
  ok: boolean;
  skipped: boolean;
  skipReason?: string;
  execute: boolean;
  exactBlocker: string | null;
  startedAt: string;
  completedAt: string;
  vaultPath: string;
  statusFile: string;
  remote?: string;
  privateRemote?: boolean;
  branch?: string;
  changedFiles?: number;
  secretFindingFiles?: string[];
  remoteAhead?: number;
  localAhead?: number;
  commitCreated?: boolean;
  pushed?: boolean;
  head?: string;
  lastExecutedAt?: string;
};

export type ObsidianGitSyncOptions = {
  execute?: boolean;
  force?: boolean;
  vaultPath?: string;
  statusFile?: string;
  intervalMs?: number;
};

const defaultIntervalMs = 6 * 60 * 60 * 1000;
const maxScanBytes = 2 * 1024 * 1024;
const secretPatterns = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i
];

export function runObsidianGitSync(options: ObsidianGitSyncOptions = {}): ObsidianGitSyncResult {
  const startedAt = new Date().toISOString();
  const vaultPath = resolve(options.vaultPath ?? process.env.AUTOMATION_OS_OBSIDIAN_VAULT ?? defaultObsidianVaultPath);
  const statusFile = resolve(options.statusFile ?? process.env.AUTOMATION_OS_OBSIDIAN_GIT_SYNC_STATUS_FILE ?? join(process.cwd(), "data", "obsidian-git-sync-status.json"));
  const execute = options.execute === true;
  const previous = readStatus(statusFile);
  const intervalMs = options.intervalMs ?? syncIntervalMs();
  const lastExecutedAt = resolveLastSuccessfulExecutionAt(previous);
  if (!options.force && previous && lastExecutedAt && Date.now() - Date.parse(lastExecutedAt) < intervalMs) {
    return persist(statusFile, { ...previous, skipped: true, startedAt, completedAt: new Date().toISOString(), statusFile, vaultPath, execute, lastExecutedAt });
  }

  try {
    return withVaultWriteLockSync(vaultPath, "obsidian-git-sync", () => syncLocked({ startedAt, statusFile, vaultPath, execute, lastExecutedAt }));
  } catch (error) {
    const lockReason = vaultWriteLockReason(error);
    if (lockReason) {
      return {
        ...(previous ?? {
          ok: false,
          exactBlocker: null,
          completedAt: startedAt,
          vaultPath,
          statusFile
        }),
        skipped: true,
        skipReason: lockReason,
        execute,
        startedAt,
        vaultPath,
        statusFile,
        lastExecutedAt
      };
    }
    return persist(statusFile, {
      ok: false,
      skipped: false,
      execute,
      exactBlocker: sanitizeError(error),
      startedAt,
      completedAt: new Date().toISOString(),
      vaultPath,
      statusFile,
      lastExecutedAt
    });
  }
}

export function resolveLastSuccessfulExecutionAt(previous: ObsidianGitSyncResult | null): string | undefined {
  if (previous?.lastExecutedAt) return previous.lastExecutedAt;
  return previous?.execute === true && previous.ok ? previous.completedAt : undefined;
}

function syncLocked(input: { startedAt: string; statusFile: string; vaultPath: string; execute: boolean; lastExecutedAt?: string }): ObsidianGitSyncResult {
  const base: ObsidianGitSyncResult = {
    ok: false,
    skipped: false,
    execute: input.execute,
    exactBlocker: null,
    startedAt: input.startedAt,
    completedAt: input.startedAt,
    vaultPath: input.vaultPath,
    statusFile: input.statusFile,
    commitCreated: false,
    pushed: false,
    lastExecutedAt: input.lastExecutedAt
  };
  if (!existsSync(join(input.vaultPath, ".git"))) return finish(base, "obsidian_vault_git_repo_missing");

  const remote = runGit(input.vaultPath, ["remote", "get-url", "origin"]).stdout.trim();
  if (!remote || remoteHasEmbeddedCredential(remote)) return finish({ ...base, remote: "[redacted]" }, "obsidian_git_origin_invalid_or_credentialed");
  const repo = githubRepoFromRemote(remote);
  if (!repo) return finish({ ...base, remote }, "obsidian_git_origin_not_github");
  const privateCheck = runCommand("gh", ["repo", "view", repo, "--json", "isPrivate,defaultBranchRef"]);
  if (!privateCheck.ok) return finish({ ...base, remote }, "obsidian_git_private_remote_check_failed");
  const privateInfo = JSON.parse(privateCheck.stdout) as { isPrivate?: boolean; defaultBranchRef?: { name?: string } };
  if (privateInfo.isPrivate !== true) return finish({ ...base, remote, privateRemote: false }, "obsidian_git_remote_not_private");
  const branch = privateInfo.defaultBranchRef?.name || "main";

  const trackedFiles = runGit(input.vaultPath, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).stdout.split("\0").filter(Boolean);
  const secretFindingFiles = scanFilesForSecrets(input.vaultPath, trackedFiles);
  if (secretFindingFiles.length > 0) {
    return finish({ ...base, remote, privateRemote: true, branch, secretFindingFiles }, "obsidian_git_secret_scan_failed");
  }

  const statusBefore = gitStatusFiles(input.vaultPath);
  const fetch = runGit(input.vaultPath, ["fetch", "--prune", "origin", branch], 2 * 60 * 1000);
  if (!fetch.ok) return finish({ ...base, remote, privateRemote: true, branch, changedFiles: statusBefore.length }, "obsidian_git_fetch_failed");
  let divergence = gitDivergence(input.vaultPath, branch);
  if (divergence.remoteAhead > 0 && divergence.localAhead > 0) {
    return finish({ ...base, remote, privateRemote: true, branch, changedFiles: statusBefore.length, ...divergence }, "obsidian_git_history_diverged");
  }
  if (divergence.remoteAhead > 0 && statusBefore.length > 0) {
    return finish({ ...base, remote, privateRemote: true, branch, changedFiles: statusBefore.length, ...divergence }, "obsidian_git_remote_ahead_with_local_changes");
  }
  if (divergence.remoteAhead > 0) {
    if (!input.execute) {
      return persist(input.statusFile, {
        ...base,
        ok: true,
        remote,
        privateRemote: true,
        branch,
        changedFiles: 0,
        ...divergence,
        exactBlocker: null,
        completedAt: new Date().toISOString()
      });
    }
    const merge = runGit(input.vaultPath, ["merge", "--ff-only", `origin/${branch}`]);
    if (!merge.ok) return finish({ ...base, remote, privateRemote: true, branch, changedFiles: 0, ...divergence }, "obsidian_git_fast_forward_failed");
    divergence = gitDivergence(input.vaultPath, branch);
  }

  let commitCreated = false;
  if (statusBefore.length > 0 && input.execute) {
    if (!runGit(input.vaultPath, ["add", "-A"]).ok) return finish({ ...base, remote, privateRemote: true, branch, changedFiles: statusBefore.length, ...divergence }, "obsidian_git_add_failed");
    const commit = runGit(input.vaultPath, ["commit", "-m", `Automated Obsidian backup ${input.startedAt}`]);
    if (!commit.ok) return finish({ ...base, remote, privateRemote: true, branch, changedFiles: statusBefore.length, ...divergence }, "obsidian_git_commit_failed");
    commitCreated = true;
  }

  const fetchBeforePush = runGit(input.vaultPath, ["fetch", "--prune", "origin", branch], 2 * 60 * 1000);
  if (!fetchBeforePush.ok) return finish({ ...base, remote, privateRemote: true, branch, changedFiles: statusBefore.length, commitCreated }, "obsidian_git_fetch_before_push_failed");
  divergence = gitDivergence(input.vaultPath, branch);
  if (divergence.remoteAhead > 0) {
    return finish({ ...base, remote, privateRemote: true, branch, changedFiles: statusBefore.length, commitCreated, ...divergence }, "obsidian_git_remote_advanced_before_push");
  }

  let pushed = false;
  if (divergence.localAhead > 0 && input.execute) {
    const push = runGit(input.vaultPath, ["push", "origin", `HEAD:${branch}`], 2 * 60 * 1000);
    if (!push.ok) return finish({ ...base, remote, privateRemote: true, branch, changedFiles: statusBefore.length, commitCreated, ...divergence }, "obsidian_git_push_failed");
    pushed = true;
    divergence = gitDivergence(input.vaultPath, branch);
  }

  const completedAt = new Date().toISOString();
  return persist(input.statusFile, {
    ...base,
    ok: true,
    exactBlocker: null,
    remote,
    privateRemote: true,
    branch,
    changedFiles: statusBefore.length,
    secretFindingFiles: [],
    ...divergence,
    commitCreated,
    pushed,
    head: runGit(input.vaultPath, ["rev-parse", "HEAD"]).stdout.trim(),
    completedAt,
    lastExecutedAt: input.execute ? completedAt : input.lastExecutedAt
  });
}

export function scanFilesForSecrets(root: string, files: string[]): string[] {
  const findings: string[] = [];
  for (const relative of files) {
    const target = resolve(root, relative);
    if (target !== resolve(root) && !target.startsWith(`${resolve(root)}/`)) continue;
    if (!existsSync(target) || statSync(target).size > maxScanBytes || binaryExtension(target)) continue;
    let body: string;
    try {
      const buffer = readFileSync(target);
      if (buffer.includes(0)) continue;
      body = buffer.toString("utf8");
    } catch {
      continue;
    }
    if (secretPatterns.some((pattern) => pattern.test(body))) findings.push(relative);
  }
  return findings.sort((left, right) => left.localeCompare(right, "en"));
}

function runGit(cwd: string, args: string[], timeout = 60 * 1000): ReturnType<typeof runCommand> {
  return runCommand("git", args, cwd, timeout);
}

function runCommand(command: string, args: string[], cwd?: string, timeout = 60 * 1000) {
  const result = spawnSync(resolveExecutable(command), args, { cwd, encoding: "utf8", timeout, env: process.env });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

export function resolveExecutable(command: string, envPath = process.env.PATH ?? ""): string {
  if (command.includes("/")) return command;
  const candidates = [
    ...envPath.split(":").filter(Boolean).map((directory) => join(directory, command)),
    `/usr/local/bin/${command}`,
    `/opt/homebrew/bin/${command}`,
    `/usr/bin/${command}`,
    `/bin/${command}`
  ];
  for (const candidate of [...new Set(candidates)]) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the bounded system path allowlist.
    }
  }
  return command;
}

function gitStatusFiles(cwd: string): string[] {
  return runGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]).stdout.split("\n").filter(Boolean);
}

function gitDivergence(cwd: string, branch: string): { remoteAhead: number; localAhead: number } {
  const output = runGit(cwd, ["rev-list", "--left-right", "--count", `origin/${branch}...HEAD`]).stdout.trim().split(/\s+/).map(Number);
  return { remoteAhead: Number.isFinite(output[0]) ? output[0] : 0, localAhead: Number.isFinite(output[1]) ? output[1] : 0 };
}

function githubRepoFromRemote(remote: string): string | null {
  const https = remote.match(/^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/i)?.[1];
  const ssh = remote.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i)?.[1];
  return https || ssh || null;
}

function remoteHasEmbeddedCredential(remote: string): boolean {
  return /^https?:\/\/[^/@]+@/i.test(remote) || /[?&](?:token|password|key)=/i.test(remote);
}

function binaryExtension(path: string): boolean {
  return new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".mov", ".pdf", ".zip", ".gz"]).has(extname(path).toLowerCase());
}

function syncIntervalMs(): number {
  const parsed = Number(process.env.AUTOMATION_OS_OBSIDIAN_GIT_SYNC_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultIntervalMs;
}

function readStatus(path: string): ObsidianGitSyncResult | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ObsidianGitSyncResult;
  } catch {
    return null;
  }
}

function finish(result: ObsidianGitSyncResult, blocker: string): ObsidianGitSyncResult {
  return persist(result.statusFile, { ...result, ok: false, exactBlocker: blocker, completedAt: new Date().toISOString() });
}

function persist(path: string, result: ObsidianGitSyncResult): ObsidianGitSyncResult {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  renameSync(tmpPath, path);
  return result;
}

function sanitizeError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/https?:\/\/[^\s]+/g, "[redacted_url]").replace(/(token|secret|password|passwd)\s*[:=]\s*\S+/gi, "$1=[redacted]").slice(0, 300);
}

function vaultWriteLockReason(error: unknown): string | null {
  const value = error instanceof Error ? error.message : String(error);
  return /^obsidian_vault_write_locked(?::[a-zA-Z0-9._:-]+)?$/.test(value) ? value : null;
}

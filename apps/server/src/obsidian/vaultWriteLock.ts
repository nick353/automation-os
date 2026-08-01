import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type VaultWriteLock = {
  path: string;
  owner: string;
  vaultPath: string;
  acquiredAt: string;
  release: () => void;
};

type LockRecord = {
  pid?: number;
  owner?: string;
  vaultPath?: string;
  acquiredAt?: string;
};

const defaultStaleMs = 6 * 60 * 60 * 1000;

export function resolveVaultWriteLockPath(vaultPath: string): string {
  if (process.env.AUTOMATION_OS_OBSIDIAN_WRITE_LOCK) return resolve(process.env.AUTOMATION_OS_OBSIDIAN_WRITE_LOCK);
  const key = createHash("sha256").update(resolve(vaultPath)).digest("hex").slice(0, 16);
  return join(tmpdir(), `automation-os-obsidian-${key}.lock`);
}

export function acquireVaultWriteLock(vaultPath: string, owner: string): VaultWriteLock {
  const canonicalVaultPath = resolve(vaultPath);
  const lockPath = resolveVaultWriteLockPath(canonicalVaultPath);
  mkdirSync(dirname(lockPath), { recursive: true });
  reclaimDeadLock(lockPath);

  const acquiredAt = new Date().toISOString();
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    const record = readLockRecord(lockPath);
    const detail = record?.owner ? `:${sanitizeOwner(record.owner)}` : "";
    throw new Error(`obsidian_vault_write_locked${detail}`);
  }

  const record: LockRecord = { pid: process.pid, owner: sanitizeOwner(owner), vaultPath: canonicalVaultPath, acquiredAt };
  writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
  closeSync(fd);
  let released = false;

  return {
    path: lockPath,
    owner: record.owner ?? owner,
    vaultPath: canonicalVaultPath,
    acquiredAt,
    release: () => {
      if (released) return;
      released = true;
      const current = readLockRecord(lockPath);
      if (current?.pid !== process.pid || current?.acquiredAt !== acquiredAt) return;
      try {
        unlinkSync(lockPath);
      } catch {
        // Another recovery path may already have removed the lock.
      }
    }
  };
}

export function withVaultWriteLockSync<T>(vaultPath: string, owner: string, action: () => T): T {
  const lock = acquireVaultWriteLock(vaultPath, owner);
  try {
    return action();
  } finally {
    lock.release();
  }
}

function reclaimDeadLock(lockPath: string): void {
  if (!existsSync(lockPath)) return;
  const record = readLockRecord(lockPath);
  const ageMs = Date.now() - statSafeMtimeMs(lockPath);
  const pid = record?.pid;
  const hasPid = typeof pid === "number";
  if (hasPid && processIsAlive(pid)) return;
  if (!hasPid && ageMs < staleLockMs()) return;
  const stalePath = `${lockPath}.stale.${Date.now()}`;
  try {
    renameSync(lockPath, stalePath);
    unlinkSync(stalePath);
  } catch {
    // Fail closed if another process races the stale-lock recovery.
  }
}

function readLockRecord(lockPath: string): LockRecord | null {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")) as LockRecord;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function statSafeMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Date.now();
  }
}

function staleLockMs(): number {
  const parsed = Number(process.env.AUTOMATION_OS_OBSIDIAN_WRITE_LOCK_STALE_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultStaleMs;
}

function sanitizeOwner(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]+/g, "_").slice(0, 80) || "unknown";
}

import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type VaultWriteLock = {
  path: string;
  owner: string;
  vaultPath: string;
  acquiredAt: string;
  leaseId: string;
  fencingToken: number;
  heartbeat: () => boolean;
  renew: () => boolean;
  release: () => void;
};

export type VaultWriteLockOptions = {
  leaseMs?: number;
};

type LockRecord = {
  pid?: number;
  owner?: string;
  vaultPath?: string;
  acquiredAt?: string;
  leaseId?: string;
  fencingToken?: number;
  heartbeatAt?: string;
  expiresAt?: string;
};

const defaultStaleMs = 6 * 60 * 60 * 1000;

export function resolveVaultWriteLockPath(vaultPath: string): string {
  if (process.env.AUTOMATION_OS_OBSIDIAN_WRITE_LOCK) return resolve(process.env.AUTOMATION_OS_OBSIDIAN_WRITE_LOCK);
  const key = createHash("sha256").update(resolve(vaultPath)).digest("hex").slice(0, 16);
  return join(tmpdir(), `automation-os-obsidian-${key}.lock`);
}

export function acquireVaultWriteLock(vaultPath: string, owner: string, options: VaultWriteLockOptions = {}): VaultWriteLock {
  const canonicalVaultPath = resolve(vaultPath);
  const lockPath = resolveVaultWriteLockPath(canonicalVaultPath);
  mkdirSync(dirname(lockPath), { recursive: true });
  reclaimDeadLock(lockPath);

  const acquiredAt = new Date().toISOString();
  const leaseId = randomUUID();
  const fencingToken = Date.now();
  const leaseMs = resolveLeaseMs(options.leaseMs);
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    const record = readLockRecord(lockPath);
    const detail = record?.owner ? `:${sanitizeOwner(record.owner)}` : "";
    throw new Error(`obsidian_vault_write_locked${detail}`);
  }

  const record: LockRecord = {
    pid: process.pid,
    owner: sanitizeOwner(owner),
    vaultPath: canonicalVaultPath,
    acquiredAt,
    leaseId,
    fencingToken,
    heartbeatAt: acquiredAt,
    expiresAt: new Date(Date.now() + leaseMs).toISOString()
  };
  writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
  closeSync(fd);
  let released = false;

  const heartbeat = (): boolean => {
    if (released) return false;
    const current = readLockRecord(lockPath);
    if (!ownsLock(current, record)) return false;
    writeLockRecord(lockPath, {
      ...record,
      heartbeatAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + leaseMs).toISOString()
    });
    return ownsLock(readLockRecord(lockPath), record);
  };

  return {
    path: lockPath,
    owner: record.owner ?? owner,
    vaultPath: canonicalVaultPath,
    acquiredAt,
    leaseId,
    fencingToken,
    heartbeat,
    renew: heartbeat,
    release: () => {
      if (released) return;
      released = true;
      const current = readLockRecord(lockPath);
      if (!ownsLock(current, record)) return;
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
  const expiresAt = record?.expiresAt ? Date.parse(record.expiresAt) : Number.NaN;
  const expired = Number.isFinite(expiresAt) ? expiresAt <= Date.now() : ageMs >= staleLockMs();
  if (hasPid && processIsAlive(pid) && !expired) return;
  if (!hasPid && !expired && ageMs < staleLockMs()) return;
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

function writeLockRecord(lockPath: string, record: LockRecord): void {
  const tmpPath = `${lockPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmpPath, lockPath);
  } catch {
    try {
      unlinkSync(tmpPath);
    } catch {
      // A later heartbeat or release will fail closed if the lease cannot be refreshed.
    }
  }
}

function ownsLock(current: LockRecord | null, expected: LockRecord): boolean {
  return current?.pid === process.pid
    && current.acquiredAt === expected.acquiredAt
    && current.leaseId === expected.leaseId
    && current.fencingToken === expected.fencingToken;
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

function resolveLeaseMs(input?: number): number {
  if (typeof input === "number" && Number.isFinite(input) && input > 0) return Math.floor(input);
  const parsed = Number(process.env.AUTOMATION_OS_OBSIDIAN_WRITE_LOCK_LEASE_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : staleLockMs();
}

function sanitizeOwner(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]+/g, "_").slice(0, 80) || "unknown";
}

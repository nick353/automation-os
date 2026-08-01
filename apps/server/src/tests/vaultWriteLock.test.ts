import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runSecondBrainProcessor } from "../obsidian/secondBrainProcessor.js";
import { acquireVaultWriteLock, resolveVaultWriteLockPath } from "../obsidian/vaultWriteLock.js";

test("Vault writer lock fails closed while another writer owns the vault", () => {
  const vault = mkdtempSync(join(tmpdir(), "automation-os-vault-lock-"));
  const lock = acquireVaultWriteLock(vault, "first-writer");
  try {
    assert.throws(() => acquireVaultWriteLock(vault, "second-writer"), /obsidian_vault_write_locked:first-writer/);
  } finally {
    lock.release();
  }

  const next = acquireVaultWriteLock(vault, "second-writer");
  next.release();
});

test("Vault writer lock immediately reclaims a lock owned by a dead process", () => {
  const vault = mkdtempSync(join(tmpdir(), "automation-os-vault-dead-lock-"));
  const lockPath = resolveVaultWriteLockPath(vault);
  writeFileSync(
    lockPath,
    `${JSON.stringify({ pid: 999_999_999, owner: "dead-writer", vaultPath: vault, acquiredAt: new Date().toISOString() })}\n`,
    { mode: 0o600 }
  );

  const lock = acquireVaultWriteLock(vault, "replacement-writer");
  assert.equal(lock.owner, "replacement-writer");
  lock.release();
});

test("Second Brain apply reports the shared writer lock without changing notes", () => {
  const vault = mkdtempSync(join(tmpdir(), "automation-os-second-brain-lock-"));
  const inbox = join(vault, "09_Inbox");
  mkdirSync(inbox, { recursive: true });
  const note = join(inbox, "note.md");
  const original = "---\ntitle: Locked\nauto_process: obsidian_internal_only\n---\n# Locked\n\nKeep unchanged.\n";
  writeFileSync(note, original);
  const lock = acquireVaultWriteLock(vault, "test-writer");
  const previousOverride = process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
  process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = "1";
  try {
    const result = runSecondBrainProcessor({ vaultPath: vault, apply: true, processedAt: "2026-07-15T00:00:00.000Z" });
    assert.equal(result.ok, false);
    assert.equal(result.blocked, 1);
    assert.match(result.results[0].reason, /obsidian_vault_write_locked:test-writer/);
  } finally {
    lock.release();
    if (previousOverride === undefined) delete process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
    else process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = previousOverride;
  }
});

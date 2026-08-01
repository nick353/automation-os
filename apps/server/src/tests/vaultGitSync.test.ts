import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  resolveExecutable,
  resolveLastSuccessfulExecutionAt,
  runObsidianGitSync,
  scanFilesForSecrets,
  type ObsidianGitSyncResult
} from "../obsidian/vaultGitSync.js";
import { acquireVaultWriteLock } from "../obsidian/vaultWriteLock.js";

test("Obsidian Git sync secret scan reports file paths without exposing values", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-os-vault-secret-scan-"));
  mkdirSync(join(root, "notes"), { recursive: true });
  writeFileSync(join(root, "notes", "safe.md"), "# Safe\nNo credential here.\n");
  writeFileSync(join(root, "notes", "blocked.md"), "password: aVeryLongCredentialValue123\n");

  const findings = scanFilesForSecrets(root, ["notes/safe.md", "notes/blocked.md"]);
  assert.deepEqual(findings, ["notes/blocked.md"]);
  assert.equal(JSON.stringify(findings).includes("aVeryLongCredentialValue123"), false);
});

test("Obsidian Git sync secret scan ignores binary files", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-os-vault-binary-scan-"));
  writeFileSync(join(root, "image.png"), Buffer.from("password: aVeryLongCredentialValue123\0binary"));
  assert.deepEqual(scanFilesForSecrets(root, ["image.png"]), []);
});

test("Obsidian Git sync dry-runs preserve the last successful execution clock", () => {
  const successfulExecution = {
    ok: true,
    skipped: false,
    execute: true,
    exactBlocker: null,
    startedAt: "2026-07-15T00:00:00.000Z",
    completedAt: "2026-07-15T00:00:05.000Z",
    vaultPath: "/tmp/vault",
    statusFile: "/tmp/status.json"
  } satisfies ObsidianGitSyncResult;
  assert.equal(resolveLastSuccessfulExecutionAt(successfulExecution), successfulExecution.completedAt);

  const laterDryRun = {
    ...successfulExecution,
    execute: false,
    completedAt: "2026-07-15T01:00:05.000Z",
    lastExecutedAt: successfulExecution.completedAt
  } satisfies ObsidianGitSyncResult;
  assert.equal(resolveLastSuccessfulExecutionAt(laterDryRun), successfulExecution.completedAt);
  assert.equal(resolveLastSuccessfulExecutionAt({ ...laterDryRun, lastExecutedAt: undefined }), undefined);
});

test("Obsidian Git sync finds Homebrew commands when LaunchAgent PATH is restricted", () => {
  const expected = ["/usr/local/bin/gh", "/opt/homebrew/bin/gh"].find((candidate) => {
    try {
      return resolveExecutable("gh", "") === candidate;
    } catch {
      return false;
    }
  });
  if (expected) assert.equal(resolveExecutable("gh", "/usr/bin:/bin"), expected);
});

test("Obsidian Git sync treats a busy Vault writer as a transient skip without overwriting status", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-os-vault-git-lock-"));
  const statusFile = join(root, "status.json");
  const previous = {
    ok: true,
    skipped: false,
    execute: true,
    exactBlocker: null,
    startedAt: "2026-07-15T00:00:00.000Z",
    completedAt: "2026-07-15T00:00:05.000Z",
    vaultPath: root,
    statusFile,
    lastExecutedAt: "2026-07-15T00:00:05.000Z"
  } satisfies ObsidianGitSyncResult;
  writeFileSync(statusFile, `${JSON.stringify(previous, null, 2)}\n`);
  const before = readFileSync(statusFile, "utf8");
  const lock = acquireVaultWriteLock(root, "exporter");
  try {
    const result = runObsidianGitSync({ execute: true, force: true, vaultPath: root, statusFile });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.skipReason, "obsidian_vault_write_locked:exporter");
    assert.equal(result.lastExecutedAt, previous.lastExecutedAt);
    assert.equal(readFileSync(statusFile, "utf8"), before);
  } finally {
    lock.release();
  }
});

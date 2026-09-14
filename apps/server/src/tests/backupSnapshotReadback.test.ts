import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readBackupSnapshot } from "../runs/backupSnapshotReadback.js";

function fixture(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aos-backup-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const destination = join(root, "working");
  const repository = join(root, "remote.git");
  const artifacts = join(root, "artifacts");
  const statePath = join(root, "STATE.md");
  const id = "20260905T090000+0900";
  const snapshot = join(destination, "snapshots", id);
  const labels = ["codex-backup", "obsidian-vault", "new-project", "etsy", "apparel-root", "heavy-chain"];
  for (const label of labels) mkdirSync(join(snapshot, label), { recursive: true });
  mkdirSync(join(artifacts, id), { recursive: true });
  const content = "# Isolated backup fixture\n";
  writeFileSync(join(snapshot, "etsy", "STATE.md"), content);
  writeFileSync(join(artifacts, id, "manifest.tsv"), "label\tstatus\tsource\tdestination\n" + labels.map((label) => `${label}\tOK\tfixture\t${join(snapshot, label)}`).join("\n") + "\n");
  symlinkSync(snapshot, join(destination, "latest"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: destination, stdio: "pipe", timeout: 5000 });
  git("init", "-b", "main");
  git("config", "user.name", "AOS isolated test");
  git("config", "user.email", "test@example.invalid");
  git("add", ".");
  git("commit", "-m", "fixture");
  git("init", "--bare", repository);
  git("remote", "add", "origin", repository);
  git("push", "origin", "main");
  const commit = git("rev-parse", "HEAD").toString().trim();
  writeFileSync(statePath, `status: success\nlatest_success_run_id: ${id}\nlatest_snapshot_path: ${snapshot}\nlatest_backup_commit: ${commit}\n`);
  return { destination, repository, artifacts, statePath, snapshot, id, commit, content, git, now: new Date("2026-09-05T11:00:00Z") };
}

test("snapshot verification proves remote parity, six sources and an isolated restore without a new backup", (t) => {
  const input = fixture(t);
  const before = input.git("rev-parse", "HEAD").toString();
  const result = readBackupSnapshot(input);
  assert.equal(result.readback_verified, true);
  assert.equal(result.remote_parity, true);
  assert.equal(result.git_integrity_verified, true);
  assert.equal(result.manifest_source_count, 6);
  assert.equal(result.restore_verified, true);
  assert.equal(result.restore_sha256, createHash("sha256").update(input.content).digest("hex"));
  assert.equal(result.manifest_sha256, createHash("sha256").update(readFileSync(join(input.artifacts, input.id, "manifest.tsv"))).digest("hex"));
  assert.equal(result.state_sha256, createHash("sha256").update(readFileSync(input.statePath)).digest("hex"));
  assert.equal(result.snapshot_age_hours, 11);
  assert.equal(result.snapshot_stale, false);
  assert.equal(result.cleanup_verified, true);
  assert.equal(result.snapshot_created, false);
  assert.equal(result.git_push_performed, false);
  assert.equal(input.git("rev-parse", "HEAD").toString(), before);
  assert.equal(readFileSync(join(input.snapshot, "etsy", "STATE.md"), "utf8"), input.content);
});

test("old snapshots remain verified historical backups, never fresh completion", (t) => {
  const input = fixture(t);
  const result = readBackupSnapshot({ ...input, now: new Date("2026-09-08T00:00:00Z") });
  assert.equal(result.readback_verified, true);
  assert.equal(result.snapshot_stale, true);
  assert.equal(result.snapshot_age_hours, 72);
});

test("unpublished local commits stop at remote parity and never push", (t) => {
  const input = fixture(t);
  input.git("commit", "--allow-empty", "-m", "not published");
  const result = readBackupSnapshot(input);
  assert.equal(result.readback_verified, false);
  assert.equal(result.exact_blocker, "backup_remote_parity_mismatch");
  assert.equal(result.git_push_performed, false);
});

test("missing source proof and a modified snapshot fail with precise evidence", (t) => {
  const input = fixture(t);
  const manifest = join(input.artifacts, input.id, "manifest.tsv");
  const original = readFileSync(manifest, "utf8");
  writeFileSync(manifest, original.replace("etsy\tOK", "etsy\tFAIL"));
  assert.equal(readBackupSnapshot(input).exact_blocker, "backup_manifest_incomplete");
  writeFileSync(manifest, original);
  writeFileSync(join(input.snapshot, "etsy", "STATE.md"), "changed");
  const result = readBackupSnapshot(input);
  assert.equal(result.exact_blocker, "backup_restore_hash_mismatch");
  assert.equal(result.cleanup_verified, true);
});

test("an unexpected repository is rejected before any remote call", (t) => {
  const input = fixture(t);
  assert.equal(readBackupSnapshot({ ...input, repository: "https://example.invalid/wrong.git" }).exact_blocker, "backup_repository_mismatch");
});

test("an expected original snapshot and commit are required to match the readback", (t) => {
  const input = fixture(t);
  const result = readBackupSnapshot({ ...input, expectedSnapshotId: input.id, expectedCommit: input.commit });
  assert.equal(result.readback_verified, true);
  assert.equal(result.snapshot_id, input.id);
  assert.equal(result.commit, input.commit);
  assert.equal(result.remote_commit, input.commit);
  assert.equal(result.destination_clean, true);
  assert.equal(result.state_matches_snapshot_and_commit, true);
  assert.equal(readBackupSnapshot({ ...input, expectedSnapshotId: "20260906T090000+0900", expectedCommit: input.commit }).exact_blocker, "backup_snapshot_original_run_mismatch");
  assert.equal(readBackupSnapshot({ ...input, expectedSnapshotId: input.id, expectedCommit: "f".repeat(40) }).exact_blocker, "backup_commit_original_run_mismatch");
});

test("STATE is read and a mismatch cannot become a successful snapshot proof", (t) => {
  const input = fixture(t);
  writeFileSync(input.statePath, `status: success\nlatest_success_run_id: ${input.id}\nlatest_snapshot_path: ${input.snapshot}\nlatest_backup_commit: ${"f".repeat(40)}\n`);
  const result = readBackupSnapshot(input);
  assert.equal(result.readback_verified, false);
  assert.equal(result.state_matches_snapshot_and_commit, false);
  assert.equal(result.state_sha256, createHash("sha256").update(readFileSync(input.statePath)).digest("hex"));
  assert.equal(result.exact_blocker, "backup_state_snapshot_commit_mismatch");
});

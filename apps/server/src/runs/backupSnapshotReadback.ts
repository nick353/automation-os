import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

export const backupDestination = "/Users/nichikatanaka/Documents/Codex/backup-repos/daily-workspace-backup";
export const backupStatePath = "/Users/nichikatanaka/.codex/automations/daily-backup-safety-check/STATE.md";
const backupRepository = "https://github.com/nick353/daily-workspace-backup.git";
const backupArtifacts = "/Users/nichikatanaka/.codex/automations/daily-backup-safety-check/artifacts";
const sourceLabels = ["codex-backup", "obsidian-vault", "new-project", "etsy", "apparel-root", "heavy-chain"];

/** Read the existing snapshot; never invoke the backup runner, commit, or push. */
export function readBackupSnapshot(input: { destination?: string; repository?: string; artifacts?: string; statePath?: string; expectedSnapshotId?: string; expectedCommit?: string; now?: Date } = {}) {
  const destination = resolve(input.destination ?? backupDestination);
  const repository = input.repository ?? backupRepository;
  const artifacts = input.artifacts ?? backupArtifacts;
  const statePath = input.statePath ?? backupStatePath;
  const now = input.now ?? new Date();
  const expectedSnapshotId = input.expectedSnapshotId?.trim() || null;
  const expectedCommit = input.expectedCommit?.trim() || null;
  const evidence: Record<string, unknown> = {
    checked_at: now.toISOString(), verification_only: true, snapshot_created: false,
    git_push_performed: false, preflight_only: false, cleanup_verified: true
  };
  let stage = "repository";
  let restoreDirectory: string | null = null;
  let restorePath: string | null = null;
  const git = (...args: string[]) => execFileSync("git", ["-C", destination, ...args], {
    timeout: args[0] === "fsck" ? 90_000 : 30_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  });
  const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  try {
    if (git("remote", "get-url", "origin").toString().trim() !== repository) throw new Error("backup_repository_mismatch");
    if (git("branch", "--show-current").toString().trim() !== "main") throw new Error("backup_branch_mismatch");
    const commit = git("rev-parse", "HEAD").toString().trim();
    const remoteCommit = git("ls-remote", "--exit-code", "origin", "refs/heads/main").toString().trim().split(/\s+/)[0];
    evidence.commit = commit;
    evidence.remote_commit = remoteCommit;
    evidence.remote_parity = remoteCommit === commit;
    if (!evidence.remote_parity) throw new Error("backup_remote_parity_mismatch");

    stage = "snapshot";
    const latest = join(destination, "latest");
    if (!lstatSync(latest).isSymbolicLink()) throw new Error("backup_latest_not_symlink");
    const snapshot = resolve(destination, readlinkSync(latest));
    const snapshotRelative = relative(destination, snapshot);
    if (!/^snapshots\/\d{8}T\d{6}[+-]\d{4}$/.test(snapshotRelative)) throw new Error("backup_snapshot_target_invalid");
    if (realpathSync(snapshot) !== snapshot) throw new Error("backup_snapshot_target_symlink");
    if (resolve(destination, git("show", `${commit}:latest`).toString().trim()) !== snapshot) throw new Error("backup_committed_latest_mismatch");
    const snapshotId = snapshotRelative.slice("snapshots/".length);
    if (expectedSnapshotId && snapshotId !== expectedSnapshotId) throw new Error("backup_snapshot_original_run_mismatch");
    if (expectedCommit && commit !== expectedCommit) throw new Error("backup_commit_original_run_mismatch");
    const match = snapshotId.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})([+-]\d{2})(\d{2})$/)!;
    const capturedAt = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${match[7]}:${match[8]}`);
    const ageHours = (now.getTime() - capturedAt.getTime()) / 3_600_000;
    if (!Number.isFinite(ageHours) || ageHours < 0) throw new Error("backup_snapshot_timestamp_invalid");
    evidence.snapshot_id = snapshotId;
    evidence.snapshot_captured_at = capturedAt.toISOString();
    evidence.snapshot_age_hours = Math.round(ageHours * 100) / 100;
    evidence.snapshot_stale = ageHours > 36;

    stage = "manifest";
    const manifestBytes = readFileSync(join(artifacts, snapshotId, "manifest.tsv"));
    const rows = manifestBytes.toString("utf8").trim().split(/\r?\n/).slice(1).map((line) => line.split("\t"));
    if (rows.length !== sourceLabels.length || sourceLabels.some((label) => rows.filter((row) => row[0] === label && row[1] === "OK" && row[3] === join(snapshot, label)).length !== 1)) throw new Error("backup_manifest_incomplete");
    evidence.manifest_source_count = rows.length;
    evidence.manifest_sha256 = sha256(manifestBytes);
    stage = "integrity";
    git("fsck", "--full", "--no-reflogs");
    evidence.git_integrity_verified = true;

    // Restore only this fixed, non-secret representative file in a private directory.
    stage = "restore";
    const sample = `${snapshotRelative}/etsy/STATE.md`;
    const existing = join(destination, sample);
    if (!lstatSync(existing).isFile() || realpathSync(existing) !== existing) throw new Error("backup_restore_sample_invalid");
    const committed = git("show", `${commit}:${sample}`);
    restoreDirectory = mkdtempSync(join(tmpdir(), "aos-backup-restore-"));
    restorePath = join(restoreDirectory, "STATE.md");
    writeFileSync(restorePath, committed, { mode: 0o600, flag: "wx" });
    const restoredHash = sha256(readFileSync(restorePath));
    if (restoredHash !== sha256(readFileSync(existing))) throw new Error("backup_restore_hash_mismatch");
    evidence.restore_sha256 = restoredHash;
    evidence.restore_verified = true;
    evidence.restore_scope = "representative_file:etsy/STATE.md";
    stage = "final_readback";
    const destinationClean = git("status", "--porcelain").toString().trim() === "";
    evidence.destination_clean = destinationClean;
    if (!destinationClean) throw new Error("backup_destination_not_clean");
    const stateBytes = readFileSync(statePath);
    const state = stateBytes.toString("utf8");
    const stateValues = Object.fromEntries(state.split(/\r?\n/u).flatMap((line) => {
      const match = line.match(/^([a-z_]+):\s*(.*)$/u);
      return match ? [[match[1], match[2]]] : [];
    }));
    const stateMatches = stateValues.status === "success"
      && stateValues.latest_success_run_id === snapshotId
      && stateValues.latest_backup_commit === commit
      && stateValues.latest_snapshot_path === snapshot
      && (!expectedSnapshotId || stateValues.latest_success_run_id === expectedSnapshotId)
      && (!expectedCommit || stateValues.latest_backup_commit === expectedCommit);
    evidence.state_matches_snapshot_and_commit = stateMatches;
    evidence.state_sha256 = sha256(stateBytes);
    if (!stateMatches) throw new Error("backup_state_snapshot_commit_mismatch");
    if (git("rev-parse", "HEAD").toString().trim() !== commit || resolve(destination, readlinkSync(latest)) !== snapshot) throw new Error("backup_snapshot_changed_during_verification");
    evidence.readback_verified = true;
    evidence.exact_blocker = null;
  } catch (error) {
    // Git stderr can contain credentials or source paths: keep only stable codes.
    const message = error instanceof Error ? error.message : "";
    evidence.exact_blocker = /^backup_[a-z_]+$/.test(message) ? message : `backup_${stage}_readback_failed`;
    const commandError = error as { code?: unknown; signal?: unknown };
    evidence.failure_code = typeof commandError?.code === "number" || commandError?.code === "ETIMEDOUT" ? commandError.code : null;
    evidence.failure_signal = commandError?.signal === "SIGTERM" ? "SIGTERM" : null;
    evidence.readback_verified = false;
  } finally {
    try {
      if (restorePath) unlinkSync(restorePath);
      if (restoreDirectory) rmdirSync(restoreDirectory);
    } catch {
      evidence.cleanup_verified = false;
      evidence.readback_verified = false;
      evidence.exact_blocker = "backup_restore_cleanup_failed";
    }
  }
  return evidence;
}

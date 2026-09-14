import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const fixtureRoot = mkdtempSync(join(tmpdir(), "aos-backup-evidence-reader-"));
const portableArtifactRoot = join(fixtureRoot, "portable-remote-worker");
const backupArtifactRoot = join(fixtureRoot, "daily-backup-artifacts");
const runId = "run_phase1_original";
const stepId = `${runId}_step_1`;
const snapshotId = "20260910T223116+0900";
const commit = "c".repeat(40);
const inputBundle = {
  schema: "automation_os_portable_workflow_input_bundle.v1",
  workflow_id: "daily-backup-safety-check",
  run_id: runId,
  input: { account_ref: "github:nick353/daily-workspace-backup", target_key: "daily-workspace-backup:main", payload_hash: "d".repeat(64) },
  created_at: "2026-09-10T13:26:57.719Z"
};
const inputBundleText = `${JSON.stringify(inputBundle, null, 2)}\n`;
const inputBundleSha = createHash("sha256").update(inputBundleText).digest("hex");
const authority = {
  schema: "automation_os_portable_external_effect_authority.v1",
  authority_id: "portable-effect-phase1",
  issued_by: "automation_os_portable_controller",
  company_id: "company_2560580981cedfd106b66245",
  workflow_id: "daily-backup-safety-check",
  run_id: runId,
  step_id: stepId,
  effect_stage: "business_execute",
  effect_class: "external_non_idempotent",
  browser_surface: "browser_use_cli",
  approval_id: "app_phase1",
  approval_status: "approved",
  idempotency_key: "phase1-backup",
  target_digest: "a".repeat(64),
  input_bundle_sha256: inputBundleSha,
  payload_hash: "d".repeat(64),
  issued_at: "2026-09-10T13:30:26.869Z",
  expires_at: "2026-09-10T13:40:26.868Z",
  timeout_ms: 599999,
  timeout_controller: "automation_os_portable_controller",
  reconciliation_required: true,
  reconciliation_owner: "automation_os_portable_controller",
  no_auto_retry: true,
  first_class_root_required: false,
  app_dependency: false,
  external_action_authorized: true
};
const authorityText = `${JSON.stringify(authority, null, 2)}\n`;
const authoritySha = createHash("sha256").update(authorityText).digest("hex");
const admission = {
  schema: "automation_os_portable_external_admission.v1",
  issued_by: "automation_os_mac_worker",
  audience: "portable_external_runner",
  workflow_id: "daily-backup-safety-check",
  run_id: runId,
  step_id: stepId,
  source_trigger: "automation_os_ui",
  idempotency_key: "phase1-backup",
  effect_class: "external_non_idempotent",
  browser_surface: "browser_use_cli",
  external_effects: "enabled",
  approval_status: "approved",
  effect_authority_id: authority.authority_id,
  effect_authority_sha256: authoritySha,
  timeout_controller: "automation_os_portable_controller",
  reconciliation_owner: "automation_os_portable_controller",
  reconciliation_required: true,
  no_auto_retry: true,
  business_effect_stage: "business_execute",
  approval_id: authority.approval_id,
  input_bundle_sha256: authority.input_bundle_sha256,
  target_digest: authority.target_digest,
  issued_at: "2026-09-10T13:30:27.020Z",
  expires_at: "2026-09-10T13:50:27.020Z"
};
const summaryText = `run_id\t${snapshotId}\nstarted_at\t2026-09-10 22:31:19 JST\nsnapshot_root\t/Users/nichikatanaka/Documents/Codex/backup-repos/daily-workspace-backup/snapshots/${snapshotId}\nbackup_repo\t/Users/nichikatanaka/Documents/Codex/backup-repos/daily-workspace-backup\nbackup_commit\t${commit}\nmanifest\t/Users/nichikatanaka/.codex/automations/daily-backup-safety-check/artifacts/${snapshotId}/manifest.tsv\ncompleted_at\t2026-09-10 22:39:50 JST\nstatus\tOK\n`;

function put(filePath, value) {
  mkdirSync(join(filePath, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function putSummary(filePath, value) {
  mkdirSync(join(filePath, ".."), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, value, { mode: 0o644 });
}

function makeFixture() {
  rmSync(fixtureRoot, { recursive: true, force: true });
  mkdirSync(join(portableArtifactRoot, runId), { recursive: true, mode: 0o700 });
  mkdirSync(join(backupArtifactRoot, snapshotId), { recursive: true, mode: 0o700 });
  put(join(portableArtifactRoot, runId, "portable-local-execution-started.v1.json"), {
    schema: "aos.portable_local_execution_started.v1", run_id: runId, step_id: stepId,
    workflow_id: "daily-backup-safety-check", company_id: authority.company_id, idempotency_key: authority.idempotency_key
  });
  put(join(portableArtifactRoot, runId, "portable-external-admission-phase1.json"), admission);
  put(join(portableArtifactRoot, runId, "portable-effect-authority.v1.json"), authority);
  writeFileSync(join(portableArtifactRoot, runId, "portable-input-bundle.v1.json"), inputBundleText, { mode: 0o600 });
  put(join(portableArtifactRoot, runId, "portable-local-worker-receipt.v1.json"), {
    schema: "aos.portable_local_worker_receipt.v1", status: "blocked",
    exact_blocker: "portable_local_child_deadline_exceeded", workflow_id: "daily-backup-safety-check",
    external_action_executed: null, adapter_result: { no_replay: true }, run_id: runId, step_id: stepId,
    created_at: "2026-09-10T13:40:11.939Z"
  });
  putSummary(join(backupArtifactRoot, snapshotId, "summary.txt"), summaryText);
}

process.env.AUTOMATION_OS_REPO_ROOT = process.cwd();
process.env.AUTOMATION_OS_PORTABLE_REMOTE_ARTIFACT_ROOT = portableArtifactRoot;
const { readPortableBackupEvidence } = await import("../aos-portable-backup-evidence-reader.mjs");

test.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

test("reader matches the original claim, timeout, unique summary, snapshot/commit and STATE proof", async () => {
  makeFixture();
  const calls = [];
  const result = await readPortableBackupEvidence({
    runId, now: new Date("2026-09-11T00:00:00Z"),
    backupArtifactRoot,
    backupSnapshotReader: (input) => {
      calls.push(input);
      return {
        snapshot_id: snapshotId, commit, remote_commit: commit, remote_parity: true,
        manifest_source_count: 6, git_integrity_verified: true, restore_verified: true,
        cleanup_verified: true, destination_clean: true, state_matches_snapshot_and_commit: true,
        manifest_sha256: "1".repeat(64), state_sha256: "2".repeat(64), exact_blocker: null,
        readback_verified: true
      };
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].expectedSnapshotId, snapshotId);
  assert.equal(calls[0].expectedCommit, commit);
  assert.ok(calls[0].now instanceof Date);
  assert.equal(result.readback_verified, true);
  assert.equal(result.original_execution_summary.snapshot_id, snapshotId);
  assert.equal(result.original_execution_summary.backup_commit, commit);
  assert.equal(result.original_claim.authority_sha256, authoritySha);
  assert.equal(result.input_bundle.sha256, inputBundleSha);
  assert.equal(result.original_execution_summary.correlation_method, "unique_success_in_original_claim_interval");
  assert.equal(result.original_execution_summary.interval_start, "2026-09-10T13:30:27.020Z");
  assert.equal(result.original_execution_summary.interval_end, "2026-09-10T13:40:11.939Z");
  assert.equal(result.original_execution_summary.candidate_count, 1);
  assert.equal(result.original_execution_summary.sha256, createHash("sha256").update(readFileSync(join(backupArtifactRoot, snapshotId, "summary.txt"))).digest("hex"));
  assert.equal(result.evidence.manifest_sha256, "1".repeat(64));
  assert.equal(result.evidence.state_sha256, "2".repeat(64));
  assert.equal(result.direct_child_link_verified, false);
  assert.equal(result.original_claim.sha256, createHash("sha256").update(readFileSync(join(portableArtifactRoot, runId, "portable-external-admission-phase1.json"))).digest("hex"));
  assert.equal(result.original_timeout_receipt.sha256, createHash("sha256").update(readFileSync(join(portableArtifactRoot, runId, "portable-local-worker-receipt.v1.json"))).digest("hex"));
});

test("latest or unrelated snapshot values cannot replace the summary matched to the original interval", async () => {
  makeFixture();
  const result = await readPortableBackupEvidence({
    runId, backupArtifactRoot,
    backupSnapshotReader: () => ({
      snapshot_id: "20260911T090000+0900", commit: "e".repeat(40), remote_commit: "e".repeat(40),
      remote_parity: true, manifest_source_count: 6, git_integrity_verified: true,
      restore_verified: true, cleanup_verified: true, destination_clean: true,
      state_matches_snapshot_and_commit: true, readback_verified: true,
      manifest_sha256: "1".repeat(64), state_sha256: "2".repeat(64), exact_blocker: null
    })
  });
  assert.equal(result.readback_verified, false);
});

test("missing and ambiguous success summaries are rejected", async () => {
  makeFixture();
  unlinkSync(join(backupArtifactRoot, snapshotId, "summary.txt"));
  await assert.rejects(() => readPortableBackupEvidence({ runId, backupArtifactRoot, backupSnapshotReader: () => ({}) }), /portable_backup_success_summary_missing/);
  makeFixture();
  const second = "20260910T223200+0900";
  mkdirSync(join(backupArtifactRoot, second), { recursive: true, mode: 0o700 });
  putSummary(join(backupArtifactRoot, second, "summary.txt"), summaryText.replaceAll(snapshotId, second));
  await assert.rejects(() => readPortableBackupEvidence({ runId, backupArtifactRoot, backupSnapshotReader: () => ({}) }), /portable_backup_success_summary_ambiguous/);
});

test("STATE mismatch from the fixed verifier is never promoted to success", async () => {
  makeFixture();
  const result = await readPortableBackupEvidence({
    runId, backupArtifactRoot,
    backupSnapshotReader: () => ({
      snapshot_id: snapshotId, commit, remote_commit: commit, remote_parity: true,
      manifest_source_count: 6, git_integrity_verified: true, restore_verified: true,
      cleanup_verified: true, destination_clean: true, state_matches_snapshot_and_commit: false,
      manifest_sha256: "1".repeat(64), state_sha256: "2".repeat(64), exact_blocker: "backup_state_snapshot_commit_mismatch", readback_verified: true
    })
  });
  assert.equal(result.readback_verified, false);
  assert.equal(result.exact_blocker, "backup_state_snapshot_commit_mismatch");
});

test("schema, company, idempotency, approval and authorization fields are required and bound", async () => {
  makeFixture();
  put(join(portableArtifactRoot, runId, "portable-effect-authority.v1.json"), { ...authority, external_action_authorized: undefined });
  await assert.rejects(() => readPortableBackupEvidence({ runId, backupArtifactRoot, backupSnapshotReader: () => ({}) }), /portable_backup_original_claim_timeout_binding_invalid/);

  makeFixture();
  put(join(portableArtifactRoot, runId, "portable-local-execution-started.v1.json"), {
    schema: "aos.portable_local_execution_started.v1", run_id: runId, step_id: stepId,
    workflow_id: "daily-backup-safety-check", company_id: "different-company", idempotency_key: authority.idempotency_key
  });
  await assert.rejects(() => readPortableBackupEvidence({ runId, backupArtifactRoot, backupSnapshotReader: () => ({}) }), /portable_backup_original_claim_timeout_binding_invalid/);

  makeFixture();
  put(join(portableArtifactRoot, runId, "portable-external-admission-phase1.json"), { ...admission, idempotency_key: "different-idempotency" });
  await assert.rejects(() => readPortableBackupEvidence({ runId, backupArtifactRoot, backupSnapshotReader: () => ({}) }), /portable_backup_original_claim_timeout_binding_invalid/);

  makeFixture();
  put(join(portableArtifactRoot, runId, "portable-effect-authority.v1.json"), { ...authority, schema: "wrong.schema" });
  await assert.rejects(() => readPortableBackupEvidence({ runId, backupArtifactRoot, backupSnapshotReader: () => ({}) }), /portable_backup_original_claim_timeout_binding_invalid/);

  makeFixture();
  put(join(portableArtifactRoot, runId, "portable-effect-authority.v1.json"), { ...authority, target_digest: "not-a-sha256" });
  await assert.rejects(() => readPortableBackupEvidence({ runId, backupArtifactRoot, backupSnapshotReader: () => ({}) }), /portable_backup_original_claim_timeout_binding_invalid/);
});

test("a present saved input bundle is checked by exact bytes and hash", async () => {
  makeFixture();
  writeFileSync(join(portableArtifactRoot, runId, "portable-input-bundle.v1.json"), `${JSON.stringify({
    ...inputBundle, input: { ...inputBundle.input, payload_hash: "e".repeat(64) }
  }, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(() => readPortableBackupEvidence({ runId, backupArtifactRoot, backupSnapshotReader: () => ({}) }), /portable_backup_input_bundle_hash_mismatch/);
});

test("the fixed verifier blocker is propagated without promoting the historical proof", async () => {
  makeFixture();
  const result = await readPortableBackupEvidence({
    runId, backupArtifactRoot,
    backupSnapshotReader: () => ({
      snapshot_id: snapshotId, commit, remote_commit: commit, remote_parity: true,
      manifest_source_count: 6, git_integrity_verified: true, restore_verified: true,
      cleanup_verified: true, destination_clean: true, state_matches_snapshot_and_commit: true,
      manifest_sha256: "1".repeat(64), state_sha256: "2".repeat(64), readback_verified: false,
      exact_blocker: "backup_manifest_incomplete"
    })
  });
  assert.equal(result.readback_verified, false);
  assert.equal(result.exact_blocker, "backup_manifest_incomplete");
  assert.equal(result.evidence.exact_blocker, "backup_manifest_incomplete");
});

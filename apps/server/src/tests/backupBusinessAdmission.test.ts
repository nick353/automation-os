import assert from "node:assert/strict";
import test from "node:test";
import {
  backupBusinessPayloadHash, isDelegatedBackupSourceReadback,
  preparePortableLocalBackupBusinessAdmission, runPortableLocalWorkflowBusiness
} from "../runs/portableLocalWorkflow.js";

const companyId = "company_2560580981cedfd106b66245";
test("cloud dispatch delegates only the fixed backup without claiming a Mac readback", () => {
  const previous = process.env.AUTOMATION_OS_BACKUP_RUNNER_PATH;
  process.env.AUTOMATION_OS_BACKUP_RUNNER_PATH = "/nonexistent/aos-backup-fixture-runner";
  try {
    const admission = preparePortableLocalBackupBusinessAdmission({ companyId, dueKey: "fixture:backup", scheduledFor: "2026-09-05T12:00:00Z" });
    assert.equal(admission.status, "ready");
    assert.equal(admission.sourceSnapshot.readback_verified, false);
    assert.equal(admission.sourceSnapshot.external_action_executed, false);
    assert.equal(isDelegatedBackupSourceReadback(admission.sourceSnapshot, admission.inputBundle!, companyId), true);
    for (const change of [{ account_ref: "github:foreign/repo" }, { target_key: "foreign:main" }, { payload_hash: "a".repeat(64) }, { source_snapshot_id: "b".repeat(64) }]) {
      assert.equal(isDelegatedBackupSourceReadback(admission.sourceSnapshot, { ...admission.inputBundle, ...change }, companyId), false);
    }
    assert.equal(isDelegatedBackupSourceReadback({ ...admission.sourceSnapshot, workflow_id: "obsidian-project-memory-audit" }, admission.inputBundle!, companyId), false);
    assert.equal(preparePortableLocalBackupBusinessAdmission({ companyId: "foreign", dueKey: "fixture", scheduledFor: "2026-09-05T12:00:00Z" }).status, "blocked");
  } finally {
    if (previous === undefined) delete process.env.AUTOMATION_OS_BACKUP_RUNNER_PATH;
    else process.env.AUTOMATION_OS_BACKUP_RUNNER_PATH = previous;
  }
});

test("backup refuses the effect when the Mac's real pre-effect source check fails", () => {
  const previous = process.env.AUTOMATION_OS_BACKUP_RUNNER_PATH;
  process.env.AUTOMATION_OS_BACKUP_RUNNER_PATH = process.execPath;
  try {
    const result = runPortableLocalWorkflowBusiness({
      companyId, workflowId: "daily-backup-safety-check", workerRole: "mac",
      runId: "fixture", stepId: "fixture_step", idempotencyKey: "fixture_key",
      targetDigest: "a".repeat(64), inputBundleSha256: "b".repeat(64),
      inputBundle: { account_ref: "github:nick353/daily-workspace-backup", target_key: "daily-workspace-backup:main", payload_hash: backupBusinessPayloadHash(), source_snapshot_id: "c".repeat(64) },
      backupSnapshotReader: () => ({ readback_verified: false, cleanup_verified: true, exact_blocker: "backup_remote_parity_mismatch" })
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.exact_blocker, "backup_remote_parity_mismatch");
    assert.equal(result.external_action_executed, false);
    assert.equal(result.business_completion_verified, false);
  } finally {
    if (previous === undefined) delete process.env.AUTOMATION_OS_BACKUP_RUNNER_PATH;
    else process.env.AUTOMATION_OS_BACKUP_RUNNER_PATH = previous;
  }
});

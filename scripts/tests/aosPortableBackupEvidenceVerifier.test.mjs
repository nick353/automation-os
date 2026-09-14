import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runPortableBackupEvidenceVerifier } from "../aos-portable-remote-worker.mjs";

const claim = (leaseMs = 30_000) => ({
  evidence_only: true,
  workflow_id: "daily-backup-safety-check",
  run_id: "run_verifier_wrapper_test",
  step_id: "run_verifier_wrapper_test_step_1",
  lease_expires_at: new Date(Date.now() + leaseMs).toISOString(),
});

const validEvidence = (runId = claim().run_id) => ({
  schema: "aos.portable_backup_post_effect_evidence.v1",
  run_id: runId,
  workflow_id: "daily-backup-safety-check",
  exact_blocker: null,
  evidence: {},
  readback_verified: true,
  cleanup_verified: true,
  provider_replayed: false,
  new_effect: false,
});

function scriptWith(root, name, source) {
  const file = join(root, name);
  writeFileSync(file, source, { mode: 0o700 });
  chmodSync(file, 0o700);
  return file;
}

function spawnScript(script, options) {
  return spawn(process.execPath, [script], options);
}

async function runScript(source, configureClaim = claim) {
  const root = mkdtempSync(join(tmpdir(), "aos-backup-verifier-wrapper-"));
  const script = scriptWith(root, "child.mjs", source);
  const previous = process.env.AUTOMATION_OS_PORTABLE_BACKUP_EVIDENCE_VERIFIER_TIMEOUT_MS;
  process.env.AUTOMATION_OS_PORTABLE_BACKUP_EVIDENCE_VERIFIER_TIMEOUT_MS = "1000";
  try {
    return await runPortableBackupEvidenceVerifier(configureClaim(), {
      spawnProcess: (_bin, _args, options) => spawnScript(script, options)
    });
  } finally {
    if (previous === undefined) delete process.env.AUTOMATION_OS_PORTABLE_BACKUP_EVIDENCE_VERIFIER_TIMEOUT_MS;
    else process.env.AUTOMATION_OS_PORTABLE_BACKUP_EVIDENCE_VERIFIER_TIMEOUT_MS = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("successful verifier output is accepted only after owned-group cleanup", async () => {
  const result = await runScript(`process.stdout.write(${JSON.stringify(JSON.stringify(validEvidence()))});\n`);
  assert.equal(result.readback_verified, true);
  assert.equal(result.cleanup_verified, true);
  assert.equal(result.provider_replayed, false);
  assert.equal(result.new_effect, false);
  assert.equal(result.child_exit_code, 0);
});

test("a valid-looking success with nonzero exit is rejected", async () => {
  await assert.rejects(() => runScript(`process.stdout.write(${JSON.stringify(JSON.stringify(validEvidence()))}); process.exit(7);\n`), /portable_backup_evidence_verifier_nonzero/);
});

test("a nonzero malformed blocker cannot be propagated as an exact blocker", async () => {
  const malformed = { exact_blocker: 42, readback_verified: true, cleanup_verified: true, provider_replayed: false, new_effect: false };
  await assert.rejects(() => runScript(`process.stdout.write(${JSON.stringify(JSON.stringify(malformed))}); process.exit(7);\n`), /portable_backup_evidence_verifier_nonzero/);
});

test("a nonzero empty blocker cannot be propagated", async () => {
  const malformed = { status: "blocked", exact_blocker: "", provider_replayed: false, new_effect: false };
  await assert.rejects(() => runScript(`process.stdout.write(${JSON.stringify(JSON.stringify(malformed))}); process.exit(7);\n`), /portable_backup_evidence_verifier_nonzero/);
});

test("a valid-looking success terminated by signal is rejected", async () => {
  await assert.rejects(() => runScript(`process.stdout.write(${JSON.stringify(JSON.stringify(validEvidence()))}, () => process.kill(process.pid, "SIGTERM"));\n`), /portable_backup_evidence_verifier_signal/);
});

test("flags cannot make malformed verifier output valid", async () => {
  const malformed = { readback_verified: true, cleanup_verified: true, provider_replayed: false, new_effect: false };
  await assert.rejects(() => runScript(`process.stdout.write(${JSON.stringify(JSON.stringify(malformed))});\n`), /portable_backup_evidence_verifier_output_invalid/);
});

test("a statusless Phase1 failure preserves cleanup_verified false", async () => {
  const failure = { ...validEvidence(), exact_blocker: "portable_backup_state_snapshot_commit_mismatch", readback_verified: false, cleanup_verified: false };
  delete failure.status;
  const result = await runScript(`process.stdout.write(${JSON.stringify(JSON.stringify(failure))});\n`);
  assert.equal(result.readback_verified, false);
  assert.equal(result.exact_blocker, "portable_backup_state_snapshot_commit_mismatch");
  assert.equal(result.cleanup_verified, false);
});

test("timeout terminates the owned process group and reports cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "aos-backup-verifier-timeout-"));
  const pidPath = join(root, "descendant.pid");
  const tempPathMarker = join(root, "temporary-restore-path.txt");
  const script = scriptWith(root, "timeout-child.mjs", `import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
const descendant = spawn(process.execPath, ["--input-type=module", "--eval", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidPath)}, String(descendant.pid));
const temporaryRestore = join(tmpdir(), "restore-left-by-timeout.tmp");
writeFileSync(temporaryRestore, "temporary restore");
writeFileSync(${JSON.stringify(tempPathMarker)}, temporaryRestore);
setInterval(() => {}, 60000);
`);
  const previous = process.env.AUTOMATION_OS_PORTABLE_BACKUP_EVIDENCE_VERIFIER_TIMEOUT_MS;
  // Keep enough time for the child to publish its descendant PID before the
  // bounded timeout fires; the verifier's deadline remains independently
  // asserted by the cleanup result below.
  process.env.AUTOMATION_OS_PORTABLE_BACKUP_EVIDENCE_VERIFIER_TIMEOUT_MS = "1000";
  let descendantPid = null;
  try {
    const result = await runPortableBackupEvidenceVerifier(claim(), {
      spawnProcess: (_bin, _args, options) => spawnScript(script, options)
    });
    descendantPid = Number(readFileSync(pidPath, "utf8"));
    assert.equal(result.status, "blocked");
    assert.equal(result.readback_verified, false);
    assert.equal(result.cleanup_verified, true);
    assert.equal(result.exact_blocker, "portable_backup_evidence_verifier_timeout");
    assert.equal(result.process_group_cleanup.verified, true);
    assert.equal(result.temporary_restore_cleanup.verified, true);
    assert.equal(existsSync(readFileSync(tempPathMarker, "utf8")), false);
    assert.throws(() => process.kill(descendantPid, 0));
  } finally {
    if (descendantPid) {
      try { process.kill(descendantPid, "SIGKILL"); } catch { /* group cleanup already removed it */ }
    }
    if (previous === undefined) delete process.env.AUTOMATION_OS_PORTABLE_BACKUP_EVIDENCE_VERIFIER_TIMEOUT_MS;
    else process.env.AUTOMATION_OS_PORTABLE_BACKUP_EVIDENCE_VERIFIER_TIMEOUT_MS = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a Phase1 blocker remains visible in a valid blocked envelope", async () => {
  const blocker = {
    schema: "aos.portable_backup_post_effect_evidence.v1",
    run_id: claim().run_id,
    workflow_id: "daily-backup-safety-check",
    status: "blocked",
    exact_blocker: "portable_backup_input_bundle_hash_mismatch",
    evidence: {},
    readback_verified: false,
    cleanup_verified: false,
    provider_replayed: false,
    new_effect: false,
  };
  const result = await runScript(`process.stdout.write(${JSON.stringify(JSON.stringify(blocker))});\n`);
  assert.equal(result.exact_blocker, "portable_backup_input_bundle_hash_mismatch");
  assert.equal(result.readback_verified, false);
  assert.equal(result.cleanup_verified, false);
});

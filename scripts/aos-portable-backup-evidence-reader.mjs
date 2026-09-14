#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(process.env.AUTOMATION_OS_REPO_ROOT || path.join(import.meta.dirname, ".."));
const artifactRoot = path.resolve(process.env.AUTOMATION_OS_PORTABLE_REMOTE_ARTIFACT_ROOT || path.join(root, "data", "artifacts", "portable-remote-worker"));
const runIdPattern = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,179}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
const idPattern = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,179}$/u;
const START_SCHEMA = "aos.portable_local_execution_started.v1";
const TIMEOUT_SCHEMA = "aos.portable_local_worker_receipt.v1";
const ADMISSION_SCHEMA = "automation_os_portable_external_admission.v1";
const AUTHORITY_SCHEMA = "automation_os_portable_external_effect_authority.v1";
const INPUT_BUNDLE_SCHEMA = "automation_os_portable_workflow_input_bundle.v1";
const backupDestination = "/Users/nichikatanaka/Documents/Codex/backup-repos/daily-workspace-backup";
const backupArtifacts = "/Users/nichikatanaka/.codex/automations/daily-backup-safety-check/artifacts";

function privateFile(filePath) {
  const stat = lstatSync(filePath);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (uid !== null && stat.uid !== uid) || (stat.mode & 0o077) !== 0 || stat.size > 4_000_000) {
    throw new Error("portable_backup_timeout_artifact_invalid");
  }
  return readFileSync(filePath);
}

function readableSummaryFile(filePath) {
  const stat = lstatSync(filePath);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (uid !== null && stat.uid !== uid) || (stat.mode & 0o022) !== 0 || stat.size > 4_000_000) {
    throw new Error("portable_backup_summary_invalid");
  }
  return readFileSync(filePath);
}

function stableEvidence(snapshot) {
  const fields = ["snapshot_id", "snapshot_captured_at", "commit", "remote_commit", "remote_parity",
    "manifest_source_count", "git_integrity_verified", "restore_sha256", "restore_verified", "restore_scope",
    "manifest_sha256", "state_sha256", "readback_verified", "cleanup_verified", "destination_clean",
    "state_matches_snapshot_and_commit", "exact_blocker"];
  return Object.fromEntries(fields.filter((key) => Object.prototype.hasOwnProperty.call(snapshot, key))
    .map((key) => [key, snapshot[key]]));
}

function parseKeyValueFile(bytes) {
  return Object.fromEntries(bytes.toString("utf8").split(/\r?\n/u).flatMap((line) => {
    const match = line.match(/^([^\t]+)\t(.*)$/u);
    return match ? [[match[1], match[2]]] : [];
  }));
}

function parseSummaryTime(value) {
  const match = String(value || "").match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) JST$/u);
  if (!match) return NaN;
  return Date.parse(`${match[1]}T${match[2]}+09:00`);
}

function readJson(filePath, errorCode) {
  try { return JSON.parse(privateFile(filePath).toString("utf8")); }
  catch { throw new Error(errorCode); }
}

function readJsonWithBytes(filePath, errorCode) {
  try {
    const bytes = privateFile(filePath);
    return { value: JSON.parse(bytes.toString("utf8")), bytes };
  } catch {
    throw new Error(errorCode);
  }
}

function requiredId(value) {
  return typeof value === "string" && idPattern.test(value);
}

function requiredHash(value) {
  return typeof value === "string" && hashPattern.test(value);
}

function readUniqueSuccessSummary({ artifactRoot: summaryRoot, startMs, endMs }) {
  const matches = [];
  for (const entry of readdirSync(summaryRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{8}T\d{6}[+-]\d{4}$/u.test(entry.name)) continue;
    try {
      const summaryBytes = readableSummaryFile(path.join(summaryRoot, entry.name, "summary.txt"));
      const summary = parseKeyValueFile(summaryBytes);
      const started = parseSummaryTime(summary.started_at);
      const completed = parseSummaryTime(summary.completed_at);
      const snapshotRoot = path.join(backupDestination, "snapshots", entry.name);
      if (summary.status === "OK" && summary.run_id === entry.name
        && summary.snapshot_root === snapshotRoot && commitPattern.test(summary.backup_commit || "")
        && Number.isFinite(started) && Number.isFinite(completed)
        && started >= startMs && completed <= endMs && started <= completed) {
        matches.push({
          id: entry.name,
          summary,
          sha256: createHash("sha256").update(summaryBytes).digest("hex"),
          started,
          completed
        });
      }
    } catch {
      // Incomplete or malformed candidates are not successful summaries.
    }
  }
  if (matches.length === 0) throw new Error("portable_backup_success_summary_missing");
  if (matches.length !== 1) throw new Error("portable_backup_success_summary_ambiguous");
  return { ...matches[0], candidate_count: matches.length };
}

/** Read only the original timeout artifact and the fixed backup snapshot. */
export async function readPortableBackupEvidence({ runId, now = new Date(), backupSnapshotReader, backupArtifactRoot = backupArtifacts } = {}) {
  if (typeof runId !== "string" || !runIdPattern.test(runId.trim())) throw new Error("portable_backup_evidence_run_id_invalid");
  const normalizedRunId = runId.trim();
  const runRoot = path.resolve(artifactRoot, normalizedRunId);
  const relative = path.relative(artifactRoot, runRoot);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("portable_backup_evidence_artifact_root_invalid");
  const timeoutArtifactName = "portable-local-worker-receipt.v1.json";
  const timeoutArtifactPath = path.join(runRoot, timeoutArtifactName);
  const bytes = privateFile(timeoutArtifactPath);
  let timeout;
  try { timeout = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("portable_backup_timeout_artifact_invalid"); }
  if (!timeout || timeout.schema !== TIMEOUT_SCHEMA
    || timeout.run_id !== normalizedRunId || timeout.workflow_id !== "daily-backup-safety-check"
    || timeout.status !== "blocked" || timeout.exact_blocker !== "portable_local_child_deadline_exceeded"
    || !requiredId(timeout.step_id) || timeout.external_action_executed !== null || timeout.adapter_result?.no_replay !== true
    || typeof timeout.created_at !== "string" || !Number.isFinite(Date.parse(timeout.created_at))) {
    throw new Error("portable_backup_original_timeout_binding_invalid");
  }
  const started = readJson(path.join(runRoot, "portable-local-execution-started.v1.json"), "portable_backup_start_marker_invalid");
  const admissionEntries = readdirSync(runRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^portable-external-admission-[A-Za-z0-9]+\.json$/u.test(entry.name));
  if (admissionEntries.length !== 1) throw new Error("portable_backup_saved_claim_ambiguous");
  const admissionPath = path.join(runRoot, admissionEntries[0].name);
  const admissionBytes = privateFile(admissionPath);
  const admission = (() => {
    try { return JSON.parse(admissionBytes.toString("utf8")); }
    catch { throw new Error("portable_backup_saved_claim_invalid"); }
  })();
  const { value: authority, bytes: authorityBytes } = readJsonWithBytes(path.join(runRoot, "portable-effect-authority.v1.json"), "portable_backup_authority_invalid");
  const timeoutCreated = Date.parse(String(timeout.created_at || ""));
  const authorityIssuedAt = Date.parse(String(authority.issued_at || ""));
  const authorityExpiresAt = Date.parse(String(authority.expires_at || ""));
  const admissionIssuedAt = Date.parse(String(admission.issued_at || ""));
  const issuedAt = Math.max(authorityIssuedAt, admissionIssuedAt);
  const authoritySha = createHash("sha256").update(authorityBytes).digest("hex");
  const authorityValidAtOriginalStart = authorityIssuedAt <= admissionIssuedAt && admissionIssuedAt <= authorityExpiresAt;
  const identityAndSchemaValid = started?.schema === START_SCHEMA
    && admission?.schema === ADMISSION_SCHEMA
    && authority?.schema === AUTHORITY_SCHEMA
    && requiredId(started.run_id) && requiredId(started.step_id) && requiredId(started.workflow_id)
    && requiredId(started.company_id) && requiredId(started.idempotency_key)
    && requiredId(admission.run_id) && requiredId(admission.step_id) && requiredId(admission.workflow_id)
    && requiredId(admission.idempotency_key) && requiredId(admission.approval_id)
    && requiredHash(admission.effect_authority_sha256) && requiredHash(admission.input_bundle_sha256)
    && requiredHash(admission.target_digest)
    && requiredId(authority.authority_id) && requiredId(authority.company_id)
    && requiredId(authority.workflow_id) && requiredId(authority.run_id) && requiredId(authority.step_id)
    && requiredId(authority.approval_id) && requiredId(authority.idempotency_key)
    && requiredHash(authority.input_bundle_sha256) && requiredHash(authority.payload_hash) && requiredHash(authority.target_digest)
    && authority.approval_status === "approved" && authority.external_action_authorized === true
    && authority.reconciliation_required === true && authority.no_auto_retry === true
    && admission.approval_status === "approved" && admission.external_effects === "enabled"
    && started.company_id === authority.company_id
    && started.run_id === normalizedRunId && started.step_id === timeout.step_id
    && started.workflow_id === "daily-backup-safety-check"
    && started.idempotency_key === authority.idempotency_key
    && admission.run_id === normalizedRunId && admission.step_id === timeout.step_id
    && admission.workflow_id === "daily-backup-safety-check"
    && admission.idempotency_key === authority.idempotency_key
    && authority.run_id === normalizedRunId && authority.step_id === timeout.step_id
    && authority.workflow_id === "daily-backup-safety-check"
    && admission.effect_authority_id === authority.authority_id
    && admission.effect_authority_sha256 === authoritySha
    && admission.approval_id === authority.approval_id
    && admission.input_bundle_sha256 === authority.input_bundle_sha256
    && admission.target_digest === authority.target_digest;
  if (!Number.isFinite(timeoutCreated) || !Number.isFinite(authorityIssuedAt) || !Number.isFinite(authorityExpiresAt)
    || !Number.isFinite(admissionIssuedAt) || !authorityValidAtOriginalStart || !identityAndSchemaValid || timeoutCreated < issuedAt
    || started.run_id !== normalizedRunId || started.step_id !== timeout.step_id
    || started.workflow_id !== "daily-backup-safety-check"
  ) {
    throw new Error("portable_backup_original_claim_timeout_binding_invalid");
  }
  const inputBundlePath = path.join(runRoot, "portable-input-bundle.v1.json");
  let inputBundleEvidence = null;
  if (existsSync(inputBundlePath)) {
    try {
      const inputBytes = privateFile(inputBundlePath);
    const input = JSON.parse(inputBytes.toString("utf8"));
    const inputSha = createHash("sha256").update(inputBytes).digest("hex");
    if (inputSha !== authority.input_bundle_sha256 || input?.schema !== INPUT_BUNDLE_SCHEMA
      || input.workflow_id !== authority.workflow_id || input.run_id !== normalizedRunId) {
      throw new Error("portable_backup_input_bundle_hash_mismatch");
    }
    inputBundleEvidence = { artifact_name: "portable-input-bundle.v1.json", sha256: inputSha };
    } catch (error) {
      if (error instanceof Error && error.message === "portable_backup_input_bundle_hash_mismatch") throw error;
      throw new Error("portable_backup_input_bundle_invalid");
    }
  }
  const summaryMatch = readUniqueSuccessSummary({ artifactRoot: path.resolve(backupArtifactRoot), startMs: issuedAt, endMs: timeoutCreated });
  const { readBackupSnapshot } = await import(pathToFileURL(path.join(root, "apps/server/dist/runs/backupSnapshotReadback.js")).href);
  const snapshot = await (backupSnapshotReader
    ? backupSnapshotReader({ now, expectedSnapshotId: summaryMatch.id, expectedCommit: summaryMatch.summary.backup_commit })
    : readBackupSnapshot({ now, expectedSnapshotId: summaryMatch.id, expectedCommit: summaryMatch.summary.backup_commit }));
  const evidence = stableEvidence(snapshot);
  const verified = snapshot.readback_verified === true && snapshot.remote_parity === true
    && snapshot.git_integrity_verified === true && snapshot.restore_verified === true
    && snapshot.cleanup_verified === true && snapshot.manifest_source_count === 6
    && snapshot.destination_clean === true
    && snapshot.state_matches_snapshot_and_commit === true
    && snapshot.snapshot_id === summaryMatch.id
    && snapshot.commit === summaryMatch.summary.backup_commit
    && snapshot.remote_commit === summaryMatch.summary.backup_commit;
  const exactBlocker = verified ? null : (typeof snapshot.exact_blocker === "string" ? snapshot.exact_blocker : "portable_backup_evidence_verification_failed");
  return {
    schema: "aos.portable_backup_post_effect_evidence.v1",
    run_id: normalizedRunId,
    workflow_id: "daily-backup-safety-check",
    original_timeout_receipt: {
      artifact_name: timeoutArtifactName,
      run_id: normalizedRunId,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      status: timeout.status,
      exact_blocker: timeout.exact_blocker,
      external_action_executed: timeout.external_action_executed,
      child_signal: timeout.adapter_result?.child_signal ?? null,
      timed_out: timeout.adapter_result?.timed_out === true,
      no_replay: timeout.adapter_result?.no_replay === true,
    },
    original_claim: {
      artifact_name: admissionEntries[0].name,
      sha256: createHash("sha256").update(admissionBytes).digest("hex"),
      run_id: admission.run_id,
      step_id: admission.step_id,
      authority_id: authority.authority_id,
      authority_sha256: authoritySha,
    },
    original_execution_summary: {
      correlation_method: "unique_success_in_original_claim_interval",
      interval_basis: "original_authority_and_admission_issued_at_to_original_timeout_created_at",
      interval_start: new Date(issuedAt).toISOString(),
      interval_end: new Date(timeoutCreated).toISOString(),
      candidate_count: summaryMatch.candidate_count,
      snapshot_id: summaryMatch.id,
      backup_commit: summaryMatch.summary.backup_commit,
      sha256: summaryMatch.sha256,
      started_at: summaryMatch.summary.started_at,
      completed_at: summaryMatch.summary.completed_at,
    },
    input_bundle: inputBundleEvidence,
    evidence: { ...evidence, exact_blocker: exactBlocker },
    exact_blocker: exactBlocker,
    readback_verified: verified,
    cleanup_verified: snapshot.cleanup_verified === true,
    direct_child_link_verified: false,
    provider_replayed: false,
    new_effect: false,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const runId = process.argv.find((value) => value.startsWith("--run-id="))?.slice("--run-id=".length);
  readPortableBackupEvidence({ runId }).then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.log(JSON.stringify({ status: "blocked", exact_blocker: error instanceof Error ? error.message : "portable_backup_evidence_failed", provider_replayed: false, new_effect: false })); process.exitCode = 1; });
}

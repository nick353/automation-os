import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "automation-os-target-admission-"));
process.env.AUTOMATION_OS_DB = join(root, "automation-os.sqlite");
process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(root, "artifacts");
process.env.NODE_TEST_CONTEXT = "1";

const db = await import("../db/client.js");
const admission = await import("../jobApplications/targetAdmission.js");
const effectLedger = await import("../taskContracts/taskEffectLedger.js");

const companyId = "target_admission_test_company";
const base = {
  workflow_id: "job-application-manager",
  registered_automation_id: "automation-3",
  job_url: "https://example.com/jobs/one",
  application_url: "https://example.com/jobs/one/apply",
  company_name: "Example Company",
  role: "Marketing Manager",
  account_ref: "account:job-manager",
  audience: { company: "Example Company", job: "Marketing Manager" },
  resume_locale: "ja-JP",
  resume_sha256: "b".repeat(64),
  payload_ref: "aos://immutable/application-payload/one",
  payload_sha256: "a".repeat(64),
  owner_ref: "owner:automation-os",
  authority_ref: "authority:job-application-manager",
  effect_specific_approval: {
    action_kind: "one_candidate_submit",
    policy_version: "automation_os_portable_external_approval_binding.v1"
  },
  source_snapshot_id: "snapshot:one",
  source_snapshot_expires_at: "2099-01-01T00:00:00.000Z",
  bucket: "japan_targeted",
  sequence: 1,
  attempt: 1,
  supply_run_id: "run:supply:one"
};

test("target admission stores only immutable references and enforces one active candidate", () => {
  db.initDb();
  db.insert("companies", { id: companyId, slug: companyId, name: "Target Admission Test", status: "active", created_at: db.nowIso(), updated_at: db.nowIso() });
  const parsed = admission.parseTargetAdmissionInput(base, "2026-08-13T00:00:00.000Z");
  const first = admission.createTargetAdmission({ companyId, admission: parsed, idempotencyKey: "target-admission-test-001" });
  assert.equal(first.replayed, false);
  assert.equal(first.admission.workflow_id, "job-application-manager");
  assert.equal(first.admission.approval_status, "not_started");
  assert.equal(first.admission.candidate_key.startsWith("job_target_"), true);
  assert.equal(first.admission.idempotency_key_fingerprint.length, 16);
  assert.equal(first.admission.payload_ref, "aos://immutable/application-payload/one");
  assert.equal(first.admission.payload_sha256, "a".repeat(64));
  const replay = admission.createTargetAdmission({ companyId, admission: parsed, idempotencyKey: "target-admission-test-001" });
  assert.equal(replay.replayed, true);
  assert.equal(replay.admission.id, first.admission.id);
  assert.equal(db.querySql<{ count: number }>(`SELECT count(*) AS count FROM job_application_target_admissions WHERE company_id=${db.sqlValue(companyId)}`)[0].count, 1);
  assert.throws(
    () => admission.createTargetAdmission({ companyId, admission: parsed, idempotencyKey: "target-admission-test-002" }),
    /UNIQUE|constraint|job_application_target_admissions/i
  );
});

test("target admission may derive the account binding from fixed Chrome Plugin Profile 2", () => {
  const parsed = admission.parseTargetAdmissionInput({ ...base, account_ref: undefined }, "2026-08-13T00:00:00.000Z", { accountRef: "auth:chrome-profile2" });
  assert.equal(parsed.accountRef, "auth:chrome-profile2");
});

test("target admission readback reflects persisted approval without claiming business completion", () => {
  const approvedCompanyId = "target_admission_approved_readback_company";
  db.initDb();
  db.insert("companies", { id: approvedCompanyId, slug: approvedCompanyId, name: "Approved Readback Test", status: "active", created_at: db.nowIso(), updated_at: db.nowIso() });
  const created = admission.createTargetAdmission({
    companyId: approvedCompanyId,
    admission: admission.parseTargetAdmissionInput({ ...base, company_name: "Approved Readback Test", audience: { company: "Approved Readback Test", job: "Marketing Manager" } }, "2026-08-13T00:00:00.000Z"),
    idempotencyKey: "target-admission-approved-readback",
  });
  const updated = admission.updateTargetAdmissionStatus({
    companyId: approvedCompanyId,
    admissionId: created.admission.id,
    status: "approved",
    approvalStatus: "approved",
    approvalId: "approval-approved-readback",
  });
  assert.equal(updated.task_contract.approval.status, "approved");
  assert.equal(updated.task_contract.approval.approval_id, "approval-approved-readback");
  assert.equal(updated.task_contract.status, "running");
  assert.equal(updated.task_contract.exact_blocker, null);
  assert.equal(updated.task_contract.provider_receipt.status, "missing");
  assert.equal(updated.task_contract.source_sync.status, "missing");
  assert.equal(updated.task_contract.reconciliation.status, "missing");
  assert.equal(updated.task_contract.cleanup.status, "missing");
});

test("fresh candidate creation reconciles an already-blocked no-effect admission", () => {
  const reconcileCompanyId = "target_admission_reconcile_company";
  db.initDb();
  db.insert("companies", { id: reconcileCompanyId, slug: reconcileCompanyId, name: "Reconcile Test", status: "active", created_at: db.nowIso(), updated_at: db.nowIso() });
  const old = admission.createTargetAdmission({
    companyId: reconcileCompanyId,
    admission: admission.parseTargetAdmissionInput({ ...base, company_name: "Reconcile Test", audience: { company: "Reconcile Test", job: "Marketing Manager" } }, "2026-08-13T00:00:00.000Z"),
    idempotencyKey: "target-admission-reconcile-old"
  });
  const oldRunId = "run_target_admission_reconcile_old";
  db.insert("runs", {
    id: oldRunId,
    company_id: reconcileCompanyId,
    name: "reconciled old run",
    objective: "reconciled old run",
    status: "blocked",
    metadata_json: { external_action_executed: false, portable_remote_receipt_reconciled: true },
    created_at: db.nowIso(),
    updated_at: db.nowIso(),
    execution_source: "automation-os"
  });
  admission.attachTargetAdmissionToRun({
    companyId: reconcileCompanyId,
    admissionId: old.admission.id,
    runId: oldRunId,
    approvalId: "approval-reconcile-old",
    triggerIdempotencyKey: "target-admission-reconcile-trigger-old",
    status: "approved"
  });

  const fresh = admission.createTargetAdmission({
    companyId: reconcileCompanyId,
    admission: admission.parseTargetAdmissionInput({ ...base, job_id: "fresh-job", job_url: "https://example.com/jobs/fresh", application_url: "https://example.com/jobs/fresh/apply", company_name: "Reconcile Test", role: "Data Analyst", audience: { company: "Reconcile Test", job: "Data Analyst" } }, "2026-08-13T00:00:00.000Z"),
    idempotencyKey: "target-admission-reconcile-fresh"
  });
  assert.equal(fresh.admission.status, "registered");
  assert.equal(admission.getTargetAdmission(reconcileCompanyId, old.admission.id)?.status, "blocked");
});

test("target admission rejects secret-like references and stale source snapshots", () => {
  db.initDb();
  assert.throws(
    () => admission.parseTargetAdmissionInput({ ...base, owner_ref: "owner:token" }, "2026-08-13T00:00:00.000Z"),
    /target_admission_secret_like_reference_forbidden/
  );
  assert.throws(
    () => admission.parseTargetAdmissionInput({ ...base, source_snapshot_expires_at: "2020-01-01T00:00:00.000Z" }, "2026-08-13T00:00:00.000Z"),
    /target_admission_source_snapshot_expiry_invalid/
  );
});

test("unstarted target admission can be rebound or cancelled exactly once", () => {
  const rebindCompanyId = "target_admission_rebind_company";
  const cancelCompanyId = "target_admission_cancel_company";
  db.initDb();
  db.insert("companies", { id: rebindCompanyId, slug: rebindCompanyId, name: "Rebind Test", status: "active", created_at: db.nowIso(), updated_at: db.nowIso() });
  db.insert("companies", { id: cancelCompanyId, slug: cancelCompanyId, name: "Cancel Test", status: "active", created_at: db.nowIso(), updated_at: db.nowIso() });

  const rebind = admission.createTargetAdmission({
    companyId: rebindCompanyId,
    admission: admission.parseTargetAdmissionInput({ ...base, company_name: "Rebind Test", audience: { company: "Rebind Test", job: "Marketing Manager" } }, "2026-08-13T00:00:00.000Z"),
    idempotencyKey: "target-admission-rebind-original"
  });
  const rebound = admission.rebindUnstartedTargetAdmission({
    companyId: rebindCompanyId,
    admissionId: rebind.admission.id,
    registeredAutomationId: "automation-correct",
    idempotencyKey: "target-admission-rebind-fresh"
  });
  assert.equal(rebound.replayed, false);
  assert.equal(rebound.admission.registered_automation_id, "automation-correct");
  const reboundReplay = admission.rebindUnstartedTargetAdmission({
    companyId: rebindCompanyId,
    admissionId: rebind.admission.id,
    registeredAutomationId: "automation-correct",
    idempotencyKey: "target-admission-rebind-fresh"
  });
  assert.equal(reboundReplay.replayed, true);
  assert.equal(reboundReplay.admission.registered_automation_id, "automation-correct");

  const cancelled = admission.createTargetAdmission({
    companyId: cancelCompanyId,
    admission: admission.parseTargetAdmissionInput({ ...base, company_name: "Cancel Test", audience: { company: "Cancel Test", job: "Marketing Manager" } }, "2026-08-13T00:00:00.000Z"),
    idempotencyKey: "target-admission-cancel-original"
  });
  const cancelResult = admission.cancelUnstartedTargetAdmission({
    companyId: cancelCompanyId,
    admissionId: cancelled.admission.id,
    idempotencyKey: "target-admission-cancel-fresh"
  });
  assert.equal(cancelResult.replayed, false);
  assert.equal(cancelResult.admission.status, "cancelled");
  const cancelReplay = admission.cancelUnstartedTargetAdmission({
    companyId: cancelCompanyId,
    admissionId: cancelled.admission.id,
    idempotencyKey: "target-admission-cancel-fresh"
  });
  assert.equal(cancelReplay.replayed, true);
  assert.equal(cancelReplay.admission.status, "cancelled");
});

test("blocked target admission retry requires durable no-effect proof and advances the attempt", () => {
  const retryCompanyId = "target_admission_retry_company";
  db.initDb();
  db.insert("companies", { id: retryCompanyId, slug: retryCompanyId, name: "Retry Test", status: "active", created_at: db.nowIso(), updated_at: db.nowIso() });
  const parsed = admission.parseTargetAdmissionInput({ ...base, company_name: "Retry Test", audience: { company: "Retry Test", job: "Marketing Manager" } }, "2026-08-13T00:00:00.000Z");
  const created = admission.createTargetAdmission({ companyId: retryCompanyId, admission: parsed, idempotencyKey: "target-admission-retry-original" });
  const previousRunId = "run_target_admission_retry_previous";
  db.insert("runs", {
    id: previousRunId,
    company_id: retryCompanyId,
    name: "retry previous run",
    objective: "retry previous run",
    status: "blocked",
    metadata_json: { external_action_executed: false, portable_remote_receipt_reconciled: true },
    created_at: db.nowIso(),
    updated_at: db.nowIso(),
    execution_source: "automation-os"
  });
  db.insert("proofs", {
    id: "proof_target_admission_retry_previous",
    company_id: retryCompanyId,
    run_id: previousRunId,
    proof_type: "worker_receipt",
    label: "no-effect worker receipt",
    uri: "aos://proof/no-effect",
    size_bytes: 1,
    metadata_json: { external_action_executed: false },
    created_at: db.nowIso()
  });
  admission.attachTargetAdmissionToRun({
    companyId: retryCompanyId,
    admissionId: created.admission.id,
    runId: previousRunId,
    approvalId: null,
    triggerIdempotencyKey: "target-admission-retry-trigger-original",
    status: "approved"
  });
  const bound = admission.getTargetAdmission(retryCompanyId, created.admission.id);
  assert.ok(bound);
  const effect = effectLedger.reserveDurableTaskEffect({
    companyId: retryCompanyId,
    traceId: previousRunId,
    taskId: bound.task_contract.task_id,
    workflowId: bound.workflow_id,
    targetHash: bound.task_contract.target.digest,
    payloadHash: bound.task_contract.payload.digest!,
    audienceHash: bound.task_contract.target.audience_digest,
    idempotencyKey: "target-admission-retry-trigger-original"
  });
  assert.equal(effect.replay, false);

  const retried = admission.prepareTargetAdmissionRetry({
    companyId: retryCompanyId,
    admissionId: created.admission.id,
    idempotencyKey: "target-admission-retry-fresh"
  });
  assert.equal(retried.previousRunId, previousRunId);
  assert.equal(retried.admission.status, "registered");
  assert.equal(retried.admission.run_id, null);
  assert.equal(retried.admission.approval_id, null);
  assert.equal(retried.admission.attempt, 2);
  assert.equal(db.querySql<{ count: number }>(`SELECT count(*) AS count FROM worker_events WHERE run_id=${db.sqlValue(previousRunId)} AND event_type='target_admission_retry_prepared'`)[0].count, 1);
});

test("expired approval recovery retires the old waiting run and advances a fresh attempt", () => {
  const recoveryCompanyId = "target_admission_expired_recovery_company";
  db.initDb();
  db.insert("companies", { id: recoveryCompanyId, slug: recoveryCompanyId, name: "Expired Recovery Test", status: "active", created_at: db.nowIso(), updated_at: db.nowIso() });
  const created = admission.createTargetAdmission({
    companyId: recoveryCompanyId,
    admission: admission.parseTargetAdmissionInput({ ...base, company_name: "Expired Recovery Test", audience: { company: "Expired Recovery Test", job: "Marketing Manager" } }, "2026-08-13T00:00:00.000Z"),
    idempotencyKey: "target-admission-expired-recovery-original"
  });
  const previousRunId = "run_target_admission_expired_recovery_previous";
  const previousApprovalId = "approval_target_admission_expired_recovery_previous";
  db.insert("runs", {
    id: previousRunId,
    company_id: recoveryCompanyId,
    name: "expired approval previous run",
    objective: "expired approval previous run",
    status: "waiting_approval",
    metadata_json: { external_action_executed: false },
    created_at: db.nowIso(),
    updated_at: db.nowIso(),
    execution_source: "automation-os"
  });
  db.insert("approvals", {
    id: previousApprovalId,
    company_id: recoveryCompanyId,
    run_id: previousRunId,
    job_id: null,
    step_id: null,
    title: "expired target approval",
    requested_by: "automation-os",
    status: "pending",
    priority: "normal",
    approval_group_id: "expired-recovery-group",
    action_kind: "one_candidate_submit",
    target_account_ref_id: "auth:chrome-profile2",
    payload_hash: "a".repeat(64),
    policy_version: "automation_os_portable_external_approval_binding.v1",
    expires_at: "2020-01-01T00:00:00.000Z",
    decided_by_user_id: null,
    decision_revision: 1,
    consumed_at: null,
    consumed_by_attempt_id: null,
    resource_locks_json: [],
    created_at: db.nowIso(),
    decided_at: null,
    decision_note: null
  });
  admission.attachTargetAdmissionToRun({
    companyId: recoveryCompanyId,
    admissionId: created.admission.id,
    runId: previousRunId,
    approvalId: previousApprovalId,
    triggerIdempotencyKey: "target-admission-expired-recovery-trigger-original",
    status: "approval_pending"
  });
  const recovered = admission.prepareExpiredTargetAdmissionRecovery({
    companyId: recoveryCompanyId,
    admissionId: created.admission.id,
    idempotencyKey: "target-admission-expired-recovery-fresh",
    sourceSnapshot: { id: "snapshot:expired-recovery-fresh", expiresAt: "2099-01-01T00:00:00.000Z", supplyRunId: "run:supply:expired-recovery-fresh" }
  });
  assert.equal(recovered.previousRunId, previousRunId);
  assert.equal(recovered.previousApprovalId, previousApprovalId);
  assert.equal(recovered.admission.status, "registered");
  assert.equal(recovered.admission.run_id, null);
  assert.equal(recovered.admission.approval_id, null);
  assert.equal(recovered.admission.approval_status, "not_started");
  assert.equal(recovered.admission.attempt, 2);
  assert.equal(db.querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${db.sqlValue(previousRunId)}`)[0].status, "cancelled");
  assert.equal(JSON.parse(db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(previousRunId)}`)[0].metadata_json).external_action_executed, false);
  assert.equal(db.querySql<{ event_type: string }>(`SELECT event_type FROM worker_events WHERE run_id=${db.sqlValue(previousRunId)} ORDER BY created_at DESC LIMIT 1`)[0].event_type, "target_admission_expired_recovery_prepared");
});

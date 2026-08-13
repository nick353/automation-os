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

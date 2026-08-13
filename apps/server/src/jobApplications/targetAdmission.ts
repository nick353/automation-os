import { createHash } from "node:crypto";
import { insert, makeId, nowIso, querySql, runSqlTransaction, sqlValue } from "../db/client.js";
import { runIdempotentSqlMutation } from "../automations/idempotency.js";
import { portableBusinessTargetDigest } from "../runs/portableExternalApprovalBinding.js";
import { buildTaskContractPreview, type TaskContractV1 } from "../taskContracts/taskContract.js";
import { operationKey } from "../taskContracts/taskOsAdvanced.js";
import { getDurableTaskEffect } from "../taskContracts/taskEffectLedger.js";

export const JOB_APPLICATION_WORKFLOW_ID = "job-application-manager" as const;
export const JOB_APPLICATION_APPROVAL_ACTION = "one_candidate_submit" as const;
export const JOB_APPLICATION_APPROVAL_POLICY = "automation_os_portable_external_approval_binding.v1" as const;

const HASH = /^[a-f0-9]{64}$/u;
const SAFE_URL = /^https?:\/\/[^\s@/]+(?:\/[^\s]*)?$/iu;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,399}$/u;
const LOCALE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8})*$/u;
const SECRET_LIKE = /(token|cookie|password|secret|authorization|credential|private.?key|otp|security.?code|session)/iu;

export class TargetAdmissionError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "TargetAdmissionError";
  }
}

export type TargetAdmissionInput = {
  workflowId: typeof JOB_APPLICATION_WORKFLOW_ID;
  registeredAutomationId: string | null;
  jobUrl: string | null;
  jobId: string | null;
  applicationUrl: string | null;
  companyName: string;
  role: string;
  accountRef: string;
  audience: { company: string; job: string };
  resumeLocale: string;
  resumeSha256: string;
  payloadRef: string | null;
  payloadSha256: string | null;
  inputBundleRef: string | null;
  inputBundleSha256: string | null;
  ownerRef: string;
  authorityRef: string;
  approvalActionKind: typeof JOB_APPLICATION_APPROVAL_ACTION;
  approvalPolicyVersion: typeof JOB_APPLICATION_APPROVAL_POLICY;
  sourceSnapshotId: string;
  sourceSnapshotExpiresAt: string;
  bucket: "japan_targeted" | "overseas_global";
  sequence: number;
  attempt: number;
  supplyRunId: string;
};

export type TargetAdmissionRecord = {
  id: string;
  company_id: string;
  workflow_id: typeof JOB_APPLICATION_WORKFLOW_ID;
  registered_automation_id: string | null;
  candidate_key: string;
  job_url: string | null;
  job_id: string | null;
  application_url: string | null;
  company_name: string;
  role: string;
  account_ref: string;
  audience: { company: string; job: string };
  resume_locale: string;
  resume_sha256: string;
  payload_ref: string | null;
  payload_sha256: string | null;
  input_bundle_ref: string | null;
  input_bundle_sha256: string | null;
  owner_ref: string;
  authority_ref: string;
  approval_action_kind: string;
  approval_policy_version: string;
  approval_id: string | null;
  approval_status: string;
  idempotency_key_fingerprint: string;
  source_snapshot_id: string;
  source_snapshot_expires_at: string;
  bucket: "japan_targeted" | "overseas_global";
  sequence: number;
  attempt: number;
  supply_run_id: string;
  target_digest: string;
  status: string;
  run_id: string | null;
  trigger_idempotency_key_fingerprint: string | null;
  task_contract: TaskContractV1;
  created_at: string;
  updated_at: string;
};

type TargetAdmissionRow = Omit<TargetAdmissionRecord, "audience" | "task_contract" | "idempotency_key_fingerprint" | "trigger_idempotency_key_fingerprint"> & {
  audience_json: string;
  idempotency_key: string;
  trigger_idempotency_key: string | null;
};

function recordFromRow(row: TargetAdmissionRow): TargetAdmissionRecord {
  let audience: { company: string; job: string } = { company: "", job: "" };
  try {
    const parsed = JSON.parse(row.audience_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const value = parsed as Record<string, unknown>;
      audience = { company: String(value.company ?? ""), job: String(value.job ?? "") };
    }
  } catch {
    // Keep malformed historical rows safe and visibly incomplete.
  }
  const record = {
    ...row,
    audience,
    idempotency_key_fingerprint: fingerprint(row.idempotency_key),
    trigger_idempotency_key_fingerprint: row.trigger_idempotency_key ? fingerprint(row.trigger_idempotency_key) : null
  };
  return withTaskContract(record);
}

export function targetAdmissionApiView(row: TargetAdmissionRow | TargetAdmissionRecord): TargetAdmissionRecord {
  if ("audience_json" in row) return recordFromRow(row);
  return row;
}

export function parseTargetAdmissionInput(value: unknown, now = nowIso()): TargetAdmissionInput {
  const body = objectValue(value, "target_admission_body_required");
  rejectUnknownFields(body, new Set([
    "workflow_id", "registered_automation_id", "job_url", "job_id", "application_url", "company_name", "role",
    "account_ref", "audience", "resume_locale", "resume_sha256", "payload_ref", "payload_sha256", "input_bundle_ref",
    "input_bundle_sha256", "owner_ref", "authority_ref", "effect_specific_approval", "source_snapshot_id",
    "source_snapshot_expires_at", "bucket", "sequence", "attempt", "supply_run_id"
  ]), "target_admission_unknown_field");

  if (body.workflow_id !== JOB_APPLICATION_WORKFLOW_ID) throw new TargetAdmissionError("target_admission_workflow_id_invalid");
  const jobUrl = nullableUrl(body.job_url, "target_admission_job_url_invalid");
  const jobId = nullableRef(body.job_id, "target_admission_job_id_invalid");
  if (!jobUrl && !jobId) throw new TargetAdmissionError("target_admission_job_url_or_id_required");
  const applicationUrl = nullableUrl(body.application_url ?? jobUrl, "target_admission_application_url_invalid");
  const companyName = requiredText(body.company_name, "target_admission_company_name_required", 240);
  const role = requiredText(body.role, "target_admission_role_required", 240);
  const accountRef = requiredSafeRef(body.account_ref, "target_admission_account_ref_required");
  const audienceValue = objectValue(body.audience, "target_admission_audience_required");
  rejectUnknownFields(audienceValue, new Set(["company", "job"]), "target_admission_audience_unknown_field");
  const audience = {
    company: requiredText(audienceValue.company, "target_admission_audience_company_required", 240),
    job: requiredText(audienceValue.job, "target_admission_audience_job_required", 240)
  };
  const resumeLocale = requiredText(body.resume_locale, "target_admission_resume_locale_required", 40);
  if (!LOCALE.test(resumeLocale)) throw new TargetAdmissionError("target_admission_resume_locale_invalid");
  const resumeSha256 = requiredHash(body.resume_sha256, "target_admission_resume_sha256_invalid");
  const payloadRef = nullableImmutableRef(body.payload_ref, "target_admission_payload_ref_invalid");
  const payloadSha256 = nullableHash(body.payload_sha256, "target_admission_payload_sha256_invalid");
  const inputBundleRef = nullableImmutableRef(body.input_bundle_ref, "target_admission_input_bundle_ref_invalid");
  const inputBundleSha256 = nullableHash(body.input_bundle_sha256, "target_admission_input_bundle_sha256_invalid");
  if ((!payloadRef || !payloadSha256) && (!inputBundleRef || !inputBundleSha256)) {
    throw new TargetAdmissionError("target_admission_payload_or_input_bundle_ref_required");
  }
  const ownerRef = requiredSafeRef(body.owner_ref, "target_admission_owner_ref_required");
  const authorityRef = requiredSafeRef(body.authority_ref, "target_admission_authority_ref_required");
  const approval = objectValue(body.effect_specific_approval, "target_admission_effect_approval_required");
  rejectUnknownFields(approval, new Set(["action_kind", "policy_version"]), "target_admission_effect_approval_unknown_field");
  if (approval.action_kind !== JOB_APPLICATION_APPROVAL_ACTION) throw new TargetAdmissionError("target_admission_effect_approval_action_invalid");
  if (approval.policy_version !== JOB_APPLICATION_APPROVAL_POLICY) throw new TargetAdmissionError("target_admission_effect_approval_policy_invalid");
  const sourceSnapshotId = requiredSafeRef(body.source_snapshot_id, "target_admission_source_snapshot_id_required");
  const sourceSnapshotExpiresAt = isoFuture(body.source_snapshot_expires_at, now, "target_admission_source_snapshot_expiry_invalid");
  const bucket = body.bucket === "japan_targeted" || body.bucket === "overseas_global" ? body.bucket : (() => { throw new TargetAdmissionError("target_admission_bucket_invalid"); })();
  const sequence = nonNegativeInteger(body.sequence, "target_admission_sequence_invalid");
  const attempt = positiveInteger(body.attempt, "target_admission_attempt_invalid");
  const supplyRunId = requiredSafeRef(body.supply_run_id, "target_admission_supply_run_id_required");
  const registeredAutomationId = body.registered_automation_id === undefined || body.registered_automation_id === null
    ? null
    : requiredSafeRef(body.registered_automation_id, "target_admission_registered_automation_id_invalid");
  if (SECRET_LIKE.test(ownerRef) || SECRET_LIKE.test(authorityRef) || SECRET_LIKE.test(accountRef)) {
    throw new TargetAdmissionError("target_admission_secret_like_reference_forbidden");
  }
  return {
    workflowId: JOB_APPLICATION_WORKFLOW_ID,
    registeredAutomationId,
    jobUrl,
    jobId,
    applicationUrl,
    companyName,
    role,
    accountRef,
    audience,
    resumeLocale,
    resumeSha256,
    payloadRef,
    payloadSha256,
    inputBundleRef,
    inputBundleSha256,
    ownerRef,
    authorityRef,
    approvalActionKind: JOB_APPLICATION_APPROVAL_ACTION,
    approvalPolicyVersion: JOB_APPLICATION_APPROVAL_POLICY,
    sourceSnapshotId,
    sourceSnapshotExpiresAt,
    bucket,
    sequence,
    attempt,
    supplyRunId
  };
}

export function buildTargetAdmissionInputBundle(input: TargetAdmissionInput, candidateKey: string): Record<string, string | number> {
  const payloadHash = input.payloadSha256 ?? input.inputBundleSha256;
  if (!payloadHash) throw new TargetAdmissionError("target_admission_payload_hash_missing");
  return {
    account_ref: input.accountRef,
    target_key: candidateKey,
    ...(input.jobUrl ? { job_url: input.jobUrl, application_url: input.applicationUrl ?? input.jobUrl } : {}),
    ...(input.jobId ? { job_id: input.jobId } : {}),
    candidate_key: candidateKey,
    bucket: input.bucket,
    sequence: input.sequence,
    attempt: input.attempt,
    source_snapshot_id: input.sourceSnapshotId,
    source_snapshot_expires_at: input.sourceSnapshotExpiresAt,
    supply_run_id: input.supplyRunId,
    company: input.companyName,
    role: input.role,
    audience: JSON.stringify(input.audience),
    resume_locale: input.resumeLocale,
    resume_sha256: input.resumeSha256,
    owner_ref: input.ownerRef,
    authority_ref: input.authorityRef,
    payload_hash: payloadHash,
    ...(input.inputBundleRef ? { input_bundle_ref: input.inputBundleRef } : {})
  };
}

export function buildTargetAdmissionInputBundleFromRecord(record: TargetAdmissionRecord): Record<string, string | number> {
  const payloadHash = record.payload_sha256 ?? record.input_bundle_sha256;
  if (!payloadHash) throw new TargetAdmissionError("target_admission_payload_hash_missing");
  return {
    account_ref: record.account_ref,
    target_key: record.candidate_key,
    ...(record.job_url ? { job_url: record.job_url, application_url: record.application_url ?? record.job_url } : {}),
    ...(record.job_id ? { job_id: record.job_id } : {}),
    candidate_key: record.candidate_key,
    bucket: record.bucket,
    sequence: record.sequence,
    attempt: record.attempt,
    source_snapshot_id: record.source_snapshot_id,
    source_snapshot_expires_at: record.source_snapshot_expires_at,
    supply_run_id: record.supply_run_id,
    company: record.company_name,
    role: record.role,
    audience: JSON.stringify(record.audience),
    resume_locale: record.resume_locale,
    resume_sha256: record.resume_sha256,
    owner_ref: record.owner_ref,
    authority_ref: record.authority_ref,
    payload_hash: payloadHash,
    ...(record.input_bundle_ref ? { input_bundle_ref: record.input_bundle_ref } : {})
  };
}

export function createTargetAdmission(input: {
  companyId: string;
  admission: TargetAdmissionInput;
  idempotencyKey: string;
}): { replayed: boolean; admission: TargetAdmissionRecord } {
  const companyId = requiredSafeRef(input.companyId, "company_id_required");
  const idempotencyKey = requiredSafeRef(input.idempotencyKey, "target_admission_idempotency_key_required");
  const candidateKey = `job_target_${createHash("sha256").update(JSON.stringify({
    job_url: input.admission.jobUrl,
    job_id: input.admission.jobId,
    company: input.admission.companyName,
    role: input.admission.role
  })).digest("hex").slice(0, 32)}`;
  const bundle = buildTargetAdmissionInputBundle(input.admission, candidateKey);
  const targetDigest = portableBusinessTargetDigest(bundle);
  const id = makeId("job_target_admission");
  const createdAt = nowIso();
  const request = {
    workflow_id: input.admission.workflowId,
    registered_automation_id: input.admission.registeredAutomationId,
    candidate_key: candidateKey,
    job_url: input.admission.jobUrl,
    job_id: input.admission.jobId,
    application_url: input.admission.applicationUrl,
    company_name: input.admission.companyName,
    role: input.admission.role,
    account_ref: input.admission.accountRef,
    audience: input.admission.audience,
    resume_locale: input.admission.resumeLocale,
    resume_sha256: input.admission.resumeSha256,
    payload_ref: input.admission.payloadRef,
    payload_sha256: input.admission.payloadSha256,
    input_bundle_ref: input.admission.inputBundleRef,
    input_bundle_sha256: input.admission.inputBundleSha256,
    owner_ref: input.admission.ownerRef,
    authority_ref: input.admission.authorityRef,
    approval_action_kind: input.admission.approvalActionKind,
    approval_policy_version: input.admission.approvalPolicyVersion,
    source_snapshot_id: input.admission.sourceSnapshotId,
    source_snapshot_expires_at: input.admission.sourceSnapshotExpiresAt,
    bucket: input.admission.bucket,
    sequence: input.admission.sequence,
    attempt: input.admission.attempt,
    supply_run_id: input.admission.supplyRunId
  };
  const response = targetAdmissionResponse({
    id,
    companyId,
    input: input.admission,
    candidateKey,
    targetDigest,
    idempotencyKey,
    createdAt
  });
  const result = runIdempotentSqlMutation({
    companyId,
    scope: "job_application_target_admission",
    key: idempotencyKey,
    request,
    response,
    resourceSteps: [{
      sql: `INSERT INTO job_application_target_admissions
        (id, company_id, workflow_id, registered_automation_id, candidate_key, job_url, job_id, application_url,
         company_name, role, account_ref, audience_json, resume_locale, resume_sha256, payload_ref, payload_sha256,
         input_bundle_ref, input_bundle_sha256, owner_ref, authority_ref, approval_action_kind, approval_policy_version,
         approval_id, approval_status, idempotency_key, source_snapshot_id, source_snapshot_expires_at, bucket, sequence,
         attempt, supply_run_id, target_digest, status, run_id, trigger_idempotency_key, created_at, updated_at)
        VALUES (${sqlValue(id)}, ${sqlValue(companyId)}, ${sqlValue(input.admission.workflowId)}, ${sqlValue(input.admission.registeredAutomationId)},
          ${sqlValue(candidateKey)}, ${sqlValue(input.admission.jobUrl)}, ${sqlValue(input.admission.jobId)}, ${sqlValue(input.admission.applicationUrl)},
          ${sqlValue(input.admission.companyName)}, ${sqlValue(input.admission.role)}, ${sqlValue(input.admission.accountRef)}, ${sqlValue(JSON.stringify(input.admission.audience))},
          ${sqlValue(input.admission.resumeLocale)}, ${sqlValue(input.admission.resumeSha256)}, ${sqlValue(input.admission.payloadRef)}, ${sqlValue(input.admission.payloadSha256)},
          ${sqlValue(input.admission.inputBundleRef)}, ${sqlValue(input.admission.inputBundleSha256)}, ${sqlValue(input.admission.ownerRef)}, ${sqlValue(input.admission.authorityRef)},
          ${sqlValue(input.admission.approvalActionKind)}, ${sqlValue(input.admission.approvalPolicyVersion)}, NULL, 'not_started', ${sqlValue(idempotencyKey)},
          ${sqlValue(input.admission.sourceSnapshotId)}, ${sqlValue(input.admission.sourceSnapshotExpiresAt)}, ${sqlValue(input.admission.bucket)},
          ${input.admission.sequence}, ${input.admission.attempt}, ${sqlValue(input.admission.supplyRunId)}, ${sqlValue(targetDigest)}, 'registered', NULL, NULL,
          ${sqlValue(createdAt)}, ${sqlValue(createdAt)})`,
      expectChanges: 1
    }]
  });
  return { replayed: result.replayed, admission: targetAdmissionApiView(result.response) };
}

export function listTargetAdmissions(companyId: string, limit = 20): TargetAdmissionRecord[] {
  const rows = querySql<TargetAdmissionRow>(`
    SELECT * FROM job_application_target_admissions
    WHERE company_id=${sqlValue(requiredSafeRef(companyId, "company_id_required"))}
      AND workflow_id=${sqlValue(JOB_APPLICATION_WORKFLOW_ID)}
    ORDER BY created_at DESC, id DESC LIMIT ${Math.max(1, Math.min(100, Math.floor(limit)))}
  `);
  return rows.map(recordFromRow);
}

export function getTargetAdmission(companyId: string, admissionId: string): TargetAdmissionRecord | null {
  const row = querySql<TargetAdmissionRow>(`
    SELECT * FROM job_application_target_admissions
    WHERE company_id=${sqlValue(requiredSafeRef(companyId, "company_id_required"))}
      AND id=${sqlValue(requiredSafeRef(admissionId, "target_admission_id_required"))}
      AND workflow_id=${sqlValue(JOB_APPLICATION_WORKFLOW_ID)} LIMIT 1
  `)[0];
  return row ? recordFromRow(row) : null;
}

export function attachTargetAdmissionToRun(input: {
  companyId: string;
  admissionId: string;
  runId: string;
  approvalId: string | null;
  triggerIdempotencyKey: string;
  status?: "approval_pending" | "approved" | "running" | "blocked";
}): TargetAdmissionRecord {
  const companyId = requiredSafeRef(input.companyId, "company_id_required");
  const current = getTargetAdmission(companyId, input.admissionId);
  if (!current) throw new TargetAdmissionError("target_admission_not_found");
  if (Date.parse(current.source_snapshot_expires_at) <= Date.now()) throw new TargetAdmissionError("target_admission_source_snapshot_expired");
  if (current.run_id && current.run_id !== input.runId) throw new TargetAdmissionError("target_admission_already_bound");
  const now = nowIso();
  runSqlTransaction([{
    sql: `UPDATE job_application_target_admissions
      SET run_id=${sqlValue(input.runId)}, approval_id=${sqlValue(input.approvalId)}, approval_status=${sqlValue(input.approvalId ? "pending" : current.approval_status)},
          trigger_idempotency_key=${sqlValue(input.triggerIdempotencyKey)}, status=${sqlValue(input.status ?? "approval_pending")}, updated_at=${sqlValue(now)}
      WHERE id=${sqlValue(input.admissionId)} AND company_id=${sqlValue(companyId)}
        AND (run_id IS NULL OR run_id=${sqlValue(input.runId)})
        AND source_snapshot_expires_at>${sqlValue(now)}`,
    expectChanges: 1
  }]);
  const updated = getTargetAdmission(companyId, input.admissionId);
  if (!updated) throw new TargetAdmissionError("target_admission_readback_missing");
  return updated;
}

/**
 * Reset a blocked target admission only when the previous run has a durable
 * no-effect receipt and its Effect Ledger record is neither ambiguous nor
 * retry-forbidden.  This creates a bounded retry point without replaying the
 * old run or mutating an already-effectful admission.
 */
export function prepareTargetAdmissionRetry(input: {
  companyId: string;
  admissionId: string;
  idempotencyKey: string;
}): { admission: TargetAdmissionRecord; previousRunId: string } {
  const companyId = requiredSafeRef(input.companyId, "company_id_required");
  const admissionId = requiredSafeRef(input.admissionId, "target_admission_id_required");
  const idempotencyKey = requiredSafeRef(input.idempotencyKey, "target_admission_retry_idempotency_key_required");
  const current = getTargetAdmission(companyId, admissionId);
  if (!current) throw new TargetAdmissionError("target_admission_not_found");
  if (current.status !== "blocked" || !current.run_id) {
    throw new TargetAdmissionError("target_admission_retry_requires_blocked_run");
  }
  if (Date.parse(current.source_snapshot_expires_at) <= Date.now()) {
    throw new TargetAdmissionError("target_admission_source_snapshot_expired");
  }
  const currentIdempotencyKey = querySql<{ idempotency_key: string }>(`
    SELECT idempotency_key FROM job_application_target_admissions
    WHERE id=${sqlValue(admissionId)} AND company_id=${sqlValue(companyId)} LIMIT 1
  `)[0]?.idempotency_key;
  if (currentIdempotencyKey === idempotencyKey) {
    throw new TargetAdmissionError("target_admission_retry_idempotency_reused");
  }

  const previousRunId = current.run_id;
  const run = querySql<{ status: string; metadata_json: string }>(`
    SELECT status, metadata_json FROM runs
    WHERE id=${sqlValue(previousRunId)} AND company_id=${sqlValue(companyId)} LIMIT 1
  `)[0];
  if (!run || run.status !== "blocked") throw new TargetAdmissionError("target_admission_retry_previous_run_not_blocked");
  const runMetadata = parseJsonRecord(run.metadata_json);
  if (runMetadata.external_action_executed === true) {
    throw new TargetAdmissionError("target_admission_retry_external_effect_already_executed");
  }

  const proof = querySql<{ metadata_json: string }>(`
    SELECT metadata_json FROM proofs
    WHERE run_id=${sqlValue(previousRunId)} AND proof_type=${sqlValue("worker_receipt")}
    ORDER BY created_at DESC LIMIT 1
  `)[0];
  const proofMetadata = proof ? parseJsonRecord(proof.metadata_json) : null;
  if (!proofMetadata || proofMetadata.external_action_executed !== false) {
    throw new TargetAdmissionError("target_admission_retry_no_effect_proof_missing");
  }

  const previousEffectKey = targetAdmissionEffectKey({ companyId, admissionId });
  const previousEffect = previousEffectKey ? getDurableTaskEffect(companyId, previousEffectKey) : null;
  if (!previousEffect) throw new TargetAdmissionError("target_admission_retry_effect_ledger_missing");
  if (previousEffect.external_action_executed || previousEffect.ambiguous || previousEffect.retry_forbidden) {
    throw new TargetAdmissionError("target_admission_retry_effect_not_replayable");
  }

  const now = nowIso();
  runSqlTransaction([{
    sql: `UPDATE job_application_target_admissions
      SET approval_id=NULL, approval_status='not_started', idempotency_key=${sqlValue(idempotencyKey)},
          source_snapshot_id=${sqlValue(current.source_snapshot_id)}, run_id=NULL, trigger_idempotency_key=NULL,
          attempt=${current.attempt + 1}, status='registered', updated_at=${sqlValue(now)}
      WHERE id=${sqlValue(admissionId)} AND company_id=${sqlValue(companyId)}
        AND status='blocked' AND run_id=${sqlValue(previousRunId)} AND idempotency_key<>${sqlValue(idempotencyKey)}`,
    expectChanges: 1
  }]);
  insert("worker_events", {
    id: makeId("evt"),
    company_id: companyId,
    run_id: previousRunId,
    step_id: null,
    lane_id: null,
    event_type: "target_admission_retry_prepared",
    message: "Blocked target admission reset after durable no-effect proof; previous run will not be replayed",
    created_at: now,
    metadata_json: {
      schema: "aos.target_admission_retry.v1",
      admission_id: admissionId,
      previous_run_id: previousRunId,
      previous_effect_operation_key: previousEffectKey,
      external_action_executed: false,
      restart_point: "fresh_target_bound_trigger",
    }
  });
  const updated = getTargetAdmission(companyId, admissionId);
  if (!updated) throw new TargetAdmissionError("target_admission_retry_readback_missing");
  return { admission: updated, previousRunId };
}

export function updateTargetAdmissionStatus(input: { companyId: string; admissionId: string; status: string; approvalStatus?: string; approvalId?: string | null }): TargetAdmissionRecord {
  const companyId = requiredSafeRef(input.companyId, "company_id_required");
  const current = getTargetAdmission(companyId, input.admissionId);
  if (!current) throw new TargetAdmissionError("target_admission_not_found");
  const now = nowIso();
  runSqlTransaction([{
    sql: `UPDATE job_application_target_admissions SET status=${sqlValue(input.status)}, approval_status=${sqlValue(input.approvalStatus ?? current.approval_status)}, approval_id=${sqlValue(input.approvalId === undefined ? current.approval_id : input.approvalId)}, updated_at=${sqlValue(now)} WHERE id=${sqlValue(current.id)} AND company_id=${sqlValue(companyId)}`,
    expectChanges: 1
  }]);
  const updated = getTargetAdmission(companyId, current.id);
  if (!updated) throw new TargetAdmissionError("target_admission_readback_missing");
  return updated;
}

export function syncTargetAdmissionFromReceipt(input: {
  companyId: string;
  runId: string;
  status: "complete" | "partial" | "blocked";
  externalActionExecuted: boolean;
  sameRunSourceSync: boolean;
  readbackVerified: boolean;
  cleanupVerified: boolean;
}): TargetAdmissionRecord | null {
  const row = querySql<TargetAdmissionRow>(`
    SELECT * FROM job_application_target_admissions
    WHERE company_id=${sqlValue(requiredSafeRef(input.companyId, "company_id_required"))}
      AND run_id=${sqlValue(requiredSafeRef(input.runId, "run_id_required"))}
    ORDER BY updated_at DESC LIMIT 1
  `)[0];
  if (!row) return null;
  const reconciled = input.externalActionExecuted && input.status === "complete" && input.sameRunSourceSync && input.readbackVerified && input.cleanupVerified;
  const nextStatus = reconciled ? "reconciled" : input.externalActionExecuted ? "submitted" : input.status === "blocked" ? "blocked" : "approval_pending";
  const nextApprovalStatus = input.externalActionExecuted || reconciled ? "approved" : row.approval_status;
  const now = nowIso();
  runSqlTransaction([{
    sql: `UPDATE job_application_target_admissions SET status=${sqlValue(nextStatus)}, approval_status=${sqlValue(nextApprovalStatus)}, updated_at=${sqlValue(now)} WHERE id=${sqlValue(row.id)} AND company_id=${sqlValue(input.companyId)}`,
    expectChanges: 1
  }]);
  const updated = getTargetAdmission(input.companyId, row.id);
  return updated;
}

export function syncTargetAdmissionApproval(input: { companyId: string; approvalId: string; approvalStatus: string }): TargetAdmissionRecord | null {
  const companyId = requiredSafeRef(input.companyId, "company_id_required");
  const row = querySql<TargetAdmissionRow>(`
    SELECT * FROM job_application_target_admissions
    WHERE company_id=${sqlValue(companyId)} AND approval_id=${sqlValue(requiredSafeRef(input.approvalId, "approval_id_required"))}
    LIMIT 1
  `)[0];
  if (!row) return null;
  const nextStatus = input.approvalStatus === "approved" ? (row.run_id ? "approved" : row.status) : input.approvalStatus === "rejected" ? "rejected" : row.status;
  const now = nowIso();
  runSqlTransaction([{
    sql: `UPDATE job_application_target_admissions SET approval_status=${sqlValue(input.approvalStatus)}, status=${sqlValue(nextStatus)}, updated_at=${sqlValue(now)} WHERE id=${sqlValue(row.id)} AND company_id=${sqlValue(companyId)}`,
    expectChanges: 1
  }]);
  return getTargetAdmission(companyId, row.id);
}

export function targetAdmissionEffectKey(input: { companyId: string; admissionId: string }): string | null {
  const companyId = requiredSafeRef(input.companyId, "company_id_required");
  const admissionId = requiredSafeRef(input.admissionId, "target_admission_id_required");
  const raw = querySql<{ trigger_idempotency_key: string | null }>(`SELECT trigger_idempotency_key FROM job_application_target_admissions WHERE company_id=${sqlValue(companyId)} AND id=${sqlValue(admissionId)} LIMIT 1`)[0];
  const record = getTargetAdmission(companyId, admissionId);
  if (!raw?.trigger_idempotency_key || !record?.task_contract.payload.digest) return null;
  return operationKey({
    taskId: record.task_contract.task_id,
    targetHash: record.task_contract.target.digest,
    payloadHash: record.task_contract.payload.digest,
    audienceHash: record.task_contract.target.audience_digest,
    idempotencyKey: raw.trigger_idempotency_key
  });
}

function targetAdmissionResponse(input: { id: string; companyId: string; input: TargetAdmissionInput; candidateKey: string; targetDigest: string; createdAt: string; idempotencyKey: string }): TargetAdmissionRecord {
  return withTaskContract({
    id: input.id,
    company_id: input.companyId,
    workflow_id: JOB_APPLICATION_WORKFLOW_ID,
    registered_automation_id: input.input.registeredAutomationId,
    candidate_key: input.candidateKey,
    job_url: input.input.jobUrl,
    job_id: input.input.jobId,
    application_url: input.input.applicationUrl,
    company_name: input.input.companyName,
    role: input.input.role,
    account_ref: input.input.accountRef,
    audience: input.input.audience,
    resume_locale: input.input.resumeLocale,
    resume_sha256: input.input.resumeSha256,
    payload_ref: input.input.payloadRef,
    payload_sha256: input.input.payloadSha256,
    input_bundle_ref: input.input.inputBundleRef,
    input_bundle_sha256: input.input.inputBundleSha256,
    owner_ref: input.input.ownerRef,
    authority_ref: input.input.authorityRef,
    approval_action_kind: input.input.approvalActionKind,
    approval_policy_version: input.input.approvalPolicyVersion,
    approval_id: null,
    approval_status: "not_started",
    idempotency_key_fingerprint: fingerprint(input.idempotencyKey),
    source_snapshot_id: input.input.sourceSnapshotId,
    source_snapshot_expires_at: input.input.sourceSnapshotExpiresAt,
    bucket: input.input.bucket,
    sequence: input.input.sequence,
    attempt: input.input.attempt,
    supply_run_id: input.input.supplyRunId,
    target_digest: input.targetDigest,
    status: "registered",
    run_id: null,
    trigger_idempotency_key_fingerprint: null,
    created_at: input.createdAt,
    updated_at: input.createdAt
  });
}

function withTaskContract(record: Omit<TargetAdmissionRecord, "task_contract">): TargetAdmissionRecord {
  const payloadDigest = record.payload_sha256 ?? record.input_bundle_sha256;
  const audienceRef = `audience_${createHash("sha256").update(JSON.stringify(record.audience), "utf8").digest("hex").slice(0, 24)}`;
  const authorityDigest = createHash("sha256").update(record.authority_ref, "utf8").digest("hex");
  const contract = buildTaskContractPreview({
    contract_id: `task_contract_${record.id}`,
    task_id: record.candidate_key,
    workflow_id: record.workflow_id,
    task_class: "external_effect",
    intent_kind: "submit",
    intent_ref: `workflow_${record.workflow_id}`,
    target_ref: record.candidate_key,
    target_digest: record.target_digest,
    account_ref: record.account_ref,
    payload_ref: record.payload_ref ?? record.input_bundle_ref ?? `payload_${payloadDigest ?? "missing"}`,
    payload_digest: payloadDigest,
    audience: audienceRef,
    owner: record.owner_ref,
    authority_ref: record.authority_ref,
    authority_digest: authorityDigest,
    authority_scope: record.approval_action_kind,
    idempotency_key: `admission_${record.idempotency_key_fingerprint}`
  });
  return { ...record, task_contract: contract };
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function objectValue(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TargetAdmissionError(code);
  return value as Record<string, unknown>;
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: Set<string>, code: string): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new TargetAdmissionError(code);
}

function requiredText(value: unknown, code: string, max: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > max || SECRET_LIKE.test(normalized)) throw new TargetAdmissionError(code);
  return normalized;
}

function requiredSafeRef(value: unknown, code: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 400 || !SAFE_REF.test(normalized)) throw new TargetAdmissionError(code);
  return normalized;
}

function nullableRef(value: unknown, code: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredSafeRef(value, code);
}

function nullableImmutableRef(value: unknown, code: string): string | null {
  const ref = nullableRef(value, code);
  if (!ref) return null;
  if (/^(?:file:|data:|javascript:)/iu.test(ref) || /(?:\/tmp\/|data\/artifacts|artifact)/iu.test(ref)) throw new TargetAdmissionError(code);
  return ref;
}

function nullableUrl(value: unknown, code: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!SAFE_URL.test(normalized) || normalized.length > 2000) throw new TargetAdmissionError(code);
  return normalized;
}

function requiredHash(value: unknown, code: string): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!HASH.test(normalized)) throw new TargetAdmissionError(code);
  return normalized;
}

function nullableHash(value: unknown, code: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredHash(value, code);
}

function isoFuture(value: unknown, now: string, code: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.parse(now)) throw new TargetAdmissionError(code);
  return new Date(value).toISOString();
}

function nonNegativeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TargetAdmissionError(code);
  return Number(value);
}

function positiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new TargetAdmissionError(code);
  return Number(value);
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

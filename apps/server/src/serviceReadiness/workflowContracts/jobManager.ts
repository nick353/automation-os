import { createHash } from "node:crypto";

import {
  SERVICE_READINESS_SCHEMA_V1,
  ServiceReadinessContractError,
  ServiceReadinessEffectLedgerV1,
  parseServiceReadinessEvidenceV1,
  type ServiceReadinessEvidenceV1,
  type ServiceReadinessValidationOptionsV1
} from "../foundationContracts.js";

/** The versioned, workflow-owned envelope for one Job Manager decision. */
export const JOB_MANAGER_WORKFLOW_CONTRACT_SCHEMA_V1 = "job_manager.workflow_contract.v1" as const;
export const JOB_MANAGER_CONTRACT_SCHEMA_V1 = JOB_MANAGER_WORKFLOW_CONTRACT_SCHEMA_V1;
export const JOB_MANAGER_SCHEMA_V1 = JOB_MANAGER_WORKFLOW_CONTRACT_SCHEMA_V1;
export const JOB_MANAGER_WORKFLOW_ID_V1 = "job-application-manager" as const;

export type JobManagerRoleV1 = "submit" | "follow_up";

export type JobManagerWorkflowContractV1 = Omit<ServiceReadinessEvidenceV1, "schema" | "safe_resume_step"> & {
  schema: typeof JOB_MANAGER_WORKFLOW_CONTRACT_SCHEMA_V1;
  account_ref: string;
  job_board: string;
  target_url: string;
  job_id: string | null;
  queue_id: string | null;
  role: JobManagerRoleV1;
  message_thread_fingerprint_hash: string | null;
  capture_blocker: string | null;
  submitted_confirmed: boolean;
  readback_url: string | null;
  safe_restart: string | null;
};

export type JobManagerServiceReadinessContractV1 = JobManagerWorkflowContractV1;

export type JobManagerValidationOptionsV1 = ServiceReadinessValidationOptionsV1 & {
  /** Bind a replayed receipt to the target URL selected by the caller. */
  expected_target_url?: string;
};

export type JobManagerServiceReadinessValidationOptionsV1 = JobManagerValidationOptionsV1;

export type JobManagerValidationSuccessV1 = {
  ok: true;
  status: "ok";
  value: JobManagerWorkflowContractV1;
};

export type JobManagerValidationFailureV1 = {
  ok: false;
  status: "blocked";
  exact_blocker: string;
};

export type JobManagerValidationResultV1 =
  | JobManagerValidationSuccessV1
  | JobManagerValidationFailureV1;

const hashPattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const roles = new Set<JobManagerRoleV1>(["submit", "follow_up"]);

const foundationFields = new Set([
  "schema",
  "root_id",
  "workflow_id",
  "run_id",
  "stage_id",
  "attempt_id",
  "fencing_token",
  "capability_id",
  "turn_id",
  "session_id",
  "nonce",
  "capability_mode",
  "provider",
  "account_ref",
  "target_hash",
  "payload_hash",
  "effect_key",
  "effect_class",
  "status",
  "external_action_executed",
  "provider_receipt_hash",
  "cleanup_receipt_hash",
  "exact_blocker"
]);

const adapterFields = new Set([
  "job_board",
  "target_url",
  "job_id",
  "queue_id",
  "role",
  "message_thread_fingerprint_hash",
  "capture_blocker",
  "submitted_confirmed",
  "readback_url",
  "safe_restart",
  // This marker is recognized only so stale callers get a deterministic
  // blocker rather than silently carrying an old request lineage forward.
  "request_reuse_marker"
]);

const requiredFields = [
  "schema",
  "root_id",
  "workflow_id",
  "run_id",
  "stage_id",
  "attempt_id",
  "fencing_token",
  "capability_id",
  "turn_id",
  "session_id",
  "nonce",
  "capability_mode",
  "provider",
  "account_ref",
  "job_board",
  "target_url",
  "target_hash",
  "payload_hash",
  "job_id",
  "queue_id",
  "role",
  "effect_key",
  "effect_class",
  "status",
  "external_action_executed",
  "provider_receipt_hash",
  "message_thread_fingerprint_hash",
  "capture_blocker",
  "submitted_confirmed",
  "readback_url",
  "cleanup_receipt_hash",
  "exact_blocker",
  "safe_restart"
] as const;

export class JobManagerContractError extends ServiceReadinessContractError {
  constructor(code: string) {
    super(code);
    this.name = "JobManagerContractError";
  }
}

/**
 * Bounded, in-memory effect ledger for one adapter sequence.  It has no
 * persistence or runtime side effects; callers explicitly scope its lifetime
 * to the validation batch they are reconciling.
 */
export class JobManagerEffectLedgerV1 extends ServiceReadinessEffectLedgerV1 {
  private entries = 0;

  constructor(private readonly maxEntries = 128) {
    super();
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 4096) {
      throw new JobManagerContractError("job_manager_effect_ledger_bound_invalid");
    }
  }

  override record(evidence: ServiceReadinessEvidenceV1): void {
    if (this.has(evidence.effect_key)) {
      throw new JobManagerContractError(`job_manager_effect_replay_forbidden:${evidence.effect_key}`);
    }
    if (this.entries >= this.maxEntries) {
      throw new JobManagerContractError("job_manager_effect_ledger_bound_exceeded");
    }
    super.record(evidence);
    this.entries += 1;
  }
}

/** Parse one immutable, flat Job Manager service-readiness record. */
export function parseJobManagerWorkflowContractV1(
  value: unknown,
  options: JobManagerValidationOptionsV1 = {}
): JobManagerWorkflowContractV1 {
  const body = objectValue(value, "job_manager_contract_required");
  rejectUnknownFields(body);
  requireFields(body);

  if (body.schema !== JOB_MANAGER_WORKFLOW_CONTRACT_SCHEMA_V1) {
    throw new JobManagerContractError("job_manager_contract_schema_invalid");
  }
  if (body.workflow_id !== JOB_MANAGER_WORKFLOW_ID_V1) {
    throw new JobManagerContractError("job_manager_workflow_id_invalid");
  }

  if (Object.prototype.hasOwnProperty.call(body, "request_reuse_marker")) {
    throw new JobManagerContractError("job_manager_old_request_reuse_marker_forbidden");
  }

  const targetUrl = supportedUrl(body.target_url, "job_manager_target_url_invalid");
  if (options.expected_target_url !== undefined && targetUrl !== options.expected_target_url) {
    throw new JobManagerContractError("job_manager_target_url_binding_mismatch");
  }
  const targetHash = hashValue(body.target_hash, "job_manager_target_hash_invalid");
  if (sha256(targetUrl) !== targetHash) {
    throw new JobManagerContractError("job_manager_target_hash_binding_mismatch");
  }

  const accountRef = requiredText(body.account_ref, "job_manager_account_ref_invalid", 256);
  const jobBoard = requiredIdentifier(body.job_board, "job_manager_job_board_invalid");
  const role = enumValue(body.role, roles, "job_manager_role_invalid");
  const jobId = nullableIdentifier(body.job_id, "job_manager_job_id_invalid");
  const queueId = nullableIdentifier(body.queue_id, "job_manager_queue_id_invalid");
  if (!jobId && !queueId) {
    throw new JobManagerContractError("job_manager_job_or_queue_id_required");
  }

  const fingerprint = nullableHash(
    body.message_thread_fingerprint_hash,
    "job_manager_message_thread_fingerprint_hash_invalid"
  );
  const captureBlocker = nullableText(body.capture_blocker, "job_manager_capture_blocker_invalid", 240);
  if (!fingerprint && !captureBlocker) {
    throw new JobManagerContractError("job_manager_message_thread_identity_or_capture_blocker_required");
  }
  if (fingerprint && captureBlocker) {
    throw new JobManagerContractError("job_manager_capture_identity_and_blocker_mutually_exclusive");
  }

  const submittedConfirmed = booleanValue(
    body.submitted_confirmed,
    "job_manager_submitted_confirmed_invalid"
  );
  const readbackUrl = nullableSupportedUrl(body.readback_url, "job_manager_readback_url_invalid");
  const safeRestart = nullableText(body.safe_restart, "job_manager_safe_restart_invalid", 240);
  const externalActionExecuted = booleanValue(
    body.external_action_executed,
    "job_manager_external_action_executed_invalid"
  );
  if (submittedConfirmed && !readbackUrl) {
    throw new JobManagerContractError("job_manager_confirmed_readback_url_required");
  }
  if (!submittedConfirmed && readbackUrl) {
    throw new JobManagerContractError("job_manager_unconfirmed_readback_url_forbidden");
  }
  if (submittedConfirmed && !externalActionExecuted) {
    throw new JobManagerContractError("job_manager_confirmed_external_action_required");
  }
  const providerReceiptHash = nullableHash(body.provider_receipt_hash, "job_manager_provider_receipt_hash_invalid");
  if (submittedConfirmed && providerReceiptHash === null) {
    throw new JobManagerContractError("job_manager_confirmed_provider_receipt_required");
  }
  if (role === "submit" && submittedConfirmed && body.status !== "succeeded") {
    throw new JobManagerContractError("job_manager_confirmed_submit_status_invalid");
  }

  const foundationBody = Object.fromEntries(
    [...foundationFields]
      .filter((field) => field in body)
      .map((field) => [field, body[field]])
  );
  const foundation = parseServiceReadinessEvidenceV1(
    {
      ...foundationBody,
      account_ref: accountRef,
      target_hash: targetHash,
      external_action_executed: externalActionExecuted,
      schema: SERVICE_READINESS_SCHEMA_V1,
      provider_receipt_hash: providerReceiptHash,
      safe_resume_step: safeRestart
    },
    options
  );

  // Foundation normalizes status=ambiguous to reconciliation_required.  The
  // adapter deliberately exposes that normalized status and never reports an
  // ambiguous external effect as successful.
  if (body.status === "ambiguous" && submittedConfirmed) {
    throw new JobManagerContractError("job_manager_ambiguous_confirmation_forbidden");
  }

  const { safe_resume_step: normalizedSafeRestart, ...normalizedFoundation } = foundation;
  return {
    ...normalizedFoundation,
    schema: JOB_MANAGER_WORKFLOW_CONTRACT_SCHEMA_V1,
    account_ref: accountRef,
    job_board: jobBoard,
    target_url: targetUrl,
    job_id: jobId,
    queue_id: queueId,
    role,
    message_thread_fingerprint_hash: fingerprint,
    capture_blocker: captureBlocker,
    submitted_confirmed: submittedConfirmed,
    readback_url: readbackUrl,
    safe_restart: normalizedSafeRestart
  };
}

/** Alias kept short for callers that treat workflow contracts as adapters. */
export const parseJobManagerContractV1 = parseJobManagerWorkflowContractV1;
export const parseJobManagerServiceReadinessContractV1 = parseJobManagerWorkflowContractV1;

export function validateJobManagerWorkflowContractV1(
  value: unknown,
  options: JobManagerValidationOptionsV1 = {}
): JobManagerValidationResultV1 {
  try {
    return { ok: true, status: "ok", value: parseJobManagerWorkflowContractV1(value, options) };
  } catch (error) {
    const exactBlocker =
      error instanceof ServiceReadinessContractError
        ? error.code
        : "job_manager_contract_validation_failed";
    return { ok: false, status: "blocked", exact_blocker: exactBlocker };
  }
}

export const validateJobManagerContractV1 = validateJobManagerWorkflowContractV1;
export const validateJobManagerServiceReadinessContractV1 = validateJobManagerWorkflowContractV1;
export { ServiceReadinessEffectLedgerV1 };

function objectValue(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JobManagerContractError(code);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(body: Record<string, unknown>): void {
  const unknown = Object.keys(body).filter((key) => !foundationFields.has(key) && !adapterFields.has(key));
  if (unknown.length > 0) {
    throw new JobManagerContractError(`job_manager_unknown_field:${unknown.sort().join(",")}`);
  }
}

function requireFields(body: Record<string, unknown>): void {
  const missing = requiredFields.filter((field) => !Object.prototype.hasOwnProperty.call(body, field));
  if (missing.length > 0) {
    throw new JobManagerContractError(`job_manager_required_field:${missing.join(",")}`);
  }
}

function requiredText(value: unknown, code: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new JobManagerContractError(code);
  }
  return value;
}

function nullableText(value: unknown, code: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  return requiredText(value, code, max);
}

function requiredIdentifier(value: unknown, code: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) {
    throw new JobManagerContractError(code);
  }
  return value;
}

function nullableIdentifier(value: unknown, code: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredIdentifier(value, code);
}

function hashValue(value: unknown, code: string): string {
  if (typeof value !== "string" || !hashPattern.test(value)) {
    throw new JobManagerContractError(code);
  }
  return value;
}

function nullableHash(value: unknown, code: string): string | null {
  if (value === null || value === undefined) return null;
  return hashValue(value, code);
}

function booleanValue(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") throw new JobManagerContractError(code);
  return value;
}

function enumValue<T extends string>(value: unknown, values: Set<T>, code: string): T {
  if (typeof value !== "string" || !values.has(value as T)) {
    throw new JobManagerContractError(code);
  }
  return value as T;
}

function supportedUrl(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new JobManagerContractError(code);
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported_protocol");
    }
  } catch {
    throw new JobManagerContractError(code);
  }
  return value;
}

function nullableSupportedUrl(value: unknown, code: string): string | null {
  if (value === null || value === undefined) return null;
  return supportedUrl(value, code);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

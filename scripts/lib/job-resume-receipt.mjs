import { createHash } from "node:crypto";
import { verifyCompanionOperationEffectProof } from "./companion-effect-proof.mjs";

export const JOB_SOURCE_RESUME_RECEIPT_SCHEMA = "aos.job.source_resume_receipt.v1";

function text(value, max = 240) {
  return typeof value === "string" ? value.replace(/\u0000/gu, "").trim().slice(0, max) : "";
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function digest(value) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function handoffStatus(input) {
  const receipt = input?.handoffReceipt ?? input?.handoff_receipt ?? input;
  return {
    receipt,
    sourceThreadId: text(receipt?.source_thread_id ?? receipt?.sourceThreadId),
    destinationThreadId: text(receipt?.destination_thread_id ?? receipt?.destinationThreadId),
    sourceStatus: text(receipt?.source_status ?? receipt?.sourceStatus),
    status: text(receipt?.status),
    implementationAllowed: receipt?.implementation_allowed === true || receipt?.implementationAllowed === true,
    resumeIdempotencyKey: text(receipt?.resume_idempotency_key ?? receipt?.resumeIdempotencyKey, 512),
  };
}

function freshRunIdentity(input) {
  const runId = text(input?.runId ?? input?.run_id, 512);
  const idempotencyKey = text(input?.idempotencyKey ?? input?.idempotency_key, 512);
  if (!runId) throw new Error("aos_job_source_resume_run_id_required");
  if (!idempotencyKey) throw new Error("aos_job_source_resume_idempotency_key_required");
  return { runId, idempotencyKey };
}

/**
 * Create a job-specific resume admission after a source-return transition.
 * The receipt grants only a fresh, source-thread continuation; it is never an
 * application-submission, provider, or Sheet completion proof.
 */
export function createJobSourceResumeReceipt(input = {}) {
  const state = handoffStatus(input);
  if (state.status !== "returned_to_source" || state.sourceStatus !== "source_resume_ready" || !state.implementationAllowed) {
    throw new Error("aos_job_source_resume_handoff_not_ready");
  }
  if (!state.sourceThreadId) throw new Error("aos_job_source_resume_source_thread_required");
  const { runId, idempotencyKey } = freshRunIdentity(input);
  const ownerTaskId = text(input.ownerTaskId ?? input.owner_task_id) || state.sourceThreadId;
  if (ownerTaskId !== state.sourceThreadId) throw new Error("aos_job_source_resume_owner_task_mismatch");
  let companionEffectProof = null;
  if (input.companionEffectProof ?? input.companion_effect_proof) {
    companionEffectProof = verifyCompanionOperationEffectProof(
      input.companionEffectProof ?? input.companion_effect_proof,
      {
        secret: input.companionEffectProofSecret ?? input.companion_effect_proof_secret,
        expected: {
          taskId: state.sourceThreadId,
          runId,
        },
      },
    );
  }
  const receipt = state.receipt;
  const createdAt = text(input.createdAt ?? input.created_at, 80) || new Date().toISOString();
  const result = {
    schema: JOB_SOURCE_RESUME_RECEIPT_SCHEMA,
    status: "ready",
    task_type: "job",
    source_thread_id: state.sourceThreadId,
    owner_task_id: ownerTaskId,
    destination_thread_id: state.destinationThreadId || null,
    source_thread_only: true,
    destination_continuation_allowed: false,
    destination_continuation_dispatched: false,
    run_id: runId,
    idempotency_key: idempotencyKey,
    resume_idempotency_key: state.resumeIdempotencyKey || null,
    fresh_session_required: true,
    external_action_executed: false,
    application_submitted: false,
    sheet_write_performed: false,
    handoff_receipt_digest: digest(receipt),
    owner_proof_verified: receipt?.resume_authority?.proof_verified === true,
    companion_effect_proof_verified: Boolean(companionEffectProof),
    companion_effect_proof: companionEffectProof,
    created_at: createdAt,
    next_action: text(input.nextAction ?? input.next_action, 1_200) || "Open a fresh owner session in the source task and perform the next bounded readback.",
    exact_blocker: null,
  };
  if (!result.owner_proof_verified) throw new Error("aos_job_source_resume_owner_proof_missing");
  return result;
}

/** Validate a job source-resume admission without performing any side effect. */
export function validateJobSourceResumeReceipt(receipt, expected = {}) {
  if (!receipt || typeof receipt !== "object" || receipt.schema !== JOB_SOURCE_RESUME_RECEIPT_SCHEMA) {
    throw new Error("aos_job_source_resume_receipt_schema_invalid");
  }
  if (receipt.status !== "ready") throw new Error("aos_job_source_resume_receipt_not_ready");
  if (receipt.task_type !== "job") throw new Error("aos_job_source_resume_receipt_task_type_invalid");
  if (receipt.source_thread_only !== true || receipt.destination_continuation_allowed !== false || receipt.destination_continuation_dispatched !== false) {
    throw new Error("aos_job_source_resume_destination_continuation_forbidden");
  }
  if (receipt.external_action_executed !== false || receipt.application_submitted !== false || receipt.sheet_write_performed !== false) {
    throw new Error("aos_job_source_resume_effect_state_invalid");
  }
  if (receipt.owner_proof_verified !== true || !text(receipt.source_thread_id) || !text(receipt.owner_task_id)) {
    throw new Error("aos_job_source_resume_owner_proof_missing");
  }
  if (receipt.owner_task_id !== receipt.source_thread_id) throw new Error("aos_job_source_resume_owner_task_mismatch");
  if (receipt.companion_effect_proof_verified === true
    && (!receipt.companion_effect_proof || receipt.companion_effect_proof.schema !== "aos.chrome_companion.operation_effect_proof.v1")) {
    throw new Error("aos_job_source_resume_companion_effect_proof_invalid");
  }
  for (const [field, value] of [["sourceThreadId", expected.sourceThreadId ?? expected.source_thread_id], ["runId", expected.runId ?? expected.run_id], ["idempotencyKey", expected.idempotencyKey ?? expected.idempotency_key]]) {
    if (value !== undefined && value !== null && text(value, 512) !== text(field === "sourceThreadId" ? receipt.source_thread_id : field === "runId" ? receipt.run_id : receipt.idempotency_key, 512)) {
      throw new Error(`aos_job_source_resume_${field}_mismatch`);
    }
  }
  return true;
}

export const buildJobSourceResumeReceipt = createJobSourceResumeReceipt;
export const verifyJobSourceResumeReceipt = validateJobSourceResumeReceipt;

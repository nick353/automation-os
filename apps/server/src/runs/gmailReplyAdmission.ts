import { listCompanyConnectionRefs, listCompanyConnectionRefsAsync } from "../automations/repository.js";
import { dbBackend, initDb, querySql, querySqlAsync, sqlValue } from "../db/client.js";
import { acceptedGmailReviewAnchor } from "./gmailReviewResult.js";
import { readVerifiedGmailSourceAcquisition } from "./gmailSourceAcquisition.js";
import { requireGmailRunConnectionRef } from "./gmailExecutionTargetPropagation.js";
import {
  canonicalJson,
  produceGmailReplyEffect,
  sha256Canonical,
  type GmailReplyEffectProducerResult
} from "./gmailReplyEffect.js";
import { startPortableLocalWorkflowRun, type PortableLocalWorkflowStartResult } from "./portableLocalWorkflowEntrypoint.js";

const HASH = /^[a-f0-9]{64}$/u;

export type GmailReplyAdmissionResult = {
  schema: "aos.gmail_reply_canonical_admission.v1";
  replayed: boolean;
  run: { id: string; status: string; company_id: string };
  approval: { id: string; status: string; action_kind: string | null; payload_hash: string | null } | null;
  source_binding: {
    source_run_id: string;
    source_message_id: string;
    source_review_hash: string;
    source_evidence_sha256: string;
    canonical_reply_payload_sha256: string;
  };
  producer_result: {
    status: "ready";
    source_evidence_sha256: string;
    canonical_reply_payload_sha256: string;
  };
  provider_called: false;
  external_action_executed: false;
  company_scope: { enforced: true; company_id: string };
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return record(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requireReadyProducer(value: unknown): Extract<GmailReplyEffectProducerResult, { status: "ready" }> {
  const result = produceGmailReplyEffect(value);
  if (result.status !== "ready") {
    throw new Error(result.exact_blocker);
  }
  return result;
}

function sourceReviewHasMessage(review: Record<string, unknown>, messageId: string): boolean {
  const items = review.review;
  if (!record(items) || !Array.isArray(items.items)) return false;
  return items.items.some((item) => record(item) && item.message_id === messageId);
}

function sourceEvidenceForMessage(sync: Record<string, unknown>, messageId: string): Record<string, unknown> | null {
  const reviewResult = record(sync.review_result) ? sync.review_result : null;
  const review = reviewResult && record(reviewResult.review) ? reviewResult.review : null;
  const items = review && Array.isArray(review.items) ? review.items : [];
  const item = items.find((value) => record(value) && stringField(value.message_id) === messageId);
  const evidence = record(sync.source_evidence) ? sync.source_evidence : record(item) && record(item.source_evidence) ? item.source_evidence : null;
  if (evidence) return evidence;
  return record(item) && record(item.source_message)
    ? { schema: "aos.gmail_source_evidence.v1", version: 1, source_message: item.source_message }
    : null;
}

function sourceEvidenceMessage(evidence: Record<string, unknown>): Record<string, unknown> | null {
  return record(evidence.source_message) ? evidence.source_message : null;
}

function sourceEvidenceContext(evidence: Record<string, unknown>, sourceBundle: Record<string, unknown> | null, sync: Record<string, unknown>) {
  const context = record(evidence.authenticated_context) ? evidence.authenticated_context : evidence;
  return {
    companyId: stringField(context.company_id ?? context.companyId ?? sync.company_id),
    accountRef: stringField(context.account_ref ?? context.accountRef ?? sync.account_ref ?? sourceBundle?.account_ref)
  };
}

function sourceIdentityHash(message: Record<string, unknown>): string {
  return sha256Canonical({
    message_id: message.message_id,
    thread_id: message.thread_id,
    structured_headers: message.structured_headers
  });
}

async function readSourceRun(companyId: string, sourceRunId: string): Promise<{ metadata: Record<string, unknown>; status: string } | undefined> {
  const sql = `SELECT metadata_json, status FROM runs WHERE id=${sqlValue(sourceRunId)} AND company_id=${sqlValue(companyId)} LIMIT 1`;
  const row = (dbBackend === "postgres"
    ? (await querySqlAsync<{ metadata_json: string; status: string }>(sql))[0]
    : querySql<{ metadata_json: string; status: string }>(sql)[0]);
  return row ? { metadata: parseJson(row.metadata_json), status: row.status } : undefined;
}

async function approvalForRun(companyId: string, runId: string): Promise<GmailReplyAdmissionResult["approval"]> {
  const sql = `SELECT id, status, action_kind, payload_hash FROM approvals
    WHERE run_id=${sqlValue(runId)} AND company_id=${sqlValue(companyId)} ORDER BY created_at ASC LIMIT 1`;
  const row = (dbBackend === "postgres"
    ? (await querySqlAsync<{ id: string; status: string; action_kind: string | null; payload_hash: string | null }>(sql))[0]
    : querySql<{ id: string; status: string; action_kind: string | null; payload_hash: string | null }>(sql)[0]);
  return row ?? null;
}

/**
 * Admit a complete, source-bound Gmail reply candidate without contacting a
 * provider. The existing portable local admission owns the invocation, Run,
 * input-bundle, and pending-approval persistence; this helper only supplies
 * its server-recomputed, immutable Gmail binding.
 */
export async function admitGmailReplyEffect(input: {
  companyId: string;
  sourceRunId: string;
  idempotencyKey: string;
  sourceCandidate: unknown;
}): Promise<GmailReplyAdmissionResult> {
  const companyId = input.companyId.trim();
  const sourceRunId = input.sourceRunId.trim();
  const idempotencyKey = input.idempotencyKey.trim();
  if (!companyId) throw new Error("company_scope_required");
  if (!sourceRunId) throw new Error("gmail_reply_source_run_id_required");
  if (!idempotencyKey) throw new Error("idempotency_key_required");

  const sourceRun = await readSourceRun(companyId, sourceRunId);
  if (!sourceRun) throw new Error("gmail_reply_source_run_not_found");
  const invocation = sourceRun.metadata.portable_workflow_invocation;
  if (!record(invocation) || invocation.workflow_id !== "email-review-reply") {
    throw new Error("gmail_reply_source_workflow_mismatch");
  }
  const accepted = acceptedGmailReviewAnchor(sourceRun.metadata, sourceRunId, companyId);
  if (!accepted || sourceRun.status !== "complete") throw new Error("gmail_reply_source_review_not_accepted");

  const sourceBundle = record(sourceRun.metadata.portable_input_bundle)
    ? (record(sourceRun.metadata.portable_input_bundle.input) ? sourceRun.metadata.portable_input_bundle.input : null)
    : null;
  const candidate = record(input.sourceCandidate) ? input.sourceCandidate : null;
  const sourceMessage = candidate && record(candidate.source_message) ? candidate.source_message : null;
  const provenance = sourceMessage && record(sourceMessage.provenance_snapshot)
    ? sourceMessage.provenance_snapshot
    : null;
  const messageId = stringField(sourceMessage?.message_id);
  let acquisition: Awaited<ReturnType<typeof readVerifiedGmailSourceAcquisition>>;
  try {
    acquisition = await readVerifiedGmailSourceAcquisition({ companyId, sourceRunId, messageId });
  } catch {
    throw new Error("gmail_reply_source_evidence_incomplete");
  }
  const persistedEvidence = acquisition.envelope;
  const persistedMessage = persistedEvidence ? sourceEvidenceMessage(persistedEvidence) : null;
  const persistedContext = persistedEvidence ? sourceEvidenceContext(persistedEvidence, sourceBundle, acquisition.acquisition.authenticated_context as Record<string, unknown>) : null;
  const persistedHash = persistedEvidence ? sha256Canonical(persistedEvidence) : "";
  if (!persistedEvidence || !persistedMessage || !persistedContext) throw new Error("gmail_reply_source_evidence_incomplete");
  const persistedHeaders = persistedMessage && record(persistedMessage.structured_headers) ? persistedMessage.structured_headers : null;
  const completePersisted = Boolean(persistedEvidence && persistedMessage && persistedContext
    && persistedEvidence.schema === "aos.gmail_source_evidence.v1" && persistedEvidence.version === 1
    && persistedContext.companyId === companyId && persistedContext.accountRef
    && stringField(persistedMessage.message_id) && stringField(persistedMessage.thread_id)
    && persistedHeaders
    && stringField(persistedHeaders.recipient)
    && stringField(persistedHeaders.subject)
    && stringField(persistedHeaders.in_reply_to)
    && Array.isArray(persistedHeaders.references)
    && persistedHeaders.references.length > 0
    && record(persistedMessage.structured_headers)
    && record(persistedMessage.provenance_snapshot)
    && stringField(persistedMessage.provenance_snapshot.source_run_id) === sourceRunId
    && stringField(persistedMessage.provenance_snapshot.source_review_hash) === accepted.review_hash
    && stringField(persistedMessage.provenance_snapshot.source_snapshot_sha256) === sourceIdentityHash(persistedMessage));
  if (!completePersisted) throw new Error("gmail_reply_source_evidence_incomplete");
  const callerSource = sourceMessage ? { ...sourceMessage } : null;
  const persistedSource = persistedMessage ? { ...persistedMessage } : null;
  if (callerSource && persistedSource) {
    delete (callerSource as Record<string, unknown>).provenance_snapshot;
    delete (persistedSource as Record<string, unknown>).provenance_snapshot;
  }
  if (!provenance
    || stringField(provenance.source_run_id) !== sourceRunId
    || stringField(provenance.source_review_hash) !== accepted.review_hash
    || stringField(provenance.source_snapshot_sha256) !== sourceIdentityHash(persistedMessage)
    || !sourceReviewHasMessage(accepted, messageId)
    || canonicalJson(callerSource) !== canonicalJson(persistedSource)) {
    throw new Error("gmail_reply_source_candidate_mismatch");
  }

  const connectionRefs = dbBackend === "postgres"
    ? await listCompanyConnectionRefsAsync(companyId)
    : listCompanyConnectionRefs(companyId);
  const connection = requireGmailRunConnectionRef({ companyId, inputBundle: sourceBundle, connectionRefs });
  const authenticatedContext = acquisition.acquisition.authenticated_context as Record<string, unknown>;
  if (persistedContext.accountRef !== connection.accountRef
    || stringField(authenticatedContext.connection_ref_id) !== connection.id) throw new Error("gmail_reply_source_account_mismatch");
  const producer = requireReadyProducer(candidate);
  if (producer.source_evidence_sha256 !== persistedHash) throw new Error("gmail_reply_source_candidate_mismatch");
  const inputBundle = {
    connection_ref_id: connection.id,
    account_ref: connection.accountRef,
    target_key: `gmail-reply:${messageId}`,
    payload_hash: producer.canonical_reply_payload_sha256,
    source_snapshot_id: producer.source_evidence_sha256,
    gmail_source_run_id: sourceRunId,
    gmail_source_review_hash: accepted.review_hash,
    gmail_source_evidence_sha256: producer.source_evidence_sha256,
    gmail_canonical_reply_payload_sha256: producer.canonical_reply_payload_sha256,
    gmail_reply_effect_input_json: canonicalJson(candidate),
    gmail_reply_producer_result_json: canonicalJson(producer)
  };

  const started: PortableLocalWorkflowStartResult = await startPortableLocalWorkflowRun({
    workflowId: "email-review-reply",
    sourceTrigger: "automation_os_ui",
    idempotencyKey,
    registeredAutomationId: "email-review-reply",
    companyId,
    effectStage: "business_execute",
    inputBundle
  });
  const approval = await approvalForRun(companyId, started.runId);
  return {
    schema: "aos.gmail_reply_canonical_admission.v1",
    replayed: started.replayed,
    run: { id: started.runId, status: started.status, company_id: companyId },
    approval,
    source_binding: {
      source_run_id: sourceRunId,
      source_message_id: messageId,
      source_review_hash: accepted.review_hash,
      source_evidence_sha256: producer.source_evidence_sha256,
      canonical_reply_payload_sha256: producer.canonical_reply_payload_sha256
    },
    producer_result: {
      status: "ready",
      source_evidence_sha256: producer.source_evidence_sha256,
      canonical_reply_payload_sha256: producer.canonical_reply_payload_sha256
    },
    provider_called: false,
    external_action_executed: false,
    company_scope: { enforced: true, company_id: companyId }
  };
}

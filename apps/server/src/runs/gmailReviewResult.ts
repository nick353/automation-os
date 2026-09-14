import { createHash } from "node:crypto";
import { redactSensitiveText } from "../obsidian/redaction.js";

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

/** Preserve only the bounded, typed result of the existing metadata-only Gmail reader. */
export function normalizeGmailReviewResult(value: unknown, expected: { runId: string; companyId: string; reviewHash?: string }) {
  if (!record(value) || value.run_id !== expected.runId || value.company_id !== expected.companyId
    || value.status !== "complete" || value.exact_blocker !== null || value.provider_read_observed !== true
    || value.reply_candidates_require_approval !== true || value.messages_sent !== false
    || value.provider_drafts_created !== false || value.external_action_executed !== false
    || !digest(value.review_hash) || (expected.reviewHash && value.review_hash !== expected.reviewHash)) return null;
  const review = value.review;
  const counts = value.diagnostics;
  if (!record(review) || !record(counts) || Buffer.byteLength(JSON.stringify(review)) > 128 * 1024
    || hash(review) !== value.review_hash || review.provider !== "gmail" || review.operation !== "summary_review"
    || review.exact_blocker !== null || !Number.isInteger(review.fetched_count) || review.fetched_count < 0 || review.fetched_count > 100
    || typeof review.exhausted !== "boolean" || (review.fetched_count < 100 && review.exhausted !== true)
    || !Array.isArray(review.items) || review.items.length !== review.fetched_count
    || counts.fetched_count !== review.fetched_count || counts.item_count !== review.fetched_count
    || counts.unique_id_count !== review.fetched_count || counts.exhausted !== review.exhausted
    || !Number.isInteger(counts.reply_candidate_count) || counts.reply_candidate_count < 0 || counts.reply_candidate_count > 5
    || !Number.isInteger(counts.provider_read_call_count) || counts.provider_read_call_count < 1 || counts.provider_read_call_count > 10) return null;
  const text = (input: unknown, limit: number): input is string => typeof input === "string" && input.length <= limit;
  if (!review.items.every((item: unknown) => record(item) && text(item.message_id, 160) && /^[A-Za-z0-9._:-]+$/u.test(item.message_id)
    && text(item.category, 80) && text(item.summary, 240) && (item.reply_candidate === null || text(item.reply_candidate, 400)))
    || new Set(review.items.map((item: Record<string, any>) => item.message_id)).size !== review.items.length
    || review.items.filter((item: Record<string, any>) => typeof item.reply_candidate === "string" && item.reply_candidate.trim()).length !== counts.reply_candidate_count) return null;
  const displayReview = {
    provider: "gmail", operation: "summary_review", fetched_count: review.fetched_count, exhausted: review.exhausted,
    items: review.items.map((item: Record<string, any>) => ({ message_id: item.message_id as string,
      category: redactSensitiveText(item.category), summary: redactSensitiveText(item.summary),
      reply_candidate: item.reply_candidate?.trim() ? redactSensitiveText(item.reply_candidate) : null })),
    exact_blocker: null
  };
  return {
    status: "complete" as const, exact_blocker: null, run_id: expected.runId, company_id: expected.companyId,
    review: displayReview, review_hash: value.review_hash, display_content_sha256: hash(displayReview),
    content_sanitized: true, provider_read_observed: true, reply_candidates_require_approval: true,
    messages_sent: false, provider_drafts_created: false, external_action_executed: false,
    diagnostics: { fetched_count: review.fetched_count, item_count: review.fetched_count, unique_id_count: review.fetched_count,
      reply_candidate_count: counts.reply_candidate_count, exhausted: review.exhausted, provider_read_call_count: counts.provider_read_call_count }
  };
}

/** The original accepted receipt is the anchor, including for a later source-only repair. */
export function acceptedGmailReviewAnchor(metadata: Record<string, any>, runId: string, companyId: string): Record<string, any> | null {
  const receipt = metadata.remote_worker_receipt;
  const result = receipt?.adapter_result?.local_receipt?.review;
  if (metadata.external_action_executed === true || !record(receipt) || receipt.run_id !== runId || receipt.workflow_id !== "email-review-reply"
    || receipt.status !== "complete" || receipt.exact_blocker !== null || receipt.effects_mode !== "read_only"
    || receipt.read_only_proof_verified !== true || receipt.same_run_receipt !== true || receipt.readback_verified !== true
    || receipt.cleanup_verified !== true || receipt.external_action_executed !== false || !record(result)
    || result.run_id !== runId || result.company_id !== companyId || result.status !== "complete" || result.exact_blocker !== null
    || result.provider_read_observed !== true || result.reply_candidates_require_approval !== true
    || result.messages_sent !== false || result.provider_drafts_created !== false || result.external_action_executed !== false
    || !digest(result.review_hash) || !record(result.diagnostics)) return null;
  return result;
}

import { createHash } from "node:crypto";

export const GMAIL_REPLY_EFFECT_INPUT_SCHEMA_V1 = "aos.gmail_reply_effect_input.v1" as const;
export const GMAIL_REPLY_CANONICAL_PAYLOAD_SCHEMA_V1 = "aos.gmail_reply_canonical_payload.v1" as const;
export const GMAIL_SOURCE_EVIDENCE_SCHEMA_V1 = "aos.gmail_source_evidence.v1" as const;

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const HEADER_INJECTION_PATTERN = /[\r\n\u0000]/u;
const SINGLE_MAILBOX_PATTERN = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/u;
const RFC_MESSAGE_ID_PATTERN = /^<[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>$/u;
const INTERNAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u;
const MAX_ID_LENGTH = 160;
const MAX_TEXT_LENGTH = 100_000;

export type GmailStructuredHeadersV1 = {
  recipient: string;
  subject: string;
  in_reply_to: string;
  references: readonly string[];
};

export type GmailSourceProvenanceSnapshotV1 = {
  source_run_id: string;
  source_review_hash: string;
  source_snapshot_sha256: string;
};

export type GmailSourceMessageV1 = {
  message_id: string;
  thread_id: string;
  structured_headers: GmailStructuredHeadersV1;
  provenance_snapshot: GmailSourceProvenanceSnapshotV1;
};

export type GmailReplyDraftV1 = {
  body: string;
};

export type GmailAttachmentRefV1 = {
  attachment_id: string;
  filename: string;
  mime_type: string;
  sha256: string;
  size_bytes: number;
};

export type GmailReplyEffectInputV1 = {
  schema: typeof GMAIL_REPLY_EFFECT_INPUT_SCHEMA_V1;
  version: 1;
  source_message: GmailSourceMessageV1;
  reply_draft: GmailReplyDraftV1;
  /** [] is an explicit no-attachments declaration; omission is invalid. */
  attachments: readonly GmailAttachmentRefV1[];
};

export type GmailCanonicalReplyPayloadV1 = {
  schema: typeof GMAIL_REPLY_CANONICAL_PAYLOAD_SCHEMA_V1;
  version: 1;
  source_message: {
    message_id: string;
    thread_id: string;
    structured_headers: GmailStructuredHeadersV1;
  };
  reply_draft: GmailReplyDraftV1;
  attachments: readonly GmailAttachmentRefV1[];
};

export type GmailSourceEvidenceV1 = {
  schema: typeof GMAIL_SOURCE_EVIDENCE_SCHEMA_V1;
  version: 1;
  source_message: GmailSourceMessageV1;
};

export type GmailReplyEffectReady = {
  schema: "aos.gmail_reply_effect_producer_result.v1";
  version: 1;
  status: "ready";
  source_evidence: GmailSourceEvidenceV1;
  source_evidence_sha256: string;
  canonical_reply_payload: GmailCanonicalReplyPayloadV1;
  canonical_reply_payload_sha256: string;
};

export type GmailReplyEffectBlocked = {
  schema: "aos.gmail_reply_effect_producer_result.v1";
  version: 1;
  status: "blocked";
  exact_blocker: "gmail_reply_effect_input_incomplete" | "gmail_reply_effect_input_invalid";
  missing_fields: string[];
  invalid_fields: string[];
};

export type GmailReplyEffectProducerResult = GmailReplyEffectReady | GmailReplyEffectBlocked;

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Deterministic JSON for hashes; object keys are sorted, array order is preserved. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new Error("gmail_reply_effect_canonical_value_invalid");
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function text(value: unknown, path: string, missing: string[], invalid: string[], maxLength = MAX_TEXT_LENGTH): string | null {
  if (value === undefined) {
    missing.push(path);
    return null;
  }
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    invalid.push(path);
    return null;
  }
  return value;
}

function headerText(value: unknown, path: string, missing: string[], invalid: string[], maxLength: number): string | null {
  const result = text(value, path, missing, invalid, maxLength);
  if (result !== null && HEADER_INJECTION_PATTERN.test(result)) {
    invalid.push(path);
    return null;
  }
  return result;
}

function identifier(value: unknown, path: string, missing: string[], invalid: string[]): string | null {
  const result = headerText(value, path, missing, invalid, MAX_ID_LENGTH);
  return result && INTERNAL_ID_PATTERN.test(result) ? result : result === null ? null : (invalid.push(path), null);
}

function mailbox(value: unknown, path: string, missing: string[], invalid: string[]): string | null {
  const result = headerText(value, path, missing, invalid, 2_000);
  return result && SINGLE_MAILBOX_PATTERN.test(result) ? result : result === null ? null : (invalid.push(path), null);
}

function rfcMessageId(value: unknown, path: string, missing: string[], invalid: string[]): string | null {
  const result = headerText(value, path, missing, invalid, MAX_ID_LENGTH);
  return result && RFC_MESSAGE_ID_PATTERN.test(result) ? result : result === null ? null : (invalid.push(path), null);
}

function hashValue(value: unknown, path: string, missing: string[], invalid: string[]): string | null {
  const result = text(value, path, missing, invalid, 64);
  return result && HASH_PATTERN.test(result) ? result : result === null ? null : (invalid.push(path), null);
}

function rfcMessageIdArray(value: unknown, path: string, missing: string[], invalid: string[]): string[] | null {
  if (value === undefined) {
    missing.push(path);
    return null;
  }
  if (!Array.isArray(value)) {
    invalid.push(path);
    return null;
  }
  const output: string[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = rfcMessageId(item, `${path}[${index}]`, missing, invalid);
    if (parsed !== null) output.push(parsed);
  }
  return invalid.some((field) => field === path || field.startsWith(`${path}[`)) ? null : output;
}

function attachmentRefs(value: unknown, path: string, missing: string[], invalid: string[]): GmailAttachmentRefV1[] | null {
  if (value === undefined) {
    missing.push(path);
    return null;
  }
  if (!Array.isArray(value)) {
    invalid.push(path);
    return null;
  }
  const output: GmailAttachmentRefV1[] = [];
  const ids = new Set<string>();
  for (const [index, item] of value.entries()) {
    const entryPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      invalid.push(entryPath);
      continue;
    }
    const attachmentId = identifier(item.attachment_id, `${entryPath}.attachment_id`, missing, invalid);
    const filename = text(item.filename, `${entryPath}.filename`, missing, invalid, 512);
    const mimeType = text(item.mime_type, `${entryPath}.mime_type`, missing, invalid, 160);
    const digest = hashValue(item.sha256, `${entryPath}.sha256`, missing, invalid);
    const size = item.size_bytes;
    const sizeIsValid = typeof size === "number" && Number.isSafeInteger(size) && size >= 0;
    if (size === undefined) missing.push(`${entryPath}.size_bytes`);
    else if (!sizeIsValid) invalid.push(`${entryPath}.size_bytes`);
    if (!attachmentId || !filename || !mimeType || !digest || !sizeIsValid || ids.has(attachmentId)) {
      if (attachmentId && ids.has(attachmentId)) invalid.push(`${entryPath}.attachment_id`);
      continue;
    }
    ids.add(attachmentId);
    output.push({ attachment_id: attachmentId, filename, mime_type: mimeType, sha256: digest, size_bytes: size });
  }
  return invalid.some((field) => field === path || field.startsWith(`${path}[`)) ? null : output;
}

function blocked(missingFields: string[], invalidFields: string[]): GmailReplyEffectBlocked {
  const missing = [...new Set(missingFields)].sort();
  const invalid = [...new Set(invalidFields)].sort();
  return {
    schema: "aos.gmail_reply_effect_producer_result.v1",
    version: 1,
    status: "blocked",
    exact_blocker: missing.length > 0 ? "gmail_reply_effect_input_incomplete" : "gmail_reply_effect_input_invalid",
    missing_fields: missing,
    invalid_fields: invalid
  };
}

/**
 * Purely materialize an exact, source-bound reply payload. This function never
 * calls Gmail, starts a Run, creates an approval, or writes an artifact.
 */
export function produceGmailReplyEffect(value: unknown): GmailReplyEffectProducerResult {
  const missing: string[] = [];
  const invalid: string[] = [];
  if (!isRecord(value)) return blocked(["input"], []);
  if (value.schema === undefined) missing.push("schema");
  else if (value.schema !== GMAIL_REPLY_EFFECT_INPUT_SCHEMA_V1) invalid.push("schema");
  if (value.version === undefined) missing.push("version");
  else if (value.version !== 1) invalid.push("version");

  const source = value.source_message;
  const draft = value.reply_draft;
  const sourceRecord = isRecord(source) ? source : null;
  const draftRecord = isRecord(draft) ? draft : null;
  if (source === undefined) missing.push("source_message");
  else if (!sourceRecord) invalid.push("source_message");
  if (draft === undefined) missing.push("reply_draft");
  else if (!draftRecord) invalid.push("reply_draft");

  const messageId = sourceRecord ? identifier(sourceRecord.message_id, "source_message.message_id", missing, invalid) : null;
  const threadId = sourceRecord ? identifier(sourceRecord.thread_id, "source_message.thread_id", missing, invalid) : null;
  const headers = sourceRecord?.structured_headers;
  const headerRecord = isRecord(headers) ? headers : null;
  if (sourceRecord && headers === undefined) missing.push("source_message.structured_headers");
  else if (sourceRecord && !headerRecord) invalid.push("source_message.structured_headers");
  const recipient = headerRecord ? mailbox(headerRecord.recipient, "source_message.structured_headers.recipient", missing, invalid) : null;
  const subject = headerRecord ? headerText(headerRecord.subject, "source_message.structured_headers.subject", missing, invalid, 2_000) : null;
  const inReplyTo = headerRecord ? rfcMessageId(headerRecord.in_reply_to, "source_message.structured_headers.in_reply_to", missing, invalid) : null;
  const references = headerRecord ? rfcMessageIdArray(headerRecord.references, "source_message.structured_headers.references", missing, invalid) : null;
  const provenance = sourceRecord?.provenance_snapshot;
  const provenanceRecord = isRecord(provenance) ? provenance : null;
  if (sourceRecord && provenance === undefined) missing.push("source_message.provenance_snapshot");
  else if (sourceRecord && !provenanceRecord) invalid.push("source_message.provenance_snapshot");
  const sourceRunId = provenanceRecord ? identifier(provenanceRecord.source_run_id, "source_message.provenance_snapshot.source_run_id", missing, invalid) : null;
  const sourceReviewHash = provenanceRecord ? hashValue(provenanceRecord.source_review_hash, "source_message.provenance_snapshot.source_review_hash", missing, invalid) : null;
  const sourceSnapshotSha256 = provenanceRecord ? hashValue(provenanceRecord.source_snapshot_sha256, "source_message.provenance_snapshot.source_snapshot_sha256", missing, invalid) : null;
  const body = draftRecord ? text(draftRecord.body, "reply_draft.body", missing, invalid) : null;
  const attachments = attachmentRefs(value.attachments, "attachments", missing, invalid);
  if (missing.length > 0 || invalid.length > 0 || !messageId || !threadId || !recipient || !subject || !inReplyTo || !references || !sourceRunId || !sourceReviewHash || !sourceSnapshotSha256 || body === null || attachments === null) {
    return blocked(missing, invalid);
  }

  const structuredHeaders = { recipient, subject, in_reply_to: inReplyTo, references };
  const sourceMessage = {
    message_id: messageId,
    thread_id: threadId,
    structured_headers: structuredHeaders,
    provenance_snapshot: { source_run_id: sourceRunId, source_review_hash: sourceReviewHash, source_snapshot_sha256: sourceSnapshotSha256 }
  } satisfies GmailSourceMessageV1;
  const sourceEvidence = {
    schema: GMAIL_SOURCE_EVIDENCE_SCHEMA_V1,
    version: 1 as const,
    source_message: sourceMessage
  } satisfies GmailSourceEvidenceV1;
  const canonicalReplyPayload = {
    schema: GMAIL_REPLY_CANONICAL_PAYLOAD_SCHEMA_V1,
    version: 1 as const,
    source_message: { message_id: messageId, thread_id: threadId, structured_headers: structuredHeaders },
    reply_draft: { body },
    attachments
  } satisfies GmailCanonicalReplyPayloadV1;
  return {
    schema: "aos.gmail_reply_effect_producer_result.v1",
    version: 1,
    status: "ready",
    source_evidence: sourceEvidence,
    source_evidence_sha256: sha256Canonical(sourceEvidence),
    canonical_reply_payload: canonicalReplyPayload,
    canonical_reply_payload_sha256: sha256Canonical(canonicalReplyPayload)
  };
}

import { createHash } from "node:crypto";
import { CodexAppServerClient } from "../codex/appServerClient.js";
import { listCompanyConnectionRefs, listCompanyConnectionRefsAsync } from "../automations/repository.js";
import { dbBackend, nowIso, querySql, querySqlAsync, runSqlTransaction, runSqlTransactionAsync, sqlValue } from "../db/client.js";
import { acceptedGmailReviewAnchor } from "./gmailReviewResult.js";
import { requireGmailRunConnectionRef } from "./gmailExecutionTargetPropagation.js";
import { canonicalJson, produceGmailReplyEffect, sha256Canonical } from "./gmailReplyEffect.js";

export const GMAIL_SOURCE_ACQUISITION_SCHEMA = "aos.gmail_source_acquisition.v1" as const;

export type GmailSourceAcquisitionTransport = (input: {
  sourceRunId: string;
  messageId: string;
  companyId: string;
  accountRef: string;
  connectionRefId: string;
}) => Promise<unknown>;

export class GmailSourceAcquisitionError extends Error {
  constructor(message: string, readonly providerCalled: boolean, readonly providerCallUncertain = false, readonly externalActionExecuted: boolean | null = false) { super(message); this.name = "GmailSourceAcquisitionError"; }
}

const GMAIL_LINK_ID_PATTERN = /^link_[a-z0-9]+$/iu;

/**
 * Resolve the Codex connector link for the company-bound Gmail account.
 * Account refs are the AOS identity boundary; connector link IDs are runtime
 * metadata and must remain replaceable when the user changes accounts.
 */
export function resolveGmailAppLinkId(accountRef: string, env: NodeJS.ProcessEnv = process.env): string {
  const normalizedAccount = text(accountRef).toLowerCase();
  if (!normalizedAccount) throw new GmailSourceAcquisitionError("gmail_source_account_ref_required", false);
  const raw = text(env.CODEX_GMAIL_LINK_IDS_JSON);
  if (!raw) throw new GmailSourceAcquisitionError("gmail_source_gmail_link_id_missing", false);
  let mapping: unknown;
  try { mapping = JSON.parse(raw); } catch { throw new GmailSourceAcquisitionError("gmail_source_gmail_link_id_mapping_invalid", false); }
  if (!record(mapping)) throw new GmailSourceAcquisitionError("gmail_source_gmail_link_id_mapping_invalid", false);
  const linkId = text(mapping[normalizedAccount]);
  if (!GMAIL_LINK_ID_PATTERN.test(linkId)) throw new GmailSourceAcquisitionError("gmail_source_gmail_link_id_missing", false);
  return linkId;
}

type Row = { id: string; company_id: string; status: string; metadata_json: string };
type SourceMessage = { message_id: string; thread_id: string; structured_headers: Record<string, unknown> };

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function parse(value: string): Record<string, unknown> { try { const parsed = JSON.parse(value); return record(parsed) ? parsed : {}; } catch { return {}; } }

function sourceMessage(value: unknown): SourceMessage | null {
  const source = record(value) && record(value.source_message) ? value.source_message : value;
  if (!record(source) || !text(source.message_id) || !text(source.thread_id) || !record(source.structured_headers)) return null;
  const candidate = { schema: "aos.gmail_reply_effect_input.v1", version: 1,
    source_message: { message_id: source.message_id, thread_id: source.thread_id, structured_headers: source.structured_headers,
      provenance_snapshot: { source_run_id: "acquisition-validation", source_review_hash: "0".repeat(64), source_snapshot_sha256: "0".repeat(64) } },
    reply_draft: { body: "source-acquisition-validation" }, attachments: [] };
  const result = produceGmailReplyEffect(candidate);
  return result.status === "ready" ? { message_id: result.source_evidence.source_message.message_id,
    thread_id: result.source_evidence.source_message.thread_id, structured_headers: result.source_evidence.source_message.structured_headers } : null;
}

async function readRun(companyId: string, sourceRunId: string): Promise<Row | undefined> {
  const sql = `SELECT id, company_id, status, metadata_json FROM runs WHERE id=${sqlValue(sourceRunId)} AND company_id=${sqlValue(companyId)} LIMIT 1`;
  return (dbBackend === "postgres" ? (await querySqlAsync<Row>(sql))[0] : querySql<Row>(sql)[0]);
}

export async function acquireGmailSource(input: { companyId: string; sourceRunId: string; messageId: string; transport: GmailSourceAcquisitionTransport }) {
  const companyId = text(input.companyId);
  const sourceRunId = text(input.sourceRunId), requestedMessageId = text(input.messageId);
  if (!companyId || !sourceRunId || !requestedMessageId) throw new Error("gmail_source_acquisition_target_required");
  const run = await readRun(companyId, sourceRunId);
  if (!run) throw new Error("gmail_source_acquisition_source_run_not_found");
  const metadata = parse(run.metadata_json);
  const anchor = acceptedGmailReviewAnchor(metadata, run.id, run.company_id);
  if (run.status !== "complete" || !anchor) throw new Error("gmail_source_acquisition_review_not_accepted");
  const item = record(anchor.review) && Array.isArray(anchor.review.items)
    ? anchor.review.items.find((value) => record(value) && text(value.message_id) === requestedMessageId) : null;
  if (!item) throw new Error("gmail_source_acquisition_message_not_in_review");
  const bundle = record(metadata.portable_input_bundle) && record(metadata.portable_input_bundle.input) ? metadata.portable_input_bundle.input : null;
  const refs = dbBackend === "postgres" ? await listCompanyConnectionRefsAsync(run.company_id) : listCompanyConnectionRefs(run.company_id);
  const connection = requireGmailRunConnectionRef({ companyId: run.company_id, inputBundle: bundle, connectionRefs: refs });
  const existing = record(metadata.gmail_source_acquisition) ? metadata.gmail_source_acquisition : null;
  if (existing) {
    if (existing.source_run_id !== run.id || existing.source_message_id !== requestedMessageId) throw new Error("gmail_source_acquisition_conflict");
    return { ...(await readVerifiedGmailSourceAcquisition({ companyId: run.company_id, sourceRunId: run.id, messageId: requestedMessageId })), provider_called: false };
  }
  if (typeof input.transport !== "function") throw new Error("gmail_source_acquisition_transport_missing");
  const receivedAt = nowIso();
  const raw = await input.transport({ sourceRunId: run.id, messageId: requestedMessageId, companyId: run.company_id,
    accountRef: connection.accountRef, connectionRefId: connection.id });
  const facts = sourceMessage(raw);
  if (!facts || facts.message_id !== requestedMessageId) throw new Error("gmail_source_acquisition_transport_invalid");
  const transportReceipt = record(raw) && record(raw.receipt) ? raw.receipt : null;
  if (!transportReceipt || transportReceipt.profile_turn_id === undefined || transportReceipt.read_turn_id === undefined
    || transportReceipt.profile_call_id === undefined || transportReceipt.read_call_id === undefined
    || transportReceipt.profile_args_sha256 === undefined || transportReceipt.read_args_sha256 === undefined) throw new GmailSourceAcquisitionError("gmail_source_acquisition_receipt_missing", true);
  const sourceMessageWithProvenance = { ...facts, provenance_snapshot: {
    source_run_id: run.id, source_review_hash: anchor.review_hash,
    source_snapshot_sha256: sha256Canonical(facts)
  } };
  const envelope = { schema: "aos.gmail_source_evidence.v1", version: 1, source_message: sourceMessageWithProvenance };
  const sourceEvidenceSha256 = sha256Canonical(envelope);
  const acquisitionId = `acquisition_gmail_${sha256Canonical({ company_id: run.company_id, run_id: run.id, message_id: requestedMessageId }).slice(0, 32)}`;
  const artifactId = `artifact_gmail_source_${sourceEvidenceSha256.slice(0, 32)}`;
  const proofId = `proof_gmail_source_${sourceEvidenceSha256.slice(0, 32)}`;
  const artifactText = `${canonicalJson(envelope)}\n`;
  const artifactChecksum = createHash("sha256").update(artifactText, "utf8").digest("hex");
  const acquisition = { schema: GMAIL_SOURCE_ACQUISITION_SCHEMA, version: 1, acquisition_id: acquisitionId,
    source_run_id: run.id, source_message_id: requestedMessageId, source_review_hash: anchor.review_hash,
    authenticated_context: { company_id: run.company_id, account_ref: connection.accountRef, connection_ref_id: connection.id },
    source_evidence_sha256: sourceEvidenceSha256, artifact_id: artifactId, proof_id: proofId, artifact_checksum_sha256: artifactChecksum,
    receipt: { transport: "approved_gmail_source_transport", ...transportReceipt, received_at: receivedAt }, created_at: receivedAt };
  const artifactUri = `/api/v1/companies/${encodeURIComponent(run.company_id)}/artifacts/${artifactId}`;
  const steps = [
    { sql: `UPDATE runs SET metadata_json=${sqlValue({ ...metadata, gmail_source_acquisition: acquisition })} WHERE id=${sqlValue(run.id)} AND company_id=${sqlValue(run.company_id)} AND metadata_json=${sqlValue(run.metadata_json)}`, expectChanges: 1 },
    { sql: `INSERT INTO run_artifacts (id, company_id, run_id, step_id, attempt_id, kind, label, mime_type, checksum_sha256, size_bytes, content_text, status, created_at, updated_at)
      VALUES (${sqlValue(artifactId)}, ${sqlValue(run.company_id)}, ${sqlValue(run.id)}, NULL, NULL, 'gmail_source_acquisition', 'Gmail authenticated source acquisition', 'application/json', ${sqlValue(artifactChecksum)}, ${Buffer.byteLength(artifactText)}, ${sqlValue(artifactText)}, 'available', ${sqlValue(receivedAt)}, ${sqlValue(receivedAt)})`, expectChanges: 1 },
    { sql: `INSERT INTO proofs (id, company_id, run_id, step_id, artifact_id, proof_type, label, uri, size_bytes, created_at, metadata_json)
      VALUES (${sqlValue(proofId)}, ${sqlValue(run.company_id)}, ${sqlValue(run.id)}, NULL, ${sqlValue(artifactId)}, 'gmail_source_acquisition', 'Gmail authenticated source acquisition', ${sqlValue(artifactUri)}, ${Buffer.byteLength(artifactText)}, ${sqlValue(receivedAt)}, ${sqlValue({ schema: GMAIL_SOURCE_ACQUISITION_SCHEMA, source_evidence_sha256: sourceEvidenceSha256, company_id: run.company_id, account_ref: connection.accountRef, connection_ref_id: connection.id })})`, expectChanges: 1 }
  ];
  if (dbBackend === "postgres") await runSqlTransactionAsync(steps); else runSqlTransaction(steps);
  return { ...(await readVerifiedGmailSourceAcquisition({ companyId: run.company_id, sourceRunId: run.id, messageId: requestedMessageId })), provider_called: true };
}

export function createApprovedGmailSourceTransport(input: { client?: CodexAppServerClient }): GmailSourceAcquisitionTransport {
  return async (context) => {
    const linkId = input.client ? null : resolveGmailAppLinkId(context.accountRef);
    const client = input.client ?? new CodexAppServerClient({ timeoutMs: 120_000, turnTimeoutMs: 120_000 });
    const ownsClient = !input.client;
    let providerCalled = false, providerCallUncertain = false;
    let profileDispatch = false, readDispatch = false;
    try {
      const threadId = await client.startOrResumeThread(undefined, { ephemeral: true });
      profileDispatch = true;
      const profile = await client.startTurn({ threadId, text: `Call only mcp__codex_apps__gmail_get_profile({link_id:${JSON.stringify(linkId)}}) once. Return no assistant prose.` });
      providerCalled = profile.events.some((event) => event.method === "item/completed" && event.status === "completed" && /gmail/i.test(`${event.serverName} ${event.toolName}`) && /profile/i.test(event.toolName ?? ""));
      if (!providerCalled && profileDispatch) providerCallUncertain = true;
      const profileEvent = profile.events.find((event) => event.method === "item/completed" && event.status === "completed" && /gmail/i.test(`${event.serverName} ${event.toolName}`) && /profile/i.test(event.toolName ?? ""));
      const expectedHash = createHash("sha256").update(context.accountRef.toLowerCase(), "utf8").digest("hex");
      if (profile.status !== "completed") throw new GmailSourceAcquisitionError(profile.exactBlocker ?? "gmail_source_profile_read_failed", providerCalled, providerCallUncertain);
      if (profile.providerAccountHashSource !== "gmail_profile_tool" || profile.providerAccountHash !== expectedHash) throw new GmailSourceAcquisitionError("gmail_source_profile_identity_mismatch", providerCalled);
      const expectedProfileArgs = linkId ? { link_id: linkId } : {};
      if (!profileEvent?.itemId || canonicalJson(profileEvent.toolArguments ?? {}) !== canonicalJson(expectedProfileArgs)) throw new GmailSourceAcquisitionError("gmail_source_profile_receipt_invalid", providerCalled);
      readDispatch = true;
      const read = await client.startTurn({ threadId, text: `Call only mcp__codex_apps__gmail_read_email({link_id:${JSON.stringify(linkId)},message_id:${JSON.stringify(context.messageId)},format:"metadata"}) once. Return no assistant prose.` });
      const observedRead = read.events.some((event) => event.method === "item/completed" && event.status === "completed" && /gmail/i.test(`${event.serverName} ${event.toolName}`) && /read_email/i.test(event.toolName ?? ""));
      providerCalled = providerCalled || observedRead;
      if (!observedRead && readDispatch) providerCallUncertain = true;
      const readEvent = read.events.find((event) => event.method === "item/completed" && event.status === "completed" && /gmail/i.test(`${event.serverName} ${event.toolName}`) && /read_email/i.test(event.toolName ?? ""));
      if (read.status !== "completed") throw new GmailSourceAcquisitionError(read.exactBlocker ?? "gmail_source_message_read_failed", providerCalled, providerCallUncertain);
      const unexpectedWrite = [...profile.events, ...read.events].some((event) => /gmail/i.test(`${event.serverName} ${event.toolName}`) && /send|draft|delete|archive|modify|label|mark_read/i.test(event.toolName ?? ""));
      if (unexpectedWrite) throw new GmailSourceAcquisitionError("gmail_source_unexpected_write_operation", providerCalled, providerCallUncertain, true);
      const source = read.gmailSourceMessage;
      if (!source) throw new GmailSourceAcquisitionError("gmail_source_message_structured_result_missing", providerCalled, providerCallUncertain);
      if (source.id !== context.messageId) throw new GmailSourceAcquisitionError("gmail_source_message_id_mismatch", providerCalled, providerCallUncertain);
      const readArgs = readEvent?.toolArguments;
      if (!readEvent?.itemId || !readArgs || readArgs.message_id !== context.messageId || readArgs.format !== "metadata"
        || (linkId ? readArgs.link_id !== linkId : readArgs.link_id !== undefined && readArgs.link_id !== null)) throw new GmailSourceAcquisitionError("gmail_source_read_receipt_invalid", providerCalled);
      const headers = new Map<string, string[]>();
      for (const header of source.payload.headers) {
        const name = header.name.trim().toLowerCase(), value = header.value.trim();
        if (name && value) headers.set(name, [...(headers.get(name) ?? []), value]);
      }
      const get = (name: string) => headers.get(name) ?? [];
      const messageIds = get("message-id"), from = get("from"), replyTo = get("reply-to"), subject = get("subject");
      if (messageIds.length !== 1) throw new GmailSourceAcquisitionError(messageIds.length ? "gmail_source_header_ambiguous:message-id" : "gmail_source_header_missing:message-id", providerCalled);
      if (from.length !== 1) throw new GmailSourceAcquisitionError(from.length ? "gmail_source_header_ambiguous:from" : "gmail_source_header_missing:from", providerCalled);
      if (replyTo.length > 1) throw new GmailSourceAcquisitionError("gmail_source_header_ambiguous:reply-to", providerCalled);
      if (subject.length !== 1) throw new GmailSourceAcquisitionError(subject.length ? "gmail_source_header_ambiguous:subject" : "gmail_source_header_missing:subject", providerCalled);
      const selectedHeader = replyTo[0] ?? from[0], selectedName = replyTo.length ? "reply-to" : "from";
      const mailboxMatch = selectedHeader.match(/^\s*(?:(?:[^<>,"]+|"[^"]*")\s*<([^<>\s@]+@[^<>\s@]+)>|([^<>,\s]+@[^<>,\s]+))\s*$/u);
      if (!mailboxMatch) {
        const ambiguous = /,|<[^<>]*>[^,]*<|<[^<>]*>,/u.test(selectedHeader);
        throw new GmailSourceAcquisitionError(ambiguous ? `gmail_source_header_ambiguous:${selectedName}-mailbox` : `gmail_source_header_invalid:${selectedName}-mailbox`, providerCalled);
      }
      const recipient = mailboxMatch[1] ?? mailboxMatch[2];
      return { source_message: { message_id: source.id, thread_id: source.thread_id, structured_headers: {
        recipient, subject: subject[0], in_reply_to: messageIds[0], references: get("references").flatMap((value) => value.match(/<[^<>\s]+>/gu) ?? [])
      } }, receipt: { profile_turn_id: profile.turnId, read_turn_id: read.turnId, profile_call_id: profileEvent.itemId, read_call_id: readEvent.itemId,
        profile_args_sha256: sha256Canonical(profileEvent.toolArguments ?? {}), read_args_sha256: sha256Canonical(readArgs), profile_tool_observed: true, read_tool_observed: true } };
    } catch (error) {
      if (error instanceof GmailSourceAcquisitionError) throw error;
      const uncertain = providerCallUncertain || profileDispatch || readDispatch;
      throw new GmailSourceAcquisitionError(error instanceof Error ? error.message : "gmail_source_transport_failed", providerCalled, uncertain, uncertain ? null : false);
    } finally { if (ownsClient) client.close(); }
  };
}

export async function readVerifiedGmailSourceAcquisition(input: { companyId: string; sourceRunId: string; messageId: string }) {
  const runSql = `SELECT metadata_json FROM runs WHERE id=${sqlValue(input.sourceRunId)} AND company_id=${sqlValue(input.companyId)} LIMIT 1`;
  const row = (dbBackend === "postgres" ? (await querySqlAsync<{ metadata_json: string }>(runSql))[0] : querySql<{ metadata_json: string }>(runSql)[0]);
  const metadata = row ? parse(row.metadata_json) : {};
  const acquisition = record(metadata.gmail_source_acquisition) ? metadata.gmail_source_acquisition : null;
  const auth = acquisition && record(acquisition.authenticated_context) ? acquisition.authenticated_context : null;
  if (!row || !acquisition || acquisition.schema !== GMAIL_SOURCE_ACQUISITION_SCHEMA || acquisition.source_run_id !== input.sourceRunId
    || acquisition.source_message_id !== input.messageId || auth?.company_id !== input.companyId) {
    throw new Error("gmail_source_acquisition_readback_missing");
  }
  if (typeof acquisition.artifact_checksum_sha256 !== "string" || typeof acquisition.artifact_id !== "string" || typeof acquisition.proof_id !== "string" || !record(acquisition.receipt)
    || typeof acquisition.receipt.profile_turn_id !== "string" || typeof acquisition.receipt.read_turn_id !== "string") throw new Error("gmail_source_acquisition_readback_mismatch");
  const artifact = (dbBackend === "postgres"
    ? (await querySqlAsync<{ content_text: string; checksum_sha256: string; size_bytes: number }>(`SELECT content_text, checksum_sha256, size_bytes FROM run_artifacts WHERE id=${sqlValue(acquisition.artifact_id as string)} AND run_id=${sqlValue(input.sourceRunId)} AND company_id=${sqlValue(input.companyId)} AND status='available' LIMIT 1`))[0]
    : querySql<{ content_text: string; checksum_sha256: string; size_bytes: number }>(`SELECT content_text, checksum_sha256, size_bytes FROM run_artifacts WHERE id=${sqlValue(acquisition.artifact_id as string)} AND run_id=${sqlValue(input.sourceRunId)} AND company_id=${sqlValue(input.companyId)} AND status='available' LIMIT 1`)[0]);
  if (!artifact || createHash("sha256").update(artifact.content_text, "utf8").digest("hex") !== artifact.checksum_sha256
    || artifact.checksum_sha256 !== acquisition.artifact_checksum_sha256 || Buffer.byteLength(artifact.content_text) !== artifact.size_bytes) throw new Error("gmail_source_acquisition_artifact_unverified");
  const proofSql = `SELECT id, company_id, run_id, artifact_id, metadata_json FROM proofs WHERE id=${sqlValue(acquisition.proof_id as string)} AND company_id=${sqlValue(input.companyId)} AND run_id=${sqlValue(input.sourceRunId)} AND artifact_id=${sqlValue(acquisition.artifact_id as string)} LIMIT 1`;
  const proof = (dbBackend === "postgres" ? (await querySqlAsync<{ id: string; company_id: string; run_id: string; artifact_id: string; metadata_json: string }>(proofSql))[0] : querySql<{ id: string; company_id: string; run_id: string; artifact_id: string; metadata_json: string }>(proofSql)[0]);
  if (!proof) throw new Error("gmail_source_acquisition_proof_unlinked");
  const proofMetadata = parse(proof.metadata_json);
  if (proofMetadata.schema !== GMAIL_SOURCE_ACQUISITION_SCHEMA || proofMetadata.source_evidence_sha256 !== acquisition.source_evidence_sha256
    || proofMetadata.company_id !== input.companyId || proofMetadata.connection_ref_id !== auth.connection_ref_id) throw new Error("gmail_source_acquisition_proof_mismatch");
  const envelope = parse(artifact.content_text.trim());
  if (envelope.schema !== "aos.gmail_source_evidence.v1" || sha256Canonical(envelope) !== acquisition.source_evidence_sha256) throw new Error("gmail_source_acquisition_readback_mismatch");
  return { acquisition, envelope, artifact_checksum_sha256: artifact.checksum_sha256 };
}

import { createHash } from "node:crypto";
import { nowIso, querySqlAsync, runSqlTransactionAsync, sqlValue } from "../db/client.js";
import { acceptedGmailReviewAnchor, normalizeGmailReviewResult } from "./gmailReviewResult.js";

const schema = "aos.gmail_review_source_sync.v1";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type RunRow = { id: string; company_id: string; status: string; metadata_json: string };

/** Source-only repair: append a verified result, never resume or rewrite the original worker receipt. */
export async function syncGmailReviewResult(input: { companyId: string; runId: string; reviewResult: unknown; idempotencyKey: string }) {
  const readRun = async () => (await querySqlAsync<RunRow>(`SELECT id, company_id, status, metadata_json FROM runs
    WHERE id=${sqlValue(input.runId)} AND company_id=${sqlValue(input.companyId)} LIMIT 1`))[0];
  const run = await readRun();
  if (!run) throw new Error("gmail_review_run_not_found");
  const metadata = JSON.parse(run.metadata_json) as Record<string, any>;
  const anchor = acceptedGmailReviewAnchor(metadata, run.id, run.company_id);
  if (run.status !== "complete" || !anchor) throw new Error("gmail_review_completed_read_only_receipt_required");
  if (input.idempotencyKey !== `gmail-review-result:${run.id}:${anchor.review_hash}`) throw new Error("gmail_review_idempotency_binding_mismatch");
  const result = normalizeGmailReviewResult(input.reviewResult, { runId: run.id, companyId: run.company_id, reviewHash: anchor.review_hash });
  if (!result || Object.entries(result.diagnostics).some(([key, value]) => anchor.diagnostics[key] !== value)) {
    throw new Error("gmail_review_source_hash_or_result_mismatch");
  }
  const binding = hash(`${run.company_id}:${run.id}:${result.review_hash}`).slice(0, 32);
  const artifactId = `artifact_gmail_review_${binding}`;
  const proofId = `proof_gmail_review_${binding}`;
  const artifactUri = `/api/v1/companies/${encodeURIComponent(run.company_id)}/artifacts/${artifactId}`;
  const readVerified = async (replayed: boolean) => {
    const current = await readRun();
    const sync = current ? (JSON.parse(current.metadata_json) as Record<string, any>).gmail_review_source_sync : null;
    if (current?.status !== "complete" || sync?.schema !== schema || sync.run_id !== run.id || sync.company_id !== run.company_id
      || sync.source_review_hash !== result.review_hash || sync.display_content_sha256 !== result.display_content_sha256
      || sync.artifact_id !== artifactId || sync.proof_id !== proofId) throw new Error("gmail_review_sync_readback_mismatch");
    const artifact = (await querySqlAsync<{ content_text: string; checksum_sha256: string; size_bytes: number }>(
      `SELECT content_text, checksum_sha256, size_bytes FROM run_artifacts WHERE id=${sqlValue(artifactId)}
       AND run_id=${sqlValue(run.id)} AND company_id=${sqlValue(run.company_id)} AND status='available' LIMIT 1`))[0];
    const proof = (await querySqlAsync<{ id: string }>(`SELECT id FROM proofs WHERE id=${sqlValue(proofId)}
      AND run_id=${sqlValue(run.id)} AND company_id=${sqlValue(run.company_id)} AND artifact_id=${sqlValue(artifactId)} LIMIT 1`))[0];
    if (!artifact || !proof || hash(artifact.content_text) !== artifact.checksum_sha256
      || Buffer.byteLength(artifact.content_text) !== artifact.size_bytes) throw new Error("gmail_review_sync_artifact_unverified");
    const content = JSON.parse(artifact.content_text) as Record<string, any>;
    if (content.schema !== schema || content.run_id !== run.id || content.company_id !== run.company_id
      || content.source_review_hash !== result.review_hash
      || hash(JSON.stringify(content.review_result?.review)) !== result.display_content_sha256
      || hash(JSON.stringify(sync.review_result?.review)) !== result.display_content_sha256) throw new Error("gmail_review_sync_artifact_unverified");
    return { schema, status: "source_synced" as const, run_id: run.id, company_id: run.company_id, artifact_id: artifactId,
      proof_id: proofId, artifact_uri: artifactUri, source_review_hash: result.review_hash, fetched_count: result.diagnostics.fetched_count,
      reply_candidate_count: result.diagnostics.reply_candidate_count, synced_at: sync.synced_at as string,
      replayed, run_started: false, provider_called: false, external_action_executed: false };
  };
  if (metadata.gmail_review_source_sync) return readVerified(true);
  const timestamp = nowIso();
  const sync = { schema, run_id: run.id, company_id: run.company_id, source_review_hash: result.review_hash,
    display_content_sha256: result.display_content_sha256, artifact_id: artifactId, proof_id: proofId, synced_at: timestamp, review_result: result };
  const contentText = `${JSON.stringify(sync, null, 2)}\n`;
  const checksum = hash(contentText);
  const size = Buffer.byteLength(contentText);
  const label = "Gmail 同一Run保存結果の同期（再実行なし）";
  try {
    await runSqlTransactionAsync([
      { sql: `UPDATE runs SET metadata_json=${sqlValue({ ...metadata, gmail_review_source_sync: sync })}
        WHERE id=${sqlValue(run.id)} AND company_id=${sqlValue(run.company_id)} AND status='complete'
          AND metadata_json=${sqlValue(run.metadata_json)}`, expectChanges: 1 },
      { sql: `INSERT INTO run_artifacts (id, company_id, run_id, step_id, attempt_id, kind, label, mime_type, checksum_sha256,
          size_bytes, content_text, status, created_at, updated_at)
        VALUES (${sqlValue(artifactId)}, ${sqlValue(run.company_id)}, ${sqlValue(run.id)}, NULL, NULL, 'gmail_review_result',
          ${sqlValue(label)}, 'application/json', ${sqlValue(checksum)}, ${size}, ${sqlValue(contentText)}, 'available', ${sqlValue(timestamp)}, ${sqlValue(timestamp)})`, expectChanges: 1 },
      { sql: `INSERT INTO proofs (id, company_id, run_id, step_id, artifact_id, proof_type, label, uri, size_bytes, created_at, metadata_json)
        VALUES (${sqlValue(proofId)}, ${sqlValue(run.company_id)}, ${sqlValue(run.id)}, NULL, ${sqlValue(artifactId)}, 'source_sync',
          ${sqlValue(label)}, ${sqlValue(artifactUri)}, ${size}, ${sqlValue(timestamp)},
          ${sqlValue({ schema, source_review_hash: result.review_hash, checksum_sha256: checksum, provider_called: false,
            original_worker_receipt_preserved: true, business_proof_verified: false, external_action_executed: false })})`, expectChanges: 1 }
    ]);
  } catch (error) {
    // A racing request may have committed the exact same immutable artifact.
    // Never rerun the writer or provider in response to an uncertain result.
    try { return await readVerified(true); } catch { throw error; }
  }
  return readVerified(false);
}

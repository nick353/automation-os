import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { acceptedGmailReviewAnchor, normalizeGmailReviewResult } from "../runs/gmailReviewResult.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fixture(runId = "gmail_result_fixture_run", companyId = "gmail_result_fixture_company", count = 100, proposals = 5) {
  const review = { provider: "gmail", operation: "summary_review", fetched_count: count, exhausted: count < 100,
    items: Array.from({ length: count }, (_, i) => ({ message_id: `mail${i}`, category: "確認", summary: `要約${i}`, reply_candidate: i < proposals ? `未送信案${i}` : null })), exact_blocker: null };
  return { run_id: runId, company_id: companyId, status: "complete", exact_blocker: null, review, review_hash: digest(review),
    provider_read_observed: true, reply_candidates_require_approval: true, provider_drafts_created: false, messages_sent: false, external_action_executed: false,
    diagnostics: { fetched_count: count, item_count: count, unique_id_count: count, reply_candidate_count: Math.min(count, proposals), exhausted: count < 100, provider_read_call_count: 2 } };
}
function anchorMetadata(result: ReturnType<typeof fixture>) {
  return { external_action_executed: false, remote_worker_receipt: { status: "complete", exact_blocker: null,
    run_id: result.run_id, workflow_id: "email-review-reply", effects_mode: "read_only", read_only_proof_verified: true,
    same_run_receipt: true, readback_verified: true, cleanup_verified: true, external_action_executed: false,
    adapter_result: { local_receipt: { review: { ...result, review: { ...result.review, items: [{}, {}] } } } } } };
}

test("Gmail result normalization preserves 100 typed summaries and five proposals without arbitrary receipt fields", () => {
  const source: any = fixture();
  source.identity = { secret: "never-copy" };
  source.review.items[0].raw_body = "never-copy";
  source.review.items[0].summary = "password=private-value recipient@example.com";
  source.review_hash = digest(source.review);
  const before = JSON.stringify(source);
  const result = normalizeGmailReviewResult(source, { runId: source.run_id, companyId: source.company_id });
  assert.ok(result);
  assert.equal(result.review.items.length, 100);
  assert.equal(result.review.items.filter((item: any) => item.reply_candidate).length, 5);
  assert.equal(result.review_hash, source.review_hash, "the original source hash remains explicit after display sanitization");
  assert.equal(result.display_content_sha256, digest(result.review));
  assert.doesNotMatch(JSON.stringify(result), /never-copy|private-value|recipient@example/);
  assert.equal(JSON.stringify(source), before, "the original source is immutable");
  for (const count of [0, 5, 99]) {
    const less = fixture("r", "c", count, 0);
    assert.equal(normalizeGmailReviewResult(less, { runId: "r", companyId: "c" })?.review.items.length, count);
  }
});

test("Gmail result normalization rejects mismatched scope, hash, counts, duplicates, excess proposals and effect flags", () => {
  const source = fixture();
  const expected = { runId: source.run_id, companyId: source.company_id, reviewHash: source.review_hash };
  for (const override of [{ run_id: "other" }, { company_id: "other" }, { review_hash: "0".repeat(64) },
    { messages_sent: true }, { provider_drafts_created: true }, { external_action_executed: true }, { provider_read_observed: false },
    { reply_candidates_require_approval: false }, { status: "blocked" }]) assert.equal(normalizeGmailReviewResult({ ...source, ...override }, expected), null);
  for (const mutate of [
    (v: any) => { v.review.items[1].message_id = v.review.items[0].message_id; },
    (v: any) => { v.review.items[5].reply_candidate = "sixth"; v.diagnostics.reply_candidate_count = 6; },
    (v: any) => { v.review.items.pop(); },
    (v: any) => { v.review.items[0].summary = "x".repeat(241); },
    (v: any) => { v.diagnostics.unique_id_count = 99; },
    (v: any) => { v.review.exhausted = true; }
  ]) {
    const changed: any = structuredClone(source); mutate(changed); changed.review_hash = digest(changed.review);
    assert.equal(normalizeGmailReviewResult(changed, { runId: source.run_id, companyId: source.company_id }), null);
  }
});

test("source-only repair needs the previously accepted complete same-company Gmail receipt", () => {
  const source = fixture();
  const metadata = anchorMetadata(source);
  assert.equal(acceptedGmailReviewAnchor(metadata, source.run_id, source.company_id)?.review_hash, source.review_hash);
  assert.equal(acceptedGmailReviewAnchor(metadata, "other", source.company_id), null);
  assert.equal(acceptedGmailReviewAnchor(metadata, source.run_id, "other"), null);
  for (const override of [{ effects_mode: "business_effect" }, { status: "blocked" }, { workflow_id: "other" },
    { read_only_proof_verified: false }, { same_run_receipt: false }, { readback_verified: false }, { cleanup_verified: false }, { external_action_executed: true }]) {
    assert.equal(acceptedGmailReviewAnchor({ ...metadata, remote_worker_receipt: { ...metadata.remote_worker_receipt, ...override } }, source.run_id, source.company_id), null);
  }
});

const postgresUrl = process.env.AUTOMATION_OS_TEST_POSTGRES_URL;
test("isolated PostgreSQL: source-only Gmail repair preserves the completed Run and original receipt, is atomic and company scoped", {
  skip: postgresUrl ? false : "postgres_fixture_unavailable", timeout: 120_000
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "aos-gmail-result-sync-pg-"));
  process.env.AUTOMATION_OS_DATABASE_URL = postgresUrl;
  process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(root, "artifacts");
  process.env.AUTOMATION_OS_SECRET_DIR = join(root, "secrets");
  process.env.AOS_WEB_OPERATION_BACKEND_CONFIG = join(root, "backend.json");
  process.env.AUTOMATION_OS_OWNER_USER_ID = "gmail_result_fixture_operator";
  process.env.AUTOMATION_OS_WORKER_ROLE = "mac";
  process.env.NODE_TEST_CONTEXT = "1";
  const db = await import("../db/client.js");
  const { syncGmailReviewResult } = await import("../runs/gmailReviewResultSync.js");
  await db.initializePostgresSchemaAsync();
  const source = fixture();
  const timestamp = "2026-01-01T00:00:00.000Z";
  const actor = process.env.AUTOMATION_OS_OWNER_USER_ID;
  await db.insertAsync("users", { id: actor, auth_provider: "service", auth_subject: actor, email: null, display_name: actor, kind: "service", status: "active", created_at: timestamp, updated_at: timestamp });
  await db.insertAsync("companies", { id: source.company_id, slug: "gmail-result-fixture", name: "Gmail result fixture", status: "active", created_at: timestamp, updated_at: timestamp });
  await db.insertAsync("company_memberships", { id: "gmail_result_member", company_id: source.company_id, user_id: actor, role: "operator", status: "active", created_at: timestamp, updated_at: timestamp });
  const seed = async (value: ReturnType<typeof fixture>) => db.insertAsync("runs", { id: value.run_id, company_id: value.company_id,
    name: "Completed Gmail fixture", status: "complete", objective: "No provider call", created_at: timestamp, updated_at: timestamp, metadata_json: JSON.stringify(anchorMetadata(value)) });
  await seed(source);
  const inputFor = (value: ReturnType<typeof fixture>) => ({ companyId: value.company_id, runId: value.run_id, reviewResult: value,
    idempotencyKey: `gmail-review-result:${value.run_id}:${value.review_hash}` });
  const input = inputFor(source);
  await assert.rejects(syncGmailReviewResult({ ...input, companyId: "foreign" }), /run_not_found/);
  await assert.rejects(syncGmailReviewResult({ ...input, idempotencyKey: "new-attempt" }), /idempotency_binding/);
  const changed = structuredClone(source); changed.review.items[0].summary = "replacement"; changed.review_hash = digest(changed.review);
  await assert.rejects(syncGmailReviewResult({ ...input, reviewResult: changed }), /source_hash_or_result_mismatch/);
  const result = await syncGmailReviewResult(input);
  assert.equal(result.status, "source_synced");
  assert.equal(result.provider_called, false);
  const replay = await syncGmailReviewResult(input);
  assert.equal(replay.artifact_id, result.artifact_id);
  assert.equal(replay.replayed, true);
  const current = (await db.querySqlAsync<{ metadata_json: string; status: string; updated_at: string }>(`SELECT metadata_json, status, updated_at FROM runs WHERE id=${db.sqlValue(source.run_id)}`))[0];
  const metadata = JSON.parse(current.metadata_json);
  assert.deepEqual(metadata.remote_worker_receipt, anchorMetadata(source).remote_worker_receipt);
  assert.equal(metadata.gmail_review_source_sync.review_result.review.items.length, 100);
  assert.equal(current.status, "complete");
  assert.equal(current.updated_at, timestamp, "source sync cannot become a new execution completion timestamp");
  assert.equal((await db.querySqlAsync(`SELECT id FROM runs`)).length, 1);
  assert.equal((await db.querySqlAsync(`SELECT id FROM run_artifacts WHERE run_id=${db.sqlValue(source.run_id)}`)).length, 1);
  assert.equal((await db.querySqlAsync(`SELECT id FROM proofs WHERE run_id=${db.sqlValue(source.run_id)}`)).length, 1);
  assert.deepEqual(await db.querySqlAsync(`SELECT id FROM durable_jobs`), []);

  const concurrent = fixture("gmail_result_concurrent"); await seed(concurrent);
  const results = await Promise.all([syncGmailReviewResult(inputFor(concurrent)), syncGmailReviewResult(inputFor(concurrent))]);
  assert.equal(results[0].artifact_id, results[1].artifact_id);
  assert.equal((await db.querySqlAsync(`SELECT id FROM run_artifacts WHERE run_id=${db.sqlValue(concurrent.run_id)}`)).length, 1);

  const interrupted = fixture("gmail_result_atomic"); await seed(interrupted);
  await db.querySqlAsync(`CREATE FUNCTION fixture_gmail_sync_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.run_id='gmail_result_atomic' THEN RAISE EXCEPTION 'fixture_gmail_sync_failed'; END IF; RETURN NEW; END; $$`);
  await db.querySqlAsync(`CREATE TRIGGER fixture_gmail_sync_failure BEFORE INSERT ON proofs FOR EACH ROW EXECUTE FUNCTION fixture_gmail_sync_failure()`);
  await assert.rejects(syncGmailReviewResult(inputFor(interrupted)), /fixture_gmail_sync_failed/);
  assert.deepEqual(await db.querySqlAsync(`SELECT id FROM run_artifacts WHERE run_id='gmail_result_atomic'`), []);
  const aborted = (await db.querySqlAsync<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id='gmail_result_atomic'`))[0];
  assert.equal(JSON.parse(aborted.metadata_json).gmail_review_source_sync, undefined);
  await db.querySqlAsync(`DROP TRIGGER fixture_gmail_sync_failure ON proofs`);
  await db.querySqlAsync(`DROP FUNCTION fixture_gmail_sync_failure()`);

  const { app, getRunDetailAsync } = await import("../index.js");
  const request = (path: string, payload: Record<string, unknown>, headers: Record<string, string>) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = Readable.from([Buffer.from(body)]) as NodeJS.ReadableStream & { method?: string; url?: string; headers?: Record<string, string> };
    req.method = "POST"; req.url = path; req.headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)), ...headers };
    const res = { statusCode: 200, setHeader() { return this; }, getHeader() { return undefined; }, removeHeader() { return undefined; },
      end(chunk?: string | Buffer) { resolve({ status: this.statusCode, body: JSON.parse(String(chunk ?? "{}")) }); return this; } };
    (app as unknown as { handle(req: unknown, res: unknown, next: (error?: unknown) => void): void }).handle(req, res, reject);
  });
  const route = `/api/v1/companies/${source.company_id}/runs/${source.run_id}/gmail-review-result`;
  const headers = { "idempotency-key": input.idempotencyKey };
  const api = await request(route, { review_result: source }, headers);
  assert.equal(api.status, 200); assert.equal(api.body.replayed, true);
  assert.equal((await request(route, { review_result: source, resume_run: true }, headers)).status, 400);
  assert.equal((await request(route.replace(source.run_id, "missing"), { review_result: source }, headers)).status, 404);
  const detail = await getRunDetailAsync(source.run_id, [source.company_id]);
  assert.equal(JSON.parse(String(detail?.run.metadata_json)).gmail_review_source_sync.review_result.review.items.length, 100);
  assert.equal(await getRunDetailAsync(source.run_id, ["foreign"]), undefined);
  await db.querySqlAsync(`UPDATE company_memberships SET role='viewer' WHERE id='gmail_result_member'`);
  assert.equal((await request(route, { review_result: source }, headers)).body.ok, false);
});

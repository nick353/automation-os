import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "aos-gmail-reply-admission-"));
process.env.AUTOMATION_OS_DB = join(root, "automation-os.sqlite");
process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(root, "artifacts");
process.env.AUTOMATION_OS_OWNER_USER_ID = "gmail_reply_admission_owner";
process.env.NODE_TEST_CONTEXT = "1";

const db = await import("../db/client.js");
const { app } = await import("../index.js");
const { startPortableLocalWorkflowRun } = await import("../runs/portableLocalWorkflowEntrypoint.js");
const { produceGmailReplyEffect, sha256Canonical } = await import("../runs/gmailReplyEffect.js");
const { acquireGmailSource } = await import("../runs/gmailSourceAcquisition.js");

const companyId = "gmail_reply_admission_company";
const connectionId = "gmail_reply_admission_connection";
const accountRef = "owner@example.test";

function request(method: string, path: string, payload?: unknown, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const text = payload === undefined ? "" : JSON.stringify(payload);
    const req = Readable.from(text ? [Buffer.from(text)] : []) as NodeJS.ReadableStream & {
      method?: string; url?: string; headers?: Record<string, string>;
    };
    req.method = method;
    req.url = path;
    req.headers = { ...(text ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) } : {}), ...headers };
    const chunks: Buffer[] = [];
    const responseHeaders = new Map<string, unknown>();
    const res = {
      statusCode: 200,
      setHeader(name: string, value: unknown) { responseHeaders.set(name.toLowerCase(), value); return this; },
      getHeader(name: string) { return responseHeaders.get(name.toLowerCase()); },
      removeHeader(name: string) { responseHeaders.delete(name.toLowerCase()); return this; },
      end(chunk?: string | Buffer) {
        if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString("utf8");
        resolve({ status: this.statusCode, body: body ? JSON.parse(body) : {} });
        return this;
      }
    };
    (app as unknown as { handle(req: unknown, res: unknown, next: (error?: unknown) => void): void }).handle(req, res, reject);
  });
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function candidate(sourceRunId: string, reviewHash: string) {
  return {
    schema: "aos.gmail_reply_effect_input.v1",
    version: 1,
    source_message: {
      message_id: "source-message-1",
      thread_id: "source-thread-1",
      structured_headers: {
        recipient: accountRef,
        subject: "確認事項",
        in_reply_to: "<source-message-1@example.test>",
        references: ["<source-message-0@example.test>"]
      },
      provenance_snapshot: {
        source_run_id: sourceRunId,
        source_review_hash: reviewHash,
        source_snapshot_sha256: "b".repeat(64)
      }
    },
    reply_draft: { body: "承知しました。確認のうえ返信します。" },
    attachments: []
  };
}

async function seedSource(sourceRunId: string) {
  db.initDb();
  const now = db.nowIso();
  db.upsert("users", { id: "gmail_reply_admission_owner", auth_provider: "test", auth_subject: "gmail_reply_admission_owner",
    email: accountRef, display_name: "Gmail admission owner", kind: "human", status: "active", created_at: now, updated_at: now });
  db.upsert("companies", { id: companyId, slug: companyId, name: "Gmail reply admission", status: "active", created_at: now, updated_at: now });
  db.upsert("company_memberships", { id: "gmail_reply_admission_membership", company_id: companyId,
    user_id: "gmail_reply_admission_owner", role: "owner", status: "active", created_at: now, updated_at: now });
  db.upsert("company_connection_account_refs", { id: connectionId, company_id: companyId, platform: "gmail", account_ref: accountRef,
    status: "verified", scopes_json: ["read"], expires_at: null, oauth_state: "connected", verification_status: "verified",
    last_verified_at: now, reconnect_requested_at: null, revoked_at: null, revision: 1, created_at: now, updated_at: now });
  const started = await startPortableLocalWorkflowRun({ workflowId: "email-review-reply", sourceTrigger: "automation_os_ui",
    idempotencyKey: `${sourceRunId}-read-only`, companyId, inputBundle: { connection_ref_id: connectionId, account_ref: accountRef },
    readOnlyStage: "reference_readback" });
  const review = { provider: "gmail", operation: "summary_review", fetched_count: 1, exhausted: true,
    items: [{ message_id: "source-message-1", category: "reply", summary: "確認事項", reply_candidate: "保存済み案" }], exact_blocker: null };
  const reviewHash = digest(review);
  const input = candidate(started.runId, reviewHash);
  input.source_message.provenance_snapshot.source_snapshot_sha256 = sha256Canonical({
    message_id: input.source_message.message_id, thread_id: input.source_message.thread_id,
    structured_headers: input.source_message.structured_headers
  });
  const sourceEvidence = { schema: "aos.gmail_source_evidence.v1", version: 1, source_message: input.source_message };
  const reviewResult = { run_id: started.runId, company_id: companyId, status: "complete", exact_blocker: null, review, review_hash: reviewHash,
    provider_read_observed: true, reply_candidates_require_approval: true, messages_sent: false, provider_drafts_created: false,
    external_action_executed: false, diagnostics: { fetched_count: 1, item_count: 1, unique_id_count: 1, reply_candidate_count: 1, exhausted: true, provider_read_call_count: 1 } };
  const raw = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)} LIMIT 1`)[0];
  const metadata = JSON.parse(raw.metadata_json) as Record<string, any>;
  metadata.remote_worker_receipt = { status: "complete", exact_blocker: null, run_id: started.runId, workflow_id: "email-review-reply",
    effects_mode: "read_only", read_only_proof_verified: true, same_run_receipt: true, readback_verified: true, cleanup_verified: true,
    external_action_executed: false, adapter_result: { local_receipt: { review: reviewResult } } };
  metadata.gmail_review_source_sync = { schema: "aos.gmail_review_source_sync.v1", run_id: started.runId, company_id: companyId,
    account_ref: accountRef, review_result: reviewResult };
  db.execSql(`UPDATE runs SET status='complete', metadata_json=${db.sqlValue(metadata)} WHERE id=${db.sqlValue(started.runId)}`);
  await acquireGmailSource({ companyId, sourceRunId: started.runId, messageId: input.source_message.message_id,
    transport: async (context) => {
      assert.equal(context.companyId, companyId);
      assert.equal(context.accountRef, accountRef);
      assert.equal(context.connectionRefId, connectionId);
      return { message_id: input.source_message.message_id, thread_id: input.source_message.thread_id,
        structured_headers: input.source_message.structured_headers,
        receipt: { profile_turn_id: "profile-turn", read_turn_id: "read-turn", profile_call_id: "profile-call", read_call_id: "read-call", profile_args_sha256: "profile-args", read_args_sha256: "read-args" } };
    } });
  return { sourceRunId: started.runId, reviewHash, input };
}

test("canonical Gmail admission is company-bound, server-recomputed, persisted, and idempotent without provider calls", async () => {
  const source = await seedSource("gmail_reply_source_1");
  const path = `/api/v1/companies/${companyId}/runs/${source.sourceRunId}/gmail-reply-admission`;
  const headers = { "idempotency-key": "gmail-reply-admission-1" };
  const first = await request("POST", path, { source_candidate: source.input }, headers);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.provider_called, false);
  assert.equal(first.body.external_action_executed, false);
  assert.equal(first.body.replayed, false);
  assert.equal(first.body.approval.status, "pending");
  assert.equal(first.body.run.status, "waiting_approval");
  const produced = produceGmailReplyEffect(source.input);
  assert.equal(produced.status, "ready");
  assert.equal(first.body.producer_result.canonical_reply_payload_sha256, produced.canonical_reply_payload_sha256);
  assert.equal(first.body.producer_result.source_evidence_sha256, produced.source_evidence_sha256);

  const replay = await request("POST", path, { source_candidate: source.input }, headers);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.run.id, first.body.run.id);
  assert.deepEqual(replay.body.producer_result, first.body.producer_result);
  assert.equal((db.querySql<{ count: number }>(`SELECT COUNT(*) AS count FROM runs WHERE company_id=${db.sqlValue(companyId)}`)[0]).count, 2);
  assert.equal((db.querySql<{ count: number }>(`SELECT COUNT(*) AS count FROM approvals WHERE run_id=${db.sqlValue(first.body.run.id)}`)[0]).count, 1);

  const detail = await request("GET", `/api/v1/companies/${companyId}/runs/${first.body.run.id}`);
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.run.id, first.body.run.id);
  assert.equal(detail.body.run.company_id, companyId);
  assert.equal(detail.body.run.status, "waiting_approval");
});

test("foreign source and conflicting payloads reject before a provider or second Run", async () => {
  const source = await seedSource("gmail_reply_source_2");
  const path = `/api/v1/companies/${companyId}/runs/${source.sourceRunId}/gmail-reply-admission`;
  const headers = { "idempotency-key": "gmail-reply-admission-2" };
  const foreign = structuredClone(source.input) as any;
  foreign.source_message.provenance_snapshot.source_run_id = "gmail_reply_other_source";
  const foreignResult = await request("POST", path, { source_candidate: foreign }, headers);
  assert.equal(foreignResult.status, 409);
  assert.equal(foreignResult.body.error, "gmail_reply_source_candidate_mismatch");
  assert.equal(foreignResult.body.provider_called, false);

  const first = await request("POST", path, { source_candidate: source.input }, headers);
  assert.equal(first.status, 201);
  const conflicting = structuredClone(source.input) as any;
  conflicting.reply_draft.body = "別の本文";
  const conflict = await request("POST", path, { source_candidate: conflicting }, headers);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, "portable_workflow_invocation_payload_conflict");
  assert.equal(conflict.body.provider_called, false);
  assert.equal((db.querySql<{ count: number }>(`SELECT COUNT(*) AS count FROM runs WHERE company_id=${db.sqlValue(companyId)}`)[0]).count, 4);
});

test("forged source identity, headers, account/company, hash, and incomplete evidence fail closed before Run or approval", async () => {
  const cases: Array<[string, (value: any) => void]> = [
    ["recipient", (value) => { value.source_message.structured_headers.recipient = "forged@example.test"; }],
    ["thread", (value) => { value.source_message.thread_id = "forged-thread"; }],
    ["headers", (value) => { value.source_message.structured_headers.in_reply_to = "<forged@example.test>"; }],
    ["wrong message", (value) => { value.source_message.message_id = "other-message"; }],
    ["valid hash", (value) => { value.source_message.provenance_snapshot.source_snapshot_sha256 = "a".repeat(64); }],
    ["foreign company", (value) => { value.source_message.company_id = "foreign-company"; }]
  ];
  for (const [label, mutate] of cases) {
    const source = await seedSource(`gmail_reply_negative_${label.replace(/ /gu, "-")}`);
    const beforeRuns = (db.querySql<{ count: number }>(`SELECT COUNT(*) AS count FROM runs WHERE company_id=${db.sqlValue(companyId)}`)[0]).count;
    const beforeApprovals = (db.querySql<{ count: number }>(`SELECT COUNT(*) AS count FROM approvals WHERE company_id=${db.sqlValue(companyId)}`)[0]).count;
    const value = structuredClone(source.input) as any;
    mutate(value);
    const response = await request("POST", `/api/v1/companies/${companyId}/runs/${source.sourceRunId}/gmail-reply-admission`,
      { source_candidate: value }, { "idempotency-key": `gmail-reply-negative-${label}` });
    assert.equal(response.status, 409, `${label}: ${JSON.stringify(response.body)}`);
    assert.equal(response.body.provider_called, false);
    assert.equal((db.querySql<{ count: number }>(`SELECT COUNT(*) AS count FROM runs WHERE company_id=${db.sqlValue(companyId)}`)[0]).count, beforeRuns);
    assert.equal((db.querySql<{ count: number }>(`SELECT COUNT(*) AS count FROM approvals WHERE company_id=${db.sqlValue(companyId)}`)[0]).count, beforeApprovals);
  }

  const foreignAccount = await seedSource("gmail_reply_negative-account");
  const foreignMetadata = JSON.parse((db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(foreignAccount.sourceRunId)}`)[0]).metadata_json) as Record<string, any>;
  foreignMetadata.gmail_source_acquisition.authenticated_context.account_ref = "foreign@example.test";
  db.execSql(`UPDATE runs SET metadata_json=${db.sqlValue(foreignMetadata)} WHERE id=${db.sqlValue(foreignAccount.sourceRunId)}`);
  const accountResponse = await request("POST", `/api/v1/companies/${companyId}/runs/${foreignAccount.sourceRunId}/gmail-reply-admission`,
    { source_candidate: foreignAccount.input }, { "idempotency-key": "gmail-reply-negative-account" });
  assert.equal(accountResponse.status, 409);
  assert.equal(accountResponse.body.error, "gmail_reply_source_account_mismatch");

  const incomplete = await seedSource("gmail_reply_negative-incomplete");
  const metadata = JSON.parse((db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(incomplete.sourceRunId)}`)[0]).metadata_json);
  delete metadata.gmail_source_acquisition;
  db.execSql(`UPDATE runs SET metadata_json=${db.sqlValue(metadata)} WHERE id=${db.sqlValue(incomplete.sourceRunId)}`);
  const incompleteResponse = await request("POST", `/api/v1/companies/${companyId}/runs/${incomplete.sourceRunId}/gmail-reply-admission`,
    { source_candidate: incomplete.input }, { "idempotency-key": "gmail-reply-negative-incomplete" });
  assert.equal(incompleteResponse.status, 409);
  assert.equal(incompleteResponse.body.error, "gmail_reply_source_evidence_incomplete");
});

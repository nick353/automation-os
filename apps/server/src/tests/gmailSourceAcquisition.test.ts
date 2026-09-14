import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "aos-gmail-source-acquisition-"));
process.env.AUTOMATION_OS_DB = join(root, "automation-os.sqlite");
process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(root, "artifacts");
process.env.AUTOMATION_OS_OWNER_USER_ID = "source_acquisition_owner";
process.env.NODE_TEST_CONTEXT = "1";
const db = await import("../db/client.js");
const { app } = await import("../index.js");
const { startPortableLocalWorkflowRun } = await import("../runs/portableLocalWorkflowEntrypoint.js");
const { acquireGmailSource, createApprovedGmailSourceTransport, GmailSourceAcquisitionError, readVerifiedGmailSourceAcquisition } = await import("../runs/gmailSourceAcquisition.js");
const { sha256Canonical } = await import("../runs/gmailReplyEffect.js");

const companyId = "source_acquisition_company";
const connectionId = "source_acquisition_connection";
const accountRef = "owner@example.test";
const messageId = "source-message-1";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function request(method: string, path: string, payload: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const text = JSON.stringify(payload);
    const req = Readable.from([Buffer.from(text)]) as NodeJS.ReadableStream & { method?: string; url?: string; headers?: Record<string, string> };
    req.method = method; req.url = path; req.headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) };
    const chunks: Buffer[] = [];
    const res = { statusCode: 200, setHeader() { return this; }, getHeader() { return undefined; }, removeHeader() { return this; }, end(chunk?: string | Buffer) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      resolve({ status: this.statusCode, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); return this;
    } };
    (app as unknown as { handle(req: unknown, res: unknown, next: (error?: unknown) => void): void }).handle(req, res, reject);
  });
}

test("mocked approved transport persists immutable acquisition and verified readback without changing old review", async () => {
  db.initDb();
  const now = db.nowIso();
  db.upsert("users", { id: "source_acquisition_owner", auth_provider: "test", auth_subject: "source_acquisition_owner", email: accountRef, display_name: "owner", kind: "human", status: "active", created_at: now, updated_at: now });
  db.upsert("companies", { id: companyId, slug: companyId, name: "source acquisition", status: "active", created_at: now, updated_at: now });
  db.upsert("company_memberships", { id: "source_acquisition_membership", company_id: companyId, user_id: "source_acquisition_owner", role: "owner", status: "active", created_at: now, updated_at: now });
  db.upsert("company_connection_account_refs", { id: connectionId, company_id: companyId, platform: "gmail", account_ref: accountRef, status: "verified", scopes_json: ["read"], expires_at: null, oauth_state: "connected", verification_status: "verified", last_verified_at: now, reconnect_requested_at: null, revoked_at: null, revision: 1, created_at: now, updated_at: now });
  const started = await startPortableLocalWorkflowRun({ workflowId: "email-review-reply", sourceTrigger: "automation_os_ui", idempotencyKey: "source-acquisition-review", companyId, inputBundle: { connection_ref_id: connectionId, account_ref: accountRef }, readOnlyStage: "reference_readback" });
  const review = { provider: "gmail", operation: "summary_review", fetched_count: 1, exhausted: true, items: [{ message_id: messageId, category: "reply", summary: "確認事項", reply_candidate: "保存済み案" }], exact_blocker: null };
  const reviewResult = { run_id: started.runId, company_id: companyId, status: "complete", exact_blocker: null, review, review_hash: digest(review), provider_read_observed: true, reply_candidates_require_approval: true, messages_sent: false, provider_drafts_created: false, external_action_executed: false, diagnostics: { fetched_count: 1, item_count: 1, unique_id_count: 1, reply_candidate_count: 1, exhausted: true, provider_read_call_count: 1 } };
  const raw = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)}`)[0];
  const metadata = JSON.parse(raw.metadata_json) as Record<string, any>;
  metadata.remote_worker_receipt = { status: "complete", exact_blocker: null, run_id: started.runId, workflow_id: "email-review-reply", effects_mode: "read_only", read_only_proof_verified: true, same_run_receipt: true, readback_verified: true, cleanup_verified: true, external_action_executed: false, adapter_result: { local_receipt: { review: reviewResult } } };
  metadata.gmail_review_source_sync = { schema: "aos.gmail_review_source_sync.v1", run_id: started.runId, company_id: companyId, review_result: reviewResult };
  db.execSql(`UPDATE runs SET status='complete', metadata_json=${db.sqlValue(metadata)} WHERE id=${db.sqlValue(started.runId)}`);
  const originalReview = JSON.stringify(metadata.gmail_review_source_sync);
  const result = await acquireGmailSource({ companyId, sourceRunId: started.runId, messageId, transport: async (context) => {
    assert.deepEqual(context, { sourceRunId: started.runId, messageId, companyId, accountRef, connectionRefId: connectionId });
    return { message_id: messageId, thread_id: "source-thread-1", structured_headers: { recipient: "owner@example.test", subject: "確認事項", in_reply_to: "<source-message-1@example.test>", references: ["<source-message-0@example.test>"] }, receipt: { profile_turn_id: "profile-turn", read_turn_id: "read-turn", profile_call_id: "profile-call", read_call_id: "read-call", profile_args_sha256: "profile-args", read_args_sha256: "read-args" } };
  } });
  const acquired = result as any;
  assert.equal(acquired.acquisition.authenticated_context.company_id, companyId);
  assert.equal(acquired.acquisition.authenticated_context.account_ref, accountRef);
  assert.equal(acquired.envelope.source_message.message_id, messageId);
  assert.equal((db.querySql<{ count: number }>(`SELECT COUNT(*) AS count FROM run_artifacts WHERE run_id=${db.sqlValue(started.runId)} AND kind='gmail_source_acquisition'`)[0]).count, 1);
  const readback = await readVerifiedGmailSourceAcquisition({ companyId, sourceRunId: started.runId, messageId });
  assert.deepEqual(readback.envelope, acquired.envelope);
  db.execSql(`UPDATE proofs SET artifact_id='wrong-artifact' WHERE id=${db.sqlValue(acquired.acquisition.proof_id)}`);
  await assert.rejects(() => readVerifiedGmailSourceAcquisition({ companyId, sourceRunId: started.runId, messageId }), /gmail_source_acquisition_proof_unlinked/);
  const after = JSON.parse(db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(started.runId)}`)[0].metadata_json) as Record<string, any>;
  assert.equal(JSON.stringify(after.gmail_review_source_sync), originalReview);
});

test("route rejects caller company A with foreign source Run B before transport or persistence", async () => {
  db.initDb();
  const now = db.nowIso();
  const callerCompany = "source_acquisition_caller_company";
  db.upsert("companies", { id: callerCompany, slug: callerCompany, name: "caller", status: "active", created_at: now, updated_at: now });
  db.upsert("company_memberships", { id: "source_acquisition_caller_membership", company_id: callerCompany, user_id: "source_acquisition_owner", role: "owner", status: "active", created_at: now, updated_at: now });
  const sourceRun = db.querySql<{ id: string }>("SELECT id FROM runs WHERE company_id='source_acquisition_company' ORDER BY created_at DESC LIMIT 1")[0];
  const counts = () => ({ runs: db.querySql<{ count: number }>("SELECT COUNT(*) AS count FROM runs")[0].count, artifacts: db.querySql<{ count: number }>("SELECT COUNT(*) AS count FROM run_artifacts")[0].count, proofs: db.querySql<{ count: number }>("SELECT COUNT(*) AS count FROM proofs")[0].count, approvals: db.querySql<{ count: number }>("SELECT COUNT(*) AS count FROM approvals")[0].count });
  const before = counts();
  const response = await request("POST", `/api/v1/companies/${callerCompany}/runs/${sourceRun.id}/gmail-source-acquisition`, { message_id: messageId });
  assert.equal(response.status, 404);
  assert.equal(response.body.error, "gmail_source_acquisition_source_run_not_found");
  assert.deepEqual(counts(), before);
});

test("approved adapter consumes actual structured tool shapes and rejects assistant prose", async () => {
  const emailHash = createHash("sha256").update(accountRef, "utf8").digest("hex");
  const capturedAt = new Date().toISOString();
  const fakeClient = (readResult: unknown, options: { readEvents?: any[] } = {}) => ({
    startOrResumeThread: async () => "thread-1",
    startTurn: async ({ text }: { text: string }) => text.includes("get_profile")
      ? { status: "completed", turnId: "profile-turn", providerAccountHash: emailHash, providerAccountHashSource: "gmail_profile_tool", events: [{ method: "item/completed", itemId: "profile-call", status: "completed", serverName: "codex_apps", toolName: "gmail_get_profile", toolArguments: {}, capturedAt }] }
      : { status: "completed", turnId: "read-turn", events: options.readEvents ?? [{ method: "item/completed", itemId: "read-call", status: "completed", serverName: "codex_apps", toolName: "gmail_read_email", toolArguments: { message_id: messageId, format: "metadata" }, capturedAt }], gmailSourceMessage: readResult }
  }) as any;
  const transport = createApprovedGmailSourceTransport({ client: fakeClient({ id: messageId, thread_id: "thread-1", payload: { headers: [
    { name: "From", value: "sender@example.test" }, { name: "Message-ID", value: "<message@example.test>" }, { name: "Subject", value: "subject" }, { name: "References", value: "<prior@example.test>" }
  ] } }) });
  const result = await transport({ sourceRunId: "run-1", messageId, companyId, accountRef, connectionRefId: connectionId });
  assert.equal((result as any).source_message.structured_headers.recipient, "sender@example.test");
  assert.equal((result as any).receipt.read_tool_observed, true);
  assert.equal((result as any).receipt.profile_call_id, "profile-call");
  assert.equal((result as any).receipt.read_call_id, "read-call");
  assert.equal((result as any).receipt.read_args_sha256, sha256Canonical({ message_id: messageId, format: "metadata" }));
  await assert.rejects(() => createApprovedGmailSourceTransport({ client: fakeClient(undefined) })({ sourceRunId: "run-1", messageId, companyId, accountRef, connectionRefId: connectionId }), /gmail_source_message_structured_result_missing/);
  const ambiguous = { id: messageId, thread_id: "thread-1", payload: { headers: [
    { name: "From", value: "Alice <a@example.test>, b@example.test" }, { name: "Message-ID", value: "<message@example.test>" }, { name: "Subject", value: "subject" }
  ] } };
  await assert.rejects(() => createApprovedGmailSourceTransport({ client: fakeClient(ambiguous) })({ sourceRunId: "run-1", messageId, companyId, accountRef, connectionRefId: connectionId }), /gmail_source_header_ambiguous:from-mailbox/);
  const invalidTrailing = { ...ambiguous, payload: { headers: [{ name: "From", value: "Alice <a@example.test> trailing" }, { name: "Message-ID", value: "<message@example.test>" }, { name: "Subject", value: "subject" }] } };
  await assert.rejects(() => createApprovedGmailSourceTransport({ client: fakeClient(invalidTrailing) })({ sourceRunId: "run-1", messageId, companyId, accountRef, connectionRefId: connectionId }), /gmail_source_header_invalid:from-mailbox/);
  const unexpectedWriteEvents = [{ method: "item/completed", itemId: "send-call", status: "completed", serverName: "codex_apps", toolName: "gmail_send_draft", toolArguments: {}, capturedAt }];
  await assert.rejects(() => createApprovedGmailSourceTransport({ client: fakeClient({ id: messageId, thread_id: "thread-1", payload: { headers: [
    { name: "From", value: "sender@example.test" }, { name: "Message-ID", value: "<message@example.test>" }, { name: "Subject", value: "subject" }
  ] } }, { readEvents: unexpectedWriteEvents }) })({ sourceRunId: "run-1", messageId, companyId, accountRef, connectionRefId: connectionId }), (error: unknown) => error instanceof GmailSourceAcquisitionError && error.message === "gmail_source_unexpected_write_operation" && error.externalActionExecuted === true);
  const uncertainClient = { startOrResumeThread: async () => "thread-1", startTurn: async ({ text }: { text: string }) => {
    if (text.includes("get_profile")) return { status: "completed", turnId: "profile-turn", providerAccountHash: emailHash, providerAccountHashSource: "gmail_profile_tool", events: [{ method: "item/completed", itemId: "profile-call", status: "completed", serverName: "codex_apps", toolName: "gmail_get_profile", toolArguments: {}, capturedAt }] };
    throw new Error("transport-timeout-after-dispatch");
  } } as any;
  await assert.rejects(() => createApprovedGmailSourceTransport({ client: uncertainClient })({ sourceRunId: "run-1", messageId, companyId, accountRef, connectionRefId: connectionId }), (error: unknown) => error instanceof GmailSourceAcquisitionError && error.providerCalled && error.providerCallUncertain);
});

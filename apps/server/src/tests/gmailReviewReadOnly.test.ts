import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { runGmailReviewReadOnly } from "../connectors/gmailReviewReadOnly.js";
import type { CodexAppServerClient } from "../codex/appServerClient.js";

type Message = { id: string; subject: string; snippet: string };
type Mutation = (items: Array<Record<string, unknown>>, batchIndex: number) => Array<Record<string, unknown>>;

function fakeClient(sourceMessages: Message[], mutation?: Mutation, timeoutBatch?: number) {
  let turn = 0;
  let classificationBatch = 0;
  const threads: Array<{ ephemeral?: boolean }> = [];
  const turnThreadIds: string[] = [];
  const classificationBatchSizes: number[] = [];
  let activeBatchStarts = 0;
  let maxConcurrentBatchStarts = 0;
  const client = {
    threads,
    turnThreadIds,
    classificationBatchSizes,
    maxConcurrentBatchStarts: 0,
    startOrResumeThread: async (_id?: string, options?: { ephemeral?: boolean }) => {
      const classificationStart = threads.length >= 2;
      const threadId = `thread-${threads.length + 1}`;
      threads.push(options ?? {});
      if (classificationStart) { activeBatchStarts += 1; maxConcurrentBatchStarts = Math.max(maxConcurrentBatchStarts, activeBatchStarts); await Promise.resolve(); activeBatchStarts -= 1; client.maxConcurrentBatchStarts = maxConcurrentBatchStarts; }
      return threadId;
    },
    startTurn: async (input: { threadId: string; text: string; outputSchema?: Record<string, unknown> }) => {
      turn += 1;
      turnThreadIds.push(input.threadId);
      if (turn === 1) return { status: "completed", events: [{ method: "item/completed", itemType: "mcpToolCall", serverName: "codex_apps", toolName: "gmail_get_profile", status: "completed" }], providerAccountHash: createHash("sha256").update("owner@example.com").digest("hex"), providerAccountHashSource: "declared_output", structured: { provider: "gmail", operation: "profile_read", provider_account_present: true, provider_account: "[redacted-email]", external_action_executed: false, data_persisted: false, exact_blocker: null } };
      if (turn === 2) return { status: "completed", events: [{ method: "item/completed", itemType: "mcpToolCall", serverName: "codex_apps", toolName: "gmail_list_email_summaries", status: "completed" }], gmailSummaryPage: { messages: sourceMessages, nextPageToken: null, unfiltered: true }, structured: null };
      const source = JSON.parse(input.text.match(/Source metadata JSON: (.*)$/s)?.[1] ?? "[]") as Message[];
      const batchIndex = classificationBatch++;
      classificationBatchSizes.push(source.length);
      const expected = source.map((m) => ({ message_id: m.id, category: "reply", summary: m.subject, reply_candidate: `Reply ${m.id}` }));
      if (timeoutBatch === batchIndex) throw new Error("turn timeout");
      return { status: "completed", events: [], structured: { provider: "gmail", operation: "summary_review", items: mutation ? mutation(expected, batchIndex) : expected } };
    }
  } as unknown as CodexAppServerClient & { threads: Array<{ ephemeral?: boolean }>; turnThreadIds: string[]; classificationBatchSizes: number[]; maxConcurrentBatchStarts: number };
  return client;
}

const run = (client: CodexAppServerClient, runId = "r1") => runGmailReviewReadOnly({ client, runId, companyId: "c1", accountRef: "owner@example.com" });
const messages = (count: number): Message[] => Array.from({ length: count }, (_, i) => ({ id: `m${i}`, subject: `Question ${i}`, snippet: "A question" }));

test("100 messages use one search thread for sequential 8-item classifications", async () => {
  const client = fakeClient(messages(100));
  const result = await run(client);
  assert.equal(result.status, "complete");
  assert.equal(result.review?.items.length, 100);
  assert.equal(client.threads.length, 15);
  assert.ok(client.threads.every((thread) => thread.ephemeral === true));
  assert.equal(client.turnThreadIds.length, 15);
  assert.equal(new Set(client.turnThreadIds.slice(2)).size, 13);
  assert.equal(client.maxConcurrentBatchStarts, 1);
  assert.deepEqual(client.classificationBatchSizes, [...Array.from({ length: 12 }, () => 8), 4]);
});

test("remainder batch uses exact JSON cardinality and source order", async () => {
  const client = fakeClient(messages(27));
  const schemaValues: unknown[] = [];
  const prompts: string[] = [];
  const startTurn = client.startTurn.bind(client);
  client.startTurn = async (input) => { schemaValues.push(input.outputSchema); prompts.push(input.text); return startTurn(input); };
  const result = await run(client, "remainder");
  assert.equal(result.status, "complete");
  assert.ok(prompts.slice(2).every((prompt) => prompt.includes("one JSON object only with provider, operation, and items")));
  assert.deepEqual(result.review?.items.map((item) => item.message_id), messages(27).map((m) => m.id));
  assert.deepEqual(client.classificationBatchSizes, [8, 8, 8, 3]);
});

test("missing, duplicate and unknown source IDs block with a null review", async () => {
  for (const mutation of [(items: Array<Record<string, unknown>>) => items.slice(1), (items: Array<Record<string, unknown>>) => [items[0], items[0], ...items.slice(2)], (items: Array<Record<string, unknown>>) => [{ ...items[0], message_id: "unknown" }, ...items.slice(1)]]) {
    const result = await run(fakeClient(messages(3), mutation));
    assert.equal(result.status, "blocked");
    assert.equal(result.review, null);
  }
});

test("a classification timeout blocks the whole review", async () => {
  const result = await run(fakeClient(messages(26), undefined, 1), "timeout");
  assert.equal(result.status, "blocked");
  assert.equal(result.exact_blocker, "gmail_review_classification_deadline_exceeded");
  assert.equal(result.review, null);
});

test("reply candidates are capped at five across all batches", async () => {
  const result = await run(fakeClient(messages(100)), "candidates");
  assert.equal(result.status, "complete");
  assert.equal(result.review?.items.filter((item) => item.reply_candidate !== null).length, 5);
  assert.deepEqual(result.review?.items.slice(0, 5).map((item) => item.reply_candidate), messages(5).map((m) => `Reply ${m.id}`));
});

test("an empty source completes without an extra classification model turn", async () => {
  const client = fakeClient([]);
  const result = await run(client, "empty");
  assert.equal(result.status, "complete");
  assert.deepEqual(result.review?.items, []);
  assert.equal(result.review?.fetched_count, 0);
  assert.equal(client.threads.length, 2);
});

import assert from "node:assert/strict";
import test from "node:test";
import { produceGmailReplyEffect, type GmailReplyEffectInputV1 } from "../runs/gmailReplyEffect.js";

const completeInput = (): GmailReplyEffectInputV1 => ({
  schema: "aos.gmail_reply_effect_input.v1",
  version: 1,
  source_message: {
    message_id: "source-message-1",
    thread_id: "source-thread-1",
    structured_headers: {
      recipient: "recipient@example.test",
      subject: "Re: synthetic subject",
      in_reply_to: "<source-message-1@example.test>",
      references: ["<source-message-0@example.test>"]
    },
    provenance_snapshot: {
      source_run_id: "run_gmail_source_1",
      source_review_hash: "a".repeat(64),
      source_snapshot_sha256: "b".repeat(64)
    }
  },
  reply_draft: { body: "synthetic reply body" },
  attachments: []
});

test("complete source-bound input produces separate evidence and canonical reply hashes", () => {
  const result = produceGmailReplyEffect(completeInput());
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.canonical_reply_payload.source_message.message_id, "source-message-1");
  assert.equal(result.canonical_reply_payload.source_message.thread_id, "source-thread-1");
  assert.equal(result.canonical_reply_payload.attachments.length, 0);
  assert.match(result.source_evidence_sha256, /^[a-f0-9]{64}$/u);
  assert.match(result.canonical_reply_payload_sha256, /^[a-f0-9]{64}$/u);
  assert.notEqual(result.source_evidence_sha256, result.canonical_reply_payload_sha256);
});

test("current candidate-like message_id/summary/reply_candidate cannot become a sendable payload", () => {
  const result = produceGmailReplyEffect({
    message_id: "1a08a0b57f419676",
    summary: "保存済み要約",
    reply_candidate: "保存済み返信案"
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.exact_blocker, "gmail_reply_effect_input_incomplete");
  assert.deepEqual(result.missing_fields, ["attachments", "reply_draft", "schema", "source_message", "version"]);
  assert.equal("canonical_reply_payload" in result, false);
});

test("reply body tampering changes only the canonical reply payload hash", () => {
  const original = produceGmailReplyEffect(completeInput());
  const tamperedInput = completeInput();
  tamperedInput.reply_draft = { body: "tampered body" };
  const tampered = produceGmailReplyEffect(tamperedInput);
  assert.equal(original.status, "ready");
  assert.equal(tampered.status, "ready");
  if (original.status !== "ready" || tampered.status !== "ready") return;
  assert.equal(tampered.source_evidence_sha256, original.source_evidence_sha256);
  assert.notEqual(tampered.canonical_reply_payload_sha256, original.canonical_reply_payload_sha256);
});

test("normal input preserves Gmail internal IDs separately from RFC Message-ID headers", () => {
  const result = produceGmailReplyEffect(completeInput());
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.canonical_reply_payload.source_message.message_id, "source-message-1");
  assert.equal(result.canonical_reply_payload.source_message.thread_id, "source-thread-1");
  assert.equal(result.canonical_reply_payload.source_message.structured_headers.in_reply_to, "<source-message-1@example.test>");
  assert.deepEqual(result.canonical_reply_payload.source_message.structured_headers.references, ["<source-message-0@example.test>"]);
});

test("header injection is rejected independently for recipient, subject, internal message ID, and RFC references", () => {
  const cases: Array<[string, (input: GmailReplyEffectInputV1) => void, string]> = [
    ["recipient", (input) => { input.source_message.structured_headers.recipient = "recipient@example.test\r\nBcc:evil@example.test"; }, "source_message.structured_headers.recipient"],
    ["subject", (input) => { input.source_message.structured_headers.subject = "Re: subject\nInjected"; }, "source_message.structured_headers.subject"],
    ["message_id", (input) => { input.source_message.message_id = "source-message-1\u0000"; }, "source_message.message_id"],
    ["references", (input) => { input.source_message.structured_headers.references = ["<source-message-0@example.test>\r"]; }, "source_message.structured_headers.references[0]"]
  ];
  for (const [name, mutate, field] of cases) {
    const input = completeInput();
    mutate(input);
    const result = produceGmailReplyEffect(input);
    assert.equal(result.status, "blocked", name);
    assert.ok(result.invalid_fields.includes(field), name);
    assert.equal("canonical_reply_payload" in result, false, name);
  }
});

test("recipient must be one valid mailbox and in_reply_to cannot use a Gmail internal ID", () => {
  for (const recipient of ["one@example.test, two@example.test", ".a@example.test", "a.@example.test", "a..b@example.test"]) {
    const input = completeInput();
    input.source_message.structured_headers.recipient = recipient;
    const invalidRecipient = produceGmailReplyEffect(input);
    assert.equal(invalidRecipient.status, "blocked", recipient);
    assert.ok(invalidRecipient.invalid_fields.includes("source_message.structured_headers.recipient"), recipient);
  }

  const internalHeaderId = completeInput();
  internalHeaderId.source_message.structured_headers.in_reply_to = "source-message-1";
  const invalidHeaderId = produceGmailReplyEffect(internalHeaderId);
  assert.equal(invalidHeaderId.status, "blocked");
  assert.ok(invalidHeaderId.invalid_fields.includes("source_message.structured_headers.in_reply_to"));
});

test("reply body may contain newlines while header fields remain single-line", () => {
  const input = completeInput();
  input.reply_draft.body = "line one\nline two\r\nline three";
  const result = produceGmailReplyEffect(input);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.canonical_reply_payload.reply_draft.body, "line one\nline two\r\nline three");
});

test("explicit attachments=[] is valid, while omitted attachments is a distinct missing field", () => {
  const explicitNone = produceGmailReplyEffect(completeInput());
  assert.equal(explicitNone.status, "ready");
  const missingInput = completeInput() as Partial<GmailReplyEffectInputV1>;
  delete missingInput.attachments;
  const missing = produceGmailReplyEffect(missingInput);
  assert.equal(missing.status, "blocked");
  assert.deepEqual(missing.missing_fields, ["attachments"]);
  assert.equal("canonical_reply_payload" in missing, false);
});

test("canonical hashes are deterministic across equivalent object key order", () => {
  const first = produceGmailReplyEffect(completeInput());
  const second = produceGmailReplyEffect({
    attachments: [],
    reply_draft: { body: "synthetic reply body" },
    version: 1,
    schema: "aos.gmail_reply_effect_input.v1",
    source_message: {
      provenance_snapshot: {
        source_snapshot_sha256: "b".repeat(64),
        source_review_hash: "a".repeat(64),
        source_run_id: "run_gmail_source_1"
      },
      structured_headers: {
        references: ["<source-message-0@example.test>"],
        in_reply_to: "<source-message-1@example.test>",
        subject: "Re: synthetic subject",
        recipient: "recipient@example.test"
      },
      thread_id: "source-thread-1",
      message_id: "source-message-1"
    }
  });
  assert.deepEqual(second, first);
});

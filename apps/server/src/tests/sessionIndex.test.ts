import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildAndWriteRedactedSessionIndex, decideSessionPromotion, readRedactedSessionIndex } from "../obsidian/sessionIndex.js";

test("session index stores redacted head/tail metadata and never promotes automatically", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-os-session-index-"));
  const sessionsDir = join(root, "sessions");
  const outputPath = join(root, "session-index.jsonl");
  const sessionPath = join(sessionsDir, "2026", "08", "04", "rollout-2026-08-04T00-00-00-019fca60-bb40-7fb0-99c1-8686356d550d.jsonl");
  mkdirSync(join(sessionsDir, "2026", "08", "04"), { recursive: true });
  writeFileSync(sessionPath, [
    JSON.stringify({ timestamp: "2026-08-04T00:00:00.000Z", type: "session_meta", payload: { id: "session-1", cwd: "/tmp/project", source: "cli" } }),
    JSON.stringify({ timestamp: "2026-08-04T00:01:00.000Z", type: "event_msg", payload: { type: "user_message", message: "Remember secret=do-not-store and inspect the export blocker" } }),
    JSON.stringify({ timestamp: "2026-08-04T00:02:00.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "project_not_resolved; next action is readback" }] } })
  ].join("\n") + "\n");

  const result = buildAndWriteRedactedSessionIndex({ sessionsDir, outputPath });
  assert.equal(result.scannedFiles, 1);
  assert.equal(result.indexedEntries, 1);
  assert.equal(result.entries[0]?.promotionAllowed, false);
  assert.equal(result.entries[0]?.reviewStatus, "pending_human_review");
  assert.equal(result.entries[0]?.blockerClass, "hard_block");
  const serialized = readFileSync(outputPath, "utf8");
  assert.doesNotMatch(serialized, /do-not-store/);
  assert.doesNotMatch(serialized, /secret=do-not-store/);

  const review = decideSessionPromotion(result.entries[0]!, {
    reviewedBy: "human",
    reviewedAt: "2026-08-04T00:03:00.000Z",
    approved: true,
    promotionRequested: true
  });
  assert.equal(review.allowed, true);
  assert.equal(review.entry.promotionAllowed, true);
});

test("redacted session index can be read without scanning the raw session directory", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-os-session-index-read-"));
  const outputPath = join(root, "session-index.jsonl");
  writeFileSync(outputPath, JSON.stringify({
    file: "2026/08/04/session.jsonl",
    sessionId: "session-1",
    mtime: "2026-08-04T00:02:00.000Z",
    cwd: "/tmp/project",
    lastUser: "safe summary",
    lastAssistant: "safe response",
    threadSource: "cli",
    parentThreadId: null,
    startedAt: "2026-08-04T00:00:00.000Z",
    endedAt: "2026-08-04T00:02:00.000Z",
    sourceHash: "hash",
    blockerClass: "none",
    exactBlocker: "none",
    nextAction: "unknown",
    restartPoint: "/tmp/project",
    coverage: "head_tail_metadata",
    reviewStatus: "pending_human_review",
    promotionAllowed: false
  }) + "\n");

  const entries = readRedactedSessionIndex(outputPath);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.sessionId, "session-1");
  assert.equal(entries[0]?.lastAssistant, "safe response");
});

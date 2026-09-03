import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareAuthorityRefresh } from "../codex-handoff-authority-refresh.mjs";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function sha(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

test("refreshes authority in the existing destination without creating or archiving a task", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handoff-refresh-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = "source_task";
  const destination = "destination_task";
  const authority = path.join(root, "STATE.md");
  fs.writeFileSync(authority, "before\n");
  const packet = {
    schema: "codex_hookless_handoff_packet.v1",
    source_thread_id: source,
    content_sha256: null,
    task_objective: "continue",
    formal_goal: { state: "present", objective: "goal", status: "active" },
    plan_snapshot: [{ step: "work", status: "in_progress" }],
    decision_log: [],
    completed_work: [],
    unfinished_work: ["work"],
    exact_blockers: [],
    external_effect_ledger: [{ state: "observed_false", replay_allowed: false }],
    next_action: "read current state",
    stop_condition: "stop on drift",
    authoritative_sources: [{ path: authority, sha256: sha("before\n") }],
  };
  packet.content_sha256 = sha(stableJson({ ...packet, content_sha256: null }));
  const packetPath = path.join(root, "handoff-packets", source, `${packet.content_sha256}.json`);
  fs.mkdirSync(path.dirname(packetPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(packetPath, `${JSON.stringify(packet)}\n`, { mode: 0o600 });
  const receiptPath = path.join(root, "handoff-receipts", `${source}.json`);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(receiptPath, `${JSON.stringify({
    schema: "codex_hookless_handoff_receipt.v1",
    status: "completed",
    source_status: "handoff_completed",
    implementation_allowed: false,
    destination_ready: true,
    source_thread_id: source,
    destination_thread_id: destination,
    packet_path: packetPath,
    packet_content_sha256: packet.content_sha256,
    source_task_archived: false,
    source_task_visible: true,
  })}\n`, { mode: 0o600 });
  fs.writeFileSync(authority, "after\n");
  const result = prepareAuthorityRefresh({ ledgerRoot: root, sourceThreadId: source, sourceTerminalTurnId: "turn_terminal", now: new Date("2026-08-26T00:00:00Z") });
  assert.equal(result.destination_thread_id, destination);
  assert.equal(result.authority_changed_since_packet, true);
  assert.equal(result.thread_creation_used, false);
  assert.equal(result.source_task_archived, false);
  const refresh = JSON.parse(fs.readFileSync(result.refresh_path, "utf8"));
  assert.equal(refresh.authoritative_sources[0].sha256, sha("after\n"));
  assert.equal(refresh.preserved_logical_state.plan_snapshot[0].status, "in_progress");
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  assert.equal(receipt.authority_refresh.path, result.refresh_path);
  assert.equal(receipt.status, "completed");
});

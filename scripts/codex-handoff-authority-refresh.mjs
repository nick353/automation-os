#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,180}$/u;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function readPrivateJson(file, expectedSchema) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error("codex_handoff_refresh_json_invalid");
  if ((stat.mode & 0o077) !== 0) throw new Error("codex_handoff_refresh_json_not_private");
  const value = JSON.parse(fs.readFileSync(resolved, "utf8"));
  if (value?.schema !== expectedSchema) throw new Error("codex_handoff_refresh_schema_invalid");
  return { resolved, value };
}

function atomicWritePrivateJson(file, value) {
  const resolved = path.resolve(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const temporary = `${resolved}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, resolved);
  fs.chmodSync(resolved, 0o600);
  return resolved;
}

function fileSnapshot(entry) {
  const resolved = path.resolve(entry.path);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error(`codex_handoff_refresh_authority_invalid:${resolved}`);
  const bytes = fs.readFileSync(resolved);
  return {
    path: resolved,
    previous_sha256: entry.sha256,
    sha256: sha256(bytes),
    bytes: bytes.length,
    modified_at: stat.mtime.toISOString(),
    changed_since_packet: sha256(bytes) !== entry.sha256,
  };
}

export function prepareAuthorityRefresh({ ledgerRoot, sourceThreadId, sourceTerminalTurnId = null, now = new Date() }) {
  if (!THREAD_ID.test(sourceThreadId)) throw new Error("codex_handoff_refresh_source_id_invalid");
  const root = path.resolve(ledgerRoot);
  if (root === "/" || root === os.homedir()) throw new Error("codex_handoff_refresh_root_invalid");
  const receiptPath = path.join(root, "handoff-receipts", `${sourceThreadId}.json`);
  const { value: receipt } = readPrivateJson(receiptPath, "codex_hookless_handoff_receipt.v1");
  if (receipt.status !== "completed" || receipt.source_status !== "handoff_completed" || receipt.implementation_allowed !== false || receipt.destination_ready !== true) {
    throw new Error("codex_handoff_refresh_receipt_not_completed");
  }
  if (receipt.source_thread_id !== sourceThreadId || !THREAD_ID.test(receipt.destination_thread_id)) {
    throw new Error("codex_handoff_refresh_receipt_binding_invalid");
  }
  const { resolved: packetPath, value: packet } = readPrivateJson(receipt.packet_path, "codex_hookless_handoff_packet.v1");
  if (packet.source_thread_id !== sourceThreadId || packet.content_sha256 !== receipt.packet_content_sha256) {
    throw new Error("codex_handoff_refresh_packet_binding_invalid");
  }
  const expectedPacketHash = sha256(stableJson({ ...packet, content_sha256: null }));
  if (expectedPacketHash !== packet.content_sha256) throw new Error("codex_handoff_refresh_packet_hash_invalid");
  const authoritativeSources = packet.authoritative_sources.map(fileSnapshot);
  const createdAt = now.toISOString();
  const refresh = {
    schema: "codex_hookless_handoff_authority_refresh.v1",
    created_at: createdAt,
    source_thread_id: sourceThreadId,
    destination_thread_id: receipt.destination_thread_id,
    source_terminal_turn_id: sourceTerminalTurnId,
    prior_packet_path: packetPath,
    prior_packet_content_sha256: packet.content_sha256,
    preserved_logical_state: {
      task_objective: packet.task_objective,
      formal_goal: packet.formal_goal,
      plan_snapshot: packet.plan_snapshot,
      decision_log: packet.decision_log,
      completed_work: packet.completed_work,
      unfinished_work: packet.unfinished_work,
      exact_blockers: packet.exact_blockers,
      external_effect_ledger: packet.external_effect_ledger,
      next_action: packet.next_action,
      stop_condition: packet.stop_condition,
    },
    authoritative_sources: authoritativeSources,
    authority_changed_since_packet: authoritativeSources.some((entry) => entry.changed_since_packet),
    destination_contract: "Fresh-read every authoritative source and match this refresh before continuing in the existing destination. Never create a second destination or resume implementation in the source.",
    content_sha256: null,
  };
  refresh.content_sha256 = sha256(stableJson(refresh));
  const refreshPath = path.join(root, "handoff-refreshes", sourceThreadId, `${refresh.content_sha256}.json`);
  if (fs.existsSync(refreshPath)) {
    const existing = readPrivateJson(refreshPath, refresh.schema).value;
    if (existing.content_sha256 !== refresh.content_sha256) throw new Error("codex_handoff_refresh_collision");
  } else {
    atomicWritePrivateJson(refreshPath, refresh);
  }
  const updatedReceipt = {
    ...receipt,
    authority_refresh: {
      status: "prepared",
      created_at: createdAt,
      path: refreshPath,
      content_sha256: refresh.content_sha256,
      source_terminal_turn_id: sourceTerminalTurnId,
    },
  };
  atomicWritePrivateJson(receiptPath, updatedReceipt);
  return {
    schema: "codex_hookless_handoff_authority_refresh_result.v1",
    status: "prepared",
    source_thread_id: sourceThreadId,
    destination_thread_id: receipt.destination_thread_id,
    refresh_path: refreshPath,
    content_sha256: refresh.content_sha256,
    authority_changed_since_packet: refresh.authority_changed_since_packet,
    source_task_archived: false,
    thread_creation_used: false,
  };
}

function parseArgs(argv) {
  const args = { ledgerRoot: path.join(os.homedir(), ".codex", "project-state-ledger") };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--ledger-root", "--source-thread-id", "--source-terminal-turn-id"].includes(flag)) throw new Error(`codex_handoff_refresh_argument_invalid:${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`codex_handoff_refresh_argument_missing:${flag}`);
    args[flag.slice(2).replaceAll("-", "_")] = value;
    index += 1;
  }
  return {
    ledgerRoot: args.ledger_root || args.ledgerRoot,
    sourceThreadId: args.source_thread_id,
    sourceTerminalTurnId: args.source_terminal_turn_id || null,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(prepareAuthorityRefresh(parseArgs(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ schema: "codex_hookless_handoff_authority_refresh_result.v1", status: "blocked", exact_blocker: String(error?.message || error).slice(0, 500) })}\n`);
    process.exitCode = 1;
  }
}

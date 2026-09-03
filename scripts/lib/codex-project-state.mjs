import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { verifyCompanionOperationEffectProof } from "./companion-effect-proof.mjs";

export const LEDGER_SCHEMA = "codex_project_state_ledger.v1";
export const HANDOFF_PACKET_SCHEMA = "codex_hookless_handoff_packet.v1";
export const HANDOFF_RECEIPT_SCHEMA = "codex_hookless_handoff_receipt.v1";
export const TURN_OUTCOME_SCHEMA = "codex_operational_turn_outcome.v1";
export const SOURCE_RESUME_AUTHORITY_SCHEMA = "codex_source_resume_authority.v1";
export const DESTINATION_NO_OUTPUT_PROOF_SCHEMA = "codex_destination_no_output_proof.v1";
const PROJECTION_VERSION = 7;

const DEFAULT_AUTHORITY_FILES = [
  "GOAL.md",
  "Goal.md",
  "Plan.md",
  "PLAN.md",
  "plan.md",
  "STATE.md",
  "AGENTS.md",
];
const VALID_PLAN_STATUSES = new Set(["pending", "in_progress", "completed", "blocked"]);
const DEFAULT_MAX_TEXT = 1_600;
const WEB_OPERATION_BACKEND_SELECTOR_PATH = path.join(os.homedir(), ".social-flow", "web-operation-backend.json");
const SECRET_PATTERNS = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/gu,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{12,}\b/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{12,}\b/gu,
  /\b(?:Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/giu,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*[^\s,;]+/giu,
];

function isoNow() {
  return new Date().toISOString();
}

function text(value, max = DEFAULT_MAX_TEXT) {
  if (typeof value !== "string") return "";
  let result = value.replace(/\u0000/gu, "").trim();
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, "[REDACTED]");
  return result.slice(0, max);
}

function unique(values, max = 40) {
  const result = [];
  const seen = new Set();
  for (const value of values || []) {
    const normalized = text(value, 1_200);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= max) break;
  }
  return result;
}

function expandHome(value) {
  const source = String(value || "");
  if (source === "~") return os.homedir();
  if (source.startsWith("~/")) return path.join(os.homedir(), source.slice(2));
  return source.replaceAll("${HOME}", os.homedir());
}

function canonical(value) {
  const resolved = path.resolve(expandHome(value));
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function isPathInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function regularFile(file, maxBytes = Number.POSITIVE_INFINITY) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes;
  } catch {
    return false;
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmacSha256(value, secret) {
  return crypto.createHmac("sha256", String(secret)).update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

export function atomicWriteJson(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const body = stableJson(value);
  const descriptor = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, body, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
}

function atomicWriteJsonNoReplace(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(target), 0o700);
  const body = stableJson(value);
  const descriptor = fs.openSync(target, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, body, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(target, 0o600);
}

export function appendJsonLine(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

export function loadPolicy(file) {
  const policy = readJson(path.resolve(file));
  if (!policy || policy.schema !== "codex_project_state_policy.v1") {
    throw new Error("codex_project_state_policy_invalid");
  }
  const roots = [];
  for (const item of policy.project_roots || []) {
    if (!item || typeof item.id !== "string" || typeof item.root !== "string") continue;
    const root = canonical(item.root);
    if (root === path.parse(root).root || root === canonical(os.homedir())) continue;
    roots.push({
      id: text(item.id, 120),
      label: text(item.label || item.id, 200),
      root,
      authority_files: unique(item.authority_files || DEFAULT_AUTHORITY_FILES, 30),
      thread_ids: unique(item.thread_ids || [], 200),
    });
  }
  if (policy.archive?.enabled === true) throw new Error("codex_project_state_archive_forbidden");
  const handoffMode = ["disabled", "prepare_only", "automatic"].includes(policy.handoff?.mode)
    ? policy.handoff.mode
    : "prepare_only";
  const outputDir = canonical(policy.output_dir || path.join(os.homedir(), ".codex", "project-state-ledger"));
  const operationalMemoryRoot = canonical(path.join(os.homedir(), ".codex", "operational-memory"));
  const observerEventsPath = canonical(policy.hookless_observer?.events_path || path.join(operationalMemoryRoot, "auto-events.jsonl"));
  const observerStatePath = canonical(policy.hookless_observer?.state_path || path.join(operationalMemoryRoot, "turn-observer-state.json"));
  const observerOutcomesDir = canonical(policy.hookless_observer?.outcomes_dir || path.join(operationalMemoryRoot, "turn-outcomes"));
  if (policy.hookless_observer?.enabled === true
    && (!isPathInside(observerEventsPath, operationalMemoryRoot)
      || !isPathInside(observerStatePath, operationalMemoryRoot)
      || !isPathInside(observerOutcomesDir, operationalMemoryRoot))) {
    throw new Error("codex_hookless_turn_observer_path_invalid");
  }
  return {
    ...policy,
    state_db: canonical(policy.state_db || path.join(os.homedir(), ".codex", "state_5.sqlite")),
    output_dir: outputDir,
    project_roots: roots,
    max_threads: Math.max(1, Math.min(Number(policy.max_threads) || 500, 5_000)),
    recent_days: Math.max(1, Math.min(Number(policy.recent_days) || 180, 3_650)),
    rollout_tail_bytes: Math.max(64 * 1024, Math.min(Number(policy.rollout_tail_bytes) || 8 * 1024 * 1024, 32 * 1024 * 1024)),
    max_authority_file_bytes: Math.max(4 * 1024, Math.min(Number(policy.max_authority_file_bytes) || 2 * 1024 * 1024, 8 * 1024 * 1024)),
    allow_synthetic_cwd_projects: policy.allow_synthetic_cwd_projects === true,
    synthetic_root_allowlist: unique(policy.synthetic_root_allowlist || [], 50).map(canonical),
    task_retention: {
      archive_tasks: false,
      keep_source_visible: true,
    },
    handoff: {
      enabled: policy.handoff?.enabled === true,
      mode: handoffMode,
      automatic_thread_creation: handoffMode === "automatic" && policy.handoff?.automatic_thread_creation === true,
      activation_not_before_ms: Date.parse(policy.handoff?.activation_not_before || "") || 0,
      max_per_run: Math.max(1, Math.min(Number(policy.handoff?.max_per_run) || 1, 10)),
      candidate_scan_limit: Math.max(1, Math.min(
        Number(policy.handoff?.candidate_scan_limit) || Math.max((Number(policy.handoff?.max_per_run) || 1) * 10, 50),
        500,
      )),
      fallback_min_duration_minutes: Math.max(30, Math.min(
        Number(policy.handoff?.fallback_min_duration_minutes ?? policy.handoff?.min_duration_minutes) || 120,
        60 * 24 * 30,
      )),
      fallback_min_context_ratio: Math.max(0.25, Math.min(Number(policy.handoff?.fallback_min_context_ratio) || 0.50, 0.95)),
      min_rollout_bytes: Math.max(64 * 1024, Math.min(Number(policy.handoff?.min_rollout_bytes) || 4 * 1024 * 1024, 256 * 1024 * 1024)),
      min_context_ratio: Math.max(0.25, Math.min(Number(policy.handoff?.min_context_ratio) || 0.72, 0.98)),
      min_total_tokens: Math.max(10_000, Math.min(Number(policy.handoff?.min_total_tokens) || 250_000, 100_000_000)),
      rollout_tail_bytes: Math.max(64 * 1024, Math.min(Number(policy.handoff?.rollout_tail_bytes) || 8 * 1024 * 1024, 32 * 1024 * 1024)),
      require_project: policy.handoff?.require_project !== false,
      require_complete_plan: policy.handoff?.require_complete_plan !== false,
      categories: unique(policy.handoff?.categories || ["manual"], 10),
      protected_thread_ids: unique(policy.handoff?.protected_thread_ids || [], 500),
      read_formal_goal: policy.handoff?.read_formal_goal !== false,
      turn_completion_timeout_ms: Math.max(60_000, Math.min(Number(policy.handoff?.turn_completion_timeout_ms) || 21_600_000, 86_400_000)),
      title_suffix: text(policy.handoff?.title_suffix || "引き継ぎ", 80),
    },
    hookless_observer: {
      enabled: policy.hookless_observer?.enabled === true,
      events_path: observerEventsPath,
      state_path: observerStatePath,
      outcomes_dir: observerOutcomesDir,
      max_events_per_run: Math.max(1, Math.min(Number(policy.hookless_observer?.max_events_per_run) || 100, 500)),
    },
  };
}

function loadRegistryRoots(registryPath) {
  if (!registryPath || !regularFile(registryPath, 4 * 1024 * 1024)) return [];
  const registry = readJson(registryPath, {});
  return (registry.projects || []).flatMap((project) => {
    if (!project || typeof project.id !== "string" || typeof project.root !== "string") return [];
    const root = canonical(project.root);
    if (root === path.parse(root).root || root === canonical(os.homedir())) return [];
    return [{
      id: text(project.id, 120),
      label: text(project.label || project.id, 200),
      root,
      authority_files: unique(project.authority_files || DEFAULT_AUTHORITY_FILES, 30),
      thread_ids: [],
    }];
  });
}

function mergeProjectRoots(policy) {
  const registryPath = policy.project_registry ? canonical(policy.project_registry) : null;
  const combined = [...policy.project_roots, ...loadRegistryRoots(registryPath)];
  const byRoot = new Map();
  for (const project of combined) {
    const previous = byRoot.get(project.root);
    byRoot.set(project.root, previous ? {
      ...previous,
      authority_files: unique([...previous.authority_files, ...project.authority_files], 40),
      thread_ids: unique([...previous.thread_ids, ...project.thread_ids], 500),
    } : project);
  }
  return [...byRoot.values()].sort((a, b) => b.root.length - a.root.length || a.id.localeCompare(b.id));
}

function readThreads(policy) {
  if (!regularFile(policy.state_db, 1024 * 1024 * 1024)) throw new Error("codex_project_state_db_unavailable");
  const database = new DatabaseSync(policy.state_db, { readOnly: true, timeout: 5_000 });
  try {
    const cutoff = Date.now() - policy.recent_days * 86_400_000;
    const statement = database.prepare(`
      SELECT id, title, preview, cwd, rollout_path, created_at_ms, updated_at_ms,
             tokens_used,
             source, thread_source, archived, archived_at, is_pinned, project_id
      FROM threads
      WHERE updated_at_ms >= ?
      ORDER BY updated_at_ms DESC
      LIMIT ?
    `);
    return statement.all(cutoff, policy.max_threads).map((row) => ({
      ...row,
      title: text(row.title || row.preview, 800),
      preview: text(row.preview || row.title, 1_200),
      cwd: canonical(row.cwd),
      rollout_path: canonical(row.rollout_path),
      created_at_ms: Number(row.created_at_ms || 0),
      updated_at_ms: Number(row.updated_at_ms || 0),
      tokens_used: Number(row.tokens_used || 0),
      archived: Boolean(row.archived),
      is_pinned: Boolean(row.is_pinned),
    }));
  } finally {
    database.close();
  }
}

function readTail(file, maxBytes) {
  if (!regularFile(file, Number.POSITIVE_INFINITY)) return { text: "", size: 0, mtime_ms: 0, truncated: false };
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - maxBytes);
  const descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(descriptor, buffer, 0, buffer.length, start);
    let body = buffer.toString("utf8");
    if (start > 0) {
      const firstNewline = body.indexOf("\n");
      body = firstNewline >= 0 ? body.slice(firstNewline + 1) : "";
    }
    return { text: body, size: stat.size, mtime_ms: Math.trunc(stat.mtimeMs), truncated: start > 0 };
  } finally {
    fs.closeSync(descriptor);
  }
}

function rolloutFingerprint(file) {
  try {
    const stat = fs.statSync(file);
    return { size: stat.isFile() ? stat.size : 0, mtime_ms: stat.isFile() ? Math.trunc(stat.mtimeMs) : 0 };
  } catch {
    return { size: 0, mtime_ms: 0 };
  }
}

function messageText(payload) {
  if (!payload || payload.type !== "message") return "";
  return (payload.content || []).map((item) => item?.text || "").join("\n");
}

function quotedString(source) {
  if (!source || !["\"", "'", "`"].includes(source[0])) return null;
  const quote = source[0];
  let escaped = false;
  for (let index = 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (character === quote) {
      const raw = source.slice(1, index);
      try { return { value: JSON.parse(`"${raw.replaceAll("\\`", "`").replaceAll("\"", "\\\"")}"`), length: index + 1 }; }
      catch { return { value: raw.replace(/\\n/gu, "\n").replace(/\\([\\'"`])/gu, "$1"), length: index + 1 }; }
    }
  }
  return null;
}

function extractStringField(block, field) {
  const match = new RegExp(`(?:^|[,\\s{])${field}\\s*:\\s*`, "u").exec(block);
  if (!match) return "";
  return text(quotedString(block.slice(match.index + match[0].length))?.value || "", 1_200);
}

export function extractPlanFromToolInput(input) {
  const source = typeof input === "string" ? input : "";
  const markerIndex = Math.max(source.lastIndexOf("tools.update_plan("), source.lastIndexOf('"name":"update_plan"'));
  if (markerIndex < 0) return null;
  const tail = source.slice(markerIndex);
  const entries = [];
  const entryPattern = /\{\s*step\s*:\s*/gu;
  let match;
  while ((match = entryPattern.exec(tail))) {
    const rest = tail.slice(match.index + match[0].length);
    const parsedStep = quotedString(rest);
    if (!parsedStep) continue;
    const afterStep = rest.slice(parsedStep.length);
    const statusMatch = /status\s*:\s*/u.exec(afterStep);
    if (!statusMatch) continue;
    const parsedStatus = quotedString(afterStep.slice(statusMatch.index + statusMatch[0].length));
    const status = parsedStatus?.value || "";
    if (!VALID_PLAN_STATUSES.has(status)) continue;
    entries.push({ step: text(parsedStep.value, 1_000), status });
    if (entries.length >= 100) break;
  }
  if (!entries.length) return null;
  return {
    source: "latest_update_plan_call",
    explanation: extractStringField(tail, "explanation"),
    steps: entries,
  };
}

function toolInputEffectObservation(payload) {
  const input = typeof payload.input === "string"
    ? payload.input
    : typeof payload.arguments === "string" ? payload.arguments : "";
  const nested = [...input.matchAll(/tools\.([A-Za-z0-9_]+)\s*\(/gu)].map((match) => match[1]);
  const directName = text(payload.name, 200);
  const names = nested.length ? nested : directName ? [directName] : [];
  if (!names.length) return { total: 1, read_only: 0, deferred_mcp: 0, unknown: 1 };
  let readOnly = 0;
  let deferredMcp = 0;
  let unknown = 0;
  for (const name of names) {
    if (name.startsWith("mcp__")) { deferredMcp += 1; continue; }
    if (name === "web__run"
      || name === "wait"
      || name === "get_goal"
      || name === "update_plan"
      || name === "list_mcp_resources"
      || name === "list_mcp_resource_templates"
      || name === "read_mcp_resource") {
      readOnly += 1;
      continue;
    }
    unknown += 1;
  }
  return { total: names.length, read_only: readOnly, deferred_mcp: deferredMcp, unknown };
}

function parseRollout(thread, maxBytes) {
  const tail = readTail(thread.rollout_path, maxBytes);
  const userMessages = [];
  const assistantMessages = [];
  const toolInputs = [];
  const plans = [];
  const taskCompletions = [];
  const effectObservations = [];
  let lastTaskStarted = 0;
  let lastTaskCompleted = 0;
  let parseErrors = 0;
  let taskStartedCount = 0;
  let taskCompletedCount = 0;
  let latestContextTokens = 0;
  let latestTotalTokens = 0;
  let modelContextWindow = 0;
  for (const line of tail.text.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { parseErrors += 1; continue; }
    const timestamp = Date.parse(record.timestamp || "") || 0;
    const payload = record.payload || {};
    if (record.type === "event_msg" && payload.type === "task_started") {
      lastTaskStarted = Math.max(lastTaskStarted, timestamp);
      taskStartedCount += 1;
    }
    if (record.type === "event_msg" && payload.type === "task_complete") {
      lastTaskCompleted = Math.max(lastTaskCompleted, timestamp);
      taskCompletedCount += 1;
      taskCompletions.push({ at: timestamp, payload });
    }
    if (record.type === "event_msg" && payload.type === "token_count") {
      const info = payload.info || {};
      latestContextTokens = Number(info.last_token_usage?.input_tokens || latestContextTokens || 0);
      latestTotalTokens = Number(info.total_token_usage?.total_tokens || latestTotalTokens || 0);
      modelContextWindow = Number(info.model_context_window || modelContextWindow || 0);
    }
    if (record.type === "event_msg" && payload.type === "web_search_end") {
      effectObservations.push({ at: timestamp, type: "web_read_only" });
    }
    if (record.type === "event_msg" && payload.type === "mcp_tool_call_end") {
      effectObservations.push({
        at: timestamp,
        type: payload.read_only_hint === true ? "mcp_read_only" : "mcp_not_read_only",
        server: text(payload.invocation?.server, 200),
        tool: text(payload.invocation?.tool, 200),
      });
    }
    if (record.type !== "response_item") continue;
    if (payload.type === "message" && payload.role === "user") userMessages.push({ at: timestamp, value: text(messageText(payload), 1_200) });
    if (payload.type === "message" && payload.role === "assistant") assistantMessages.push({ at: timestamp, phase: payload.phase || null, value: text(messageText(payload), 20_000) });
    if (["custom_tool_call", "function_call"].includes(payload.type)) {
      const input = typeof payload.input === "string" ? payload.input : typeof payload.arguments === "string" ? payload.arguments : "";
      toolInputs.push(text(input, 200_000));
      const plan = extractPlanFromToolInput(input);
      if (plan) plans.push({ ...plan, at: timestamp });
      effectObservations.push({ at: timestamp, type: "tool_input", ...toolInputEffectObservation(payload) });
    }
  }
  const active = lastTaskStarted > lastTaskCompleted;
  const safeTerminal = lastTaskCompleted > 0 && lastTaskCompleted >= lastTaskStarted;
  const latestTurnStart = lastTaskStarted || 0;
  const latestTurnEnd = safeTerminal ? lastTaskCompleted : Number.POSITIVE_INFINITY;
  const inLatestTurn = (item) => item.at >= latestTurnStart && item.at <= latestTurnEnd;
  const latestCompletion = taskCompletions.filter(inLatestTurn).at(-1) || null;
  const terminalMessage = text(latestCompletion?.payload?.last_agent_message, 20_000);
  const latestTurnAssistant = assistantMessages.filter(inLatestTurn).at(-1)?.value || "";
  const latestTurnEffects = effectObservations.filter(inLatestTurn);
  const toolInputTotals = latestTurnEffects
    .filter((item) => item.type === "tool_input")
    .reduce((result, item) => ({
      total: result.total + Number(item.total || 0),
      read_only: result.read_only + Number(item.read_only || 0),
      deferred_mcp: result.deferred_mcp + Number(item.deferred_mcp || 0),
      unknown: result.unknown + Number(item.unknown || 0),
    }), { total: 0, read_only: 0, deferred_mcp: 0, unknown: 0 });
  const mcpReadOnly = latestTurnEffects.filter((item) => item.type === "mcp_read_only").length;
  const mcpNotReadOnly = latestTurnEffects.filter((item) => item.type === "mcp_not_read_only").length;
  const webReadOnly = latestTurnEffects.filter((item) => item.type === "web_read_only").length;
  const unmatchedMcpInputs = Math.max(0, toolInputTotals.deferred_mcp - mcpReadOnly - mcpNotReadOnly);
  const contextPressureRatio = modelContextWindow > 0 ? latestContextTokens / modelContextWindow : 0;
  return {
    rollout_path: thread.rollout_path,
    rollout_size_bytes: tail.size,
    rollout_mtime_ms: tail.mtime_ms,
    rollout_tail_truncated: tail.truncated,
    parse_errors: parseErrors,
    active_turn_detected: active,
    safe_terminal_detected: safeTerminal,
    latest_turn_coverage_complete: !tail.truncated || lastTaskStarted > 0,
    latest_turn_id: text(latestCompletion?.payload?.turn_id, 200) || null,
    last_task_started_at: lastTaskStarted ? new Date(lastTaskStarted).toISOString() : null,
    last_task_completed_at: lastTaskCompleted ? new Date(lastTaskCompleted).toISOString() : null,
    task_started_count: taskStartedCount,
    task_completed_count: taskCompletedCount,
    latest_context_tokens: latestContextTokens,
    latest_total_tokens: latestTotalTokens,
    model_context_window: modelContextWindow,
    context_pressure_ratio: Number(contextPressureRatio.toFixed(4)),
    latest_user_intent: userMessages.filter(inLatestTurn).at(-1)?.value || userMessages.at(-1)?.value || thread.preview || thread.title,
    latest_assistant_summary: terminalMessage || latestTurnAssistant,
    latest_plan: plans.at(-1) || null,
    latest_plan_current: plans.filter(inLatestTurn).at(-1) || null,
    latest_turn_effects: {
      coverage_complete: !tail.truncated || lastTaskStarted > 0,
      tool_inputs: toolInputTotals.total,
      read_only_tool_inputs: toolInputTotals.read_only,
      unknown_tool_inputs: toolInputTotals.unknown,
      deferred_mcp_inputs: toolInputTotals.deferred_mcp,
      unmatched_mcp_inputs: unmatchedMcpInputs,
      mcp_read_only: mcpReadOnly,
      mcp_not_read_only: mcpNotReadOnly,
      web_read_only: webReadOnly,
    },
    searchable_text: text([
      thread.cwd,
      thread.title,
      ...userMessages.slice(-6).map((item) => item.value),
      ...assistantMessages.slice(-6).map((item) => item.value),
      ...toolInputs.slice(-50),
    ].join("\n"), Math.max(maxBytes, 200_000)),
  };
}

function scoreProject(thread, rollout, project) {
  if (project.thread_ids.includes(thread.id)) return { score: 10_000, reasons: ["explicit_thread_id"] };
  let score = 0;
  const reasons = [];
  if (isPathInside(thread.cwd, project.root)) {
    score += 800 + Math.min(project.root.length, 200);
    reasons.push("cwd_within_project_root");
  }
  const occurrences = rollout.searchable_text.split(project.root).length - 1;
  if (occurrences > 0) {
    score += Math.min(occurrences, 8) * 50;
    reasons.push(`rollout_project_path_mentions:${occurrences}`);
  }
  return { score, reasons };
}

function assignProject(thread, rollout, projects, policy) {
  const ranked = projects
    .map((project) => ({ project, ...scoreProject(thread, rollout, project) }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || b.project.root.length - a.project.root.length);
  if (!ranked.length && policy.allow_synthetic_cwd_projects) {
    const allowed = policy.synthetic_root_allowlist.some((root) => isPathInside(thread.cwd, root));
    if (allowed && thread.cwd !== path.parse(thread.cwd).root && thread.cwd !== canonical(os.homedir())) {
      return {
        status: "assigned",
        project: {
          id: `cwd-${sha256(thread.cwd).slice(0, 12)}`,
          label: path.basename(thread.cwd),
          root: thread.cwd,
          authority_files: DEFAULT_AUTHORITY_FILES,
          thread_ids: [],
        },
        confidence: 0.7,
        reasons: ["isolated_synthetic_cwd_project"],
      };
    }
  }
  if (!ranked.length) return { status: "needs_review", project: null, confidence: 0, reasons: ["no_project_evidence"] };
  if (ranked[1] && ranked[0].score === ranked[1].score && ranked[0].project.root !== ranked[1].project.root) {
    return { status: "needs_review", project: null, confidence: 0, reasons: ["ambiguous_project_evidence"] };
  }
  return {
    status: "assigned",
    project: ranked[0].project,
    confidence: Math.min(1, ranked[0].score / 600),
    reasons: ranked[0].reasons,
  };
}

function authoritySnapshot(project, maxBytes) {
  if (!project) return [];
  const result = [];
  for (const relative of unique([...project.authority_files, ...DEFAULT_AUTHORITY_FILES], 50)) {
    const candidate = canonical(path.join(project.root, relative));
    if (!isPathInside(candidate, project.root) || !regularFile(candidate, maxBytes)) continue;
    const body = fs.readFileSync(candidate);
    const stat = fs.statSync(candidate);
    result.push({
      path: candidate,
      relative_path: path.relative(project.root, candidate),
      size_bytes: stat.size,
      modified_at: stat.mtime.toISOString(),
      sha256: sha256(body),
      excerpt: text(body.toString("utf8"), 3_000),
    });
  }
  return result;
}

function planFromAuthority(snapshot) {
  const steps = [];
  for (const item of snapshot) {
    if (!/(^|\/)(plan|goal|state)\.md$/iu.test(item.relative_path)) continue;
    for (const line of item.excerpt.split("\n")) {
      const match = /^\s*-\s*\[([ xX])\]\s+(.+)$/u.exec(line);
      if (!match) continue;
      steps.push({ step: text(match[2], 1_000), status: match[1].toLowerCase() === "x" ? "completed" : "pending" });
      if (steps.length >= 100) break;
    }
    if (steps.length >= 100) break;
  }
  return steps.length ? { source: "project_authority_checklists", explanation: "", steps } : null;
}

function sectionLines(source, headings, max = 20) {
  const result = [];
  const lines = String(source || "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const normalized = lines[index].replace(/[*#_`]/gu, "").trim().toLowerCase();
    if (!headings.some((heading) => normalized.startsWith(heading))) continue;
    const inline = lines[index].replace(/^.*?(?:[:：]|\*\*)\s*/u, "").trim();
    if (inline && inline !== lines[index].trim()) result.push(inline);
    for (let offset = 1; offset <= 8 && index + offset < lines.length; offset += 1) {
      const candidate = lines[index + offset].trim();
      if (/^#{1,6}\s/u.test(candidate) || /^\*\*[^*]+\*\*\s*$/u.test(candidate)) break;
      if (candidate) result.push(candidate.replace(/^[-*]\s+/u, ""));
      if (result.length >= max) return unique(result, max);
    }
  }
  return unique(result, max);
}

function noneRecorded(value) {
  return /^(?:なし|ありません|該当なし|none|no blockers?|n\/a)[。.!\s]*$/iu.test(String(value || "").trim());
}

function meaningfulSectionLines(source, headings, max = 20) {
  return sectionLines(source, headings, max).filter((item) => !noneRecorded(item));
}

function noFurtherAction(value) {
  return noneRecorded(value)
    || /(?:不要|必要ありません|no (?:further )?action|required action: none)/iu.test(String(value || ""));
}

function terminalActionItems(source) {
  const lines = sectionLines(source, ["next action", "next safe step", "次のアクション", "次にやる", "restart"], 30);
  const numbered = lines
    .filter((item) => /^\d+[.)]\s+/u.test(item))
    .map((item) => item.replace(/^\d+[.)]\s+/u, "").trim())
    .filter((item) => !noFurtherAction(item));
  if (numbered.length) return { items: unique(numbered, 30), exhaustive: true };
  const actionable = lines.filter((item) => {
    if (noFurtherAction(item)) return false;
    if (/(?:以下|次のとおり|following).*(?:です|ます|:|：)$/iu.test(item)) return false;
    return true;
  });
  return { items: actionable.length === 1 ? unique(actionable, 1) : [], exhaustive: false };
}

function planForSafeTerminal(rollout, snapshot) {
  if (rollout.latest_plan_current?.steps?.length) return rollout.latest_plan_current;
  if (rollout.safe_terminal_detected) {
    const actions = terminalActionItems(rollout.latest_assistant_summary);
    if (actions.items.length && actions.exhaustive) {
      const completed = rollout.latest_plan?.steps
        ?.filter((item) => item.status === "completed")
        .map((item) => ({ step: item.step, status: "completed" })) || [];
      const completedKeys = new Set(completed.map((item) => item.step.toLowerCase()));
      return {
        source: "safe_terminal_reconstruction",
        explanation: "Rebuilt from the latest terminal turn; stale unfinished statuses were not reused.",
        steps: [
          ...completed,
          ...actions.items
            .filter((step) => !completedKeys.has(step.toLowerCase()))
            .map((step) => ({ step, status: "pending" })),
        ],
      };
    }
    if (actions.items.length && rollout.latest_plan?.steps?.length) {
      const steps = rollout.latest_plan.steps.map((item) => ({ ...item }));
      for (const action of actions.items) {
        const match = steps.find((item) => item.step.toLowerCase() === action.toLowerCase());
        if (match) {
          if (match.status === "completed") match.status = "pending";
        } else {
          steps.push({ step: action, status: "pending" });
        }
      }
      return {
        source: "safe_terminal_reconciliation",
        explanation: "Reconciled the latest single next action without discarding the remaining prior plan steps.",
        steps,
      };
    }
    if (rollout.latest_plan?.steps?.length) {
      return {
        ...rollout.latest_plan,
        source: "prior_update_plan_call_unreconciled",
        explanation: "An earlier plan exists, but the latest terminal turn did not contain enough status evidence to reconcile it.",
      };
    }
  }
  return rollout.latest_plan || planFromAuthority(snapshot);
}

function inferExternalEffect(source, observations = {}) {
  const value = String(source || "");
  const positive = /external_(?:action|effect)_executed\s*[:=]\s*true|external effects?\s*[:=]\s*[1-9]|外部効果.{0,20}(?:実行済み|あり|[1-9]\d*件)/iu.test(value);
  const negative = /external_(?:action|effect)_executed\s*[:=]\s*false|external effects?\s*[:=]\s*0|外部効果.{0,20}(?:なし|未実行|0件)/iu.test(value);
  if (positive && negative) return { state: "unknown_conflicting_observations", basis: "assistant_conflicting_observations" };
  if (positive) return { state: "observed_true_unverified", basis: "assistant_explicit_positive" };
  if (negative) return { state: "observed_false", basis: "assistant_explicit_negative" };
  if (observations.coverage_complete !== true) return { state: "unknown", basis: "latest_turn_observation_incomplete" };
  if (Number(observations.mcp_not_read_only || 0) > 0) return { state: "unknown", basis: "non_read_only_tool_observed" };
  if (Number(observations.unknown_tool_inputs || 0) > 0
    || Number(observations.unmatched_mcp_inputs || 0) > 0) {
    return { state: "unknown", basis: "tool_effect_not_mechanically_classified" };
  }
  return {
    state: "observed_false",
    basis: Number(observations.tool_inputs || 0) > 0
      || Number(observations.web_read_only || 0) > 0
      || Number(observations.mcp_read_only || 0) > 0
      ? "latest_turn_mechanically_read_only"
      : "latest_turn_no_tool_calls",
  };
}

function evidencePaths(source, project) {
  const matches = String(source || "").match(/(?:\/Users\/[^\s)\]>'"`]+|(?:work|outputs|artifacts|data)\/[A-Za-z0-9._\/-]+)/gu) || [];
  return unique(matches.map((candidate) => {
    const clean = candidate.replace(/[.,;:]+$/u, "");
    if (path.isAbsolute(clean)) return clean;
    return project ? path.join(project.root, clean) : clean;
  }), 40);
}

function threadCategory(thread) {
  const source = String(thread.thread_source || "").toLowerCase();
  if (source === "automation") return "automation";
  if (["subagent", "agent_created_thread"].includes(source)) return "delegated";
  if (source === "user" || !source) return "manual";
  return "other";
}

function projectObjective(snapshot) {
  const goal = snapshot.find((item) => /(^|\/)goal\.md$/iu.test(item.relative_path));
  if (!goal) return "";
  const line = goal.excerpt.split("\n").find((candidate) => {
    const value = candidate.trim();
    return value && !value.startsWith("#") && !value.startsWith("-") && !value.startsWith("**");
  });
  return text(line || "", 1_200);
}

function buildProjection(thread, rollout, assignment, snapshot) {
  const terminalSummary = rollout.latest_assistant_summary;
  const authorityCombined = snapshot.map((item) => item.excerpt).join("\n");
  const combined = [terminalSummary, authorityCombined].join("\n");
  const latestPlan = planForSafeTerminal(rollout, snapshot);
  const completed = latestPlan?.steps.filter((item) => item.status === "completed").map((item) => item.step) || [];
  const unfinished = latestPlan?.steps.filter((item) => item.status !== "completed").map((item) => item.step) || [];
  const blockerSource = terminalSummary || authorityCombined;
  const blockers = meaningfulSectionLines(blockerSource, ["remaining blocker", "exact blocker", "blocker", "残るブロッカー", "未解決", "exact_blocker"]);
  const decisions = sectionLines(combined, ["decision log", "decisions", "decision", "決定", "判断"]);
  const acceptanceCriteria = sectionLines(combined, ["acceptance criteria", "done criteria", "completion criteria", "完了条件", "受け入れ条件"]);
  const scope = sectionLines(combined, ["scope", "対象範囲", "対象"]);
  const nonGoals = sectionLines(combined, ["non-goals", "non goals", "対象外"]);
  const unknowns = sectionLines(combined, ["unknowns", "unknown", "pending_confirmation", "未確認", "不明"]);
  const explicitNext = meaningfulSectionLines(terminalSummary || authorityCombined, ["next action", "next safe step", "次のアクション", "次にやる", "restart"] , 5)[0] || "";
  const explicitStop = sectionLines(combined, ["stop condition", "hard stop", "停止条件"] , 5)[0] || "";
  const planNext = latestPlan?.source === "safe_terminal_reconciliation"
    ? explicitNext
    : ["latest_update_plan_call", "safe_terminal_reconstruction"].includes(latestPlan?.source) ? unfinished[0] : "";
  const nextAction = text(planNext || explicitNext || unfinished[0] || (rollout.active_turn_detected ? "Current turn must reach a safe terminal checkpoint before handoff." : "No further action recorded; fresh-read project authority before continuing."), 1_200);
  const objective = text(projectObjective(snapshot) || rollout.latest_user_intent || thread.preview || thread.title, 1_200);
  const evidence = unique([...snapshot.map((item) => item.path), ...evidencePaths(combined, assignment.project)], 60);
  const planComplete = ["latest_update_plan_call", "safe_terminal_reconstruction", "safe_terminal_reconciliation"].includes(latestPlan?.source)
    && latestPlan.steps.length > 0;
  const nextActionRecorded = !/^No further action recorded|^Current turn must reach/iu.test(nextAction);
  const planAvailable = Boolean(latestPlan?.steps?.length);
  const completeness = objective && nextActionRecorded && planAvailable
    ? "sufficient"
    : "pending_confirmation";
  const externalEffect = inferExternalEffect(terminalSummary, rollout.latest_turn_effects);
  return {
    objective,
    latest_user_intent: text(rollout.latest_user_intent, 1_200),
    current_state_summary: text(rollout.latest_assistant_summary || snapshot.find((item) => /state\.md$/iu.test(item.relative_path))?.excerpt || "", 2_400),
    plan: latestPlan || { source: "unavailable", explanation: "", steps: [] },
    plan_complete: planComplete,
    status_counts: Object.fromEntries([...VALID_PLAN_STATUSES].map((status) => [status, latestPlan?.steps.filter((item) => item.status === status).length || 0])),
    acceptance_criteria: acceptanceCriteria,
    scope,
    non_goals: nonGoals,
    decisions,
    completed: unique(completed, 100),
    unfinished: unique(unfinished, 100),
    blockers,
    unknowns,
    evidence,
    external_effect_state: externalEffect.state,
    external_effect_basis: externalEffect.basis,
    next_action: nextAction,
    stop_condition: text(explicitStop || "Stop before any replay or external effect when fresh authority, idempotency, or effect readback does not match this packet.", 1_200),
    completeness,
  };
}

export function handoffPressureTriggers(thread, rollout, policy) {
  const triggers = [];
  const durationMs = Math.max(0, thread.updated_at_ms - thread.created_at_ms);
  if (durationMs >= policy.handoff.fallback_min_duration_minutes * 60_000
    && rollout.context_pressure_ratio >= policy.handoff.fallback_min_context_ratio) {
    triggers.push("long_duration_with_moderate_context");
  }
  if (rollout.rollout_size_bytes >= policy.handoff.min_rollout_bytes) triggers.push("large_rollout");
  if (rollout.context_pressure_ratio >= policy.handoff.min_context_ratio) triggers.push("context_pressure");
  if (Math.max(thread.tokens_used, rollout.latest_total_tokens) >= policy.handoff.min_total_tokens) triggers.push("high_token_usage");
  return triggers;
}

export function readSourceHandoffState(policy, threadId) {
  const sourceId = safeId(threadId);
  if (policy?.handoff?.enabled === false || policy?.handoff?.mode === "disabled") {
    return {
      source_status: "active",
      source_execution: "running",
      goal_status: null,
      implementation_allowed: true,
      source_task_visible: true,
      source_task_archived: false,
      destination_thread_id: null,
    };
  }
  const claim = readJson(path.join(policy.output_dir, "handoff-claims", `${sourceId}.json`), null);
  const receipt = readJson(path.join(policy.output_dir, "handoff-receipts", `${sourceId}.json`), null);
  const destinationThreadId = text(receipt?.destination_thread_id || claim?.destination_thread_id, 200) || null;
  if (receipt?.schema === HANDOFF_RECEIPT_SCHEMA
    && ["returned_to_source", "source_resume_ready"].includes(receipt?.status)) {
    return {
      source_status: "source_resume_ready",
      source_execution: "running",
      goal_status: receipt?.source_goal_status || null,
      implementation_allowed: true,
      source_task_visible: true,
      source_task_archived: false,
      destination_thread_id: destinationThreadId,
      handoff_suppressed: true,
      handoff_suppression_reason: "returned_to_source",
      resume_idempotency_key: text(receipt.resume_idempotency_key, 200) || null,
    };
  }
  if (receipt?.schema === HANDOFF_RECEIPT_SCHEMA && receipt?.status === "cancelled_by_user") {
    return {
      source_status: "active",
      source_execution: "running",
      goal_status: receipt?.source_goal_status || null,
      implementation_allowed: true,
      source_task_visible: true,
      source_task_archived: false,
      destination_thread_id: destinationThreadId,
      handoff_suppressed: true,
      handoff_suppression_reason: "cancelled_by_user",
    };
  }
  if (receipt?.schema === HANDOFF_RECEIPT_SCHEMA && receipt?.status === "completed") {
    return {
      source_status: "handoff_completed",
      source_execution: receipt?.source_execution || "handoff_stopped",
      goal_status: receipt?.source_goal_status || receipt?.source_goal_close?.readback?.status || null,
      implementation_allowed: false,
      source_task_visible: true,
      source_task_archived: false,
      destination_thread_id: destinationThreadId,
    };
  }
  if (claim || (receipt?.schema === HANDOFF_RECEIPT_SCHEMA && receipt?.status === "reconciliation_required")) {
    return {
      source_status: "reconciliation_only",
      source_execution: receipt?.source_execution || "handoff_stopped",
      goal_status: receipt?.source_goal_status || receipt?.source_goal_close?.readback?.status || null,
      implementation_allowed: false,
      source_task_visible: true,
      source_task_archived: false,
      destination_thread_id: destinationThreadId,
    };
  }
  return {
    source_status: "active",
    source_execution: "running",
    goal_status: null,
    implementation_allowed: true,
    source_task_visible: true,
    source_task_archived: false,
    destination_thread_id: null,
  };
}

function sourceResumeAuthorityBody(input = {}) {
  return {
    schema: SOURCE_RESUME_AUTHORITY_SCHEMA,
    source_thread_id: text(input.sourceThreadId || input.source_thread_id, 200),
    owner_task_id: text(input.ownerTaskId || input.owner_task_id, 200),
    destination_thread_id: text(input.destinationThreadId || input.destination_thread_id, 200),
    generation: text(input.generation, 200) || null,
    authority_digest: text(input.authorityDigest || input.authority_digest, 200) || null,
    idempotency_key: text(input.idempotencyKey || input.idempotency_key, 200),
  };
}

/**
 * Create an opaque owner proof for the source-thread return transition.
 * The signing secret is supplied by the owner boundary and is never written
 * to a receipt or included in any returned object.
 */
export function signSourceResumeAuthority(input, secret) {
  if (!String(secret || "")) throw new Error("codex_source_resume_owner_secret_required");
  const body = sourceResumeAuthorityBody(input);
  if (!body.source_thread_id || !body.owner_task_id || !body.destination_thread_id || !body.idempotency_key) {
    throw new Error("codex_source_resume_authority_fields_required");
  }
  return {
    ...body,
    signature: hmacSha256(stableJson(body), secret),
  };
}

/**
 * Verify an owner proof against the fresh source/destination identity.  This
 * function deliberately fails closed when a secret or a field is missing.
 */
export function verifySourceResumeAuthority(proof, expected = {}, secret) {
  if (!proof || typeof proof !== "object") throw new Error("codex_source_resume_owner_proof_required");
  if (!String(secret || "")) throw new Error("codex_source_resume_owner_secret_required");
  if (proof.schema !== SOURCE_RESUME_AUTHORITY_SCHEMA) throw new Error("codex_source_resume_authority_schema_invalid");
  const body = sourceResumeAuthorityBody(proof);
  const expectedBody = sourceResumeAuthorityBody({ ...body, ...expected });
  for (const field of ["source_thread_id", "owner_task_id", "destination_thread_id", "generation", "authority_digest", "idempotency_key"]) {
    if (body[field] !== expectedBody[field]) throw new Error(`codex_source_resume_authority_${field}_mismatch`);
  }
  const provided = String(proof.signature || "");
  const expectedSignature = hmacSha256(stableJson(body), secret);
  if (!provided || provided.length !== expectedSignature.length
    || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expectedSignature))) {
    throw new Error("codex_source_resume_authority_signature_invalid");
  }
  return true;
}

function destinationNoOutputProofBody(input = {}) {
  return {
    schema: DESTINATION_NO_OUTPUT_PROOF_SCHEMA,
    source_thread_id: text(input.sourceThreadId || input.source_thread_id, 200),
    destination_thread_id: text(input.destinationThreadId || input.destination_thread_id, 200),
    owner_task_id: text(input.ownerTaskId || input.owner_task_id, 200),
    continuation_turn_id: text(input.continuationTurnId || input.continuation_turn_id, 200),
    destination_state: text(input.destinationState || input.destination_state, 80),
    turn_status: text(input.turnStatus || input.turn_status, 80),
    output_state: text(input.outputState || input.output_state, 80),
    assistant_item_count: Number.isSafeInteger(input.assistantItemCount ?? input.assistant_item_count)
      ? Number(input.assistantItemCount ?? input.assistant_item_count)
      : 0,
    external_effect_state: text(input.externalEffectState || input.external_effect_state, 80),
    reconciliation_state: text(input.reconciliationState || input.reconciliation_state, 80),
    generation: text(input.generation, 200) || null,
    authority_digest: text(input.authorityDigest || input.authority_digest, 200) || null,
    readback_digest: text(input.readbackDigest || input.readback_digest, 200) || null,
    idempotency_key: text(input.idempotencyKey || input.idempotency_key, 200),
  };
}

/**
 * Sign a destination readback that proves the continuation produced no
 * assistant output.  This is deliberately separate from the source-resume
 * authority: a source owner must not be able to turn an unverified empty
 * destination into a resume merely by supplying a local boolean.
 */
export function signDestinationNoOutputProof(input, secret) {
  if (!String(secret || "")) throw new Error("codex_destination_no_output_owner_secret_required");
  const body = destinationNoOutputProofBody(input);
  if (!body.source_thread_id || !body.destination_thread_id || !body.owner_task_id
    || !body.continuation_turn_id || !body.idempotency_key) {
    throw new Error("codex_destination_no_output_proof_fields_required");
  }
  if (body.destination_state !== "idle_interrupted") {
    throw new Error("codex_destination_no_output_destination_not_terminal");
  }
  if (!["completed", "interrupted", "failed"].includes(body.turn_status)) {
    throw new Error("codex_destination_no_output_turn_status_invalid");
  }
  if (body.output_state !== "no_output" || body.assistant_item_count !== 0) {
    throw new Error("codex_destination_no_output_output_present");
  }
  if (body.external_effect_state !== "observed_false" || body.reconciliation_state !== "clear") {
    throw new Error("codex_destination_no_output_effect_not_clear");
  }
  return { ...body, signature: hmacSha256(stableJson(body), secret) };
}

/** Verify a signed destination no-output readback against fresh identities. */
export function verifyDestinationNoOutputProof(proof, expected = {}, secret) {
  if (!proof || typeof proof !== "object") throw new Error("codex_destination_no_output_proof_required");
  if (!String(secret || "")) throw new Error("codex_destination_no_output_owner_secret_required");
  if (proof.schema !== DESTINATION_NO_OUTPUT_PROOF_SCHEMA) throw new Error("codex_destination_no_output_proof_schema_invalid");
  const body = destinationNoOutputProofBody(proof);
  const expectedBody = destinationNoOutputProofBody({ ...body, ...expected });
  for (const field of [
    "source_thread_id", "destination_thread_id", "owner_task_id", "continuation_turn_id",
    "destination_state", "turn_status", "output_state", "assistant_item_count",
    "external_effect_state", "reconciliation_state", "generation", "authority_digest",
    "readback_digest", "idempotency_key",
  ]) {
    if (body[field] !== expectedBody[field]) throw new Error(`codex_destination_no_output_${field}_mismatch`);
  }
  if (body.destination_state !== "idle_interrupted") throw new Error("codex_destination_no_output_destination_not_terminal");
  if (!["completed", "interrupted", "failed"].includes(body.turn_status)) throw new Error("codex_destination_no_output_turn_status_invalid");
  if (body.output_state !== "no_output" || body.assistant_item_count !== 0) throw new Error("codex_destination_no_output_output_present");
  if (body.external_effect_state !== "observed_false" || body.reconciliation_state !== "clear") throw new Error("codex_destination_no_output_effect_not_clear");
  const provided = String(proof.signature || "");
  const expectedSignature = hmacSha256(stableJson(body), secret);
  if (!provided || provided.length !== expectedSignature.length
    || !crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expectedSignature))) {
    throw new Error("codex_destination_no_output_proof_signature_invalid");
  }
  return true;
}

/**
 * Accept an optional Companion effect proof as an additional no-effect gate.
 * The proof is evidence only; the source-resume authority and destination
 * no-output proof remain independent required controls.
 */
export function verifyCompanionEffectProof(proof, expected = {}, secret) {
  if (!proof) return null;
  return verifyCompanionOperationEffectProof(proof, { secret, expected });
}

export function sourceResumeIdempotencyKey({
  sourceThreadId,
  generation = null,
  lastTerminalTurnId = null,
  resumeIntent = "resume_in_source",
} = {}) {
  const source = text(sourceThreadId, 200);
  if (!source) throw new Error("codex_source_resume_source_thread_required");
  const digest = sha256(stableJson({
    source_thread_id: source,
    generation: text(generation, 200) || null,
    last_terminal_turn_id: text(lastTerminalTurnId, 200) || null,
    resume_intent: text(resumeIntent, 120) || "resume_in_source",
  }));
  return `resume_${digest.slice(0, 48)}`;
}

export function destinationNoOutputIdempotencyKey({
  sourceThreadId,
  destinationThreadId,
  continuationTurnId = null,
  generation = null,
  readbackDigest = null,
  resumeIntent = "return_no_output_to_source",
} = {}) {
  const source = text(sourceThreadId, 200);
  const destination = text(destinationThreadId, 200);
  const turn = text(continuationTurnId, 200) || null;
  if (!source || !destination || !turn) throw new Error("codex_destination_no_output_identity_required");
  const digest = sha256(stableJson({
    source_thread_id: source,
    destination_thread_id: destination,
    continuation_turn_id: turn,
    generation: text(generation, 200) || null,
    readback_digest: text(readbackDigest, 200) || null,
    resume_intent: text(resumeIntent, 120) || "return_no_output_to_source",
  }));
  return `return_${digest.slice(0, 48)}`;
}

function stripDestinationNoOutputProof(proof) {
  const body = destinationNoOutputProofBody(proof);
  return { ...body, proof_verified: true };
}

/**
 * Return a destination that was created but produced no assistant output to
 * its source task.  This is a local, signed state transition only: it does
 * not contact Codex, send another turn, replay a provider effect, or archive
 * either task.  The destination owner proof and source owner proof are both
 * required, making an empty/no-output classification auditable and bounded.
 */
function returnCompletedNoOutputHandoffUnlocked(policy, threadId, {
  expectedDestinationThreadId,
  destinationNoOutputProof,
  destinationOwnerTaskId,
  ownerTaskId,
  ownerProof,
  ownerSecret,
  verifyOwnerProof = null,
  verifyDestinationProof = null,
  companionEffectProof = null,
  companionEffectProofSecret = null,
  generation = null,
  expectedGeneration = null,
  authorityDigest = null,
  idempotencyKey = null,
  lastTerminalTurnId = null,
  resumeIntent = "return_no_output_to_source",
  reason = "Destination continuation produced no assistant output; continue in the source task.",
} = {}) {
  const sourceThreadId = text(threadId, 200);
  if (!sourceThreadId) throw new Error("codex_source_resume_source_thread_required");
  if (text(ownerTaskId, 200) !== sourceThreadId) throw new Error("codex_source_resume_owner_task_mismatch");
  const sourceId = safeId(sourceThreadId);
  const claimPath = path.join(policy.output_dir, "handoff-claims", `${sourceId}.json`);
  const receiptPath = path.join(policy.output_dir, "handoff-receipts", `${sourceId}.json`);
  const claim = readJson(claimPath, null);
  const receipt = readJson(receiptPath, null);
  if (claim?.schema !== "codex_hookless_handoff_claim.v1" || receipt?.schema !== HANDOFF_RECEIPT_SCHEMA) {
    throw new Error("codex_source_resume_state_missing");
  }
  if (text(claim.source_thread_id, 200) !== sourceThreadId || text(receipt.source_thread_id, 200) !== sourceThreadId) {
    throw new Error("codex_source_resume_source_identity_mismatch");
  }
  const actualDestinationThreadId = text(receipt.destination_thread_id || claim.destination_thread_id, 200);
  if (!actualDestinationThreadId || actualDestinationThreadId !== text(expectedDestinationThreadId, 200)) {
    throw new Error("codex_source_resume_destination_mismatch");
  }
  const effectiveGeneration = text(generation || receipt.generation || claim.generation, 200) || null;
  if (expectedGeneration !== null && text(expectedGeneration, 200) !== effectiveGeneration) {
    throw new Error("codex_source_resume_generation_mismatch");
  }
  const effectiveAuthorityDigest = text(authorityDigest || receipt.authority_digest || claim.authority_digest, 200) || null;
  const proofTurnId = text(destinationNoOutputProof?.continuationTurnId || destinationNoOutputProof?.continuation_turn_id
    || receipt.continuation_turn_id, 200);
  const proofReadbackDigest = text(destinationNoOutputProof?.readbackDigest || destinationNoOutputProof?.readback_digest, 200) || null;
  const effectiveIdempotencyKey = text(idempotencyKey, 200)
    || text(destinationNoOutputProof?.idempotencyKey || destinationNoOutputProof?.idempotency_key, 200)
    || sourceResumeIdempotencyKey({ sourceThreadId, generation: effectiveGeneration, lastTerminalTurnId: proofTurnId || lastTerminalTurnId, resumeIntent });
  const destinationProofOwner = text(destinationOwnerTaskId, 200) || actualDestinationThreadId;

  if (["returned_to_source", "source_resume_ready"].includes(receipt.status)) {
    if (receipt.resume_idempotency_key === effectiveIdempotencyKey) return receipt;
    throw new Error("codex_source_resume_already_returned");
  }
  if (!["completed", "destination_no_output_verified", "return_requested"].includes(receipt.status)) {
    throw new Error("codex_source_resume_receipt_state_invalid");
  }
  if (receipt.status === "return_requested"
    && text(receipt.resume_idempotency_key, 200) !== effectiveIdempotencyKey) {
    throw new Error("codex_source_resume_return_request_idempotency_mismatch");
  }

  const destinationExpected = {
    sourceThreadId,
    destinationThreadId: actualDestinationThreadId,
    ownerTaskId: destinationProofOwner,
    continuationTurnId: proofTurnId || null,
    destinationState: "idle_interrupted",
    outputState: "no_output",
    assistantItemCount: 0,
    externalEffectState: "observed_false",
    reconciliationState: "clear",
    generation: effectiveGeneration,
    authorityDigest: effectiveAuthorityDigest,
    readbackDigest: proofReadbackDigest,
    idempotencyKey: effectiveIdempotencyKey,
  };
  if (typeof verifyDestinationProof === "function") {
    if (verifyDestinationProof(destinationNoOutputProof, destinationExpected) !== true) {
      throw new Error("codex_destination_no_output_proof_invalid");
    }
  } else {
    verifyDestinationNoOutputProof(destinationNoOutputProof, destinationExpected, ownerSecret);
  }
  const sourceExpectedAuthority = {
    sourceThreadId,
    ownerTaskId: sourceThreadId,
    destinationThreadId: actualDestinationThreadId,
    generation: effectiveGeneration,
    authorityDigest: effectiveAuthorityDigest,
    idempotencyKey: effectiveIdempotencyKey,
  };
  if (typeof verifyOwnerProof === "function") {
    if (verifyOwnerProof(ownerProof, sourceExpectedAuthority) !== true) throw new Error("codex_source_resume_owner_proof_invalid");
  } else {
    verifySourceResumeAuthority(ownerProof, sourceExpectedAuthority, ownerSecret);
  }
  const companionProofBody = companionEffectProof
    ? verifyCompanionEffectProof(companionEffectProof, { taskId: sourceThreadId }, companionEffectProofSecret || ownerSecret)
    : null;

  const proofBody = stripDestinationNoOutputProof(destinationNoOutputProof);
  const requestedAt = isoNow();
  const verifiedReceipt = {
    ...receipt,
    status: "destination_no_output_verified",
    source_status: "reconciliation_only",
    implementation_allowed: false,
    source_task_archived: false,
    source_task_visible: true,
    destination_ready: false,
    destination_no_output_verified: true,
    destination_no_output_verified_at: requestedAt,
    destination_no_output_proof: proofBody,
    companion_effect_proof: companionProofBody,
    companion_effect_proof_verified: Boolean(companionProofBody),
    resume_idempotency_key: effectiveIdempotencyKey,
    resume_requested_at: requestedAt,
    resume_reason: text(reason, 500),
    exact_blocker: null,
  };
  atomicWriteJson(receiptPath, verifiedReceipt);
  const returnedAt = isoNow();
  const returnedReceipt = {
    ...verifiedReceipt,
    status: "returned_to_source",
    source_status: "source_resume_ready",
    implementation_allowed: true,
    handoff_suppressed: true,
    handoff_suppression_reason: "destination_no_output_returned_to_source",
    returned_to_source_at: returnedAt,
    destination_no_output_returned_at: returnedAt,
  };
  const returnedClaim = {
    ...claim,
    state_before_return: claim.state,
    state: "returned_to_source",
    returned_to_source_at: returnedAt,
    resume_idempotency_key: effectiveIdempotencyKey,
    destination_no_output_verified: true,
  };
  atomicWriteJson(claimPath, returnedClaim);
  atomicWriteJson(receiptPath, returnedReceipt);
  return returnedReceipt;
}

export function returnCompletedNoOutputHandoff(policy, threadId, options = {}) {
  const rawOutputDir = String(policy?.output_dir || "").trim();
  const outputDir = path.resolve(rawOutputDir || ".");
  if (!rawOutputDir || outputDir === path.parse(outputDir).root) {
    throw new Error("codex_source_resume_output_dir_invalid");
  }
  const release = acquireLock(path.join(outputDir, ".source-resume.lock"));
  try {
    return returnCompletedNoOutputHandoffUnlocked(policy, threadId, options);
  } finally {
    release();
  }
}

export const resumeCompletedNoOutputHandoff = returnCompletedNoOutputHandoff;
export const returnNoOutputHandoffToSource = returnCompletedNoOutputHandoff;

/**
 * Return an existing handoff to its source task after a fresh, owner-signed
 * no-effect observation.  This is a local state transition only: it never
 * contacts the destination, sends a turn, changes a goal, or performs a
 * browser/external operation.
 */
function resumeSourceHandoffUnlocked(policy, threadId, {
  expectedDestinationThreadId,
  destinationState,
  externalEffectState,
  reconciliationState = "clear",
  ownerTaskId,
  ownerProof,
  ownerSecret,
  verifyOwnerProof = null,
  companionEffectProof = null,
  companionEffectProofSecret = null,
  generation = null,
  expectedGeneration = null,
  authorityDigest = null,
  idempotencyKey = null,
  lastTerminalTurnId = null,
  resumeIntent = "resume_in_source",
  reason = "Owner requested continuation in the source task.",
} = {}) {
  const sourceThreadId = text(threadId, 200);
  if (!sourceThreadId) throw new Error("codex_source_resume_source_thread_required");
  if (text(ownerTaskId, 200) !== sourceThreadId) throw new Error("codex_source_resume_owner_task_mismatch");
  if (destinationState !== "idle_interrupted") throw new Error("codex_source_resume_destination_not_terminal");
  if (externalEffectState !== "observed_false") throw new Error("codex_source_resume_external_effect_reconciliation_required");
  if (reconciliationState !== "clear") throw new Error("codex_source_resume_reconciliation_required");

  const sourceId = safeId(sourceThreadId);
  const claimPath = path.join(policy.output_dir, "handoff-claims", `${sourceId}.json`);
  const receiptPath = path.join(policy.output_dir, "handoff-receipts", `${sourceId}.json`);
  const claim = readJson(claimPath, null);
  const receipt = readJson(receiptPath, null);
  if (claim?.schema !== "codex_hookless_handoff_claim.v1" || receipt?.schema !== HANDOFF_RECEIPT_SCHEMA) {
    throw new Error("codex_source_resume_state_missing");
  }
  if (text(claim.source_thread_id, 200) !== sourceThreadId || text(receipt.source_thread_id, 200) !== sourceThreadId) {
    throw new Error("codex_source_resume_source_identity_mismatch");
  }
  const actualDestinationThreadId = text(receipt.destination_thread_id || claim.destination_thread_id, 200);
  if (!actualDestinationThreadId || actualDestinationThreadId !== text(expectedDestinationThreadId, 200)) {
    throw new Error("codex_source_resume_destination_mismatch");
  }
  const effectiveGeneration = text(generation || receipt.generation || claim.generation, 200) || null;
  if (expectedGeneration !== null && text(expectedGeneration, 200) !== effectiveGeneration) {
    throw new Error("codex_source_resume_generation_mismatch");
  }
  const effectiveAuthorityDigest = text(authorityDigest || receipt.authority_digest || claim.authority_digest, 200) || null;
  const effectiveIdempotencyKey = text(idempotencyKey, 200)
    || sourceResumeIdempotencyKey({ sourceThreadId, generation: effectiveGeneration, lastTerminalTurnId, resumeIntent });

  if (receipt.status === "returned_to_source" || receipt.status === "source_resume_ready") {
    if (receipt.resume_idempotency_key === effectiveIdempotencyKey) return receipt;
    throw new Error("codex_source_resume_already_returned");
  }
  if (receipt.status === "completed" || receipt.destination_ready === true) {
    throw new Error("codex_source_resume_destination_already_ready");
  }
  if (!["reconciliation_required", "return_requested"].includes(receipt.status)) {
    throw new Error("codex_source_resume_receipt_state_invalid");
  }
  if (receipt.status === "return_requested"
    && text(receipt.resume_idempotency_key, 200) !== effectiveIdempotencyKey) {
    throw new Error("codex_source_resume_return_request_idempotency_mismatch");
  }

  const expectedAuthority = {
    sourceThreadId,
    ownerTaskId: sourceThreadId,
    destinationThreadId: actualDestinationThreadId,
    generation: effectiveGeneration,
    authorityDigest: effectiveAuthorityDigest,
    idempotencyKey: effectiveIdempotencyKey,
  };
  if (typeof verifyOwnerProof === "function") {
    if (verifyOwnerProof(ownerProof, expectedAuthority) !== true) throw new Error("codex_source_resume_owner_proof_invalid");
  } else {
    verifySourceResumeAuthority(ownerProof, expectedAuthority, ownerSecret);
  }
  const companionProofBody = companionEffectProof
    ? verifyCompanionEffectProof(companionEffectProof, { taskId: sourceThreadId }, companionEffectProofSecret || ownerSecret)
    : null;

  const requestedAt = isoNow();
  const requestReceipt = {
    ...receipt,
    status: "return_requested",
    source_status: "reconciliation_only",
    implementation_allowed: false,
    source_task_archived: false,
    source_task_visible: true,
    destination_ready: false,
    resume_idempotency_key: effectiveIdempotencyKey,
    resume_requested_at: requestedAt,
    resume_reason: text(reason, 500),
    resume_authority: {
      schema: SOURCE_RESUME_AUTHORITY_SCHEMA,
      source_thread_id: sourceThreadId,
      owner_task_id: sourceThreadId,
      destination_thread_id: actualDestinationThreadId,
      generation: effectiveGeneration,
      authority_digest: effectiveAuthorityDigest,
      proof_verified: true,
    },
    companion_effect_proof: companionProofBody,
    companion_effect_proof_verified: Boolean(companionProofBody),
    exact_blocker: null,
  };
  atomicWriteJson(receiptPath, requestReceipt);
  const returnedReceipt = {
    ...requestReceipt,
    status: "returned_to_source",
    source_status: "source_resume_ready",
    implementation_allowed: true,
    handoff_suppressed: true,
    handoff_suppression_reason: "returned_to_source",
    returned_to_source_at: isoNow(),
  };
  const returnedClaim = {
    ...claim,
    state_before_return: claim.state,
    state: "returned_to_source",
    returned_to_source_at: returnedReceipt.returned_to_source_at,
    resume_idempotency_key: effectiveIdempotencyKey,
  };
  atomicWriteJson(claimPath, returnedClaim);
  atomicWriteJson(receiptPath, returnedReceipt);
  return returnedReceipt;
}

/**
 * Serialize source-return transitions across the hourly scheduler and a
 * manually requested resume.  Both callers can observe the same
 * reconciliation receipt at once; the lock makes the idempotency check and
 * the `return_requested` -> `returned_to_source` writes one local critical
 * section without contacting Codex or a provider.
 */
export function resumeSourceHandoff(policy, threadId, options = {}) {
  const rawOutputDir = String(policy?.output_dir || "").trim();
  const outputDir = path.resolve(rawOutputDir || ".");
  if (!rawOutputDir || outputDir === path.parse(outputDir).root) {
    throw new Error("codex_source_resume_output_dir_invalid");
  }
  const release = acquireLock(path.join(outputDir, ".source-resume.lock"));
  try {
    return resumeSourceHandoffUnlocked(policy, threadId, options);
  } finally {
    release();
  }
}

export function cancelSourceHandoff(policy, threadId, {
  expectedDestinationThreadId,
  destinationState,
  externalEffectState,
  userRequested = false,
  reason = "",
} = {}) {
  const sourceThreadId = text(threadId, 200);
  if (!sourceThreadId) throw new Error("codex_hookless_handoff_cancel_source_thread_required");
  if (userRequested !== true) throw new Error("codex_hookless_handoff_cancel_user_request_required");
  if (destinationState !== "idle_interrupted") {
    throw new Error("codex_hookless_handoff_cancel_destination_not_terminal");
  }
  if (externalEffectState !== "observed_false") {
    throw new Error("codex_hookless_handoff_cancel_external_effect_reconciliation_required");
  }
  const sourceId = safeId(sourceThreadId);
  const claimPath = path.join(policy.output_dir, "handoff-claims", `${sourceId}.json`);
  const receiptPath = path.join(policy.output_dir, "handoff-receipts", `${sourceId}.json`);
  const claim = readJson(claimPath, null);
  const receipt = readJson(receiptPath, null);
  if (claim?.schema !== "codex_hookless_handoff_claim.v1"
    || receipt?.schema !== HANDOFF_RECEIPT_SCHEMA) {
    throw new Error("codex_hookless_handoff_cancel_state_missing");
  }
  if (receipt.status === "completed" || receipt.destination_ready === true) {
    throw new Error("codex_hookless_handoff_cancel_destination_already_ready");
  }
  if (receipt.status === "cancelled_by_user") return receipt;
  if (receipt.status !== "reconciliation_required") {
    throw new Error("codex_hookless_handoff_cancel_receipt_state_invalid");
  }
  const actualDestinationThreadId = text(
    receipt.destination_thread_id || claim.destination_thread_id,
    200,
  );
  if (!actualDestinationThreadId
    || actualDestinationThreadId !== text(expectedDestinationThreadId, 200)) {
    throw new Error("codex_hookless_handoff_cancel_destination_mismatch");
  }
  const cancelledAt = isoNow();
  const cancellationReason = text(reason || "User explicitly requested continuation in the source task.", 500);
  const cancelledClaim = {
    ...claim,
    state_before_cancellation: claim.state,
    state: "cancelled_by_user",
    cancelled_at: cancelledAt,
    cancellation_reason: cancellationReason,
  };
  const cancelledReceipt = {
    ...receipt,
    status_before_cancellation: receipt.status,
    source_status_before_cancellation: receipt.source_status,
    implementation_allowed_before_cancellation: receipt.implementation_allowed,
    status: "cancelled_by_user",
    source_status: "active",
    implementation_allowed: true,
    source_task_archived: false,
    source_task_visible: true,
    destination_ready: false,
    exact_blocker: null,
    cancelled_at: cancelledAt,
    cancellation_reason: cancellationReason,
    cancellation_evidence: {
      user_requested: true,
      destination_state: destinationState,
      external_effect_state: externalEffectState,
    },
  };
  atomicWriteJson(claimPath, cancelledClaim);
  atomicWriteJson(receiptPath, cancelledReceipt);
  return cancelledReceipt;
}

function handoffEligibility(thread, rollout, assignment, projection, policy, currentThreadId, sourceHandoffState) {
  const reasons = [];
  const triggers = handoffPressureTriggers(thread, rollout, policy);
  if (!policy.handoff.enabled || policy.handoff.mode === "disabled") reasons.push("handoff_disabled");
  if (thread.archived) reasons.push("source_already_archived");
  if (thread.id === currentThreadId) reasons.push("current_thread");
  if (thread.is_pinned) reasons.push("pinned_thread");
  if (rollout.active_turn_detected) reasons.push("active_turn_detected");
  if (!rollout.safe_terminal_detected) reasons.push("safe_terminal_not_detected");
  if (sourceHandoffState.source_status === "reconciliation_only") reasons.push("source_handoff_reconciliation_only");
  if (sourceHandoffState.source_status === "handoff_completed") reasons.push("source_handoff_completed");
  if (sourceHandoffState.handoff_suppressed === true) reasons.push("source_handoff_cancelled_by_user");
  if (policy.handoff.protected_thread_ids.includes(thread.id)) reasons.push("protected_thread_id");
  if (!policy.handoff.categories.includes(threadCategory(thread))) reasons.push("category_not_enabled");
  if (policy.handoff.require_project && assignment.status !== "assigned") reasons.push("project_assignment_required");
  if (projection.completeness !== "sufficient") reasons.push("projection_incomplete");
  if (policy.handoff.require_complete_plan && !projection.plan_complete) reasons.push("complete_plan_required");
  if (!projection.unfinished.length) reasons.push("no_unfinished_work");
  if (policy.handoff.activation_not_before_ms && thread.updated_at_ms < policy.handoff.activation_not_before_ms) reasons.push("before_handoff_activation");
  if (!triggers.length) reasons.push("handoff_pressure_not_reached");
  const effectRequiresReconciliation = ["unknown", "unknown_conflicting_observations", "observed_true_unverified"].includes(projection.external_effect_state);
  return {
    eligible: reasons.length === 0,
    reasons,
    triggers,
    mode: policy.handoff.mode,
    automatic_thread_creation: policy.handoff.automatic_thread_creation,
    source_task_retention: "keep_visible_never_archive",
    execution_requires_reconciliation: effectRequiresReconciliation,
    packet_path: null,
    packet_content_sha256: null,
    prepared: false,
  };
}

function projectSummaries(rows, projects) {
  return projects.map((project) => {
    const members = rows.filter((row) => row.project?.id === project.id);
    if (!members.length) return null;
    const newest = [...members].sort((a, b) => b.updated_at_ms - a.updated_at_ms)[0];
    return {
      id: project.id,
      label: project.label,
      root: project.root,
      thread_ids: members.map((row) => row.thread_id),
      active_thread_ids: members.filter((row) => row.runtime.active_turn_detected).map((row) => row.thread_id),
      objective: newest.projection.objective,
      plan: newest.projection.plan,
      blockers: unique(members.flatMap((row) => row.projection.blockers), 40),
      evidence: unique(members.flatMap((row) => row.projection.evidence), 80),
      external_effect_state: members.some((row) => row.projection.external_effect_state === "observed_true_unverified")
        ? "observed_true_unverified"
        : members.every((row) => row.projection.external_effect_state === "observed_false") ? "observed_false" : "unknown",
      next_action: newest.projection.next_action,
      authoritative_thread_id: newest.thread_id,
      updated_at: new Date(newest.updated_at_ms).toISOString(),
    };
  }).filter(Boolean);
}

function snapshotsEqual(previous, current) {
  if (!Array.isArray(previous) || previous.length !== current.length) return false;
  const byPath = new Map(previous.map((item) => [item.path, item.sha256]));
  return current.every((item) => byPath.get(item.path) === item.sha256);
}

export function buildLedger(policy, {
  currentThreadId = process.env.CODEX_SESSION_ID || "",
  previousLedger = readJson(path.join(policy.output_dir, "ledger.v1.json"), null),
} = {}) {
  const projects = mergeProjectRoots(policy);
  const threads = readThreads(policy);
  const projectPolicySha256 = sha256(stableJson(projects.map((project) => ({
    id: project.id,
    root: project.root,
    authority_files: project.authority_files,
    thread_ids: project.thread_ids,
  }))));
  const projectPolicyStable = previousLedger?.inputs?.project_policy_sha256 === projectPolicySha256
    && previousLedger?.inputs?.projection_version === PROJECTION_VERSION;
  const previousRows = new Map(
    previousLedger?.schema === LEDGER_SCHEMA
      ? (previousLedger.threads || []).map((row) => [row.thread_id, row])
      : [],
  );
  const snapshotCache = new Map();
  const rows = threads.map((thread) => {
    const previous = previousRows.get(thread.id);
    const fingerprint = rolloutFingerprint(thread.rollout_path);
    const unchanged = Boolean(projectPolicyStable
      && previous
      && previous.updated_at_ms === thread.updated_at_ms
      && Number(previous.source?.rollout_size_bytes || 0) === fingerprint.size
      && Number(previous.source?.rollout_mtime_ms || 0) === fingerprint.mtime_ms);
    let assignment = null;
    let snapshot = [];
    let canReuse = false;
    let rollout = null;
    if (unchanged && previous.project?.root) {
      const previousProject = projects.find((project) => project.root === previous.project.root) || {
        ...previous.project,
        authority_files: DEFAULT_AUTHORITY_FILES,
        thread_ids: [],
      };
      assignment = {
        status: previous.project_assignment?.status || "assigned",
        project: previousProject,
        confidence: Number(previous.project_assignment?.confidence || 0),
        reasons: previous.project_assignment?.reasons || ["previous_projection"],
      };
      if (!snapshotCache.has(previousProject.root)) {
        snapshotCache.set(previousProject.root, authoritySnapshot(previousProject, policy.max_authority_file_bytes));
      }
      snapshot = snapshotCache.get(previousProject.root);
      canReuse = snapshotsEqual(previous.authority_snapshot, snapshot);
    }
    if (!canReuse) {
      rollout = parseRollout(thread, policy.rollout_tail_bytes);
      const extendedHandoffReadAllowed = !thread.archived
        && (!policy.handoff.activation_not_before_ms || thread.updated_at_ms >= policy.handoff.activation_not_before_ms)
        && !policy.handoff.protected_thread_ids.includes(thread.id)
        && policy.handoff.categories.includes(threadCategory(thread));
      if (extendedHandoffReadAllowed
        && (!rollout.latest_plan_current || !rollout.latest_turn_coverage_complete)
        && handoffPressureTriggers(thread, rollout, policy).length > 0
        && policy.handoff.rollout_tail_bytes > policy.rollout_tail_bytes) {
        rollout = parseRollout(thread, policy.handoff.rollout_tail_bytes);
      }
      assignment = assignProject(thread, rollout, projects, policy);
      const snapshotKey = assignment.project?.root || "unassigned";
      if (!snapshotCache.has(snapshotKey)) {
        snapshotCache.set(snapshotKey, authoritySnapshot(assignment.project, policy.max_authority_file_bytes));
      }
      snapshot = snapshotCache.get(snapshotKey);
    }
    const projection = canReuse ? previous.projection : buildProjection(thread, rollout, assignment, snapshot);
    const effectiveRuntime = canReuse ? previous.runtime : {
      active_turn_detected: rollout.active_turn_detected,
      safe_terminal_detected: rollout.safe_terminal_detected,
      latest_turn_coverage_complete: rollout.latest_turn_coverage_complete,
      latest_turn_id: rollout.latest_turn_id,
      last_task_started_at: rollout.last_task_started_at,
      last_task_completed_at: rollout.last_task_completed_at,
      task_started_count: rollout.task_started_count,
      task_completed_count: rollout.task_completed_count,
      latest_context_tokens: rollout.latest_context_tokens,
      latest_total_tokens: rollout.latest_total_tokens,
      model_context_window: rollout.model_context_window,
      context_pressure_ratio: rollout.context_pressure_ratio,
    };
    const effectiveRollout = canReuse ? {
      rollout_path: previous.source?.rollout_path || thread.rollout_path,
      rollout_size_bytes: previous.source?.rollout_size_bytes || 0,
      rollout_mtime_ms: previous.source?.rollout_mtime_ms || 0,
      rollout_tail_truncated: Boolean(previous.source?.rollout_tail_truncated),
      parse_errors: Number(previous.source?.parse_errors || 0),
      active_turn_detected: effectiveRuntime.active_turn_detected,
      safe_terminal_detected: effectiveRuntime.safe_terminal_detected,
      latest_turn_coverage_complete: effectiveRuntime.latest_turn_coverage_complete,
      latest_turn_id: effectiveRuntime.latest_turn_id,
      last_task_started_at: effectiveRuntime.last_task_started_at,
      last_task_completed_at: effectiveRuntime.last_task_completed_at,
      task_started_count: effectiveRuntime.task_started_count,
      task_completed_count: effectiveRuntime.task_completed_count,
      latest_context_tokens: effectiveRuntime.latest_context_tokens,
      latest_total_tokens: effectiveRuntime.latest_total_tokens,
      model_context_window: effectiveRuntime.model_context_window,
      context_pressure_ratio: effectiveRuntime.context_pressure_ratio,
    } : rollout;
    const sourceHandoffState = readSourceHandoffState(policy, thread.id);
    const eligibility = handoffEligibility(thread, effectiveRollout, assignment, projection, policy, currentThreadId, sourceHandoffState);
    return {
      thread_id: thread.id,
      title: thread.title,
      category: threadCategory(thread),
      cwd: thread.cwd,
      created_at_ms: thread.created_at_ms,
      updated_at_ms: thread.updated_at_ms,
      tokens_used: thread.tokens_used,
      archived: thread.archived,
      pinned: thread.is_pinned,
      app_project_id: thread.project_id || null,
      project: assignment.project ? { id: assignment.project.id, label: assignment.project.label, root: assignment.project.root } : null,
      project_assignment: { status: assignment.status, confidence: assignment.confidence, reasons: assignment.reasons },
      runtime: effectiveRuntime,
      source: {
        rollout_path: effectiveRollout.rollout_path,
        rollout_size_bytes: effectiveRollout.rollout_size_bytes,
        rollout_mtime_ms: effectiveRollout.rollout_mtime_ms,
        rollout_tail_truncated: effectiveRollout.rollout_tail_truncated,
        parse_errors: effectiveRollout.parse_errors,
        thread_source: thread.thread_source || null,
      },
      authority_snapshot: snapshot.map(({ excerpt, ...item }) => item),
      projection,
      projection_reused: Boolean(canReuse),
      source_handoff_state: sourceHandoffState,
      handoff: eligibility,
    };
  });
  const body = {
    schema: LEDGER_SCHEMA,
    generated_at: isoNow(),
    generation_mode: "hookless_local_projection",
    inputs: {
      state_db: policy.state_db,
      project_registry: policy.project_registry ? canonical(policy.project_registry) : null,
      hooks_used: false,
      thread_activation_used: false,
      internal_database_writes: false,
      rollout_tail_bytes: policy.rollout_tail_bytes,
      project_policy_sha256: projectPolicySha256,
      projection_version: PROJECTION_VERSION,
    },
    policy: {
      archive_tasks: false,
      keep_source_visible: true,
      handoff_enabled: policy.handoff.enabled,
      handoff_mode: policy.handoff.mode,
      automatic_thread_creation: policy.handoff.automatic_thread_creation,
      handoff_activation_not_before_ms: policy.handoff.activation_not_before_ms,
      handoff_max_per_run: policy.handoff.max_per_run,
    },
    counts: {
      threads: rows.length,
      projects: new Set(rows.map((row) => row.project?.id).filter(Boolean)).size,
      active: rows.filter((row) => row.runtime.active_turn_detected).length,
      handoff_eligible: rows.filter((row) => row.handoff.eligible).length,
      needs_project_review: rows.filter((row) => row.project_assignment.status !== "assigned").length,
    },
    projects: projectSummaries(rows, projects),
    threads: rows.sort((a, b) => b.updated_at_ms - a.updated_at_ms || a.thread_id.localeCompare(b.thread_id)),
  };
  body.content_sha256 = sha256(stableJson({ ...body, generated_at: null, content_sha256: null }));
  return body;
}

export function recordHooklessTurnObservations(policy, ledger) {
  if (!policy.hookless_observer?.enabled) {
    return {
      enabled: false,
      bootstrapped: false,
      observed: 0,
      outcome_receipts_created: 0,
      outcome_receipts_existing: 0,
      events_path: null,
      outcomes_dir: null,
    };
  }
  const statePath = policy.hookless_observer.state_path;
  const eventsPath = policy.hookless_observer.events_path;
  const outcomesDir = policy.hookless_observer.outcomes_dir;
  const previous = readJson(statePath, null);
  const priorWatermarks = previous?.schema === "codex_hookless_turn_observer_state.v1"
    && previous?.watermarks && typeof previous.watermarks === "object"
    ? previous.watermarks
    : {};
  const terminalRows = ledger.threads
    .filter((row) => row.runtime.safe_terminal_detected && !row.runtime.active_turn_detected && row.runtime.task_completed_count > 0)
    .sort((a, b) => a.updated_at_ms - b.updated_at_ms || a.thread_id.localeCompare(b.thread_id));
  if (previous?.schema !== "codex_hookless_turn_observer_state.v1") {
    const watermarks = Object.fromEntries(terminalRows.map((row) => [row.thread_id, {
      updated_at_ms: row.updated_at_ms,
      task_completed_count: row.runtime.task_completed_count,
    }]));
    atomicWriteJson(statePath, {
      schema: "codex_hookless_turn_observer_state.v1",
      updated_at: isoNow(),
      bootstrap_without_historical_replay: true,
      watermarks,
    });
    return {
      enabled: true,
      bootstrapped: true,
      observed: 0,
      outcome_receipts_created: 0,
      outcome_receipts_existing: 0,
      events_path: eventsPath,
      outcomes_dir: outcomesDir,
    };
  }
  const candidates = terminalRows.filter((row) => {
    const watermark = priorWatermarks[row.thread_id] || {};
    return row.updated_at_ms > Number(watermark.updated_at_ms || 0)
      || row.runtime.task_completed_count > Number(watermark.task_completed_count || 0);
  }).slice(0, policy.hookless_observer.max_events_per_run);
  const watermarks = { ...priorWatermarks };
  let outcomeReceiptsCreated = 0;
  let outcomeReceiptsExisting = 0;
  const outcomeReceiptPaths = [];
  for (const row of candidates) {
    const completionCount = row.runtime.task_completed_count;
    const terminalTurnId = safeId(row.runtime.latest_turn_id || `terminal-${completionCount}-${row.updated_at_ms}`);
    const outcomeId = `turn:${safeId(row.thread_id)}:${terminalTurnId}`;
    const outcome = {
      schema: TURN_OUTCOME_SCHEMA,
      outcome_id: outcomeId,
      recorded_at: isoNow(),
      session_id: row.thread_id,
      turn_id: row.runtime.latest_turn_id || `terminal:${completionCount}`,
      task_completed_count: completionCount,
      cwd: row.project?.root || row.cwd,
      project_id: row.project?.id || null,
      status: "terminal_observed",
      automated: true,
      raw_prompt_stored: false,
      raw_transcript_stored: false,
      business_completion: "unknown",
      same_run: false,
      readback_verified: false,
      plan_source: row.projection.plan.source,
      plan_status_counts: row.projection.status_counts,
      blocker_count: row.projection.blockers.length,
      unknown_count: row.projection.unknowns.length,
      evidence_count: row.projection.evidence.length,
      external_effect_state: row.projection.external_effect_state,
      external_effect_basis: row.projection.external_effect_basis || "unknown",
      external_action_executed: row.projection.external_effect_state === "observed_false"
        ? false
        : row.projection.external_effect_state === "observed_true_unverified" ? true : null,
      source_handoff_status: row.source_handoff_state.source_status,
    };
    outcome.content_sha256 = sha256(stableJson({ ...outcome, content_sha256: null }));
    const outcomePath = path.join(outcomesDir, safeId(row.thread_id), `${terminalTurnId}.json`);
    try {
      atomicWriteJsonNoReplace(outcomePath, outcome);
      outcomeReceiptsCreated += 1;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existing = readJson(outcomePath, null);
      if (existing?.schema !== TURN_OUTCOME_SCHEMA || existing?.outcome_id !== outcomeId) {
        throw new Error("codex_operational_turn_outcome_collision");
      }
      outcomeReceiptsExisting += 1;
    }
    outcomeReceiptPaths.push(outcomePath);
    appendJsonLine(eventsPath, {
      schema: "codex_operational_memory_auto_event.v1",
      event_id: `turn:${safeId(row.thread_id)}:${row.updated_at_ms}:${completionCount}`,
      event: "turn",
      recorded_at: isoNow(),
      session_id: row.thread_id,
      turn_id: `terminal:${completionCount}`,
      cwd: row.project?.root || row.cwd,
      project_id: row.project?.id || null,
      aos: row.project?.id === "automation-os",
      route_label: "codex_app_turn",
      status: "terminal_observed",
      automated: true,
      raw_prompt_stored: false,
      raw_transcript_stored: false,
      prompt_terms: [],
      business_completion: "unknown",
      same_run: false,
      readback_verified: false,
      evidence_count: row.projection.evidence.length,
      external_effect_state: row.projection.external_effect_state,
      source_handoff_status: row.source_handoff_state.source_status,
      outcome_id: outcomeId,
      outcome_receipt_path: outcomePath,
      outcome_content_sha256: outcome.content_sha256,
    });
    watermarks[row.thread_id] = {
      updated_at_ms: row.updated_at_ms,
      task_completed_count: completionCount,
    };
  }
  atomicWriteJson(statePath, {
    schema: "codex_hookless_turn_observer_state.v1",
    updated_at: isoNow(),
    bootstrap_without_historical_replay: true,
    watermarks,
  });
  return {
    enabled: true,
    bootstrapped: false,
    observed: candidates.length,
    outcome_receipts_created: outcomeReceiptsCreated,
    outcome_receipts_existing: outcomeReceiptsExisting,
    outcome_receipt_paths: outcomeReceiptPaths,
    events_path: eventsPath,
    outcomes_dir: outcomesDir,
  };
}

export function createAppServerClient({ binary, timeoutMs = 20_000, env = process.env } = {}) {
  if (!regularFile(binary, 1024 * 1024 * 1024)) throw new Error("codex_project_state_app_server_unavailable");
  const child = spawn(binary, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"], env: { ...env } });
  let buffer = "";
  let stderr = "";
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  const notifications = [];
  const notificationWaiters = new Set();
  const rejectAll = (error) => {
    for (const item of pending.values()) item.reject(error);
    pending.clear();
    for (const waiter of notificationWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    notificationWaiters.clear();
  };
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const item = pending.get(message.id);
      if (!item) {
        notifications.push(message);
        if (notifications.length > 100) notifications.shift();
        for (const waiter of [...notificationWaiters]) {
          if (!waiter.predicate(message)) continue;
          notificationWaiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
        continue;
      }
      pending.delete(message.id);
      if (message.error) {
        const detail = text(message.error.message, 500) || "unknown_protocol_error";
        item.reject(Object.assign(new Error(detail), { code: `codex_project_state_protocol_error:${item.method}` }));
      }
      else item.resolve(message.result);
    }
  });
  child.stderr.on("data", (chunk) => { stderr = text(`${stderr}${chunk}`, 2_000); });
  child.on("error", (error) => { closed = true; rejectAll(error); });
  child.on("close", () => { closed = true; rejectAll(new Error("codex_project_state_app_server_closed")); });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error("codex_project_state_app_server_closed")); return; }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`codex_project_state_protocol_timeout:${method}`));
    }, timeoutMs);
    pending.set(id, { method, resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const waitForNotification = (predicate, waitTimeoutMs) => new Promise((resolve, reject) => {
    const existing = notifications.find(predicate);
    if (existing) { resolve(existing); return; }
    if (closed) { reject(new Error("codex_project_state_app_server_closed")); return; }
    const waiter = { predicate, resolve, reject, timer: null };
    waiter.timer = setTimeout(() => {
      notificationWaiters.delete(waiter);
      reject(new Error("codex_hookless_handoff_turn_completion_timeout"));
    }, waitTimeoutMs);
    notificationWaiters.add(waiter);
  });
  return { request, waitForNotification, stderr: () => stderr, close: () => { if (!closed) child.kill("SIGTERM"); } };
}

function safeId(value) {
  const result = String(value || "").replace(/[^A-Za-z0-9._:-]/gu, "_").slice(0, 200);
  if (!result) throw new Error("codex_hookless_handoff_source_id_invalid");
  return result;
}

function refreshLedgerHash(ledger) {
  ledger.content_sha256 = sha256(stableJson({ ...ledger, generated_at: null, content_sha256: null }));
  return ledger.content_sha256;
}

async function readFormalGoal(client, threadId) {
  if (!client) return { state: "unavailable", exact_blocker: "codex_hookless_handoff_goal_reader_unavailable" };
  try {
    const response = await client.request("thread/goal/get", { threadId });
    const goal = response?.goal || null;
    if (!goal) return { state: "absent", objective: null, status: null, token_budget: null };
    const rawTokenBudget = goal.tokenBudget ?? goal.token_budget ?? null;
    const tokenBudget = rawTokenBudget === null || rawTokenBudget === undefined || rawTokenBudget === ""
      ? null
      : Number(rawTokenBudget);
    return {
      state: "present",
      objective: text(goal.objective, 2_000),
      status: text(goal.status, 80) || null,
      token_budget: Number.isFinite(tokenBudget) && tokenBudget > 0 ? tokenBudget : null,
    };
  } catch (error) {
    return {
      state: "unavailable",
      exact_blocker: text(error?.code || error?.message || "codex_hookless_handoff_goal_read_failed", 300),
    };
  }
}

function packetForRow(row, formalGoal, createdAt = isoNow()) {
  const explicitAcceptance = row.projection.acceptance_criteria || [];
  const packet = {
    schema: HANDOFF_PACKET_SCHEMA,
    created_at: createdAt,
    source_thread_id: row.thread_id,
    source_turn_id: row.source?.latest_turn_id || row.source?.turn_id || null,
    source_cwd: row.cwd,
    source_title: row.title,
    source_app_project_id: row.app_project_id,
    source_task_retention: "keep_visible_never_archive",
    source_continuation_contract: {
      before_destination_claim: "normal_or_reconciliation_only",
      after_destination_claim: "reconciliation_only",
      after_destination_ready: "handoff_completed",
      implementation_allowed_after_destination_claim: false,
      source_archive_allowed: false,
      source_visibility_required: true,
    },
    project: row.project,
    trigger: {
      kind: "long_or_context_degraded_at_safe_boundary",
      reasons: row.handoff.triggers,
      context_pressure_ratio: row.runtime.context_pressure_ratio,
      rollout_size_bytes: row.source.rollout_size_bytes,
      tokens_used: Math.max(row.tokens_used || 0, row.runtime.latest_total_tokens || 0),
    },
    task_objective: row.projection.objective,
    acceptance_criteria: explicitAcceptance.length ? explicitAcceptance : [
      "Fresh-read every authoritative source and preserve the complete plan statuses before continuing.",
      "Execute only the packet's single next action and do not replay an ambiguous or completed external effect.",
    ],
    acceptance_criteria_source: explicitAcceptance.length ? "source_projection" : "handoff_safety_contract",
    scope: row.projection.scope,
    non_goals: row.projection.non_goals,
    formal_goal: formalGoal,
    current_state: row.projection.current_state_summary,
    plan_complete: row.projection.plan_complete,
    plan_snapshot: row.projection.plan.steps,
    plan_source: row.projection.plan.source,
    plan_status_counts: row.projection.status_counts,
    decision_log: row.projection.decisions,
    completed_work: row.projection.completed,
    unfinished_work: row.projection.unfinished,
    exact_blockers: row.projection.blockers,
    unknowns: unique([
      ...row.projection.unknowns,
      ...(formalGoal.state === "unavailable" ? [formalGoal.exact_blocker] : []),
    ], 40),
    authoritative_sources: row.authority_snapshot.map((item) => ({ path: item.path, sha256: item.sha256, modified_at: item.modified_at })),
    evidence: row.projection.evidence,
    external_effect_ledger: [{
      state: row.projection.external_effect_state,
      replay_allowed: false,
      reconciliation_required: row.handoff.execution_requires_reconciliation,
    }],
    next_action: row.projection.next_action,
    stop_condition: row.projection.stop_condition,
    target_mode: "start",
    destination_contract: {
      creation_method: "thread/start",
      target_mode: "start",
      history_mode: "historyless",
      inherited_turns_allowed: 0,
      fork_allowed: false,
      source_archive_allowed: false,
      source_goal_completion_allowed: false,
      source_execution_after_claim: "handoff_stopped",
      fresh_authority_read_required: true,
      goal_readback_required_when_present: true,
      exactly_one_destination: true,
      browser_route_bootstrap: {
        selector_path: WEB_OPERATION_BACKEND_SELECTOR_PATH,
        route_authority: "adaptive_two_extension_resolver",
        selector_backend_role: "preferred_backend_not_final_route",
        decision_scope: "browser_stage",
        read_before_browser_skill_or_preflight: true,
        nested_chrome_profile_surface_role: "profile_metadata_only_not_route_authority",
        decision_precedence: [
          "explicit_user_or_workflow_requirement",
          "active_run_or_owned_tab_continuity",
          "official_surface_or_proof_requirement",
          "effectful_workflow_adapter_availability",
          "companion_for_normal_new_browser_stage",
        ],
        stage_rules: {
          normal_or_read_only: "aos_chrome_companion",
          official_surface_or_proof: "chrome_plugin",
          registered_effect: "use_immutable_aos_browser_route_decision_v2",
          missing_effectful_adapter: "block_before_dispatch",
        },
        preserve_active_run_backend: true,
        post_dispatch_fallback_allowed: false,
        reroute_after_terminal_no_effect_only: true,
      },
    },
  };
  packet.execution_eligible = formalGoal.state !== "unavailable"
    && packet.plan_snapshot.length > 0
    && packet.unfinished_work.length > 0
    && !row.handoff.execution_requires_reconciliation;
  packet.execution_blockers = unique([
    ...(formalGoal.state === "unavailable" ? [formalGoal.exact_blocker] : []),
    ...(packet.plan_snapshot.length === 0 ? ["codex_hookless_handoff_plan_missing"] : []),
    ...(row.handoff.execution_requires_reconciliation ? ["codex_hookless_handoff_external_effect_reconciliation_required"] : []),
  ], 20);
  packet.content_sha256 = sha256(stableJson({ ...packet, content_sha256: null }));
  return packet;
}

export async function prepareHandoffPackets(policy, ledger, {
  client: injectedClient = null,
  binary = policy.app_server_binary || "/Applications/ChatGPT.app/Contents/Resources/codex",
} = {}) {
  const candidatePool = ledger.threads.filter((row) => row.handoff.eligible);
  const candidates = candidatePool.slice(0, policy.handoff.candidate_scan_limit);
  if (!policy.handoff.enabled || policy.handoff.mode === "disabled" || !candidates.length) {
    return {
      candidate_pool: candidatePool.length,
      attempted: 0,
      prepared: 0,
      execution_eligible: 0,
      skipped_execution_ineligible: 0,
      packets: [],
    };
  }
  let client = injectedClient;
  let ownsClient = false;
  if (policy.handoff.read_formal_goal && !client) {
    try {
      client = createAppServerClient({ binary: canonical(binary) });
      ownsClient = true;
      await client.request("initialize", {
        clientInfo: { name: "codex-hookless-handoff", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      });
    } catch {
      if (client && ownsClient) client.close();
      client = null;
      ownsClient = false;
    }
  }
  const packets = [];
  let attempted = 0;
  let executionEligible = 0;
  let skippedExecutionIneligible = 0;
  try {
    for (const row of candidates) {
      if (executionEligible >= policy.handoff.max_per_run) break;
      attempted += 1;
      const formalGoal = policy.handoff.read_formal_goal
        ? await readFormalGoal(client, row.thread_id)
        : { state: "not_requested", objective: null, status: null, token_budget: null };
      const packet = packetForRow(row, formalGoal);
      const directory = path.join(policy.output_dir, "handoff-packets", safeId(row.thread_id));
      const packetPath = path.join(directory, `${packet.content_sha256}.json`);
      try {
        atomicWriteJsonNoReplace(packetPath, packet);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const existing = readJson(packetPath, null);
        if (existing?.schema !== HANDOFF_PACKET_SCHEMA || existing?.content_sha256 !== packet.content_sha256) {
          throw new Error("codex_hookless_handoff_packet_collision");
        }
      }
      row.handoff.packet_path = packetPath;
      row.handoff.packet_content_sha256 = packet.content_sha256;
      row.handoff.prepared = true;
      row.handoff.execution_eligible = packet.execution_eligible;
      row.handoff.execution_blockers = packet.execution_blockers;
      if (packet.execution_eligible) executionEligible += 1;
      else skippedExecutionIneligible += 1;
      packets.push({
        source_thread_id: row.thread_id,
        packet_path: packetPath,
        content_sha256: packet.content_sha256,
        execution_eligible: packet.execution_eligible,
        execution_blockers: packet.execution_blockers,
      });
    }
  } finally {
    if (client && ownsClient) client.close();
  }
  refreshLedgerHash(ledger);
  return {
    candidate_pool: candidatePool.length,
    attempted,
    prepared: packets.length,
    execution_eligible: executionEligible,
    skipped_execution_ineligible: skippedExecutionIneligible,
    packets,
  };
}

function validatePacket(policy, packetPath) {
  const resolved = canonical(packetPath);
  const packetRoot = canonical(path.join(policy.output_dir, "handoff-packets"));
  if (!isPathInside(resolved, packetRoot) || !regularFile(resolved, 2 * 1024 * 1024)) {
    throw new Error("codex_hookless_handoff_packet_invalid");
  }
  const packet = readJson(resolved, null);
  if (packet?.schema !== HANDOFF_PACKET_SCHEMA) throw new Error("codex_hookless_handoff_packet_schema_invalid");
  const expected = sha256(stableJson({ ...packet, content_sha256: null }));
  if (packet.content_sha256 !== expected) throw new Error("codex_hookless_handoff_packet_hash_mismatch");
  return { path: resolved, packet };
}

function continuationPrompt(packetPath, packet) {
  return [
    "これはフックを使わない履歴なし引き継ぎです。",
    `最初に引き継ぎpacketをfresh-readしてください: ${packetPath}`,
    "次にpacket内のauthoritative_sourcesとevidenceをfresh-readし、formal_goalがpresentならget_goal相当のreadbackを照合してください。",
    "Planの全step/status、decisions、completed/unfinished、blockers、external-effect stateを維持し、勝手に完了や再実行を推測しないでください。",
    "ブラウザが必要な時だけ選択済みsurfaceを使い、dispatch後は同じstageを維持してください。",
    `唯一の次アクション: ${packet.next_action}`,
    `停止条件: ${packet.stop_condition}`,
  ].join("\n");
}

function goalMatches(expected, actual) {
  if (expected.state !== "present") return actual == null;
  return actual
    && text(actual.objective, 2_000) === expected.objective
    && text(actual.status, 80) === expected.status
    && Number(actual.tokenBudget ?? 0) === Number(expected.token_budget ?? 0);
}

async function verifySourceGoalForHandoff(client, packet) {
  const expected = packet.formal_goal;
  if (expected?.state !== "present") {
    return { status: "not_applicable", method: "thread/goal/get", readback: null, goal_preserved: true };
  }
  const readbackResponse = await client.request("thread/goal/get", { threadId: packet.source_thread_id });
  const goal = readbackResponse?.goal || null;
  const readback = goal
    ? {
        objective: text(goal.objective, 2_000),
        status: text(goal.status, 80) || null,
        token_budget: Number.isFinite(Number(goal.tokenBudget ?? goal.token_budget))
          ? Number(goal.tokenBudget ?? goal.token_budget)
          : null,
      }
    : null;
  if (!readback || readback.status === "complete" || readback.status !== expected.status
    || readback.objective !== expected.objective || readback.token_budget !== expected.token_budget) {
    throw new Error("codex_hookless_handoff_source_goal_readback_mismatch");
  }
  return {
    status: "verified",
    method: "thread/goal/get",
    requested_status: expected.status,
    readback,
    goal_preserved: true,
  };
}

function activeTurnForHandoffStop(thread, preferredTurnId = "") {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const isActive = (turn) => ["inProgress", "active", "running"].includes(turn?.status?.type || turn?.status);
  return turns.find((turn) => preferredTurnId && turn?.id === preferredTurnId && isActive(turn))
    || turns.find((turn) => isActive(turn));
}

async function interruptSourceTurnForHandoff(client, packet) {
  if (!packet.source_turn_id) {
    return { status: "not_requested", method: "source_gate_only", turn_id: null };
  }
  const beforeResponse = await client.request("thread/read", { threadId: packet.source_thread_id });
  const before = beforeResponse?.thread || null;
  const activeTurn = activeTurnForHandoffStop(before, packet.source_turn_id || "");
  if (!activeTurn?.id) {
    return { status: "already_idle", method: "thread/read", turn_id: packet.source_turn_id || null };
  }
  await client.request("turn/interrupt", { threadId: packet.source_thread_id, turnId: activeTurn.id });
  const afterResponse = await client.request("thread/read", { threadId: packet.source_thread_id });
  if (activeTurnForHandoffStop(afterResponse?.thread, activeTurn.id)) {
    throw new Error("codex_hookless_handoff_source_turn_stop_readback_missing");
  }
  return { status: "interrupted", method: "turn/interrupt", turn_id: activeTurn.id };
}

async function readThreadWithBoundedRetry(client, threadId) {
  let lastError = null;
  for (const delayMs of [0, 100, 250]) {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const response = await client.request("thread/read", { threadId });
      const thread = response?.thread;
      if (!thread || thread.historyMode !== "paginated"
        || (Array.isArray(thread.turns) && thread.turns.length > 0)) return response;
      try {
        const turnsResponse = await client.request("thread/turns/list", { threadId, limit: 100 });
        const turns = Array.isArray(turnsResponse?.data)
          ? turnsResponse.data
          : Array.isArray(turnsResponse?.turns)
            ? turnsResponse.turns
            : [];
        return { ...response, thread: { ...thread, turns } };
      } catch (error) {
        const message = String(error?.message || "");
        if (/not supported|unavailable before first user message/i.test(message)) return response;
        throw error;
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("codex_hookless_handoff_destination_readback_failed");
}

export async function reconcilePendingHandoffs(policy, {
  execute = executePreparedHandoff,
} = {}) {
  const result = { attempted: 0, completed: 0, receipts: [] };
  if (!policy.handoff.automatic_thread_creation || policy.handoff.mode !== "automatic") return result;
  const receiptsDir = path.join(policy.output_dir, "handoff-receipts");
  let names;
  try {
    names = fs.readdirSync(receiptsDir).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error?.code === "ENOENT") return result;
    throw error;
  }
  for (const name of names.slice(0, policy.handoff.candidate_scan_limit)) {
    if (result.attempted >= policy.handoff.max_per_run) break;
    const receiptPath = path.join(receiptsDir, name);
    let stat;
    try { stat = fs.lstatSync(receiptPath); } catch { continue; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > policy.max_authority_file_bytes) continue;
    const receipt = readJson(receiptPath, null);
    if (receipt?.schema !== HANDOFF_RECEIPT_SCHEMA
      || receipt.status !== "reconciliation_required"
      || receipt.implementation_allowed !== false
      || !receipt.destination_thread_id
      || !receipt.packet_path) continue;
    result.attempted += 1;
    const next = await execute(policy, receipt.packet_path);
    result.receipts.push(next);
    if (next?.status === "completed") result.completed += 1;
  }
  return result;
}

export async function executePreparedHandoff(policy, packetPath, {
  client: injectedClient = null,
  binary = policy.app_server_binary || "/Applications/ChatGPT.app/Contents/Resources/codex",
} = {}) {
  if (!policy.handoff.automatic_thread_creation || policy.handoff.mode !== "automatic") {
    throw new Error("codex_hookless_handoff_automatic_creation_disabled");
  }
  const { path: resolvedPacketPath, packet } = validatePacket(policy, packetPath);
  if ((packet.target_mode || packet.destination_contract?.target_mode || "start") !== "start") {
    throw new Error("codex_hookless_handoff_explicit_fork_requires_legacy_path");
  }
  if (!packet.execution_eligible) throw new Error(packet.execution_blockers?.[0] || "codex_hookless_handoff_packet_not_execution_eligible");
  if (policy.handoff.protected_thread_ids.includes(packet.source_thread_id)) throw new Error("codex_hookless_handoff_protected_thread");
  let client = injectedClient;
  let ownsClient = false;
  if (!client) {
    client = createAppServerClient({ binary: canonical(binary) });
    ownsClient = true;
    try {
      await client.request("initialize", {
        clientInfo: { name: "codex-hookless-handoff", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      });
    } catch (error) {
      client.close();
      throw error;
    }
  }
  const claimPath = path.join(policy.output_dir, "handoff-claims", `${safeId(packet.source_thread_id)}.json`);
  const receiptPath = path.join(policy.output_dir, "handoff-receipts", `${safeId(packet.source_thread_id)}.json`);
  const previousClaim = readJson(claimPath, null);
  const previousReceipt = readJson(receiptPath, null);
  if (previousClaim && !previousClaim.destination_thread_id) {
    const sourceGoalCloseRequired = packet.formal_goal?.state === "present";
    const reconciliationReceipt = {
      ...(previousReceipt || {}),
      schema: HANDOFF_RECEIPT_SCHEMA,
      status: "reconciliation_required",
      source_status: "reconciliation_only",
      implementation_allowed: false,
      source_thread_id: packet.source_thread_id,
      destination_thread_id: null,
      packet_path: resolvedPacketPath,
      packet_content_sha256: packet.content_sha256,
      source_task_archived: false,
      source_task_visible: true,
      source_execution: "stopping",
      next_action: packet.next_action,
      source_goal_close_required: sourceGoalCloseRequired,
      source_goal_close: previousReceipt?.source_goal_close
        || (sourceGoalCloseRequired ? null : { status: "not_applicable", method: "thread/goal/get", readback: null, goal_preserved: true }),
    };
    try {
      previousClaim.source_goal_stop_state = "dispatched";
      atomicWriteJson(claimPath, previousClaim);
      atomicWriteJson(receiptPath, reconciliationReceipt);
      reconciliationReceipt.source_goal_close = await verifySourceGoalForHandoff(client, packet);
      reconciliationReceipt.source_turn_stop = await interruptSourceTurnForHandoff(client, packet);
      reconciliationReceipt.source_execution = "handoff_stopped";
      reconciliationReceipt.source_goal_stopped = true;
      reconciliationReceipt.source_goal_status = reconciliationReceipt.source_goal_close.readback?.status || null;
      reconciliationReceipt.source_goal_stopped_at = isoNow();
      previousClaim.source_goal_stop_state = "completed";
      atomicWriteJson(claimPath, previousClaim);
    } catch (error) {
      reconciliationReceipt.exact_blocker = text(error?.code || error?.message || "codex_hookless_handoff_source_stop_failed", 300);
    }
    atomicWriteJson(receiptPath, reconciliationReceipt);
    if (ownsClient) client.close();
    return {
      ...reconciliationReceipt,
      exact_blocker: reconciliationReceipt.exact_blocker || previousReceipt?.exact_blocker || "codex_hookless_handoff_thread_start_effect_unknown",
    };
  }
  const claim = previousClaim || {
    schema: "codex_hookless_handoff_claim.v1",
    created_at: isoNow(),
    source_thread_id: packet.source_thread_id,
    packet_path: resolvedPacketPath,
    packet_content_sha256: packet.content_sha256,
    state: "claimed",
    destination_thread_id: null,
  };
  if (!previousClaim) atomicWriteJsonNoReplace(claimPath, claim);
  const receipt = {
    schema: HANDOFF_RECEIPT_SCHEMA,
    created_at: previousReceipt?.created_at || isoNow(),
    status: "reconciliation_required",
    source_status: "active",
    implementation_allowed: true,
    source_thread_id: packet.source_thread_id,
    destination_thread_id: previousClaim?.destination_thread_id || null,
    packet_path: resolvedPacketPath,
    packet_content_sha256: packet.content_sha256,
    source_task_archived: false,
    source_task_visible: true,
    source_execution: "running",
    next_action: packet.next_action,
    historyless_verified: Boolean(previousReceipt?.historyless_verified),
    goal_verified: Boolean(previousReceipt?.goal_verified),
    continuation_dispatched: Boolean(previousReceipt?.continuation_dispatched),
    continuation_turn_id: text(previousReceipt?.continuation_turn_id, 200) || null,
    continuation_status: text(previousReceipt?.continuation_status, 80) || null,
    retry_empty_interrupted_turn_authorized: previousReceipt?.retry_empty_interrupted_turn_authorized === true,
    destination_ready: false,
    source_goal_close_required: packet.formal_goal?.state === "present",
    source_goal_close: previousReceipt?.source_goal_close
      || (packet.formal_goal?.state === "present" ? null : { status: "not_applicable", method: "thread/goal/get", readback: null, goal_preserved: true }),
    source_goal_stopped: previousReceipt?.source_goal_stopped === true,
    source_goal_stopped_at: previousReceipt?.source_goal_stopped_at || null,
    exact_blocker: null,
  };
  try {
    receipt.source_status = "reconciliation_only";
    receipt.implementation_allowed = false;
    receipt.source_goal_stop_requested_at = isoNow();
    claim.source_goal_stop_state = "dispatched";
    if (claim.state === "claimed") claim.state = "source_goal_stop_dispatched";
    atomicWriteJson(claimPath, claim);
    atomicWriteJson(receiptPath, receipt);
    receipt.source_goal_close = await verifySourceGoalForHandoff(client, packet);
    receipt.source_turn_stop = await interruptSourceTurnForHandoff(client, packet);
    receipt.source_execution = "handoff_stopped";
    receipt.source_goal_stopped = true;
    receipt.source_goal_status = receipt.source_goal_close.readback?.status || null;
    receipt.source_goal_stopped_at = isoNow();
    claim.source_goal_stop_state = "completed";
    atomicWriteJson(claimPath, claim);
    atomicWriteJson(receiptPath, receipt);
    let destinationId = text(claim.destination_thread_id, 200);
    if (!destinationId) {
      claim.state = "thread_start_dispatched";
      atomicWriteJson(claimPath, claim);
      const started = await client.request("thread/start", {
        cwd: packet.source_cwd,
        projectId: packet.source_app_project_id || null,
        historyMode: "paginated",
        ephemeral: false,
        threadSource: "agent_created_thread",
      });
      destinationId = text(started?.thread?.id || started?.threadId, 200);
      if (!destinationId) throw new Error("codex_hookless_handoff_destination_id_missing");
      claim.destination_thread_id = destinationId;
      claim.state = "destination_created";
      receipt.destination_thread_id = destinationId;
      receipt.source_status = "reconciliation_only";
      receipt.implementation_allowed = false;
      atomicWriteJson(claimPath, claim);
      atomicWriteJson(receiptPath, receipt);
    } else {
      receipt.source_status = "reconciliation_only";
      receipt.implementation_allowed = false;
      atomicWriteJson(receiptPath, receipt);
      await client.request("thread/resume", {
        threadId: destinationId,
        cwd: packet.source_cwd,
        excludeTurns: true,
      });
    }
    const emptyReadback = await readThreadWithBoundedRetry(client, destinationId);
    const inheritedTurns = emptyReadback?.thread?.turns || [];
    if (inheritedTurns.length !== 0 && !receipt.continuation_dispatched) {
      throw new Error("codex_hookless_handoff_destination_not_empty_reconciliation_required");
    }
    const existingContinuation = receipt.continuation_turn_id
      ? inheritedTurns.find((item) => item?.id === receipt.continuation_turn_id)
      : null;
    if (receipt.continuation_dispatched && !receipt.continuation_turn_id) {
      throw new Error("codex_hookless_handoff_legacy_continuation_readback_required");
    }
    if (receipt.continuation_dispatched && !existingContinuation) {
      throw new Error("codex_hookless_handoff_continuation_turn_missing");
    }
    if (existingContinuation?.status === "interrupted"
      && (existingContinuation.items || []).length === 0
      && receipt.retry_empty_interrupted_turn_authorized) {
      receipt.prior_interrupted_turn_id = receipt.continuation_turn_id;
      receipt.continuation_dispatched = false;
      receipt.continuation_turn_id = null;
      receipt.continuation_status = null;
      receipt.retry_empty_interrupted_turn_authorized = false;
    } else if (["failed", "interrupted"].includes(existingContinuation?.status)) {
      throw new Error(`codex_hookless_handoff_continuation_${existingContinuation.status}`);
    }
    if (existingContinuation?.status === "completed") receipt.continuation_status = "completed";
    receipt.historyless_verified = true;
    await client.request("thread/name/set", {
      threadId: destinationId,
      name: text(`${packet.source_title || packet.project?.label || "作業"} ${policy.handoff.title_suffix}`, 200),
    });
    if (packet.formal_goal.state === "present") {
      const goalParams = {
        threadId: destinationId,
        objective: packet.formal_goal.objective,
        status: packet.formal_goal.status,
      };
      if (Number.isFinite(Number(packet.formal_goal.token_budget)) && Number(packet.formal_goal.token_budget) > 0) {
        goalParams.tokenBudget = Number(packet.formal_goal.token_budget);
      }
      await client.request("thread/goal/set", goalParams);
    }
    const goalReadback = await client.request("thread/goal/get", { threadId: destinationId });
    if (!goalMatches(packet.formal_goal, goalReadback?.goal || null)) throw new Error("codex_hookless_handoff_goal_readback_mismatch");
    receipt.goal_verified = true;
    let pendingTurnId = null;
    if (!receipt.continuation_dispatched) {
      const turn = await client.request("turn/start", {
        threadId: destinationId,
        cwd: packet.source_cwd,
        input: [{ type: "text", text: continuationPrompt(resolvedPacketPath, packet), text_elements: [] }],
      });
      const turnId = text(turn?.turn?.id || turn?.turnId, 200);
      if (!turnId) throw new Error("codex_hookless_handoff_continuation_receipt_missing");
      receipt.continuation_dispatched = true;
      receipt.continuation_turn_id = turnId;
      pendingTurnId = turnId;
      claim.state = "continuation_dispatched";
      atomicWriteJson(claimPath, claim);
      atomicWriteJson(receiptPath, receipt);
    } else if (existingContinuation?.status === "inProgress") {
      pendingTurnId = receipt.continuation_turn_id;
    }
    if (pendingTurnId) {
      const completion = typeof client.waitForNotification === "function"
        ? await client.waitForNotification(
            (message) => message?.method === "turn/completed"
              && message?.params?.threadId === destinationId
              && message?.params?.turn?.id === pendingTurnId,
            policy.handoff.turn_completion_timeout_ms,
          )
        : { params: { turn: { id: pendingTurnId, status: "completed" } } };
      receipt.continuation_status = text(completion?.params?.turn?.status, 80);
      if (receipt.continuation_status !== "completed") {
        throw new Error(`codex_hookless_handoff_continuation_${receipt.continuation_status || "unknown"}`);
      }
    }
    receipt.destination_ready = true;
    receipt.status = "completed";
    receipt.source_status = "handoff_completed";
    receipt.source_execution = "handoff_stopped";
    receipt.source_goal_stopped = true;
    receipt.implementation_allowed = false;
    claim.state = "completed";
    atomicWriteJson(claimPath, claim);
  } catch (error) {
    if (claim.state !== "claimed" || receipt.source_status !== "active" || receipt.source_goal_stop_requested_at) {
      receipt.source_status = "reconciliation_only";
      receipt.source_execution = receipt.source_goal_stop_requested_at ? "handoff_stopped" : "stopping";
      receipt.implementation_allowed = false;
    }
    receipt.exact_blocker = text(error?.code || error?.message || "codex_hookless_handoff_failed", 300);
  } finally {
    if (client && ownsClient) client.close();
    atomicWriteJson(receiptPath, receipt);
  }
  return receipt;
}

export function acquireLock(file, staleMs = 15 * 60_000) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    const descriptor = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, created_at: isoNow() }));
    fs.closeSync(descriptor);
    return () => { try { fs.unlinkSync(file); } catch {} };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs <= staleMs) throw new Error("codex_project_state_sync_already_running");
    fs.unlinkSync(file);
    return acquireLock(file, staleMs);
  }
}

export function ledgerPaths(policy) {
  return {
    ledger: path.join(policy.output_dir, "ledger.v1.json"),
    lock: path.join(policy.output_dir, ".sync.lock"),
    status: path.join(policy.output_dir, "status.v1.json"),
  };
}

export function writeLedger(policy, ledger) {
  const paths = ledgerPaths(policy);
  atomicWriteJson(paths.ledger, ledger);
  return paths.ledger;
}

export function writeStatus(policy, value) {
  const paths = ledgerPaths(policy);
  atomicWriteJson(paths.status, { schema: "codex_project_state_sync_status.v1", updated_at: isoNow(), ...value });
  return paths.status;
}

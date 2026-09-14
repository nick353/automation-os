import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const projectionModuleUrl = new URL("./thread-readback-projection.mjs", import.meta.url);
projectionModuleUrl.search = new URL(import.meta.url).search;
const {
  createThreadAlias,
  createThreadReadbackProjection,
  normalizeOfficialThreadReadback,
} = await import(projectionModuleUrl.href);
const dispatchModuleUrl = new URL("./hourly-thread-dispatch.mjs", import.meta.url);
dispatchModuleUrl.search = new URL(import.meta.url).search;
const { normalizeConfirmedDeliveryProof } = await import(dispatchModuleUrl.href);

export const CODEX_APP_SERVER_BINARY = "/Applications/ChatGPT.app/Contents/Resources/codex";
export const COMPANION_BRIDGE_SCHEMA = "aos.codex_app_server_companion_bridge.v1";
export const MAX_THREAD_RECORDS = 256;
export const MAX_DEEP_READS = 128;
export const MAX_LIST_PAGES = 8;
export const CONTINUATION_WORKER_PATH = "/Users/nichikatanaka/Documents/Codex/automation-os/scripts/lib/codex-app-server-continuation-worker.mjs";
export const CONTINUATION_WORKER_ROOT = "/Users/nichikatanaka/.codex/automations/aos-companion-2/continuation-workers";
const MAX_DEEP_READ_CONCURRENCY = 5;
const MAX_WORKER_JOB_BYTES = 256 * 1024;

const USER_SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "unknown"];
const TASK_STATUS = new Set(["active", "idle", "notLoaded", "completed", "blocked", "failed", "interrupted", "unknown"]);

function exactError(code, details = {}) {
  const error = new Error(code);
  error.exact_blocker = code;
  error.details = details;
  return error;
}

function cleanText(value, max = 240) {
  const result = String(value ?? "")
    .replace(/[\u0000\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return result ? result.slice(0, max) : null;
}

function privateWriteNoReplace(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
  return file;
}

function markPreDispatchNoEffect(error) {
  if (error && typeof error === "object") {
    error.preDispatchNoEffect = true;
    error.pre_dispatch_no_effect = true;
    return error;
  }
  const wrapped = new Error(String(error ?? "continuation_worker_launch_failed"));
  wrapped.preDispatchNoEffect = true;
  wrapped.pre_dispatch_no_effect = true;
  return wrapped;
}

function readPrivateJson(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_WORKER_JOB_BYTES) return null;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function workerResultFor(root, jobId) {
  const id = cleanText(jobId, 200);
  if (!id) return null;
  return readPrivateJson(path.join(root, `${id}.result.json`));
}

function workerResultPreDispatchNoEffect(result) {
  if (!result || typeof result !== "object") return false;
  if (result.preDispatchNoEffect === true || result.pre_dispatch_no_effect === true) return true;
  return result.status === "failed"
    && !String(result.turnId || result.turn_id || "").trim()
    && String(result.exactBlocker || result.exact_blocker || "") === "codex_app_server_protocol_error:thread/resume";
}

function workerJobForKey(root, idempotencyKey) {
  const key = cleanText(idempotencyKey, 200);
  if (!key) return null;
  let names;
  try { names = fs.readdirSync(root).filter((name) => name.endsWith(".job.json")); }
  catch { return null; }
  for (const name of names.sort().reverse()) {
    const job = readPrivateJson(path.join(root, name));
    if (job?.idempotencyKey === key) return job;
  }
  return null;
}

function launchContinuationWorker({
  workerPath = CONTINUATION_WORKER_PATH,
  workerRoot = CONTINUATION_WORKER_ROOT,
  launcher = null,
  threadId,
  cwd,
  prompt,
  idempotencyKey,
  beforeTurnId = null,
  timeoutMs = 180_000,
} = {}) {
  const jobId = `continuation-${Date.now()}-${crypto.randomUUID().slice(0, 12)}`;
  const jobPath = path.join(workerRoot, `${jobId}.job.json`);
  const resultPath = path.join(workerRoot, `${jobId}.result.json`);
  const job = {
    schema: "aos.codex_app_server_continuation_job.v1",
    jobId,
    threadId,
    cwd: typeof cwd === "string" && cwd.trim() ? cwd.trim() : null,
    prompt,
    idempotencyKey,
    beforeTurnId: cleanText(beforeTurnId, 200) || null,
    resultPath,
    timeoutMs,
    createdAt: new Date().toISOString(),
  };
  try {
    privateWriteNoReplace(jobPath, job);
  } catch (error) {
    throw markPreDispatchNoEffect(error);
  }
  if (typeof launcher === "function") {
    const launched = launcher({ job, jobPath, resultPath });
    return { ...job, launched, jobPath, resultPath };
  }
  const currentProcess = globalThis.process;
  const nodeBinary = typeof currentProcess?.execPath === "string" && currentProcess.execPath.startsWith("/")
    ? currentProcess.execPath
    : "/usr/local/bin/node";
  let child;
  try {
    child = spawn(nodeBinary, [workerPath, "--job", jobPath], {
      detached: true,
      stdio: "ignore",
    });
  } catch (error) {
    throw markPreDispatchNoEffect(error);
  }
  child.unref();
  return { ...job, launched: true, jobPath, resultPath, pid: child.pid ?? null };
}

function statusType(value, fallback = "unknown") {
  const raw = typeof value === "object" && value !== null
    ? value.type ?? value.status ?? value.state
    : value;
  const normalized = String(raw ?? "").trim().replaceAll("-", "_").toLowerCase();
  const aliases = {
    active: "active",
    running: "active",
    in_progress: "active",
    idle: "idle",
    waiting: "idle",
    notloaded: "notLoaded",
    not_loaded: "notLoaded",
    unloaded: "notLoaded",
    completed: "completed",
    complete: "completed",
    done: "completed",
    closed: "completed",
    blocked: "blocked",
    failed: "failed",
    error: "failed",
    systemerror: "failed",
    interrupted: "interrupted",
    cancelled: "failed",
    canceled: "failed",
  };
  return TASK_STATUS.has(aliases[normalized] ?? normalized) ? aliases[normalized] ?? normalized : fallback;
}

function turnStatus(value) {
  const raw = typeof value === "object" && value !== null
    ? value.type ?? value.status ?? value.state
    : value;
  const normalized = String(raw ?? "").trim().replaceAll("-", "_").toLowerCase();
  return {
    in_progress: "inProgress",
    inprogress: "inProgress",
    running: "inProgress",
    executing: "inProgress",
    completed: "completed",
    complete: "completed",
    done: "completed",
    succeeded: "completed",
    failed: "failed",
    error: "failed",
    interrupted: "interrupted",
    aborted: "interrupted",
  }[normalized] ?? "unknown";
}

function isActiveWriterError(error) {
  const message = String(error?.details?.message ?? error?.message ?? error?.error?.message ?? "");
  return /already has an active writer|active writer already exists|thread is busy/iu.test(message);
}

/**
 * The App Server can briefly project a live task as `notLoaded` while its
 * newest turn is already running.  Treat the turn as authoritative for the
 * message boundary so a scheduled callback never tries to resume a busy
 * task.
 */
export function classifyThreadExecutionBoundary(response = {}) {
  const thread = response?.thread ?? response ?? {};
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const taskStatus = statusType(thread?.status);
  const latestTurnStatus = turnStatus(turns[0]?.status);
  const active = taskStatus === "active" || latestTurnStatus === "inProgress";
  return {
    taskStatus,
    latestTurnStatus,
    active,
    exactBlocker: active ? "codex_app_thread_active_boundary_required" : null,
  };
}

function isoFromUnixSeconds(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? new Date(numeric * 1_000).toISOString() : cleanText(value, 80);
}

function sourceIsAgent(thread) {
  const source = thread?.source;
  return Boolean(thread?.parentThreadId
    || thread?.agentRole
    || thread?.agentNickname
    || (source && typeof source === "object" && Object.prototype.hasOwnProperty.call(source, "subAgent")));
}

function listState(thread) {
  const taskStatus = statusType(thread?.status);
  return {
    taskStatus,
    latestTurnStatus: "unknown",
    goalStatus: "unknown",
    planStatus: "unknown",
    owner: "user",
    userOwned: true,
    actionable: taskStatus === "blocked" || taskStatus === "failed",
    stalled: null,
    changed: null,
    revision: cleanText(thread?.updatedAt, 160),
    updatedAt: isoFromUnixSeconds(thread?.updatedAt),
    generation: null,
    exactBlocker: taskStatus === "failed" ? "codex_app_thread_status_failed" : null,
    softAnomalyTypes: [],
  };
}

function deepState(thread, fallback) {
  const normalized = normalizeOfficialThreadReadback(thread, { fallbackState: fallback });
  if (normalized.status !== "observed") throw exactError("codex_app_thread_readback_shape_unrecognized");
  return {
    taskStatus: normalized.taskStatus,
    latestTurnStatus: normalized.latestTurnStatus,
    goalStatus: normalized.goalStatus,
    planStatus: normalized.planStatus,
    userOwned: true,
    owner: "user",
    actionable: fallback.actionable,
    stalled: fallback.stalled,
    changed: fallback.changed,
    revision: normalized.revision,
    updatedAt: normalized.updatedAt,
    generation: normalized.generation,
    exactBlocker: normalized.exactBlocker,
    softAnomalyTypes: normalized.softAnomalyTypes,
  };
}

function protocolClient({ binary = CODEX_APP_SERVER_BINARY, timeoutMs = 30_000, env = null } = {}) {
  if (typeof binary !== "string" || !binary.startsWith("/")) throw exactError("codex_app_server_binary_invalid");
  const child = spawn(binary, ["app-server", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    ...(env && typeof env === "object" ? { env: { ...env } } : {}),
  });
  let buffer = "";
  let stderr = "";
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  const notifications = [];

  const rejectAll = (error) => {
    for (const item of pending.values()) item.reject(error);
    pending.clear();
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
      if (message.id !== undefined && pending.has(message.id)) {
        const item = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          const error = exactError(`codex_app_server_protocol_error:${item.method}`, {
            message: cleanText(message.error.message, 300),
          });
          item.reject(error);
        } else item.resolve(message.result);
      } else {
        notifications.push(message);
        if (notifications.length > 100) notifications.shift();
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-2_000);
  });
  child.on("error", (error) => {
    closed = true;
    rejectAll(error);
  });
  child.on("close", () => {
    closed = true;
    rejectAll(exactError("codex_app_server_closed"));
  });

  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (closed) {
      reject(exactError("codex_app_server_closed"));
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(exactError(`codex_app_server_timeout:${method}`));
    }, timeoutMs);
    pending.set(id, {
      method,
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

  const notify = (method, params = {}) => {
    if (closed) throw exactError("codex_app_server_closed");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  };

  const waitForNotification = async (predicate, waitTimeoutMs = 15_000) => {
    const existing = notifications.find(predicate);
    if (existing) return existing;
    const deadline = Date.now() + waitTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
      const next = notifications.find(predicate);
      if (next) return next;
    }
    throw exactError("codex_app_server_notification_timeout");
  };

  return {
    request,
    notify,
    waitForNotification,
    stderr: () => stderr,
    close: () => {
      if (!closed) child.kill("SIGTERM");
    },
  };
}

async function initialize(client) {
  await client.request("initialize", {
    clientInfo: { name: "aos-companion-thread-bridge", version: "1.0.0" },
    capabilities: { experimentalApi: true },
  });
  client.notify("notifications/initialized");
}

export async function collectRecentTaskReview(options = {}) {
  const moduleUrl = new URL("./recent-task-review.mjs", import.meta.url);
  moduleUrl.search = new URL(import.meta.url).search;
  const { collectRecentTaskReviewWithClient } = await import(moduleUrl.href);
  const client = protocolClient(options);
  try {
    await initialize(client);
    return await collectRecentTaskReviewWithClient({ ...options, client });
  } finally { client.close(); }
}

export async function readCodexThreadMetadata({ threadId, ...options } = {}) {
  const client = protocolClient(options);
  try {
    await initialize(client);
    return (await client.request("thread/read", { threadId, includeTurns: false })).thread;
  } finally { client.close(); }
}

/** Reuse this Root's already collected official metadata/turn summaries.
 * The broad report remains authoritative for coverage; the legacy diagnostic
 * envelope is bounded and explicitly marks snapshot-only history as non-live.
 * This does not create a writer, send permission, or a second App Server read.
 */
export function buildDiagnosticProjectionFromReview({ report, rootRunId, excludeThreadIds = [], lastInspectedThreadId = null } = {}) {
  if (report?.schema !== "aos.recent_task_review.v1" || report.runId !== rootRunId || !Array.isArray(report.rows)) {
    throw exactError("scheduled_companion_review_projection_run_mismatch");
  }
  const excluded = new Set(excludeThreadIds);
  const rows = report.rows.filter((row) => row.kind === "codex" && !excluded.has(row.threadId));
  const previousIndex = rows.findIndex((row) => row.threadId === lastInspectedThreadId);
  const rotated = previousIndex < 0 ? rows : [...rows.slice(previousIndex + 1), ...rows.slice(0, previousIndex + 1)];
  const selected = rotated.slice(0, MAX_DEEP_READS);
  const lightweight = [], deep = [];
  for (const row of selected) {
    const thread = { id: row.threadId, status: row.appServerStatus, updatedAt: row.updatedAt };
    const fallback = listState(thread), alias = createThreadAlias(row.threadId);
    const metadataRead = Boolean(row.appServerStatus);
    lightweight.push({ alias, outcome: metadataRead ? "success" : "bounded_error", state: fallback });
    const snapshotOnly = row.historyReadMode === "verified_persisted_tail" || row.snapshotOnly === true;
    const historyRead = row.readStatus === "read" && !snapshotOnly;
    const state = deepState({ thread: { ...thread, turns: snapshotOnly ? [] : (row.turns || []).map(({ id, status }) => ({ id, status })) },
      goal: row.goal, exactBlocker: !historyRead
        ? snapshotOnly ? "recent_review_history_is_snapshot_only" : cleanText(row.readError || "recent_review_history_unread", 240)
        : null }, fallback);
    deep.push({ alias, outcome: historyRead ? "success" : "bounded_error", state });
  }
  return { projection: createThreadReadbackProjection({ automationId: "aos-companion-2", rootRunId,
    childAuditId: `child-${String(rootRunId).slice(-48)}`, producedAt: report.createdAt,
    listTruncated: report.inventoryComplete !== true || rows.length > selected.length,
    maxDeepReads: MAX_DEEP_READS, lightweight, deep }),
    source: "same_root_recent_task_review", reviewRunId: report.runId, inventoryCount: rows.length,
    selectedCount: selected.length, lastInspectedThreadId: selected.at(-1)?.threadId || null,
    snapshotOnlyCount: selected.filter((row) => row.historyReadMode === "verified_persisted_tail" || row.snapshotOnly === true).length };
}

function normalizeListPage(page) {
  const data = Array.isArray(page?.data)
    ? page.data
    : Array.isArray(page?.threads) ? page.threads : [];
  return { data, nextCursor: typeof page?.nextCursor === "string" && page.nextCursor ? page.nextCursor : null };
}

async function listThreads(client, { maxRecords = MAX_THREAD_RECORDS, maxPages = MAX_LIST_PAGES } = {}) {
  const threads = [];
  let cursor = null;
  let pages = 0;
  let truncated = false;
  while (pages < Math.max(1, maxPages) && threads.length < maxRecords) {
    const params = {
      limit: Math.min(50, maxRecords - threads.length),
      archived: false,
      useStateDbOnly: true,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: USER_SOURCE_KINDS,
      ...(cursor ? { cursor } : {}),
    };
    const page = normalizeListPage(await client.request("thread/list", params));
    pages += 1;
    threads.push(...page.data);
    if (!page.nextCursor) { cursor = null; break; }
    cursor = page.nextCursor;
    if (threads.length >= maxRecords) truncated = true;
  }
  if (cursor && pages >= maxPages) truncated = true;
  return { threads: threads.slice(0, maxRecords), listTruncated: truncated, pages };
}

async function readOfficialThreadState(client, threadId, { includeTurnItems = false, includeGoal = false } = {}) {
  const metadata = await client.request("thread/read", { threadId, includeTurns: false });
  const thread = metadata?.thread;
  if (!thread || typeof thread !== "object") throw exactError("codex_app_thread_read_shape_unrecognized");
  const turns = await client.request("thread/turns/list", {
    threadId,
    limit: 1,
    sortDirection: "desc",
    itemsView: includeTurnItems ? "full" : "summary",
  });
  const hydrated = {
    ...thread,
    turns: Array.isArray(turns?.data) ? turns.data : [],
  };
  if (!includeGoal) return { thread: hydrated, turnPage: turns };
  try {
    const response = await client.request("thread/goal/get", { threadId });
    return { thread: hydrated, turnPage: turns, goal: response.goal,
      goalStatus: response.goal?.status || "unknown", goalReadback: response.goal ? "present" : "absent" };
  } catch (error) {
    return { thread: hydrated, turnPage: turns, goalStatus: "unknown", goalReadback: "unavailable",
      goalReadbackBlocker: cleanText(error?.exact_blocker || error?.message, 240) };
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const result = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      result[index] = await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, run));
  return result;
}

function eligibleThreads(threads, excludeThreadIds = []) {
  const excluded = new Set((Array.isArray(excludeThreadIds) ? excludeThreadIds : []).map((value) => String(value)));
  return (Array.isArray(threads) ? threads : [])
    .filter((thread) => thread && typeof thread.id === "string" && thread.id && !excluded.has(thread.id))
    .filter((thread) => !thread.ephemeral && !sourceIsAgent(thread))
    .slice(0, MAX_THREAD_RECORDS);
}

function shortTurnId(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  return turns[0]?.id ?? turns[0]?.turnId ?? null;
}

export function latestAssistantMessage(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  const latest = turns[0] ?? {};
  const messages = (Array.isArray(latest?.items) ? latest.items : [])
    .filter((item) => item?.type === "agentMessage" && typeof item.text === "string")
    .map((item) => cleanText(item.text, 1_200))
    .filter(Boolean);
  return messages.at(-1) ?? null;
}

function callbackRequest(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : { ...fallback, threadId: value };
}

export function buildCompanionThreadProjection({
  threads = [],
  deepReadbacks = new Map(),
  rootRunId,
  childAuditId = `child-${String(rootRunId || "").slice(-48)}`,
  listTruncated = false,
  maxDeepReads = MAX_DEEP_READS,
} = {}) {
  if (!rootRunId) throw exactError("codex_app_server_bridge_root_run_id_missing");
  const selected = eligibleThreads(threads);
  const deepLimit = Math.max(0, Math.min(MAX_DEEP_READS, Number(maxDeepReads) || MAX_DEEP_READS));
  // The projection stores one lightweight and, when selected, one deep record
  // for the same alias. The expanded bounded envelope allows the current App
  // page to receive a fresh official read_thread outcome for every listed
  // task, including bounded read failures.
  const projectionCapacity = Math.max(0, MAX_THREAD_RECORDS - deepLimit);
  const projectionThreads = selected.slice(0, projectionCapacity);
  const lightweight = projectionThreads.map((thread) => ({
    alias: createThreadAlias(thread.id),
    outcome: "success",
    state: listState(thread),
  }));
  const deep = [];
  for (const thread of projectionThreads.slice(0, deepLimit)) {
    const result = deepReadbacks instanceof Map ? deepReadbacks.get(thread.id) : deepReadbacks?.[thread.id];
    if (!result) continue;
    const fallback = listState(thread);
    if (result.ok === false || result.error) {
      deep.push({
        alias: createThreadAlias(thread.id),
        outcome: "bounded_error",
        state: { ...fallback, exactBlocker: cleanText(result.exactBlocker || result.error || "codex_app_thread_read_failed", 240) },
      });
      continue;
    }
    try {
      deep.push({ alias: createThreadAlias(thread.id), outcome: "success", state: deepState(result, fallback) });
    } catch {
      deep.push({
        alias: createThreadAlias(thread.id),
        outcome: "bounded_error",
        state: { ...fallback, exactBlocker: "codex_app_thread_read_shape_unrecognized" },
      });
    }
  }
  return createThreadReadbackProjection({
    automationId: "aos-companion-2",
    rootRunId: String(rootRunId),
    childAuditId: String(childAuditId),
    maxDeepReads: deepLimit,
    listAttempted: 1,
    listSucceeded: 1,
    listTruncated: Boolean(listTruncated || selected.length > projectionThreads.length),
    lightweight,
    deep,
  });
}

export async function createCompanionThreadBridge({
  binary = CODEX_APP_SERVER_BINARY,
  timeoutMs = 30_000,
  maxRecords = MAX_THREAD_RECORDS,
  maxDeepReads = MAX_DEEP_READS,
  excludeThreadIds = [],
  rootRunId,
  childAuditId,
  continuationWorkerPath = CONTINUATION_WORKER_PATH,
  continuationWorkerRoot = CONTINUATION_WORKER_ROOT,
  continuationWorkerLauncher = null,
  lastInspectedThreadId = null,
} = {}) {
  const client = protocolClient({ binary, timeoutMs });
  const workerJobs = new Map();
  try {
    await initialize(client);
    const listed = await listThreads(client, { maxRecords });
    const inventory = eligibleThreads(listed.threads, excludeThreadIds);
    const deepLimit = Math.max(0, Math.min(MAX_DEEP_READS, Number(maxDeepReads) || MAX_DEEP_READS));
    const projectionCapacity = Math.max(0, MAX_THREAD_RECORDS - deepLimit);
    const previousIndex = inventory.findIndex((item) => item.id === lastInspectedThreadId);
    const rotated = previousIndex >= 0
      ? [...inventory.slice(previousIndex + 1), ...inventory.slice(0, previousIndex + 1)] : inventory;
    const selected = rotated.slice(0, projectionCapacity);
    const deepTargets = selected.slice(0, deepLimit);
    const deepResults = await mapWithConcurrency(deepTargets, MAX_DEEP_READ_CONCURRENCY, async (thread) => {
      try {
        return { threadId: thread.id, response: await readOfficialThreadState(client, thread.id) };
      } catch (error) {
        return { threadId: thread.id, error: cleanText(error?.exact_blocker || error?.message || "codex_app_thread_read_failed", 240) };
      }
    });
    const deepReadbacks = new Map(deepResults.map((item) => [item.threadId, item.error ? { ok: false, exactBlocker: item.error } : item.response]));
    const projection = buildCompanionThreadProjection({
      threads: selected,
      deepReadbacks,
      rootRunId,
      childAuditId,
      listTruncated: listed.listTruncated || inventory.length > selected.length,
      maxDeepReads,
    });
    const byAlias = new Map(inventory.map((thread) => [createThreadAlias(thread.id), thread]));
    return {
      schema: COMPANION_BRIDGE_SCHEMA,
      projection,
      listedCount: listed.threads.length,
      selectedCount: selected.length,
      inventoryCount: inventory.length,
      deepReadCount: deepReadbacks.size,
      lastInspectedThreadId: deepTargets.at(-1)?.id || null,
      listPages: listed.pages,
      listTruncated: listed.listTruncated,
      resolveThreadId: (aliasOrId) => {
        const raw = String(aliasOrId || "");
        const thread = byAlias.get(raw) || inventory.find((item) => item.id === raw) || null;
        return thread ? { threadId: thread.id, cwd: thread.cwd ?? null, status: statusType(thread.status), updatedAt: isoFromUnixSeconds(thread.updatedAt) } : null;
      },
      readThread: async (threadIdOrRequest, options = {}) => {
        const request = callbackRequest(threadIdOrRequest, options);
        const threadId = request.threadId ?? request.thread_id;
        const includeTurns = request.includeTurns !== undefined ? request.includeTurns === true : true;
        const thread = inventory.find((item) => item.id === String(threadId));
        if (!thread) throw exactError("codex_app_thread_target_not_in_fresh_inventory");
        const response = await readOfficialThreadState(client, thread.id, { includeTurnItems: includeTurns, includeGoal: true });
        const fallback = listState(thread);
        const normalized = deepState(response, fallback);
        const continuationJob = request.idempotencyKey
          ? workerJobs.get(cleanText(request.idempotencyKey, 200))
            || workerJobForKey(continuationWorkerRoot, request.idempotencyKey)
          : null;
        const beforeTurnId = cleanText(continuationJob?.beforeTurnId, 200);
        const latestTurnId = shortTurnId(response.thread ?? response);
        const freshContinuationTurn = Boolean(beforeTurnId && latestTurnId && beforeTurnId !== latestTurnId);
        const workerResult = continuationJob
          ? workerResultFor(continuationWorkerRoot, continuationJob.jobId) : null;
        const exactWorker = workerResult?.threadId === thread.id
          && workerResult?.idempotencyKey === request.idempotencyKey;
        const saved = normalizeConfirmedDeliveryProof({ transportDeliveryProof: request.priorDeliveryProof },
          { threadId: thread.id, idempotencyKey: request.idempotencyKey });
        const savedBound = Boolean(saved);
        const knownTurnId = workerResult?.turnId || (savedBound ? saved.turnId || saved.afterTurnId : null);
        let recentTurns = response.thread?.turns || [];
        const hasMarker = (turn) => (turn.items || []).some((item) => item.type === "userMessage"
          && (item.content || []).some((part) => part.type === "text"
            && part.text?.split("\n").some((line) => line.trim() === `continuation_key=${request.idempotencyKey}`)));
        let markerTurn = request.idempotencyKey ? recentTurns.find(hasMarker) : null;
        let deliveredTurn = recentTurns.find((turn) => turn.id === knownTurnId);
        if (request.idempotencyKey && !markerTurn && (!deliveredTurn || !beforeTurnId)) {
          // A later user turn must not erase the receipt for our exact turn.
          const recent = await client.request("thread/turns/list", {
            threadId: thread.id, limit: 10, sortDirection: "desc", itemsView: "full",
          });
          recentTurns = recent?.data || [];
          deliveredTurn = recentTurns.find((turn) => turn.id === knownTurnId);
          markerTurn = recentTurns.find(hasMarker);
        }
        const deliveryProof = exactWorker && beforeTurnId && deliveredTurn?.id !== beforeTurnId
          && deliveredTurn?.status === "completed"
          ? { kind: "same_task_new_turn_completed", threadId: thread.id,
              idempotencyKey: request.idempotencyKey, beforeTurnId, afterTurnId: deliveredTurn.id,
              afterTurnStatus: "completed", sendResultStatus: "accepted", sameTask: true }
          : markerTurn ? { kind: "same_task_message_observed", threadId: thread.id,
              idempotencyKey: request.idempotencyKey, turnId: markerTurn.id,
              turnStatus: markerTurn.status, markerVisible: true, sameTask: true }
          : savedBound && deliveredTurn ? { ...saved, proofSource: "prior_confirmed_delivery",
              observedTurnStatus: deliveredTurn.status,
              ...(saved.kind === "same_task_message_observed" ? { turnStatus: deliveredTurn.status } : {}) } : null;
        return {
          threadId: thread.id,
          status: normalized.taskStatus,
          latestTurnStatus: normalized.latestTurnStatus,
          goalStatus: response.goal?.status || "unknown",
          planStatus: normalized.planStatus,
          goalStateSource: ["present", "absent"].includes(response.goalReadback) ? "official_goal_api" : "unknown",
          goalReadback: response.goalReadback,
          goalReadbackBlocker: response.goalReadbackBlocker || null,
          ...(deliveryProof ? { transportDeliveryProof: deliveryProof } : {}),
          owner: normalized.owner,
          userOwned: normalized.userOwned,
          exactBlocker: normalized.exactBlocker,
          updatedAt: normalized.updatedAt,
          revision: normalized.revision,
          latestTurnId,
          latestAssistantMessage: latestAssistantMessage(response.thread ?? response),
          // A same-task user message is transport evidence even when the
          // destination Root later becomes interrupted.  Keep this separate
          // from Goal/Plan state: delivery is not continuation completion.
          continuationDelivered: request.idempotencyKey
            && freshContinuationTurn
            ? JSON.stringify(response.thread?.turns || []).includes(`continuation_key=${String(request.idempotencyKey)}`)
            : false,
        };
      },
      sendMessage: async (threadIdOrRequest, messageOrOptions) => {
        const request = typeof messageOrOptions === "string"
          ? callbackRequest(threadIdOrRequest, { prompt: messageOrOptions })
          : callbackRequest(threadIdOrRequest, messageOrOptions || {});
        const threadId = request.threadId ?? request.thread_id;
        const message = request.prompt ?? request.message;
        const thread = selected.find((item) => item.id === String(threadId));
        if (!thread) throw exactError("codex_app_thread_target_not_in_fresh_inventory");
        if (typeof message !== "string" || !message.trim()) throw exactError("codex_app_thread_message_empty");
        const cwd = typeof request.cwd === "string" && request.cwd.trim()
          ? request.cwd.trim()
          : typeof request.workdir === "string" && request.workdir.trim()
            ? request.workdir.trim()
            : typeof thread.cwd === "string" && thread.cwd.trim() ? thread.cwd.trim() : null;
        const before = await readOfficialThreadState(client, thread.id, { includeTurnItems: true });
        const beforeThread = before.thread ?? {};
        const beforeBoundary = classifyThreadExecutionBoundary(beforeThread);
        if (beforeBoundary.active) {
          throw exactError(beforeBoundary.exactBlocker, {
            taskStatus: beforeBoundary.taskStatus,
            latestTurnStatus: beforeBoundary.latestTurnStatus,
          });
        }
        // A direct turn/start is owned by the App Server process that issued
        // it. The heartbeat must be allowed to finish, so closing this bridge
        // cannot also terminate a destination task's live turn. Hand the
        // continuation to a detached, task-owned worker that keeps its own
        // App Server connection until turn/completed.
        const worker = launchContinuationWorker({
          workerPath: continuationWorkerPath,
          workerRoot: continuationWorkerRoot,
          launcher: continuationWorkerLauncher,
          threadId: thread.id,
          cwd,
          prompt: message,
          idempotencyKey: request.idempotencyKey ?? null,
          beforeTurnId: shortTurnId(beforeThread),
        });
        workerJobs.set(worker.idempotencyKey || worker.jobId, worker);
        return {
          status: "accepted",
          threadId: thread.id,
          beforeTurnId: shortTurnId(beforeThread),
          afterTurnId: null,
          afterStatus: "active",
          afterLatestTurnStatus: "inProgress",
          markerVisible: false,
          workerJobId: worker.jobId,
          sameTask: true,
        };
      },
      waitForCompletion: async (threadIdOrRequest, timeoutMsOrOptions = 15_000) => {
        const request = typeof timeoutMsOrOptions === "object"
          ? callbackRequest(threadIdOrRequest, timeoutMsOrOptions)
          : callbackRequest(threadIdOrRequest);
        const timeoutMsForWait = typeof timeoutMsOrOptions === "number"
          ? timeoutMsOrOptions
          : Number(request.timeoutMs ?? request.timeout_ms ?? 15_000);
        const threadId = request.threadId ?? request.thread_id;
        const expectedTurnId = request.turnId ?? request.turn_id;
        const key = cleanText(request.idempotencyKey ?? request.idempotency_key, 200);
        const job = workerJobs.get(key) || workerJobForKey(continuationWorkerRoot, key);
        if (job) {
          const deadline = Date.now() + Math.max(0, timeoutMsForWait);
          while (Date.now() < deadline) {
            const result = workerResultFor(job.resultPath ? path.dirname(job.resultPath) : CONTINUATION_WORKER_ROOT, job.jobId);
            if (result) {
              const activeExecutionBoundary = result.activeExecutionBoundary === true
                || result.active_execution_boundary === true
                || isActiveWriterError({ error: result.error })
                || String(result.exactBlocker || result.exact_blocker || "") === "codex_app_thread_active_boundary_required";
              return {
                status: ["completed", "running", "awaiting_user"].includes(result.status) ? result.status : "failed",
                threadId: String(threadId),
                turnId: result.turnId || expectedTurnId || null,
                workerJobId: job.jobId,
                exact_blocker: activeExecutionBoundary
                  ? "codex_app_thread_active_boundary_required"
                  : result.exactBlocker || null,
                ...(activeExecutionBoundary ? { activeExecutionBoundary: true } : {}),
                ...(workerResultPreDispatchNoEffect(result) ? { preDispatchNoEffect: true } : {}),
                result,
              };
            }
            await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
          }
          return {
            status: "timeout",
            threadId: String(threadId),
            turnId: expectedTurnId || null,
            workerJobId: job.jobId,
            exact_blocker: "continuation_worker_completion_timeout",
          };
        }
        const notification = await client.waitForNotification(
          (message) => message?.method === "turn/completed"
            && String(message?.params?.threadId || "") === String(threadId)
            && (!expectedTurnId || String(message?.params?.turn?.id || message?.params?.turnId || "") === String(expectedTurnId)),
          Math.max(0, timeoutMsForWait),
        );
        return {
          status: "completed",
          threadId: String(threadId),
          turnId: notification?.params?.turn?.id ?? notification?.params?.turnId ?? null,
          notification,
        };
      },
      close: () => client.close(),
      stderr: () => client.stderr(),
    };
  } catch (error) {
    client.close();
    if (error?.exact_blocker) throw error;
    throw exactError("codex_app_server_companion_bridge_failed", { message: cleanText(error?.message, 300) });
  }
}

export async function collectCompanionThreadReadback({
  rootRunId,
  childAuditId,
  excludeThreadIds = [],
  binary = CODEX_APP_SERVER_BINARY,
  timeoutMs = 30_000,
  maxRecords = MAX_THREAD_RECORDS,
  maxDeepReads = MAX_DEEP_READS,
  lastInspectedThreadId = null,
} = {}) {
  const bridge = await createCompanionThreadBridge({
    rootRunId,
    childAuditId,
    excludeThreadIds,
    binary,
    timeoutMs,
    maxRecords,
    maxDeepReads,
    lastInspectedThreadId,
  });
  return bridge;
}

export function bridgeFingerprint(projection) {
  return crypto.createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

// Automatic repair resumes only verified blockers. A paused Goal requires a
// fresh explicit user request in this destination task (never an audit default).
// This cannot create a Goal, change its objective/budget or operate another task.
export async function resumeCurrentTaskGoal({ globals = globalThis, blockerResolved = false,
  verificationPassed = false, userRequestedResume = false, client: suppliedClient = null } = {}) {
  const threadId = globals?.nodeRepl?.requestMeta?.["x-codex-turn-metadata"]?.thread_id;
  if (!threadId) throw exactError("current_task_identity_required");
  if (userRequestedResume !== true && (!blockerResolved || !verificationPassed)) {
    throw exactError("goal_blocker_resolution_not_verified");
  }
  const client = suppliedClient || protocolClient();
  try {
    if (!suppliedClient) await initialize(client);
    const before = await client.request("thread/goal/get", { threadId });
    if (!before?.goal) return { status: "not_applicable", goal: null, exactBlocker: "formal_goal_absent" };
    const repairedBlocker = before.goal.status === "blocked" && blockerResolved && verificationPassed;
    const requestedPauseResume = before.goal.status === "paused" && userRequestedResume === true;
    if (!repairedBlocker && !requestedPauseResume) return { status: "unchanged", goal: before.goal };
    await client.request("thread/goal/set", { threadId, status: "active" });
    const after = await client.request("thread/goal/get", { threadId });
    if (after?.goal?.status !== "active" || after.goal.objective !== before.goal.objective
      || (before.goal.id && after.goal.id !== before.goal.id)
      || after.goal.tokenBudget !== before.goal.tokenBudget) throw exactError("goal_resume_readback_mismatch");
    return { status: "resumed", goal: after.goal, source: "official_goal_api" };
  } finally { if (!suppliedClient) client.close(); }
}

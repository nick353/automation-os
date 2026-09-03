import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const HOURLY_THREAD_DISPATCH_SCHEMA = "aos.hourly_thread_dispatch.v1";
const MAX_MESSAGE_CHARS = 6_000;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function text(value, max = 500) {
  return String(value ?? "").replace(/[\u0000\r\n]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max);
}

function threadIdOf(task) {
  return text(task?.threadId ?? task?.thread_id, 200);
}

function keyDigest(idempotencyKey) {
  return crypto.createHash("sha256").update(String(idempotencyKey || "")).digest("hex");
}

function targetIdentityOf(task) {
  const target = task?.targetIdentity ?? task?.target_identity ?? task?.target ?? {};
  const pick = (key, ...aliases) => {
    for (const candidate of [key, ...aliases]) {
      if (target?.[candidate] !== undefined && target?.[candidate] !== null) return target[candidate];
      if (task?.[candidate] !== undefined && task?.[candidate] !== null) return task[candidate];
    }
    return null;
  };
  return {
    taskId: pick("taskId", "task_id"),
    sessionId: pick("sessionId", "session_id"),
    leaseId: pick("leaseId", "lease_id"),
    generation: pick("generation", "runtimeGeneration", "runtime_generation"),
    pageInstanceId: pick("pageInstanceId", "page_instance_id"),
    windowId: pick("windowId", "window_id"),
    frameId: pick("frameId", "frame_id"),
    targetFingerprint: pick("targetFingerprint", "target_fingerprint"),
  };
}

function compactExecutionReceipt(executionReceipt) {
  if (!executionReceipt || typeof executionReceipt !== "object") return null;
  const stages = executionReceipt.stageReceipts ?? executionReceipt.stages;
  const stageSummary = stages && typeof stages === "object"
    ? Object.entries(stages)
      .map(([name, value]) => `${text(name, 80)}:${text(value?.status ?? value, 40)}`)
      .join(",")
      .slice(0, 900)
    : "";
  return {
    schema: text(executionReceipt.schema, 120) || "unknown",
    status: text(executionReceipt.status, 40) || "unknown",
    stages: stageSummary || "none",
  };
}

function privateJsonNoReplace(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") return { path: file, created: false };
    throw error;
  }
  try {
    fs.writeFileSync(fd, bytes, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
  return { path: file, created: true };
}

function readPrivateJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function existingLedgerFile(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) {
      const error = new Error("thread_dispatch_ledger_entry_not_a_file");
      error.code = "thread_dispatch_ledger_entry_not_a_file";
      throw error;
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function dispatchRecord(payload = {}, phase) {
  const prompt = text(payload.prompt, MAX_MESSAGE_CHARS);
  return {
    schema: HOURLY_THREAD_DISPATCH_SCHEMA,
    phase,
    runId: text(payload.runId, 180) || null,
    idempotencyKey: text(payload.idempotencyKey, 200),
    threadId: text(payload.threadId, 200),
    hostId: text(payload.hostId, 200) || null,
    lane: text(payload.lane, 80) || "normal",
    sourceThreadOnly: payload.sourceThreadOnly === true,
    targetIdentity: targetIdentityOf(payload.task),
    promptSha256: crypto.createHash("sha256").update(prompt).digest("hex"),
    status: text(payload.status, 80) || null,
    exactBlocker: text(payload.exact_blocker ?? payload.exactBlocker, 400) || null,
    recordedAt: new Date().toISOString(),
  };
}

/**
 * Build the default private O_EXCL ledger.  The dispatcher accepts callbacks
 * so a host can use a database instead; this adapter keeps the common local
 * path durable without storing the message body or any credentials.  The
 * default scope is global to the ledger root: a stable continuation key must
 * remain suppressed across hourly scheduler processes, not only within one
 * process/run.  Pass `scope: "run"` only for an explicitly isolated test or
 * diagnostic ledger.  An intent file reserves a key before send, and a
 * receipt file records the terminal observation after send/readback.
 */
export function createFileDispatchLedger({ root, runId = "run", scope = "global" } = {}) {
  if (!root) throw new Error("hourly_thread_dispatch_ledger_root_required");
  const ledgerRoot = path.resolve(String(root));
  const runSegment = text(runId, 180).replace(/[^A-Za-z0-9._-]+/gu, "-") || "run";
  const selectedScope = scope === "run" ? "run" : "global";
  const scopeRoot = selectedScope === "run" ? path.join(ledgerRoot, runSegment) : ledgerRoot;
  const intentDir = path.join(scopeRoot, "intents");
  const receiptDir = path.join(scopeRoot, "receipts");
  const reconciliationDir = path.join(scopeRoot, "reconciliations");
  const fileFor = (dir, key) => path.join(dir, `${keyDigest(key)}.json`);
  const latestReconciliation = (key) => {
    if (!fs.existsSync(reconciliationDir)) return null;
    const prefix = `${keyDigest(key)}-`;
    const candidates = fs.readdirSync(reconciliationDir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
      .sort()
      .reverse();
    return candidates.length > 0 ? readPrivateJson(path.join(reconciliationDir, candidates[0])) : null;
  };
  return {
    root: ledgerRoot,
    runId: runSegment,
    scope: selectedScope,
    paths: { intentDir, receiptDir, reconciliationDir },
    async alreadyDispatched({ idempotencyKey } = {}) {
      if (!idempotencyKey) return false;
      const receiptPath = fileFor(receiptDir, idempotencyKey);
      const intentPath = fileFor(intentDir, idempotencyKey);
      const receipt = existingLedgerFile(receiptPath) ? readPrivateJson(receiptPath) : null;
      const reconciliation = latestReconciliation(idempotencyKey);
      const latest = reconciliation || receipt;
      if (latest) {
        const status = text(latest.status, 80) || "sent_unverified";
        return {
          seen: true,
          status,
          terminal: status === "sent" || status === "duplicate_suppressed",
          receipt,
          reconciliation,
        };
      }
      if (existingLedgerFile(intentPath)) {
        return { seen: true, reserved: true, status: "intent_reserved", intent: readPrivateJson(intentPath) };
      }
      return false;
    },
    async recordIntent(payload = {}) {
      const key = payload.idempotencyKey;
      if (!key) return { ok: false, exact_blocker: "thread_dispatch_idempotency_key_required" };
      const result = privateJsonNoReplace(fileFor(intentDir, key), dispatchRecord({ ...payload, runId: runSegment }, "intent"));
      return result.created ? { ok: true, ...result } : { ok: false, exact_blocker: "thread_dispatch_intent_already_recorded", ...result };
    },
    async recordReceipt(payload = {}) {
      const key = payload.idempotencyKey;
      if (!key) return { ok: false, exact_blocker: "thread_dispatch_idempotency_key_required" };
      const result = privateJsonNoReplace(fileFor(receiptDir, key), dispatchRecord({ ...payload, runId: runSegment }, "receipt"));
      return { ok: true, duplicate: !result.created, ...result };
    },
    async recordReconciliation(payload = {}) {
      const key = payload.idempotencyKey;
      if (!key) return { ok: false, exact_blocker: "thread_dispatch_idempotency_key_required" };
      fs.mkdirSync(reconciliationDir, { recursive: true, mode: 0o700 });
      const safeTimestamp = new Date().toISOString().replace(/[^0-9]/gu, "").slice(0, 17);
      const file = path.join(reconciliationDir, `${keyDigest(key)}-${safeTimestamp}-${crypto.randomBytes(4).toString("hex")}.json`);
      const result = privateJsonNoReplace(file, dispatchRecord({ ...payload, runId: runSegment }, "reconciliation"));
      return { ok: true, duplicate: !result.created, ...result };
    },
  };
}

/**
 * A continuation key is derived only from the current audit signal, the
 * existing task/thread, and its target identity. It is stable across
 * scheduler retries, but changes when the Companion generation, bound target,
 * or requested next action changes.
 */
export function buildContinuationIdempotencyKey({
  task,
  auditFingerprint,
  generation,
  nextAction,
} = {}) {
  const threadId = threadIdOf(task);
  if (!threadId) throw new Error("hourly_thread_dispatch_thread_id_required");
  const payload = {
    threadId,
    targetIdentity: targetIdentityOf(task),
    auditFingerprint: text(auditFingerprint, 500),
    generation: text(generation, 200),
    nextAction: text(nextAction ?? task?.nextAction ?? task?.next_action, 1_000),
  };
  return `aos-hourly:${crypto.createHash("sha256").update(stableJson(payload)).digest("hex").slice(0, 32)}`;
}

/**
 * Keep the continuation human-readable and small. The destination task must
 * perform its own fresh Goal/Plan and Companion readback; this message is a
 * resumable baton, never a claim of business completion.
 */
export function buildContinuationMessage({
  task,
  auditFingerprint,
  freshStatus,
  executionReceipt,
  nextAction,
  idempotencyKey = null,
  stopConditions = [],
  proof = [],
  lane = "normal",
  sourceThreadOnly = false,
} = {}) {
  const threadId = threadIdOf(task);
  if (!threadId) throw new Error("hourly_thread_dispatch_thread_id_required");
  const taskLabel = text(task?.title ?? task?.name ?? task?.taskType ?? task?.task_type ?? "task", 160);
  const goalId = text(task?.goalId ?? task?.goal_id ?? task?.goal?.id, 200) || "unknown";
  const planId = text(task?.planId ?? task?.plan_id ?? task?.plan?.id, 200) || "unknown";
  const generation = text(freshStatus?.generation ?? freshStatus?.runtimeGeneration ?? freshStatus?.runtime_generation, 200) || "unknown";
  const action = text(nextAction ?? task?.nextAction ?? task?.next_action, 1_000) || "fresh task-scoped readback and continue the existing plan";
  const target = targetIdentityOf(task);
  const continuationKey = text(idempotencyKey, 200);
  const targetLine = [
    `task=${text(target.taskId, 160) || "unknown"}`,
    `session=${text(target.sessionId, 160) || "unknown"}`,
    `lease=${text(target.leaseId, 160) || "unknown"}`,
    `generation=${text(target.generation ?? generation, 160) || "unknown"}`,
    `page=${text(target.pageInstanceId, 180) || "unknown"}`,
    `window=${text(target.windowId, 80) || "unknown"}`,
    `frame=${text(target.frameId, 80) || "0"}`,
    `fingerprint=${text(target.targetFingerprint, 220) || "unknown"}`,
  ].join(" ");
  const receipt = compactExecutionReceipt(executionReceipt);
  const proofLines = (Array.isArray(proof) ? proof : [proof]).map((value) => text(value, 400)).filter(Boolean).slice(0, 8);
  const stops = (Array.isArray(stopConditions) ? stopConditions : [stopConditions]).map((value) => text(value, 300)).filter(Boolean).slice(0, 8);
  const lines = [
    "Hourly Companion audit continuation (same task; no new task or handoff).",
    `task=${taskLabel} thread=${threadId} lane=${text(lane, 80)}`,
    ...(continuationKey ? [`continuation_key=${continuationKey}`] : []),
    `goal=${goalId} plan=${planId} generation=${generation} audit=${text(auditFingerprint, 120) || "unknown"}`,
    `target_identity ${targetLine}`,
    `source_thread_only=${sourceThreadOnly ? "true" : "false"}`,
    receipt
      ? `execution_receipt schema=${receipt.schema} status=${receipt.status} stages=${receipt.stages}`
      : "execution_receipt=not_supplied; business completion is not claimed",
    "",
    "Fresh-read before acting: read the current Goal/Plan, target, owner, and Companion status. Preserve the original intent.",
    "Goal resume rule: when the existing Goal is stalled but the fresh safety readback is clear, resume that same Goal/Plan in this thread; do not create a new Goal, fork, or handoff.",
    "Goal/Plan confirmation: use this task's own exposed Goal/Plan readback (for example get_goal or the task's native Goal control) at the start of this turn and report the resulting goal_plan_state. A delivered message alone is not Goal/Plan proof. If the existing Goal is blocked only by the cleared blocker, continue that same Goal/Plan; if a concrete blocker remains, keep it blocked and report the exact blocker.",
    ...(lane === "task_owned_companion_relay" ? [
      "Task-owned Companion relay: the scheduler cannot operate another task's Companion. This task is now the owner; perform the fresh Companion status/target/owner/effect readback and one bounded local repair in this thread, then verify the existing Goal/Plan before continuing.",
      "Use only the supported Companion surface and refresh at a fully idle/reconciled boundary. Do not adopt foreign resources, replay unknown effects, or bypass auth/OTP/CAPTCHA, provider, or target gates.",
    ] : []),
    `One next action now: ${action}`,
    "",
    proofLines.length ? `Verified evidence: ${proofLines.join("; ")}` : "Verified evidence: controller stage receipt only; business completion is not claimed.",
    stops.length ? `Stop conditions: ${stops.join("; ")}` : "Stop conditions: visible auth/OTP/CAPTCHA, foreign owner, unknown effect, or ambiguous target.",
    "After the action, read back the result and continue the existing task. Do not replay an unknown external effect or resume a human-only/blocked Goal automatically.",
  ];
  return lines.join("\n").slice(0, MAX_MESSAGE_CHARS);
}

function sendResultStatus(value) {
  if (value === undefined || value === null) return "unknown";
  if (typeof value !== "object") return "unknown";
  if (value.isError === true || value.ok === false || value.success === false || value.status === "failed") return "failed";
  if (value.status === "deferred" || value.status === "blocked") return "deferred";
  if (["unknown", "sent_unverified", "send_result_unknown", "unknown_result"].includes(String(value.status || "").toLowerCase())) return "unknown";
  return "accepted";
}

function hasMatchingIdempotencyKey(value, expected, seen = new Set()) {
  if (!expected || value === null || value === undefined || (typeof value !== "object" && !Array.isArray(value))) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasMatchingIdempotencyKey(item, expected, seen));
  for (const [key, nested] of Object.entries(value)) {
    if (["idempotencyKey", "idempotency_key", "continuationIdempotencyKey", "continuation_idempotency_key"].includes(key)
      && String(nested) === String(expected)) return true;
    if (nested && typeof nested === "object" && hasMatchingIdempotencyKey(nested, expected, seen)) return true;
  }
  return false;
}

function hasMatchingContinuationMarker(value, expected, seen = new Set()) {
  if (!expected || value === null || value === undefined) return false;
  if (typeof value === "string") return value.includes(`continuation_key=${String(expected)}`);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasMatchingContinuationMarker(item, expected, seen));
  return Object.values(value).some((nested) => hasMatchingContinuationMarker(nested, expected, seen));
}

function goalPlanStateOf(value, seen = new Set()) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const marker = /(?:^|[\s;])goal_plan_state\s*[:=]\s*([A-Za-z][A-Za-z0-9_-]{0,79})/u.exec(value);
    return marker ? text(marker[1], 80).toLowerCase() : null;
  }
  if (typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    if (["goalPlanState", "goal_plan_state", "goalStatus", "goal_status", "planStatus", "plan_status"].includes(key)) {
      if (typeof nested === "string" && text(nested, 80)) return text(nested, 80).toLowerCase();
      if (nested && typeof nested === "object") {
        const nestedState = text(nested.state ?? nested.status, 80);
        if (nestedState) return nestedState.toLowerCase();
      }
    }
    if (["goal", "plan"].includes(key) && nested && typeof nested === "object") {
      const nestedState = text(nested.state ?? nested.status, 80);
      if (nestedState) return nestedState.toLowerCase();
    }
    const recursive = goalPlanStateOf(nested, seen);
    if (recursive) return recursive;
  }
  return null;
}

function readbackStatus(value, { idempotencyKey = null } = {}) {
  if (value === undefined || value === null) return { status: "unavailable", exactBlocker: "thread_readback_not_supplied" };
  if (value?.isError === true || value?.ok === false || value?.success === false) {
    return { status: "unavailable", exactBlocker: text(value?.exact_blocker ?? value?.exactBlocker ?? value?.error, 300) || "thread_readback_failed" };
  }
  const goalPlanState = goalPlanStateOf(value);
  const deliveryConfirmed = value?.deliveryConfirmed === true
    || value?.delivery_confirmed === true
    || value?.messageDelivered === true
    || value?.message_delivered === true
    || value?.continuationDelivered === true
    || value?.continuation_delivered === true
    || value?.readbackVerified === true && Boolean(value?.continuationTurnId ?? value?.continuation_turn_id ?? value?.messageId ?? value?.message_id)
    || value?.readback?.deliveryConfirmed === true
    || value?.readback?.delivery_confirmed === true
    || hasMatchingIdempotencyKey(value, idempotencyKey)
    || hasMatchingContinuationMarker(value, idempotencyKey);
  return deliveryConfirmed
    ? { status: "observed", exactBlocker: null, ...(goalPlanState ? { goalPlanState } : {}) }
    : { status: "unavailable", exactBlocker: "thread_send_delivery_not_confirmed", ...(goalPlanState ? { goalPlanState } : {}) };
}

function uncertainSendError(error) {
  const code = text(error?.code, 120).toLowerCase();
  const message = text(error?.message ?? error, 400).toLowerCase();
  return /(?:timeout|timed[_ -]?out|disconnect|disconnected|unknown[_ -]?effect|connection[_ -]?reset|no[_ -]?response)/u.test(`${code} ${message}`);
}

async function persistReceipt(recordReceipt, result) {
  if (typeof recordReceipt !== "function") return result;
  try {
    const receipt = await recordReceipt({ ...result, phase: "receipt" });
    if (receipt === false || receipt?.ok === false || receipt?.status === "failed") {
      result.status = result.status === "failed" ? "failed" : "sent_unverified";
      result.exact_blocker = text(receipt?.exact_blocker ?? receipt?.exactBlocker ?? receipt?.error, 400) || "thread_dispatch_receipt_persistence_failed";
    }
    result.receipt = receipt ?? null;
  } catch (error) {
    result.status = result.status === "failed" ? "failed" : "sent_unverified";
    result.exact_blocker = text(error?.message ?? error, 400) || "thread_dispatch_receipt_persistence_failed";
    result.receipt = null;
  }
  return result;
}

async function persistReconciliation(recordReconciliation, result) {
  if (typeof recordReconciliation !== "function") return result;
  try {
    const receipt = await recordReconciliation({ ...result, phase: "reconciliation" });
    if (receipt === false || receipt?.ok === false || receipt?.status === "failed") {
      result.reconciliation = null;
      result.reconciliation_exact_blocker = text(receipt?.exact_blocker ?? receipt?.exactBlocker ?? receipt?.error, 400) || "thread_dispatch_reconciliation_persistence_failed";
    } else {
      result.reconciliation = receipt ?? null;
    }
  } catch (error) {
    result.reconciliation = null;
    result.reconciliation_exact_blocker = text(error?.message ?? error, 400) || "thread_dispatch_reconciliation_persistence_failed";
  }
  return result;
}

async function readbackAfterUncertainSend(readThread, { threadId, hostId, idempotencyKey } = {}) {
  if (typeof readThread !== "function") return { status: "unavailable", exactBlocker: "thread_readback_callback_required" };
  try {
    return readbackStatus(await readThread({ threadId, hostId, idempotencyKey, reason: "uncertain_send_no_replay" }), { idempotencyKey });
  } catch (error) {
    return { status: "unavailable", exactBlocker: text(error?.message ?? error, 400) || "thread_readback_failed" };
  }
}

/**
 * Send exactly one existing-task message and optionally perform one readback.
 * The injected callbacks are the only bridge to Codex App; this module never
 * creates a thread, forks, archives, or assumes that API acceptance means the
 * destination task completed.
 */
export async function dispatchThreadContinuation({
  task,
  auditFingerprint,
  freshStatus,
  executionReceipt = null,
  nextAction,
  stopConditions = [],
  proof = [],
  lane = "normal",
  sourceThreadOnly = false,
  sendMessage,
  readThread = null,
  resolveHostId = null,
  alreadyDispatched = null,
  recordIntent = null,
  recordReceipt = null,
  recordReconciliation = null,
} = {}) {
  const threadId = threadIdOf(task);
  if (!threadId) return { schema: HOURLY_THREAD_DISPATCH_SCHEMA, status: "deferred", exact_blocker: "thread_id_missing", external_action_executed: false };
  if (typeof sendMessage !== "function") return { schema: HOURLY_THREAD_DISPATCH_SCHEMA, status: "deferred", exact_blocker: "thread_send_callback_required", threadId, external_action_executed: false };
  const idempotencyKey = buildContinuationIdempotencyKey({
    task,
    auditFingerprint,
    generation: freshStatus?.generation ?? freshStatus?.runtimeGeneration ?? freshStatus?.runtime_generation,
    nextAction,
  });
  if (typeof alreadyDispatched === "function") {
    let seen = false;
    try { seen = await alreadyDispatched({ task, threadId, idempotencyKey }); }
    catch (error) {
      return { schema: HOURLY_THREAD_DISPATCH_SCHEMA, status: "deferred", exact_blocker: text(error?.message ?? error, 400) || "thread_dispatch_dedupe_lookup_failed", threadId, idempotencyKey, external_action_executed: false };
    }
    const canReconcile = typeof readThread === "function"
      && seen
      && typeof seen === "object"
      && !seen?.terminal
      && ["sent_unverified", "intent_reserved"].includes(String(seen.status || ""));
    if (canReconcile) {
      const hostId = seen.hostId
        ?? seen.receipt?.hostId
        ?? seen.receipt?.host_id
        ?? seen.reconciliation?.hostId
        ?? seen.reconciliation?.host_id
        ?? seen.intent?.hostId
        ?? seen.intent?.host_id
        ?? task?.hostId
        ?? task?.host_id
        ?? null;
      const readback = await readbackAfterUncertainSend(readThread, { threadId, hostId, idempotencyKey });
      const result = {
        schema: HOURLY_THREAD_DISPATCH_SCHEMA,
        status: readback.status === "observed" ? "sent" : "sent_unverified",
        exact_blocker: readback.status === "observed" ? null : readback.exactBlocker || "thread_send_result_unknown",
        threadId,
        hostId,
        idempotencyKey,
        readback,
        replay_allowed: false,
        resume_trigger: readback.status === "observed" ? null : "same-target readback for this idempotency key; do not resend",
        external_action_executed: false,
        reconciliation_of: seen.status,
      };
      return persistReconciliation(recordReconciliation, result);
    }
    if (seen === true || seen?.seen === true || seen?.reserved === true || seen?.terminal === true || ["sent", "duplicate_suppressed"].includes(seen?.status)) {
      return { schema: HOURLY_THREAD_DISPATCH_SCHEMA, status: "duplicate_suppressed", threadId, idempotencyKey, external_action_executed: false };
    }
  }
  let hostId;
  try {
    hostId = task?.hostId ?? task?.host_id ?? (typeof resolveHostId === "function" ? await resolveHostId({ task, threadId }) : undefined);
  } catch (error) {
    return { schema: HOURLY_THREAD_DISPATCH_SCHEMA, status: "deferred", exact_blocker: text(error?.message ?? error, 400) || "thread_host_resolution_failed", threadId, idempotencyKey, external_action_executed: false };
  }
  const prompt = buildContinuationMessage({ task, auditFingerprint, freshStatus, executionReceipt, nextAction, idempotencyKey, stopConditions, proof, lane, sourceThreadOnly });
  // Persist the immutable intent before crossing the send boundary. A caller
  // can back this with O_EXCL/transactional storage; a crash after this point
  // must be reconciled by idempotencyKey instead of blindly sending again.
  if (typeof recordIntent === "function") {
    try {
      const intent = await recordIntent({
        schema: HOURLY_THREAD_DISPATCH_SCHEMA,
        phase: "intent",
        task,
        threadId,
        hostId: hostId ?? null,
        idempotencyKey,
        prompt,
        lane,
        sourceThreadOnly,
      });
      if (intent === false || intent?.ok === false || intent?.status === "failed") {
        return { schema: HOURLY_THREAD_DISPATCH_SCHEMA, status: "deferred", exact_blocker: text(intent?.exact_blocker ?? intent?.exactBlocker ?? intent?.error, 400) || "thread_dispatch_intent_persistence_failed", threadId, hostId: hostId ?? null, idempotencyKey, external_action_executed: false };
      }
    } catch (error) {
      return { schema: HOURLY_THREAD_DISPATCH_SCHEMA, status: "deferred", exact_blocker: text(error?.message ?? error, 400) || "thread_dispatch_intent_persistence_failed", threadId, hostId: hostId ?? null, idempotencyKey, external_action_executed: false };
    }
  }
  let sent;
  try {
    sent = await sendMessage({ threadId, hostId, prompt, idempotencyKey, lane, sourceThreadOnly });
  } catch (error) {
    const uncertain = uncertainSendError(error);
    const readback = uncertain
      ? await readbackAfterUncertainSend(readThread, { threadId, hostId: hostId ?? null, idempotencyKey })
      : null;
    const result = {
      schema: HOURLY_THREAD_DISPATCH_SCHEMA,
      status: uncertain && readback?.status === "observed" ? "sent" : uncertain ? "sent_unverified" : "failed",
      exact_blocker: readback?.status === "observed" ? null : text(error?.code ?? error?.message ?? error, 400) || "thread_send_failed",
      threadId,
      hostId: hostId ?? null,
      idempotencyKey,
      ...(readback ? { readback } : {}),
      replay_allowed: false,
      resume_trigger: uncertain
        ? "same-target readback for this idempotency key; do not resend while the intent is reserved"
        : null,
      external_action_executed: false,
    };
    return persistReceipt(recordReceipt, result);
  }
  const sentStatus = sendResultStatus(sent);
  if (sentStatus !== "accepted") {
    const uncertain = sentStatus === "unknown";
    const readback = uncertain
      ? await readbackAfterUncertainSend(readThread, { threadId, hostId: hostId ?? null, idempotencyKey })
      : null;
    return persistReceipt(recordReceipt, {
      schema: HOURLY_THREAD_DISPATCH_SCHEMA,
      status: uncertain && readback?.status === "observed" ? "sent" : uncertain ? "sent_unverified" : sentStatus,
      exact_blocker: readback?.status === "observed"
        ? null
        : text(readback?.exactBlocker, 400)
          || text(sent?.exact_blocker ?? sent?.exactBlocker ?? sent?.error, 400)
          || (uncertain ? "thread_send_result_unknown" : "thread_send_deferred"),
      threadId,
      hostId: hostId ?? null,
      idempotencyKey,
      sendResult: sent ?? null,
      ...(readback ? { readback } : {}),
      replay_allowed: false,
      resume_trigger: uncertain ? "same-target readback for this idempotency key; do not resend" : null,
      external_action_executed: false,
    });
  }
  let readback = null;
  if (typeof readThread === "function") {
    try { readback = await readThread({ threadId, hostId, idempotencyKey }); }
    catch (error) { readback = { isError: true, error: text(error?.message ?? error, 400) || "thread_readback_failed" }; }
  }
  const readbackResult = readbackStatus(readback, { idempotencyKey });
  const result = {
    schema: HOURLY_THREAD_DISPATCH_SCHEMA,
    status: readbackResult.status === "observed" ? "sent" : "sent_unverified",
    exact_blocker: readbackResult.exactBlocker,
    threadId,
    hostId: hostId ?? null,
    idempotencyKey,
    promptChars: prompt.length,
    sendResult: sent ?? null,
    readback: readbackResult,
    replay_allowed: false,
    resume_trigger: readbackResult.status === "observed"
      ? null
      : "same-target readback for this idempotency key; do not resend",
    external_action_executed: false,
  };
  return persistReceipt(recordReceipt, result);
}

export async function dispatchThreadContinuations({
  tasks = [],
  ...options
} = {}) {
  const seenKeys = new Set();
  const results = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    let result;
    try {
      const key = buildContinuationIdempotencyKey({
        task,
        auditFingerprint: options.auditFingerprint,
        generation: options.freshStatus?.generation ?? options.freshStatus?.runtimeGeneration ?? options.freshStatus?.runtime_generation,
        nextAction: options.nextAction,
      });
      if (seenKeys.has(key)) {
        result = { schema: HOURLY_THREAD_DISPATCH_SCHEMA, status: "duplicate_suppressed", threadId: threadIdOf(task), idempotencyKey: key, external_action_executed: false };
      } else {
        seenKeys.add(key);
        result = await dispatchThreadContinuation({ ...options, task });
      }
    } catch (error) {
      result = { schema: HOURLY_THREAD_DISPATCH_SCHEMA, status: "failed", exact_blocker: text(error?.message ?? error, 400) || "thread_dispatch_failed", threadId: threadIdOf(task), external_action_executed: false };
    }
    results.push(result);
  }
  return { schema: HOURLY_THREAD_DISPATCH_SCHEMA, status: "completed", attempted: results.length, results, external_action_executed: false };
}

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

const PRE_DISPATCH_NO_EFFECT_RETRY_SUFFIX = ":retry-no-effect";
const ACTIVE_BOUNDARY_RETRY_SUFFIX = ":retry-active-boundary";
const ACTIVE_EXECUTION_BOUNDARY_BLOCKER = "codex_app_thread_active_boundary_required";
const CONTINUATION_COMPLETION_WAIT_TIMEOUT_MS = 30_000;
const KNOWN_PRE_DISPATCH_NO_EFFECT_BLOCKERS = new Set([
  // Migration allowance for the 2026-09-05 node_repl callback failure. The
  // bridge now marks this boundary explicitly; this exact legacy value is
  // retained only so the already-recorded no-effect receipt can recover once.
  "process is not defined",
  // The detached worker failed while rejoining the existing task, before
  // turn/start was issued. The target task therefore has no new turn effect.
  "codex_app_server_protocol_error:thread/resume",
]);

function isKnownPreDispatchNoEffect(value) {
  return KNOWN_PRE_DISPATCH_NO_EFFECT_BLOCKERS.has(text(value, 400));
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
  const status = text(payload.status, 80) || null;
  const readback = payload.readback && typeof payload.readback === "object" ? payload.readback : null;
  const sendResult = payload.sendResult && typeof payload.sendResult === "object" ? payload.sendResult : null;
  const confirmedTurnIdBackfillAttempted = payload.confirmedTurnIdBackfillAttempted === true;
  const preDispatchNoEffect = payload.preDispatchNoEffect === true || payload.pre_dispatch_no_effect === true;
  const externalActionExecuted = payload.externalActionExecuted === true || payload.external_action_executed === true;
  const sendError = payload.sendError && typeof payload.sendError === "object" && !Array.isArray(payload.sendError)
    ? { message: text(payload.sendError.message, 300) }
    : null;
  const workerErrorSource = payload.completionWait?.result?.error
    ?? payload.completion_wait?.result?.error
    ?? payload.workerError
    ?? payload.worker_error;
  const workerError = workerErrorSource && typeof workerErrorSource === "object" && !Array.isArray(workerErrorSource)
    ? {
        ...(text(workerErrorSource.method, 120) ? { method: text(workerErrorSource.method, 120) } : {}),
        ...(text(workerErrorSource.code, 120) ? { code: text(workerErrorSource.code, 120) } : {}),
        ...(text(workerErrorSource.message, 300) ? { message: text(workerErrorSource.message, 300) } : {}),
      }
    : null;
  const workerJobId = text(payload.workerJobId ?? sendResult?.workerJobId ?? sendResult?.worker_job_id, 200) || null;
  const activeExecutionBoundary = payload.activeExecutionBoundary === true || payload.active_execution_boundary === true;
  const observedTurnId = text(payload.observedTurnId ?? payload.observed_turn_id, 200) || null;
  const confirmedProof = status === "sent"
    ? sameTaskCompletedTurnProof(readback, {
        idempotencyKey: payload.idempotencyKey,
        threadId: payload.threadId,
      }) ?? sameTaskMessageProof(readback, payload)
    : null;
  const confirmedAfterTurnId = confirmedProof?.afterTurnId ?? confirmedProof?.turnId ?? null;
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
    status,
    exactBlocker: text(payload.exact_blocker ?? payload.exactBlocker, 400) || null,
    externalActionExecuted,
    ...(preDispatchNoEffect ? { preDispatchNoEffect: true } : {}),
    ...((payload.retryOfIdempotencyKey ?? payload.retry_of_idempotency_key)
      ? { retryOfIdempotencyKey: text(payload.retryOfIdempotencyKey ?? payload.retry_of_idempotency_key, 240) }
      : {}),
    ...(sendError?.message ? { sendError } : {}),
    ...(workerError && Object.keys(workerError).length > 0 ? { workerError } : {}),
    ...(workerJobId ? { workerJobId } : {}),
    ...(activeExecutionBoundary ? { activeExecutionBoundary: true } : {}),
    ...(observedTurnId ? { observedTurnId } : {}),
    ...(confirmedProof ? { deliveryProof: confirmedProof } : {}),
    reconciliationAttempted: payload.reconciliationAttempted === true,
    ...(confirmedTurnIdBackfillAttempted ? { confirmedTurnIdBackfillAttempted: true } : {}),
    ...(confirmedAfterTurnId ? { lastConfirmedTurnId: confirmedAfterTurnId } : {}),
    goalStatus: readback?.goalStatus ?? "unknown",
    planStatus: readback?.planStatus ?? "unknown",
    goalReadback: readback?.goalReadback ?? "unknown",
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
// Delivery is a historical fact for one exact key/task, not a live Goal state.
// A later timeout or absent marker cannot erase an already observed message.
// Keep the latest work/Goal observation while retaining only valid bound proof.
function retainConfirmedDelivery(previous, latest) {
  if (!previous || !latest || previous.idempotencyKey !== latest.idempotencyKey || previous.threadId !== latest.threadId) return latest;
  const binding = { idempotencyKey: latest.idempotencyKey, threadId: latest.threadId };
  if (persistedDeliveryConfirmed(latest, binding) || !persistedDeliveryConfirmed(previous, binding)) return latest;
  const proof = sameTaskCompletedTurnProof(previous.readback ?? previous, binding)
    ?? sameTaskMessageProof(previous.readback ?? previous, binding);
  return { ...latest, status: "sent", latestObservationStatus: latest.status,
    deliveryProof: proof, lastConfirmedTurnId: proof.afterTurnId ?? proof.turnId };
}

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
  const confirmedThreadEntry = (threadId, currentTurnId, currentTurnStatus) => {
    if (!threadId || !currentTurnId) return null;
    // A prior message may have created a turn that was later interrupted.
    // That turn is not proof that the existing task/Goal actually resumed;
    // allow one fresh continuation at that explicit stopped boundary.  Keep
    // the conservative suppression rule when the status is missing or still
    // active, because those cases do not prove that a new action is safe.
    const stoppedStatuses = new Set(["interrupted", "failed", "cancelled", "canceled", "aborted"]);
    if (stoppedStatuses.has(text(currentTurnStatus, 80).toLowerCase())) return null;
    const entries = [];
    for (const dir of [receiptDir, reconciliationDir]) {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith(".json"))) {
        const value = readPrivateJson(path.join(dir, name));
        if (!value || String(value.threadId || "") !== String(threadId)) continue;
        if (value.status !== "sent" || !persistedDeliveryConfirmed(value, {
          idempotencyKey: value.idempotencyKey,
          threadId,
        })) continue;
        const proof = sameTaskCompletedTurnProof(value.readback ?? value, {
          idempotencyKey: value.idempotencyKey,
          threadId,
        }) ?? sameTaskMessageProof(value.readback ?? value, { idempotencyKey: value.idempotencyKey, threadId });
        if (!proof || String(proof.afterTurnId || proof.turnId || "") !== String(currentTurnId)) continue;
        entries.push(value);
      }
    }
    return entries.sort((left, right) => (Date.parse(right.recordedAt || "") || 0) - (Date.parse(left.recordedAt || "") || 0))[0] || null;
  };
  const unresolvedThreadEntry = (threadId, currentKey, currentTurnId = null, currentTurnStatus = null) => {
    if (!threadId) return null;
    const byKey = new Map();
    const rank = { intent: 0, receipt: 1, reconciliation: 2 };
    for (const [phase, dir] of [["intent", intentDir], ["receipt", receiptDir], ["reconciliation", reconciliationDir]]) {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith(".json"))) {
        const value = readPrivateJson(path.join(dir, name));
        if (!value || String(value.threadId || "") !== String(threadId)) continue;
        const key = text(value.idempotencyKey, 200);
        if (!key || key === String(currentKey || "")) continue;
        const previous = byKey.get(key);
        const recordedAt = Date.parse(value.recordedAt || "") || 0;
        if (!previous || rank[phase] > previous.rank || (rank[phase] === previous.rank && recordedAt >= previous.recordedAt)) {
          byKey.set(key, { ...retainConfirmedDelivery(previous, value), rank: rank[phase], recordedAt });
        } else {
          byKey.set(key, retainConfirmedDelivery(value, previous));
        }
      }
    }
    const entries = [...byKey.values()].sort((left, right) => right.recordedAt - left.recordedAt);
    if (entries.length === 0) return null;
    const activeBoundaryEntry = entries.find((entry) => entry.activeExecutionBoundary === true
      || text(entry.exactBlocker ?? entry.exact_blocker, 400) === ACTIVE_EXECUTION_BOUNDARY_BLOCKER);
    if (activeBoundaryEntry) {
      const observedTurnId = text(activeBoundaryEntry.observedTurnId ?? activeBoundaryEntry.observed_turn_id, 200);
      const freshTurnId = text(currentTurnId, 200);
      const freshStatus = text(currentTurnStatus, 80).toLowerCase();
      const turnChanged = Boolean(observedTurnId && freshTurnId && observedTurnId !== freshTurnId);
      const terminal = ["completed", "failed", "cancelled", "canceled", "aborted"].includes(freshStatus);
      // An active-writer response is a positive boundary signal, not an
      // unknown external effect. Suppress the same observed turn, but allow
      // a later turn or an explicitly terminal state to be evaluated again.
      if (!turnChanged && !terminal) return activeBoundaryEntry;
    }
    // There can be more than one unresolved key for a task after an earlier
    // controller run raced with App readback.  Prefer the newest key that is
    // still eligible for its one bounded reconciliation, rather than letting
    // a newer already-attempted key permanently hide an older key whose late
    // delivery marker may now be visible.  This is read-only and never
    // authorizes replay of either key.
    const eligible = entries.filter((entry) => {
      const status = String(entry.status || "");
      if (["sent_unverified", "intent_reserved"].includes(status)) {
        return entry.reconciliationAttempted !== true;
      }
      return status === "sent"
        && !persistedDeliveryConfirmed(entry, {
          idempotencyKey: entry.idempotencyKey,
          threadId,
        })
        && entry.confirmedTurnIdBackfillAttempted !== true;
    });
    if (eligible.length > 0) return eligible[0];
    const unresolved = [...entries].reverse().find((entry) => ["sent_unverified", "intent_reserved"].includes(String(entry.status || ""))
      || (String(entry.status || "") === "sent" && !persistedDeliveryConfirmed(entry, {
        idempotencyKey: entry.idempotencyKey,
        threadId,
      })));
    if (unresolved) return unresolved;
    return null;
  };
  const latestReconciliation = (key) => {
    if (!fs.existsSync(reconciliationDir)) return null;
    const prefix = `${keyDigest(key)}-`;
    const candidates = fs.readdirSync(reconciliationDir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
      .sort()
      .reverse();
    if (!candidates.length) return null;
    let observation = readPrivateJson(fileFor(receiptDir, key));
    for (const name of candidates.reverse()) observation = retainConfirmedDelivery(observation, readPrivateJson(path.join(reconciliationDir, name)));
    return observation;
  };
  return {
    root: ledgerRoot,
    runId: runSegment,
    scope: selectedScope,
    paths: { intentDir, receiptDir, reconciliationDir },
    listPending() {
      // Keep sent-but-unconfirmed tasks observable even after their original
      // error disappears from the current audit's candidate list.
      const latest = new Map();
      for (const dir of [intentDir, receiptDir, reconciliationDir]) {
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
          const value = readPrivateJson(path.join(dir, name));
          if (!value?.idempotencyKey || !value.threadId) continue;
          const previous = latest.get(value.idempotencyKey);
          latest.set(value.idempotencyKey, !previous || Date.parse(value.recordedAt) >= Date.parse(previous.recordedAt)
            ? retainConfirmedDelivery(previous, value) : retainConfirmedDelivery(value, previous));
        }
      }
      return [...latest.values()].filter((value) => value.phase === "intent"
        || ["sent_unverified", "intent_reserved"].includes(value.status)
        || value.status === "sent" && (value.goalStatus !== "complete" && value.goalReadback !== "absent" || !persistedDeliveryConfirmed(value, value)))
        .sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt))
        .map((value) => ({ threadId: value.threadId, hostId: value.hostId || "local",
          lane: value.lane, reconciliationOnly: true, priorIdempotencyKey: value.idempotencyKey }));
    },
    async alreadyDispatched({ idempotencyKey, threadId, currentTurnId, currentTurnStatus = null } = {}) {
      if (!idempotencyKey) return false;
      const receiptPath = fileFor(receiptDir, idempotencyKey);
      const intentPath = fileFor(intentDir, idempotencyKey);
      const receipt = existingLedgerFile(receiptPath) ? readPrivateJson(receiptPath) : null;
      const reconciliation = latestReconciliation(idempotencyKey);
      const latest = reconciliation || receipt;
      if (latest) {
        const status = text(latest.status, 80) || "sent_unverified";
        const activeBoundary = latest.activeExecutionBoundary === true
          || text(latest.exactBlocker ?? latest.exact_blocker, 400) === ACTIVE_EXECUTION_BOUNDARY_BLOCKER;
        if (activeBoundary) {
          const observedTurnId = text(latest.observedTurnId ?? latest.observed_turn_id, 200);
          const freshTurnId = text(currentTurnId, 200);
          const freshStatus = text(currentTurnStatus, 80).toLowerCase();
          const turnChanged = Boolean(observedTurnId && freshTurnId && observedTurnId !== freshTurnId);
          const terminal = ["completed", "failed", "cancelled", "canceled", "aborted"].includes(freshStatus);
          if (!turnChanged && !terminal) {
            return {
              seen: true,
              status,
              terminal: true,
              activeBoundary: true,
              exactBlocker: ACTIVE_EXECUTION_BOUNDARY_BLOCKER,
              receipt,
              reconciliation,
            };
          }
          return {
            seen: true,
            status,
            retryableActiveBoundary: true,
            activeBoundary: true,
            exactBlocker: ACTIVE_EXECUTION_BOUNDARY_BLOCKER,
            receipt,
            reconciliation,
          };
        }
        const retryableNoEffect = !String(idempotencyKey).endsWith(PRE_DISPATCH_NO_EFFECT_RETRY_SUFFIX)
          && status === "failed"
          && latest.externalActionExecuted !== true
          && (latest.preDispatchNoEffect === true
            || isKnownPreDispatchNoEffect(latest.exactBlocker ?? latest.exact_blocker));
        const strongDelivery = status === "sent" && persistedDeliveryConfirmed(latest, {
          idempotencyKey,
          threadId,
        });
        return {
          seen: true,
          status,
          terminal: !retryableNoEffect && (strongDelivery || status === "duplicate_suppressed"),
          ...(status === "sent" && !strongDelivery ? { needsDeliveryReconciliation: true } : {}),
          ...(retryableNoEffect ? { retryableNoEffect: true } : {}),
          receipt,
          reconciliation,
        };
      }
      const confirmed = confirmedThreadEntry(threadId ?? "", currentTurnId, currentTurnStatus);
      if (confirmed) {
        return {
          seen: true,
          terminal: true,
          status: "duplicate_suppressed",
          priorIdempotencyKey: confirmed.idempotencyKey,
          sameThreadConfirmedTurn: true,
        };
      }
      if (existingLedgerFile(intentPath)) {
        return { seen: true, reserved: true, status: "intent_reserved", intent: readPrivateJson(intentPath) };
      }
      const unresolved = unresolvedThreadEntry(threadId ?? "", idempotencyKey, currentTurnId, currentTurnStatus);
      if (unresolved) {
        const activeBoundary = unresolved.activeExecutionBoundary === true
          || text(unresolved.exactBlocker ?? unresolved.exact_blocker, 400) === ACTIVE_EXECUTION_BOUNDARY_BLOCKER;
        return {
          seen: true,
          unresolved: true,
          ...(activeBoundary ? { activeBoundary: true } : {}),
          status: "unresolved_prior_send",
          exactBlocker: activeBoundary ? ACTIVE_EXECUTION_BOUNDARY_BLOCKER : "thread_send_delivery_not_confirmed",
          priorIdempotencyKey: unresolved.idempotencyKey,
          reconciliationKey: unresolved.idempotencyKey,
          reconciliationAttempted: unresolved.reconciliationAttempted === true,
          needsTurnIdBackfill: unresolved.status === "sent" && !text(unresolved.lastConfirmedTurnId, 200),
          confirmedTurnIdBackfillAttempted: unresolved.confirmedTurnIdBackfillAttempted === true,
        };
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
    "After resolving and verifying the blocker in this task, a formally blocked Goal can be resumed through the current-task-only helper: in the official node_repl import /Users/nichikatanaka/Documents/Codex/automation-os/scripts/lib/codex-app-server-companion-bridge.mjs with a fresh query string, then call resumeCurrentTaskGoal({globals:globalThis, blockerResolved:true, verificationPassed:true}). It uses official thread/goal/get, status-only thread/goal/set, and readback; never create a missing Goal or lift paused/budgetLimited/usageLimited. Do not pass true unless the repair and verification actually succeeded.",
    "Required final state line: include one literal line in the final response, replacing the placeholders with actual values, for example `goal_plan_state=active exact_blocker=none` or `goal_plan_state=blocked exact_blocker=capability_missing`. Allowed goal_plan_state values are active, continued, in_progress, resumed, running, verified, blocked, and unknown. Use the state actually returned by the task's Goal/Plan readback; never report active when the Goal is blocked or the readback is missing.",
    ...(lane === "task_owned_companion_relay" ? [
      "Task-owned Companion relay: the scheduler cannot operate another task's Companion. This task is now the owner; perform the fresh Companion status/target/owner/effect readback and one bounded local repair in this thread, then verify the existing Goal/Plan before continuing.",
      "Use only the supported Companion surface and refresh at a fully idle/reconciled boundary. Do not adopt foreign resources, replay unknown effects, or bypass auth/OTP/CAPTCHA, provider, or target gates.",
    ] : []),
    `One next action now: ${action}`,
    "",
    proofLines.length ? `Verified evidence: ${proofLines.join("; ")}` : "Verified evidence: controller stage receipt only; business completion is not claimed.",
    stops.length ? `Stop conditions: ${stops.join("; ")}` : "Stop conditions: visible auth/OTP/CAPTCHA, foreign owner, unknown effect, or ambiguous target.",
    "After the action, read back the result and continue the existing task. Report the repair, verification, formal Goal state, and next concrete action in this same task. Do not replay an unknown external effect or resume a human-only Goal or one whose blocker remains.",
  ];
  return lines.join("\n").slice(0, MAX_MESSAGE_CHARS);
}

function sendResultStatus(value) {
  if (value === undefined || value === null) return "unknown";
  if (typeof value !== "object") return "unknown";
  if (value.isError === true || value.ok === false || value.success === false || value.status === "failed") return "failed";
  const status = String(value.status ?? "").trim().toLowerCase();
  if (["deferred", "blocked"].includes(status)) return "deferred";
  if (["unknown", "sent_unverified", "send_result_unknown", "unknown_result"].includes(status)) return "unknown";
  // A send callback is accepted only when it reports the transport outcome
  // explicitly.  A matching idempotency key or an arbitrary `{ ok: true }`
  // envelope is metadata, not proof that the message was accepted by the
  // destination thread.
  if (["accepted", "sent", "queued"].includes(status)) return "accepted";
  return "unknown";
}

function hasMatchingContinuationMarker(value, expected, seen = new Set(), trusted = false) {
  if (!expected || value === null || value === undefined) return false;
  if (typeof value === "string") return trusted && value.includes(`continuation_key=${String(expected)}`);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasMatchingContinuationMarker(item, expected, seen, trusted));
  const trustedKeys = new Set([
    "content", "turns", "turn", "items", "messages", "message", "text", "output",
    "functionCallOutput", "function_call_output", "userMessage", "assistantMessage",
    "input", "prompt",
  ]);
  return Object.entries(value).some(([key, nested]) => hasMatchingContinuationMarker(
    nested,
    expected,
    seen,
    trusted || trustedKeys.has(key),
  ));
}

function goalPlanStateOf(value, seen = new Set()) {
  if (value === null || value === undefined) return null;
  // A quoted prompt or assistant claim is not a formal Goal readback.
  if (typeof value === "string") return null;
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
    const recursive = ["result", "readback", "structuredContent"].includes(key)
      ? goalPlanStateOf(nested, seen) : null;
    if (recursive) return recursive;
  }
  return null;
}

function boundedProofText(value, max = 200) {
  return text(value, max);
}

function completedTurnId(value) {
  if (!value || typeof value !== "object") return null;
  const status = String(value.status ?? value.turnStatus ?? value.turn_status ?? "").toLowerCase();
  if (!["completed", "complete", "done", "succeeded"].includes(status)) return null;
  return boundedProofText(
    value.turnId
      ?? value.turn_id
      ?? value.result?.turnId
      ?? value.result?.turn_id,
    200,
  ) || null;
}

function sameTaskCompletedTurnProof(value, { idempotencyKey = null, threadId = null } = {}) {
  const proof = value?.transportDeliveryProof
    ?? value?.transport_delivery_proof
    ?? value?.deliveryProof
    ?? value?.delivery_proof;
  if (!proof || typeof proof !== "object" || Array.isArray(proof)) return null;
  if (proof.kind !== "same_task_new_turn_completed") return null;
  if (String(proof.idempotencyKey ?? proof.idempotency_key ?? "") !== String(idempotencyKey ?? "")) return null;
  if (threadId && String(proof.threadId ?? proof.thread_id ?? "") !== String(threadId)) return null;
  if (proof.sendResultStatus !== "accepted" && proof.send_result_status !== "accepted") return null;
  const beforeTurnId = boundedProofText(proof.beforeTurnId ?? proof.before_turn_id, 200);
  const afterTurnId = boundedProofText(proof.afterTurnId ?? proof.after_turn_id, 200);
  if (!beforeTurnId || !afterTurnId || beforeTurnId === afterTurnId) return null;
  if (proof.afterTurnStatus !== "completed" && proof.after_turn_status !== "completed") return null;
  if (proof.sameTask === false || proof.same_task === false) return null;
  return {
    kind: "same_task_new_turn_completed",
    threadId: boundedProofText(proof.threadId ?? proof.thread_id, 200) || null,
    idempotencyKey: boundedProofText(proof.idempotencyKey ?? proof.idempotency_key, 200) || null,
    sendResultStatus: "accepted",
    beforeTurnId,
    afterTurnId,
    afterTurnStatus: "completed",
    sameTask: true,
    markerVisible: proof.markerVisible === true || proof.marker_visible === true,
  };
}

function persistedDeliveryConfirmed(value, { idempotencyKey = null, threadId = null } = {}) {
  if (!value || typeof value !== "object") return false;
  const readback = value.readback && typeof value.readback === "object" ? value.readback : value;
  return Boolean(normalizeConfirmedDeliveryProof(readback, { idempotencyKey, threadId }));
}

export function normalizeConfirmedDeliveryProof(value, binding = {}) {
  return sameTaskCompletedTurnProof(value, binding) || sameTaskMessageProof(value, binding);
}

function sameTaskMessageProof(value, { idempotencyKey, threadId } = {}) {
  const proof = value?.transportDeliveryProof ?? value?.deliveryProof;
  if (proof?.kind !== "same_task_message_observed" || proof.markerVisible !== true || proof.sameTask !== true
    || proof.idempotencyKey !== idempotencyKey || proof.threadId !== threadId
    || !text(proof.turnId, 200)
    || !["completed", "interrupted", "failed", "inProgress"].includes(proof.turnStatus)) return null;
  return { kind: proof.kind, idempotencyKey, threadId, turnId: proof.turnId,
    turnStatus: proof.turnStatus, markerVisible: true, sameTask: true };
}

function readbackStatus(value, {
  idempotencyKey = null,
  threadId = null,
  expectedAfterTurnId = null,
  requireFreshTurn = false,
} = {}) {
  if (value === undefined || value === null) return { status: "unavailable", exactBlocker: "thread_readback_not_supplied" };
  if (value?.isError === true || value?.ok === false || value?.success === false) {
    return { status: "unavailable", exactBlocker: text(value?.exact_blocker ?? value?.exactBlocker ?? value?.error, 300) || "thread_readback_failed" };
  }
  const goalPlanState = goalPlanStateOf(value);
  const transportProof = sameTaskCompletedTurnProof(value, { idempotencyKey, threadId })
    ?? sameTaskMessageProof(value, { idempotencyKey, threadId });
  const latestTurnId = boundedProofText(
    value?.latestTurnId
      ?? value?.latest_turn_id
      ?? value?.continuationTurnId
      ?? value?.continuation_turn_id,
    200,
  );
  const freshTurnReadback = !requireFreshTurn
    || Boolean(transportProof)
    || Boolean(expectedAfterTurnId && latestTurnId && latestTurnId === expectedAfterTurnId);
  const deliveryConfirmed = freshTurnReadback && (
    value?.deliveryConfirmed === true
      || value?.delivery_confirmed === true
      || value?.messageDelivered === true
      || value?.message_delivered === true
      || value?.continuationDelivered === true
      || value?.continuation_delivered === true
      || value?.readbackVerified === true && Boolean(value?.continuationTurnId ?? value?.continuation_turn_id ?? value?.messageId ?? value?.message_id)
      || value?.readback?.deliveryConfirmed === true
      || value?.readback?.delivery_confirmed === true
      || hasMatchingContinuationMarker(value, idempotencyKey)
      || Boolean(transportProof)
  );
  return deliveryConfirmed
    ? {
        status: "observed",
        exactBlocker: null,
        ...(latestTurnId ? { latestTurnId } : {}),
        ...(transportProof ? { deliveryProof: transportProof } : {}),
        ...(goalPlanState ? { goalPlanState } : {}),
        goalStatus: value.goalStatus ?? "unknown",
        planStatus: value.planStatus ?? "unknown",
        latestTurnStatus: value.latestTurnStatus ?? "unknown",
        goalStateSource: value.goalStateSource ?? "unknown",
        goalReadback: value.goalReadback ?? "unknown",
      }
    : { status: "unavailable", exactBlocker: "thread_send_delivery_not_confirmed", ...(goalPlanState ? { goalPlanState } : {}),
        goalStatus: value.goalStatus ?? "unknown", planStatus: value.planStatus ?? "unknown",
        goalReadback: value.goalReadback ?? "unknown", goalStateSource: value.goalStateSource ?? "unknown",
        latestTurnStatus: value.latestTurnStatus ?? "unknown" };
}

function transportDeliveryProof(sent, readback, {
  idempotencyKey,
  threadId,
  expectedAfterTurnId = null,
  requireFreshTurn = false,
} = {}) {
  if (!sent || !readback || typeof readback !== "object") return null;
  const beforeTurnId = boundedProofText(sent.beforeTurnId ?? sent.before_turn_id, 200);
  const afterTurnId = boundedProofText(
    expectedAfterTurnId
      ?? sent.afterTurnId
      ?? sent.after_turn_id
      ?? readback.latestTurnId
      ?? readback.latest_turn_id,
    200,
  );
  const observedLatestTurnId = boundedProofText(readback.latestTurnId ?? readback.latest_turn_id, 200);
  const afterTurnStatus = String(
    readback.latestTurnStatus
      ?? readback.latest_turn_status
      ?? sent.afterLatestTurnStatus
      ?? sent.after_latest_turn_status
      ?? "",
  ).toLowerCase();
  const safetyText = JSON.stringify(readback).toLowerCase();
  if (!beforeTurnId || !afterTurnId || beforeTurnId === afterTurnId
    || !["completed", "complete", "done", "succeeded"].includes(afterTurnStatus)
    || readback.sameTask === false || readback.same_task === false
    || (requireFreshTurn && (!expectedAfterTurnId || !observedLatestTurnId || observedLatestTurnId !== expectedAfterTurnId))
    || /(?:unknown[_ -]?effect|foreign[_ -]?owner|target[_ -]?mismatch|active[_ -]?reconciliation|captcha|otp|human[_ -]?auth|provider[_ -]?(?:limit|quota))/u.test(safetyText)) return null;
  return {
    schema: "aos.continuation_transport_delivery_proof.v1",
    kind: "same_task_new_turn_completed",
    threadId,
    idempotencyKey,
    sendResultStatus: "accepted",
    beforeTurnId,
    afterTurnId,
    afterTurnStatus: "completed",
    sameTask: true,
    markerVisible: hasMatchingContinuationMarker(readback, idempotencyKey),
  };
}

function uncertainSendError(error) {
  const code = text(error?.code, 120).toLowerCase();
  const message = text(error?.message ?? error, 400).toLowerCase();
  return /(?:timeout|timed[_ -]?out|disconnect|disconnected|unknown[_ -]?effect|connection[_ -]?reset|no[_ -]?response)/u.test(`${code} ${message}`);
}

function activeExecutionBoundaryError(error) {
  const code = text(error?.code ?? error?.exact_blocker ?? error?.exactBlocker, 160);
  const message = text(error?.details?.message ?? error?.message ?? error, 400);
  return code === ACTIVE_EXECUTION_BOUNDARY_BLOCKER
    || /already has an active writer|active writer already exists|thread is busy/iu.test(message);
}

function workerPreDispatchNoEffect(completionWait) {
  if (!completionWait || typeof completionWait !== "object") return false;
  const result = completionWait.result && typeof completionWait.result === "object" ? completionWait.result : null;
  if (completionWait.preDispatchNoEffect === true || completionWait.pre_dispatch_no_effect === true
    || result?.preDispatchNoEffect === true || result?.pre_dispatch_no_effect === true) return true;
  const exactBlocker = text(result?.exactBlocker ?? result?.exact_blocker ?? completionWait.exact_blocker, 400);
  return completionWait.status === "failed"
    && !text(completionWait.turnId ?? completionWait.turn_id ?? result?.turnId ?? result?.turn_id, 200)
    && exactBlocker === "codex_app_server_protocol_error:thread/resume";
}

function workerActiveExecutionBoundary(completionWait) {
  if (!completionWait || typeof completionWait !== "object") return false;
  const result = completionWait.result && typeof completionWait.result === "object" ? completionWait.result : null;
  const code = text(result?.exactBlocker ?? result?.exact_blocker ?? completionWait.exact_blocker, 400);
  const error = result?.error && typeof result.error === "object" ? result.error : null;
  const message = text(error?.message ?? completionWait?.message, 400);
  return completionWait.activeExecutionBoundary === true
    || completionWait.active_execution_boundary === true
    || result?.activeExecutionBoundary === true
    || result?.active_execution_boundary === true
    || code === ACTIVE_EXECUTION_BOUNDARY_BLOCKER
    || /already has an active writer|active writer already exists|thread is busy/iu.test(message);
}

function workerNeedsFreshBoundaryReadback(completionWait) {
  if (!completionWait || typeof completionWait !== "object") return false;
  const result = completionWait.result && typeof completionWait.result === "object" ? completionWait.result : null;
  const exactBlocker = text(result?.exactBlocker ?? result?.exact_blocker ?? completionWait.exact_blocker, 400);
  if (exactBlocker !== "codex_app_server_protocol_error:thread/resume") return false;
  // Older detached workers persisted only the method-level blocker and lost
  // the server's active-writer detail.  A fresh same-task read is the only
  // safe way to distinguish that race from another pre-dispatch protocol
  // failure; it is read-only and never replays the reserved message.
  return !result?.error || typeof result.error !== "object"
    || !text(result.error.message ?? result.error.code ?? result.error.method, 300);
}

async function freshActiveBoundary(readThread, { threadId, hostId, completionWait } = {}) {
  if (!workerNeedsFreshBoundaryReadback(completionWait)) return null;
  if (typeof readThread !== "function") return null;
  try {
    const readback = await readThread({
      threadId,
      hostId,
      reason: "active_boundary_recheck_after_thread_resume_no_effect",
    });
    const taskStatus = text(readback?.status ?? readback?.taskStatus, 80).toLowerCase();
    const latestTurnStatus = text(readback?.latestTurnStatus ?? readback?.latest_turn_status, 80).toLowerCase();
    if (taskStatus !== "active" && latestTurnStatus !== "inprogress") return null;
    return {
      readback,
      observedTurnId: text(readback?.latestTurnId ?? readback?.latest_turn_id, 200) || null,
    };
  } catch {
    return null;
  }
}

function workerPreDispatchBlocker(completionWait) {
  const result = completionWait?.result && typeof completionWait.result === "object" ? completionWait.result : null;
  return text(result?.exactBlocker ?? result?.exact_blocker ?? completionWait?.exact_blocker, 400)
    || "continuation_worker_pre_dispatch_failed";
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

async function readbackAfterUncertainSend(readThread, {
  threadId,
  hostId,
  idempotencyKey,
  expectedAfterTurnId = null,
  requireFreshTurn = true,
  priorDeliveryProof = null,
} = {}) {
  if (typeof readThread !== "function") return { status: "unavailable", exactBlocker: "thread_readback_callback_required" };
  try {
    return readbackStatus(
      await readThread({ threadId, hostId, idempotencyKey, priorDeliveryProof, reason: "uncertain_send_no_replay" }),
      { idempotencyKey, threadId, expectedAfterTurnId, requireFreshTurn },
    );
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
  waitForCompletion = null,
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
  let idempotencyKey = task?.reconciliationOnly && task?.priorIdempotencyKey
    ? text(task.priorIdempotencyKey, 200) : buildContinuationIdempotencyKey({
    task,
    auditFingerprint,
    generation: freshStatus?.generation ?? freshStatus?.runtimeGeneration ?? freshStatus?.runtime_generation,
    nextAction,
  });
  let retryOfIdempotencyKey = null;
  if (typeof alreadyDispatched === "function") {
    let seen = false;
    const currentTurnId = task?.latestTurnId ?? task?.latest_turn_id ?? null;
    const currentTurnStatus = task?.latestTurnStatus
      ?? task?.latest_turn_status
      ?? task?.officialLatestTurnStatus
      ?? task?.official_latest_turn_status
      ?? null;
    try { seen = await alreadyDispatched({ task, threadId, idempotencyKey, currentTurnId, currentTurnStatus }); }
    catch (error) {
      return { schema: HOURLY_THREAD_DISPATCH_SCHEMA, status: "deferred", exact_blocker: text(error?.message ?? error, 400) || "thread_dispatch_dedupe_lookup_failed", threadId, idempotencyKey, external_action_executed: false };
    }
    if (seen?.retryableNoEffect === true) {
      const baseIdempotencyKey = idempotencyKey;
      const retryKey = `${baseIdempotencyKey}${PRE_DISPATCH_NO_EFFECT_RETRY_SUFFIX}`;
      let retrySeen = false;
      try {
        retrySeen = await alreadyDispatched({ task, threadId, idempotencyKey: retryKey, currentTurnId, currentTurnStatus });
      } catch (error) {
        return {
          schema: HOURLY_THREAD_DISPATCH_SCHEMA,
          status: "deferred",
          exact_blocker: text(error?.message ?? error, 400) || "thread_dispatch_dedupe_lookup_failed",
          threadId,
          idempotencyKey: retryKey,
          retry_of_idempotency_key: baseIdempotencyKey,
          external_action_executed: false,
        };
      }
      idempotencyKey = retryKey;
      retryOfIdempotencyKey = baseIdempotencyKey;
      // The retry key is subject to the normal reconciliation/suppression
      // rules, but cannot create another retry key.
      seen = retrySeen;
    }
    if (seen?.retryableActiveBoundary === true) {
      const baseIdempotencyKey = idempotencyKey;
      const retryKey = `${baseIdempotencyKey}${ACTIVE_BOUNDARY_RETRY_SUFFIX}`;
      let retrySeen = false;
      try {
        retrySeen = await alreadyDispatched({ task, threadId, idempotencyKey: retryKey, currentTurnId, currentTurnStatus });
      } catch (error) {
        return {
          schema: HOURLY_THREAD_DISPATCH_SCHEMA,
          status: "deferred",
          exact_blocker: text(error?.message ?? error, 400) || "thread_dispatch_dedupe_lookup_failed",
          threadId,
          idempotencyKey: retryKey,
          retry_of_idempotency_key: baseIdempotencyKey,
          external_action_executed: false,
        };
      }
      idempotencyKey = retryKey;
      retryOfIdempotencyKey = baseIdempotencyKey;
      seen = retrySeen;
    }
    const reconciliationKey = text(seen?.reconciliationKey ?? seen?.priorIdempotencyKey, 200) || idempotencyKey;
    const canReconcile = typeof readThread === "function"
      && seen
      && typeof seen === "object"
      && (!seen?.terminal || task?.reconciliationOnly === true && seen.status === "sent")
      && (
        task?.reconciliationOnly === true && seen.status === "sent"
        || ["sent_unverified", "intent_reserved"].includes(String(seen.status || ""))
        || (seen?.unresolved === true && reconciliationKey !== idempotencyKey)
        || seen?.needsDeliveryReconciliation === true
      );
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
      let completionWait = null;
      if (typeof waitForCompletion === "function") {
        try {
          completionWait = await waitForCompletion({
            threadId,
            hostId,
            idempotencyKey: reconciliationKey,
            timeoutMs: CONTINUATION_COMPLETION_WAIT_TIMEOUT_MS,
            reason: "uncertain_send_reconciliation_no_replay",
          });
        } catch (error) {
          completionWait = {
            status: "timeout",
            exact_blocker: text(error?.code ?? error?.message ?? error, 400) || "thread_completion_wait_timeout",
          };
        }
      }
      if (workerPreDispatchNoEffect(completionWait)) {
        const boundary = workerActiveExecutionBoundary(completionWait)
          ? { readback: null, observedTurnId: null }
          : await freshActiveBoundary(readThread, { threadId, hostId, completionWait });
        if (boundary) {
          const result = {
            schema: HOURLY_THREAD_DISPATCH_SCHEMA,
            status: "deferred",
            exact_blocker: ACTIVE_EXECUTION_BOUNDARY_BLOCKER,
            threadId,
            hostId,
            idempotencyKey: reconciliationKey,
            ...(retryOfIdempotencyKey ? { retry_of_idempotency_key: retryOfIdempotencyKey } : {}),
            ...(completionWait ? { completionWait } : {}),
            active_execution_boundary: true,
            observed_turn_id: boundary.observedTurnId
              || text(task?.latestTurnId ?? task?.latest_turn_id, 200)
              || null,
            reconciliationAttempted: true,
            pre_dispatch_no_effect: true,
            replay_allowed: false,
            resume_trigger: "fresh same-task readback after the current turn reaches a terminal boundary; do not resend while active",
            external_action_executed: false,
            reconciliation_of: seen.status,
            ...(boundary.readback ? { boundaryReadback: boundary.readback } : {}),
          };
          return persistReconciliation(recordReconciliation, result);
        }
        const result = {
          schema: HOURLY_THREAD_DISPATCH_SCHEMA,
          status: "failed",
          exact_blocker: workerPreDispatchBlocker(completionWait),
          threadId,
          hostId,
          idempotencyKey: reconciliationKey,
          ...(retryOfIdempotencyKey ? { retry_of_idempotency_key: retryOfIdempotencyKey } : {}),
          ...(completionWait ? { completionWait } : {}),
          reconciliationAttempted: true,
          pre_dispatch_no_effect: true,
          replay_allowed: false,
          resume_trigger: "retry once with the deterministic no-effect retry key after the task reaches an idle boundary; do not duplicate an unknown effect",
          external_action_executed: false,
          reconciliation_of: seen.status,
        };
        return persistReconciliation(recordReconciliation, result);
      }
      const readback = await readbackAfterUncertainSend(readThread, {
        threadId,
        hostId,
        idempotencyKey: reconciliationKey,
        priorDeliveryProof: seen?.reconciliation?.deliveryProof ?? seen?.receipt?.deliveryProof ?? null,
        expectedAfterTurnId: completedTurnId(completionWait)
          ?? completedTurnId(seen?.receipt ?? seen?.reconciliation)
          ?? boundedProofText(
            seen?.receipt?.sendResult?.afterTurnId
              ?? seen?.receipt?.sendResult?.after_turn_id
              ?? seen?.reconciliation?.sendResult?.afterTurnId
              ?? seen?.reconciliation?.sendResult?.after_turn_id,
            200,
          ),
        requireFreshTurn: true,
      });
      const result = {
        schema: HOURLY_THREAD_DISPATCH_SCHEMA,
        status: readback.status === "observed" ? "sent" : "sent_unverified",
        exact_blocker: readback.status === "observed" ? null : readback.exactBlocker || "thread_send_result_unknown",
        threadId,
        hostId,
        idempotencyKey: reconciliationKey,
        ...(retryOfIdempotencyKey ? { retry_of_idempotency_key: retryOfIdempotencyKey } : {}),
        readback,
        ...(completionWait ? { completionWait } : {}),
        reconciliationAttempted: true,
        ...(seen?.needsTurnIdBackfill === true ? { confirmedTurnIdBackfillAttempted: true } : {}),
        replay_allowed: false,
        resume_trigger: readback.status === "observed" ? null : "same-target readback for this idempotency key; do not resend",
        external_action_executed: false,
        reconciliation_of: seen.status,
      };
      return persistReconciliation(recordReconciliation, result);
    }
    if (seen?.unresolved === true) {
      return {
        schema: HOURLY_THREAD_DISPATCH_SCHEMA,
        status: "deferred",
        exact_blocker: text(seen.exactBlocker ?? seen.exact_blocker, 400) || "thread_send_delivery_not_confirmed",
        threadId,
        idempotencyKey,
        ...(retryOfIdempotencyKey ? { retry_of_idempotency_key: retryOfIdempotencyKey } : {}),
        prior_idempotency_key: text(seen.priorIdempotencyKey ?? seen.prior_idempotency_key, 200) || null,
        replay_allowed: false,
        resume_trigger: "reconcile the prior idempotency key before creating a new same-task continuation; do not resend",
        external_action_executed: false,
      };
    }
    if (seen === true || seen?.seen === true || seen?.reserved === true || seen?.terminal === true || ["sent", "duplicate_suppressed"].includes(seen?.status)) {
      return {
        schema: HOURLY_THREAD_DISPATCH_SCHEMA,
        status: "duplicate_suppressed",
        threadId,
        idempotencyKey,
        ...(retryOfIdempotencyKey ? { retry_of_idempotency_key: retryOfIdempotencyKey } : {}),
        external_action_executed: false,
      };
    }
  }
  if (task?.reconciliationOnly === true) {
    return { schema: HOURLY_THREAD_DISPATCH_SCHEMA, status: "deferred", threadId,
      idempotencyKey, exact_blocker: "prior_dispatch_readback_required", external_action_executed: false };
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
        ...(retryOfIdempotencyKey ? { retryOfIdempotencyKey } : {}),
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
    sent = await sendMessage({
      threadId,
      hostId,
      cwd: task?.cwd ?? task?.workdir ?? null,
      prompt,
      idempotencyKey,
      lane,
      sourceThreadOnly,
    });
  } catch (error) {
    const uncertain = uncertainSendError(error);
    const activeBoundary = activeExecutionBoundaryError(error);
    const preDispatchNoEffect = error?.preDispatchNoEffect === true || error?.pre_dispatch_no_effect === true;
    const readback = uncertain
      ? await readbackAfterUncertainSend(readThread, { threadId, hostId: hostId ?? null, idempotencyKey })
      : null;
    const sendErrorDetails = error?.details && typeof error.details === "object" && !Array.isArray(error.details)
      ? { message: text(error.details.message, 300) }
      : null;
    const result = {
      schema: HOURLY_THREAD_DISPATCH_SCHEMA,
      status: activeBoundary ? "deferred" : uncertain && readback?.status === "observed" ? "sent" : uncertain ? "sent_unverified" : "failed",
      exact_blocker: activeBoundary
        ? ACTIVE_EXECUTION_BOUNDARY_BLOCKER
        : readback?.status === "observed" ? null : text(error?.code ?? error?.message ?? error, 400) || "thread_send_failed",
      threadId,
      hostId: hostId ?? null,
      idempotencyKey,
      ...(retryOfIdempotencyKey ? { retry_of_idempotency_key: retryOfIdempotencyKey } : {}),
      ...(preDispatchNoEffect ? { pre_dispatch_no_effect: true } : {}),
      ...(activeBoundary ? {
        active_execution_boundary: true,
        observed_turn_id: text(task?.latestTurnId ?? task?.latest_turn_id, 200) || null,
      } : {}),
      ...(sendErrorDetails?.message ? { sendError: sendErrorDetails } : {}),
      ...(readback ? { readback } : {}),
      replay_allowed: false,
      resume_trigger: activeBoundary
        ? "fresh same-task readback after the current turn reaches a terminal boundary; do not resend while active"
        : uncertain
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
      ...(retryOfIdempotencyKey ? { retry_of_idempotency_key: retryOfIdempotencyKey } : {}),
      sendResult: sent ?? null,
      ...(readback ? { readback } : {}),
      replay_allowed: false,
      resume_trigger: uncertain ? "same-target readback for this idempotency key; do not resend" : null,
      external_action_executed: false,
    });
  }
  let completionWait = null;
  const sentMayStillRun = sentStatus === "accepted" && (
    String(sent?.afterLatestTurnStatus ?? sent?.after_latest_turn_status ?? "").toLowerCase() === "inprogress"
    || String(sent?.afterStatus ?? sent?.after_status ?? "").toLowerCase() === "active"
    || (String(sent?.afterTurnId ?? sent?.after_turn_id ?? "")
      && String(sent?.beforeTurnId ?? sent?.before_turn_id ?? "")
      && String(sent.afterTurnId ?? sent.after_turn_id) !== String(sent.beforeTurnId ?? sent.before_turn_id)
      && !["completed", "complete", "done", "succeeded", "failed"].includes(
        String(sent?.afterLatestTurnStatus ?? sent?.after_latest_turn_status ?? "").toLowerCase(),
      ))
  );
  if (sentMayStillRun && typeof waitForCompletion === "function") {
    try {
      completionWait = await waitForCompletion({
        threadId,
        hostId,
        idempotencyKey,
        turnId: sent?.afterTurnId ?? sent?.after_turn_id ?? null,
        timeoutMs: CONTINUATION_COMPLETION_WAIT_TIMEOUT_MS,
      });
    } catch (error) {
      completionWait = {
        status: "timeout",
        exact_blocker: text(error?.code ?? error?.message ?? error, 400) || "thread_completion_wait_timeout",
      };
    }
  }
  if (workerPreDispatchNoEffect(completionWait)) {
    const boundary = workerActiveExecutionBoundary(completionWait)
      ? { readback: null, observedTurnId: null }
      : await freshActiveBoundary(readThread, { threadId, hostId, completionWait });
    if (boundary) {
      return persistReceipt(recordReceipt, {
        schema: HOURLY_THREAD_DISPATCH_SCHEMA,
        status: "deferred",
        exact_blocker: ACTIVE_EXECUTION_BOUNDARY_BLOCKER,
        threadId,
        hostId,
        idempotencyKey,
        ...(retryOfIdempotencyKey ? { retry_of_idempotency_key: retryOfIdempotencyKey } : {}),
        sendResult: sent ?? null,
        ...(completionWait ? { completionWait } : {}),
        active_execution_boundary: true,
        observed_turn_id: boundary.observedTurnId
          || text(task?.latestTurnId ?? task?.latest_turn_id, 200)
          || null,
        pre_dispatch_no_effect: true,
        replay_allowed: false,
        resume_trigger: "fresh same-task readback after the current turn reaches a terminal boundary; do not resend while active",
        external_action_executed: false,
        ...(boundary.readback ? { boundaryReadback: boundary.readback } : {}),
      });
    }
    return persistReceipt(recordReceipt, {
      schema: HOURLY_THREAD_DISPATCH_SCHEMA,
      status: "failed",
      exact_blocker: workerPreDispatchBlocker(completionWait),
      threadId,
      hostId: hostId ?? null,
      idempotencyKey,
      ...(retryOfIdempotencyKey ? { retry_of_idempotency_key: retryOfIdempotencyKey } : {}),
      sendResult: sent ?? null,
      ...(completionWait ? { completionWait } : {}),
      pre_dispatch_no_effect: true,
      replay_allowed: false,
      resume_trigger: "retry once with the deterministic no-effect retry key after the task reaches an idle boundary; do not duplicate an unknown effect",
      external_action_executed: false,
    });
  }
  let readback = null;
  if (typeof readThread === "function") {
    try { readback = await readThread({ threadId, hostId, idempotencyKey }); }
    catch (error) { readback = { isError: true, error: text(error?.message ?? error, 400) || "thread_readback_failed" }; }
  }
  const expectedAfterTurnId = completedTurnId(completionWait)
    ?? boundedProofText(sent?.afterTurnId ?? sent?.after_turn_id, 200);
  const requireFreshTurn = Boolean(
    sent?.beforeTurnId
      ?? sent?.before_turn_id
      ?? sent?.afterTurnId
      ?? sent?.after_turn_id
      ?? completionWait,
  );
  const deliveryProof = transportDeliveryProof(sent, readback, {
    idempotencyKey,
    threadId,
    expectedAfterTurnId,
    requireFreshTurn,
  });
  if (deliveryProof) readback = { ...readback, transportDeliveryProof: deliveryProof };
  const readbackResult = readbackStatus(readback, {
    idempotencyKey,
    threadId,
    expectedAfterTurnId,
    requireFreshTurn,
  });
  const result = {
    schema: HOURLY_THREAD_DISPATCH_SCHEMA,
    status: readbackResult.status === "observed" ? "sent" : "sent_unverified",
    exact_blocker: readbackResult.exactBlocker,
    threadId,
    hostId: hostId ?? null,
    idempotencyKey,
    ...(retryOfIdempotencyKey ? { retry_of_idempotency_key: retryOfIdempotencyKey } : {}),
    promptChars: prompt.length,
    sendResult: sent ?? null,
    ...(completionWait ? { completionWait } : {}),
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

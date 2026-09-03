import crypto from "node:crypto";
import fs from "node:fs";

export const THREAD_READBACK_PROJECTION_SCHEMA = "aos.codex_app_thread_readback_projection.v2";
export const THREAD_READBACK_PROJECTION_VERSION = 2;
// A full official-App page can contain dozens of user-owned tasks.  The
// projection remains field-allowlisted and record-bounded, but 64 KiB was
// smaller than the valid 54-lightweight/50-deep-read envelope and caused a
// false startup blocker before the Runner could inspect it.
export const THREAD_READBACK_PROJECTION_MAX_BYTES = 128 * 1024;
export const THREAD_READBACK_PROJECTION_MAX_RECORDS = 128;
export const THREAD_READBACK_PROJECTION_MAX_DEEP_READS = 50;

const ROOT_KEYS = new Set([
  "schema",
  "version",
  "automationId",
  "rootRunId",
  "childAuditId",
  "producedAt",
  "projectionDigest",
  "limits",
  "counts",
  "records",
]);
const LIMIT_KEYS = new Set(["maxRecords", "maxDeepReads", "listTruncated"]);
const COUNT_KEYS = new Set([
  "listAttempted",
  "listSucceeded",
  "lightweightRequested",
  "lightweightSucceeded",
  "lightweightFailed",
  "deepCandidates",
  "deepAttempted",
  "deepSucceeded",
  "deepFailed",
]);
const RECORD_KEYS = new Set([
  "alias",
  "readClass",
  "outcome",
  "deepAttempted",
  "deepSucceeded",
  "deepFailed",
  "state",
]);
const STATE_KEYS = new Set([
  "taskStatus",
  "latestTurnStatus",
  "goalStatus",
  "planStatus",
  "owner",
  "userOwned",
  "actionable",
  "stalled",
  "changed",
  "revision",
  "updatedAt",
  "generation",
  "exactBlocker",
  "softAnomalyTypes",
]);
const READ_CLASSES = new Set(["lightweight", "deep"]);
const OUTCOMES = new Set(["success", "bounded_error"]);
const OPAQUE_ALIAS_PATTERN = /^t-[a-f0-9]{24}$/u;
const TASK_STATUSES = new Set(["active", "idle", "notLoaded", "completed", "blocked", "failed", "interrupted", "unknown"]);
const TURN_STATUSES = new Set(["inProgress", "completed", "failed", "interrupted", "unknown"]);
const GOAL_STATUSES = new Set(["active", "blocked", "complete", "unknown"]);
const PLAN_STATUSES = new Set(["active", "blocked", "complete", "unknown"]);
const OWNERS = new Set(["user", "automation", "agent", "foreign", "unknown"]);

function exactError(code, details = {}) {
  const error = new Error(code);
  error.exact_blocker = code;
  error.details = details;
  return error;
}

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

function assertPlainObject(value, field) {
  if (!isPlainRecord(value)) {
    throw exactError("thread_readback_projection_object_invalid", { field });
  }
}

function assertAllowedKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw exactError("thread_readback_projection_field_not_allowed", { field: `${field}.${key}` });
  }
}

function boundedText(value, field, max = 160) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || !/^[\x20-\x7e]+$/u.test(value)) {
    throw exactError("thread_readback_projection_text_invalid", { field });
  }
  return value;
}

function boundedBool(value, field) {
  if (typeof value !== "boolean") throw exactError("thread_readback_projection_boolean_invalid", { field });
  return value;
}

function boundedNullableBool(value, field) {
  if (value === null || value === undefined) return null;
  return boundedBool(value, field);
}

function boundedNullableText(value, field, max = 160) {
  if (value === null || value === undefined) return null;
  return boundedText(value, field, max);
}

function boundedEnum(value, field, allowed) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw exactError("thread_readback_projection_enum_invalid", { field, value });
  }
  return value;
}

function normalizeState(value, index) {
  const state = value ?? {};
  assertPlainObject(state, `records[${index}].state`);
  assertAllowedKeys(state, STATE_KEYS, `records[${index}].state`);
  const rawAnomalies = state.softAnomalyTypes ?? [];
  if (!Array.isArray(rawAnomalies) || rawAnomalies.length > 8) {
    throw exactError("thread_readback_projection_soft_anomaly_types_invalid", { index });
  }
  const softAnomalyTypes = rawAnomalies.map((item, anomalyIndex) => boundedText(
    item,
    `records[${index}].state.softAnomalyTypes[${anomalyIndex}]`,
    64,
  ));
  return {
    taskStatus: boundedEnum(state.taskStatus ?? "unknown", `records[${index}].state.taskStatus`, TASK_STATUSES),
    latestTurnStatus: boundedEnum(state.latestTurnStatus ?? "unknown", `records[${index}].state.latestTurnStatus`, TURN_STATUSES),
    goalStatus: boundedEnum(state.goalStatus ?? "unknown", `records[${index}].state.goalStatus`, GOAL_STATUSES),
    planStatus: boundedEnum(state.planStatus ?? "unknown", `records[${index}].state.planStatus`, PLAN_STATUSES),
    owner: boundedEnum(state.owner ?? "unknown", `records[${index}].state.owner`, OWNERS),
    userOwned: boundedNullableBool(state.userOwned, `records[${index}].state.userOwned`),
    actionable: boundedNullableBool(state.actionable, `records[${index}].state.actionable`),
    stalled: boundedNullableBool(state.stalled, `records[${index}].state.stalled`),
    changed: boundedNullableBool(state.changed, `records[${index}].state.changed`),
    revision: boundedNullableText(state.revision ?? null, `records[${index}].state.revision`, 160),
    updatedAt: boundedNullableText(state.updatedAt ?? null, `records[${index}].state.updatedAt`, 80),
    generation: boundedNullableText(state.generation ?? null, `records[${index}].state.generation`, 160),
    exactBlocker: boundedNullableText(state.exactBlocker ?? null, `records[${index}].state.exactBlocker`, 240),
    softAnomalyTypes,
  };
}

function boundedCount(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > THREAD_READBACK_PROJECTION_MAX_RECORDS) {
    throw exactError("thread_readback_projection_count_invalid", { field });
  }
  return value;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function digestInput(value) {
  const withoutDigest = { ...value };
  delete withoutDigest.projectionDigest;
  return crypto.createHash("sha256").update(JSON.stringify(stableValue(withoutDigest))).digest("hex");
}

function normalizeRecord(value, index) {
  assertPlainObject(value, `records[${index}]`);
  assertAllowedKeys(value, RECORD_KEYS, `records[${index}]`);
  const alias = boundedText(value.alias, `records[${index}].alias`, 128);
  if (!OPAQUE_ALIAS_PATTERN.test(alias)) throw exactError("thread_readback_projection_alias_invalid", { index });
  const readClass = boundedText(value.readClass, `records[${index}].readClass`, 20);
  if (!READ_CLASSES.has(readClass)) throw exactError("thread_readback_projection_read_class_invalid", { index });
  const outcome = boundedText(value.outcome, `records[${index}].outcome`, 30);
  if (!OUTCOMES.has(outcome)) throw exactError("thread_readback_projection_outcome_invalid", { index });
  return {
    alias,
    readClass,
    outcome,
    deepAttempted: boundedBool(value.deepAttempted, `records[${index}].deepAttempted`),
    deepSucceeded: boundedBool(value.deepSucceeded, `records[${index}].deepSucceeded`),
    deepFailed: boundedBool(value.deepFailed, `records[${index}].deepFailed`),
    state: normalizeState(value.state, index),
  };
}

function normalizeCounts(value) {
  assertPlainObject(value, "counts");
  assertAllowedKeys(value, COUNT_KEYS, "counts");
  return Object.fromEntries([...COUNT_KEYS].map((key) => [key, boundedCount(value[key], `counts.${key}`)]));
}

// Official App read_thread returns a response envelope whose useful state is
// nested under `thread` and `turns`.  Depending on the callable bridge, that
// envelope may arrive directly, as JSON in a text block, or under
// functionCallOutput.output.text.  Keep the bridge-specific traversal here so
// the scheduler Root can pass only the allowlisted state into the projection.
function officialReadbackPayload(value, seen = new Set(), depth = 0) {
  if (depth > 8 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return null;
    try { return officialReadbackPayload(JSON.parse(trimmed), seen, depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = officialReadbackPayload(item, seen, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isPlainRecord(value) || seen.has(value)) return null;
  seen.add(value);
  if (isPlainRecord(value.thread) && Array.isArray(value.turns)) return value;
  for (const key of ["structuredContent", "content", "output", "functionCallOutput", "result", "data", "text"]) {
    if (value[key] === undefined) continue;
    const found = officialReadbackPayload(value[key], seen, depth + 1);
    if (found) return found;
  }
  return null;
}

function statusText(value) {
  if (value && typeof value === "object") {
    return value.type ?? value.status ?? value.state ?? value.lifecycleState ?? null;
  }
  return value;
}

function normalizeStatus(value, aliases, fallback = "unknown") {
  const raw = String(statusText(value) ?? "").trim().toLowerCase().replaceAll("-", "_");
  return aliases[raw] ?? (raw ? fallback : fallback);
}

const OFFICIAL_TASK_STATUS_ALIASES = Object.freeze({
  active: "active", running: "active", executing: "active", in_progress: "active",
  idle: "idle", waiting: "idle",
  notloaded: "notLoaded", not_loaded: "notLoaded", unloaded: "notLoaded",
  completed: "completed", complete: "completed", done: "completed", closed: "completed",
  blocked: "blocked", failed: "failed", interrupted: "interrupted",
  cancelled: "failed", canceled: "failed",
});

const OFFICIAL_TURN_STATUS_ALIASES = Object.freeze({
  inprogress: "inProgress", in_progress: "inProgress", running: "inProgress", executing: "inProgress",
  completed: "completed", complete: "completed", done: "completed", succeeded: "completed",
  failed: "failed", error: "failed", interrupted: "interrupted", aborted: "interrupted",
});

const OFFICIAL_GOAL_PLAN_STATUS_ALIASES = Object.freeze({
  active: "active", running: "active", inprogress: "active", in_progress: "active",
  blocked: "blocked", complete: "complete", completed: "complete", done: "complete",
});

const OFFICIAL_OWNER_ALIASES = Object.freeze({
  user: "user", user_owned: "user", "user-owned": "user", human: "user",
  automation: "automation", agent: "agent", foreign: "foreign",
});

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function boundedOfficialStateValue(value, max = 160) {
  if (value === null || value === undefined) return null;
  const result = String(value).replace(/[\u0000\r\n]+/gu, " ").replace(/\s+/gu, " ").trim();
  return result ? result.slice(0, max) : null;
}

/**
 * Extract only current task/turn state from an official App read_thread
 * result.  A missing Goal/Plan object remains `unknown`; it is not promoted
 * to a blocker here.  The optional fallbackState is the already allowlisted
 * task-list state and is used only when the readback omits a field.
 */
export function normalizeOfficialThreadReadback(readback, { fallbackState = {} } = {}) {
  const payload = officialReadbackPayload(readback);
  if (!payload) return { status: "unavailable", exactBlocker: "thread_readback_shape_unrecognized" };
  const thread = payload.thread ?? {};
  const turns = Array.isArray(payload.turns)
    ? payload.turns
    : Array.isArray(payload.page?.turns) ? payload.page.turns : [];
  const latestTurn = turns[0] ?? {};
  const goal = firstDefined(payload.goal, thread.goal, latestTurn.goal);
  const plan = firstDefined(payload.plan, thread.plan, latestTurn.plan);
  const goalStatus = normalizeStatus(
    firstDefined(payload.goalStatus, payload.goal_status, goal?.status, fallbackState.goalStatus),
    OFFICIAL_GOAL_PLAN_STATUS_ALIASES,
  );
  const planStatus = normalizeStatus(
    firstDefined(payload.planStatus, payload.plan_status, plan?.status, fallbackState.planStatus),
    OFFICIAL_GOAL_PLAN_STATUS_ALIASES,
  );
  const ownerRaw = firstDefined(payload.owner, thread.owner, fallbackState.owner);
  const ownerKey = String(statusText(ownerRaw) ?? "").trim().toLowerCase();
  return {
    status: "observed",
    taskStatus: normalizeStatus(firstDefined(statusText(thread.status), thread.taskStatus, fallbackState.taskStatus), OFFICIAL_TASK_STATUS_ALIASES),
    latestTurnStatus: normalizeStatus(firstDefined(latestTurn.status, latestTurn.turnStatus, fallbackState.latestTurnStatus), OFFICIAL_TURN_STATUS_ALIASES),
    goalStatus,
    planStatus,
    owner: OFFICIAL_OWNER_ALIASES[ownerKey] ?? (ownerKey ? "unknown" : (fallbackState.owner ?? "unknown")),
    userOwned: typeof fallbackState.userOwned === "boolean" ? fallbackState.userOwned : null,
    actionable: typeof fallbackState.actionable === "boolean" ? fallbackState.actionable : null,
    stalled: typeof fallbackState.stalled === "boolean" ? fallbackState.stalled : null,
    changed: typeof fallbackState.changed === "boolean" ? fallbackState.changed : null,
    revision: boundedOfficialStateValue(firstDefined(thread.revision, thread.revisionId, fallbackState.revision)),
    updatedAt: boundedOfficialStateValue(firstDefined(thread.updatedAt, thread.updated_at, fallbackState.updatedAt), 80),
    generation: boundedOfficialStateValue(firstDefined(thread.generation, fallbackState.generation)),
    exactBlocker: boundedOfficialStateValue(firstDefined(payload.exactBlocker, payload.exact_blocker, fallbackState.exactBlocker), 240),
    softAnomalyTypes: Array.isArray(fallbackState.softAnomalyTypes) ? fallbackState.softAnomalyTypes.slice(0, 8) : [],
  };
}

function normalizeLimits(value) {
  assertPlainObject(value, "limits");
  assertAllowedKeys(value, LIMIT_KEYS, "limits");
  const maxRecords = boundedCount(value.maxRecords, "limits.maxRecords");
  const maxDeepReads = boundedCount(value.maxDeepReads, "limits.maxDeepReads");
  if (maxRecords !== THREAD_READBACK_PROJECTION_MAX_RECORDS
    || maxDeepReads > THREAD_READBACK_PROJECTION_MAX_DEEP_READS) {
    throw exactError("thread_readback_projection_limit_invalid", { field: "limits.maxRecords" });
  }
  return {
    maxRecords,
    maxDeepReads,
    listTruncated: boundedBool(value.listTruncated, "limits.listTruncated"),
  };
}

export function normalizeThreadReadbackProjection(value, { maxBytes = THREAD_READBACK_PROJECTION_MAX_BYTES } = {}) {
  assertPlainObject(value, "projection");
  const rawBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (rawBytes > maxBytes) throw exactError("thread_readback_projection_oversize", { bytes: rawBytes, maxBytes });
  assertAllowedKeys(value, ROOT_KEYS, "projection");
  if (value.schema !== THREAD_READBACK_PROJECTION_SCHEMA || value.version !== THREAD_READBACK_PROJECTION_VERSION) {
    throw exactError("thread_readback_projection_schema_invalid");
  }
  const normalized = {
    schema: THREAD_READBACK_PROJECTION_SCHEMA,
    version: THREAD_READBACK_PROJECTION_VERSION,
    automationId: boundedText(value.automationId, "automationId", 120),
    rootRunId: boundedText(value.rootRunId, "rootRunId", 180),
    childAuditId: boundedText(value.childAuditId, "childAuditId", 180),
    producedAt: boundedText(value.producedAt, "producedAt", 80),
    projectionDigest: boundedText(value.projectionDigest, "projectionDigest", 64),
    limits: normalizeLimits(value.limits),
    counts: normalizeCounts(value.counts),
    records: Array.isArray(value.records) ? value.records.map(normalizeRecord) : (() => { throw exactError("thread_readback_projection_records_invalid"); })(),
  };
  if (normalized.records.length > THREAD_READBACK_PROJECTION_MAX_RECORDS) {
    throw exactError("thread_readback_projection_record_limit_exceeded", { count: normalized.records.length });
  }
  if (normalized.records.length > normalized.limits.maxRecords) {
    throw exactError("thread_readback_projection_record_limit_exceeded", { count: normalized.records.length, max: normalized.limits.maxRecords });
  }
  if (!/^[a-f0-9]{64}$/u.test(normalized.projectionDigest) || digestInput(normalized) !== normalized.projectionDigest) {
    throw exactError("thread_readback_projection_digest_mismatch");
  }
  const aliases = new Set();
  const lightweightAliases = new Set();
  const deepAliases = new Set();
  for (const record of normalized.records) {
    const key = `${record.alias}:${record.readClass}`;
    if (aliases.has(key)) throw exactError("thread_readback_projection_duplicate_record", { key });
    aliases.add(key);
    if (record.readClass === "lightweight") lightweightAliases.add(record.alias);
    else deepAliases.add(record.alias);
  }
  for (const alias of deepAliases) {
    if (!lightweightAliases.has(alias)) throw exactError("thread_readback_projection_deep_target_not_listed", { alias });
  }
  const counts = normalized.counts;
  const expectedCounts = {
    lightweightRequested: lightweightAliases.size,
    lightweightSucceeded: normalized.records.filter((record) => record.readClass === "lightweight" && record.outcome === "success").length,
    lightweightFailed: normalized.records.filter((record) => record.readClass === "lightweight" && record.outcome === "bounded_error").length,
    deepCandidates: deepAliases.size,
    deepAttempted: normalized.records.filter((record) => record.readClass === "deep" && record.deepAttempted).length,
    deepSucceeded: normalized.records.filter((record) => record.readClass === "deep" && record.deepSucceeded).length,
    deepFailed: normalized.records.filter((record) => record.readClass === "deep" && record.deepFailed).length,
  };
  for (const [key, expected] of Object.entries(expectedCounts)) {
    if (counts[key] !== expected) throw exactError("thread_readback_projection_count_mismatch", { field: `counts.${key}`, expected, actual: counts[key] });
  }
  if (counts.listAttempted !== 1 || counts.listSucceeded > counts.listAttempted) {
    throw exactError("thread_readback_projection_list_count_invalid");
  }
  if (counts.deepAttempted > normalized.limits.maxDeepReads
    || counts.deepAttempted > THREAD_READBACK_PROJECTION_MAX_DEEP_READS) {
    throw exactError("thread_readback_projection_deep_limit_exceeded", { attempted: counts.deepAttempted, max: normalized.limits.maxDeepReads });
  }
  return normalized;
}

export function createThreadAlias(threadId) {
  return `t-${crypto.createHash("sha256").update(String(threadId || "")).digest("hex").slice(0, 24)}`;
}

export function createThreadReadbackProjection({
  automationId,
  rootRunId,
  childAuditId,
  producedAt = new Date().toISOString(),
  maxDeepReads = THREAD_READBACK_PROJECTION_MAX_DEEP_READS,
  listAttempted = 1,
  listSucceeded = 1,
  listTruncated = false,
  lightweight = [],
  deep = [],
} = {}) {
  const records = [
    ...(Array.isArray(lightweight) ? lightweight : []).map((record) => ({
      alias: boundedText(record?.alias, "lightweight.alias", 128),
      readClass: "lightweight",
      outcome: record?.outcome === "success" ? "success" : "bounded_error",
      deepAttempted: false,
      deepSucceeded: false,
      deepFailed: false,
      state: record?.state ?? {},
    })),
    ...(Array.isArray(deep) ? deep : []).map((record) => ({
      alias: boundedText(record?.alias, "deep.alias", 128),
      readClass: "deep",
      outcome: record?.outcome === "success" ? "success" : "bounded_error",
      deepAttempted: true,
      deepSucceeded: record?.outcome === "success",
      deepFailed: record?.outcome !== "success",
      state: record?.state ?? {},
    })),
  ];
  const lightweightRecords = records.filter((record) => record.readClass === "lightweight");
  const deepRecords = records.filter((record) => record.readClass === "deep");
  if (records.length > THREAD_READBACK_PROJECTION_MAX_RECORDS) {
    throw exactError("thread_readback_projection_record_limit_exceeded", { count: records.length });
  }
  const value = {
    schema: THREAD_READBACK_PROJECTION_SCHEMA,
    version: THREAD_READBACK_PROJECTION_VERSION,
    automationId: boundedText(automationId, "automationId", 120),
    rootRunId: boundedText(rootRunId, "rootRunId", 180),
    childAuditId: boundedText(childAuditId, "childAuditId", 180),
    producedAt: boundedText(producedAt, "producedAt", 80),
    projectionDigest: "",
    limits: {
      maxRecords: THREAD_READBACK_PROJECTION_MAX_RECORDS,
      maxDeepReads: boundedCount(maxDeepReads, "maxDeepReads"),
      listTruncated: Boolean(listTruncated),
    },
    counts: {
      listAttempted: boundedCount(listAttempted, "listAttempted"),
      listSucceeded: boundedCount(listSucceeded, "listSucceeded"),
      lightweightRequested: lightweightRecords.length,
      lightweightSucceeded: lightweightRecords.filter((record) => record.outcome === "success").length,
      lightweightFailed: lightweightRecords.filter((record) => record.outcome !== "success").length,
      deepCandidates: deepRecords.length,
      deepAttempted: deepRecords.length,
      deepSucceeded: deepRecords.filter((record) => record.outcome === "success").length,
      deepFailed: deepRecords.filter((record) => record.outcome !== "success").length,
    },
    records: records.map((record, index) => normalizeRecord(record, index)),
  };
  value.projectionDigest = digestInput(value);
  return normalizeThreadReadbackProjection(value);
}

export function readThreadReadbackProjection(file, options = {}) {
  if (typeof file !== "string" || !file.startsWith("/")) throw exactError("thread_readback_projection_path_invalid");
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw exactError("thread_readback_projection_file_unavailable"); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw exactError("thread_readback_projection_file_untrusted");
  }
  if (stat.size > (options.maxBytes ?? THREAD_READBACK_PROJECTION_MAX_BYTES)) {
    throw exactError("thread_readback_projection_oversize", { bytes: stat.size });
  }
  let value;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw exactError("thread_readback_projection_json_invalid"); }
  return normalizeThreadReadbackProjection(value, options);
}

export function projectionCallbacks(projection) {
  const normalized = normalizeThreadReadbackProjection(projection);
  const lightweight = new Map(normalized.records.filter((record) => record.readClass === "lightweight").map((record) => [record.alias, record]));
  const deep = new Map(normalized.records.filter((record) => record.readClass === "deep").map((record) => [record.alias, record]));
  const tasks = [...lightweight.keys()].map((alias) => {
    const deepRecord = deep.get(alias);
    const state = lightweight.get(alias).state;
    const completed = state.taskStatus === "completed" || state.goalStatus === "complete";
    const interrupted = state.taskStatus === "interrupted";
    const blocked = state.taskStatus === "blocked"
      || state.taskStatus === "failed"
      || state.goalStatus === "blocked"
      || state.planStatus === "blocked";
    return {
      threadId: alias,
      owner: state.owner,
      userOwned: state.userOwned,
      status: state.taskStatus,
      latestTurnStatus: state.latestTurnStatus,
      goalStatus: state.goalStatus,
      planStatus: state.planStatus,
      revision: state.revision,
      updatedAt: state.updatedAt,
      generation: state.generation,
      exactBlocker: state.exactBlocker,
      actionable: state.actionable,
      stalled: state.stalled,
      changed: state.changed,
      softAnomalyTypes: state.softAnomalyTypes,
      softAnomalyConfirmed: false,
      blocked,
      completed,
      interrupted,
      stateScope: completed ? "history" : interrupted ? "paused" : "live_candidate",
    };
  });
  const readback = (record) => record?.outcome === "success"
    ? {
        status: "observed",
        threadStatus: record.state.taskStatus,
        latestTurnStatus: record.state.latestTurnStatus,
        goalStatus: record.state.goalStatus,
        planStatus: record.state.planStatus,
        owner: record.state.owner,
        actionable: record.state.actionable,
        stalled: record.state.stalled,
        changed: record.state.changed,
        revision: record.state.revision,
        updatedAt: record.state.updatedAt,
        generation: record.state.generation,
        exactBlocker: record.state.exactBlocker,
        softAnomalyTypes: record.state.softAnomalyTypes,
        softAnomalyConfirmed: false,
      }
    : { status: "failed", exact_blocker: "thread_readback_projection_bounded_error" };
  return {
    projection: normalized,
    tasks,
    inspectThread: async ({ threadId }) => readback(lightweight.get(threadId), deep.has(threadId)),
    readThread: async ({ threadId }) => {
      const record = deep.get(threadId);
      return record ? readback(record, true) : undefined;
    },
  };
}

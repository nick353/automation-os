import { createHash } from "node:crypto";

export const PORTABLE_WORKER_HEARTBEAT_KIND = "portable_mac_worker";
export const PORTABLE_WORKER_HEARTBEAT_SCHEMA = "aos.portable_worker_heartbeat.v2" as const;
export const PORTABLE_WORKER_HEARTBEAT_LEGACY_SCHEMA = "aos.portable_worker_heartbeat.v1" as const;
export const PORTABLE_WORKER_RUNTIME_OBSERVATION_SCHEMA = "aos.portable_worker_runtime_observation.v1" as const;
export const PORTABLE_WORKER_HEARTBEAT_TRANSPORT_ACK_SCHEMA = "aos.portable_worker_heartbeat_transport_ack.v1" as const;
export const DEFAULT_PORTABLE_WORKER_HEARTBEAT_STALE_SECONDS = 300;
const SAFE_WORKER_ID = /^[A-Za-z0-9._:-]{1,120}$/u;
const SAFE_OPAQUE_ID = /^-?[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const SAFE_STATUS = new Set(["running", "idle", "blocked"]);
const SAFE_CHROME_STATUS = new Set(["ready", "blocked", "stopped", "stale", "unavailable"]);
const SAFE_CHROME_OPERATION_STATUS = new Set(["ready", "read_only_ready", "target_scoped_ready", "blocked", "unknown"]);
const SAFE_CHROME_OWNER_STATUS = new Set(["foreground_ready", "bridge_only", "stopped", "blocked", "unknown"]);
const SAFE_OBSERVATION_STATUS = new Set(["observed", "idle", "unobserved", "unavailable"]);
const SAFE_OBSERVATION_RESOURCE_STATUS = new Set(["present", "absent", "unobserved", "unavailable"]);
const SAFE_BROWSER_ROOM_STATE = new Set(["active", "starting", "held"]);
const SAFE_BROWSER_ROOM_LIFECYCLE = new Set(["temporary", "single-use", "scheduled"]);
const SAFE_BROWSER_TRANSPORT_STATUS = new Set(["connected", "disconnected", "unobserved", "unavailable"]);
const SAFE_TRANSPORT_ACK_STATUS = new Set(["acknowledged", "blocked", "unobserved", "pending"]);
const SAFE_TRANSPORT_BINDING_STATUS = new Set(["verified", "legacy_unbound", "mismatch", "unverified"]);

const PORTABLE_WORKER_HEARTBEAT_KEYS = new Set([
  "schema", "company_id", "worker_id", "worker_instance_id", "generation", "generation_id", "observed_at",
  "status", "queue_depth", "exact_blocker", "run_id", "runtime_observation", "browser_use_observation",
  "browser_use_runtime_observation", "transport_ack", "chrome_plugin_readback"
]);
const PORTABLE_WORKER_RUNTIME_OBSERVATION_KEYS = new Set(["schema", "status", "observed_at", "run_id", "room_id", "browser_use"]);
const PORTABLE_WORKER_BROWSER_USE_KEYS = new Set(["runtime_status", "process", "room", "transport"]);
const PORTABLE_WORKER_PROCESS_OBSERVATION_KEYS = new Set(["status", "pid", "process_count", "profile_ref", "port"]);
const PORTABLE_WORKER_ROOM_OBSERVATION_KEYS = new Set([
  "status", "room_id", "state", "lifecycle", "owner_kind", "owner_id", "task_id", "automation_id",
  "profile_ref", "port", "current_activity", "updated_at"
]);
const PORTABLE_WORKER_TRANSPORT_OBSERVATION_KEYS = new Set(["status", "last_seen_at"]);
const PORTABLE_WORKER_TRANSPORT_ACK_KEYS = new Set([
  "schema", "status", "observed_at", "ack_at", "worker_instance_id", "generation", "binding_status"
]);

type PortableWorkerObservationResourceStatus = "present" | "absent" | "unobserved" | "unavailable";

export type PortableWorkerBrowserUseProcessObservation = {
  status: PortableWorkerObservationResourceStatus;
  pid: number | null;
  processCount: number | null;
  profileRef: string | null;
  port: number | null;
};

export type PortableWorkerBrowserUseRoomObservation = {
  status: PortableWorkerObservationResourceStatus;
  roomId: string | null;
  state: "active" | "starting" | "held" | null;
  lifecycle: "temporary" | "single-use" | "scheduled" | null;
  ownerKind: string | null;
  ownerId: string | null;
  taskId: string | null;
  automationId: string | null;
  profileRef: string | null;
  port: number | null;
  currentActivity: string | null;
  updatedAt: string | null;
};

export type PortableWorkerBrowserUseTransportObservation = {
  status: "connected" | "disconnected" | "unobserved" | "unavailable";
  lastSeenAt: string | null;
};

export type PortableWorkerRuntimeObservation = {
  schema: typeof PORTABLE_WORKER_RUNTIME_OBSERVATION_SCHEMA;
  status: "observed" | "idle" | "unobserved" | "unavailable";
  observedAt: string;
  runId: string | null;
  roomId: string | null;
  browserUse: {
    runtimeStatus: PortableWorkerObservationResourceStatus;
    process: PortableWorkerBrowserUseProcessObservation | null;
    room: PortableWorkerBrowserUseRoomObservation | null;
    transport: PortableWorkerBrowserUseTransportObservation | null;
  } | null;
};

export type PortableWorkerHeartbeatTransportAck = {
  schema: typeof PORTABLE_WORKER_HEARTBEAT_TRANSPORT_ACK_SCHEMA;
  status: "acknowledged" | "blocked" | "unobserved" | "pending";
  observedAt: string | null;
  ackAt: string | null;
  workerInstanceId: string | null;
  generation: string | null;
  bindingStatus: "verified" | "legacy_unbound" | "mismatch" | "unverified";
};

export type PortableWorkerChromePluginReadback = {
  schema: "aos.portable_worker_chrome_plugin_readback.v1";
  status: "ready" | "blocked" | "stopped" | "stale" | "unavailable";
  exact_blocker: string | null;
  target_scoped_ready: boolean;
  target_scoped_exact_blocker: string | null;
  operation_ready: boolean;
  operation_status: "ready" | "read_only_ready" | "target_scoped_ready" | "blocked" | "unknown";
  operation_exact_blocker: string | null;
  bridge_instance_id: string | null;
  last_seen_at: string | null;
  browser: {
    id: string | null;
    type: string | null;
    profile_name: string | null;
    profile_ordering: string | null;
  } | null;
  bridge_owner: {
    schema: string;
    owner_id: string | null;
    bridge_instance_id: string | null;
    session_id: string | null;
    thread_id: string | null;
    turn_id: string | null;
    status: "foreground_ready" | "bridge_only" | "stopped" | "blocked" | "unknown";
    foreground_executor_ready: boolean;
    exact_blocker: string | null;
    updated_at: string | null;
  } | null;
};

export type PortableWorkerHeartbeatInput = {
  workerId: string;
  status: "running" | "idle" | "blocked";
  queueDepth: number | null;
  exactBlocker: string | null;
  chromePluginReadback: PortableWorkerChromePluginReadback | null;
  schema?: typeof PORTABLE_WORKER_HEARTBEAT_SCHEMA | typeof PORTABLE_WORKER_HEARTBEAT_LEGACY_SCHEMA;
  companyId?: string;
  workerInstanceId?: string;
  generation?: string;
  observedAt?: string;
  runId?: string | null;
  runtimeObservation?: PortableWorkerRuntimeObservation | null;
  transportAck?: PortableWorkerHeartbeatTransportAck | null;
};

export type PortableWorkerHeartbeatBinding = {
  companyId: string;
  workerId: string;
  workerInstanceId: string;
  generation: string;
};

type PortableWorkerHeartbeatBindingLike = {
  company_id?: unknown;
  worker_id?: unknown;
  worker_instance_id?: unknown;
  generation?: unknown;
  generation_id?: unknown;
  companyId?: unknown;
  workerId?: unknown;
  workerInstanceId?: unknown;
  generationId?: unknown;
};

type PortableWorkerHeartbeatValidationOptions = {
  expectedCompanyId?: string | null;
  expectedWorkerId?: string | null;
  expectedWorkerInstanceId?: string | null;
  expectedGeneration?: string | null;
};

function safeOpaqueId(value: unknown): string | null {
  return typeof value === "string" && SAFE_OPAQUE_ID.test(value.trim()) ? value.trim() : null;
}

function safeIsoTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= 64 && Number.isFinite(Date.parse(value.trim()))
    ? value.trim()
    : null;
}

function safePublicRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || normalized.startsWith("/") || normalized.includes("\\")
    || normalized.includes("..") || normalized.includes("://")) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(normalized) ? normalized : null;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function readNullableOpaque(value: unknown): { valid: boolean; present: boolean; value: string | null } {
  if (value === undefined) return { valid: true, present: false, value: null };
  if (value === null) return { valid: true, present: true, value: null };
  if (typeof value === "string" && value.trim() === "") return { valid: true, present: false, value: null };
  const normalized = safeOpaqueId(value);
  return { valid: normalized !== null, present: true, value: normalized };
}

function readNullablePublicRef(value: unknown): { valid: boolean; present: boolean; value: string | null } {
  if (value === undefined) return { valid: true, present: false, value: null };
  if (value === null) return { valid: true, present: true, value: null };
  if (typeof value === "string" && value.trim() === "") return { valid: true, present: false, value: null };
  const normalized = safePublicRef(value);
  return { valid: normalized !== null, present: true, value: normalized };
}

function readNullableTimestamp(value: unknown): { valid: boolean; present: boolean; value: string | null } {
  if (value === undefined) return { valid: true, present: false, value: null };
  if (value === null) return { valid: true, present: true, value: null };
  if (typeof value === "string" && value.trim() === "") return { valid: true, present: false, value: null };
  const normalized = safeIsoTimestamp(value);
  return { valid: normalized !== null, present: true, value: normalized };
}

function readNullableBlocker(value: unknown): { valid: boolean; present: boolean; value: string | null } {
  if (value === undefined) return { valid: true, present: false, value: null };
  if (value === null) return { valid: true, present: true, value: null };
  if (typeof value !== "string") return { valid: false, present: true, value: null };
  const normalized = value.trim();
  if (!normalized) return { valid: true, present: false, value: null };
  return {
    valid: /^[A-Za-z0-9_.:-]{1,160}$/u.test(normalized),
    present: true,
    value: /^[A-Za-z0-9_.:-]{1,160}$/u.test(normalized) ? normalized : null
  };
}

function parseObservationProcess(value: unknown): PortableWorkerBrowserUseProcessObservation | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasOnlyKeys(record, PORTABLE_WORKER_PROCESS_OBSERVATION_KEYS)) return null;
  const status = typeof record.status === "string" && SAFE_OBSERVATION_RESOURCE_STATUS.has(record.status)
    ? record.status as PortableWorkerObservationResourceStatus
    : null;
  if (!status) return null;
  const pid = record.pid === null || record.pid === undefined
    ? null
    : typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid > 0 ? record.pid : -1;
  const processCount = record.process_count === null || record.process_count === undefined
    ? null
    : typeof record.process_count === "number" && Number.isSafeInteger(record.process_count) && record.process_count >= 0 && record.process_count <= 100
      ? record.process_count
      : -1;
  const profileRef = readNullablePublicRef(record.profile_ref);
  const port = record.port === null || record.port === undefined
    ? null
    : typeof record.port === "number" && Number.isSafeInteger(record.port) && record.port > 0 && record.port < 65_536 ? record.port : -1;
  if (pid === -1 || processCount === -1 || port === -1 || !profileRef.valid) return null;
  if (status === "present" && (pid === null || processCount === null || profileRef.value === null || port === null)) return null;
  return { status, pid, processCount, profileRef: profileRef.value, port };
}

function parseObservationRoom(value: unknown): PortableWorkerBrowserUseRoomObservation | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasOnlyKeys(record, PORTABLE_WORKER_ROOM_OBSERVATION_KEYS)) return null;
  const status = typeof record.status === "string" && SAFE_OBSERVATION_RESOURCE_STATUS.has(record.status)
    ? record.status as PortableWorkerObservationResourceStatus
    : null;
  if (!status) return null;
  const roomId = readNullableOpaque(record.room_id);
  const ownerKind = readNullableOpaque(record.owner_kind);
  const ownerId = readNullableOpaque(record.owner_id);
  const taskId = readNullableOpaque(record.task_id);
  const automationId = readNullableOpaque(record.automation_id);
  const profileRef = readNullablePublicRef(record.profile_ref);
  const currentActivity = readNullablePublicRef(record.current_activity);
  const updatedAt = readNullableTimestamp(record.updated_at);
  const state = record.state === null || record.state === undefined
    ? null
    : typeof record.state === "string" && SAFE_BROWSER_ROOM_STATE.has(record.state) ? record.state as PortableWorkerBrowserUseRoomObservation["state"] : "invalid";
  const lifecycle = record.lifecycle === null || record.lifecycle === undefined
    ? null
    : typeof record.lifecycle === "string" && SAFE_BROWSER_ROOM_LIFECYCLE.has(record.lifecycle) ? record.lifecycle as PortableWorkerBrowserUseRoomObservation["lifecycle"] : "invalid";
  const port = record.port === null || record.port === undefined
    ? null
    : typeof record.port === "number" && Number.isSafeInteger(record.port) && record.port > 0 && record.port < 65_536 ? record.port : -1;
  if ([roomId, ownerKind, ownerId, taskId, automationId, profileRef, currentActivity, updatedAt].some((item) => !item.valid)
    || state === "invalid" || lifecycle === "invalid" || port === -1) return null;
  if (status === "present" && (roomId.value === null || profileRef.value === null || port === null)) return null;
  return {
    status, roomId: roomId.value, state, lifecycle, ownerKind: ownerKind.value, ownerId: ownerId.value,
    taskId: taskId.value, automationId: automationId.value, profileRef: profileRef.value, port,
    currentActivity: currentActivity.value, updatedAt: updatedAt.value
  };
}

function parseObservationTransport(value: unknown): PortableWorkerBrowserUseTransportObservation | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasOnlyKeys(record, PORTABLE_WORKER_TRANSPORT_OBSERVATION_KEYS)) return null;
  const status = typeof record.status === "string" && SAFE_BROWSER_TRANSPORT_STATUS.has(record.status)
    ? record.status as PortableWorkerBrowserUseTransportObservation["status"]
    : null;
  const lastSeenAt = readNullableTimestamp(record.last_seen_at);
  if (!status || !lastSeenAt.valid || (status === "connected" && lastSeenAt.value === null)) return null;
  return { status, lastSeenAt: lastSeenAt.value };
}

function parsePortableWorkerRuntimeObservation(value: unknown): PortableWorkerRuntimeObservation | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasOnlyKeys(record, PORTABLE_WORKER_RUNTIME_OBSERVATION_KEYS)
    || record.schema !== PORTABLE_WORKER_RUNTIME_OBSERVATION_SCHEMA) return null;
  const status = typeof record.status === "string" && SAFE_OBSERVATION_STATUS.has(record.status)
    ? record.status as PortableWorkerRuntimeObservation["status"]
    : null;
  const observedAt = safeIsoTimestamp(record.observed_at);
  const runId = readNullableOpaque(record.run_id);
  const roomId = readNullableOpaque(record.room_id);
  if (!status || !observedAt || !runId.valid || !roomId.valid) return null;
  const rawBrowserUse = record.browser_use;
  let browserUse: PortableWorkerRuntimeObservation["browserUse"] = null;
  if (rawBrowserUse !== null && rawBrowserUse !== undefined) {
    if (!rawBrowserUse || typeof rawBrowserUse !== "object" || Array.isArray(rawBrowserUse)) return null;
    const browserRecord = rawBrowserUse as Record<string, unknown>;
    if (!hasOnlyKeys(browserRecord, PORTABLE_WORKER_BROWSER_USE_KEYS)) return null;
    const runtimeStatus = typeof browserRecord.runtime_status === "string" && SAFE_OBSERVATION_RESOURCE_STATUS.has(browserRecord.runtime_status)
      ? browserRecord.runtime_status as PortableWorkerObservationResourceStatus
      : null;
    const process = parseObservationProcess(browserRecord.process);
    const room = parseObservationRoom(browserRecord.room);
    const transport = parseObservationTransport(browserRecord.transport);
    if (!runtimeStatus || (browserRecord.process !== null && browserRecord.process !== undefined && !process)
      || (browserRecord.room !== null && browserRecord.room !== undefined && !room)
      || (browserRecord.transport !== null && browserRecord.transport !== undefined && !transport)) return null;
    browserUse = { runtimeStatus, process, room, transport };
  }
  const nestedRoomId = browserUse?.room?.roomId ?? null;
  if (roomId.value !== null && nestedRoomId !== null && roomId.value !== nestedRoomId) return null;
  const effectiveRoomId = roomId.value ?? nestedRoomId;
  // An idle worker has no current run or room.  In particular, an absent
  // process/zero count is not a liveness proof, so idle projections use the
  // explicit `unobserved` state instead of manufacturing a stopped result.
  if (status === "idle" && (runId.value !== null || effectiveRoomId !== null
    || browserUse?.runtimeStatus === "absent"
    || browserUse?.process?.status === "absent"
    || browserUse?.process?.processCount === 0
    || browserUse?.room?.status === "absent")) return null;
  return {
    schema: PORTABLE_WORKER_RUNTIME_OBSERVATION_SCHEMA,
    status,
    observedAt,
    runId: runId.value,
    roomId: effectiveRoomId,
    browserUse
  };
}

function parsePortableWorkerTransportAck(value: unknown): PortableWorkerHeartbeatTransportAck | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasOnlyKeys(record, PORTABLE_WORKER_TRANSPORT_ACK_KEYS)
    || record.schema !== PORTABLE_WORKER_HEARTBEAT_TRANSPORT_ACK_SCHEMA) return null;
  const status = typeof record.status === "string" && SAFE_TRANSPORT_ACK_STATUS.has(record.status)
    ? record.status as PortableWorkerHeartbeatTransportAck["status"]
    : null;
  const observedAt = readNullableTimestamp(record.observed_at);
  const ackAt = readNullableTimestamp(record.ack_at);
  const workerInstanceId = readNullableOpaque(record.worker_instance_id);
  const generation = readNullableOpaque(record.generation);
  const bindingStatus = typeof record.binding_status === "string" && SAFE_TRANSPORT_BINDING_STATUS.has(record.binding_status)
    ? record.binding_status as PortableWorkerHeartbeatTransportAck["bindingStatus"]
    : null;
  if (!status || !observedAt.valid || !ackAt.valid || !workerInstanceId.valid || !generation.valid || !bindingStatus) return null;
  if (status === "acknowledged" && (observedAt.value === null || ackAt.value === null
    || workerInstanceId.value === null || generation.value === null || bindingStatus !== "verified")) return null;
  return {
    schema: PORTABLE_WORKER_HEARTBEAT_TRANSPORT_ACK_SCHEMA, status, observedAt: observedAt.value, ackAt: ackAt.value,
    workerInstanceId: workerInstanceId.value, generation: generation.value, bindingStatus
  };
}

export function validatePortableWorkerRuntimeObservation(value: unknown):
  | { ok: true; value: PortableWorkerRuntimeObservation }
  | { ok: false; exactBlocker: string } {
  const parsed = parsePortableWorkerRuntimeObservation(value);
  return parsed
    ? { ok: true, value: parsed }
    : { ok: false, exactBlocker: "portable_worker_runtime_observation_invalid" };
}

function parseChromePluginReadback(value: unknown): PortableWorkerChromePluginReadback | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasOnlyKeys(record, new Set([
    "schema", "status", "exact_blocker", "target_scoped_ready", "target_scoped_exact_blocker", "operation_ready",
    "operation_status", "operation_exact_blocker", "bridge_instance_id", "last_seen_at", "browser", "bridge_owner"
  ])) || record.schema !== "aos.portable_worker_chrome_plugin_readback.v1") return null;
  const status = typeof record.status === "string" && SAFE_CHROME_STATUS.has(record.status)
    ? record.status as PortableWorkerChromePluginReadback["status"]
    : null;
  const operationStatus = typeof record.operation_status === "string" && SAFE_CHROME_OPERATION_STATUS.has(record.operation_status)
    ? record.operation_status as PortableWorkerChromePluginReadback["operation_status"]
    : null;
  if (!status || !operationStatus) return null;
  const blocker = (candidate: unknown) => typeof candidate === "string" && /^[A-Za-z0-9_.:-]{1,160}$/u.test(candidate.trim()) ? candidate.trim() : null;
  const exactBlocker = readNullableBlocker(record.exact_blocker);
  const targetScopedExactBlocker = readNullableBlocker(record.target_scoped_exact_blocker);
  const operationExactBlocker = readNullableBlocker(record.operation_exact_blocker);
  if (!exactBlocker.valid || !targetScopedExactBlocker.valid || !operationExactBlocker.valid) return null;
  const rawBrowser = record.browser && typeof record.browser === "object" && !Array.isArray(record.browser)
    ? record.browser as Record<string, unknown>
    : null;
  if (rawBrowser && !hasOnlyKeys(rawBrowser, new Set(["id", "type", "profile_name", "profile_ordering"]))) return null;
  const browserId = readNullableOpaque(rawBrowser?.id);
  const browserType = readNullableOpaque(rawBrowser?.type);
  const browserProfileName = readNullableOpaque(rawBrowser?.profile_name);
  const browserProfileOrdering = readNullableOpaque(rawBrowser?.profile_ordering);
  if ([browserId, browserType, browserProfileName, browserProfileOrdering].some((item) => !item.valid)) return null;
  const browser = rawBrowser ? {
    id: browserId.value,
    type: browserType.value,
    profile_name: browserProfileName.value,
    profile_ordering: browserProfileOrdering.value,
  } : null;
  const rawOwner = record.bridge_owner && typeof record.bridge_owner === "object" && !Array.isArray(record.bridge_owner)
    ? record.bridge_owner as Record<string, unknown>
    : null;
  if (rawOwner && !hasOnlyKeys(rawOwner, new Set([
    "schema", "owner_id", "bridge_instance_id", "session_id", "thread_id", "turn_id", "status",
    "foreground_executor_ready", "exact_blocker", "updated_at"
  ]))) return null;
  const ownerStatus = rawOwner && typeof rawOwner.status === "string" && SAFE_CHROME_OWNER_STATUS.has(rawOwner.status)
    ? rawOwner.status as NonNullable<PortableWorkerChromePluginReadback["bridge_owner"]>["status"]
    : "unknown";
  const ownerSchema = readNullableOpaque(rawOwner?.schema);
  const ownerId = readNullableOpaque(rawOwner?.owner_id);
  const ownerBridgeInstanceId = readNullableOpaque(rawOwner?.bridge_instance_id);
  const ownerSessionId = readNullableOpaque(rawOwner?.session_id);
  const ownerThreadId = readNullableOpaque(rawOwner?.thread_id);
  const ownerTurnId = readNullableOpaque(rawOwner?.turn_id);
  const ownerExactBlocker = readNullableBlocker(rawOwner?.exact_blocker);
  const ownerUpdatedAt = readNullableTimestamp(rawOwner?.updated_at);
  if ([ownerSchema, ownerId, ownerBridgeInstanceId, ownerSessionId, ownerThreadId, ownerTurnId, ownerExactBlocker, ownerUpdatedAt]
    .some((item) => !item.valid)
    || (rawOwner && Object.prototype.hasOwnProperty.call(rawOwner, "status") && typeof rawOwner.status !== "string")
    || (rawOwner && Object.prototype.hasOwnProperty.call(rawOwner, "foreground_executor_ready")
      && typeof rawOwner.foreground_executor_ready !== "boolean")) return null;
  const bridgeOwner = rawOwner ? {
    schema: ownerSchema.value ?? "",
    owner_id: ownerId.value,
    bridge_instance_id: ownerBridgeInstanceId.value,
    session_id: ownerSessionId.value,
    thread_id: ownerThreadId.value,
    turn_id: ownerTurnId.value,
    status: ownerStatus,
    foreground_executor_ready: rawOwner.foreground_executor_ready === true,
    exact_blocker: ownerExactBlocker.value,
    updated_at: ownerUpdatedAt.value,
  } : null;
  const bridgeInstanceId = readNullableOpaque(record.bridge_instance_id);
  const lastSeenAt = readNullableTimestamp(record.last_seen_at);
  if (!bridgeInstanceId.valid || !lastSeenAt.valid) return null;
  return {
    schema: "aos.portable_worker_chrome_plugin_readback.v1",
    status,
    exact_blocker: exactBlocker.value,
    target_scoped_ready: record.target_scoped_ready === true,
    target_scoped_exact_blocker: targetScopedExactBlocker.value,
    operation_ready: record.operation_ready === true,
    operation_status: operationStatus,
    operation_exact_blocker: operationExactBlocker.value,
    bridge_instance_id: bridgeInstanceId.value,
    last_seen_at: lastSeenAt.value,
    browser,
    bridge_owner: bridgeOwner,
  };
}

export function portableWorkerHeartbeatBindingMatches(
  expected: PortableWorkerHeartbeatBinding,
  observed: PortableWorkerHeartbeatBindingLike
): boolean {
  const expectedCompanyId = safeOpaqueId(expected?.companyId);
  const expectedWorkerId = safeOpaqueId(expected?.workerId);
  const expectedWorkerInstanceId = safeOpaqueId(expected?.workerInstanceId);
  const expectedGeneration = safeOpaqueId(expected?.generation);
  const observedCompanyId = safeOpaqueId(observed?.company_id ?? observed?.companyId);
  const observedWorkerId = safeOpaqueId(observed?.worker_id ?? observed?.workerId);
  const observedWorkerInstanceId = safeOpaqueId(observed?.worker_instance_id ?? observed?.workerInstanceId);
  const observedGeneration = safeOpaqueId(observed?.generation ?? observed?.generation_id ?? observed?.generationId);
  return expectedCompanyId !== null && expectedWorkerId !== null && expectedWorkerInstanceId !== null && expectedGeneration !== null
    && observedCompanyId === expectedCompanyId
    && observedWorkerId === expectedWorkerId
    && observedWorkerInstanceId === expectedWorkerInstanceId
    && observedGeneration === expectedGeneration;
}

// Keep the descriptive alias available to callers that read this as a predicate.
export const matchesPortableWorkerHeartbeatBinding = portableWorkerHeartbeatBindingMatches;

export function validatePortableWorkerHeartbeat(
  body: unknown,
  options: PortableWorkerHeartbeatValidationOptions = {}
):
  | { ok: true; value: PortableWorkerHeartbeatInput }
  | { ok: false; exactBlocker: string } {
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  if (!hasOnlyKeys(record, PORTABLE_WORKER_HEARTBEAT_KEYS)) {
    return { ok: false, exactBlocker: "portable_worker_heartbeat_field_invalid" };
  }
  const suppliedSchema = record.schema;
  if (suppliedSchema !== undefined
    && suppliedSchema !== PORTABLE_WORKER_HEARTBEAT_SCHEMA
    && suppliedSchema !== PORTABLE_WORKER_HEARTBEAT_LEGACY_SCHEMA) {
    return { ok: false, exactBlocker: "portable_worker_heartbeat_schema_invalid" };
  }
  const workerId = typeof record.worker_id === "string" ? record.worker_id.trim() : "";
  if (!SAFE_WORKER_ID.test(workerId)) return { ok: false, exactBlocker: "portable_worker_heartbeat_worker_id_invalid" };
  const status = typeof record.status === "string" ? record.status.trim() : "";
  if (!SAFE_STATUS.has(status)) return { ok: false, exactBlocker: "portable_worker_heartbeat_status_invalid" };
  const rawQueueDepth = record.queue_depth;
  const queueDepth = rawQueueDepth === undefined || rawQueueDepth === null
    ? null
    : typeof rawQueueDepth === "number" && Number.isSafeInteger(rawQueueDepth) && rawQueueDepth >= 0 && rawQueueDepth <= 100_000
      ? rawQueueDepth
      : -1;
  if (queueDepth === -1) return { ok: false, exactBlocker: "portable_worker_heartbeat_queue_depth_invalid" };
  const exactBlockerRead = readNullableBlocker(record.exact_blocker);
  if (!exactBlockerRead.valid) return { ok: false, exactBlocker: "portable_worker_heartbeat_exact_blocker_invalid" };
  const companyId = readNullableOpaque(record.company_id);
  const workerInstanceId = readNullableOpaque(record.worker_instance_id);
  const generation = readNullableOpaque(record.generation);
  const generationId = readNullableOpaque(record.generation_id);
  const observedAt = readNullableTimestamp(record.observed_at);
  const runId = readNullableOpaque(record.run_id);
  if ([companyId, workerInstanceId, generation, generationId, observedAt, runId].some((item) => !item.valid)) {
    return { ok: false, exactBlocker: "portable_worker_heartbeat_observation_metadata_invalid" };
  }
  if (generation.value !== null && generationId.value !== null && generation.value !== generationId.value) {
    return { ok: false, exactBlocker: "portable_worker_heartbeat_generation_mismatch" };
  }
  const effectiveGeneration = generation.value ?? generationId.value;
  const hasObservationIdentity = workerInstanceId.present || effectiveGeneration !== null || observedAt.present;
  const requiresObservationIdentity = suppliedSchema === PORTABLE_WORKER_HEARTBEAT_SCHEMA;
  if ((requiresObservationIdentity || hasObservationIdentity)
    && (workerInstanceId.value === null || effectiveGeneration === null || observedAt.value === null
      || (requiresObservationIdentity && companyId.value === null))) {
    return { ok: false, exactBlocker: "portable_worker_heartbeat_observation_metadata_incomplete" };
  }
  if (status === "idle" && runId.value !== null) return { ok: false, exactBlocker: "portable_worker_heartbeat_idle_run_binding_invalid" };
  const runtimeObservationKeys = ["runtime_observation", "browser_use_observation", "browser_use_runtime_observation"]
    .filter((key) => Object.prototype.hasOwnProperty.call(record, key));
  if (runtimeObservationKeys.length > 1) return { ok: false, exactBlocker: "portable_worker_heartbeat_observation_ambiguous" };
  const runtimeObservation = runtimeObservationKeys.length > 0
    ? parsePortableWorkerRuntimeObservation(record[runtimeObservationKeys[0]])
    : null;
  if (runtimeObservationKeys.length > 0 && runtimeObservation === null) {
    return { ok: false, exactBlocker: "portable_worker_heartbeat_runtime_observation_invalid" };
  }
  if (runtimeObservation && observedAt.value !== null && runtimeObservation.observedAt !== observedAt.value) {
    return { ok: false, exactBlocker: "portable_worker_heartbeat_observation_timestamp_mismatch" };
  }
  if (runtimeObservation && runId.value !== null && runtimeObservation.runId !== null && runtimeObservation.runId !== runId.value) {
    return { ok: false, exactBlocker: "portable_worker_heartbeat_run_binding_mismatch" };
  }
  const observedRoomId = runtimeObservation?.browserUse?.room?.roomId ?? null;
  if (runtimeObservation && runtimeObservation.roomId !== null
    && observedRoomId !== null
    && runtimeObservation.roomId !== observedRoomId) {
    return { ok: false, exactBlocker: "portable_worker_heartbeat_room_binding_mismatch" };
  }
  if (status === "idle" && runtimeObservation?.status === "idle"
    && (runtimeObservation.runId !== null || runtimeObservation.roomId !== null)) {
    return { ok: false, exactBlocker: "portable_worker_heartbeat_idle_run_binding_invalid" };
  }
  const hasChromePluginReadback = Object.prototype.hasOwnProperty.call(record, "chrome_plugin_readback");
  const chromePluginReadback = parseChromePluginReadback(record.chrome_plugin_readback);
  if (hasChromePluginReadback && record.chrome_plugin_readback !== null && chromePluginReadback === null) {
    return { ok: false, exactBlocker: "portable_worker_heartbeat_chrome_readback_invalid" };
  }
  const transportAck = Object.prototype.hasOwnProperty.call(record, "transport_ack")
    ? parsePortableWorkerTransportAck(record.transport_ack)
    : null;
  if (Object.prototype.hasOwnProperty.call(record, "transport_ack") && record.transport_ack !== null && transportAck === null) {
    return { ok: false, exactBlocker: "portable_worker_heartbeat_transport_ack_invalid" };
  }
  if (transportAck) {
    if (workerInstanceId.value !== null && transportAck.workerInstanceId !== workerInstanceId.value) {
      return { ok: false, exactBlocker: "portable_worker_heartbeat_transport_ack_binding_mismatch" };
    }
    if (effectiveGeneration !== null && transportAck.generation !== effectiveGeneration) {
      return { ok: false, exactBlocker: "portable_worker_heartbeat_transport_ack_binding_mismatch" };
    }
    if (observedAt.value !== null && transportAck.observedAt !== null && transportAck.observedAt !== observedAt.value) {
      return { ok: false, exactBlocker: "portable_worker_heartbeat_transport_ack_timestamp_mismatch" };
    }
  }
  const value: PortableWorkerHeartbeatInput = {
    workerId,
    status: status as PortableWorkerHeartbeatInput["status"],
    queueDepth,
    exactBlocker: exactBlockerRead.value,
    chromePluginReadback
  };
  if (suppliedSchema !== undefined) value.schema = suppliedSchema;
  if (companyId.value !== null) value.companyId = companyId.value;
  if (workerInstanceId.value !== null) value.workerInstanceId = workerInstanceId.value;
  if (effectiveGeneration !== null) value.generation = effectiveGeneration;
  if (observedAt.value !== null) value.observedAt = observedAt.value;
  if (runId.present || requiresObservationIdentity) value.runId = runId.value;
  if (runtimeObservationKeys.length > 0) value.runtimeObservation = runtimeObservation;
  if (Object.prototype.hasOwnProperty.call(record, "transport_ack")) value.transportAck = transportAck;

  const expectedBindings: Array<[unknown, unknown]> = [
    [options.expectedCompanyId, companyId.value],
    [options.expectedWorkerId, workerId],
    [options.expectedWorkerInstanceId, workerInstanceId.value],
    [options.expectedGeneration, effectiveGeneration]
  ];
  if (expectedBindings.some(([expectedValue, observedValue]) => (
    expectedValue !== undefined && expectedValue !== null
    && (safeOpaqueId(expectedValue) === null || safeOpaqueId(observedValue) !== safeOpaqueId(expectedValue))
  ))) return { ok: false, exactBlocker: "portable_worker_heartbeat_binding_mismatch" };
  return {
    ok: true,
    value
  };
}

export function portableWorkerHeartbeatId(companyId: string, workerId: string): string {
  return `portable_mac_worker_heartbeat_${createHash("sha256").update(`${companyId}:${workerId}`).digest("hex").slice(0, 40)}`;
}

export type PortableWorkerHeartbeatFreshness = {
  heartbeatAt: string | null;
  heartbeatAgeSeconds: number | null;
  heartbeatFresh: boolean;
  readbackStatus:
    | "stored"
    | "fresh_portable_worker_heartbeat"
    | "portable_worker_heartbeat_stale"
    | "portable_worker_heartbeat_invalid";
  exactBlocker: string | null;
};

/**
 * Live worker-status evidence is stronger than the last persisted
 * system-check row. Prefer the last successful live heartbeat, then the live
 * heartbeat, and only fall back to persisted state when live transport has
 * no usable timestamp.
 */
export function resolvePortableWorkerHeartbeatAt(input: {
  liveLastSuccessfulHeartbeatAt?: string | null;
  liveHeartbeatAt?: string | null;
  persistedHeartbeatAt?: string | null;
}): string | null {
  const candidates = [
    input.liveLastSuccessfulHeartbeatAt,
    input.liveHeartbeatAt,
    input.persistedHeartbeatAt
  ];
  return candidates.find((candidate) => (
    typeof candidate === "string"
    && candidate.trim().length > 0
    && Number.isFinite(Date.parse(candidate))
  ))?.trim() ?? null;
}

/**
 * A persisted heartbeat is evidence of the last observation, not proof that a
 * worker is connected now. Keep the freshness decision pure so API readback
 * and its regression tests share the same boundary.
 */
export function classifyPortableWorkerHeartbeat(input: {
  heartbeatAt: string | null | undefined;
  nowMs?: number;
  staleAfterSeconds?: number;
}): PortableWorkerHeartbeatFreshness {
  const heartbeatAt = typeof input.heartbeatAt === "string" && input.heartbeatAt.trim()
    ? input.heartbeatAt.trim()
    : null;
  if (!heartbeatAt) {
    return {
      heartbeatAt: null,
      heartbeatAgeSeconds: null,
      heartbeatFresh: false,
      readbackStatus: "stored",
      exactBlocker: null
    };
  }
  const timestamp = Date.parse(heartbeatAt);
  if (!Number.isFinite(timestamp)) {
    return {
      heartbeatAt,
      heartbeatAgeSeconds: null,
      heartbeatFresh: false,
      readbackStatus: "portable_worker_heartbeat_invalid",
      exactBlocker: "portable_worker_heartbeat_timestamp_invalid"
    };
  }
  const nowMs = input.nowMs ?? Date.now();
  const ageMs = nowMs - timestamp;
  if (ageMs < -30_000) {
    return {
      heartbeatAt,
      heartbeatAgeSeconds: null,
      heartbeatFresh: false,
      readbackStatus: "portable_worker_heartbeat_invalid",
      exactBlocker: "portable_worker_heartbeat_timestamp_future"
    };
  }
  const heartbeatAgeSeconds = Math.max(0, Math.floor(ageMs / 1000));
  const configuredStaleAfterSeconds = input.staleAfterSeconds ?? DEFAULT_PORTABLE_WORKER_HEARTBEAT_STALE_SECONDS;
  const staleAfterSeconds = Number.isFinite(configuredStaleAfterSeconds) && configuredStaleAfterSeconds >= 30
    ? configuredStaleAfterSeconds
    : DEFAULT_PORTABLE_WORKER_HEARTBEAT_STALE_SECONDS;
  if (heartbeatAgeSeconds > staleAfterSeconds) {
    return {
      heartbeatAt,
      heartbeatAgeSeconds,
      heartbeatFresh: false,
      readbackStatus: "portable_worker_heartbeat_stale",
      exactBlocker: "portable_worker_heartbeat_stale"
    };
  }
  return {
    heartbeatAt,
    heartbeatAgeSeconds,
    heartbeatFresh: true,
    readbackStatus: "fresh_portable_worker_heartbeat",
    exactBlocker: null
  };
}

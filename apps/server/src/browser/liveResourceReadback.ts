import { execFile as execFileCallback, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { registeredBrowserLanes } from "../runs/laneManager.js";
import {
  PORTABLE_WORKER_HEARTBEAT_LEGACY_SCHEMA,
  PORTABLE_WORKER_HEARTBEAT_SCHEMA,
  PORTABLE_WORKER_HEARTBEAT_TRANSPORT_ACK_SCHEMA,
  PORTABLE_WORKER_RUNTIME_OBSERVATION_SCHEMA,
  validatePortableWorkerHeartbeat,
  type PortableWorkerChromePluginReadback,
  type PortableWorkerHeartbeatTransportAck,
  type PortableWorkerRuntimeObservation
} from "../runs/portableWorkerHeartbeat.js";

const execFileAsync = promisify(execFileCallback);
const LIVE_PROCESS_READBACK_TIMEOUT_MS = 2_000;
const BROWSER_USE_ROOM_REGISTRY_PATH = "/Users/nichikatanaka/.browser-use-cli/home/room-registry.json";

export const BROWSER_RUNTIME_PROCESS_READBACK_SCHEMA = "aos.browser_runtime_process_readback.v1" as const;

type ProcessRow = {
  pid: number;
  ppid: number;
  command: string;
};

type SafeProcessEnv = {
  effects: "read_only" | "unknown";
  mode: "external" | "canary" | "unknown";
  durableOnly: boolean | null;
  workerId: string | null;
  workerInstanceId: string | null;
  generation: string | null;
  identityStatus: "verified" | "legacy_unbound" | "mismatch" | "unreadable" | "unknown";
  remoteOrigin: string | null;
  remoteCompanyId: string | null;
};

export type PortableRemoteWorkerScopeReadback = {
  status: "matched" | "mismatch" | "unknown" | "absent" | "unavailable";
  controlPlaneCompanyIds: string[];
  remoteWorkerCompanyIds: string[];
  remoteOrigins: string[];
  workerIds: string[];
  remoteWorkerInstanceIds: string[];
  remoteWorkerGenerations: string[];
  identityStatus: "verified" | "legacy_unbound" | "mismatch" | "unreadable" | "not_observed";
  alignmentCandidates: Array<{
    scope: "control_plane_queue" | "portable_remote_worker";
    status: "observed" | "not_observed" | "unreadable";
    companyIds: string[];
    origins: string[];
    workerIds: string[];
  }>;
  alignmentDecisionRequired: boolean;
  exactBlocker:
    | "portable_worker_company_scope_mismatch"
    | "portable_worker_company_scope_unreadable"
    | "portable_worker_identity_mismatch"
    | "portable_worker_identity_unreadable"
    | "portable_worker_heartbeat_unreadable"
    | null;
  nextAction: string;
};

export type BrowserRuntimeProcessReadbackOptions = {
  psOutput?: string | null;
  envOutputByPid?: Record<string, string | null>;
  workerStatusOutput?: string | null;
  /** Sanitized canonical Browser Use room-registry JSON for hermetic tests. */
  roomRegistryOutput?: string | null;
  controlPlaneCompanyIds?: string[];
  /** Keep server-side unit projections hermetic; production defaults to live ps readback. */
  readLiveProcessTable?: boolean;
  capturedAt?: string;
  /** Sanitized or raw heartbeat metadata persisted by the control plane. */
  remoteWorkerHeartbeat?: unknown;
  /** Backward-compatible alias used by readback callers that call this metadata. */
  heartbeatMetadata?: unknown;
};

export type PortableRemoteWorkerHeartbeatReadback = {
  readbackStatus: "reported" | "unreadable";
  identityStatus: "verified" | "legacy_unbound" | "unreadable";
  schema: string | null;
  companyId: string | null;
  workerId: string | null;
  workerInstanceId: string | null;
  generation: string | null;
  observedAt: string | null;
  heartbeatAt: string | null;
  status: "running" | "idle" | "blocked" | "unknown";
  queueDepth: number | null;
  exactBlocker: string | null;
  runId: string | null;
  runtimeObservation: PortableWorkerRuntimeObservation | null;
  transportAck: PortableWorkerHeartbeatTransportAck | null;
  chromePluginReadback: PortableWorkerChromePluginReadback | null;
};

/**
 * Async counterpart used by HTTP readbacks.  The sync helper remains for
 * worker/CLI callers, but a request must not block the Node event loop while
 * asking macOS for the process table or a worker environment projection.
 */
export async function buildBrowserRuntimeProcessReadbackAsync(options: BrowserRuntimeProcessReadbackOptions = {}) {
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  const psOutput = options.psOutput === undefined
    ? options.readLiveProcessTable === false ? "" : await readProcessTableAsync()
    : options.psOutput;
  if (psOutput === null) return buildBrowserRuntimeProcessReadback({ ...options, psOutput: null, capturedAt });
  const rows = parseProcessRows(psOutput);
  const remoteWorkerPids = rows
    .filter((row) => /aos-portable-remote-worker\.mjs/u.test(row.command))
    .map((row) => row.pid);
  const envOutputByPid: Record<string, string | null> = { ...(options.envOutputByPid ?? {}) };
  await Promise.all(remoteWorkerPids.map(async (pid) => {
    const key = String(pid);
    if (Object.prototype.hasOwnProperty.call(envOutputByPid, key)) return;
    envOutputByPid[key] = await readSafeProcessEnvAsync(pid);
  }));
  const hasBrowserProcess = rows.some((row) => parseBrowserUseProcess(row) !== null);
  const roomRegistryOutput = options.roomRegistryOutput === undefined
    ? hasBrowserProcess ? await readBrowserUseRoomRegistryAsync() : null
    : options.roomRegistryOutput;
  return buildBrowserRuntimeProcessReadback({ ...options, psOutput, envOutputByPid, roomRegistryOutput, capturedAt });
}

type BrowserRoomRecord = {
  roomId: string;
  lifecycle: "temporary" | "single-use" | "scheduled";
  state: "active" | "starting" | "held";
  ownerKind: string | null;
  ownerId: string | null;
  taskId: string | null;
  automationId: string | null;
  profileRef: string;
  port: number;
  currentActivity: string | null;
  updatedAt: string | null;
};

type BrowserRoomReadback = {
  status: "available" | "unavailable" | "invalid";
  source: "canonical_browser_use_room_registry" | "unavailable" | "invalid";
  reconciliation: "observation_only" | "not_requested" | null;
  activeRoomCount: number;
  matchedProcessCount: number;
  rooms: Array<BrowserRoomRecord & { reclaimAllowed: false }>;
  exactBlocker: "browser_use_room_registry_readback_unavailable" | "browser_use_room_registry_readback_invalid" | null;
};

export type PortableRemoteWorkerTransportReadback = {
  status: "available" | "missing" | "invalid" | "unavailable";
  heartbeatStatus: "ok" | "blocked" | "unknown";
  heartbeatExactBlocker: string | null;
  heartbeatAt: string | null;
  lastSuccessfulHeartbeatAt: string | null;
  lastAttemptAt: string | null;
  claimStatus: "claimed" | "idle" | "unknown";
  generationStartedAt: string | null;
  updatedAt: string | null;
  pid: number | null;
  workerId: string | null;
  workerInstanceId: string | null;
  generation: string | null;
  observedAt: string | null;
  identityStatus: "verified" | "legacy_unbound" | "mismatch" | "unreadable" | "unknown";
  remoteOrigin: string | null;
  source: "worker_status_file" | "heartbeat_metadata" | "missing" | "invalid" | "unavailable";
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstOwn(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) return record[key];
  }
  return undefined;
}

function copyOwn(target: Record<string, unknown>, targetKey: string, source: Record<string, unknown>, keys: readonly string[]): void {
  const value = firstOwn(source, keys);
  if (value !== undefined) target[targetKey] = value;
}

function normalizeHeartbeatProcess(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const result: Record<string, unknown> = {};
  copyOwn(result, "status", record, ["status"]);
  copyOwn(result, "pid", record, ["pid"]);
  copyOwn(result, "process_count", record, ["process_count", "processCount"]);
  copyOwn(result, "profile_ref", record, ["profile_ref", "profileRef"]);
  copyOwn(result, "port", record, ["port"]);
  return result;
}

function normalizeHeartbeatRoom(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const result: Record<string, unknown> = {};
  copyOwn(result, "status", record, ["status"]);
  copyOwn(result, "room_id", record, ["room_id", "roomId"]);
  copyOwn(result, "state", record, ["state"]);
  copyOwn(result, "lifecycle", record, ["lifecycle"]);
  copyOwn(result, "owner_kind", record, ["owner_kind", "ownerKind"]);
  copyOwn(result, "owner_id", record, ["owner_id", "ownerId"]);
  copyOwn(result, "task_id", record, ["task_id", "taskId"]);
  copyOwn(result, "automation_id", record, ["automation_id", "automationId"]);
  copyOwn(result, "profile_ref", record, ["profile_ref", "profileRef"]);
  copyOwn(result, "port", record, ["port"]);
  copyOwn(result, "current_activity", record, ["current_activity", "currentActivity"]);
  copyOwn(result, "updated_at", record, ["updated_at", "updatedAt"]);
  return result;
}

function normalizeHeartbeatRuntimeObservation(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const result: Record<string, unknown> = {};
  copyOwn(result, "schema", record, ["schema"]);
  copyOwn(result, "status", record, ["status"]);
  copyOwn(result, "observed_at", record, ["observed_at", "observedAt"]);
  copyOwn(result, "run_id", record, ["run_id", "runId"]);
  copyOwn(result, "room_id", record, ["room_id", "roomId"]);
  const browserUse = firstOwn(record, ["browser_use", "browserUse"]);
  if (browserUse !== undefined) {
    const browserRecord = asRecord(browserUse);
    if (!browserRecord) {
      result.browser_use = browserUse;
    } else {
      const browserResult: Record<string, unknown> = {};
      copyOwn(browserResult, "runtime_status", browserRecord, ["runtime_status", "runtimeStatus"]);
      const process = firstOwn(browserRecord, ["process"]);
      const room = firstOwn(browserRecord, ["room"]);
      const transport = firstOwn(browserRecord, ["transport"]);
      if (process !== undefined) browserResult.process = normalizeHeartbeatProcess(process);
      if (room !== undefined) browserResult.room = normalizeHeartbeatRoom(room);
      if (transport !== undefined) browserResult.transport = normalizeHeartbeatTransport(transport);
      result.browser_use = browserResult;
    }
  }
  return result;
}

function normalizeHeartbeatTransport(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const result: Record<string, unknown> = {};
  copyOwn(result, "status", record, ["status"]);
  copyOwn(result, "last_seen_at", record, ["last_seen_at", "lastSeenAt"]);
  return result;
}

function normalizeHeartbeatTransportAck(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const result: Record<string, unknown> = {};
  copyOwn(result, "schema", record, ["schema"]);
  copyOwn(result, "status", record, ["status"]);
  copyOwn(result, "observed_at", record, ["observed_at", "observedAt"]);
  copyOwn(result, "ack_at", record, ["ack_at", "ackAt"]);
  copyOwn(result, "worker_instance_id", record, ["worker_instance_id", "workerInstanceId"]);
  copyOwn(result, "generation", record, ["generation"]);
  copyOwn(result, "binding_status", record, ["binding_status", "bindingStatus"]);
  return result;
}

function heartbeatCandidate(input: Record<string, unknown>, fallbackCompanyId?: string | null): Record<string, unknown> {
  const candidate: Record<string, unknown> = {};
  copyOwn(candidate, "schema", input, ["schema"]);
  copyOwn(candidate, "company_id", input, ["company_id", "companyId"]);
  if (!Object.prototype.hasOwnProperty.call(candidate, "company_id") && fallbackCompanyId) {
    candidate.company_id = fallbackCompanyId;
  }
  copyOwn(candidate, "worker_id", input, ["worker_id", "workerId"]);
  copyOwn(candidate, "worker_instance_id", input, ["worker_instance_id", "workerInstanceId"]);
  copyOwn(candidate, "generation", input, ["generation", "generation_id", "generationId"]);
  copyOwn(candidate, "observed_at", input, ["observed_at", "observedAt"]);
  copyOwn(candidate, "status", input, ["status"]);
  copyOwn(candidate, "queue_depth", input, ["queue_depth", "queueDepth"]);
  copyOwn(candidate, "exact_blocker", input, ["exact_blocker", "exactBlocker"]);
  copyOwn(candidate, "run_id", input, ["run_id", "runId"]);
  const runtimeObservation = firstOwn(input, ["runtime_observation", "runtimeObservation", "browser_use_observation", "browser_use_runtime_observation"]);
  if (runtimeObservation !== undefined) candidate.runtime_observation = normalizeHeartbeatRuntimeObservation(runtimeObservation);
  const transportAck = firstOwn(input, ["transport_ack", "transportAck"]);
  if (transportAck !== undefined) candidate.transport_ack = normalizeHeartbeatTransportAck(transportAck);
  copyOwn(candidate, "chrome_plugin_readback", input, ["chrome_plugin_readback", "chromePluginReadback"]);
  return candidate;
}

function invalidPortableRemoteHeartbeat(input: Record<string, unknown>, exactBlocker: string, fallbackHeartbeatAt?: string | null): PortableRemoteWorkerHeartbeatReadback {
  const statusValue = firstOwn(input, ["status"]);
  const status = statusValue === "running" || statusValue === "idle" || statusValue === "blocked" ? statusValue : "unknown";
  const companyValue = firstOwn(input, ["company_id", "companyId"]);
  const workerValue = firstOwn(input, ["worker_id", "workerId"]);
  const instanceValue = firstOwn(input, ["worker_instance_id", "workerInstanceId"]);
  const generationValue = firstOwn(input, ["generation", "generation_id", "generationId"]);
  const observedValue = firstOwn(input, ["observed_at", "observedAt"]);
  const queueValue = firstOwn(input, ["queue_depth", "queueDepth"]);
  const runValue = firstOwn(input, ["run_id", "runId"]);
  return {
    readbackStatus: "unreadable",
    identityStatus: "unreadable",
    schema: input.schema === PORTABLE_WORKER_HEARTBEAT_SCHEMA || input.schema === PORTABLE_WORKER_HEARTBEAT_LEGACY_SCHEMA ? input.schema : null,
    companyId: typeof companyValue === "string" ? safeIdentifier(companyValue.trim()) : null,
    workerId: typeof workerValue === "string" ? safeIdentifier(workerValue.trim()) : null,
    workerInstanceId: typeof instanceValue === "string" ? safeIdentifier(instanceValue.trim()) : null,
    generation: typeof generationValue === "string" ? safeIdentifier(generationValue.trim()) : null,
    observedAt: typeof observedValue === "string" ? safeTimestamp(observedValue.trim()) : null,
    heartbeatAt: safeTimestamp(typeof firstOwn(input, ["heartbeat_at", "heartbeatAt"]) === "string" ? String(firstOwn(input, ["heartbeat_at", "heartbeatAt"])) : fallbackHeartbeatAt ?? null),
    status,
    queueDepth: typeof queueValue === "number" && Number.isSafeInteger(queueValue) && queueValue >= 0 ? queueValue : null,
    exactBlocker,
    runId: typeof runValue === "string" ? safeIdentifier(runValue.trim()) : null,
    runtimeObservation: null,
    transportAck: null,
    chromePluginReadback: null
  };
}

/**
 * Sanitize heartbeat metadata before it crosses the control-plane readback
 * boundary. This accepts both the wire snake_case envelope and the validator's
 * internal camelCase value, but never returns paths, URLs, cookies, or raw
 * untrusted metadata. A malformed persisted row remains explicit as
 * `unreadable`; it is never silently treated as no worker.
 */
export function sanitizePortableRemoteWorkerHeartbeat(
  input: unknown,
  options: { fallbackCompanyId?: string | null; fallbackHeartbeatAt?: string | null } = {}
): PortableRemoteWorkerHeartbeatReadback | null {
  const record = asRecord(input);
  if (!record) return null;
  const candidate = heartbeatCandidate(record, options.fallbackCompanyId);
  const validation = validatePortableWorkerHeartbeat(candidate);
  if (!validation.ok) return invalidPortableRemoteHeartbeat(record, validation.exactBlocker, options.fallbackHeartbeatAt);
  const value = validation.value;
  const companyId = value.companyId ?? (options.fallbackCompanyId ? safeIdentifier(options.fallbackCompanyId) : null);
  const suppliedCompanyId = firstOwn(record, ["company_id", "companyId"]);
  if (options.fallbackCompanyId && suppliedCompanyId !== undefined && companyId !== safeIdentifier(options.fallbackCompanyId)) {
    return invalidPortableRemoteHeartbeat(record, "portable_worker_company_scope_mismatch", options.fallbackHeartbeatAt);
  }
  const modernIdentityComplete = value.schema === PORTABLE_WORKER_HEARTBEAT_SCHEMA
    ? Boolean(companyId && value.workerInstanceId && value.generation && value.observedAt)
    : true;
  if (!modernIdentityComplete) {
    return invalidPortableRemoteHeartbeat(record, "portable_worker_heartbeat_observation_metadata_incomplete", options.fallbackHeartbeatAt);
  }
  const heartbeatAtValue = firstOwn(record, ["heartbeat_at", "heartbeatAt"]);
  const heartbeatAt = safeTimestamp(typeof heartbeatAtValue === "string" ? heartbeatAtValue : options.fallbackHeartbeatAt ?? null);
  const identityStatus: PortableRemoteWorkerHeartbeatReadback["identityStatus"] = value.workerInstanceId && value.generation && value.observedAt
    ? "verified"
    : "legacy_unbound";
  return {
    readbackStatus: "reported",
    identityStatus,
    // An omitted schema is the pre-v2 legacy shape, but keep it as `null` so
    // callers can distinguish an explicitly declared v1 payload (which is
    // legacy-unbound and cannot claim a generation) from an older status row
    // that predates schema tagging altogether.
    schema: value.schema ?? null,
    companyId,
    workerId: safeIdentifier(value.workerId),
    workerInstanceId: safeIdentifier(value.workerInstanceId),
    generation: safeIdentifier(value.generation),
    observedAt: safeTimestamp(value.observedAt),
    heartbeatAt,
    status: value.status,
    queueDepth: value.queueDepth,
    exactBlocker: value.exactBlocker ?? (value.status === "blocked" ? "portable_worker_heartbeat_blocked" : null),
    runId: value.runId ?? null,
    runtimeObservation: value.runtimeObservation ?? null,
    transportAck: value.transportAck ?? null,
    chromePluginReadback: value.chromePluginReadback ?? null
  };
}

export function buildBrowserRuntimeProcessReadback(options: BrowserRuntimeProcessReadbackOptions = {}) {
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  const psOutput = options.psOutput === undefined
    ? options.readLiveProcessTable === false ? "" : readProcessTable()
    : options.psOutput;
  const remoteWorkerHeartbeat = sanitizePortableRemoteWorkerHeartbeat(
    options.remoteWorkerHeartbeat ?? options.heartbeatMetadata,
    {
      fallbackCompanyId: options.controlPlaneCompanyIds?.length === 1 ? options.controlPlaneCompanyIds[0] : null,
      fallbackHeartbeatAt: capturedAt
    }
  );
  if (psOutput === null) return unavailableReadback(capturedAt, remoteWorkerHeartbeat, options.controlPlaneCompanyIds ?? []);

  const rows = parseProcessRows(psOutput);
  const browserProcesses = dedupeBrowserUseProcesses(rows
    .map((row) => parseBrowserUseProcess(row))
    .filter((row): row is ParsedBrowserUseProcess => row !== null));
  const remoteWorkers = rows
    .filter((row) => /aos-portable-remote-worker\.mjs/u.test(row.command))
    .map((row) => ({
      pid: row.pid,
      ...readSafeProcessEnv(row.pid, options.envOutputByPid?.[String(row.pid)])
    }));
  const workerTransport = readPortableRemoteWorkerTransport(options.workerStatusOutput, remoteWorkerHeartbeat);
  const roomReadback = parseBrowserUseRoomRegistry(options.roomRegistryOutput);

  const registeredLaneReadback = registeredBrowserLanes.map((lane) => {
    const profileRef = publicProfileRef(lane.profileDir) ?? lane.profileDir.split("/").at(-1) ?? "unknown";
    const exact = browserProcesses.find((process) => process.port === lane.reservedPort && process.profileRef === profileRef);
    const portMatch = browserProcesses.find((process) => process.port === lane.reservedPort);
    const profileMatch = browserProcesses.find((process) => process.profileRef === profileRef);
    const mismatch = portMatch ?? profileMatch;
    return {
      laneId: lane.id,
      workflowId: lane.workflowId,
      profileRef,
      reservedPort: lane.reservedPort,
      processStatus: exact ? "present" : mismatch ? "binding_mismatch" : "absent",
      matchingPid: exact?.pid ?? null,
      mismatchPid: exact ? null : mismatch?.pid ?? null
    } as const;
  });

  const publicBrowserProcesses = browserProcesses.map((process) => {
    const exactLane = registeredLaneReadback.find((lane) => lane.profileRef === process.profileRef && lane.reservedPort === process.port);
    const portLane = registeredLaneReadback.find((lane) => lane.reservedPort === process.port);
    const profileLane = registeredLaneReadback.find((lane) => lane.profileRef === process.profileRef);
    const relatedLane = exactLane ?? portLane ?? profileLane;
    const exactRoom = roomReadback.rooms.find((room) => room.profileRef === process.profileRef && room.port === process.port);
    const portRooms = roomReadback.rooms.filter((room) => room.port === process.port);
    const room = exactRoom ?? (portRooms.length === 1 ? portRooms[0] : null);
    const roomMatchStatus = exactRoom ? "exact_profile_port" : room ? "port_only_profile_mismatch" : "not_matched";
    return {
      kind: "browser_use_chrome",
      pid: process.pid,
      profileRef: process.profileRef,
      profileName: process.profileName,
      port: process.port,
      processCount: process.processCount,
      laneId: relatedLane?.laneId ?? null,
      workflowId: relatedLane?.workflowId ?? null,
      bindingStatus: exactLane ? "registered" : relatedLane ? "binding_mismatch" : "unregistered",
      ownership: exactLane ? "workflow_owned" : room ? "foreign_owner_bound" : "unknown",
      readbackStatus: "process_present",
      roomId: room?.roomId ?? null,
      roomState: room?.state ?? null,
      roomLifecycle: room?.lifecycle ?? null,
      roomOwnerKind: room?.ownerKind ?? null,
      roomOwnerId: room?.ownerId ?? null,
      roomTaskId: room?.taskId ?? null,
      roomAutomationId: room?.automationId ?? null,
      roomCurrentActivity: room?.currentActivity ?? null,
      roomMatchStatus,
      roomOwnership: room ? "descriptor_bound_registry" : "unknown",
      roomReclaimAllowed: room ? false : null,
      roomReadbackStatus: roomReadback.status
    } as const;
  });

  const mismatchCount = publicBrowserProcesses.filter((process) => process.bindingStatus === "binding_mismatch").length;
  const unregisteredCount = publicBrowserProcesses.filter((process) => process.bindingStatus === "unregistered").length;
  const exactBlocker = mismatchCount > 0
    ? "browser_use_live_process_binding_mismatch"
    : unregisteredCount > 0
      ? "browser_use_unregistered_live_process"
      : null;
  const portableEffects = remoteWorkers.length > 0 && remoteWorkers.every((worker) => worker.effects === "read_only")
    ? "read_only"
    : "unknown";
  const portableModes = new Set(remoteWorkers.map((worker) => worker.mode));
  const portableMode = portableModes.size === 1 ? [...portableModes][0] : "unknown";
  const durableOnlyValues = new Set(remoteWorkers.map((worker) => worker.durableOnly).filter((value): value is boolean => value !== null));
  const durableOnly = durableOnlyValues.size === 1 ? [...durableOnlyValues][0] : null;
  const workerScopeReadback = buildPortableRemoteWorkerScopeReadback({
    controlPlaneCompanyIds: options.controlPlaneCompanyIds ?? [],
    remoteWorkers: remoteWorkers.map((worker) => ({
      remoteCompanyId: worker.remoteCompanyId,
      remoteOrigin: worker.remoteOrigin ?? workerTransport.remoteOrigin,
      workerId: worker.workerId ?? workerTransport.workerId,
      workerInstanceId: worker.workerInstanceId ?? workerTransport.workerInstanceId,
      generation: worker.generation ?? workerTransport.generation,
      identityStatus: worker.identityStatus ?? workerTransport.identityStatus
    })),
    remoteHeartbeat: remoteWorkerHeartbeat
  });

  const localProcessStatus = remoteWorkers.length > 0 ? "present" : "absent";
  const portableStatus = remoteWorkers.length > 0
    ? "present"
    : remoteWorkerHeartbeat?.readbackStatus === "reported"
      ? "remote_reported"
      : remoteWorkerHeartbeat
        ? "unknown"
        : "absent";

  return {
    schema: BROWSER_RUNTIME_PROCESS_READBACK_SCHEMA,
    status: "available",
    source: "same_host_ps",
    capturedAt,
    registeredLanes: registeredLaneReadback,
    browserProcesses: publicBrowserProcesses,
    roomReadback: {
      ...roomReadback,
      matchedProcessCount: publicBrowserProcesses.filter((process) => process.roomId !== null).length
    },
    portableRemoteWorker: {
      // `status` describes the best available worker evidence. It is not a
      // process claim: a hosted control plane can have a remote heartbeat even
      // when its own same-host process table is empty.
      status: portableStatus,
      processStatus: localProcessStatus,
      processReadbackStatus: "available",
      processCount: remoteWorkers.length,
      pids: remoteWorkers.map((worker) => worker.pid),
      mode: portableMode,
      effects: portableEffects,
      durableOnly,
      processes: remoteWorkers.map((worker) => ({
        pid: worker.pid,
        workerId: worker.workerId ?? workerTransport.workerId,
        remoteOrigin: worker.remoteOrigin ?? workerTransport.remoteOrigin,
        remoteCompanyId: worker.remoteCompanyId,
        mode: worker.mode,
        effects: worker.effects,
        durableOnly: worker.durableOnly
      })),
      scopeReadback: workerScopeReadback,
      transportReadback: workerTransport,
      remoteReport: remoteWorkerHeartbeat,
      heartbeatMetadata: remoteWorkerHeartbeat
    },
    unregisteredBrowserProcessCount: unregisteredCount,
    bindingMismatchCount: mismatchCount,
    exactBlocker,
    nextAction: exactBlocker
      ? "所有者を確認できないBrowser Useプロセスは終了せず、同一Runのroom・authority・recording readbackを確認してください。"
      : workerScopeReadback.exactBlocker
        ? workerScopeReadback.nextAction
        : remoteWorkerHeartbeat?.readbackStatus === "reported"
          ? "Mac workerのheartbeat reportは受理済みです。APIホストのprocess/roomは別観測で、同一Runのreceipt/readbackを別に確認してください。"
          : remoteWorkers.length > 0
            ? "remote workerのプロセス存在は確認済みです。heartbeat、queue claim、同一Runのreceipt/readbackは別に確認してください。"
            : "登録laneを起動する場合は、AOSのworkflow-owned profile/port lockを同一Runで取得してから進めてください。",
    externalActionExecuted: false
  } as const;
}

function unavailableReadback(
  capturedAt: string,
  remoteWorkerHeartbeat: PortableRemoteWorkerHeartbeatReadback | null = null,
  controlPlaneCompanyIds: string[] = []
) {
  return {
    schema: BROWSER_RUNTIME_PROCESS_READBACK_SCHEMA,
    status: "unavailable",
    source: "unavailable",
    capturedAt,
    registeredLanes: [],
    browserProcesses: [],
    roomReadback: parseBrowserUseRoomRegistry(null),
    portableRemoteWorker: {
      status: remoteWorkerHeartbeat?.readbackStatus === "reported" ? "remote_reported" : remoteWorkerHeartbeat ? "unknown" : "unknown",
      processStatus: "unknown",
      processReadbackStatus: "unavailable",
      processCount: 0,
      pids: [],
      mode: "unknown",
      effects: "unknown",
      durableOnly: null,
      processes: [],
      scopeReadback: buildPortableRemoteWorkerScopeReadback({
        controlPlaneCompanyIds,
        remoteWorkers: [],
        unavailable: true,
        remoteHeartbeat: remoteWorkerHeartbeat
      }),
      transportReadback: readPortableRemoteWorkerTransport(null, remoteWorkerHeartbeat),
      remoteReport: remoteWorkerHeartbeat,
      heartbeatMetadata: remoteWorkerHeartbeat
    },
    unregisteredBrowserProcessCount: 0,
    bindingMismatchCount: 0,
    exactBlocker: "browser_use_same_host_process_readback_unavailable",
    nextAction: "Mac worker側でprocess identityとprofile/port lockをreadbackし、control planeへ返してください。",
    externalActionExecuted: false
  } as const;
}

function parseBrowserUseRoomRegistry(output: string | null | undefined): BrowserRoomReadback {
  if (output === undefined || output === null) {
    return {
      status: "unavailable",
      source: "unavailable",
      reconciliation: "not_requested",
      activeRoomCount: 0,
      matchedProcessCount: 0,
      rooms: [],
      exactBlocker: "browser_use_room_registry_readback_unavailable"
    };
  }
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    if (!value || typeof value !== "object" || value.schema !== "browser-use-room-registry.v1" || !Array.isArray(value.rooms)) {
      return {
        status: "invalid",
        source: "invalid",
        reconciliation: null,
        activeRoomCount: 0,
        matchedProcessCount: 0,
        rooms: [],
        exactBlocker: "browser_use_room_registry_readback_invalid"
      };
    }
    const rooms = value.rooms
      .map((raw): BrowserRoomRecord & { reclaimAllowed: false } | null => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
        const item = raw as Record<string, unknown>;
        const roomId = safeIdentifier(typeof item.room_id === "string" ? item.room_id : null);
        const lifecycle = item.lifecycle === "temporary" || item.lifecycle === "single-use" || item.lifecycle === "scheduled" ? item.lifecycle : null;
        const state = item.state === "active" || item.state === "starting" || item.state === "held" ? item.state : null;
        const profileRef = typeof item.profile === "string" ? publicProfileRef(item.profile) : null;
        const port = typeof item.port === "number" && Number.isSafeInteger(item.port) && item.port > 0 && item.port < 65536 ? item.port : null;
        const owner = item.owner && typeof item.owner === "object" && !Array.isArray(item.owner) ? item.owner as Record<string, unknown> : {};
        if (!roomId || !lifecycle || !state || !profileRef || port === null) return null;
        return {
          roomId,
          lifecycle,
          state,
          ownerKind: safeIdentifier(typeof owner.kind === "string" ? owner.kind : null),
          ownerId: safeIdentifier(typeof owner.id === "string" ? owner.id : null),
          taskId: safeIdentifier(typeof item.task_id === "string" ? item.task_id : null),
          automationId: safeIdentifier(typeof item.automation_id === "string" ? item.automation_id : null),
          profileRef,
          port,
          currentActivity: safeActivity(typeof item.current_activity === "string" ? item.current_activity : null),
          updatedAt: safeTimestamp(typeof item.updated_at === "string" ? item.updated_at : null),
          reclaimAllowed: false
        };
      })
      .filter((room): room is BrowserRoomRecord & { reclaimAllowed: false } => room !== null);
    return {
      status: "available",
      source: "canonical_browser_use_room_registry",
      reconciliation: value.reconciliation === "observation_only" ? "observation_only" : "not_requested",
      activeRoomCount: rooms.length,
      matchedProcessCount: 0,
      rooms,
      exactBlocker: null
    };
  } catch {
    return {
      status: "invalid",
      source: "invalid",
      reconciliation: null,
      activeRoomCount: 0,
      matchedProcessCount: 0,
      rooms: [],
      exactBlocker: "browser_use_room_registry_readback_invalid"
    };
  }
}

function readBrowserUseRoomRegistry(): string | null {
  try {
    const stat = lstatSync(BROWSER_USE_ROOM_REGISTRY_PATH);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (uid !== null && stat.uid !== uid) || (stat.mode & 0o077) !== 0) return null;
    return readFileSync(BROWSER_USE_ROOM_REGISTRY_PATH, "utf8");
  } catch {
    return null;
  }
}

async function readBrowserUseRoomRegistryAsync(): Promise<string | null> {
  try {
    const stat = await lstat(BROWSER_USE_ROOM_REGISTRY_PATH);
    const uid = typeof process.getuid === "function" ? process.getuid() : null;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (uid !== null && stat.uid !== uid) || (stat.mode & 0o077) !== 0) return null;
    return await readFile(BROWSER_USE_ROOM_REGISTRY_PATH, { encoding: "utf8" });
  } catch {
    return null;
  }
}

function heartbeatTransportReadback(heartbeat: PortableRemoteWorkerHeartbeatReadback): PortableRemoteWorkerTransportReadback {
  const reported = heartbeat.readbackStatus === "reported";
  const heartbeatStatus: PortableRemoteWorkerTransportReadback["heartbeatStatus"] = !reported
    ? "unknown"
    : heartbeat.status === "blocked" || heartbeat.exactBlocker ? "blocked" : "ok";
  const claimStatus: PortableRemoteWorkerTransportReadback["claimStatus"] = !reported
    ? "unknown"
    : heartbeat.runId ? "claimed" : heartbeat.status === "idle" ? "idle" : "unknown";
  return {
    status: reported ? "available" : "invalid",
    heartbeatStatus,
    heartbeatExactBlocker: heartbeat.exactBlocker,
    heartbeatAt: heartbeat.heartbeatAt,
    lastSuccessfulHeartbeatAt: heartbeatStatus === "ok" ? heartbeat.heartbeatAt : null,
    lastAttemptAt: heartbeat.heartbeatAt,
    claimStatus,
    generationStartedAt: null,
    updatedAt: heartbeat.heartbeatAt ?? heartbeat.observedAt,
    pid: null,
    workerId: heartbeat.workerId,
    workerInstanceId: heartbeat.workerInstanceId,
    generation: heartbeat.generation,
    observedAt: heartbeat.observedAt,
    identityStatus: heartbeat.identityStatus,
    remoteOrigin: null,
    source: "heartbeat_metadata"
  };
}

function readPortableRemoteWorkerTransport(
  injectedOutput?: string | null,
  remoteHeartbeat?: PortableRemoteWorkerHeartbeatReadback | null
): PortableRemoteWorkerTransportReadback {
  if (injectedOutput === null) return remoteHeartbeat ? heartbeatTransportReadback(remoteHeartbeat) : unavailableWorkerTransport("unavailable");
  const output = injectedOutput === undefined
    ? (() => {
      const repoRoot = resolve(process.env.AUTOMATION_OS_REPO_ROOT || process.cwd());
      const artifactRoot = resolve(process.env.AUTOMATION_OS_PORTABLE_REMOTE_ARTIFACT_ROOT || join(repoRoot, "data", "artifacts", "portable-remote-worker"));
      const statusPath = join(artifactRoot, "worker-status.v1.json");
      try {
        const stat = lstatSync(statusPath);
        const uid = typeof process.getuid === "function" ? process.getuid() : null;
        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (uid !== null && stat.uid !== uid) || (stat.mode & 0o077) !== 0) return null;
        return readFileSync(statusPath, "utf8");
      } catch {
        return null;
      }
    })()
    : injectedOutput;
  if (output === null) return remoteHeartbeat ? heartbeatTransportReadback(remoteHeartbeat) : unavailableWorkerTransport("missing");
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    if (!value || value.schema !== "aos.portable_remote_worker_status.v1") {
      return remoteHeartbeat ? heartbeatTransportReadback(remoteHeartbeat) : unavailableWorkerTransport("invalid");
    }
    const heartbeatStatus = value.heartbeat_status === "ok" || value.heartbeat_status === "blocked" ? value.heartbeat_status : "unknown";
    const claimStatus = value.claim_status === "claimed" || value.claim_status === "idle" ? value.claim_status : "unknown";
    const safeTimestamp = (key: string) => typeof value[key] === "string" && !Number.isNaN(Date.parse(String(value[key]))) ? String(value[key]) : null;
    const blocker = typeof value.heartbeat_exact_blocker === "string" && /^[A-Za-z0-9_.:-]{1,160}$/u.test(value.heartbeat_exact_blocker) ? value.heartbeat_exact_blocker : null;
    const pid = typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0 ? value.pid : null;
    const workerId = safeIdentifier(typeof value.worker_id === "string" ? value.worker_id : null);
    const workerInstanceId = safeIdentifier(typeof value.worker_instance_id === "string" ? value.worker_instance_id : null);
    const generation = safeIdentifier(typeof value.generation === "string" ? value.generation : null);
    const identityStatus: PortableRemoteWorkerTransportReadback["identityStatus"] = workerId && workerInstanceId && generation
      ? "verified"
      : workerId && !workerInstanceId && !generation
        ? "legacy_unbound"
        : workerInstanceId || generation
          ? "unreadable"
          : "unknown";
    const remoteOrigin = safeOrigin(typeof value.remote_origin === "string" ? value.remote_origin : null);
    const localReadback: PortableRemoteWorkerTransportReadback = {
      status: "available",
      heartbeatStatus,
      heartbeatExactBlocker: blocker,
      heartbeatAt: safeTimestamp("heartbeat_at"),
      lastSuccessfulHeartbeatAt: safeTimestamp("last_successful_heartbeat_at"),
      lastAttemptAt: safeTimestamp("last_attempt_at"),
      claimStatus,
      generationStartedAt: safeTimestamp("generation_started_at"),
      updatedAt: safeTimestamp("updated_at"),
      pid,
      workerId,
      workerInstanceId,
      generation,
      observedAt: safeTimestamp("observed_at"),
      identityStatus,
      remoteOrigin,
      source: "worker_status_file"
    };
    if (!remoteHeartbeat) return localReadback;
    // The persisted control-plane heartbeat is the newest authenticated
    // transport observation. Keep useful same-host pid/origin fields from the
    // local artifact, but do not let a stale artifact overwrite the heartbeat
    // status, timestamp, claim, or generation identity.
    const heartbeatReadback = heartbeatTransportReadback(remoteHeartbeat);
    return {
      ...heartbeatReadback,
      pid: localReadback.pid,
      generationStartedAt: localReadback.generationStartedAt,
      remoteOrigin: localReadback.remoteOrigin ?? heartbeatReadback.remoteOrigin,
      source: "heartbeat_metadata"
    };
  } catch {
    return remoteHeartbeat ? heartbeatTransportReadback(remoteHeartbeat) : unavailableWorkerTransport("invalid");
  }
}

function unavailableWorkerTransport(status: "missing" | "invalid" | "unavailable"): PortableRemoteWorkerTransportReadback {
  return {
    status,
    heartbeatStatus: "unknown",
    heartbeatExactBlocker: null,
    heartbeatAt: null,
    lastSuccessfulHeartbeatAt: null,
    lastAttemptAt: null,
    claimStatus: "unknown",
    generationStartedAt: null,
    updatedAt: null,
    pid: null,
    workerId: null,
    workerInstanceId: null,
    generation: null,
    observedAt: null,
    identityStatus: "unknown",
    remoteOrigin: null,
    source: status
  };
}

function parseProcessRows(output: string): ProcessRow[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/u);
      return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
    })
    .filter((row): row is ProcessRow => row !== null && Number.isInteger(row.pid) && row.pid > 0);
}

type ParsedBrowserUseProcess = ProcessRow & {
  profileRef: string;
  profileName: string;
  port: number;
  processCount: number;
  pids: number[];
};

function parseBrowserUseProcess(row: ProcessRow): ParsedBrowserUseProcess | null {
  if (!/(?:Google Chrome|Chromium|chrome)/iu.test(row.command)) return null;
  const portMatch = row.command.match(/--remote-debugging-port=(\d+)/u);
  const profileMatch = row.command.match(/--user-data-dir=(?:"([^"]+)"|'([^']+)'|(\S+))/u);
  if (!portMatch || !profileMatch) return null;
  const profilePath = profileMatch[1] ?? profileMatch[2] ?? profileMatch[3] ?? "";
  const profileRef = publicProfileRef(profilePath);
  if (!profileRef) return null;
  return {
    ...row,
    port: Number(portMatch[1]),
    profileRef,
    profileName: profileRef.split("/").at(-1) ?? profileRef,
    processCount: 1,
    pids: [row.pid]
  };
}

function dedupeBrowserUseProcesses(processes: ParsedBrowserUseProcess[]): ParsedBrowserUseProcess[] {
  const groups = new Map<string, ParsedBrowserUseProcess[]>();
  for (const process of processes) {
    const key = `${process.profileRef}\n${process.port}`;
    const group = groups.get(key) ?? [];
    group.push(process);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const primary = group.find((process) => process.ppid === 1) ?? [...group].sort((left, right) => left.pid - right.pid)[0];
      return {
        ...primary,
        processCount: group.length,
        pids: group.map((process) => process.pid).sort((left, right) => left - right)
      };
    })
    .sort((left, right) => left.port - right.port || left.profileRef.localeCompare(right.profileRef));
}

function publicProfileRef(profilePath: string): string | null {
  const normalized = profilePath.replaceAll("\\", "/");
  const marker = "/.browser-use-cli/profiles/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const ref = normalized.slice(markerIndex + marker.length).replace(/[^0-9A-Za-z._/-]/g, "").replace(/^\/+|\/+$/g, "");
  if (!ref || ref.length > 160) return null;
  return ref;
}

function readProcessTable(): string | null {
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout ?? "");
}

async function readProcessTableAsync(): Promise<string | null> {
  try {
    const result = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      timeout: LIVE_PROCESS_READBACK_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024
    });
    return String(result.stdout ?? "");
  } catch {
    return null;
  }
}

function readSafeProcessEnv(pid: number, injectedOutput?: string | null): SafeProcessEnv {
  const output = injectedOutput === undefined
    ? String(spawnSync("ps", ["eww", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "")
    : injectedOutput ?? "";
  const read = (key: string) => output.match(new RegExp(`(?:^|\\s)${key}=([^\\s]*)`, "u"))?.[1] ?? null;
  const effects = read("AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS");
  const mode = read("AUTOMATION_OS_PORTABLE_WORKER_MODE");
  const durableOnly = read("AUTOMATION_OS_WORKER_DURABLE_ONLY");
  const workerId = safeIdentifier(read("AUTOMATION_OS_PORTABLE_REMOTE_WORKER_ID"));
  const workerInstanceId = safeIdentifier(read("AUTOMATION_OS_PORTABLE_REMOTE_WORKER_INSTANCE_ID"));
  const generation = safeIdentifier(read("AUTOMATION_OS_PORTABLE_REMOTE_WORKER_GENERATION"));
  const remoteOrigin = safeOrigin(read("AUTOMATION_OS_PORTABLE_REMOTE_URL"));
  const remoteCompanyId = safeIdentifier(read("AUTOMATION_OS_PORTABLE_REMOTE_COMPANY_ID"));
  const identityStatus: SafeProcessEnv["identityStatus"] = workerId && remoteCompanyId && workerInstanceId && generation
    ? "verified"
    : workerId && !workerInstanceId && !generation
      ? "legacy_unbound"
      : workerInstanceId || generation
        ? "unreadable"
        : "unknown";
  return {
    effects: effects === "read_only" ? "read_only" : "unknown",
    mode: mode === "external" || mode === "canary" ? mode : "unknown",
    durableOnly: durableOnly === "1" ? true : durableOnly === "0" ? false : null,
    workerId,
    workerInstanceId,
    generation,
    identityStatus,
    remoteOrigin,
    remoteCompanyId
  };
}

async function readSafeProcessEnvAsync(pid: number): Promise<string | null> {
  try {
    const result = await execFileAsync("ps", ["eww", "-p", String(pid)], {
      encoding: "utf8",
      timeout: LIVE_PROCESS_READBACK_TIMEOUT_MS,
      maxBuffer: 512 * 1024
    });
    return String(result.stdout ?? "");
  } catch {
    return null;
  }
}

function safeIdentifier(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value) ? value : null;
}

function safeTimestamp(value: string | null | undefined): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function safeActivity(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9_.:-]{0,79}$/u.test(value) ? value : null;
}

function safeOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function buildPortableRemoteWorkerScopeReadback(input: {
  controlPlaneCompanyIds?: string[];
  remoteWorkers: Array<{
    remoteCompanyId: string | null;
    remoteOrigin: string | null;
    workerId: string | null;
    workerInstanceId?: string | null;
    generation?: string | null;
    identityStatus?: PortableRemoteWorkerScopeReadback["identityStatus"] | "unknown";
  }>;
  remoteHeartbeat?: PortableRemoteWorkerHeartbeatReadback | null;
  unavailable?: boolean;
}): PortableRemoteWorkerScopeReadback {
  let controlPlaneCompanyIds = [...new Set((input.controlPlaneCompanyIds ?? []).filter((value): value is string => Boolean(safeIdentifier(value))))].sort();
  const heartbeatWorker = input.remoteHeartbeat
    ? {
      remoteCompanyId: input.remoteHeartbeat.companyId,
      remoteOrigin: null,
      workerId: input.remoteHeartbeat.workerId,
      workerInstanceId: input.remoteHeartbeat.workerInstanceId,
      generation: input.remoteHeartbeat.generation,
      identityStatus: input.remoteHeartbeat.identityStatus
    }
    : null;
  const remoteWorkers = heartbeatWorker ? [...input.remoteWorkers, heartbeatWorker] : input.remoteWorkers;
  const remoteWorkerCompanyIds = [...new Set(remoteWorkers.map((worker) => worker.remoteCompanyId).filter((value): value is string => Boolean(safeIdentifier(value))))].sort();
  // During the Company 1 migration, the authenticated actor can still carry
  // a legacy project-* membership alongside the canonical company_* record.
  // If the live worker reports exactly one canonical company and that
  // company is present in the control-plane set, the legacy alias is not a
  // second worker scope. Keep real company mismatches fail-closed.
  if (remoteWorkerCompanyIds.length === 1
    && /^company_[A-Za-z0-9_-]+$/u.test(remoteWorkerCompanyIds[0] ?? "")
    && controlPlaneCompanyIds.includes(remoteWorkerCompanyIds[0])) {
    const canonicalCompanyId = remoteWorkerCompanyIds[0];
    const legacyAliases = controlPlaneCompanyIds.filter((companyId) => companyId !== canonicalCompanyId && /^project[-_][A-Za-z0-9_-]+$/u.test(companyId));
    if (legacyAliases.length > 0 && legacyAliases.length === controlPlaneCompanyIds.length - 1) {
      controlPlaneCompanyIds = [canonicalCompanyId];
    }
  }
  const remoteOrigins = [...new Set(remoteWorkers.map((worker) => worker.remoteOrigin).filter((value): value is string => Boolean(safeOrigin(value))))].sort();
  const workerIds = [...new Set(remoteWorkers.map((worker) => worker.workerId).filter((value): value is string => Boolean(safeIdentifier(value))))].sort();
  const remoteWorkerInstanceIds = [...new Set(remoteWorkers.map((worker) => worker.workerInstanceId).filter((value): value is string => Boolean(safeIdentifier(value))))].sort();
  const remoteWorkerGenerations = [...new Set(remoteWorkers.map((worker) => worker.generation).filter((value): value is string => Boolean(safeIdentifier(value))))].sort();
  const identityStatuses = remoteWorkers.map((worker) => worker.identityStatus ?? "unknown");
  const identityStatus: PortableRemoteWorkerScopeReadback["identityStatus"] = remoteWorkers.length === 0
    ? "not_observed"
    : input.remoteHeartbeat?.readbackStatus === "unreadable"
      ? "unreadable"
      : identityStatuses.includes("mismatch")
        ? "mismatch"
        : identityStatuses.includes("unreadable")
          ? "unreadable"
          : identityStatuses.includes("verified")
            ? "verified"
            : identityStatuses.includes("legacy_unbound")
              ? "legacy_unbound"
              : "not_observed";
  const heartbeatUnreadable = input.remoteHeartbeat?.readbackStatus === "unreadable";
  const alignmentCandidates = [
    {
      scope: "control_plane_queue" as const,
      status: controlPlaneCompanyIds.length > 0 ? "observed" as const : "not_observed" as const,
      companyIds: controlPlaneCompanyIds,
      origins: [],
      workerIds: []
    },
    {
      scope: "portable_remote_worker" as const,
      status: input.unavailable || heartbeatUnreadable || (remoteWorkers.length > 0 && remoteWorkerCompanyIds.length === 0)
        ? "unreadable" as const
        : remoteWorkers.length > 0
          ? "observed" as const
          : "not_observed" as const,
      companyIds: remoteWorkerCompanyIds,
      origins: remoteOrigins,
      workerIds
    }
  ];
  const withCandidates = (value: Omit<PortableRemoteWorkerScopeReadback, "alignmentCandidates" | "alignmentDecisionRequired">) => ({
    ...value,
    alignmentCandidates,
    alignmentDecisionRequired: value.status === "mismatch"
  });
  if (input.unavailable) {
    const heartbeatScopeMismatch = remoteWorkerCompanyIds.length > 0
      && remoteWorkerCompanyIds.some((companyId) => !controlPlaneCompanyIds.includes(companyId));
    const heartbeatScopeMatched = remoteWorkerCompanyIds.length > 0
      && controlPlaneCompanyIds.length > 0
      && !heartbeatScopeMismatch;
    return withCandidates({
      status: heartbeatScopeMismatch ? "mismatch" : heartbeatScopeMatched ? "matched" : "unavailable",
      controlPlaneCompanyIds,
      remoteWorkerCompanyIds,
      remoteOrigins,
      workerIds,
      remoteWorkerInstanceIds,
      remoteWorkerGenerations,
      identityStatus: heartbeatScopeMismatch && identityStatus === "verified" ? "mismatch" : identityStatus,
      exactBlocker: heartbeatScopeMismatch
        ? "portable_worker_company_scope_mismatch"
        : heartbeatScopeMatched ? null : "portable_worker_company_scope_unreadable",
      nextAction: heartbeatScopeMismatch
        ? "control planeのqueue scopeとMac workerのremote company scopeが異なります。同じAOS company/endpointへ揃えてからclaimしてください。"
        : heartbeatScopeMatched
          ? "Mac worker heartbeatのcompany scopeは一致しています。APIホストのprocess表は別観測として未取得です。"
          : "同一ホストのworker process readbackを取得し、control planeとworkerの会社scopeを照合してください。"
    });
  }
  if (remoteWorkers.length === 0) {
    return withCandidates({
      status: "absent",
      controlPlaneCompanyIds,
      remoteWorkerCompanyIds,
      remoteOrigins,
      workerIds,
      remoteWorkerInstanceIds,
      remoteWorkerGenerations,
      identityStatus,
      exactBlocker: null,
      nextAction: "このホスト内にはworker processがありません。別ホストの稼働は会社別queueのheartbeatと同一Run receiptで確認します。この表示だけを理由にworkerを再起動しません。"
    });
  }
  if (remoteWorkerCompanyIds.length === 0) {
    return withCandidates({
      status: "unknown",
      controlPlaneCompanyIds,
      remoteWorkerCompanyIds,
      remoteOrigins,
      workerIds,
      remoteWorkerInstanceIds,
      remoteWorkerGenerations,
      identityStatus,
      exactBlocker: heartbeatUnreadable ? "portable_worker_heartbeat_unreadable" : "portable_worker_company_scope_unreadable",
      nextAction: heartbeatUnreadable
        ? "Mac worker heartbeat metadataを再取得し、会社・worker・instance・generationのreadbackを確認してください。"
        : "workerの会社scopeをreadbackできるLaunchAgent/process環境を確認してください。"
    });
  }
  if (controlPlaneCompanyIds.length === 0) {
    return withCandidates({
      status: "unknown",
      controlPlaneCompanyIds,
      remoteWorkerCompanyIds,
      remoteOrigins,
      workerIds,
      remoteWorkerInstanceIds,
      remoteWorkerGenerations,
      identityStatus,
      exactBlocker: null,
      nextAction: "対象companyを選択して、control planeとworkerの会社scopeを比較してください。"
    });
  }
  const mismatch = remoteWorkerCompanyIds.some((companyId) => !controlPlaneCompanyIds.includes(companyId));
  if (mismatch) {
    return withCandidates({
      status: "mismatch",
      controlPlaneCompanyIds,
      remoteWorkerCompanyIds,
      remoteOrigins,
      workerIds,
      remoteWorkerInstanceIds,
      remoteWorkerGenerations,
      identityStatus: identityStatus === "verified" ? "mismatch" : identityStatus,
      exactBlocker: "portable_worker_company_scope_mismatch",
      nextAction: "control planeのqueue scopeとMac workerのremote company scopeが異なります。同じAOS company/endpointへ揃えてからclaimしてください。"
    });
  }
  if (heartbeatUnreadable) {
    return withCandidates({
      status: "unknown",
      controlPlaneCompanyIds,
      remoteWorkerCompanyIds,
      remoteOrigins,
      workerIds,
      remoteWorkerInstanceIds,
      remoteWorkerGenerations,
      identityStatus,
      exactBlocker: "portable_worker_heartbeat_unreadable",
      nextAction: "Mac worker heartbeat metadataを再取得し、現行company scopeとworker identityを照合してください。"
    });
  }
  if (input.remoteHeartbeat?.readbackStatus === "reported"
    && input.remoteHeartbeat.schema === PORTABLE_WORKER_HEARTBEAT_LEGACY_SCHEMA
    && input.remoteHeartbeat.identityStatus === "legacy_unbound") {
    return withCandidates({
      status: "matched",
      controlPlaneCompanyIds,
      remoteWorkerCompanyIds,
      remoteOrigins,
      workerIds,
      remoteWorkerInstanceIds,
      remoteWorkerGenerations,
      identityStatus,
      exactBlocker: "portable_worker_identity_unreadable",
      nextAction: "legacy heartbeatはcompany scopeのみ確認済みです。新世代worker_instance_id/generation付きheartbeatを取得してからclaimしてください。"
    });
  }
  if (identityStatus === "mismatch") {
    return withCandidates({
      status: "mismatch",
      controlPlaneCompanyIds,
      remoteWorkerCompanyIds,
      remoteOrigins,
      workerIds,
      remoteWorkerInstanceIds,
      remoteWorkerGenerations,
      identityStatus,
      exactBlocker: "portable_worker_identity_mismatch",
      nextAction: "worker instance/generationのreadbackが現在のheartbeatと一致しません。新しいgenerationを確認してからclaimしてください。"
    });
  }
  if (identityStatus === "unreadable") {
    return withCandidates({
      status: "unknown",
      controlPlaneCompanyIds,
      remoteWorkerCompanyIds,
      remoteOrigins,
      workerIds,
      remoteWorkerInstanceIds,
      remoteWorkerGenerations,
      identityStatus,
      exactBlocker: "portable_worker_identity_unreadable",
      nextAction: "worker instance/generationのreadbackが不完全です。現行worker identityを再取得してください。"
    });
  }
  return withCandidates({
    status: "matched",
    controlPlaneCompanyIds,
    remoteWorkerCompanyIds,
    remoteOrigins,
    workerIds,
    remoteWorkerInstanceIds,
    remoteWorkerGenerations,
    identityStatus,
    exactBlocker: null,
    nextAction: "同じcompany scopeを確認済みです。claim・同一Run receipt・source syncを個別に確認してください。"
  });
}

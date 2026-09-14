#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { constants, existsSync, mkdirSync, openSync, readFileSync, lstatSync, chmodSync, writeFileSync, closeSync, fsyncSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { tmpdir } from "node:os";
import { businessRunnerBindingEnvironment as resolveBusinessRunnerBindingEnvironment } from "./aos-portable-business-runner.mjs";
import { portableLocalExecutionDeadline, runPortableLocalWorkflowOffThread } from "./aos-portable-local-workflow-execution.mjs";
import { cleanupOwnedProcessGroup } from "./process-group-cleanup.mjs";

const ROOT = path.resolve(process.env.AUTOMATION_OS_REPO_ROOT || path.join(import.meta.dirname, ".."));
const REMOTE_URL = String(process.env.AUTOMATION_OS_PORTABLE_REMOTE_URL || "https://automation-os.zeabur.app").replace(/\/+$/u, "");
const COMPANY_ID = String(process.env.AUTOMATION_OS_PORTABLE_REMOTE_COMPANY_ID || "company_2560580981cedfd106b66245").trim();
const TOKEN_SERVICE = String(process.env.AUTOMATION_OS_PORTABLE_REMOTE_TOKEN_SERVICE || "Automation OS Zeabur Trigger");
const WORKER_ID = String(process.env.AUTOMATION_OS_PORTABLE_REMOTE_WORKER_ID || `mac-${hostname()}`).replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 120);
const WORKER_INSTANCE_ID = String(process.env.AUTOMATION_OS_PORTABLE_REMOTE_WORKER_INSTANCE_ID || `instance-${process.pid}-${Date.now()}-${randomUUID()}`).replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 120);
const WORKER_GENERATION = String(process.env.AUTOMATION_OS_PORTABLE_REMOTE_WORKER_GENERATION || `generation-${process.pid}-${Date.now()}-${randomUUID()}`).replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 120);
const WORKER_GENERATION_STARTED_AT = new Date().toISOString();
const WORKER_PROFILE_ID = String(process.env.AUTOMATION_OS_WORKER_PROFILE_ID || "default").replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 120);
const CODEX_ACCOUNT_REF = String(process.env.AUTOMATION_OS_CODEX_ACCOUNT_REF || "").replace(/[^A-Za-z0-9._:@+/-]/gu, "-").slice(0, 160);
const ARTIFACT_ROOT = path.resolve(process.env.AUTOMATION_OS_PORTABLE_REMOTE_ARTIFACT_ROOT || path.join(ROOT, "data", "artifacts", "portable-remote-worker"));
const WORKER_STATUS_PATH = path.join(ARTIFACT_ROOT, "worker-status.v1.json");
const READ_ONLY_RUNNER = path.join(ROOT, "scripts", "aos-portable-browser-use-runner.mjs");
const BUSINESS_RUNNER = path.join(ROOT, "scripts", "aos-portable-business-runner.mjs");
const BACKUP_EVIDENCE_READER = path.join(ROOT, "scripts", "aos-portable-backup-evidence-reader.mjs");
const POLL_MS = Math.max(5_000, Math.min(10 * 60_000, Number(process.env.AUTOMATION_OS_PORTABLE_REMOTE_POLL_MS || 30_000)));
const LOG_IDLE = String(process.env.AUTOMATION_OS_PORTABLE_REMOTE_LOG_IDLE || "0") === "1";
const DEFAULT_REMOTE_HTTP_TIMEOUT_MS = 15_000;
const PORTABLE_LOCAL_WORKFLOW_IDS = new Set([
  "email-review-reply",
  "daily-backup-safety-check",
  "obsidian-project-memory-audit",
  "nisenprints-existing-product-audit",
  "daily-ai-research-source-sync",
]);
const AOS_CHROME_COMPANION_BROWSER_SURFACE = "aos_chrome_companion_profile_instance";
const AOS_CHROME_COMPANION_TASK_ID_ENV = "AOS_CHROME_COMPANION_TASK_ID";
const heartbeatInFlight = new Map();
const registrySyncInFlight = new Map();
const registryLastSyncAt = new Map();
const CODEX_REGISTRY_SYNC_TTL_MS = 5 * 60_000;

const ZEABUR_PROJECT_ID = String(process.env.AUTOMATION_OS_ZEABUR_PROJECT_ID || "69df815a554543d46b0f2485").trim();
const ZEABUR_CODEX_APP_SERVER_SERVICE_ID = String(process.env.AUTOMATION_OS_CODEX_APP_SERVER_SERVICE_ID || "6a7777cde4a69d66638d2141").trim();
const ZEABUR_CODEX_APP_SERVER_ENVIRONMENT_ID = String(process.env.AUTOMATION_OS_CODEX_APP_SERVER_ENVIRONMENT_ID || "69df815a5ae0a69725e92048").trim();
const ZEABUR_CLI = String(process.env.AUTOMATION_OS_ZEABUR_CLI || "/usr/local/bin/zeabur").trim();
const CODEX_REGISTRY_READBACK_PATH = path.resolve(process.env.AUTOMATION_OS_CODEX_APP_SERVER_REGISTRY_READBACK_PATH || path.join(ARTIFACT_ROOT, "codex-registry-readback.v1.json"));
const CHROME_PLUGIN_READBACK_PATH = path.resolve(
  process.env.AOS_CHROME_PLUGIN_READBACK_PATH
    || path.join(String(process.env.HOME || "/Users/nichikatanaka"), ".social-flow", "aos-company1-profile2-bridge-readback-v2.json")
);
const BROWSER_USE_ROOM_REGISTRY_PATH = path.resolve(
  process.env.AUTOMATION_OS_BROWSER_USE_ROOM_REGISTRY_PATH
    || path.join(String(process.env.HOME || "/Users/nichikatanaka"), ".browser-use-cli", "home", "room-registry.json")
);
const PORTABLE_WORKER_RUNTIME_OBSERVATION_SCHEMA = "aos.portable_worker_runtime_observation.v1";
const PORTABLE_WORKER_HEARTBEAT_TRANSPORT_ACK_SCHEMA = "aos.portable_worker_heartbeat_transport_ack.v1";
const PORTABLE_WORKER_PROCESS_READBACK_TIMEOUT_MS = 2_000;

/**
 * A local AOS UI can be backed by a different PostgreSQL instance than the
 * configured Zeabur control plane.  Keep the authorities explicit instead of
 * silently assuming that both URLs share a database.  The launch helper opts
 * into both authorities so a local UI run cannot be stranded while the remote
 * queue remains supported.
 */
export function portableQueueTargets(env = process.env) {
  const authority = String(env.AUTOMATION_OS_PORTABLE_QUEUE_AUTHORITY || "remote").trim().toLowerCase();
  if (!["remote", "local", "remote_and_local"].includes(authority)) {
    throw new Error("portable_queue_authority_invalid");
  }
  const targets = [];
  const remoteUrl = String(env.AUTOMATION_OS_PORTABLE_REMOTE_URL || "https://automation-os.zeabur.app").replace(/\/+$/u, "");
  const remoteCompanyId = String(env.AUTOMATION_OS_PORTABLE_REMOTE_COMPANY_ID || "company_2560580981cedfd106b66245").trim();
  const localUrl = String(env.AUTOMATION_OS_PORTABLE_LOCAL_QUEUE_URL || "").trim().replace(/\/+$/u, "");
  const localCompanyId = String(env.AUTOMATION_OS_PORTABLE_LOCAL_QUEUE_COMPANY_ID || "").trim();
  if (authority === "remote" || authority === "remote_and_local") {
    targets.push({ kind: "remote", baseUrl: remoteUrl, companyId: remoteCompanyId, token: readPortableRemoteToken(env) });
  }
  if (authority === "local" || authority === "remote_and_local") {
    if (!localUrl) throw new Error("portable_local_queue_url_missing");
    if (!localCompanyId) throw new Error("portable_local_queue_company_id_missing");
    targets.push({ kind: "local", baseUrl: localUrl, companyId: localCompanyId, token: readPortableLocalQueueToken(env) });
  }
  return targets;
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

export function shouldEmitPortableRemoteResult(value, { force = false, logIdle = LOG_IDLE } = {}) {
  return force || logIdle || value?.status !== "idle";
}

function emitResult(value, { force = false } = {}) {
  if (!shouldEmitPortableRemoteResult(value, { force })) return;
  console.log(JSON.stringify(value));
}

export function readPortableRemoteToken(env = process.env, { keychainRunner = spawnSync } = {}) {
  const inline = String(env.AUTOMATION_OS_PORTABLE_REMOTE_TOKEN || "").trim();
  if (inline) return inline;

  const tokenFile = String(env.AUTOMATION_OS_PORTABLE_REMOTE_TOKEN_FILE || "").trim();
  if (tokenFile) {
    try {
      const stat = fs.lstatSync(path.resolve(tokenFile));
      const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (currentUid !== null && stat.uid !== currentUid) || (stat.mode & 0o077) !== 0) return "";
      return String(fs.readFileSync(path.resolve(tokenFile), "utf8")).trim();
    } catch {
      return "";
    }
  }

  const tokenService = String(env.AUTOMATION_OS_PORTABLE_REMOTE_TOKEN_SERVICE || TOKEN_SERVICE).trim();
  const result = keychainRunner("security", ["find-generic-password", "-s", tokenService, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

function readPortableLocalQueueToken(env = process.env) {
  // Do not fall back to the remote token for a loopback request.  Local AOS
  // normally runs with its loopback-unrestricted guard; a strict local server
  // must opt into its own protected token/file explicitly.
  const inline = String(env.AUTOMATION_OS_PORTABLE_LOCAL_TOKEN || "").trim();
  if (inline) return inline;
  const tokenFile = String(env.AUTOMATION_OS_PORTABLE_LOCAL_TOKEN_FILE || "").trim();
  if (!tokenFile) return "";
  try {
    const stat = fs.lstatSync(path.resolve(tokenFile));
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (currentUid !== null && stat.uid !== currentUid) || (stat.mode & 0o077) !== 0) return "";
    return String(fs.readFileSync(path.resolve(tokenFile), "utf8")).trim();
  } catch {
    return "";
  }
}

function safeChromeWorkerId(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^-?[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u.test(normalized) ? normalized : null;
}

function safeChromeWorkerBlocker(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_.:-]{1,160}$/u.test(normalized) ? normalized : null;
}

function safeChromeWorkerTimestamp(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 && normalized.length <= 64 && Number.isFinite(Date.parse(normalized)) ? normalized : null;
}

/**
 * The hosted control plane cannot read the Mac loopback bridge or its local
 * readback file.  Send only the bounded, non-secret Profile 2 identity and
 * operation projection in the authenticated heartbeat; URLs, tab content,
 * cookies, paths, and bridge endpoints never leave the worker.
 */
export function readChromePluginWorkerReadback(readbackPath = CHROME_PLUGIN_READBACK_PATH) {
  try {
    const stat = fs.lstatSync(readbackPath);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (currentUid !== null && stat.uid !== currentUid) || (stat.mode & 0o077) !== 0) return null;
    const raw = JSON.parse(fs.readFileSync(readbackPath, "utf8"));
    if (!raw || raw.schema !== "aos.chrome_plugin_bridge_readback.v2") return null;
    const operationStatus = ["ready", "read_only_ready", "target_scoped_ready", "blocked", "unknown"].includes(String(raw.operation_status))
      ? String(raw.operation_status)
      : "unknown";
    const exactBlocker = safeChromeWorkerBlocker(raw.exact_blocker);
    const operationExactBlocker = safeChromeWorkerBlocker(raw.operation_exact_blocker);
    const foregroundOnlyBlocker = new Set([
      "chrome_selected_tab_readback_invalid",
      "chrome_plugin_foreground_executor_lease_expired",
      "chrome_foreground_activation_capability_unavailable",
    ]).has(exactBlocker || operationExactBlocker || "");
    const targetScopedReady = raw.operation_ready === true
      && ["ready", "read_only_ready", "target_scoped_ready"].includes(operationStatus)
      && (raw.status === "ready" || foregroundOnlyBlocker);
    const browserRaw = raw.browser && typeof raw.browser === "object" && !Array.isArray(raw.browser) ? raw.browser : null;
    const metadata = browserRaw?.metadata && typeof browserRaw.metadata === "object" && !Array.isArray(browserRaw.metadata)
      ? browserRaw.metadata
      : {};
    const ownerRaw = raw.bridge_owner && typeof raw.bridge_owner === "object" && !Array.isArray(raw.bridge_owner)
      ? raw.bridge_owner
      : null;
    const ownerStatus = ["foreground_ready", "bridge_only", "stopped", "blocked", "unknown"].includes(String(ownerRaw?.status))
      ? String(ownerRaw.status)
      : "unknown";
    return {
      schema: "aos.portable_worker_chrome_plugin_readback.v1",
      status: ["ready", "blocked", "stopped", "stale", "unavailable"].includes(String(raw.status)) ? String(raw.status) : "unavailable",
      exact_blocker: exactBlocker,
      target_scoped_ready: targetScopedReady,
      target_scoped_exact_blocker: targetScopedReady ? null : exactBlocker || operationExactBlocker || "chrome_plugin_target_scoped_readback_unavailable",
      operation_ready: raw.operation_ready === true,
      operation_status: operationStatus,
      operation_exact_blocker: operationExactBlocker,
      bridge_instance_id: safeChromeWorkerId(raw.bridge_instance_id),
      last_seen_at: safeChromeWorkerTimestamp(raw.last_seen_at),
      browser: browserRaw ? {
        id: safeChromeWorkerId(browserRaw.id),
        type: safeChromeWorkerId(browserRaw.type),
        profile_name: safeChromeWorkerId(metadata.profileName),
        profile_ordering: safeChromeWorkerId(metadata.profileOrdering),
      } : null,
      bridge_owner: ownerRaw ? {
        schema: safeChromeWorkerId(ownerRaw.schema) || "",
        owner_id: safeChromeWorkerId(ownerRaw.owner_id),
        bridge_instance_id: safeChromeWorkerId(ownerRaw.bridge_instance_id),
        session_id: safeChromeWorkerId(ownerRaw.session_id),
        thread_id: safeChromeWorkerId(ownerRaw.thread_id),
        turn_id: safeChromeWorkerId(ownerRaw.turn_id),
        status: ownerStatus,
        foreground_executor_ready: ownerRaw.foreground_executor_ready === true,
        exact_blocker: safeChromeWorkerBlocker(ownerRaw.exact_blocker),
        updated_at: safeChromeWorkerTimestamp(ownerRaw.updated_at),
      } : null,
    };
  } catch {
    return null;
  }
}

function safePortableWorkerIdentifier(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^-?[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u.test(normalized) ? normalized : null;
}

function safePortableWorkerPublicRef(value) {
  const normalized = typeof value === "string" ? value.trim().replaceAll("\\", "/") : "";
  if (!normalized || normalized.length > 160 || normalized.startsWith("/") || normalized.includes("..") || normalized.includes("://")) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(normalized) ? normalized : null;
}

function safePortableWorkerTimestamp(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 && normalized.length <= 64 && !Number.isNaN(Date.parse(normalized)) ? normalized : null;
}

function safePortableWorkerActivity(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[a-z][a-z0-9_.:-]{0,79}$/u.test(normalized) ? normalized : null;
}

function publicBrowserUseProfileRef(value) {
  const normalized = typeof value === "string" ? value.replaceAll("\\", "/") : "";
  const marker = "/.browser-use-cli/profiles/";
  const markerIndex = normalized.lastIndexOf(marker);
  // A bare profile reference is safe; an unrecognised path is not.  Only
  // strip the known Browser Use profile root before allowing nested public
  // profile components through.
  if (markerIndex < 0) return normalized.includes("/") ? null : safePortableWorkerPublicRef(normalized);
  return safePortableWorkerPublicRef(normalized.slice(markerIndex + marker.length));
}

/** Read only the local process table; raw command text never leaves this module. */
export function readPortableWorkerProcessTable({ runner = spawnSync } = {}) {
  try {
    const result = runner("ps", ["-axo", "pid=,ppid=,command="], {
      encoding: "utf8",
      timeout: PORTABLE_WORKER_PROCESS_READBACK_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
    if (result?.error || result?.status !== 0) return null;
    return String(result.stdout || "");
  } catch {
    return null;
  }
}

function parsePortableWorkerBrowserUseProcesses(output) {
  if (typeof output !== "string") return null;
  const groups = new Map();
  for (const line of output.split(/\r?\n/u)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/u);
    if (!match || !/(?:Google Chrome|Chromium|chrome)/iu.test(match[3])) continue;
    const portMatch = match[3].match(/--remote-debugging-port=(\d+)/u);
    const profileMatch = match[3].match(/--user-data-dir=(?:"([^"]+)"|'([^']+)'|(\S+))/u);
    const port = Number(portMatch?.[1]);
    const profileRef = publicBrowserUseProfileRef(profileMatch?.[1] ?? profileMatch?.[2] ?? profileMatch?.[3]);
    if (!Number.isSafeInteger(port) || port <= 0 || port >= 65_536 || !profileRef) continue;
    const row = {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      profileRef,
      port
    };
    const key = `${profileRef}:${port}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const primary = [...group].sort((left, right) => left.pid - right.pid)[0];
      return { ...primary, processCount: group.length };
    })
    .sort((left, right) => left.port - right.port || left.profileRef.localeCompare(right.profileRef));
}

function readPortableBrowserUseRoomRegistry(roomRegistryPath = BROWSER_USE_ROOM_REGISTRY_PATH) {
  try {
    const stat = fs.lstatSync(roomRegistryPath);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1
      || (currentUid !== null && stat.uid !== currentUid) || (stat.mode & 0o077) !== 0) return null;
    return fs.readFileSync(roomRegistryPath, "utf8");
  } catch {
    return null;
  }
}

function parsePortableBrowserUseRoomRegistry(output) {
  if (typeof output !== "string") return { status: "unobserved", rooms: [] };
  try {
    const value = JSON.parse(output);
    if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schema !== "browser-use-room-registry.v1" || !Array.isArray(value.rooms)) {
      return { status: "unobserved", rooms: [] };
    }
    const rooms = value.rooms.flatMap((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const owner = raw.owner && typeof raw.owner === "object" && !Array.isArray(raw.owner) ? raw.owner : {};
      const roomId = safePortableWorkerIdentifier(raw.room_id);
      const lifecycle = ["temporary", "single-use", "scheduled"].includes(raw.lifecycle) ? raw.lifecycle : null;
      const state = ["active", "starting", "held"].includes(raw.state) ? raw.state : null;
      const profileRef = publicBrowserUseProfileRef(raw.profile);
      const port = Number(raw.port);
      if (!roomId || !lifecycle || !state || !profileRef || !Number.isSafeInteger(port) || port <= 0 || port >= 65_536) return [];
      return [{
        roomId,
        lifecycle,
        state,
        ownerKind: safePortableWorkerIdentifier(owner.kind),
        ownerId: safePortableWorkerIdentifier(owner.id),
        taskId: safePortableWorkerIdentifier(raw.task_id),
        automationId: safePortableWorkerIdentifier(raw.automation_id),
        profileRef,
        port,
        currentActivity: safePortableWorkerActivity(raw.current_activity),
        updatedAt: safePortableWorkerTimestamp(raw.updated_at)
      }];
    });
    return { status: "observed", rooms };
  } catch {
    return { status: "unobserved", rooms: [] };
  }
}

function emptyPortableWorkerRoomObservation(status) {
  return {
    status,
    room_id: null,
    state: null,
    lifecycle: null,
    owner_kind: null,
    owner_id: null,
    task_id: null,
    automation_id: null,
    profile_ref: null,
    port: null,
    current_activity: null,
    updated_at: null
  };
}

/**
 * Build a bounded Mac-local Browser Use observation.  The control plane only
 * receives this projection through the authenticated heartbeat; it cannot
 * infer it from its own ps or room registry.
 */
export function buildPortableWorkerRuntimeObservation({
  psOutput = undefined,
  roomRegistryOutput = undefined,
  roomRegistryPath = BROWSER_USE_ROOM_REGISTRY_PATH,
  runId = null,
  workerStatus = "idle",
  observedAt = new Date().toISOString(),
  processRunner = spawnSync
} = {}) {
  const effectiveObservedAt = safePortableWorkerTimestamp(observedAt) ?? new Date().toISOString();
  const processOutput = psOutput === undefined ? readPortableWorkerProcessTable({ runner: processRunner }) : psOutput;
  const processes = parsePortableWorkerBrowserUseProcesses(processOutput);
  const normalizedRunId = workerStatus === "idle" ? null : safePortableWorkerIdentifier(runId);
  // An idle worker must not turn an empty or inaccessible local process table
  // into a false stopped-process proof.  Keep all local runtime resources
  // explicitly unobserved until a run is bound to this worker generation.
  const processStatus = normalizedRunId === null
    ? "unobserved"
    : processes === null ? "unobserved" : processes.length > 0 ? "present" : "absent";
  const process = normalizedRunId === null
    ? { status: "unobserved", pid: null, process_count: null, profile_ref: null, port: null }
    : {
      status: processStatus,
      pid: processes?.[0]?.pid ?? null,
      process_count: processes === null ? null : processes[0]?.processCount ?? 0,
      profile_ref: processes?.[0]?.profileRef ?? null,
      port: processes?.[0]?.port ?? null
    };
  const registryOutput = roomRegistryOutput === undefined && processStatus === "present"
    ? readPortableBrowserUseRoomRegistry(roomRegistryPath)
    : roomRegistryOutput;
  const registry = parsePortableBrowserUseRoomRegistry(registryOutput);
  let room = null;
  if (normalizedRunId !== null) {
    const matchedRoom = processes?.[0]
      ? registry.rooms.find((candidate) => candidate.profileRef === processes[0].profileRef && candidate.port === processes[0].port)
      : null;
    room = matchedRoom
      ? {
        status: "present",
        room_id: matchedRoom.roomId,
        state: matchedRoom.state,
        lifecycle: matchedRoom.lifecycle,
        owner_kind: matchedRoom.ownerKind,
        owner_id: matchedRoom.ownerId,
        task_id: matchedRoom.taskId,
        automation_id: matchedRoom.automationId,
        profile_ref: matchedRoom.profileRef,
        port: matchedRoom.port,
        current_activity: matchedRoom.currentActivity,
        updated_at: matchedRoom.updatedAt
      }
      : emptyPortableWorkerRoomObservation(registry.status === "observed" ? "absent" : "unobserved");
  }
  const transport = normalizedRunId === null
    ? { status: "unobserved", last_seen_at: null }
    : room?.status === "present"
      ? { status: "connected", last_seen_at: room.updated_at ?? effectiveObservedAt }
      : { status: "unobserved", last_seen_at: null };
  const status = normalizedRunId === null
    ? workerStatus === "idle" ? "idle" : "unobserved"
    : processes === null ? "unobserved" : "observed";
  return {
    schema: PORTABLE_WORKER_RUNTIME_OBSERVATION_SCHEMA,
    status,
    observed_at: effectiveObservedAt,
    run_id: normalizedRunId,
    room_id: room?.room_id ?? null,
    browser_use: {
      runtime_status: processStatus,
      process,
      room,
      transport
    }
  };
}

export function buildPortableWorkerHeartbeatBody({
  companyId = COMPANY_ID,
  status = "idle",
  queueDepth = null,
  exactBlocker = null,
  runId = null,
  observedAt = new Date().toISOString(),
  runtimeObservation = undefined,
  chromePluginReadback = undefined
} = {}) {
  const observation = runtimeObservation ?? buildPortableWorkerRuntimeObservation({
    runId,
    workerStatus: status,
    observedAt
  });
  const effectiveObservedAt = safePortableWorkerTimestamp(observation?.observed_at)
    ?? safePortableWorkerTimestamp(observedAt)
    ?? new Date().toISOString();
  const normalizedRunId = status === "idle" ? null : safePortableWorkerIdentifier(runId);
  return {
    schema: "aos.portable_worker_heartbeat.v2",
    company_id: companyId,
    worker_id: WORKER_ID,
    worker_instance_id: WORKER_INSTANCE_ID,
    generation: WORKER_GENERATION,
    observed_at: effectiveObservedAt,
    status,
    queue_depth: queueDepth,
    exact_blocker: exactBlocker,
    run_id: normalizedRunId,
    runtime_observation: observation,
    chrome_plugin_readback: chromePluginReadback === undefined ? readChromePluginWorkerReadback() : chromePluginReadback
  };
}

/** Normalize a heartbeat response without treating a missing legacy echo as a new binding. */
export function normalizePortableWorkerHeartbeatAck(response, {
  companyId = COMPANY_ID,
  workerId = WORKER_ID,
  workerInstanceId = WORKER_INSTANCE_ID,
  generation = WORKER_GENERATION
} = {}, observedAt = new Date().toISOString()) {
  const record = response && typeof response === "object" && !Array.isArray(response) ? response : {};
  const nested = record.heartbeat && typeof record.heartbeat === "object" && !Array.isArray(record.heartbeat) ? record.heartbeat : {};
  const hasTransportAck = Object.prototype.hasOwnProperty.call(record, "transport_ack");
  const transportRecord = hasTransportAck && record.transport_ack && typeof record.transport_ack === "object" && !Array.isArray(record.transport_ack)
    ? record.transport_ack
    : {};
  const transportAckShapeInvalid = hasTransportAck
    && (!record.transport_ack || typeof record.transport_ack !== "object" || Array.isArray(record.transport_ack)
      || record.transport_ack.schema !== PORTABLE_WORKER_HEARTBEAT_TRANSPORT_ACK_SCHEMA);
  const ackAt = safePortableWorkerTimestamp(
    transportRecord.ack_at
      ?? record.ack_at
      ?? nested.ack_at
      ?? record.heartbeat_at
      ?? nested.heartbeat_at
  );
  const returnedCompanyId = safePortableWorkerIdentifier(transportRecord.company_id ?? record.company_id ?? nested.company_id);
  const returnedWorkerId = safePortableWorkerIdentifier(transportRecord.worker_id ?? record.worker_id ?? nested.worker_id);
  const returnedWorkerInstanceId = safePortableWorkerIdentifier(transportRecord.worker_instance_id ?? record.worker_instance_id ?? nested.worker_instance_id);
  const returnedGeneration = safePortableWorkerIdentifier(transportRecord.generation ?? record.generation ?? nested.generation);
  const hasBindingEcho = [returnedCompanyId, returnedWorkerId, returnedWorkerInstanceId, returnedGeneration]
    .some((value) => value !== null);
  const expectedValues = [companyId, workerId, workerInstanceId, generation].map((value) => safePortableWorkerIdentifier(value));
  const transportAckShape = transportRecord.schema === PORTABLE_WORKER_HEARTBEAT_TRANSPORT_ACK_SCHEMA;
  const explicitBindingStatus = ["verified", "legacy_unbound", "mismatch", "unverified"].includes(String(transportRecord.binding_status))
    ? String(transportRecord.binding_status)
    : null;
  // The v1 transport-ack projection intentionally echoes only the worker
  // instance and generation.  A legacy response may instead echo all four
  // identity fields, or none of them.  Validate whichever binding contract
  // the response actually advertises; never treat a partial legacy echo as a
  // verified binding.
  const bindingStatus = transportAckShape
    ? explicitBindingStatus === "legacy_unbound" && returnedWorkerInstanceId === null && returnedGeneration === null
      ? "legacy_unbound"
      : explicitBindingStatus === "mismatch"
        ? "mismatch"
        : expectedValues[2] !== null
          && expectedValues[3] !== null
          && returnedWorkerInstanceId === expectedValues[2]
          && returnedGeneration === expectedValues[3]
          && (explicitBindingStatus === null || explicitBindingStatus === "verified")
          ? "verified"
          : explicitBindingStatus === "unverified"
            ? "unverified"
            : "mismatch"
    : !hasBindingEcho
      ? "legacy_unbound"
      : expectedValues.every((value) => value !== null)
        && returnedCompanyId === expectedValues[0]
        && returnedWorkerId === expectedValues[1]
        && returnedWorkerInstanceId === expectedValues[2]
        && returnedGeneration === expectedValues[3]
        ? "verified"
        : "mismatch";
  const advertisedAckStatus = transportAckShape && ["acknowledged", "blocked", "unobserved", "pending"].includes(String(transportRecord.status))
    ? String(transportRecord.status)
    : null;
  return {
    schema: PORTABLE_WORKER_HEARTBEAT_TRANSPORT_ACK_SCHEMA,
    // A successful HTTP response without a server-captured heartbeat time is
    // not a usable transport acknowledgement.  Do not substitute the local
    // observation time, which would create a false fresh heartbeat.
    status: record.ok === true && !transportAckShapeInvalid && ackAt !== null
      && (advertisedAckStatus === null || advertisedAckStatus === "acknowledged")
      ? "acknowledged"
      : "blocked",
    observed_at: observedAt,
    ack_at: ackAt,
    worker_instance_id: returnedWorkerInstanceId,
    generation: returnedGeneration,
    binding_status: bindingStatus
  };
}

export function portableRemoteErrorCode(error) {
  const message = error instanceof Error ? error.message : "";
  if (message === "portable_remote_http_timeout") return message;
  if (/^portable_remote_http_\d+$/u.test(message)) return message;
  if (message === "portable_remote_heartbeat_ack_invalid" || message === "portable_remote_heartbeat_binding_mismatch") return message;
  return "portable_remote_http_failed";
}

const WORKER_STATUS_PRESERVED_FIELDS = [
  "observed_at",
  "heartbeat_observed_at",
  "heartbeat_status",
  "heartbeat_exact_blocker",
  "heartbeat_transport_status",
  "heartbeat_transport_observed_at",
  "heartbeat_ack_at",
  "heartbeat_ack_observed_at",
  "heartbeat_ack_binding_status",
  "heartbeat_ack_worker_instance_id",
  "heartbeat_ack_generation",
  "heartbeat_observation",
  "heartbeat_observation_status",
  "heartbeat_observation_run_id",
  "heartbeat_observation_room_id",
  "last_attempt_at",
  "last_successful_heartbeat_at",
  "heartbeat_at",
  "generation",
  "generation_started_at",
  "claim_status",
  "last_claim_at",
];

export function mergePortableRemoteWorkerStatus(previous, update, { targetKey = "", primary = true } = {}) {
  const source = previous && typeof previous === "object" ? previous : {};
  const preserved = Object.fromEntries(WORKER_STATUS_PRESERVED_FIELDS
    .filter((key) => Object.prototype.hasOwnProperty.call(source, key))
    .map((key) => [key, source[key]]));
  const safeUpdate = update && typeof update === "object" ? update : {};
  const merged = primary ? { ...preserved, ...safeUpdate } : { ...source };
  const existingTargetStatuses = source.target_statuses && typeof source.target_statuses === "object" && !Array.isArray(source.target_statuses)
    ? source.target_statuses
    : null;
  if (existingTargetStatuses && !Object.prototype.hasOwnProperty.call(safeUpdate, "target_statuses")) {
    merged.target_statuses = existingTargetStatuses;
  }
  if (targetKey) {
    const previousTargets = existingTargetStatuses ?? {};
    const existingTarget = previousTargets[targetKey] && typeof previousTargets[targetKey] === "object" && !Array.isArray(previousTargets[targetKey])
      ? previousTargets[targetKey]
      : {};
    merged.target_statuses = {
      ...previousTargets,
      [targetKey]: { ...existingTarget, ...safeUpdate },
    };
  }
  return merged;
}

function writeWorkerStatus(update, { targetKey = "", primary = true, primaryOrigin = REMOTE_URL } = {}) {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  const temporaryPath = `${WORKER_STATUS_PATH}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(path.dirname(WORKER_STATUS_PATH), { recursive: true, mode: 0o700 });
    let previous = {};
    if (existsSync(WORKER_STATUS_PATH)) {
      const stat = lstatSync(WORKER_STATUS_PATH);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (currentUid !== null && stat.uid !== currentUid)) return false;
      try {
        const parsed = JSON.parse(readFileSync(WORKER_STATUS_PATH, "utf8"));
        previous = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch {
        previous = {};
      }
    }
    const value = {
      schema: "aos.portable_remote_worker_status.v1",
      worker_id: WORKER_ID,
      worker_instance_id: WORKER_INSTANCE_ID,
      generation: WORKER_GENERATION,
      worker_profile_id: WORKER_PROFILE_ID,
      codex_account_ref: CODEX_ACCOUNT_REF || null,
      browser_use_helper: String(process.env.AUTOMATION_OS_BROWSER_USE_CLI_HELPER || "").trim() || null,
      pid: process.pid,
      remote_origin: (() => { try { return new URL(primaryOrigin).origin; } catch { return "invalid"; } })(),
      effects: "read_only",
      ...mergePortableRemoteWorkerStatus(previous, update, { targetKey, primary }),
      updated_at: new Date().toISOString(),
    };
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, WORKER_STATUS_PATH);
    chmodSync(WORKER_STATUS_PATH, 0o600);
    return true;
  } catch {
    try { if (existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch { /* status must never stop the worker */ }
    return false;
  }
}

function workerTargetStatusKey(target) {
  return `${target.kind}:${target.baseUrl}:${target.companyId}`;
}

export function initialPortableWorkerTargetStatuses(targets) {
  return Object.fromEntries((Array.isArray(targets) ? targets : []).map((target) => [
    workerTargetStatusKey(target),
    {
      kind: target.kind,
      base_url: target.baseUrl,
      company_id: target.companyId,
      status: "starting",
      exact_blocker: null,
      heartbeat_status: "unknown",
      heartbeat_exact_blocker: null,
      observed_at: null,
      heartbeat_observed_at: null,
      heartbeat_transport_status: "unobserved",
      heartbeat_transport_observed_at: null,
      heartbeat_ack_at: null,
      heartbeat_ack_observed_at: null,
      heartbeat_ack_binding_status: "unverified",
      heartbeat_ack_worker_instance_id: null,
      heartbeat_ack_generation: null,
      heartbeat_observation: null,
      heartbeat_observation_status: "unobserved",
      heartbeat_observation_run_id: null,
      heartbeat_observation_room_id: null,
      claim_status: "unknown",
    },
  ]));
}

function writeTargetWorkerStatus(target, update) {
  const queueAuthority = String(process.env.AUTOMATION_OS_PORTABLE_QUEUE_AUTHORITY || "remote").trim().toLowerCase();
  const primary = queueAuthority === "local" ? target.kind === "local" : target.kind === "remote";
  return writeWorkerStatus(update, {
    targetKey: workerTargetStatusKey(target),
    // The explicitly selected queue authority is the primary control-plane
    // readback. The other target, when present, remains visible under
    // target_statuses without overwriting it.
    primary,
    primaryOrigin: target.baseUrl,
  });
}

function safeWriteBytes(filePath, bytes) {
  const resolved = path.resolve(filePath);
  mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(resolved), 0o700);
  if (existsSync(resolved)) {
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || readFileSync(resolved, "utf8") !== bytes) throw new Error("portable_remote_immutable_collision");
    chmodSync(resolved, 0o600);
    return { path: resolved, sha256: sha256(bytes) };
  }
  const fd = openSync(resolved, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
  try { writeFileSync(fd, bytes, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  chmodSync(resolved, 0o600);
  return { path: resolved, sha256: sha256(bytes) };
}

function safeWrite(filePath, value) {
  return safeWriteBytes(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseJsonDocument(stdout) {
  const text = String(stdout || "")
    .replace(/\u001b\[[0-?]*[ -\/]*[@-~]/gu, "")
    .replace(/\r/g, "")
    .trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* command wrappers may add progress lines */ }
  const starts = [text.indexOf("{"), text.indexOf("[")].filter((index) => index >= 0).sort((a, b) => a - b);
  const ends = [text.lastIndexOf("}"), text.lastIndexOf("]")].filter((index) => index >= 0).sort((a, b) => b - a);
  for (const start of starts) {
    for (const end of ends) {
      if (end <= start) continue;
      try { return JSON.parse(text.slice(start, end + 1)); } catch { /* try the next bounded document */ }
    }
  }
  return null;
}

export function runZeaburServiceExec(args, { runner = spawnSync } = {}) {
  if (!ZEABUR_CLI || !ZEABUR_CODEX_APP_SERVER_SERVICE_ID || !ZEABUR_CODEX_APP_SERVER_ENVIRONMENT_ID) {
    return { ok: false, stdout: "", exactBlocker: "zeabur_service_exec_target_missing" };
  }
  try {
    const result = runner(ZEABUR_CLI, [
      "service", "exec",
      "--id", ZEABUR_CODEX_APP_SERVER_SERVICE_ID,
      "--env-id", ZEABUR_CODEX_APP_SERVER_ENVIRONMENT_ID,
      "-i=false", "--", "env", "CODEX_HOME=/data/codex", ...args
    ], { encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    // `codex login status` intentionally exits non-zero for the valid
    // unauthenticated state. Preserve its safe stdout so the caller can
    // classify it as login_not_verified instead of transport failure.
    const loginStatusReadback = args[0] === "codex" && args[1] === "login" && args[2] === "status";
    const failureText = [result.error?.message, result.stdout, result.stderr]
      .filter((value) => typeof value === "string")
      .join(" ");
    const authenticationFailure = /(?:\b401\b|unauthorized)/iu.test(failureText);
    if (authenticationFailure) return { ok: false, stdout: "", exactBlocker: "zeabur_cli_authentication_unavailable" };
    if (result.error || (result.status !== 0 && !loginStatusReadback)) return { ok: false, stdout: "", exactBlocker: "zeabur_service_exec_readback_failed" };
    return { ok: true, stdout: String(result.stdout || ""), exactBlocker: null };
  } catch {
    return { ok: false, stdout: "", exactBlocker: "zeabur_service_exec_readback_failed" };
  }
}

const CODEX_APP_LIST_READBACK_SCRIPT = String.raw`
const { spawn } = require("node:child_process");
let buffer = "";
let finished = false;
const timer = setTimeout(() => finish({ ok: false, apps: [], exactBlocker: "codex_app_server_app_list_readback_timeout" }), 9000);
function safeApps(value) {
  if (!Array.isArray(value)) return null;
  return value.flatMap((item) => {
    const record = item && typeof item === "object" && !Array.isArray(item) ? item : {};
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) return [];
    const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : name;
    return [{ id, name, isAccessible: record.isAccessible === true, isEnabled: record.isEnabled === true }];
  }).slice(0, 500);
}
function finish(value) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  process.stdout.write(JSON.stringify(value));
  try { child.kill("SIGTERM"); } catch {}
  setTimeout(() => process.exit(value.ok === true ? 0 : 1), 25).unref();
}
function send(value) {
  try { child.stdin.write(JSON.stringify(value) + "\n"); } catch { finish({ ok: false, apps: [], exactBlocker: "codex_app_server_app_list_readback_write_failed" }); }
}
const child = spawn("/usr/local/bin/codex", ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "ignore"] });
child.once("error", () => finish({ ok: false, apps: [], exactBlocker: "codex_app_server_app_list_readback_spawn_failed" }));
child.stdout.on("data", (chunk) => {
  buffer += String(chunk);
  const lines = buffer.split(/\n/u);
  buffer = lines.pop() || "";
  for (const line of lines) {
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const data = message?.method === "app/list/updated"
      ? message?.params?.data
      : message?.id === 2 && Array.isArray(message?.result?.apps) ? message.result.apps : null;
    const apps = safeApps(data);
    if (apps) finish({ ok: true, apps, exactBlocker: null });
  }
});
send({ id: 1, method: "initialize", params: { clientInfo: { name: "automation_os", title: "Automation OS", version: "1.0.0" }, capabilities: {} } });
setTimeout(() => {
  send({ method: "initialized", params: {} });
  send({ id: 2, method: "app/list", params: {} });
}, 150).unref();
`;

function safeAppAccessEntries(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = item && typeof item === "object" && !Array.isArray(item) ? item : {};
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) return [];
    const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : name;
    return [{ id, name, isAccessible: record.isAccessible === true, isEnabled: record.isEnabled === true }];
  }).slice(0, 500);
}

export function runCodexAppListReadback({ runner = spawnSync } = {}) {
  const result = runZeaburServiceExec(["node", "-e", CODEX_APP_LIST_READBACK_SCRIPT], { runner });
  if (!result.ok) return { ok: false, apps: [], exactBlocker: "zeabur_connector_access_readback_failed" };
  const document = parseJsonDocument(result.stdout);
  if (!document || document.ok !== true || !Array.isArray(document.apps)) {
    return { ok: false, apps: [], exactBlocker: "zeabur_connector_access_readback_failed" };
  }
  return { ok: true, apps: safeAppAccessEntries(document.apps), exactBlocker: null };
}

function safePluginEntries(value, accessApps = undefined) {
  if (!Array.isArray(value)) return [];
  const accessByName = new Map(safeAppAccessEntries(accessApps).map((entry) => [canonicalConnectorName(entry.name), entry]));
  return value.flatMap((item) => {
    const record = item && typeof item === "object" && !Array.isArray(item) ? item : {};
    const name = typeof record.name === "string" && record.name.trim()
      ? record.name.trim()
      : typeof record.pluginName === "string" ? record.pluginName.trim() : "";
    if (!name) return [];
    const id = typeof record.pluginId === "string" && record.pluginId.trim()
      ? record.pluginId.trim()
      : typeof record.id === "string" && record.id.trim() ? record.id.trim() : name;
    const marketplaceName = typeof record.marketplaceName === "string" && record.marketplaceName.trim()
      ? record.marketplaceName.trim()
      : id.includes("@") ? id.slice(id.lastIndexOf("@") + 1).trim() : "openai-curated";
    // App Server app display names use spaces ("Google Drive"), while the
    // marketplace/plugin names use hyphens ("google-drive").  Compare only
    // the canonical connector key so a fresh, accessible app is not
    // incorrectly persisted as unverified.
    const access = accessByName.get(canonicalConnectorName(name));
    const installed = record.installed === true;
    const authStatus = !installed
      ? "unknown"
      : access?.isAccessible === true && access.isEnabled === true ? "verified" : "unverified";
    const authPolicy = record.authPolicy === "ON_INSTALL" || record.authPolicy === "ON_USE" ? record.authPolicy : undefined;
    return [{ id, name, installed, authStatus, marketplaceName, ...(authPolicy ? { authPolicy } : {}) }];
  }).slice(0, 500);
}

function canonicalConnectorName(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
}

function safeMcpNames(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string") return item.trim() ? [item.trim()] : [];
    const record = item && typeof item === "object" && !Array.isArray(item) ? item : {};
    const name = [record.name, record.server, record.id].find((candidate) => typeof candidate === "string" && candidate.trim());
    return name ? [name.trim()] : [];
  }).slice(0, 100);
}

export function buildZeaburConnectorRegistryReadback({ login, installed, available, mcp, appReadback, capturedAt = new Date().toISOString() }) {
  const accessReadbackProvided = appReadback && typeof appReadback === "object";
  const accessApps = accessReadbackProvided && appReadback.ok === true ? appReadback.apps : undefined;
  const installedEntries = safePluginEntries(installed, accessApps);
  const availableEntries = safePluginEntries(available, accessApps).map((entry) => ({ ...entry, installed: false }));
  const connectorAuth = Object.fromEntries(installedEntries.map((entry) => [entry.name.toLowerCase(), entry.authStatus]));
  const hasInstalledConnector = (name) => installedEntries.some((entry) => entry.name.toLowerCase() === name && entry.installed === true);
  const accessReadbackBlocker = accessReadbackProvided && appReadback.ok !== true ? "zeabur_connector_access_readback_failed" : null;
  const exactBlocker = login !== "logged_in"
    ? "zeabur_codex_app_server_login_not_verified"
    : accessReadbackBlocker
      ? accessReadbackBlocker
    : !hasInstalledConnector("gmail")
      ? "zeabur_plugin_not_installed"
      : connectorAuth.gmail !== "verified" ? "zeabur_connector_auth_not_verified" : null;
  const mcpNames = safeMcpNames(mcp);
  return {
    schema: "aos_zeabur_codex_app_server_connector_registry.v1",
    capturedAt,
    source: "zeabur_service_exec",
    target: {
      projectId: ZEABUR_PROJECT_ID,
      serviceId: ZEABUR_CODEX_APP_SERVER_SERVICE_ID,
      serviceName: "codex-app-server",
      environmentId: ZEABUR_CODEX_APP_SERVER_ENVIRONMENT_ID,
    },
    appServer: {
      servicePresent: Boolean(ZEABUR_CODEX_APP_SERVER_SERVICE_ID),
      runtimeStatus: "running",
      codexLogin: login === "logged_in" ? "logged_in" : login === "not_logged_in" ? "not_logged_in" : "unknown",
    },
    pluginRegistry: { installed: installedEntries, available: availableEntries },
    connectorAccess: {
      stateReadbackAvailable: accessReadbackProvided && appReadback.ok === true,
      apps: safeAppAccessEntries(accessApps),
    },
    mcpRegistry: { configuredCount: mcpNames.length, verified: mcpNames.length > 0, names: mcpNames },
    connectorAuth,
    exactBlocker,
    secretMaterialIncluded: false,
  };
}

function writeMutableProtectedJson(filePath, value) {
  const resolved = path.resolve(filePath);
  mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (existsSync(resolved)) {
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (currentUid !== null && stat.uid !== currentUid)) throw new Error("portable_remote_registry_readback_path_invalid");
  }
  const temporaryPath = `${resolved}.tmp-${process.pid}-${Date.now()}`;
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(temporaryPath, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(temporaryPath, 0o600);
  fs.renameSync(temporaryPath, resolved);
  chmodSync(resolved, 0o600);
  return { path: resolved, sha256: sha256(bytes) };
}

export async function syncZeaburConnectorRegistry(target) {
  if (target?.kind !== "remote") return { status: "skipped", exact_blocker: null };
  const key = workerTargetStatusKey(target);
  const existing = registrySyncInFlight.get(key);
  if (existing) return existing;
  const last = registryLastSyncAt.get(key) || 0;
  if (Date.now() - last < CODEX_REGISTRY_SYNC_TTL_MS) return { status: "cached", exact_blocker: null };
  const current = (async () => {
    const loginResult = runZeaburServiceExec(["codex", "login", "status"]);
    const pluginResult = runZeaburServiceExec(["codex", "plugin", "list", "--json"]);
    const availableResult = runZeaburServiceExec(["codex", "plugin", "list", "--available", "--json"]);
    const mcpResult = runZeaburServiceExec(["codex", "mcp", "list", "--json"]);
    const appReadback = runCodexAppListReadback();
    const loginText = loginResult.stdout.toLowerCase();
    // `Not logged in` contains the substring `logged in`; classify the
    // negative state first so the registry cannot advertise a false login.
    const login = loginText.includes("not logged") || loginText.includes("logged out")
      ? "not_logged_in"
      : loginText.includes("logged in") ? "logged_in" : "unknown";
    const pluginDocument = parseJsonDocument(pluginResult.stdout);
    const availableDocument = parseJsonDocument(availableResult.stdout);
    const mcpDocument = parseJsonDocument(mcpResult.stdout);
    const registry = buildZeaburConnectorRegistryReadback({
      login,
      installed: pluginDocument?.installed,
      available: Array.isArray(availableDocument) ? availableDocument : availableDocument?.available,
      mcp: mcpDocument,
      appReadback,
      capturedAt: new Date().toISOString(),
    });
    const essentialBlocker = [loginResult, pluginResult, mcpResult, appReadback].find((result) => !result.ok)?.exactBlocker ?? null;
    const finalRegistry = essentialBlocker
      ? { ...registry, exactBlocker: essentialBlocker, appServer: { ...registry.appServer, runtimeStatus: "blocked" } }
      : registry;
    writeMutableProtectedJson(CODEX_REGISTRY_READBACK_PATH, finalRegistry);
    process.env.AUTOMATION_OS_CODEX_APP_SERVER_REGISTRY_READBACK_PATH = CODEX_REGISTRY_READBACK_PATH;
    if (!target.token) return { status: "local_readback_only", exact_blocker: "portable_remote_worker_token_missing" };
    const response = await requestTargetJson(target, `/api/v1/companies/${encodeURIComponent(target.companyId)}/codex/app-server/connector-registry/sync`, { registry: finalRegistry });
    writeMutableProtectedJson(path.join(ARTIFACT_ROOT, "codex-registry-sync-receipt.v1.json"), {
      schema: "aos.codex_registry_sync_receipt.v1",
      company_id: target.companyId,
      status: "accepted",
      action: response.receipt?.action === "codex_app_server.registry_synced" ? response.receipt.action : "codex_app_server.registry_synced",
      registry_id: typeof response.receipt?.registry_id === "string" ? response.receipt.registry_id : null,
      revision: Number.isSafeInteger(Number(response.receipt?.revision)) ? Number(response.receipt.revision) : null,
      captured_at: typeof response.receipt?.captured_at === "string" ? response.receipt.captured_at : finalRegistry.capturedAt,
      external_action_executed: false,
      secret_material_included: false,
    });
    registryLastSyncAt.set(key, Date.now());
    writeTargetWorkerStatus(target, {
      codex_registry_sync_status: "ok",
      codex_registry_exact_blocker: finalRegistry.exactBlocker,
      codex_registry_captured_at: finalRegistry.capturedAt,
    });
    return { status: "synced", exact_blocker: finalRegistry.exactBlocker, response_ok: response.ok === true };
  })().catch((error) => {
    const exactBlocker = portableRemoteErrorCode(error);
    writeTargetWorkerStatus(target, { codex_registry_sync_status: "blocked", codex_registry_exact_blocker: exactBlocker });
    return { status: "blocked", exact_blocker: exactBlocker };
  });
  registrySyncInFlight.set(key, current);
  void current.finally(() => { if (registrySyncInFlight.get(key) === current) registrySyncInFlight.delete(key); });
  return current;
}

/**
 * Persist only the server-accepted, same-run receipt fields that are safe to
 * inspect locally after the worker has posted its receipt.  A direct
 * production run/proof GET is intentionally not used here: the worker's
 * authenticated receipt POST already returns the sanitized source-of-truth
 * projection, while protected dashboard reads may require a production token.
 */
export function buildPortableProtectedReadback(claim, localReceipt, completion) {
  const claimValue = claim && typeof claim === "object" ? claim : {};
  const localValue = localReceipt && typeof localReceipt === "object" ? localReceipt : {};
  const completionValue = completion && typeof completion === "object" ? completion : {};
  const completionReceipt = completionValue.receipt && typeof completionValue.receipt === "object" && !Array.isArray(completionValue.receipt)
    ? completionValue.receipt
    : null;
  const source = completionReceipt || localValue;
  const backend = claimValue.web_operation_backend && typeof claimValue.web_operation_backend === "object"
    ? claimValue.web_operation_backend
    : {};
  const profile = backend.chrome_profile && typeof backend.chrome_profile === "object"
    ? backend.chrome_profile
    : {};
  const runId = String(claimValue.run_id || source.run_id || "").trim() || null;
  const stepId = String(claimValue.step_id || source.step_id || "").trim() || null;
  const sameRunSourceReceipt = completionValue.ok === true
    && completionReceipt !== null
    && completionReceipt.run_id === runId
    && completionReceipt.step_id === stepId
    && typeof completionReceipt.external_action_executed === "boolean";
  const browserSurface = String(source.browser_surface || claimBrowserSurface(claimValue));
  const protectedStatus = sameRunSourceReceipt ? "verified" : "PENDING_CONFIRMATION";
  return {
    schema: "aos.portable_remote_worker_protected_readback.v1",
    run_id: runId,
    job_id: typeof claimValue.job_id === "string" ? claimValue.job_id : null,
    step_id: stepId,
    workflow_id: String(claimValue.workflow_id || source.workflow_id || "").trim() || null,
    status: source.status === "complete" || source.status === "partial" || source.status === "blocked" ? source.status : "blocked",
    exact_blocker: source.exact_blocker === null || source.exact_blocker === undefined ? null : String(source.exact_blocker).slice(0, 240),
    external_action_executed: source.external_action_executed === true,
    effects_mode: source.effects_mode === "business_effect" ? "business_effect" : "read_only",
    browser_surface: browserSurface,
    backend: String(backend.resolved_backend || backend.requested_backend || (browserSurface === "signed_chrome_extension_profile2" ? "chrome_plugin" : "unknown")),
    profile_id: String(profile.id || (browserSurface === "signed_chrome_extension_profile2" ? "profile2" : "unknown")),
    browser_surface_revision: backend.revision ?? null,
    cleanup_verified: source.cleanup_verified === true,
    readback_verified: source.readback_verified === true,
    read_only_proof_verified: source.read_only_proof_verified === true,
    same_run_receipt: source.same_run_receipt === true,
    same_run_source_sync: source.same_run_source_sync === true,
    external_executor_status: typeof source.external_executor_status === "string" ? source.external_executor_status.slice(0, 240) : "unknown",
    protected_readback: {
      status: protectedStatus,
      source: "portable_worker_receipt_post_response",
      server_receipt_accepted: sameRunSourceReceipt,
      redacted: true,
      secrets_present: false,
    },
  };
}

export function persistPortableProtectedReadback(claim, localReceipt, completion, root) {
  const readback = buildPortableProtectedReadback(claim, localReceipt, completion);
  const artifact = safeWrite(path.join(root, "portable-protected-readback.v1.json"), readback);
  return { ...readback, artifact_path: artifact.path, artifact_sha256: artifact.sha256 };
}

function runRoot(runId) {
  if (!/^[A-Za-z0-9][-_A-Za-z0-9.:]{0,179}$/u.test(runId)) throw new Error("portable_remote_run_id_invalid");
  const root = path.resolve(ARTIFACT_ROOT, runId);
  const relative = path.relative(ARTIFACT_ROOT, root);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("portable_remote_run_root_invalid");
  return root;
}

export function effectAuthorityFromClaim(claim) {
  if (!claim || typeof claim !== "object") return null;
  // The HTTP claim is `effect_authority`; persisted run metadata uses the
  // explicit `portable_effect_authority` name. Accept both only at this
  // boundary, then pass the normalized object to every downstream gate.
  return claim.effect_authority || claim.portable_effect_authority || null;
}

function claimBrowserSurface(claim) {
  const explicitSurface = String(claim?.browser_surface || "");
  if (explicitSurface === "signed_chrome_extension_profile2") return "signed_chrome_extension_profile2";
  if (explicitSurface === "aos_chrome_companion_profile_instance") return "aos_chrome_companion_profile_instance";
  if (explicitSurface === "browser_use_cli") return "browser_use_cli";
  const backend = claim?.web_operation_backend && typeof claim.web_operation_backend === "object"
    ? claim.web_operation_backend
    : {};
  const backendName = String(backend.resolved_backend || backend.requested_backend || "browser_use_cli");
  if (backendName === "aos_chrome_companion") return "aos_chrome_companion_profile_instance";
  return backendName === "chrome_plugin"
    ? "signed_chrome_extension_profile2"
    : "browser_use_cli";
}

export function fixedChromePluginProfile2BlockerForClaim(claim) {
  if (String(claim?.workflow_id || "") !== "job-application-manager") return null;
  // Browser Use CLI is the canonical unattended application lane. Keep the
  // old Profile 2 and read-only Companion cases compatible so an already
  // claimed legacy run can still reconcile without replaying its effect.
  if (claim?.execution_mode === "read_only"
    && claimBrowserSurface(claim) === "aos_chrome_companion_profile_instance") return null;
  return claimBrowserSurface(claim) === "signed_chrome_extension_profile2"
    || claimBrowserSurface(claim) === "browser_use_cli"
    ? null
    : "chrome_plugin_profile2_fixed_old_run_surface_mismatch";
}

function fixedChromePluginProfile2Receipt(claim, exactBlocker) {
  return {
    status: "blocked",
    exact_blocker: exactBlocker,
    external_action_executed: false,
    browser_surface: claimBrowserSurface(claim),
    expected_browser_surface: "signed_chrome_extension_profile2",
    workflow_id: claim.workflow_id,
    run_id: claim.run_id,
    step_id: claim.step_id,
    cleanup_verified: false,
    readback_verified: false,
    effects_mode: claim.execution_mode,
    read_only_stage_bound: claim.execution_mode === "read_only",
    same_run_receipt: false,
    business_proof_verified: false,
    external_executor_status: "chrome_plugin_profile2_fixed_old_run_surface_mismatch",
  };
}

export function claimBrowserEnvironment(claim) {
  const surface = claimBrowserSurface(claim);
  if (surface === AOS_CHROME_COMPANION_BROWSER_SURFACE) {
    const backend = claim?.web_operation_backend && typeof claim.web_operation_backend === "object"
      ? claim.web_operation_backend
      : {};
    const taskId = typeof claim?.task_id === "string" ? claim.task_id.trim() : "";
    const profileInstanceId = typeof backend.companion_profile_instance_id === "string"
      ? backend.companion_profile_instance_id.trim()
      : "";
    return {
      AUTOMATION_OS_BROWSER_SURFACE: AOS_CHROME_COMPANION_BROWSER_SURFACE,
      AOS_WEB_OPERATION_BACKEND: "aos_chrome_companion",
      AUTOMATION_OS_BROWSER_DRIVER: "aos_chrome_companion",
      // Never inherit a shared worker's ambient task ID. A Companion task ID
      // is valid only when it is carried by this exact run claim.
      [AOS_CHROME_COMPANION_TASK_ID_ENV]: taskId,
      ...(profileInstanceId ? { AOS_CHROME_COMPANION_PROFILE_INSTANCE_ID: profileInstanceId } : {}),
    };
  }
  if (surface === "browser_use_cli") {
    return {
      AUTOMATION_OS_BROWSER_SURFACE: "browser_use_cli",
      AOS_WEB_OPERATION_BACKEND: "browser_use_cli",
      AUTOMATION_OS_BROWSER_DRIVER: "browser_use_cli",
    };
  }
  const backend = claim?.web_operation_backend && typeof claim.web_operation_backend === "object"
    ? claim.web_operation_backend
    : {};
  const profile = backend.chrome_profile && typeof backend.chrome_profile === "object" ? backend.chrome_profile : {};
  const home = String(process.env.HOME || "/Users/nichikatanaka").trim();
  return {
    AUTOMATION_OS_BROWSER_SURFACE: surface,
    AOS_WEB_OPERATION_BACKEND: "chrome_plugin",
    AOS_WEB_OPERATION_BACKEND_REVISION: String(backend.revision || "1"),
    AOS_WEB_OPERATION_BACKEND_SOURCE: String(backend.source || "aos_global_setting"),
    AOS_WEB_OPERATION_BACKEND_FALLBACK_ALLOWED: String(backend.fallback_allowed === false ? "false" : "true"),
    AUTOMATION_OS_BROWSER_DRIVER: "chrome_plugin",
    AOS_CHROME_PROFILE_ID: String(profile.id || "profile2"),
    AOS_CHROME_PROFILE_NAME: String(profile.name || "Profile 2"),
    AOS_CHROME_PROFILE_DIRECTORY: String(profile.directory || "Profile 2"),
    AOS_CHROME_PROFILE_SURFACE: surface,
    // Keep the detached read-only child on the same durable handoff files as
    // the official Profile 2 bridge. LaunchAgent environments can omit these
    // optional variables, and relying on a child-specific cwd/HOME then
    // produces a misleading capability-missing blocker after the bridge is
    // already healthy.
    AOS_CHROME_PLUGIN_READBACK_PATH: String(
      process.env.AOS_CHROME_PLUGIN_READBACK_PATH
        || path.join(home, ".social-flow", "aos-company1-profile2-bridge-readback-v2.json"),
    ),
    AOS_CHROME_PLUGIN_BACKGROUND_READ_ONLY_CAPABILITY_PATH: String(
      process.env.AOS_CHROME_PLUGIN_BACKGROUND_READ_ONLY_CAPABILITY_PATH
        || path.join(home, ".codex", "runtime", "aos-chrome-plugin-background-read-only-capability.v1.json"),
    ),
  };
}

export function createAdmission(claim, root) {
  const now = Date.now();
  const authority = claim.execution_mode === "business_effect" ? effectAuthorityFromClaim(claim) : null;
  if (claim.execution_mode === "business_effect" && (!authority || authority.schema !== "automation_os_portable_external_effect_authority.v1" || authority.external_action_authorized !== true || authority.first_class_root_required !== false)) {
    throw new Error("portable_remote_effect_authority_missing");
  }
  const admissionPath = path.join(root, `portable-external-admission-${sha256(`${claim.run_id}:${claim.step_id}:${claim.idempotency_key}`).slice(0, 24)}.json`);
  const approvalStatus = claim.approval_id ? "approved" : claim.execution_mode === "read_only" ? "approved" : "missing";
  const existing = readExistingAdmission(admissionPath, claim, approvalStatus, now);
  if (existing) return existing;
  return safeWrite(admissionPath, {
    schema: "automation_os_portable_external_admission.v1",
    issued_by: "automation_os_mac_worker",
    audience: "portable_external_runner",
    workflow_id: claim.workflow_id,
    run_id: claim.run_id,
    step_id: claim.step_id,
    source_trigger: claim.source_trigger,
    idempotency_key: claim.idempotency_key,
    effect_class: "external_non_idempotent",
    browser_surface: claimBrowserSurface(claim),
    external_effects: claim.execution_mode === "business_effect" ? "enabled" : "read_only",
    approval_status: approvalStatus,
    ...(authority ? {
      effect_authority_id: authority.authority_id,
      effect_authority_sha256: sha256(`${JSON.stringify(authority, null, 2)}\n`),
      timeout_controller: authority.timeout_controller,
      reconciliation_owner: authority.reconciliation_owner,
      reconciliation_required: authority.reconciliation_required,
      no_auto_retry: authority.no_auto_retry,
    } : {}),
    ...(claim.execution_mode === "business_effect" ? {
      business_effect_stage: claim.business_effect_stage,
      approval_id: claim.approval_id,
      input_bundle_sha256: claim.input_bundle_sha256,
      target_digest: claim.target_digest,
    } : {}),
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 20 * 60_000).toISOString(),
  });
}

function readExistingAdmission(admissionPath, claim, approvalStatus, now) {
  if (!fs.existsSync(admissionPath)) return null;
  let stat;
  let bytes;
  let value;
  try {
    stat = fs.lstatSync(admissionPath);
    bytes = fs.readFileSync(admissionPath);
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("portable_remote_immutable_collision");
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.uid !== currentUid || (stat.mode & 0o777) !== 0o600
    || !value || typeof value !== "object" || Array.isArray(value)
    || value.schema !== "automation_os_portable_external_admission.v1"
    || value.issued_by !== "automation_os_mac_worker"
    || value.audience !== "portable_external_runner"
    || value.workflow_id !== claim.workflow_id
    || value.run_id !== claim.run_id
    || value.step_id !== claim.step_id
    || value.source_trigger !== claim.source_trigger
    || value.idempotency_key !== claim.idempotency_key
    || value.effect_class !== "external_non_idempotent"
    || value.browser_surface !== claimBrowserSurface(claim)
    || value.external_effects !== (claim.execution_mode === "business_effect" ? "enabled" : "read_only")
    || value.approval_status !== approvalStatus
    || Date.parse(String(value.expires_at || "")) <= now
  ) {
    throw new Error("portable_remote_immutable_collision");
  }
  fs.chmodSync(admissionPath, 0o600);
  return { path: admissionPath, sha256: sha256(bytes) };
}

export function createEffectAuthorityFile(claim, root) {
  if (claim.execution_mode !== "business_effect") return null;
  const authority = effectAuthorityFromClaim(claim);
  if (!authority || authority.schema !== "automation_os_portable_external_effect_authority.v1") {
    throw new Error("portable_remote_effect_authority_missing");
  }
  const bytes = `${JSON.stringify(authority, null, 2)}\n`;
  const expected = sha256(bytes);
  if (authority.authority_id !== `portable-effect-${sha256([
    authority.company_id, authority.workflow_id, authority.run_id, authority.step_id,
    authority.effect_stage, authority.approval_id, authority.idempotency_key,
    authority.target_digest, authority.input_bundle_sha256
  ].join("\u001f")).slice(0, 32)}`) {
    throw new Error("portable_remote_effect_authority_binding_invalid");
  }
  return safeWrite(path.join(root, "portable-effect-authority.v1.json"), authority);
}

export function bindBusinessReceiptToClaim(claim, receipt) {
  if (claim?.execution_mode !== "business_effect" || !receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return receipt;
  }
  // The AOS target-bound approval receipt is authoritative.  Never accept a
  // child-run copy (or omission) as a substitute for the current claim.
  return {
    ...receipt,
    approval_receipt: claim.approval_receipt || null,
  };
}

function canonicalInputBundleSourcePath(claim, { repoRoot = ROOT, artifactRoot = ARTIFACT_ROOT } = {}) {
  if (!claim.input_bundle || !claim.input_bundle_sha256) return null;
  const canonicalArtifactRoot = path.resolve(repoRoot, "data", "artifacts");
  const remoteArtifactRoot = path.resolve(artifactRoot);
  const candidates = [
    path.join(canonicalArtifactRoot, claim.run_id, "portable-input-bundle.v1.json"),
    path.join(remoteArtifactRoot, "..", claim.run_id, "portable-input-bundle.v1.json"),
  ];
  const allowedRoots = [canonicalArtifactRoot, path.resolve(remoteArtifactRoot, "..")];
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  const seen = new Set();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved) || !allowedRoots.some((allowedRoot) => resolved === allowedRoot || resolved.startsWith(`${allowedRoot}${path.sep}`))) continue;
    seen.add(resolved);
    try {
      const stat = lstatSync(resolved);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (currentUid !== null && stat.uid !== currentUid) || (stat.mode & 0o077) !== 0) continue;
      const bytes = readFileSync(resolved, "utf8");
      if (sha256(bytes) !== claim.input_bundle_sha256) continue;
      const value = JSON.parse(bytes);
      if (!value || typeof value !== "object" || Array.isArray(value)
        || value.schema !== "automation_os_portable_workflow_input_bundle.v1"
        || value.workflow_id !== claim.workflow_id
        || value.run_id !== claim.run_id
        || !isDeepStrictEqual(value.input, claim.input_bundle)) continue;
      return resolved;
    } catch {
      // A missing or mismatched candidate is not a source fallback.
    }
  }
  return null;
}

export function createInputBundle(claim, root, options = {}) {
  if (!claim.input_bundle) return null;
  const sourcePath = canonicalInputBundleSourcePath(claim, options);
  if (claim.input_bundle_sha256 && !sourcePath) {
    const createdAt = typeof claim.input_bundle_created_at === "string" && Number.isFinite(Date.parse(claim.input_bundle_created_at))
      ? claim.input_bundle_created_at
      : null;
    if (!createdAt) throw new Error("portable_remote_input_bundle_canonical_source_missing");
    const bytes = `${JSON.stringify({
      schema: "automation_os_portable_workflow_input_bundle.v1",
      workflow_id: claim.workflow_id,
      run_id: claim.run_id,
      input: claim.input_bundle,
      created_at: createdAt,
    }, null, 2)}\n`;
    if (sha256(bytes) !== claim.input_bundle_sha256) throw new Error("portable_remote_input_bundle_digest_invalid");
    return safeWriteBytes(path.join(root, "portable-input-bundle.v1.json"), bytes);
  }
  const bytes = sourcePath
    ? readFileSync(sourcePath, "utf8")
    : `${JSON.stringify({
      schema: "automation_os_portable_workflow_input_bundle.v1",
      workflow_id: claim.workflow_id,
      run_id: claim.run_id,
      input: claim.input_bundle,
    }, null, 2)}\n`;
  if (claim.input_bundle_sha256 && sha256(bytes) !== claim.input_bundle_sha256) throw new Error("portable_remote_input_bundle_digest_invalid");
  return safeWriteBytes(path.join(root, "portable-input-bundle.v1.json"), bytes);
}

function parseFinalJson(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch { /* progress output is ignored */ }
  }
  return null;
}

/**
 * A child runner can fail before it has constructed its normal receipt
 * envelope (for example, the top-level bridge/runtime guard only knows the
 * blocker).  The remote receipt API still requires the claim binding fields.
 * Fill only absent fields from the immutable claim; preserve present values so
 * a drifted or malformed child receipt remains fail-closed at the server.
 */
export function normalizePortableRemoteRunnerReceipt(claim, parsedReceipt) {
  const parsed = parsedReceipt && typeof parsedReceipt === "object" && !Array.isArray(parsedReceipt)
    ? { ...parsedReceipt }
    : {};
  if (!["complete", "partial", "blocked"].includes(parsed.status)) parsed.status = "blocked";
  if (!Object.prototype.hasOwnProperty.call(parsed, "exact_blocker")) parsed.exact_blocker = "portable_remote_runner_receipt_missing";
  if (!Object.prototype.hasOwnProperty.call(parsed, "external_action_executed")) parsed.external_action_executed = false;
  if (!Object.prototype.hasOwnProperty.call(parsed, "browser_surface")) parsed.browser_surface = claimBrowserSurface(claim);
  if (!Object.prototype.hasOwnProperty.call(parsed, "connector_execution_owner")
    && claim.connector_execution_owner !== undefined
    && claim.connector_execution_owner !== null) {
    parsed.connector_execution_owner = claim.connector_execution_owner;
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, "workflow_id")) parsed.workflow_id = claim.workflow_id;
  if (!Object.prototype.hasOwnProperty.call(parsed, "run_id")) parsed.run_id = claim.run_id;
  if (!Object.prototype.hasOwnProperty.call(parsed, "step_id")) parsed.step_id = claim.step_id;
  if (!Object.prototype.hasOwnProperty.call(parsed, "cleanup_verified")) parsed.cleanup_verified = false;
  if (!Object.prototype.hasOwnProperty.call(parsed, "readback_verified")) parsed.readback_verified = false;
  if (!Object.prototype.hasOwnProperty.call(parsed, "effects_mode")) parsed.effects_mode = claim.execution_mode;
  if (!Object.prototype.hasOwnProperty.call(parsed, "read_only_stage_bound")) parsed.read_only_stage_bound = claim.execution_mode === "read_only";
  if (!Object.prototype.hasOwnProperty.call(parsed, "same_run_receipt")) parsed.same_run_receipt = false;
  if (!Object.prototype.hasOwnProperty.call(parsed, "business_proof_verified")) parsed.business_proof_verified = false;
  if (!Object.prototype.hasOwnProperty.call(parsed, "external_executor_status")) parsed.external_executor_status = "portable_remote_runner_failed";
  return parsed;
}

async function runRunner(claim, files) {
  const runner = claim.execution_mode === "business_effect" ? BUSINESS_RUNNER : READ_ONLY_RUNNER;
  const childArgs = [runner,
    "--workflow-id", claim.workflow_id,
    "--run-id", claim.run_id,
    "--step-id", claim.step_id,
    "--source-trigger", claim.source_trigger,
    "--idempotency-key", claim.idempotency_key,
  ];
  if (typeof claim.task_id === "string" && claim.task_id.trim()) {
    childArgs.push("--task-id", claim.task_id.trim());
  }
  const child = spawn(process.execPath, childArgs, {
    cwd: ROOT,
    env: {
      ...process.env,
      ...resolveBusinessRunnerBindingEnvironment(),
      ...claimBrowserEnvironment(claim),
      AUTOMATION_OS_CONNECTOR_EXECUTION_OWNER: claim.connector_execution_owner,
      AUTOMATION_OS_CONNECTOR_FALLBACK_ALLOWED: claim.connector_execution_owner === "mac_worker_explicit_connector_fallback" ? "1" : "0",
      AUTOMATION_OS_ARTIFACT_ROOT: ARTIFACT_ROOT,
      BROWSER_USE_CLI_HELPER: String(process.env.BROWSER_USE_CLI_HELPER || process.env.AUTOMATION_OS_BROWSER_USE_CLI_HELPER || "").trim(),
      BROWSER_USE_RUNTIME_CONFIG: String(process.env.BROWSER_USE_RUNTIME_CONFIG || process.env.AUTOMATION_OS_BROWSER_USE_CLI_RUNTIME_CONFIG || "").trim(),
      BROWSER_USE_HOME: String(process.env.BROWSER_USE_HOME || "").trim(),
      AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS: claim.execution_mode === "business_effect" ? "enabled" : "read_only",
      AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL: "approved",
      AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_PATH: files.admission.path,
      AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_SHA256: files.admission.sha256,
      AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_PATH: files.actionPlan.path,
      AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_SHA256: files.actionPlan.sha256,
      ...(files.effectAuthority ? {
        AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_REQUIRED: "1",
        AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH: files.effectAuthority.path,
        AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256: files.effectAuthority.sha256,
        AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_ID: effectAuthorityFromClaim(claim)?.authority_id || "",
      } : {}),
      ...(files.inputBundle ? { AUTOMATION_OS_PORTABLE_EXTERNAL_INPUT_BUNDLE_PATH: files.inputBundle.path } : {}),
      ...(claim.read_only_stage ? { AUTOMATION_OS_PORTABLE_EXTERNAL_READ_ONLY_STAGE: claim.read_only_stage } : {}),
      ...(claim.execution_mode === "business_effect" ? {
        AUTOMATION_OS_PORTABLE_BUSINESS_EFFECT_STAGE: claim.business_effect_stage,
        AUTOMATION_OS_PORTABLE_BUSINESS_APPROVAL_ID: claim.approval_id,
        AUTOMATION_OS_PORTABLE_BUSINESS_TARGET_DIGEST: claim.target_digest,
      } : {}),
      AUTOMATION_OS_WEB_OPERATION_CONTRACT_SCHEMA: "automation_os_web_operation_contract.v1",
      AUTOMATION_OS_WEB_OPERATION_ADAPTIVE: "semantic_live_state_bounded_exploration",
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-500_000); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-50_000); });
  const timeoutMs = Math.max(30_000, Math.min(3_600_000, Number(
    process.env.AUTOMATION_OS_PORTABLE_REMOTE_RUN_TIMEOUT_MS
      || process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_TIMEOUT_MS
      || 180_000
  )));
  const terminateRunner = (signal) => {
    if (!child.pid) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* runner may have exited between timeout and group cleanup */ }
  };
  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => {
      terminateRunner("SIGTERM");
      setTimeout(() => terminateRunner("SIGKILL"), 5_000).unref();
      finish({ code: null, signal: "SIGTERM", timed_out: true });
    }, timeoutMs);
    child.once("error", () => { clearTimeout(timer); finish({ code: null, signal: null, timed_out: false }); });
    child.once("close", (code, signal) => { clearTimeout(timer); finish({ code, signal, timed_out: false }); });
  });
  const parsedReceipt = parseFinalJson(stdout);
  let receipt = normalizePortableRemoteRunnerReceipt(claim, parsedReceipt);
  if (!parsedReceipt && result.timed_out) receipt.exact_blocker = "portable_external_worker_timeout";
  if (!parsedReceipt && !result.timed_out) receipt.exact_blocker = "portable_remote_runner_receipt_missing";
  if (claim.execution_mode === "business_effect") {
    const adapter = receipt && typeof receipt.adapter_result === "object" && !Array.isArray(receipt.adapter_result) ? receipt.adapter_result : {};
    const jobProof = claim.workflow_id === "job-application-manager"
      && adapter.state === "submitted_confirmed"
      && adapter.sync_ok === true
      && adapter.ledger_finalized === true;
    const genericProof = Boolean(receipt.runner_receipt && receipt.same_run_receipt === true);
    receipt = bindBusinessReceiptToClaim(claim, {
      ...receipt,
      effects_mode: "business_effect",
      business_effect_stage: claim.business_effect_stage,
      target_digest: claim.target_digest,
      same_run_receipt: receipt.same_run_receipt === true,
      readback_verified: receipt.readback_verified === true || jobProof || genericProof,
      business_proof_verified: jobProof || genericProof,
    });
  } else {
    if (receipt.external_action_executed === true) throw new Error("portable_remote_external_effect_reported");
    receipt = { ...receipt, effects_mode: "read_only", read_only_stage_bound: true };
  }
  // Preserve the exact child-runner envelope for same-run diagnosis. This is
  // private, run-owned evidence; the server still remains the authority for
  // completion and proof verification.
  try {
    safeWrite(path.join(runRoot(claim.run_id), "portable-runner-receipt.v1.json"), {
      schema: "aos.portable_runner_receipt.v1",
      run_id: claim.run_id,
      step_id: claim.step_id,
      workflow_id: claim.workflow_id,
      child_exit_code: result.code,
      child_signal: result.signal,
      timed_out: result.timed_out,
      receipt,
      captured_at: new Date().toISOString(),
    });
  } catch {
    // Diagnostic evidence must never change the worker's completion boundary.
  }
  return { receipt, child_exit_code: result.code, child_signal: result.signal, timed_out: result.timed_out, stderr_present: Boolean(stderr.trim()) };
}

async function processPortableLocalWorkflowClaim(claim, target) {
  const root = runRoot(claim.run_id);
  // A receipt-delivery failure or a worker crash never admits the adapter a
  // second time. Legacy receipts also count as positive prior execution.
  if (["portable-local-execution-started.v1.json", "portable-local-worker-receipt.v1.json", "portable-local-receipt-submission.v1.json"].some((name) => existsSync(path.join(root, name)))) {
    return resumePortableLocalReceiptOnly(claim, target, root);
  }
  if (!claimPortableLocalMarker(path.join(root, "portable-local-execution-started.v1.json"), {
    schema: "aos.portable_local_execution_started.v1", run_id: claim.run_id, step_id: claim.step_id,
    workflow_id: claim.workflow_id, company_id: claim.company_id, idempotency_key: claim.idempotency_key
  })) return resumePortableLocalReceiptOnly(claim, target, root);
  let localReceipt;
  let observedExternalAction = false;
  let artifactUri = "";
  const business = claim.execution_mode === "business_effect";
  let effectAuthority = null;
  let admission = null;
  let inputBundle = null;
  try {
    if (business) {
      effectAuthority = createEffectAuthorityFile(claim, root);
      admission = createAdmission(claim, root);
      inputBundle = createInputBundle(claim, root);
      const businessInput = {
        workflowId: claim.workflow_id,
        workerRole: process.env.AUTOMATION_OS_WORKER_ROLE?.trim() || "mac",
        companyId: claim.company_id,
        runId: claim.run_id,
        stepId: claim.step_id,
        idempotencyKey: claim.idempotency_key,
        targetDigest: claim.target_digest,
        inputBundleSha256: claim.input_bundle_sha256,
        inputBundle: claim.input_bundle || {},
        authorityExpiresAt: effectAuthorityFromClaim(claim)?.expires_at ?? "",
      };
      portableLocalExecutionDeadline(claim);
      observedExternalAction = null;
      localReceipt = await runPortableLocalWorkflowOffThread(claim, businessInput);
      observedExternalAction = localReceipt.external_action_executed;
    } else if (claim.workflow_id === "email-review-reply") {
      const response = await requestPortableRemoteJson(
        `${target.baseUrl}/api/v1/companies/${encodeURIComponent(claim.company_id)}/connectors/gmail/review-read-only`,
        target.token, { run_id: claim.run_id }, { companyId: claim.company_id, timeoutMs: 300_000, localWorker: target.kind === "local" }
      );
      const review = response.review;
      if (!review || review.run_id !== claim.run_id || review.company_id !== claim.company_id) throw new Error("gmail_review_response_binding_invalid");
      observedExternalAction = review.external_action_executed === true;
      if (observedExternalAction) throw new Error("gmail_review_read_only_boundary_violation");
      localReceipt = {
        status: review.status, exact_blocker: review.exact_blocker,
        external_action_executed: false, workflow_id: claim.workflow_id,
        read_only_stage_bound: true, readback_verified: review.status === "complete", cleanup_verified: true,
        business_completion_verified: false,
        adapter_result: { connector: "gmail", connector_execution_owner: "zeabur_codex_app_server", review, review_only: true, send_completed: false },
      };
    } else {
      localReceipt = await runPortableLocalWorkflowOffThread(claim, {
        workflowId: claim.workflow_id,
        runId: claim.run_id,
        workerRole: process.env.AUTOMATION_OS_WORKER_ROLE?.trim() || "mac",
        companyId: claim.company_id,
        companyConnectionVerified: claim.company_connection_verified === true,
      });
    }
    const artifact = safeWrite(path.join(root, "portable-local-worker-receipt.v1.json"), {
      schema: "aos.portable_local_worker_receipt.v1",
      ...localReceipt,
      run_id: claim.run_id,
      step_id: claim.step_id,
      adapter: "portable_local_workflow",
      created_at: new Date().toISOString(),
    });
    artifactUri = `file://${artifact.path}`;
  } catch (error) {
    localReceipt = {
      status: "blocked",
      exact_blocker: error instanceof Error ? error.message.slice(0, 240) : "portable_local_worker_setup_failed",
      external_action_executed: observedExternalAction,
      workflow_id: claim.workflow_id,
      read_only_stage_bound: !business,
      readback_verified: false,
      cleanup_verified: localReceipt?.cleanup_verified ?? observedExternalAction === false,
      business_completion_verified: false,
      same_run_receipt: false,
      same_run_source_sync: false,
      adapter_result: { execution_surface: "mac_local_worker", artifact_uri: artifactUri },
      runner_receipt: { business_proofs: {} },
    };
  }
  const completed = localReceipt.status === "complete" && localReceipt.exact_blocker === null && localReceipt.cleanup_verified === true;
  const externalActionExecuted = localReceipt.external_action_executed;
  if (localReceipt.status === "complete" && !completed) localReceipt = { ...localReceipt, status: "blocked", exact_blocker: "portable_local_child_cleanup_unverified" };
  const payloadHash = typeof claim.input_bundle?.payload_hash === "string" ? claim.input_bundle.payload_hash : null;
  const lifecycle = business ? {
    schema: "automation_os_web_operation_lifecycle.v1",
    state: externalActionExecuted === true && completed ? "completed" : externalActionExecuted !== false ? "effect_unknown" : "blocked",
    status: externalActionExecuted === true && completed ? "complete" : "blocked",
    run_id: claim.run_id,
    step_id: claim.step_id,
    idempotency_key: claim.idempotency_key,
    operation: claim.workflow_id === "daily-ai-research-source-sync" ? "update" : "publish",
    target_digest: claim.target_digest,
    payload_hash: payloadHash,
    external_action_executed: externalActionExecuted,
    same_run_receipt: localReceipt.same_run_receipt === true,
    readback_verified: localReceipt.readback_verified === true,
    cleanup_verified: localReceipt.cleanup_verified === true,
    no_replay: true,
    exact_blocker: localReceipt.exact_blocker,
  } : null;
  const receipt = {
    status: localReceipt.status,
    exact_blocker: localReceipt.exact_blocker,
    external_action_executed: externalActionExecuted,
    browser_surface: "local_worker",
    workflow_id: claim.workflow_id,
    run_id: claim.run_id,
    step_id: claim.step_id,
    cleanup_verified: localReceipt.cleanup_verified === true,
    readback_verified: localReceipt.readback_verified === true,
    effects_mode: business ? "business_effect" : "read_only",
    read_only_stage_bound: !business,
    business_effect_stage: business ? claim.business_effect_stage : undefined,
    same_run_receipt: business ? localReceipt.same_run_receipt === true : completed,
    business_proof_verified: business ? localReceipt.business_completion_verified === true : false,
    read_only_proof_verified: business ? false : completed,
    external_executor_status: business
      ? (completed ? "portable_local_business_worker_completed" : "portable_local_business_worker_blocked")
      : (completed ? "portable_local_worker_completed" : "portable_local_worker_blocked"),
    ...(business ? {
      target_digest: claim.target_digest,
      input_bundle_sha256: claim.input_bundle_sha256,
      approval_receipt: claim.approval_receipt,
      effect_authority_id: effectAuthority?.path ? effectAuthorityFromClaim(claim)?.authority_id : undefined,
      effect_authority_sha256: effectAuthority?.sha256,
      same_run_source_sync: localReceipt.same_run_source_sync === true,
      web_operation_lifecycle: lifecycle,
      runner_receipt: localReceipt.runner_receipt,
    } : {}),
    adapter_result: {
      local_workflow_receipt: true,
      execution_surface: "mac_local_worker",
      artifact_uri: artifactUri,
      cleanup_verified: localReceipt.cleanup_verified === true,
      readback_verified: localReceipt.readback_verified === true,
      business_completion_verified: business ? localReceipt.business_completion_verified === true : false,
      local_receipt: localReceipt.adapter_result,
      ...(business ? { remote_verified: localReceipt.adapter_result?.remote_verified === true } : {}),
    },
  };
  const submission = await submitPortableLocalReceipt(claim, target, receipt, runRoot(claim.run_id));
  if (submission.status !== "recorded") return submission;
  const completion = submission.completion;
  return {
    status: completion.receipt.status,
    run_id: claim.run_id,
    workflow_id: claim.workflow_id,
    step_id: claim.step_id,
    exact_blocker: completion.receipt.exact_blocker,
    external_action_executed: externalActionExecuted,
    browser_surface: "local_worker",
    cleanup_verified: receipt.cleanup_verified,
    readback_verified: receipt.readback_verified,
    remote_replayed: completion.replayed === true,
    child_exit_code: completed ? 0 : 1,
    child_signal: null,
  };
}

/** Run only the fixed backup verifier; this path never starts a business runner. */
export async function runPortableBackupEvidenceVerifier(claim, { spawnProcess = spawn } = {}) {
  if (!claim?.evidence_only || claim.workflow_id !== "daily-backup-safety-check") throw new Error("portable_backup_evidence_claim_invalid");
  const leaseExpiresAt = Date.parse(String(claim.lease_expires_at || ""));
  if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= Date.now()) throw new Error("portable_backup_evidence_claim_deadline_invalid");
  const configuredTimeout = Number(process.env.AUTOMATION_OS_PORTABLE_BACKUP_EVIDENCE_VERIFIER_TIMEOUT_MS || 120_000);
  const timeoutMs = Math.max(1, Math.min(120_000, Number.isFinite(configuredTimeout) ? configuredTimeout : 120_000, leaseExpiresAt - Date.now()));
  return new Promise((resolve, reject) => {
    let temporaryScope;
    try {
      temporaryScope = fs.mkdtempSync(path.join(tmpdir(), "aos-backup-evidence-verifier-"));
      fs.chmodSync(temporaryScope, 0o700);
    } catch {
      reject(new Error("portable_backup_evidence_verifier_temp_scope_failed"));
      return;
    }
    const cleanupTemporaryScope = () => {
      try {
        fs.rmSync(temporaryScope, { recursive: true, force: true });
        return !fs.existsSync(temporaryScope);
      } catch {
        return false;
      }
    };
    let child;
    try {
      child = spawnProcess(process.execPath, [BACKUP_EVIDENCE_READER, `--run-id=${claim.run_id}`], {
        cwd: ROOT,
        env: {
          ...process.env,
          AUTOMATION_OS_REPO_ROOT: ROOT,
          AUTOMATION_OS_PORTABLE_REMOTE_ARTIFACT_ROOT: ARTIFACT_ROOT,
          TMPDIR: temporaryScope,
          TMP: temporaryScope,
          TEMP: temporaryScope,
        },
        detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"]
      });
    } catch {
      cleanupTemporaryScope();
      reject(new Error("portable_backup_evidence_verifier_spawn_failed"));
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let cleanupPromise;
    const cleanup = () => {
      if (!cleanupPromise) cleanupPromise = cleanupOwnedProcessGroup(child, 1_000).catch(() => ({ verified: false }));
      return cleanupPromise;
    };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      callback();
    };
    const parseOutput = () => {
      const text = String(stdout || "").trim();
      if (!text) return null;
      try { return JSON.parse(text); } catch { return null; }
    };
    const validExactBlocker = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,240}$/u.test(value);
    const validBlockedEnvelope = (parsed) => parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && parsed.status === "blocked" && validExactBlocker(parsed.exact_blocker)
      && parsed.provider_replayed === false && parsed.new_effect === false;
    const validEvidenceEnvelope = (parsed) => parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && parsed.schema === "aos.portable_backup_post_effect_evidence.v1"
      && parsed.run_id === claim.run_id && parsed.workflow_id === claim.workflow_id
      && (parsed.exact_blocker === null || validExactBlocker(parsed.exact_blocker))
      && parsed.provider_replayed === false && parsed.new_effect === false
      && (parsed.evidence === null || (parsed.evidence && typeof parsed.evidence === "object" && !Array.isArray(parsed.evidence)));
    const timer = setTimeout(() => {
      timedOut = true;
      void cleanup().then((processGroupCleanup) => finish(() => {
        const temporaryCleanupVerified = cleanupTemporaryScope();
        return resolve({
        status: "blocked", exact_blocker: processGroupCleanup.verified === true
          && temporaryCleanupVerified ? "portable_backup_evidence_verifier_timeout" : "portable_backup_evidence_verifier_cleanup_unverified",
        readback_verified: false, cleanup_verified: processGroupCleanup.verified === true && temporaryCleanupVerified,
        provider_replayed: false, new_effect: false, child_exit_code: child.exitCode ?? null,
        child_signal: child.signalCode || "SIGTERM", process_group_cleanup: processGroupCleanup,
        temporary_restore_cleanup: { attempted: true, verified: temporaryCleanupVerified }
        });
      }));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-200_000); });
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    child.once("error", () => {
      clearTimeout(timer);
      void cleanup().then(() => finish(() => {
        const temporaryCleanupVerified = cleanupTemporaryScope();
        reject(new Error(temporaryCleanupVerified ? "portable_backup_evidence_verifier_spawn_failed" : "portable_backup_evidence_verifier_cleanup_unverified"));
      }));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      void cleanup().then((processGroupCleanup) => finish(() => {
        const parsed = parseOutput();
        const temporaryCleanupVerified = cleanupTemporaryScope();
        if (timedOut) return resolve({ status: "blocked", exact_blocker: processGroupCleanup.verified === true && temporaryCleanupVerified
          ? "portable_backup_evidence_verifier_timeout" : "portable_backup_evidence_verifier_cleanup_unverified", readback_verified: false,
        cleanup_verified: processGroupCleanup.verified === true && temporaryCleanupVerified, provider_replayed: false, new_effect: false,
        process_group_cleanup: processGroupCleanup, temporary_restore_cleanup: { attempted: true, verified: temporaryCleanupVerified } });
        const knownEnvelope = validEvidenceEnvelope(parsed) || validBlockedEnvelope(parsed);
        const knownBlocker = knownEnvelope && validExactBlocker(parsed.exact_blocker) ? parsed.exact_blocker : null;
        if (code !== 0 || signal) return reject(new Error(knownBlocker || (signal
          ? "portable_backup_evidence_verifier_signal"
          : "portable_backup_evidence_verifier_nonzero")));
        if (stderr.trim() || (!validEvidenceEnvelope(parsed) && !validBlockedEnvelope(parsed))) return reject(new Error("portable_backup_evidence_verifier_output_invalid"));
        if (validBlockedEnvelope(parsed)) return resolve({ ...parsed, cleanup_verified: parsed.cleanup_verified === true && processGroupCleanup.verified === true && temporaryCleanupVerified,
          child_exit_code: code, child_signal: signal, process_group_cleanup: processGroupCleanup,
          temporary_restore_cleanup: { attempted: true, verified: temporaryCleanupVerified } });
        if (parsed.readback_verified === true && (parsed.cleanup_verified !== true || !processGroupCleanup.verified || !temporaryCleanupVerified)) return reject(new Error("portable_backup_evidence_verifier_cleanup_unverified"));
        if (parsed.readback_verified !== true && typeof parsed.exact_blocker !== "string") return reject(new Error("portable_backup_evidence_verifier_output_invalid"));
        return resolve({ ...parsed, cleanup_verified: parsed.cleanup_verified === true && processGroupCleanup.verified === true && temporaryCleanupVerified,
          child_exit_code: code, child_signal: signal,
          process_group_cleanup: processGroupCleanup, temporary_restore_cleanup: { attempted: true, verified: temporaryCleanupVerified } });
      }));
    });
  });
}

async function processPortableBackupEvidenceClaim(claim, target) {
  const root = runRoot(claim.run_id);
  let verified;
  try {
    verified = await runPortableBackupEvidenceVerifier(claim);
  } catch (error) {
    verified = { status: "blocked", exact_blocker: error instanceof Error ? error.message : "portable_backup_evidence_verifier_failed", readback_verified: false, cleanup_verified: false, provider_replayed: false, new_effect: false };
  }
  const success = verified.readback_verified === true && verified.cleanup_verified === true;
  const receipt = {
    evidence_only: true, status: success ? "complete" : "blocked", exact_blocker: success ? null : verified.exact_blocker,
    external_action_executed: success ? true : null, browser_surface: "local_worker", workflow_id: claim.workflow_id,
    run_id: claim.run_id, step_id: claim.step_id, cleanup_verified: success, readback_verified: success,
    effects_mode: "business_effect", read_only_stage_bound: false, same_run_receipt: success,
    same_run_source_sync: success, business_completion_verified: success, business_proof_verified: success,
    provider_replayed: false, new_effect: false, original_run_id: claim.run_id,
    original_step_id: claim.step_id, original_authority_id: claim.reconciliation_binding?.original_authority_id,
    original_authority_sha256: claim.reconciliation_binding?.original_authority_sha256,
    original_claim: verified.original_claim || null,
    original_timeout_receipt: verified.original_timeout_receipt || null,
    reconciliation_binding: claim.reconciliation_binding || null,
    evidence: verified.evidence ? {
      ...verified.evidence,
      original_execution_summary: verified.original_execution_summary || null,
      direct_child_link_verified: verified.direct_child_link_verified === false ? false : null
    } : null,
    adapter_result: { execution_surface: "mac_local_worker", evidence_only: true, remote_verified: success, evidence: verified.evidence || null },
    runner_receipt: { status: success ? "complete" : "blocked", same_run_source_sync: success,
      business_proofs: { backup_snapshot: success, backup_remote_push: success, backup_state: success, cleanup_receipt: success } },
    external_executor_status: "portable_backup_post_effect_evidence_verifier"
    , attempt_id: claim.attempt_id, fencing_token: claim.fencing_token
  };
  const body = { worker_id: WORKER_ID, worker_instance_id: WORKER_INSTANCE_ID, receipt };
  safeWrite(path.join(root, "portable-backup-post-effect-evidence-submission.v1.json"), {
    schema: "aos.portable_backup_post_effect_evidence_submission.v1", run_id: claim.run_id,
    step_id: claim.step_id, workflow_id: claim.workflow_id, provider_replayed: false, new_effect: false, body
  });
  const completion = await requestTargetJson(target, `/api/portable-worker/${encodeURIComponent(claim.run_id)}/receipt`, body);
  return { status: completion.receipt.status, run_id: claim.run_id, workflow_id: claim.workflow_id, step_id: claim.step_id,
    exact_blocker: completion.receipt.exact_blocker, external_action_executed: completion.receipt.external_action_executed,
    evidence_only: true, provider_replayed: false, new_effect: false, readback_verified: success, cleanup_verified: success,
    remote_replayed: completion.replayed === true };
}

/** Persist the exact token-free submission before HTTP; never rerun a provider. */
export async function submitPortableLocalReceipt(claim, target, receipt, root, { request = requestTargetJson } = {}) {
  const body = { worker_id: WORKER_ID, worker_instance_id: WORKER_INSTANCE_ID, receipt };
  let envelope;
  let completion;
  let serverReceiptConfirmed = false;
  try {
    envelope = safeWrite(path.join(root, "portable-local-receipt-submission.v1.json"), {
      schema: "aos.portable_local_receipt_submission.v1", run_id: claim.run_id, step_id: claim.step_id,
      workflow_id: claim.workflow_id, company_id: claim.company_id,
      target_origin: target.baseUrl, lease_expires_at: claim.lease_expires_at,
      idempotency_key: claim.idempotency_key, input_bundle_sha256: claim.input_bundle_sha256 ?? null, body
    });
    // The server's completion schema is boolean-only. Never coerce unknown
    // business effects to false to make a receipt fit that schema.
    if (typeof receipt.external_action_executed !== "boolean") throw new Error("portable_local_effect_reconciliation_required");
    completion = await request(target, `/api/portable-worker/${encodeURIComponent(claim.run_id)}/receipt`, body);
    const readback = buildPortableProtectedReadback(claim, receipt, completion);
    if (readback.protected_readback.status !== "verified" || completion.receipt.workflow_id !== claim.workflow_id
      || (receipt.external_action_executed === true && completion.receipt.external_action_executed !== true)) {
      throw new Error("portable_local_server_receipt_binding_unverified");
    }
    serverReceiptConfirmed = true;
    persistPortableProtectedReadback(claim, receipt, completion, root);
    return { status: "recorded", completion };
  } catch (error) {
    return {
      status: "blocked", run_id: claim.run_id, step_id: claim.step_id, workflow_id: claim.workflow_id,
      exact_blocker: serverReceiptConfirmed ? "portable_local_completion_readback_persist_failed" : "portable_local_receipt_submission_unconfirmed",
      receipt_submission_error: portableRemoteErrorCode(error),
      local_receipt_status: receipt.status, local_receipt_exact_blocker: receipt.exact_blocker,
      external_action_executed: receipt.external_action_executed,
      operation_effect_state: receipt.external_action_executed === false ? "none" : "unknown",
      reconciliation_required: true, no_replay: true, browser_surface: "local_worker",
      cleanup_verified: receipt.cleanup_verified === true, readback_verified: receipt.readback_verified === true,
      receipt_submission_artifact: envelope ? `file://${envelope.path}` : null,
      server_receipt_confirmed: serverReceiptConfirmed
    };
  }
}

function claimPortableLocalMarker(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let fd;
  try { fd = openSync(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600); }
  catch (error) { if (error.code === "EEXIST") return false; throw error; }
  try { writeFileSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  return true;
}

function privatePortableLocalRecord(filePath) {
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || stat.size > 4_000_000) throw new Error("portable_local_receipt_artifact_invalid");
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/** One receipt-only retry within the original claim. Never invokes an adapter. */
export async function resumePortableLocalReceiptOnly(claim, target, root, { request = requestTargetJson } = {}) {
  let receipt = null;
  const fallback = () => ({
    status: "blocked", exact_blocker: "portable_local_previous_execution_reconciliation_required",
    run_id: claim.run_id, step_id: claim.step_id, workflow_id: claim.workflow_id,
    external_action_executed: receipt?.external_action_executed === true ? true
      : receipt?.external_action_executed === false || claim.execution_mode === "read_only" ? false : null,
    local_receipt_status: receipt?.status ?? null, local_receipt_exact_blocker: receipt?.exact_blocker ?? null,
    reconciliation_required: true, no_replay: true, provider_replayed: false, browser_surface: "local_worker",
    cleanup_verified: receipt?.cleanup_verified === true, readback_verified: receipt?.readback_verified === true
  });
  try {
    const envelopePath = path.join(root, "portable-local-receipt-submission.v1.json");
    if (!existsSync(envelopePath)) {
      const legacy = privatePortableLocalRecord(path.join(root, "portable-local-worker-receipt.v1.json"));
      if (legacy.run_id === claim.run_id && legacy.step_id === claim.step_id && legacy.workflow_id === claim.workflow_id) receipt = legacy;
      return fallback();
    }
    const saved = privatePortableLocalRecord(envelopePath);
    if (saved.schema !== "aos.portable_local_receipt_submission.v1" || saved.company_id !== claim.company_id
      || saved.run_id !== claim.run_id || saved.step_id !== claim.step_id || saved.workflow_id !== claim.workflow_id
      || saved.target_origin !== target.baseUrl || saved.idempotency_key !== claim.idempotency_key
      || saved.input_bundle_sha256 !== (claim.input_bundle_sha256 ?? null)
      || saved.lease_expires_at !== claim.lease_expires_at
      || saved.body?.receipt?.run_id !== claim.run_id || saved.body.receipt.step_id !== claim.step_id
      || saved.body.receipt.workflow_id !== claim.workflow_id) return fallback();
    receipt = saved.body.receipt;
    if (saved.body.worker_id !== WORKER_ID || saved.body.worker_instance_id !== WORKER_INSTANCE_ID
      || typeof receipt.external_action_executed !== "boolean") return fallback();
    portableLocalExecutionDeadline(claim);
    if (!claimPortableLocalMarker(path.join(root, "portable-local-receipt-resubmission.v1.json"), {
      schema: "aos.portable_local_receipt_resubmission.v1", run_id: claim.run_id,
      original_submission_sha256: sha256(readFileSync(envelopePath)), provider_replayed: false
    })) return fallback();
    const submitted = await submitPortableLocalReceipt(claim, target, receipt, root, { request });
    if (submitted.status !== "recorded") return { ...submitted, provider_replayed: false };
    return {
      ...fallback(), status: submitted.completion.receipt.status, exact_blocker: submitted.completion.receipt.exact_blocker,
      reconciliation_required: submitted.completion.receipt.status !== "complete", remote_receipt_resynced: true,
      remote_replayed: submitted.completion.replayed === true, server_receipt_confirmed: true
    };
  } catch { return fallback(); }
}

export function portableRemoteHttpTimeoutMs(value = process.env.AUTOMATION_OS_PORTABLE_REMOTE_HTTP_TIMEOUT_MS) {
  const parsed = Number(value ?? DEFAULT_REMOTE_HTTP_TIMEOUT_MS);
  return Number.isFinite(parsed)
    ? Math.max(1_000, Math.min(300_000, Math.floor(parsed)))
    : DEFAULT_REMOTE_HTTP_TIMEOUT_MS;
}

export async function requestPortableRemoteJson(url, token, body, { timeoutMs, companyId = COMPANY_ID, localWorker = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), portableRemoteHttpTimeoutMs(timeoutMs));
  try {
    const headers = {
      "content-type": "application/json",
      "x-automation-os-company-id": companyId,
      ...(token ? { "x-automation-os-token": token } : {}),
      ...(localWorker ? { "x-automation-os-local-worker": "1" } : {}),
    };
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof json.exactBlocker === "string" ? json.exactBlocker : `portable_remote_http_${response.status}`);
    return json;
  } catch (error) {
    if (error && typeof error === "object" && error.name === "AbortError") {
      throw new Error("portable_remote_http_timeout");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestTargetJson(target, pathname, body) {
  const url = `${target.baseUrl}${pathname}`;
  return requestPortableRemoteJson(url, target.token, body, { companyId: target.companyId, localWorker: target.kind === "local" });
}

export function publishHeartbeat(target) {
  const key = `${target.kind}:${target.baseUrl}:${target.companyId}`;
  const existing = heartbeatInFlight.get(key);
  if (existing) return existing;
  const current = (async () => {
    const attemptedAt = new Date().toISOString();
    const runtimeObservation = buildPortableWorkerRuntimeObservation({
      workerStatus: "idle",
      runId: null,
      observedAt: attemptedAt
    });
    if (target.kind === "remote" && !target.token) {
      writeTargetWorkerStatus(target, {
        status: "blocked",
        exact_blocker: "portable_remote_worker_token_missing",
        heartbeat_status: "blocked",
        heartbeat_exact_blocker: "portable_remote_worker_token_missing",
        observed_at: attemptedAt,
        heartbeat_observed_at: attemptedAt,
        heartbeat_transport_status: "blocked",
        heartbeat_transport_observed_at: attemptedAt,
        heartbeat_ack_at: null,
        heartbeat_ack_observed_at: null,
        heartbeat_ack_binding_status: "unverified",
        heartbeat_ack_worker_instance_id: null,
        heartbeat_ack_generation: null,
        heartbeat_observation: runtimeObservation,
        heartbeat_observation_status: runtimeObservation.status,
        heartbeat_observation_run_id: runtimeObservation.run_id,
        heartbeat_observation_room_id: null,
        last_attempt_at: attemptedAt
      });
      return false;
    }
    try {
      const response = await requestTargetJson(target, "/api/portable-worker/heartbeat", buildPortableWorkerHeartbeatBody({
        companyId: target.companyId,
        status: "idle",
        queueDepth: null,
        exactBlocker: null,
        runId: null,
        observedAt: attemptedAt,
        runtimeObservation
      }));
      const ackObservedAt = new Date().toISOString();
      const ack = normalizePortableWorkerHeartbeatAck(response, {
        companyId: target.companyId,
        workerId: WORKER_ID,
        workerInstanceId: WORKER_INSTANCE_ID,
        generation: WORKER_GENERATION
      }, ackObservedAt);
      if (ack.status !== "acknowledged") throw new Error("portable_remote_heartbeat_ack_invalid");
      if (!["verified", "legacy_unbound"].includes(ack.binding_status)) throw new Error("portable_remote_heartbeat_binding_mismatch");
      const heartbeatAt = ack.ack_at;
      writeTargetWorkerStatus(target, {
        status: "heartbeat_ok",
        exact_blocker: null,
        heartbeat_status: "ok",
        heartbeat_exact_blocker: null,
        observed_at: attemptedAt,
        heartbeat_observed_at: attemptedAt,
        heartbeat_transport_status: ack.status,
        heartbeat_transport_observed_at: ack.observed_at,
        heartbeat_ack_at: ack.ack_at,
        heartbeat_ack_observed_at: ack.observed_at,
        heartbeat_ack_binding_status: ack.binding_status,
        heartbeat_ack_worker_instance_id: ack.worker_instance_id,
        heartbeat_ack_generation: ack.generation,
        heartbeat_observation: runtimeObservation,
        heartbeat_observation_status: runtimeObservation.status,
        heartbeat_observation_run_id: runtimeObservation.run_id,
        heartbeat_observation_room_id: runtimeObservation.browser_use?.room?.room_id ?? null,
        last_attempt_at: attemptedAt,
        last_successful_heartbeat_at: heartbeatAt ?? attemptedAt,
        heartbeat_at: heartbeatAt,
      });
      return true;
    } catch (error) {
      const exactBlocker = portableRemoteErrorCode(error);
      writeTargetWorkerStatus(target, {
        status: "heartbeat_blocked",
        exact_blocker: exactBlocker,
        heartbeat_status: "blocked",
        heartbeat_exact_blocker: exactBlocker,
        observed_at: attemptedAt,
        heartbeat_observed_at: attemptedAt,
        heartbeat_transport_status: "blocked",
        heartbeat_transport_observed_at: new Date().toISOString(),
        heartbeat_ack_at: null,
        heartbeat_ack_observed_at: null,
        heartbeat_ack_binding_status: "unverified",
        heartbeat_ack_worker_instance_id: null,
        heartbeat_ack_generation: null,
        heartbeat_observation: runtimeObservation,
        heartbeat_observation_status: runtimeObservation.status,
        heartbeat_observation_run_id: runtimeObservation.run_id,
        heartbeat_observation_room_id: null,
        last_attempt_at: attemptedAt
      });
      return false;
    }
  })();
  heartbeatInFlight.set(key, current);
  void current.finally(() => { if (heartbeatInFlight.get(key) === current) heartbeatInFlight.delete(key); });
  return current;
}

function startResidentHeartbeat(targets) {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    for (const target of targets) void publishHeartbeat(target);
  };
  const interval = setInterval(tick, Math.max(5_000, Math.min(60_000, POLL_MS)));
  interval.unref?.();
  tick();
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

function setupFailureCode(error) {
  const value = error instanceof Error ? error.message : String(error || "");
  const allowed = new Set([
    "portable_remote_immutable_collision",
    "portable_remote_run_id_invalid",
    "portable_remote_run_root_invalid",
    "portable_remote_input_bundle_secret_like_key",
    "portable_remote_input_bundle_invalid",
    "portable_remote_input_bundle_canonical_source_missing",
    "portable_remote_input_bundle_digest_invalid"
  ]);
  return allowed.has(value) ? value : "portable_remote_local_setup_failed";
}

function setupFailureReceipt(claim, error) {
  const exactBlocker = setupFailureCode(error);
  return {
    status: "blocked",
    exact_blocker: exactBlocker,
    external_action_executed: false,
    browser_surface: claimBrowserSurface(claim),
    workflow_id: claim.workflow_id,
    run_id: claim.run_id,
    step_id: claim.step_id,
    cleanup_verified: false,
    readback_verified: false,
    effects_mode: claim.execution_mode,
    read_only_stage_bound: claim.execution_mode === "read_only",
    ...(claim.execution_mode === "business_effect" ? {
      business_effect_stage: claim.business_effect_stage,
      target_digest: claim.target_digest,
      ...(claim.effect_authority ? {
        effect_authority_id: claim.effect_authority.authority_id,
        effect_authority_sha256: sha256(`${JSON.stringify(claim.effect_authority, null, 2)}\n`),
      } : {}),
    } : {}),
    same_run_receipt: false,
    business_proof_verified: false,
    ...(claim.input_bundle_sha256 ? { input_bundle_sha256: claim.input_bundle_sha256 } : {}),
    external_executor_status: "portable_remote_local_setup_failed"
  };
}

async function processOne({ target, requestedRunId = null } = {}) {
  if (!target || (target.kind === "remote" && !target.token)) {
    writeTargetWorkerStatus(target, { status: "blocked", exact_blocker: "portable_remote_worker_token_missing", heartbeat_status: "blocked", heartbeat_exact_blocker: "portable_remote_worker_token_missing" });
    return { status: "blocked", exact_blocker: "portable_remote_worker_token_missing", external_action_executed: false };
  }
  await publishHeartbeat(target);
  // Refresh the remote Codex App Server registry before claiming a run. This
  // is best-effort: a registry readback failure blocks only connector-owned
  // local workflows and must not stop the durable queue or Chrome lane.
  await syncZeaburConnectorRegistry(target);
  let claimed;
  try {
    claimed = await requestTargetJson(target, "/api/portable-worker/claim", { worker_id: WORKER_ID, worker_instance_id: WORKER_INSTANCE_ID, ...(requestedRunId ? { run_id: requestedRunId } : {}) });
  } catch (error) {
    writeTargetWorkerStatus(target, { status: "claim_blocked", exact_blocker: portableRemoteErrorCode(error) });
    throw error;
  }
  if (!claimed.run) {
    writeTargetWorkerStatus(target, { status: "idle", exact_blocker: null, claim_status: "idle", last_claim_at: new Date().toISOString() });
    return { status: "idle", claimed: false, external_action_executed: false };
  }
  const claim = claimed.run;
  writeTargetWorkerStatus(target, { status: "claimed", exact_blocker: null, claim_status: "claimed", last_claim_at: new Date().toISOString() });
  if (claim.evidence_only === true) return processPortableBackupEvidenceClaim(claim, target);
  const fixedSurfaceBlocker = fixedChromePluginProfile2BlockerForClaim(claim);
  if (fixedSurfaceBlocker) {
    const receipt = fixedChromePluginProfile2Receipt(claim, fixedSurfaceBlocker);
    const completion = await requestTargetJson(target, `/api/portable-worker/${encodeURIComponent(claim.run_id)}/receipt`, { worker_id: WORKER_ID, worker_instance_id: WORKER_INSTANCE_ID, receipt });
    persistPortableProtectedReadback(claim, receipt, completion, runRoot(claim.run_id));
    return {
      status: receipt.status,
      run_id: claim.run_id,
      workflow_id: claim.workflow_id,
      step_id: claim.step_id,
      exact_blocker: receipt.exact_blocker,
      external_action_executed: false,
      browser_surface: receipt.browser_surface,
      cleanup_verified: false,
      readback_verified: false,
      remote_replayed: completion.replayed === true,
      child_exit_code: null,
      child_signal: null,
    };
  }
  if (PORTABLE_LOCAL_WORKFLOW_IDS.has(claim.workflow_id)) {
    return processPortableLocalWorkflowClaim(claim, target);
  }
  let root;
  let admission;
  let inputBundle;
  let actionPlan;
  let effectAuthority;
  try {
    root = runRoot(claim.run_id);
    effectAuthority = createEffectAuthorityFile(claim, root);
    admission = createAdmission(claim, root);
    inputBundle = createInputBundle(claim, root);
    process.env.AUTOMATION_OS_ARTIFACT_ROOT = ARTIFACT_ROOT;
    const { issuePortableExternalActionPlan } = await import(pathToFileURL(path.join(ROOT, "apps/server/dist/runs/portableExternalActionPlan.js")).href);
    actionPlan = issuePortableExternalActionPlan({
      workflowId: claim.workflow_id,
      runId: claim.run_id,
      stepId: claim.step_id,
      sourceTrigger: claim.source_trigger,
      idempotencyKey: claim.idempotency_key,
      inputBundlePath: inputBundle?.path || null,
      webOperationBackend: claim.web_operation_backend,
    });
  } catch (error) {
    // No runner/browser has started yet. Persist a safe no-effect receipt so
    // a local immutable artifact collision cannot keep the same lease alive
    // forever or cause an external retry.
    const receipt = setupFailureReceipt(claim, error);
    const completion = await requestTargetJson(target, `/api/portable-worker/${encodeURIComponent(claim.run_id)}/receipt`, { worker_id: WORKER_ID, worker_instance_id: WORKER_INSTANCE_ID, receipt });
    persistPortableProtectedReadback(claim, receipt, completion, runRoot(claim.run_id));
    return {
      status: receipt.status,
      run_id: claim.run_id,
      workflow_id: claim.workflow_id,
      step_id: claim.step_id,
      exact_blocker: receipt.exact_blocker,
      external_action_executed: false,
      browser_surface: claimBrowserSurface(claim),
      cleanup_verified: false,
      readback_verified: false,
      remote_replayed: completion.replayed === true,
      child_exit_code: null,
      child_signal: null,
    };
  }
  const result = await runRunner(claim, { admission, inputBundle, actionPlan, effectAuthority });
  if (claim.execution_mode === "business_effect" && effectAuthorityFromClaim(claim)) {
    result.receipt.effect_authority_id = effectAuthorityFromClaim(claim).authority_id;
    result.receipt.effect_authority_sha256 = effectAuthority?.sha256 || null;
  }
  const completion = await requestTargetJson(target, `/api/portable-worker/${encodeURIComponent(claim.run_id)}/receipt`, { worker_id: WORKER_ID, worker_instance_id: WORKER_INSTANCE_ID, receipt: result.receipt });
  persistPortableProtectedReadback(claim, result.receipt, completion, runRoot(claim.run_id));
  return {
    status: result.receipt.status,
    run_id: claim.run_id,
    workflow_id: claim.workflow_id,
    step_id: claim.step_id,
    exact_blocker: result.receipt.exact_blocker || null,
    external_action_executed: result.receipt.external_action_executed === true,
    browser_surface: claimBrowserSurface(claim),
    cleanup_verified: result.receipt.cleanup_verified === true,
    readback_verified: result.receipt.readback_verified === true,
    remote_replayed: completion.replayed === true,
    child_exit_code: result.child_exit_code,
    child_signal: result.child_signal,
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const requestedRunId = process.argv.find((value) => value.startsWith("--run-id="))?.slice("--run-id=".length) || null;
  const registryOnly = args.has("--registry-only");
  const once = args.has("--once") || Boolean(requestedRunId);
  let targets;
  try {
    targets = portableQueueTargets();
  } catch (error) {
    emitResult({ status: "blocked", exact_blocker: error instanceof Error ? error.message : "portable_queue_authority_invalid", external_action_executed: false }, { force: true });
    process.exitCode = 1;
    return;
  }
  const origins = targets.map((target) => target.baseUrl);
  writeWorkerStatus({
    status: "starting",
    claim_status: "unknown",
    heartbeat_status: "unknown",
    heartbeat_exact_blocker: null,
    observed_at: null,
    heartbeat_observed_at: null,
    last_attempt_at: null,
    last_successful_heartbeat_at: null,
    heartbeat_at: null,
    generation: WORKER_GENERATION,
    generation_started_at: WORKER_GENERATION_STARTED_AT,
    heartbeat_transport_status: "unobserved",
    heartbeat_transport_observed_at: null,
    heartbeat_ack_at: null,
    heartbeat_ack_observed_at: null,
    heartbeat_ack_binding_status: "unverified",
    heartbeat_ack_worker_instance_id: null,
    heartbeat_ack_generation: null,
    heartbeat_observation: null,
    heartbeat_observation_status: "unobserved",
    heartbeat_observation_run_id: null,
    heartbeat_observation_room_id: null,
    // A status artifact is a current-generation readback, not an append-only
    // history.  Drop target keys from an older company/authority binding so
    // a stale `claimed` entry cannot be mistaken for a live target.
    target_statuses: initialPortableWorkerTargetStatuses(targets),
  });
  if (registryOnly) {
    for (const target of targets) {
      try {
        emitResult(await syncZeaburConnectorRegistry(target), { force: true });
      } catch (error) {
        emitResult({ status: "blocked", exact_blocker: portableRemoteErrorCode(error), external_action_executed: false }, { force: true });
      }
    }
    return;
  }
  if (once) {
    for (const target of targets) {
      try {
        emitResult(await processOne({ target, requestedRunId }), { force: true });
      } catch (error) {
        emitResult({ status: "blocked", exact_blocker: error instanceof Error ? error.message : "portable_remote_worker_failed", external_action_executed: false }, { force: true });
      }
    }
    return;
  }
  writeWorkerStatus({ queue_origins: origins });
  const stopHeartbeat = startResidentHeartbeat(targets);
  let stopping = false;
  process.once("SIGTERM", () => { stopping = true; });
  process.once("SIGINT", () => { stopping = true; });
  try {
    while (!stopping) {
      for (const target of targets) {
        try { emitResult(await processOne({ target })); } catch (error) { emitResult({ status: "blocked", exact_blocker: error instanceof Error ? error.message : "portable_remote_worker_failed", external_action_executed: false }); }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    stopHeartbeat();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => { emitResult({ status: "blocked", exact_blocker: error instanceof Error ? error.message : "portable_remote_worker_failed", external_action_executed: false }, { force: true }); process.exitCode = 1; });
}

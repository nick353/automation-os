import { createHash } from "node:crypto";

export const PORTABLE_WORKER_HEARTBEAT_KIND = "portable_mac_worker";
export const DEFAULT_PORTABLE_WORKER_HEARTBEAT_STALE_SECONDS = 300;
const SAFE_WORKER_ID = /^[A-Za-z0-9._:-]{1,120}$/u;
const SAFE_OPAQUE_ID = /^-?[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/u;
const SAFE_STATUS = new Set(["running", "idle", "blocked"]);
const SAFE_CHROME_STATUS = new Set(["ready", "blocked", "stopped", "stale", "unavailable"]);
const SAFE_CHROME_OPERATION_STATUS = new Set(["ready", "read_only_ready", "target_scoped_ready", "blocked", "unknown"]);
const SAFE_CHROME_OWNER_STATUS = new Set(["foreground_ready", "bridge_only", "stopped", "blocked", "unknown"]);

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
};

function safeOpaqueId(value: unknown): string | null {
  return typeof value === "string" && SAFE_OPAQUE_ID.test(value.trim()) ? value.trim() : null;
}

function safeIsoTimestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function parseChromePluginReadback(value: unknown): PortableWorkerChromePluginReadback | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schema !== "aos.portable_worker_chrome_plugin_readback.v1") return null;
  const status = typeof record.status === "string" && SAFE_CHROME_STATUS.has(record.status)
    ? record.status as PortableWorkerChromePluginReadback["status"]
    : null;
  const operationStatus = typeof record.operation_status === "string" && SAFE_CHROME_OPERATION_STATUS.has(record.operation_status)
    ? record.operation_status as PortableWorkerChromePluginReadback["operation_status"]
    : null;
  if (!status || !operationStatus) return null;
  const blocker = (candidate: unknown) => typeof candidate === "string" && /^[A-Za-z0-9_.:-]{1,160}$/u.test(candidate.trim()) ? candidate.trim() : null;
  const rawBrowser = record.browser && typeof record.browser === "object" && !Array.isArray(record.browser)
    ? record.browser as Record<string, unknown>
    : null;
  const browser = rawBrowser ? {
    id: safeOpaqueId(rawBrowser.id),
    type: safeOpaqueId(rawBrowser.type),
    profile_name: safeOpaqueId(rawBrowser.profile_name),
    profile_ordering: safeOpaqueId(rawBrowser.profile_ordering),
  } : null;
  const rawOwner = record.bridge_owner && typeof record.bridge_owner === "object" && !Array.isArray(record.bridge_owner)
    ? record.bridge_owner as Record<string, unknown>
    : null;
  const ownerStatus = rawOwner && typeof rawOwner.status === "string" && SAFE_CHROME_OWNER_STATUS.has(rawOwner.status)
    ? rawOwner.status as NonNullable<PortableWorkerChromePluginReadback["bridge_owner"]>["status"]
    : "unknown";
  const bridgeOwner = rawOwner ? {
    schema: safeOpaqueId(rawOwner.schema) ?? "",
    owner_id: safeOpaqueId(rawOwner.owner_id),
    bridge_instance_id: safeOpaqueId(rawOwner.bridge_instance_id),
    session_id: safeOpaqueId(rawOwner.session_id),
    thread_id: safeOpaqueId(rawOwner.thread_id),
    turn_id: safeOpaqueId(rawOwner.turn_id),
    status: ownerStatus,
    foreground_executor_ready: rawOwner.foreground_executor_ready === true,
    exact_blocker: blocker(rawOwner.exact_blocker),
    updated_at: safeIsoTimestamp(rawOwner.updated_at),
  } : null;
  return {
    schema: "aos.portable_worker_chrome_plugin_readback.v1",
    status,
    exact_blocker: blocker(record.exact_blocker),
    target_scoped_ready: record.target_scoped_ready === true,
    target_scoped_exact_blocker: blocker(record.target_scoped_exact_blocker),
    operation_ready: record.operation_ready === true,
    operation_status: operationStatus,
    operation_exact_blocker: blocker(record.operation_exact_blocker),
    bridge_instance_id: safeOpaqueId(record.bridge_instance_id),
    last_seen_at: safeIsoTimestamp(record.last_seen_at),
    browser,
    bridge_owner: bridgeOwner,
  };
}

export function validatePortableWorkerHeartbeat(body: unknown):
  | { ok: true; value: PortableWorkerHeartbeatInput }
  | { ok: false; exactBlocker: string } {
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
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
  const exactBlocker = typeof record.exact_blocker === "string" && /^[A-Za-z0-9_.:-]{1,160}$/u.test(record.exact_blocker.trim())
    ? record.exact_blocker.trim()
    : null;
  const hasChromePluginReadback = Object.prototype.hasOwnProperty.call(record, "chrome_plugin_readback");
  const chromePluginReadback = parseChromePluginReadback(record.chrome_plugin_readback);
  if (hasChromePluginReadback && record.chrome_plugin_readback !== null && chromePluginReadback === null) {
    return { ok: false, exactBlocker: "portable_worker_heartbeat_chrome_readback_invalid" };
  }
  return {
    ok: true,
    value: {
      workerId,
      status: status as PortableWorkerHeartbeatInput["status"],
      queueDepth,
      exactBlocker,
      chromePluginReadback
    }
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

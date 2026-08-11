import { createHash } from "node:crypto";

export const PORTABLE_WORKER_HEARTBEAT_KIND = "portable_mac_worker";
export const DEFAULT_PORTABLE_WORKER_HEARTBEAT_STALE_SECONDS = 300;
const SAFE_WORKER_ID = /^[A-Za-z0-9._:-]{1,120}$/u;
const SAFE_STATUS = new Set(["running", "idle", "blocked"]);

export type PortableWorkerHeartbeatInput = {
  workerId: string;
  status: "running" | "idle" | "blocked";
  queueDepth: number | null;
  exactBlocker: string | null;
};

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
  return {
    ok: true,
    value: {
      workerId,
      status: status as PortableWorkerHeartbeatInput["status"],
      queueDepth,
      exactBlocker
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

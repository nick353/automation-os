import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PortableWorkerChromePluginReadback } from "../runs/portableWorkerHeartbeat.js";

export const CHROME_PLUGIN_BRIDGE_READBACK_SCHEMA = "aos.chrome_plugin_bridge_readback.v2" as const;

type ChromePluginBrowserMetadata = {
  extensionId: string | null;
  extensionInstanceId: string | null;
  profileName: string | null;
  profileOrdering: string | null;
  profileIsLastUsed: string | null;
};

type RawChromePluginReadback = {
  schema?: string;
  status?: string;
  backend?: string;
  bridge_instance_id?: string;
  bridge_url?: string;
  browser_execution_authority?: string;
  browser_execution_disabled?: boolean;
  operation_ready?: boolean;
  operation_status?: string;
  operation_exact_blocker?: string | null;
  selected_tab?: {
    id?: string;
    url?: string | null;
  } | null;
  visibility?: {
    capability_id?: string;
    advertised?: boolean;
    state?: boolean | null;
  } | null;
  capability_ids?: unknown;
  refresh_status?: string;
  refresh_exact_blocker?: string | null;
  browser?: {
    id?: string;
    name?: string;
    type?: string;
    metadata?: Record<string, unknown>;
  };
  bridge_owner?: {
    schema?: string;
    owner_id?: string;
    pid?: number | string;
    bridge_instance_id?: string;
    session_id?: string;
    thread_id?: string;
    turn_id?: string;
    status?: string;
    foreground_executor_ready?: boolean;
    exact_blocker?: string | null;
    started_at?: string | null;
    updated_at?: string | null;
  } | null;
  last_seen_at?: string;
  exact_blocker?: string | null;
  writer_lease?: {
    schema?: string;
    profile_surface?: string;
    profile_ordering?: number | string;
    lease_path?: string;
    status?: string;
    poisoned?: boolean;
    exact_blocker?: string | null;
    updated_at?: string | null;
  } | null;
};

type ChromePluginReadbackScope = "foreground" | "target_scoped";
export type ChromePluginFailurePlane = "none" | "transport" | "bridge" | "foreground" | "ownership" | "target" | "upstream";

const TARGET_SCOPED_FOREGROUND_BLOCKERS = new Set([
  "chrome_selected_tab_readback_invalid",
  "chrome_plugin_foreground_executor_lease_expired",
  "chrome_foreground_activation_capability_unavailable",
]);

export type ChromePluginWriterLeaseReadback = {
  schema: string;
  profileSurface: string;
  profileOrdering: number | null;
  status: "idle" | "held" | "poisoned" | "stale" | "blocked" | "unknown";
  poisoned: boolean;
  exactBlocker: string | null;
  updatedAt: string | null;
};

export type ChromePluginBridgeOwnerReadback = {
  schema: string;
  ownerId: string | null;
  pid: number | null;
  bridgeInstanceId: string | null;
  sessionId: string | null;
  threadId: string | null;
  turnId: string | null;
  status: "foreground_ready" | "bridge_only" | "stopped" | "blocked" | "unknown";
  foregroundExecutorReady: boolean;
  exactBlocker: string | null;
  startedAt: string | null;
  updatedAt: string | null;
};

export type ChromePluginReadback = {
  schema: typeof CHROME_PLUGIN_BRIDGE_READBACK_SCHEMA;
  status: "ready" | "blocked" | "stopped" | "stale" | "unavailable";
  exactBlocker: string | null;
  source: "trusted_chrome_bridge_readback" | "portable_worker_heartbeat";
  path: string;
  capturedAt: string | null;
  lastSeenAt: string | null;
  ageSeconds: number | null;
  bridgeInstanceId: string | null;
  bridgeUrl: string | null;
  browserExecutionAuthority: string | null;
  browserExecutionDisabled: boolean | null;
  operationReady: boolean;
  readbackScope: ChromePluginReadbackScope;
  operationStatus: "ready" | "read_only_ready" | "target_scoped_ready" | "blocked" | "unknown";
  operationExactBlocker: string | null;
  failurePlane: ChromePluginFailurePlane;
  blockingScope: "chrome_plugin_lane" | null;
  independentLanesAllowed: boolean;
  selectedTab: { id: string; url: string | null } | null;
  visibility: { capabilityId: string; advertised: boolean | null; state: boolean | null } | null;
  refreshStatus: "ready" | "blocked" | null;
  refreshExactBlocker: string | null;
  browser: {
    id: string | null;
    name: string | null;
    type: string | null;
    metadata: ChromePluginBrowserMetadata;
  } | null;
  bridgeOwner: ChromePluginBridgeOwnerReadback | null;
  writerLease: ChromePluginWriterLeaseReadback | null;
};

const REMOTE_WORKER_READBACK_STALE_SECONDS = 90;

export function publicChromePluginReadback(readback: ChromePluginReadback) {
  return {
    status: readback.status,
    operationReady: readback.operationReady,
    readbackScope: readback.readbackScope,
    operationStatus: readback.operationStatus,
    operationExactBlocker: readback.operationExactBlocker,
    failurePlane: readback.failurePlane,
    blockingScope: readback.blockingScope,
    independentLanesAllowed: readback.independentLanesAllowed,
    selectedTab: readback.selectedTab,
    visibility: readback.visibility,
    exactBlocker: readback.exactBlocker,
    capturedAt: readback.capturedAt,
    ageSeconds: readback.ageSeconds,
    bridgeInstanceId: readback.bridgeInstanceId,
    bridgeUrl: readback.bridgeUrl,
    browserExecutionAuthority: readback.browserExecutionAuthority,
    browserExecutionDisabled: readback.browserExecutionDisabled,
    refreshStatus: readback.refreshStatus,
    refreshExactBlocker: readback.refreshExactBlocker,
    writerLease: readback.writerLease ? {
      schema: readback.writerLease.schema,
      profileSurface: readback.writerLease.profileSurface,
      profileOrdering: readback.writerLease.profileOrdering,
      status: readback.writerLease.status,
      poisoned: readback.writerLease.poisoned,
      exactBlocker: readback.writerLease.exactBlocker,
      updatedAt: readback.writerLease.updatedAt,
    } : null,
    browser: readback.browser ? {
      id: readback.browser.id,
      name: readback.browser.name,
      type: readback.browser.type,
      metadata: {
        profileName: readback.browser.metadata.profileName,
        profileOrdering: readback.browser.metadata.profileOrdering,
        profileIsLastUsed: readback.browser.metadata.profileIsLastUsed,
      }
    } : null
  } as const;
}

export function chromePluginReadbackPathForEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  return environment.AOS_CHROME_PLUGIN_READBACK_PATH?.trim()
    || environment.SOCIAL_FLOW_CHROME_PLUGIN_READBACK_PATH?.trim()
    || join(String(environment.HOME || homedir()), ".social-flow", "aos-company1-profile2-bridge-readback-v2.json");
}

function readbackPath() {
  return chromePluginReadbackPathForEnvironment(process.env);
}

function text(value: unknown) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function safeMetadata(value: unknown): ChromePluginBrowserMetadata {
  const metadata = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    extensionId: text(metadata.extensionId),
    extensionInstanceId: text(metadata.extensionInstanceId),
    profileName: text(metadata.profileName),
    profileOrdering: text(metadata.profileOrdering),
    profileIsLastUsed: text(metadata.profileIsLastUsed),
  };
}

function unavailable(path: string, exactBlocker: string, status: ChromePluginReadback["status"] = "unavailable", readbackScope: ChromePluginReadbackScope = "foreground"): ChromePluginReadback {
  return {
    schema: CHROME_PLUGIN_BRIDGE_READBACK_SCHEMA,
    status,
    exactBlocker,
    source: "trusted_chrome_bridge_readback",
    path,
    capturedAt: null,
    lastSeenAt: null,
    ageSeconds: null,
    bridgeInstanceId: null,
    bridgeUrl: null,
    browserExecutionAuthority: null,
    browserExecutionDisabled: null,
    operationReady: false,
    readbackScope,
    operationStatus: "unknown",
    operationExactBlocker: exactBlocker,
    failurePlane: failurePlaneFor(exactBlocker),
    blockingScope: "chrome_plugin_lane",
    independentLanesAllowed: true,
    selectedTab: null,
    visibility: null,
    refreshStatus: null,
    refreshExactBlocker: null,
    browser: null,
    bridgeOwner: null,
    writerLease: null,
  };
}

export function chromePluginRemoteWorkerReadbackPending(targetScopedReadback = true): ChromePluginReadback {
  return unavailable(
    "portable_remote_worker_heartbeat",
    "chrome_plugin_remote_worker_readback_pending",
    "unavailable",
    targetScopedReadback ? "target_scoped" : "foreground"
  );
}

function safeBridgeOwner(value: RawChromePluginReadback["bridge_owner"]): ChromePluginBridgeOwnerReadback | null {
  if (!value || typeof value !== "object") return null;
  const pid = Number(value.pid);
  const status = ["foreground_ready", "bridge_only", "stopped", "blocked"].includes(String(value.status || ""))
    ? String(value.status) as ChromePluginBridgeOwnerReadback["status"]
    : "unknown";
  return {
    schema: String(value.schema || ""),
    ownerId: text(value.owner_id),
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    bridgeInstanceId: text(value.bridge_instance_id),
    sessionId: text(value.session_id),
    threadId: text(value.thread_id),
    turnId: text(value.turn_id),
    status,
    foregroundExecutorReady: value.foreground_executor_ready === true,
    exactBlocker: text(value.exact_blocker),
    startedAt: text(value.started_at),
    updatedAt: text(value.updated_at),
  };
}

function safeWriterLease(value: RawChromePluginReadback["writer_lease"]): ChromePluginWriterLeaseReadback | null {
  if (!value || typeof value !== "object") return null;
  const status = ["idle", "held", "poisoned", "stale", "blocked"].includes(String(value.status || ""))
    ? String(value.status) as ChromePluginWriterLeaseReadback["status"]
    : "unknown";
  const ordering = Number(value.profile_ordering);
  return {
    schema: String(value.schema || ""),
    profileSurface: String(value.profile_surface || ""),
    profileOrdering: Number.isSafeInteger(ordering) ? ordering : null,
    status,
    poisoned: value.poisoned === true,
    exactBlocker: text(value.exact_blocker),
    updatedAt: text(value.updated_at),
  };
}

function failurePlaneFor(exactBlocker: string | null): ChromePluginFailurePlane {
  if (!exactBlocker) return "none";
  if (/(?:Browser is not available|native|socket|transport|unreachable|health|readback_(?:stale|unavailable)|bridge_(?:stopped|unreachable|health|instance|url))/iu.test(exactBlocker)) return "transport";
  if (/(?:bridge_only|foreground_executor|selected_tab|foreground|management|activation|lease)/iu.test(exactBlocker)) return "foreground";
  if (/(?:foreign|owner|contention|EADDRINUSE|session_not_owned)/iu.test(exactBlocker)) return "ownership";
  if (/(?:target|tab|DOM|hydration|route|page|action_dispatch)/u.test(exactBlocker)) return "target";
  return "upstream";
}

function readChromePluginReadbackValue(raw: RawChromePluginReadback, path: string, now: number, { targetScopedReadback = false } = {}): ChromePluginReadback {
  const readbackScope: ChromePluginReadbackScope = targetScopedReadback ? "target_scoped" : "foreground";
  const lastSeenAt = text(raw.last_seen_at);
  const lastSeenMs = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  if (!Number.isFinite(lastSeenMs)) return unavailable(path, "chrome_extension_bridge_readback_timestamp_invalid", "unavailable", readbackScope);
  const ageSeconds = Math.max(0, (now - lastSeenMs) / 1000);
  const staleAfterSeconds = Math.max(5, Number(process.env.AOS_CHROME_PLUGIN_READBACK_STALE_SECONDS || 15));
  const browser = raw.browser && typeof raw.browser === "object" ? {
    id: text(raw.browser.id),
    name: text(raw.browser.name),
    type: text(raw.browser.type),
    metadata: safeMetadata(raw.browser.metadata),
  } : null;
  const bridgeOwner = safeBridgeOwner(raw.bridge_owner);
  const writerLease = safeWriterLease(raw.writer_lease);
  const selectedTab = raw.selected_tab && typeof raw.selected_tab === "object" && text(raw.selected_tab.id)
    ? { id: text(raw.selected_tab.id) as string, url: text(raw.selected_tab.url) }
    : null;
  const visibility = raw.visibility && typeof raw.visibility === "object"
    ? {
        capabilityId: text(raw.visibility.capability_id) || "",
        advertised: typeof raw.visibility.advertised === "boolean" ? raw.visibility.advertised : null,
        state: typeof raw.visibility.state === "boolean" ? raw.visibility.state : null,
      }
    : null;
  const targetScopedBusiness = raw.browser_execution_authority === "target_scoped_business";
  const transportAdmission = raw.browser_execution_authority === "general"
    || raw.browser_execution_authority === "read_only_admission"
    || targetScopedBusiness;
  const readOnlyAdmission = raw.browser_execution_authority === "read_only_admission"
    || targetScopedBusiness;
  const operationExactBlocker = text(raw.operation_exact_blocker);
  const foregroundBlocker = text(raw.exact_blocker) || operationExactBlocker || text(raw.refresh_exact_blocker);
  const targetScopedSelectionBlocked = targetScopedReadback
    && selectedTab === null
    && raw.operation_ready === false
    && raw.operation_status === "blocked"
    && TARGET_SCOPED_FOREGROUND_BLOCKERS.has(String(foregroundBlocker || ""));
  const targetScopedReadOnlyStatusValid = targetScopedReadback
    && readOnlyAdmission
    && ["read_only_ready", "target_scoped_ready"].includes(String(raw.operation_status || ""));
  const operationAdmissionValid = targetScopedSelectionBlocked || (raw.operation_ready === true
    && (targetScopedReadOnlyStatusValid || raw.operation_status === (readOnlyAdmission ? "read_only_ready" : "ready"))
    && (targetScopedReadback || selectedTab !== null)
    && (transportAdmission || (
      visibility?.capabilityId === "visibility"
      && visibility.advertised === true
      && visibility.state === true
    )));
  const operationStatus = raw.operation_status === "ready"
    || raw.operation_status === "read_only_ready"
    || raw.operation_status === "target_scoped_ready"
    || raw.operation_status === "blocked"
    ? raw.operation_status
    : "unknown";
  const identityReady = browser?.type === "extension"
    && browser.metadata.profileOrdering === "2"
    && Boolean(browser.id)
    && Boolean(text(raw.bridge_instance_id));
  const ownerUpdatedMs = bridgeOwner?.updatedAt ? Date.parse(bridgeOwner.updatedAt) : NaN;
  const ownerReady = bridgeOwner?.schema === "aos.chrome_plugin_bridge_owner.v1"
    && (targetScopedReadback
      ? (bridgeOwner.status === "bridge_only" || bridgeOwner.status === "foreground_ready")
      : bridgeOwner.status === "foreground_ready" && bridgeOwner.foregroundExecutorReady)
    && Boolean(bridgeOwner.ownerId)
    && bridgeOwner.bridgeInstanceId === text(raw.bridge_instance_id)
    && Boolean(bridgeOwner.sessionId)
    && Boolean(bridgeOwner.threadId)
    && Boolean(bridgeOwner.turnId)
    && Number.isFinite(ownerUpdatedMs)
    && Math.max(0, (now - ownerUpdatedMs) / 1000) <= staleAfterSeconds;
  const stale = ageSeconds > staleAfterSeconds;
  const refreshStatus = raw.refresh_status === "ready" || raw.refresh_status === "blocked" ? raw.refresh_status : null;
  const refreshExactBlocker = text(raw.refresh_exact_blocker);
  const status = stale
    ? "stale"
      : raw.status === "stopped"
      ? "stopped"
      : !identityReady
        ? "blocked"
        : !ownerReady
          ? "blocked"
        : (raw.status === "ready" || (targetScopedSelectionBlocked && raw.status === "blocked"))
          && raw.browser_execution_disabled !== true && operationAdmissionValid
          ? "ready"
          : "blocked";
  const exactBlocker = stale
    ? refreshExactBlocker || "chrome_extension_bridge_readback_stale"
    : status === "stopped"
      ? "chrome_extension_bridge_stopped"
      : !identityReady
        ? text(raw.exact_blocker) || "chrome_extension_profile2_identity_unverified"
        : !ownerReady
          ? bridgeOwner?.exactBlocker || "chrome_plugin_foreground_executor_not_admitted"
        : status === "blocked"
          ? text(raw.exact_blocker) || operationExactBlocker || "chrome_extension_bridge_execution_unavailable"
          : null;
  const effectiveOperationReady = stale ? false : operationAdmissionValid;
  const effectiveOperationStatus = stale ? "blocked" : operationStatus;
  const failurePlane = failurePlaneFor(exactBlocker);
  return {
    schema: CHROME_PLUGIN_BRIDGE_READBACK_SCHEMA,
    status,
    exactBlocker,
    source: "trusted_chrome_bridge_readback",
    path,
    capturedAt: lastSeenAt,
    lastSeenAt,
    ageSeconds,
    bridgeInstanceId: text(raw.bridge_instance_id),
    bridgeUrl: text(raw.bridge_url),
    browserExecutionAuthority: text(raw.browser_execution_authority),
    browserExecutionDisabled: typeof raw.browser_execution_disabled === "boolean" ? raw.browser_execution_disabled : null,
    operationReady: effectiveOperationReady,
    readbackScope,
    operationStatus: effectiveOperationStatus,
    operationExactBlocker,
    failurePlane,
    blockingScope: exactBlocker ? "chrome_plugin_lane" : null,
    independentLanesAllowed: true,
    selectedTab,
    visibility,
    refreshStatus,
    refreshExactBlocker,
    browser,
    bridgeOwner,
    writerLease,
  };
}

/**
 * Reconstruct the public target-scoped Profile 2 readback from the bounded
 * projection sent by the authenticated Mac worker heartbeat.  The hosted
 * control plane must never try to call the worker's 127.0.0.1 bridge.
 */
export function chromePluginReadbackFromPortableWorkerHeartbeat(
  value: PortableWorkerChromePluginReadback | null | undefined,
  now = Date.now(),
): ChromePluginReadback {
  if (!value) return chromePluginRemoteWorkerReadbackPending(true);
  const lastSeenAt = value.last_seen_at;
  const lastSeenMs = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
  if (!Number.isFinite(lastSeenMs)) return unavailable("portable_remote_worker_heartbeat", "chrome_plugin_remote_worker_readback_timestamp_invalid", "unavailable", "target_scoped");
  const ageSeconds = Math.max(0, (now - lastSeenMs) / 1000);
  const stale = ageSeconds > Math.max(REMOTE_WORKER_READBACK_STALE_SECONDS, Number(process.env.AOS_CHROME_PLUGIN_REMOTE_READBACK_STALE_SECONDS || REMOTE_WORKER_READBACK_STALE_SECONDS));
  const browser = value.browser ? {
    id: value.browser.id,
    name: null,
    type: value.browser.type,
    metadata: {
      extensionId: null,
      extensionInstanceId: null,
      profileName: value.browser.profile_name,
      profileOrdering: value.browser.profile_ordering,
      profileIsLastUsed: null,
    }
  } : null;
  const owner = value.bridge_owner ? {
    schema: value.bridge_owner.schema,
    ownerId: value.bridge_owner.owner_id,
    pid: null,
    bridgeInstanceId: value.bridge_owner.bridge_instance_id,
    sessionId: value.bridge_owner.session_id,
    threadId: value.bridge_owner.thread_id,
    turnId: value.bridge_owner.turn_id,
    status: value.bridge_owner.status,
    foregroundExecutorReady: value.bridge_owner.foreground_executor_ready,
    exactBlocker: value.bridge_owner.exact_blocker,
    startedAt: null,
    updatedAt: value.bridge_owner.updated_at,
  } satisfies ChromePluginBridgeOwnerReadback : null;
  const identityReady = browser?.type === "extension"
    && browser.metadata.profileOrdering === "2"
    && Boolean(browser.id)
    && Boolean(value.bridge_instance_id)
    && owner?.schema === "aos.chrome_plugin_bridge_owner.v1"
    && owner.bridgeInstanceId === value.bridge_instance_id
    && Boolean(owner.ownerId)
    && Boolean(owner.sessionId)
    && Boolean(owner.threadId)
    && Boolean(owner.turnId);
  const targetReady = value.target_scoped_ready === true && value.operation_ready === true && ["ready", "read_only_ready", "target_scoped_ready"].includes(value.operation_status);
  const status: ChromePluginReadback["status"] = stale
    ? "stale"
    : identityReady && targetReady
      ? "ready"
      : value.status === "stopped" ? "stopped" : "blocked";
  const exactBlocker = stale
    ? "chrome_plugin_remote_worker_readback_stale"
    : !identityReady
      ? "chrome_plugin_remote_worker_profile2_identity_unverified"
      : targetReady
        ? null
        : value.target_scoped_exact_blocker || value.exact_blocker || value.operation_exact_blocker || "chrome_plugin_remote_worker_target_readback_unavailable";
  return {
    schema: CHROME_PLUGIN_BRIDGE_READBACK_SCHEMA,
    status,
    exactBlocker,
    source: "portable_worker_heartbeat",
    path: "portable_remote_worker_heartbeat",
    capturedAt: lastSeenAt,
    lastSeenAt,
    ageSeconds,
    bridgeInstanceId: value.bridge_instance_id,
    bridgeUrl: null,
    browserExecutionAuthority: "read_only_admission",
    browserExecutionDisabled: false,
    operationReady: status === "ready" && targetReady,
    readbackScope: "target_scoped",
    operationStatus: stale ? "blocked" : value.operation_status,
    operationExactBlocker: value.operation_exact_blocker,
    failurePlane: failurePlaneFor(exactBlocker),
    blockingScope: exactBlocker ? "chrome_plugin_lane" : null,
    independentLanesAllowed: true,
    selectedTab: null,
    visibility: null,
    refreshStatus: status === "ready" ? "ready" : "blocked",
    refreshExactBlocker: status === "ready" ? null : exactBlocker,
    browser,
    bridgeOwner: owner,
    writerLease: null,
  };
}

function bridgeHealthUnavailable(current: ChromePluginReadback, exactBlocker: string): ChromePluginReadback {
  if (current.status === "unavailable") {
    return {
      ...current,
      exactBlocker,
      operationReady: false,
      operationStatus: "blocked",
      operationExactBlocker: exactBlocker,
      failurePlane: failurePlaneFor(exactBlocker),
      blockingScope: "chrome_plugin_lane",
      independentLanesAllowed: true,
      refreshStatus: "blocked",
      refreshExactBlocker: exactBlocker,
    };
  }
  return {
    ...current,
    status: "stale",
    exactBlocker,
    operationReady: false,
    operationStatus: "blocked",
    operationExactBlocker: exactBlocker,
    failurePlane: failurePlaneFor(exactBlocker),
    blockingScope: "chrome_plugin_lane",
    independentLanesAllowed: true,
    refreshStatus: "blocked",
    refreshExactBlocker: exactBlocker,
  };
}

export function readChromePluginReadback(now = Date.now(), { targetScopedReadback = false } = {}): ChromePluginReadback {
  const readbackScope: ChromePluginReadbackScope = targetScopedReadback ? "target_scoped" : "foreground";
  const path = readbackPath();
  if (!existsSync(path)) return unavailable(path, "chrome_extension_bridge_readback_missing", "unavailable", readbackScope);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return unavailable(path, "chrome_extension_bridge_readback_not_regular_file", "unavailable", readbackScope);
    if ((stat.mode & 0o077) !== 0) return unavailable(path, "chrome_extension_bridge_readback_permissions_invalid", "unavailable", readbackScope);
    const raw = JSON.parse(readFileSync(path, "utf8")) as RawChromePluginReadback;
    if (raw.schema !== CHROME_PLUGIN_BRIDGE_READBACK_SCHEMA) return unavailable(path, "chrome_extension_bridge_readback_schema_invalid", "unavailable", readbackScope);
    return readChromePluginReadbackValue(raw, path, now, { targetScopedReadback });
  } catch (error) {
    return unavailable(path, `chrome_extension_bridge_readback_unreadable:${error instanceof Error ? error.message : String(error)}`, "unavailable", readbackScope);
  }
}

/**
 * Ask the already-running trusted bridge to refresh its same-instance
 * readback before an async control-plane snapshot. This is deliberately
 * loopback-only and never starts a browser, changes tabs, or switches
 * providers. A missing/unreachable bridge returns the ordinary stale or
 * unavailable readback so the caller still fails closed.
 */
export async function refreshChromePluginReadback(options: { timeoutMs?: number; targetScopedReadback?: boolean } = {}): Promise<ChromePluginReadback> {
  const targetScopedReadback = options.targetScopedReadback === true;
  const current = readChromePluginReadback(Date.now(), { targetScopedReadback });
  const configuredPort = Number.parseInt(process.env.AOS_CHROME_PLUGIN_BRIDGE_PORT?.trim() || "58744", 10);
  const bridgePort = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65536
    ? configuredPort
    : 58744;
  const candidate = current.bridgeUrl
    || process.env.AOS_CHROME_PLUGIN_BRIDGE_URL?.trim()
    || `http://127.0.0.1:${bridgePort}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return current;
  }
  if (!((url.hostname === "127.0.0.1" || url.hostname === "localhost") && (url.protocol === "http:" || url.protocol === "https:"))) {
    return current;
  }
  const timeoutMs = Math.max(100, Math.min(3000, Number(options.timeoutMs ?? 1200)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL("/health", url), { signal: controller.signal });
    if (!response.ok) return bridgeHealthUnavailable(current, "chrome_extension_bridge_health_unavailable");
    const health = await response.json().catch(() => ({})) as {
      bridge_instance_id?: unknown;
      url?: unknown;
      browser_readback?: RawChromePluginReadback;
    };
    const healthBridgeInstanceId = text(health.bridge_instance_id);
    if (healthBridgeInstanceId && current.bridgeInstanceId && healthBridgeInstanceId !== current.bridgeInstanceId) {
      return bridgeHealthUnavailable(current, "chrome_extension_bridge_instance_mismatch");
    }
    const healthUrl = text(health.url);
    if (healthUrl && current.bridgeUrl && healthUrl.replace(/\/$/u, "") !== current.bridgeUrl.replace(/\/$/u, "")) {
      return bridgeHealthUnavailable(current, "chrome_extension_bridge_url_mismatch");
    }
    const freshReadback = health.browser_readback;
    if (freshReadback && freshReadback.schema === CHROME_PLUGIN_BRIDGE_READBACK_SCHEMA) {
      return readChromePluginReadbackValue(freshReadback, current.path, Date.now(), { targetScopedReadback });
    }
    return readChromePluginReadback(Date.now(), { targetScopedReadback });
  } catch {
    return bridgeHealthUnavailable(current, "chrome_extension_bridge_unreachable");
  } finally {
    clearTimeout(timer);
  }
}

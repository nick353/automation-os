import { existsSync, lstatSync } from "node:fs";
import { registeredBrowserLanes, type RegisteredBrowserLane } from "../runs/laneManager.js";
import { buildRegisteredWorkflowInventoryReadback } from "../workflowInventory.js";
import { buildBrowserRuntimeProcessReadback, buildBrowserRuntimeProcessReadbackAsync } from "./liveResourceReadback.js";

export const BROWSER_OPERATIONAL_READBACK_SCHEMA = "aos.browser_operational_readback.v1" as const;

export type BrowserOperationalReadback = {
  schema: typeof BROWSER_OPERATIONAL_READBACK_SCHEMA;
  scope: "current_control_plane_snapshot";
  capturedAt: string;
  authentication: {
    status: "unknown" | "waiting_auth" | "verified" | "not_required";
    exactBlocker: string | null;
    source: "same_run_screen_readback_required";
  };
  externalEffect: {
    status: "not_verified" | "approval_pending" | "executed" | "reconciliation_required";
    externalActionExecuted: boolean;
    exactBlocker: string;
    source: "same_run_provider_receipt_required";
  };
  businessCompletion: {
    status: "not_claimed" | "verified" | "blocked";
    businessCompletionVerified: boolean;
    exactBlocker: string;
    source: "same_run_business_receipt_and_source_sync_required";
  };
  receipt: {
    status: "not_claimed" | "present" | "verified" | "missing" | "unknown";
    sameRunReceipt: boolean;
    exactBlocker: string;
  };
  sourceSync: {
    status: "not_claimed" | "present" | "verified" | "missing" | "unknown";
    sameRunSourceSync: boolean;
    exactBlocker: string;
  };
  worker: {
    processStatus: "present" | "absent" | "unknown";
    transportStatus: "available" | "missing" | "invalid" | "unavailable";
    heartbeatStatus: "ok" | "blocked" | "unknown";
    claimStatus: "claimed" | "idle" | "unknown";
    receiptStatus: "not_claimed";
    sourceSyncStatus: "not_claimed";
    exactBlocker: string | null;
  };
};

export type PublicBrowserUseLaneBinding = {
  id: string;
  workflowId: string;
  runnerKind: string;
  canonicalBrowserSurface: "browser_use_cli";
  executionContract: "workflow_owned_runner";
  visibility: RegisteredBrowserLane["laneVisibility"];
  status: "registered";
  lifecycle: RegisteredBrowserLane["lifecycle"];
  profileRef: string;
  profileName: string;
  reservedPort: number;
  portStatus: "reserved";
  ownership: "workflow_owned";
  bindingStatus: "registered";
  liveReadbackStatus: "not_claimed";
  processReadbackStatus: "present" | "absent" | "binding_mismatch" | "unavailable" | "not_observed";
  processPid: number | null;
  processReadbackCapturedAt: string | null;
};

/**
 * Public, non-sensitive lane binding. The worker-local absolute profile path,
 * lock path, cookies, and CDP URL remain private. `profileRef` is relative to
 * the Browser Use profiles root so the UI can identify the profile without
 * exposing the machine filesystem layout.
 */
export function publicBrowserUseLaneBinding(lane: RegisteredBrowserLane): PublicBrowserUseLaneBinding;
export function publicBrowserUseLaneBinding(lane: RegisteredBrowserLane | undefined): PublicBrowserUseLaneBinding | null;
export function publicBrowserUseLaneBinding(lane: RegisteredBrowserLane | undefined): PublicBrowserUseLaneBinding | null {
  if (!lane) return null;
  const profileRef = publicProfileRef(lane.profileDir);
  return {
    id: lane.id,
    workflowId: lane.workflowId,
    runnerKind: lane.runnerKind,
    canonicalBrowserSurface: "browser_use_cli",
    executionContract: "workflow_owned_runner",
    visibility: lane.laneVisibility,
    status: "registered",
    lifecycle: lane.lifecycle,
    profileRef,
    profileName: profileRef.split("/").at(-1) ?? profileRef,
    reservedPort: lane.reservedPort,
    portStatus: "reserved",
    ownership: "workflow_owned",
    bindingStatus: "registered",
    liveReadbackStatus: "not_claimed",
    processReadbackStatus: "not_observed",
    processPid: null,
    processReadbackCapturedAt: null
  };
}

/**
 * Public projection of the locally stabilized Browser Use contract.
 * Private paths, lock files, cookies, CDP URLs, and authority contents stay
 * local to the worker. Stable logical profile references and reserved ports
 * are returned so the control plane can explain the active lane contract.
 */
export function buildBrowserUseRuntimeSnapshot(options: { controlPlaneCompanyIds?: string[] } = {}) {
  const processReadback = buildBrowserRuntimeProcessReadback({
    controlPlaneCompanyIds: options.controlPlaneCompanyIds,
    readLiveProcessTable: shouldReadLiveProcessTable()
  });
  return buildBrowserUseRuntimeSnapshotFromReadback(options, processReadback);
}

export async function buildBrowserUseRuntimeSnapshotAsync(options: { controlPlaneCompanyIds?: string[] } = {}) {
  const processReadback = await buildBrowserRuntimeProcessReadbackAsync({
    controlPlaneCompanyIds: options.controlPlaneCompanyIds,
    readLiveProcessTable: shouldReadLiveProcessTable()
  });
  return buildBrowserUseRuntimeSnapshotFromReadback(options, processReadback);
}

function buildBrowserUseRuntimeSnapshotFromReadback(
  options: { controlPlaneCompanyIds?: string[] },
  processReadback: ReturnType<typeof buildBrowserRuntimeProcessReadback>
) {
  const runtimeRole = process.env.AUTOMATION_OS_RUNTIME_ROLE === "mac_worker" ? "mac_worker" : "control_plane";
  const helperPath = "/Users/nichikatanaka/.local/bin/codex-browser-use";
  const helperStat = tryLstat(helperPath);
  const helperConfigured = Boolean(helperStat?.isFile() && !helperStat.isSymbolicLink());
  const helperTargetPresent = existsSync(helperPath);
  const adapterConfigured = existsSync("/Users/nichikatanaka/.codex/skills/automation-kernel-run/scripts/browser-use-cli-stage-adapter.mjs");
  const verified = process.env.AUTOMATION_OS_BROWSER_USE_RUNTIME_VERIFIED === "1";
  const workerBlocker = !helperTargetPresent
    ? "browser_use_helper_missing"
    : !helperConfigured
      ? "browser_use_helper_must_be_canonical_regular_file"
      : !adapterConfigured
        ? "browser_use_adapter_missing"
        : !verified
          ? "browser_use_runtime_not_verified"
          : null;
  const exactBlocker = runtimeRole === "mac_worker" ? workerBlocker : "browser_use_worker_readback_pending";
  const status = runtimeRole === "mac_worker"
    ? workerBlocker ? "blocked" : "verified"
    : "readback_pending";
  const summary = runtimeRole === "mac_worker"
    ? status === "verified"
      ? "Mac workerのcanonical Browser Use helperとadapterを確認済みです。"
      : "Mac workerのBrowser Use runtime確認が完了していません。"
    : "Zeabur control planeではBrowser Useを起動せず、Mac workerのruntime readbackを待ちます。";
  const nextAction = runtimeRole === "mac_worker"
    ? status === "verified"
      ? "同一runのauthority・session・readbackを確認してから実行します。"
      : "Mac workerでcanonical helper/adapterのreadbackを完了してください。"
    : "Mac worker heartbeatと同一runのBrowser Use readbackを確認してください。";
  const operationalReadback = buildBrowserOperationalReadback(processReadback);
  const lanes = registeredBrowserLanes.map((lane) => {
    const binding = publicBrowserUseLaneBinding(lane);
    const laneReadback = processReadback.registeredLanes.find((item) => item.laneId === lane.id);
    const processReadbackStatus = processReadback.status === "unavailable"
      ? "unavailable"
      : laneReadback?.processStatus ?? "unavailable";
    return {
      ...binding,
      processReadbackStatus,
      processPid: laneReadback?.matchingPid ?? laneReadback?.mismatchPid ?? null,
      processReadbackCapturedAt: processReadback.capturedAt
    } as const;
  });
  return {
    surface: "browser_use_cli",
    helper: "canonical_codex_browser_use",
    runtimeRole,
    status,
    exactBlocker,
    readbackStatus: runtimeRole === "mac_worker" && status === "verified" ? "verified" : "pending",
    summary,
    nextAction,
    fallbackPolicy: "no_implicit_surface_switch",
    contract: [
      "workflow_owned_session",
      "profile_and_port_lock",
      "record_start_readback_finalize",
      "authority_bound_external_effects",
      "cleanup_and_receipt"
    ],
    lanes,
    processReadback,
    operationalReadback,
    workflowInventory: buildRegisteredWorkflowInventoryReadback()
  } as const;
}

function shouldReadLiveProcessTable(): boolean {
  return process.env.AUTOMATION_OS_READ_LIVE_PROCESS_TABLE === "1"
    ? true
    : process.env.AUTOMATION_OS_READ_LIVE_PROCESS_TABLE === "0"
      ? false
      : process.env.NODE_TEST_CONTEXT !== "1" && !process.argv.some((argument) => argument === "--test" || argument.startsWith("--test-"));
}

export function buildBrowserOperationalReadback(processReadback: ReturnType<typeof buildBrowserRuntimeProcessReadback>): BrowserOperationalReadback {
  const transport = processReadback.portableRemoteWorker.transportReadback;
  const workerProcessStatus = processReadback.portableRemoteWorker.status === "present"
    ? "present"
    : processReadback.portableRemoteWorker.status === "absent"
      ? "absent"
      : "unknown";
  return {
    schema: BROWSER_OPERATIONAL_READBACK_SCHEMA,
    scope: "current_control_plane_snapshot",
    capturedAt: processReadback.capturedAt,
    authentication: {
      status: "unknown",
      exactBlocker: "browser_use_authentication_screen_readback_required",
      source: "same_run_screen_readback_required"
    },
    externalEffect: {
      status: "not_verified",
      externalActionExecuted: false,
      exactBlocker: "same_run_external_effect_receipt_required",
      source: "same_run_provider_receipt_required"
    },
    businessCompletion: {
      status: "not_claimed",
      businessCompletionVerified: false,
      exactBlocker: "same_run_business_completion_proof_required",
      source: "same_run_business_receipt_and_source_sync_required"
    },
    receipt: {
      status: "not_claimed",
      sameRunReceipt: false,
      exactBlocker: "same_run_receipt_required"
    },
    sourceSync: {
      status: "not_claimed",
      sameRunSourceSync: false,
      exactBlocker: "same_run_source_sync_required"
    },
    worker: {
      processStatus: workerProcessStatus,
      transportStatus: transport.status,
      heartbeatStatus: transport.heartbeatStatus,
      claimStatus: transport.claimStatus,
      receiptStatus: "not_claimed",
      sourceSyncStatus: "not_claimed",
      exactBlocker: processReadback.exactBlocker
        ?? processReadback.portableRemoteWorker.scopeReadback.exactBlocker
        ?? transport.heartbeatExactBlocker
    }
  };
}

function publicProfileRef(profileDir: string): string {
  const normalized = profileDir.replaceAll("\\", "/");
  const marker = "/profiles/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex >= 0) return normalized.slice(markerIndex + marker.length);
  return normalized.split("/").filter(Boolean).at(-1) ?? "unknown";
}

function tryLstat(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

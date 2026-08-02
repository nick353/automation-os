import { existsSync, lstatSync } from "node:fs";
import { registeredBrowserLanes } from "../runs/laneManager.js";

/**
 * Public projection of the locally stabilized Browser Use contract.
 * Private paths, ports, profiles, cookies, and authority contents stay local
 * to the worker and are intentionally not returned here.
 */
export function buildBrowserUseRuntimeSnapshot() {
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
    lanes: registeredBrowserLanes.map((lane) => ({
      id: lane.id,
      workflowId: lane.workflowId,
      runnerKind: lane.runnerKind,
      visibility: lane.laneVisibility,
      status: "registered"
    }))
  } as const;
}

function tryLstat(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

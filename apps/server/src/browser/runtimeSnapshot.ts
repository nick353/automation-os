import { existsSync, lstatSync } from "node:fs";
import { registeredBrowserLanes } from "../runs/laneManager.js";

/**
 * Public projection of the locally stabilized Browser Use contract.
 * Private paths, ports, profiles, cookies, and authority contents stay local
 * to the worker and are intentionally not returned here.
 */
export function buildBrowserUseRuntimeSnapshot() {
  const helperPath = "/Users/nichikatanaka/.local/bin/codex-browser-use";
  const helperStat = tryLstat(helperPath);
  const helperConfigured = Boolean(helperStat?.isFile() && !helperStat.isSymbolicLink());
  const helperTargetPresent = existsSync(helperPath);
  const adapterConfigured = existsSync("/Users/nichikatanaka/.codex/skills/automation-kernel-run/scripts/browser-use-cli-stage-adapter.mjs");
  const verified = process.env.AUTOMATION_OS_BROWSER_USE_RUNTIME_VERIFIED === "1";
  const exactBlocker = !helperTargetPresent
    ? "browser_use_helper_missing"
    : !helperConfigured
      ? "browser_use_helper_must_be_canonical_regular_file"
      : !adapterConfigured
        ? "browser_use_adapter_missing"
        : null;
  return {
    surface: "browser_use_cli",
    helper: "canonical_codex_browser_use",
    status: verified && !exactBlocker ? "verified" : !exactBlocker ? "configured" : "blocked",
    exactBlocker,
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

import { createHash } from "node:crypto";
import {
  BROWSER_USE_LOCK_ROOT,
  BROWSER_USE_SCHEDULED_PROFILE_ROOT,
  BROWSER_USE_SINGLE_USE_PROFILE_ROOT,
  BROWSER_USE_TEMPORARY_PROFILE_ROOT
} from "./browserUseCanonical.js";

export type BrowserUseLifecycle = "single_use" | "temporary" | "scheduled";

export const BROWSER_USE_LIFECYCLE_PORT_RANGES: Record<BrowserUseLifecycle, { min: number; max: number }> = {
  scheduled: { min: 19880, max: 19899 },
  single_use: { min: 19980, max: 19999 },
  temporary: { min: 20080, max: 20099 }
};

const workflowSlots: Record<string, { lifecycle: BrowserUseLifecycle; port: number; profile: string }> = {
  "job-application-manager": { lifecycle: "scheduled", port: 19881, profile: "automation-3" },
  "daily-ai-research-publish-run": { lifecycle: "scheduled", port: 19882, profile: "daily-ai" },
  "nisenprints-daily-product-canva-printify-etsy-pinterest": { lifecycle: "scheduled", port: 19884, profile: "nisenprints" },
  "x-authenticated-browser-lane": { lifecycle: "scheduled", port: 19885, profile: "x-authenticated-browser-lane" },
  "youtube-visible-transcript-capture": { lifecycle: "temporary", port: 20080, profile: "youtube-visible-transcript" },
  "prompt-transfer-ukiyoe": { lifecycle: "single_use", port: 19981, profile: "prompt-transfer-ukiyoe" },
  "sns-multi-poster-ukiyoe": { lifecycle: "temporary", port: 20081, profile: "sns-multi-poster-ukiyoe" }
};

const lifecycleRoots: Record<BrowserUseLifecycle, string> = {
  scheduled: BROWSER_USE_SCHEDULED_PROFILE_ROOT,
  single_use: BROWSER_USE_SINGLE_USE_PROFILE_ROOT,
  temporary: BROWSER_USE_TEMPORARY_PROFILE_ROOT
};

export type BrowserUseLaneBinding = {
  schema: "aos.browser_use_lane_binding.v1";
  lifecycle: BrowserUseLifecycle;
  owner_key: string;
  workflow_id: string;
  surface: "browser_use_cli";
  profile_dir: string;
  reserved_port: number;
  session: string;
  lock_path: string;
  allocation: "workflow_reserved" | "run_derived";
};

/**
 * Browser Use CLI's lock identity is the profile, not the planner task id.
 * Keep this projection byte-for-byte aligned with the canonical stage adapter
 * so two workflows can never appear isolated while sharing one lock file.
 */
export function profileLockPathFor(profileDir: string): string {
  return `${BROWSER_USE_LOCK_ROOT}/profile-${createHash("sha256").update(profileDir, "utf8").digest("hex").slice(0, 24)}.lock`;
}

export function profileRootForLifecycle(lifecycle: BrowserUseLifecycle): string {
  return lifecycleRoots[lifecycle];
}

export function browserUseLaneFor(input: {
  lifecycle: BrowserUseLifecycle;
  ownerKey: string;
  workflowId?: string;
}): BrowserUseLaneBinding {
  const ownerKey = safeToken(input.ownerKey, "owner");
  const workflowId = safeToken(input.workflowId || input.ownerKey, "workflow");
  const range = BROWSER_USE_LIFECYCLE_PORT_RANGES[input.lifecycle];
  const slot = input.workflowId ? workflowSlots[input.workflowId] : undefined;
  const reserved = slot?.lifecycle === input.lifecycle ? slot : undefined;
  const digest = createHash("sha256").update(`${input.lifecycle}:${input.ownerKey}:${input.workflowId || ""}`).digest("hex");
  const port = reserved?.port ?? range.min + (Number.parseInt(digest.slice(0, 8), 16) % (range.max - range.min + 1));
  const profileName = reserved?.profile ?? `${ownerKey}-${digest.slice(0, 12)}`;
  const profileDir = `${lifecycleRoots[input.lifecycle]}/${profileName}`;
  const session = `browser-use-${input.lifecycle}-${ownerKey}-${digest.slice(0, 12)}`;
  const lockPath = profileLockPathFor(profileDir);
  return {
    schema: "aos.browser_use_lane_binding.v1",
    lifecycle: input.lifecycle,
    owner_key: input.ownerKey,
    workflow_id: input.workflowId || input.ownerKey,
    surface: "browser_use_cli",
    profile_dir: profileDir,
    reserved_port: port,
    session,
    lock_path: lockPath,
    allocation: reserved ? "workflow_reserved" : "run_derived"
  };
}

export function assertBrowserUseLaneBinding(binding: BrowserUseLaneBinding): void {
  const range = BROWSER_USE_LIFECYCLE_PORT_RANGES[binding.lifecycle];
  const root = lifecycleRoots[binding.lifecycle];
  if (binding.surface !== "browser_use_cli") throw new Error("browser_use_lane_surface_invalid");
  if (!Number.isSafeInteger(binding.reserved_port) || binding.reserved_port < range.min || binding.reserved_port > range.max) {
    throw new Error("browser_use_lane_port_outside_lifecycle_range");
  }
  if (!binding.profile_dir.startsWith(`${root}/`) || binding.profile_dir.includes("/../")) {
    throw new Error("browser_use_lane_profile_outside_lifecycle_root");
  }
  if (binding.lock_path !== profileLockPathFor(binding.profile_dir)) throw new Error("browser_use_lane_lock_profile_mismatch");
}

function safeToken(value: string, fallback: string): string {
  const token = String(value || "").replace(/[^0-9A-Za-z_.-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return token || fallback;
}

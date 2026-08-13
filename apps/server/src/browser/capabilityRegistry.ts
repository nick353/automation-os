import { createHash } from "node:crypto";
import type { BrowserSurface } from "./browserKernel.js";

export const BROWSER_CAPABILITY_MANIFEST_SCHEMA_V1 = "automation_os_browser_capability_manifest.v1" as const;
export type BrowserCapabilityName = "authenticated" | "observe" | "locate" | "scroll" | "fill" | "select" | "upload" | "iframe" | "screenshot" | "extract" | "submit" | "visible_confirmation";
export type BrowserCapabilityManifestV1 = { schema: typeof BROWSER_CAPABILITY_MANIFEST_SCHEMA_V1; run_id: string; session_id: string; surface: BrowserSurface; capabilities: Readonly<Record<BrowserCapabilityName, boolean>>; allowed_origins: readonly string[]; profile_binding_digest: string; source_state_digest: string; expires_at: string; exact_blocker: string | null; alternative_stage: string | null };

const HASH = /^[a-f0-9]{64}$/u;
const ALL: readonly BrowserCapabilityName[] = ["authenticated", "observe", "locate", "scroll", "fill", "select", "upload", "iframe", "screenshot", "extract", "submit", "visible_confirmation"];
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export function buildCapabilityManifest(input: { runId: string; sessionId: string; surface: BrowserSurface; capabilities: Partial<Record<BrowserCapabilityName, boolean>>; allowedOrigins: readonly string[]; profileBindingRef: string; sourceStateRef: string; expiresAt: string; exactBlocker?: string | null; alternativeStage?: string | null }): BrowserCapabilityManifestV1 {
  const capabilities = Object.fromEntries(ALL.map((name) => [name, input.capabilities[name] === true])) as Record<BrowserCapabilityName, boolean>;
  return { schema: BROWSER_CAPABILITY_MANIFEST_SCHEMA_V1, run_id: input.runId, session_id: input.sessionId, surface: input.surface, capabilities, allowed_origins: [...new Set(input.allowedOrigins)].sort(), profile_binding_digest: digest(input.profileBindingRef), source_state_digest: digest(input.sourceStateRef), expires_at: new Date(input.expiresAt).toISOString(), exact_blocker: input.exactBlocker ?? null, alternative_stage: input.alternativeStage ?? null };
}

export function planAgainstCapabilities(manifest: BrowserCapabilityManifestV1, required: readonly BrowserCapabilityName[]): { status: "ready" | "blocked"; missing: BrowserCapabilityName[]; exact_blocker: string | null; alternative_stage: string | null } {
  const missing = required.filter((capability) => manifest.capabilities[capability] !== true);
  if (!missing.length) return { status: "ready", missing: [], exact_blocker: null, alternative_stage: null };
  return { status: "blocked", missing, exact_blocker: manifest.exact_blocker || `browser_capability_${missing[0]}_unavailable`, alternative_stage: manifest.alternative_stage || (missing.includes("upload") ? "read_only_discovery_without_upload" : "observe_and_clarify_missing_capability") };
}

export function validateCapabilityManifest(input: unknown): BrowserCapabilityManifestV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("browser_capability_manifest_missing");
  const value = input as BrowserCapabilityManifestV1;
  if (value.schema !== BROWSER_CAPABILITY_MANIFEST_SCHEMA_V1 || !value.run_id || !value.session_id || !HASH.test(value.profile_binding_digest) || !HASH.test(value.source_state_digest)) throw new Error("browser_capability_manifest_invalid");
  if (!ALL.every((name) => typeof value.capabilities?.[name] === "boolean")) throw new Error("browser_capability_manifest_capabilities_invalid");
  return value;
}

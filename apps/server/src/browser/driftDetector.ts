import { createHash } from "node:crypto";

export const BROWSER_DRIFT_SCHEMA_V1 = "automation_os_browser_drift.v1" as const;
export type BrowserPageFingerprintV1 = { route: string; dom_sha256: string; accessibility_sha256: string; visible_text_sha256: string; labels_sha256: string; page_sha256: string };
export type BrowserDriftResultV1 = { schema: typeof BROWSER_DRIFT_SCHEMA_V1; status: "stable" | "drifted"; changed: string[]; exact_blocker: "browser_page_drift_reobserve_required" | null; next_action: string };

const HASH = /^[a-f0-9]{64}$/u;
function digest(value: unknown): string { return createHash("sha256").update(String(value || "")).digest("hex"); }
export function fingerprintBrowserPage(input: { route: string; dom: string; accessibilityTree: string; visibleText: string; labels: readonly string[] }): BrowserPageFingerprintV1 { return { route: input.route, dom_sha256: digest(input.dom), accessibility_sha256: digest(input.accessibilityTree), visible_text_sha256: digest(input.visibleText), labels_sha256: digest(input.labels.join("\n")), page_sha256: digest(JSON.stringify(input)) }; }
export function detectBrowserDrift(previous: BrowserPageFingerprintV1, current: BrowserPageFingerprintV1): BrowserDriftResultV1 {
  const changed = ["route", "dom_sha256", "accessibility_sha256", "visible_text_sha256", "labels_sha256", "page_sha256"].filter((key) => previous[key as keyof BrowserPageFingerprintV1] !== current[key as keyof BrowserPageFingerprintV1]);
  if (!changed.every((key) => key === "page_sha256") && !changed.length) throw new Error("browser_drift_fingerprint_invalid");
  if (![previous, current].every((value) => [value.dom_sha256, value.accessibility_sha256, value.visible_text_sha256, value.labels_sha256, value.page_sha256].every((hash) => HASH.test(hash)))) throw new Error("browser_drift_fingerprint_invalid");
  return changed.length ? { schema: BROWSER_DRIFT_SCHEMA_V1, status: "drifted", changed, exact_blocker: "browser_page_drift_reobserve_required", next_action: "fresh observe then semantic locate; never reuse stale selector or coordinate" } : { schema: BROWSER_DRIFT_SCHEMA_V1, status: "stable", changed: [], exact_blocker: null, next_action: "continue same-run command" };
}

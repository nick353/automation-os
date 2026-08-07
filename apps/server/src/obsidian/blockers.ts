export type ObsidianBlockerCategory =
  | "busy"
  | "route_pending"
  | "unverified"
  | "retryable"
  | "hard_block"
  | "vault_guard"
  | "lease"
  | "human_review"
  | "external_action"
  | "invalid_input"
  | "unknown";

export type ObsidianBlocker = {
  code: string;
  category: ObsidianBlockerCategory;
  retryable: boolean;
  humanReviewRequired: boolean;
  message: string;
};

export function classifyObsidianBlocker(value: unknown): ObsidianBlocker {
  const message = value instanceof Error ? value.message : String(value ?? "unknown_error");
  const normalized = message.toLowerCase();
  if (normalized.includes("obsidian_vault_write_locked") || normalized.includes("export_in_flight")) {
    return blocker("obsidian_vault_busy", "busy", true, false, message);
  }
  if (/project_not_resolved|connector|surface|scope_mismatch|wrong_surface|route_pending/.test(normalized)) {
    return blocker("route_pending", "route_pending", true, false, message);
  }
  if (/non-generated|non_generated|parity[_ -]?drift|generated[_ -]?manifest/.test(normalized)) {
    return blocker("parity_drift", "unverified", false, false, message);
  }
  if (/readback|receipt|coverage|proof|unverified/.test(normalized)) {
    return blocker("evidence_unverified", "unverified", true, false, message);
  }
  if (/captcha|\botp\b|security[_ -]?code|identity[_ -]?verification|human[_ -]?input/.test(normalized)) {
    return blocker("human_input_required", "human_review", false, true, message);
  }
  if (/secret|password|billing|purchase|payment|checkout|delete|external[_ -]?effect[_ -]?(?:ambiguous|uncertain)/.test(normalized)) {
    return blocker("hard_block", "hard_block", false, true, message);
  }
  if (/timeout|timed[_ -]?out|econnreset|temporar|eai_again|network|retry/.test(normalized)) {
    return blocker("retryable_runtime", "retryable", true, false, message);
  }
  if (normalized.includes("custom_export_requires_approval") || normalized.includes("vault_path")) {
    return blocker("obsidian_vault_guard", "vault_guard", false, true, message);
  }
  if (normalized.includes("lease") || normalized.includes("fence")) {
    return blocker("obsidian_vault_lease_invalid", "lease", true, false, message);
  }
  if (normalized.includes("external_or_approval_required") || normalized.includes("human_review")) {
    return blocker("human_review_required", "human_review", false, true, message);
  }
  if (normalized.includes("external_action") || normalized.includes("approval_required")) {
    return blocker("external_action_boundary", "external_action", false, true, message);
  }
  if (normalized.includes("invalid") || normalized.includes("malformed")) {
    return blocker("obsidian_invalid_input", "invalid_input", false, false, message);
  }
  return blocker("obsidian_unknown_blocker", "unknown", false, false, message);
}

export function isObsidianBusyBlocker(value: unknown): boolean {
  return classifyObsidianBlocker(value).category === "busy";
}

function blocker(
  code: string,
  category: ObsidianBlockerCategory,
  retryable: boolean,
  humanReviewRequired: boolean,
  message: string
): ObsidianBlocker {
  return { code, category, retryable, humanReviewRequired, message };
}

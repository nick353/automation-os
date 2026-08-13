import { createHash } from "node:crypto";

export const BROWSER_KERNEL_SCHEMA_V1 = "automation_os_browser_kernel.v1" as const;
export const BROWSER_COMMAND_SCHEMA_V1 = "automation_os_browser_command.v1" as const;
export const BROWSER_RECEIPT_SCHEMA_V1 = "automation_os_browser_command_receipt.v1" as const;
export const BROWSER_SESSION_SCHEMA_V1 = "automation_os_browser_session.v1" as const;

export type BrowserSurface = "browser_use_cli" | "codex_app_browser";
export type BrowserCommandKind = "observe" | "locate" | "scroll" | "click" | "fill" | "select" | "upload" | "wait" | "extract" | "submit" | "verify";
export type BrowserErrorCode = "target_not_found" | "target_ambiguous" | "stale_element" | "navigation_timeout" | "modal_blocked" | "infinite_scroll_exhausted" | "delayed_render_timeout" | "precondition_mismatch" | "postcondition_mismatch" | "captcha_detected" | "otp_required" | "identity_verification_required" | "unknown_required_fact" | "ambiguous_submit" | "approval_missing" | "same_run_binding_mismatch" | "provider_error" | "cleanup_failed";

export type BrowserSemanticCandidateV1 = {
  candidate_id: string;
  source: "accessibility_tree" | "dom" | "visible_text" | "coordinate_fallback";
  semantic_role: string;
  accessible_name?: string;
  visible_text?: string;
  context?: string;
  visible: boolean;
  enabled: boolean;
  target_digest: string;
  source_state_digest: string;
  coordinate?: { x: number; y: number };
};

export type BrowserSessionBindingV1 = {
  schema: typeof BROWSER_SESSION_SCHEMA_V1;
  run_id: string;
  session_id: string;
  surface: BrowserSurface;
  authority_digest: string;
  allowed_origins: readonly string[];
  expires_at: string;
};

export type BrowserCommandV1 = {
  schema: typeof BROWSER_COMMAND_SCHEMA_V1;
  command_id: string;
  sequence: number;
  kind: BrowserCommandKind;
  session: Pick<BrowserSessionBindingV1, "run_id" | "session_id" | "surface" | "authority_digest">;
  target?: { semantic_query: string; target_key?: string; allow_coordinate_fallback?: boolean };
  payload?: { key: string; sha256: string } | { file_ref: string; sha256: string } | { option: string };
  direction?: "up" | "down" | "left" | "right";
  timeout_ms: number;
  precondition: { source_state_digest?: string; target_digest?: string; visible?: boolean; unique?: boolean; enabled?: boolean };
  postcondition: { source_state_digest?: string; target_digest?: string; expected: "present" | "absent" | "changed" | "unchanged"; receipt_required: boolean };
  effect_preview?: { target_digest: string; payload_sha256: string | null; audience_digest: string };
  approval_id?: string;
};

export type BrowserCommandReceiptV1 = {
  schema: typeof BROWSER_RECEIPT_SCHEMA_V1;
  command_id: string;
  sequence: number;
  kind: BrowserCommandKind;
  run_id: string;
  session_id: string;
  surface: BrowserSurface;
  status: "ok" | "blocked" | "timeout" | "error";
  source_state_digest_before: string;
  source_state_digest_after: string | null;
  target_digest: string | null;
  provider_receipt_digest: string | null;
  external_action_executed: boolean;
  same_run: boolean;
  stale_recovered: boolean;
  visible_confirmation: boolean;
  error_code: BrowserErrorCode | null;
  cleanup_verified: boolean;
};

export type BrowserKernelContractV1 = {
  schema: typeof BROWSER_KERNEL_SCHEMA_V1;
  supported_surfaces: readonly BrowserSurface[];
  pipeline: readonly ["observe", "locate", "scroll", "act", "verify"];
  target_resolution_priority: readonly ["accessibility_tree", "dom", "visible_text", "coordinate_fallback"];
  common_recovery: readonly ["scroll_before_action", "readback_after_action", "stale_element_recovery", "spa_route_recovery", "modal_recovery", "infinite_scroll_recovery", "delayed_render_wait"];
  command_kinds: readonly BrowserCommandKind[];
  timeout_error_taxonomy: readonly BrowserErrorCode[];
  effect_admission: "target_payload_audience_preview_then_one_item_approval";
  completion_proof: readonly ["provider_receipt", "source_sync", "reconciliation", "cleanup"];
  fail_closed_on: readonly ["captcha_detected", "otp_required", "identity_verification_required", "unknown_required_fact", "ambiguous_submit"];
  secret_policy: "never_log_or_artifact_raw_secret_cookie_token_password_page_body";
  selector_policy: "route_adapter_only_semantic_resolution_no_site_selector_in_kernel";
};

export const browserKernelContract: BrowserKernelContractV1 = Object.freeze({
  schema: BROWSER_KERNEL_SCHEMA_V1,
  supported_surfaces: ["browser_use_cli", "codex_app_browser"] as const,
  pipeline: ["observe", "locate", "scroll", "act", "verify"] as const,
  target_resolution_priority: ["accessibility_tree", "dom", "visible_text", "coordinate_fallback"] as const,
  common_recovery: ["scroll_before_action", "readback_after_action", "stale_element_recovery", "spa_route_recovery", "modal_recovery", "infinite_scroll_recovery", "delayed_render_wait"] as const,
  command_kinds: ["observe", "locate", "scroll", "click", "fill", "select", "upload", "wait", "extract", "submit", "verify"] as const,
  timeout_error_taxonomy: ["target_not_found", "target_ambiguous", "stale_element", "navigation_timeout", "modal_blocked", "infinite_scroll_exhausted", "delayed_render_timeout", "precondition_mismatch", "postcondition_mismatch", "captcha_detected", "otp_required", "identity_verification_required", "unknown_required_fact", "ambiguous_submit", "approval_missing", "same_run_binding_mismatch", "provider_error", "cleanup_failed"] as const,
  effect_admission: "target_payload_audience_preview_then_one_item_approval",
  completion_proof: ["provider_receipt", "source_sync", "reconciliation", "cleanup"] as const,
  fail_closed_on: ["captcha_detected", "otp_required", "identity_verification_required", "unknown_required_fact", "ambiguous_submit"] as const,
  secret_policy: "never_log_or_artifact_raw_secret_cookie_token_password_page_body",
  selector_policy: "route_adapter_only_semantic_resolution_no_site_selector_in_kernel",
});

const HASH = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,179}$/u;
const SECRET_KEY = /(token|secret|password|cookie|authorization|localstorage|sessionstorage|storage_state|body|html)/iu;

function hash(value: unknown, code: string): string {
  const normalized = String(value || "");
  if (!HASH.test(normalized)) throw new Error(code);
  return normalized;
}

function id(value: unknown, code: string): string {
  const normalized = String(value || "");
  if (!ID.test(normalized)) throw new Error(code);
  return normalized;
}

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export function getBrowserKernelContract(): BrowserKernelContractV1 { return { ...browserKernelContract, supported_surfaces: [...browserKernelContract.supported_surfaces], pipeline: [...browserKernelContract.pipeline], target_resolution_priority: [...browserKernelContract.target_resolution_priority], common_recovery: [...browserKernelContract.common_recovery], command_kinds: [...browserKernelContract.command_kinds], timeout_error_taxonomy: [...browserKernelContract.timeout_error_taxonomy], completion_proof: [...browserKernelContract.completion_proof], fail_closed_on: [...browserKernelContract.fail_closed_on] }; }

export function bindBrowserSession(input: { runId: string; sessionId: string; surface: BrowserSurface; authorityDigest: string; allowedOrigins: readonly string[]; expiresAt: string }): BrowserSessionBindingV1 {
  const runId = id(input.runId, "browser_session_run_id_invalid");
  const sessionId = id(input.sessionId, "browser_session_id_invalid");
  hash(input.authorityDigest, "browser_session_authority_invalid");
  if (!browserKernelContract.supported_surfaces.includes(input.surface)) throw new Error("browser_session_surface_invalid");
  const expires = new Date(input.expiresAt);
  if (!Number.isFinite(expires.getTime()) || expires.getTime() <= Date.now()) throw new Error("browser_session_expiry_invalid");
  const origins = [...new Set(input.allowedOrigins.map((origin) => new URL(origin).origin))].sort();
  if (origins.length === 0) throw new Error("browser_session_origins_missing");
  return { schema: BROWSER_SESSION_SCHEMA_V1, run_id: runId, session_id: sessionId, surface: input.surface, authority_digest: String(input.authorityDigest), allowed_origins: origins, expires_at: expires.toISOString() };
}

export function validateBrowserCommand(input: unknown, session: BrowserSessionBindingV1): BrowserCommandV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("browser_command_missing");
  const value = input as BrowserCommandV1;
  if (value.schema !== BROWSER_COMMAND_SCHEMA_V1 || !browserKernelContract.command_kinds.includes(value.kind)) throw new Error("browser_command_schema_invalid");
  id(value.command_id, "browser_command_id_invalid");
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) throw new Error("browser_command_sequence_invalid");
  if (!Number.isSafeInteger(value.timeout_ms) || value.timeout_ms < 100 || value.timeout_ms > 120_000) throw new Error("browser_command_timeout_invalid");
  if (value.session?.run_id !== session.run_id || value.session?.session_id !== session.session_id || value.session?.surface !== session.surface || value.session?.authority_digest !== session.authority_digest) throw new Error("browser_command_same_run_binding_mismatch");
  for (const field of [value.precondition?.source_state_digest, value.precondition?.target_digest, value.postcondition?.source_state_digest, value.postcondition?.target_digest]) if (field !== undefined) hash(field, "browser_command_digest_invalid");
  if (!value.postcondition || typeof value.postcondition.receipt_required !== "boolean") throw new Error("browser_command_postcondition_invalid");
  if (["click", "fill", "select", "upload", "extract", "submit", "locate", "verify"].includes(value.kind)) {
    if (!value.target || typeof value.target.semantic_query !== "string" || !value.target.semantic_query.trim() || value.target.semantic_query.length > 240) throw new Error("browser_command_semantic_target_required");
    if ("css_selector" in (value.target as unknown as Record<string, unknown>) || "xpath" in (value.target as unknown as Record<string, unknown>)) throw new Error("browser_command_fixed_selector_rejected");
  }
  if (value.kind === "scroll" && !["up", "down", "left", "right"].includes(value.direction || "")) throw new Error("browser_command_scroll_direction_invalid");
  if (["fill", "select", "upload"].includes(value.kind) && !value.payload) throw new Error("browser_command_payload_required");
  if (value.payload && "key" in value.payload && SECRET_KEY.test(String(value.payload.key))) throw new Error("browser_command_secret_payload_key_rejected");
  if (value.payload && "file_ref" in value.payload && SECRET_KEY.test(String(value.payload.file_ref))) throw new Error("browser_command_secret_file_ref_rejected");
  if (value.kind === "submit") {
    if (!value.effect_preview || !HASH.test(value.effect_preview.target_digest) || (value.effect_preview.payload_sha256 !== null && !HASH.test(value.effect_preview.payload_sha256)) || !HASH.test(value.effect_preview.audience_digest)) throw new Error("browser_command_effect_preview_required");
    if (!value.approval_id) throw new Error("browser_command_approval_required");
  }
  return value;
}

export function resolveSemanticTarget(input: { query: string; candidates: readonly BrowserSemanticCandidateV1[] }): { status: "resolved"; candidate: BrowserSemanticCandidateV1 } | { status: "blocked"; error_code: "target_not_found" | "target_ambiguous" } {
  const query = String(input.query || "").normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  if (!query) return { status: "blocked", error_code: "target_not_found" };
  const priority = new Map(browserKernelContract.target_resolution_priority.map((value, index) => [value, 100 - index * 10]));
  const scored = input.candidates.filter((candidate) => candidate.visible && candidate.enabled && HASH.test(candidate.target_digest) && HASH.test(candidate.source_state_digest)).map((candidate) => {
    const text = [candidate.accessible_name, candidate.visible_text, candidate.semantic_role, candidate.context].filter(Boolean).join(" ").normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
    const exact = text === query ? 50 : text.includes(query) || query.includes(text) ? 25 : 0;
    return { candidate, score: (priority.get(candidate.source) || 0) + exact };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score);
  if (!scored.length) return { status: "blocked", error_code: "target_not_found" };
  if (scored.length > 1 && scored[0].score === scored[1].score) return { status: "blocked", error_code: "target_ambiguous" };
  if (scored[0].candidate.source === "coordinate_fallback" && scored[0].candidate.coordinate === undefined) return { status: "blocked", error_code: "target_not_found" };
  return { status: "resolved", candidate: scored[0].candidate };
}

export function validateBrowserReceipt(input: unknown, session: BrowserSessionBindingV1): BrowserCommandReceiptV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("browser_receipt_missing");
  const value = input as BrowserCommandReceiptV1;
  if (value.schema !== BROWSER_RECEIPT_SCHEMA_V1 || value.run_id !== session.run_id || value.session_id !== session.session_id || value.surface !== session.surface || value.same_run !== true) throw new Error("browser_receipt_same_run_binding_mismatch");
  id(value.command_id, "browser_receipt_command_id_invalid");
  hash(value.source_state_digest_before, "browser_receipt_source_state_digest_invalid");
  if (value.source_state_digest_after !== null) hash(value.source_state_digest_after, "browser_receipt_source_state_digest_invalid");
  if (value.target_digest !== null) hash(value.target_digest, "browser_receipt_target_digest_invalid");
  if (value.provider_receipt_digest !== null) hash(value.provider_receipt_digest, "browser_receipt_provider_digest_invalid");
  if (value.status === "ok" && value.error_code !== null) throw new Error("browser_receipt_error_code_invalid");
  if (value.kind === "submit" && value.status === "ok" && value.visible_confirmation !== true) throw new Error("browser_receipt_visible_confirmation_missing");
  if (browserKernelContract.fail_closed_on.includes(value.error_code as (typeof browserKernelContract.fail_closed_on)[number]) && value.external_action_executed !== false) throw new Error("browser_receipt_fail_closed_violation");
  return value;
}

export function browserCommandReceipt(input: { command: BrowserCommandV1; session: BrowserSessionBindingV1; status: BrowserCommandReceiptV1["status"]; before: string; after?: string | null; targetDigest?: string | null; providerReceiptDigest?: string | null; externalActionExecuted?: boolean; staleRecovered?: boolean; visibleConfirmation?: boolean; errorCode?: BrowserErrorCode | null; cleanupVerified?: boolean }): BrowserCommandReceiptV1 {
  validateBrowserCommand(input.command, input.session);
  const receipt: BrowserCommandReceiptV1 = { schema: BROWSER_RECEIPT_SCHEMA_V1, command_id: input.command.command_id, sequence: input.command.sequence, kind: input.command.kind, run_id: input.session.run_id, session_id: input.session.session_id, surface: input.session.surface, status: input.status, source_state_digest_before: input.before, source_state_digest_after: input.after ?? null, target_digest: input.targetDigest ?? null, provider_receipt_digest: input.providerReceiptDigest ?? null, external_action_executed: input.externalActionExecuted === true, same_run: true, stale_recovered: input.staleRecovered === true, visible_confirmation: input.visibleConfirmation === true, error_code: input.errorCode ?? null, cleanup_verified: input.cleanupVerified === true };
  return validateBrowserReceipt(receipt, input.session);
}

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isIP } from "node:net";

export { BROWSER_USE_HELPER_PATH, BROWSER_USE_RUNTIME_CONFIG_PATH } from "./browserUseCanonical.js";
import { BROWSER_USE_HELPER_PATH, BROWSER_USE_RUNTIME_CONFIG_PATH } from "./browserUseCanonical.js";

export const BROWSER_USE_AUTHORITY_SCHEMA_V1 = "browser_use_authority.v1" as const;
export const BROWSER_USE_AUTHORITY_ENVELOPE_SCHEMA_V1 = "browser_use_authority_envelope.v1" as const;
export const BROWSER_USE_MANIFEST_SCHEMA_V1 = "automation_kernel_manifest.v1" as const;
export const BROWSER_USE_SURFACE = "browser_use_cli" as const;

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
const noncePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,255}$/u;

export type BrowserUseApprovalV1 = {
  approved: true;
  subject: string;
  source: string;
  scope: string;
  approved_at: string;
};

export type BrowserUseAuthorityV1 = {
  schema: typeof BROWSER_USE_AUTHORITY_SCHEMA_V1;
  browser_surface: typeof BROWSER_USE_SURFACE;
  authority_id: string;
  nonce: string;
  issuer: "automation_os_root";
  issued_at: string;
  not_before: string;
  expires_at: string;
  run_id: string;
  session: string;
  stage_id: string;
  attempt: number;
  idempotency_key: string;
  allowed_origins: string[];
  account_identity: string;
  data_exposure: string;
  side_effect_scope: string;
  approval: BrowserUseApprovalV1;
  readback_required: true;
  no_fallback: true;
  helper_path: typeof BROWSER_USE_HELPER_PATH;
  runtime_config_path: typeof BROWSER_USE_RUNTIME_CONFIG_PATH;
};

export type BrowserUseAuthorityEnvelopeV1 = {
  schema: typeof BROWSER_USE_AUTHORITY_ENVELOPE_SCHEMA_V1;
  issuer: "automation_os_root";
  authority_sha256: string;
  authority_id: string;
  nonce: string;
  run_id: string;
  session: string;
  stage_id: string;
  attempt: number;
};

export type BrowserUseManifestV1 = {
  schema: typeof BROWSER_USE_MANIFEST_SCHEMA_V1;
  browser_use: {
    surface: typeof BROWSER_USE_SURFACE;
    helper_path: typeof BROWSER_USE_HELPER_PATH;
    runtime_config_path: typeof BROWSER_USE_RUNTIME_CONFIG_PATH;
    mode: "public" | "authorized";
    lifecycle: "scheduled" | "single-use";
    allowed_origins: string[];
    requested_session_id: string;
    authority_ref: string | null;
    authority_expiry: string | null;
    external_action_scope: string;
    recording_required: boolean;
    proof_policy: string;
    cleanup_policy: string;
    no_fallback: true;
  };
};

export type BrowserUseAuthorityExpectation = Pick<BrowserUseAuthorityV1, "run_id" | "session" | "stage_id" | "attempt">;

function invalid(code: string): never {
  throw new Error(code);
}

function identifier(value: unknown, code: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) invalid(code);
  return value;
}

function hash(value: unknown, code: string): string {
  if (typeof value !== "string" || !hashPattern.test(value)) invalid(code);
  return value;
}

function nonce(value: unknown): string {
  if (typeof value !== "string" || !noncePattern.test(value)) invalid("browser_use_authority_nonce_invalid");
  return value;
}

function instant(value: unknown, code: string): string {
  if (typeof value !== "string") invalid(code);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) invalid(code);
  return value;
}

function assertOrigin(value: unknown): string {
  if (typeof value !== "string") invalid("browser_use_authority_origin_invalid");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalid("browser_use_authority_origin_invalid");
  }
  if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    invalid("browser_use_authority_origin_invalid");
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/u, "");
  if (!host || host === "localhost" || host.endsWith(".local") || isIP(host) > 0) {
    invalid("browser_use_authority_private_origin_rejected");
  }
  return parsed.origin;
}

function approval(value: unknown): BrowserUseApprovalV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("browser_use_authority_approval_invalid");
  const body = value as Record<string, unknown>;
  if (body.approved !== true) invalid("browser_use_authority_approval_missing");
  return {
    approved: true,
    subject: identifier(body.subject, "browser_use_authority_approval_subject_invalid"),
    source: identifier(body.source, "browser_use_authority_approval_source_invalid"),
    scope: identifier(body.scope, "browser_use_authority_approval_scope_invalid"),
    approved_at: instant(body.approved_at, "browser_use_authority_approval_time_invalid")
  };
}

function assertRegularOwnedFile(filePath: string, code: string): void {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    invalid(code);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || (uid !== null && stat.uid !== uid)) invalid(code);
  let parent;
  try {
    parent = lstatSync(filePath.replace(/\/[^/]+$/u, "") || "/");
  } catch {
    invalid(code);
  }
  if (parent.isSymbolicLink() || !parent.isDirectory() || (parent.mode & 0o777) !== 0o700 || (uid !== null && parent.uid !== uid)) invalid(code);
}

export function authoritySha256(path: string): string {
  assertRegularOwnedFile(path, "browser_use_authority_file_invalid");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function parseBrowserUseAuthority(value: unknown, expected?: BrowserUseAuthorityExpectation): BrowserUseAuthorityV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("browser_use_authority_json_invalid");
  const body = value as Record<string, unknown>;
  const forbidden = Object.keys(body).find((key) => /secret|token|cookie|password|credential/iu.test(key));
  if (forbidden) invalid(`browser_use_authority_secret_field_forbidden:${forbidden}`);
  if (body.schema !== BROWSER_USE_AUTHORITY_SCHEMA_V1 || body.browser_surface !== BROWSER_USE_SURFACE) invalid("browser_use_authority_schema_invalid");
  if (body.issuer !== "automation_os_root" || body.no_fallback !== true || body.readback_required !== true) invalid("browser_use_authority_provenance_invalid");
  const result: BrowserUseAuthorityV1 = {
    schema: BROWSER_USE_AUTHORITY_SCHEMA_V1,
    browser_surface: BROWSER_USE_SURFACE,
    authority_id: identifier(body.authority_id, "browser_use_authority_id_invalid"),
    nonce: nonce(body.nonce),
    issuer: "automation_os_root",
    issued_at: instant(body.issued_at, "browser_use_authority_issued_at_invalid"),
    not_before: instant(body.not_before, "browser_use_authority_not_before_invalid"),
    expires_at: instant(body.expires_at, "browser_use_authority_expiry_invalid"),
    run_id: identifier(body.run_id, "browser_use_authority_run_id_invalid"),
    session: identifier(body.session, "browser_use_authority_session_invalid"),
    stage_id: identifier(body.stage_id, "browser_use_authority_stage_id_invalid"),
    attempt: Number(body.attempt),
    idempotency_key: identifier(body.idempotency_key, "browser_use_authority_idempotency_key_invalid"),
    allowed_origins: Array.isArray(body.allowed_origins) && body.allowed_origins.length > 0
      ? [...new Set(body.allowed_origins.map(assertOrigin))].sort()
      : invalid("browser_use_authority_allowed_origins_missing"),
    account_identity: identifier(body.account_identity, "browser_use_authority_account_identity_missing"),
    data_exposure: identifier(body.data_exposure, "browser_use_authority_data_exposure_missing"),
    side_effect_scope: identifier(body.side_effect_scope, "browser_use_authority_scope_missing"),
    approval: approval(body.approval),
    readback_required: true,
    no_fallback: true,
    helper_path: body.helper_path === BROWSER_USE_HELPER_PATH ? BROWSER_USE_HELPER_PATH : invalid("browser_use_authority_helper_path_invalid"),
    runtime_config_path: body.runtime_config_path === BROWSER_USE_RUNTIME_CONFIG_PATH ? BROWSER_USE_RUNTIME_CONFIG_PATH : invalid("browser_use_authority_runtime_config_path_invalid")
  };
  if (!Number.isSafeInteger(result.attempt) || result.attempt < 1) invalid("browser_use_authority_attempt_invalid");
  const now = Date.now();
  if (Date.parse(result.expires_at) <= Date.parse(result.not_before) || Date.parse(result.expires_at) <= now || Date.parse(result.not_before) > now) invalid("browser_use_authority_time_window_invalid");
  if (expected) {
    for (const field of ["run_id", "session", "stage_id"] as const) if (result[field] !== expected[field]) invalid(`browser_use_authority_binding_mismatch:${field}`);
    if (result.attempt !== expected.attempt) invalid("browser_use_authority_binding_mismatch:attempt");
  }
  if (result.approval.scope !== result.side_effect_scope) invalid("browser_use_authority_approval_scope_mismatch");
  return result;
}

export function loadBrowserUseAuthority(input: {
  authorityPath: string;
  expected: BrowserUseAuthorityExpectation;
  envelope: BrowserUseAuthorityEnvelopeV1;
}): { authority: BrowserUseAuthorityV1; authority_sha256: string } {
  if (!input.authorityPath.startsWith("/")) invalid("browser_use_authority_path_invalid");
  const digest = authoritySha256(input.authorityPath);
  const value = JSON.parse(readFileSync(input.authorityPath, "utf8")) as unknown;
  const authority = parseBrowserUseAuthority(value, input.expected);
  const envelope = input.envelope;
  if (envelope.schema !== BROWSER_USE_AUTHORITY_ENVELOPE_SCHEMA_V1 || envelope.issuer !== "automation_os_root") invalid("browser_use_authority_envelope_invalid");
  if (envelope.authority_sha256 !== digest || envelope.authority_id !== authority.authority_id || envelope.nonce !== authority.nonce) invalid("browser_use_authority_envelope_binding_mismatch");
  for (const field of ["run_id", "session", "stage_id"] as const) if (envelope[field] !== authority[field]) invalid(`browser_use_authority_envelope_binding_mismatch:${field}`);
  if (envelope.attempt !== authority.attempt) invalid("browser_use_authority_envelope_binding_mismatch:attempt");
  return { authority, authority_sha256: digest };
}

export function parseBrowserUseManifest(value: unknown): BrowserUseManifestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("browser_use_manifest_json_invalid");
  const body = value as Record<string, unknown>;
  const config = body.browser_use;
  if (body.schema !== BROWSER_USE_MANIFEST_SCHEMA_V1 || !config || typeof config !== "object" || Array.isArray(config)) invalid("browser_use_manifest_schema_invalid");
  const browser = config as Record<string, unknown>;
  if (browser.surface !== BROWSER_USE_SURFACE || browser.helper_path !== BROWSER_USE_HELPER_PATH || browser.runtime_config_path !== BROWSER_USE_RUNTIME_CONFIG_PATH) invalid("browser_use_manifest_runtime_binding_invalid");
  if (!new Set(["public", "authorized"]).has(String(browser.mode))) invalid("browser_use_manifest_mode_invalid");
  if (!new Set(["scheduled", "single-use"]).has(String(browser.lifecycle))) invalid("browser_use_manifest_lifecycle_invalid");
  if (browser.no_fallback !== true || typeof browser.recording_required !== "boolean") invalid("browser_use_manifest_policy_invalid");
  if (!Array.isArray(browser.allowed_origins) || browser.allowed_origins.length === 0) invalid("browser_use_manifest_origins_missing");
  const allowed_origins = [...new Set(browser.allowed_origins.map(assertOrigin))].sort();
  const mode = browser.mode as "public" | "authorized";
  const lifecycle = browser.lifecycle as "scheduled" | "single-use";
  if (mode === "public" && lifecycle !== "single-use") invalid("browser_use_manifest_public_lifecycle_invalid");
  if (mode === "authorized") {
    if (typeof browser.authority_ref !== "string") invalid("browser_use_manifest_authority_ref_required");
    if (typeof browser.authority_expiry !== "string") invalid("browser_use_manifest_authority_expiry_required");
    if (Date.parse(browser.authority_expiry) <= Date.now()) invalid("browser_use_manifest_authority_expiry_past");
  } else {
    if (browser.authority_ref !== undefined && browser.authority_ref !== null) invalid("browser_use_manifest_public_authority_ref_forbidden");
    if (browser.authority_expiry !== undefined && browser.authority_expiry !== null) invalid("browser_use_manifest_public_authority_expiry_forbidden");
  }
  return {
    schema: BROWSER_USE_MANIFEST_SCHEMA_V1,
    browser_use: {
      surface: BROWSER_USE_SURFACE,
      helper_path: BROWSER_USE_HELPER_PATH,
      runtime_config_path: BROWSER_USE_RUNTIME_CONFIG_PATH,
      mode,
      lifecycle,
      allowed_origins,
      requested_session_id: identifier(browser.requested_session_id, "browser_use_manifest_session_invalid"),
      authority_ref: browser.authority_ref === null ? null : identifier(browser.authority_ref, "browser_use_manifest_authority_ref_invalid"),
      authority_expiry: browser.authority_expiry === null ? null : instant(browser.authority_expiry, "browser_use_manifest_authority_expiry_invalid"),
      external_action_scope: identifier(browser.external_action_scope, "browser_use_manifest_external_scope_invalid"),
      recording_required: browser.recording_required,
      proof_policy: identifier(browser.proof_policy, "browser_use_manifest_proof_policy_invalid"),
      cleanup_policy: identifier(browser.cleanup_policy, "browser_use_manifest_cleanup_policy_invalid"),
      no_fallback: true
    }
  };
}

export function loadBrowserUseManifest(manifestPath: string): BrowserUseManifestV1 {
  if (!manifestPath.startsWith("/")) invalid("browser_use_manifest_path_invalid");
  assertRegularOwnedFile(manifestPath, "browser_use_manifest_file_invalid");
  return parseBrowserUseManifest(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
}

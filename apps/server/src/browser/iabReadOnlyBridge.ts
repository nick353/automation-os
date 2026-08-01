import { createHash } from "node:crypto";
import { isAbsolute, normalize, posix } from "node:path";

/**
 * The bridge is deliberately an in-memory contract verifier.  It does not
 * import an IAB client and therefore cannot open a browser, navigate a page,
 * or perform an external action.
 */

export const IAB_READONLY_CONTRACT_SCHEMA = "automation_os_iab_readonly_contract.v1" as const;
export const IAB_HANDLER_RECEIPT_SCHEMA = "automation_os_iab_handler_receipt.v1" as const;
export const IAB_RECEIPT_CONSUMPTION_SCHEMA = "automation_os_iab_receipt_consumption.v1" as const;
export const IAB_CONTRACT_VERSION = "v1" as const;

// A state-root attestation is meaningful only for the canonical Automation OS
// state root.  In particular, this is intentionally not sourced from an env
// var or a caller supplied workspace path.
export const CANONICAL_TRUSTED_STATE_ROOT = "/Users/nichikatanaka/Documents/Codex/automation-os/data" as const;
export const IAB_MAX_TTL_MS = 5 * 60 * 1000;
export const IAB_MAX_FUTURE_SKEW_MS = 30 * 1000;

export const READONLY_IAB_OPERATIONS = [
  "navigate",
  "read",
  "read_only",
  "readonly",
  "read_dom",
  "read_text",
  "read_snapshot",
  "inspect",
  "extract",
  "screenshot",
  "get"
] as const;
export type IabReadonlyOperation = (typeof READONLY_IAB_OPERATIONS)[number];
export type IabHttpMethod = "GET" | "HEAD" | "OPTIONS";
export type IabRedirectScope = "none" | "same-origin" | "allowlist";

export type IabTargetRequestInput = {
  url: string;
  http_method?: string;
  method?: string;
  operation?: string;
  op?: string;
  redirect_scope?: string | string[];
  redirectScope?: string | string[];
};

export type NormalizedIabTargetRequest = {
  url: string;
  http_method: IabHttpMethod;
  operation: IabReadonlyOperation;
  redirect_scope: IabRedirectScope | string[];
  target_request_sha256: string;
};

export type IabIdentity = {
  generation: string;
  project_id: string;
  thread_id: string;
  session_id: string;
  turn_id: string;
  nonce: string;
  stage: string;
  attempt: number;
};

export type IabTrustedProvenance = {
  mode: "trusted_state_root";
  state_root: typeof CANONICAL_TRUSTED_STATE_ROOT;
  attestation: {
    kind: "canonical_state_root";
    state_root: typeof CANONICAL_TRUSTED_STATE_ROOT;
    generation: string;
    issued_at: string;
    attestation_sha256: string;
  };
};

/** Evidence must come from a trusted integration which inspected the root.
 * These fields are intentionally not read from provenance itself. */
export type TrustedStateRootEvidence = {
  canonical_root: typeof CANONICAL_TRUSTED_STATE_ROOT;
  realpath: typeof CANONICAL_TRUSTED_STATE_ROOT;
  uid: number;
  mode: number;
  receipt_realpath: string;
  receipt_mode: number;
  receipt_is_symlink: false;
  receipt_link_count: 1;
  is_symlink: false;
  atomic_origin: true;
};

export type IabProvenanceValidationOptions = {
  /** Trusted code may provide an attestation verifier; ordinary callers must not. */
  trustedProvenanceVerifier?: (provenance: unknown, identity: IabIdentity, evidence?: TrustedStateRootEvidence) => boolean;
  /** Read-only stat/ownership evidence captured by a trusted state-root integration. */
  trustedStateRootEvidence?: TrustedStateRootEvidence;
};

export type IabProof = {
  status: "verified" | "ok";
  dom_readback: true;
  screenshot: true | { status: "present" | "verified"; path?: string; artifact_sha256?: string };
  // Optional, but when supplied it must be derived rather than self-asserted.
  proof_sha256?: string;
};

export type IabCleanup = {
  status: "verified" | "ok";
  no_residual_processes: true;
  no_external_action: true;
};

export type IabReadonlyContract = IabIdentity & {
  schema: typeof IAB_READONLY_CONTRACT_SCHEMA;
  contract_version: typeof IAB_CONTRACT_VERSION;
  contract_id: string;
  issued_at: string;
  expires_at: string;
  target: IabTargetRequestInput & { target_request_sha256: string };
  proof: { screenshot_required: true; dom_readback_required: true };
  cleanup: { required: true };
  external_action: false;
  provenance: IabTrustedProvenance;
};

export type IabHandlerReceipt = IabIdentity & {
  schema: typeof IAB_HANDLER_RECEIPT_SCHEMA;
  contract_version: typeof IAB_CONTRACT_VERSION;
  contract_id: string;
  receipt_id: string;
  issued_at: string;
  expires_at: string;
  target: IabTargetRequestInput & { target_request_sha256: string };
  proof: IabProof;
  cleanup: IabCleanup;
  external_action: false;
  provenance: IabTrustedProvenance;
  receipt_hash_sha256: string;
};

export type IabReceiptConsumptionClaim = IabIdentity & {
  schema: typeof IAB_RECEIPT_CONSUMPTION_SCHEMA;
  contract_version: typeof IAB_CONTRACT_VERSION;
  contract_id: string;
  receipt_id: string;
  receipt_hash_sha256: string;
  target_request_sha256: string;
  consumed_at?: string;
};

export type IabValidationFailure = {
  ok: false;
  status: "blocked";
  exact_blocker: string;
};

export type IabValidationSuccess<T> = {
  ok: true;
  status: "ok";
  value: T;
  target_request_sha256?: string;
};

export type IabValidationResult<T> = IabValidationSuccess<T> | IabValidationFailure;

function blocked(exact_blocker: string): IabValidationFailure {
  return { ok: false, status: "blocked", exact_blocker };
}

function ok<T>(value: T, target_request_sha256?: string): IabValidationSuccess<T> {
  return { ok: true, status: "ok", value, ...(target_request_sha256 ? { target_request_sha256 } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, name: string, options: { max?: number; path?: boolean } = {}): string | IabValidationFailure {
  if (typeof value !== "string" || value.length === 0 || value.length > (options.max ?? 256)) return blocked(`iab_${name}_invalid`);
  if (/^[\u0000-\u001f\u007f]/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return blocked(`iab_${name}_control_character`);
  if (!options.path && /[\\/]/.test(value)) return blocked(`iab_${name}_path_like`);
  return value;
}

function isoMillis(value: unknown, name: string): number | IabValidationFailure {
  if (typeof value !== "string") return blocked(`iab_${name}_invalid`);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) return blocked(`iab_${name}_invalid`);
  return time;
}

/** Deterministic JSON used for hashes and attestation preimages. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function normalizeRedirectScope(value: unknown): IabRedirectScope | string[] | IabValidationFailure {
  if (value === undefined || value === null || value === "none") return "none";
  if (value === "same-origin" || value === "same_origin") return "same-origin";
  if (Array.isArray(value)) {
    if (value.length === 0 || value.length > 20 || value.some((item) => typeof item !== "string" || !/^[a-z0-9.-]+(?::\d+)?$/i.test(item))) {
      return blocked("iab_redirect_scope_invalid");
    }
    const hosts = [...new Set(value.map((item) => item.toLowerCase()))].sort();
    if (hosts.some((host) => host === "*" || host.includes(".."))) return blocked("iab_redirect_scope_wildcard");
    return hosts;
  }
  return blocked("iab_redirect_scope_invalid");
}

export function normalizeIabTargetRequest(input: IabTargetRequestInput): IabValidationResult<NormalizedIabTargetRequest> {
  if (!isRecord(input)) return blocked("iab_target_invalid");
  const allowedKeys = new Set(["url", "http_method", "method", "operation", "op", "redirect_scope", "redirectScope", "target_request_sha256"]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) return blocked("iab_target_field_unexpected");
  if (input.http_method !== undefined && input.method !== undefined) return blocked("iab_target_method_alias_conflict");
  if (input.operation !== undefined && input.op !== undefined) return blocked("iab_target_operation_alias_conflict");
  if (input.redirect_scope !== undefined && input.redirectScope !== undefined) return blocked("iab_target_redirect_alias_conflict");
  if (typeof input.url !== "string" || input.url.length > 4096 || /[\u0000-\u0020]/.test(input.url)) return blocked("iab_target_url_invalid");
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return blocked("iab_target_url_invalid");
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.hash) return blocked("iab_target_url_unsupported");
  parsed.protocol = parsed.protocol.toLowerCase();
  parsed.hostname = parsed.hostname.toLowerCase();
  if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) parsed.port = "";
  parsed.pathname = parsed.pathname || "/";
  const query = [...parsed.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  parsed.search = query.length ? `?${query.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")}` : "";
  const method = String(input.http_method ?? input.method ?? "GET").toUpperCase();
  if (!(["GET", "HEAD", "OPTIONS"] as string[]).includes(method)) return blocked("iab_http_method_forbidden");
  const operation = String(input.operation ?? input.op ?? "read").toLowerCase();
  if (!(READONLY_IAB_OPERATIONS as readonly string[]).includes(operation)) return blocked("iab_readonly_operation_forbidden");
  const redirectScope = normalizeRedirectScope(input.redirect_scope ?? input.redirectScope);
  if (typeof redirectScope !== "string" && !Array.isArray(redirectScope)) return redirectScope;
  const target = { url: parsed.toString(), http_method: method as IabHttpMethod, operation: operation as IabReadonlyOperation, redirect_scope: redirectScope };
  return ok({ ...target, target_request_sha256: sha256Canonical(target) }, sha256Canonical(target));
}

export function computeIabTargetRequestSha256(input: IabTargetRequestInput): IabValidationResult<string> {
  const normalized = normalizeIabTargetRequest(input);
  return normalized.ok ? ok(normalized.value.target_request_sha256, normalized.value.target_request_sha256) : normalized;
}

function validateIdentity(value: Record<string, unknown>): IabValidationFailure | IabIdentity {
  const fields: Array<[keyof IabIdentity, unknown]> = [
    ["generation", value.generation], ["project_id", value.project_id], ["thread_id", value.thread_id],
    ["session_id", value.session_id], ["turn_id", value.turn_id], ["nonce", value.nonce], ["stage", value.stage]
  ];
  const result: Partial<IabIdentity> = {};
  for (const [name, field] of fields) {
    const checked = stringField(field, name, { max: name === "nonce" ? 128 : 256 });
    if (typeof checked !== "string") return checked;
    (result as Record<string, unknown>)[name] = checked;
  }
  if (!Number.isSafeInteger(value.attempt) || Number(value.attempt) < 1 || Number(value.attempt) > 100000) return blocked("iab_attempt_invalid");
  result.attempt = Number(value.attempt);
  return result as IabIdentity;
}

function validateTtl(value: Record<string, unknown>, now: number): IabValidationFailure | { issuedAt: number; expiresAt: number } {
  const issuedAt = isoMillis(value.issued_at, "issued_at");
  if (typeof issuedAt !== "number") return issuedAt;
  const expiresAt = isoMillis(value.expires_at, "expires_at");
  if (typeof expiresAt !== "number") return expiresAt;
  if (issuedAt > now + IAB_MAX_FUTURE_SKEW_MS) return blocked("iab_issued_at_future");
  if (expiresAt <= issuedAt) return blocked("iab_ttl_invalid");
  if (expiresAt - issuedAt > IAB_MAX_TTL_MS) return blocked("iab_ttl_exceeds_max");
  if (now >= expiresAt) return blocked("iab_receipt_stale");
  return { issuedAt, expiresAt };
}

function attestationPreimage(provenance: Record<string, unknown>): Record<string, unknown> {
  const attestation = provenance.attestation as Record<string, unknown>;
  return { kind: attestation.kind, state_root: attestation.state_root, generation: attestation.generation, issued_at: attestation.issued_at };
}

/** Test/fixture constructor only. Production callers must supply independent
 * trustedStateRootEvidence or trustedProvenanceVerifier to a validator. */
export function createTrustedStateRootProvenance(input: { generation: string; issued_at: string }): IabTrustedProvenance {
  const attestation = { kind: "canonical_state_root" as const, state_root: CANONICAL_TRUSTED_STATE_ROOT, generation: input.generation, issued_at: input.issued_at };
  return { mode: "trusted_state_root", state_root: CANONICAL_TRUSTED_STATE_ROOT, attestation: { ...attestation, attestation_sha256: sha256Canonical(attestation) } };
}

function validateTrustedStateRootEvidence(evidence: TrustedStateRootEvidence | undefined): boolean {
  if (!evidence || evidence.canonical_root !== CANONICAL_TRUSTED_STATE_ROOT || evidence.realpath !== CANONICAL_TRUSTED_STATE_ROOT) return false;
  if (evidence.is_symlink !== false || evidence.atomic_origin !== true || evidence.receipt_is_symlink !== false || evidence.receipt_link_count !== 1 || !Number.isInteger(evidence.uid) || evidence.uid < 0 || evidence.mode !== 0o700 || evidence.receipt_mode !== 0o600) return false;
  if (typeof evidence.receipt_realpath !== "string" || !evidence.receipt_realpath.startsWith(`${CANONICAL_TRUSTED_STATE_ROOT}/`) || evidence.receipt_realpath.includes("..") || normalize(evidence.receipt_realpath) !== evidence.receipt_realpath) return false;
  // State must be owned by the current user (when Node exposes a uid) and not
  // be group/other writable.  The root's read bit is also required.
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (currentUid !== null && evidence.uid !== currentUid) return false;
  return true;
}

function validateProvenance(value: unknown, identity: IabIdentity, options: IabProvenanceValidationOptions, now: number): IabValidationFailure | IabTrustedProvenance {
  if (!options.trustedProvenanceVerifier && !options.trustedStateRootEvidence) return blocked("iab_provenance_verifier_required");
  if (!isRecord(value) || value.mode !== "trusted_state_root" || value.state_root !== CANONICAL_TRUSTED_STATE_ROOT) return blocked("iab_provenance_untrusted");
  if (!isRecord(value.attestation) || value.attestation.kind !== "canonical_state_root" || value.attestation.state_root !== CANONICAL_TRUSTED_STATE_ROOT || value.attestation.generation !== identity.generation) return blocked("iab_provenance_attestation_invalid");
  const issuedAt = isoMillis(value.attestation.issued_at, "provenance_issued_at");
  if (typeof issuedAt !== "number") return issuedAt;
  if (issuedAt > now + IAB_MAX_FUTURE_SKEW_MS) return blocked("iab_provenance_issued_at_future");
  const hash = value.attestation.attestation_sha256;
  if (typeof hash !== "string" || hash !== sha256Canonical(attestationPreimage(value))) return blocked("iab_provenance_attestation_hash_mismatch");
  if (options.trustedStateRootEvidence && !validateTrustedStateRootEvidence(options.trustedStateRootEvidence)) return blocked("iab_provenance_evidence_invalid");
  if (options.trustedProvenanceVerifier && options.trustedProvenanceVerifier(value, identity, options.trustedStateRootEvidence) !== true) return blocked("iab_provenance_verifier_rejected");
  return value as unknown as IabTrustedProvenance;
}

function targetFromRecord(value: unknown): IabValidationResult<NormalizedIabTargetRequest> {
  if (!isRecord(value)) return blocked("iab_target_invalid");
  const normalized = normalizeIabTargetRequest(value as IabTargetRequestInput);
  if (!normalized.ok) return normalized;
  if (value.target_request_sha256 !== normalized.value.target_request_sha256) return blocked("iab_target_hash_mismatch");
  return normalized;
}

function validateContractShape(value: unknown, now: number, options: IabProvenanceValidationOptions): IabValidationResult<IabReadonlyContract> {
  if (!isRecord(value) || value.schema !== IAB_READONLY_CONTRACT_SCHEMA || value.contract_version !== IAB_CONTRACT_VERSION) return blocked("iab_contract_schema_invalid");
  const identity = validateIdentity(value);
  if ("ok" in identity) return identity;
  const ttl = validateTtl(value, now);
  if ("ok" in ttl) return ttl;
  if (typeof value.contract_id !== "string" || !value.contract_id || /[\\/]/.test(value.contract_id)) return blocked("iab_contract_id_invalid");
  if (value.external_action !== false) return blocked("iab_external_action_forbidden");
  if (!isRecord(value.proof) || value.proof.screenshot_required !== true || value.proof.dom_readback_required !== true) return blocked("iab_contract_proof_required");
  if (!isRecord(value.cleanup) || value.cleanup.required !== true) return blocked("iab_contract_cleanup_required");
  const target = targetFromRecord(value.target);
  if (!target.ok) return target;
  const provenance = validateProvenance(value.provenance, identity, options, now);
  if ("ok" in provenance) return provenance;
  return ok({ ...(value as unknown as IabReadonlyContract), ...identity, target: target.value, provenance });
}

export function validateIabReadonlyContract(value: unknown, options: { now?: Date } & IabProvenanceValidationOptions = {}): IabValidationResult<IabReadonlyContract> {
  return validateContractShape(value, (options.now ?? new Date()).getTime(), options);
}

function proofArtifactPathValid(value: unknown): boolean {
  if (typeof value !== "string" || isAbsolute(value) || value.includes("\\") || value.includes("..")) return false;
  const cleaned = normalize(value);
  return cleaned === value && cleaned !== "." && !cleaned.startsWith("/") && posix.normalize(cleaned) === cleaned;
}

function validateProof(value: unknown): IabValidationFailure | IabProof {
  if (!isRecord(value) || (value.status !== "verified" && value.status !== "ok") || value.dom_readback !== true) return blocked("iab_proof_invalid");
  if (value.screenshot !== true && !isRecord(value.screenshot)) return blocked("iab_screenshot_missing");
  if (isRecord(value.screenshot)) {
    if (value.screenshot.status !== "present" && value.screenshot.status !== "verified") return blocked("iab_screenshot_invalid");
    if (value.screenshot.path !== undefined && !proofArtifactPathValid(value.screenshot.path)) return blocked("iab_proof_path_invalid");
    if (value.screenshot.artifact_sha256 !== undefined && (typeof value.screenshot.artifact_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.screenshot.artifact_sha256))) return blocked("iab_screenshot_hash_invalid");
  }
  if (value.proof_sha256 !== undefined && (typeof value.proof_sha256 !== "string" || value.proof_sha256 !== sha256Canonical({ status: value.status, dom_readback: value.dom_readback, screenshot: value.screenshot }))) return blocked("iab_proof_hash_mismatch");
  return value as unknown as IabProof;
}

function validateCleanup(value: unknown): IabValidationFailure | IabCleanup {
  if (!isRecord(value) || (value.status !== "verified" && value.status !== "ok") || value.no_residual_processes !== true || value.no_external_action !== true) return blocked("iab_cleanup_invalid");
  return value as unknown as IabCleanup;
}

function receiptHashPreimage(value: Record<string, unknown>): Record<string, unknown> {
  const { receipt_hash_sha256: _ignored, ...rest } = value;
  return rest;
}

export function computeIabReceiptHash(receipt: Omit<IabHandlerReceipt, "receipt_hash_sha256"> | IabHandlerReceipt): string {
  return sha256Canonical(receiptHashPreimage(receipt as unknown as Record<string, unknown>));
}

export function validateIabHandlerReceipt(value: unknown, options: { now?: Date } & IabProvenanceValidationOptions = {}): IabValidationResult<IabHandlerReceipt> {
  if (!isRecord(value) || value.schema !== IAB_HANDLER_RECEIPT_SCHEMA || value.contract_version !== IAB_CONTRACT_VERSION) return blocked("iab_receipt_schema_invalid");
  const identity = validateIdentity(value);
  if ("ok" in identity) return identity;
  const ttl = validateTtl(value, (options.now ?? new Date()).getTime());
  if ("ok" in ttl) return ttl;
  if (typeof value.contract_id !== "string" || !value.contract_id || typeof value.receipt_id !== "string" || !value.receipt_id) return blocked("iab_receipt_identity_invalid");
  if (value.external_action !== false) return blocked("iab_external_action_forbidden");
  const target = targetFromRecord(value.target);
  if (!target.ok) return target;
  const provenance = validateProvenance(value.provenance, identity, options, (options.now ?? new Date()).getTime());
  if ("ok" in provenance) return provenance;
  const proof = validateProof(value.proof);
  if ("ok" in proof) return proof;
  const cleanup = validateCleanup(value.cleanup);
  if ("ok" in cleanup) return cleanup;
  if (typeof value.receipt_hash_sha256 !== "string" || value.receipt_hash_sha256 !== computeIabReceiptHash(value as unknown as IabHandlerReceipt)) return blocked("iab_receipt_hash_mismatch");
  return ok({ ...(value as unknown as IabHandlerReceipt), ...identity, target: target.value, provenance, proof, cleanup });
}

function sameIdentity(a: IabIdentity, b: IabIdentity): boolean {
  return a.generation === b.generation && a.project_id === b.project_id && a.thread_id === b.thread_id && a.session_id === b.session_id && a.turn_id === b.turn_id && a.nonce === b.nonce && a.stage === b.stage && a.attempt === b.attempt;
}

export class IabReceiptConsumptionStore {
  private readonly consumed = new Set<string>();

  has(receiptHash: string): boolean {
    return this.consumed.has(receiptHash);
  }

  mark(receiptHash: string): void {
    this.consumed.add(receiptHash);
  }

  tryConsume(receiptHash: string): boolean {
    if (this.consumed.has(receiptHash)) return false;
    this.consumed.add(receiptHash);
    return true;
  }
}

export type IabConsumptionResult = IabValidationResult<IabReceiptConsumptionClaim & { consumed_at: string }>;

export function validateIabReceiptConsumptionClaim(value: unknown): IabValidationResult<IabReceiptConsumptionClaim> {
  if (!isRecord(value) || value.schema !== IAB_RECEIPT_CONSUMPTION_SCHEMA || value.contract_version !== IAB_CONTRACT_VERSION) return blocked("iab_consumption_schema_invalid");
  const identity = validateIdentity(value);
  if ("ok" in identity) return identity;
  if (typeof value.contract_id !== "string" || !value.contract_id || typeof value.receipt_id !== "string" || !value.receipt_id) return blocked("iab_consumption_identity_invalid");
  if (typeof value.receipt_hash_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.receipt_hash_sha256) || typeof value.target_request_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.target_request_sha256)) return blocked("iab_consumption_hash_invalid");
  if (value.consumed_at !== undefined) return blocked("iab_consumption_self_claimed");
  return ok({ ...(value as unknown as IabReceiptConsumptionClaim), ...identity });
}

export function consumeIabReadonlyReceipt(input: {
  contract: unknown;
  receipt: unknown;
  claim: unknown;
  store: IabReceiptConsumptionStore;
  now?: Date;
  trustedProvenanceVerifier?: IabProvenanceValidationOptions["trustedProvenanceVerifier"];
  trustedStateRootEvidence?: TrustedStateRootEvidence;
}): IabConsumptionResult {
  const now = input.now ?? new Date();
  const provenanceOptions = { trustedProvenanceVerifier: input.trustedProvenanceVerifier, trustedStateRootEvidence: input.trustedStateRootEvidence };
  const contract = validateIabReadonlyContract(input.contract, { now, ...provenanceOptions });
  if (!contract.ok) return contract;
  const receipt = validateIabHandlerReceipt(input.receipt, { now, ...provenanceOptions });
  if (!receipt.ok) return receipt;
  if (!sameIdentity(contract.value, receipt.value) || contract.value.contract_id !== receipt.value.contract_id || contract.value.target.target_request_sha256 !== receipt.value.target.target_request_sha256) return blocked("iab_receipt_contract_binding_mismatch");
  const claimResult = validateIabReceiptConsumptionClaim(input.claim);
  if (!claimResult.ok) return claimResult;
  const claim = claimResult.value;
  const claimIdentity = claim;
  if (!sameIdentity(receipt.value, claimIdentity) || claim.contract_id !== contract.value.contract_id || claim.receipt_id !== receipt.value.receipt_id || claim.receipt_hash_sha256 !== receipt.value.receipt_hash_sha256 || claim.target_request_sha256 !== receipt.value.target.target_request_sha256) return blocked("iab_consumption_binding_mismatch");
  if (claim.consumed_at !== undefined) return blocked("iab_consumption_self_claimed");
  if (!(input.store instanceof IabReceiptConsumptionStore)) return blocked("iab_consumption_store_required");
  if (!input.store.tryConsume(receipt.value.receipt_hash_sha256)) return blocked("iab_receipt_already_consumed");
  const consumedAt = now.toISOString();
  return ok({ ...claim, consumed_at: consumedAt });
}

// Friendly aliases used by callers that prefer the schema's terminology.
export const validateReadonlyContract = validateIabReadonlyContract;
export const validateHandlerReceipt = validateIabHandlerReceipt;
export const consumeHandlerReceipt = consumeIabReadonlyReceipt;
export const normalizeTargetRequest = normalizeIabTargetRequest;
export const computeTargetRequestSha256 = computeIabTargetRequestSha256;
export const validateReceiptConsumptionClaim = validateIabReceiptConsumptionClaim;

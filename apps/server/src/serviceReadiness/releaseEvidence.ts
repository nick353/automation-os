/**
 * Strict, read-only release-evidence envelope for Company SaaS.
 *
 * This contract is intentionally separate from the release activation path.
 * It can validate evidence that an owner or verifier has already produced,
 * but it never creates a signature, candidate, backup, provider receipt, or
 * authorization.  A blocked packet is the truthful result when evidence is
 * absent or cannot be bound to a fresh readback.
 */

import { createHash } from "node:crypto";

export const COMPANY_RELEASE_EVIDENCE_SCHEMA_V1 = "company_release_evidence.v1" as const;

export const COMPANY_RELEASE_EVIDENCE_REQUIRED_FIELDS_V1 = [
  "named_g0_approvers_and_decisions",
  "mixed_file_hunk_allowlist_owner",
  "clean_candidate_sha_and_signed_manifest",
  "backup_restore_rollback_owner",
  "per_workflow_account_target_payload_receipt_contract",
  "incident_recovery_drill"
] as const;

export type CompanyReleaseEvidenceFieldV1 = (typeof COMPANY_RELEASE_EVIDENCE_REQUIRED_FIELDS_V1)[number];

type CompanyReleaseEvidenceBlockedV1 = {
  status: "blocked";
  exact_blocker: string;
  blocker_owner: string | null;
  safe_resume_step: string;
};

type CompanyReleaseEvidenceEnvelopeV1<T> = {
  status: "verified";
  value: T;
  evidence_uri: string;
  evidence_sha256: string;
  canonical_value_sha256: string;
  verified_at: string;
  verifier: string;
};

export type CompanyReleaseG0EvidenceV1 = {
  decisions: Array<{
    decision_id: string;
    name: string;
    role: string;
    decision: "approved";
    decided_at: string;
  }>;
  decision_pack_sha256: string;
};

export type CompanyReleaseHunkAllowlistEvidenceV1 = {
  owner: string;
  allowlist_sha256: string;
  approved_at: string;
};

export type CompanyReleaseCandidateManifestEvidenceV1 = {
  candidate_sha: string;
  manifest_sha256: string;
  sbom_sha256: string;
  signature: string;
  signature_algorithm: string;
  source_commit: string;
  clean_checkout: true;
  signature_verified: true;
  manifest_matches_candidate: true;
};

export type CompanyReleaseBackupRestoreRollbackEvidenceV1 = {
  owner: string;
  backup_id: string;
  backup_manifest_sha256: string;
  restore_drill_id: string;
  restore_readback_sha256: string;
  rollback_anchor: string;
  rollback_readback_sha256: string;
  restore_executed: true;
  rollback_readback_verified: true;
};

export type CompanyReleaseWorkflowReceiptContractV1 = {
  workflow_id: "daily-ai" | "job-application-manager" | "nisenprints";
  account_ref: string;
  target_ref: string;
  payload_hash: string;
  provider: string;
  provider_receipt_contract: string;
  idempotency_key: string;
  unknown_outcome_owner: string;
  cleanup_receipt_schema: string;
  rollback_contract: string;
};

export type CompanyReleaseWorkflowReceiptEvidenceV1 = {
  workflows: [
    CompanyReleaseWorkflowReceiptContractV1,
    CompanyReleaseWorkflowReceiptContractV1,
    CompanyReleaseWorkflowReceiptContractV1
  ];
};

export type CompanyReleaseIncidentRecoveryEvidenceV1 = {
  owner: string;
  drill_id: string;
  scenario: string;
  recovery_readback_sha256: string;
  cleanup_readback_sha256: string;
  rollback_anchor: string;
  passed: true;
};

export type CompanyReleaseEvidenceV1 = {
  schema: typeof COMPANY_RELEASE_EVIDENCE_SCHEMA_V1;
  status: "ready" | "blocked";
  external_action_executed: false;
  named_g0_approvers_and_decisions: CompanyReleaseEvidenceBlockedV1 | CompanyReleaseEvidenceEnvelopeV1<CompanyReleaseG0EvidenceV1>;
  mixed_file_hunk_allowlist_owner: CompanyReleaseEvidenceBlockedV1 | CompanyReleaseEvidenceEnvelopeV1<CompanyReleaseHunkAllowlistEvidenceV1>;
  clean_candidate_sha_and_signed_manifest: CompanyReleaseEvidenceBlockedV1 | CompanyReleaseEvidenceEnvelopeV1<CompanyReleaseCandidateManifestEvidenceV1>;
  backup_restore_rollback_owner: CompanyReleaseEvidenceBlockedV1 | CompanyReleaseEvidenceEnvelopeV1<CompanyReleaseBackupRestoreRollbackEvidenceV1>;
  per_workflow_account_target_payload_receipt_contract: CompanyReleaseEvidenceBlockedV1 | CompanyReleaseEvidenceEnvelopeV1<CompanyReleaseWorkflowReceiptEvidenceV1>;
  incident_recovery_drill: CompanyReleaseEvidenceBlockedV1 | CompanyReleaseEvidenceEnvelopeV1<CompanyReleaseIncidentRecoveryEvidenceV1>;
  exact_blocker: string | null;
  blocker_owner: string | null;
  safe_resume_step: string | null;
};

export type CompanyReleaseEvidenceValidationResultV1 =
  | { ok: true; status: "ok"; value: CompanyReleaseEvidenceV1 }
  | { ok: false; status: "blocked"; exact_blocker: string; blocker_owner: string | null; safe_resume_step: string | null };

export type CompanyReleaseEvidenceValidationOptionsV1 = {
  /** A trusted verifier identity is required before any field can be ready. */
  trusted_verifier_ids: readonly string[];
  /** The caller's fresh readback of evidence URI -> content hash. */
  evidence_readback: Readonly<Record<string, string>>;
  /** Current time and freshness bound for the verifier receipt. */
  now_ms?: number;
  max_age_ms?: number;
  /** Optional release-line bindings supplied by the trusted verifier. */
  expected_candidate_sha?: string;
  expected_source_commit?: string;
};

class CompanyReleaseEvidenceError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "CompanyReleaseEvidenceError";
  }
}

const hashPattern = /^[a-f0-9]{64}$/;
const commitHashPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const placeholderValues = new Set([
  "",
  "tbd",
  "todo",
  "unknown",
  "unset",
  "null",
  "none",
  "placeholder",
  "pending",
  "missing",
  "n/a",
  "na",
  "unassigned",
  "not_provided",
  "not provided"
]);
const placeholderPrefixPattern = /^(?:tbd|todo|unknown|unset|null|none|placeholder|pending|missing|n\/?a|na|unassigned|not[ _-]?provided)(?:\b|\s*[:_-])/iu;
const workflowIds = new Set<CompanyReleaseWorkflowReceiptContractV1["workflow_id"]>([
  "daily-ai",
  "job-application-manager",
  "nisenprints"
]);

const topLevelFields = new Set<string>([
  "schema",
  "status",
  "external_action_executed",
  ...COMPANY_RELEASE_EVIDENCE_REQUIRED_FIELDS_V1,
  "exact_blocker",
  "blocker_owner",
  "safe_resume_step"
]);
const blockedFields = new Set(["status", "exact_blocker", "blocker_owner", "safe_resume_step"]);
const envelopeFields = new Set(["status", "value", "evidence_uri", "evidence_sha256", "canonical_value_sha256", "verified_at", "verifier"]);
const supportedSignatureAlgorithms = new Set(["ed25519", "sigstore", "cosign"]);
const signaturePrefixes: Record<string, string> = {
  ed25519: "ed25519:",
  sigstore: "sigstore:",
  cosign: "cosign:"
};
const canonicalCleanupReceiptSchema = "service_readiness_cleanup_receipt.v1";
const workflowProviderReceiptContracts: Record<
  CompanyReleaseWorkflowReceiptContractV1["workflow_id"],
  Readonly<Record<string, string>>
> = {
  "daily-ai": {
    x: "daily-ai-x-receipt.v1",
    linkedin: "read-only-post-receipt.v1"
  },
  "job-application-manager": {
    gmail: "gmail-capture-receipt.v1",
    linkedin: "job-manager-linkedin-receipt.v1"
  },
  nisenprints: {
    canva: "nisenprints-canva-receipt.v1",
    etsy: "nisenprints-etsy-receipt.v1",
    pinterest: "nisenprints-pinterest-receipt.v1",
    printify: "listing-receipt.v1"
  }
};
const workflowProviders: Record<CompanyReleaseWorkflowReceiptContractV1["workflow_id"], ReadonlySet<string>> = {
  "daily-ai": new Set(Object.keys(workflowProviderReceiptContracts["daily-ai"])),
  "job-application-manager": new Set(Object.keys(workflowProviderReceiptContracts["job-application-manager"])),
  nisenprints: new Set(Object.keys(workflowProviderReceiptContracts.nisenprints))
};

function record(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CompanyReleaseEvidenceError(code);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: Set<string>, code: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new CompanyReleaseEvidenceError(`${code}:${key}`);
  }
}

function requireFields(value: Record<string, unknown>, fields: readonly string[], code: string): void {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw new CompanyReleaseEvidenceError(`${code}:${field}`);
    }
  }
}

function text(value: unknown, code: string, max = 512): string {
  if (typeof value !== "string") throw new CompanyReleaseEvidenceError(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || placeholderValues.has(normalized.toLowerCase()) || placeholderPrefixPattern.test(normalized)) {
    throw new CompanyReleaseEvidenceError(code);
  }
  if (/^[\u0000-\u001f\u007f]/.test(normalized) || /[\u0000-\u001f\u007f]$/.test(normalized)) {
    throw new CompanyReleaseEvidenceError(code);
  }
  return normalized;
}

function identifier(value: unknown, code: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value) || placeholderValues.has(value.trim().toLowerCase()) || placeholderPrefixPattern.test(value.trim())) {
    throw new CompanyReleaseEvidenceError(code);
  }
  return value;
}

function hash(value: unknown, code: string): string {
  if (typeof value !== "string" || !hashPattern.test(value)) throw new CompanyReleaseEvidenceError(code);
  return value;
}

function commitHash(value: unknown, code: string): string {
  if (typeof value !== "string" || !commitHashPattern.test(value)) throw new CompanyReleaseEvidenceError(code);
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const body = value as Record<string, unknown>;
    return `{${Object.keys(body).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(body[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeCompanyReleaseEvidenceValueSha256V1(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function timestamp(value: unknown, code: string): string {
  const normalized = text(value, code, 128);
  if (!Number.isFinite(Date.parse(normalized))) throw new CompanyReleaseEvidenceError(code);
  return normalized;
}

function isCandidateValue(value: unknown): value is CompanyReleaseCandidateManifestEvidenceV1 {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && "candidate_sha" in value && "source_commit" in value);
}

function assertValueFreshness(value: unknown, nowMs: number, upperBoundMs = nowMs): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const body = value as Record<string, unknown>;
  const timestamps: unknown[] = [body.approved_at];
  if (Array.isArray(body.decisions)) {
    for (const decision of body.decisions) {
      if (decision && typeof decision === "object" && !Array.isArray(decision)) timestamps.push((decision as Record<string, unknown>).decided_at);
    }
  }
  for (const raw of timestamps) {
    if (raw === undefined) continue;
    if (typeof raw !== "string" || !Number.isFinite(Date.parse(raw))) {
      throw new CompanyReleaseEvidenceError("company_release_evidence_value_timestamp_invalid");
    }
    if (Date.parse(raw) > nowMs + 5 * 60 * 1000) {
      throw new CompanyReleaseEvidenceError("company_release_evidence_value_timestamp_future");
    }
    if (Date.parse(raw) > upperBoundMs + 5 * 60 * 1000) {
      throw new CompanyReleaseEvidenceError("company_release_evidence_value_timestamp_after_verification");
    }
  }
}

function isBackupValue(value: unknown): value is CompanyReleaseBackupRestoreRollbackEvidenceV1 {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && "rollback_anchor" in value && "restore_drill_id" in value);
}

function isIncidentValue(value: unknown): value is CompanyReleaseIncidentRecoveryEvidenceV1 {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && "rollback_anchor" in value && "drill_id" in value && "recovery_readback_sha256" in value);
}

function parseBlocked(value: Record<string, unknown>): CompanyReleaseEvidenceBlockedV1 {
  requireFields(value, ["status", "exact_blocker", "blocker_owner", "safe_resume_step"], "company_release_evidence_field_missing");
  rejectUnknown(value, blockedFields, "company_release_evidence_unknown_field");
  if (value.status !== "blocked") throw new CompanyReleaseEvidenceError("company_release_evidence_status_invalid");
  const blocker = text(value.exact_blocker, "company_release_evidence_exact_blocker_invalid");
  const owner = value.blocker_owner === null ? null : text(value.blocker_owner, "company_release_evidence_blocker_owner_invalid", 256);
  const resume = text(value.safe_resume_step, "company_release_evidence_safe_resume_step_invalid");
  return { status: "blocked", exact_blocker: blocker, blocker_owner: owner, safe_resume_step: resume };
}

function parseEnvelope<T>(
  value: Record<string, unknown>,
  parser: (value: unknown) => T,
  options: CompanyReleaseEvidenceValidationOptionsV1
): CompanyReleaseEvidenceEnvelopeV1<T> {
  requireFields(value, ["status", "value", "evidence_uri", "evidence_sha256", "canonical_value_sha256", "verified_at", "verifier"], "company_release_evidence_field_missing");
  rejectUnknown(value, envelopeFields, "company_release_evidence_unknown_field");
  if (value.status !== "verified") throw new CompanyReleaseEvidenceError("company_release_evidence_status_invalid");
  const evidenceUri = text(value.evidence_uri, "company_release_evidence_uri_invalid", 2048);
  if (!/^(?:file|https?):\/\//u.test(evidenceUri)) {
    throw new CompanyReleaseEvidenceError("company_release_evidence_uri_scheme_invalid");
  }
  if (!options.trusted_verifier_ids.includes(String(value.verifier))) {
    throw new CompanyReleaseEvidenceError("company_release_evidence_trusted_verifier_required");
  }
  const readbackHash = options.evidence_readback[evidenceUri];
  if (readbackHash === undefined) {
    throw new CompanyReleaseEvidenceError("company_release_evidence_readback_required");
  }
  const evidenceSha = hash(value.evidence_sha256, "company_release_evidence_sha_invalid");
  const canonicalValueSha = hash(value.canonical_value_sha256, "company_release_evidence_canonical_value_sha_invalid");
  if (readbackHash !== evidenceSha) {
    throw new CompanyReleaseEvidenceError("company_release_evidence_readback_hash_mismatch");
  }
  const nowMs = options.now_ms ?? Date.now();
  const maxAgeMs = options.max_age_ms ?? 24 * 60 * 60 * 1000;
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 30 * 24 * 60 * 60 * 1000) {
    throw new CompanyReleaseEvidenceError("company_release_evidence_validation_clock_invalid");
  }
  const verifiedAt = timestamp(value.verified_at, "company_release_evidence_verified_at_invalid");
  const verifiedAtMs = Date.parse(verifiedAt);
  if (verifiedAtMs > nowMs + 5 * 60 * 1000) throw new CompanyReleaseEvidenceError("company_release_evidence_verified_at_future");
  if (nowMs - verifiedAtMs > maxAgeMs) throw new CompanyReleaseEvidenceError("company_release_evidence_stale");
  const parsedValue = parser(value.value);
  if (computeCompanyReleaseEvidenceValueSha256V1(parsedValue) !== canonicalValueSha || canonicalValueSha !== evidenceSha) {
    throw new CompanyReleaseEvidenceError("company_release_evidence_value_hash_mismatch");
  }
  assertValueFreshness(parsedValue, nowMs, verifiedAtMs);
  if (options.expected_candidate_sha && isCandidateValue(parsedValue) && parsedValue.candidate_sha !== options.expected_candidate_sha) {
    throw new CompanyReleaseEvidenceError("company_release_evidence_candidate_binding_mismatch");
  }
  if (options.expected_source_commit && isCandidateValue(parsedValue) && parsedValue.source_commit !== options.expected_source_commit) {
    throw new CompanyReleaseEvidenceError("company_release_evidence_source_commit_binding_mismatch");
  }
  if ((isBackupValue(parsedValue) || isIncidentValue(parsedValue)) && options.expected_candidate_sha) {
    const expectedAnchor = `candidate_sha:${options.expected_candidate_sha}`;
    if (parsedValue.rollback_anchor !== expectedAnchor) {
      throw new CompanyReleaseEvidenceError("company_release_evidence_rollback_anchor_binding_mismatch");
    }
  }
  return {
    status: "verified",
    value: parsedValue,
    evidence_uri: evidenceUri,
    evidence_sha256: evidenceSha,
    canonical_value_sha256: canonicalValueSha,
    verified_at: verifiedAt,
    verifier: text(value.verifier, "company_release_evidence_verifier_invalid", 256)
  };
}

function parseField(
  value: unknown,
  parser: (value: unknown) => unknown,
  options: CompanyReleaseEvidenceValidationOptionsV1
): CompanyReleaseEvidenceV1[CompanyReleaseEvidenceFieldV1] {
  const body = record(value, "company_release_evidence_required_field");
  if (body.status === "blocked") return parseBlocked(body);
  return parseEnvelope(body, parser, options) as CompanyReleaseEvidenceV1[CompanyReleaseEvidenceFieldV1];
}

function parseG0(value: unknown): CompanyReleaseG0EvidenceV1 {
  const body = record(value, "company_release_g0_value_invalid");
  requireFields(body, ["decisions", "decision_pack_sha256"], "company_release_g0_field_missing");
  rejectUnknown(body, new Set(["decisions", "decision_pack_sha256"]), "company_release_g0_unknown_field");
  if (!Array.isArray(body.decisions) || body.decisions.length === 0) throw new CompanyReleaseEvidenceError("company_release_g0_decisions_required");
  const decisions = body.decisions.map((raw) => {
    const entry = record(raw, "company_release_g0_decision_invalid");
    requireFields(entry, ["decision_id", "name", "role", "decision", "decided_at"], "company_release_g0_decision_field_missing");
    rejectUnknown(entry, new Set(["decision_id", "name", "role", "decision", "decided_at"]), "company_release_g0_decision_unknown_field");
    if (entry.decision !== "approved") throw new CompanyReleaseEvidenceError("company_release_g0_decision_not_approved");
    return {
      decision_id: identifier(entry.decision_id, "company_release_g0_decision_id_invalid"),
      name: text(entry.name, "company_release_g0_name_invalid", 256),
      role: text(entry.role, "company_release_g0_role_invalid", 256),
      decision: "approved" as const,
      decided_at: timestamp(entry.decided_at, "company_release_g0_decided_at_invalid")
    };
  });
  return { decisions, decision_pack_sha256: hash(body.decision_pack_sha256, "company_release_g0_decision_pack_sha_invalid") };
}

function parseHunkAllowlist(value: unknown): CompanyReleaseHunkAllowlistEvidenceV1 {
  const body = record(value, "company_release_hunk_allowlist_value_invalid");
  requireFields(body, ["owner", "allowlist_sha256", "approved_at"], "company_release_hunk_allowlist_field_missing");
  rejectUnknown(body, new Set(["owner", "allowlist_sha256", "approved_at"]), "company_release_hunk_allowlist_unknown_field");
  return {
    owner: text(body.owner, "company_release_hunk_allowlist_owner_invalid", 256),
    allowlist_sha256: hash(body.allowlist_sha256, "company_release_hunk_allowlist_sha_invalid"),
    approved_at: timestamp(body.approved_at, "company_release_hunk_allowlist_approved_at_invalid")
  };
}

function parseCandidate(value: unknown): CompanyReleaseCandidateManifestEvidenceV1 {
  const body = record(value, "company_release_candidate_value_invalid");
  requireFields(body, ["candidate_sha", "manifest_sha256", "sbom_sha256", "signature", "signature_algorithm", "source_commit", "clean_checkout", "signature_verified", "manifest_matches_candidate"], "company_release_candidate_field_missing");
  rejectUnknown(body, new Set(["candidate_sha", "manifest_sha256", "sbom_sha256", "signature", "signature_algorithm", "source_commit", "clean_checkout", "signature_verified", "manifest_matches_candidate"]), "company_release_candidate_unknown_field");
  if (body.clean_checkout !== true) throw new CompanyReleaseEvidenceError("company_release_candidate_not_clean");
  if (body.signature_verified !== true) throw new CompanyReleaseEvidenceError("company_release_candidate_signature_unverified");
  if (body.manifest_matches_candidate !== true) throw new CompanyReleaseEvidenceError("company_release_candidate_manifest_mismatch");
  if (typeof body.signature_algorithm !== "string" || !supportedSignatureAlgorithms.has(body.signature_algorithm)) {
    throw new CompanyReleaseEvidenceError("company_release_candidate_signature_algorithm_invalid");
  }
  const signaturePrefix = signaturePrefixes[body.signature_algorithm];
  if (
    typeof body.signature !== "string" ||
    !signaturePrefix ||
    !body.signature.startsWith(signaturePrefix) ||
    !/^[A-Za-z0-9+/=._:-]{16,}$/u.test(body.signature.slice(signaturePrefix.length))
  ) {
    throw new CompanyReleaseEvidenceError("company_release_candidate_signature_invalid");
  }
  return {
    candidate_sha: hash(body.candidate_sha, "company_release_candidate_sha_invalid"),
    manifest_sha256: hash(body.manifest_sha256, "company_release_candidate_manifest_sha_invalid"),
    sbom_sha256: hash(body.sbom_sha256, "company_release_candidate_sbom_sha_invalid"),
    signature: body.signature,
    signature_algorithm: body.signature_algorithm,
    source_commit: commitHash(body.source_commit, "company_release_candidate_source_commit_invalid"),
    clean_checkout: true,
    signature_verified: true,
    manifest_matches_candidate: true
  };
}

function parseBackup(value: unknown): CompanyReleaseBackupRestoreRollbackEvidenceV1 {
  const body = record(value, "company_release_backup_value_invalid");
  requireFields(body, ["owner", "backup_id", "backup_manifest_sha256", "restore_drill_id", "restore_readback_sha256", "rollback_anchor", "rollback_readback_sha256", "restore_executed", "rollback_readback_verified"], "company_release_backup_field_missing");
  rejectUnknown(body, new Set(["owner", "backup_id", "backup_manifest_sha256", "restore_drill_id", "restore_readback_sha256", "rollback_anchor", "rollback_readback_sha256", "restore_executed", "rollback_readback_verified"]), "company_release_backup_unknown_field");
  if (body.restore_executed !== true) throw new CompanyReleaseEvidenceError("company_release_restore_not_executed");
  if (body.rollback_readback_verified !== true) throw new CompanyReleaseEvidenceError("company_release_rollback_readback_unverified");
  return {
    owner: text(body.owner, "company_release_backup_owner_invalid", 256),
    backup_id: identifier(body.backup_id, "company_release_backup_id_invalid"),
    backup_manifest_sha256: hash(body.backup_manifest_sha256, "company_release_backup_manifest_sha_invalid"),
    restore_drill_id: identifier(body.restore_drill_id, "company_release_restore_drill_id_invalid"),
    restore_readback_sha256: hash(body.restore_readback_sha256, "company_release_restore_readback_sha_invalid"),
    rollback_anchor: text(body.rollback_anchor, "company_release_rollback_anchor_invalid", 512),
    rollback_readback_sha256: hash(body.rollback_readback_sha256, "company_release_rollback_readback_sha_invalid"),
    restore_executed: true,
    rollback_readback_verified: true
  };
}

function parseWorkflowContracts(value: unknown): CompanyReleaseWorkflowReceiptEvidenceV1 {
  const body = record(value, "company_release_workflow_receipt_value_invalid");
  requireFields(body, ["workflows"], "company_release_workflow_receipt_field_missing");
  rejectUnknown(body, new Set(["workflows"]), "company_release_workflow_receipt_unknown_field");
  if (!Array.isArray(body.workflows) || body.workflows.length !== 3) throw new CompanyReleaseEvidenceError("company_release_workflow_receipt_three_required");
  const workflows = body.workflows.map((raw) => {
    const entry = record(raw, "company_release_workflow_receipt_entry_invalid");
    const fields = ["workflow_id", "account_ref", "target_ref", "payload_hash", "provider", "provider_receipt_contract", "idempotency_key", "unknown_outcome_owner", "cleanup_receipt_schema", "rollback_contract"] as const;
    requireFields(entry, fields, "company_release_workflow_receipt_entry_field_missing");
    rejectUnknown(entry, new Set(fields), "company_release_workflow_receipt_entry_unknown_field");
    if (typeof entry.workflow_id !== "string" || !workflowIds.has(entry.workflow_id as CompanyReleaseWorkflowReceiptContractV1["workflow_id"])) {
      throw new CompanyReleaseEvidenceError("company_release_workflow_receipt_workflow_id_invalid");
    }
    const workflowId = entry.workflow_id as CompanyReleaseWorkflowReceiptContractV1["workflow_id"];
    if (typeof entry.provider !== "string" || !workflowProviders[workflowId].has(entry.provider)) {
      throw new CompanyReleaseEvidenceError("company_release_workflow_receipt_provider_invalid");
    }
    if (entry.cleanup_receipt_schema !== canonicalCleanupReceiptSchema) {
      throw new CompanyReleaseEvidenceError("company_release_workflow_receipt_cleanup_schema_invalid");
    }
    const expectedProviderReceiptContract = workflowProviderReceiptContracts[workflowId][entry.provider as string];
    if (
      typeof entry.provider_receipt_contract !== "string" ||
      !identifierPattern.test(entry.provider_receipt_contract) ||
      entry.provider_receipt_contract !== expectedProviderReceiptContract
    ) {
      throw new CompanyReleaseEvidenceError("company_release_workflow_receipt_contract_invalid");
    }
    return {
      workflow_id: workflowId,
      account_ref: text(entry.account_ref, "company_release_workflow_receipt_account_invalid", 256),
      target_ref: text(entry.target_ref, "company_release_workflow_receipt_target_invalid", 2048),
      payload_hash: hash(entry.payload_hash, "company_release_workflow_receipt_payload_hash_invalid"),
      provider: entry.provider,
      provider_receipt_contract: entry.provider_receipt_contract,
      idempotency_key: identifier(entry.idempotency_key, "company_release_workflow_receipt_idempotency_invalid"),
      unknown_outcome_owner: text(entry.unknown_outcome_owner, "company_release_workflow_receipt_unknown_outcome_owner_invalid", 256),
      cleanup_receipt_schema: entry.cleanup_receipt_schema,
      rollback_contract: text(entry.rollback_contract, "company_release_workflow_receipt_rollback_contract_invalid", 2048)
    };
  });
  const ids = new Set(workflows.map((workflow) => workflow.workflow_id));
  if (ids.size !== 3 || [...workflowIds].some((workflowId) => !ids.has(workflowId))) {
    throw new CompanyReleaseEvidenceError("company_release_workflow_receipt_contracts_incomplete");
  }
  return { workflows: workflows as CompanyReleaseWorkflowReceiptEvidenceV1["workflows"] };
}

function parseIncident(value: unknown): CompanyReleaseIncidentRecoveryEvidenceV1 {
  const body = record(value, "company_release_incident_value_invalid");
  requireFields(body, ["owner", "drill_id", "scenario", "recovery_readback_sha256", "cleanup_readback_sha256", "rollback_anchor", "passed"], "company_release_incident_field_missing");
  rejectUnknown(body, new Set(["owner", "drill_id", "scenario", "recovery_readback_sha256", "cleanup_readback_sha256", "rollback_anchor", "passed"]), "company_release_incident_unknown_field");
  if (body.passed !== true) throw new CompanyReleaseEvidenceError("company_release_incident_drill_failed");
  return {
    owner: text(body.owner, "company_release_incident_owner_invalid", 256),
    drill_id: identifier(body.drill_id, "company_release_incident_drill_id_invalid"),
    scenario: text(body.scenario, "company_release_incident_scenario_invalid", 2048),
    recovery_readback_sha256: hash(body.recovery_readback_sha256, "company_release_incident_recovery_sha_invalid"),
    cleanup_readback_sha256: hash(body.cleanup_readback_sha256, "company_release_incident_cleanup_sha_invalid"),
    rollback_anchor: text(body.rollback_anchor, "company_release_incident_rollback_anchor_invalid", 512),
    passed: true
  };
}

const blockedDefaults: Record<CompanyReleaseEvidenceFieldV1, { exact_blocker: string; safe_resume_step: string }> = {
  named_g0_approvers_and_decisions: {
    exact_blocker: "named_g0_approvers_and_decisions_missing",
    safe_resume_step: "Record named G0 approvers, approved decisions, and decision-pack readback."
  },
  mixed_file_hunk_allowlist_owner: {
    exact_blocker: "mixed_file_hunk_allowlist_owner_missing",
    safe_resume_step: "Assign an owner and approve the exact mixed-file hunk allowlist."
  },
  clean_candidate_sha_and_signed_manifest: {
    exact_blocker: "clean_candidate_sha_and_signed_manifest_missing_or_unverified",
    safe_resume_step: "Produce a clean candidate, SBOM, signed manifest, and independent verification readback."
  },
  backup_restore_rollback_owner: {
    exact_blocker: "backup_restore_rollback_owner_missing",
    safe_resume_step: "Name the owner and execute a bounded restore drill plus rollback-anchor readback."
  },
  per_workflow_account_target_payload_receipt_contract: {
    exact_blocker: "per_workflow_account_target_payload_receipt_contract_missing",
    safe_resume_step: "Bind account, target, payload, provider receipt, idempotency, cleanup, and rollback values for all three workflows."
  },
  incident_recovery_drill: {
    exact_blocker: "incident_drill_evidence_missing",
    safe_resume_step: "Run an approved incident/recovery drill and record recovery, cleanup, and rollback readbacks."
  }
};

export function buildBlockedCompanyReleaseEvidenceV1(): CompanyReleaseEvidenceV1 {
  return {
    schema: COMPANY_RELEASE_EVIDENCE_SCHEMA_V1,
    status: "blocked",
    external_action_executed: false,
    ...Object.fromEntries(COMPANY_RELEASE_EVIDENCE_REQUIRED_FIELDS_V1.map((field) => [field, {
      status: "blocked",
      exact_blocker: blockedDefaults[field].exact_blocker,
      blocker_owner: null,
      safe_resume_step: blockedDefaults[field].safe_resume_step
    }])) as Pick<CompanyReleaseEvidenceV1, CompanyReleaseEvidenceFieldV1>,
    exact_blocker: "company_release_evidence_required_fields_missing",
    blocker_owner: null,
    safe_resume_step: "Resolve all release evidence fields, then run an independent no-effect validation readback."
  };
}

const defaultValidationOptions: CompanyReleaseEvidenceValidationOptionsV1 = {
  trusted_verifier_ids: [],
  evidence_readback: {}
};

export function parseCompanyReleaseEvidenceV1(
  value: unknown,
  options: CompanyReleaseEvidenceValidationOptionsV1 = defaultValidationOptions
): CompanyReleaseEvidenceV1 {
  const body = record(value, "company_release_evidence_required");
  rejectUnknown(body, topLevelFields, "company_release_evidence_unknown_field");
  requireFields(body, ["schema", "status", "external_action_executed", ...COMPANY_RELEASE_EVIDENCE_REQUIRED_FIELDS_V1, "exact_blocker", "blocker_owner", "safe_resume_step"], "company_release_evidence_field_missing");
  if (body.schema !== COMPANY_RELEASE_EVIDENCE_SCHEMA_V1) throw new CompanyReleaseEvidenceError("company_release_evidence_schema_invalid");
  if (body.status !== "ready" && body.status !== "blocked") throw new CompanyReleaseEvidenceError("company_release_evidence_status_invalid");
  if (body.external_action_executed !== false) throw new CompanyReleaseEvidenceError("company_release_evidence_external_action_forbidden");
  if (body.status === "ready" && (!options.expected_candidate_sha || !options.expected_source_commit)) {
    throw new CompanyReleaseEvidenceError("company_release_evidence_release_line_binding_required");
  }
  if (options.expected_candidate_sha !== undefined) hash(options.expected_candidate_sha, "company_release_evidence_expected_candidate_sha_invalid");
  if (options.expected_source_commit !== undefined) commitHash(options.expected_source_commit, "company_release_evidence_expected_source_commit_invalid");

  const evidence = {
    named_g0_approvers_and_decisions: parseField(body.named_g0_approvers_and_decisions, parseG0, options),
    mixed_file_hunk_allowlist_owner: parseField(body.mixed_file_hunk_allowlist_owner, parseHunkAllowlist, options),
    clean_candidate_sha_and_signed_manifest: parseField(body.clean_candidate_sha_and_signed_manifest, parseCandidate, options),
    backup_restore_rollback_owner: parseField(body.backup_restore_rollback_owner, parseBackup, options),
    per_workflow_account_target_payload_receipt_contract: parseField(body.per_workflow_account_target_payload_receipt_contract, parseWorkflowContracts, options),
    incident_recovery_drill: parseField(body.incident_recovery_drill, parseIncident, options)
  } as Pick<CompanyReleaseEvidenceV1, CompanyReleaseEvidenceFieldV1>;
  const blocked = COMPANY_RELEASE_EVIDENCE_REQUIRED_FIELDS_V1.filter((field) => evidence[field].status === "blocked");
  const exactBlocker = body.exact_blocker === null ? null : text(body.exact_blocker, "company_release_evidence_exact_blocker_invalid");
  const blockerOwner = body.blocker_owner === null ? null : text(body.blocker_owner, "company_release_evidence_blocker_owner_invalid", 256);
  const safeResume = body.safe_resume_step === null ? null : text(body.safe_resume_step, "company_release_evidence_safe_resume_step_invalid");
  if (body.status === "ready") {
    if (blocked.length > 0) throw new CompanyReleaseEvidenceError(`company_release_evidence_ready_blocked_field:${blocked[0]}`);
    if (exactBlocker !== null || blockerOwner !== null || safeResume !== null) throw new CompanyReleaseEvidenceError("company_release_evidence_ready_blocker_fields_forbidden");
  } else if (!exactBlocker || !safeResume) {
    throw new CompanyReleaseEvidenceError("company_release_evidence_blocker_resume_required");
  }
  return {
    schema: COMPANY_RELEASE_EVIDENCE_SCHEMA_V1,
    status: body.status,
    external_action_executed: false,
    ...evidence,
    exact_blocker: exactBlocker,
    blocker_owner: blockerOwner,
    safe_resume_step: safeResume
  };
}

export function validateCompanyReleaseEvidenceV1(
  value: unknown,
  options: CompanyReleaseEvidenceValidationOptionsV1 = defaultValidationOptions
): CompanyReleaseEvidenceValidationResultV1 {
  try {
    return { ok: true, status: "ok", value: parseCompanyReleaseEvidenceV1(value, options) };
  } catch (error) {
    return {
      ok: false,
      status: "blocked",
      exact_blocker: error instanceof CompanyReleaseEvidenceError ? error.code : "company_release_evidence_validation_failed",
      blocker_owner: null,
      safe_resume_step: null
    };
  }
}

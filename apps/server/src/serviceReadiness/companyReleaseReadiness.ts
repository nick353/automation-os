/**
 * Pure, in-memory gate for the Company SaaS G0/G1 release packet.
 *
 * This is deliberately not wired to the server, git, signing, backup, or any
 * provider.  It only validates an already-produced packet.  A blocked entry
 * is explicit evidence of an unmet prerequisite; it is not a placeholder and
 * cannot be promoted to activation.
 */

export const COMPANY_RELEASE_READINESS_SCHEMA_V1 = "company_release_readiness.v1" as const;

export const COMPANY_RELEASE_REQUIRED_FIELDS_V1 = [
  "named_g0_approvers_and_decisions",
  "mixed_file_hunk_allowlist_owner",
  "clean_candidate_sha_and_signed_manifest",
  "backup_restore_rollback_owner",
  "per_workflow_account_target_payload_receipt_contract"
] as const;

const defaultBlockedCompanyReleaseFields = {
  named_g0_approvers_and_decisions: {
    exact_blocker: "named_g0_approvers_and_decisions_missing",
    safe_resume_step: "Obtain named G0 approvers and signed decisions."
  },
  mixed_file_hunk_allowlist_owner: {
    exact_blocker: "mixed_file_hunk_allowlist_owner_missing",
    safe_resume_step: "Assign the hunk allowlist owner and approval."
  },
  clean_candidate_sha_and_signed_manifest: {
    exact_blocker: "clean_candidate_sha_and_signed_manifest_missing_or_unverified",
    safe_resume_step: "Create a clean candidate and signed manifest."
  },
  backup_restore_rollback_owner: {
    exact_blocker: "backup_restore_rollback_owner_missing",
    safe_resume_step: "Name the backup restore and rollback owner."
  },
  per_workflow_account_target_payload_receipt_contract: {
    exact_blocker: "per_workflow_account_target_payload_receipt_contract_missing",
    safe_resume_step: "Define all three workflow receipt contracts."
  }
} as const;

/** Current owner-safe packet before real release evidence is supplied. */
export function buildBlockedCompanyReleaseReadinessV1(): CompanyReleaseReadinessV1 {
  return {
    schema: COMPANY_RELEASE_READINESS_SCHEMA_V1,
    mode: "no_effect_readiness",
    status: "blocked",
    activation_requested: false,
    activation_authorized: false,
    external_action_executed: false,
    ...Object.fromEntries(Object.entries(defaultBlockedCompanyReleaseFields).map(([field, value]) => [field, {
      status: "blocked",
      ...value,
      blocker_owner: null
    }])) as Pick<CompanyReleaseReadinessV1, CompanyReleaseRequiredFieldV1>,
    exact_blocker: "company_release_required_fields_missing",
    blocker_owner: null,
    safe_resume_step: "Resolve the five required fields, then revalidate a fresh no-effect packet."
  };
}

export type CompanyReleaseRequiredFieldV1 = (typeof COMPANY_RELEASE_REQUIRED_FIELDS_V1)[number];
export type CompanyReleaseReadinessModeV1 = "no_effect_readiness" | "activation";
export type CompanyReleaseReadinessStatusV1 = "ready" | "blocked";

export type CompanyReleaseBlockedEvidenceV1 = {
  status: "blocked";
  exact_blocker: string;
  blocker_owner: string | null;
  safe_resume_step: string;
};

export type CompanyReleaseG0ApprovalV1 = {
  approvers: Array<{
    name: string;
    role: string;
    decision: "approved" | "rejected" | "deferred";
    decided_at: string;
  }>;
  decision_pack_sha256: string;
};

export type CompanyReleaseAllowlistV1 = {
  owner: string;
  allowlist_sha256: string;
  approved_at: string;
};

export type CompanyReleaseCandidateV1 = {
  candidate_sha: string;
  signed_manifest_sha256: string;
  signature: string;
  dirty: false;
  verified: true;
};

export type CompanyReleaseBackupV1 = {
  owner: string;
  restore_proof: string;
  rollback_plan: string;
};

export type CompanyReleaseWorkflowContractV1 = {
  workflow_id: "daily-ai" | "job-application-manager" | "nisenprints";
  account: string;
  target: string;
  payload_hash: string;
  provider_receipt_contract: string;
};

export type CompanyReleaseWorkflowContractsV1 = {
  workflows: [
    CompanyReleaseWorkflowContractV1,
    CompanyReleaseWorkflowContractV1,
    CompanyReleaseWorkflowContractV1
  ];
};

export type CompanyReleaseVerifiedEvidenceV1 =
  | { status: "verified"; value: CompanyReleaseG0ApprovalV1 }
  | { status: "verified"; value: CompanyReleaseAllowlistV1 }
  | { status: "verified"; value: CompanyReleaseCandidateV1 }
  | { status: "verified"; value: CompanyReleaseBackupV1 }
  | { status: "verified"; value: CompanyReleaseWorkflowContractsV1 };

export type CompanyReleaseFieldEvidenceV1 =
  | CompanyReleaseBlockedEvidenceV1
  | CompanyReleaseVerifiedEvidenceV1;

export type CompanyReleaseReadinessV1 = {
  schema: typeof COMPANY_RELEASE_READINESS_SCHEMA_V1;
  mode: CompanyReleaseReadinessModeV1;
  status: CompanyReleaseReadinessStatusV1;
  activation_requested: boolean;
  activation_authorized: boolean;
  external_action_executed: false;
  named_g0_approvers_and_decisions: CompanyReleaseFieldEvidenceV1;
  mixed_file_hunk_allowlist_owner: CompanyReleaseFieldEvidenceV1;
  clean_candidate_sha_and_signed_manifest: CompanyReleaseFieldEvidenceV1;
  backup_restore_rollback_owner: CompanyReleaseFieldEvidenceV1;
  per_workflow_account_target_payload_receipt_contract: CompanyReleaseFieldEvidenceV1;
  exact_blocker: string | null;
  blocker_owner: string | null;
  safe_resume_step: string | null;
};

export type CompanyReleaseReadinessValidationSuccessV1 = {
  ok: true;
  status: "ok";
  value: CompanyReleaseReadinessV1;
};

export type CompanyReleaseReadinessValidationFailureV1 = {
  ok: false;
  status: "blocked";
  exact_blocker: string;
  blocker_owner: string | null;
  safe_resume_step: string | null;
};

export type CompanyReleaseReadinessValidationResultV1 =
  | CompanyReleaseReadinessValidationSuccessV1
  | CompanyReleaseReadinessValidationFailureV1;

export class CompanyReleaseReadinessContractError extends Error {
  constructor(
    public readonly code: string,
    public readonly blocker_owner: string | null = null,
    public readonly safe_resume_step: string | null = null
  ) {
    super(code);
    this.name = "CompanyReleaseReadinessContractError";
  }
}

const topLevelFields = new Set<string>([
  "schema",
  "mode",
  "status",
  "activation_requested",
  "activation_authorized",
  "external_action_executed",
  ...COMPANY_RELEASE_REQUIRED_FIELDS_V1,
  "exact_blocker",
  "blocker_owner",
  "safe_resume_step"
]);
const evidenceFields = new Set(["status", "value", "exact_blocker", "blocker_owner", "safe_resume_step"]);
const sha256Pattern = /^[a-f0-9]{64}$/;
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
  "n/a",
  "na",
  "unassigned",
  "not_provided",
  "not provided"
]);
const workflowIds = new Set<CompanyReleaseWorkflowContractV1["workflow_id"]>([
  "daily-ai",
  "job-application-manager",
  "nisenprints"
]);

function objectValue(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CompanyReleaseReadinessContractError(code);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: Set<string>, code: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new CompanyReleaseReadinessContractError(`${code}:${key}`);
  }
}

function requireFields(value: Record<string, unknown>, fields: readonly string[], code: string): void {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw new CompanyReleaseReadinessContractError(`${code}:${field}`);
    }
  }
}

function text(value: unknown, code: string, allowNull = false): string | null {
  if (allowNull && value === null) return null;
  if (typeof value !== "string" || placeholderValues.has(value.trim().toLowerCase())) {
    throw new CompanyReleaseReadinessContractError(code);
  }
  const normalized = value.trim();
  if (/^[\u0000-\u001f\u007f]/.test(normalized) || /[\u0000-\u001f\u007f]$/.test(normalized)) {
    throw new CompanyReleaseReadinessContractError(code);
  }
  return normalized;
}

function nullableText(value: unknown, code: string): string | null {
  return text(value, code, true);
}

function booleanValue(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") throw new CompanyReleaseReadinessContractError(code);
  return value;
}

function sha256(value: unknown, code: string): string {
  if (typeof value !== "string" || !sha256Pattern.test(value)) {
    throw new CompanyReleaseReadinessContractError(code);
  }
  return value;
}

function parseBlockedEvidence(body: Record<string, unknown>): CompanyReleaseBlockedEvidenceV1 {
  requireFields(body, ["status", "exact_blocker", "blocker_owner", "safe_resume_step"], "company_release_evidence_field_missing");
  rejectUnknownFields(body, evidenceFields, "company_release_evidence_unknown_field");
  if (body.status !== "blocked") throw new CompanyReleaseReadinessContractError("company_release_evidence_status_invalid");
  const exactBlocker = text(body.exact_blocker, "company_release_field_exact_blocker_invalid");
  const blockerOwner = nullableText(body.blocker_owner, "company_release_field_blocker_owner_invalid");
  const safeResumeStep = text(body.safe_resume_step, "company_release_field_safe_resume_step_invalid");
  return { status: "blocked", exact_blocker: exactBlocker!, blocker_owner: blockerOwner, safe_resume_step: safeResumeStep! };
}

function parseEvidence(value: unknown, field: CompanyReleaseRequiredFieldV1): CompanyReleaseFieldEvidenceV1 {
  const body = objectValue(value, `company_release_required_field_invalid:${field}`);
  if (body.status === "blocked") return parseBlockedEvidence(body);
  requireFields(body, ["status", "value"], "company_release_evidence_field_missing");
  rejectUnknownFields(body, evidenceFields, "company_release_evidence_unknown_field");
  if (body.status !== "verified") throw new CompanyReleaseReadinessContractError(`company_release_evidence_status_invalid:${field}`);
  const parsed = parseVerifiedValue(body.value, field);
  return { status: "verified", value: parsed } as CompanyReleaseVerifiedEvidenceV1;
}

function parseVerifiedValue(value: unknown, field: CompanyReleaseRequiredFieldV1):
  | CompanyReleaseG0ApprovalV1
  | CompanyReleaseAllowlistV1
  | CompanyReleaseCandidateV1
  | CompanyReleaseBackupV1
  | CompanyReleaseWorkflowContractsV1 {
  const body = objectValue(value, `company_release_verified_value_invalid:${field}`);
  if (field === "named_g0_approvers_and_decisions") {
    requireFields(body, ["approvers", "decision_pack_sha256"], `company_release_value_field_missing:${field}`);
    rejectUnknownFields(body, new Set(["approvers", "decision_pack_sha256"]), `company_release_value_unknown_field:${field}`);
    if (!Array.isArray(body.approvers) || body.approvers.length === 0) {
      throw new CompanyReleaseReadinessContractError("company_release_g0_approvers_required");
    }
    const approvers = body.approvers.map((raw) => {
      const entry = objectValue(raw, "company_release_g0_approver_invalid");
      requireFields(entry, ["name", "role", "decision", "decided_at"], "company_release_g0_approver_field_missing");
      rejectUnknownFields(entry, new Set(["name", "role", "decision", "decided_at"]), "company_release_g0_approver_unknown_field");
      const decision = entry.decision;
      if (decision !== "approved" && decision !== "rejected" && decision !== "deferred") {
        throw new CompanyReleaseReadinessContractError("company_release_g0_decision_invalid");
      }
      return {
        name: text(entry.name, "company_release_g0_approver_name_invalid")!,
        role: text(entry.role, "company_release_g0_approver_role_invalid")!,
        decision: decision as "approved" | "rejected" | "deferred",
        decided_at: text(entry.decided_at, "company_release_g0_decided_at_invalid")!
      };
    });
    return { approvers, decision_pack_sha256: sha256(body.decision_pack_sha256, "company_release_g0_decision_pack_sha_invalid") };
  }

  if (field === "mixed_file_hunk_allowlist_owner") {
    requireFields(body, ["owner", "allowlist_sha256", "approved_at"], `company_release_value_field_missing:${field}`);
    rejectUnknownFields(body, new Set(["owner", "allowlist_sha256", "approved_at"]), `company_release_value_unknown_field:${field}`);
    return {
      owner: text(body.owner, "company_release_allowlist_owner_invalid")!,
      allowlist_sha256: sha256(body.allowlist_sha256, "company_release_allowlist_sha_invalid"),
      approved_at: text(body.approved_at, "company_release_allowlist_approved_at_invalid")!
    };
  }

  if (field === "clean_candidate_sha_and_signed_manifest") {
    requireFields(body, ["candidate_sha", "signed_manifest_sha256", "signature", "dirty", "verified"], `company_release_value_field_missing:${field}`);
    rejectUnknownFields(body, new Set(["candidate_sha", "signed_manifest_sha256", "signature", "dirty", "verified"]), `company_release_value_unknown_field:${field}`);
    if (body.dirty !== false) throw new CompanyReleaseReadinessContractError("company_release_candidate_dirty");
    if (body.verified !== true) throw new CompanyReleaseReadinessContractError("company_release_candidate_unverified");
    return {
      candidate_sha: sha256(body.candidate_sha, "company_release_candidate_sha_invalid"),
      signed_manifest_sha256: sha256(body.signed_manifest_sha256, "company_release_signed_manifest_sha_invalid"),
      signature: text(body.signature, "company_release_signed_manifest_signature_invalid")!,
      dirty: false,
      verified: true
    };
  }

  if (field === "backup_restore_rollback_owner") {
    requireFields(body, ["owner", "restore_proof", "rollback_plan"], `company_release_value_field_missing:${field}`);
    rejectUnknownFields(body, new Set(["owner", "restore_proof", "rollback_plan"]), `company_release_value_unknown_field:${field}`);
    return {
      owner: text(body.owner, "company_release_backup_owner_invalid")!,
      restore_proof: text(body.restore_proof, "company_release_restore_proof_invalid")!,
      rollback_plan: text(body.rollback_plan, "company_release_rollback_plan_invalid")!
    };
  }

  requireFields(body, ["workflows"], `company_release_value_field_missing:${field}`);
  rejectUnknownFields(body, new Set(["workflows"]), `company_release_value_unknown_field:${field}`);
  if (!Array.isArray(body.workflows) || body.workflows.length !== 3) {
    throw new CompanyReleaseReadinessContractError("company_release_workflow_contracts_must_cover_three_workflows");
  }
  const workflows = body.workflows.map((raw) => {
    const entry = objectValue(raw, "company_release_workflow_contract_invalid");
    requireFields(entry, ["workflow_id", "account", "target", "payload_hash", "provider_receipt_contract"], "company_release_workflow_contract_field_missing");
    rejectUnknownFields(entry, new Set(["workflow_id", "account", "target", "payload_hash", "provider_receipt_contract"]), "company_release_workflow_contract_unknown_field");
    if (typeof entry.workflow_id !== "string" || !workflowIds.has(entry.workflow_id as CompanyReleaseWorkflowContractV1["workflow_id"])) {
      throw new CompanyReleaseReadinessContractError("company_release_workflow_id_invalid");
    }
    return {
      workflow_id: entry.workflow_id as CompanyReleaseWorkflowContractV1["workflow_id"],
      account: text(entry.account, "company_release_workflow_account_invalid")!,
      target: text(entry.target, "company_release_workflow_target_invalid")!,
      payload_hash: sha256(entry.payload_hash, "company_release_workflow_payload_hash_invalid"),
      provider_receipt_contract: text(entry.provider_receipt_contract, "company_release_workflow_receipt_contract_invalid")!
    };
  });
  const ids = new Set(workflows.map((workflow) => workflow.workflow_id));
  if (ids.size !== 3 || [...workflowIds].some((id) => !ids.has(id))) {
    throw new CompanyReleaseReadinessContractError("company_release_workflow_contracts_incomplete");
  }
  return { workflows: workflows as CompanyReleaseWorkflowContractsV1["workflows"] };
}

export function parseCompanyReleaseReadinessV1(value: unknown): CompanyReleaseReadinessV1 {
  const body = objectValue(value, "company_release_readiness_required");
  rejectUnknownFields(body, topLevelFields, "company_release_readiness_unknown_field");
  requireFields(body, ["schema", "mode", "status", "activation_requested", "activation_authorized", "external_action_executed", ...COMPANY_RELEASE_REQUIRED_FIELDS_V1, "exact_blocker", "blocker_owner", "safe_resume_step"], "company_release_readiness_field_missing");
  if (body.schema !== COMPANY_RELEASE_READINESS_SCHEMA_V1) {
    throw new CompanyReleaseReadinessContractError("company_release_readiness_schema_invalid");
  }
  if (body.mode !== "no_effect_readiness" && body.mode !== "activation") {
    throw new CompanyReleaseReadinessContractError("company_release_readiness_mode_invalid");
  }
  if (body.status !== "ready" && body.status !== "blocked") {
    throw new CompanyReleaseReadinessContractError("company_release_readiness_status_invalid");
  }
  const activationRequested = booleanValue(body.activation_requested, "company_release_activation_requested_invalid");
  const activationAuthorized = booleanValue(body.activation_authorized, "company_release_activation_authorized_invalid");
  if (body.external_action_executed !== false) {
    throw new CompanyReleaseReadinessContractError("company_release_external_action_forbidden");
  }
  if (body.mode === "no_effect_readiness" && (activationRequested || activationAuthorized)) {
    throw new CompanyReleaseReadinessContractError("company_release_no_effect_activation_flags_forbidden");
  }
  if (body.mode === "activation" && (!activationRequested || !activationAuthorized)) {
    throw new CompanyReleaseReadinessContractError("company_release_activation_authorization_required");
  }

  const evidence = Object.fromEntries(
    COMPANY_RELEASE_REQUIRED_FIELDS_V1.map((field) => [field, parseEvidence(body[field], field)])
  ) as Pick<CompanyReleaseReadinessV1, CompanyReleaseRequiredFieldV1>;
  const exactBlocker = nullableText(body.exact_blocker, "company_release_exact_blocker_invalid");
  const blockerOwner = nullableText(body.blocker_owner, "company_release_blocker_owner_invalid");
  const safeResumeStep = nullableText(body.safe_resume_step, "company_release_safe_resume_step_invalid");
  const blockedEvidence = COMPANY_RELEASE_REQUIRED_FIELDS_V1.filter((field) => evidence[field].status === "blocked");
  if (body.status === "blocked") {
    if (!exactBlocker || !safeResumeStep) throw new CompanyReleaseReadinessContractError("company_release_blocker_resume_required");
  } else {
    if (blockedEvidence.length > 0) throw new CompanyReleaseReadinessContractError(`company_release_ready_blocked_field:${blockedEvidence[0]}`);
    if (exactBlocker !== null || blockerOwner !== null || safeResumeStep !== null) {
      throw new CompanyReleaseReadinessContractError("company_release_ready_blocker_fields_forbidden");
    }
  }
  if (body.mode === "activation" && body.status !== "ready") {
    throw new CompanyReleaseReadinessContractError("company_release_activation_blocked");
  }
  return {
    schema: COMPANY_RELEASE_READINESS_SCHEMA_V1,
    mode: body.mode,
    status: body.status,
    activation_requested: activationRequested,
    activation_authorized: activationAuthorized,
    external_action_executed: false,
    ...evidence,
    exact_blocker: exactBlocker,
    blocker_owner: blockerOwner,
    safe_resume_step: safeResumeStep
  };
}

export function validateCompanyReleaseReadinessV1(value: unknown): CompanyReleaseReadinessValidationResultV1 {
  try {
    return { ok: true, status: "ok", value: parseCompanyReleaseReadinessV1(value) };
  } catch (error) {
    if (error instanceof CompanyReleaseReadinessContractError) {
      return {
        ok: false,
        status: "blocked",
        exact_blocker: error.code,
        blocker_owner: error.blocker_owner,
        safe_resume_step: error.safe_resume_step
      };
    }
    return {
      ok: false,
      status: "blocked",
      exact_blocker: "company_release_readiness_validation_failed",
      blocker_owner: null,
      safe_resume_step: null
    };
  }
}

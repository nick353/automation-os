import { createHash } from "node:crypto";

export const PORTABLE_EXTERNAL_APPROVAL_BINDING_SCHEMA_V1 = "automation_os_portable_external_approval_binding.v1" as const;
export const PORTABLE_TARGET_BOUND_APPROVAL_RECEIPT_SCHEMA_V1 = "automation_os_portable_target_bound_approval_receipt.v1" as const;

const IDENTIFIER = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,179}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const SAFE_URL = /^https?:\/\/[^\s@/]+(?:\/[^\s]*)?$/iu;

export type PortableApprovalTarget = {
  candidate_key?: string;
  application_url?: string;
  job_url?: string;
  job_id?: string;
  target_key?: string;
  account_ref?: string;
  content_key?: string;
  product_key?: string;
  asset_manifest_id?: string;
  source_snapshot_id?: string;
  bucket?: string;
  sequence?: number;
  attempt?: number;
  company?: string;
  role?: string;
  audience?: string;
  resume_locale?: string;
  resume_sha256?: string;
  owner_ref?: string;
  authority_ref?: string;
  source_snapshot_expires_at?: string;
  input_bundle_ref?: string;
  target_digest?: string;
  source_state_digest?: string;
};

export type PortableExternalApprovalBindingV1 = {
  schema: typeof PORTABLE_EXTERNAL_APPROVAL_BINDING_SCHEMA_V1;
  issued_by: "automation_os_portable_controller";
  company_id: string;
  workflow_id: string;
  run_id: string;
  step_id: string;
  effect_stage: string;
  idempotency_key: string;
  input_bundle_sha256: string;
  target_digest: string;
  target: PortableApprovalTarget;
  browser_surface: "browser_use_cli";
  fresh_browser_use_authority_required: true;
  authority_scope: "current_run_company_target";
  first_class_root_required: false;
  external_action_authorized: false;
};

export type PortableTargetBoundApprovalReceiptV1 = {
  schema: typeof PORTABLE_TARGET_BOUND_APPROVAL_RECEIPT_SCHEMA_V1;
  approval_id: string;
  approval_status: "pending" | "approved" | "rejected" | "cancelled";
  decided_at: string | null;
  binding: PortableExternalApprovalBindingV1;
  binding_sha256: string;
  fresh_browser_use_authority_required: true;
  first_class_root_required: false;
  external_action_authorized: false;
};

function requiredIdentifier(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!IDENTIFIER.test(normalized)) throw new Error(`portable_external_approval_${field}_invalid`);
  return normalized;
}

function requiredHash(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!HASH.test(normalized)) throw new Error(`portable_external_approval_${field}_invalid`);
  return normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeTargetValue(value: unknown): string | number | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized || normalized.length > 1000) return undefined;
    return normalized;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  return undefined;
}

function targetForBundle(workflowId: string, bundle: Record<string, unknown>): PortableApprovalTarget {
  const target: PortableApprovalTarget = {};
  const keys: Array<keyof PortableApprovalTarget> = [
    "candidate_key", "application_url", "job_url", "job_id", "target_key", "account_ref", "content_key",
    "product_key", "asset_manifest_id", "source_snapshot_id", "bucket", "sequence", "attempt",
    "company", "role", "audience", "resume_locale", "resume_sha256", "owner_ref", "authority_ref",
    "source_snapshot_expires_at", "input_bundle_ref", "target_digest", "source_state_digest"
  ];
  for (const key of keys) {
    const value = safeTargetValue(bundle[key]);
    if (value !== undefined) target[key] = value as never;
  }
  if (workflowId === "job-application-manager") {
    if (typeof target.candidate_key !== "string" || typeof target.application_url !== "string" || typeof target.job_url !== "string") {
      throw new Error("portable_external_approval_job_target_missing");
    }
    if (!SAFE_URL.test(target.application_url) || !SAFE_URL.test(target.job_url)) {
      throw new Error("portable_external_approval_job_url_invalid");
    }
  }
  return target;
}

/** Keep this digest compatible with the Mac claim path and the existing ledger contract. */
export function portableBusinessTargetDigest(bundle: Record<string, unknown>): string {
  const keys = [
    "account_ref", "target_key", "payload_hash", "content_key", "product_key", "asset_manifest_id",
    "job_url", "job_id", "application_url", "candidate_key", "bucket", "sequence", "attempt",
    "source_snapshot_id", "source_snapshot_expires_at", "supply_run_id", "company", "role", "audience",
    "resume_locale", "resume_sha256", "owner_ref", "authority_ref", "input_bundle_ref", "target_digest", "source_state_digest"
  ];
  return sha256(JSON.stringify(Object.fromEntries(keys.filter((key) => key in bundle).map((key) => [key, bundle[key]]))));
}

export function portableExternalApprovalResourceLocks(input: {
  workflowId: string;
  inputBundleSha256: string;
  targetDigest: string;
  idempotencyKey: string;
}): string[] {
  const workflowId = requiredIdentifier(input.workflowId, "workflow_id");
  const inputBundleSha256 = requiredHash(input.inputBundleSha256, "input_bundle_sha256");
  const targetDigest = requiredHash(input.targetDigest, "target_digest");
  const idempotencyKey = requiredIdentifier(input.idempotencyKey, "idempotency_key");
  return [
    `portable_external:${workflowId}:${inputBundleSha256}`,
    `portable_external_target:${workflowId}:${targetDigest}:${idempotencyKey}`
  ];
}

export function buildPortableExternalApprovalBinding(input: {
  companyId: string;
  workflowId: string;
  runId: string;
  stepId: string;
  effectStage: string;
  idempotencyKey: string;
  inputBundleSha256: string;
  inputBundle: Record<string, unknown>;
}): PortableExternalApprovalBindingV1 {
  const companyId = requiredIdentifier(input.companyId, "company_id");
  const workflowId = requiredIdentifier(input.workflowId, "workflow_id");
  const runId = requiredIdentifier(input.runId, "run_id");
  const stepId = requiredIdentifier(input.stepId, "step_id");
  const effectStage = requiredIdentifier(input.effectStage, "effect_stage");
  const idempotencyKey = requiredIdentifier(input.idempotencyKey, "idempotency_key");
  const inputBundleSha256 = requiredHash(input.inputBundleSha256, "input_bundle_sha256");
  const target = targetForBundle(workflowId, input.inputBundle);
  return {
    schema: PORTABLE_EXTERNAL_APPROVAL_BINDING_SCHEMA_V1,
    issued_by: "automation_os_portable_controller",
    company_id: companyId,
    workflow_id: workflowId,
    run_id: runId,
    step_id: stepId,
    effect_stage: effectStage,
    idempotency_key: idempotencyKey,
    input_bundle_sha256: inputBundleSha256,
    target_digest: portableBusinessTargetDigest(input.inputBundle),
    target,
    browser_surface: "browser_use_cli",
    fresh_browser_use_authority_required: true,
    authority_scope: "current_run_company_target",
    first_class_root_required: false,
    external_action_authorized: false
  };
}

export function portableApprovalBindingSha256(binding: PortableExternalApprovalBindingV1): string {
  return sha256(JSON.stringify(binding));
}

export function buildPortableTargetBoundApprovalReceipt(input: {
  approvalId: string;
  approvalStatus: PortableTargetBoundApprovalReceiptV1["approval_status"];
  decidedAt?: string | null;
  binding: PortableExternalApprovalBindingV1;
}): PortableTargetBoundApprovalReceiptV1 {
  const approvalId = requiredIdentifier(input.approvalId, "approval_id");
  if (input.approvalStatus === "approved" && !input.decidedAt) throw new Error("portable_external_approval_decision_time_missing");
  return {
    schema: PORTABLE_TARGET_BOUND_APPROVAL_RECEIPT_SCHEMA_V1,
    approval_id: approvalId,
    approval_status: input.approvalStatus,
    decided_at: input.decidedAt ?? null,
    binding: input.binding,
    binding_sha256: portableApprovalBindingSha256(input.binding),
    fresh_browser_use_authority_required: true,
    first_class_root_required: false,
    external_action_authorized: false
  };
}

export function validatePortableTargetBoundApprovalReceipt(
  value: unknown,
  expected: Partial<Pick<PortableExternalApprovalBindingV1, "company_id" | "workflow_id" | "run_id" | "step_id" | "effect_stage" | "idempotency_key" | "input_bundle_sha256" | "target_digest">> = {}
): PortableTargetBoundApprovalReceiptV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("portable_external_approval_receipt_invalid");
  const receipt = value as Record<string, unknown>;
  if (receipt.schema !== PORTABLE_TARGET_BOUND_APPROVAL_RECEIPT_SCHEMA_V1
    || receipt.approval_status !== "approved"
    || receipt.fresh_browser_use_authority_required !== true
    || receipt.first_class_root_required !== false
    || receipt.external_action_authorized !== false
    || !receipt.binding || typeof receipt.binding !== "object" || Array.isArray(receipt.binding)) {
    throw new Error("portable_external_approval_receipt_contract_invalid");
  }
  const binding = receipt.binding as Record<string, unknown>;
  if (binding.schema !== PORTABLE_EXTERNAL_APPROVAL_BINDING_SCHEMA_V1
    || binding.issued_by !== "automation_os_portable_controller"
    || binding.browser_surface !== "browser_use_cli"
    || binding.fresh_browser_use_authority_required !== true
    || binding.authority_scope !== "current_run_company_target"
    || binding.first_class_root_required !== false
    || binding.external_action_authorized !== false) {
    throw new Error("portable_external_approval_binding_contract_invalid");
  }
  requiredIdentifier(receipt.approval_id, "approval_id");
  for (const field of ["company_id", "workflow_id", "run_id", "step_id", "effect_stage", "idempotency_key"] as const) {
    const actual = requiredIdentifier(binding[field], field);
    if (expected[field] !== undefined && actual !== expected[field]) throw new Error(`portable_external_approval_binding_mismatch:${field}`);
  }
  const inputBundleSha256 = requiredHash(binding.input_bundle_sha256, "input_bundle_sha256");
  const targetDigest = requiredHash(binding.target_digest, "target_digest");
  if (expected.input_bundle_sha256 !== undefined && inputBundleSha256 !== expected.input_bundle_sha256) throw new Error("portable_external_approval_binding_mismatch:input_bundle_sha256");
  if (expected.target_digest !== undefined && targetDigest !== expected.target_digest) throw new Error("portable_external_approval_binding_mismatch:target_digest");
  if (receipt.binding_sha256 !== portableApprovalBindingSha256(binding as PortableExternalApprovalBindingV1)) throw new Error("portable_external_approval_binding_digest_invalid");
  return receipt as unknown as PortableTargetBoundApprovalReceiptV1;
}

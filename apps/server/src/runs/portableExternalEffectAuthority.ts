import { createHash } from "node:crypto";

export const PORTABLE_EXTERNAL_EFFECT_AUTHORITY_SCHEMA_V1 = "automation_os_portable_external_effect_authority.v1" as const;
export const PORTABLE_EXTERNAL_EFFECT_AUTHORITY_ISSUER_V1 = "automation_os_portable_controller" as const;

const IDENTIFIER = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,179}$/u;
const HASH = /^[a-f0-9]{64}$/u;

export type PortableExternalEffectAuthorityV1 = {
  schema: typeof PORTABLE_EXTERNAL_EFFECT_AUTHORITY_SCHEMA_V1;
  authority_id: string;
  issued_by: typeof PORTABLE_EXTERNAL_EFFECT_AUTHORITY_ISSUER_V1;
  company_id: string;
  workflow_id: string;
  run_id: string;
  step_id: string;
  effect_stage: string;
  effect_class: "external_non_idempotent";
  browser_surface: "browser_use_cli";
  approval_id: string;
  approval_status: "approved";
  idempotency_key: string;
  target_digest: string;
  input_bundle_sha256: string;
  payload_hash: string;
  issued_at: string;
  expires_at: string;
  timeout_ms: number;
  timeout_controller: "automation_os_portable_controller";
  reconciliation_required: true;
  reconciliation_owner: "automation_os_portable_controller";
  no_auto_retry: true;
  first_class_root_required: false;
  app_dependency: false;
  external_action_authorized: true;
};

export type IssuePortableExternalEffectAuthorityInputV1 = {
  companyId: string;
  workflowId: string;
  runId: string;
  stepId: string;
  effectStage: string;
  approvalId: string;
  idempotencyKey: string;
  targetDigest: string;
  inputBundleSha256: string;
  payloadHash: string;
  leaseExpiresAt: string;
  nowMs?: number;
};

function requiredIdentifier(value: string, field: string): string {
  const normalized = String(value || "").trim();
  if (!IDENTIFIER.test(normalized)) throw new Error(`portable_effect_authority_${field}_invalid`);
  return normalized;
}

function requiredHash(value: string, field: string): string {
  const normalized = String(value || "").trim();
  if (!HASH.test(normalized)) throw new Error(`portable_effect_authority_${field}_invalid`);
  return normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseTime(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`portable_effect_authority_${field}_invalid`);
  return parsed;
}

/**
 * Issue the portable authority used by the AOS scheduler -> durable run ->
 * Mac Browser Use CLI lane.  It is deliberately data-only: it contains no
 * cookie, token, password, provider secret, or Codex App identity.
 */
export function issuePortableExternalEffectAuthorityV1(
  input: IssuePortableExternalEffectAuthorityInputV1
): PortableExternalEffectAuthorityV1 {
  const companyId = requiredIdentifier(input.companyId, "company_id");
  const workflowId = requiredIdentifier(input.workflowId, "workflow_id");
  const runId = requiredIdentifier(input.runId, "run_id");
  const stepId = requiredIdentifier(input.stepId, "step_id");
  const effectStage = requiredIdentifier(input.effectStage, "effect_stage");
  const approvalId = requiredIdentifier(input.approvalId, "approval_id");
  const idempotencyKey = requiredIdentifier(input.idempotencyKey, "idempotency_key");
  const targetDigest = requiredHash(input.targetDigest, "target_digest");
  const inputBundleSha256 = requiredHash(input.inputBundleSha256, "input_bundle_sha256");
  const payloadHash = requiredHash(input.payloadHash, "payload_hash");
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error("portable_effect_authority_clock_invalid");
  const issuedAt = new Date(nowMs).toISOString();
  const leaseExpiresMs = parseTime(String(input.leaseExpiresAt || ""), "lease_expires_at");
  const expiresMs = Math.min(leaseExpiresMs, nowMs + 10 * 60_000);
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) throw new Error("portable_effect_authority_lease_expired");
  const timeoutMs = expiresMs - nowMs;
  const authorityId = `portable-effect-${sha256([
    companyId, workflowId, runId, stepId, effectStage, approvalId, idempotencyKey, targetDigest, inputBundleSha256
  ].join("\u001f")).slice(0, 32)}`;
  return {
    schema: PORTABLE_EXTERNAL_EFFECT_AUTHORITY_SCHEMA_V1,
    authority_id: authorityId,
    issued_by: PORTABLE_EXTERNAL_EFFECT_AUTHORITY_ISSUER_V1,
    company_id: companyId,
    workflow_id: workflowId,
    run_id: runId,
    step_id: stepId,
    effect_stage: effectStage,
    effect_class: "external_non_idempotent",
    browser_surface: "browser_use_cli",
    approval_id: approvalId,
    approval_status: "approved",
    idempotency_key: idempotencyKey,
    target_digest: targetDigest,
    input_bundle_sha256: inputBundleSha256,
    payload_hash: payloadHash,
    issued_at: issuedAt,
    expires_at: new Date(expiresMs).toISOString(),
    timeout_ms: timeoutMs,
    timeout_controller: "automation_os_portable_controller",
    reconciliation_required: true,
    reconciliation_owner: "automation_os_portable_controller",
    no_auto_retry: true,
    first_class_root_required: false,
    app_dependency: false,
    external_action_authorized: true
  };
}

export function validatePortableExternalEffectAuthorityV1(
  value: unknown,
  expected?: Partial<Pick<PortableExternalEffectAuthorityV1, "company_id" | "workflow_id" | "run_id" | "step_id" | "effect_stage" | "approval_id" | "idempotency_key" | "target_digest" | "input_bundle_sha256">>,
  nowMs = Date.now()
): PortableExternalEffectAuthorityV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("portable_effect_authority_invalid");
  const body = value as Record<string, unknown>;
  if (body.schema !== PORTABLE_EXTERNAL_EFFECT_AUTHORITY_SCHEMA_V1
    || body.issued_by !== PORTABLE_EXTERNAL_EFFECT_AUTHORITY_ISSUER_V1
    || body.effect_class !== "external_non_idempotent"
    || body.browser_surface !== "browser_use_cli"
    || body.approval_status !== "approved"
    || body.timeout_controller !== "automation_os_portable_controller"
    || body.reconciliation_required !== true
    || body.reconciliation_owner !== "automation_os_portable_controller"
    || body.no_auto_retry !== true
    || body.first_class_root_required !== false
    || body.app_dependency !== false
    || body.external_action_authorized !== true
    || !Number.isSafeInteger(body.timeout_ms)
    || Number(body.timeout_ms) <= 0) {
    throw new Error("portable_effect_authority_contract_invalid");
  }
  const fields = [
    ["authority_id", body.authority_id], ["company_id", body.company_id], ["workflow_id", body.workflow_id],
    ["run_id", body.run_id], ["step_id", body.step_id], ["effect_stage", body.effect_stage],
    ["approval_id", body.approval_id], ["idempotency_key", body.idempotency_key]
  ] as const;
  for (const [field, raw] of fields) requiredIdentifier(String(raw || ""), field);
  for (const [field, raw] of [["target_digest", body.target_digest], ["input_bundle_sha256", body.input_bundle_sha256]] as const) {
    requiredHash(String(raw || ""), field);
  }
  requiredHash(String(body.payload_hash || ""), "payload_hash");
  const issuedAt = parseTime(String(body.issued_at || ""), "issued_at");
  const expiresAt = parseTime(String(body.expires_at || ""), "expires_at");
  if (!Number.isSafeInteger(nowMs) || issuedAt > nowMs || expiresAt <= nowMs || expiresAt <= issuedAt) {
    throw new Error("portable_effect_authority_expired");
  }
  for (const [field, expectedValue] of Object.entries(expected ?? {})) {
    if (expectedValue !== undefined && body[field] !== expectedValue) throw new Error(`portable_effect_authority_binding_invalid:${field}`);
  }
  const expectedId = `portable-effect-${sha256([
    body.company_id, body.workflow_id, body.run_id, body.step_id, body.effect_stage,
    body.approval_id, body.idempotency_key, body.target_digest, body.input_bundle_sha256
  ].join("\u001f")).slice(0, 32)}`;
  if (body.authority_id !== expectedId) throw new Error("portable_effect_authority_id_invalid");
  return body as PortableExternalEffectAuthorityV1;
}

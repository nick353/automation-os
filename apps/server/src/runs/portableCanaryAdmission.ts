import { randomBytes } from "node:crypto";

import { hashIdempotencyRequest } from "../automations/idempotency.js";
import type { PortableCanaryReceiptV1, PortableTrigger } from "./portableWorkflowContract.js";

export const PORTABLE_CANARY_ADMISSION_SCHEMA_V1 = "aos.portable_canary_admission.v1" as const;
export const PORTABLE_CANARY_ADMISSION_PROVIDER = "aos.control_plane" as const;
export const PORTABLE_CANARY_ADMISSION_CONTRACT = "aos.execution_provider.v1" as const;
export const PORTABLE_CANARY_ADMISSION_TTL_MS = 5 * 60 * 1000;

export type PortableCanaryAdmissionWorkflowId =
  | "daily-ai-research-publish-run"
  | "job-application-manager"
  | "nisenprints-daily-product-canva-printify-etsy-pinterest";

export type PortableCanaryAdmissionAdapter =
  | "daily_ai_registered"
  | "job_submit_registered"
  | "nisenprints_registered";

export type PortableCanaryAdmissionTrigger = PortableTrigger;

export type PortableCanaryAdmissionOperation =
  | "manifest_validation"
  | "run_binding"
  | "readback"
  | "cleanup";

export type PortableCanaryAdmissionDecision = "allow" | "deny";

export type PortableCanaryAdmissionEnvelopeV1 = {
  schema: typeof PORTABLE_CANARY_ADMISSION_SCHEMA_V1;
  run_id: string;
  workflow_id: PortableCanaryAdmissionWorkflowId;
  provider: typeof PORTABLE_CANARY_ADMISSION_PROVIDER;
  contract: typeof PORTABLE_CANARY_ADMISSION_CONTRACT;
  operation: PortableCanaryAdmissionOperation;
  adapter: PortableCanaryAdmissionAdapter;
  trigger: PortableCanaryAdmissionTrigger;
  request_digest: string;
  issued_at: string;
  expires_at: string;
  effect_free: true;
  decision: PortableCanaryAdmissionDecision;
  nonce: string;
  portable_receipt_digest: string;
};

export type PortableCanaryAdmissionEvidenceV1 = {
  schema: typeof PORTABLE_CANARY_ADMISSION_SCHEMA_V1;
  run_id: string;
  workflow_id: PortableCanaryAdmissionWorkflowId;
  provider: typeof PORTABLE_CANARY_ADMISSION_PROVIDER;
  contract: typeof PORTABLE_CANARY_ADMISSION_CONTRACT;
  operation: PortableCanaryAdmissionOperation;
  adapter: PortableCanaryAdmissionAdapter;
  trigger: PortableCanaryAdmissionTrigger;
  request_digest: string;
  issued_at: string;
  expires_at: string;
  effect_free: true;
  decision: "allow";
  nonce_digest: string;
  portable_receipt_digest: string;
};

export type PortableCanaryAdmissionRequest = {
  runId: string;
  workflowId: PortableCanaryAdmissionWorkflowId;
  adapter: PortableCanaryAdmissionAdapter;
  trigger: PortableCanaryAdmissionTrigger;
  operation: PortableCanaryAdmissionOperation;
  request: unknown;
  portableReceipt: PortableCanaryReceiptV1;
  issuedAt?: string;
  expiresAt?: string;
  decision?: PortableCanaryAdmissionDecision;
};

type VerifyPortableCanaryAdmissionRequest = {
  envelope: PortableCanaryAdmissionEnvelopeV1;
  runId: string;
  workflowId: PortableCanaryAdmissionWorkflowId;
  request: unknown;
  portableReceipt: PortableCanaryReceiptV1;
  now?: string | Date;
};

const admissionWorkflows = new Set<string>([
  "daily-ai-research-publish-run",
  "job-application-manager",
  "nisenprints-daily-product-canva-printify-etsy-pinterest"
]);
const admissionAdapters = new Set<string>([
  "daily_ai_registered",
  "job_submit_registered",
  "nisenprints_registered"
]);
const admissionTriggers = new Set<string>([
  "automation_os_scheduler",
  "automation_os_ui",
  "codex_app_bridge",
  "launchd",
  "github_actions"
]);
const admissionOperations = new Set<string>([
  "manifest_validation",
  "run_binding",
  "readback",
  "cleanup"
]);
const admissionTuples = new Set([
  "daily-ai-research-publish-run|daily_ai_registered|manifest_validation",
  "daily-ai-research-publish-run|daily_ai_registered|run_binding",
  "daily-ai-research-publish-run|daily_ai_registered|readback",
  "daily-ai-research-publish-run|daily_ai_registered|cleanup",
  "job-application-manager|job_submit_registered|manifest_validation",
  "job-application-manager|job_submit_registered|run_binding",
  "job-application-manager|job_submit_registered|readback",
  "job-application-manager|job_submit_registered|cleanup",
  "nisenprints-daily-product-canva-printify-etsy-pinterest|nisenprints_registered|manifest_validation",
  "nisenprints-daily-product-canva-printify-etsy-pinterest|nisenprints_registered|run_binding",
  "nisenprints-daily-product-canva-printify-etsy-pinterest|nisenprints_registered|readback",
  "nisenprints-daily-product-canva-printify-etsy-pinterest|nisenprints_registered|cleanup"
]);
const usedNonces = new Set<string>();
const evidenceKeys = new Set([
  "schema",
  "run_id",
  "workflow_id",
  "provider",
  "contract",
  "operation",
  "adapter",
  "trigger",
  "request_digest",
  "issued_at",
  "expires_at",
  "effect_free",
  "decision",
  "nonce_digest",
  "portable_receipt_digest"
]);
const secretLikeKey = /(token|cookie|password|secret|authorization|credential|storage[_-]?state|api[_-]?key)/i;
const nisenPrintsUnsafeOperation = /(publish|post|create|update|delete|send|upload|attach|submit|replace|mutat|write|checkout|purchase)/i;

function invalid(reason: string): never {
  throw new Error(`portable_canary_admission_invalid:${reason}`);
}

function exactString(value: unknown, reason: string): string {
  if (typeof value !== "string" || value.length === 0) invalid(reason);
  return value;
}

function timestamp(value: string | Date | undefined, reason: string): string {
  const raw = value instanceof Date ? value.toISOString() : exactString(value, reason);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== raw) invalid(reason);
  return raw;
}

function nowIso(value?: string | Date): string {
  return timestamp(value ?? new Date(), "now_invalid");
}

function tuple(workflowId: string, adapter: string, operation: string): string {
  return `${workflowId}|${adapter}|${operation}`;
}

function validateTuple(workflowId: unknown, adapter: unknown, operation: unknown): void {
  if (typeof workflowId !== "string" || !admissionWorkflows.has(workflowId)) invalid("workflow_invalid");
  if (typeof adapter !== "string" || !admissionAdapters.has(adapter)) invalid("adapter_invalid");
  if (typeof operation !== "string" || !admissionOperations.has(operation)) invalid("operation_invalid");
  if (!admissionTuples.has(tuple(workflowId, adapter, operation))) invalid("tuple_not_allowed");
}

function validateTrigger(value: unknown): asserts value is PortableCanaryAdmissionTrigger {
  if (typeof value !== "string" || !admissionTriggers.has(value)) invalid("trigger_invalid");
}

function validateEnvelope(value: unknown): PortableCanaryAdmissionEnvelopeV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("envelope_invalid");
  const envelope = value as Record<string, unknown>;
  for (const key of Object.keys(envelope)) {
    if (secretLikeKey.test(key)) invalid("envelope_secret_field_forbidden");
  }
  const expectedKeys = new Set([
    "schema", "run_id", "workflow_id", "provider", "contract", "operation", "adapter", "trigger",
    "request_digest", "issued_at", "expires_at", "effect_free", "decision", "nonce", "portable_receipt_digest"
  ]);
  for (const key of Object.keys(envelope)) if (!expectedKeys.has(key)) invalid(`envelope_unknown_field:${key}`);
  if (envelope.schema !== PORTABLE_CANARY_ADMISSION_SCHEMA_V1) invalid("schema_invalid");
  exactString(envelope.run_id, "run_id_invalid");
  if (typeof envelope.workflow_id !== "string" || !admissionWorkflows.has(envelope.workflow_id)) invalid("workflow_invalid");
  if (envelope.provider !== PORTABLE_CANARY_ADMISSION_PROVIDER) invalid("provider_invalid");
  if (envelope.contract !== PORTABLE_CANARY_ADMISSION_CONTRACT) invalid("contract_invalid");
  validateTuple(envelope.workflow_id, envelope.adapter, envelope.operation);
  validateTrigger(envelope.trigger);
  exactString(envelope.request_digest, "request_digest_invalid");
  const issuedAt = timestamp(envelope.issued_at as string, "issued_at_invalid");
  const expiresAt = timestamp(envelope.expires_at as string, "expires_at_invalid");
  const ttl = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (ttl <= 0 || ttl > PORTABLE_CANARY_ADMISSION_TTL_MS) invalid("ttl_invalid");
  if (envelope.effect_free !== true) invalid("effect_free_invalid");
  if (envelope.decision !== "allow" && envelope.decision !== "deny") invalid("decision_invalid");
  if (typeof envelope.nonce !== "string" || !/^[a-f0-9]{64}$/.test(envelope.nonce)) invalid("nonce_invalid");
  exactString(envelope.portable_receipt_digest, "portable_receipt_digest_invalid");
  const runId = exactString(envelope.run_id, "run_id_invalid");
  const requestDigestValue = exactString(envelope.request_digest, "request_digest_invalid");
  const nonceValue = envelope.nonce;
  const receiptDigestValue = exactString(envelope.portable_receipt_digest, "portable_receipt_digest_invalid");
  return {
    schema: PORTABLE_CANARY_ADMISSION_SCHEMA_V1,
    run_id: runId,
    workflow_id: envelope.workflow_id as PortableCanaryAdmissionWorkflowId,
    provider: PORTABLE_CANARY_ADMISSION_PROVIDER,
    contract: PORTABLE_CANARY_ADMISSION_CONTRACT,
    operation: envelope.operation as PortableCanaryAdmissionOperation,
    adapter: envelope.adapter as PortableCanaryAdmissionAdapter,
    trigger: envelope.trigger as PortableCanaryAdmissionTrigger,
    request_digest: requestDigestValue,
    issued_at: issuedAt,
    expires_at: expiresAt,
    effect_free: true,
    decision: envelope.decision,
    nonce: nonceValue,
    portable_receipt_digest: receiptDigestValue
  };
}

function receiptBinding(input: { runId: string; workflowId: string; portableReceipt: PortableCanaryReceiptV1 }): string {
  if (input.portableReceipt.run_id !== input.runId || input.portableReceipt.workflow_id !== input.workflowId) {
    invalid("cross_run_receipt");
  }
  return hashIdempotencyRequest(input.portableReceipt);
}

function requestDigest(request: unknown): string {
  try {
    return hashIdempotencyRequest(request);
  } catch {
    invalid("request_digest_invalid");
  }
}

export function portableCanaryAdapterForWorkflow(workflowId: string): PortableCanaryAdmissionAdapter | null {
  switch (workflowId) {
    case "daily-ai-research-publish-run":
      return "daily_ai_registered";
    case "job-application-manager":
      return "job_submit_registered";
    case "nisenprints-daily-product-canva-printify-etsy-pinterest":
      return "nisenprints_registered";
    default:
      return null;
  }
}

export function createPortableCanaryAdmissionEnvelopeV1(input: PortableCanaryAdmissionRequest): PortableCanaryAdmissionEnvelopeV1 {
  validateTuple(input.workflowId, input.adapter, input.operation);
  validateTrigger(input.trigger);
  if (portableCanaryAdapterForWorkflow(input.workflowId) !== input.adapter) invalid("adapter_workflow_mismatch");
  const issuedAt = timestamp(input.issuedAt ?? new Date(), "issued_at_invalid");
  const expiresAt = timestamp(input.expiresAt ?? new Date(Date.parse(issuedAt) + PORTABLE_CANARY_ADMISSION_TTL_MS).toISOString(), "expires_at_invalid");
  const ttl = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (ttl <= 0 || ttl > PORTABLE_CANARY_ADMISSION_TTL_MS) invalid("ttl_invalid");
  const receiptDigest = receiptBinding(input);
  return validateEnvelope({
    schema: PORTABLE_CANARY_ADMISSION_SCHEMA_V1,
    run_id: exactString(input.runId, "run_id_invalid"),
    workflow_id: input.workflowId,
    provider: PORTABLE_CANARY_ADMISSION_PROVIDER,
    contract: PORTABLE_CANARY_ADMISSION_CONTRACT,
    operation: input.operation,
    adapter: input.adapter,
    trigger: input.trigger,
    request_digest: requestDigest(input.request),
    issued_at: issuedAt,
    expires_at: expiresAt,
    effect_free: true,
    decision: input.decision ?? "allow",
    nonce: randomBytes(32).toString("hex"),
    portable_receipt_digest: receiptDigest
  });
}

export function verifyPortableCanaryAdmissionV1(input: VerifyPortableCanaryAdmissionRequest): PortableCanaryAdmissionEvidenceV1 {
  const envelope = validateEnvelope(input.envelope);
  if (envelope.decision !== "allow") invalid("decision_denied");
  if (envelope.run_id !== input.runId || envelope.workflow_id !== input.workflowId) invalid("cross_run");
  const now = Date.parse(nowIso(input.now));
  const issued = Date.parse(envelope.issued_at);
  const expires = Date.parse(envelope.expires_at);
  if (now < issued) invalid("future");
  if (now >= expires) invalid("stale");
  if (envelope.request_digest !== requestDigest(input.request)) invalid("request_digest_mismatch");
  if (envelope.portable_receipt_digest !== receiptBinding({ runId: input.runId, workflowId: input.workflowId, portableReceipt: input.portableReceipt })) {
    invalid("portable_receipt_digest_mismatch");
  }
  if (usedNonces.has(envelope.nonce)) invalid("nonce_reuse");
  usedNonces.add(envelope.nonce);
  return validatePortableCanaryEvidenceV1({
    schema: PORTABLE_CANARY_ADMISSION_SCHEMA_V1,
    run_id: envelope.run_id,
    workflow_id: envelope.workflow_id,
    provider: envelope.provider,
    contract: envelope.contract,
    operation: envelope.operation,
    adapter: envelope.adapter,
    trigger: envelope.trigger,
    request_digest: envelope.request_digest,
    issued_at: envelope.issued_at,
    expires_at: envelope.expires_at,
    effect_free: true,
    decision: "allow",
    nonce_digest: hashIdempotencyRequest({ nonce: envelope.nonce }),
    portable_receipt_digest: envelope.portable_receipt_digest
  });
}

export function validatePortableCanaryEvidenceV1(value: unknown): PortableCanaryAdmissionEvidenceV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("evidence_invalid");
  const evidence = value as Record<string, unknown>;
  for (const key of Object.keys(evidence)) {
    if (secretLikeKey.test(key)) invalid("evidence_secret_field_forbidden");
    if (!evidenceKeys.has(key)) invalid(`evidence_unknown_field:${key}`);
  }
  if (evidence.schema !== PORTABLE_CANARY_ADMISSION_SCHEMA_V1) invalid("evidence_schema_invalid");
  exactString(evidence.run_id, "evidence_run_id_invalid");
  if (typeof evidence.workflow_id !== "string" || !admissionWorkflows.has(evidence.workflow_id)) invalid("evidence_workflow_invalid");
  if (evidence.provider !== PORTABLE_CANARY_ADMISSION_PROVIDER) invalid("evidence_provider_invalid");
  if (evidence.contract !== PORTABLE_CANARY_ADMISSION_CONTRACT) invalid("evidence_contract_invalid");
  validateTuple(evidence.workflow_id, evidence.adapter, evidence.operation);
  validateTrigger(evidence.trigger);
  exactString(evidence.request_digest, "evidence_request_digest_invalid");
  const issuedAt = timestamp(evidence.issued_at as string, "evidence_issued_at_invalid");
  const expiresAt = timestamp(evidence.expires_at as string, "evidence_expires_at_invalid");
  const evidenceTtl = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (evidenceTtl <= 0 || evidenceTtl > PORTABLE_CANARY_ADMISSION_TTL_MS) invalid("evidence_time_window_invalid");
  if (evidence.effect_free !== true || evidence.decision !== "allow") invalid("evidence_policy_invalid");
  if (typeof evidence.nonce_digest !== "string" || !/^[a-f0-9]{64}$/.test(evidence.nonce_digest)) invalid("evidence_nonce_digest_invalid");
  exactString(evidence.portable_receipt_digest, "evidence_receipt_digest_invalid");
  const evidenceRunId = exactString(evidence.run_id, "evidence_run_id_invalid");
  const evidenceRequestDigest = exactString(evidence.request_digest, "evidence_request_digest_invalid");
  const evidenceNonceDigest = evidence.nonce_digest;
  const evidenceReceiptDigest = exactString(evidence.portable_receipt_digest, "evidence_receipt_digest_invalid");
  return {
    schema: PORTABLE_CANARY_ADMISSION_SCHEMA_V1,
    run_id: evidenceRunId,
    workflow_id: evidence.workflow_id as PortableCanaryAdmissionWorkflowId,
    provider: PORTABLE_CANARY_ADMISSION_PROVIDER,
    contract: PORTABLE_CANARY_ADMISSION_CONTRACT,
    operation: evidence.operation as PortableCanaryAdmissionOperation,
    adapter: evidence.adapter as PortableCanaryAdmissionAdapter,
    trigger: evidence.trigger as PortableCanaryAdmissionTrigger,
    request_digest: evidenceRequestDigest,
    issued_at: issuedAt,
    expires_at: expiresAt,
    effect_free: true,
    decision: "allow",
    nonce_digest: evidenceNonceDigest,
    portable_receipt_digest: evidenceReceiptDigest
  };
}

export function guardNisenPrintsCanaryOperation(operation: unknown): { allowed: boolean; reason: string } {
  if (typeof operation !== "string" || operation.length === 0) return { allowed: false, reason: "operation_empty" };
  if (nisenPrintsUnsafeOperation.test(operation)) return { allowed: false, reason: "operation_unsafe" };
  if (admissionOperations.has(operation)) return { allowed: true, reason: "canary_operation_allowed" };
  return { allowed: false, reason: "operation_unknown" };
}

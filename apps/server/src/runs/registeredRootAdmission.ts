import { createHash, randomBytes, randomUUID } from "node:crypto";
import { canonicalJson } from "../automations/idempotency.js";

export const REGISTERED_ROOT_ADMISSION_SCHEMA_V1 = "aos.registered_first_class_root.v1" as const;
export const REGISTERED_ROOT_OWNER = "automation_os_control_plane" as const;
export const REGISTERED_ROOT_TTL_MS = 2 * 60 * 60 * 1000;

export type RegisteredRootSourceTrigger =
  | "automation_os_scheduler"
  | "automation_os_ui"
  | "codex_app_bridge"
  | "launchd"
  | "github_actions";

export type RegisteredRootAdmissionV1 = {
  schema: typeof REGISTERED_ROOT_ADMISSION_SCHEMA_V1;
  root_kind: "aos_registered_control_plane";
  first_class_root: true;
  root_id: string;
  registered_automation_id: string;
  workflow_id: string;
  run_id: string;
  source_trigger: RegisteredRootSourceTrigger;
  issuer: typeof REGISTERED_ROOT_OWNER;
  owner: typeof REGISTERED_ROOT_OWNER;
  thread_source: RegisteredRootSourceTrigger;
  thread_source_attested: true;
  external_effect_authority: false;
  capability_mode: "read_only";
  external_action_executed: false;
  definition_fingerprint: string;
  issued_at: string;
  expires_at: string;
  nonce: string;
  root_digest: string;
};

export type RegisteredRootAdmissionInputV1 = {
  registeredAutomationId: string;
  workflowId: string;
  runId: string;
  sourceTrigger: RegisteredRootSourceTrigger;
  definitionFingerprint: string;
  now?: string | Date;
  ttlMs?: number;
};

export type RegisteredRootAdmissionExpectationV1 = {
  registeredAutomationId?: string;
  workflowId?: string;
  runId?: string;
  sourceTrigger?: RegisteredRootSourceTrigger;
};

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const fingerprintPattern = /^[a-f0-9]{64}$/u;
const noncePattern = /^[a-f0-9]{64}$/u;
const triggers = new Set<RegisteredRootSourceTrigger>([
  "automation_os_scheduler",
  "automation_os_ui",
  "codex_app_bridge",
  "launchd",
  "github_actions"
]);

const allowedFields = new Set([
  "schema",
  "root_kind",
  "first_class_root",
  "root_id",
  "registered_automation_id",
  "workflow_id",
  "run_id",
  "source_trigger",
  "issuer",
  "owner",
  "thread_source",
  "thread_source_attested",
  "external_effect_authority",
  "capability_mode",
  "external_action_executed",
  "definition_fingerprint",
  "issued_at",
  "expires_at",
  "nonce",
  "root_digest"
]);

function fail(reason: string): never {
  throw new Error(`registered_root_admission_invalid:${reason}`);
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) fail(`${field}_invalid`);
  return value;
}

function timestamp(value: string | Date, field: string): string {
  const raw = value instanceof Date ? value.toISOString() : value;
  if (typeof raw !== "string" || !raw.trim() || Number.isNaN(Date.parse(raw))) fail(`${field}_invalid`);
  return raw;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function rootPayload(value: Omit<RegisteredRootAdmissionV1, "root_digest">): Omit<RegisteredRootAdmissionV1, "root_digest"> {
  return value;
}

function parse(value: unknown, nowMs = Date.now(), expected?: RegisteredRootAdmissionExpectationV1): RegisteredRootAdmissionV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("object_required");
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) if (!allowedFields.has(key)) fail(`unknown_field:${key}`);
  if (body.schema !== REGISTERED_ROOT_ADMISSION_SCHEMA_V1) fail("schema_invalid");
  if (body.root_kind !== "aos_registered_control_plane") fail("root_kind_invalid");
  if (body.first_class_root !== true) fail("first_class_root_required");
  if (body.issuer !== REGISTERED_ROOT_OWNER || body.owner !== REGISTERED_ROOT_OWNER) fail("owner_invalid");
  if (body.thread_source_attested !== true) fail("thread_source_attestation_required");
  if (body.external_effect_authority !== false) fail("external_effect_authority_forbidden");
  if (body.capability_mode !== "read_only") fail("capability_mode_invalid");
  if (body.external_action_executed !== false) fail("external_action_forbidden");

  const sourceTrigger = body.source_trigger;
  if (typeof sourceTrigger !== "string" || !triggers.has(sourceTrigger as RegisteredRootSourceTrigger)) fail("source_trigger_invalid");
  if (body.thread_source !== sourceTrigger) fail("thread_source_binding_mismatch");

  const normalized: Omit<RegisteredRootAdmissionV1, "root_digest"> = {
    schema: REGISTERED_ROOT_ADMISSION_SCHEMA_V1,
    root_kind: "aos_registered_control_plane",
    first_class_root: true,
    root_id: identifier(body.root_id, "root_id"),
    registered_automation_id: identifier(body.registered_automation_id, "registered_automation_id"),
    workflow_id: identifier(body.workflow_id, "workflow_id"),
    run_id: identifier(body.run_id, "run_id"),
    source_trigger: sourceTrigger as RegisteredRootSourceTrigger,
    issuer: REGISTERED_ROOT_OWNER,
    owner: REGISTERED_ROOT_OWNER,
    thread_source: sourceTrigger as RegisteredRootSourceTrigger,
    thread_source_attested: true,
    external_effect_authority: false,
    capability_mode: "read_only",
    external_action_executed: false,
    definition_fingerprint: typeof body.definition_fingerprint === "string" && fingerprintPattern.test(body.definition_fingerprint)
      ? body.definition_fingerprint
      : fail("definition_fingerprint_invalid"),
    issued_at: timestamp(body.issued_at as string, "issued_at"),
    expires_at: timestamp(body.expires_at as string, "expires_at"),
    nonce: typeof body.nonce === "string" && noncePattern.test(body.nonce) ? body.nonce : fail("nonce_invalid")
  };
  const issuedMs = Date.parse(normalized.issued_at);
  const expiresMs = Date.parse(normalized.expires_at);
  if (expiresMs <= issuedMs) fail("expiry_order_invalid");
  if (expiresMs - issuedMs > REGISTERED_ROOT_TTL_MS) fail("ttl_exceeded");
  if (issuedMs > nowMs + 60_000) fail("issued_at_future");
  if (expiresMs <= nowMs) fail("expired");
  const rootDigest = body.root_digest;
  if (typeof rootDigest !== "string" || !fingerprintPattern.test(rootDigest) || rootDigest !== digest(rootPayload(normalized))) {
    fail("root_digest_invalid");
  }

  const checks: Array<[keyof RegisteredRootAdmissionExpectationV1, keyof Omit<RegisteredRootAdmissionV1, "root_digest">]> = [
    ["registeredAutomationId", "registered_automation_id"],
    ["workflowId", "workflow_id"],
    ["runId", "run_id"],
    ["sourceTrigger", "source_trigger"]
  ];
  for (const [expectedKey, actualKey] of checks) {
    const expectedValue = expected?.[expectedKey];
    if (expectedValue !== undefined && normalized[actualKey] !== expectedValue) fail(`${actualKey}_binding_mismatch`);
  }
  return { ...normalized, root_digest: rootDigest };
}

export function createRegisteredRootAdmissionV1(input: RegisteredRootAdmissionInputV1): RegisteredRootAdmissionV1 {
  const ttlMs = input.ttlMs ?? REGISTERED_ROOT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > REGISTERED_ROOT_TTL_MS) fail("ttl_invalid");
  const issuedAt = timestamp(input.now ?? new Date(), "issued_at");
  const root: Omit<RegisteredRootAdmissionV1, "root_digest"> = {
    schema: REGISTERED_ROOT_ADMISSION_SCHEMA_V1,
    root_kind: "aos_registered_control_plane",
    first_class_root: true,
    root_id: `root-${randomUUID()}`,
    registered_automation_id: identifier(input.registeredAutomationId, "registered_automation_id"),
    workflow_id: identifier(input.workflowId, "workflow_id"),
    run_id: identifier(input.runId, "run_id"),
    source_trigger: input.sourceTrigger,
    issuer: REGISTERED_ROOT_OWNER,
    owner: REGISTERED_ROOT_OWNER,
    thread_source: input.sourceTrigger,
    thread_source_attested: true,
    external_effect_authority: false,
    capability_mode: "read_only",
    external_action_executed: false,
    definition_fingerprint: fingerprintPattern.test(input.definitionFingerprint) ? input.definitionFingerprint : fail("definition_fingerprint_invalid"),
    issued_at: issuedAt,
    expires_at: new Date(Date.parse(issuedAt) + ttlMs).toISOString(),
    nonce: randomBytes(32).toString("hex")
  };
  return parse({ ...root, root_digest: digest(rootPayload(root)) }, Date.parse(issuedAt), {
    registeredAutomationId: root.registered_automation_id,
    workflowId: root.workflow_id,
    runId: root.run_id,
    sourceTrigger: root.source_trigger
  });
}

export function validateRegisteredRootAdmissionV1(
  value: unknown,
  expected?: RegisteredRootAdmissionExpectationV1,
  nowMs = Date.now()
): RegisteredRootAdmissionV1 {
  return parse(value, nowMs, expected);
}

export function registeredRootAdmissionDigest(value: RegisteredRootAdmissionV1): string {
  return value.root_digest;
}

import { createHash } from "node:crypto";

export const SERVICE_READINESS_CLEANUP_RECEIPT_SCHEMA_V1 = "service_readiness_cleanup_receipt.v1" as const;
export const SERVICE_READINESS_BROWSER_USE_CLEANUP_RECEIPT_SCHEMA_V1 = "service_readiness_browser_use_cleanup_receipt.v1" as const;

export type ServiceReadinessBrowserUseCleanupReceiptV1 = {
  schema: typeof SERVICE_READINESS_BROWSER_USE_CLEANUP_RECEIPT_SCHEMA_V1;
  root_id: string;
  workflow_id: "daily-ai" | "job-application-manager" | "nisenprints";
  run_id: string;
  stage_id: string;
  attempt_id: string;
  authority_digest: string;
  requested_session_id: string;
  effective_session_id: string;
  profile_root: string;
  reserved_port: number;
  lock_path: string;
  process_identity: string;
  surface: "browser_use_cli";
  status: "verified";
  readback_status: "verified";
  no_residual_processes: true;
  no_external_action: true;
  external_action_executed: false;
  legacy_surfaces_forbidden: true;
  prior_receipt_reuse: false;
  artifact_uri: string;
  created_at: string;
};

export type ServiceReadinessCleanupReceiptV1 = {
  schema: typeof SERVICE_READINESS_CLEANUP_RECEIPT_SCHEMA_V1;
  root_id: string;
  workflow_id: "daily-ai" | "job-application-manager" | "nisenprints";
  run_id: string;
  stage_id: string;
  attempt_id: string;
  fencing_token: number;
  surface: "in_app_browser";
  capability_mode: "read_only";
  status: "verified";
  no_residual_processes: true;
  no_external_action: true;
  external_action_executed: false;
  legacy_surfaces_forbidden: true;
  prior_receipt_reuse: false;
  artifact_uri: string;
  created_at: string;
};

export type ServiceReadinessCleanupReceiptInputV1 = Omit<
  ServiceReadinessCleanupReceiptV1,
  "schema" | "surface" | "capability_mode" | "status" | "no_residual_processes" | "no_external_action" |
    "external_action_executed" | "legacy_surfaces_forbidden" | "prior_receipt_reuse"
>;

export type ServiceReadinessCleanupReceiptValidationResultV1 =
  | { ok: true; status: "ok"; value: ServiceReadinessCleanupReceiptV1 }
  | { ok: false; status: "blocked"; exact_blocker: string };

const identifiers = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const workflows = new Set<ServiceReadinessCleanupReceiptV1["workflow_id"]>([
  "daily-ai",
  "job-application-manager",
  "nisenprints"
]);
const allowedFields = new Set([
  "schema", "root_id", "workflow_id", "run_id", "stage_id", "attempt_id", "fencing_token", "surface",
  "capability_mode", "status", "no_residual_processes", "no_external_action", "external_action_executed",
  "legacy_surfaces_forbidden", "prior_receipt_reuse", "artifact_uri", "created_at"
]);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("service_readiness_cleanup_receipt_required");
  return value as Record<string, unknown>;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !identifiers.test(value)) throw new Error(`service_readiness_cleanup_${field}_invalid`);
  return value;
}

function requiredHashLikeUri(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("service_readiness_cleanup_artifact_uri_invalid");
  }
  if (!value.startsWith("file://")) throw new Error("service_readiness_cleanup_artifact_uri_invalid");
  return value;
}

function iso(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || new Date(value).toISOString() !== value) {
    throw new Error("service_readiness_cleanup_created_at_invalid");
  }
  return value;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error("service_readiness_cleanup_fencing_token_invalid");
  return Number(value);
}

function parse(value: unknown): ServiceReadinessCleanupReceiptV1 {
  const body = record(value);
  const unknown = Object.keys(body).filter((key) => !allowedFields.has(key));
  if (unknown.length > 0) throw new Error(`service_readiness_cleanup_receipt_unknown_field:${unknown.sort().join(",")}`);
  if (body.schema !== SERVICE_READINESS_CLEANUP_RECEIPT_SCHEMA_V1) throw new Error("service_readiness_cleanup_receipt_schema_invalid");
  const workflowId = identifier(body.workflow_id, "workflow_id") as ServiceReadinessCleanupReceiptV1["workflow_id"];
  if (!workflows.has(workflowId)) throw new Error("service_readiness_cleanup_workflow_id_invalid");
  if (body.surface !== "in_app_browser" || body.capability_mode !== "read_only") throw new Error("service_readiness_cleanup_surface_invalid");
  if (body.status !== "verified") throw new Error("service_readiness_cleanup_status_invalid");
  if (body.no_residual_processes !== true || body.no_external_action !== true) throw new Error("service_readiness_cleanup_incomplete");
  if (body.external_action_executed !== false) throw new Error("service_readiness_cleanup_external_action_forbidden");
  if (body.legacy_surfaces_forbidden !== true || body.prior_receipt_reuse !== false) throw new Error("service_readiness_cleanup_legacy_or_reuse_forbidden");
  return {
    schema: SERVICE_READINESS_CLEANUP_RECEIPT_SCHEMA_V1,
    root_id: identifier(body.root_id, "root_id"),
    workflow_id: workflowId,
    run_id: identifier(body.run_id, "run_id"),
    stage_id: identifier(body.stage_id, "stage_id"),
    attempt_id: identifier(body.attempt_id, "attempt_id"),
    fencing_token: integer(body.fencing_token),
    surface: "in_app_browser",
    capability_mode: "read_only",
    status: "verified",
    no_residual_processes: true,
    no_external_action: true,
    external_action_executed: false,
    legacy_surfaces_forbidden: true,
    prior_receipt_reuse: false,
    artifact_uri: requiredHashLikeUri(body.artifact_uri),
    created_at: iso(body.created_at)
  };
}

/** Build a cleanup proof only from explicit no-residual/no-effect evidence. */
export function buildServiceReadinessCleanupReceiptV1(input: ServiceReadinessCleanupReceiptInputV1): ServiceReadinessCleanupReceiptV1 {
  return parse({
    schema: SERVICE_READINESS_CLEANUP_RECEIPT_SCHEMA_V1,
    ...input,
    surface: "in_app_browser",
    capability_mode: "read_only",
    status: "verified",
    no_residual_processes: true,
    no_external_action: true,
    external_action_executed: false,
    legacy_surfaces_forbidden: true,
    prior_receipt_reuse: false
  });
}

export function canonicalServiceReadinessCleanupReceiptJson(value: ServiceReadinessCleanupReceiptV1): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))));
}

export function hashServiceReadinessCleanupReceiptV1(value: ServiceReadinessCleanupReceiptV1): string {
  return createHash("sha256").update(canonicalServiceReadinessCleanupReceiptJson(value), "utf8").digest("hex");
}

export function validateServiceReadinessCleanupReceiptV1(value: unknown): ServiceReadinessCleanupReceiptValidationResultV1 {
  try {
    return { ok: true, status: "ok", value: parse(value) };
  } catch (error) {
    return { ok: false, status: "blocked", exact_blocker: error instanceof Error ? error.message : "service_readiness_cleanup_receipt_invalid" };
  }
}

export function assertServiceReadinessCleanupReceiptMatches(
  actual: ServiceReadinessCleanupReceiptV1,
  expected: Pick<ServiceReadinessCleanupReceiptV1, "root_id" | "workflow_id" | "run_id" | "stage_id" | "attempt_id" | "fencing_token">
): void {
  for (const field of ["root_id", "workflow_id", "run_id", "stage_id", "attempt_id", "fencing_token"] as const) {
    if (actual[field] !== expected[field]) throw new Error(`service_readiness_cleanup_receipt_binding_mismatch:${field}`);
  }
}

const browserUseCleanupFields = new Set([
  "schema", "root_id", "workflow_id", "run_id", "stage_id", "attempt_id", "authority_digest",
  "requested_session_id", "effective_session_id", "profile_root", "reserved_port", "lock_path",
  "process_identity", "surface", "status", "readback_status", "no_residual_processes", "no_external_action",
  "external_action_executed", "legacy_surfaces_forbidden", "prior_receipt_reuse", "artifact_uri", "created_at"
]);

function browserUseHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`service_readiness_browser_use_cleanup_${field}_invalid`);
  return value;
}

function browserUsePath(value: unknown, field: string, root: string): string {
  if (typeof value !== "string" || !value.startsWith(root + "/") || value.includes("..") || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`service_readiness_browser_use_cleanup_${field}_invalid`);
  }
  return value;
}

export function buildServiceReadinessBrowserUseCleanupReceiptV1(input: {
  root_id: string;
  workflow_id: ServiceReadinessBrowserUseCleanupReceiptV1["workflow_id"];
  run_id: string;
  stage_id: string;
  attempt_id: string;
  authority_digest: string;
  requested_session_id: string;
  effective_session_id: string;
  profile_root: string;
  reserved_port: number;
  lock_path: string;
  process_identity: string;
  artifact_uri: string;
  created_at: string;
}): ServiceReadinessBrowserUseCleanupReceiptV1 {
  if (!workflows.has(input.workflow_id)) throw new Error("service_readiness_browser_use_cleanup_workflow_id_invalid");
  const reservedPort = input.reserved_port;
  if (!Number.isSafeInteger(reservedPort) || reservedPort < 19880 || reservedPort > 19999) throw new Error("service_readiness_browser_use_cleanup_port_invalid");
  const profile = browserUsePath(input.profile_root, "profile_root", "/Users/nichikatanaka/.codex/browser-use/profiles");
  const lock = browserUsePath(input.lock_path, "lock_path", "/Users/nichikatanaka/.codex/browser-use/locks");
  if (!identifiers.test(input.root_id) || !identifiers.test(input.run_id) || !identifiers.test(input.stage_id) || !identifiers.test(input.attempt_id) || !identifiers.test(input.requested_session_id) || !identifiers.test(input.effective_session_id) || !identifiers.test(input.process_identity)) {
    throw new Error("service_readiness_browser_use_cleanup_binding_invalid");
  }
  return {
    schema: SERVICE_READINESS_BROWSER_USE_CLEANUP_RECEIPT_SCHEMA_V1,
    root_id: input.root_id,
    workflow_id: input.workflow_id,
    run_id: input.run_id,
    stage_id: input.stage_id,
    attempt_id: input.attempt_id,
    authority_digest: browserUseHash(input.authority_digest, "authority_digest"),
    requested_session_id: input.requested_session_id,
    effective_session_id: input.effective_session_id,
    profile_root: profile,
    reserved_port: reservedPort,
    lock_path: lock,
    process_identity: input.process_identity,
    surface: "browser_use_cli",
    status: "verified",
    readback_status: "verified",
    no_residual_processes: true,
    no_external_action: true,
    external_action_executed: false,
    legacy_surfaces_forbidden: true,
    prior_receipt_reuse: false,
    artifact_uri: requiredHashLikeUri(input.artifact_uri),
    created_at: iso(input.created_at)
  };
}

export function parseServiceReadinessBrowserUseCleanupReceiptV1(value: unknown): ServiceReadinessBrowserUseCleanupReceiptV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("service_readiness_browser_use_cleanup_receipt_required");
  const body = value as Record<string, unknown>;
  const unknown = Object.keys(body).filter((key) => !browserUseCleanupFields.has(key));
  if (unknown.length > 0) throw new Error(`service_readiness_browser_use_cleanup_unknown_field:${unknown.sort().join(",")}`);
  if (body.schema !== SERVICE_READINESS_BROWSER_USE_CLEANUP_RECEIPT_SCHEMA_V1 || body.surface !== "browser_use_cli") throw new Error("service_readiness_browser_use_cleanup_surface_invalid");
  if (body.status !== "verified" || body.readback_status !== "verified" || body.no_residual_processes !== true || body.no_external_action !== true || body.external_action_executed !== false || body.legacy_surfaces_forbidden !== true || body.prior_receipt_reuse !== false) throw new Error("service_readiness_browser_use_cleanup_incomplete");
  return buildServiceReadinessBrowserUseCleanupReceiptV1({
    root_id: body.root_id as string,
    workflow_id: body.workflow_id as ServiceReadinessBrowserUseCleanupReceiptV1["workflow_id"],
    run_id: body.run_id as string,
    stage_id: body.stage_id as string,
    attempt_id: body.attempt_id as string,
    authority_digest: body.authority_digest as string,
    requested_session_id: body.requested_session_id as string,
    effective_session_id: body.effective_session_id as string,
    profile_root: body.profile_root as string,
    reserved_port: body.reserved_port as number,
    lock_path: body.lock_path as string,
    process_identity: body.process_identity as string,
    artifact_uri: body.artifact_uri as string,
    created_at: body.created_at as string
  });
}

export function validateServiceReadinessBrowserUseCleanupReceiptV1(value: unknown): { ok: true; status: "ok"; value: ServiceReadinessBrowserUseCleanupReceiptV1 } | { ok: false; status: "blocked"; exact_blocker: string } {
  try {
    return { ok: true, status: "ok", value: parseServiceReadinessBrowserUseCleanupReceiptV1(value) };
  } catch (error) {
    return { ok: false, status: "blocked", exact_blocker: error instanceof Error ? error.message : "service_readiness_browser_use_cleanup_invalid" };
  }
}

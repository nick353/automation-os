import {
  parseIabRootStageBindingV1,
  validateIabRootStageBindingV1,
  type IabRootStageBindingV1
} from "./iabRootBinding.js";
import type { IabIdentity } from "../browser/iabReadOnlyBridge.js";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  BROWSER_USE_LOCK_ROOT,
  BROWSER_USE_SCHEDULED_PROFILE_ROOT,
  BROWSER_USE_SINGLE_USE_PROFILE_ROOT,
  BROWSER_USE_TEMPORARY_PROFILE_ROOT
} from "./browserUseCanonical.js";

/**
 * Durable run/attempt identity for the service-readiness boundary.
 *
 * This is deliberately a non-executing envelope.  It gives the queue, worker,
 * proof, and canary paths one stable identity to read back, while a missing
 * IAB identity remains an explicit safe-stop.  It never creates a browser
 * handle, consumes a receipt, calls a provider, or reserves the effect ledger.
 */
export const SERVICE_READINESS_RUNTIME_BINDING_SCHEMA_V1 = "service_readiness_runtime_binding.v1" as const;
export const SERVICE_READINESS_BROWSER_USE_RUNTIME_BINDING_SCHEMA_V1 = "service_readiness_browser_use_runtime_binding.v1" as const;
export const SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_CONTRACT_SCHEMA_V1 = "browser_use_authorized_adapter_contract.v1" as const;
export const SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_CONTRACT_BLOCKER = "p6_authorized_browser_use_cli_adapter_contract_unverified" as const;
export const SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_IDENTITY_V1 = "browser-use-cli-stage-adapter.v1" as const;
export const SERVICE_READINESS_RUNTIME_BINDING_BLOCKER = "in_app_browser_runtime_unavailable" as const;

export type ServiceReadinessReferenceWorkflowId = "daily-ai" | "job-application-manager" | "nisenprints";
export type ServiceReadinessRuntimeBindingStatusV1 = "bound" | "blocked";

export type ServiceReadinessBrowserUseRuntimeBindingV1 = {
  schema: typeof SERVICE_READINESS_BROWSER_USE_RUNTIME_BINDING_SCHEMA_V1;
  surface: "browser_use_cli";
  root_id: string;
  workflow_id: ServiceReadinessReferenceWorkflowId;
  run_id: string;
  stage_id: string;
  attempt_id: string;
  authority_digest: string | null;
  requested_session_id: string | null;
  effective_session_id: string | null;
  profile_root: string | null;
  reserved_port: number | null;
  lock_path: string | null;
  process_identity: string | null;
  readback_status: "required" | "verified" | "missing";
  mode: "public" | "authorized";
  status: ServiceReadinessRuntimeBindingStatusV1;
  exact_blocker: string | null;
  external_action_executed: false;
  legacy_surfaces_forbidden: true;
  prior_receipt_reuse: false;
};

/**
 * Pure, non-executing capability fact for the authorized Browser Use adapter.
 *
 * This is intentionally separate from the runtime binding: it describes the
 * adapter contract a worker may hand off to, but it never creates a process,
 * reads a browser state, or authorizes an external action.
 */
export type ServiceReadinessBrowserUseAuthorizedAdapterContractV1 = {
  schema: typeof SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_CONTRACT_SCHEMA_V1;
  browser_surface: "browser_use_cli";
  mode: "authorized";
  adapter_identity: typeof SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_IDENTITY_V1;
  authorized_scheduled_lifecycle: true;
  structured_start_descriptor: true;
  pre_open_descriptor_validation: true;
  run_stage_attempt_session_binding: true;
  authority_digest_binding: true;
  allowed_origin_action_binding: true;
  artifact_binding: true;
  runtime_home_binding: true;
  bounded_result_format: true;
  no_fallback: true;
  run_id: string;
  stage_id: string;
  attempt_id: string;
  session_id: string;
  authority_digest: string;
  allowed_origin: string;
  external_action_executed: false;
  legacy_surfaces_forbidden: true;
  prior_receipt_reuse: false;
};

export type ServiceReadinessBrowserUseAuthorizedAdapterContractExpectedV1 = Pick<
  ServiceReadinessBrowserUseAuthorizedAdapterContractV1,
  "run_id" | "stage_id" | "attempt_id" | "session_id" | "authority_digest" | "allowed_origin"
>;

export type ServiceReadinessRuntimeBindingV1 = {
  schema: typeof SERVICE_READINESS_RUNTIME_BINDING_SCHEMA_V1;
  surface: "in_app_browser";
  root_id: string;
  workflow_id: ServiceReadinessReferenceWorkflowId;
  run_id: string;
  stage_id: string;
  attempt_id: string;
  fencing_token: number;
  effect_key: string | null;
  capability_id: string | null;
  turn_id: string | null;
  session_id: string | null;
  nonce: string | null;
  iab_identity: IabIdentity | null;
  capability_mode: "read_only";
  status: ServiceReadinessRuntimeBindingStatusV1;
  exact_blocker: string | null;
  external_action_executed: false;
  legacy_surfaces_forbidden: true;
  prior_receipt_reuse: false;
};

export type ServiceReadinessRuntimeBindingInputV1 = {
  root_id: string;
  workflow_id: string;
  run_id: string;
  stage_id: string;
  attempt_id: string;
  fencing_token: number;
  effect_key?: string | null;
  capability_id?: string | null;
  iab_identity?: IabIdentity | null;
  browser_use?: {
    authority_digest: string;
    requested_session_id: string;
    effective_session_id?: string | null;
    profile_root: string;
    reserved_port: number;
    lock_path: string;
    process_identity?: string | null;
    readback_status?: "required" | "verified" | "missing";
    mode: "public" | "authorized";
  } | null;
  legacy_markers?: Record<string, unknown> | null;
};

export type ServiceReadinessRuntimeBindingValidationResultV1 =
  | { ok: true; status: "ok"; value: ServiceReadinessRuntimeBindingV1 }
  | { ok: false; status: "blocked"; exact_blocker: string };

export type ServiceReadinessRuntimeBindingExpectedV1 = Pick<
  ServiceReadinessRuntimeBindingV1,
  "root_id" | "workflow_id" | "run_id" | "stage_id" | "attempt_id" | "fencing_token" | "effect_key"
>;

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const browserUseProfileRoots = [
  BROWSER_USE_SCHEDULED_PROFILE_ROOT,
  BROWSER_USE_SINGLE_USE_PROFILE_ROOT,
  BROWSER_USE_TEMPORARY_PROFILE_ROOT
];
const browserUseLockRoot = BROWSER_USE_LOCK_ROOT;
const referenceWorkflows = new Set<ServiceReadinessReferenceWorkflowId>([
  "daily-ai",
  "job-application-manager",
  "nisenprints"
]);
const registeredWorkflowAliases: Record<string, ServiceReadinessReferenceWorkflowId> = {
  "daily-ai-research-publish-run": "daily-ai",
  "job-application-manager": "job-application-manager",
  "nisenprints-daily-product-canva-printify-etsy-pinterest": "nisenprints"
};
const legacyMarkerFields = new Set([
  "browser_handle",
  "browser_surface",
  "browser_driver",
  "legacy_surface",
  "legacy_primary_surface",
  "legacy_receipt",
  "old_receipt",
  "old_receipt_hash",
  "receipt_reuse",
  "stale_request_id",
  "old_request_id",
  "chrome_extension",
  "playwright",
  "playwright_cli",
  "browser_use"
]);

function requiredIdentifier(value: unknown, code: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) throw new Error(code);
  return value;
}

function nullableIdentifier(value: unknown, code: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredIdentifier(value, code);
}

function nullableHash(value: unknown, code: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !hashPattern.test(value)) throw new Error(code);
  return value;
}

function referenceWorkflow(value: unknown): ServiceReadinessReferenceWorkflowId {
  const workflowId = requiredIdentifier(value, "service_readiness_runtime_workflow_id_invalid");
  if (!referenceWorkflows.has(workflowId as ServiceReadinessReferenceWorkflowId)) {
    throw new Error("service_readiness_runtime_workflow_not_reference");
  }
  return workflowId as ServiceReadinessReferenceWorkflowId;
}

function fencingToken(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 100000) {
    throw new Error("service_readiness_runtime_fencing_token_invalid");
  }
  return Number(value);
}

function assertNoLegacyMarkers(value: Record<string, unknown> | null | undefined): void {
  if (!value) return;
  const marker = Object.keys(value).find((key) => legacyMarkerFields.has(key));
  if (marker) throw new Error(`iab_external_effect_capability_not_implemented:${marker}`);
}

function rootBindingFor(input: {
  root_id: string;
  workflow_id: ServiceReadinessReferenceWorkflowId;
  run_id: string;
  stage_id: string;
  attempt_id: string;
  fencing_token: number;
  effect_key: string;
  capability_id: string;
  iab_identity: IabIdentity;
}): IabRootStageBindingV1 {
  return parseIabRootStageBindingV1({
    schema: "service_readiness_iab_root_binding.v1",
    surface: "in_app_browser",
    root_id: input.root_id,
    workflow_id: input.workflow_id,
    run_id: input.run_id,
    stage_id: input.stage_id,
    attempt_id: input.attempt_id,
    fencing_token: input.fencing_token,
    capability_id: input.capability_id,
    turn_id: input.iab_identity.turn_id,
    session_id: input.iab_identity.session_id,
    nonce: input.iab_identity.nonce,
    iab_identity: input.iab_identity,
    capability_mode: "read_only",
    effect_class: "internal_idempotent",
    effect_key: input.effect_key,
    external_action_executed: false,
    legacy_surfaces_forbidden: true,
    prior_receipt_reuse: false
  });
}

function browserUsePathInside(base: string, candidate: string): boolean {
  const rel = relative(resolve(base), resolve(candidate));
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("..");
}

function browserUseProfilePath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.split(sep).includes("..")) throw new Error("service_readiness_browser_use_profile_invalid");
  const profile = resolve(value);
  if (!browserUseProfileRoots.some((root) => browserUsePathInside(root, profile))) throw new Error("service_readiness_browser_use_profile_invalid");
  return profile;
}

function browserUseLockPath(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.split(sep).includes("..")) throw new Error("service_readiness_browser_use_lock_invalid");
  const lock = resolve(value);
  if (!browserUsePathInside(browserUseLockRoot, lock)) throw new Error("service_readiness_browser_use_lock_invalid");
  return lock;
}

/** Build a Browser Use binding without creating a session or launching a helper. */
export function buildServiceReadinessBrowserUseRuntimeBindingV1(input: {
  root_id: string;
  workflow_id: string;
  run_id: string;
  stage_id: string;
  attempt_id: string;
  authority_digest: string;
  requested_session_id: string;
  effective_session_id?: string | null;
  profile_root: string;
  reserved_port: number;
  lock_path: string;
  process_identity?: string | null;
  readback_status?: "required" | "verified" | "missing";
  mode: "public" | "authorized";
}): ServiceReadinessBrowserUseRuntimeBindingV1 {
  const workflowId = referenceWorkflow(input.workflow_id);
  const rootId = requiredIdentifier(input.root_id, "service_readiness_browser_use_root_id_invalid");
  const runId = requiredIdentifier(input.run_id, "service_readiness_browser_use_run_id_invalid");
  const stageId = requiredIdentifier(input.stage_id, "service_readiness_browser_use_stage_id_invalid");
  const attemptId = requiredIdentifier(input.attempt_id, "service_readiness_browser_use_attempt_id_invalid");
  if (!hashPattern.test(input.authority_digest)) throw new Error("service_readiness_browser_use_authority_digest_invalid");
  const requested = requiredIdentifier(input.requested_session_id, "service_readiness_browser_use_requested_session_invalid");
  const effective = input.effective_session_id == null ? null : requiredIdentifier(input.effective_session_id, "service_readiness_browser_use_effective_session_invalid");
  const profile = browserUseProfilePath(input.profile_root);
  const lock = browserUseLockPath(input.lock_path);
  const minPort = input.mode === "public" ? 19980 : 19880;
  if (!Number.isSafeInteger(input.reserved_port) || input.reserved_port < minPort || input.reserved_port > 19999) throw new Error("service_readiness_browser_use_port_invalid");
  const readback = input.readback_status ?? "required";
  if (!["required", "verified", "missing"].includes(readback)) throw new Error("service_readiness_browser_use_readback_status_invalid");
  const processIdentity = input.process_identity == null ? null : requiredIdentifier(input.process_identity, "service_readiness_browser_use_process_identity_invalid");
  const blocked = !effective || readback !== "verified" || !processIdentity;
  return {
    schema: SERVICE_READINESS_BROWSER_USE_RUNTIME_BINDING_SCHEMA_V1,
    surface: "browser_use_cli",
    root_id: rootId,
    workflow_id: workflowId,
    run_id: runId,
    stage_id: stageId,
    attempt_id: attemptId,
    authority_digest: input.authority_digest,
    requested_session_id: requested,
    effective_session_id: effective,
    profile_root: profile,
    reserved_port: input.reserved_port,
    lock_path: lock,
    process_identity: processIdentity,
    readback_status: readback,
    mode: input.mode,
    status: blocked ? "blocked" : "bound",
    exact_blocker: blocked ? (!effective ? "service_readiness_browser_use_effective_session_missing" : readback !== "verified" ? "service_readiness_browser_use_readback_required" : "service_readiness_browser_use_process_identity_missing") : null,
    external_action_executed: false,
    legacy_surfaces_forbidden: true,
    prior_receipt_reuse: false
  };
}

export function parseServiceReadinessBrowserUseRuntimeBindingV1(value: unknown): ServiceReadinessBrowserUseRuntimeBindingV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("service_readiness_browser_use_binding_required");
  const body = value as Record<string, unknown>;
  const allowed = new Set(["schema", "surface", "root_id", "workflow_id", "run_id", "stage_id", "attempt_id", "authority_digest", "requested_session_id", "effective_session_id", "profile_root", "reserved_port", "lock_path", "process_identity", "readback_status", "mode", "status", "exact_blocker", "external_action_executed", "legacy_surfaces_forbidden", "prior_receipt_reuse"]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`service_readiness_browser_use_binding_unknown_field:${unknown.sort().join(",")}`);
  if (body.schema !== SERVICE_READINESS_BROWSER_USE_RUNTIME_BINDING_SCHEMA_V1 || body.surface !== "browser_use_cli") throw new Error("service_readiness_browser_use_binding_surface_invalid");
  if (body.external_action_executed !== false || body.legacy_surfaces_forbidden !== true || body.prior_receipt_reuse !== false) throw new Error("service_readiness_browser_use_binding_legacy_or_effect_invalid");
  if (body.status !== "bound" && body.status !== "blocked") throw new Error("service_readiness_browser_use_status_invalid");
  if (body.mode !== "public" && body.mode !== "authorized") throw new Error("service_readiness_browser_use_mode_invalid");
  const built = buildServiceReadinessBrowserUseRuntimeBindingV1({
    root_id: body.root_id as string,
    workflow_id: body.workflow_id as string,
    run_id: body.run_id as string,
    stage_id: body.stage_id as string,
    attempt_id: body.attempt_id as string,
    authority_digest: body.authority_digest as string,
    requested_session_id: body.requested_session_id as string,
    effective_session_id: body.effective_session_id as string | null | undefined,
    profile_root: body.profile_root as string,
    reserved_port: body.reserved_port as number,
    lock_path: body.lock_path as string,
    process_identity: body.process_identity as string | null | undefined,
    readback_status: body.readback_status as "required" | "verified" | "missing" | undefined,
    mode: body.mode as "public" | "authorized"
  });
  if (built.status !== body.status || built.exact_blocker !== body.exact_blocker) throw new Error("service_readiness_browser_use_binding_status_mismatch");
  return built;
}

export function validateServiceReadinessBrowserUseRuntimeBindingV1(value: unknown): { ok: true; status: "ok"; value: ServiceReadinessBrowserUseRuntimeBindingV1 } | { ok: false; status: "blocked"; exact_blocker: string } {
  try {
    return { ok: true, status: "ok", value: parseServiceReadinessBrowserUseRuntimeBindingV1(value) };
  } catch (error) {
    return { ok: false, status: "blocked", exact_blocker: error instanceof Error ? error.message : "service_readiness_browser_use_binding_invalid" };
  }
}

const browserUseAuthorizedAdapterContractFields = new Set([
  "schema",
  "browser_surface",
  "mode",
  "adapter_identity",
  "authorized_scheduled_lifecycle",
  "structured_start_descriptor",
  "pre_open_descriptor_validation",
  "run_stage_attempt_session_binding",
  "authority_digest_binding",
  "allowed_origin_action_binding",
  "artifact_binding",
  "runtime_home_binding",
  "bounded_result_format",
  "no_fallback",
  "run_id",
  "stage_id",
  "attempt_id",
  "session_id",
  "authority_digest",
  "allowed_origin",
  "external_action_executed",
  "legacy_surfaces_forbidden",
  "prior_receipt_reuse"
]);

function browserUseAuthorizedAdapterContractFailure(): { ok: false; status: "blocked"; exact_blocker: typeof SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_CONTRACT_BLOCKER } {
  return {
    ok: false,
    status: "blocked",
    exact_blocker: SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_CONTRACT_BLOCKER
  };
}

function parseServiceReadinessBrowserUseAuthorizedAdapterContractV1(
  value: unknown,
  expected: ServiceReadinessBrowserUseAuthorizedAdapterContractExpectedV1
): ServiceReadinessBrowserUseAuthorizedAdapterContractV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_CONTRACT_BLOCKER);
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !browserUseAuthorizedAdapterContractFields.has(key))) {
    throw new Error(SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_CONTRACT_BLOCKER);
  }
  const requiredStrings: Array<keyof ServiceReadinessBrowserUseAuthorizedAdapterContractExpectedV1> = [
    "run_id", "stage_id", "attempt_id", "session_id", "authority_digest"
  ];
  if (
    body.schema !== SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_CONTRACT_SCHEMA_V1 ||
    body.browser_surface !== "browser_use_cli" ||
    body.mode !== "authorized" ||
    body.adapter_identity !== SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_IDENTITY_V1 ||
    body.external_action_executed !== false ||
    body.legacy_surfaces_forbidden !== true ||
    body.prior_receipt_reuse !== false
  ) throw new Error(SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_CONTRACT_BLOCKER);
  for (const field of [
    "authorized_scheduled_lifecycle",
    "structured_start_descriptor",
    "pre_open_descriptor_validation",
    "run_stage_attempt_session_binding",
    "authority_digest_binding",
    "allowed_origin_action_binding",
    "artifact_binding",
    "runtime_home_binding",
    "bounded_result_format",
    "no_fallback"
  ]) {
    if (body[field] !== true) throw new Error(SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_CONTRACT_BLOCKER);
  }
  for (const field of requiredStrings) {
    const valueForField = body[field];
    if (typeof valueForField !== "string" || !identifierPattern.test(valueForField)) {
      throw new Error(SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_CONTRACT_BLOCKER);
    }
    if (valueForField !== expected[field]) throw new Error(SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_CONTRACT_BLOCKER);
  }
  if (!hashPattern.test(body.authority_digest as string)) throw new Error(SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_CONTRACT_BLOCKER);
  if (typeof body.allowed_origin !== "string" || body.allowed_origin !== expected.allowed_origin) {
    throw new Error(SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_CONTRACT_BLOCKER);
  }
  let origin: URL;
  try {
    origin = new URL(body.allowed_origin as string);
  } catch {
    throw new Error(SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_CONTRACT_BLOCKER);
  }
  if (origin.protocol !== "https:" || origin.origin !== body.allowed_origin) {
    throw new Error(SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_CONTRACT_BLOCKER);
  }
  return body as unknown as ServiceReadinessBrowserUseAuthorizedAdapterContractV1;
}

/** Build explicit adapter contract facts without invoking any adapter. */
export function buildServiceReadinessBrowserUseAuthorizedAdapterContractV1(
  expected: ServiceReadinessBrowserUseAuthorizedAdapterContractExpectedV1
): ServiceReadinessBrowserUseAuthorizedAdapterContractV1 {
  if (
    !expected ||
    typeof expected.run_id !== "string" ||
    typeof expected.stage_id !== "string" ||
    typeof expected.attempt_id !== "string" ||
    typeof expected.session_id !== "string" ||
    typeof expected.authority_digest !== "string" ||
    typeof expected.allowed_origin !== "string"
  ) throw new Error(SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_CONTRACT_BLOCKER);
  return {
    schema: SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_CONTRACT_SCHEMA_V1,
    browser_surface: "browser_use_cli",
    mode: "authorized",
    adapter_identity: SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_IDENTITY_V1,
    authorized_scheduled_lifecycle: true,
    structured_start_descriptor: true,
    pre_open_descriptor_validation: true,
    run_stage_attempt_session_binding: true,
    authority_digest_binding: true,
    allowed_origin_action_binding: true,
    artifact_binding: true,
    runtime_home_binding: true,
    bounded_result_format: true,
    no_fallback: true,
    run_id: expected.run_id,
    stage_id: expected.stage_id,
    attempt_id: expected.attempt_id,
    session_id: expected.session_id,
    authority_digest: expected.authority_digest,
    allowed_origin: expected.allowed_origin,
    external_action_executed: false,
    legacy_surfaces_forbidden: true,
    prior_receipt_reuse: false
  };
}

export function validateServiceReadinessBrowserUseAuthorizedAdapterContractV1(
  value: unknown,
  expected: Partial<ServiceReadinessBrowserUseAuthorizedAdapterContractExpectedV1> | undefined
):
  | { ok: true; status: "ok"; value: ServiceReadinessBrowserUseAuthorizedAdapterContractV1 }
  | { ok: false; status: "blocked"; exact_blocker: typeof SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_CONTRACT_BLOCKER } {
  if (!expected || Object.values(expected).some((entry) => typeof entry !== "string")) return browserUseAuthorizedAdapterContractFailure();
  try {
    return { ok: true, status: "ok", value: parseServiceReadinessBrowserUseAuthorizedAdapterContractV1(value, expected as ServiceReadinessBrowserUseAuthorizedAdapterContractExpectedV1) };
  } catch {
    return browserUseAuthorizedAdapterContractFailure();
  }
}

export const parseBrowserUseAuthorizedAdapterContractV1 = parseServiceReadinessBrowserUseAuthorizedAdapterContractV1;
export const validateBrowserUseAuthorizedAdapterContractV1 = validateServiceReadinessBrowserUseAuthorizedAdapterContractV1;
export const buildBrowserUseAuthorizedAdapterContractV1 = buildServiceReadinessBrowserUseAuthorizedAdapterContractV1;
export type BrowserUseAuthorizedAdapterContractV1 = ServiceReadinessBrowserUseAuthorizedAdapterContractV1;
export type BrowserUseAuthorizedAdapterContractExpectedV1 = ServiceReadinessBrowserUseAuthorizedAdapterContractExpectedV1;

/** A stable root id derived from a run id; no caller-supplied state is reused. */
export function deriveServiceReadinessRootId(runId: string): string {
  const normalized = requiredIdentifier(runId, "service_readiness_runtime_run_id_invalid");
  return `root-${createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 40)}`;
}

/** Extract only the three registered reference workflow ids from run metadata. */
export function referenceWorkflowIdFromMetadata(metadata: Record<string, unknown> | null | undefined): ServiceReadinessReferenceWorkflowId | null {
  if (!metadata) return null;
  const candidates = [
    metadata.workflow_id,
    metadata.workflowId,
    metadata.registered_workflow_id,
    metadata.registeredWorkflowId,
    metadata.AUTOMATION_OS_REGISTERED_WORKFLOW_ID,
    metadata.service_readiness_workflow_id
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const unique = [...new Set(candidates.map((value) => {
    const normalized = value.trim();
    return registeredWorkflowAliases[normalized] ?? normalized;
  }))];
  if (unique.length !== 1) return null;
  if (!referenceWorkflows.has(unique[0] as ServiceReadinessReferenceWorkflowId)) return null;
  return unique[0] as ServiceReadinessReferenceWorkflowId;
}

/** Build a safe, deterministic binding.  Missing IAB identity is a blocker. */
export function buildServiceReadinessRuntimeBindingV1(input: ServiceReadinessRuntimeBindingInputV1): ServiceReadinessRuntimeBindingV1 {
  assertNoLegacyMarkers(input.legacy_markers);
  const rootId = requiredIdentifier(input.root_id, "service_readiness_runtime_root_id_invalid");
  const workflowId = referenceWorkflow(input.workflow_id);
  const runId = requiredIdentifier(input.run_id, "service_readiness_runtime_run_id_invalid");
  const stageId = requiredIdentifier(input.stage_id, "service_readiness_runtime_stage_id_invalid");
  const attemptId = requiredIdentifier(input.attempt_id, "service_readiness_runtime_attempt_id_invalid");
  const fence = fencingToken(input.fencing_token);
  const effectKey = nullableHash(input.effect_key, "service_readiness_runtime_effect_key_invalid");
  const capabilityId = nullableIdentifier(input.capability_id, "service_readiness_runtime_capability_id_invalid");
  const identity = input.iab_identity ?? null;

  const base: ServiceReadinessRuntimeBindingV1 = {
    schema: SERVICE_READINESS_RUNTIME_BINDING_SCHEMA_V1,
    surface: "in_app_browser",
    root_id: rootId,
    workflow_id: workflowId,
    run_id: runId,
    stage_id: stageId,
    attempt_id: attemptId,
    fencing_token: fence,
    effect_key: effectKey,
    capability_id: capabilityId,
    turn_id: identity?.turn_id ?? null,
    session_id: identity?.session_id ?? null,
    nonce: identity?.nonce ?? null,
    iab_identity: identity,
    capability_mode: "read_only",
    status: "blocked",
    exact_blocker: SERVICE_READINESS_RUNTIME_BINDING_BLOCKER,
    external_action_executed: false,
    legacy_surfaces_forbidden: true,
    prior_receipt_reuse: false
  };

  if (!identity) return base;
  if (!effectKey) return { ...base, exact_blocker: "service_readiness_runtime_effect_key_required" };
  if (!capabilityId) return { ...base, exact_blocker: "service_readiness_runtime_capability_id_required" };
  const root = rootBindingFor({
    root_id: rootId,
    workflow_id: workflowId,
    run_id: runId,
    stage_id: stageId,
    attempt_id: attemptId,
    fencing_token: fence,
    effect_key: effectKey,
    capability_id: capabilityId,
    iab_identity: identity
  });
  return {
    ...base,
    status: "bound",
    exact_blocker: null,
    capability_id: root.capability_id,
    turn_id: root.turn_id,
    session_id: root.session_id,
    nonce: root.nonce,
    iab_identity: root.iab_identity
  };
}

function parse(value: unknown): ServiceReadinessRuntimeBindingV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("service_readiness_runtime_binding_required");
  const body = value as Record<string, unknown>;
  const expectedFields = new Set([
    "schema", "surface", "root_id", "workflow_id", "run_id", "stage_id", "attempt_id", "fencing_token", "effect_key",
    "capability_id", "turn_id", "session_id", "nonce", "iab_identity", "capability_mode", "status", "exact_blocker",
    "external_action_executed", "legacy_surfaces_forbidden", "prior_receipt_reuse"
  ]);
  const unknown = Object.keys(body).filter((key) => !expectedFields.has(key));
  if (unknown.length > 0) throw new Error(`service_readiness_runtime_binding_unknown_field:${unknown.sort().join(",")}`);
  if (body.schema !== SERVICE_READINESS_RUNTIME_BINDING_SCHEMA_V1) throw new Error("service_readiness_runtime_binding_schema_invalid");
  if (body.surface !== "in_app_browser" || body.capability_mode !== "read_only") throw new Error("service_readiness_runtime_surface_invalid");
  if (body.external_action_executed !== false || body.legacy_surfaces_forbidden !== true || body.prior_receipt_reuse !== false) {
    throw new Error("iab_external_effect_capability_not_implemented");
  }
  const status = body.status === "bound" || body.status === "blocked" ? body.status : (() => { throw new Error("service_readiness_runtime_status_invalid"); })();
  const normalized = {
    schema: SERVICE_READINESS_RUNTIME_BINDING_SCHEMA_V1,
    surface: "in_app_browser" as const,
    root_id: requiredIdentifier(body.root_id, "service_readiness_runtime_root_id_invalid"),
    workflow_id: referenceWorkflow(body.workflow_id),
    run_id: requiredIdentifier(body.run_id, "service_readiness_runtime_run_id_invalid"),
    stage_id: requiredIdentifier(body.stage_id, "service_readiness_runtime_stage_id_invalid"),
    attempt_id: requiredIdentifier(body.attempt_id, "service_readiness_runtime_attempt_id_invalid"),
    fencing_token: fencingToken(body.fencing_token),
    effect_key: nullableHash(body.effect_key, "service_readiness_runtime_effect_key_invalid"),
    capability_id: nullableIdentifier(body.capability_id, "service_readiness_runtime_capability_id_invalid"),
    turn_id: nullableIdentifier(body.turn_id, "service_readiness_runtime_turn_id_invalid"),
    session_id: nullableIdentifier(body.session_id, "service_readiness_runtime_session_id_invalid"),
    nonce: nullableIdentifier(body.nonce, "service_readiness_runtime_nonce_invalid"),
    iab_identity: body.iab_identity === null ? null : body.iab_identity as IabIdentity,
    capability_mode: "read_only" as const,
    status,
    exact_blocker: body.exact_blocker === null ? null : requiredIdentifier(body.exact_blocker, "service_readiness_runtime_exact_blocker_invalid"),
    external_action_executed: false as const,
    legacy_surfaces_forbidden: true as const,
    prior_receipt_reuse: false as const
  } satisfies ServiceReadinessRuntimeBindingV1;
  if (status === "blocked") {
    if (!normalized.exact_blocker) throw new Error("service_readiness_runtime_blocker_required");
    if (normalized.iab_identity !== null) throw new Error("service_readiness_runtime_blocked_identity_forbidden");
    if (normalized.capability_id !== null || normalized.turn_id !== null || normalized.session_id !== null || normalized.nonce !== null) {
      throw new Error("service_readiness_runtime_blocked_identity_partial");
    }
    return normalized;
  }
  if (!normalized.effect_key || !normalized.capability_id || !normalized.iab_identity || !normalized.turn_id || !normalized.session_id || !normalized.nonce || normalized.exact_blocker !== null) {
    throw new Error("service_readiness_runtime_bound_identity_required");
  }
  rootBindingFor({
    root_id: normalized.root_id,
    workflow_id: normalized.workflow_id,
    run_id: normalized.run_id,
    stage_id: normalized.stage_id,
    attempt_id: normalized.attempt_id,
    fencing_token: normalized.fencing_token,
    effect_key: normalized.effect_key,
    capability_id: normalized.capability_id,
    iab_identity: normalized.iab_identity
  });
  return normalized;
}

export function parseServiceReadinessRuntimeBindingV1(value: unknown): ServiceReadinessRuntimeBindingV1 {
  return parse(value);
}

export function validateServiceReadinessRuntimeBindingV1(value: unknown): ServiceReadinessRuntimeBindingValidationResultV1 {
  try {
    return { ok: true, status: "ok", value: parse(value) };
  } catch (error) {
    return { ok: false, status: "blocked", exact_blocker: error instanceof Error ? error.message : "service_readiness_runtime_binding_validation_failed" };
  }
}

export function assertServiceReadinessRuntimeBindingMatches(
  actual: ServiceReadinessRuntimeBindingV1,
  expected: ServiceReadinessRuntimeBindingExpectedV1
): void {
  for (const field of ["root_id", "workflow_id", "run_id", "stage_id", "attempt_id", "fencing_token", "effect_key"] as const) {
    if (actual[field] !== expected[field]) throw new Error(`service_readiness_runtime_binding_mismatch:${field}`);
  }
}

export const buildRuntimeBindingV1 = buildServiceReadinessRuntimeBindingV1;
export const parseRuntimeBindingV1 = parseServiceReadinessRuntimeBindingV1;
export const validateRuntimeBindingV1 = validateServiceReadinessRuntimeBindingV1;

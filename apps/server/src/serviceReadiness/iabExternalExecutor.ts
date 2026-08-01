import { createHash } from "node:crypto";

import { canonicalJson } from "../automations/idempotency.js";
import type { IabIdentity } from "../browser/iabReadOnlyBridge.js";
import {
  validateIabExternalCapabilityV1,
  type IabExternalCapabilityV1
} from "./iabExternalCapability.js";

/**
 * Root-owned external execution is intentionally a sibling of the read-only
 * IAB contracts.  The executor accepts only an injected root runtime and an
 * injected atomic approval/ledger gate; it never discovers a browser, reads a
 * secret, calls a provider, or creates an approval on its own.
 */
export const IAB_EXTERNAL_EXECUTOR_SCHEMA_V1 = "service_readiness_iab_external_executor.v1" as const;
export const IAB_EXTERNAL_EXECUTOR_RUNTIME_BLOCKER = "in_app_browser_runtime_unavailable" as const;
export const IAB_EXTERNAL_EXECUTOR_ATOMIC_GATE_BLOCKER = "iab_external_atomic_gate_unavailable" as const;
export const IAB_EXTERNAL_EXECUTOR_CLEANUP_BLOCKER = "iab_external_cleanup_receipt_missing" as const;

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const uriPattern = /^(?:file|https?):\/\/[^\s\u0000-\u001f\u007f]{1,4095}$/;

export type IabExternalExecutorBindingV1 = {
  company_id: string;
  service_user_id: string;
  issuer_service_user_id: string;
  iab_generation: string;
  iab_project_id: string;
  iab_thread_id: string;
  job_id: string;
  action_kind: string;
  policy_version: string;
  manifest_hash: string;
  root_id: string;
  workflow_id: string;
  run_id: string;
  stage_id: string;
  attempt_id: string;
  fencing_token: number;
  capability_id: string;
  turn_id: string;
  session_id: string;
  nonce: string;
  provider: string;
  account_ref: string;
  target_hash: string;
  payload_hash: string;
  effect_key: string;
  approval_id: string;
  approval_revision: number;
  approval_payload_hash: string;
};

const providerReceiptBindingFields: readonly (keyof IabExternalExecutorBindingV1)[] = [
  "company_id", "service_user_id", "issuer_service_user_id", "iab_generation", "iab_project_id", "iab_thread_id",
  "job_id", "action_kind", "policy_version", "manifest_hash",
  "root_id", "workflow_id", "run_id", "stage_id", "attempt_id", "fencing_token", "capability_id",
  "turn_id", "session_id", "nonce", "provider", "account_ref", "target_hash", "payload_hash",
  "effect_key", "approval_id", "approval_revision", "approval_payload_hash"
];

export type IabExternalEffectRequestV1 = Pick<
  IabExternalExecutorBindingV1,
  | "company_id"
  | "service_user_id"
  | "issuer_service_user_id"
  | "iab_generation"
  | "iab_project_id"
  | "iab_thread_id"
  | "job_id"
  | "action_kind"
  | "policy_version"
  | "manifest_hash"
  | "root_id"
  | "workflow_id"
  | "run_id"
  | "stage_id"
  | "attempt_id"
  | "fencing_token"
  | "capability_id"
  | "provider"
  | "account_ref"
  | "target_hash"
  | "payload_hash"
  | "effect_key"
  | "approval_id"
  | "approval_revision"
  | "approval_payload_hash"
> & {
  surface: "in_app_browser";
  capability_mode: "external";
  effect_class: "external_non_idempotent";
  external_action_executed: false;
  legacy_surfaces_forbidden: true;
  prior_receipt_reuse: false;
};

export type IabExternalProviderReceiptV1 = IabExternalExecutorBindingV1 & {
  schema: "service_readiness_iab_external_provider_receipt.v1";
  receipt_id: string;
  readback_uri: string;
  readback_hash: string;
  external_action_executed: true;
  receipt_hash: string;
};

export type IabExternalProviderOutcomeV1 = {
  status: "succeeded" | "failed" | "ambiguous";
  external_action_executed: boolean;
  provider_receipt: IabExternalProviderReceiptV1 | null;
  exact_blocker: string | null;
  safe_resume_step: string | null;
};

export type IabExternalCleanupEvidenceV1 = {
  schema: "service_readiness_iab_external_cleanup_receipt.v1";
  root_id: string;
  workflow_id: string;
  run_id: string;
  stage_id: string;
  attempt_id: string;
  fencing_token: number;
  capability_id: string;
  effect_key: string;
  provider_receipt_hash: string | null;
  effect_external_action_executed: boolean;
  status: "verified" | "incomplete";
  capability_released: true;
  task_tab_finalized: true;
  no_residual_processes: true;
  no_external_cleanup_action: true;
  capability_release_readback_uri: string;
  capability_release_readback_hash: string;
  artifact_uri: string;
  created_at: string;
  receipt_hash: string;
};

export type IabExternalCleanupDraftV1 = Omit<
  IabExternalCleanupEvidenceV1,
  "capability_released" | "capability_release_readback_uri" | "capability_release_readback_hash" | "receipt_hash"
> & {
  capability_released: false;
  capability_release_readback_uri: null;
  capability_release_readback_hash: null;
};

export type IabExternalCapabilityReleaseReadbackV1 = {
  released: true;
  readback_uri: string;
  readback_hash: string;
};

export type IabExternalRuntimeLeaseV1 = {
  /** Fresh runtime identity, not a caller-supplied copy. */
  readIdentity(): Promise<IabIdentity>;
  /** Exactly one provider attempt. The executor never retries this call. */
  executeOnce(request: IabExternalEffectRequestV1): Promise<IabExternalProviderOutcomeV1>;
  /** Must prove capability/tab/process cleanup without performing another effect. */
  /** Cleans task-owned resources before capability release; it must not claim release yet. */
  cleanup(outcome: IabExternalProviderOutcomeV1 | null): Promise<IabExternalCleanupDraftV1>;
  /** Releases the root-owned capability once and returns a fresh readback. */
  release(): Promise<IabExternalCapabilityReleaseReadbackV1>;
};

export type RootOwnedIabExternalRuntimeV1 = {
  acquire(binding: IabExternalExecutorBindingV1): Promise<IabExternalRuntimeLeaseV1>;
};

export type IabExternalReservationV1 = {
  reservation_id: string;
  reservation_token: string;
  effect_key: string;
  approval_consumed: true;
  ledger_reserved: true;
};

export type RootOwnedIabExternalAtomicGateV1 = {
  /** Read-only check of the current approval, company scope, and revision. */
  assertApproval(binding: IabExternalExecutorBindingV1): Promise<void>;
  /** One root-owned transaction must consume approval and reserve the effect. */
  reserveAndConsume(input: {
    binding: IabExternalExecutorBindingV1;
    capability: IabExternalCapabilityV1;
    request: IabExternalEffectRequestV1;
  }): Promise<IabExternalReservationV1>;
  /** Terminalizes only after verified same-run cleanup. */
  transition(input: {
    binding: IabExternalExecutorBindingV1;
    reservation: IabExternalReservationV1;
    status: "succeeded" | "failed" | "reconciliation_required";
    external_action_executed: boolean;
    provider_receipt_hash: string | null;
    cleanup_receipt_hash: string;
    exact_blocker: string | null;
    safe_resume_step: string | null;
  }): Promise<void>;
};

type ExecutorCommonResult = {
  schema: typeof IAB_EXTERNAL_EXECUTOR_SCHEMA_V1;
  provider_called: boolean;
  approval_consumed: boolean;
  ledger_reserved: boolean;
  cleanup_verified: boolean;
  provider_receipt_hash: string | null;
  cleanup_receipt_hash: string | null;
  external_action_executed: boolean;
  exact_blocker: string | null;
  safe_resume_step: string | null;
};

export type IabExternalExecutorResultV1 = ExecutorCommonResult & {
  status: "blocked" | "succeeded" | "failed" | "reconciliation_required";
};

export type ExecuteIabExternalEffectInputV1 = {
  capability: unknown;
  binding: IabExternalExecutorBindingV1;
  runtime?: RootOwnedIabExternalRuntimeV1;
  atomic_gate?: RootOwnedIabExternalAtomicGateV1;
  /** Called once after reservation and immediately before the provider boundary. */
  before_provider_call?: (reservation: IabExternalReservationV1) => Promise<void>;
  /** Deterministic clock hook for boundary revalidation tests and trusted callers. */
  clock_ms?: () => number;
  now_ms?: number;
};

function hash(value: unknown, field: string): string {
  if (typeof value !== "string" || !hashPattern.test(value)) throw new Error(`iab_external_executor_${field}_invalid`);
  return value;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !identifierPattern.test(value)) throw new Error(`iab_external_executor_${field}_invalid`);
  return value;
}

function safeCode(error: unknown, fallback: string): string {
  const code = error instanceof Error ? error.message : "";
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(code) ? code : fallback;
}

function blocked(exactBlocker: string, safeResumeStep = "repair_iab_external_executor_before_retry"): IabExternalExecutorResultV1 {
  return {
    schema: IAB_EXTERNAL_EXECUTOR_SCHEMA_V1,
    status: "blocked",
    provider_called: false,
    approval_consumed: false,
    ledger_reserved: false,
    cleanup_verified: false,
    provider_receipt_hash: null,
    cleanup_receipt_hash: null,
    external_action_executed: false,
    exact_blocker: exactBlocker,
    safe_resume_step: safeResumeStep
  };
}

function bindingFromCapability(capability: IabExternalCapabilityV1, binding: IabExternalExecutorBindingV1): string | null {
  const fields: Array<keyof IabExternalCapabilityV1 & keyof IabExternalExecutorBindingV1> = [
    "company_id", "issuer_service_user_id", "manifest_hash",
    "root_id", "workflow_id", "run_id", "stage_id", "attempt_id", "fencing_token", "capability_id",
    "turn_id", "session_id", "nonce", "provider", "account_ref", "target_hash", "payload_hash",
    "effect_key", "approval_id", "approval_revision", "approval_payload_hash"
  ];
  for (const field of fields) {
    if (capability[field] !== binding[field]) return `iab_external_executor_binding_mismatch:${field}`;
  }
  const identityBindings: Array<[string, string]> = [
    ["iab_generation", capability.iab_identity.generation],
    ["iab_project_id", capability.iab_identity.project_id],
    ["iab_thread_id", capability.iab_identity.thread_id]
  ];
  for (const [field, value] of identityBindings) {
    if (value !== binding[field as "iab_generation" | "iab_project_id" | "iab_thread_id"]) {
      return `iab_external_executor_binding_mismatch:${field}`;
    }
  }
  return null;
}

function validateBinding(binding: IabExternalExecutorBindingV1): string | null {
  const identifiers: Array<[string, unknown]> = [
    ["company_id", binding.company_id], ["service_user_id", binding.service_user_id],
    ["issuer_service_user_id", binding.issuer_service_user_id], ["iab_generation", binding.iab_generation],
    ["iab_project_id", binding.iab_project_id], ["iab_thread_id", binding.iab_thread_id], ["job_id", binding.job_id],
    ["action_kind", binding.action_kind], ["policy_version", binding.policy_version], ["root_id", binding.root_id],
    ["workflow_id", binding.workflow_id], ["run_id", binding.run_id], ["stage_id", binding.stage_id],
    ["attempt_id", binding.attempt_id], ["capability_id", binding.capability_id], ["turn_id", binding.turn_id],
    ["session_id", binding.session_id], ["nonce", binding.nonce], ["provider", binding.provider],
    ["account_ref", binding.account_ref], ["approval_id", binding.approval_id]
  ];
  for (const [field, value] of identifiers) {
    try { identifier(value, field); } catch (error) { return safeCode(error, `iab_external_executor_${field}_invalid`); }
  }
  const hashes: Array<[string, unknown]> = [
    ["manifest_hash", binding.manifest_hash], ["target_hash", binding.target_hash], ["payload_hash", binding.payload_hash],
    ["effect_key", binding.effect_key], ["approval_payload_hash", binding.approval_payload_hash]
  ];
  for (const [field, value] of hashes) {
    try { hash(value, field); } catch (error) { return safeCode(error, `iab_external_executor_${field}_invalid`); }
  }
  if (!Number.isSafeInteger(binding.fencing_token) || binding.fencing_token < 1 || binding.fencing_token > 100000) {
    return "iab_external_executor_fencing_token_invalid";
  }
  if (!Number.isSafeInteger(binding.approval_revision) || binding.approval_revision < 1 || binding.approval_revision > 100000) {
    return "iab_external_executor_approval_revision_invalid";
  }
  return null;
}

function identityMismatch(actual: IabIdentity, expected: IabExternalCapabilityV1): string | null {
  const fields: Array<keyof IabIdentity> = ["generation", "project_id", "thread_id", "session_id", "turn_id", "nonce", "stage", "attempt"];
  for (const field of fields) {
    if (actual[field] !== expected.iab_identity[field]) return `iab_external_executor_runtime_identity_mismatch:${field}`;
  }
  return null;
}

function effectRequest(binding: IabExternalExecutorBindingV1): IabExternalEffectRequestV1 {
  return {
    ...binding,
    surface: "in_app_browser",
    capability_mode: "external",
    effect_class: "external_non_idempotent",
    external_action_executed: false,
    legacy_surfaces_forbidden: true,
    prior_receipt_reuse: false
  };
}

function receiptPreimage(receipt: Omit<IabExternalProviderReceiptV1, "receipt_hash">): string {
  return canonicalJson(receipt);
}

export function hashIabExternalProviderReceiptV1(receipt: Omit<IabExternalProviderReceiptV1, "receipt_hash">): string {
  return createHash("sha256").update(receiptPreimage(receipt), "utf8").digest("hex");
}

function validateProviderReceipt(
  receipt: IabExternalProviderReceiptV1 | null,
  binding: IabExternalExecutorBindingV1
): string | null {
  if (!receipt) return "iab_external_provider_receipt_missing";
  if (receipt.schema !== "service_readiness_iab_external_provider_receipt.v1") return "iab_external_provider_receipt_schema_invalid";
  try {
    identifier(receipt.receipt_id, "receipt_id");
    hash(receipt.readback_hash, "receipt_readback_hash");
    hash(receipt.receipt_hash, "receipt_hash");
  } catch (error) {
    return safeCode(error, "iab_external_provider_receipt_invalid");
  }
  const receiptBindingError = validateBinding(receipt);
  if (receiptBindingError) return `iab_external_provider_receipt_binding_invalid:${receiptBindingError}`;
  if (!uriPattern.test(receipt.readback_uri)) return "iab_external_provider_readback_uri_invalid";
  if (receipt.external_action_executed !== true) return "iab_external_provider_action_not_confirmed";
  for (const field of providerReceiptBindingFields) {
    if (receipt[field] !== binding[field]) return `iab_external_provider_receipt_binding_mismatch:${field}`;
  }
  const { receipt_hash: ignored, ...withoutHash } = receipt;
  if (hashIabExternalProviderReceiptV1(withoutHash) !== ignored) return "iab_external_provider_receipt_hash_mismatch";
  return null;
}

export function hashIabExternalCleanupEvidenceV1(receipt: Omit<IabExternalCleanupEvidenceV1, "receipt_hash">): string {
  return createHash("sha256").update(canonicalJson(receipt), "utf8").digest("hex");
}

function validateCleanup(
  cleanup: IabExternalCleanupEvidenceV1 | null,
  binding: IabExternalExecutorBindingV1,
  providerReceiptHash: string | null,
  externalActionExecuted: boolean
): string | null {
  if (!cleanup) return IAB_EXTERNAL_EXECUTOR_CLEANUP_BLOCKER;
  if (cleanup.schema !== "service_readiness_iab_external_cleanup_receipt.v1") return "iab_external_cleanup_receipt_schema_invalid";
  const fields: Array<[string, unknown]> = [
    ["root_id", cleanup.root_id], ["workflow_id", cleanup.workflow_id], ["run_id", cleanup.run_id],
    ["stage_id", cleanup.stage_id], ["attempt_id", cleanup.attempt_id], ["capability_id", cleanup.capability_id], ["effect_key", cleanup.effect_key]
  ];
  for (const [field, value] of fields) {
    try { identifier(value, `cleanup_${field}`); } catch (error) { return safeCode(error, `iab_external_cleanup_${field}_invalid`); }
  }
  if (cleanup.root_id !== binding.root_id || cleanup.workflow_id !== binding.workflow_id || cleanup.run_id !== binding.run_id ||
      cleanup.stage_id !== binding.stage_id || cleanup.attempt_id !== binding.attempt_id || cleanup.fencing_token !== binding.fencing_token ||
      cleanup.capability_id !== binding.capability_id || cleanup.effect_key !== binding.effect_key) {
    return "iab_external_cleanup_binding_mismatch";
  }
  if (cleanup.provider_receipt_hash !== providerReceiptHash) return "iab_external_cleanup_provider_receipt_mismatch";
  if (cleanup.effect_external_action_executed !== externalActionExecuted) return "iab_external_cleanup_effect_flag_mismatch";
  if (cleanup.status !== "verified" || cleanup.capability_released !== true || cleanup.task_tab_finalized !== true ||
      cleanup.no_residual_processes !== true || cleanup.no_external_cleanup_action !== true) {
    return IAB_EXTERNAL_EXECUTOR_CLEANUP_BLOCKER;
  }
  if (!uriPattern.test(cleanup.capability_release_readback_uri)) return "iab_external_cleanup_release_readback_uri_invalid";
  try { hash(cleanup.capability_release_readback_hash, "cleanup_release_readback_hash"); } catch (error) {
    return safeCode(error, "iab_external_cleanup_release_readback_hash_invalid");
  }
  if (!uriPattern.test(cleanup.artifact_uri) || !Number.isFinite(Date.parse(cleanup.created_at))) return "iab_external_cleanup_artifact_invalid";
  try { hash(cleanup.receipt_hash, "cleanup_receipt_hash"); } catch (error) { return safeCode(error, "iab_external_cleanup_receipt_hash_invalid"); }
  const { receipt_hash: ignored, ...withoutHash } = cleanup;
  if (hashIabExternalCleanupEvidenceV1(withoutHash) !== ignored) return "iab_external_cleanup_receipt_hash_mismatch";
  return null;
}

function finalizeCleanupEvidence(
  draft: IabExternalCleanupDraftV1 | null,
  releaseReadback: IabExternalCapabilityReleaseReadbackV1 | null
): IabExternalCleanupEvidenceV1 | null {
  if (!draft || draft.capability_released !== false || draft.capability_release_readback_uri !== null ||
      draft.capability_release_readback_hash !== null || !releaseReadback || releaseReadback.released !== true) {
    return null;
  }
  const finalEvidence = {
    ...draft,
    capability_released: true as const,
    capability_release_readback_uri: releaseReadback.readback_uri,
    capability_release_readback_hash: releaseReadback.readback_hash
  };
  return { ...finalEvidence, receipt_hash: hashIabExternalCleanupEvidenceV1(finalEvidence) };
}

function errorResult(
  blockerCode: string,
  reservation: IabExternalReservationV1 | null,
  externalActionExecuted = false,
  cleanupVerified = false,
  cleanupReceiptHash: string | null = null
): IabExternalExecutorResultV1 {
  return {
    schema: IAB_EXTERNAL_EXECUTOR_SCHEMA_V1,
    status: reservation ? "reconciliation_required" : "blocked",
    provider_called: false,
    approval_consumed: Boolean(reservation?.approval_consumed),
    ledger_reserved: Boolean(reservation?.ledger_reserved),
    cleanup_verified: cleanupVerified,
    provider_receipt_hash: null,
    cleanup_receipt_hash: cleanupReceiptHash,
    external_action_executed: externalActionExecuted,
    exact_blocker: blockerCode,
    safe_resume_step: reservation ? "reconcile_external_effect_before_retry" : "repair_iab_external_executor_before_retry"
  };
}

/** Execute one root-owned external attempt, or return an exact safe-stop. */
export async function executeIabExternalEffectV1(input: ExecuteIabExternalEffectInputV1): Promise<IabExternalExecutorResultV1> {
  const bindingError = validateBinding(input.binding);
  if (bindingError) return blocked(bindingError);

  const clockMs = input.clock_ms ?? (() => input.now_ms ?? Date.now());
  let capabilityResult = validateIabExternalCapabilityV1(input.capability, clockMs());
  if (!capabilityResult.ok) return blocked(capabilityResult.exact_blocker);
  let capability = capabilityResult.value;
  let capabilityBindingError = bindingFromCapability(capability, input.binding);
  if (capabilityBindingError) return blocked(capabilityBindingError);

  const refreshCapability = (): string | null => {
    capabilityResult = validateIabExternalCapabilityV1(input.capability, clockMs());
    if (!capabilityResult.ok) return capabilityResult.exact_blocker;
    capability = capabilityResult.value;
    capabilityBindingError = bindingFromCapability(capability, input.binding);
    return capabilityBindingError;
  };

  // Runtime absence is checked before approval/ledger/provider dependencies.
  if (!input.runtime) return blocked(IAB_EXTERNAL_EXECUTOR_RUNTIME_BLOCKER, "obtain_a_fresh_trusted_iab_runtime");
  if (!input.atomic_gate) return blocked(IAB_EXTERNAL_EXECUTOR_ATOMIC_GATE_BLOCKER);

  const binding = input.binding;
  const request = effectRequest(binding);
  let lease: IabExternalRuntimeLeaseV1 | null = null;
  let reservation: IabExternalReservationV1 | null = null;
  let outcome: IabExternalProviderOutcomeV1 | null = null;
  let cleanupDraft: IabExternalCleanupDraftV1 | null = null;
  let releaseReadback: IabExternalCapabilityReleaseReadbackV1 | null = null;
  let providerReceiptHash: string | null = null;
  let externalActionExecuted = false;
  let preEffectBlocker: string | null = null;
  let preEffectResumeStep = "repair_iab_external_executor_before_retry";

  try {
    try {
      await input.atomic_gate.assertApproval(binding);
    } catch (error) {
      return blocked(safeCode(error, "iab_external_approval_readback_blocked"), "refresh_current_turn_approval_readback");
    }
    const postApprovalCapabilityError = refreshCapability();
    if (postApprovalCapabilityError) {
      return blocked(postApprovalCapabilityError, "refresh_current_turn_capability");
    }

    try {
      lease = await input.runtime.acquire(binding);
    } catch (error) {
      return blocked(safeCode(error, "iab_external_runtime_acquire_failed"), "obtain_a_fresh_trusted_iab_runtime");
    }
    try {
      const runtimeIdentity = await lease.readIdentity();
      const runtimeIdentityError = identityMismatch(runtimeIdentity, capability);
      if (runtimeIdentityError) {
        preEffectBlocker = runtimeIdentityError;
        preEffectResumeStep = "obtain_a_fresh_matching_iab_identity";
      }
    } catch (error) {
      preEffectBlocker = safeCode(error, "iab_external_runtime_identity_readback_failed");
      preEffectResumeStep = "obtain_a_fresh_matching_iab_identity";
    }

    if (!preEffectBlocker) {
      const preReservationCapabilityError = refreshCapability();
      if (preReservationCapabilityError) {
        preEffectBlocker = preReservationCapabilityError;
        preEffectResumeStep = "refresh_current_turn_capability";
      }
    }

    if (!preEffectBlocker) {
      try {
        reservation = await input.atomic_gate.reserveAndConsume({ binding, capability, request });
        if (!reservation || reservation.effect_key !== binding.effect_key || reservation.approval_consumed !== true || reservation.ledger_reserved !== true) {
          preEffectBlocker = "iab_external_atomic_reservation_readback_invalid";
          preEffectResumeStep = "reconcile_external_effect_before_retry";
        }
      } catch (error) {
        preEffectBlocker = safeCode(error, "iab_external_atomic_reservation_failed");
        preEffectResumeStep = "reconcile_external_effect_before_retry";
      }
    }

    if (!preEffectBlocker && reservation) {
      const preProviderCapabilityError = refreshCapability();
      if (preProviderCapabilityError) {
        preEffectBlocker = preProviderCapabilityError;
        preEffectResumeStep = reservation ? "reconcile_external_effect_before_retry" : "refresh_current_turn_capability";
      }
    }

    if (!preEffectBlocker && reservation) {
      try {
        const providerIdentity = await lease.readIdentity();
        const providerIdentityError = identityMismatch(providerIdentity, capability);
        if (providerIdentityError) {
          preEffectBlocker = providerIdentityError;
          preEffectResumeStep = "reconcile_external_effect_before_retry";
        }
      } catch (error) {
        preEffectBlocker = safeCode(error, "iab_external_runtime_identity_readback_failed");
        preEffectResumeStep = "reconcile_external_effect_before_retry";
      }
    }

    if (!preEffectBlocker && reservation) {
      const providerBoundaryCapabilityError = refreshCapability();
      if (providerBoundaryCapabilityError) {
        preEffectBlocker = providerBoundaryCapabilityError;
        preEffectResumeStep = "reconcile_external_effect_before_retry";
      }
    }

    if (!preEffectBlocker && reservation) {
      try {
        await input.before_provider_call?.(reservation);
      } catch (error) {
        preEffectBlocker = safeCode(error, "iab_external_provider_boundary_admission_failed");
        preEffectResumeStep = "reconcile_external_effect_before_retry";
      }
    }

    if (!preEffectBlocker && reservation) {
      try {
        outcome = await lease.executeOnce(request);
      } catch {
        outcome = {
          status: "ambiguous",
          external_action_executed: true,
          provider_receipt: null,
          exact_blocker: "iab_external_provider_outcome_ambiguous",
          safe_resume_step: "reconcile_external_provider_readback"
        };
      }
      if (!outcome || !["succeeded", "failed", "ambiguous"].includes(outcome.status) || typeof outcome.external_action_executed !== "boolean") {
        outcome = {
          status: "ambiguous",
          external_action_executed: true,
          provider_receipt: null,
          exact_blocker: "iab_external_provider_outcome_invalid",
          safe_resume_step: "reconcile_external_provider_readback"
        };
      }
      externalActionExecuted = outcome.external_action_executed;
      if (outcome.provider_receipt) {
        const receiptError = validateProviderReceipt(outcome.provider_receipt, binding);
        if (!receiptError) {
          providerReceiptHash = outcome.provider_receipt.receipt_hash;
          if (outcome.provider_receipt.external_action_executed !== outcome.external_action_executed) {
            outcome = {
              ...outcome,
              status: "ambiguous",
              external_action_executed: true,
              exact_blocker: "iab_external_provider_outcome_receipt_effect_flag_mismatch",
              safe_resume_step: "reconcile_external_provider_readback"
            };
            externalActionExecuted = true;
          }
        } else {
          outcome = {
            ...outcome,
            status: "ambiguous",
            external_action_executed: true,
            exact_blocker: receiptError,
            safe_resume_step: "reconcile_external_provider_readback"
          };
          externalActionExecuted = true;
        }
      }
      if (outcome.status === "succeeded" && (!outcome.external_action_executed || !providerReceiptHash)) {
        outcome = {
          ...outcome,
          status: "ambiguous",
          external_action_executed: true,
          exact_blocker: outcome.exact_blocker ?? "iab_external_provider_receipt_required",
          safe_resume_step: "reconcile_external_provider_readback"
        };
        externalActionExecuted = true;
      }
      if (outcome.status === "ambiguous") externalActionExecuted = true;
      if (outcome.status === "failed" && outcome.external_action_executed && !providerReceiptHash) {
        outcome = { ...outcome, status: "ambiguous", exact_blocker: outcome.exact_blocker ?? "iab_external_provider_outcome_ambiguous", safe_resume_step: "reconcile_external_provider_readback" };
      }
    }
  } finally {
    if (lease) {
      try {
        cleanupDraft = await lease.cleanup(outcome);
      } catch {
        cleanupDraft = null;
      }
      try {
        releaseReadback = await lease.release();
      } catch {
        releaseReadback = null;
      }
    }
  }

  const cleanup = finalizeCleanupEvidence(cleanupDraft, releaseReadback);
  const cleanupError = validateCleanup(cleanup, binding, providerReceiptHash, externalActionExecuted);
  const cleanupHash = cleanup && cleanupError === null ? cleanup.receipt_hash : null;
  if (preEffectBlocker) {
    return {
      ...errorResult(preEffectBlocker, reservation, externalActionExecuted, cleanupError === null, cleanupHash),
      provider_called: false,
      exact_blocker: cleanupError ?? preEffectBlocker,
      safe_resume_step: cleanupError ? "reconcile_external_cleanup_before_retry" : preEffectResumeStep
    };
  }
  if (cleanupError) {
    return {
      ...errorResult(cleanupError, reservation, externalActionExecuted, false, cleanupHash),
      provider_called: Boolean(outcome),
      provider_receipt_hash: providerReceiptHash,
      status: reservation && outcome ? "reconciliation_required" : "blocked",
      exact_blocker: cleanupError,
      safe_resume_step: "reconcile_external_cleanup_before_retry"
    };
  }
  if (!reservation || !outcome || !cleanupHash) return blocked("iab_external_execution_state_missing");

  let terminalStatus: "succeeded" | "failed" | "reconciliation_required" = outcome.status === "succeeded" && providerReceiptHash
    ? "succeeded"
    : outcome.status === "failed" && !externalActionExecuted
      ? "failed"
      : "reconciliation_required";
  const exactBlocker = terminalStatus === "succeeded" ? null : outcome.exact_blocker ?? "iab_external_provider_outcome_ambiguous";
  const safeResumeStep = terminalStatus === "succeeded" ? null : outcome.safe_resume_step ?? "reconcile_external_provider_readback";
  try {
    await input.atomic_gate.transition({
      binding,
      reservation,
      status: terminalStatus,
      external_action_executed: externalActionExecuted,
      provider_receipt_hash: providerReceiptHash,
      cleanup_receipt_hash: cleanupHash,
      exact_blocker: exactBlocker,
      safe_resume_step: safeResumeStep
    });
  } catch (error) {
    terminalStatus = "reconciliation_required";
    return {
      schema: IAB_EXTERNAL_EXECUTOR_SCHEMA_V1,
      status: terminalStatus,
      provider_called: true,
      approval_consumed: true,
      ledger_reserved: true,
      cleanup_verified: true,
      provider_receipt_hash: providerReceiptHash,
      cleanup_receipt_hash: cleanupHash,
      external_action_executed: externalActionExecuted,
      exact_blocker: safeCode(error, "iab_external_ledger_transition_failed"),
      safe_resume_step: "reconcile_external_ledger_transition"
    };
  }
  return {
    schema: IAB_EXTERNAL_EXECUTOR_SCHEMA_V1,
    status: terminalStatus,
    provider_called: true,
    approval_consumed: true,
    ledger_reserved: true,
    cleanup_verified: true,
    provider_receipt_hash: providerReceiptHash,
    cleanup_receipt_hash: cleanupHash,
    external_action_executed: externalActionExecuted,
    exact_blocker: exactBlocker,
    safe_resume_step: safeResumeStep
  };
}

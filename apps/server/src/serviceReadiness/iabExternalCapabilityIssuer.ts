import type { IabIdentity } from "../browser/iabReadOnlyBridge.js";
import {
  signIabExternalCapabilityV1,
  validateIabExternalCapabilityV1,
  type IabExternalCapabilityV1
} from "./iabExternalCapability.js";
import type { IabExternalExecutorBindingV1 } from "./iabExternalExecutor.js";

/**
 * Root-owned capability issuance boundary.
 *
 * The issuer never accepts an IAB identity from the caller.  It asks the
 * root-owned runtime for a fresh identity, binds that identity to the live
 * executor binding, and only then signs the one-use capability.  The signer is
 * injectable so a production secret manager can own key material; the local
 * default remains fail-closed when its test-only secret is absent.
 */
export const IAB_EXTERNAL_CAPABILITY_ISSUER_SCHEMA_V1 = "service_readiness_iab_external_capability_issuer.v1" as const;

export type RootOwnedIabExternalCapabilitySignerV1 = (
  value: Omit<IabExternalCapabilityV1, "capability_mac">
) => IabExternalCapabilityV1;

export type RootOwnedIabExternalCapabilityIssuerV1 = {
  schema: typeof IAB_EXTERNAL_CAPABILITY_ISSUER_SCHEMA_V1;
  issue(binding: IabExternalExecutorBindingV1, nowMs?: number): Promise<
    | { ok: true; status: "issued"; capability: IabExternalCapabilityV1 }
    | { ok: false; status: "blocked"; exact_blocker: string }
  >;
};

export type CreateRootOwnedIabExternalCapabilityIssuerInputV1 = {
  /** Fresh identity readback owned by the root IAB integration. */
  readCurrentIdentity(binding: IabExternalExecutorBindingV1): Promise<IabIdentity>;
  /** Production should inject a secret-manager-backed signer. */
  sign?: RootOwnedIabExternalCapabilitySignerV1;
  /** Capability lifetime is bounded to the executor's five-minute maximum. */
  ttl_ms?: number;
};

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const noncePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hashPattern = /^[a-f0-9]{64}$/;

function blocker(error: unknown, fallback: string): string {
  const value = error instanceof Error ? error.message : "";
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value) ? value : fallback;
}

function assertIdentityMatches(binding: IabExternalExecutorBindingV1, identity: IabIdentity): void {
  const fields: Array<[string, unknown, unknown]> = [
    ["generation", identity.generation, binding.iab_generation],
    ["project_id", identity.project_id, binding.iab_project_id],
    ["thread_id", identity.thread_id, binding.iab_thread_id],
    ["session_id", identity.session_id, binding.session_id],
    ["turn_id", identity.turn_id, binding.turn_id],
    ["nonce", identity.nonce, binding.nonce],
    ["stage", identity.stage, binding.stage_id],
    ["attempt", identity.attempt, binding.fencing_token]
  ];
  for (const [field, actual, expected] of fields) {
    if (actual !== expected) throw new Error(`iab_external_capability_issuer_identity_mismatch:${field}`);
  }
}

function assertBindingShape(binding: IabExternalExecutorBindingV1): void {
  for (const [field, value] of Object.entries(binding)) {
    if (field === "fencing_token" || field === "approval_revision") {
      if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`iab_external_capability_issuer_${field}_invalid`);
    } else if (field.endsWith("_hash") || field === "effect_key" || field === "manifest_hash") {
      if (typeof value !== "string" || !hashPattern.test(value)) throw new Error(`iab_external_capability_issuer_${field}_invalid`);
    } else if (field === "nonce") {
      if (typeof value !== "string" || !noncePattern.test(value)) throw new Error("iab_external_capability_issuer_nonce_invalid");
    } else if (typeof value !== "string" || !identifierPattern.test(value)) {
      throw new Error(`iab_external_capability_issuer_${field}_invalid`);
    }
  }
}

function nowValue(nowMs: number | undefined): number {
  const value = nowMs ?? Date.now();
  if (!Number.isFinite(value)) throw new Error("iab_external_capability_issuer_clock_invalid");
  return value;
}

export function createRootOwnedIabExternalCapabilityIssuerV1(
  input: CreateRootOwnedIabExternalCapabilityIssuerInputV1
): RootOwnedIabExternalCapabilityIssuerV1 {
  const ttlMs = input.ttl_ms ?? 4 * 60 * 1000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 5 * 60 * 1000) {
    throw new Error("iab_external_capability_issuer_ttl_invalid");
  }
  if (typeof input.readCurrentIdentity !== "function") {
    throw new Error("iab_external_capability_issuer_runtime_reader_required");
  }
  const sign = input.sign ?? signIabExternalCapabilityV1;

  return {
    schema: IAB_EXTERNAL_CAPABILITY_ISSUER_SCHEMA_V1,
    async issue(binding, requestedNowMs) {
      try {
        assertBindingShape(binding);
        const nowMs = nowValue(requestedNowMs);
        let identity: IabIdentity;
        try {
          identity = await input.readCurrentIdentity(binding);
        } catch (error) {
          return { ok: false, status: "blocked", exact_blocker: blocker(error, "trusted_current_turn_iab_runtime_not_available") };
        }
        assertIdentityMatches(binding, identity);
        const issuedAt = new Date(nowMs).toISOString();
        const expiresAt = new Date(nowMs + ttlMs).toISOString();
        const unsigned: Omit<IabExternalCapabilityV1, "capability_mac"> = {
          schema: "service_readiness_iab_external_capability.v1",
          surface: "in_app_browser",
          company_id: binding.company_id,
          root_id: binding.root_id,
          issuer_service_user_id: binding.issuer_service_user_id,
          manifest_hash: binding.manifest_hash,
          workflow_id: binding.workflow_id,
          run_id: binding.run_id,
          stage_id: binding.stage_id,
          attempt_id: binding.attempt_id,
          fencing_token: binding.fencing_token,
          capability_id: binding.capability_id,
          turn_id: binding.turn_id,
          session_id: binding.session_id,
          nonce: binding.nonce,
          iab_identity: identity,
          capability_mode: "external",
          effect_class: "external_non_idempotent",
          effect_key: binding.effect_key,
          provider: binding.provider,
          account_ref: binding.account_ref,
          target_hash: binding.target_hash,
          payload_hash: binding.payload_hash,
          approval_id: binding.approval_id,
          approval_revision: binding.approval_revision,
          approval_payload_hash: binding.approval_payload_hash,
          issued_at: issuedAt,
          expires_at: expiresAt,
          external_action_executed: false,
          legacy_surfaces_forbidden: true,
          prior_receipt_reuse: false
        };
        const capability = sign(unsigned);
        const validation = validateIabExternalCapabilityV1(capability, nowMs);
        if (!validation.ok) return { ok: false, status: "blocked", exact_blocker: validation.exact_blocker };
        return { ok: true, status: "issued", capability: validation.value };
      } catch (error) {
        return { ok: false, status: "blocked", exact_blocker: blocker(error, "iab_external_capability_issuer_failed") };
      }
    }
  };
}

import {
  type IabHandlerReceipt,
  type IabReadonlyContract,
  type IabValidationResult,
  type IabProvenanceValidationOptions,
  validateIabHandlerReceipt,
  validateIabReadonlyContract,
  IAB_CONTRACT_VERSION
} from "./iabReadOnlyBridge.js";

/**
 * A deliberately lossy owner-facing projection.  It is safe to return from
 * an admin/status endpoint: no ids, nonce, filesystem path, DOM, URL, or
 * receipt hash cross this boundary.
 */
export type IabOwnerDiagnostics = {
  state: "ready" | "blocked" | "consumed";
  contract_version: string;
  receipt_fresh: boolean;
  consumed: boolean;
  provenance: "trusted_state_root" | "blocked";
  generation: "match" | "mismatch" | "unknown";
  proof: "verified" | "missing" | "invalid";
  cleanup: "verified" | "missing" | "invalid";
  age_ms: number | null;
  binding: "matched" | "mismatch" | "unknown";
  exact_blocker: string | null;
  existing_workflows_unchanged: boolean;
};

export type IabOwnerDiagnosticsInput = {
  contract: unknown;
  receipt: unknown;
  now?: Date;
  consumed?: boolean;
  claimedGeneration?: unknown;
  existingWorkflowsUnchanged?: boolean;
  trustedProvenanceVerifier?: IabProvenanceValidationOptions["trustedProvenanceVerifier"];
  trustedStateRootEvidence?: IabProvenanceValidationOptions["trustedStateRootEvidence"];
};

const SAFE_BLOCKER = /^[a-z0-9_.:-]{1,160}$/;

function blockerOf(value: IabValidationResult<unknown>): string | null {
  return value.ok ? null : SAFE_BLOCKER.test(value.exact_blocker) ? value.exact_blocker : "iab_validation_blocked";
}

function generationState(contract: IabValidationResult<IabReadonlyContract>, receipt: IabValidationResult<IabHandlerReceipt>, claimedGeneration: unknown): IabOwnerDiagnostics["generation"] {
  if (!contract.ok || !receipt.ok) return "unknown";
  if (claimedGeneration !== undefined && (typeof claimedGeneration !== "string" || claimedGeneration !== contract.value.generation)) return "mismatch";
  const identityKeys = ["generation", "project_id", "thread_id", "session_id", "turn_id", "nonce", "stage", "attempt"] as const;
  return identityKeys.every((key) => contract.value[key] === receipt.value[key]) ? "match" : "mismatch";
}

export function projectIabOwnerDiagnostics(input: IabOwnerDiagnosticsInput): IabOwnerDiagnostics {
  const now = input.now ?? new Date();
  const provenanceOptions = { trustedProvenanceVerifier: input.trustedProvenanceVerifier, trustedStateRootEvidence: input.trustedStateRootEvidence };
  const contract = validateIabReadonlyContract(input.contract, { now, ...provenanceOptions });
  const receipt = validateIabHandlerReceipt(input.receipt, { now, ...provenanceOptions });
  const consumed = input.consumed === true;
  const contractVersion = contract.ok ? contract.value.contract_version : receipt.ok ? receipt.value.contract_version : IAB_CONTRACT_VERSION;
  const contractBinding = contract.ok && receipt.ok
    ? contract.value.contract_id === receipt.value.contract_id
      && contract.value.target.target_request_sha256 === receipt.value.target.target_request_sha256
      && ["generation", "project_id", "thread_id", "session_id", "turn_id", "nonce", "stage", "attempt"].every((key) => contract.value[key as keyof IabReadonlyContract] === receipt.value[key as keyof IabHandlerReceipt])
    : undefined;
  const ageMs = receipt.ok ? Math.max(0, now.getTime() - Date.parse(receipt.value.issued_at)) : null;
  const workflowsUnchanged = input.existingWorkflowsUnchanged === true;
  const blocker = blockerOf(contract)
    ?? blockerOf(receipt)
    ?? (contractBinding === false ? "iab_receipt_contract_binding_mismatch" : null)
    ?? (!workflowsUnchanged ? "iab_existing_workflows_unchanged_unverified" : null);
  const state: IabOwnerDiagnostics["state"] = blocker ? "blocked" : consumed ? "consumed" : "ready";
  return {
    state,
    contract_version: contractVersion,
    receipt_fresh: receipt.ok,
    consumed,
    provenance: contract.ok && receipt.ok ? "trusted_state_root" : "blocked",
    generation: generationState(contract, receipt, input.claimedGeneration),
    proof: receipt.ok ? "verified" : "invalid",
    cleanup: receipt.ok ? "verified" : "invalid",
    age_ms: ageMs,
    binding: contractBinding === true ? "matched" : contractBinding === false ? "mismatch" : "unknown",
    exact_blocker: blocker,
    existing_workflows_unchanged: workflowsUnchanged
  };
}

export const getIabOwnerDiagnostics = projectIabOwnerDiagnostics;

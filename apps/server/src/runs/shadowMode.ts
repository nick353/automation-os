import { createHash } from "node:crypto";
import { validateTaskContract, type TaskContractV1 } from "../taskContracts/taskContract.js";

export const SHADOW_MODE_SCHEMA_V1 = "automation_os_shadow_mode.v1" as const;
export type ShadowModeResultV1 = { schema: typeof SHADOW_MODE_SCHEMA_V1; mode: "shadow" | "effectful"; contract_id: string; target_binding_digest: string; authority_digest: string | null; approval_required: boolean; external_action_executed: false; provider_receipt: "no_effect" | "pending"; source_sync: "no_effect" | "pending"; reconciliation: "no_effect" | "pending"; cleanup: "verified" | "pending"; exact_blocker: string | null; promotion: "eligible" | "not_eligible" };

const HASH = /^[a-f0-9]{64}$/u;
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export function executeShadowMode(contract: TaskContractV1): ShadowModeResultV1 {
  const current = validateTaskContract(contract);
  const eligible = current.approval.required ? current.approval.status === "approved" : true;
  return { schema: SHADOW_MODE_SCHEMA_V1, mode: "shadow", contract_id: current.contract_id, target_binding_digest: digest({ target: current.target.digest, audience: current.target.audience_digest, payload: current.payload.digest }), authority_digest: current.authority.digest, approval_required: current.approval.required, external_action_executed: false, provider_receipt: eligible ? "no_effect" : "pending", source_sync: eligible ? "no_effect" : "pending", reconciliation: eligible ? "no_effect" : "pending", cleanup: "verified", exact_blocker: eligible ? null : "shadow_effect_approval_pending", promotion: eligible ? "eligible" : "not_eligible" };
}

export function promoteShadowToEffectful(input: { shadow: ShadowModeResultV1; freshTargetBindingDigest: string; approved: boolean }): { status: "eligible" | "blocked"; exact_blocker: string | null } {
  if (!HASH.test(input.freshTargetBindingDigest) || input.freshTargetBindingDigest !== input.shadow.target_binding_digest) return { status: "blocked", exact_blocker: "shadow_target_binding_changed_reapproval_required" };
  if (!input.approved) return { status: "blocked", exact_blocker: "shadow_effect_approval_pending" };
  if (input.shadow.external_action_executed !== false || input.shadow.cleanup !== "verified") return { status: "blocked", exact_blocker: "shadow_preflight_proof_invalid" };
  return { status: "eligible", exact_blocker: null };
}

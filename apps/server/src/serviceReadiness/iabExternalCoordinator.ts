import {
  executeIabExternalEffectV1,
  type IabExternalExecutorBindingV1,
  type IabExternalExecutorResultV1,
  type IabExternalReservationV1,
  type RootOwnedIabExternalAtomicGateV1,
  type RootOwnedIabExternalRuntimeV1
} from "./iabExternalExecutor.js";
import type { RootOwnedIabExternalCapabilityIssuerV1 } from "./iabExternalCapabilityIssuer.js";

/**
 * The only coordinator surface allowed to turn an external admission into an
 * executor call.  Runtime, gate, and issuer dependencies are captured in the
 * closure; callers cannot replace them per attempt or pass a serialized
 * capability through a child worker.
 */
export const IAB_EXTERNAL_COORDINATOR_SCHEMA_V1 = "service_readiness_iab_external_coordinator.v1" as const;

export type RootOwnedIabExternalCoordinatorAdmissionV1 = {
  release_admission: "approved";
  workflow_status: "active";
  account_status: "verified";
  external_execution_authorized: true;
};

export type CreateRootOwnedIabExternalCoordinatorInputV1 = {
  issuer: RootOwnedIabExternalCapabilityIssuerV1;
  runtime: RootOwnedIabExternalRuntimeV1;
  atomic_gate: RootOwnedIabExternalAtomicGateV1;
  admission: RootOwnedIabExternalCoordinatorAdmissionV1;
};

export type RootOwnedIabExternalCoordinatorV1 = {
  schema: typeof IAB_EXTERNAL_COORDINATOR_SCHEMA_V1;
  execute(input: {
    binding: IabExternalExecutorBindingV1;
    now_ms?: number;
    before_provider_call?: (reservation: IabExternalReservationV1) => Promise<void>;
  }): Promise<IabExternalExecutorResultV1>;
};

function blocked(exactBlocker: string): IabExternalExecutorResultV1 {
  return {
    schema: "service_readiness_iab_external_executor.v1",
    status: "blocked",
    provider_called: false,
    approval_consumed: false,
    ledger_reserved: false,
    cleanup_verified: false,
    provider_receipt_hash: null,
    cleanup_receipt_hash: null,
    external_action_executed: false,
    exact_blocker: exactBlocker,
    safe_resume_step: "repair_root_owned_external_admission_before_retry"
  };
}

function assertAdmission(admission: RootOwnedIabExternalCoordinatorAdmissionV1): string | null {
  if (!admission || admission.release_admission !== "approved") return "company_release_admission_required";
  if (admission.workflow_status !== "active") return "canonical_registered_workflow_not_active";
  if (admission.account_status !== "verified") return "iab_external_account_not_verified";
  if (admission.external_execution_authorized !== true) return "iab_external_execution_not_authorized";
  return null;
}

export function createRootOwnedIabExternalCoordinatorV1(
  input: CreateRootOwnedIabExternalCoordinatorInputV1
): RootOwnedIabExternalCoordinatorV1 {
  const admissionError = assertAdmission(input.admission);
  if (admissionError) throw new Error(admissionError);
  if (!input.issuer || !input.runtime || !input.atomic_gate) throw new Error("iab_external_root_dependencies_required");
  return {
    schema: IAB_EXTERNAL_COORDINATOR_SCHEMA_V1,
    async execute({ binding, now_ms, before_provider_call }) {
      const issued = await input.issuer.issue(binding, now_ms);
      if (!issued.ok) return blocked(issued.exact_blocker);
      return executeIabExternalEffectV1({
        binding,
        capability: issued.capability,
        runtime: input.runtime,
        atomic_gate: input.atomic_gate,
        before_provider_call,
        now_ms
      });
    }
  };
}

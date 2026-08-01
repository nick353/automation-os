import {
  claimNextDurableJob,
  listDurableJobs,
  processClaimedDurableExternalJobOnce,
  reconcileDurableExternalJobOnce,
  recoverExpiredDurableJobs,
  type DurableJob,
  type DurableExternalReconciliationReadbackV1,
  type ProcessClaimedDurableExternalJobInputV1
} from "./durableQueue.js";
import {
  createRootOwnedIabExternalCoordinatorV1,
  type RootOwnedIabExternalCoordinatorAdmissionV1,
  type RootOwnedIabExternalCoordinatorV1
} from "../serviceReadiness/iabExternalCoordinator.js";
import type { RootOwnedIabExternalCapabilityIssuerV1 } from "../serviceReadiness/iabExternalCapabilityIssuer.js";
import type {
  IabExternalExecutorBindingV1,
  IabExternalExecutorResultV1,
  RootOwnedIabExternalAtomicGateV1,
  RootOwnedIabExternalRuntimeV1
} from "../serviceReadiness/iabExternalExecutor.js";

export const DURABLE_EXTERNAL_WORKER_RUNTIME_BLOCKER = "trusted_current_turn_iab_runtime_not_bound_to_registered_runner" as const;
export const DURABLE_EXTERNAL_WORKER_ISSUER_BLOCKER = "trusted_current_turn_iab_capability_issuer_not_bound_to_registered_runner" as const;
export const DURABLE_EXTERNAL_WORKER_ATOMIC_GATE_BLOCKER = "trusted_current_turn_iab_atomic_gate_not_bound_to_registered_runner" as const;
export const DURABLE_EXTERNAL_WORKER_ADMISSION_BLOCKER = "trusted_current_turn_iab_root_admission_invalid" as const;
export const DURABLE_EXTERNAL_WORKER_RECONCILIATION_BLOCKER = "external_queue_reconciliation_required" as const;

/**
 * The dependencies below are deliberately passed as a single root-owned
 * bundle.  The worker does not construct any of them and never discovers a
 * browser, provider, or secret.  Keeping this bundle explicit makes the
 * normal CLI's unbound state observable while preserving the queued job.
 */
export type DurableExternalWorkerRootDependenciesV1 = {
  runtime: RootOwnedIabExternalRuntimeV1;
  issuer: RootOwnedIabExternalCapabilityIssuerV1;
  atomic_gate: RootOwnedIabExternalAtomicGateV1;
};

export type DurableExternalWorkerInputV1 = {
  companyId: string;
  serviceUserId: string;
  coordinator?: RootOwnedIabExternalCoordinatorV1;
  rootDependencies?: Partial<DurableExternalWorkerRootDependenciesV1>;
  /** Optional only when the caller asks this worker to build the coordinator. */
  rootAdmission?: RootOwnedIabExternalCoordinatorAdmissionV1;
  buildBinding?: ProcessClaimedDurableExternalJobInputV1["buildBinding"];
  reconcile?: (input: {
    job: DurableJob;
    binding: IabExternalExecutorBindingV1;
    reservationId: string | null;
  }) => Promise<DurableExternalReconciliationReadbackV1>;
  now?: string;
  nowMs?: number;
  leaseMs?: number;
};

export type DurableExternalWorkerResultV1 = {
  status: "idle" | "blocked" | "completed" | "reconciliation_required";
  recoveredJobIds: string[];
  pendingExternalJobIds: string[];
  job: DurableJob | null;
  result: IabExternalExecutorResultV1 | null;
  reconciliation: DurableExternalReconciliationReadbackV1 | null;
  exactBlocker: string | null;
  externalActionExecuted: boolean;
};

/**
 * Root-owned external queue callsite.
 *
 * The normal CLI worker deliberately has no browser/provider runtime.  In
 * that state this function reports the exact blocker before claiming a job,
 * so queued non-idempotent work remains untouched.  A first-class Codex root
 * may inject the trusted coordinator plus its root dependency bundle and
 * binding builder.  Alternatively, a root can provide the dependency bundle
 * and current release admission and let this boundary construct the
 * coordinator.  Only then is a single external job claimed and handed to the
 * durable one-shot bridge.
 */
export async function runDurableExternalWorkerOnce(input: DurableExternalWorkerInputV1): Promise<DurableExternalWorkerResultV1> {
  const recovered = recoverExpiredDurableJobs({
    companyId: input.companyId,
    serviceUserId: input.serviceUserId,
    now: input.now
  });
  const pending = pendingExternalJobs(input.companyId);
  const bindingBuilderReady = typeof input.buildBinding === "function";
  const rootDependencyBlocker = missingRootDependencyBlocker(input.rootDependencies);
  const resolvedCoordinator = resolveRootCoordinator(input, rootDependencyBlocker);
  const coordinatorReady = Boolean(resolvedCoordinator.coordinator && typeof resolvedCoordinator.coordinator.execute === "function");

  const pendingReconciliation = pending.find((job) => job.status === "reconciliation_required");
  if (pendingReconciliation) {
    if (!bindingBuilderReady || typeof input.reconcile !== "function") {
      return {
        status: "blocked",
        recoveredJobIds: recovered.map((job) => job.id),
        pendingExternalJobIds: pending.map((job) => job.id),
        job: null,
        result: null,
        reconciliation: null,
        exactBlocker: DURABLE_EXTERNAL_WORKER_RECONCILIATION_BLOCKER,
        externalActionExecuted: false
      };
    }
    const reconciled = await reconcileDurableExternalJobOnce({
      companyId: input.companyId,
      jobId: pendingReconciliation.id,
      serviceUserId: input.serviceUserId,
      buildBinding: input.buildBinding!,
      readback: input.reconcile,
      now: input.now
    });
    return {
      status: reconciled.job.status === "completed" ? "completed" : "reconciliation_required",
      recoveredJobIds: recovered.map((job) => job.id),
      pendingExternalJobIds: pendingExternalJobs(input.companyId).map((job) => job.id),
      job: reconciled.job,
      result: null,
      reconciliation: reconciled.readback,
      exactBlocker: reconciled.readback.exactBlocker,
      externalActionExecuted: reconciled.readback.externalActionExecuted
    };
  }

  if (!coordinatorReady || !bindingBuilderReady || rootDependencyBlocker) {
    const exactBlocker = resolvedCoordinator.exactBlocker
      ?? (!bindingBuilderReady
        ? "trusted_current_turn_root_binding_builder_not_bound_to_registered_runner"
        : rootDependencyBlocker ?? DURABLE_EXTERNAL_WORKER_RUNTIME_BLOCKER);
    return {
      status: pending.length ? "blocked" : "idle",
      recoveredJobIds: recovered.map((job) => job.id),
      pendingExternalJobIds: pending.map((job) => job.id),
      job: null,
      result: null,
      reconciliation: null,
      exactBlocker: pending.length ? exactBlocker : null,
      externalActionExecuted: false
    };
  }

  const claim = claimNextDurableJob({
    companyId: input.companyId,
    serviceUserId: input.serviceUserId,
    kinds: ["external_iab"],
    now: input.now,
    leaseMs: input.leaseMs
  });
  if (!claim) {
    const reconciliationPending = pending.some((job) => job.status === "reconciliation_required");
    return {
      status: reconciliationPending ? "blocked" : "idle",
      recoveredJobIds: recovered.map((job) => job.id),
      pendingExternalJobIds: pending.map((job) => job.id),
      job: null,
      result: null,
      reconciliation: null,
      exactBlocker: reconciliationPending ? DURABLE_EXTERNAL_WORKER_RECONCILIATION_BLOCKER : null,
      externalActionExecuted: false
    };
  }

  const processed = await processClaimedDurableExternalJobOnce({
    companyId: input.companyId,
    jobId: claim.id,
    serviceUserId: input.serviceUserId,
    fencingToken: claim.fencingToken,
    coordinator: resolvedCoordinator.coordinator!,
    buildBinding: input.buildBinding!,
    now: input.now,
    nowMs: input.nowMs
  });
  return {
    status: processed.job.status === "completed" ? "completed" : "reconciliation_required",
    recoveredJobIds: recovered.map((job) => job.id),
    pendingExternalJobIds: pendingExternalJobs(input.companyId).map((job) => job.id),
    job: processed.job,
    result: processed.result,
    reconciliation: null,
    exactBlocker: processed.result.exact_blocker,
    externalActionExecuted: processed.result.external_action_executed === true
  };
}

function resolveRootCoordinator(
  input: DurableExternalWorkerInputV1,
  dependencyBlocker: string | null
): { coordinator: RootOwnedIabExternalCoordinatorV1 | null; exactBlocker: string | null } {
  if (input.coordinator) {
    return typeof input.coordinator.execute === "function"
      ? { coordinator: input.coordinator, exactBlocker: null }
      : { coordinator: null, exactBlocker: DURABLE_EXTERNAL_WORKER_RUNTIME_BLOCKER };
  }
  if (dependencyBlocker) return { coordinator: null, exactBlocker: dependencyBlocker };
  if (!input.rootAdmission) return { coordinator: null, exactBlocker: DURABLE_EXTERNAL_WORKER_ADMISSION_BLOCKER };
  try {
    return {
      coordinator: createRootOwnedIabExternalCoordinatorV1({
        issuer: input.rootDependencies!.issuer!,
        runtime: input.rootDependencies!.runtime!,
        atomic_gate: input.rootDependencies!.atomic_gate!,
        admission: input.rootAdmission
      }),
      exactBlocker: null
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    return {
      coordinator: null,
      exactBlocker: `${DURABLE_EXTERNAL_WORKER_ADMISSION_BLOCKER}:${/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(reason) ? reason : "invalid"}`
    };
  }
}

function missingRootDependencyBlocker(
  dependencies: DurableExternalWorkerInputV1["rootDependencies"]
): string | null {
  if (!dependencies || !dependencies.runtime || typeof dependencies.runtime.acquire !== "function") {
    return DURABLE_EXTERNAL_WORKER_RUNTIME_BLOCKER;
  }
  if (!dependencies.issuer || typeof dependencies.issuer.issue !== "function") {
    return DURABLE_EXTERNAL_WORKER_ISSUER_BLOCKER;
  }
  if (!dependencies.atomic_gate ||
      typeof dependencies.atomic_gate.assertApproval !== "function" ||
      typeof dependencies.atomic_gate.reserveAndConsume !== "function" ||
      typeof dependencies.atomic_gate.transition !== "function") {
    return DURABLE_EXTERNAL_WORKER_ATOMIC_GATE_BLOCKER;
  }
  return null;
}

function pendingExternalJobs(companyId: string): DurableJob[] {
  return listDurableJobs(companyId, 500).filter((job) =>
    job.executionMode === "external" &&
    ["queued", "leased", "reconciliation_required"].includes(job.status)
  );
}

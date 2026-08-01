import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  executeIabExternalEffectV1,
  hashIabExternalProviderReceiptV1,
  IAB_EXTERNAL_EXECUTOR_ATOMIC_GATE_BLOCKER,
  IAB_EXTERNAL_EXECUTOR_CLEANUP_BLOCKER,
  IAB_EXTERNAL_EXECUTOR_RUNTIME_BLOCKER,
  type IabExternalCleanupDraftV1,
  type IabExternalExecutorBindingV1,
  type IabExternalProviderOutcomeV1,
  type RootOwnedIabExternalAtomicGateV1,
  type RootOwnedIabExternalRuntimeV1
} from "../serviceReadiness/iabExternalExecutor.js";
import { signIabExternalCapabilityV1 } from "../serviceReadiness/iabExternalCapability.js";
import type { IabExternalCapabilityV1 } from "../serviceReadiness/iabExternalCapability.js";
import { computeServiceReadinessEffectKey } from "../serviceReadiness/effectLedger.js";
import { readTrustedRegisteredWorkflowManifestHash } from "../registeredWorkflows.js";

process.env.AUTOMATION_OS_IAB_CAPABILITY_SECRET = "test-only-iab-capability-secret-20260724-32-bytes";
const nowMs = Date.parse("2026-07-23T00:00:00.000Z");
const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function binding(): IabExternalExecutorBindingV1 {
  const targetHash = sha("target");
  const payloadHash = sha("payload");
  return {
    company_id: "company-a",
    service_user_id: "service-a",
    issuer_service_user_id: "service-a",
    iab_generation: "generation-a",
    iab_project_id: "project-a",
    iab_thread_id: "thread-a",
    job_id: "job-a",
    action_kind: "publish",
    policy_version: "policy-v1",
    manifest_hash: readTrustedRegisteredWorkflowManifestHash("daily-ai") as string,
    root_id: "root-a",
    workflow_id: "daily-ai",
    run_id: "run-a",
    stage_id: "publish",
    attempt_id: "attempt-a",
    fencing_token: 1,
    capability_id: "cap-a",
    turn_id: "turn-a",
    session_id: "session-a",
    nonce: "nonce-a",
    provider: "linkedin",
    account_ref: "account-a",
    target_hash: targetHash,
    payload_hash: payloadHash,
    effect_key: computeServiceReadinessEffectKey({
      company_id: "company-a",
      provider: "linkedin",
      account_ref: "account-a",
      target_hash: targetHash,
      payload_hash: payloadHash,
      effect_class: "external_non_idempotent"
    }),
    approval_id: "approval-a",
    approval_revision: 2,
    approval_payload_hash: payloadHash
  };
}

function capabilityFor(current: IabExternalExecutorBindingV1, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const body: Omit<IabExternalCapabilityV1, "capability_mac"> = {
    schema: "service_readiness_iab_external_capability.v1",
    surface: "in_app_browser",
    company_id: current.company_id,
    root_id: current.root_id,
    issuer_service_user_id: current.issuer_service_user_id,
    manifest_hash: current.manifest_hash,
    workflow_id: current.workflow_id,
    run_id: current.run_id,
    stage_id: current.stage_id,
    attempt_id: current.attempt_id,
    fencing_token: current.fencing_token,
    capability_id: current.capability_id,
    turn_id: current.turn_id,
    session_id: current.session_id,
    nonce: current.nonce,
    iab_identity: {
      generation: "generation-a",
      project_id: "project-a",
      thread_id: "thread-a",
      session_id: current.session_id,
      turn_id: current.turn_id,
      nonce: current.nonce,
      stage: current.stage_id,
      attempt: current.fencing_token
    },
    capability_mode: "external",
    effect_class: "external_non_idempotent",
    effect_key: current.effect_key,
    provider: current.provider,
    account_ref: current.account_ref,
    target_hash: current.target_hash,
    payload_hash: current.payload_hash,
    approval_id: current.approval_id,
    approval_revision: current.approval_revision,
    approval_payload_hash: current.approval_payload_hash,
    issued_at: "2026-07-23T00:00:00.000Z",
    expires_at: "2026-07-23T00:04:00.000Z",
    external_action_executed: false,
    legacy_surfaces_forbidden: true,
    prior_receipt_reuse: false,
    ...overrides
  };
  return signIabExternalCapabilityV1(body);
}

function providerReceipt(current: IabExternalExecutorBindingV1) {
  const base = {
    ...current,
    schema: "service_readiness_iab_external_provider_receipt.v1" as const,
    receipt_id: "provider-receipt-a",
    readback_uri: "file:///tmp/provider-readback-a.json",
    readback_hash: sha("provider-readback-a"),
    external_action_executed: true as const
  };
  return { ...base, receipt_hash: hashIabExternalProviderReceiptV1(base) };
}

function cleanupEvidence(
  current: IabExternalExecutorBindingV1,
  providerReceiptHash: string | null,
  effectExternalActionExecuted: boolean,
  overrides: Partial<IabExternalCleanupDraftV1> = {}
): IabExternalCleanupDraftV1 {
  const base = {
    schema: "service_readiness_iab_external_cleanup_receipt.v1" as const,
    root_id: current.root_id,
    workflow_id: current.workflow_id,
    run_id: current.run_id,
    stage_id: current.stage_id,
    attempt_id: current.attempt_id,
    fencing_token: current.fencing_token,
    capability_id: current.capability_id,
    effect_key: current.effect_key,
    provider_receipt_hash: providerReceiptHash,
    effect_external_action_executed: effectExternalActionExecuted,
    status: "verified" as const,
    capability_released: false as const,
    capability_release_readback_uri: null,
    capability_release_readback_hash: null,
    task_tab_finalized: true as const,
    no_residual_processes: true as const,
    no_external_cleanup_action: true as const,
    artifact_uri: "file:///tmp/iab-cleanup-a.json",
    created_at: "2026-07-23T00:03:00.000Z"
  };
  const merged = { ...base, ...overrides };
  return merged;
}

function fakeDependencies(current: IabExternalExecutorBindingV1, outcome: IabExternalProviderOutcomeV1) {
  const counts = {
    assertApproval: 0,
    acquire: 0,
    readIdentity: 0,
    reserveAndConsume: 0,
    executeOnce: 0,
    cleanup: 0,
    release: 0,
    transition: 0
  };
  const receiptHash = outcome.provider_receipt?.receipt_hash ?? null;
  let executed = false;
  const runtime: RootOwnedIabExternalRuntimeV1 = {
    async acquire() {
      counts.acquire += 1;
      return {
        async readIdentity() {
          counts.readIdentity += 1;
          return (capabilityFor(current).iab_identity as never);
        },
        async executeOnce() {
          counts.executeOnce += 1;
          executed = true;
          return outcome;
        },
        async cleanup() {
          counts.cleanup += 1;
          return cleanupEvidence(current, executed ? receiptHash : null, executed && outcome.external_action_executed);
        },
        async release() {
          counts.release += 1;
          return {
            released: true as const,
            readback_uri: "file:///tmp/iab-capability-release-a.json",
            readback_hash: sha("iab-capability-release-a")
          };
        }
      };
    }
  };
  let transitioned: Parameters<NonNullable<RootOwnedIabExternalAtomicGateV1["transition"]>>[0] | null = null;
  const gate: RootOwnedIabExternalAtomicGateV1 = {
    async assertApproval() {
      counts.assertApproval += 1;
    },
    async reserveAndConsume() {
      counts.reserveAndConsume += 1;
      return { reservation_id: "reservation-a", reservation_token: "a".repeat(64), effect_key: current.effect_key, approval_consumed: true, ledger_reserved: true };
    },
    async transition(input) {
      counts.transition += 1;
      transitioned = input;
    }
  };
  return { counts, runtime, gate, get transitioned() { return transitioned; } };
}

test("missing runtime stops before approval, ledger, provider, or cleanup calls", async () => {
  const current = binding();
  const outcome = { status: "succeeded" as const, external_action_executed: true, provider_receipt: providerReceipt(current), exact_blocker: null, safe_resume_step: null };
  const deps = fakeDependencies(current, outcome);
  const result = await executeIabExternalEffectV1({ capability: capabilityFor(current), binding: current, atomic_gate: deps.gate, now_ms: nowMs });
  assert.equal(result.status, "blocked");
  assert.equal(result.exact_blocker, IAB_EXTERNAL_EXECUTOR_RUNTIME_BLOCKER);
  assert.deepEqual(deps.counts, { assertApproval: 0, acquire: 0, readIdentity: 0, reserveAndConsume: 0, executeOnce: 0, cleanup: 0, release: 0, transition: 0 });
});

test("missing atomic gate stops before claiming the IAB runtime", async () => {
  const current = binding();
  const outcome = { status: "succeeded" as const, external_action_executed: true, provider_receipt: providerReceipt(current), exact_blocker: null, safe_resume_step: null };
  const deps = fakeDependencies(current, outcome);
  const result = await executeIabExternalEffectV1({ capability: capabilityFor(current), binding: current, runtime: deps.runtime, now_ms: nowMs });
  assert.equal(result.status, "blocked");
  assert.equal(result.exact_blocker, IAB_EXTERNAL_EXECUTOR_ATOMIC_GATE_BLOCKER);
  assert.equal(deps.counts.acquire, 0);
});

test("stale approval readback stops before claiming the IAB runtime", async () => {
  const current = binding();
  const outcome = { status: "succeeded" as const, external_action_executed: true, provider_receipt: providerReceipt(current), exact_blocker: null, safe_resume_step: null };
  const deps = fakeDependencies(current, outcome);
  const gate: RootOwnedIabExternalAtomicGateV1 = {
    ...deps.gate,
    async assertApproval() {
      deps.counts.assertApproval += 1;
      throw new Error("approval_binding_mismatch");
    }
  };
  const result = await executeIabExternalEffectV1({ capability: capabilityFor(current), binding: current, runtime: deps.runtime, atomic_gate: gate, now_ms: nowMs });
  assert.equal(result.status, "blocked");
  assert.equal(result.exact_blocker, "approval_binding_mismatch");
  assert.equal(deps.counts.acquire, 0);
});

test("capability expiry is rechecked after approval and before claiming the runtime", async () => {
  const current = binding();
  const outcome = { status: "succeeded" as const, external_action_executed: true, provider_receipt: providerReceipt(current), exact_blocker: null, safe_resume_step: null };
  const deps = fakeDependencies(current, outcome);
  let clock = nowMs;
  const gate: RootOwnedIabExternalAtomicGateV1 = {
    ...deps.gate,
    async assertApproval() {
      deps.counts.assertApproval += 1;
      clock = Date.parse("2026-07-23T00:05:00.000Z");
    }
  };
  const result = await executeIabExternalEffectV1({
    capability: capabilityFor(current),
    binding: current,
    runtime: deps.runtime,
    atomic_gate: gate,
    now_ms: nowMs,
    clock_ms: () => clock
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.exact_blocker, "iab_external_capability_expired");
  assert.equal(deps.counts.acquire, 0);
  assert.equal(deps.counts.executeOnce, 0);
});

test("capability expiry after reservation stops before the provider call", async () => {
  const current = binding();
  const outcome = { status: "succeeded" as const, external_action_executed: true, provider_receipt: providerReceipt(current), exact_blocker: null, safe_resume_step: null };
  const deps = fakeDependencies(current, outcome);
  let clock = nowMs;
  const gate: RootOwnedIabExternalAtomicGateV1 = {
    ...deps.gate,
    async reserveAndConsume() {
      deps.counts.reserveAndConsume += 1;
      clock = Date.parse("2026-07-23T00:05:00.000Z");
      return { reservation_id: "reservation-a", reservation_token: "a".repeat(64), effect_key: current.effect_key, approval_consumed: true, ledger_reserved: true };
    }
  };
  const result = await executeIabExternalEffectV1({
    capability: capabilityFor(current),
    binding: current,
    runtime: deps.runtime,
    atomic_gate: gate,
    now_ms: nowMs,
    clock_ms: () => clock
  });
  assert.equal(result.status, "reconciliation_required");
  assert.equal(result.exact_blocker, "iab_external_capability_expired");
  assert.equal(result.external_action_executed, false);
  assert.equal(deps.counts.executeOnce, 0);
  assert.equal(deps.counts.cleanup, 1);
  assert.equal(deps.counts.release, 1);
  assert.equal(deps.counts.transition, 0);
});

test("fresh runtime identity mismatch is cleaned up without reserving or executing", async () => {
  const current = binding();
  const outcome = { status: "succeeded" as const, external_action_executed: true, provider_receipt: providerReceipt(current), exact_blocker: null, safe_resume_step: null };
  const deps = fakeDependencies(current, outcome);
  const runtime: RootOwnedIabExternalRuntimeV1 = {
    async acquire(bindingArg) {
      const lease = await deps.runtime.acquire(bindingArg);
      return {
        ...lease,
        async readIdentity() {
          deps.counts.readIdentity += 1;
          const identity = capabilityFor(current).iab_identity as Record<string, unknown>;
          return { ...identity, session_id: "foreign-session" } as never;
        }
      };
    }
  };
  const result = await executeIabExternalEffectV1({ capability: capabilityFor(current), binding: current, runtime, atomic_gate: deps.gate, now_ms: nowMs });
  assert.equal(result.status, "blocked");
  assert.equal(result.exact_blocker, "iab_external_executor_runtime_identity_mismatch:session_id");
  assert.equal(deps.counts.reserveAndConsume, 0);
  assert.equal(deps.counts.executeOnce, 0);
  assert.equal(deps.counts.cleanup, 1);
  assert.equal(deps.counts.release, 1);
});

test("provider boundary rechecks the live IAB identity after reservation", async () => {
  const current = binding();
  const outcome = { status: "succeeded" as const, external_action_executed: true, provider_receipt: providerReceipt(current), exact_blocker: null, safe_resume_step: null };
  const deps = fakeDependencies(current, outcome);
  const runtime: RootOwnedIabExternalRuntimeV1 = {
    async acquire(bindingArg) {
      const lease = await deps.runtime.acquire(bindingArg);
      let reads = 0;
      return {
        ...lease,
        async readIdentity() {
          reads += 1;
          const identity = capabilityFor(current).iab_identity as Record<string, unknown>;
          return (reads === 2 ? { ...identity, project_id: "foreign-project" } : identity) as never;
        }
      };
    }
  };
  const result = await executeIabExternalEffectV1({ capability: capabilityFor(current), binding: current, runtime, atomic_gate: deps.gate, now_ms: nowMs });
  assert.equal(result.status, "reconciliation_required");
  assert.equal(result.exact_blocker, "iab_external_executor_runtime_identity_mismatch:project_id");
  assert.equal(deps.counts.executeOnce, 0);
  assert.equal(deps.counts.transition, 0);
});

test("atomic reservation failure is terminally safe and never calls the provider", async () => {
  const current = binding();
  const outcome = { status: "succeeded" as const, external_action_executed: true, provider_receipt: providerReceipt(current), exact_blocker: null, safe_resume_step: null };
  const deps = fakeDependencies(current, outcome);
  const gate: RootOwnedIabExternalAtomicGateV1 = {
    ...deps.gate,
    async reserveAndConsume() {
      deps.counts.reserveAndConsume += 1;
      throw new Error("effect_replay_forbidden");
    }
  };
  const result = await executeIabExternalEffectV1({ capability: capabilityFor(current), binding: current, runtime: deps.runtime, atomic_gate: gate, now_ms: nowMs });
  assert.equal(result.status, "blocked");
  assert.equal(result.exact_blocker, "effect_replay_forbidden");
  assert.equal(deps.counts.executeOnce, 0);
  assert.equal(deps.counts.cleanup, 1);
  assert.equal(deps.counts.release, 1);
});

test("provider-boundary admission failure stops before the provider call and preserves reconciliation", async () => {
  const current = binding();
  const outcome = { status: "succeeded" as const, external_action_executed: true, provider_receipt: providerReceipt(current), exact_blocker: null, safe_resume_step: null };
  const deps = fakeDependencies(current, outcome);
  let boundaryCalls = 0;
  const result = await executeIabExternalEffectV1({
    capability: capabilityFor(current),
    binding: current,
    runtime: deps.runtime,
    atomic_gate: deps.gate,
    before_provider_call: async () => {
      boundaryCalls += 1;
      throw new Error("durable_external_provider_boundary_persist_failed");
    },
    now_ms: nowMs
  });
  assert.equal(boundaryCalls, 1);
  assert.equal(result.status, "reconciliation_required");
  assert.equal(result.exact_blocker, "durable_external_provider_boundary_persist_failed");
  assert.equal(result.provider_called, false);
  assert.equal(deps.counts.executeOnce, 0);
  assert.equal(deps.counts.transition, 0);
  assert.equal(deps.counts.cleanup, 1);
  assert.equal(deps.counts.release, 1);
});

test("capability or manifest binding mismatch stops before all injected dependencies", async () => {
  const current = binding();
  const outcome = { status: "succeeded" as const, external_action_executed: true, provider_receipt: providerReceipt(current), exact_blocker: null, safe_resume_step: null };
  const deps = fakeDependencies(current, outcome);
  const result = await executeIabExternalEffectV1({
    capability: capabilityFor(current, { approval_revision: 1 }),
    binding: current,
    runtime: deps.runtime,
    atomic_gate: deps.gate,
    now_ms: nowMs
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.exact_blocker, "iab_external_executor_binding_mismatch:approval_revision");
  assert.deepEqual(deps.counts, { assertApproval: 0, acquire: 0, readIdentity: 0, reserveAndConsume: 0, executeOnce: 0, cleanup: 0, release: 0, transition: 0 });
});

test("synthetic runtime succeeds once and terminalizes only after same-run cleanup", async () => {
  const current = binding();
  const receipt = providerReceipt(current);
  const outcome = { status: "succeeded" as const, external_action_executed: true, provider_receipt: receipt, exact_blocker: null, safe_resume_step: null };
  const deps = fakeDependencies(current, outcome);
  const result = await executeIabExternalEffectV1({ capability: capabilityFor(current), binding: current, runtime: deps.runtime, atomic_gate: deps.gate, now_ms: nowMs });
  assert.equal(result.status, "succeeded");
  assert.equal(result.external_action_executed, true);
  assert.equal(result.provider_receipt_hash, receipt.receipt_hash);
  assert.equal(result.cleanup_verified, true);
  assert.deepEqual(deps.counts, { assertApproval: 1, acquire: 1, readIdentity: 2, reserveAndConsume: 1, executeOnce: 1, cleanup: 1, release: 1, transition: 1 });
  assert.equal(deps.transitioned?.status, "succeeded");
});

test("cleanup cannot terminalize until capability release readback is fresh", async () => {
  const current = binding();
  const receipt = providerReceipt(current);
  const outcome = { status: "succeeded" as const, external_action_executed: true, provider_receipt: receipt, exact_blocker: null, safe_resume_step: null };
  const deps = fakeDependencies(current, outcome);
  const runtime: RootOwnedIabExternalRuntimeV1 = {
    async acquire(bindingArg) {
      const lease = await deps.runtime.acquire(bindingArg);
      return {
        ...lease,
        async release() {
          deps.counts.release += 1;
          throw new Error("iab_capability_release_readback_missing");
        }
      };
    }
  };
  const result = await executeIabExternalEffectV1({ capability: capabilityFor(current), binding: current, runtime, atomic_gate: deps.gate, now_ms: nowMs });
  assert.equal(result.status, "reconciliation_required");
  assert.equal(result.exact_blocker, IAB_EXTERNAL_EXECUTOR_CLEANUP_BLOCKER);
  assert.equal(result.cleanup_verified, false);
  assert.equal(deps.counts.cleanup, 1);
  assert.equal(deps.counts.release, 1);
  assert.equal(deps.counts.transition, 0);
});

test("provider exception becomes reconciliation_required and is never retried", async () => {
  const current = binding();
  const outcome = { status: "ambiguous" as const, external_action_executed: true, provider_receipt: null, exact_blocker: "provider_timeout", safe_resume_step: "reconcile_provider" };
  const deps = fakeDependencies(current, outcome);
  const result = await executeIabExternalEffectV1({ capability: capabilityFor(current), binding: current, runtime: deps.runtime, atomic_gate: deps.gate, now_ms: nowMs });
  assert.equal(result.status, "reconciliation_required");
  assert.equal(result.exact_blocker, "provider_timeout");
  assert.equal(deps.counts.executeOnce, 1);
  assert.equal(deps.transitioned?.status, "reconciliation_required");
});

test("provider receipt and outcome effect flags cannot disagree", async () => {
  const current = binding();
  const receipt = providerReceipt(current);
  const outcome = { status: "failed" as const, external_action_executed: false, provider_receipt: receipt, exact_blocker: "provider_rejected", safe_resume_step: "review_provider" };
  const deps = fakeDependencies(current, outcome);
  const originalRuntime = deps.runtime;
  const runtime: RootOwnedIabExternalRuntimeV1 = {
    async acquire(bindingArg) {
      const lease = await originalRuntime.acquire(bindingArg);
      return {
        ...lease,
        async cleanup() {
          return cleanupEvidence(current, receipt.receipt_hash, true);
        }
      };
    }
  };
  const result = await executeIabExternalEffectV1({ capability: capabilityFor(current), binding: current, runtime, atomic_gate: deps.gate, now_ms: nowMs });
  assert.equal(result.status, "reconciliation_required");
  assert.equal(result.exact_blocker, "iab_external_provider_outcome_receipt_effect_flag_mismatch");
  assert.equal(result.external_action_executed, true);
  assert.equal(result.provider_receipt_hash, receipt.receipt_hash);
  assert.equal(deps.counts.executeOnce, 1);
  assert.equal(deps.transitioned?.status, "reconciliation_required");
  assert.equal(deps.transitioned?.external_action_executed, true);
});

test("provider receipt binding mismatch cannot produce success", async () => {
  const current = binding();
  const base = providerReceipt(current);
  const badBase = { ...base, account_ref: "foreign-account" };
  const badReceipt = { ...badBase, receipt_hash: hashIabExternalProviderReceiptV1(badBase) };
  const outcome = { status: "succeeded" as const, external_action_executed: true, provider_receipt: badReceipt, exact_blocker: null, safe_resume_step: null };
  const deps = fakeDependencies(current, outcome);
  const runtime: RootOwnedIabExternalRuntimeV1 = {
    async acquire(bindingArg) {
      const lease = await deps.runtime.acquire(bindingArg);
      return {
        ...lease,
        async cleanup() {
          return cleanupEvidence(current, null, true);
        }
      };
    }
  };
  const result = await executeIabExternalEffectV1({ capability: capabilityFor(current), binding: current, runtime, atomic_gate: deps.gate, now_ms: nowMs });
  assert.equal(result.status, "reconciliation_required");
  assert.equal(result.exact_blocker, "iab_external_provider_receipt_binding_mismatch:account_ref");
  assert.equal(deps.counts.executeOnce, 1);
  assert.equal(deps.transitioned?.status, "reconciliation_required");
});

test("foreign-run provider receipts cannot terminalize the current effect", async () => {
  const current = binding();
  const base = providerReceipt(current);
  const foreignBase = { ...base, run_id: "foreign-run" };
  const foreignReceipt = { ...foreignBase, receipt_hash: hashIabExternalProviderReceiptV1(foreignBase) };
  const outcome = { status: "succeeded" as const, external_action_executed: true, provider_receipt: foreignReceipt, exact_blocker: null, safe_resume_step: null };
  const deps = fakeDependencies(current, outcome);
  const originalRuntime = deps.runtime;
  const runtime: RootOwnedIabExternalRuntimeV1 = {
    async acquire(bindingArg) {
      const lease = await originalRuntime.acquire(bindingArg);
      return {
        ...lease,
        async cleanup() {
          return cleanupEvidence(current, null, true);
        }
      };
    }
  };
  const result = await executeIabExternalEffectV1({ capability: capabilityFor(current), binding: current, runtime, atomic_gate: deps.gate, now_ms: nowMs });
  assert.equal(result.status, "reconciliation_required");
  assert.equal(result.exact_blocker, "iab_external_provider_receipt_binding_mismatch:run_id");
  assert.equal(result.external_action_executed, true);
  assert.equal(result.provider_receipt_hash, null);
  assert.equal(deps.transitioned?.status, "reconciliation_required");
});

test("cleanup mismatch prevents success and leaves the effect for reconciliation", async () => {
  const current = binding();
  const receipt = providerReceipt(current);
  const outcome = { status: "succeeded" as const, external_action_executed: true, provider_receipt: receipt, exact_blocker: null, safe_resume_step: null };
  const deps = fakeDependencies(current, outcome);
  const originalRuntime = deps.runtime;
  const badRuntime: RootOwnedIabExternalRuntimeV1 = {
    async acquire(bindingArg) {
      const lease = await originalRuntime.acquire(bindingArg);
      return {
        ...lease,
        async cleanup() {
          return cleanupEvidence(current, receipt.receipt_hash, false);
        }
      };
    }
  };
  const result = await executeIabExternalEffectV1({ capability: capabilityFor(current), binding: current, runtime: badRuntime, atomic_gate: deps.gate, now_ms: nowMs });
  assert.equal(result.status, "reconciliation_required");
  assert.equal(result.exact_blocker, "iab_external_cleanup_effect_flag_mismatch");
  assert.equal(deps.counts.transition, 0);
});

test("read-only registry and root contracts remain separate from the external executor", async () => {
  const current = binding();
  const outcome = { status: "failed" as const, external_action_executed: false, provider_receipt: null, exact_blocker: "provider_rejected", safe_resume_step: "review_provider" };
  const deps = fakeDependencies(current, outcome);
  const result = await executeIabExternalEffectV1({ capability: capabilityFor(current), binding: current, runtime: deps.runtime, atomic_gate: deps.gate, now_ms: nowMs });
  assert.equal(result.status, "failed");
  assert.equal(result.external_action_executed, false);
  assert.equal(deps.transitioned?.status, "failed");
});

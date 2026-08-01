import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DurableExternalWorkerRootDependenciesV1 } from "../runs/durableExternalWorker.js";
import type { IabExternalExecutorBindingV1, IabExternalExecutorResultV1, IabExternalReservationV1 } from "../serviceReadiness/iabExternalExecutor.js";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-external-queue-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");

const db = await import("../db/client.js");
const { hashIdempotencyRequest } = await import("../automations/idempotency.js");
const queue = await import("../runs/durableQueue.js");
const { runDurableDryRunWorkerOnce } = await import("../runs/durableDryRunWorker.js");
const { runDurableExternalWorkerOnce } = await import("../runs/durableExternalWorker.js");

const now = "2029-01-01T00:00:00.000Z";
let seedNo = 0;

function seed() {
  db.initDb();
  const suffix = ++seedNo;
  const companyId = `company_external_queue_${suffix}`;
  const serviceUserId = `service_external_queue_${suffix}`;
  const automationId = `automation_external_queue_${suffix}`;
  const versionId = `version_external_queue_${suffix}`;
  db.insert("users", {
    id: serviceUserId,
    auth_provider: "service",
    auth_subject: serviceUserId,
    email: null,
    display_name: serviceUserId,
    kind: "service",
    status: "active",
    created_at: now,
    updated_at: now
  });
  db.insert("companies", { id: companyId, slug: companyId, name: companyId, status: "active", created_at: now, updated_at: now });
  db.insert("company_memberships", { id: `${companyId}_membership`, company_id: companyId, user_id: serviceUserId, role: "operator", status: "active", created_at: now, updated_at: now });
  db.insert("mvp_automations", {
    id: automationId,
    company_id: companyId,
    project_id: companyId,
    automation_type: "daily-ai",
    name: automationId,
    description: "external queue test",
    goal: "root-owned external queue admission",
    schedule: "manual",
    cadence: "manual",
    lane: "in_app_browser",
    risk_level: "high",
    approval_policy: "required_before_external_action",
    worker_command_kind: "safe_local_demo",
    create_approval: 1,
    status: "active",
    builder_spec_json: {},
    current_version_id: versionId,
    revision: 1,
    archived_at: null,
    created_at: now,
    updated_at: now
  });
  db.insert("mvp_automation_versions", {
    id: versionId,
    company_id: companyId,
    project_id: companyId,
    automation_id: automationId,
    revision: 1,
    automation_type: "daily-ai",
    name: automationId,
    description: "external queue test",
    goal: "root-owned external queue admission",
    schedule: "manual",
    cadence: "manual",
    lane: "in_app_browser",
    risk_level: "high",
    approval_policy: "required_before_external_action",
    worker_command_kind: "safe_local_demo",
    create_approval: 1,
    status: "active",
    builder_spec_json: {},
    created_at: now,
    updated_at: now
  });
  return { companyId, serviceUserId, automationId };
}

function admission(companyId: string, payloadHash: string) {
  return {
    schema: "service_readiness_external_queue_admission.v1" as const,
    company_id: companyId,
    workflow_id: "daily-ai" as const,
    provider: "linkedin",
    account_ref: "account-external-queue",
    target_hash: createHash("sha256").update("target").digest("hex"),
    payload_hash: payloadHash,
    release_admission_id: "release-admission-external-queue",
    release_admission: "approved" as const,
    workflow_status: "active" as const,
    account_status: "verified" as const,
    external_execution_authorized: true as const,
    no_auto_retry: true as const,
    legacy_surfaces_forbidden: true as const
  };
}

function syntheticBinding(job: { companyId: string; runId: string; id: string; fencingToken: number; externalIntent: Record<string, unknown> }, attemptId: string): IabExternalExecutorBindingV1 {
  const targetHash = String(job.externalIntent.target_hash);
  const payloadHash = String(job.externalIntent.payload_hash);
  return {
    company_id: job.companyId,
    service_user_id: `service_external_queue_${seedNo}`,
    issuer_service_user_id: `service_external_queue_${seedNo}`,
    iab_generation: "generation-synthetic",
    iab_project_id: "project-synthetic",
    iab_thread_id: "thread-synthetic",
    job_id: job.id,
    action_kind: "external_iab",
    policy_version: "policy-synthetic",
    manifest_hash: createHash("sha256").update("manifest-synthetic").digest("hex"),
    root_id: `root-${job.runId}`,
    workflow_id: String(job.externalIntent.workflow_id),
    run_id: job.runId,
    stage_id: "external_iab",
    attempt_id: attemptId,
    fencing_token: job.fencingToken,
    capability_id: "capability-synthetic",
    turn_id: "turn-synthetic",
    session_id: "session-synthetic",
    nonce: "nonce-synthetic",
    provider: String(job.externalIntent.provider),
    account_ref: String(job.externalIntent.account_ref),
    target_hash: targetHash,
    payload_hash: payloadHash,
    effect_key: createHash("sha256").update(`${job.companyId}:${job.id}`).digest("hex"),
    approval_id: "approval-synthetic",
    approval_revision: 1,
    approval_payload_hash: payloadHash
  };
}

function syntheticRootDependencies(): DurableExternalWorkerRootDependenciesV1 {
  return {
    runtime: {
      acquire: async () => {
        throw new Error("synthetic_root_runtime_not_called");
      }
    },
    issuer: {
      schema: "service_readiness_iab_external_capability_issuer.v1",
      issue: async () => ({ ok: false as const, status: "blocked" as const, exact_blocker: "synthetic_root_issuer_not_called" })
    },
    atomic_gate: {
      assertApproval: async () => undefined,
      reserveAndConsume: async () => {
        throw new Error("synthetic_root_atomic_gate_not_called");
      },
      transition: async () => undefined
    }
  };
}

function successfulExternalResult(): IabExternalExecutorResultV1 {
  return {
    schema: "service_readiness_iab_external_executor.v1",
    status: "succeeded",
    provider_called: true,
    approval_consumed: true,
    ledger_reserved: true,
    cleanup_verified: true,
    provider_receipt_hash: createHash("sha256").update("provider-receipt-synthetic").digest("hex"),
    cleanup_receipt_hash: createHash("sha256").update("cleanup-receipt-synthetic").digest("hex"),
    external_action_executed: true,
    exact_blocker: null,
    safe_resume_step: null
  };
}

function rootCoordinatorAdmission() {
  return {
    release_admission: "approved" as const,
    workflow_status: "active" as const,
    account_status: "verified" as const,
    external_execution_authorized: true as const
  };
}

function activeSlot(companyId: string, concurrencyKey: string): number {
  return Number(db.querySql<{ active_count: number }>(
    `SELECT active_count FROM durable_concurrency_slots WHERE company_id=${db.sqlValue(companyId)} AND concurrency_key=${db.sqlValue(concurrencyKey)} LIMIT 1`
  )[0]?.active_count ?? 0);
}

async function seedPendingReconciliation(fixture: ReturnType<typeof seed>, idempotencyKey: string) {
  const payload = { message: "synthetic pending reconciliation" };
  const queuePayload = { ...payload, dry_run: false, external_action_allowed: true };
  const job = queue.enqueueAutomationExternalEffect({
    companyId: fixture.companyId,
    actorUserId: fixture.serviceUserId,
    automationId: fixture.automationId,
    idempotencyKey,
    payload,
    admission: admission(fixture.companyId, hashIdempotencyRequest(queuePayload))
  });
  const claim = queue.claimNextDurableJob({ companyId: fixture.companyId, serviceUserId: fixture.serviceUserId, kinds: ["external_iab"], now });
  assert.ok(claim);
  const coordinator = {
    schema: "service_readiness_iab_external_coordinator.v1" as const,
    async execute(input: { binding: IabExternalExecutorBindingV1; before_provider_call?: (reservation: IabExternalReservationV1) => Promise<void> }): Promise<IabExternalExecutorResultV1> {
      await input.before_provider_call?.({
        reservation_id: `${idempotencyKey}-reservation`,
        reservation_token: `${idempotencyKey}-token`,
        effect_key: input.binding.effect_key,
        approval_consumed: true,
        ledger_reserved: true
      });
      return {
        ...successfulExternalResult(),
        status: "reconciliation_required",
        cleanup_verified: false,
        external_action_executed: true,
        exact_blocker: "iab_external_provider_outcome_ambiguous",
        safe_resume_step: "reconcile_external_provider_readback"
      };
    }
  };
  const processed = await queue.processClaimedDurableExternalJobOnce({
    companyId: fixture.companyId,
    jobId: job.id,
    serviceUserId: fixture.serviceUserId,
    fencingToken: claim.fencingToken,
    coordinator,
    buildBinding: ({ job: claimedJob, attemptId }) => syntheticBinding(claimedJob, attemptId),
    now
  });
  assert.equal(processed.job.status, "reconciliation_required");
  return job;
}

test("external queue admission is durable, root-bound, and excluded from dry-run workers", () => {
  const fixture = seed();
  const payload = { message: "synthetic external intent" };
  const queuePayload = { ...payload, dry_run: false, external_action_allowed: true };
  const job = queue.enqueueAutomationExternalEffect({
    companyId: fixture.companyId,
    actorUserId: fixture.serviceUserId,
    automationId: fixture.automationId,
    idempotencyKey: "external-queue-once",
    payload,
    admission: admission(fixture.companyId, hashIdempotencyRequest(queuePayload))
  });
  assert.equal(job.executionMode, "external");
  assert.equal(job.maxAttempts, 1);
  assert.equal(job.providerCalled, false);
  assert.equal(job.externalIntent.no_auto_retry, true);
  assert.equal(runDurableDryRunWorkerOnce({ companyId: fixture.companyId, serviceUserId: fixture.serviceUserId, now }).status, "idle");
  assert.equal(queue.getDurableJob(fixture.companyId, job.id)?.status, "queued");
});

test("external worker reports missing root runtime before claiming queued work", async () => {
  const fixture = seed();
  const payload = { message: "external worker runtime missing" };
  const queuePayload = { ...payload, dry_run: false, external_action_allowed: true };
  const job = queue.enqueueAutomationExternalEffect({
    companyId: fixture.companyId,
    actorUserId: fixture.serviceUserId,
    automationId: fixture.automationId,
    idempotencyKey: "external-worker-runtime-missing",
    payload,
    admission: admission(fixture.companyId, hashIdempotencyRequest(queuePayload))
  });

  const result = await runDurableExternalWorkerOnce({ companyId: fixture.companyId, serviceUserId: fixture.serviceUserId, now });

  assert.equal(result.status, "blocked");
  assert.equal(result.exactBlocker, "trusted_current_turn_iab_runtime_not_bound_to_registered_runner");
  assert.equal(result.externalActionExecuted, false);
  assert.deepEqual(result.pendingExternalJobIds, [job.id]);
  assert.equal(queue.getDurableJob(fixture.companyId, job.id)?.status, "queued");
  assert.equal(queue.listDurableJobAttempts(fixture.companyId, job.id).length, 0);
});

test("external worker reports the first missing root dependency and preserves queued work", async () => {
  const fixture = seed();
  const payload = { message: "external worker root dependency missing" };
  const queuePayload = { ...payload, dry_run: false, external_action_allowed: true };
  const job = queue.enqueueAutomationExternalEffect({
    companyId: fixture.companyId,
    actorUserId: fixture.serviceUserId,
    automationId: fixture.automationId,
    idempotencyKey: "external-worker-root-dependencies-missing",
    payload,
    admission: admission(fixture.companyId, hashIdempotencyRequest(queuePayload))
  });
  const synthetic = syntheticRootDependencies();
  const coordinator = {
    schema: "service_readiness_iab_external_coordinator.v1" as const,
    async execute(): Promise<IabExternalExecutorResultV1> {
      throw new Error("coordinator_must_not_be_called_before_root_dependency_admission");
    }
  };
  const buildBinding = ({ job: claimedJob, attemptId }: { job: typeof job; attemptId: string }) => syntheticBinding(claimedJob, attemptId);

  const issuerMissing = await runDurableExternalWorkerOnce({
    companyId: fixture.companyId,
    serviceUserId: fixture.serviceUserId,
    coordinator,
    buildBinding,
    rootDependencies: { runtime: synthetic.runtime, atomic_gate: synthetic.atomic_gate },
    now
  });
  assert.equal(issuerMissing.status, "blocked");
  assert.equal(issuerMissing.exactBlocker, "trusted_current_turn_iab_capability_issuer_not_bound_to_registered_runner");
  assert.deepEqual(issuerMissing.pendingExternalJobIds, [job.id]);
  assert.equal(queue.getDurableJob(fixture.companyId, job.id)?.status, "queued");
  assert.equal(queue.listDurableJobAttempts(fixture.companyId, job.id).length, 0);

  const gateMissing = await runDurableExternalWorkerOnce({
    companyId: fixture.companyId,
    serviceUserId: fixture.serviceUserId,
    coordinator,
    buildBinding,
    rootDependencies: { runtime: synthetic.runtime, issuer: synthetic.issuer },
    now
  });
  assert.equal(gateMissing.status, "blocked");
  assert.equal(gateMissing.exactBlocker, "trusted_current_turn_iab_atomic_gate_not_bound_to_registered_runner");
  assert.deepEqual(gateMissing.pendingExternalJobIds, [job.id]);
  assert.equal(queue.getDurableJob(fixture.companyId, job.id)?.status, "queued");
  assert.equal(queue.listDurableJobAttempts(fixture.companyId, job.id).length, 0);
});

test("external worker builds a coordinator only from complete root injection", async () => {
  const fixture = seed();
  const payload = { message: "external worker builds root coordinator" };
  const queuePayload = { ...payload, dry_run: false, external_action_allowed: true };
  const job = queue.enqueueAutomationExternalEffect({
    companyId: fixture.companyId,
    actorUserId: fixture.serviceUserId,
    automationId: fixture.automationId,
    idempotencyKey: "external-worker-builds-root-coordinator",
    payload,
    admission: admission(fixture.companyId, hashIdempotencyRequest(queuePayload))
  });

  const result = await runDurableExternalWorkerOnce({
    companyId: fixture.companyId,
    serviceUserId: fixture.serviceUserId,
    rootDependencies: syntheticRootDependencies(),
    rootAdmission: rootCoordinatorAdmission(),
    buildBinding: ({ job: claimedJob, attemptId }) => syntheticBinding(claimedJob, attemptId),
    now,
    nowMs: Date.parse(now)
  });

  assert.equal(result.status, "reconciliation_required");
  assert.equal(result.exactBlocker, "synthetic_root_issuer_not_called");
  assert.equal(result.externalActionExecuted, false);
  assert.equal(result.job?.id, job.id);
  assert.equal(result.job?.status, "reconciliation_required");
  assert.equal(queue.listDurableJobAttempts(fixture.companyId, job.id).length, 1);
});

test("external worker rejects invalid root admission before claiming queued work", async () => {
  const fixture = seed();
  const payload = { message: "external worker root admission invalid" };
  const queuePayload = { ...payload, dry_run: false, external_action_allowed: true };
  const job = queue.enqueueAutomationExternalEffect({
    companyId: fixture.companyId,
    actorUserId: fixture.serviceUserId,
    automationId: fixture.automationId,
    idempotencyKey: "external-worker-root-admission-invalid",
    payload,
    admission: admission(fixture.companyId, hashIdempotencyRequest(queuePayload))
  });

  const result = await runDurableExternalWorkerOnce({
    companyId: fixture.companyId,
    serviceUserId: fixture.serviceUserId,
    rootDependencies: syntheticRootDependencies(),
    rootAdmission: { ...rootCoordinatorAdmission(), release_admission: "pending" as never },
    buildBinding: ({ job: claimedJob, attemptId }) => syntheticBinding(claimedJob, attemptId),
    now
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.exactBlocker, "trusted_current_turn_iab_root_admission_invalid:company_release_admission_required");
  assert.deepEqual(result.pendingExternalJobIds, [job.id]);
  assert.equal(queue.getDurableJob(fixture.companyId, job.id)?.status, "queued");
  assert.equal(queue.listDurableJobAttempts(fixture.companyId, job.id).length, 0);
});

test("external worker delegates one claimed job through an injected root coordinator", async () => {
  const fixture = seed();
  const payload = { message: "external worker injected coordinator" };
  const queuePayload = { ...payload, dry_run: false, external_action_allowed: true };
  const job = queue.enqueueAutomationExternalEffect({
    companyId: fixture.companyId,
    actorUserId: fixture.serviceUserId,
    automationId: fixture.automationId,
    idempotencyKey: "external-worker-injected-coordinator",
    payload,
    admission: admission(fixture.companyId, hashIdempotencyRequest(queuePayload))
  });
  let providerBoundaryCalls = 0;
  const coordinator = {
    schema: "service_readiness_iab_external_coordinator.v1" as const,
    async execute(input: { binding: IabExternalExecutorBindingV1; before_provider_call?: (reservation: IabExternalReservationV1) => Promise<void> }): Promise<IabExternalExecutorResultV1> {
      providerBoundaryCalls += 1;
      await input.before_provider_call?.({
        reservation_id: "reservation-external-worker",
        reservation_token: "reservation-token-external-worker",
        effect_key: input.binding.effect_key,
        approval_consumed: true,
        ledger_reserved: true
      });
      return successfulExternalResult();
    }
  };

  const result = await runDurableExternalWorkerOnce({
    companyId: fixture.companyId,
    serviceUserId: fixture.serviceUserId,
    coordinator,
    buildBinding: ({ job: claimedJob, attemptId }) => syntheticBinding(claimedJob, attemptId),
    rootDependencies: syntheticRootDependencies(),
    now,
    nowMs: Date.parse(now)
  });

  assert.equal(providerBoundaryCalls, 1);
  assert.equal(result.status, "completed");
  assert.equal(result.job?.id, job.id);
  assert.equal(result.externalActionExecuted, true);
  assert.equal(result.exactBlocker, null);
});

test("external queue provider boundary is one-shot and failure becomes reconciliation_required", () => {
  const fixture = seed();
  const payload = { message: "synthetic provider boundary" };
  const queuePayload = { ...payload, dry_run: false, external_action_allowed: true };
  const job = queue.enqueueAutomationExternalEffect({
    companyId: fixture.companyId,
    actorUserId: fixture.serviceUserId,
    automationId: fixture.automationId,
    idempotencyKey: "external-queue-provider-once",
    payload,
    admission: admission(fixture.companyId, hashIdempotencyRequest(queuePayload))
  });
  const claim = queue.claimNextDurableJob({ companyId: fixture.companyId, serviceUserId: fixture.serviceUserId, kinds: ["external_iab"], now });
  assert.ok(claim);
  const marked = queue.markDurableExternalProviderCalled({ companyId: fixture.companyId, jobId: job.id, serviceUserId: fixture.serviceUserId, fencingToken: claim.fencingToken, reservationId: "iab_reservation_synthetic", now });
  assert.equal(marked.providerCalled, true);
  const reconciled = queue.failDurableJob({ companyId: fixture.companyId, jobId: job.id, serviceUserId: fixture.serviceUserId, fencingToken: claim.fencingToken, errorCode: "provider_timeout_ambiguous", retryable: true, now });
  assert.equal(reconciled.status, "reconciliation_required");
  assert.equal(reconciled.providerCalled, true);
  assert.equal(queue.claimNextDurableJob({ companyId: fixture.companyId, serviceUserId: fixture.serviceUserId, kinds: ["external_iab"], now }), null);
});

test("root coordinator worker bridge records the provider boundary before completion", async () => {
  const fixture = seed();
  const payload = { message: "synthetic coordinator success" };
  const queuePayload = { ...payload, dry_run: false, external_action_allowed: true };
  const job = queue.enqueueAutomationExternalEffect({
    companyId: fixture.companyId,
    actorUserId: fixture.serviceUserId,
    automationId: fixture.automationId,
    idempotencyKey: "external-queue-coordinator-success",
    payload,
    admission: admission(fixture.companyId, hashIdempotencyRequest(queuePayload))
  });
  const claim = queue.claimNextDurableJob({ companyId: fixture.companyId, serviceUserId: fixture.serviceUserId, kinds: ["external_iab"], now });
  assert.ok(claim);
  let providerBoundaryCalls = 0;
  const coordinator = {
    schema: "service_readiness_iab_external_coordinator.v1" as const,
    async execute(input: { binding: IabExternalExecutorBindingV1; before_provider_call?: (reservation: IabExternalReservationV1) => Promise<void> }): Promise<IabExternalExecutorResultV1> {
      providerBoundaryCalls += 1;
      await input.before_provider_call?.({
        reservation_id: "reservation-coordinator-success",
        reservation_token: "reservation-token-coordinator-success",
        effect_key: input.binding.effect_key,
        approval_consumed: true,
        ledger_reserved: true
      });
      return successfulExternalResult();
    }
  };
  const processed = await queue.processClaimedDurableExternalJobOnce({
    companyId: fixture.companyId,
    jobId: job.id,
    serviceUserId: fixture.serviceUserId,
    fencingToken: claim.fencingToken,
    coordinator,
    buildBinding: ({ job: claimedJob, attemptId }) => syntheticBinding(claimedJob, attemptId),
    now,
    nowMs: Date.parse(now)
  });

  assert.equal(providerBoundaryCalls, 1);
  assert.equal(processed.result.status, "succeeded");
  assert.equal(processed.job.status, "completed");
  assert.equal(processed.job.providerCalled, true);
  assert.equal(activeSlot(fixture.companyId, processed.job.concurrencyKey), 0);
  assert.equal(db.querySql<{ status: string }>(`SELECT status FROM runs WHERE id=${db.sqlValue(job.runId)}`)[0].status, "complete");
  assert.equal(db.querySql<{ status: string }>(`SELECT status FROM durable_job_attempts WHERE job_id=${db.sqlValue(job.id)}`)[0].status, "completed");
});

test("root coordinator worker bridge converts ambiguous external results to reconciliation without retry", async () => {
  const fixture = seed();
  const payload = { message: "synthetic coordinator ambiguity" };
  const queuePayload = { ...payload, dry_run: false, external_action_allowed: true };
  const job = queue.enqueueAutomationExternalEffect({
    companyId: fixture.companyId,
    actorUserId: fixture.serviceUserId,
    automationId: fixture.automationId,
    idempotencyKey: "external-queue-coordinator-ambiguous",
    payload,
    admission: admission(fixture.companyId, hashIdempotencyRequest(queuePayload))
  });
  const claim = queue.claimNextDurableJob({ companyId: fixture.companyId, serviceUserId: fixture.serviceUserId, kinds: ["external_iab"], now });
  assert.ok(claim);
  const coordinator = {
    schema: "service_readiness_iab_external_coordinator.v1" as const,
    async execute(input: { binding: IabExternalExecutorBindingV1; before_provider_call?: (reservation: IabExternalReservationV1) => Promise<void> }): Promise<IabExternalExecutorResultV1> {
      await input.before_provider_call?.({
        reservation_id: "reservation-coordinator-ambiguous",
        reservation_token: "reservation-token-coordinator-ambiguous",
        effect_key: input.binding.effect_key,
        approval_consumed: true,
        ledger_reserved: true
      });
      return {
        ...successfulExternalResult(),
        status: "reconciliation_required",
        cleanup_verified: false,
        external_action_executed: true,
        exact_blocker: "iab_external_provider_outcome_ambiguous",
        safe_resume_step: "reconcile_external_provider_readback"
      };
    }
  };
  const processed = await queue.processClaimedDurableExternalJobOnce({
    companyId: fixture.companyId,
    jobId: job.id,
    serviceUserId: fixture.serviceUserId,
    fencingToken: claim.fencingToken,
    coordinator,
    buildBinding: ({ job: claimedJob, attemptId }) => syntheticBinding(claimedJob, attemptId),
    now
  });

  assert.equal(processed.result.status, "reconciliation_required");
  assert.equal(processed.job.status, "reconciliation_required");
  assert.equal(processed.job.providerCalled, true);
  assert.equal(queue.claimNextDurableJob({ companyId: fixture.companyId, serviceUserId: fixture.serviceUserId, kinds: ["external_iab"], now }), null);
});

test("external worker consumes one trusted provider readback and terminalizes reconciliation without retry", async () => {
  const fixture = seed();
  const payload = { message: "synthetic reconciliation readback" };
  const queuePayload = { ...payload, dry_run: false, external_action_allowed: true };
  const job = queue.enqueueAutomationExternalEffect({
    companyId: fixture.companyId,
    actorUserId: fixture.serviceUserId,
    automationId: fixture.automationId,
    idempotencyKey: "external-queue-reconciliation-readback",
    payload,
    admission: admission(fixture.companyId, hashIdempotencyRequest(queuePayload))
  });
  const claim = queue.claimNextDurableJob({ companyId: fixture.companyId, serviceUserId: fixture.serviceUserId, kinds: ["external_iab"], now });
  assert.ok(claim);
  const coordinator = {
    schema: "service_readiness_iab_external_coordinator.v1" as const,
    async execute(input: { binding: IabExternalExecutorBindingV1; before_provider_call?: (reservation: IabExternalReservationV1) => Promise<void> }): Promise<IabExternalExecutorResultV1> {
      await input.before_provider_call?.({
        reservation_id: "reservation-reconciliation-readback",
        reservation_token: "reservation-token-reconciliation-readback",
        effect_key: input.binding.effect_key,
        approval_consumed: true,
        ledger_reserved: true
      });
      return {
        ...successfulExternalResult(),
        status: "reconciliation_required",
        cleanup_verified: false,
        external_action_executed: true,
        exact_blocker: "iab_external_provider_outcome_ambiguous",
        safe_resume_step: "reconcile_external_provider_readback"
      };
    }
  };
  const first = await queue.processClaimedDurableExternalJobOnce({
    companyId: fixture.companyId,
    jobId: job.id,
    serviceUserId: fixture.serviceUserId,
    fencingToken: claim.fencingToken,
    coordinator,
    buildBinding: ({ job: claimedJob, attemptId }) => syntheticBinding(claimedJob, attemptId),
    now
  });
  assert.equal(first.job.status, "reconciliation_required");

  let readbackCalls = 0;
  const second = await runDurableExternalWorkerOnce({
    companyId: fixture.companyId,
    serviceUserId: fixture.serviceUserId,
    buildBinding: ({ job: reconJob, attemptId }) => syntheticBinding(reconJob, attemptId),
    reconcile: async ({ binding, reservationId }) => {
      readbackCalls += 1;
      assert.equal(binding.job_id, job.id);
      assert.equal(reservationId, "reservation-reconciliation-readback");
      return {
        status: "confirmed",
        externalActionExecuted: true,
        providerReceiptHash: createHash("sha256").update("reconciled-provider").digest("hex"),
        cleanupReceiptHash: createHash("sha256").update("reconciled-cleanup").digest("hex"),
        exactBlocker: null,
        safeResumeStep: null
      };
    },
    now
  });

  assert.equal(readbackCalls, 1);
  assert.equal(second.status, "completed");
  assert.equal(second.job?.status, "completed");
  assert.equal(second.externalActionExecuted, true);
  assert.equal(second.reconciliation?.status, "confirmed");
  assert.equal(queue.claimNextDurableJob({ companyId: fixture.companyId, serviceUserId: fixture.serviceUserId, kinds: ["external_iab"], now }), null);
  assert.equal(db.querySql<{ status: string }>(`SELECT status FROM runs WHERE id=${db.sqlValue(job.runId)}`)[0].status, "complete");
});

test("external worker terminalizes a trusted not_found readback as failed without retry", async () => {
  const fixture = seed();
  const job = await seedPendingReconciliation(fixture, "external-queue-reconciliation-not-found");
  let readbackCalls = 0;

  const result = await runDurableExternalWorkerOnce({
    companyId: fixture.companyId,
    serviceUserId: fixture.serviceUserId,
    buildBinding: ({ job: reconJob, attemptId }) => syntheticBinding(reconJob, attemptId),
    reconcile: async ({ binding, reservationId }) => {
      readbackCalls += 1;
      assert.equal(binding.job_id, job.id);
      assert.equal(reservationId, "external-queue-reconciliation-not-found-reservation");
      return {
        status: "not_found",
        externalActionExecuted: false,
        providerReceiptHash: null,
        cleanupReceiptHash: createHash("sha256").update("not-found-cleanup").digest("hex"),
        exactBlocker: null,
        safeResumeStep: null
      };
    },
    now
  });

  assert.equal(readbackCalls, 1);
  assert.equal(result.status, "reconciliation_required");
  assert.equal(result.job?.status, "failed");
  assert.equal(result.externalActionExecuted, false);
  assert.equal(result.reconciliation?.status, "not_found");
  assert.equal(queue.claimNextDurableJob({ companyId: fixture.companyId, serviceUserId: fixture.serviceUserId, kinds: ["external_iab"], now }), null);
  assert.equal(db.querySql<{ status: string }>(`SELECT status FROM runs WHERE id=${db.sqlValue(job.runId)}`)[0].status, "failed");
});

test("external worker keeps an ambiguous readback stopped and never retries", async () => {
  const fixture = seed();
  const job = await seedPendingReconciliation(fixture, "external-queue-reconciliation-ambiguous-readback");
  let readbackCalls = 0;

  const result = await runDurableExternalWorkerOnce({
    companyId: fixture.companyId,
    serviceUserId: fixture.serviceUserId,
    buildBinding: ({ job: reconJob, attemptId }) => syntheticBinding(reconJob, attemptId),
    reconcile: async ({ binding, reservationId }) => {
      readbackCalls += 1;
      assert.equal(binding.job_id, job.id);
      assert.equal(reservationId, "external-queue-reconciliation-ambiguous-readback-reservation");
      return {
        status: "ambiguous",
        externalActionExecuted: true,
        providerReceiptHash: null,
        cleanupReceiptHash: null,
        exactBlocker: "provider_source_of_truth_ambiguous",
        safeResumeStep: "owner_reconcile_provider_source_of_truth"
      };
    },
    now
  });

  assert.equal(readbackCalls, 1);
  assert.equal(result.status, "reconciliation_required");
  assert.equal(result.job?.status, "reconciliation_required");
  assert.equal(result.externalActionExecuted, true);
  assert.equal(result.reconciliation?.status, "ambiguous");
  assert.equal(queue.claimNextDurableJob({ companyId: fixture.companyId, serviceUserId: fixture.serviceUserId, kinds: ["external_iab"], now }), null);
  assert.equal(db.querySql<{ status: string }>(`SELECT status FROM runs WHERE id=${db.sqlValue(job.runId)}`)[0].status, "blocked");
});

test("external queue rejects missing release admission and payload drift before mutation", () => {
  const fixture = seed();
  const payload = { message: "invalid external intent" };
  const queuePayload = { ...payload, dry_run: false, external_action_allowed: true };
  const invalid = admission(fixture.companyId, hashIdempotencyRequest(queuePayload));
  invalid.release_admission = "approved";
  assert.throws(() => queue.enqueueAutomationExternalEffect({
    companyId: fixture.companyId,
    actorUserId: fixture.serviceUserId,
    automationId: fixture.automationId,
    idempotencyKey: "external-queue-drift",
    payload: { ...payload, drift: true },
    admission: invalid
  }), /iab_external_queue_payload_hash_mismatch/);
  assert.equal(db.querySql<{ count: number }>(`SELECT count(*) AS count FROM durable_jobs WHERE company_id=${db.sqlValue(fixture.companyId)}`)[0].count, 0);
});

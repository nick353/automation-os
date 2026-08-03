import { createHash } from "node:crypto";
import { makeId, nowIso, querySql, runSqlTransaction, sqlValue, type SqlTransactionStep } from "../db/client.js";
import { getAutomationRecord } from "../automations/repository.js";
import { canonicalJson, hashIdempotencyRequest, readIdempotencyReplay, runIdempotentSqlMutation } from "../automations/idempotency.js";
import { requireCompanyAccess, requireExistingCompanyAccess, requireExistingServiceIdentity } from "../companies/repository.js";
import {
  buildServiceReadinessRuntimeBindingV1,
  deriveServiceReadinessRootId,
  referenceWorkflowIdFromMetadata,
  type ServiceReadinessReferenceWorkflowId
} from "../serviceReadiness/runtimeBinding.js";
import type { RootOwnedIabExternalCoordinatorV1 } from "../serviceReadiness/iabExternalCoordinator.js";
import type {
  IabExternalExecutorBindingV1,
  IabExternalExecutorResultV1,
  IabExternalReservationV1
} from "../serviceReadiness/iabExternalExecutor.js";
import { PORTABLE_EXECUTION_SOURCE } from "./portableWorkerIsolation.js";

export class DurableQueueError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "DurableQueueError";
  }
}

export type DurableJobStatus = "queued" | "leased" | "completed" | "failed" | "cancelled" | "timed_out" | "reconciliation_required";

export type DurableJob = {
  id: string;
  companyId: string;
  runId: string;
  automationId: string;
  automationVersionId: string;
  scheduleOccurrenceId: string | null;
  kind: string;
  executionMode: "dry_run" | "external";
  externalIntent: Record<string, unknown>;
  status: DurableJobStatus;
  payloadHash: string;
  priority: number;
  maxAttempts: number;
  attemptCount: number;
  availableAt: string;
  concurrencyKey: string;
  maxConcurrency: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  fencingToken: number;
  heartbeatAt: string | null;
  providerCalled: boolean;
  reservationId: string | null;
  reconciliationStartedAt: string | null;
  reconciliationOwner: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DurableJobClaim = DurableJob & { attemptId: string; attemptNo: number };

export type DurableJobAttempt = {
  id: string;
  companyId: string;
  jobId: string;
  attemptNo: number;
  serviceUserId: string;
  fencingToken: number;
  status: string;
  providerCalled: boolean;
  providerCalledAt: string | null;
  reservationId: string | null;
  reconciliationStartedAt: string | null;
  reconciliationOwner: string | null;
  startedAt: string;
  heartbeatAt: string;
  finishedAt: string | null;
  errorCode: string | null;
};

type DurableJobRow = {
  id: string;
  company_id: string;
  run_id: string;
  automation_id: string;
  automation_version_id: string;
  schedule_occurrence_id: string | null;
  kind: string;
  execution_mode: "dry_run" | "external";
  external_intent_json: string;
  status: DurableJobStatus;
  payload_hash: string;
  priority: number;
  max_attempts: number;
  attempt_count: number;
  available_at: string;
  concurrency_key: string;
  max_concurrency: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  fencing_token: number;
  heartbeat_at: string | null;
  provider_called: number;
  reservation_id: string | null;
  reconciliation_started_at: string | null;
  reconciliation_owner: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

function serviceReadinessRunMetadata(runId: string, payload: Record<string, unknown>): Record<string, unknown> {
  const workflowId = referenceWorkflowIdFromMetadata(payload);
  if (!workflowId) return {};
  return {
    service_readiness_root_id: deriveServiceReadinessRootId(runId),
    service_readiness_workflow_id: workflowId,
    service_readiness_surface: "in_app_browser",
    service_readiness_capability_mode: "read_only",
    service_readiness_external_action_executed: false,
    service_readiness_legacy_surfaces_forbidden: true,
    service_readiness_prior_receipt_reuse: false
  };
}

function serviceReadinessBindingForDurableAttempt(input: {
  runId: string;
  workflowId: ServiceReadinessReferenceWorkflowId;
  attemptId: string;
  fencingToken: number;
  stageId?: string;
}) {
  return buildServiceReadinessRuntimeBindingV1({
    root_id: deriveServiceReadinessRootId(input.runId),
    workflow_id: input.workflowId,
    run_id: input.runId,
    stage_id: input.stageId ?? "durable_job",
    attempt_id: input.attemptId,
    fencing_token: input.fencingToken
  });
}

export type DurableScheduleOccurrence = {
  id: string;
  companyId: string;
  scheduleId: string;
  occurrenceKey: string;
  scheduledFor: string;
  status: string;
  jobId: string | null;
  createdAt: string;
  updatedAt: string;
};

export function listDurableJobs(companyId: string, limit = 200): DurableJob[] {
  const company = required(companyId, "company_id_required");
  const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  return querySql<DurableJobRow>(`
    SELECT * FROM durable_jobs
    WHERE company_id=${sqlValue(company)}
    ORDER BY created_at DESC, id DESC
    LIMIT ${boundedLimit}
  `).map(toDurableJob);
}

export function getDurableJob(companyId: string, jobId: string): DurableJob | undefined {
  const row = querySql<DurableJobRow>(`
    SELECT * FROM durable_jobs
    WHERE company_id=${sqlValue(required(companyId, "company_id_required"))}
      AND id=${sqlValue(required(jobId, "durable_job_id_required"))}
    LIMIT 1
  `)[0];
  return row ? toDurableJob(row) : undefined;
}

export function listDurableJobAttempts(companyId: string, jobId: string): DurableJobAttempt[] {
  const job = getDurableJob(companyId, jobId);
  if (!job) return [];
  return querySql<any>(`
    SELECT * FROM durable_job_attempts
    WHERE company_id=${sqlValue(job.companyId)} AND job_id=${sqlValue(job.id)}
    ORDER BY attempt_no DESC, id DESC
  `).map((row) => ({
    id: row.id,
    companyId: row.company_id,
    jobId: row.job_id,
    attemptNo: Number(row.attempt_no),
    serviceUserId: row.service_user_id,
    fencingToken: Number(row.fencing_token),
    status: row.status,
    providerCalled: Number(row.provider_called) === 1,
    providerCalledAt: row.provider_called_at ?? null,
    reservationId: row.reservation_id ?? null,
    reconciliationStartedAt: row.reconciliation_started_at ?? null,
    reconciliationOwner: row.reconciliation_owner ?? null,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code
  }));
}

export function listDurableScheduleOccurrences(companyId: string, limit = 200): DurableScheduleOccurrence[] {
  const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  return querySql<any>(`
    SELECT * FROM durable_schedule_occurrences
    WHERE company_id=${sqlValue(required(companyId, "company_id_required"))}
    ORDER BY scheduled_for DESC, id DESC
    LIMIT ${boundedLimit}
  `).map((row) => ({
    id: row.id,
    companyId: row.company_id,
    scheduleId: row.schedule_id,
    occurrenceKey: row.occurrence_key,
    scheduledFor: row.scheduled_for,
    status: row.status,
    jobId: row.job_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export function materializeDurableScheduleOccurrence(input: {
  companyId: string;
  serviceUserId: string;
  scheduleId: string;
  scheduledFor: string;
  expectedScheduleRevision: number;
  nextRunAt?: string | null;
  payload?: Record<string, unknown>;
}): { occurrence: DurableScheduleOccurrence; job: DurableJob } {
  const companyId = required(input.companyId, "company_id_required");
  const serviceUserId = required(input.serviceUserId, "service_user_id_required");
  const scheduleId = required(input.scheduleId, "automation_schedule_id_required");
  const scheduledFor = normalizedTime(input.scheduledFor, "automation_schedule_occurrence_time_invalid");
  const expectedScheduleRevision = boundedInteger(input.expectedScheduleRevision, 1, Number.MAX_SAFE_INTEGER, "automation_schedule_revision_invalid");
  const nextRunAt = input.nextRunAt === null || input.nextRunAt === undefined ? null : normalizedTime(input.nextRunAt, "automation_schedule_next_run_time_invalid");
  requireExistingServiceIdentity(serviceUserId);
  requireExistingCompanyAccess(companyId, ["operator"], serviceUserId);
  const occurrenceKey = `${scheduleId}:${scheduledFor}`;
  const key = `schedule:${occurrenceKey}`;
  const scope = `durable_schedule:materialize:${serviceUserId}`;
  const payload = { ...input.payload, dry_run: true, scheduled: true, external_action_allowed: false };
  const request = { scheduleId, scheduledFor, expectedScheduleRevision, nextRunAt, payload };
  const replay = readIdempotencyReplay<{ occurrence_id: string; job_id: string }>({ companyId, scope, key, request });
  if (replay) return { occurrence: requiredOccurrence(companyId, replay.occurrence_id), job: requiredJob(companyId, replay.job_id) };
  const schedule = querySql<any>(`
    SELECT schedule.*, automation.name AS automation_name, automation.goal AS automation_goal,
           automation.description AS automation_description
    FROM mvp_automation_schedules schedule
    JOIN mvp_automations automation
      ON automation.id=schedule.automation_id AND automation.company_id=schedule.company_id
    WHERE schedule.id=${sqlValue(scheduleId)} AND schedule.company_id=${sqlValue(companyId)}
      AND schedule.enabled=1 AND schedule.status='active' AND automation.status='active'
      AND schedule.revision=${expectedScheduleRevision} AND schedule.next_run_at=${sqlValue(scheduledFor)}
    LIMIT 1
  `)[0];
  if (!schedule) throw new DurableQueueError("automation_schedule_revision_or_due_conflict");
  const timestamp = nowIso();
  const occurrenceId = makeId("occurrence");
  const jobId = makeId("job");
  const runId = makeId("run");
  const payloadJson = canonicalJson(payload);
  const payloadHash = hashIdempotencyRequest(payload);
  const concurrencyKey = `automation_version:${schedule.automation_version_id}`;
  const maxConcurrency = Number(querySql<{ slot_limit: number }>(`
    SELECT slot_limit FROM durable_concurrency_slots
    WHERE company_id=${sqlValue(companyId)} AND concurrency_key=${sqlValue(concurrencyKey)}
    LIMIT 1
  `)[0]?.slot_limit ?? 1);
  const result = runIdempotentSqlMutation({
    companyId,
    scope,
    key,
    request,
    resourceSteps: [
      {
        sql: `INSERT INTO durable_schedule_occurrences
              (id, company_id, schedule_id, occurrence_key, scheduled_for, status, job_id, created_at, updated_at)
              VALUES (${sqlValue(occurrenceId)}, ${sqlValue(companyId)}, ${sqlValue(scheduleId)}, ${sqlValue(occurrenceKey)}, ${sqlValue(scheduledFor)}, 'queued', ${sqlValue(jobId)}, ${sqlValue(timestamp)}, ${sqlValue(timestamp)})`,
        expectChanges: 1
      },
      {
        sql: `INSERT INTO runs (id, company_id, automation_id, automation_version_id, name, status, objective, created_at, updated_at, metadata_json, execution_source, quarantined)
              VALUES (${sqlValue(runId)}, ${sqlValue(companyId)}, ${sqlValue(schedule.automation_id)}, ${sqlValue(schedule.automation_version_id)}, ${sqlValue(`Scheduled dry run: ${schedule.automation_name}`)}, 'queued', ${sqlValue(schedule.automation_goal || schedule.automation_description || schedule.automation_name)}, ${sqlValue(timestamp)}, ${sqlValue(timestamp)}, ${sqlValue({ durable_job_id: jobId, schedule_occurrence_id: occurrenceId, external_action_allowed: false, ...serviceReadinessRunMetadata(runId, payload) })}, ${sqlValue(PORTABLE_EXECUTION_SOURCE)}, 0)`,
        expectChanges: 1
      },
      {
        sql: `INSERT INTO durable_jobs
              (id, company_id, run_id, automation_id, automation_version_id, schedule_occurrence_id, kind, status,
               payload_json, payload_hash, idempotency_key, priority, max_attempts, attempt_count, available_at,
               concurrency_key, max_concurrency, lease_owner, lease_expires_at, fencing_token, heartbeat_at,
               last_error, created_at, updated_at)
              VALUES (${sqlValue(jobId)}, ${sqlValue(companyId)}, ${sqlValue(runId)}, ${sqlValue(schedule.automation_id)}, ${sqlValue(schedule.automation_version_id)}, ${sqlValue(occurrenceId)}, 'scheduled_dry_run', 'queued',
                      ${sqlValue(payloadJson)}, ${sqlValue(payloadHash)}, ${sqlValue(key)}, 50, 3, 0, ${sqlValue(scheduledFor)},
                      ${sqlValue(concurrencyKey)}, ${maxConcurrency}, NULL, NULL, 0, NULL, NULL, ${sqlValue(timestamp)}, ${sqlValue(timestamp)})`,
        expectChanges: 1
      },
      {
        sql: `INSERT INTO durable_concurrency_slots
              (id, company_id, concurrency_key, slot_limit, active_count, revision, created_at, updated_at)
              VALUES (${sqlValue(makeId("concurrency"))}, ${sqlValue(companyId)}, ${sqlValue(concurrencyKey)}, ${maxConcurrency}, 0, 1, ${sqlValue(timestamp)}, ${sqlValue(timestamp)})
              ON CONFLICT(company_id, concurrency_key) DO UPDATE SET slot_limit=excluded.slot_limit
              WHERE durable_concurrency_slots.slot_limit=excluded.slot_limit`,
        expectChanges: 1
      },
      {
        sql: `UPDATE mvp_automation_schedules SET last_run_at=${sqlValue(scheduledFor)},
                    next_run_at=${nextRunAt ? sqlValue(nextRunAt) : "next_run_at"}, updated_at=${sqlValue(timestamp)}
              WHERE id=${sqlValue(scheduleId)} AND company_id=${sqlValue(companyId)} AND enabled=1 AND status='active'
                AND revision=${expectedScheduleRevision} AND next_run_at=${sqlValue(scheduledFor)}`,
        expectChanges: 1
      },
      workerEventStep(companyId, runId, "durable_schedule_occurrence_materialized", "Scheduled occurrence queued", { occurrence_id: occurrenceId, job_id: jobId, automation_version_id: schedule.automation_version_id }, timestamp),
      auditStep(companyId, serviceUserId, "durable_schedule.occurrence_materialized", "durable_schedule_occurrence", occurrenceId, {}, { job_id: jobId, scheduled_for: scheduledFor, automation_version_id: schedule.automation_version_id }, timestamp)
    ],
    response: { occurrence_id: occurrenceId, job_id: jobId }
  });
  return { occurrence: requiredOccurrence(companyId, result.response.occurrence_id), job: requiredJob(companyId, result.response.job_id) };
}

export function enqueueAutomationDryRun(input: {
  companyId: string;
  actorUserId: string;
  automationId: string;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  maxConcurrency?: number;
}): DurableJob {
  const companyId = required(input.companyId, "company_id_required");
  const actorUserId = required(input.actorUserId, "actor_user_id_required");
  const automationId = required(input.automationId, "automation_id_required");
  const key = required(input.idempotencyKey, "idempotency_key_required");
  requireCompanyAccess(companyId, ["owner", "admin", "operator"], actorUserId);
  const request = {
    automationId,
    kind: "dry_run",
    payload: input.payload ?? {},
    maxAttempts: input.maxAttempts ?? 3,
    maxConcurrency: input.maxConcurrency ?? 1
  };
  const scope = `durable_job:enqueue:${actorUserId}:dry_run`;
  const replay = readIdempotencyReplay<{ job_id: string; run_id: string; automation_version_id: string }>({ companyId, scope, key, request });
  if (replay) return requiredJob(companyId, replay.job_id);

  const automation = getAutomationRecord(companyId, automationId);
  if (!automation) throw new DurableQueueError("automation_not_found");
  const timestamp = nowIso();
  const jobId = makeId("job");
  const runId = makeId("run");
  const payload = { ...input.payload, dry_run: true, external_action_allowed: false };
  const payloadJson = canonicalJson(payload);
  const payloadHash = hashIdempotencyRequest(payload);
  const maxAttempts = boundedInteger(input.maxAttempts ?? 3, 1, 20, "durable_job_max_attempts_invalid");
  const maxConcurrency = boundedInteger(input.maxConcurrency ?? 1, 1, 50, "durable_job_max_concurrency_invalid");
  const concurrencyKey = `automation_version:${automation.currentVersionId}`;
  const existingSlot = querySql<{ slot_limit: number }>(`
    SELECT slot_limit FROM durable_concurrency_slots
    WHERE company_id=${sqlValue(companyId)} AND concurrency_key=${sqlValue(concurrencyKey)}
    LIMIT 1
  `)[0];
  if (existingSlot && Number(existingSlot.slot_limit) !== maxConcurrency) {
    throw new DurableQueueError("durable_job_concurrency_policy_conflict");
  }
  const steps: SqlTransactionStep[] = [
    {
      sql: `INSERT INTO runs (id, company_id, automation_id, automation_version_id, name, status, objective, created_at, updated_at, metadata_json, execution_source, quarantined)
            VALUES (${sqlValue(runId)}, ${sqlValue(companyId)}, ${sqlValue(automation.id)}, ${sqlValue(automation.currentVersionId)}, ${sqlValue(`Dry run: ${automation.name}`)}, 'queued', ${sqlValue(automation.goal || automation.description || automation.name)}, ${sqlValue(timestamp)}, ${sqlValue(timestamp)}, ${sqlValue({ durable_job_id: jobId, job_kind: "dry_run", external_action_allowed: false, ...serviceReadinessRunMetadata(runId, payload) })}, ${sqlValue(PORTABLE_EXECUTION_SOURCE)}, 0)`,
      expectChanges: 1
    },
    {
      sql: `INSERT INTO durable_jobs
            (id, company_id, run_id, automation_id, automation_version_id, schedule_occurrence_id, kind, status,
             payload_json, payload_hash, idempotency_key, priority, max_attempts, attempt_count, available_at,
             concurrency_key, max_concurrency, lease_owner, lease_expires_at, fencing_token, heartbeat_at,
             last_error, created_at, updated_at)
            VALUES (${sqlValue(jobId)}, ${sqlValue(companyId)}, ${sqlValue(runId)}, ${sqlValue(automation.id)}, ${sqlValue(automation.currentVersionId)}, NULL, 'dry_run', 'queued',
                    ${sqlValue(payloadJson)}, ${sqlValue(payloadHash)}, ${sqlValue(key)}, 100, ${maxAttempts}, 0, ${sqlValue(timestamp)},
                    ${sqlValue(concurrencyKey)}, ${maxConcurrency}, NULL, NULL, 0, NULL, NULL, ${sqlValue(timestamp)}, ${sqlValue(timestamp)})`,
      expectChanges: 1
    },
    {
      sql: `INSERT INTO durable_concurrency_slots
            (id, company_id, concurrency_key, slot_limit, active_count, revision, created_at, updated_at)
            VALUES (${sqlValue(makeId("concurrency"))}, ${sqlValue(companyId)}, ${sqlValue(concurrencyKey)}, ${maxConcurrency}, 0, 1, ${sqlValue(timestamp)}, ${sqlValue(timestamp)})
            ON CONFLICT(company_id, concurrency_key) DO UPDATE SET slot_limit=excluded.slot_limit
            WHERE durable_concurrency_slots.slot_limit=excluded.slot_limit`,
      expectChanges: 1
    },
    workerEventStep(companyId, runId, "durable_job_enqueued", "Durable dry-run job queued", { job_id: jobId, automation_version_id: automation.currentVersionId }, timestamp),
    auditStep(companyId, actorUserId, "durable_job.enqueued", "durable_job", jobId, {}, { run_id: runId, automation_id: automation.id, automation_version_id: automation.currentVersionId, payload_hash: payloadHash }, timestamp)
  ];
  const result = runIdempotentSqlMutation({
    companyId,
    scope,
    key,
    request,
    resourceSteps: steps,
    response: { job_id: jobId, run_id: runId, automation_version_id: automation.currentVersionId }
  });
  return requiredJob(companyId, result.response.job_id);
}

export type DurableExternalQueueAdmissionV1 = {
  schema: "service_readiness_external_queue_admission.v1";
  company_id: string;
  workflow_id: ServiceReadinessReferenceWorkflowId;
  provider: string;
  account_ref: string;
  target_hash: string;
  payload_hash: string;
  release_admission_id: string;
  release_admission: "approved";
  workflow_status: "active";
  account_status: "verified";
  external_execution_authorized: true;
  no_auto_retry: true;
  legacy_surfaces_forbidden: true;
};

/**
 * Queue an external intent only after the root release admission has already
 * been independently verified.  This function creates no capability, claims
 * no browser, and calls no provider; it is the durable handoff to the root
 * coordinator.  max_attempts is fixed to one so the queue cannot create a
 * second provider attempt after reservation or an ambiguous outcome.
 */
export function enqueueAutomationExternalEffect(input: {
  companyId: string;
  actorUserId: string;
  automationId: string;
  idempotencyKey: string;
  payload?: Record<string, unknown>;
  maxConcurrency?: number;
  admission: DurableExternalQueueAdmissionV1;
}): DurableJob {
  const companyId = required(input.companyId, "company_id_required");
  const actorUserId = required(input.actorUserId, "actor_user_id_required");
  const automationId = required(input.automationId, "automation_id_required");
  const key = required(input.idempotencyKey, "idempotency_key_required");
  requireExistingServiceIdentity(actorUserId);
  requireExistingCompanyAccess(companyId, ["operator"], actorUserId);
  const admission = input.admission;
  if (!admission || admission.schema !== "service_readiness_external_queue_admission.v1") {
    throw new DurableQueueError("iab_external_queue_admission_invalid");
  }
  if (admission.company_id !== companyId) throw new DurableQueueError("company_scope_forbidden");
  if (admission.release_admission !== "approved") throw new DurableQueueError("company_release_admission_required");
  if (admission.workflow_status !== "active") throw new DurableQueueError("canonical_registered_workflow_not_active");
  if (admission.account_status !== "verified") throw new DurableQueueError("iab_external_account_not_verified");
  if (admission.external_execution_authorized !== true) throw new DurableQueueError("iab_external_execution_not_authorized");
  if (admission.no_auto_retry !== true || admission.legacy_surfaces_forbidden !== true) {
    throw new DurableQueueError("iab_external_queue_safety_contract_required");
  }
  const automation = getAutomationRecord(companyId, automationId);
  if (!automation) throw new DurableQueueError("automation_not_found");
  if (automation.status !== "active" || automation.archivedAt) throw new DurableQueueError("automation_not_active");
  const payload = { ...(input.payload ?? {}), dry_run: false, external_action_allowed: true };
  const payloadHash = hashIdempotencyRequest(payload);
  if (payloadHash !== admission.payload_hash) throw new DurableQueueError("iab_external_queue_payload_hash_mismatch");
  if (!/^[a-f0-9]{64}$/.test(admission.target_hash)) throw new DurableQueueError("iab_external_queue_target_hash_invalid");
  const maxConcurrency = boundedInteger(input.maxConcurrency ?? 1, 1, 50, "durable_job_max_concurrency_invalid");
  const concurrencyKey = `automation_version:${automation.currentVersionId}`;
  const existingSlot = querySql<{ slot_limit: number }>(`
    SELECT slot_limit FROM durable_concurrency_slots
    WHERE company_id=${sqlValue(companyId)} AND concurrency_key=${sqlValue(concurrencyKey)}
    LIMIT 1
  `)[0];
  if (existingSlot && Number(existingSlot.slot_limit) !== maxConcurrency) {
    throw new DurableQueueError("durable_job_concurrency_policy_conflict");
  }
  const timestamp = nowIso();
  const jobId = makeId("job");
  const runId = makeId("run");
  const payloadJson = canonicalJson(payload);
  const externalIntent = {
    schema: admission.schema,
    workflow_id: admission.workflow_id,
    provider: admission.provider,
    account_ref: admission.account_ref,
    target_hash: admission.target_hash,
    payload_hash: admission.payload_hash,
    release_admission_id: admission.release_admission_id,
    no_auto_retry: true,
    external_action_executed: false
  };
  const request = {
    automationId,
    kind: "external_iab",
    payload,
    maxConcurrency,
    admission
  };
  const scope = `durable_job:enqueue:${actorUserId}:external_iab`;
  const replay = readIdempotencyReplay<{ job_id: string }>({ companyId, scope, key, request });
  if (replay) return requiredJob(companyId, replay.job_id);
  const result = runIdempotentSqlMutation({
    companyId,
    scope,
    key,
    request,
    resourceSteps: [
      {
        sql: `INSERT INTO runs (id, company_id, automation_id, automation_version_id, name, status, objective, created_at, updated_at, metadata_json, execution_source, quarantined)
              VALUES (${sqlValue(runId)}, ${sqlValue(companyId)}, ${sqlValue(automation.id)}, ${sqlValue(automation.currentVersionId)}, ${sqlValue(`External IAB intent: ${automation.name}`)}, 'queued', ${sqlValue(automation.goal || automation.description || automation.name)}, ${sqlValue(timestamp)}, ${sqlValue(timestamp)}, ${sqlValue({ durable_job_id: jobId, job_kind: "external_iab", execution_mode: "external", external_action_allowed: true, external_intent: externalIntent })}, ${sqlValue(PORTABLE_EXECUTION_SOURCE)}, 0)`,
        expectChanges: 1
      },
      {
        sql: `INSERT INTO durable_jobs
              (id, company_id, run_id, automation_id, automation_version_id, schedule_occurrence_id, concurrency_key, max_concurrency,
               kind, execution_mode, external_intent_json, status, payload_json, payload_hash, idempotency_key, priority, max_attempts,
               attempt_count, available_at, lease_owner, lease_expires_at, fencing_token, heartbeat_at, provider_called,
               reservation_id, reconciliation_started_at, reconciliation_owner, last_error, created_at, updated_at)
              VALUES (${sqlValue(jobId)}, ${sqlValue(companyId)}, ${sqlValue(runId)}, ${sqlValue(automation.id)}, ${sqlValue(automation.currentVersionId)}, NULL,
                      ${sqlValue(concurrencyKey)}, ${maxConcurrency}, 'external_iab', 'external', ${sqlValue(externalIntent)}, 'queued',
                      ${sqlValue(payloadJson)}, ${sqlValue(payloadHash)}, ${sqlValue(key)}, 100, 1, 0, ${sqlValue(timestamp)}, NULL, NULL, 0, NULL, 0,
                      NULL, NULL, NULL, NULL, ${sqlValue(timestamp)}, ${sqlValue(timestamp)})`,
        expectChanges: 1
      },
      {
        sql: `INSERT INTO durable_concurrency_slots
              (id, company_id, concurrency_key, slot_limit, active_count, revision, created_at, updated_at)
              VALUES (${sqlValue(makeId("concurrency"))}, ${sqlValue(companyId)}, ${sqlValue(concurrencyKey)}, ${maxConcurrency}, 0, 1, ${sqlValue(timestamp)}, ${sqlValue(timestamp)})
              ON CONFLICT(company_id, concurrency_key) DO UPDATE SET slot_limit=excluded.slot_limit
              WHERE durable_concurrency_slots.slot_limit=excluded.slot_limit`,
        expectChanges: 1
      },
      workerEventStep(companyId, runId, "durable_external_intent_queued", "External IAB intent queued for root coordinator", { job_id: jobId, execution_mode: "external", external_intent: externalIntent }, timestamp),
      auditStep(companyId, actorUserId, "durable_job.external_intent_queued", "durable_job", jobId, {}, { run_id: runId, execution_mode: "external", external_intent: externalIntent }, timestamp)
    ],
    response: { job_id: jobId }
  });
  return requiredJob(companyId, result.response.job_id);
}

export function claimNextDurableJob(input: {
  companyId: string;
  serviceUserId: string;
  kinds?: readonly string[];
  leaseMs?: number;
  now?: string;
}): DurableJobClaim | null {
  const companyId = required(input.companyId, "company_id_required");
  const serviceUserId = required(input.serviceUserId, "service_user_id_required");
  requireExistingServiceIdentity(serviceUserId);
  requireExistingCompanyAccess(companyId, ["operator"], serviceUserId);
  const now = normalizedTime(input.now ?? nowIso(), "durable_job_claim_time_invalid");
  const leaseMs = boundedInteger(input.leaseMs ?? 60_000, 5_000, 15 * 60_000, "durable_job_lease_ms_invalid");
  const kindPredicate = input.kinds?.length
    ? ` AND durable_jobs.kind IN (${input.kinds.map((kind) => sqlValue(required(kind, "durable_job_kind_invalid"))).join(", ")})`
    : "";
  const candidates = querySql<DurableJobRow>(`
    SELECT durable_jobs.* FROM durable_jobs
    JOIN runs ON runs.id=durable_jobs.run_id AND (runs.company_id=durable_jobs.company_id OR runs.company_id IS NULL)
    WHERE durable_jobs.company_id=${sqlValue(companyId)} AND durable_jobs.status='queued' AND durable_jobs.available_at<=${sqlValue(now)}
      AND runs.execution_source=${sqlValue(PORTABLE_EXECUTION_SOURCE)} AND runs.quarantined=0${kindPredicate}
    ORDER BY priority DESC, available_at ASC, created_at ASC, id ASC
    LIMIT 100
  `);
  for (const candidate of candidates) {
    const attemptNo = Number(candidate.attempt_count) + 1;
    const fencingToken = Number(candidate.fencing_token) + 1;
    const attemptId = makeId("attempt");
    const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    const runMetadataRow = querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${sqlValue(candidate.run_id)} AND company_id=${sqlValue(companyId)} LIMIT 1`)[0];
    const runMetadata = runMetadataRow?.metadata_json ? JSON.parse(runMetadataRow.metadata_json) as Record<string, unknown> : {};
    const serviceReadinessWorkflowId = referenceWorkflowIdFromMetadata(runMetadata);
    const serviceReadinessBinding = serviceReadinessWorkflowId && candidate.execution_mode !== "external"
      ? serviceReadinessBindingForDurableAttempt({ runId: candidate.run_id, workflowId: serviceReadinessWorkflowId, attemptId, fencingToken })
      : null;
    try {
      runSqlTransaction([
        {
          sql: `UPDATE durable_concurrency_slots
                SET active_count=active_count+1, revision=revision+1, updated_at=${sqlValue(now)}
                WHERE company_id=${sqlValue(companyId)} AND concurrency_key=${sqlValue(candidate.concurrency_key)}
                  AND active_count < slot_limit`,
          expectChanges: 1
        },
        {
          sql: `UPDATE durable_jobs
                SET status='leased', attempt_count=${attemptNo}, lease_owner=${sqlValue(serviceUserId)},
                    lease_expires_at=${sqlValue(leaseExpiresAt)}, fencing_token=${fencingToken}, heartbeat_at=${sqlValue(now)}, updated_at=${sqlValue(now)}
                WHERE id=${sqlValue(candidate.id)} AND company_id=${sqlValue(companyId)} AND status='queued'
                  AND available_at<=${sqlValue(now)} AND fencing_token=${Number(candidate.fencing_token)}`,
          expectChanges: 1
        },
        {
          sql: `INSERT INTO durable_job_attempts
                (id, company_id, job_id, attempt_no, service_user_id, fencing_token, status, started_at, heartbeat_at, finished_at, error_code, created_at, updated_at)
                VALUES (${sqlValue(attemptId)}, ${sqlValue(companyId)}, ${sqlValue(candidate.id)}, ${attemptNo}, ${sqlValue(serviceUserId)}, ${fencingToken}, 'running', ${sqlValue(now)}, ${sqlValue(now)}, NULL, NULL, ${sqlValue(now)}, ${sqlValue(now)})`,
          expectChanges: 1
        },
        ...(candidate.schedule_occurrence_id ? [occurrenceStatusStep(companyId, candidate.schedule_occurrence_id, "leased", now)] : []),
        { sql: `UPDATE runs SET status='running', updated_at=${sqlValue(now)} WHERE id=${sqlValue(candidate.run_id)} AND company_id=${sqlValue(companyId)}`, expectChanges: 1 },
        workerEventStep(companyId, candidate.run_id, "durable_job_claimed", "Durable job claimed", {
          job_id: candidate.id,
          attempt_id: attemptId,
          fencing_token: fencingToken,
          execution_mode: candidate.execution_mode,
          ...(candidate.execution_mode === "external" ? { external_intent: parseObject(candidate.external_intent_json) } : {}),
          ...(serviceReadinessBinding ? { service_readiness_runtime_binding: serviceReadinessBinding } : {})
        }, now)
      ]);
      return { ...requiredJob(companyId, candidate.id), attemptId, attemptNo };
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("sql_transaction_expected_changes"))) throw error;
    }
  }
  return null;
}

export function heartbeatDurableJob(input: {
  companyId: string;
  jobId: string;
  serviceUserId: string;
  fencingToken: number;
  leaseMs?: number;
  now?: string;
}): DurableJob {
  const current = requiredLeasedJob(input.companyId, input.jobId, input.serviceUserId, input.fencingToken, input.now);
  const now = normalizedTime(input.now ?? nowIso(), "durable_job_heartbeat_time_invalid");
  const leaseMs = boundedInteger(input.leaseMs ?? 60_000, 5_000, 15 * 60_000, "durable_job_lease_ms_invalid");
  const expires = new Date(Date.parse(now) + leaseMs).toISOString();
  runSqlTransaction([
    {
      sql: `UPDATE durable_jobs SET heartbeat_at=${sqlValue(now)}, lease_expires_at=${sqlValue(expires)}, updated_at=${sqlValue(now)}
            WHERE id=${sqlValue(current.id)} AND company_id=${sqlValue(current.companyId)} AND status='leased'
              AND lease_owner=${sqlValue(input.serviceUserId)} AND fencing_token=${input.fencingToken}`,
      expectChanges: 1
    },
    {
      sql: `UPDATE durable_job_attempts SET heartbeat_at=${sqlValue(now)}, updated_at=${sqlValue(now)}
            WHERE job_id=${sqlValue(current.id)} AND company_id=${sqlValue(current.companyId)} AND status='running'
              AND service_user_id=${sqlValue(input.serviceUserId)} AND fencing_token=${input.fencingToken}`,
      expectChanges: 1
    }
  ]);
  return requiredJob(current.companyId, current.id);
}

export function completeDurableDryRun(input: {
  companyId: string;
  jobId: string;
  serviceUserId: string;
  fencingToken: number;
  result: Record<string, unknown>;
  now?: string;
}): { job: DurableJob; artifactId: string; proofId: string } {
  const current = requiredLeasedJob(input.companyId, input.jobId, input.serviceUserId, input.fencingToken, input.now);
  if (current.kind !== "dry_run" && current.kind !== "scheduled_dry_run") throw new DurableQueueError("durable_job_kind_not_dry_run");
  const now = normalizedTime(input.now ?? nowIso(), "durable_job_complete_time_invalid");
  const artifactId = makeId("artifact");
  const proofId = makeId("proof");
  const attempt = currentAttempt(current, input.serviceUserId, input.fencingToken);
  const runMetadataRow = querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${sqlValue(current.runId)} AND company_id=${sqlValue(current.companyId)} LIMIT 1`)[0];
  const runMetadata = runMetadataRow?.metadata_json ? JSON.parse(runMetadataRow.metadata_json) as Record<string, unknown> : {};
  const serviceReadinessWorkflowId = referenceWorkflowIdFromMetadata(runMetadata);
  const serviceReadinessBinding = serviceReadinessWorkflowId
    ? serviceReadinessBindingForDurableAttempt({ runId: current.runId, workflowId: serviceReadinessWorkflowId, attemptId: attempt.id, fencingToken: input.fencingToken })
    : null;
  const resultContent = {
    ...input.result,
    dry_run: true,
    external_action_executed: false,
    ...(serviceReadinessBinding ? { service_readiness_runtime_binding: serviceReadinessBinding } : {})
  };
  const resultContentText = canonicalJson(resultContent);
  const resultChecksum = createHash("sha256").update(resultContentText).digest("hex");
  runSqlTransaction([
    {
      sql: `INSERT INTO run_artifacts
            (id, company_id, run_id, step_id, attempt_id, kind, label, mime_type, checksum_sha256, size_bytes, content_text, status, created_at, updated_at)
            VALUES (${sqlValue(artifactId)}, ${sqlValue(current.companyId)}, ${sqlValue(current.runId)}, NULL, ${sqlValue(attempt.id)}, 'dry_run_result', 'Dry-run result', 'application/json', ${sqlValue(resultChecksum)}, ${Buffer.byteLength(resultContentText)}, ${sqlValue(resultContentText)}, 'available', ${sqlValue(now)}, ${sqlValue(now)})`,
      expectChanges: 1
    },
    {
      sql: `INSERT INTO proofs (id, company_id, run_id, step_id, artifact_id, attempt_id, fencing_token, proof_type, label, uri, size_bytes, created_at, metadata_json)
            VALUES (${sqlValue(proofId)}, ${sqlValue(current.companyId)}, ${sqlValue(current.runId)}, NULL,
                    ${sqlValue(artifactId)}, ${sqlValue(attempt.id)}, ${input.fencingToken}, 'durable_dry_run', 'Durable dry-run proof',
                    ${sqlValue(`/api/v1/companies/${encodeURIComponent(current.companyId)}/artifacts/${encodeURIComponent(artifactId)}`)},
                    ${Buffer.byteLength(resultContentText)}, ${sqlValue(now)}, ${sqlValue({ artifact_id: artifactId, checksum_sha256: resultChecksum, mime_type: "application/json", attempt_id: attempt.id, fencing_token: input.fencingToken, ...(serviceReadinessBinding ? { service_readiness_runtime_binding: serviceReadinessBinding } : {}) })})`,
      expectChanges: 1
    },
    fencedJobTerminalStep(current, input.serviceUserId, input.fencingToken, "completed", null, now),
    attemptTerminalStep(attempt.id, current, input.serviceUserId, input.fencingToken, "completed", null, now),
    releaseConcurrencyStep(current, now),
    ...(current.scheduleOccurrenceId ? [occurrenceStatusStep(current.companyId, current.scheduleOccurrenceId, "completed", now)] : []),
    { sql: `UPDATE runs SET status='complete', updated_at=${sqlValue(now)} WHERE id=${sqlValue(current.runId)} AND company_id=${sqlValue(current.companyId)}`, expectChanges: 1 },
    workerEventStep(current.companyId, current.runId, "durable_job_completed", "Durable dry-run completed", { job_id: current.id, artifact_id: artifactId, proof_id: proofId, checksum_sha256: resultChecksum, ...(serviceReadinessBinding ? { service_readiness_runtime_binding: serviceReadinessBinding } : {}) }, now),
    auditStep(current.companyId, input.serviceUserId, "durable_job.completed", "durable_job", current.id, { status: current.status }, { status: "completed", artifact_id: artifactId, proof_id: proofId }, now)
  ]);
  return { job: requiredJob(current.companyId, current.id), artifactId, proofId };
}

export function failDurableJob(input: {
  companyId: string;
  jobId: string;
  serviceUserId: string;
  fencingToken: number;
  errorCode: string;
  retryable: boolean;
  retryDelayMs?: number;
  now?: string;
}): DurableJob {
  const current = requiredLeasedJob(input.companyId, input.jobId, input.serviceUserId, input.fencingToken, input.now);
  const now = normalizedTime(input.now ?? nowIso(), "durable_job_fail_time_invalid");
  const errorCode = required(input.errorCode, "durable_job_error_code_required").slice(0, 200);
  const externalEffect = current.executionMode === "external";
  const canRetry = !externalEffect && input.retryable && current.attemptCount < current.maxAttempts;
  const nextStatus: DurableJobStatus = externalEffect ? "reconciliation_required" : canRetry ? "queued" : input.retryable ? "failed" : "reconciliation_required";
  const availableAt = canRetry ? new Date(Date.parse(now) + boundedInteger(input.retryDelayMs ?? 1_000, 0, 24 * 60 * 60_000, "durable_job_retry_delay_invalid")).toISOString() : current.availableAt;
  const attempt = currentAttempt(current, input.serviceUserId, input.fencingToken);
  runSqlTransaction([
    {
      sql: `UPDATE durable_jobs
            SET status=${sqlValue(nextStatus)}, available_at=${sqlValue(availableAt)}, lease_owner=NULL, lease_expires_at=NULL,
                heartbeat_at=NULL, last_error=${sqlValue(errorCode)},
                reconciliation_started_at=${externalEffect ? sqlValue(now) : "reconciliation_started_at"},
                reconciliation_owner=${externalEffect ? sqlValue(input.serviceUserId) : "reconciliation_owner"},
                updated_at=${sqlValue(now)}
            WHERE id=${sqlValue(current.id)} AND company_id=${sqlValue(current.companyId)} AND status='leased'
              AND lease_owner=${sqlValue(input.serviceUserId)} AND fencing_token=${input.fencingToken}`,
      expectChanges: 1
    },
    ...(externalEffect ? [externalAttemptReconciliationStep(attempt.id, current, input.serviceUserId, input.fencingToken, errorCode, now)] : []),
    ...(!externalEffect ? [attemptTerminalStep(attempt.id, current, input.serviceUserId, input.fencingToken, canRetry ? "retry_scheduled" : nextStatus, errorCode, now)] : []),
    releaseConcurrencyStep(current, now),
    ...(current.scheduleOccurrenceId ? [occurrenceStatusStep(current.companyId, current.scheduleOccurrenceId, nextStatus, now)] : []),
    { sql: `UPDATE runs SET status=${sqlValue(canRetry ? "queued" : nextStatus === "reconciliation_required" ? "blocked" : "failed")}, updated_at=${sqlValue(now)} WHERE id=${sqlValue(current.runId)} AND company_id=${sqlValue(current.companyId)}`, expectChanges: 1 },
    workerEventStep(current.companyId, current.runId, canRetry ? "durable_job_retry_scheduled" : "durable_job_failed", canRetry ? "Durable job retry scheduled" : "Durable job stopped", { job_id: current.id, error_code: errorCode, next_status: nextStatus }, now)
  ]);
  return requiredJob(current.companyId, current.id);
}

/** Mark the one external reservation as provider-called without enabling a retry. */
export function markDurableExternalProviderCalled(input: {
  companyId: string;
  jobId: string;
  serviceUserId: string;
  fencingToken: number;
  reservationId: string;
  now?: string;
}): DurableJob {
  const current = requiredLeasedJob(input.companyId, input.jobId, input.serviceUserId, input.fencingToken, input.now);
  if (current.executionMode !== "external") throw new DurableQueueError("durable_job_not_external");
  const reservationId = required(input.reservationId, "external_reservation_id_required");
  const now = normalizedTime(input.now ?? nowIso(), "durable_job_provider_called_time_invalid");
  const attempt = currentAttempt(current, input.serviceUserId, input.fencingToken);
  runSqlTransaction([
    {
      sql: `UPDATE durable_jobs SET provider_called=1, reservation_id=${sqlValue(reservationId)}, updated_at=${sqlValue(now)}
            WHERE id=${sqlValue(current.id)} AND company_id=${sqlValue(current.companyId)} AND status='leased'
              AND lease_owner=${sqlValue(input.serviceUserId)} AND fencing_token=${input.fencingToken} AND provider_called=0`,
      expectChanges: 1
    },
    {
      sql: `UPDATE durable_job_attempts SET provider_called=1, provider_called_at=${sqlValue(now)}, reservation_id=${sqlValue(reservationId)}, updated_at=${sqlValue(now)}
            WHERE id=${sqlValue(attempt.id)} AND company_id=${sqlValue(current.companyId)} AND job_id=${sqlValue(current.id)}
              AND status='running' AND provider_called=0 AND service_user_id=${sqlValue(input.serviceUserId)} AND fencing_token=${input.fencingToken}`,
      expectChanges: 1
    },
    workerEventStep(current.companyId, current.runId, "durable_external_provider_called", "External provider boundary entered exactly once", { job_id: current.id, reservation_id: reservationId, no_auto_retry: true }, now)
  ]);
  return requiredJob(current.companyId, current.id);
}

/** Terminalize one successful external coordinator result after the ledger has committed it. */
export function completeDurableExternalEffect(input: {
  companyId: string;
  jobId: string;
  serviceUserId: string;
  fencingToken: number;
  providerReceiptHash: string;
  cleanupReceiptHash: string;
  now?: string;
}): DurableJob {
  const current = requiredLeasedJob(input.companyId, input.jobId, input.serviceUserId, input.fencingToken, input.now);
  if (current.executionMode !== "external") throw new DurableQueueError("durable_job_not_external");
  if (!current.providerCalled) throw new DurableQueueError("durable_external_provider_boundary_not_recorded");
  const providerReceiptHash = requiredHash(input.providerReceiptHash, "durable_external_provider_receipt_hash_invalid");
  const cleanupReceiptHash = requiredHash(input.cleanupReceiptHash, "durable_external_cleanup_receipt_hash_invalid");
  const now = normalizedTime(input.now ?? nowIso(), "durable_job_external_complete_time_invalid");
  const attempt = currentAttempt(current, input.serviceUserId, input.fencingToken);
  runSqlTransaction([
    {
      sql: `UPDATE durable_jobs SET status='completed', lease_owner=NULL, lease_expires_at=NULL, heartbeat_at=NULL,
                last_error=NULL, updated_at=${sqlValue(now)}
            WHERE id=${sqlValue(current.id)} AND company_id=${sqlValue(current.companyId)} AND status='leased'
              AND lease_owner=${sqlValue(input.serviceUserId)} AND fencing_token=${input.fencingToken} AND provider_called=1`,
      expectChanges: 1
    },
    {
      sql: `UPDATE durable_job_attempts SET status='completed', finished_at=${sqlValue(now)}, updated_at=${sqlValue(now)}
            WHERE id=${sqlValue(attempt.id)} AND company_id=${sqlValue(current.companyId)} AND job_id=${sqlValue(current.id)}
              AND status='running' AND provider_called=1 AND service_user_id=${sqlValue(input.serviceUserId)} AND fencing_token=${input.fencingToken}`,
      expectChanges: 1
    },
    releaseConcurrencyStep(current, now),
    ...(current.scheduleOccurrenceId ? [occurrenceStatusStep(current.companyId, current.scheduleOccurrenceId, "completed", now)] : []),
    { sql: `UPDATE runs SET status='complete', updated_at=${sqlValue(now)} WHERE id=${sqlValue(current.runId)} AND company_id=${sqlValue(current.companyId)}`, expectChanges: 1 },
    workerEventStep(current.companyId, current.runId, "durable_external_effect_completed", "Root coordinator completed one external effect", {
      job_id: current.id,
      provider_receipt_hash: providerReceiptHash,
      cleanup_receipt_hash: cleanupReceiptHash,
      external_action_executed: true,
      no_auto_retry: true
    }, now),
    auditStep(current.companyId, input.serviceUserId, "durable_job.external_effect_completed", "durable_job", current.id,
      { status: current.status, provider_called: true },
      { status: "completed", provider_receipt_hash: providerReceiptHash, cleanup_receipt_hash: cleanupReceiptHash, external_action_executed: true }, now)
  ]);
  return requiredJob(current.companyId, current.id);
}

/** Terminalize an external queue item as reconciliation_required, never queued. */
export function markDurableExternalReconciliationRequired(input: {
  companyId: string;
  jobId: string;
  serviceUserId: string;
  fencingToken: number;
  errorCode: string;
  now?: string;
}): DurableJob {
  const current = requiredLeasedJob(input.companyId, input.jobId, input.serviceUserId, input.fencingToken, input.now);
  if (current.executionMode !== "external") throw new DurableQueueError("durable_job_not_external");
  const errorCode = required(input.errorCode, "durable_job_error_code_required").slice(0, 200);
  const now = normalizedTime(input.now ?? nowIso(), "durable_job_reconciliation_time_invalid");
  const attempt = currentAttempt(current, input.serviceUserId, input.fencingToken);
  runSqlTransaction([
    {
      sql: `UPDATE durable_jobs SET status='reconciliation_required', lease_owner=NULL, lease_expires_at=NULL,
                heartbeat_at=NULL, last_error=${sqlValue(errorCode)}, reconciliation_started_at=${sqlValue(now)},
                reconciliation_owner=${sqlValue(input.serviceUserId)}, updated_at=${sqlValue(now)}
            WHERE id=${sqlValue(current.id)} AND company_id=${sqlValue(current.companyId)} AND status='leased'
              AND lease_owner=${sqlValue(input.serviceUserId)} AND fencing_token=${input.fencingToken}`,
      expectChanges: 1
    },
    externalAttemptReconciliationStep(attempt.id, current, input.serviceUserId, input.fencingToken, errorCode, now),
    releaseConcurrencyStep(current, now),
    { sql: `UPDATE runs SET status='blocked', updated_at=${sqlValue(now)} WHERE id=${sqlValue(current.runId)} AND company_id=${sqlValue(current.companyId)}`, expectChanges: 1 },
    workerEventStep(current.companyId, current.runId, "durable_external_reconciliation_required", "External effect requires owner reconciliation; automatic retry is disabled", { job_id: current.id, error_code: errorCode, no_auto_retry: true }, now)
  ]);
  return requiredJob(current.companyId, current.id);
}

export type ProcessClaimedDurableExternalJobInputV1 = {
  companyId: string;
  jobId: string;
  serviceUserId: string;
  fencingToken: number;
  coordinator: RootOwnedIabExternalCoordinatorV1;
  buildBinding: (input: {
    job: DurableJob;
    attemptId: string;
    externalIntent: Record<string, unknown>;
  }) => IabExternalExecutorBindingV1 | Promise<IabExternalExecutorBindingV1>;
  now?: string;
  nowMs?: number;
};

/**
 * Root-owned worker bridge for one claimed external job.
 *
 * It never discovers IAB/provider state.  The caller must inject the trusted
 * root binding builder and coordinator; missing or ambiguous results become
 * reconciliation_required and are never requeued automatically.
 */
export async function processClaimedDurableExternalJobOnce(input: ProcessClaimedDurableExternalJobInputV1): Promise<{
  job: DurableJob;
  result: IabExternalExecutorResultV1;
}> {
  const current = requiredLeasedJob(input.companyId, input.jobId, input.serviceUserId, input.fencingToken, input.now);
  if (current.executionMode !== "external") throw new DurableQueueError("durable_job_not_external");
  if (!input.coordinator || typeof input.coordinator.execute !== "function") throw new DurableQueueError("durable_external_coordinator_required");
  if (typeof input.buildBinding !== "function") throw new DurableQueueError("durable_external_binding_builder_required");
  const attempt = currentAttempt(current, input.serviceUserId, input.fencingToken);
  let reservationId: string | null = null;
  let result: IabExternalExecutorResultV1;
  try {
    const binding = await input.buildBinding({ job: current, attemptId: attempt.id, externalIntent: current.externalIntent });
    if (binding.company_id !== current.companyId || binding.job_id !== current.id || binding.run_id !== current.runId ||
        binding.attempt_id !== attempt.id || binding.fencing_token !== current.fencingToken) {
      throw new DurableQueueError("durable_external_binding_queue_mismatch");
    }
    result = await input.coordinator.execute({
      binding,
      now_ms: input.nowMs,
      before_provider_call: async (reservation: IabExternalReservationV1) => {
        const currentReservationId = required(reservation.reservation_id, "external_reservation_id_required");
        reservationId = currentReservationId;
        markDurableExternalProviderCalled({
          companyId: current.companyId,
          jobId: current.id,
          serviceUserId: input.serviceUserId,
          fencingToken: current.fencingToken,
          reservationId: currentReservationId,
          now: input.now
        });
      }
    });
  } catch (error) {
    const exactBlocker = safeExternalErrorCode(error, "durable_external_coordinator_failed");
    const job = markDurableExternalReconciliationRequired({
      companyId: current.companyId,
      jobId: current.id,
      serviceUserId: input.serviceUserId,
      fencingToken: current.fencingToken,
      errorCode: exactBlocker,
      now: input.now
    });
    return {
      job,
      result: externalReconciliationResult(exactBlocker, Boolean(reservationId))
    };
  }

  if (result.status === "succeeded" && result.provider_called && result.external_action_executed === true &&
      result.cleanup_verified && result.provider_receipt_hash && result.cleanup_receipt_hash) {
    try {
      return {
        job: completeDurableExternalEffect({
          companyId: current.companyId,
          jobId: current.id,
          serviceUserId: input.serviceUserId,
          fencingToken: current.fencingToken,
          providerReceiptHash: result.provider_receipt_hash,
          cleanupReceiptHash: result.cleanup_receipt_hash,
          now: input.now
        }),
        result
      };
    } catch (error) {
      const exactBlocker = safeExternalErrorCode(error, "durable_external_terminalization_failed");
      const job = markDurableExternalReconciliationRequired({
        companyId: current.companyId,
        jobId: current.id,
        serviceUserId: input.serviceUserId,
        fencingToken: current.fencingToken,
        errorCode: exactBlocker,
        now: input.now
      });
      return { job, result: { ...result, status: "reconciliation_required", exact_blocker: exactBlocker, safe_resume_step: "reconcile_external_queue_terminalization" } };
    }
  }

  const exactBlocker = result.exact_blocker ?? "durable_external_result_requires_reconciliation";
  const job = markDurableExternalReconciliationRequired({
    companyId: current.companyId,
    jobId: current.id,
    serviceUserId: input.serviceUserId,
    fencingToken: current.fencingToken,
    errorCode: exactBlocker,
    now: input.now
  });
  return { job, result };
}

export type DurableExternalReconciliationReadbackV1 = {
  status: "confirmed" | "not_found" | "ambiguous";
  externalActionExecuted: boolean;
  providerReceiptHash: string | null;
  cleanupReceiptHash: string | null;
  exactBlocker: string | null;
  safeResumeStep: string | null;
};

export type ReconcileDurableExternalJobInputV1 = {
  companyId: string;
  jobId: string;
  serviceUserId: string;
  buildBinding: (input: {
    job: DurableJob;
    attemptId: string;
    externalIntent: Record<string, unknown>;
  }) => IabExternalExecutorBindingV1 | Promise<IabExternalExecutorBindingV1>;
  readback: (input: {
    job: DurableJob;
    binding: IabExternalExecutorBindingV1;
    reservationId: string | null;
  }) => Promise<DurableExternalReconciliationReadbackV1>;
  now?: string;
};

/**
 * Reconcile one already-stopped external attempt from a trusted root readback.
 * This path never claims a queued job, retries a provider call, or performs an
 * external effect. Confirmed provider presence completes the job; a verified
 * absence records a terminal failed outcome; ambiguity remains stopped.
 */
export async function reconcileDurableExternalJobOnce(input: ReconcileDurableExternalJobInputV1): Promise<{
  job: DurableJob;
  readback: DurableExternalReconciliationReadbackV1;
}> {
  const companyId = required(input.companyId, "company_id_required");
  const serviceUserId = required(input.serviceUserId, "service_user_id_required");
  requireExistingServiceIdentity(serviceUserId);
  requireExistingCompanyAccess(companyId, ["operator"], serviceUserId);
  const current = requiredJob(companyId, required(input.jobId, "durable_job_id_required"));
  if (current.executionMode !== "external") throw new DurableQueueError("durable_job_not_external");
  if (current.status !== "reconciliation_required") throw new DurableQueueError("durable_external_reconciliation_not_pending");
  if (current.reconciliationOwner && current.reconciliationOwner !== serviceUserId) {
    throw new DurableQueueError("durable_external_reconciliation_owner_mismatch");
  }
  const attempt = reconciliationAttempt(current);
  if (!attempt) throw new DurableQueueError("durable_external_reconciliation_attempt_not_found");
  let binding: IabExternalExecutorBindingV1;
  try {
    binding = await input.buildBinding({ job: current, attemptId: attempt.id, externalIntent: current.externalIntent });
  } catch (error) {
    return {
      job: current,
      readback: {
        status: "ambiguous",
        externalActionExecuted: true,
        providerReceiptHash: null,
        cleanupReceiptHash: null,
        exactBlocker: safeExternalErrorCode(error, "durable_external_reconciliation_binding_failed"),
        safeResumeStep: "repair_root_owned_external_binding_before_reconciliation"
      }
    };
  }
  if (binding.company_id !== current.companyId || binding.job_id !== current.id || binding.run_id !== current.runId ||
      binding.attempt_id !== attempt.id || binding.fencing_token !== current.fencingToken) {
    return {
      job: current,
      readback: {
        status: "ambiguous",
        externalActionExecuted: true,
        providerReceiptHash: null,
        cleanupReceiptHash: null,
        exactBlocker: "durable_external_binding_queue_mismatch",
        safeResumeStep: "repair_root_owned_external_binding_before_reconciliation"
      }
    };
  }

  let readback: DurableExternalReconciliationReadbackV1;
  try {
    readback = await input.readback({ job: current, binding, reservationId: current.reservationId });
  } catch (error) {
    readback = {
      status: "ambiguous",
      externalActionExecuted: true,
      providerReceiptHash: null,
      cleanupReceiptHash: null,
      exactBlocker: safeExternalErrorCode(error, "durable_external_reconciliation_readback_failed"),
      safeResumeStep: "reconcile_external_provider_readback"
    };
  }
  if (!readback || !["confirmed", "not_found", "ambiguous"].includes(readback.status) || typeof readback.externalActionExecuted !== "boolean" ||
      (readback.status === "confirmed" && readback.externalActionExecuted !== true) ||
      (readback.status === "not_found" && readback.externalActionExecuted !== false)) {
    readback = {
      status: "ambiguous",
      externalActionExecuted: true,
      providerReceiptHash: null,
      cleanupReceiptHash: null,
      exactBlocker: "durable_external_reconciliation_readback_invalid",
      safeResumeStep: "reconcile_external_provider_readback"
    };
  }
  if (readback.status === "ambiguous") {
    return { job: current, readback: { ...readback, externalActionExecuted: true, exactBlocker: readback.exactBlocker ?? "durable_external_reconciliation_ambiguous", safeResumeStep: readback.safeResumeStep ?? "reconcile_external_provider_readback" } };
  }
  let providerReceiptHash: string | null = null;
  let cleanupReceiptHash: string;
  try {
    providerReceiptHash = readback.status === "confirmed"
      ? requiredHash(readback.providerReceiptHash ?? "", "durable_external_reconciliation_provider_receipt_hash_invalid")
      : null;
    cleanupReceiptHash = requiredHash(readback.cleanupReceiptHash ?? "", "durable_external_reconciliation_cleanup_receipt_hash_invalid");
  } catch (error) {
    return {
      job: current,
      readback: {
        status: "ambiguous",
        externalActionExecuted: true,
        providerReceiptHash: null,
        cleanupReceiptHash: null,
        exactBlocker: safeExternalErrorCode(error, "durable_external_reconciliation_receipt_invalid"),
        safeResumeStep: "reconcile_external_provider_readback"
      }
    };
  }
  const externalActionExecuted = readback.status === "confirmed";
  const job = terminalizeDurableExternalReconciliation({
    companyId,
    jobId: current.id,
    serviceUserId,
    status: externalActionExecuted ? "completed" : "failed",
    providerReceiptHash,
    cleanupReceiptHash,
    errorCode: externalActionExecuted ? null : "external_provider_effect_not_found",
    now: input.now
  });
  return { job, readback: { ...readback, externalActionExecuted, providerReceiptHash, cleanupReceiptHash, exactBlocker: null, safeResumeStep: null } };
}

function terminalizeDurableExternalReconciliation(input: {
  companyId: string;
  jobId: string;
  serviceUserId: string;
  status: "completed" | "failed";
  providerReceiptHash: string | null;
  cleanupReceiptHash: string;
  errorCode: string | null;
  now?: string;
}): DurableJob {
  const current = requiredJob(input.companyId, input.jobId);
  if (current.status !== "reconciliation_required") throw new DurableQueueError("durable_external_reconciliation_not_pending");
  if (current.reconciliationOwner && current.reconciliationOwner !== input.serviceUserId) throw new DurableQueueError("durable_external_reconciliation_owner_mismatch");
  const now = normalizedTime(input.now ?? nowIso(), "durable_job_reconciliation_terminal_time_invalid");
  const providerReceiptHash = input.providerReceiptHash ? requiredHash(input.providerReceiptHash, "durable_external_reconciliation_provider_receipt_hash_invalid") : null;
  const cleanupReceiptHash = requiredHash(input.cleanupReceiptHash, "durable_external_reconciliation_cleanup_receipt_hash_invalid");
  const attempt = reconciliationAttempt(current);
  if (!attempt) throw new DurableQueueError("durable_external_reconciliation_attempt_not_found");
  const nextStatus = input.status;
  runSqlTransaction([
    {
      sql: `UPDATE durable_jobs SET status=${sqlValue(nextStatus)}, last_error=${sqlValue(input.errorCode)},
                reconciliation_owner=${sqlValue(input.serviceUserId)}, updated_at=${sqlValue(now)}
            WHERE id=${sqlValue(current.id)} AND company_id=${sqlValue(current.companyId)} AND status='reconciliation_required'
              AND (reconciliation_owner IS NULL OR reconciliation_owner=${sqlValue(input.serviceUserId)})`,
      expectChanges: 1
    },
    {
      sql: `UPDATE durable_job_attempts SET status=${sqlValue(nextStatus)}, error_code=${sqlValue(input.errorCode)},
                reconciliation_owner=${sqlValue(input.serviceUserId)}, updated_at=${sqlValue(now)}
            WHERE id=${sqlValue(attempt.id)} AND company_id=${sqlValue(current.companyId)} AND job_id=${sqlValue(current.id)}
              AND status!='completed' AND status!='failed'`,
      expectChanges: 1
    },
    ...(current.scheduleOccurrenceId ? [occurrenceStatusStep(current.companyId, current.scheduleOccurrenceId, nextStatus, now)] : []),
    { sql: `UPDATE runs SET status=${sqlValue(nextStatus === "completed" ? "complete" : "failed")}, updated_at=${sqlValue(now)} WHERE id=${sqlValue(current.runId)} AND company_id=${sqlValue(current.companyId)}`, expectChanges: 1 },
    workerEventStep(current.companyId, current.runId, "durable_external_reconciliation_terminalized", "External provider readback terminalized the stopped job", {
      job_id: current.id,
      status: nextStatus,
      provider_receipt_hash: providerReceiptHash,
      cleanup_receipt_hash: cleanupReceiptHash,
      external_action_executed: nextStatus === "completed",
      no_auto_retry: true
    }, now),
    auditStep(current.companyId, input.serviceUserId, "durable_job.external_reconciliation_terminalized", "durable_job", current.id,
      { status: current.status },
      { status: nextStatus, provider_receipt_hash: providerReceiptHash, cleanup_receipt_hash: cleanupReceiptHash, external_action_executed: nextStatus === "completed" }, now)
  ]);
  return requiredJob(current.companyId, current.id);
}

export function cancelDurableJob(input: { companyId: string; actorUserId: string; jobId: string; now?: string }): DurableJob {
  requireCompanyAccess(required(input.companyId, "company_id_required"), ["owner", "admin", "operator"], required(input.actorUserId, "actor_user_id_required"));
  const current = requiredJob(input.companyId, input.jobId);
  if (["completed", "failed", "cancelled"].includes(current.status)) throw new DurableQueueError("durable_job_terminal");
  const now = normalizedTime(input.now ?? nowIso(), "durable_job_cancel_time_invalid");
  const steps: SqlTransactionStep[] = [
    {
      sql: `UPDATE durable_jobs
            SET status='cancelling', fencing_token=fencing_token+1, lease_owner=NULL, lease_expires_at=NULL, heartbeat_at=NULL, updated_at=${sqlValue(now)}
            WHERE id=${sqlValue(current.id)} AND company_id=${sqlValue(current.companyId)} AND status NOT IN ('completed','failed','cancelled')`,
      expectChanges: 1
    },
    {
      sql: `UPDATE durable_job_attempts
            SET status='cancelled', finished_at=${sqlValue(now)}, error_code='cancelled_by_actor', updated_at=${sqlValue(now)}
            WHERE job_id=${sqlValue(current.id)} AND company_id=${sqlValue(current.companyId)} AND status='running'`
    },
    {
      sql: `UPDATE durable_concurrency_slots
            SET active_count=active_count-1, revision=revision+1, updated_at=${sqlValue(now)}
            WHERE company_id=${sqlValue(current.companyId)} AND concurrency_key=${sqlValue(current.concurrencyKey)}
              AND active_count>0 AND EXISTS (
                SELECT 1 FROM durable_job_attempts attempt
                WHERE attempt.job_id=${sqlValue(current.id)} AND attempt.company_id=${sqlValue(current.companyId)}
                  AND attempt.status='cancelled' AND attempt.finished_at=${sqlValue(now)}
              )`
    },
    {
      sql: `UPDATE durable_jobs SET status='cancelled', updated_at=${sqlValue(now)}
            WHERE id=${sqlValue(current.id)} AND company_id=${sqlValue(current.companyId)} AND status='cancelling'`,
      expectChanges: 1
    }
  ];
  steps.push(
    ...(current.scheduleOccurrenceId ? [occurrenceStatusStep(current.companyId, current.scheduleOccurrenceId, "cancelled", now)] : []),
    { sql: `UPDATE runs SET status='cancelled', updated_at=${sqlValue(now)} WHERE id=${sqlValue(current.runId)} AND company_id=${sqlValue(current.companyId)}`, expectChanges: 1 },
    workerEventStep(current.companyId, current.runId, "durable_job_cancelled", "Durable job cancelled", { job_id: current.id }, now),
    auditStep(current.companyId, required(input.actorUserId, "actor_user_id_required"), "durable_job.cancelled", "durable_job", current.id, { status: current.status }, { status: "cancelled" }, now)
  );
  runSqlTransaction(steps);
  return requiredJob(current.companyId, current.id);
}

export function retryDurableJob(input: {
  companyId: string;
  actorUserId: string;
  jobId: string;
  idempotencyKey: string;
  now?: string;
}): DurableJob {
  const companyId = required(input.companyId, "company_id_required");
  const actorUserId = required(input.actorUserId, "actor_user_id_required");
  const jobId = required(input.jobId, "durable_job_id_required");
  const key = required(input.idempotencyKey, "idempotency_key_required");
  requireCompanyAccess(companyId, ["owner", "admin", "operator"], actorUserId);
  const request = { jobId, action: "retry" };
  const scope = `durable_job:retry:${actorUserId}`;
  const replay = readIdempotencyReplay<{ job_id: string }>({ companyId, scope, key, request });
  if (replay) return requiredJob(companyId, replay.job_id);
  const current = requiredJob(companyId, jobId);
  if (!["failed", "timed_out"].includes(current.status)) {
    throw new DurableQueueError("durable_job_not_retryable");
  }
  const now = normalizedTime(input.now ?? nowIso(), "durable_job_retry_time_invalid");
  const nextMaxAttempts = Math.max(current.maxAttempts, current.attemptCount + 1);
  const result = runIdempotentSqlMutation({
    companyId,
    scope,
    key,
    request,
    resourceSteps: [
      {
        sql: `UPDATE durable_jobs
              SET status='queued', max_attempts=${nextMaxAttempts}, available_at=${sqlValue(now)},
                  last_error=NULL, updated_at=${sqlValue(now)}
              WHERE id=${sqlValue(current.id)} AND company_id=${sqlValue(companyId)}
                AND status=${sqlValue(current.status)} AND fencing_token=${current.fencingToken}`,
        expectChanges: 1
      },
      ...(current.scheduleOccurrenceId ? [occurrenceStatusStep(companyId, current.scheduleOccurrenceId, "queued", now)] : []),
      { sql: `UPDATE runs SET status='queued', updated_at=${sqlValue(now)} WHERE id=${sqlValue(current.runId)} AND company_id=${sqlValue(companyId)}`, expectChanges: 1 },
      workerEventStep(companyId, current.runId, "durable_job_manual_retry_queued", "Durable job queued for explicit retry", { job_id: current.id, automation_version_id: current.automationVersionId }, now),
      auditStep(companyId, actorUserId, "durable_job.retry_queued", "durable_job", current.id, { status: current.status }, { status: "queued", automation_version_id: current.automationVersionId }, now)
    ],
    response: { job_id: current.id }
  });
  return requiredJob(companyId, result.response.job_id);
}

export function recoverExpiredDurableJobs(input: { companyId: string; serviceUserId: string; now?: string }): DurableJob[] {
  const companyId = required(input.companyId, "company_id_required");
  requireExistingServiceIdentity(input.serviceUserId);
  requireExistingCompanyAccess(companyId, ["operator"], input.serviceUserId);
  const now = normalizedTime(input.now ?? nowIso(), "durable_job_recovery_time_invalid");
  const expired = querySql<DurableJobRow>(`
    SELECT * FROM durable_jobs
    WHERE company_id=${sqlValue(companyId)} AND status='leased' AND lease_expires_at<=${sqlValue(now)}
    ORDER BY lease_expires_at ASC, id ASC
  `).map(toDurableJob);
  const recovered: DurableJob[] = [];
  for (const current of expired) {
    const safeAutomaticRetry = current.kind === "dry_run" || current.kind === "scheduled_dry_run";
    const canRetry = safeAutomaticRetry && current.attemptCount < current.maxAttempts;
    const nextStatus: DurableJobStatus = canRetry ? "queued" : safeAutomaticRetry ? "timed_out" : "reconciliation_required";
    const attempt = currentAttempt(current, current.leaseOwner!, current.fencingToken);
    try {
      runSqlTransaction([
        {
          sql: `UPDATE durable_jobs
                SET status=${sqlValue(nextStatus)}, available_at=${sqlValue(now)}, lease_owner=NULL, lease_expires_at=NULL,
                    heartbeat_at=NULL, last_error='lease_expired', updated_at=${sqlValue(now)}
                WHERE id=${sqlValue(current.id)} AND company_id=${sqlValue(companyId)} AND status='leased'
                  AND fencing_token=${current.fencingToken} AND lease_expires_at<=${sqlValue(now)}`,
          expectChanges: 1
        },
        attemptTerminalStep(attempt.id, current, current.leaseOwner!, current.fencingToken, nextStatus === "queued" ? "retry_scheduled" : "timed_out", "lease_expired", now),
        releaseConcurrencyStep(current, now),
        ...(current.scheduleOccurrenceId ? [occurrenceStatusStep(companyId, current.scheduleOccurrenceId, nextStatus, now)] : []),
        { sql: `UPDATE runs SET status=${sqlValue(canRetry ? "queued" : nextStatus === "reconciliation_required" ? "blocked" : "failed")}, updated_at=${sqlValue(now)} WHERE id=${sqlValue(current.runId)} AND company_id=${sqlValue(companyId)}`, expectChanges: 1 },
        workerEventStep(companyId, current.runId, "durable_job_lease_expired", "Durable job lease expired", { job_id: current.id, next_status: nextStatus }, now)
      ]);
      recovered.push(requiredJob(companyId, current.id));
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("sql_transaction_expected_changes"))) throw error;
    }
  }
  return recovered;
}

export function readRunArtifact(companyId: string, artifactId: string): {
  id: string;
  companyId: string;
  runId: string;
  kind: string;
  label: string;
  mimeType: string;
  checksumSha256: string;
  sizeBytes: number;
  contentText: string;
  createdAt: string;
} | undefined {
  const row = querySql<any>(`
    SELECT * FROM run_artifacts
    WHERE company_id=${sqlValue(required(companyId, "company_id_required"))}
      AND id=${sqlValue(required(artifactId, "artifact_id_required"))} AND status='available'
    LIMIT 1
  `)[0];
  if (!row) return undefined;
  const checksum = createHash("sha256").update(row.content_text).digest("hex");
  if (checksum !== row.checksum_sha256 || Buffer.byteLength(row.content_text) !== Number(row.size_bytes)) {
    throw new DurableQueueError("artifact_integrity_mismatch");
  }
  return { id: row.id, companyId: row.company_id, runId: row.run_id, kind: row.kind, label: row.label, mimeType: row.mime_type, checksumSha256: row.checksum_sha256, sizeBytes: Number(row.size_bytes), contentText: row.content_text, createdAt: row.created_at };
}

function requiredLeasedJob(companyId: string, jobId: string, serviceUserId: string, fencingToken: number, at?: string): DurableJob {
  const current = requiredJob(companyId, jobId);
  if (current.status !== "leased" || current.leaseOwner !== serviceUserId || current.fencingToken !== fencingToken) {
    throw new DurableQueueError("stale_durable_job_fence");
  }
  const now = Date.parse(at ?? nowIso());
  if (!current.leaseExpiresAt || Date.parse(current.leaseExpiresAt) <= now) throw new DurableQueueError("durable_job_lease_expired");
  return current;
}

function currentAttempt(job: DurableJob, serviceUserId: string, fencingToken: number): { id: string } {
  const row = querySql<{ id: string }>(`
    SELECT id FROM durable_job_attempts
    WHERE company_id=${sqlValue(job.companyId)} AND job_id=${sqlValue(job.id)} AND status='running'
      AND service_user_id=${sqlValue(serviceUserId)} AND fencing_token=${fencingToken}
    LIMIT 1
  `)[0];
  if (!row) throw new DurableQueueError("durable_job_attempt_not_found");
  return row;
}

function reconciliationAttempt(job: DurableJob): { id: string } | undefined {
  const row = querySql<{ id: string }>(`
    SELECT id FROM durable_job_attempts
    WHERE company_id=${sqlValue(job.companyId)} AND job_id=${sqlValue(job.id)}
      AND fencing_token=${job.fencingToken}
    ORDER BY attempt_no DESC, id DESC
    LIMIT 1
  `)[0];
  return row;
}

function requiredJob(companyId: string, jobId: string): DurableJob {
  const job = getDurableJob(companyId, jobId);
  if (!job) throw new DurableQueueError("durable_job_not_found");
  return job;
}

function requiredOccurrence(companyId: string, occurrenceId: string): DurableScheduleOccurrence {
  const row = querySql<any>(`
    SELECT * FROM durable_schedule_occurrences
    WHERE company_id=${sqlValue(companyId)} AND id=${sqlValue(occurrenceId)}
    LIMIT 1
  `)[0];
  if (!row) throw new DurableQueueError("durable_schedule_occurrence_not_found");
  return {
    id: row.id,
    companyId: row.company_id,
    scheduleId: row.schedule_id,
    occurrenceKey: row.occurrence_key,
    scheduledFor: row.scheduled_for,
    status: row.status,
    jobId: row.job_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function fencedJobTerminalStep(job: DurableJob, serviceUserId: string, fencingToken: number, status: DurableJobStatus, error: string | null, now: string): SqlTransactionStep {
  return {
    sql: `UPDATE durable_jobs SET status=${sqlValue(status)}, lease_owner=NULL, lease_expires_at=NULL, heartbeat_at=NULL,
          last_error=${sqlValue(error)}, updated_at=${sqlValue(now)}
          WHERE id=${sqlValue(job.id)} AND company_id=${sqlValue(job.companyId)} AND status='leased'
            AND lease_owner=${sqlValue(serviceUserId)} AND fencing_token=${fencingToken}`,
    expectChanges: 1
  };
}

function attemptTerminalStep(attemptId: string, job: DurableJob, serviceUserId: string, fencingToken: number, status: string, error: string | null, now: string): SqlTransactionStep {
  return {
    sql: `UPDATE durable_job_attempts SET status=${sqlValue(status)}, finished_at=${sqlValue(now)}, error_code=${sqlValue(error)}, updated_at=${sqlValue(now)}
          WHERE id=${sqlValue(attemptId)} AND company_id=${sqlValue(job.companyId)} AND job_id=${sqlValue(job.id)}
            AND status='running' AND service_user_id=${sqlValue(serviceUserId)} AND fencing_token=${fencingToken}`,
    expectChanges: 1
  };
}

function externalAttemptReconciliationStep(attemptId: string, job: DurableJob, serviceUserId: string, fencingToken: number, error: string, now: string): SqlTransactionStep {
  return {
    sql: `UPDATE durable_job_attempts SET status='reconciliation_required', finished_at=${sqlValue(now)}, error_code=${sqlValue(error)},
              reconciliation_started_at=${sqlValue(now)}, reconciliation_owner=${sqlValue(serviceUserId)}, updated_at=${sqlValue(now)}
          WHERE id=${sqlValue(attemptId)} AND company_id=${sqlValue(job.companyId)} AND job_id=${sqlValue(job.id)}
            AND status='running' AND service_user_id=${sqlValue(serviceUserId)} AND fencing_token=${fencingToken}`,
    expectChanges: 1
  };
}

function releaseConcurrencyStep(job: DurableJob, now: string): SqlTransactionStep {
  return {
    sql: `UPDATE durable_concurrency_slots SET active_count=active_count-1, revision=revision+1, updated_at=${sqlValue(now)}
          WHERE company_id=${sqlValue(job.companyId)} AND concurrency_key=${sqlValue(job.concurrencyKey)} AND active_count>0`,
    expectChanges: 1
  };
}

function occurrenceStatusStep(companyId: string, occurrenceId: string, status: string, now: string): SqlTransactionStep {
  return {
    sql: `UPDATE durable_schedule_occurrences SET status=${sqlValue(status)}, updated_at=${sqlValue(now)}
          WHERE id=${sqlValue(occurrenceId)} AND company_id=${sqlValue(companyId)}`,
    expectChanges: 1
  };
}

function workerEventStep(companyId: string, runId: string, eventType: string, message: string, metadata: object, createdAt: string): SqlTransactionStep {
  return {
    sql: `INSERT INTO worker_events (id, company_id, run_id, step_id, lane_id, event_type, message, created_at, metadata_json)
          VALUES (${sqlValue(makeId("evt"))}, ${sqlValue(companyId)}, ${sqlValue(runId)}, NULL, NULL, ${sqlValue(eventType)}, ${sqlValue(message)}, ${sqlValue(createdAt)}, ${sqlValue(metadata)})`,
    expectChanges: 1
  };
}

function auditStep(companyId: string, actorUserId: string, action: string, entityType: string, entityId: string, before: object, after: object, createdAt: string): SqlTransactionStep {
  return {
    sql: `INSERT INTO company_audit_events (id, company_id, actor_user_id, action, entity_type, entity_id, before_json, after_json, created_at)
          VALUES (${sqlValue(makeId("audit"))}, ${sqlValue(companyId)}, ${sqlValue(actorUserId)}, ${sqlValue(action)}, ${sqlValue(entityType)}, ${sqlValue(entityId)}, ${sqlValue(before)}, ${sqlValue(after)}, ${sqlValue(createdAt)})`,
    expectChanges: 1
  };
}

function toDurableJob(row: DurableJobRow): DurableJob {
  return {
    id: row.id,
    companyId: row.company_id,
    runId: row.run_id,
    automationId: row.automation_id,
    automationVersionId: row.automation_version_id,
    scheduleOccurrenceId: row.schedule_occurrence_id,
    kind: row.kind,
    executionMode: row.execution_mode === "external" ? "external" : "dry_run",
    externalIntent: parseObject(row.external_intent_json),
    status: row.status,
    payloadHash: row.payload_hash,
    priority: Number(row.priority),
    maxAttempts: Number(row.max_attempts),
    attemptCount: Number(row.attempt_count),
    availableAt: row.available_at,
    concurrencyKey: row.concurrency_key,
    maxConcurrency: Number(row.max_concurrency),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    fencingToken: Number(row.fencing_token),
    heartbeatAt: row.heartbeat_at,
    providerCalled: Number(row.provider_called) === 1,
    reservationId: row.reservation_id ?? null,
    reconciliationStartedAt: row.reconciliation_started_at ?? null,
    reconciliationOwner: row.reconciliation_owner ?? null,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function boundedInteger(value: number, min: number, max: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new DurableQueueError(code);
  return value;
}

function normalizedTime(value: string, code: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new DurableQueueError(code);
  return new Date(timestamp).toISOString();
}

function parseObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function required(value: string, code: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new DurableQueueError(code);
  return normalized;
}

function requiredHash(value: string, code: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new DurableQueueError(code);
  return value;
}

function safeExternalErrorCode(error: unknown, fallback: string): string {
  const code = error instanceof Error ? error.message : "";
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(code) ? code : fallback;
}

function externalReconciliationResult(exactBlocker: string, providerCalled: boolean): IabExternalExecutorResultV1 {
  return {
    schema: "service_readiness_iab_external_executor.v1",
    status: "reconciliation_required",
    provider_called: providerCalled,
    approval_consumed: providerCalled,
    ledger_reserved: providerCalled,
    cleanup_verified: false,
    provider_receipt_hash: null,
    cleanup_receipt_hash: null,
    external_action_executed: providerCalled,
    exact_blocker: exactBlocker,
    safe_resume_step: "reconcile_external_queue_before_retry"
  };
}

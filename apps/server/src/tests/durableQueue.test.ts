import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-durable-queue-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");

// Child processes must use the same runtime generation as the parent test.
// Source-mode tsx tests otherwise resolve `../*.js` to a non-existent source
// path, while the normal npm test command executes the compiled dist tests.
function compiledRuntimeModule(relativePath: string, sourceRelativeUrl: string): string {
  const compiledPath = join(process.cwd(), "apps/server", "dist", relativePath);
  return existsSync(compiledPath)
    ? pathToFileURL(compiledPath).href
    : new URL(sourceRelativeUrl, import.meta.url).href;
}

function compiledRuntimeEntry(relativePath: string, sourceRelativeUrl: string): string {
  const compiledPath = join(process.cwd(), "apps/server", "dist", relativePath);
  return existsSync(compiledPath)
    ? compiledPath
    : fileURLToPath(new URL(sourceRelativeUrl, import.meta.url));
}

const db = await import("../db/client.js");
const {
  cancelDurableJob,
  claimNextDurableJob,
  completeDurableDryRun,
  enqueueAutomationDryRun,
  failDurableJob,
  heartbeatDurableJob,
  materializeDurableScheduleOccurrence,
  recoverExpiredDurableJobs,
  readRunArtifact,
  retryDurableJob
} = await import("../runs/durableQueue.js");
const { runDurableDryRunWorkerOnce } = await import("../runs/durableDryRunWorker.js");
const { runWorkerOnce } = await import("../runs/workerEngine.js");

const claimNow = "2099-01-01T00:00:00.000Z";
const laterNow = "2099-01-01T00:05:00.000Z";
const recoveryNow = "2099-01-01T00:10:00.000Z";

test("durable queue stays isolated by tenant", () => {
  resetDurableState();
  const companyA = seedDurableCompany("company_a", "service_a", "automation_a", "version_a");
  const companyB = seedDurableCompany("company_b", "service_b", "automation_b", "version_b");
  const jobA = enqueueAutomationDryRun({
    companyId: companyA.companyId,
    actorUserId: companyA.serviceUserId,
    automationId: companyA.automationId,
    idempotencyKey: "enqueue-a",
    payload: { company: "a" }
  });
  const jobB = enqueueAutomationDryRun({
    companyId: companyB.companyId,
    actorUserId: companyB.serviceUserId,
    automationId: companyB.automationId,
    idempotencyKey: "enqueue-b",
    payload: { company: "b" }
  });

  assert.deepEqual(listJobIds(companyA.companyId), [jobA.id]);
  assert.deepEqual(listJobIds(companyB.companyId), [jobB.id]);
  assert.equal(db.querySql<{ count: number }>(
    `SELECT count(*) AS count FROM durable_jobs WHERE company_id=${db.sqlValue(companyA.companyId)} AND id=${db.sqlValue(jobB.id)}`
  )[0].count, 0);
  assert.equal(db.querySql<{ count: number }>(
    `SELECT count(*) AS count FROM durable_jobs WHERE company_id=${db.sqlValue(companyB.companyId)} AND id=${db.sqlValue(jobA.id)}`
  )[0].count, 0);

  const claimA = claimNextDurableJob({ companyId: companyA.companyId, serviceUserId: companyA.serviceUserId, now: claimNow });
  const claimB = claimNextDurableJob({ companyId: companyB.companyId, serviceUserId: companyB.serviceUserId, now: claimNow });
  assert.equal(claimA?.id, jobA.id);
  assert.equal(claimB?.id, jobB.id);
  assert.equal(getJob(companyA.companyId, jobB.id), undefined);
  assert.equal(getJob(companyB.companyId, jobA.id), undefined);
});

test("enqueue replays by idempotency key, pins the automation version, and rejects payload drift", () => {
  resetDurableState();
  const seed = seedDurableCompany("company_idem", "service_idem", "automation_idem", "version_1");
  const baseRequest = {
    companyId: seed.companyId,
    actorUserId: seed.serviceUserId,
    automationId: seed.automationId,
    idempotencyKey: "enqueue-idem",
    payload: { topic: "alpha" },
    maxAttempts: 4,
    maxConcurrency: 2
  } as const;

  const first = enqueueAutomationDryRun(baseRequest);
  assert.equal(first.automationVersionId, seed.versionId);
  assert.equal(first.concurrencyKey, `automation_version:${seed.versionId}`);
  assert.equal(db.querySql<{ count: number }>(`SELECT count(*) AS count FROM durable_jobs WHERE company_id=${db.sqlValue(seed.companyId)}`)[0].count, 1);
  assert.equal(db.querySql<{ count: number }>(`SELECT count(*) AS count FROM mvp_idempotency_keys WHERE company_id=${db.sqlValue(seed.companyId)}`)[0].count, 1);
  assert.throws(() => enqueueAutomationDryRun({ ...baseRequest, idempotencyKey: "enqueue-conflicting-concurrency", maxConcurrency: 1 }), /durable_job_concurrency_policy_conflict/);

  const version2 = "version_2";
  db.insert("mvp_automation_versions", {
    id: version2,
    company_id: seed.companyId,
    project_id: seed.companyId,
    automation_id: seed.automationId,
    revision: 2,
    automation_type: "daily-ai",
    name: "Automation idem v2",
    description: "desc v2",
    goal: "goal v2",
    schedule: "0 * * * *",
    cadence: "daily",
    lane: "local",
    risk_level: "medium",
    approval_policy: "required_before_external_action",
    worker_command_kind: "safe_local_demo",
    create_approval: 0,
    status: "draft",
    builder_spec_json: { step: "one", revision: 2 },
    created_at: laterNow,
    updated_at: laterNow
  });
  db.execSql(`
    UPDATE mvp_automations
    SET current_version_id=${db.sqlValue(version2)}, revision=2, name='Automation idem v2', updated_at=${db.sqlValue(laterNow)}
    WHERE id=${db.sqlValue(seed.automationId)} AND company_id=${db.sqlValue(seed.companyId)};
  `);

  const replay = enqueueAutomationDryRun(baseRequest);
  assert.equal(replay.id, first.id);
  assert.equal(replay.automationVersionId, seed.versionId);
  assert.equal(db.querySql<{ count: number }>(`SELECT count(*) AS count FROM durable_jobs WHERE company_id=${db.sqlValue(seed.companyId)}`)[0].count, 1);

  assert.throws(
    () => enqueueAutomationDryRun({ ...baseRequest, payload: { topic: "beta" } }),
    (error: unknown) => {
      assert.equal((error as Error).message, "idempotency_key_payload_conflict");
      return true;
    }
  );
  assert.throws(() => enqueueAutomationDryRun({ ...baseRequest, maxAttempts: 5 }), /idempotency_key_payload_conflict/);
  assert.throws(() => enqueueAutomationDryRun({ ...baseRequest, maxConcurrency: 3 }), /idempotency_key_payload_conflict/);
  db.execSql(`UPDATE company_memberships SET status='revoked' WHERE company_id=${db.sqlValue(seed.companyId)} AND user_id=${db.sqlValue(seed.serviceUserId)}`);
  assert.throws(() => enqueueAutomationDryRun(baseRequest), /company_scope_forbidden/);
});

test("claiming is atomic: the first job leases and the second call returns null while the queued peer stays put", () => {
  resetDurableState();
  const seed = seedDurableCompany("company_claim", "service_claim", "automation_claim", "version_claim");
  const first = enqueueAutomationDryRun({
    companyId: seed.companyId,
    actorUserId: seed.serviceUserId,
    automationId: seed.automationId,
    idempotencyKey: "claim-one",
    payload: { job: 1 }
  });
  const second = enqueueAutomationDryRun({
    companyId: seed.companyId,
    actorUserId: seed.serviceUserId,
    automationId: seed.automationId,
    idempotencyKey: "claim-two",
    payload: { job: 2 }
  });

  const claim1 = claimNextDurableJob({ companyId: seed.companyId, serviceUserId: seed.serviceUserId, now: claimNow });
  const claim2 = claimNextDurableJob({ companyId: seed.companyId, serviceUserId: seed.serviceUserId, now: claimNow });

  assert.equal(claim1?.id, first.id);
  assert.equal(claim1?.attemptNo, 1);
  assert.equal(claim2, null);
  assert.equal(getJob(seed.companyId, second.id)?.status, "queued");
  assert.equal(activeSlotCount(seed.companyId, first.concurrencyKey), 1);
  assert.equal(db.querySql<{ count: number }>(`SELECT count(*) AS count FROM durable_job_attempts WHERE company_id=${db.sqlValue(seed.companyId)}`)[0].count, 1);
});

test("heartbeat rejects a stale fence without mutating the lease", () => {
  resetDurableState();
  const seed = seedDurableCompany("company_heartbeat", "service_heartbeat", "automation_heartbeat", "version_heartbeat");
  const job = enqueueAutomationDryRun({
    companyId: seed.companyId,
    actorUserId: seed.serviceUserId,
    automationId: seed.automationId,
    idempotencyKey: "heartbeat-job",
    payload: { job: "heartbeat" }
  });
  const claim = claimNextDurableJob({ companyId: seed.companyId, serviceUserId: seed.serviceUserId, leaseMs: 15 * 60 * 1000, now: claimNow });
  assert.ok(claim);

  assert.throws(
    () =>
      heartbeatDurableJob({
        companyId: seed.companyId,
        jobId: job.id,
        serviceUserId: seed.serviceUserId,
        fencingToken: claim.fencingToken - 1,
        now: laterNow
      }),
    (error: unknown) => {
      assert.equal((error as Error).message, "stale_durable_job_fence");
      return true;
    }
  );

  assert.equal(getJob(seed.companyId, job.id)?.heartbeatAt, claimNow);
  assert.equal(activeSlotCount(seed.companyId, job.concurrencyKey), 1);
});

test("dry-run completion writes an integrity-checked artifact and tampering is detected", () => {
  resetDurableState();
  const seed = seedDurableCompany("company_complete", "service_complete", "automation_complete", "version_complete");
  const job = enqueueAutomationDryRun({
    companyId: seed.companyId,
    actorUserId: seed.serviceUserId,
    automationId: seed.automationId,
    idempotencyKey: "complete-job",
    payload: { job: "complete" }
  });
  const claim = claimNextDurableJob({ companyId: seed.companyId, serviceUserId: seed.serviceUserId, leaseMs: 15 * 60 * 1000, now: claimNow });
  assert.ok(claim);

  const result = completeDurableDryRun({
    companyId: seed.companyId,
    jobId: job.id,
    serviceUserId: seed.serviceUserId,
    fencingToken: claim.fencingToken,
    result: { outcome: "done" },
    now: laterNow
  });

  const artifact = readRunArtifact(seed.companyId, result.artifactId);
  assert.ok(artifact);
  const artifactBody = JSON.parse(artifact.contentText);
  assert.equal(artifactBody.dry_run, true);
  assert.equal(artifactBody.external_action_executed, false);
  assert.equal(artifactBody.trigger_source, "automation_os_manual");
  assert.equal(artifactBody.execution_provider.selected_provider, "aos.control_plane");
  assert.equal(getJob(seed.companyId, job.id)?.status, "completed");
  assert.equal(activeSlotCount(seed.companyId, job.concurrencyKey), 0);

  db.execSql(`
    UPDATE run_artifacts
    SET checksum_sha256='tampered'
    WHERE id=${db.sqlValue(result.artifactId)} AND company_id=${db.sqlValue(seed.companyId)};
  `);

  assert.throws(
    () => readRunArtifact(seed.companyId, result.artifactId),
    (error: unknown) => {
      assert.equal((error as Error).message, "artifact_integrity_mismatch");
      return true;
    }
  );
});

test("failed jobs retry once and then exhaust into failed state", () => {
  resetDurableState();
  const seed = seedDurableCompany("company_retry", "service_retry", "automation_retry", "version_retry");
  const retryableJob = enqueueAutomationDryRun({
    companyId: seed.companyId,
    actorUserId: seed.serviceUserId,
    automationId: seed.automationId,
    idempotencyKey: "retryable-job",
    payload: { attempt: 1 },
    maxAttempts: 3
  });
  const retryableClaim = claimNextDurableJob({ companyId: seed.companyId, serviceUserId: seed.serviceUserId, leaseMs: 15 * 60 * 1000, now: claimNow });
  assert.ok(retryableClaim);

  const retried = failDurableJob({
    companyId: seed.companyId,
    jobId: retryableJob.id,
    serviceUserId: seed.serviceUserId,
    fencingToken: retryableClaim.fencingToken,
    errorCode: "transient_error",
    retryable: true,
    retryDelayMs: 5000,
    now: laterNow
  });

  assert.equal(retried.status, "queued");
  assert.equal(retried.attemptCount, 1);
  assert.ok(retried.availableAt > laterNow);
  assert.equal(getJob(seed.companyId, retryableJob.id)?.status, "queued");
  assert.equal(activeSlotCount(seed.companyId, retryableJob.concurrencyKey), 0);
  assert.equal(db.querySql<{ status: string; error_code: string | null }>(
    `SELECT status, error_code FROM durable_job_attempts WHERE job_id=${db.sqlValue(retryableJob.id)} ORDER BY attempt_no DESC LIMIT 1`
  )[0].status, "retry_scheduled");

  const exhaustedAutomation = seedDurableCompany("company_exhaust", "service_exhaust", "automation_exhaust", "version_exhaust");
  const exhaustedJob = enqueueAutomationDryRun({
    companyId: exhaustedAutomation.companyId,
    actorUserId: exhaustedAutomation.serviceUserId,
    automationId: exhaustedAutomation.automationId,
    idempotencyKey: "exhausted-job",
    payload: { attempt: 2 },
    maxAttempts: 1
  });
  const exhaustedClaim = claimNextDurableJob({ companyId: exhaustedAutomation.companyId, serviceUserId: exhaustedAutomation.serviceUserId, leaseMs: 15 * 60 * 1000, now: claimNow });
  assert.ok(exhaustedClaim);

  const failed = failDurableJob({
    companyId: exhaustedAutomation.companyId,
    jobId: exhaustedJob.id,
    serviceUserId: exhaustedAutomation.serviceUserId,
    fencingToken: exhaustedClaim.fencingToken,
    errorCode: "permanent_error",
    retryable: true,
    now: laterNow
  });

  assert.equal(failed.status, "failed");
  assert.equal(failed.lastError, "permanent_error");
  assert.equal(getJob(exhaustedAutomation.companyId, exhaustedJob.id)?.status, "failed");
  assert.equal(activeSlotCount(exhaustedAutomation.companyId, exhaustedJob.concurrencyKey), 0);
});

test("cancelling a leased job releases the slot once and stale finalizers are fenced out", () => {
  resetDurableState();
  const seed = seedDurableCompany("company_cancel", "service_cancel", "automation_cancel", "version_cancel");
  const job = enqueueAutomationDryRun({
    companyId: seed.companyId,
    actorUserId: seed.serviceUserId,
    automationId: seed.automationId,
    idempotencyKey: "cancel-job",
    payload: { job: "cancel" }
  });
  const claim = claimNextDurableJob({ companyId: seed.companyId, serviceUserId: seed.serviceUserId, leaseMs: 15 * 60 * 1000, now: claimNow });
  assert.ok(claim);

  const cancelled = cancelDurableJob({ companyId: seed.companyId, actorUserId: seed.serviceUserId, jobId: job.id, now: laterNow });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(activeSlotCount(seed.companyId, job.concurrencyKey), 0);
  assert.equal(db.querySql<{ status: string }>(
    `SELECT status FROM durable_job_attempts WHERE job_id=${db.sqlValue(job.id)} LIMIT 1`
  )[0].status, "cancelled");

  assert.throws(
    () =>
      completeDurableDryRun({
        companyId: seed.companyId,
        jobId: job.id,
        serviceUserId: seed.serviceUserId,
        fencingToken: claim.fencingToken,
        result: { outcome: "stale" },
        now: laterNow
      }),
    (error: unknown) => {
      assert.equal((error as Error).message, "stale_durable_job_fence");
      return true;
    }
  );

  assert.equal(activeSlotCount(seed.companyId, job.concurrencyKey), 0);
});

test("expired leases can be recovered back to queued state", () => {
  resetDurableState();
  const seed = seedDurableCompany("company_recover", "service_recover", "automation_recover", "version_recover");
  const job = enqueueAutomationDryRun({
    companyId: seed.companyId,
    actorUserId: seed.serviceUserId,
    automationId: seed.automationId,
    idempotencyKey: "recover-job",
    payload: { job: "recover" },
    maxAttempts: 2
  });
  const claim = claimNextDurableJob({ companyId: seed.companyId, serviceUserId: seed.serviceUserId, leaseMs: 5000, now: claimNow });
  assert.ok(claim);

  const recovered = recoverExpiredDurableJobs({ companyId: seed.companyId, serviceUserId: seed.serviceUserId, now: recoveryNow });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, job.id);
  assert.equal(recovered[0].status, "queued");
  assert.equal(recovered[0].availableAt, recoveryNow);
  assert.equal(getJob(seed.companyId, job.id)?.status, "queued");
  assert.equal(activeSlotCount(seed.companyId, job.concurrencyKey), 0);
  assert.equal(db.querySql<{ status: string; error_code: string | null }>(
    `SELECT status, error_code FROM durable_job_attempts WHERE job_id=${db.sqlValue(job.id)} ORDER BY attempt_no DESC LIMIT 1`
  )[0].status, "retry_scheduled");
});

test("schedule occurrence materialization is idempotent and pins the scheduled version", () => {
  resetDurableState();
  const seed = seedDurableCompany("company_schedule", "service_schedule", "automation_schedule", "version_schedule_1");
  db.execSql(`UPDATE mvp_automations SET status='active' WHERE id=${db.sqlValue(seed.automationId)}`);
  db.insert("mvp_automation_schedules", {
    id: "schedule_durable_1",
    company_id: seed.companyId,
    project_id: seed.companyId,
    automation_id: seed.automationId,
    automation_version_id: seed.versionId,
    kind: "daily",
    expression: "09:00",
    timezone: "UTC",
    enabled: 1,
    status: "active",
    revision: 1,
    next_run_at: laterNow,
    last_run_at: null,
    paused_at: null,
    created_at: claimNow,
    updated_at: claimNow
  });
  const first = materializeDurableScheduleOccurrence({
    companyId: seed.companyId,
    serviceUserId: seed.serviceUserId,
    scheduleId: "schedule_durable_1",
    scheduledFor: laterNow,
    expectedScheduleRevision: 1
  });
  const replay = materializeDurableScheduleOccurrence({
    companyId: seed.companyId,
    serviceUserId: seed.serviceUserId,
    scheduleId: "schedule_durable_1",
    scheduledFor: laterNow,
    expectedScheduleRevision: 1
  });
  assert.equal(replay.job.id, first.job.id);
  assert.equal(replay.occurrence.id, first.occurrence.id);
  assert.equal(first.job.automationVersionId, seed.versionId);
  assert.equal(db.querySql<{ count: number }>("SELECT count(*) AS count FROM durable_schedule_occurrences WHERE schedule_id='schedule_durable_1'")[0].count, 1);

  db.execSql("UPDATE mvp_automation_schedules SET status='paused', enabled=0 WHERE id='schedule_durable_1'");
  assert.throws(() => materializeDurableScheduleOccurrence({
    companyId: seed.companyId,
    serviceUserId: seed.serviceUserId,
    scheduleId: "schedule_durable_1",
    scheduledFor: recoveryNow,
    expectedScheduleRevision: 1
  }), /automation_schedule_revision_or_due_conflict/);
});

test("P5 no-effect canary coordinates two schedulers and three workers, then recovers a killed worker", async () => {
  resetDurableState();
  const seed = seedDurableCompany("company_p5_canary", "service_p5_canary", "automation_p5_canary", "version_p5_canary");
  db.execSql(`UPDATE mvp_automations SET status='active' WHERE id=${db.sqlValue(seed.automationId)}`);
  db.insert("mvp_automation_schedules", {
    id: "schedule_p5_canary",
    company_id: seed.companyId,
    project_id: seed.companyId,
    automation_id: seed.automationId,
    automation_version_id: seed.versionId,
    kind: "daily",
    expression: "09:00",
    timezone: "UTC",
    enabled: 1,
    status: "active",
    revision: 1,
    next_run_at: claimNow,
    last_run_at: null,
    paused_at: null,
    created_at: claimNow,
    updated_at: claimNow
  });

  const moduleUrl = compiledRuntimeModule("runs/durableQueue.js", "../runs/durableQueue.js");
  const schedulerCode = `
    const queue = await import(${JSON.stringify(moduleUrl)});
    const result = queue.materializeDurableScheduleOccurrence({ companyId: ${JSON.stringify(seed.companyId)}, serviceUserId: ${JSON.stringify(seed.serviceUserId)}, scheduleId: "schedule_p5_canary", scheduledFor: ${JSON.stringify(claimNow)}, expectedScheduleRevision: 1 });
    process.stdout.write(result.job.id);
  `;
  const schedulerResults = await Promise.all(Array.from({ length: 2 }, () => runClaimProcess(schedulerCode)));
  assert.equal(new Set(schedulerResults).size, 1, "two schedulers must converge on one idempotent occurrence");

  const workerCode = `
    const queue = await import(${JSON.stringify(moduleUrl)});
    const claim = queue.claimNextDurableJob({ companyId: ${JSON.stringify(seed.companyId)}, serviceUserId: ${JSON.stringify(seed.serviceUserId)}, leaseMs: 5000, now: ${JSON.stringify(claimNow)} });
    process.stdout.write(claim ? claim.id : "null");
  `;
  const workerResults = await Promise.all(Array.from({ length: 3 }, () => runClaimProcess(workerCode)));
  const winner = workerResults.filter((value) => value !== "null");
  assert.deepEqual(winner, [schedulerResults[0]]);
  assert.equal(workerResults.filter((value) => value === "null").length, 2);

  const claimed = db.querySql<{ fencing_token: number; heartbeat_at: string | null }>(
    `SELECT fencing_token, heartbeat_at FROM durable_jobs WHERE id=${db.sqlValue(schedulerResults[0])} AND company_id=${db.sqlValue(seed.companyId)} LIMIT 1`
  )[0];
  assert.equal(claimed.fencing_token, 1);
  heartbeatDurableJob({ companyId: seed.companyId, jobId: schedulerResults[0], serviceUserId: seed.serviceUserId, fencingToken: claimed.fencing_token, leaseMs: 5000, now: claimNow });
  assert.equal(getJob(seed.companyId, schedulerResults[0])?.heartbeatAt, claimNow);
  assert.throws(
    () => heartbeatDurableJob({ companyId: seed.companyId, jobId: schedulerResults[0], serviceUserId: seed.serviceUserId, fencingToken: 0, now: laterNow }),
    /stale_durable_job_fence/
  );

  const recovered = recoverExpiredDurableJobs({ companyId: seed.companyId, serviceUserId: seed.serviceUserId, now: recoveryNow });
  assert.equal(recovered.length, 1, "a worker that exits before finalization must be recoverable");
  assert.equal(recovered[0].status, "queued");
  assert.equal(activeSlotCount(seed.companyId, recovered[0].concurrencyKey), 0);
  assert.equal(db.querySql<{ count: number }>(`SELECT count(*) AS count FROM durable_schedule_occurrences WHERE schedule_id='schedule_p5_canary'`)[0].count, 1);
});

test("explicit retry is idempotent and preserves the pinned version", () => {
  resetDurableState();
  const seed = seedDurableCompany("company_manual_retry", "service_manual_retry", "automation_manual_retry", "version_manual_retry");
  const job = enqueueAutomationDryRun({
    companyId: seed.companyId,
    actorUserId: seed.serviceUserId,
    automationId: seed.automationId,
    idempotencyKey: "manual-retry-job",
    maxAttempts: 1
  });
  const claim = claimNextDurableJob({ companyId: seed.companyId, serviceUserId: seed.serviceUserId, now: claimNow, leaseMs: 15 * 60 * 1000 });
  assert.ok(claim);
  const failed = failDurableJob({ companyId: seed.companyId, jobId: job.id, serviceUserId: seed.serviceUserId, fencingToken: claim.fencingToken, errorCode: "exhausted", retryable: true, now: laterNow });
  assert.equal(failed.status, "failed");
  const retried = retryDurableJob({ companyId: seed.companyId, actorUserId: seed.serviceUserId, jobId: job.id, idempotencyKey: "manual-retry-request", now: recoveryNow });
  const replay = retryDurableJob({ companyId: seed.companyId, actorUserId: seed.serviceUserId, jobId: job.id, idempotencyKey: "manual-retry-request", now: recoveryNow });
  assert.equal(retried.status, "queued");
  assert.equal(replay.id, retried.id);
  assert.equal(retried.automationVersionId, seed.versionId);
  assert.equal(retried.maxAttempts, 2);
});

test("safe durable worker completes only the internal dry-run control plane", () => {
  resetDurableState();
  const seed = seedDurableCompany("company_worker", "service_worker", "automation_worker", "version_worker");
  const job = enqueueAutomationDryRun({ companyId: seed.companyId, actorUserId: seed.serviceUserId, automationId: seed.automationId, idempotencyKey: "worker-job" });
  const result = runDurableDryRunWorkerOnce({ companyId: seed.companyId, serviceUserId: seed.serviceUserId, now: claimNow });
  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  assert.equal(result.job.id, job.id);
  const artifact = readRunArtifact(seed.companyId, result.artifactId);
  assert.ok(artifact);
  const body = JSON.parse(artifact.contentText);
  assert.equal(body.external_action_executed, false);
  assert.equal(body.automation_version_id, seed.versionId);
});

test("durable reference workflow attempts carry one root-bound IAB readback and stop without runtime identity", () => {
  resetDurableState();
  const seed = seedDurableCompany("company_runtime_binding", "service_runtime_binding", "automation_runtime_binding", "version_runtime_binding");
  const job = enqueueAutomationDryRun({
    companyId: seed.companyId,
    actorUserId: seed.serviceUserId,
    automationId: seed.automationId,
    idempotencyKey: "runtime-binding-job",
    payload: { registered_workflow_id: "daily-ai-research-publish-run" }
  });
  const result = runDurableDryRunWorkerOnce({ companyId: seed.companyId, serviceUserId: seed.serviceUserId, now: claimNow });
  assert.equal(result.status, "completed");
  if (result.status !== "completed") return;
  const runMetadata = JSON.parse(db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${db.sqlValue(job.runId)}`)[0].metadata_json);
  assert.match(runMetadata.service_readiness_root_id, /^root-[a-f0-9]{40}$/);
  assert.equal(runMetadata.service_readiness_workflow_id, "daily-ai");
  const claimedEvent = db.querySql<{ metadata_json: string }>(`SELECT metadata_json FROM worker_events WHERE run_id=${db.sqlValue(job.runId)} AND event_type='durable_job_claimed' LIMIT 1`)[0];
  const claimMetadata = JSON.parse(claimedEvent.metadata_json);
  assert.equal(claimMetadata.service_readiness_runtime_binding.status, "blocked");
  assert.equal(claimMetadata.service_readiness_runtime_binding.exact_blocker, "in_app_browser_runtime_unavailable");
  const artifact = readRunArtifact(seed.companyId, result.artifactId);
  assert.ok(artifact);
  const body = JSON.parse(artifact.contentText);
  assert.equal(body.service_readiness_runtime_binding.workflow_id, "daily-ai");
  assert.equal(body.service_readiness_runtime_binding.run_id, job.runId);
  assert.equal(body.service_readiness_runtime_binding.external_action_executed, false);
});

test("legacy worker scanner never executes a run owned by the durable queue", async () => {
  resetDurableState();
  const seed = seedDurableCompany("company_legacy_skip", "service_legacy_skip", "automation_legacy_skip", "version_legacy_skip");
  const job = enqueueAutomationDryRun({ companyId: seed.companyId, actorUserId: seed.serviceUserId, automationId: seed.automationId, idempotencyKey: "legacy-skip-job" });
  const summaries = await runWorkerOnce(job.runId);
  assert.deepEqual(summaries, []);
  assert.equal(db.querySql<{ status: string }>(`SELECT status FROM runs WHERE id=${db.sqlValue(job.runId)}`)[0].status, "queued");
  assert.equal(db.querySql<{ status: string }>(`SELECT status FROM durable_jobs WHERE id=${db.sqlValue(job.id)}`)[0].status, "queued");
});

test("worker loop fails closed instead of silently skipping queued durable work without a service identity", async () => {
  resetDurableState();
  const seed = seedDurableCompany("company_missing_service", "service_missing_service", "automation_missing_service", "version_missing_service");
  const job = enqueueAutomationDryRun({ companyId: seed.companyId, actorUserId: seed.serviceUserId, automationId: seed.automationId, idempotencyKey: "missing-service-job" });

  const result = await runWorkerLoopProcess();
  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /durable_service_user_id_missing_with_pending_work/);
  assert.equal(db.querySql<{ status: string }>(`SELECT status FROM durable_jobs WHERE id=${db.sqlValue(job.id)}`)[0].status, "queued");
  const heartbeat = db.querySql<{ status: string; metadata_json: string }>("SELECT status, metadata_json FROM system_checks WHERE id='local_codex_worker_heartbeat'")[0];
  assert.equal(heartbeat.status, "blocked");
  assert.equal(JSON.parse(heartbeat.metadata_json).blocker, "durable_service_user_id_missing_with_pending_work");
});

test("worker loop rejects an invalid durable service identity instead of reporting an empty success", async () => {
  resetDurableState();
  const seed = seedDurableCompany("company_invalid_service", "service_invalid_service", "automation_invalid_service", "version_invalid_service");
  const job = enqueueAutomationDryRun({ companyId: seed.companyId, actorUserId: seed.serviceUserId, automationId: seed.automationId, idempotencyKey: "invalid-service-job" });

  const result = await runWorkerLoopProcess("typo_service_user");
  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /durable_service_user_invalid_or_unscoped_for_pending_work/);
  assert.equal(db.querySql<{ status: string }>(`SELECT status FROM durable_jobs WHERE id=${db.sqlValue(job.id)}`)[0].status, "queued");
});

test("worker loop rejects a service identity whose operator scope misses any company with durable work", async () => {
  resetDurableState();
  const companyA = seedDurableCompany("company_partial_a", "service_partial_a", "automation_partial_a", "version_partial_a");
  const companyB = seedDurableCompany("company_partial_b", "service_partial_b", "automation_partial_b", "version_partial_b");
  const jobA = enqueueAutomationDryRun({ companyId: companyA.companyId, actorUserId: companyA.serviceUserId, automationId: companyA.automationId, idempotencyKey: "partial-service-job-a" });
  const jobB = enqueueAutomationDryRun({ companyId: companyB.companyId, actorUserId: companyB.serviceUserId, automationId: companyB.automationId, idempotencyKey: "partial-service-job-b" });

  const result = await runWorkerLoopProcess(companyA.serviceUserId);
  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /durable_service_user_scope_incomplete_for_pending_work/);
  assert.equal(db.querySql<{ status: string }>(`SELECT status FROM durable_jobs WHERE id=${db.sqlValue(jobA.id)}`)[0].status, "queued");
  assert.equal(db.querySql<{ status: string }>(`SELECT status FROM durable_jobs WHERE id=${db.sqlValue(jobB.id)}`)[0].status, "queued");
});

test("worker loop processes durable work when the configured service identity covers every required company", async () => {
  resetDurableState();
  const seed = seedDurableCompany("company_valid_service", "service_valid_service", "automation_valid_service", "version_valid_service");
  const job = enqueueAutomationDryRun({ companyId: seed.companyId, actorUserId: seed.serviceUserId, automationId: seed.automationId, idempotencyKey: "valid-service-job" });

  const result = await runWorkerLoopProcess(seed.serviceUserId);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /"processed":1/);
  assert.match(result.stdout, /"workerStatus":"completed"/);
  assert.equal(db.querySql<{ status: string }>(`SELECT status FROM durable_jobs WHERE id=${db.sqlValue(job.id)}`)[0].status, "completed");
});

test("100 concurrent worker processes produce exactly one claim winner for one job", async () => {
  resetDurableState();
  const seed = seedDurableCompany("company_concurrent", "service_concurrent", "automation_concurrent", "version_concurrent");
  const job = enqueueAutomationDryRun({ companyId: seed.companyId, actorUserId: seed.serviceUserId, automationId: seed.automationId, idempotencyKey: "concurrent-job" });
  const moduleUrl = compiledRuntimeModule("runs/durableQueue.js", "../runs/durableQueue.js");
  const code = `
    const queue = await import(${JSON.stringify(moduleUrl)});
    const claim = queue.claimNextDurableJob({ companyId: ${JSON.stringify(seed.companyId)}, serviceUserId: ${JSON.stringify(seed.serviceUserId)}, now: ${JSON.stringify(claimNow)} });
    process.stdout.write(claim ? claim.id : "null");
  `;
  const results = await Promise.all(Array.from({ length: 100 }, () => runClaimProcess(code)));
  assert.deepEqual(results.filter((value) => value === job.id), [job.id]);
  assert.equal(results.filter((value) => value === "null").length, 99);
  assert.equal(activeSlotCount(seed.companyId, job.concurrencyKey), 1);
  assert.equal(db.querySql<{ count: number }>(`SELECT count(*) AS count FROM durable_job_attempts WHERE job_id=${db.sqlValue(job.id)}`)[0].count, 1);
});

function resetDurableState(): void {
  db.initDb();
  db.execSql(`
    DELETE FROM run_artifacts;
    DELETE FROM durable_job_attempts;
    DELETE FROM durable_jobs;
    DELETE FROM durable_schedule_occurrences;
    DELETE FROM durable_concurrency_slots;
    DELETE FROM mvp_idempotency_keys;
    DELETE FROM worker_events;
    DELETE FROM proofs;
    DELETE FROM run_steps;
    DELETE FROM runs;
    DELETE FROM mvp_automation_schedules;
    DELETE FROM mvp_automation_versions;
    DELETE FROM mvp_automations;
    DELETE FROM company_audit_events;
    DELETE FROM company_memberships;
    DELETE FROM users;
    DELETE FROM companies;
  `);
}

function seedDurableCompany(companyId: string, serviceUserId: string, automationId: string, versionId: string): {
  companyId: string;
  serviceUserId: string;
  automationId: string;
  versionId: string;
} {
  const createdAt = "2026-07-15T00:00:00.000Z";
  db.insert("users", {
    id: serviceUserId,
    auth_provider: "legacy_operator_token",
    auth_subject: serviceUserId,
    email: null,
    display_name: serviceUserId,
    kind: "service",
    status: "active",
    created_at: createdAt,
    updated_at: createdAt
  });
  db.insert("companies", {
    id: companyId,
    slug: companyId,
    name: companyId,
    status: "active",
    created_at: createdAt,
    updated_at: createdAt
  });
  db.insert("company_memberships", {
    id: `${companyId}_membership`,
    company_id: companyId,
    user_id: serviceUserId,
    role: "operator",
    status: "active",
    created_at: createdAt,
    updated_at: createdAt
  });
  db.insert("mvp_automations", {
    id: automationId,
    company_id: companyId,
    project_id: companyId,
    automation_type: "daily-ai",
    name: automationId,
    description: "desc",
    goal: "goal",
    schedule: "0 * * * *",
    cadence: "daily",
    lane: "local",
    risk_level: "medium",
    approval_policy: "required_before_external_action",
    worker_command_kind: "safe_local_demo",
    create_approval: 0,
    status: "draft",
    builder_spec_json: { seed: automationId },
    current_version_id: versionId,
    revision: 1,
    archived_at: null,
    created_at: createdAt,
    updated_at: createdAt
  });
  db.insert("mvp_automation_versions", {
    id: versionId,
    company_id: companyId,
    project_id: companyId,
    automation_id: automationId,
    revision: 1,
    automation_type: "daily-ai",
    name: automationId,
    description: "desc",
    goal: "goal",
    schedule: "0 * * * *",
    cadence: "daily",
    lane: "local",
    risk_level: "medium",
    approval_policy: "required_before_external_action",
    worker_command_kind: "safe_local_demo",
    create_approval: 0,
    status: "draft",
    builder_spec_json: { seed: automationId },
    created_at: createdAt,
    updated_at: createdAt
  });
  return { companyId, serviceUserId, automationId, versionId };
}

function listJobIds(companyId: string): string[] {
  return db.querySql<{ id: string }>(
    `SELECT id FROM durable_jobs WHERE company_id=${db.sqlValue(companyId)} ORDER BY created_at ASC, id ASC`
  ).map((row) => row.id);
}

function getJob(companyId: string, jobId: string) {
  const row = db.querySql<{ status: string; heartbeat_at: string | null; concurrency_key: string }>(
    `SELECT status, heartbeat_at, concurrency_key FROM durable_jobs WHERE company_id=${db.sqlValue(companyId)} AND id=${db.sqlValue(jobId)} LIMIT 1`
  )[0];
  if (!row) return undefined;
  return {
    status: row.status,
    heartbeatAt: row.heartbeat_at,
    concurrencyKey: row.concurrency_key
  };
}

function activeSlotCount(companyId: string, concurrencyKey: string): number {
  return db.querySql<{ active_count: number }>(
    `SELECT active_count FROM durable_concurrency_slots WHERE company_id=${db.sqlValue(companyId)} AND concurrency_key=${db.sqlValue(concurrencyKey)} LIMIT 1`
  )[0]?.active_count ?? 0;
}

function runClaimProcess(code: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", code], {
      cwd: process.cwd(),
      env: { ...process.env, AUTOMATION_OS_DB: process.env.AUTOMATION_OS_DB! },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (codeValue) => {
      if (codeValue === 0) resolve(stdout.trim());
      else reject(new Error(`claim_process_failed:${codeValue}:${stderr.trim()}`));
    });
  });
}

function runWorkerLoopProcess(serviceUserId = ""): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const workerLoopPath = compiledRuntimeEntry("cli/workerLoop.js", "../cli/workerLoop.js");
    const child = spawn(process.execPath, [workerLoopPath, "--max-cycles=1"], {
      cwd: process.cwd(),
      env: { ...process.env, AUTOMATION_OS_DB: process.env.AUTOMATION_OS_DB!, AUTOMATION_OS_DURABLE_SERVICE_USER_ID: serviceUserId },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

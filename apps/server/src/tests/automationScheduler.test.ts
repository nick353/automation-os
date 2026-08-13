import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-scheduler-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");

const db = await import("../db/client.js");
const scheduler = await import("../runs/automationScheduler.js");
const queue = await import("../runs/durableQueue.js");
const durableScheduler = await import("../runs/durableAutomationScheduler.js");
const { portableReadOnlyStageForScheduledWorkflow } = await import("../runs/portableScheduleDispatch.js");
const { adoptRegisteredAutomationCatalog } = await import("../automations/registeredCatalog.js");
const { initRegisteredWorkflows } = await import("../registeredWorkflows.js");

test("schedule calculations honor timezone, weekday, and cron cadence", () => {
  assert.equal(scheduler.computeNextAutomationOccurrence({ kind: "daily", expression: "09:00", timezone: "Asia/Tokyo" }, "2026-07-15T00:00:00.000Z"), "2026-07-16T00:00:00.000Z");
  assert.equal(scheduler.computeNextAutomationOccurrence({ kind: "weekly", expression: "MON 09:00", timezone: "Asia/Tokyo" }, "2026-07-15T00:00:00.000Z"), "2026-07-20T00:00:00.000Z");
  assert.equal(scheduler.computeNextAutomationOccurrence({ kind: "cron", expression: "0 * * * *", timezone: "UTC" }, "2026-07-15T00:30:00.000Z"), "2026-07-15T01:00:00.000Z");
  assert.equal(scheduler.computeNextAutomationOccurrence({ kind: "daily", expression: "09:00", timezone: "America/New_York" }, "2026-03-07T14:00:00.000Z"), "2026-03-08T13:00:00.000Z");
  assert.throws(() => scheduler.computeNextAutomationOccurrence({ kind: "cron", expression: "invalid", timezone: "UTC" }, "2026-07-15T00:00:00.000Z"), /scheduler_cron_expression_invalid/);
  assert.throws(() => scheduler.computeNextAutomationOccurrence({ kind: "daily", expression: "09:00", timezone: "Invalid\/Zone" }, "2026-07-15T00:00:00.000Z"), /scheduler_timezone_invalid/);
});

test("job no-effect dispatch uses reference readback unless a run-bound input bundle exists", () => {
  assert.equal(portableReadOnlyStageForScheduledWorkflow("job-application-manager"), "reference_readback");
  assert.equal(
    portableReadOnlyStageForScheduledWorkflow("job-application-manager", { hasInputBundle: true }),
    "candidate_supply"
  );
  assert.equal(
    portableReadOnlyStageForScheduledWorkflow("daily-ai-research-publish-run"),
    "reference_readback"
  );
});

test("scheduler initializes next run, materializes one durable occurrence, and keeps the pinned version", () => {
  const fixture = seedSchedule();
  const initialized = scheduler.materializeDueAutomationOccurrences({ companyId: fixture.companyId, serviceUserId: fixture.serviceUserId, now: "2026-07-15T00:00:00.000Z" });
  assert.deepEqual(initialized.initializedScheduleIds, [fixture.scheduleId]);
  assert.deepEqual(initialized.occurrences, []);
  assert.equal(db.querySql<{ next_run_at: string }>(`SELECT next_run_at FROM mvp_automation_schedules WHERE id=${db.sqlValue(fixture.scheduleId)}`)[0].next_run_at, "2026-07-15T09:00:00.000Z");

  addVersion2(fixture);
  const due = scheduler.materializeDueAutomationOccurrences({ companyId: fixture.companyId, serviceUserId: fixture.serviceUserId, now: "2026-07-15T09:00:00.000Z" });
  assert.equal(due.occurrences.length, 1);
  const job = db.querySql<{ automation_version_id: string; status: string }>(`SELECT automation_version_id, status FROM durable_jobs WHERE schedule_occurrence_id=${db.sqlValue(due.occurrences[0].id)}`)[0];
  assert.equal(job.automation_version_id, fixture.versionId);
  assert.equal(job.status, "queued");
  assert.equal(db.querySql<{ next_run_at: string }>(`SELECT next_run_at FROM mvp_automation_schedules WHERE id=${db.sqlValue(fixture.scheduleId)}`)[0].next_run_at, "2026-07-16T09:00:00.000Z");

  const duplicateTick = scheduler.materializeDueAutomationOccurrences({ companyId: fixture.companyId, serviceUserId: fixture.serviceUserId, now: "2026-07-15T09:00:00.000Z" });
  assert.equal(duplicateTick.occurrences.length, 0);
  assert.equal(db.querySql<{ count: number }>("SELECT count(*) AS count FROM durable_schedule_occurrences")[0].count, 1);

  db.execSql(`UPDATE mvp_automation_schedules SET enabled=0, status='paused' WHERE id=${db.sqlValue(fixture.scheduleId)}`);
  const paused = scheduler.materializeDueAutomationOccurrences({ companyId: fixture.companyId, serviceUserId: fixture.serviceUserId, now: "2026-07-16T09:00:00.000Z" });
  assert.equal(paused.occurrences.length, 0);
  assert.equal(db.querySql<{ count: number }>("SELECT count(*) AS count FROM durable_schedule_occurrences")[0].count, 1);
});

test("stale scheduler snapshots cannot enqueue after a schedule revision or due-time edit", () => {
  const fixture = seedScheduleVariant("stale");
  const staleDueAt = "2026-07-15T09:00:00.000Z";
  db.execSql(`UPDATE mvp_automation_schedules SET next_run_at=${db.sqlValue(staleDueAt)} WHERE id=${db.sqlValue(fixture.scheduleId)}`);
  db.execSql(`UPDATE mvp_automation_schedules
              SET revision=2, automation_version_id=${db.sqlValue(fixture.versionId)}, next_run_at='2026-07-15T10:00:00.000Z', updated_at='2026-07-15T08:30:00.000Z'
              WHERE id=${db.sqlValue(fixture.scheduleId)}`);

  assert.throws(() => queue.materializeDurableScheduleOccurrence({
    companyId: fixture.companyId,
    serviceUserId: fixture.serviceUserId,
    scheduleId: fixture.scheduleId,
    scheduledFor: staleDueAt,
    expectedScheduleRevision: 1,
    nextRunAt: "2026-07-16T09:00:00.000Z"
  }), /automation_schedule_revision_or_due_conflict/);
  assert.equal(db.querySql<{ count: number }>(`SELECT count(*) AS count FROM durable_schedule_occurrences WHERE schedule_id=${db.sqlValue(fixture.scheduleId)}`)[0].count, 0);
  assert.equal(db.querySql<{ next_run_at: string }>(`SELECT next_run_at FROM mvp_automation_schedules WHERE id=${db.sqlValue(fixture.scheduleId)}`)[0].next_run_at, "2026-07-15T10:00:00.000Z");
});

test("AOS server-owned scheduler materializes due work without invoking a provider", async () => {
  db.execSql("UPDATE mvp_automation_schedules SET enabled=0, status='paused'");
  const fixture = seedScheduleVariant("server_owned");
  db.execSql(`UPDATE mvp_automation_schedules SET next_run_at='2026-07-15T09:00:00.000Z' WHERE id=${db.sqlValue(fixture.scheduleId)}`);
  const result = await durableScheduler.runDurableAutomationSchedulerOnce({
    serviceUserId: fixture.serviceUserId,
    now: "2026-07-15T09:00:00.000Z"
  });
  assert.equal(result.status, "completed");
  assert.equal(result.externalActionExecuted, false);
  assert.deepEqual(result.checkedCompanyIds, [fixture.companyId]);
  assert.equal(result.occurrences.length, 1);
  assert.equal(db.querySql<{ kind: string; status: string }>(`SELECT kind, status FROM durable_jobs WHERE company_id=${db.sqlValue(fixture.companyId)}`)[0].kind, "scheduled_dry_run");
  assert.equal(db.querySql<{ status: string }>(`SELECT status FROM durable_jobs WHERE company_id=${db.sqlValue(fixture.companyId)}`)[0].status, "queued");
});

test("registered browser schedules enter the portable Mac-worker queue instead of the Codex/root queue", async () => {
  db.initDb();
  db.execSql("UPDATE mvp_automation_schedules SET enabled=0, status='paused'");
  initRegisteredWorkflows();
  const createdAt = "2026-07-14T00:00:00.000Z";
  const companyId = "portable_scheduler_company";
  const ownerId = "portable_scheduler_owner";
  const serviceUserId = "portable_scheduler_service";
  db.insert("users", { id: ownerId, auth_provider: "test", auth_subject: ownerId, email: null, display_name: ownerId, kind: "human", status: "active", created_at: createdAt, updated_at: createdAt });
  db.insert("users", { id: serviceUserId, auth_provider: "service", auth_subject: serviceUserId, email: null, display_name: serviceUserId, kind: "service", status: "active", created_at: createdAt, updated_at: createdAt });
  db.insert("companies", { id: companyId, slug: companyId, name: companyId, status: "active", created_at: createdAt, updated_at: createdAt });
  db.insert("company_memberships", { id: "portable_scheduler_owner_membership", company_id: companyId, user_id: ownerId, role: "owner", status: "active", created_at: createdAt, updated_at: createdAt });
  db.insert("company_memberships", { id: "portable_scheduler_service_membership", company_id: companyId, user_id: serviceUserId, role: "operator", status: "active", created_at: createdAt, updated_at: createdAt });
  const adopted = adoptRegisteredAutomationCatalog({ companyId, actorUserId: ownerId, enableSchedules: true });
  const job = adopted.adopted.find((item) => item.sourceAutomationId === "automation-3")!;
  db.execSql(`UPDATE mvp_automation_schedules SET next_run_at='2026-07-15T00:30:00.000Z' WHERE id=${db.sqlValue(job.schedule.id)}`);

  const result = await durableScheduler.runDurableAutomationSchedulerOnce({
    serviceUserId,
    now: "2026-07-15T00:30:00.000Z"
  });
  assert.equal(result.status, "completed");
  assert.equal(result.externalActionExecuted, false);
  assert.equal(result.portableRunIds.length, 1);
  assert.ok(result.portableScheduleIds.includes(job.schedule.id));
  assert.ok(result.portableWorkflowIds.includes("job-application-manager"));
  assert.equal(db.querySql<{ count: number }>(`SELECT count(*) AS count FROM durable_jobs WHERE company_id=${db.sqlValue(companyId)}`)[0].count, 0);
  const portableRun = db.querySql<{ execution_source: string; metadata_json: string }>(`SELECT execution_source, metadata_json FROM runs WHERE id=${db.sqlValue(result.portableRunIds[0])}`)[0];
  const metadata = JSON.parse(portableRun.metadata_json) as { worker_protocol?: string; worker_mode?: string; portable_workflow_invocation?: { source_trigger?: string; read_only_stage?: string } };
  assert.equal(portableRun.execution_source, "automation-os");
  assert.equal(metadata.worker_protocol, "mac_worker_polling_required");
  assert.equal(metadata.worker_mode, "queued_for_mac_worker");
  assert.equal(metadata.portable_workflow_invocation?.source_trigger, "automation_os_scheduler");
    assert.equal(metadata.portable_workflow_invocation?.read_only_stage, "reference_readback");
});

test("unknown registered schedules fail closed and never fall through to generic durable dry-run", async () => {
  db.execSql("UPDATE mvp_automation_schedules SET enabled=0, status='paused'");
  initRegisteredWorkflows();
  const createdAt = "2026-07-14T00:00:00.000Z";
  const companyId = "portable_scheduler_unbound_company";
  const ownerId = "portable_scheduler_unbound_owner";
  const serviceUserId = "portable_scheduler_unbound_service";
  db.insert("users", { id: ownerId, auth_provider: "test", auth_subject: ownerId, email: null, display_name: ownerId, kind: "human", status: "active", created_at: createdAt, updated_at: createdAt });
  db.insert("users", { id: serviceUserId, auth_provider: "service", auth_subject: serviceUserId, email: null, display_name: serviceUserId, kind: "service", status: "active", created_at: createdAt, updated_at: createdAt });
  db.insert("companies", { id: companyId, slug: companyId, name: companyId, status: "active", created_at: createdAt, updated_at: createdAt });
  db.insert("company_memberships", { id: "portable_scheduler_unbound_owner_membership", company_id: companyId, user_id: ownerId, role: "owner", status: "active", created_at: createdAt, updated_at: createdAt });
  db.insert("company_memberships", { id: "portable_scheduler_unbound_service_membership", company_id: companyId, user_id: serviceUserId, role: "operator", status: "active", created_at: createdAt, updated_at: createdAt });
  const adopted = adoptRegisteredAutomationCatalog({ companyId, actorUserId: ownerId, enableSchedules: true });
  const email = adopted.adopted.find((item) => item.sourceAutomationId === "automation")!;
  db.execSql(`UPDATE mvp_automations
              SET worker_command_kind='unknown_registered', builder_spec_json=${db.sqlValue(JSON.stringify({ schema: "aos.registered_automation_adoption.v1", canonicalWorkflowId: "unknown-registered-workflow" }))}
              WHERE id=${db.sqlValue(email.automation.id)} AND company_id=${db.sqlValue(companyId)}`);
  db.execSql(`UPDATE mvp_automation_schedules SET next_run_at='2026-07-15T00:30:00.000Z' WHERE id=${db.sqlValue(email.schedule.id)}`);

  const result = await durableScheduler.runDurableAutomationSchedulerOnce({
    serviceUserId,
    now: "2026-07-15T00:30:00.000Z"
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.exactBlocker, "portable_registered_adapter_missing:unknown_registered");
  assert.equal(result.externalActionExecuted, false);
  assert.ok(result.handledScheduleIds.includes(email.schedule.id));
  assert.equal(result.portableRunIds.length, 0);
  assert.equal(db.querySql<{ count: number }>(`SELECT count(*) AS count FROM durable_jobs WHERE company_id=${db.sqlValue(companyId)}`)[0].count, 0);
});

test("scheduled dry-runs take precedence over an older manual dry-run backlog", async () => {
  db.execSql("UPDATE mvp_automation_schedules SET enabled=0, status='paused'");
  const fixture = seedScheduleVariant("scheduled_priority");
  const manual = queue.enqueueAutomationDryRun({
    companyId: fixture.companyId,
    actorUserId: fixture.serviceUserId,
    automationId: fixture.automationId,
    idempotencyKey: "manual-backlog-before-scheduled"
  });
  db.execSql(`UPDATE mvp_automation_schedules SET next_run_at='2026-07-15T09:00:00.000Z' WHERE id=${db.sqlValue(fixture.scheduleId)}`);

  const scheduled = await durableScheduler.runDurableAutomationSchedulerOnce({
    serviceUserId: fixture.serviceUserId,
    now: "2026-07-15T09:00:00.000Z"
  });
  assert.equal(scheduled.occurrences.length, 1);
  const scheduledJob = scheduled.occurrences[0].jobId;
  const priority = db.querySql<{ id: string; priority: number }>(
    `SELECT id, priority FROM durable_jobs WHERE company_id=${db.sqlValue(fixture.companyId)} ORDER BY priority DESC, created_at ASC`
  );
  assert.equal(priority[0].id, scheduledJob);
  assert.equal(priority[0].priority, 200);

  const claim = queue.claimNextDurableJob({ companyId: fixture.companyId, serviceUserId: fixture.serviceUserId, now: "2026-07-15T09:00:00.000Z" });
  assert.equal(claim?.id, scheduledJob);
  assert.equal(db.querySql<{ status: string }>(`SELECT status FROM durable_jobs WHERE id=${db.sqlValue(manual.id)}`)[0].status, "queued");
});

test("AOS server-owned scheduler fails closed when active schedules have no service identity", async () => {
  db.execSql("UPDATE mvp_automation_schedules SET enabled=0, status='paused'");
  const fixture = seedScheduleVariant("missing_identity");
  db.execSql(`UPDATE mvp_automation_schedules SET next_run_at='2026-07-15T09:00:00.000Z' WHERE id=${db.sqlValue(fixture.scheduleId)}`);
  const result = await durableScheduler.runDurableAutomationSchedulerOnce({ now: "2026-07-15T09:00:00.000Z", serviceUserId: "" });
  assert.equal(result.status, "blocked");
  assert.equal(result.exactBlocker, "durable_scheduler_service_user_id_missing");
  assert.equal(result.externalActionExecuted, false);
  assert.equal(db.querySql<{ count: number }>(`SELECT count(*) AS count FROM durable_jobs WHERE company_id=${db.sqlValue(fixture.companyId)}`)[0].count, 0);
});

function seedSchedule() {
  return seedScheduleVariant("");
}

function seedScheduleVariant(suffix: string) {
  db.initDb();
  const tag = suffix ? `_${suffix}` : "";
  const companyId = `scheduler_company${tag}`;
  const serviceUserId = `scheduler_service${tag}`;
  const automationId = `scheduler_automation${tag}`;
  const versionId = `scheduler_version_1${tag}`;
  const scheduleId = `scheduler_schedule${tag}`;
  const createdAt = "2026-07-14T00:00:00.000Z";
  db.insert("users", { id: serviceUserId, auth_provider: "service", auth_subject: serviceUserId, email: null, display_name: serviceUserId, kind: "service", status: "active", created_at: createdAt, updated_at: createdAt });
  db.insert("companies", { id: companyId, slug: companyId, name: companyId, status: "active", created_at: createdAt, updated_at: createdAt });
  db.insert("company_memberships", { id: `scheduler_membership${tag}`, company_id: companyId, user_id: serviceUserId, role: "operator", status: "active", created_at: createdAt, updated_at: createdAt });
  const common = { company_id: companyId, project_id: companyId, automation_type: "scheduled", name: "Scheduled automation", description: "desc", goal: "goal", schedule: "09:00", cadence: "daily", lane: "local", risk_level: "low", approval_policy: "required_before_external_action", worker_command_kind: "safe_local_demo", create_approval: 0, status: "active", builder_spec_json: {}, created_at: createdAt, updated_at: createdAt };
  db.insert("mvp_automations", { id: automationId, ...common, current_version_id: versionId, revision: 1, archived_at: null });
  db.insert("mvp_automation_versions", { id: versionId, ...common, automation_id: automationId, revision: 1 });
  db.insert("mvp_automation_schedules", { id: scheduleId, company_id: companyId, project_id: companyId, automation_id: automationId, automation_version_id: versionId, kind: "daily", expression: "09:00", timezone: "UTC", enabled: 1, status: "active", revision: 1, next_run_at: null, last_run_at: null, paused_at: null, created_at: createdAt, updated_at: createdAt });
  return { companyId, serviceUserId, automationId, versionId, scheduleId };
}

function addVersion2(fixture: ReturnType<typeof seedSchedule>) {
  const row = db.querySql<any>(`SELECT * FROM mvp_automation_versions WHERE id=${db.sqlValue(fixture.versionId)}`)[0];
  const { id: _id, revision: _revision, ...rest } = row;
  db.insert("mvp_automation_versions", { ...rest, id: "scheduler_version_2", revision: 2, name: "Changed automation", updated_at: "2026-07-15T08:00:00.000Z" });
  db.execSql(`UPDATE mvp_automations SET current_version_id='scheduler_version_2', revision=2, name='Changed automation' WHERE id=${db.sqlValue(fixture.automationId)}`);
}

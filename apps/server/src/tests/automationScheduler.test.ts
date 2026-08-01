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

test("schedule calculations honor timezone, weekday, and cron cadence", () => {
  assert.equal(scheduler.computeNextAutomationOccurrence({ kind: "daily", expression: "09:00", timezone: "Asia/Tokyo" }, "2026-07-15T00:00:00.000Z"), "2026-07-16T00:00:00.000Z");
  assert.equal(scheduler.computeNextAutomationOccurrence({ kind: "weekly", expression: "MON 09:00", timezone: "Asia/Tokyo" }, "2026-07-15T00:00:00.000Z"), "2026-07-20T00:00:00.000Z");
  assert.equal(scheduler.computeNextAutomationOccurrence({ kind: "cron", expression: "0 * * * *", timezone: "UTC" }, "2026-07-15T00:30:00.000Z"), "2026-07-15T01:00:00.000Z");
  assert.equal(scheduler.computeNextAutomationOccurrence({ kind: "daily", expression: "09:00", timezone: "America/New_York" }, "2026-03-07T14:00:00.000Z"), "2026-03-08T13:00:00.000Z");
  assert.throws(() => scheduler.computeNextAutomationOccurrence({ kind: "cron", expression: "invalid", timezone: "UTC" }, "2026-07-15T00:00:00.000Z"), /scheduler_cron_expression_invalid/);
  assert.throws(() => scheduler.computeNextAutomationOccurrence({ kind: "daily", expression: "09:00", timezone: "Invalid\/Zone" }, "2026-07-15T00:00:00.000Z"), /scheduler_timezone_invalid/);
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

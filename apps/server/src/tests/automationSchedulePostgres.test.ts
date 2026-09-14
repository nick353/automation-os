import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const postgresUrl = process.env.AUTOMATION_OS_TEST_POSTGRES_URL;
test("isolated PostgreSQL: draft schedule activation is atomic, concurrent-safe, and admitted only at its exact due time", {
  skip: postgresUrl ? false : "postgres_fixture_unavailable", timeout: 120_000
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "aos-schedule-activation-pg-"));
  process.env.AUTOMATION_OS_DATABASE_URL = postgresUrl;
  process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(root, "artifacts");
  process.env.AUTOMATION_OS_SECRET_DIR = join(root, "secrets");
  process.env.AOS_WEB_OPERATION_BACKEND_CONFIG = join(root, "backend.json");
  process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE = "external";
  process.env.AUTOMATION_OS_WORKER_ROLE = "mac";
  process.env.NODE_TEST_CONTEXT = "1";
  const db = await import("../db/client.js");
  await db.initializePostgresSchemaAsync();
  const repo = await import("../automations/repository.js");
  const { materializeDuePortableAutomationOccurrences } = await import("../runs/portableAutomationScheduler.js");
  const companyId = "schedule_pg_company";
  const actorUserId = "schedule_pg_actor";
  const at = db.nowIso();
  await db.insertAsync("users", { id: actorUserId, auth_provider: "service", auth_subject: actorUserId, email: null,
    display_name: actorUserId, kind: "service", status: "active", created_at: at, updated_at: at });
  await db.insertAsync("companies", { id: companyId, slug: companyId, name: "Schedule fixture", status: "active", created_at: at, updated_at: at });
  await db.insertAsync("company_memberships", { id: "schedule_pg_member", company_id: companyId, user_id: actorUserId,
    role: "operator", status: "active", created_at: at, updated_at: at });
  const definition = { automationType: "registered_workflow", name: "Audit-only schedule", description: "Isolated fixture",
    goal: "No provider or Vault write", lane: "local", riskLevel: "low", approvalPolicy: "required_before_external_action",
    workerCommandKind: "obsidian_audit_registered", createApproval: false,
    builderSpec: { schema: "aos.registered_automation_adoption.v1", canonicalWorkflowId: "obsidian-project-memory-audit",
      browserSurface: "none", unattendedEffectPolicy: null, stages: [{ id: "read_only_audit" }] } };
  const created = await repo.createAutomationRecordAsync({ companyId, actorUserId, definition });
  const scope = { companyId, actorUserId, automationId: created.id };
  const dueAt = new Date(Math.ceil((Date.now() + 600_000) / 60_000) * 60_000).toISOString();
  const schedule = { kind: "daily" as const, expression: dueAt.slice(11, 16), timezone: "UTC", enabled: false, expectedRevision: 1 };
  const paused = await repo.saveAutomationScheduleAsync({ ...scope, schedule, nextRunAt: dueAt });
  assert.equal(paused.nextRunAt, null);
  assert.deepEqual(await repo.getAutomationRecordAsync(companyId, created.id), created);
  const versionCount = async () => Number((await db.querySqlAsync<{ count: string }>(
    `SELECT count(*) AS count FROM mvp_automation_versions WHERE automation_id=${db.sqlValue(created.id)}`))[0].count);
  const auditCount = async () => Number((await db.querySqlAsync<{ count: string }>(
    `SELECT count(*) AS count FROM company_audit_events WHERE entity_id=${db.sqlValue(created.id)} AND action='automation.activated'`))[0].count);
  const enabledInput = { ...scope, schedule: { ...schedule, enabled: true }, nextRunAt: dueAt };
  await assert.rejects(repo.saveAutomationScheduleAsync({ ...enabledInput, companyId: "foreign" }), /company_scope_forbidden|company_not_found/);
  await assert.rejects(repo.saveAutomationScheduleAsync({ ...enabledInput, schedule: { ...schedule, enabled: true, expectedRevision: 99 } }), /revision_conflict/);

  // Fail only in this disposable DB, after version/automation activation but
  // before the schedule UPDATE. A rollback must remove every intermediate row.
  await db.querySqlAsync(`CREATE FUNCTION fixture_schedule_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.automation_id=${db.sqlValue(created.id)} AND NEW.enabled=1 THEN
      RAISE EXCEPTION 'fixture_schedule_write_failed'; END IF; RETURN NEW; END; $$`);
  await db.querySqlAsync("CREATE TRIGGER fixture_schedule_fail BEFORE UPDATE ON mvp_automation_schedules FOR EACH ROW EXECUTE FUNCTION fixture_schedule_fail()");
  await assert.rejects(repo.saveAutomationScheduleAsync(enabledInput), /fixture_schedule_write_failed/);
  assert.deepEqual(await repo.getAutomationRecordAsync(companyId, created.id), created);
  assert.deepEqual((await repo.listAutomationSchedulesAsync(companyId, created.id))[0], paused);
  assert.equal(await versionCount(), 1);
  assert.equal(await auditCount(), 0);
  await db.querySqlAsync("DROP TRIGGER fixture_schedule_fail ON mvp_automation_schedules");

  const concurrent = await Promise.allSettled([
    repo.saveAutomationScheduleAsync(enabledInput), repo.saveAutomationScheduleAsync(enabledInput)
  ]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);
  const active = (await repo.getAutomationRecordAsync(companyId, created.id))!;
  const saved = (await repo.listAutomationSchedulesAsync(companyId, created.id))[0]!;
  assert.equal(active.status, "active");
  assert.equal(active.revision, 2);
  assert.equal(saved.revision, 2);
  assert.equal(saved.automationVersionId, active.currentVersionId);
  assert.notEqual(saved.automationVersionId, created.currentVersionId);
  assert.deepEqual(active.builderSpec, created.builderSpec);
  assert.equal(await versionCount(), 2);
  assert.equal(await auditCount(), 1);
  assert.deepEqual(await db.querySqlAsync(`SELECT id FROM runs WHERE company_id=${db.sqlValue(companyId)}`), []);

  const beforeDue = await materializeDuePortableAutomationOccurrences({ companyId, serviceUserId: actorUserId,
    now: new Date(Date.parse(dueAt) - 1_000).toISOString() });
  assert.deepEqual(beforeDue.runIds, []);
  const due = await materializeDuePortableAutomationOccurrences({ companyId, serviceUserId: actorUserId, now: dueAt });
  assert.equal(due.runIds.length, 1);
  assert.deepEqual(due.blocked, []);
  const runs = await db.querySqlAsync<{ automation_id: string; automation_version_id: string; metadata_json: string }>(
    `SELECT automation_id, automation_version_id, metadata_json FROM runs WHERE company_id=${db.sqlValue(companyId)}`);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].automation_id, created.id);
  assert.equal(runs[0].automation_version_id, active.currentVersionId);
  const metadata = JSON.parse(runs[0].metadata_json);
  assert.equal(metadata.effect_stage, undefined);
  assert.equal(metadata.portable_worker.external_action_executed, false);
  assert.deepEqual((await materializeDuePortableAutomationOccurrences({ companyId, serviceUserId: actorUserId, now: dueAt })).runIds, []);
  assert.deepEqual(await db.querySqlAsync(`SELECT id FROM durable_jobs WHERE company_id=${db.sqlValue(companyId)}`), []);
});

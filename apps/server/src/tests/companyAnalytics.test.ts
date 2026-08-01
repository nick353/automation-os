import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-company-analytics-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");

const db = await import("../db/client.js");
const contracts = await import("../automations/contracts.js");
const automations = await import("../automations/repository.js");
const queue = await import("../runs/durableQueue.js");
const approvals = await import("../approvals/repository.js");
const analytics = await import("../analytics/companyAnalytics.js");

test("company analytics derives typed metrics, filters, provenance, and explicit unavailable metrics", () => {
  const companyId = "company_analytics";
  const ownerId = "owner_analytics";
  seedCompany(companyId, ownerId);
  const automationA = createAutomation(companyId, ownerId, "Analytics A");
  const automationB = createAutomation(companyId, ownerId, "Analytics B");
  const jobA = queue.enqueueAutomationDryRun({ companyId, actorUserId: ownerId, automationId: automationA.id, idempotencyKey: "analytics-job-a" });
  const jobB = queue.enqueueAutomationDryRun({ companyId, actorUserId: ownerId, automationId: automationB.id, idempotencyKey: "analytics-job-b" });
  const approval = approvals.createBoundApproval({
    companyId,
    requestedByUserId: ownerId,
    jobId: jobA.id,
    title: "Analytics approval",
    actionKind: "publish.post",
    payloadHash: "a".repeat(64),
    policyVersion: "policy-v1",
    expiresAt: "2027-01-01T00:00:00.000Z",
    now: "2026-07-10T00:00:00.000Z"
  });
  approvals.decideBoundApproval({ companyId, approvalId: approval.id, actorUserId: ownerId, decision: "approved", expectedRevision: 1, now: "2026-07-10T00:05:00.000Z" });
  db.execSql(`
    UPDATE durable_jobs SET status='completed', created_at='2026-07-10T00:00:00.000Z', updated_at='2026-07-10T00:02:00.000Z' WHERE id=${db.sqlValue(jobA.id)};
    UPDATE durable_jobs SET status='failed', last_error='authentication_failed', created_at='2026-07-11T00:00:00.000Z', updated_at='2026-07-11T00:03:00.000Z' WHERE id=${db.sqlValue(jobB.id)};
    UPDATE runs SET created_at='2026-07-10T00:00:00.000Z', updated_at='2026-07-10T00:02:00.000Z' WHERE id=${db.sqlValue(jobA.runId)};
    UPDATE runs SET created_at='2026-07-11T00:00:00.000Z', updated_at='2026-07-11T00:03:00.000Z' WHERE id=${db.sqlValue(jobB.runId)};
    INSERT INTO runs (id, company_id, automation_id, name, status, objective, created_at, updated_at, metadata_json)
    VALUES ('legacy_analytics_run', ${db.sqlValue(companyId)}, ${db.sqlValue(automationA.id)}, 'Legacy', 'complete', 'legacy', '2026-07-12T00:00:00.000Z', '2026-07-12T00:01:00.000Z', '{}');
  `);

  const result = analytics.buildCompanyAnalytics({ companyId, from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" });
  assert.equal(result.data_state, "partial");
  assert.equal(result.metrics.outcome.denominator, 2);
  assert.equal(result.metrics.outcome.numerator, 1);
  assert.equal(result.metrics.outcome.completion_rate, 0.5);
  assert.equal(result.metrics.duration.average, 150_000);
  assert.equal(result.metrics.approval_latency.average, 300_000);
  assert.deepEqual(result.metrics.failure_categories.categories, [{ category: "authorization", count: 1 }]);
  assert.equal(result.metrics.cost.availability, "unavailable");
  assert.equal(result.metrics.time_saved.availability, "unavailable");
  assert.equal(result.metrics.sla.availability, "unavailable");
  assert.equal(result.by_date.length, 2);
  assert.equal(result.by_automation.length, 2);
  assert.equal(result.completeness.excluded_legacy_runs, 1);
  assert.equal(result.provenance.find((item) => item.source === "durable_jobs")?.row_count, 2);
  assert.doesNotMatch(JSON.stringify(result), /authentication_failed/);

  const filtered = analytics.buildCompanyAnalytics({ companyId, automationId: automationA.id, from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" });
  assert.equal(filtered.metrics.outcome.denominator, 1);
  assert.equal(filtered.metrics.outcome.numerator, 1);
  assert.equal(filtered.by_automation[0].automation_id, automationA.id);
  assert.equal(filtered.completeness.excluded_legacy_runs, 1);

  const empty = analytics.buildCompanyAnalytics({ companyId, from: "2025-01-01T00:00:00.000Z", to: "2025-02-01T00:00:00.000Z" });
  assert.equal(empty.data_state, "empty");
  assert.equal(empty.metrics.outcome.completion_rate, null);
  assert.equal(empty.last_updated_at, null);
  assert.throws(() => analytics.buildCompanyAnalytics({ companyId, from: "2026-08-01T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z" }), /analytics_range_invalid/);
  assert.throws(() => analytics.buildCompanyAnalytics({ companyId, from: "2024-01-01T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z" }), /analytics_range_too_large/);
});

function seedCompany(companyId: string, ownerId: string) {
  db.initDb();
  const now = db.nowIso();
  db.insert("users", { id: ownerId, auth_provider: "test", auth_subject: ownerId, email: null, display_name: ownerId, kind: "human", status: "active", created_at: now, updated_at: now });
  db.insert("companies", { id: companyId, slug: companyId, name: companyId, status: "active", created_at: now, updated_at: now });
  db.insert("company_memberships", { id: `${companyId}_${ownerId}`, company_id: companyId, user_id: ownerId, role: "owner", status: "active", created_at: now, updated_at: now });
}

function createAutomation(companyId: string, ownerId: string, name: string) {
  return automations.createAutomationRecord({
    companyId,
    actorUserId: ownerId,
    definition: contracts.parseAutomationCreate({ automation_type: "analytics-test", name, description: name, goal: "Measure durable work", lane: "local", risk_level: "low", approval_policy: "required_before_external_action", worker_command_kind: "safe_local_demo", create_approval: true, builder_spec: {} })
  });
}

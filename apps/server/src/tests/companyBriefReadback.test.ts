import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempRoot = mkdtempSync(join(tmpdir(), "aos-company-brief-readback-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.NODE_TEST_CONTEXT = "1";

const db = await import("../db/client.js");
const { buildCompanyBriefReadback, buildCompanyBriefReadbackAsync } = await import("../briefs/companyBriefReadback.js");

db.initDb();
const now = db.nowIso();
db.upsert("companies", { id: "brief-company-a", slug: "brief-company-a", name: "Brief A", status: "active", created_at: now, updated_at: now });
db.upsert("companies", { id: "brief-company-b", slug: "brief-company-b", name: "Brief B", status: "active", created_at: now, updated_at: now });
db.upsert("mvp_automations", {
  id: "brief-automation-a", company_id: "brief-company-a", project_id: "brief-company-a", automation_type: "answer-only",
  name: "A automation", description: "A", desc: "A", goal: "A goal", schedule: "manual", cadence: "manual",
  lane: "local", risk_level: "low", approval_policy: "none", worker_command_kind: "local", create_approval: 0,
  status: "active", builder_spec_json: {}, current_version_id: null, revision: 1, archived_at: null, created_at: now, updated_at: now
});
db.upsert("mvp_automation_schedules", {
  id: "brief-schedule-a", company_id: "brief-company-a", project_id: "brief-company-a", automation_id: "brief-automation-a", automation_version_id: null,
  kind: "daily", expression: "09:00", timezone: "Asia/Tokyo", enabled: 1, status: "active", revision: 1,
  next_run_at: "2026-09-03T00:00:00.000Z", last_run_at: "2026-09-02T00:00:00.000Z", paused_at: null, created_at: now, updated_at: now
});
db.upsert("runs", {
  id: "brief-run-a", company_id: "brief-company-a", automation_id: "brief-automation-a", automation_version_id: null,
  name: "A automation run", status: "complete", objective: "brief test", created_at: "2026-09-02T00:00:00.000Z", updated_at: "2026-09-02T00:05:00.000Z",
  metadata_json: {}, execution_source: "test", quarantined: 0, readback_proof_id: null
});
db.upsert("proofs", {
  id: "brief-proof-a", company_id: "brief-company-a", run_id: "brief-run-a", step_id: null, artifact_id: null,
  attempt_id: null, fencing_token: null, proof_type: "worker_receipt", label: "safe test receipt", uri: "local://brief-proof-a",
  size_bytes: 0, created_at: "2026-09-02T00:05:00.000Z", metadata_json: {}
});
db.upsert("mvp_automations", {
  id: "brief-automation-b", company_id: "brief-company-b", project_id: "brief-company-b", automation_type: "answer-only",
  name: "B automation", description: "B", desc: "B", goal: "B goal", schedule: "manual", cadence: "manual",
  lane: "local", risk_level: "low", approval_policy: "none", worker_command_kind: "local", create_approval: 0,
  status: "active", builder_spec_json: {}, current_version_id: null, revision: 1, archived_at: null, created_at: now, updated_at: now
});
db.upsert("mvp_automations", {
  id: "brief-automation-c", company_id: "brief-company-a", project_id: "brief-company-a", automation_type: "answer-only",
  name: "C blocked automation", description: "C", desc: "C", goal: "C goal", schedule: "manual", cadence: "manual",
  lane: "local", risk_level: "low", approval_policy: "none", worker_command_kind: "local", create_approval: 0,
  status: "active", builder_spec_json: {}, current_version_id: null, revision: 1, archived_at: null, created_at: now, updated_at: now
});
db.upsert("runs", {
  id: "brief-run-c", company_id: "brief-company-a", automation_id: "brief-automation-c", automation_version_id: null,
  name: "C blocked automation run", status: "blocked", objective: "brief blocker test", created_at: "2026-09-02T00:00:00.000Z", updated_at: "2026-09-02T00:06:00.000Z",
  metadata_json: {}, execution_source: "test", quarantined: 0, readback_proof_id: null
});
db.upsert("run_steps", {
  id: "brief-step-c", run_id: "brief-run-c", company_id: "brief-company-a", name: "C step", status: "blocked",
  lane_id: null, started_at: "2026-09-02T00:05:00.000Z", completed_at: "2026-09-02T00:06:00.000Z",
  metadata_json: { exact_blocker: "gmail_provider_read_only_call_not_executed", external_action_executed: false, cleanup_verified: true, readback_verified: false }
});

test("readback is company-scoped and returns a local morning/evening-compatible bundle", async () => {
  const sync = buildCompanyBriefReadback({ companyId: "brief-company-a", briefType: "morning", businessDate: "2026-09-02", timezone: "Asia/Tokyo" });
  const stale = buildCompanyBriefReadback({ companyId: "brief-company-a", briefType: "morning", businessDate: "2026-09-04", timezone: "Asia/Tokyo" });
  const asyncResult = await buildCompanyBriefReadbackAsync({ companyId: "brief-company-a", briefType: "evening", businessDate: "2026-09-02", timezone: "Asia/Tokyo" });
  assert.equal(sync.status, "complete");
  assert.equal(sync.companies.length, 1);
  assert.equal(sync.companies[0]?.company_id, "brief-company-a");
  assert.equal(sync.companies[0]?.items[0]?.record_id, "mvp_automation:brief-automation-a");
  const morningAutomation = sync.companies[0]?.items.find((item) => item.record_id === "mvp_automation:brief-automation-a");
  assert.match(morningAutomation?.summary ?? "", /直近Run=complete/u);
  assert.match(morningAutomation?.summary ?? "", /同一Run proof=1（worker_receipt）/u);
  assert.match(morningAutomation?.summary ?? "", /次回=09:00 Asia\/Tokyo/u);
  assert.match(morningAutomation?.next_action ?? "", /今日の予定時刻/u);
  const staleAutomation = stale.companies[0]?.items.find((item) => item.record_id === "mvp_automation:brief-automation-a");
  assert.match(staleAutomation?.summary ?? "", /過去のため再計算が必要/u);
  assert.match(staleAutomation?.next_action ?? "", /scheduler・queue・worker/u);
  assert.doesNotMatch(JSON.stringify(sync), /Brief B|brief-automation-b/u);
  assert.equal(asyncResult.brief_type, "evening");
  assert.equal(asyncResult.companies[0]?.company_id, "brief-company-a");
  const eveningAutomation = asyncResult.companies[0]?.items.find((item) => item.record_id === "mvp_automation:brief-automation-a");
  assert.match(eveningAutomation?.summary ?? "", /夜確認/u);
  assert.match(eveningAutomation?.next_action ?? "", /次回Run/u);
});

test("brief surfaces the same-run blocker and a blocker-specific next action", () => {
  const result = buildCompanyBriefReadback({ companyId: "brief-company-a", briefType: "evening", businessDate: "2026-09-02", timezone: "Asia/Tokyo" });
  const blocked = result.companies[0]?.items.find((item) => item.record_id === "mvp_automation:brief-automation-c");
  assert.match(blocked?.summary ?? "", /exact blocker=gmail_provider_read_only_call_not_executed/u);
  assert.match(blocked?.next_action ?? "", /Gmail provider canary/u);
  assert.match(blocked?.summary ?? "", /read-only/u);
});

test("Brief never labels a lost business receipt read-only, including legacy false metadata", async () => {
  const originalStep = db.querySql<Record<string, string | number | null>>("SELECT * FROM run_steps WHERE id='brief-step-c'")[0]!;
  const originalRun = db.querySql<Record<string, string | number | null>>("SELECT * FROM runs WHERE id='brief-run-c'")[0]!;
  const input = { companyId: "brief-company-a", briefType: "morning" as const, businessDate: "2026-09-06", timezone: "Asia/Tokyo" };
  try {
    for (const executionMode of ["business_effect", "missing", "read_only"]) {
      const metadata = { exact_blocker: "portable_remote_claim_expired_without_receipt", external_action_executed: false };
      db.upsert("run_steps", { ...originalStep, metadata_json: metadata });
      db.upsert("runs", { ...originalRun, metadata_json: { ...metadata, remote_worker_claim: executionMode === "missing" ? {} : { execution_mode: executionMode } } });
      const result = buildCompanyBriefReadback(input);
      const item = result.companies[0]?.items.find((row) => row.record_id === "mvp_automation:brief-automation-c");
      if (executionMode === "read_only") assert.match(item?.summary ?? "", /read-only/u);
      else {
        assert.match(item?.summary ?? "", /外部結果未確認/u);
        assert.doesNotMatch(item?.summary ?? "", /read-only/u);
      }
      assert.match(item?.next_action ?? "", /同じRun.*再実行・再送しない/u);
      assert.equal((await buildCompanyBriefReadbackAsync(input)).output_fingerprint, result.output_fingerprint);
    }
  } finally {
    db.upsert("run_steps", originalStep);
    db.upsert("runs", originalRun);
  }
});

test("future UTC and American schedules are compared with the Brief business date in its timezone", async () => {
  const original = db.querySql<Record<string, string | number | null>>("SELECT * FROM mvp_automation_schedules WHERE id='brief-schedule-a'")[0]!;
  const input = { companyId: "brief-company-a", briefType: "morning" as const, businessDate: "2026-09-06", timezone: "Asia/Tokyo" };
  try {
    for (const timezone of ["UTC", "America/Los_Angeles"]) {
      db.upsert("mvp_automation_schedules", { ...original, timezone, next_run_at: "2026-09-05T21:05:00.000Z" });
      const current = buildCompanyBriefReadback(input);
      const item = current.companies[0]?.items.find((row) => row.record_id === "mvp_automation:brief-automation-a");
      assert.doesNotMatch(item?.summary ?? "", /過去のため再計算が必要/u, timezone);
      assert.doesNotMatch(item?.next_action ?? "", /scheduler・queue・worker/u, timezone);
      assert.equal((await buildCompanyBriefReadbackAsync(input)).output_fingerprint, current.output_fingerprint);
    }
    db.upsert("mvp_automation_schedules", { ...original, timezone: "UTC", next_run_at: "2026-09-05T14:59:00.000Z" });
    const stale = buildCompanyBriefReadback(input).companies[0]?.items.find((row) => row.record_id === "mvp_automation:brief-automation-a");
    assert.match(stale?.summary ?? "", /過去のため再計算が必要/u);
  } finally {
    db.upsert("mvp_automation_schedules", original);
  }
});

test("Company1 excludes only the requested job display records and does not mutate schedules", async () => {
  const companyId = "company_2560580981cedfd106b66245";
  const jobId = "automation_c304872764579ce2db1c5c90";
  db.upsert("companies", { id: companyId, slug: companyId, name: "Company1", status: "active", created_at: now, updated_at: now });
  const sourceAutomation = db.querySql<Record<string, unknown>>("SELECT * FROM mvp_automations WHERE id='brief-automation-a'")[0]!;
  db.upsert("mvp_automations", { ...sourceAutomation, id: jobId, company_id: companyId, project_id: companyId, name: "Excluded jobs" });
  db.upsert("mvp_automations", { ...sourceAutomation, id: "personal-daily-ai", company_id: companyId, project_id: companyId, name: "Daily AI non-Runway work" });
  const sourceSchedule = db.querySql<Record<string, unknown>>("SELECT * FROM mvp_automation_schedules WHERE id='brief-schedule-a'")[0]!;
  db.upsert("mvp_automation_schedules", { ...sourceSchedule, id: "personal-job-schedule", company_id: companyId, project_id: companyId, automation_id: jobId });
  const before = db.querySql("SELECT * FROM mvp_automation_schedules WHERE id='personal-job-schedule'");
  const input = { companyId, briefType: "evening" as const, businessDate: "2026-09-05", timezone: "Asia/Tokyo" };
  const result = buildCompanyBriefReadback(input);
  assert.equal(result.status, "complete");
  assert.equal(result.counts.scope_excluded_records, 2);
  assert.equal(result.counts.excluded_records, 0);
  assert.match(result.scope_note ?? "", /Runway/u);
  assert.deepEqual(result.companies[0]?.items.map((item) => item.record_id), ["mvp_automation:personal-daily-ai"]);
  assert.deepEqual(db.querySql("SELECT * FROM mvp_automation_schedules WHERE id='personal-job-schedule'"), before);
  assert.equal((await buildCompanyBriefReadbackAsync(input)).output_fingerprint, result.output_fingerprint);
  assert.equal(buildCompanyBriefReadback({ ...input, companyId: "brief-company-a" }).scope_note, undefined);
});

test("archived automations and their schedules stay in history without becoming current Brief work", async () => {
  const companyId = "brief-company-archived";
  db.upsert("companies", { id: companyId, slug: companyId, name: "Archived fixture", status: "active", created_at: now, updated_at: now });
  const automation = db.querySql<Record<string, unknown>>("SELECT * FROM mvp_automations WHERE id='brief-automation-a'")[0]!;
  db.upsert("mvp_automations", { ...automation, id: "archived-test", company_id: companyId, project_id: companyId, status: "archived", archived_at: now });
  db.upsert("mvp_automations", { ...automation, id: "active-test", company_id: companyId, project_id: companyId });
  const schedule = db.querySql<Record<string, unknown>>("SELECT * FROM mvp_automation_schedules WHERE id='brief-schedule-a'")[0]!;
  db.upsert("mvp_automation_schedules", { ...schedule, id: "archived-test-schedule", company_id: companyId, project_id: companyId, automation_id: "archived-test", enabled: 0, status: "paused" });
  const before = db.querySql("SELECT * FROM mvp_automations WHERE company_id='brief-company-archived' ORDER BY id");
  const input = { companyId, briefType: "evening" as const, businessDate: "2026-09-05", timezone: "Asia/Tokyo" };
  const result = buildCompanyBriefReadback(input);
  assert.equal(result.status, "complete");
  assert.equal(result.counts.excluded_records, 0);
  assert.equal(result.counts.scope_excluded_records, 2);
  assert.deepEqual(result.companies[0]?.items.map((item) => item.record_id), ["mvp_automation:active-test"]);
  assert.match(JSON.stringify(result.scope_exclusions), /archived_automation_history/u);
  assert.deepEqual(db.querySql("SELECT * FROM mvp_automations WHERE company_id='brief-company-archived' ORDER BY id"), before);
  assert.equal((await buildCompanyBriefReadbackAsync(input)).output_fingerprint, result.output_fingerprint);
});

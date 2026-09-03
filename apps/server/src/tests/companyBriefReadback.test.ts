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

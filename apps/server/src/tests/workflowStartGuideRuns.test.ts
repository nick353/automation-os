import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-guide-runs-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.NODE_TEST_CONTEXT = "1";
process.env.AUTOMATION_OS_OWNER_USER_ID = "guide-runs-owner";

const { getMvpStateReadback } = await import("../index.js");
const { execSql, initDb, insert, resetDemoData } = await import("../db/client.js");

test("workflowStartGuideRuns is complete, company-scoped, and separate from the bounded general runs list", () => {
  initDb();
  resetDemoData();
  const now = new Date().toISOString();
  const companyId = "guide-runs-company";
  const foreignCompanyId = "guide-runs-foreign";
  for (const id of [companyId, foreignCompanyId]) {
    insert("users", {
      id: `${id}-user`, auth_provider: "test", auth_subject: `${id}-subject`,
      display_name: id, created_at: now, updated_at: now
    });
    insert("companies", { id, slug: id, name: id, created_at: now, updated_at: now });
    insert("company_memberships", {
      id: `${id}-membership`, company_id: id, user_id: `${id}-user`, role: "owner",
      status: "active", created_at: now, updated_at: now
    });
  }
  insert("mvp_automations", {
    id: "guide-automation", company_id: companyId, project_id: companyId,
    automation_type: "custom", name: "Guide automation", description: "", desc: "", goal: "",
    schedule: "manual", cadence: "manual", lane: "Lane 1", risk_level: "low",
    approval_policy: "none", worker_command_kind: "safe_local_demo", create_approval: 0,
    status: "active", builder_spec_json: { canonicalWorkflowId: "daily-backup-safety-check" },
    revision: 1, created_at: now, updated_at: now
  });
  const runs = [
    {
      id: "guide-newer-running", company_id: companyId, automation_id: "guide-automation",
      name: "newer", status: "running", objective: "newer", created_at: "2026-09-09T02:00:00.000Z",
      updated_at: "2026-09-09T02:00:00.000Z", metadata_json: { workflow_id: "daily-backup-safety-check", token: "must-not-leak" }
    },
    {
      id: "guide-older-complete", company_id: companyId, automation_id: "guide-automation",
      name: "older", status: "complete", objective: "older", created_at: "2026-09-09T01:00:00.000Z",
      updated_at: "2026-09-09T01:00:00.000Z", metadata_json: { workflow_id: "daily-backup-safety-check" }
    },
    {
      id: "guide-foreign", company_id: foreignCompanyId, automation_id: "guide-automation",
      name: "foreign", status: "complete", objective: "foreign", created_at: "2026-09-09T03:00:00.000Z",
      updated_at: "2026-09-09T03:00:00.000Z", metadata_json: { workflow_id: "daily-backup-safety-check" }
    },
    {
      id: "unrelated", company_id: companyId, automation_id: "other", name: "other", status: "complete",
      objective: "other", created_at: "2026-09-09T04:00:00.000Z", updated_at: "2026-09-09T04:00:00.000Z",
      metadata_json: { workflow_id: "not-a-guide-workflow" }
    }
  ];
  for (const run of runs) insert("runs", run);
  // Keep the valid guide candidates outside the general dashboard window.
  for (let index = 0; index < 510; index += 1) {
    const timestamp = `2026-09-10T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`;
    insert("runs", {
      id: `dashboard-noise-${index}`,
      company_id: companyId,
      automation_id: "other",
      name: "dashboard noise",
      status: "complete",
      objective: "unrelated",
      created_at: timestamp,
      updated_at: timestamp,
      metadata_json: { workflow_id: "not-a-guide-workflow" }
    });
  }
  execSql("PRAGMA wal_checkpoint(TRUNCATE)");
  process.env.AUTOMATION_OS_OWNER_USER_ID = `${companyId}-user`;

  const state = getMvpStateReadback([companyId]) as {
    runs: Array<Record<string, unknown>>;
    workflowStartGuideRuns: Array<Record<string, unknown>>;
  };
  assert.equal(state.runs.length, 500);
  assert.equal(state.runs.some((run) => run.id === "guide-newer-running" || run.id === "guide-older-complete"), false);
  assert.deepEqual(state.workflowStartGuideRuns.map((run) => run.id).sort(), ["guide-newer-running", "guide-older-complete"]);
  assert.ok(state.workflowStartGuideRuns.every((run) => run.company_id === companyId));
  assert.equal(JSON.parse(String(state.workflowStartGuideRuns[0].metadata_json)).token, undefined);
});

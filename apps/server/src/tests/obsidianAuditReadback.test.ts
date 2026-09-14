import assert from "node:assert/strict";
import test from "node:test";
import { buildObsidianAuditReadback } from "../runs/portableLocalWorkflow.js";
import type { ProjectAuditResult } from "../projects/projectAuditor.js";

function fixture(count = 10): ProjectAuditResult {
  return {
    ok: true, generatedAt: "2026-09-06T00:00:00.000Z", registryPath: "/private/registry.json",
    summary: { projects: count, ok: count - 5, attention: 5, blocked: 0, safeAutoFixes: 0, approvalRequired: 0, humanOnly: 0 },
    policy: { default_surface: "read_only", safe_auto_fix: [], approval_required_fix: [], human_only: [] },
    projects: Array.from({ length: count }, (_, i) => ({
      project: { id: `project-${i}`, label: `Project ${i}`, root: `/private/project-${i}` },
      status: i < 5 ? "attention" : "ok", stateMtime: "2026-08-01T00:00:00.000Z",
      authority: [{ path: "/private/STATE.md", exists: true, mtime: "2026-08-01T00:00:00.000Z" }],
      artifacts: [{ path: "/private/artifacts", exists: true, latest: "/private/raw-secret-filename", latestMtime: "2026-09-01T00:00:00.000Z" }],
      issues: i < 5 ? [{ severity: "warning", code: "state_stale", message: "newer activity /private/raw-secret-filename" }] : [],
      safeFixes: [], approvalRequired: [], humanOnly: [], nextAction: "source-owned instruction"
    }))
  } as unknown as ProjectAuditResult;
}

test("Obsidian audit preserves the ten project findings as bound read-only rows without copying private source contents", () => {
  const result = buildObsidianAuditReadback(fixture(), { runId: "run-1", companyId: "company-1" });
  assert.equal(result.audit_run_id, "run-1");
  assert.equal(result.audit_company_id, "company-1");
  assert.equal(result.audit_projects.length, 10);
  assert.equal(result.audit_projects_truncated, false);
  assert.equal(result.audit_projects.filter((row) => row.status === "attention").length, 5);
  assert.equal(result.audit_projects[0].latest_activity_at, "2026-09-01T00:00:00.000Z");
  assert.match(result.audit_projects[0].finding, /STATE.mdより新しい活動/);
  assert.match(result.audit_projects[0].next_action, /最新成果物とSTATE.mdを照合/);
  assert.equal(result.write_performed, false);
  assert.equal(result.maintenance_performed, false);
  assert.equal(result.git_sync_performed, false);
  assert.doesNotMatch(JSON.stringify(result), /private|raw-secret-filename|source-owned instruction/);
});

test("large Obsidian registries keep full counts and explicitly bound the displayed table", () => {
  const result = buildObsidianAuditReadback(fixture(25), { runId: "run-1", companyId: "company-1" });
  assert.equal(result.audit_summary.projects, 25);
  assert.equal(result.audit_projects.length, 20);
  assert.equal(result.audit_projects_truncated, true);
  assert.equal(result.audit_projects.filter((row) => row.status === "attention").length, 5);
});

test("Obsidian receipt text is bounded and redacted; missing run scope is not invented", () => {
  const source = fixture();
  source.projects[0].project.label = "label".repeat(200);
  source.projects[0].issues = [{ severity: "warning", code: "future_issue", message: "Bearer test-token-1234567890 " + "x".repeat(2000) }];
  const result = buildObsidianAuditReadback(source, {});
  const row = result.audit_projects.find((item) => item.project_id === "project-0")!;
  assert.equal(row.project_label.length, 160);
  assert.ok(row.finding.length <= 900);
  assert.doesNotMatch(row.finding, /test-token-1234567890/);
  assert.equal(result.audit_run_id, null);
  assert.equal(result.audit_company_id, null);
});

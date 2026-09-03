import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("company binding CLI emits a stable read-only diagnostic and redacts registered prompts", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "aos-company-binding-readiness-"));
  const databasePath = join(fixtureRoot, "fixture.sqlite");
  const automationRoot = join(fixtureRoot, "automations");
  const automationDir = join(automationRoot, "fixture-automation");
  const db = new Database(databasePath);
    db.exec(readFileSync(join(root, "apps", "server", "src", "db", "schema.sql"), "utf8"));
    db.prepare("INSERT INTO companies (id, slug, name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
      .run("fixture-company", "fixture-company", "Fixture Company", "2026-09-03T00:00:00.000Z", "2026-09-03T00:00:00.000Z");
    db.prepare(`
      INSERT INTO mvp_automations (
        id, company_id, project_id, automation_type, name, description, desc, goal, schedule, cadence,
        lane, risk_level, approval_policy, worker_command_kind, create_approval, status,
        builder_spec_json, current_version_id, revision, archived_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, 'daily', 'local', 'low', 'required_before_external_action',
        'safe_local_demo', 0, 'active', '{}', NULL, 1, NULL, ?, ?)
    `).run(
      "fixture-automation",
      "fixture-company",
      "fixture-company",
      "Fixture automation",
      "fixture description",
      "fixture description",
      "fixture goal",
      "09:00",
      "2026-09-03T00:00:00.000Z",
      "2026-09-03T00:00:00.000Z"
    );
    db.prepare(`
      INSERT INTO mvp_automation_schedules (
        id, company_id, project_id, automation_id, automation_version_id, kind, expression, timezone,
        enabled, status, revision, next_run_at, last_run_at, paused_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, 'daily', '09:00', 'Asia/Tokyo', 1, 'active', 1, ?, NULL, NULL, ?, ?)
    `).run(
      "fixture-schedule",
      "fixture-company",
      "fixture-company",
      "fixture-automation",
      "2026-09-04T00:00:00.000Z",
      "2026-09-03T00:00:00.000Z",
      "2026-09-03T00:00:00.000Z"
    );
  db.close();

  mkdirSync(automationDir, { recursive: true });
  writeFileSync(join(automationDir, "automation.toml"), [
    'id = "fixture-automation"',
    'rrule = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0"',
    'prompt = "private-prompt-marker --company fixture-company --automation fixture-automation"',
    'status = "ACTIVE"'
  ].join("\n"), { flag: "w" });

  try {
    const completed = spawnSync(process.execPath, [join(root, "scripts", "aos-company-binding-readiness.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        AUTOMATION_OS_REPO_ROOT: root,
        AUTOMATION_OS_DB: databasePath,
        CODEX_AUTOMATIONS_ROOT: automationRoot,
        AOS_TRIGGER_PARITY_COMPANY_ID: "fixture-company",
        AOS_COMPANY_BINDING_READINESS_NOW: "2026-09-03T00:00:00.000Z"
      }
    });
    const output = completed.stdout;
    const result = JSON.parse(output);
    assert.equal(completed.status, 2, output);
    assert.equal(result.schema, "company_binding_readiness.v1", output);
    assert.equal(result.status, "blocked", output);
    assert.equal(result.production_ready, false, output);
    assert.equal(result.scope.status, "canonical_unselected", output);
    assert.equal(result.schedules.length, 1, output);
    assert.equal(result.schedules[0].materialization_decision, "blocked", output);
    assert.ok(result.schedules[0].exact_blockers.includes("protected_aos_company_and_endpoint_not_owner_selected"), output);
    assert.equal(result.database.integrity, "ok", output);
    assert.equal(result.database.stable, true, output);
    assert.equal(result.external_effects.external_action_executed, false, output);
    assert.equal(result.external_effects.graph_receipt_replayed, false, output);
    assert.equal(result.company_binding_reconciliation.schema, "company_binding_reconciliation.v1", output);
    assert.equal(result.company_binding_reconciliation.canonical_company_id, null, output);
    assert.equal(result.company_binding_reconciliation.selection.selected, false, output);
    assert.equal(result.company_binding_reconciliation.candidates.length, 1, output);
    assert.equal(result.company_binding_reconciliation.exact_blocker, "canonical_company_unresolved", output);
    assert.equal(result.canonical_company_consultation.schema, "canonical_company_consultation.v1", output);
    assert.equal(result.canonical_company_consultation.selection_state, "unresolved", output);
    assert.equal(result.canonical_company_consultation.canonical_company_id, null, output);
    assert.equal(result.canonical_company_consultation.owner_decision.required, true, output);
    assert.equal(result.canonical_company_consultation.owner_decision.recommended_candidate_company_id, null, output);
    assert.equal(result.canonical_company_consultation.downstream.provider_receipt.status, "not_attempted", output);
    assert.equal(result.canonical_company_consultation.external_action_executed, false, output);
    assert.doesNotMatch(output, /private-prompt-marker/u);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

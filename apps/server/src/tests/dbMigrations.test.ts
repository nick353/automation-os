import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-db-migrations-"));
const legacyDbPath = join(tempRoot, "automation-os.sqlite");
process.env.AUTOMATION_OS_DB = legacyDbPath;

const db = await import("../db/client.js");

test("initDb adds Browser Use lane columns to an existing lanes table", () => {
  mkdirSync(dirname(legacyDbPath), { recursive: true });
  const legacySchema = `
    CREATE TABLE companies (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO companies (id, slug, name, status, created_at, updated_at)
    VALUES ('company_legacy', 'company-legacy', 'Company Legacy', 'active', '2026-06-11T00:00:00.000Z', '2026-06-11T00:00:00.000Z');

    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      objective TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    INSERT INTO runs (id, name, status, objective, created_at, updated_at, metadata_json)
    VALUES ('run_legacy', 'Legacy Run', 'queued', 'legacy objective', '2026-06-11T00:00:00.000Z', '2026-06-11T00:00:00.000Z', '{}');

    CREATE TABLE approvals (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      title TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      approval_group_id TEXT NOT NULL,
      resource_locks_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      decided_at TEXT,
      decision_note TEXT
    );
    INSERT INTO approvals (id, run_id, title, requested_by, status, priority, approval_group_id, resource_locks_json, created_at, decided_at, decision_note)
    VALUES ('approval_legacy', 'run_legacy', 'Legacy Approval', 'operator', 'pending', 'normal', 'group-legacy', '[]', '2026-06-11T00:00:00.000Z', NULL, NULL);

    CREATE TABLE proofs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      step_id TEXT,
      proof_type TEXT NOT NULL,
      label TEXT NOT NULL,
      uri TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );
    INSERT INTO proofs (id, run_id, step_id, proof_type, label, uri, size_bytes, created_at, metadata_json)
    VALUES ('proof_legacy', 'run_legacy', NULL, 'worker_receipt', 'Legacy Proof', 'file:///legacy-proof', 0, '2026-06-11T00:00:00.000Z', '{}');

    CREATE TABLE registered_workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      runner_status TEXT NOT NULL,
      runner_kind TEXT NOT NULL,
      project_root TEXT NOT NULL,
      start_command_json TEXT NOT NULL DEFAULT '{}',
      schedule_json TEXT NOT NULL DEFAULT '{}',
      source_refs_json TEXT NOT NULL DEFAULT '[]',
      provenance_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO registered_workflows (id, name, status, runner_status, runner_kind, project_root, start_command_json, schedule_json, source_refs_json, provenance_json, created_at, updated_at)
    VALUES ('workflow_legacy', 'Legacy Workflow', 'active', 'ready', 'worker', '/tmp/workflow-legacy', '{}', '{}', '[]', '{}', '2026-06-11T00:00:00.000Z', '2026-06-11T00:00:00.000Z');

    CREATE TABLE research_plans (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      command TEXT NOT NULL,
      sources_json TEXT NOT NULL DEFAULT '[]',
      visible_flow_json TEXT NOT NULL DEFAULT '[]',
      source_of_truth_json TEXT NOT NULL DEFAULT '[]',
      proof_boundary_json TEXT NOT NULL DEFAULT '[]',
      approval_boundary_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      demo_check_id TEXT,
      run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO research_plans (id, title, status, command, sources_json, visible_flow_json, source_of_truth_json, proof_boundary_json, approval_boundary_json, metadata_json, demo_check_id, run_id, created_at, updated_at)
    VALUES ('research_plan_legacy', 'Legacy', 'planned', 'legacy command', '[]', '[]', '[]', '[]', '[]', '{}', NULL, 'run_legacy', '2026-06-11T00:00:00.000Z', '2026-06-11T00:00:00.000Z');

    CREATE TABLE skills (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      name TEXT NOT NULL,
      draft_markdown TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO skills (id, run_id, name, draft_markdown, created_at)
    VALUES ('skill_legacy', 'run_legacy', 'Legacy Skill', '# legacy', '2026-06-11T00:00:00.000Z');

    CREATE TABLE lanes (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      role TEXT NOT NULL,
      cdp_port INTEGER NOT NULL,
      profile_dir TEXT NOT NULL,
      workdir TEXT NOT NULL,
      status TEXT NOT NULL,
      current_task TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      health TEXT NOT NULL DEFAULT 'good',
      resource_locks_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );
    INSERT INTO lanes (id, run_id, role, cdp_port, profile_dir, workdir, status, current_task, progress, health, resource_locks_json, updated_at)
    VALUES ('lane_legacy', 'run_legacy', 'browser', 9333, '/tmp/profile', '/tmp/workdir', 'active', 'legacy', 10, 'good', '[]', '2026-06-11T00:00:00.000Z');

    CREATE TABLE mvp_automations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      automation_type TEXT NOT NULL,
      name TEXT NOT NULL,
      desc TEXT NOT NULL,
      goal TEXT NOT NULL,
      schedule TEXT NOT NULL,
      cadence TEXT NOT NULL,
      lane TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      approval_policy TEXT NOT NULL,
      worker_command_kind TEXT NOT NULL,
      create_approval INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'draft',
      builder_spec_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO mvp_automations (id, project_id, automation_type, name, desc, goal, schedule, cadence, lane, risk_level, approval_policy, worker_command_kind, create_approval, status, builder_spec_json, created_at, updated_at)
    VALUES ('legacy_automation', 'legacy-company', 'test', 'Legacy', 'legacy description', '', '09:00', 'daily', 'Lane 1', 'low', 'manual', 'none', 0, 'draft', '{}', '2026-06-11T00:00:00.000Z', '2026-06-11T00:00:00.000Z');
  `;
  const created = spawnSync("sqlite3", [legacyDbPath], { input: legacySchema, encoding: "utf8" });
  assert.equal(created.status, 0, created.stderr);

  db.initDb();
  db.initDb();

  const columns = db.querySql<{ name: string }>("PRAGMA table_info(lanes)").map((row) => row.name);
  assert.ok(columns.includes("browser_use_session"));
  assert.ok(columns.includes("browser_use_cdp_url"));
  assert.ok(columns.includes("browser_use_profile"));
  assert.ok(columns.includes("profile_strategy"));
  assert.ok(columns.includes("lane_visibility"));

  const legacyLane = db.querySql<{ profile_strategy: string; lane_visibility: string }>("SELECT profile_strategy, lane_visibility FROM lanes WHERE id='lane_legacy'")[0];
  assert.equal(legacyLane.profile_strategy, "cdp_profile_lane");
  assert.equal(legacyLane.lane_visibility, "visible");

  const childColumns = db.querySql<{ name: string }>("PRAGMA table_info(child_runs)").map((row) => row.name);
  assert.ok(childColumns.includes("parent_run_id"));
  assert.ok(childColumns.includes("step_id"));
  assert.ok(childColumns.includes("prompt_uri"));
  assert.ok(childColumns.includes("result_uri"));
  assert.ok(childColumns.includes("metadata_json"));

  const childIndexes = db.querySql<{ name: string }>("PRAGMA index_list(child_runs)").map((row) => row.name);
  assert.ok(childIndexes.includes("idx_child_runs_parent"));
  assert.ok(childIndexes.includes("idx_child_runs_step"));

  const companyTables = db.querySql<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','companies','company_memberships','company_audit_events') ORDER BY name");
  assert.deepEqual(companyTables.map((row) => row.name), ["companies", "company_audit_events", "company_memberships", "users"]);

  const tenancyColumns = {
    runs: db.querySql<{ name: string }>("PRAGMA table_info(runs)").map((row) => row.name),
    approvals: db.querySql<{ name: string }>("PRAGMA table_info(approvals)").map((row) => row.name),
    proofs: db.querySql<{ name: string }>("PRAGMA table_info(proofs)").map((row) => row.name),
    registeredWorkflows: db.querySql<{ name: string }>("PRAGMA table_info(registered_workflows)").map((row) => row.name),
    researchPlans: db.querySql<{ name: string }>("PRAGMA table_info(research_plans)").map((row) => row.name),
    skills: db.querySql<{ name: string }>("PRAGMA table_info(skills)").map((row) => row.name)
  };
  assert.ok(tenancyColumns.runs.includes("company_id"));
  assert.ok(tenancyColumns.approvals.includes("company_id"));
  assert.ok(tenancyColumns.approvals.includes("job_id"));
  assert.ok(tenancyColumns.proofs.includes("company_id"));
  assert.ok(tenancyColumns.registeredWorkflows.includes("company_id"));
  assert.ok(tenancyColumns.researchPlans.includes("company_id"));
  assert.ok(tenancyColumns.skills.includes("company_id"));

  const tenancyIndexes = {
    runs: db.querySql<{ name: string }>("PRAGMA index_list(runs)").map((row) => row.name),
    approvals: db.querySql<{ name: string }>("PRAGMA index_list(approvals)").map((row) => row.name),
    proofs: db.querySql<{ name: string }>("PRAGMA index_list(proofs)").map((row) => row.name),
    registeredWorkflows: db.querySql<{ name: string }>("PRAGMA index_list(registered_workflows)").map((row) => row.name),
    researchPlans: db.querySql<{ name: string }>("PRAGMA index_list(research_plans)").map((row) => row.name),
    skills: db.querySql<{ name: string }>("PRAGMA index_list(skills)").map((row) => row.name)
  };
  assert.ok(tenancyIndexes.runs.includes("idx_runs_company"));
  assert.ok(tenancyIndexes.approvals.includes("idx_approvals_company_status"));
  assert.ok(tenancyIndexes.approvals.includes("idx_approvals_bound_action"));
  assert.ok(tenancyIndexes.proofs.includes("idx_proofs_company_run"));
  assert.ok(tenancyIndexes.registeredWorkflows.includes("idx_registered_workflows_company"));
  assert.ok(tenancyIndexes.researchPlans.includes("idx_research_plans_company"));
  assert.ok(tenancyIndexes.skills.includes("idx_skills_company"));

  const legacyTenancyRows = {
    run: db.querySql<{ company_id: string | null }>("SELECT company_id FROM runs WHERE id='run_legacy'")[0],
    approval: db.querySql<{ company_id: string | null }>("SELECT company_id FROM approvals WHERE id='approval_legacy'")[0],
    proof: db.querySql<{ company_id: string | null }>("SELECT company_id FROM proofs WHERE id='proof_legacy'")[0],
    workflow: db.querySql<{ company_id: string | null }>("SELECT company_id FROM registered_workflows WHERE id='workflow_legacy'")[0],
    researchPlan: db.querySql<{ company_id: string | null }>("SELECT company_id FROM research_plans WHERE id='research_plan_legacy'")[0],
    skill: db.querySql<{ company_id: string | null }>("SELECT company_id FROM skills WHERE id='skill_legacy'")[0]
  };
  assert.equal(legacyTenancyRows.run?.company_id, null);
  assert.equal(legacyTenancyRows.approval?.company_id, null);
  assert.equal(legacyTenancyRows.proof?.company_id, null);
  assert.equal(legacyTenancyRows.workflow?.company_id, null);
  assert.equal(legacyTenancyRows.researchPlan?.company_id, null);
  assert.equal(legacyTenancyRows.skill?.company_id, null);

  const automationColumns = db.querySql<{ name: string }>("PRAGMA table_info(mvp_automations)").map((row) => row.name);
  assert.ok(automationColumns.includes("company_id"));
  assert.ok(automationColumns.includes("description"));
  assert.ok(automationColumns.includes("current_version_id"));
  assert.ok(automationColumns.includes("revision"));
  assert.ok(automationColumns.includes("archived_at"));
  const runColumns = db.querySql<{ name: string }>("PRAGMA table_info(runs)").map((row) => row.name);
  assert.ok(runColumns.includes("automation_id"));
  assert.ok(runColumns.includes("automation_version_id"));
  const versionColumns = db.querySql<{ name: string }>("PRAGMA table_info(mvp_automation_versions)").map((row) => row.name);
  assert.ok(versionColumns.includes("automation_id"));
  assert.ok(versionColumns.includes("revision"));
  const scheduleColumns = db.querySql<{ name: string }>("PRAGMA table_info(mvp_automation_schedules)").map((row) => row.name);
  assert.ok(scheduleColumns.includes("automation_id"));
  assert.ok(scheduleColumns.includes("automation_version_id"));
  const durableScheduleColumns = db.querySql<{ name: string }>("PRAGMA table_info(durable_schedule_occurrences)").map((row) => row.name);
  assert.ok(durableScheduleColumns.includes("schedule_id"));
  assert.ok(durableScheduleColumns.includes("occurrence_key"));
  assert.ok(durableScheduleColumns.includes("job_id"));
  const durableConcurrencyColumns = db.querySql<{ name: string }>("PRAGMA table_info(durable_concurrency_slots)").map((row) => row.name);
  assert.ok(durableConcurrencyColumns.includes("concurrency_key"));
  assert.ok(durableConcurrencyColumns.includes("slot_limit"));
  assert.ok(durableConcurrencyColumns.includes("active_count"));
  const durableJobColumns = db.querySql<{ name: string }>("PRAGMA table_info(durable_jobs)").map((row) => row.name);
  assert.ok(durableJobColumns.includes("run_id"));
  assert.ok(durableJobColumns.includes("automation_version_id"));
  assert.ok(durableJobColumns.includes("concurrency_key"));
  assert.ok(durableJobColumns.includes("fencing_token"));
  const durableAttemptColumns = db.querySql<{ name: string }>("PRAGMA table_info(durable_job_attempts)").map((row) => row.name);
  assert.ok(durableAttemptColumns.includes("job_id"));
  assert.ok(durableAttemptColumns.includes("attempt_no"));
  assert.ok(durableAttemptColumns.includes("service_user_id"));
  assert.ok(durableAttemptColumns.includes("fencing_token"));
  const artifactColumns = db.querySql<{ name: string }>("PRAGMA table_info(run_artifacts)").map((row) => row.name);
  assert.ok(artifactColumns.includes("run_id"));
  assert.ok(artifactColumns.includes("step_id"));
  assert.ok(artifactColumns.includes("attempt_id"));
  assert.ok(artifactColumns.includes("mime_type"));
  assert.ok(artifactColumns.includes("checksum_sha256"));
  assert.ok(artifactColumns.includes("status"));
  assert.ok(artifactColumns.includes("content_text"));
  const idempotencyColumns = db.querySql<{ name: string }>("PRAGMA table_info(mvp_idempotency_keys)").map((row) => row.name);
  assert.ok(idempotencyColumns.includes("idempotency_key"));
  assert.ok(idempotencyColumns.includes("request_hash"));
  const memoryColumns = db.querySql<{ name: string }>("PRAGMA table_info(company_memory_entries)").map((row) => row.name);
  assert.ok(memoryColumns.includes("memory_key"));
  assert.ok(memoryColumns.includes("revision"));
  const connectionColumns = db.querySql<{ name: string }>("PRAGMA table_info(company_connection_account_refs)").map((row) => row.name);
  assert.ok(connectionColumns.includes("platform"));
  assert.ok(connectionColumns.includes("account_ref"));
  assert.ok(connectionColumns.includes("oauth_state"));
  assert.ok(connectionColumns.includes("verification_status"));
  assert.ok(connectionColumns.includes("last_verified_at"));
  assert.ok(connectionColumns.includes("reconnect_requested_at"));
  assert.ok(connectionColumns.includes("revoked_at"));
  const feedbackColumns = db.querySql<{ name: string }>("PRAGMA table_info(mvp_feedback)").map((row) => row.name);
  assert.ok(feedbackColumns.includes("screenshot_artifact_id"));
  const feedbackArtifactColumns = db.querySql<{ name: string }>("PRAGMA table_info(feedback_artifacts)").map((row) => row.name);
  assert.ok(feedbackArtifactColumns.includes("company_id"));
  assert.ok(feedbackArtifactColumns.includes("checksum_sha256"));
  assert.ok(feedbackArtifactColumns.includes("content_base64"));
  const effectLedgerColumns = db.querySql<{ name: string }>("PRAGMA table_info(service_readiness_effect_ledger)").map((row) => row.name);
  assert.ok(effectLedgerColumns.includes("effect_key"));
  assert.ok(effectLedgerColumns.includes("root_id"));
  assert.ok(effectLedgerColumns.includes("fencing_token"));
  assert.ok(effectLedgerColumns.includes("provider_receipt_hash"));
  assert.ok(effectLedgerColumns.includes("cleanup_receipt_hash"));
  assert.ok(effectLedgerColumns.includes("capability_id"));
  assert.ok(effectLedgerColumns.includes("approval_id"));
  assert.ok(effectLedgerColumns.includes("approval_revision"));
  const effectLedgerIndexes = db.querySql<{ name: string }>("PRAGMA index_list(service_readiness_effect_ledger)").map((row) => row.name);
  assert.ok(effectLedgerIndexes.includes("service_readiness_effect_ledger_binding_idx"));
  assert.ok(effectLedgerIndexes.includes("service_readiness_effect_ledger_status_idx"));
  assert.ok(effectLedgerIndexes.includes("service_readiness_effect_ledger_company_capability_idx"));
  const legacyAutomation = db.querySql<{ company_id: string; description: string }>("SELECT company_id, description FROM mvp_automations WHERE id='legacy_automation'")[0];
  assert.deepEqual(legacyAutomation, { company_id: "", description: "legacy description" });
  const automationVersion = db.querySql<{ id: string; company_id: string; project_id: string; automation_id: string; revision: number }>(
    "SELECT id, company_id, project_id, automation_id, revision FROM mvp_automation_versions WHERE automation_id='legacy_automation' AND revision=1"
  )[0];
  assert.deepEqual(automationVersion, {
    id: "mvpav_legacy_automation_v1",
    company_id: "",
    project_id: "legacy-company",
    automation_id: "legacy_automation",
    revision: 1
  });
  const currentAutomation = db.querySql<{ current_version_id: string | null; revision: number }>(
    "SELECT current_version_id, revision FROM mvp_automations WHERE id='legacy_automation'"
  )[0];
  assert.deepEqual(currentAutomation, { current_version_id: "mvpav_legacy_automation_v1", revision: 1 });
  const versionCountBefore = db.querySql<{ count: number }>("SELECT count(*) AS count FROM mvp_automation_versions WHERE automation_id='legacy_automation'")[0].count;
  assert.equal(versionCountBefore, 1);
  assert.equal(db.querySql<{ count: number }>("SELECT count(*) AS count FROM durable_schedule_occurrences")[0].count, 0);
  assert.equal(db.querySql<{ count: number }>("SELECT count(*) AS count FROM durable_concurrency_slots")[0].count, 0);
  assert.equal(db.querySql<{ count: number }>("SELECT count(*) AS count FROM durable_jobs")[0].count, 0);
  assert.equal(db.querySql<{ count: number }>("SELECT count(*) AS count FROM durable_job_attempts")[0].count, 0);
  assert.equal(db.querySql<{ count: number }>("SELECT count(*) AS count FROM run_artifacts")[0].count, 0);
});

test("PostgreSQL copy migration reconciles old target columns before applying current indexes and copying rows", () => {
  const source = readFileSync(resolve(process.cwd(), "scripts", "migrateSqliteToPostgres.mjs"), "utf8");
  const reconcileAt = source.indexOf("await reconcileExistingTargetColumns(table)");
  const schemaAt = source.indexOf("await client.query(schema)");
  const copyAt = source.indexOf("const copied = []");
  assert.ok(reconcileAt >= 0, "expected target-column reconciliation");
  assert.ok(schemaAt > reconcileAt, "current indexes must be applied after missing columns exist");
  assert.ok(copyAt > schemaAt, "row copy must happen after schema reconciliation");
  assert.match(source, /information_schema\.columns/);
  assert.match(source, /ALTER TABLE .* ADD COLUMN/);
});

test("initDb migrates an existing effect ledger before creating capability indexes", () => {
  db.execSql(`
    DROP TABLE IF EXISTS service_readiness_effect_ledger;
    CREATE TABLE service_readiness_effect_ledger (
      effect_key TEXT PRIMARY KEY CHECK (length(effect_key) = 64),
      root_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      stage_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      fencing_token INTEGER NOT NULL CHECK (fencing_token >= 0),
      provider TEXT NOT NULL,
      account_ref TEXT NOT NULL,
      target_hash TEXT NOT NULL CHECK (length(target_hash) = 64),
      payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
      effect_class TEXT NOT NULL CHECK (effect_class IN ('internal_idempotent', 'external_non_idempotent')),
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'blocked', 'reconciliation_required', 'cancelled')),
      external_action_executed INTEGER NOT NULL CHECK (external_action_executed IN (0, 1)),
      provider_receipt_hash TEXT,
      cleanup_receipt_hash TEXT,
      exact_blocker TEXT,
      safe_resume_step TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminal_at TEXT,
      company_id TEXT NOT NULL DEFAULT 'legacy',
      reservation_id TEXT NOT NULL DEFAULT '',
      reservation_token_hash TEXT
    );
  `);
  db.initDb();
  const columns = db.querySql<{ name: string }>("PRAGMA table_info(service_readiness_effect_ledger)").map((row) => row.name);
  assert.ok(columns.includes("capability_id"));
  assert.ok(columns.includes("approval_id"));
  assert.ok(columns.includes("approval_revision"));
  const indexes = db.querySql<{ name: string }>("PRAGMA index_list(service_readiness_effect_ledger)").map((row) => row.name);
  assert.ok(indexes.includes("service_readiness_effect_ledger_company_capability_idx"));
});

test("migrateSqliteToPostgres preserves dependency order for automation and tenant tables", () => {
  const script = readFileSync(resolve(process.cwd(), "scripts/migrateSqliteToPostgres.mjs"), "utf8");
  const orderedTables = [
    "mvp_automations",
    "mvp_automation_versions",
    "mvp_automation_schedules",
    "durable_schedule_occurrences",
    "durable_concurrency_slots",
    "durable_jobs",
    "durable_job_attempts",
    "run_artifacts",
    "service_readiness_effect_ledger",
    "feedback_artifacts",
    "mvp_idempotency_keys",
    "company_memory_entries",
    "company_connection_account_refs"
  ];
  let lastIndex = -1;
  for (const table of orderedTables) {
    const index = script.indexOf(`\"${table}\"`);
    assert.ok(index >= 0, `${table} must be listed in the migration table order`);
    assert.ok(index > lastIndex, `${table} must appear after the previous dependent table`);
    lastIndex = index;
  }
});

test("initDb backfills empty Browser Use lane defaults when columns already exist", () => {
  db.execSql(`
    DROP TABLE lanes;
    CREATE TABLE lanes (
      id TEXT PRIMARY KEY,
      run_id TEXT,
      role TEXT NOT NULL,
      cdp_port INTEGER NOT NULL,
      profile_dir TEXT NOT NULL,
      workdir TEXT NOT NULL,
      browser_use_session TEXT,
      browser_use_cdp_url TEXT,
      browser_use_profile TEXT,
      profile_strategy TEXT,
      lane_visibility TEXT,
      status TEXT NOT NULL,
      current_task TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      health TEXT NOT NULL DEFAULT 'good',
      resource_locks_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );
    INSERT INTO lanes (
      id, run_id, role, cdp_port, profile_dir, workdir,
      browser_use_session, browser_use_cdp_url, browser_use_profile,
      profile_strategy, lane_visibility, status, current_task, progress, health, resource_locks_json, updated_at
    )
    VALUES
      ('lane_null_defaults', 'run_null', 'browser', 9333, '/tmp/profile-null', '/tmp/workdir-null', NULL, NULL, NULL, NULL, NULL, 'idle', 'legacy', 0, 'good', '[]', '2026-06-11T01:00:00.000Z'),
      ('lane_empty_defaults', 'run_empty', 'browser', 9334, '/tmp/profile-empty', '/tmp/workdir-empty', NULL, NULL, NULL, '', '   ', 'idle', 'legacy', 0, 'good', '[]', '2026-06-11T01:01:00.000Z');
  `);

  db.initDb();

  const lanes = db.querySql<{ id: string; profile_strategy: string; lane_visibility: string }>(
    "SELECT id, profile_strategy, lane_visibility FROM lanes ORDER BY id"
  );
  assert.deepEqual(lanes, [
    { id: "lane_empty_defaults", profile_strategy: "cdp_profile_lane", lane_visibility: "visible" },
    { id: "lane_null_defaults", profile_strategy: "cdp_profile_lane", lane_visibility: "visible" }
  ]);
});

test("initDb adds Research Planner JSON columns to an existing research_plans table", () => {
  db.execSql(`
    DROP TABLE research_plans;
    CREATE TABLE research_plans (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      command TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO research_plans (id, title, status, command, created_at, updated_at)
    VALUES ('research_plan_legacy', 'Legacy', 'planned', 'legacy command', '2026-06-16T00:00:00.000Z', '2026-06-16T00:00:00.000Z');
  `);

  db.initDb();

  const columns = db.querySql<{ name: string }>("PRAGMA table_info(research_plans)").map((row) => row.name);
  assert.ok(columns.includes("sources_json"));
  assert.ok(columns.includes("visible_flow_json"));
  assert.ok(columns.includes("source_of_truth_json"));
  assert.ok(columns.includes("proof_boundary_json"));
  assert.ok(columns.includes("approval_boundary_json"));
  assert.ok(columns.includes("metadata_json"));
  assert.ok(columns.includes("demo_check_id"));
  assert.ok(columns.includes("run_id"));

  const row = db.querySql<{ visible_flow_json: string; metadata_json: string }>("SELECT visible_flow_json, metadata_json FROM research_plans WHERE id='research_plan_legacy'")[0];
  assert.equal(row.visible_flow_json, "[]");
  assert.equal(row.metadata_json, "{}");
});

test("querySql reuses completed initDb until a schema-changing execSql invalidates it", () => {
  db.initDb();
  const afterExplicitInit = db.getDbInitDiagnostics();

  assert.equal(afterExplicitInit.initialized, true);
  assert.equal(afterExplicitInit.initializing, false);

  assert.deepEqual(db.querySql<{ value: number }>("SELECT 1 AS value"), [{ value: 1 }]);
  assert.deepEqual(db.querySql<{ value: number }>("SELECT 2 AS value"), [{ value: 2 }]);
  const afterRepeatedQueries = db.getDbInitDiagnostics();

  assert.equal(afterRepeatedQueries.runCount, afterExplicitInit.runCount);

  db.execSql("CREATE TABLE IF NOT EXISTS init_cache_probe (id TEXT PRIMARY KEY);");
  const afterSchemaChange = db.getDbInitDiagnostics();

  assert.equal(afterSchemaChange.initialized, false);

  assert.deepEqual(db.querySql<{ value: number }>("SELECT 3 AS value"), [{ value: 3 }]);
  const afterReinit = db.getDbInitDiagnostics();

  assert.equal(afterReinit.initialized, true);
  assert.equal(afterReinit.runCount, afterRepeatedQueries.runCount + 1);

  assert.deepEqual(db.querySql<{ value: number }>("SELECT 4 AS value"), [{ value: 4 }]);
  assert.equal(db.getDbInitDiagnostics().runCount, afterReinit.runCount);
});

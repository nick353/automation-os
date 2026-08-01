import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-tenancy-audit-"));
const dbPath = join(tempRoot, "automation-os.sqlite");
process.env.AUTOMATION_OS_DB = dbPath;

const db = await import("../db/client.js");
const { auditTenancy } = await import("../companies/tenancyAudit.js");

test("fresh schema includes tenancy lineage columns and indexes", () => {
  db.initDb();

  for (const [table, column] of [
    ["runs", "company_id"],
    ["runs", "automation_id"],
    ["runs", "automation_version_id"],
    ["run_steps", "company_id"],
    ["approvals", "company_id"],
    ["proofs", "company_id"],
    ["worker_events", "company_id"],
    ["registered_workflows", "company_id"],
    ["research_plans", "company_id"],
    ["skills", "company_id"],
    ["mvp_feedback", "company_id"],
    ["mvp_feedback", "screenshot_artifact_id"],
    ["feedback_artifacts", "company_id"],
    ["feedback_artifacts", "feedback_id"],
    ["mvp_automations", "company_id"],
    ["mvp_automations", "current_version_id"],
    ["mvp_automations", "revision"],
    ["mvp_automations", "archived_at"],
    ["mvp_automation_versions", "company_id"],
    ["mvp_automation_versions", "automation_id"],
    ["mvp_automation_versions", "revision"],
    ["mvp_automation_schedules", "company_id"],
    ["mvp_automation_schedules", "automation_id"],
    ["mvp_automation_schedules", "automation_version_id"],
    ["mvp_idempotency_keys", "company_id"],
    ["mvp_idempotency_keys", "idempotency_key"],
    ["company_memory_entries", "company_id"],
    ["company_memory_entries", "memory_key"],
    ["company_connection_account_refs", "company_id"],
    ["company_connection_account_refs", "platform"],
    ["company_connection_account_refs", "account_ref"]
  ] as const) {
    const columns = db.querySql<{ name: string }>(`PRAGMA table_info(${table})`).map((row) => row.name);
    assert.ok(columns.includes(column), `${table}.${column} missing`);
  }

  for (const [table, indexName] of [
    ["runs", "idx_runs_company"],
    ["runs", "idx_runs_automation"],
    ["runs", "idx_runs_automation_version"],
    ["approvals", "idx_approvals_company_status"],
    ["proofs", "idx_proofs_company_run"],
    ["registered_workflows", "idx_registered_workflows_company"],
    ["research_plans", "idx_research_plans_company"],
    ["skills", "idx_skills_company"],
    ["mvp_feedback", "mvp_feedback_company_idx"],
    ["feedback_artifacts", "feedback_artifacts_company_idx"],
    ["mvp_automations", "mvp_automations_company_idx"],
    ["mvp_automations", "mvp_automations_current_version_idx"],
    ["mvp_automation_versions", "mvp_automation_versions_company_idx"],
    ["mvp_automation_versions", "mvp_automation_versions_automation_idx"],
    ["mvp_automation_schedules", "mvp_automation_schedules_company_idx"],
    ["mvp_automation_schedules", "mvp_automation_schedules_automation_idx"],
    ["mvp_automation_schedules", "mvp_automation_schedules_single_idx"],
    ["mvp_idempotency_keys", "mvp_idempotency_keys_company_idx"],
    ["company_memory_entries", "company_memory_entries_company_idx"],
    ["company_connection_account_refs", "company_connection_account_refs_company_idx"]
  ] as const) {
    const indexes = db.querySql<{ name: string }>(`PRAGMA index_list(${table})`).map((row) => row.name);
    assert.ok(indexes.includes(indexName), `${table} missing ${indexName}`);
  }
});

test("tenancy audit counts lineage failures without backfilling ownership", () => {
  db.execSql("PRAGMA foreign_keys = OFF;");
  db.execSql(`
    DELETE FROM skills;
    DELETE FROM research_plans;
    DELETE FROM registered_workflows;
    DELETE FROM proofs;
    DELETE FROM approvals;
    DELETE FROM worker_events;
    DELETE FROM run_steps;
    DELETE FROM runs;
    DELETE FROM mvp_automation_schedules;
    DELETE FROM mvp_automation_versions;
    DELETE FROM mvp_idempotency_keys;
    DELETE FROM company_memory_entries;
    DELETE FROM company_connection_account_refs;
    DELETE FROM mvp_automations;
    DELETE FROM companies;
  `);

  const timestamp = "2026-07-15T00:00:00.000Z";
  db.insert("companies", {
    id: "company_a",
    slug: "company-a",
    name: "Company A",
    status: "active",
    created_at: timestamp,
    updated_at: timestamp
  });
  db.insert("companies", {
    id: "company_b",
    slug: "company-b",
    name: "Company B",
    status: "active",
    created_at: timestamp,
    updated_at: timestamp
  });
  db.insert("runs", {
    id: "run_blank_company",
    company_id: "",
    name: "Blank company run",
    status: "draft",
    objective: "blank",
    created_at: timestamp,
    updated_at: timestamp,
    metadata_json: "{}"
  });
  db.insert("runs", {
    id: "run_missing_company_fk",
    company_id: "company_missing",
    name: "Missing company fk run",
    status: "draft",
    objective: "missing",
    created_at: timestamp,
    updated_at: timestamp,
    metadata_json: "{}"
  });
  db.insert("runs", {
    id: "run_company_a",
    company_id: "company_a",
    name: "Company A run",
    status: "draft",
    objective: "match",
    created_at: timestamp,
    updated_at: timestamp,
    metadata_json: "{}"
  });
  db.insert("runs", {
    id: "run_company_b",
    company_id: "company_b",
    name: "Company B run",
    status: "draft",
    objective: "match",
    created_at: timestamp,
    updated_at: timestamp,
    metadata_json: "{}"
  });
  db.insert("run_steps", {
    id: "step_company_a",
    run_id: "run_company_a",
    company_id: "company_a",
    name: "Step A",
    status: "queued",
    lane_id: null,
    started_at: null,
    completed_at: null,
    metadata_json: "{}"
  });
  db.insert("run_steps", {
    id: "step_company_b",
    run_id: "run_company_b",
    company_id: "company_b",
    name: "Step B",
    status: "queued",
    lane_id: null,
    started_at: null,
    completed_at: null,
    metadata_json: "{}"
  });
  for (const [id, companyId, runId] of [
    ["step_blank_company", "", "run_company_a"],
    ["step_missing_company_fk", "company_missing", "run_company_a"],
    ["step_company_mismatch", "company_b", "run_company_a"]
  ] as const) {
    db.insert("run_steps", {
      id,
      company_id: companyId,
      run_id: runId,
      name: id,
      status: "queued",
      lane_id: null,
      started_at: null,
      completed_at: null,
      metadata_json: "{}"
    });
  }
  for (const [id, companyId, runId] of [
    ["event_blank_company", "", "run_company_a"],
    ["event_missing_company_fk", "company_missing", "run_company_a"],
    ["event_company_mismatch", "company_b", "run_company_a"]
  ] as const) {
    db.insert("worker_events", {
      id,
      company_id: companyId,
      run_id: runId,
      step_id: null,
      lane_id: null,
      event_type: "test",
      message: id,
      created_at: timestamp,
      metadata_json: "{}"
    });
  }
  db.insert("approvals", {
    id: "approval_blank_company",
    company_id: "",
    run_id: "run_company_a",
    title: "Blank company approval",
    requested_by: "operator",
    status: "pending",
    priority: "normal",
    approval_group_id: "group-a",
    resource_locks_json: "[]",
    created_at: timestamp,
    decided_at: null,
    decision_note: null
  });
  db.insert("approvals", {
    id: "approval_missing_company_fk",
    company_id: "company_missing",
    run_id: "run_company_a",
    title: "Missing company fk approval",
    requested_by: "operator",
    status: "pending",
    priority: "normal",
    approval_group_id: "group-a",
    resource_locks_json: "[]",
    created_at: timestamp,
    decided_at: null,
    decision_note: null
  });
  db.insert("approvals", {
    id: "approval_orphan_run",
    company_id: "company_a",
    run_id: "run_missing",
    title: "Orphan approval run",
    requested_by: "operator",
    status: "pending",
    priority: "normal",
    approval_group_id: "group-a",
    resource_locks_json: "[]",
    created_at: timestamp,
    decided_at: null,
    decision_note: null
  });
  db.insert("approvals", {
    id: "approval_company_mismatch",
    company_id: "company_b",
    run_id: "run_company_a",
    title: "Company mismatch approval",
    requested_by: "operator",
    status: "pending",
    priority: "normal",
    approval_group_id: "group-a",
    resource_locks_json: "[]",
    created_at: timestamp,
    decided_at: null,
    decision_note: null
  });
  db.insert("proofs", {
    id: "proof_blank_company",
    company_id: "",
    run_id: "run_company_a",
    step_id: null,
    proof_type: "worker_receipt",
    label: "Blank company proof",
    uri: "file:///blank",
    size_bytes: 0,
    created_at: timestamp,
    metadata_json: "{}"
  });
  db.insert("proofs", {
    id: "proof_missing_company_fk",
    company_id: "company_missing",
    run_id: "run_company_a",
    step_id: null,
    proof_type: "worker_receipt",
    label: "Missing company fk proof",
    uri: "file:///missing",
    size_bytes: 0,
    created_at: timestamp,
    metadata_json: "{}"
  });
  db.insert("proofs", {
    id: "proof_orphan_run",
    company_id: "company_a",
    run_id: "run_missing",
    step_id: null,
    proof_type: "worker_receipt",
    label: "Orphan proof run",
    uri: "file:///orphan-run",
    size_bytes: 0,
    created_at: timestamp,
    metadata_json: "{}"
  });
  db.insert("proofs", {
    id: "proof_company_mismatch",
    company_id: "company_b",
    run_id: "run_company_a",
    step_id: null,
    proof_type: "worker_receipt",
    label: "Company mismatch proof",
    uri: "file:///mismatch",
    size_bytes: 0,
    created_at: timestamp,
    metadata_json: "{}"
  });
  db.insert("proofs", {
    id: "proof_step_missing",
    company_id: "company_a",
    run_id: "run_company_a",
    step_id: "step_missing",
    proof_type: "worker_receipt",
    label: "Missing step proof",
    uri: "file:///step-missing",
    size_bytes: 0,
    created_at: timestamp,
    metadata_json: "{}"
  });
  db.insert("proofs", {
    id: "proof_step_mismatch",
    company_id: "company_a",
    run_id: "run_company_a",
    step_id: "step_company_b",
    proof_type: "worker_receipt",
    label: "Step mismatch proof",
    uri: "file:///step-mismatch",
    size_bytes: 0,
    created_at: timestamp,
    metadata_json: "{}"
  });
  db.insert("registered_workflows", {
    id: "workflow_blank_company",
    company_id: "",
    name: "Workflow blank company",
    status: "active",
    runner_status: "ready",
    runner_kind: "worker",
    project_root: "/tmp/workflow",
    start_command_json: "{}",
    schedule_json: "{}",
    source_refs_json: "[]",
    provenance_json: "{}",
    created_at: timestamp,
    updated_at: timestamp
  });
  db.insert("registered_workflows", {
    id: "workflow_missing_company_fk",
    company_id: "company_missing",
    name: "Workflow missing company fk",
    status: "active",
    runner_status: "ready",
    runner_kind: "worker",
    project_root: "/tmp/workflow-missing",
    start_command_json: "{}",
    schedule_json: "{}",
    source_refs_json: "[]",
    provenance_json: "{}",
    created_at: timestamp,
    updated_at: timestamp
  });
  db.insert("research_plans", {
    id: "plan_blank_company",
    company_id: "",
    title: "Plan blank company",
    status: "planned",
    command: "echo blank",
    sources_json: "[]",
    visible_flow_json: "[]",
    source_of_truth_json: "[]",
    proof_boundary_json: "[]",
    approval_boundary_json: "[]",
    metadata_json: "{}",
    demo_check_id: null,
    run_id: null,
    created_at: timestamp,
    updated_at: timestamp
  });
  db.insert("research_plans", {
    id: "plan_company_mismatch",
    company_id: "company_b",
    title: "Plan company mismatch",
    status: "started",
    command: "echo mismatch",
    sources_json: "[]",
    visible_flow_json: "[]",
    source_of_truth_json: "[]",
    proof_boundary_json: "[]",
    approval_boundary_json: "[]",
    metadata_json: "{}",
    demo_check_id: null,
    run_id: "run_company_a",
    created_at: timestamp,
    updated_at: timestamp
  });
  db.insert("research_plans", {
    id: "plan_missing_company_fk",
    company_id: "company_missing",
    title: "Plan missing company fk",
    status: "planned",
    command: "echo missing",
    sources_json: "[]",
    visible_flow_json: "[]",
    source_of_truth_json: "[]",
    proof_boundary_json: "[]",
    approval_boundary_json: "[]",
    metadata_json: "{}",
    demo_check_id: null,
    run_id: null,
    created_at: timestamp,
    updated_at: timestamp
  });
  db.insert("skills", {
    id: "skill_blank_company",
    company_id: "",
    run_id: "run_company_a",
    name: "Skill blank company",
    draft_markdown: "# blank",
    created_at: timestamp
  });
  db.insert("mvp_automations", {
    id: "automation_blank_company",
    company_id: "",
    project_id: "company_a",
    automation_type: "test",
    name: "Blank company automation",
    description: "",
    goal: "",
    schedule: "",
    cadence: "manual",
    lane: "local",
    risk_level: "low",
    approval_policy: "none",
    worker_command_kind: "local",
    create_approval: 0,
    status: "draft",
    builder_spec_json: "{}",
    created_at: timestamp,
    updated_at: timestamp
  });
  db.insert("mvp_automations", {
    id: "automation_missing_company_fk",
    company_id: "company_missing",
    project_id: "company_missing",
    automation_type: "test",
    name: "Missing company automation",
    description: "",
    goal: "",
    schedule: "",
    cadence: "manual",
    lane: "local",
    risk_level: "low",
    approval_policy: "none",
    worker_command_kind: "local",
    create_approval: 0,
    status: "draft",
    builder_spec_json: "{}",
    created_at: timestamp,
    updated_at: timestamp
  });
  db.insert("mvp_automations", {
    id: "automation_company_mismatch",
    company_id: "company_b",
    project_id: "company_a",
    automation_type: "test",
    name: "Mismatched company automation",
    description: "",
    goal: "",
    schedule: "",
    cadence: "manual",
    lane: "local",
    risk_level: "low",
    approval_policy: "none",
    worker_command_kind: "local",
    create_approval: 0,
    status: "draft",
    builder_spec_json: "{}",
    created_at: timestamp,
    updated_at: timestamp
  });
  db.insert("mvp_automations", {
    id: "automation_current_version_mismatch",
    company_id: "company_a",
    project_id: "company_a",
    automation_type: "test",
    name: "Current version mismatch automation",
    description: "",
    goal: "",
    schedule: "",
    cadence: "manual",
    lane: "local",
    risk_level: "low",
    approval_policy: "none",
    worker_command_kind: "local",
    create_approval: 0,
    status: "draft",
    builder_spec_json: "{}",
    current_version_id: "automation_current_version_mismatch_v1",
    revision: 2,
    created_at: timestamp,
    updated_at: timestamp
  });
  db.insert("mvp_automations", {
    id: "automation_schedule_version_other",
    company_id: "company_a",
    project_id: "company_a",
    automation_type: "test",
    name: "Schedule version other automation",
    description: "",
    goal: "",
    schedule: "",
    cadence: "manual",
    lane: "local",
    risk_level: "low",
    approval_policy: "none",
    worker_command_kind: "local",
    create_approval: 0,
    status: "draft",
    builder_spec_json: "{}",
    current_version_id: "automation_schedule_version_other_v1",
    revision: 1,
    created_at: timestamp,
    updated_at: timestamp
  });
  for (const [id, companyId, automationId, revision] of [
    ["automation_version_blank_company_v1", "", "automation_blank_company", 1],
    ["automation_version_missing_company_fk_v1", "company_missing", "automation_missing_company_fk", 1],
    ["automation_version_company_mismatch_v1", "company_a", "automation_company_mismatch", 1],
    ["automation_current_version_mismatch_v1", "company_a", "automation_current_version_mismatch", 1],
    ["automation_schedule_version_other_v1", "company_a", "automation_schedule_version_other", 1]
  ] as const) {
    db.insert("mvp_automation_versions", {
      id,
      company_id: companyId,
      project_id: companyId || "company_a",
      automation_id: automationId,
      revision,
      automation_type: "test",
      name: id,
      description: id,
      goal: id,
      schedule: "",
      cadence: "manual",
      lane: "local",
      risk_level: "low",
      approval_policy: "none",
      worker_command_kind: "local",
      create_approval: 0,
      status: "draft",
      builder_spec_json: "{}",
      created_at: timestamp,
      updated_at: timestamp
    });
  }
  for (const [id, companyId, automationId, automationVersionId] of [
    ["schedule_blank_company", "", "automation_current_version_mismatch", "automation_current_version_mismatch_v1"],
    ["schedule_missing_company_fk", "company_missing", "automation_missing_company_fk", "automation_version_missing_company_fk_v1"],
    ["schedule_company_mismatch", "company_b", "automation_current_version_mismatch", "automation_current_version_mismatch_v1"],
    ["schedule_version_mismatch", "company_a", "automation_current_version_mismatch", "automation_schedule_version_other_v1"]
  ] as const) {
    db.insert("mvp_automation_schedules", {
      id,
      company_id: companyId,
      project_id: companyId || "company_a",
      automation_id: automationId,
      automation_version_id: automationVersionId,
      kind: "cron",
      expression: "0 * * * *",
      timezone: "UTC",
      enabled: 0,
      status: "paused",
      revision: 1,
      next_run_at: null,
      last_run_at: null,
      paused_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp
    });
  }
  for (const [id, companyId] of [
    ["idempotency_blank_company", ""],
    ["idempotency_missing_company_fk", "company_missing"]
  ] as const) {
    db.insert("mvp_idempotency_keys", {
      id,
      company_id: companyId,
      scope: "test",
      idempotency_key: id,
      request_hash: `hash:${id}`,
      response_json: "{}",
      status: "pending",
      expires_at: null,
      created_at: timestamp,
      updated_at: timestamp
    });
  }
  for (const [id, companyId, keyField] of [
    ["memory_blank_company", "", "memory_blank_company"],
    ["memory_missing_company_fk", "company_missing", "memory_missing_company_fk"]
  ] as const) {
    db.insert("company_memory_entries", {
      id,
      company_id: companyId,
      kind: "note",
      title: id,
      body: id,
      memory_key: keyField,
      status: "active",
      archived_at: null,
      created_at: timestamp,
      updated_at: timestamp
    });
  }
  for (const [id, companyId, platform, accountRef] of [
    ["connection_blank_company", "", "test", "connection_blank_company"],
    ["connection_missing_company_fk", "company_missing", "test", "connection_missing_company_fk"]
  ] as const) {
    db.insert("company_connection_account_refs", {
      id,
      company_id: companyId,
      platform,
      account_ref: accountRef,
      status: "active",
      scopes_json: "[]",
      expires_at: null,
      revision: 1,
      created_at: timestamp,
      updated_at: timestamp
    });
  }
  db.insert("mvp_feedback", {
    id: "feedback_blank_company",
    company_id: "",
    feedback_id: "feedback_blank_company",
    status: "open",
    route: "#/",
    page_title: "Blank",
    comment: "blank",
    artifact_uri: "#/",
    has_screenshot: 0,
    viewport_json: "{}",
    workflow_context_json: "{}",
    category: "bug",
    severity: "medium",
    fix_target: "ui",
    captured_at: timestamp,
    created_at: timestamp,
    payload_json: "{}"
  });
  db.insert("mvp_feedback", {
    id: "feedback_missing_company_fk",
    company_id: "company_missing",
    feedback_id: "feedback_missing_company_fk",
    status: "open",
    route: "#/",
    page_title: "Missing",
    comment: "missing",
    artifact_uri: "#/",
    has_screenshot: 0,
    viewport_json: "{}",
    workflow_context_json: "{}",
    category: "bug",
    severity: "medium",
    fix_target: "ui",
    captured_at: timestamp,
    created_at: timestamp,
    payload_json: "{}"
  });
  db.insert("skills", {
    id: "skill_missing_company_fk",
    company_id: "company_missing",
    run_id: "run_company_a",
    name: "Skill missing company fk",
    draft_markdown: "# missing",
    created_at: timestamp
  });
  db.insert("runs", {
    id: "run_legacy_null_lineage",
    company_id: "company_a",
    automation_id: null,
    automation_version_id: null,
    name: "Legacy null lineage run",
    status: "draft",
    objective: "legacy",
    created_at: timestamp,
    updated_at: timestamp,
    metadata_json: "{}"
  });
  db.insert("runs", {
    id: "run_partial_automation_only",
    company_id: "company_a",
    automation_id: "automation_current_version_mismatch",
    automation_version_id: null,
    name: "Partial automation only run",
    status: "draft",
    objective: "partial",
    created_at: timestamp,
    updated_at: timestamp,
    metadata_json: "{}"
  });
  db.insert("runs", {
    id: "run_partial_version_only",
    company_id: "company_a",
    automation_id: null,
    automation_version_id: "automation_current_version_mismatch_v1",
    name: "Partial version only run",
    status: "draft",
    objective: "partial",
    created_at: timestamp,
    updated_at: timestamp,
    metadata_json: "{}"
  });
  db.insert("runs", {
    id: "run_conflicting_lineage",
    company_id: "company_a",
    automation_id: "automation_current_version_mismatch",
    automation_version_id: "automation_schedule_version_other_v1",
    name: "Conflicting lineage run",
    status: "draft",
    objective: "conflict",
    created_at: timestamp,
    updated_at: timestamp,
    metadata_json: "{}"
  });

  db.execSql("PRAGMA foreign_keys = ON;");
  const audit = auditTenancy();
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.counts.blankCompany, {
    runs: 1,
    runSteps: 1,
    approvals: 1,
    proofs: 1,
    workerEvents: 1,
    registeredWorkflows: 1,
    researchPlans: 1,
    skills: 1,
    mvpFeedback: 1,
    mvpAutomations: 1,
    mvpAutomationVersions: 1,
    mvpAutomationSchedules: 1,
    mvpIdempotencyKeys: 1,
    companyMemoryEntries: 1,
    companyConnectionAccountRefs: 1
  });
  assert.deepEqual(audit.counts.missingCompanyFk, {
    runs: 1,
    runSteps: 1,
    approvals: 1,
    proofs: 1,
    workerEvents: 1,
    registeredWorkflows: 1,
    researchPlans: 1,
    skills: 1,
    mvpFeedback: 1,
    mvpAutomations: 1,
    mvpAutomationVersions: 1,
    mvpAutomationSchedules: 1,
    mvpIdempotencyKeys: 1,
    companyMemoryEntries: 1,
    companyConnectionAccountRefs: 1
  });
  assert.equal(audit.counts.automationCurrentVersionMismatch, 1);
  assert.equal(audit.counts.automationProjectionVersionMismatch, 2);
  assert.equal(audit.counts.automationVersionCompanyMismatch, 1);
  assert.equal(audit.counts.automationScheduleCompanyMismatch, 1);
  assert.equal(audit.counts.automationScheduleVersionMismatch, 3);
  assert.equal(audit.counts.runAutomationLineageMismatch, 3);
  assert.equal(audit.counts.orphanRunStepRun, 0);
  assert.equal(audit.counts.orphanApprovalRun, 1);
  assert.equal(audit.counts.orphanProofRun, 1);
  assert.equal(audit.counts.orphanWorkerEventRun, 0);
  assert.equal(audit.counts.orphanSkillRun, 0);
  assert.equal(audit.counts.runStepRunCompanyMismatch, 2);
  assert.equal(audit.counts.approvalRunCompanyMismatch, 2);
  assert.equal(audit.counts.proofRunCompanyMismatch, 2);
  assert.equal(audit.counts.workerEventRunCompanyMismatch, 2);
  assert.equal(audit.counts.researchPlanRunCompanyMismatch, 1);
  assert.equal(audit.counts.skillRunCompanyMismatch, 1);
  assert.equal(audit.counts.automationProjectCompanyMismatch, 2);
  assert.equal(audit.counts.proofStepRunMismatch, 2);
  assert.ok(audit.issues.some((issue) => issue.code === "approval_run_company_mismatch" && issue.count === 2));
  assert.ok(audit.issues.some((issue) => issue.code === "proof_run_company_mismatch" && issue.count === 2));
  assert.ok(audit.issues.some((issue) => issue.code === "proof_step_run_mismatch" && issue.count === 2));
  assert.ok(audit.issues.some((issue) => issue.code === "automation_current_version_mismatch" && issue.count === 1));
  assert.ok(audit.issues.some((issue) => issue.code === "automation_projection_version_mismatch" && issue.count === 2));
  assert.ok(audit.issues.some((issue) => issue.code === "automation_version_company_mismatch" && issue.count === 1));
  assert.ok(audit.issues.some((issue) => issue.code === "automation_schedule_company_mismatch" && issue.count === 1));
  assert.ok(audit.issues.some((issue) => issue.code === "automation_schedule_version_mismatch" && issue.count === 3));
  assert.ok(audit.issues.some((issue) => issue.code === "run_automation_lineage_mismatch" && issue.count === 3));
  assert.equal(
    db.querySql<{ automation_id: string | null; automation_version_id: string | null }>(
      `SELECT automation_id, automation_version_id FROM runs WHERE id = 'run_legacy_null_lineage'`
    )[0]?.automation_id,
    null
  );
  assert.equal(
    db.querySql<{ automation_id: string | null; automation_version_id: string | null }>(
      `SELECT automation_id, automation_version_id FROM runs WHERE id = 'run_legacy_null_lineage'`
    )[0]?.automation_version_id,
    null
  );
});

test("tenancy audit exempts only canonical fixed globals with strong manual or scheduler identity markers", () => {
  db.execSql(`
    DELETE FROM users;
    DELETE FROM skills;
    DELETE FROM research_plans;
    DELETE FROM proofs;
    DELETE FROM approvals;
    DELETE FROM worker_events;
    DELETE FROM run_steps;
    DELETE FROM runs;
    DELETE FROM registered_workflows;
    DELETE FROM mvp_feedback;
    DELETE FROM mvp_automations;
  `);
  const timestamp = "2026-07-15T01:00:00.000Z";
  const insertUser = (id: string, kind: "human" | "service", status: "active" | "inactive") => db.upsert("users", {
    id,
    auth_provider: "test",
    auth_subject: id,
    email: null,
    display_name: id,
    kind,
    status,
    created_at: timestamp,
    updated_at: timestamp
  });
  insertUser("user_admin_active", "human", "active");
  insertUser("user_admin_inactive", "human", "inactive");
  insertUser("service_global_active", "service", "active");
  insertUser("service_global_inactive", "service", "inactive");

  const insertWorkflow = (id: string, runnerKind: string) => db.insert("registered_workflows", {
    id,
    company_id: null,
    name: id,
    status: "active",
    runner_status: "connected",
    runner_kind: runnerKind,
    project_root: "/tmp/fixed-global-audit",
    start_command_json: "{}",
    schedule_json: "{}",
    source_refs_json: "[]",
    provenance_json: "{}",
    created_at: timestamp,
    updated_at: timestamp
  });
  insertWorkflow("daily-ai-research-publish-run", "daily_ai_registered");
  insertWorkflow("spoofed-daily-ai", "daily_ai_registered");
  insertWorkflow("prompt-transfer-ukiyoe", "daily_ai_registered");

  const insertGlobalRun = (id: string, metadata: Record<string, unknown>) => db.insert("runs", {
    id,
    company_id: null,
    name: id,
    status: "queued",
    objective: id,
    created_at: timestamp,
    updated_at: timestamp,
    metadata_json: metadata
  });
  insertGlobalRun("run_valid_manual_global", {
    registeredWorkflowId: "daily-ai-research-publish-run",
    registered_workflow_id: "daily-ai-research-publish-run",
    registered_workflow_start: { source: "manual", runnerKind: "daily_ai_registered" },
    system_scope: "global",
    system_admin_actor_user_id: "user_admin_active"
  });
  insertGlobalRun("run_valid_scheduler_global", {
    workflowId: "daily-ai-research-publish-run",
    workflow_id: "daily-ai-research-publish-run",
    AUTOMATION_OS_REGISTERED_WORKFLOW_ID: "daily-ai-research-publish-run",
    registered_workflow_start: {
      source: "scheduler",
      runnerKind: "daily_ai_registered",
      workflowId: "daily-ai-research-publish-run"
    },
    system_scope: "global",
    scheduler_service_identity: { userId: "service_global_active", kind: "service", scope: "global_system" }
  });
  insertGlobalRun("run_spoofed_workflow_id", {
    registeredWorkflowId: "spoofed-daily-ai",
    registered_workflow_start: { source: "manual", runnerKind: "daily_ai_registered" },
    system_scope: "global",
    system_admin_actor_user_id: "user_admin_active"
  });
  insertGlobalRun("run_runner_kind_mismatch", {
    registeredWorkflowId: "daily-ai-research-publish-run",
    registered_workflow_start: { source: "manual", runnerKind: "prompt_transfer_registered" },
    system_scope: "global",
    system_admin_actor_user_id: "user_admin_active"
  });
  insertGlobalRun("run_inactive_manual_identity", {
    registeredWorkflowId: "daily-ai-research-publish-run",
    registered_workflow_start: { source: "manual", runnerKind: "daily_ai_registered" },
    system_scope: "global",
    system_admin_actor_user_id: "user_admin_inactive"
  });
  insertGlobalRun("run_inactive_scheduler_identity", {
    registeredWorkflowId: "daily-ai-research-publish-run",
    registered_workflow_start: { source: "scheduler", runnerKind: "daily_ai_registered" },
    system_scope: "global",
    scheduler_service_identity: { userId: "service_global_inactive", kind: "service", scope: "global_system" }
  });
  insertGlobalRun("run_conflicting_workflow_aliases", {
    registeredWorkflowId: "daily-ai-research-publish-run",
    registered_workflow_id: "daily-ai-research-publish-run",
    workflowId: "daily-ai-research-publish-run",
    workflow_id: "daily-ai-research-publish-run",
    AUTOMATION_OS_REGISTERED_WORKFLOW_ID: "daily-ai-research-publish-run",
    registered_workflow_start: {
      source: "manual",
      runnerKind: "daily_ai_registered",
      workflowId: "prompt-transfer-ukiyoe"
    },
    system_scope: "global",
    system_admin_actor_user_id: "user_admin_active"
  });

  for (const runId of ["run_valid_manual_global", "run_spoofed_workflow_id"]) {
    db.insert("run_steps", {
      id: `step_${runId}`,
      company_id: null,
      run_id: runId,
      name: runId,
      status: "queued",
      lane_id: null,
      started_at: null,
      completed_at: null,
      metadata_json: "{}"
    });
    db.insert("worker_events", {
      id: `event_${runId}`,
      company_id: null,
      run_id: runId,
      step_id: null,
      lane_id: null,
      event_type: "queued",
      message: runId,
      created_at: timestamp,
      metadata_json: "{}"
    });
  }

  const audit = auditTenancy();
  assert.equal(audit.counts.blankCompany.registeredWorkflows, 2);
  assert.equal(audit.counts.blankCompany.runs, 5);
  assert.equal(audit.counts.blankCompany.runSteps, 1);
  assert.equal(audit.counts.blankCompany.workerEvents, 1);
  assert.ok(audit.issues.some((issue) => issue.code === "blank_company_runs" && issue.count === 5));
});

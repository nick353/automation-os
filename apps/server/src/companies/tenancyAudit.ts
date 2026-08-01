import { querySql, sqlValue } from "../db/client.js";
import { fixedRegisteredWorkflows } from "../registeredWorkflows.js";

type CountRow = { count: number };

export type TenancyAuditCounts = {
  blankCompany: {
    runs: number;
    runSteps: number;
    approvals: number;
    proofs: number;
    workerEvents: number;
    registeredWorkflows: number;
    researchPlans: number;
    skills: number;
    mvpFeedback: number;
    mvpAutomations: number;
    mvpAutomationVersions: number;
    mvpAutomationSchedules: number;
    mvpIdempotencyKeys: number;
    companyMemoryEntries: number;
    companyConnectionAccountRefs: number;
  };
  missingCompanyFk: {
    runs: number;
    runSteps: number;
    approvals: number;
    proofs: number;
    workerEvents: number;
    registeredWorkflows: number;
    researchPlans: number;
    skills: number;
    mvpFeedback: number;
    mvpAutomations: number;
    mvpAutomationVersions: number;
    mvpAutomationSchedules: number;
    mvpIdempotencyKeys: number;
    companyMemoryEntries: number;
    companyConnectionAccountRefs: number;
  };
  automationCurrentVersionMismatch: number;
  automationProjectionVersionMismatch: number;
  automationVersionCompanyMismatch: number;
  automationScheduleCompanyMismatch: number;
  automationScheduleVersionMismatch: number;
  runAutomationLineageMismatch: number;
  orphanRunStepRun: number;
  orphanApprovalRun: number;
  orphanProofRun: number;
  orphanWorkerEventRun: number;
  orphanSkillRun: number;
  runStepRunCompanyMismatch: number;
  approvalRunCompanyMismatch: number;
  proofRunCompanyMismatch: number;
  workerEventRunCompanyMismatch: number;
  researchPlanRunCompanyMismatch: number;
  skillRunCompanyMismatch: number;
  automationProjectCompanyMismatch: number;
  proofStepRunMismatch: number;
};

export type TenancyAuditIssue = {
  code: string;
  count: number;
};

export type TenancyAuditResult = {
  ok: boolean;
  counts: TenancyAuditCounts;
  issues: TenancyAuditIssue[];
};

const companyScopedTables = [
  { key: "runs", table: "runs" },
  { key: "runSteps", table: "run_steps" },
  { key: "approvals", table: "approvals" },
  { key: "proofs", table: "proofs" },
  { key: "workerEvents", table: "worker_events" },
  { key: "registeredWorkflows", table: "registered_workflows" },
  { key: "researchPlans", table: "research_plans" },
  { key: "skills", table: "skills" },
  { key: "mvpFeedback", table: "mvp_feedback" },
  { key: "mvpAutomations", table: "mvp_automations" },
  { key: "mvpAutomationVersions", table: "mvp_automation_versions" },
  { key: "mvpAutomationSchedules", table: "mvp_automation_schedules" },
  { key: "mvpIdempotencyKeys", table: "mvp_idempotency_keys" },
  { key: "companyMemoryEntries", table: "company_memory_entries" },
  { key: "companyConnectionAccountRefs", table: "company_connection_account_refs" }
] as const;

export function auditTenancy(): TenancyAuditResult {
  const fixedGlobalWorkflows = new Map(fixedRegisteredWorkflows.map((workflow) => [workflow.id, workflow.runnerKind]));
  const blankCompany = Object.fromEntries(
    companyScopedTables.map(({ key, table }) => [key, countBlankCompanyRows(table, fixedGlobalWorkflows)])
  ) as TenancyAuditCounts["blankCompany"];
  const missingCompanyFk = Object.fromEntries(
    companyScopedTables.map(({ key, table }) => [key, countRows(missingCompanyFkSql(table))])
  ) as TenancyAuditCounts["missingCompanyFk"];

  const counts: TenancyAuditCounts = {
    blankCompany,
    missingCompanyFk,
    orphanRunStepRun: countRows(
      `SELECT 1 FROM run_steps
       WHERE run_id IS NULL OR trim(run_id)=''
          OR NOT EXISTS (SELECT 1 FROM runs WHERE runs.id = run_steps.run_id)`
    ),
    orphanApprovalRun: countRows(
      `SELECT 1 FROM approvals
       WHERE run_id IS NULL OR trim(run_id)=''
          OR NOT EXISTS (SELECT 1 FROM runs WHERE runs.id = approvals.run_id)`
    ),
    orphanProofRun: countRows(
      `SELECT 1 FROM proofs
       WHERE run_id IS NULL OR trim(run_id)=''
          OR NOT EXISTS (SELECT 1 FROM runs WHERE runs.id = proofs.run_id)`
    ),
    orphanWorkerEventRun: countRows(
      `SELECT 1 FROM worker_events
       WHERE run_id IS NULL OR trim(run_id)=''
          OR NOT EXISTS (SELECT 1 FROM runs WHERE runs.id = worker_events.run_id)`
    ),
    orphanSkillRun: countRows(
      `SELECT 1 FROM skills
       WHERE run_id IS NULL OR trim(run_id)=''
          OR NOT EXISTS (SELECT 1 FROM runs WHERE runs.id = skills.run_id)`
    ),
    runStepRunCompanyMismatch: childRunCompanyMismatch("run_steps"),
    approvalRunCompanyMismatch: countRows(
      `SELECT 1 FROM approvals
       INNER JOIN runs ON runs.id = approvals.run_id
       WHERE approvals.company_id IS NOT NULL
         AND trim(approvals.company_id) <> ''
         AND (
           runs.company_id IS NULL
           OR trim(runs.company_id) = ''
           OR runs.company_id <> approvals.company_id
         )`
    ),
    proofRunCompanyMismatch: countRows(
      `SELECT 1 FROM proofs
       INNER JOIN runs ON runs.id = proofs.run_id
       WHERE proofs.company_id IS NOT NULL
         AND trim(proofs.company_id) <> ''
         AND (
           runs.company_id IS NULL
           OR trim(runs.company_id) = ''
           OR runs.company_id <> proofs.company_id
         )`
    ),
    workerEventRunCompanyMismatch: childRunCompanyMismatch("worker_events"),
    researchPlanRunCompanyMismatch: countRows(
      `SELECT 1 FROM research_plans
       INNER JOIN runs ON runs.id = research_plans.run_id
       WHERE research_plans.run_id IS NOT NULL
         AND trim(research_plans.run_id) <> ''
         AND (
           research_plans.company_id IS NULL
           OR trim(research_plans.company_id) = ''
           OR runs.company_id IS NULL
           OR trim(runs.company_id) = ''
           OR runs.company_id <> research_plans.company_id
         )`
    ),
    skillRunCompanyMismatch: childRunCompanyMismatch("skills"),
    automationProjectCompanyMismatch: countRows(
      `SELECT 1 FROM mvp_automations
       WHERE company_id IS NULL OR trim(company_id)=''
          OR project_id IS NULL OR trim(project_id)=''
          OR company_id <> project_id`
    ),
    automationCurrentVersionMismatch: countRows(
      `SELECT 1 FROM mvp_automations
       LEFT JOIN mvp_automation_versions ON mvp_automation_versions.id = mvp_automations.current_version_id
       WHERE mvp_automations.current_version_id IS NOT NULL
         AND trim(mvp_automations.current_version_id) <> ''
         AND (
           mvp_automation_versions.id IS NULL
           OR mvp_automation_versions.automation_id <> mvp_automations.id
           OR mvp_automation_versions.company_id <> mvp_automations.company_id
           OR mvp_automation_versions.revision <> mvp_automations.revision
         )`
    ),
    automationProjectionVersionMismatch: countRows(
      `SELECT 1 FROM mvp_automations
       INNER JOIN mvp_automation_versions ON mvp_automation_versions.id = mvp_automations.current_version_id
       WHERE mvp_automation_versions.automation_id <> mvp_automations.id
          OR mvp_automation_versions.company_id <> mvp_automations.company_id
          OR mvp_automation_versions.revision <> mvp_automations.revision
          OR mvp_automation_versions.automation_type <> mvp_automations.automation_type
          OR mvp_automation_versions.name <> mvp_automations.name
          OR mvp_automation_versions.description <> mvp_automations.description
          OR mvp_automation_versions.goal <> mvp_automations.goal
          OR mvp_automation_versions.lane <> mvp_automations.lane
          OR mvp_automation_versions.risk_level <> mvp_automations.risk_level
          OR mvp_automation_versions.approval_policy <> mvp_automations.approval_policy
          OR mvp_automation_versions.worker_command_kind <> mvp_automations.worker_command_kind
          OR mvp_automation_versions.create_approval <> mvp_automations.create_approval
          OR mvp_automation_versions.status <> mvp_automations.status
          OR mvp_automation_versions.builder_spec_json <> mvp_automations.builder_spec_json`
    ),
    automationVersionCompanyMismatch: countRows(
      `SELECT 1 FROM mvp_automation_versions
       LEFT JOIN mvp_automations ON mvp_automations.id = mvp_automation_versions.automation_id
       WHERE mvp_automation_versions.company_id IS NOT NULL
         AND trim(mvp_automation_versions.company_id) <> ''
         AND (
           mvp_automations.id IS NULL
           OR mvp_automations.company_id IS NULL
           OR trim(mvp_automations.company_id) = ''
           OR mvp_automations.company_id <> mvp_automation_versions.company_id
         )`
    ),
    automationScheduleCompanyMismatch: countRows(
      `SELECT 1 FROM mvp_automation_schedules
       LEFT JOIN mvp_automations ON mvp_automations.id = mvp_automation_schedules.automation_id
       WHERE mvp_automation_schedules.company_id IS NOT NULL
         AND trim(mvp_automation_schedules.company_id) <> ''
         AND (
           mvp_automations.id IS NULL
           OR mvp_automations.company_id IS NULL
           OR trim(mvp_automations.company_id) = ''
           OR mvp_automations.company_id <> mvp_automation_schedules.company_id
         )`
    ),
    automationScheduleVersionMismatch: countRows(
      `SELECT 1 FROM mvp_automation_schedules
       LEFT JOIN mvp_automations ON mvp_automations.id = mvp_automation_schedules.automation_id
       LEFT JOIN mvp_automation_versions ON mvp_automation_versions.id = mvp_automation_schedules.automation_version_id
       WHERE mvp_automation_schedules.automation_id IS NULL
         OR trim(mvp_automation_schedules.automation_id) = ''
         OR mvp_automation_schedules.automation_version_id IS NULL
         OR trim(mvp_automation_schedules.automation_version_id) = ''
         OR mvp_automations.id IS NULL
         OR mvp_automation_versions.id IS NULL
         OR mvp_automation_versions.automation_id <> mvp_automations.id
         OR mvp_automation_versions.company_id <> mvp_automation_schedules.company_id`
    ),
    runAutomationLineageMismatch: countRows(
      `SELECT 1 FROM runs
       LEFT JOIN mvp_automations ON mvp_automations.id = runs.automation_id
       LEFT JOIN mvp_automation_versions ON mvp_automation_versions.id = runs.automation_version_id
       WHERE (
           (runs.automation_id IS NULL OR trim(runs.automation_id) = '')
           <> (runs.automation_version_id IS NULL OR trim(runs.automation_version_id) = '')
         )
         OR (
           runs.automation_id IS NOT NULL
           AND trim(runs.automation_id) <> ''
           AND runs.automation_version_id IS NOT NULL
           AND trim(runs.automation_version_id) <> ''
           AND (
             mvp_automations.id IS NULL
             OR mvp_automation_versions.id IS NULL
             OR mvp_automations.company_id IS NULL
             OR trim(mvp_automations.company_id) = ''
             OR mvp_automation_versions.company_id IS NULL
             OR trim(mvp_automation_versions.company_id) = ''
             OR runs.company_id IS NULL
             OR trim(runs.company_id) = ''
             OR runs.company_id <> mvp_automations.company_id
             OR runs.company_id <> mvp_automation_versions.company_id
             OR mvp_automation_versions.automation_id <> mvp_automations.id
           )
         )`
    ),
    proofStepRunMismatch: countRows(
      `SELECT 1 FROM proofs
       LEFT JOIN run_steps ON run_steps.id = proofs.step_id
       WHERE proofs.step_id IS NOT NULL
         AND (
           run_steps.id IS NULL
           OR run_steps.run_id <> proofs.run_id
         )`
    )
  };

  const issues = [
    ...issueRows("blank_company", counts.blankCompany),
    ...issueRows("missing_company_fk", counts.missingCompanyFk),
    issue("orphan_run_step_run", counts.orphanRunStepRun),
    issue("orphan_approval_run", counts.orphanApprovalRun),
    issue("orphan_proof_run", counts.orphanProofRun),
    issue("orphan_worker_event_run", counts.orphanWorkerEventRun),
    issue("orphan_skill_run", counts.orphanSkillRun),
    issue("run_step_run_company_mismatch", counts.runStepRunCompanyMismatch),
    issue("approval_run_company_mismatch", counts.approvalRunCompanyMismatch),
    issue("proof_run_company_mismatch", counts.proofRunCompanyMismatch),
    issue("worker_event_run_company_mismatch", counts.workerEventRunCompanyMismatch),
    issue("research_plan_run_company_mismatch", counts.researchPlanRunCompanyMismatch),
    issue("skill_run_company_mismatch", counts.skillRunCompanyMismatch),
    issue("automation_project_company_mismatch", counts.automationProjectCompanyMismatch),
    issue("automation_current_version_mismatch", counts.automationCurrentVersionMismatch),
    issue("automation_projection_version_mismatch", counts.automationProjectionVersionMismatch),
    issue("automation_version_company_mismatch", counts.automationVersionCompanyMismatch),
    issue("automation_schedule_company_mismatch", counts.automationScheduleCompanyMismatch),
    issue("automation_schedule_version_mismatch", counts.automationScheduleVersionMismatch),
    issue("run_automation_lineage_mismatch", counts.runAutomationLineageMismatch),
    issue("proof_step_run_mismatch", counts.proofStepRunMismatch)
  ].filter((entry) => entry.count > 0);

  return { ok: issues.length === 0, counts, issues };
}

function blankCompanySql(table: string): string {
  const blank = `(company_id IS NULL OR trim(company_id) = '')`;
  return `SELECT 1 FROM ${table} WHERE ${blank}`;
}

function countBlankCompanyRows(table: string, fixedGlobalWorkflows: Map<string, string>): number {
  if (table === "runs") {
    return querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE company_id IS NULL OR trim(company_id)=''`)
      .filter((row) => !isFixedGlobalRun(row.metadata_json, fixedGlobalWorkflows)).length;
  }
  if (table === "run_steps" || table === "approvals" || table === "proofs" || table === "worker_events") {
    return querySql<{ metadata_json: string | null }>(`
      SELECT runs.metadata_json
      FROM ${table}
      LEFT JOIN runs ON runs.id=${table}.run_id
      WHERE ${table}.company_id IS NULL OR trim(${table}.company_id)=''
    `).filter((row) => !row.metadata_json || !isFixedGlobalRun(row.metadata_json, fixedGlobalWorkflows)).length;
  }
  if (table === "registered_workflows") {
    return querySql<{ id: string; runner_kind: string }>(`
      SELECT id, runner_kind FROM registered_workflows
      WHERE company_id IS NULL OR trim(company_id)=''
    `).filter((row) => fixedGlobalWorkflows.get(row.id) !== row.runner_kind).length;
  }
  return countRows(blankCompanySql(table));
}

function isFixedGlobalRun(metadataJson: string, fixedGlobalWorkflows: Map<string, string>): boolean {
  try {
    const metadata = JSON.parse(metadataJson || "{}") as Record<string, unknown>;
    const start = metadata.registered_workflow_start;
    if (!start || typeof start !== "object") return false;
    const startRecord = start as Record<string, unknown>;
    const workflowIds = [
      metadata.registeredWorkflowId,
      metadata.registered_workflow_id,
      metadata.workflowId,
      metadata.workflow_id,
      metadata.AUTOMATION_OS_REGISTERED_WORKFLOW_ID,
      startRecord.workflowId
    ]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim());
    if (workflowIds.length === 0 || new Set(workflowIds).size !== 1) return false;
    const workflowId = workflowIds[0];
    const expectedRunnerKind = typeof workflowId === "string" ? fixedGlobalWorkflows.get(workflowId) : undefined;
    const source = startRecord.source;
    const systemScope = metadata.system_scope;
    const manualIdentityValid = source === "manual"
      && isActiveUserOfKind(metadata.system_admin_actor_user_id, "human");
    const schedulerIdentity = metadata.scheduler_service_identity;
    const schedulerIdentityValid = source === "scheduler"
      && typeof schedulerIdentity === "object"
      && schedulerIdentity !== null
      && (schedulerIdentity as Record<string, unknown>).kind === "service"
      && (schedulerIdentity as Record<string, unknown>).scope === "global_system"
      && isActiveUserOfKind((schedulerIdentity as Record<string, unknown>).userId, "service");
    return typeof workflowId === "string"
      && typeof expectedRunnerKind === "string"
      && startRecord.runnerKind === expectedRunnerKind
      && systemScope === "global"
      && (manualIdentityValid || schedulerIdentityValid);
  } catch {
    return false;
  }
}

function isActiveUserOfKind(userId: unknown, kind: "human" | "service"): boolean {
  if (typeof userId !== "string" || userId.trim().length === 0) return false;
  const user = querySql<{ id: string }>(`
    SELECT id FROM users
    WHERE id=${sqlValue(userId.trim())}
      AND status='active'
      AND kind=${sqlValue(kind)}
    LIMIT 1
  `)[0];
  return Boolean(user);
}

function childRunCompanyMismatch(table: "run_steps" | "worker_events" | "skills"): number {
  return countRows(
    `SELECT 1 FROM ${table}
     INNER JOIN runs ON runs.id = ${table}.run_id
     WHERE ${table}.company_id IS NOT NULL
       AND trim(${table}.company_id) <> ''
       AND (
         runs.company_id IS NULL
         OR trim(runs.company_id) = ''
         OR runs.company_id <> ${table}.company_id
       )`
  );
}

function missingCompanyFkSql(table: string): string {
  return `SELECT 1 FROM ${table}
          WHERE company_id IS NOT NULL
            AND trim(company_id) <> ''
            AND NOT EXISTS (SELECT 1 FROM companies WHERE companies.id = ${table}.company_id)`;
}

function countRows(sql: string): number {
  const row = querySql<CountRow>(`SELECT COUNT(*) AS count FROM (${sql}) AS tenancy_audit_count`)[0];
  return Number(row?.count ?? 0);
}

function issueRows(prefix: string, counts: Record<string, number>): TenancyAuditIssue[] {
  return Object.entries(counts).map(([key, count]) => issue(`${prefix}_${key}`, count));
}

function issue(code: string, count: number): TenancyAuditIssue {
  return { code, count };
}

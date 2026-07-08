import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseAutomationToml, type AutomationTomlRecord } from "../automationHealth.js";
import type { RegisteredWorkflowRow } from "../registeredWorkflows.js";

export type CodexAutomationMigrationStatus = "registered" | "unregistered" | "inactive" | "manual_helper";
export type CodexAutomationInventorySource = "automation_toml" | "registered_workflow" | "automation_toml+registered_workflow";

export type CodexAutomationMigrationRunRow = {
  id: string;
  name: string;
  status: string;
  objective: string;
  created_at: string;
  updated_at: string;
  metadata_json: string;
};

export type CodexAutomationMigrationProofRow = {
  run_id: string;
  proof_type: string;
  created_at: string;
  metadata_json?: string;
};

export type CodexAutomationMigrationApprovalRow = {
  id?: string;
  run_id: string | null;
  status: string;
  created_at?: string;
};

export type CodexAutomationMigrationLedgerItem = {
  id: string;
  name: string;
  status: CodexAutomationMigrationStatus;
  automationStatus: string;
  rrule: string;
  path: string;
  dir: string;
  registeredWorkflowId: string | null;
  reason: string;
  inventorySource: CodexAutomationInventorySource;
  runnerKind: string | null;
  runnerStatus: string | null;
  workflowStatus: string | null;
  automationOsMigrated: boolean;
  scheduledOperationConfirmed: boolean;
  actualOperationConfirmed: boolean;
  proofConfirmed: boolean;
  latestRunId: string | null;
  latestRunStatus: string | null;
  latestRunAt: string | null;
  latestProofTypes: string[];
  proofGateOk: boolean;
  missingProofs: string[];
  remainingBlocker: string | null;
  evidenceUpdatedAt: string | null;
};

export type CodexAutomationMigrationLedger = {
  generatedAt: string;
  automationRoot: string;
  summary: Record<CodexAutomationMigrationStatus | "total", number> & {
    registeredWorkflowTotal: number;
    migrated: number;
    scheduledConfirmed: number;
    actualConfirmed: number;
    proofConfirmed: number;
    blocked: number;
  };
  items: CodexAutomationMigrationLedgerItem[];
};

export type CodexAutomationMigrationLedgerOptions = {
  automationRoot?: string;
  registeredWorkflows: RegisteredWorkflowRow[];
  runs?: CodexAutomationMigrationRunRow[];
  proofs?: CodexAutomationMigrationProofRow[];
  approvals?: CodexAutomationMigrationApprovalRow[];
  generatedAt?: string;
};

export function defaultCodexAutomationRoot(): string {
  return process.env.AUTOMATION_OS_CODEX_AUTOMATIONS_ROOT ?? join(homedir(), ".codex", "automations");
}

export function buildCodexAutomationMigrationLedger(options: CodexAutomationMigrationLedgerOptions): CodexAutomationMigrationLedger {
  const automationRoot = options.automationRoot ?? defaultCodexAutomationRoot();
  const registeredIndex = indexRegisteredWorkflows(options.registeredWorkflows);
  const matchedRegisteredWorkflowIds = new Set<string>();
  const proofIndex = indexProofs(options.proofs ?? []);
  const pendingApprovalRunIds = indexPendingApprovalRunIds(options.approvals ?? []);
  const tomlItems = listAutomationTomls(automationRoot).map((path) => {
    const automation = parseAutomationToml(readFileSync(path, "utf8"), path);
    const item = classifyAutomation(automation, registeredIndex, options.runs ?? [], proofIndex, pendingApprovalRunIds);
    if (item.registeredWorkflowId) matchedRegisteredWorkflowIds.add(item.registeredWorkflowId);
    return item;
  });
  const registeredOnlyItems = options.registeredWorkflows
    .filter((workflow) => !matchedRegisteredWorkflowIds.has(workflow.id))
    .filter((workflow) => String(workflow.status).toLowerCase() === "active")
    .map((workflow) => registeredWorkflowOnlyItem(workflow, options.runs ?? [], proofIndex, pendingApprovalRunIds));
  const items = [...tomlItems, ...registeredOnlyItems].sort((a, b) => a.id.localeCompare(b.id));
  const summary = {
    total: items.length,
    registered: 0,
    unregistered: 0,
    inactive: 0,
    manual_helper: 0,
    registeredWorkflowTotal: options.registeredWorkflows.length,
    migrated: 0,
    scheduledConfirmed: 0,
    actualConfirmed: 0,
    proofConfirmed: 0,
    blocked: 0
  };
  for (const item of items) {
    summary[item.status] += 1;
    if (item.automationOsMigrated) summary.migrated += 1;
    if (item.scheduledOperationConfirmed) summary.scheduledConfirmed += 1;
    if (item.actualOperationConfirmed) summary.actualConfirmed += 1;
    if (item.proofConfirmed) summary.proofConfirmed += 1;
    if (item.remainingBlocker) summary.blocked += 1;
  }
  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    automationRoot,
    summary,
    items
  };
}

function classifyAutomation(
  automation: AutomationTomlRecord,
  registeredIndex: Map<string, RegisteredWorkflowRow>,
  runs: CodexAutomationMigrationRunRow[],
  proofIndex: Map<string, CodexAutomationMigrationProofRow[]>,
  pendingApprovalRunIds: Set<string>
): CodexAutomationMigrationLedgerItem {
  const automationStatus = automation.status.trim();
  const normalizedStatus = automationStatus.toLowerCase();
  const registeredWorkflow = registeredIndex.get(automation.id);
  if (registeredWorkflow) {
    return ledgerItem(
      automation,
      "registered",
      registeredWorkflow,
      "matched registered_workflows by id or legacy source reference",
      "automation_toml+registered_workflow",
      runs,
      proofIndex,
      pendingApprovalRunIds
    );
  }
  if (normalizedStatus && normalizedStatus !== "active" && normalizedStatus !== "unknown") {
    return ledgerItem(
      automation,
      "inactive",
      null,
      `automation.toml status is ${automation.status}`,
      "automation_toml",
      runs,
      proofIndex,
      pendingApprovalRunIds
    );
  }
  if (isManualHelperAutomation(automation)) {
    return ledgerItem(
      automation,
      "manual_helper",
      null,
      "helper or bridge automation is audit-visible but not a native scheduled runner",
      "automation_toml",
      runs,
      proofIndex,
      pendingApprovalRunIds
    );
  }
  if (!automation.rrule.trim()) {
    return ledgerItem(
      automation,
      "manual_helper",
      null,
      "automation.toml has no rrule schedule",
      "automation_toml",
      runs,
      proofIndex,
      pendingApprovalRunIds
    );
  }
  return ledgerItem(
    automation,
    "unregistered",
    null,
    "active scheduled automation has no registered_workflows match",
    "automation_toml",
    runs,
    proofIndex,
    pendingApprovalRunIds
  );
}

function isManualHelperAutomation(automation: AutomationTomlRecord): boolean {
  const id = automation.id.toLowerCase();
  const name = automation.name.toLowerCase();
  const kind = automation.kind.toLowerCase();

  if (kind === "heartbeat" || kind === "alias") return true;
  if (id === "automation-child-launcher-bridge" || id === "ghostty-codex-autocontinue") return true;
  if (/\bmanual helper\b/.test(name)) return true;
  return /\bchild-launcher\b/.test(id) || /\bautocontinue\b/.test(id);
}

function ledgerItem(
  automation: AutomationTomlRecord,
  status: CodexAutomationMigrationStatus,
  registeredWorkflow: RegisteredWorkflowRow | null,
  reason: string,
  inventorySource: CodexAutomationInventorySource,
  runs: CodexAutomationMigrationRunRow[],
  proofIndex: Map<string, CodexAutomationMigrationProofRow[]>,
  pendingApprovalRunIds: Set<string>
): CodexAutomationMigrationLedgerItem {
  const evidence = buildEvidence(registeredWorkflow, runs, proofIndex, pendingApprovalRunIds);
  const automationOsMigrated = Boolean(registeredWorkflow) && status !== "manual_helper";
  return {
    id: automation.id,
    name: automation.name,
    status,
    automationStatus: automation.status,
    rrule: automation.rrule,
    path: automation.path,
    dir: automation.dir,
    registeredWorkflowId: registeredWorkflow?.id ?? null,
    reason,
    inventorySource,
    runnerKind: registeredWorkflow?.runner_kind ?? null,
    runnerStatus: registeredWorkflow?.runner_status ?? null,
    workflowStatus: registeredWorkflow?.status ?? null,
    automationOsMigrated,
    ...evidence
  };
}

function registeredWorkflowOnlyItem(
  workflow: RegisteredWorkflowRow,
  runs: CodexAutomationMigrationRunRow[],
  proofIndex: Map<string, CodexAutomationMigrationProofRow[]>,
  pendingApprovalRunIds: Set<string>
): CodexAutomationMigrationLedgerItem {
  const schedule = parseJsonRecord(workflow.schedule_json);
  const evidence = buildEvidence(workflow, runs, proofIndex, pendingApprovalRunIds);
  return {
    id: workflow.id,
    name: workflow.name,
    status: "registered",
    automationStatus: "",
    rrule: typeof schedule.rrule === "string" ? schedule.rrule : "",
    path: "",
    dir: "",
    registeredWorkflowId: workflow.id,
    reason: "active registered_workflows row has no matching automation.toml inventory file",
    inventorySource: "registered_workflow",
    runnerKind: workflow.runner_kind,
    runnerStatus: workflow.runner_status,
    workflowStatus: workflow.status,
    automationOsMigrated: true,
    ...evidence
  };
}

function buildEvidence(
  workflow: RegisteredWorkflowRow | null,
  runs: CodexAutomationMigrationRunRow[],
  proofIndex: Map<string, CodexAutomationMigrationProofRow[]>,
  pendingApprovalRunIds: Set<string>
) {
  const latestRun = workflow ? latestWorkflowRun(workflow, runs) : null;
  const latestRunProofs = latestRun ? proofIndex.get(latestRun.id) ?? [] : [];
  const latestRunMetadata = latestRun ? parseJsonRecord(latestRun.metadata_json) : {};
  const latestProofTypes = uniqueStrings([
    ...latestRunProofs.map((proof) => proof.proof_type),
    ...proofGateStrings(latestRunMetadata, "present")
  ]).sort();
  const missingProofs = uniqueStrings(proofGateStrings(latestRunMetadata, "missing")).sort();
  const proofGateOk = proofGateOkFromMetadata(latestRunMetadata);
  const proofConfirmed = proofGateOk || (Boolean(latestRun) && latestRunProofs.length > 0 && missingProofs.length === 0);
  const actualOperationConfirmed = Boolean(latestRun && isCompleteStatus(latestRun.status));
  const provenance = workflow ? parseJsonRecord(workflow.provenance_json) : {};
  const scheduler = isRecord(provenance.scheduler) ? provenance.scheduler : {};
  const scheduledRunId = typeof scheduler.lastRunId === "string" ? scheduler.lastRunId : null;
  const scheduledRun =
    scheduledRunId && workflow
      ? runs.find((run) => run.id === scheduledRunId && workflowMatchesRun(workflow, run)) ?? null
      : null;
  const scheduledRunMetadata = scheduledRun ? parseJsonRecord(scheduledRun.metadata_json) : {};
  const scheduledProofGateOk = scheduledRun ? proofGateOkFromMetadata(scheduledRunMetadata) : false;
  const scheduledApprovalBoundaryConfirmed = Boolean(
    workflow && scheduledRun && scheduledApprovalBoundaryConfirmedForRun(scheduledRun, scheduledRunMetadata, pendingApprovalRunIds)
  );
  const latestRunHasScheduledApprovalBoundary = Boolean(
    latestRun && scheduledRun && latestRun.id === scheduledRun.id && scheduledApprovalBoundaryConfirmed
  );
  const scheduledOperationConfirmed = Boolean(
    scheduledRun && (isCompleteStatus(scheduledRun.status) || scheduledProofGateOk || scheduledApprovalBoundaryConfirmed)
  );
  const latestProofAt = latestRunProofs.map((proof) => proof.created_at).sort().at(-1) ?? null;
  const evidenceUpdatedAt = latestProofAt ?? latestRun?.updated_at ?? workflow?.updated_at ?? null;
  return {
    scheduledOperationConfirmed,
    actualOperationConfirmed,
    proofConfirmed,
    latestRunId: latestRun?.id ?? null,
    latestRunStatus: latestRun?.status ?? null,
    latestRunAt: latestRun?.updated_at ?? null,
    latestProofTypes,
    proofGateOk,
    missingProofs,
    remainingBlocker: remainingBlocker(scheduler, latestRunMetadata, missingProofs, latestRunHasScheduledApprovalBoundary),
    evidenceUpdatedAt
  };
}

function scheduledApprovalBoundaryConfirmedForRun(
  run: CodexAutomationMigrationRunRow,
  runMetadata: Record<string, unknown>,
  pendingApprovalRunIds: Set<string>
): boolean {
  const registeredWorkflowStart = isRecord(runMetadata.registered_workflow_start) ? runMetadata.registered_workflow_start : {};
  const plan = isRecord(runMetadata.plan) ? runMetadata.plan : {};
  return (
    run.status === "waiting_approval" &&
    registeredWorkflowStart.source === "scheduler" &&
    typeof registeredWorkflowStart.dueKey === "string" &&
    registeredWorkflowStart.dueKey.trim().length > 0 &&
    plan.approvalRequired === true &&
    pendingApprovalRunIds.has(run.id)
  );
}

function latestWorkflowRun(workflow: RegisteredWorkflowRow, runs: CodexAutomationMigrationRunRow[]): CodexAutomationMigrationRunRow | null {
  const matching = runs.filter((run) => workflowMatchesRun(workflow, run));
  const effectiveMatching = matching.some((run) => !isCancelledStatus(run.status)) ? matching.filter((run) => !isCancelledStatus(run.status)) : matching;
  effectiveMatching.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  return effectiveMatching[0] ?? null;
}

function workflowMatchesRun(workflow: RegisteredWorkflowRow, run: CodexAutomationMigrationRunRow): boolean {
  const metadata = parseJsonRecord(run.metadata_json);
  const directIds = [
    metadata.registeredWorkflowId,
    metadata.registered_workflow_id,
    metadata.workflowId,
    metadata.workflow_id,
    metadata.AUTOMATION_OS_REGISTERED_WORKFLOW_ID
  ]
    .filter((value): value is string => typeof value === "string")
    .map(canonicalRegisteredWorkflowId);
  if (directIds.length > 0) return directIds.includes(canonicalRegisteredWorkflowId(workflow.id));

  const startCommand = parseJsonRecord(workflow.start_command_json);
  const researchPlanSnapshot = isRecord(metadata.research_plan_snapshot) ? metadata.research_plan_snapshot : {};
  const command = typeof startCommand.command === "string" ? startCommand.command : "";
  if (
    workflow.runner_kind === "research_plan_registered" &&
    typeof startCommand.researchPlanId === "string" &&
    researchPlanSnapshot.id === startCommand.researchPlanId
  ) {
    return true;
  }
  if (workflow.runner_kind === "research_plan_registered") return false;

  const adapter = runnerKindToAdapter(workflow.runner_kind);
  const plan = isRecord(metadata.plan) ? metadata.plan : {};
  const tasks = Array.isArray(plan.tasks) ? plan.tasks.filter(isRecord) : [];
  if (!adapter || !tasks.some((task) => task.adapter === adapter)) return false;
  return runTextMatchesWorkflow(run, workflow, command);
}

function canonicalRegisteredWorkflowId(id: string): string {
  if (id === "job-application-daily-submit-queue" || id === "job-application-follow-up-inbox-2") {
    return "job-application-manager";
  }
  return id;
}

function runTextMatchesWorkflow(run: CodexAutomationMigrationRunRow, workflow: RegisteredWorkflowRow, command: string): boolean {
  const runValues = [run.id, run.name, run.objective].map(normalizeMatchText).filter(Boolean);
  const candidates = [workflow.id, workflow.name, command].map(normalizeMatchText).filter(Boolean);
  return candidates.some((candidate) => runValues.includes(candidate));
}

function normalizeMatchText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function runnerKindToAdapter(kind: string): string | null {
  const map: Record<string, string> = {
    daily_ai_registered: "daily_ai_registered",
    nisenprints_registered: "nisenprints_registered",
    job_submit_registered: "job_submit_registered",
    job_followup_registered: "job_followup_registered",
    prompt_transfer_registered: "prompt_transfer_registered",
    sns_multi_poster_registered: "sns_multi_poster_registered",
    x_authenticated_browser_lane_registered: "x_authenticated_browser_lane_registered",
    research_plan_registered: "child_codex"
  };
  return map[kind] ?? null;
}

function remainingBlocker(
  scheduler: Record<string, unknown>,
  runMetadata: Record<string, unknown>,
  missingProofs: string[],
  ignoreMissingProofsForApprovalBoundary = false
): string | null {
  if (typeof scheduler.exactBlocker === "string" && scheduler.exactBlocker.trim()) return scheduler.exactBlocker;
  for (const key of ["blocker", "exact_blocker", "exactBlocker", "stop_reason"]) {
    const value = runMetadata[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  if (ignoreMissingProofsForApprovalBoundary) return null;
  return missingProofs.length > 0 ? `missing_proofs:${missingProofs.join(",")}` : null;
}

function proofGateOkFromMetadata(metadata: Record<string, unknown>): boolean {
  const proofGate = metadata.proof_gate;
  return isRecord(proofGate) && proofGate.ok === true;
}

function proofGateStrings(metadata: Record<string, unknown>, key: "present" | "missing"): string[] {
  const proofGate = metadata.proof_gate;
  if (!isRecord(proofGate) || !Array.isArray(proofGate[key])) return [];
  return proofGate[key].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function isCompleteStatus(status: string): boolean {
  return status === "complete" || status === "completed";
}

function isCancelledStatus(status: string): boolean {
  return status === "cancelled" || status === "canceled";
}

function indexProofs(proofs: CodexAutomationMigrationProofRow[]): Map<string, CodexAutomationMigrationProofRow[]> {
  const index = new Map<string, CodexAutomationMigrationProofRow[]>();
  for (const proof of proofs) {
    const current = index.get(proof.run_id) ?? [];
    current.push(proof);
    index.set(proof.run_id, current);
  }
  return index;
}

function indexPendingApprovalRunIds(approvals: CodexAutomationMigrationApprovalRow[]): Set<string> {
  const runIds = new Set<string>();
  for (const approval of approvals) {
    if (approval.status === "pending" && typeof approval.run_id === "string" && approval.run_id.trim()) {
      runIds.add(approval.run_id);
    }
  }
  return runIds;
}

function indexRegisteredWorkflows(workflows: RegisteredWorkflowRow[]): Map<string, RegisteredWorkflowRow> {
  const index = new Map<string, RegisteredWorkflowRow>();
  for (const workflow of workflows) {
    index.set(workflow.id, workflow);
    for (const legacyId of registeredLegacyIds(workflow)) {
      index.set(legacyId, workflow);
    }
  }
  return index;
}

function registeredLegacyIds(workflow: RegisteredWorkflowRow): string[] {
  const ids: string[] = [];
  for (const ref of parseJsonArray(workflow.source_refs_json)) {
    if (typeof ref.legacyAutomationId === "string" && ref.legacyAutomationId.trim()) {
      ids.push(ref.legacyAutomationId);
    }
    if (typeof ref.path === "string" && basename(ref.path) === "automation.toml") {
      ids.push(basename(dirname(ref.path)));
    }
  }
  const provenance = parseJsonRecord(workflow.provenance_json);
  if (typeof provenance.legacyAutomationId === "string" && provenance.legacyAutomationId.trim()) {
    ids.push(provenance.legacyAutomationId);
  }
  return ids;
}

function parseJsonArray(value: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function listAutomationTomls(root: string): string[] {
  if (!existsSync(root)) return [];
  return safeReadDir(root)
    .flatMap((entry) => {
      const path = join(root, entry);
      if (isFile(path) && entry.endsWith(".toml")) return [path];
      const nested = join(path, "automation.toml");
      return isFile(nested) ? [nested] : [];
    })
    .sort();
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path).filter((entry) => !entry.startsWith("."));
  } catch {
    return [];
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

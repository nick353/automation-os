import { querySql, querySqlAsync, sqlValue } from "../db/client.js";
import { reconcileCompanyRegistry } from "../companies/registryReconciliation.js";
import { generateCompanyBriefs, type CompanyBriefInput, type LocalBriefBundle, type LocalBriefType } from "./companyBriefs.js";

type CompanyRow = { company_id: string; display_name: string };
type AutomationRow = { record_id: string; company_id: string; name: string; worker_command_kind: string; status: string };
type ScheduleRow = { record_id: string; company_id: string; automation_id: string; kind: string; expression: string | null; timezone: string; enabled: number | boolean; status: string; next_run_at: string | null };
type WorkflowRow = { record_id: string; company_id: string | null; runner_kind: string; status: string };
type AccountRefRow = { record_id: string; company_id: string; provider: string; status: string };
type RunRow = { id: string; automation_id: string | null; status: string; updated_at: string; metadata_json: unknown };
type RunStepRow = { run_id: string; status: string; metadata_json: unknown; started_at: string | null; completed_at: string | null };
type ProofRow = { run_id: string; proof_type: string; created_at: string };

export class CompanyBriefReadbackError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "CompanyBriefReadbackError";
  }
}

export type CompanyBriefReadbackInput = {
  companyId: string;
  briefType: LocalBriefType;
  businessDate: string;
  timezone: string;
  templateVersion?: string;
};

/**
 * Build a company-scoped Brief from the current control-plane snapshot. This
 * is intentionally a read path: it queries only rows owned by the requested
 * company and delegates formatting/fingerprints to the pure generator.
 */
export function buildCompanyBriefReadback(input: CompanyBriefReadbackInput): LocalBriefBundle {
  const companyId = requiredCompanyId(input.companyId);
  const company = querySql<CompanyRow>(`
    SELECT id AS company_id, name AS display_name
    FROM companies
    WHERE id=${sqlValue(companyId)}
    LIMIT 1
  `)[0];
  if (!company) throw new CompanyBriefReadbackError("company_not_found");
  const runs = querySql<RunRow>(`
    SELECT id, automation_id, status, updated_at, metadata_json
    FROM runs
    WHERE company_id=${sqlValue(companyId)} AND automation_id IS NOT NULL
    ORDER BY updated_at DESC, id ASC
  `);
  const proofs = querySql<ProofRow>(`
    SELECT proofs.run_id, proofs.proof_type, proofs.created_at
    FROM proofs
    JOIN runs ON runs.id=proofs.run_id AND runs.company_id=${sqlValue(companyId)}
    WHERE proofs.company_id=${sqlValue(companyId)}
    ORDER BY proofs.created_at DESC, proofs.id ASC
  `);
  const runSteps = querySql<RunStepRow>(`
    SELECT run_steps.run_id, run_steps.status, run_steps.metadata_json, run_steps.started_at, run_steps.completed_at
    FROM run_steps
    JOIN runs ON runs.id=run_steps.run_id AND runs.company_id=${sqlValue(companyId)}
    WHERE runs.company_id=${sqlValue(companyId)}
    ORDER BY COALESCE(run_steps.completed_at, run_steps.started_at, '') DESC, run_steps.id ASC
  `);
  return generateCompanyBriefs(toGeneratorInput(input, company, {
    automations: querySql<AutomationRow>(`
      SELECT id AS record_id, company_id, name, worker_command_kind, status
      FROM mvp_automations
      WHERE company_id=${sqlValue(companyId)}
      ORDER BY id
    `),
    schedules: querySql<ScheduleRow>(`
      SELECT id AS record_id, company_id, automation_id, kind, expression, timezone, enabled, status, next_run_at
      FROM mvp_automation_schedules
      WHERE company_id=${sqlValue(companyId)}
      ORDER BY id
    `),
    workflows: querySql<WorkflowRow>(`
      SELECT id AS record_id, company_id, runner_kind, status
      FROM registered_workflows
      WHERE company_id=${sqlValue(companyId)}
      ORDER BY id
    `),
    accountRefs: querySql<AccountRefRow>(`
      SELECT id AS record_id, company_id, platform AS provider, status
      FROM company_connection_account_refs
      WHERE company_id=${sqlValue(companyId)}
      ORDER BY id
    `),
    runs,
    runSteps,
    proofs
  }));
}

export async function buildCompanyBriefReadbackAsync(input: CompanyBriefReadbackInput): Promise<LocalBriefBundle> {
  const companyId = requiredCompanyId(input.companyId);
  const company = (await querySqlAsync<CompanyRow>(`
    SELECT id AS company_id, name AS display_name
    FROM companies
    WHERE id=${sqlValue(companyId)}
    LIMIT 1
  `))[0];
  if (!company) throw new CompanyBriefReadbackError("company_not_found");
  // Briefs are generated during unattended morning/evening reads.  The
  // hosted PostgreSQL pool is intentionally small, so firing seven queries
  // at once can turn a transient connection/queue delay into a false 500.
  // Keep the read-only projection deterministic and bounded by reading each
  // company-owned relation in order; no provider or external effect is added.
  const automations = await querySqlAsync<AutomationRow>(`
    SELECT id AS record_id, company_id, name, worker_command_kind, status
    FROM mvp_automations
    WHERE company_id=${sqlValue(companyId)}
    ORDER BY id
  `);
  const schedules = await querySqlAsync<ScheduleRow>(`
    SELECT id AS record_id, company_id, automation_id, kind, expression, timezone, enabled, status, next_run_at
    FROM mvp_automation_schedules
    WHERE company_id=${sqlValue(companyId)}
    ORDER BY id
  `);
  const workflows = await querySqlAsync<WorkflowRow>(`
    SELECT id AS record_id, company_id, runner_kind, status
    FROM registered_workflows
    WHERE company_id=${sqlValue(companyId)}
    ORDER BY id
  `);
  const accountRefs = await querySqlAsync<AccountRefRow>(`
    SELECT id AS record_id, company_id, platform AS provider, status
    FROM company_connection_account_refs
    WHERE company_id=${sqlValue(companyId)}
    ORDER BY id
  `);
  const runs = await querySqlAsync<RunRow>(`
    SELECT id, automation_id, status, updated_at, metadata_json
    FROM runs
    WHERE company_id=${sqlValue(companyId)} AND automation_id IS NOT NULL
    ORDER BY updated_at DESC, id ASC
  `);
  const runSteps = await querySqlAsync<RunStepRow>(`
    SELECT run_steps.run_id, run_steps.status, run_steps.metadata_json, run_steps.started_at, run_steps.completed_at
    FROM run_steps
    JOIN runs ON runs.id=run_steps.run_id AND runs.company_id=${sqlValue(companyId)}
    WHERE runs.company_id=${sqlValue(companyId)}
    ORDER BY COALESCE(run_steps.completed_at, run_steps.started_at, '') DESC, run_steps.id ASC
  `);
  const proofs = await querySqlAsync<ProofRow>(`
    SELECT proofs.run_id, proofs.proof_type, proofs.created_at
    FROM proofs
    JOIN runs ON runs.id=proofs.run_id AND runs.company_id=${sqlValue(companyId)}
    WHERE proofs.company_id=${sqlValue(companyId)}
    ORDER BY proofs.created_at DESC, proofs.id ASC
  `);
  return generateCompanyBriefs(toGeneratorInput(input, company, { automations, schedules, workflows, accountRefs, runs, runSteps, proofs }));
}

function toGeneratorInput(
  input: CompanyBriefReadbackInput,
  company: CompanyRow,
  rows: { automations: AutomationRow[]; schedules: ScheduleRow[]; workflows: WorkflowRow[]; accountRefs: AccountRefRow[]; runs: RunRow[]; runSteps: RunStepRow[]; proofs: ProofRow[] }
): CompanyBriefInput {
  const registryRecords = [
    ...rows.automations.map((row) => ({
      recordId: `mvp_automation:${row.record_id}`,
      companyId: row.company_id,
      identityKey: `mvp_automation:${row.record_id}`,
      safeFields: { automation_id: row.record_id, name: row.name, runner_kind: row.worker_command_kind, status: row.status }
    })),
    ...rows.schedules.map((row) => ({
      recordId: `mvp_schedule:${row.record_id}`,
      companyId: row.company_id,
      identityKey: `mvp_schedule:${row.record_id}`,
      safeFields: { automation_id: row.automation_id, schedule_id: row.record_id, status: row.status }
    })),
    ...rows.workflows.map((row) => ({
      recordId: `registered_workflow:${row.record_id}`,
      companyId: row.company_id,
      identityKey: `registered_workflow:${row.record_id}`,
      safeFields: { runner_kind: row.runner_kind, status: row.status }
    })),
    ...rows.accountRefs.map((row) => ({
      recordId: `account_ref:${row.record_id}`,
      companyId: row.company_id,
      identityKey: `account_ref:${row.record_id}`,
      safeFields: { provider: row.provider, status: row.status }
    }))
  ];
  const reconciliation = reconcileCompanyRegistry({
    records: registryRecords,
    knownCompanies: [{ companyId: company.company_id }],
    fingerprintKey: `company-brief-readback-${company.company_id}`
  });
  const personalScope = company.company_id === "company_2560580981cedfd106b66245";
  const excludedJobAutomation = "automation_c304872764579ce2db1c5c90";
  const scopeExcludedRecords = new Map((personalScope ? [
    `mvp_automation:${excludedJobAutomation}`,
    "registered_workflow:job-application-manager",
    ...rows.schedules.filter((row) => row.automation_id === excludedJobAutomation).map((row) => `mvp_schedule:${row.record_id}`)
  ] : []).map((id) => [id, "user_excluded_job_applications"]));
  // Archived definitions stay in the registry/history, but are not current
  // work and must never produce a request to enable their schedule again.
  const archivedAutomationIds = new Set(rows.automations.filter((row) => row.status === "archived").map((row) => row.record_id));
  for (const id of archivedAutomationIds) scopeExcludedRecords.set(`mvp_automation:${id}`, "archived_automation_history");
  for (const row of rows.schedules) {
    if (archivedAutomationIds.has(row.automation_id)) scopeExcludedRecords.set(`mvp_schedule:${row.record_id}`, "archived_automation_history");
  }
  const recordDescriptions = new Map(registryRecords.map((row) => [row.recordId, {
    title: typeof (row.safeFields as Record<string, unknown>).name === "string" && String((row.safeFields as Record<string, unknown>).name).trim()
      ? String((row.safeFields as Record<string, unknown>).name)
      : `${row.recordId.split(":", 2)[0]} ${row.recordId.split(":", 2)[1]}`,
    summary: summaryFor(row.safeFields, input.briefType, input.businessDate, input.timezone, rows),
    nextAction: nextActionFor(row.safeFields, input.briefType, input.businessDate, input.timezone, rows)
  }]));
  return {
    briefType: input.briefType,
    businessDate: input.businessDate,
    timezone: input.timezone,
    templateVersion: input.templateVersion ?? "v1",
    companies: [{ companyId: company.company_id, displayName: company.display_name }],
    ...(personalScope ? { scopeNote: "今回の利用対象は会社1のGmail・Daily AI・NisenPrints・Backup・Obsidianです。求人応募は表示集計の対象外（既存設定・履歴は保持）。Runway導入とRunway必須の生成・公開は対象外で、Daily AI・NisenPrintsの非依存部分は引き続き未完項目を含めて表示します。" } : {}),
    records: reconciliation.records.map((row) => {
      const description = recordDescriptions.get(row.record_id);
      if (!description) throw new CompanyBriefReadbackError("brief_description_missing");
      return {
        recordId: row.record_id,
        companyId: row.company_id,
        matchClass: row.match_class,
        ...(scopeExcludedRecords.has(row.record_id) ? { scopeExcludedReason: scopeExcludedRecords.get(row.record_id) } : {}),
        ...description
      };
    })
  };
}

type SummaryRow = {
  name?: string | null;
  worker_command_kind?: string | null;
  automation_id?: string | null;
  runner_kind?: string | null;
  provider?: string | null;
  status?: string | null;
};

function summaryFor(row: SummaryRow, briefType: LocalBriefType, businessDate: string, timezone: string, rows: { automations: AutomationRow[]; schedules: ScheduleRow[]; runs: RunRow[]; runSteps: RunStepRow[]; proofs: ProofRow[] }): string {
  if (row.name && row.automation_id) {
    const schedule = rows.schedules.find((candidate) => candidate.automation_id === row.automation_id);
    const latestRun = rows.runs.find((candidate) => candidate.automation_id === row.automation_id);
    const period = briefType === "morning" ? "朝" : "夜";
    const observation = latestRun ? observeRun(latestRun, rows.runSteps) : null;
    const run = latestRun
      ? `直近Run=${safeStatus(latestRun.status)}${observation?.effectUnknown ? "（外部結果未確認）" : observation?.externalActionExecuted === false ? "（read-only）" : ""}（${safeTimestamp(latestRun.updated_at)}）`
      : "直近Run=未実行";
    const proof = latestRun ? proofSummary(latestRun.id, rows.proofs) : "同一Run proof=未確認";
    const blocker = observation?.exactBlocker ? ` / exact blocker=${observation.exactBlocker}` : "";
    const next = schedule?.enabled && schedule.status === "active"
      ? scheduleIsStale(schedule, businessDate, timezone)
        ? `次回=${safeSchedule(schedule.expression ?? schedule.kind)} ${safeTimezone(schedule.timezone)}（${safeTimestamp(schedule.next_run_at)} / 過去のため再計算が必要）`
        : `次回=${safeSchedule(schedule.expression ?? schedule.kind)} ${safeTimezone(schedule.timezone)}（${safeTimestamp(schedule.next_run_at)}）`
      : "次回=有効なschedule未確認";
    return `${period}確認: 登録済みautomation「${row.name}」 / 状態=${safeStatus(row.status)} / ${run} / ${proof}${blocker} / ${next}`;
  }
  if (row.worker_command_kind) return `登録済みautomation (${row.worker_command_kind}) の状態: ${row.status}`;
  if (row.automation_id) return `登録済みschedule (${row.automation_id}) の状態: ${row.status}`;
  if (row.runner_kind) return `登録済みworkflow (${row.runner_kind}) の状態: ${row.status}`;
  return `接続account reference (${row.provider}) の状態: ${row.status}`;
}

function nextActionFor(row: SummaryRow, briefType: LocalBriefType, businessDate: string, timezone: string, rows: { schedules: ScheduleRow[]; runs: RunRow[]; runSteps: RunStepRow[]; proofs: ProofRow[] }): string {
  if (!row.name || !row.automation_id) return "実行Runのprovider receipt・source同期・reconciliation・cleanupを同一Runで確認する";
  const latestRun = rows.runs.find((candidate) => candidate.automation_id === row.automation_id);
  const observation = latestRun ? observeRun(latestRun, rows.runSteps) : null;
  if (observation?.exactBlocker) return nextActionForBlocker(observation.exactBlocker);
  const schedule = rows.schedules.find((candidate) => candidate.automation_id === row.automation_id);
  if (!schedule || (schedule.enabled !== 1 && schedule.enabled !== true) || schedule.status !== "active") return "有効なscheduleを確認してから、同一Runのreadbackへ進む";
  if (scheduleIsStale(schedule, businessDate, timezone)) return "過去のnext_run_atを再計算し、scheduler・queue・workerの状態を確認してから最初のRunをread-only preflightする";
  return briefType === "morning"
    ? "今日の予定時刻に同一Runを起動し、provider receipt・source同期・reconciliation・cleanupを確認する"
    : latestRun
      ? "次回Runでもprovider receipt・source同期・reconciliation・cleanupを確認する"
      : "未実行のため、最初のRunをread-only preflightから確認する";
}

function observeRun(run: RunRow, steps: RunStepRow[]): { exactBlocker: string | null; externalActionExecuted: boolean | null; effectUnknown: boolean } {
  const step = steps.find((candidate) => candidate.run_id === run.id);
  const metadata = parseObject(step?.metadata_json);
  const runMetadata = parseObject(run.metadata_json);
  const receipt = parseObject(metadata?.portable_external_receipt) ?? parseObject(runMetadata?.remote_worker_receipt);
  const claim = parseObject(runMetadata?.remote_worker_claim);
  const exactBlocker = safeBlocker(metadata?.exact_blocker) ?? safeBlocker(receipt?.exact_blocker) ?? safeBlocker(runMetadata?.exact_blocker);
  const effectUnknown = metadata?.operation_effect_state === "unknown" || runMetadata?.operation_effect_state === "unknown"
    || (exactBlocker === "portable_remote_claim_expired_without_receipt" && !receipt && claim?.execution_mode !== "read_only");
  const positiveEffect = metadata?.external_action_executed === true || receipt?.external_action_executed === true || runMetadata?.external_action_executed === true;
  const externalActionExecuted = positiveEffect ? true : effectUnknown ? null
    : typeof receipt?.external_action_executed === "boolean" ? receipt.external_action_executed
    : typeof metadata?.external_action_executed === "boolean" ? metadata.external_action_executed : null;
  return { exactBlocker, externalActionExecuted, effectUnknown };
}

function nextActionForBlocker(blocker: string): string {
  if (blocker === "portable_remote_claim_expired_without_receipt") {
    return "同じRunのworker記録と実際の保存先を照合する。外部結果が未確認なら再実行・再送しない";
  }
  if (blocker === "gmail_provider_read_only_call_not_executed") {
    return "Gmail provider canaryを同一Runで実行し、provider receipt・source同期・reconciliation・cleanupを確認する";
  }
  if (blocker === "zeabur_codex_app_server_registry_readback_missing") {
    return "Zeabur App Server/Connector Registryの認証・readbackを復旧してから、Gmail provider canaryへ進む";
  }
  if (blocker === "local_backup_effect_requires_explicit_approval") {
    return "バックアップ対象・private remote・同一Runの実行許可を確認してからsnapshot/pushへ進む";
  }
  if (blocker === "chrome_plugin_backend_snapshot_missing") {
    return "Chrome Companion/Profile 2のfresh backend snapshotとtarget readbackを取得してから次回Runへ進む";
  }
  if (blocker === "portable_remote_immutable_collision") {
    return "同じRun/artifactのcollisionをreconcileし、新しいtarget fingerprintとidempotency keyで次回Runへ進む";
  }
  return `exact blocker「${blocker}」を解消し、fresh target/readback後に次回Runへ進む`;
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || value.length > 200_000) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function safeBlocker(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_.:-]{1,160}$/u.test(normalized) ? normalized : null;
}

function scheduleIsStale(schedule: ScheduleRow, businessDate: string, timezone: string): boolean {
  if (!schedule.next_run_at || !Number.isFinite(Date.parse(schedule.next_run_at))) return false;
  // businessDate belongs to the Brief, not to the schedule's timezone.
  const nextDate = localDateKey(schedule.next_run_at, timezone);
  return nextDate !== null && nextDate < businessDate;
}

function localDateKey(value: string, timezone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
    const fields = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return typeof fields.year === "string" && typeof fields.month === "string" && typeof fields.day === "string"
      ? `${fields.year}-${fields.month}-${fields.day}`
      : null;
  } catch {
    return null;
  }
}

function proofSummary(runId: string, proofs: ProofRow[]): string {
  const types = proofs
    .filter((proof) => proof.run_id === runId)
    .map((proof) => proof.proof_type)
    .filter((proofType) => /^[A-Za-z0-9._:-]{1,100}$/u.test(proofType))
    .filter((proofType, index, all) => all.indexOf(proofType) === index)
    .sort()
    .slice(0, 5);
  return types.length > 0
    ? `同一Run proof=${types.length}${types.length === 5 ? "+" : ""}（${types.join(",")}）`
    : "同一Run proof=未確認";
}

function safeStatus(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9._:-]{1,80}$/u.test(normalized) ? normalized : "未確認";
}

function safeTimestamp(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && Number.isFinite(Date.parse(normalized)) ? normalized : "時刻未確認";
}

function safeSchedule(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && /^[A-Za-z0-9_.*,: -]{1,100}$/u.test(normalized) ? normalized : "schedule未確認";
}

function safeTimezone(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && /^[A-Za-z0-9_+\-/]{1,100}$/u.test(normalized) ? normalized : "timezone未確認";
}

function requiredCompanyId(value: string): string {
  if (typeof value !== "string" || !value.trim()) throw new CompanyBriefReadbackError("company_id_required");
  return value.trim();
}

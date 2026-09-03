#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateCompanyBriefs } from "../apps/server/dist/briefs/companyBriefs.js";
import { reconcileCompanyRegistry } from "../apps/server/dist/companies/registryReconciliation.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const databasePath = resolve(process.env.AUTOMATION_OS_DB?.trim() || join(repositoryRoot, "data", "automation-os.sqlite"));
const databaseUri = `file://${databasePath}?immutable=1`;
const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.split("=");
  return [key, rest.join("=")];
}));
const briefType = args.get("--brief-type");
const businessDate = args.get("--business-date");
const timezone = args.get("--timezone") || "Asia/Tokyo";

if (briefType !== "morning" && briefType !== "evening") {
  fail("brief_type_required", "use --brief-type=morning or --brief-type=evening");
}
if (!businessDate) fail("business_date_required", "use --business-date=YYYY-MM-DD");
if (!existsSync(databasePath)) fail("company_brief_preview_db_missing");

const companies = readRows("SELECT id AS company_id, name AS display_name FROM companies ORDER BY id;");
const automations = readRows("SELECT id AS record_id, company_id, name, worker_command_kind, status FROM mvp_automations ORDER BY id;");
const schedules = readRows("SELECT id AS record_id, company_id, automation_id, kind, expression, timezone, enabled, status, next_run_at FROM mvp_automation_schedules ORDER BY id;");
const workflows = readRows("SELECT id AS record_id, company_id, runner_kind, status FROM registered_workflows ORDER BY id;");
const accountRefs = readRows("SELECT id AS record_id, company_id, platform AS provider, status FROM company_connection_account_refs ORDER BY id;");
const runs = readRows("SELECT id, company_id, automation_id, status, updated_at FROM runs WHERE automation_id IS NOT NULL ORDER BY updated_at DESC, id ASC;");
const proofs = readRows("SELECT company_id, run_id, proof_type, created_at FROM proofs ORDER BY created_at DESC, id ASC;");

const registryRecords = [
  ...automations.map((row) => ({
    recordId: `mvp_automation:${row.record_id}`,
    companyId: row.company_id,
    identityKey: `mvp_automation:${row.record_id}`,
    safeFields: { automation_id: row.record_id, name: row.name, runner_kind: row.worker_command_kind, status: row.status }
  })),
  ...schedules.map((row) => ({
    recordId: `mvp_schedule:${row.record_id}`,
    companyId: row.company_id,
    identityKey: `mvp_schedule:${row.record_id}`,
    safeFields: { automation_id: row.automation_id, schedule_id: row.record_id, status: row.status }
  })),
  ...workflows.filter((row) => row.company_id !== null).map((row) => ({
    recordId: `registered_workflow:${row.record_id}`,
    companyId: row.company_id,
    identityKey: `registered_workflow:${row.record_id}`,
    safeFields: { runner_kind: row.runner_kind, status: row.status }
  })),
  ...accountRefs.map((row) => ({
    recordId: `account_ref:${row.record_id}`,
    companyId: row.company_id,
    identityKey: `account_ref:${row.record_id}`,
    safeFields: { provider: row.provider, status: row.status }
  }))
];
const reconciliation = reconcileCompanyRegistry({
  records: registryRecords,
  knownCompanies: companies.map((row) => ({ companyId: row.company_id })),
  fingerprintKey: randomBytes(32).toString("hex")
});
const descriptions = new Map(registryRecords.map((row) => [row.recordId, {
  title: titleFor(row),
  summary: summaryFor(row.safeFields, briefType, businessDate, timezone, schedules, runs, proofs),
  nextAction: nextActionFor(row.safeFields, briefType, businessDate, timezone, schedules, runs, proofs)
}]));
const records = reconciliation.records.map((row) => ({
  recordId: row.record_id,
  companyId: row.company_id,
  matchClass: row.match_class,
  ...descriptions.get(row.record_id)
}));
const bundle = generateCompanyBriefs({
  briefType,
  businessDate,
  timezone,
  templateVersion: "v1",
  companies: companies.map((row) => ({ companyId: row.company_id, displayName: row.display_name })),
  records
});
process.stdout.write(`${JSON.stringify(bundle)}\n`);

function readRows(sql) {
  const result = spawnSync("sqlite3", ["-readonly", "-json", databaseUri, sql], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) fail("company_brief_preview_read_failed");
  try {
    const rows = result.stdout.trim() ? JSON.parse(result.stdout) : [];
    if (!Array.isArray(rows)) throw new Error("not_array");
    return rows;
  } catch {
    fail("company_brief_preview_snapshot_invalid");
  }
}

function titleFor(row) {
  if (typeof row.safeFields?.name === "string" && row.safeFields.name.trim()) return row.safeFields.name;
  const recordId = row.recordId;
  const [kind, id] = recordId.split(":", 2);
  return `${kind} ${id}`;
}

function summaryFor(row, period, businessDate, timezone, schedules, runs, proofs) {
  if (row.name && row.automation_id) {
    const schedule = schedules.find((candidate) => candidate.automation_id === row.automation_id);
    const latestRun = runs.find((candidate) => candidate.automation_id === row.automation_id);
    const run = latestRun ? `直近Run=${safeStatus(latestRun.status)}（${safeTimestamp(latestRun.updated_at)}）` : "直近Run=未実行";
    const proof = latestRun ? proofSummary(latestRun.id, proofs) : "同一Run proof=未確認";
    const next = schedule?.enabled && schedule.status === "active"
      ? scheduleIsStale(schedule, businessDate, timezone)
        ? `次回=${safeSchedule(schedule.expression || schedule.kind)} ${safeTimezone(schedule.timezone)}（${safeTimestamp(schedule.next_run_at)} / 過去のため再計算が必要）`
        : `次回=${safeSchedule(schedule.expression || schedule.kind)} ${safeTimezone(schedule.timezone)}（${safeTimestamp(schedule.next_run_at)}）`
      : "次回=有効なschedule未確認";
    return `${period === "morning" ? "朝" : "夜"}確認: 登録済みautomation「${row.name}」 / 状態=${safeStatus(row.status)} / ${run} / ${proof} / ${next}`;
  }
  if (row.runner_kind) return `登録済みworkflow (${row.runner_kind}) の状態: ${row.status}`;
  if (row.automation_id) return `登録済みschedule (${row.automation_id}) の状態: ${row.status}`;
  return `接続account reference (${row.provider}) の状態: ${row.status}`;
}

function nextActionFor(row, period, businessDate, timezone, schedules, runs, _proofs) {
  if (!row.name || !row.automation_id) return "実行Runのprovider receipt・source同期・reconciliation・cleanupを同一Runで確認する";
  const schedule = schedules.find((candidate) => candidate.automation_id === row.automation_id);
  const latestRun = runs.find((candidate) => candidate.automation_id === row.automation_id);
  if (!schedule || (schedule.enabled !== 1 && schedule.enabled !== true) || schedule.status !== "active") return "有効なscheduleを確認してから、同一Runのreadbackへ進む";
  if (scheduleIsStale(schedule, businessDate, timezone)) return "過去のnext_run_atを再計算し、scheduler・queue・workerの状態を確認してから最初のRunをread-only preflightする";
  return period === "morning"
    ? "今日の予定時刻に同一Runを起動し、provider receipt・source同期・reconciliation・cleanupを確認する"
    : latestRun
      ? "次回Runでもprovider receipt・source同期・reconciliation・cleanupを確認する"
      : "未実行のため、最初のRunをread-only preflightから確認する";
}

function scheduleIsStale(schedule, businessDate, _timezone) {
  if (!schedule.next_run_at || !Number.isFinite(Date.parse(schedule.next_run_at))) return false;
  const nextDate = localDateKey(schedule.next_run_at, String(schedule.timezone || "").trim() || _timezone);
  return nextDate !== null && nextDate < businessDate;
}

function localDateKey(value, timezone) {
  try {
    const fields = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    return typeof fields.year === "string" && typeof fields.month === "string" && typeof fields.day === "string" ? `${fields.year}-${fields.month}-${fields.day}` : null;
  } catch {
    return null;
  }
}

function proofSummary(runId, proofs) {
  const types = proofs
    .filter((proof) => proof.run_id === runId)
    .map((proof) => proof.proof_type)
    .filter((proofType) => /^[A-Za-z0-9._:-]{1,100}$/.test(proofType))
    .filter((proofType, index, all) => all.indexOf(proofType) === index)
    .sort()
    .slice(0, 5);
  return types.length > 0
    ? `同一Run proof=${types.length}${types.length === 5 ? "+" : ""}（${types.join(",")}）`
    : "同一Run proof=未確認";
}

function safeStatus(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9._:-]{1,80}$/.test(normalized) ? normalized : "未確認";
}

function safeTimestamp(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && Number.isFinite(Date.parse(normalized)) ? normalized : "時刻未確認";
}

function safeSchedule(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && /^[A-Za-z0-9_.*,: -]{1,100}$/.test(normalized) ? normalized : "schedule未確認";
}

function safeTimezone(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized && /^[A-Za-z0-9_+\/-]{1,100}$/.test(normalized) ? normalized : "timezone未確認";
}

function fail(code, usage) {
  process.stderr.write(`${code}${usage ? `: ${usage}` : ""}\n`);
  process.exit(1);
}

#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

const repoRoot = resolve(process.env.AUTOMATION_OS_REPO_ROOT || process.cwd());
const automationRoot = resolve(process.env.CODEX_AUTOMATIONS_ROOT || `${process.env.HOME || ""}/.codex/automations`);
const dbPath = resolve(process.env.AUTOMATION_OS_DB || join(repoRoot, "data", "automation-os.sqlite"));
// The registered Codex App prompts and the portable remote worker both use
// Company 1's current production scope. A local SQLite scope is diagnostic
// only until an owner explicitly aligns it; it must never silently win here.
const expectedCompanyId = process.env.AOS_TRIGGER_PARITY_COMPANY_ID
  || process.env.AOS_CANONICAL_COMPANY_ID
  || "company_2560580981cedfd106b66245";
const LOCAL_SCOPE_BLOCKER = "aos_local_diagnostic_scope_not_authorized_for_claim";
const triggerPath = "scripts/aos-trigger.mjs";
const triggerWrapperPath = "/.local/bin/aos-trigger-zeabur";
const remoteBaseUrl = String(process.env.AOS_PARITY_AOS_BASE_URL || "").replace(/\/$/u, "");
const remoteToken = process.env.AOS_PARITY_AOS_TOKEN || process.env.AOS_TRIGGER_TOKEN || "";
const scheduleFixture = process.env.AOS_PARITY_SCHEDULES_JSON || "";

function field(text, name) {
  return text.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "mu"))?.[1] ?? null;
}

function parseRrule(rrule) {
  const parts = Object.fromEntries(String(rrule || "").replace(/^RRULE:/u, "").split(";").map((part) => {
    const [key, value] = part.split("=", 2);
    return [key, value];
  }));
  const hour = String(parts.BYHOUR || "").padStart(2, "0");
  const minute = String(parts.BYMINUTE || "").padStart(2, "0");
  if (parts.FREQ === "WEEKLY" && parts.BYDAY) {
    const days = parts.BYDAY.split(",").filter(Boolean);
    if (days.length === 7) return `${hour}:${minute}`;
    const dayNames = { MO: "MON", TU: "TUE", WE: "WED", TH: "THU", FR: "FRI", SA: "SAT", SU: "SUN" };
    return `${dayNames[days[0]] || days[0]} ${hour}:${minute}`;
  }
  if (parts.FREQ === "DAILY") return `${hour}:${minute}`;
  return null;
}

function parseRegisteredToml(path) {
  const text = readFileSync(path, "utf8");
  const id = field(text, "id");
  const rrule = field(text, "rrule");
  const status = field(text, "status");
  const promptStart = text.indexOf("prompt = ");
  const promptEnd = text.indexOf("\nstatus =", promptStart);
  const prompt = promptStart >= 0 && promptEnd > promptStart ? text.slice(promptStart, promptEnd) : "";
  const company = prompt.match(/--company\s+([A-Za-z0-9_:-]+)/u)?.[1] ?? null;
  const automation = prompt.match(/--automation\s+([A-Za-z0-9_:-]+)/u)?.[1] ?? null;
  const hasBridge = prompt.includes("AOS_TRIGGER_BRIDGE_V1") && (prompt.includes(triggerPath) || prompt.includes(triggerWrapperPath));
  const hasNoEffectContract = prompt.includes("no-effect trigger") || prompt.includes("preflight_no_effect");
  return { path, id, rrule, status, company, automation, hasBridge, hasNoEffectContract, expectedExpression: parseRrule(rrule) };
}

async function readRemoteSchedules() {
  if (!remoteToken) throw new Error("aos_remote_machine_token_required");
  const headers = { authorization: `Bearer ${remoteToken}`, accept: "application/json" };
  async function getJson(path) {
    const response = await fetch(`${remoteBaseUrl}${path}`, { headers, redirect: "error" });
    if (!response.ok) throw new Error(`aos_remote_readback_http_${response.status}`);
    return response.json();
  }
  const catalog = await getJson(`/api/v1/companies/${encodeURIComponent(expectedCompanyId)}/automations`);
  const automations = Array.isArray(catalog?.automations) ? catalog.automations : [];
  return Promise.all(automations.map(async (automation) => {
    const schedulePayload = await getJson(`/api/v1/companies/${encodeURIComponent(expectedCompanyId)}/automations/${encodeURIComponent(automation.id)}/schedule`);
    const schedule = schedulePayload?.schedule || {};
    return {
      id: automation.id,
      name: automation.name,
      company_id: schedule.companyId || automation.company_id || automation.companyId,
      automation_status: String(automation.status || "").toLowerCase(),
      kind: schedule.kind,
      expression: schedule.expression,
      timezone: schedule.timezone,
      enabled: schedule.enabled,
      schedule_status: String(schedule.status || "").toLowerCase()
    };
  }));
}

let schedules;
let aosSource;
let localCompanyIds = [];
try {
  if (scheduleFixture) {
    const parsed = JSON.parse(scheduleFixture);
    if (!Array.isArray(parsed)) throw new Error("aos_schedule_fixture_invalid");
    schedules = parsed;
    aosSource = { kind: "fixture" };
  } else if (remoteBaseUrl) {
    schedules = await readRemoteSchedules();
    aosSource = { kind: "zeabur_https", base_url: remoteBaseUrl };
  } else {
    if (!existsSync(dbPath)) throw new Error("aos_sqlite_missing");
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    localCompanyIds = db.prepare(`
      SELECT company_id, COUNT(*) AS automation_count
      FROM mvp_automations
      WHERE trim(company_id)!=''
      GROUP BY company_id
      ORDER BY company_id
    `).all().map((row) => ({ company_id: row.company_id, automation_count: Number(row.automation_count) }));
    schedules = db.prepare(`
      SELECT a.id, a.name, a.company_id, a.status AS automation_status,
             s.kind, s.expression, s.timezone, s.enabled, s.status AS schedule_status
      FROM mvp_automations a
      LEFT JOIN mvp_automation_schedules s
        ON s.automation_id=a.id AND s.company_id=a.company_id
      WHERE a.company_id=?
      ORDER BY a.id
    `).all(expectedCompanyId);
    db.close();
    aosSource = { kind: "sqlite", path: dbPath };
  }
} catch (error) {
  const blocker = String(error?.message || "aos_parity_readback_failed").replace(/[^a-z0-9_:-]/giu, "_").slice(0, 120);
  console.log(JSON.stringify({
    schema: "aos_codex_app_trigger_parity.v1",
    status: "blocked",
    exact_blocker: blocker,
    external_action_executed: false,
    secret_values_read: false,
    next_action: "Provide a fresh protected AOS readback or repair the local AOS source/runtime binding, then rerun this read-only parity check."
  }, null, 2));
  process.exit(2);
}

const registeredAll = readdirSync(automationRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(automationRoot, entry.name, "automation.toml"))
  .filter((path) => existsSync(path))
  .map(parseRegisteredToml);
const registered = registeredAll.filter((entry) => entry.company === expectedCompanyId);

const byAutomation = new Map(schedules.map((row) => [row.id, row]));
const entries = registered.map((entry) => {
  const aos = entry.automation ? byAutomation.get(entry.automation) : undefined;
  const mismatch = [];
  if (!entry.id || entry.status !== "ACTIVE") mismatch.push("codex_app_registration_not_active");
  if (!entry.hasBridge || !entry.hasNoEffectContract) mismatch.push("codex_app_prompt_not_aos_no_effect_bridge");
  if (!entry.company || !entry.automation) mismatch.push("codex_app_trigger_binding_missing");
  if (!aos) mismatch.push("aos_automation_binding_missing");
  if (aos && (aos.company_id !== expectedCompanyId || aos.automation_status !== "active" || aos.schedule_status !== "active" || Number(aos.enabled) !== 1 || aos.timezone !== "Asia/Tokyo")) mismatch.push("aos_schedule_not_active_or_company_scoped");
  if (aos && entry.expectedExpression !== aos.expression) mismatch.push("codex_app_aos_schedule_expression_mismatch");
  return {
    codex_app_id: entry.id,
    codex_app_path: entry.path,
    aos_automation_id: entry.automation,
    company_id: entry.company,
    codex_app_rrule: entry.rrule,
    aos_expression: aos?.expression ?? null,
    timezone: aos?.timezone ?? null,
    status: mismatch.length ? "mismatch" : "matched",
    exact_blockers: mismatch
  };
});

const expectedAutomationCount = schedules.length;
if (aosSource.kind === "sqlite" && localCompanyIds.length > 0 && !localCompanyIds.some((row) => row.company_id === expectedCompanyId)) {
  entries.unshift({
    status: "mismatch",
    exact_blockers: [LOCAL_SCOPE_BLOCKER],
    historical_parity_blocker: "aos_scope_alignment_required",
    expected_company_id: expectedCompanyId,
    local_company_ids: localCompanyIds,
    registered_company_ids: [...new Set(registeredAll.map((entry) => entry.company).filter(Boolean))],
    aos_count: expectedAutomationCount
  });
} else if (registered.length === 0 && registeredAll.length > 0) {
  entries.push({
    status: "mismatch",
    exact_blockers: [LOCAL_SCOPE_BLOCKER],
    historical_parity_blocker: "aos_scope_alignment_required",
    expected_company_id: expectedCompanyId,
    registered_count: 0,
    registered_total_count: registeredAll.length,
    registered_company_ids: [...new Set(registeredAll.map((entry) => entry.company).filter(Boolean))],
    aos_count: expectedAutomationCount
  });
} else if (registered.length !== expectedAutomationCount) {
  entries.push({ status: "mismatch", exact_blockers: ["codex_app_aos_automation_count_mismatch"], registered_count: registered.length, aos_count: expectedAutomationCount });
}
const mismatches = entries.filter((entry) => entry.status === "mismatch");
const exactBlocker = mismatches.length ? mismatches[0].exact_blockers[0] : null;
const result = {
  schema: "aos_codex_app_trigger_parity.v1",
  generated_at: new Date().toISOString(),
  company_id: expectedCompanyId,
  codex_app_automation_root: automationRoot,
  aos_database_path: aosSource.kind === "sqlite" ? dbPath : null,
  aos_source: aosSource,
  registered_count: registered.length,
  registered_total_count: registeredAll.length,
  registered_company_ids: [...new Set(registeredAll.map((entry) => entry.company).filter(Boolean))],
  local_company_ids: localCompanyIds,
  aos_count: expectedAutomationCount,
  entries,
  status: mismatches.length ? "blocked" : "matched",
  exact_blocker: exactBlocker,
  external_action_executed: false,
  secret_values_read: false,
  next_action: exactBlocker === LOCAL_SCOPE_BLOCKER
    ? "Obtain a fresh protected AOS schedule readback for the registered Codex App company scope, select one authoritative company/endpoint, then rerun this read-only parity check; do not rewrite either scope from this audit."
    : mismatches.length
      ? "Repair the Codex App registration through the official PAUSED -> update -> audit -> ACTIVE lifecycle, then rerun this read-only parity check."
      : "Codex App may remain a thin AOS trigger; execute the AOS receipt/readback contract only."
};
console.log(JSON.stringify(result, null, 2));
process.exitCode = mismatches.length ? 2 : 0;

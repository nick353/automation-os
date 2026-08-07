import { listActorCompanies } from "../companies/repository.js";
import { runResearchPlanSchedulerOnce } from "../index.js";

const now = parseSchedulerNow(process.env.AUTOMATION_OS_SCHEDULER_NOW);
const allowedCompanyIds = parseAllowedCompanyIds(process.env.AUTOMATION_OS_SCHEDULER_ALLOWED_COMPANY_IDS);
const scopeRoles = parseScopeRoles(process.env.AUTOMATION_OS_SCHEDULER_SCOPE_ROLES);

try {
  const scopedCompanyIds = allowedCompanyIds ?? (scopeRoles ? listActorCompanies()
    .filter((company) => scopeRoles.includes(company.role))
    .map((company) => company.id) : undefined);
  if (scopeRoles && (!scopedCompanyIds || scopedCompanyIds.length === 0)) {
    writePayload({ ok: false, exactBlocker: "company_scope_forbidden" });
  } else {
    const result = await runResearchPlanSchedulerOnce(now, scopedCompanyIds);
    writePayload({ ok: true, result });
  }
} catch {
  // Never print database errors, URLs, paths, or inherited environment values.
  process.exitCode = 1;
  writePayload({ ok: false, exactBlocker: "research_plan_scheduler_failed" });
}

function parseSchedulerNow(value: string | undefined): Date {
  if (!value?.trim()) return new Date();
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function parseAllowedCompanyIds(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
  } catch {
    return undefined;
  }
}

function parseScopeRoles(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function writePayload(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

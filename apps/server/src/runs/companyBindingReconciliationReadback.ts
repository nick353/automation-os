import { dbBackend, dbPath, nowIso, querySql, querySqlAsync, sqlValue } from "../db/client.js";
import { buildCompanyBindingReconciliationV1, readConfiguredCanonicalCompanyAuthority, type CompanyBindingReconciliationReferenceInput } from "./companyBindingReconciliation.js";
import { DEFAULT_CODEX_TRIGGER_COMPANY_ID } from "./companyBindingReadiness.js";
import { readRegisteredAutomationSources } from "./registeredAutomationSourceReadback.js";

type CompanyRow = { company_id: string; name: string; status: string; automation_count: number | string };
type AutomationRow = { company_id: string; id: string };
type ScheduleRow = { company_id: string; id: string };
type AccountRow = { company_id: string; platform: string; status: string; verification_status: string };
type ServiceMembershipRow = { company_id: string };

async function readRows<T>(sql: string): Promise<T[]> {
  return dbBackend === "postgres" ? querySqlAsync<T>(sql) : querySql<T>(sql);
}

/**
 * Build the same reconciliation schema used by the CLI from current local
 * SQL and non-sensitive registered-trigger metadata. This function is GET
 * only and does not claim, select, schedule, notify, or call a provider.
 */
export async function readCompanyBindingReconciliationV1(options: {
  now?: string;
  companyId?: string | null;
  triggerCompanyId?: string | null;
  automationRoot?: string;
} = {}) {
  const now = options.now ?? nowIso();
  const companyId = options.companyId?.trim() || null;
  const companyPredicate = companyId ? ` WHERE companies.id=${sqlValue(companyId)}` : "";
  const scopedPredicate = companyId ? ` WHERE company_id=${sqlValue(companyId)}` : "";
  const [companies, automations, schedules, accountRefs] = await Promise.all([
    readRows<CompanyRow>(`
      SELECT companies.id AS company_id, companies.name, companies.status, COUNT(mvp_automations.id) AS automation_count
      FROM companies
      LEFT JOIN mvp_automations ON mvp_automations.company_id=companies.id
      ${companyPredicate}
      GROUP BY companies.id, companies.name, companies.status
      ORDER BY companies.id
    `),
    readRows<AutomationRow>(`SELECT company_id, id FROM mvp_automations${scopedPredicate} ORDER BY company_id, id`),
    readRows<ScheduleRow>(`SELECT company_id, id FROM mvp_automation_schedules${scopedPredicate} ORDER BY company_id, id`),
    readRows<AccountRow>(`SELECT company_id, platform, status, verification_status FROM company_connection_account_refs${scopedPredicate} ORDER BY company_id, platform`)
  ]);
  const serviceUserId = process.env.AUTOMATION_OS_DURABLE_SERVICE_USER_ID?.trim() ?? "";
  const serviceIdentityConfigured = serviceUserId.length > 0 && (await readRows<{ id: string }>(`
    SELECT id FROM users
    WHERE id=${sqlValue(serviceUserId)} AND kind='service' AND status='active'
    LIMIT 1
  `)).length > 0;
  const serviceMemberships = serviceIdentityConfigured
    ? await readRows<ServiceMembershipRow>(`
        SELECT company_memberships.company_id
        FROM company_memberships
        WHERE company_memberships.user_id=${sqlValue(serviceUserId)}
          AND company_memberships.role='operator'
          AND company_memberships.status='active'
        ORDER BY company_memberships.company_id
      `)
    : [];
  const serviceMembershipCompanyIds = new Set(serviceMemberships.map((row) => row.company_id));
  const canonicalAuthority = readConfiguredCanonicalCompanyAuthority();
  const references: Record<string, CompanyBindingReconciliationReferenceInput> = {};
  for (const row of companies) {
    const rows = accountRefs.filter((account) => account.company_id === row.company_id);
    references[row.company_id] = {
      service_identity_configured: serviceIdentityConfigured && serviceMembershipCompanyIds.has(row.company_id),
      service_identity_source: serviceUserId
        ? "environment_plus_active_operator_membership_readonly_readback"
        : "missing_environment_service_identity",
      account_ref_count: rows.length,
      verified_account_ref_count: rows.filter((account) => account.status === "active" && account.verification_status === "verified").length,
      account_platforms: rows.map((account) => account.platform),
      provider_authority_fresh: false,
      browser_authority_fresh: false,
      brief_home_readback_available: true,
      brief_delivery_configured: process.env.AOS_BRIEF_DELIVERY_MODE === "home_only",
      chat_consultation_available: true,
      chat_read_only_demo_available: true,
      chat_approval_preview_available: true,
      chat_registration_ready: canonicalAuthority?.applied === true && canonicalAuthority.company_id === row.company_id
    };
  }
  const triggerCompanyId = options.triggerCompanyId ?? process.env.AOS_TRIGGER_PARITY_COMPANY_ID ?? DEFAULT_CODEX_TRIGGER_COMPANY_ID;
  const registered = readRegisteredAutomationSources({ root: options.automationRoot });
  const visibleCompanyIds = new Set([companyId, triggerCompanyId].filter((value): value is string => typeof value === "string" && value.trim() !== ""));
  const triggerSources = registered.entries.filter((entry) => entry.company_id === null || visibleCompanyIds.has(entry.company_id));
  return buildCompanyBindingReconciliationV1({
    now,
    requested_company_id: companyId,
    trigger_company_id: triggerCompanyId,
    trigger_provenance: "codex_app_registered_trigger_readback",
    trigger_sources: triggerSources,
    local_companies: companies.map((row) => ({
      company_id: row.company_id,
      name: row.name,
      status: row.status,
      automation_count: Number(row.automation_count),
      automation_ids: automations.filter((automation) => automation.company_id === row.company_id).map((automation) => automation.id),
      schedule_ids: schedules.filter((schedule) => schedule.company_id === row.company_id).map((schedule) => schedule.id),
      provenance: "local_sql_company_and_automation_readback"
    })),
    reference_observations: references,
    explicit_authority: canonicalAuthority ?? undefined
  });
}

export const companyBindingReconciliationReadbackMetadata = {
  backend: dbBackend,
  database_path: dbBackend === "sqlite" ? dbPath : null,
  read_only: true,
  external_action_executed: false
} as const;

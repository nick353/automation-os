import { companyRoles, listActorCompanies, requireCompanyAccess } from "../companies/repository.js";
import { getMvpStateReadback } from "../index.js";

try {
  const requestedCompanyId = process.env.AUTOMATION_OS_MVP_STATE_COMPANY_ID?.trim() ?? "";
  const companies = listActorCompanies();
  const companyIds = requestedCompanyId
    ? [requireCompanyAccess(requestedCompanyId, companyRoles).id]
    : companies.map((company) => company.id);
  writePayload({ ok: true, state: getMvpStateReadback(companyIds) });
} catch (error) {
  const exactBlocker = error instanceof Error && [
    "company_scope_forbidden",
    "company_project_scope_mismatch",
    "project_id_required"
  ].includes(error.message)
    ? error.message
    : "mvp_state_read_failed";
  writePayload({ ok: false, exactBlocker });
}

function writePayload(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

import { dbBackend } from "../db/client.js";
import { companyRoles, listActorCompanies, requireCompanyAccess } from "../companies/repository.js";
import { classifyPostgresMvpStateError, readPostgresMvpState } from "../runs/postgresMvpState.js";
import { getMvpStateReadbackAsync } from "../index.js";

try {
  const requestedCompanyId = process.env.AUTOMATION_OS_MVP_STATE_COMPANY_ID?.trim() ?? "";
  // PostgreSQL is the production source of truth. Do not call the legacy
  // synchronous projection in this read-only child: it spawns one blocking
  // worker per query and can time out while the HTTP server's async snapshot
  // path is healthy. Keep the child contract, but use the same async pool
  // readback as /api/mvp/state.
  if (dbBackend === "postgres") {
    writePayload({
      ok: true,
      state: await readPostgresMvpState({ companyId: requestedCompanyId || undefined })
    });
  } else {
  const companies = listActorCompanies();
  const companyIds = requestedCompanyId
    ? [requireCompanyAccess(requestedCompanyId, companyRoles).id]
    : companies.map((company) => company.id);
  writePayload({ ok: true, state: await getMvpStateReadbackAsync(companyIds) });
  }
} catch (error) {
  const exactBlocker = error instanceof Error && [
    "company_scope_forbidden",
    "company_project_scope_mismatch",
    "project_id_required"
  ].includes(error.message)
    ? error.message
    : dbBackend === "postgres"
      ? classifyPostgresMvpStateError(error) ?? "mvp_state_postgres_read_failed"
    : "mvp_state_read_failed";
  writePayload({ ok: false, exactBlocker });
}

function writePayload(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

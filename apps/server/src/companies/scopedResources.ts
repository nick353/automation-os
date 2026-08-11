import { querySql, querySqlAsync, sqlValue } from "../db/client.js";

export type ScopedRunRow = Record<string, unknown> & {
  id: string;
  company_id: string;
  name: string;
};

export type ScopedApprovalRow = Record<string, unknown> & {
  id: string;
  company_id: string;
  run_id: string | null;
  status: string;
  requested_by: string;
  approval_group_id: string;
  resource_locks_json: string;
  created_at: string;
};

export type ScopedProofRow = Record<string, unknown> & {
  id: string;
  company_id: string;
  run_id: string;
};

export function scopedCompanyPredicate(column: string, companyIds: readonly string[]): string {
  const normalized = [...new Set(companyIds.map((value) => value.trim()).filter(Boolean))];
  if (normalized.length === 0) return "1=0";
  return `${column} IN (${normalized.map((companyId) => sqlValue(companyId)).join(", ")})`;
}

export function findScopedRun(runId: string, companyIds: readonly string[]): ScopedRunRow | undefined {
  return querySql<ScopedRunRow>(`
    SELECT runs.*
    FROM runs
    WHERE runs.id=${sqlValue(runId)}
      AND ${scopedCompanyPredicate("runs.company_id", companyIds)}
    LIMIT 1
  `)[0];
}

export async function findScopedRunAsync(runId: string, companyIds: readonly string[]): Promise<ScopedRunRow | undefined> {
  return (await querySqlAsync<ScopedRunRow>(`
    SELECT runs.*
    FROM runs
    WHERE runs.id=${sqlValue(runId)}
      AND ${scopedCompanyPredicate("runs.company_id", companyIds)}
    LIMIT 1
  `))[0];
}

export function findScopedApproval(approvalId: string, companyIds: readonly string[]): ScopedApprovalRow | undefined {
  return querySql<ScopedApprovalRow>(`
    SELECT approvals.*
    FROM approvals
    LEFT JOIN runs
      ON runs.id=approvals.run_id
     AND runs.company_id=approvals.company_id
    WHERE approvals.id=${sqlValue(approvalId)}
      AND ${scopedCompanyPredicate("approvals.company_id", companyIds)}
      AND (approvals.run_id IS NULL OR runs.id IS NOT NULL)
    LIMIT 1
  `)[0];
}

export function findScopedProof(proofId: string, companyIds: readonly string[]): ScopedProofRow | undefined {
  return querySql<ScopedProofRow>(`
    SELECT proofs.*
    FROM proofs
    JOIN runs
      ON runs.id=proofs.run_id
     AND runs.company_id=proofs.company_id
    WHERE proofs.id=${sqlValue(proofId)}
      AND ${scopedCompanyPredicate("proofs.company_id", companyIds)}
    LIMIT 1
  `)[0];
}

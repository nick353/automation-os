export type ApprovalReadStatus = "pending" | "approved" | "rejected" | "cancelled";

export type ApprovalReadFilters = {
  companyId: string;
  runId: string;
  status?: ApprovalReadStatus;
  actionKind?: string;
};

export type ApprovalReadback = {
  ok: true;
  company_scope: { enforced: true; company_id: string };
  query: { limit: 20; run_id: string; status?: ApprovalReadStatus; action_kind?: string };
  count: number;
  approvals: Array<Record<string, unknown>>;
};

export type CompanyApprovalListReadback = {
  ok: true;
  company_scope: { enforced: true; company_id: string };
  query: { limit: number; run_id: string | null; status: string | null; action_kind: string | null };
  count: number;
  approvals: Array<Record<string, unknown>>;
};

export function companyApprovalListReadbackUrl(companyId: string): string {
  return `/api/v1/companies/${encodeURIComponent(companyId)}/approvals?limit=20`;
}

export function validateCompanyApprovalListReadback(value: unknown, companyId: string): CompanyApprovalListReadback {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("approval_list_readback_invalid_json");
  const body = value as Record<string, any>;
  const scope = body.company_scope;
  const query = body.query;
  if (body.ok !== true || !scope || scope.enforced !== true || scope.company_id !== companyId
    || !query || query.limit !== 20 || !Number.isInteger(body.count) || !Array.isArray(body.approvals)
    || body.approvals.some((approval: unknown) => !approval || typeof approval !== "object" || Array.isArray(approval)
      || String((approval as Record<string, unknown>).company_id ?? "") !== companyId)) {
    throw new Error("approval_list_readback_scope_mismatch");
  }
  return body as CompanyApprovalListReadback;
}

export function buildApprovalReadbackQuery(filters: ApprovalReadFilters): string {
  const params = new URLSearchParams();
  params.set("run_id", filters.runId);
  if (filters.status) params.set("status", filters.status);
  if (filters.actionKind) params.set("action_kind", filters.actionKind);
  params.set("limit", "20");
  return params.toString();
}

export function approvalReadbackUrl(filters: ApprovalReadFilters): string {
  return `/api/v1/companies/${encodeURIComponent(filters.companyId)}/approvals?${buildApprovalReadbackQuery(filters)}`;
}

export function validateApprovalReadback(value: unknown, filters: ApprovalReadFilters): ApprovalReadback {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("approval_readback_invalid_json");
  const body = value as Record<string, any>;
  const scope = body.company_scope;
  const query = body.query;
  const expectedAction = filters.actionKind || undefined;
  if (body.ok !== true || !scope || scope.enforced !== true || scope.company_id !== filters.companyId
    || !query || query.limit !== 20 || query.run_id !== filters.runId
    || (query.status ?? undefined) !== filters.status
    || (query.action_kind ?? undefined) !== expectedAction
    || !Number.isInteger(body.count) || !Array.isArray(body.approvals)) {
    throw new Error("approval_readback_contract_mismatch");
  }
  return body as ApprovalReadback;
}

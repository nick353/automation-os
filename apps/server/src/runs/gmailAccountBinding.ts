import type { AutomationRecord, CompanyConnectionRefRecord } from "../automations/repository.js";

export const GMAIL_EXECUTION_TARGET_SCHEMA = "aos.gmail_execution_target_readback.v1" as const;
export type GmailExecutionTargetState = "not_required" | "unbound" | "bound" | "unknown_ref" | "company_mismatch" | "competing" | "non_gmail" | "revoked" | "expired" | "unverified" | "scope_insufficient";
export type GmailExecutionTargetReadback = {
  schema: typeof GMAIL_EXECUTION_TARGET_SCHEMA; required: boolean; state: GmailExecutionTargetState;
  canonical_workflow_id: string | null; company_id: string; connection_ref_id: string | null; account_ref: string | null;
  connection_evidence: "not_required" | "verified" | "available_unverified" | "missing";
  binding_evidence: "explicit_connection_ref" | "explicit_account_ref" | "explicit_pair" | "none" | "conflict";
  scope: { company_id: string; platform: "gmail" | "unknown"; required: string[] }; exact_blocker: string | null;
  next_action: string; external_action_allowed: false;
};

function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function canonicalWorkflowId(spec: Record<string, unknown>): string {
  const adapter = object(spec.workflowAdapter ?? spec.workflow_adapter);
  return text(spec.canonicalWorkflowId ?? spec.canonical_workflow_id ?? adapter?.workflow_id ?? adapter?.workflowId);
}
function executionTarget(spec: Record<string, unknown>): Record<string, unknown> | null { return object(spec.execution_target ?? spec.executionTarget); }
function targetValue(target: Record<string, unknown>, snake: string, camel: string): string { return text(target[snake] ?? target[camel]); }
function targetValues(target: Record<string, unknown>, snake: string, camel: string): string[] {
  return [...new Set([text(target[snake]), text(target[camel]).trim()].filter(Boolean))];
}
function isGmail(ref: CompanyConnectionRefRecord): boolean { return ["gmail", "mail"].includes(ref.platform.trim().toLowerCase()); }
function isRevoked(ref: CompanyConnectionRefRecord): boolean { return Boolean(ref.revokedAt) || ["revoked", "reconnect_required"].includes(ref.status.trim().toLowerCase()); }
function isExpired(ref: CompanyConnectionRefRecord, now: number): boolean {
  if (!ref.expiresAt) return false;
  const expiresAt = Date.parse(ref.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}
function isVerified(ref: CompanyConnectionRefRecord): boolean {
  return ref.status.trim().toLowerCase() === "verified" && ref.verificationStatus.trim().toLowerCase() === "verified" && ["connected", "not_applicable"].includes(ref.oauthState.trim().toLowerCase());
}
function hasReadScope(ref: CompanyConnectionRefRecord): boolean {
  const scopes = new Set(ref.scopes.map((scope) => scope.trim().toLowerCase()));
  return scopes.has("read") || scopes.has("gmail.read") || scopes.has("gmail.readonly") || scopes.has("https://www.googleapis.com/auth/gmail.readonly");
}

export function resolveGmailExecutionTarget(
  automation: Pick<AutomationRecord, "companyId" | "builderSpec"> & { id?: string }, refs: readonly CompanyConnectionRefRecord[], now: Date | string | number = Date.now()
): GmailExecutionTargetReadback {
  const spec = object(automation.builderSpec) ?? {};
  const canonical = canonicalWorkflowId(spec);
  const base = { schema: GMAIL_EXECUTION_TARGET_SCHEMA, required: canonical === "email-review-reply", canonical_workflow_id: canonical || null, company_id: automation.companyId, scope: { company_id: automation.companyId, platform: "gmail" as const, required: ["read"] }, external_action_allowed: false as const };
  if (canonical !== "email-review-reply") return { ...base, state: "not_required", connection_ref_id: null, account_ref: null, connection_evidence: "not_required", binding_evidence: "none", exact_blocker: null, next_action: "このworkflowはGmail execution targetを要求しません。" };

  const target = executionTarget(spec);
  const connectionIds = target ? targetValues(target, "connection_ref_id", "connectionRefId") : [];
  const accountRefs = target ? targetValues(target, "account_ref", "accountRef") : [];
  const requestedConnectionId = connectionIds[0] ?? "";
  const requestedAccountRef = accountRefs[0] ?? "";
  const requestedCompanyId = target ? targetValue(target, "company_id", "companyId") : "";
  const bindingEvidence = requestedConnectionId && requestedAccountRef ? "explicit_pair" : requestedConnectionId ? "explicit_connection_ref" : requestedAccountRef ? "explicit_account_ref" : "none";
  const nowMs = typeof now === "number" ? now : new Date(now).getTime();
  const companyRefs = refs.filter((ref) => ref.companyId === automation.companyId);
  const verifiedCompanyRef = companyRefs.find((ref) => isGmail(ref) && isVerified(ref) && !isRevoked(ref) && !isExpired(ref, nowMs));
  if (!requestedConnectionId && !requestedAccountRef) return { ...base, state: "unbound", connection_ref_id: null, account_ref: null, connection_evidence: verifiedCompanyRef ? "verified" : companyRefs.some(isGmail) ? "available_unverified" : "missing", binding_evidence: "none", exact_blocker: "execution_target_unbound", next_action: "canonical Gmail workflowに対象connection_ref_idまたはaccount_refを明示してください。" };

  const connection = requestedConnectionId ? refs.find((ref) => ref.id === requestedConnectionId) : undefined;
  // Account refs are not globally unique across providers (the same Google
  // identity can back Gmail, Drive, and Supabase connections). Only Gmail
  // refs can satisfy this workflow's account binding; otherwise an explicit
  // Gmail pair is incorrectly reported as competing with unrelated providers.
  const accountMatches = requestedAccountRef
    ? refs.filter((ref) => isGmail(ref) && ref.accountRef === requestedAccountRef)
    : [];
  if (requestedConnectionId && !connection) return { ...base, state: "unknown_ref", connection_ref_id: requestedConnectionId, account_ref: requestedAccountRef || null, connection_evidence: "missing", binding_evidence: bindingEvidence, exact_blocker: "execution_target_connection_ref_not_found", next_action: "Company 1のGmail connection inventoryに存在するrefを指定してください。" };
  if (!requestedConnectionId && accountMatches.length === 0) return { ...base, state: "unknown_ref", connection_ref_id: null, account_ref: requestedAccountRef, connection_evidence: "missing", binding_evidence: bindingEvidence, exact_blocker: "execution_target_account_ref_not_found", next_action: "Company 1のGmail connection inventoryに存在するaccount_refを指定してください。" };
  if (connection && requestedAccountRef && accountMatches.length === 0) return { ...base, state: "unknown_ref", connection_ref_id: connection.id, account_ref: requestedAccountRef, connection_evidence: "available_unverified", binding_evidence: bindingEvidence, exact_blocker: "execution_target_account_ref_not_found", next_action: "指定したconnection_ref_idと同じGmail接続のaccount_refを指定してください。" };
  if (connectionIds.length > 1 || accountRefs.length > 1 || accountMatches.length > 1 || (connection && accountMatches.some((ref) => ref.id !== connection.id))) return { ...base, state: "competing", connection_ref_id: null, account_ref: null, connection_evidence: "available_unverified", binding_evidence: "conflict", exact_blocker: "execution_target_competing_bindings", next_action: "connection_ref_idとaccount_refを1つの同一Gmail接続に整理してください。" };

  const resolved = connection ?? accountMatches[0]!;
  if (requestedCompanyId && requestedCompanyId !== automation.companyId || resolved.companyId !== automation.companyId) return { ...base, state: "company_mismatch", connection_ref_id: resolved.id, account_ref: resolved.accountRef, connection_evidence: "available_unverified", binding_evidence: bindingEvidence, exact_blocker: "execution_target_company_mismatch", next_action: "同じCompany 1のconnection refを明示して確認してください。" };
  if (!isGmail(resolved)) return { ...base, state: "non_gmail", scope: { ...base.scope, platform: "unknown" }, connection_ref_id: resolved.id, account_ref: resolved.accountRef, connection_evidence: "available_unverified", binding_evidence: bindingEvidence, exact_blocker: "execution_target_platform_not_gmail", next_action: "Gmail platformのconnection refを指定してください。" };
  if (isRevoked(resolved)) return { ...base, state: "revoked", connection_ref_id: resolved.id, account_ref: resolved.accountRef, connection_evidence: "available_unverified", binding_evidence: bindingEvidence, exact_blocker: "execution_target_connection_revoked", next_action: "対象Gmail接続を再認証し、verified readback後にbindingを再確認してください。" };
  if (isExpired(resolved, nowMs)) return { ...base, state: "expired", connection_ref_id: resolved.id, account_ref: resolved.accountRef, connection_evidence: "available_unverified", binding_evidence: bindingEvidence, exact_blocker: "execution_target_connection_expired", next_action: "対象Gmail接続を更新し、fresh verified readback後にbindingを再確認してください。" };
  if (!isVerified(resolved)) return { ...base, state: "unverified", connection_ref_id: resolved.id, account_ref: resolved.accountRef, connection_evidence: "available_unverified", binding_evidence: bindingEvidence, exact_blocker: "execution_target_connection_unverified", next_action: "対象Gmail接続をverified/connectedにしてから再確認してください。" };
  if (!hasReadScope(resolved)) return { ...base, state: "scope_insufficient", connection_ref_id: resolved.id, account_ref: resolved.accountRef, connection_evidence: "verified", binding_evidence: bindingEvidence, exact_blocker: "execution_target_gmail_read_scope_missing", next_action: "対象Gmail接続にread scopeを付与し、fresh readbackを確認してください。" };
  return { ...base, state: "bound", connection_ref_id: resolved.id, account_ref: resolved.accountRef, connection_evidence: "verified", binding_evidence: bindingEvidence, exact_blocker: null, next_action: "実行対象の会社・canonical ID・Gmail connection refを同一Runで再確認してください。" };
}

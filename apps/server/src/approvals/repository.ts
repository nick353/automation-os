import { makeId, nowIso, querySql, runSqlTransaction, sqlValue } from "../db/client.js";
import { requireCompanyAccess, requireExistingCompanyAccess, requireExistingServiceIdentity } from "../companies/repository.js";

export class BoundApprovalError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "BoundApprovalError";
  }
}

export type BoundApproval = {
  id: string;
  companyId: string;
  runId: string;
  jobId: string;
  stepId: string | null;
  title: string;
  requestedBy: string;
  status: "pending" | "approved" | "rejected";
  priority: string;
  actionKind: string;
  targetAccountRefId: string | null;
  payloadHash: string;
  policyVersion: string;
  expiresAt: string;
  decidedByUserId: string | null;
  decisionRevision: number;
  consumedAt: string | null;
  consumedByAttemptId: string | null;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
};

export function getBoundApproval(companyId: string, approvalId: string): BoundApproval | undefined {
  const row = querySql<any>(`
    SELECT * FROM approvals
    WHERE company_id=${sqlValue(required(companyId, "company_id_required"))}
      AND id=${sqlValue(required(approvalId, "approval_id_required"))}
      AND job_id IS NOT NULL AND action_kind IS NOT NULL AND payload_hash IS NOT NULL
    LIMIT 1
  `)[0];
  return row ? toBoundApproval(row) : undefined;
}

export function listBoundApprovals(companyId: string, limit = 200): BoundApproval[] {
  const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  return querySql<any>(`
    SELECT * FROM approvals
    WHERE company_id=${sqlValue(required(companyId, "company_id_required"))}
      AND job_id IS NOT NULL AND action_kind IS NOT NULL AND payload_hash IS NOT NULL
    ORDER BY created_at DESC, id DESC
    LIMIT ${boundedLimit}
  `).map(toBoundApproval);
}

export function createBoundApproval(input: {
  companyId: string;
  requestedByUserId: string;
  jobId: string;
  stepId?: string | null;
  title: string;
  actionKind: string;
  targetAccountRefId?: string | null;
  payloadHash: string;
  policyVersion: string;
  expiresAt: string;
  priority?: string;
  now?: string;
}): BoundApproval {
  const companyId = required(input.companyId, "company_id_required");
  const requester = required(input.requestedByUserId, "approval_requester_required");
  requireActiveCompanyMember(companyId, requester, ["owner", "admin", "operator"]);
  const job = querySql<any>(`
    SELECT id, run_id, status FROM durable_jobs
    WHERE id=${sqlValue(required(input.jobId, "durable_job_id_required"))} AND company_id=${sqlValue(companyId)}
    LIMIT 1
  `)[0];
  if (!job) throw new BoundApprovalError("durable_job_not_found");
  if (job.status !== "queued" && job.status !== "leased") throw new BoundApprovalError("durable_job_not_accepting_approval");
  if (input.stepId) {
    const step = querySql<{ id: string }>(`SELECT id FROM run_steps WHERE id=${sqlValue(input.stepId)} AND run_id=${sqlValue(job.run_id)} AND company_id=${sqlValue(companyId)} LIMIT 1`)[0];
    if (!step) throw new BoundApprovalError("approval_step_not_found");
  }
  const now = normalizedTime(input.now ?? nowIso(), "approval_time_invalid");
  const accountRef = input.targetAccountRefId ? required(input.targetAccountRefId, "approval_target_account_ref_invalid") : null;
  if (accountRef) {
    const account = querySql<{ id: string }>(`
      SELECT id FROM company_connection_account_refs
      WHERE id=${sqlValue(accountRef)} AND company_id=${sqlValue(companyId)}
        AND status='verified' AND verification_status='verified'
        AND oauth_state IN ('connected', 'not_applicable') AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at>${sqlValue(now)})
      LIMIT 1
    `)[0];
    if (!account) throw new BoundApprovalError("approval_target_account_ref_not_found");
  }
  const expiresAt = normalizedTime(input.expiresAt, "approval_expiry_invalid");
  if (Date.parse(expiresAt) <= Date.parse(now)) throw new BoundApprovalError("approval_expiry_not_future");
  const payloadHash = requiredHash(input.payloadHash);
  const id = makeId("approval");
  runSqlTransaction([{
    sql: `INSERT INTO approvals
          (id, company_id, run_id, job_id, step_id, title, requested_by, status, priority, approval_group_id,
           action_kind, target_account_ref_id, payload_hash, policy_version, expires_at, decided_by_user_id,
           decision_revision, consumed_at, consumed_by_attempt_id, resource_locks_json, created_at, decided_at, decision_note)
          VALUES (${sqlValue(id)}, ${sqlValue(companyId)}, ${sqlValue(job.run_id)}, ${sqlValue(job.id)}, ${sqlValue(input.stepId ?? null)},
                  ${sqlValue(required(input.title, "approval_title_required").slice(0, 240))}, ${sqlValue(requester)}, 'pending',
                  ${sqlValue((input.priority ?? "normal").slice(0, 32))}, ${sqlValue(`job:${job.id}`)},
                  ${sqlValue(required(input.actionKind, "approval_action_kind_required").slice(0, 120))}, ${sqlValue(accountRef)},
                  ${sqlValue(payloadHash)}, ${sqlValue(required(input.policyVersion, "approval_policy_version_required").slice(0, 120))},
                  ${sqlValue(expiresAt)}, NULL, 1, NULL, NULL, '[]', ${sqlValue(now)}, NULL, NULL)`,
    expectChanges: 1
  }]);
  return requiredApproval(companyId, id);
}

export function decideBoundApproval(input: {
  companyId: string;
  approvalId: string;
  actorUserId: string;
  decision: "approved" | "rejected";
  expectedRevision: number;
  note?: string | null;
  now?: string;
}): BoundApproval {
  const companyId = required(input.companyId, "company_id_required");
  requireCompanyAccess(companyId, ["owner", "admin", "approver"], required(input.actorUserId, "actor_user_id_required"));
  const current = requiredApproval(companyId, input.approvalId);
  const now = normalizedTime(input.now ?? nowIso(), "approval_time_invalid");
  if (current.status !== "pending") throw new BoundApprovalError("approval_not_pending");
  if (current.decisionRevision !== input.expectedRevision) throw new BoundApprovalError("approval_revision_conflict");
  if (Date.parse(current.expiresAt) <= Date.parse(now)) throw new BoundApprovalError("approval_expired");
  try {
    runSqlTransaction([{
      sql: `UPDATE approvals
            SET status=${sqlValue(input.decision)}, decided_by_user_id=${sqlValue(input.actorUserId)},
                decided_at=${sqlValue(now)}, decision_note=${sqlValue(input.note?.trim().slice(0, 1000) || null)},
                decision_revision=decision_revision+1
            WHERE id=${sqlValue(current.id)} AND company_id=${sqlValue(companyId)} AND status='pending'
              AND decision_revision=${input.expectedRevision} AND expires_at>${sqlValue(now)}`,
      expectChanges: 1
    }]);
  } catch (error) {
    if (isExpectedChangesError(error)) throw new BoundApprovalError("approval_decision_conflict");
    throw error;
  }
  return requiredApproval(companyId, current.id);
}

export function consumeBoundApproval(input: {
  companyId: string;
  approvalId: string;
  serviceUserId: string;
  attemptId: string;
  fencingToken: number;
  expectedDecisionRevision: number;
  jobId: string;
  actionKind: string;
  targetAccountRefId?: string | null;
  payloadHash: string;
  policyVersion: string;
  now?: string;
}): BoundApproval {
  const companyId = required(input.companyId, "company_id_required");
  const serviceUserId = required(input.serviceUserId, "service_user_id_required");
  requireExistingServiceIdentity(serviceUserId);
  requireExistingCompanyAccess(companyId, ["operator"], serviceUserId);
  const current = requiredApproval(companyId, input.approvalId);
  const now = normalizedTime(input.now ?? nowIso(), "approval_time_invalid");
  const expected = {
    jobId: required(input.jobId, "durable_job_id_required"),
    actionKind: required(input.actionKind, "approval_action_kind_required"),
    accountRef: input.targetAccountRefId?.trim() || null,
    payloadHash: requiredHash(input.payloadHash),
    policyVersion: required(input.policyVersion, "approval_policy_version_required")
  };
  if (current.status !== "approved" || current.consumedAt || Date.parse(current.expiresAt) <= Date.parse(now)) {
    throw new BoundApprovalError("approval_not_consumable");
  }
  if (current.decisionRevision !== input.expectedDecisionRevision || current.jobId !== expected.jobId || current.actionKind !== expected.actionKind
      || current.targetAccountRefId !== expected.accountRef || current.payloadHash !== expected.payloadHash || current.policyVersion !== expected.policyVersion) {
    throw new BoundApprovalError("approval_binding_mismatch");
  }
  const attemptId = required(input.attemptId, "durable_attempt_id_required");
  try {
    runSqlTransaction([{
      sql: `UPDATE approvals
            SET consumed_at=${sqlValue(now)}, consumed_by_attempt_id=${sqlValue(attemptId)}, decision_revision=decision_revision+1
            WHERE id=${sqlValue(current.id)} AND company_id=${sqlValue(companyId)} AND status='approved'
              AND consumed_at IS NULL AND expires_at>${sqlValue(now)} AND decision_revision=${input.expectedDecisionRevision}
              AND job_id=${sqlValue(expected.jobId)} AND action_kind=${sqlValue(expected.actionKind)}
              AND ${nullableEquals("target_account_ref_id", expected.accountRef)}
              AND payload_hash=${sqlValue(expected.payloadHash)} AND policy_version=${sqlValue(expected.policyVersion)}
              AND (
                target_account_ref_id IS NULL OR EXISTS (
                  SELECT 1 FROM company_connection_account_refs account
                  WHERE account.id=approvals.target_account_ref_id AND account.company_id=approvals.company_id
                    AND account.status='verified' AND account.verification_status='verified'
                    AND account.oauth_state IN ('connected', 'not_applicable') AND account.revoked_at IS NULL
                    AND (account.expires_at IS NULL OR account.expires_at>${sqlValue(now)})
                )
              )
              AND EXISTS (
                SELECT 1
                FROM durable_job_attempts attempt
                JOIN durable_jobs job
                  ON job.id=attempt.job_id AND job.company_id=attempt.company_id
                WHERE attempt.id=${sqlValue(attemptId)} AND attempt.company_id=${sqlValue(companyId)}
                  AND attempt.job_id=${sqlValue(expected.jobId)} AND attempt.status='running'
                  AND attempt.service_user_id=${sqlValue(serviceUserId)} AND attempt.fencing_token=${input.fencingToken}
                  AND job.status='leased' AND job.lease_owner=${sqlValue(serviceUserId)}
                  AND job.fencing_token=${input.fencingToken} AND job.lease_expires_at>${sqlValue(now)}
              )`,
      expectChanges: 1
    }]);
  } catch (error) {
    if (isExpectedChangesError(error)) throw new BoundApprovalError("approval_consume_conflict");
    throw error;
  }
  return requiredApproval(companyId, current.id);
}

function requiredApproval(companyId: string, approvalId: string): BoundApproval {
  const approval = getBoundApproval(companyId, approvalId);
  if (!approval) throw new BoundApprovalError("approval_not_found");
  return approval;
}

function requireActiveCompanyMember(companyId: string, userId: string, allowedRoles: readonly string[]): void {
  const row = querySql<{ role: string }>(`
    SELECT membership.role FROM company_memberships membership
    JOIN users ON users.id=membership.user_id
    JOIN companies ON companies.id=membership.company_id
    WHERE membership.company_id=${sqlValue(companyId)} AND membership.user_id=${sqlValue(userId)}
      AND membership.status='active' AND users.status='active' AND companies.status!='archived'
    LIMIT 1
  `)[0];
  if (!row || !allowedRoles.includes(row.role)) throw new BoundApprovalError("company_scope_forbidden");
}

function toBoundApproval(row: any): BoundApproval {
  return {
    id: row.id,
    companyId: row.company_id,
    runId: row.run_id,
    jobId: row.job_id,
    stepId: row.step_id,
    title: row.title,
    requestedBy: row.requested_by,
    status: row.status,
    priority: row.priority,
    actionKind: row.action_kind,
    targetAccountRefId: row.target_account_ref_id,
    payloadHash: row.payload_hash,
    policyVersion: row.policy_version,
    expiresAt: row.expires_at,
    decidedByUserId: row.decided_by_user_id,
    decisionRevision: Number(row.decision_revision),
    consumedAt: row.consumed_at,
    consumedByAttemptId: row.consumed_by_attempt_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note
  };
}

function nullableEquals(column: string, value: string | null): string {
  return value === null ? `${column} IS NULL` : `${column}=${sqlValue(value)}`;
}

function requiredHash(value: string): string {
  const normalized = required(value, "approval_payload_hash_required").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new BoundApprovalError("approval_payload_hash_invalid");
  return normalized;
}

function normalizedTime(value: string, code: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new BoundApprovalError(code);
  return new Date(timestamp).toISOString();
}

function required(value: string, code: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new BoundApprovalError(code);
  return normalized;
}

function isExpectedChangesError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("sql_transaction_expected_changes");
}

import { createHash, randomBytes } from "node:crypto";
import {
  querySql,
  runSqlTransaction,
  sqlValue,
  type SqlTransactionStep
} from "../db/client.js";
import {
  requireExistingCompanyAccess,
  requireExistingServiceIdentity
} from "../companies/repository.js";
import { readTrustedRegisteredWorkflowManifestHash } from "../registeredWorkflows.js";
import {
  computeServiceReadinessEffectKey,
  readServiceReadinessEffect
} from "./effectLedger.js";
import { parseServiceReadinessEvidenceV1 } from "./foundationContracts.js";
import type {
  IabExternalCapabilityV1
} from "./iabExternalCapability.js";
import { validateIabExternalCapabilityV1 } from "./iabExternalCapability.js";
import type {
  IabExternalExecutorBindingV1,
  IabExternalEffectRequestV1,
  IabExternalReservationV1,
  RootOwnedIabExternalAtomicGateV1
} from "./iabExternalExecutor.js";

/**
 * The production-shaped gate for the external executor.  It is intentionally
 * separate from the executor so a provider/runtime can never consume an
 * approval or reserve an effect outside one database transaction.
 */
export const IAB_EXTERNAL_ATOMIC_GATE_SCHEMA_V1 = "service_readiness_iab_external_atomic_gate.v1" as const;
export const IAB_EXTERNAL_ATOMIC_GATE_PARTIAL_COMMIT_BLOCKER = "iab_external_atomic_partial_commit_detected" as const;
const hashPattern = /^[a-f0-9]{64}$/;

type ApprovalRow = {
  id: string;
  company_id: string;
  run_id: string;
  job_id: string;
  action_kind: string;
  target_account_ref_id: string | null;
  payload_hash: string;
  policy_version: string;
  status: string;
  decision_revision: number;
  expires_at: string;
  consumed_at: string | null;
  consumed_by_attempt_id: string | null;
};

export type IabExternalAtomicGateOptionsV1 = {
  /** Deterministic clock hook for capability/approval lease boundary checks. */
  clock_ms?: () => number;
  /** Fixed clock value for deterministic callers that do not need a callback. */
  now_ms?: number;
};

const approvalColumns = `id, company_id, run_id, job_id, action_kind,
  target_account_ref_id, payload_hash, policy_version, status,
  decision_revision, expires_at, consumed_at, consumed_by_attempt_id`;

function approvalFor(binding: IabExternalExecutorBindingV1): ApprovalRow | undefined {
  return querySql<ApprovalRow>(`
    SELECT ${approvalColumns}
      FROM approvals
     WHERE id=${sqlValue(binding.approval_id)}
       AND company_id=${sqlValue(binding.company_id)}
       AND job_id IS NOT NULL AND action_kind IS NOT NULL AND payload_hash IS NOT NULL
     LIMIT 1
  `)[0];
}

function requiredApproval(binding: IabExternalExecutorBindingV1): ApprovalRow {
  const row = approvalFor(binding);
  if (!row) throw new Error("iab_external_approval_readback_not_found");
  return { ...row, decision_revision: Number(row.decision_revision) };
}

function clockFor(options: IabExternalAtomicGateOptionsV1): () => number {
  const clock = options.clock_ms ?? (() => options.now_ms ?? Date.now());
  return () => {
    const value = clock();
    if (!Number.isFinite(value)) throw new Error("iab_external_atomic_clock_invalid");
    return value;
  };
}

function isoAt(clockMs: () => number): string {
  return new Date(clockMs()).toISOString();
}

function nullableEquals(column: string, value: string | null): string {
  return value === null ? `${column} IS NULL` : `${column}=${sqlValue(value)}`;
}

function assertLiveAttemptAndLease(binding: IabExternalExecutorBindingV1, now: string): void {
  const row = querySql<{
    attempt_id: string;
    attempt_company_id: string;
    attempt_job_id: string;
    attempt_service_user_id: string;
    attempt_fencing_token: number;
    attempt_status: string;
    job_company_id: string;
    job_run_id: string | null;
    job_status: string;
    job_lease_owner: string | null;
    job_fencing_token: number;
    job_lease_expires_at: string | null;
  }>(`
    SELECT attempt.id AS attempt_id, attempt.company_id AS attempt_company_id,
           attempt.job_id AS attempt_job_id, attempt.service_user_id AS attempt_service_user_id,
           attempt.fencing_token AS attempt_fencing_token, attempt.status AS attempt_status,
           job.company_id AS job_company_id, job.run_id AS job_run_id, job.status AS job_status,
           job.lease_owner AS job_lease_owner, job.fencing_token AS job_fencing_token,
           job.lease_expires_at AS job_lease_expires_at
      FROM durable_job_attempts attempt
      JOIN durable_jobs job ON job.id=attempt.job_id AND job.company_id=attempt.company_id
     WHERE attempt.id=${sqlValue(binding.attempt_id)}
       AND attempt.company_id=${sqlValue(binding.company_id)}
       AND attempt.job_id=${sqlValue(binding.job_id)}
     LIMIT 1
  `)[0];
  if (!row || row.attempt_id !== binding.attempt_id || row.attempt_company_id !== binding.company_id ||
      row.attempt_job_id !== binding.job_id || row.attempt_service_user_id !== binding.service_user_id ||
      row.attempt_status !== "running" || Number(row.attempt_fencing_token) !== binding.fencing_token ||
      row.job_company_id !== binding.company_id || row.job_run_id !== binding.run_id || row.job_status !== "leased" ||
      row.job_lease_owner !== binding.service_user_id || Number(row.job_fencing_token) !== binding.fencing_token ||
      !row.job_lease_expires_at || !Number.isFinite(Date.parse(row.job_lease_expires_at)) ||
      Date.parse(row.job_lease_expires_at) <= Date.parse(now)) {
    throw new Error("iab_external_live_attempt_lease_binding_mismatch");
  }
}

function assertVerifiedAccount(binding: IabExternalExecutorBindingV1, now: string): void {
  const row = querySql<{ id: string; expires_at: string | null }>(`
    SELECT id, expires_at
      FROM company_connection_account_refs
     WHERE id=${sqlValue(binding.account_ref)}
       AND company_id=${sqlValue(binding.company_id)}
       AND status='verified' AND verification_status='verified'
       AND oauth_state IN ('connected', 'not_applicable') AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at>${sqlValue(now)})
     LIMIT 1
  `)[0];
  if (!row || (row.expires_at !== null && (!Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= Date.parse(now)))) {
    throw new Error("iab_external_account_binding_invalid");
  }
}

function assertApprovalBinding(binding: IabExternalExecutorBindingV1, now: string): ApprovalRow {
  if (binding.approval_payload_hash !== binding.payload_hash) {
    throw new Error("iab_external_approval_payload_hash_mismatch");
  }
  requireExistingServiceIdentity(binding.service_user_id);
  requireExistingCompanyAccess(binding.company_id, ["operator"], binding.service_user_id);
  const current = requiredApproval(binding);
  const approvalExpiry = Date.parse(current.expires_at);
  if (current.status !== "approved" || current.consumed_at || !Number.isFinite(approvalExpiry) || approvalExpiry <= Date.parse(now)) {
    throw new Error("iab_external_approval_not_consumable");
  }
  if (current.decision_revision !== binding.approval_revision) {
    throw new Error("iab_external_approval_binding_mismatch");
  }
  if (current.company_id !== binding.company_id || current.job_id !== binding.job_id ||
      current.action_kind !== binding.action_kind || current.target_account_ref_id !== binding.account_ref ||
      current.payload_hash !== binding.payload_hash || current.policy_version !== binding.policy_version ||
      current.run_id !== binding.run_id) {
    throw new Error("iab_external_approval_binding_mismatch");
  }
  assertLiveAttemptAndLease(binding, now);
  assertVerifiedAccount(binding, now);
  return current;
}

const capabilityBindingFields: readonly (keyof IabExternalCapabilityV1 & keyof IabExternalExecutorBindingV1)[] = [
  "company_id", "issuer_service_user_id", "manifest_hash",
  "root_id", "workflow_id", "run_id", "stage_id", "attempt_id", "fencing_token", "capability_id",
  "turn_id", "session_id", "nonce", "provider", "account_ref", "target_hash", "payload_hash",
  "effect_key", "approval_id", "approval_revision", "approval_payload_hash"
];

function assertCapabilityBinding(
  capabilityInput: unknown,
  binding: IabExternalExecutorBindingV1,
  nowMs: number
): IabExternalCapabilityV1 {
  const result = validateIabExternalCapabilityV1(capabilityInput, nowMs);
  if (!result.ok) throw new Error(result.exact_blocker);
  const capability = result.value;
  if (binding.approval_payload_hash !== binding.payload_hash) {
    throw new Error("iab_external_approval_payload_hash_mismatch");
  }
  for (const field of capabilityBindingFields) {
    if (capability[field] !== binding[field]) {
      throw new Error(`iab_external_capability_binding_mismatch:${field}`);
    }
  }
  const identityBindings: Array<[string, string]> = [
    ["iab_generation", capability.iab_identity.generation],
    ["iab_project_id", capability.iab_identity.project_id],
    ["iab_thread_id", capability.iab_identity.thread_id]
  ];
  for (const [field, value] of identityBindings) {
    if (value !== binding[field as "iab_generation" | "iab_project_id" | "iab_thread_id"]) {
      throw new Error(`iab_external_capability_binding_mismatch:${field}`);
    }
  }
  requireExistingServiceIdentity(capability.issuer_service_user_id);
  requireExistingCompanyAccess(capability.company_id, ["operator"], capability.issuer_service_user_id);
  return capability;
}

function assertTrustedManifestHash(
  binding: IabExternalExecutorBindingV1,
  capability: IabExternalCapabilityV1
): void {
  const trustedHash = readTrustedRegisteredWorkflowManifestHash(binding.workflow_id);
  if (!trustedHash) throw new Error("iab_external_trusted_manifest_hash_source_unavailable");
  if (trustedHash !== binding.manifest_hash || capability.manifest_hash !== trustedHash) {
    throw new Error("iab_external_trusted_manifest_hash_mismatch");
  }
}

const requestBindingFields: readonly (keyof IabExternalExecutorBindingV1)[] = [
  "company_id", "service_user_id", "issuer_service_user_id", "iab_generation", "iab_project_id", "iab_thread_id",
  "job_id", "action_kind", "policy_version", "manifest_hash", "root_id",
  "workflow_id", "run_id", "stage_id", "attempt_id", "fencing_token", "capability_id", "turn_id",
  "session_id", "nonce", "provider", "account_ref", "target_hash", "payload_hash", "effect_key",
  "approval_id", "approval_revision", "approval_payload_hash"
];

function assertRequestBinding(
  request: IabExternalEffectRequestV1,
  binding: IabExternalExecutorBindingV1
): void {
  for (const field of requestBindingFields) {
    if ((request as Partial<IabExternalExecutorBindingV1>)[field] !== binding[field]) {
      throw new Error(`iab_external_atomic_request_binding_mismatch:${field}`);
    }
  }
  if (request.surface !== "in_app_browser" || request.capability_mode !== "external" ||
      request.effect_class !== "external_non_idempotent" || request.external_action_executed !== false ||
      request.legacy_surfaces_forbidden !== true || request.prior_receipt_reuse !== false) {
    throw new Error("iab_external_atomic_request_binding_mismatch");
  }
}

function effectEvidence(binding: IabExternalExecutorBindingV1) {
  const effectKey = computeServiceReadinessEffectKey({
    company_id: binding.company_id,
    provider: binding.provider,
    account_ref: binding.account_ref,
    target_hash: binding.target_hash,
    payload_hash: binding.payload_hash,
    effect_class: "external_non_idempotent"
  });
  if (effectKey !== binding.effect_key) throw new Error("iab_external_atomic_effect_key_binding_mismatch");
  return parseServiceReadinessEvidenceV1({
    schema: "service_readiness.evidence.v1",
    company_id: binding.company_id,
    root_id: binding.root_id,
    workflow_id: binding.workflow_id,
    run_id: binding.run_id,
    stage_id: binding.stage_id,
    attempt_id: binding.attempt_id,
    fencing_token: binding.fencing_token,
    capability_id: binding.capability_id,
    turn_id: binding.turn_id,
    session_id: binding.session_id,
    nonce: binding.nonce,
    capability_mode: "external",
    provider: binding.provider,
    account_ref: binding.account_ref,
    target_hash: binding.target_hash,
    payload_hash: binding.payload_hash,
    effect_key: binding.effect_key,
    effect_class: "external_non_idempotent",
    status: "running",
    external_action_executed: false,
    provider_receipt_hash: null,
    cleanup_receipt_hash: null,
    exact_blocker: null,
    safe_resume_step: null
  });
}

function sameEffectBinding(
  row: ReturnType<typeof readServiceReadinessEffect>,
  binding: IabExternalExecutorBindingV1
): boolean {
  return Boolean(row && row.company_id === binding.company_id && row.root_id === binding.root_id && row.workflow_id === binding.workflow_id &&
    row.run_id === binding.run_id && row.stage_id === binding.stage_id && row.attempt_id === binding.attempt_id &&
    row.fencing_token === binding.fencing_token && row.provider === binding.provider &&
    row.account_ref === binding.account_ref && row.target_hash === binding.target_hash &&
    row.payload_hash === binding.payload_hash && row.effect_class === "external_non_idempotent" &&
    row.capability_id === binding.capability_id && row.approval_id === binding.approval_id &&
    row.approval_revision === binding.approval_revision);
}

function approvalConsumeStep(binding: IabExternalExecutorBindingV1, now: string): SqlTransactionStep {
  return {
    sql: `UPDATE approvals
             SET consumed_at=${sqlValue(now)}, consumed_by_attempt_id=${sqlValue(binding.attempt_id)},
                 decision_revision=decision_revision+1
           WHERE id=${sqlValue(binding.approval_id)} AND company_id=${sqlValue(binding.company_id)}
             AND status='approved' AND consumed_at IS NULL AND expires_at>${sqlValue(now)}
             AND decision_revision=${sqlValue(binding.approval_revision)}
             AND job_id=${sqlValue(binding.job_id)} AND action_kind=${sqlValue(binding.action_kind)}
             AND ${nullableEquals("target_account_ref_id", binding.account_ref)}
             AND payload_hash=${sqlValue(binding.payload_hash)} AND policy_version=${sqlValue(binding.policy_version)}
             AND EXISTS (
               SELECT 1 FROM users service_user
               JOIN company_memberships membership
                 ON membership.user_id=service_user.id AND membership.company_id=approvals.company_id
              WHERE service_user.id=${sqlValue(binding.service_user_id)}
                AND service_user.id=${sqlValue(binding.issuer_service_user_id)}
                AND service_user.kind='service' AND service_user.status='active'
                AND membership.status='active' AND membership.role='operator'
             )
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
                WHERE attempt.id=${sqlValue(binding.attempt_id)}
                  AND attempt.company_id=${sqlValue(binding.company_id)}
                  AND attempt.job_id=${sqlValue(binding.job_id)}
                  AND attempt.status='running'
                  AND attempt.service_user_id=${sqlValue(binding.service_user_id)}
                  AND attempt.fencing_token=${sqlValue(binding.fencing_token)}
                  AND job.status='leased' AND job.lease_owner=${sqlValue(binding.service_user_id)}
                  AND job.fencing_token=${sqlValue(binding.fencing_token)}
                  AND job.run_id=${sqlValue(binding.run_id)}
                  AND job.lease_expires_at>${sqlValue(now)}
             )`,
    expectChanges: 1
  };
}

function effectReserveStep(
  binding: IabExternalExecutorBindingV1,
  now: string,
  reservationId: string,
  reservationTokenHash: string
): SqlTransactionStep {
  return {
    sql: `INSERT INTO service_readiness_effect_ledger
      (effect_key, company_id, reservation_id, reservation_token_hash, capability_id, approval_id, approval_revision,
       root_id, workflow_id, run_id, stage_id, attempt_id,
       fencing_token, provider, account_ref, target_hash, payload_hash, effect_class, status,
       external_action_executed, provider_receipt_hash, cleanup_receipt_hash, exact_blocker,
       safe_resume_step, created_at, updated_at, terminal_at)
     VALUES (${sqlValue(binding.effect_key)}, ${sqlValue(binding.company_id)}, ${sqlValue(reservationId)}, ${sqlValue(reservationTokenHash)},
             ${sqlValue(binding.capability_id)}, ${sqlValue(binding.approval_id)}, ${sqlValue(binding.approval_revision)},
             ${sqlValue(binding.root_id)}, ${sqlValue(binding.workflow_id)},
             ${sqlValue(binding.run_id)}, ${sqlValue(binding.stage_id)}, ${sqlValue(binding.attempt_id)},
             ${sqlValue(binding.fencing_token)}, ${sqlValue(binding.provider)}, ${sqlValue(binding.account_ref)},
             ${sqlValue(binding.target_hash)}, ${sqlValue(binding.payload_hash)}, 'external_non_idempotent', 'running',
             0, NULL, NULL, NULL, NULL, ${sqlValue(now)}, ${sqlValue(now)}, NULL)`,
    expectChanges: 1
  };
}

function reservation(
  binding: IabExternalExecutorBindingV1,
  reservationId: string,
  reservationToken: string
): IabExternalReservationV1 {
  return {
    reservation_id: reservationId,
    reservation_token: reservationToken,
    effect_key: binding.effect_key,
    approval_consumed: true,
    ledger_reserved: true
  };
}

function safeError(error: unknown, fallback: string): string {
  const code = error instanceof Error ? error.message : "";
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(code) ? code : fallback;
}

function assertReservation(input: {
  binding: IabExternalExecutorBindingV1;
  reservation: IabExternalReservationV1;
}): void {
  if (!/^iab_reservation_[a-f0-9]{32}$/.test(input.reservation.reservation_id) ||
      !/^[a-f0-9]{64}$/.test(input.reservation.reservation_token) ||
      input.reservation.effect_key !== input.binding.effect_key || input.reservation.approval_consumed !== true ||
      input.reservation.ledger_reserved !== true) {
    throw new Error("iab_external_atomic_reservation_binding_invalid");
  }
}

function transitionRootOwnedExternalEffect(input: {
  binding: IabExternalExecutorBindingV1;
  reservation: IabExternalReservationV1;
  status: "succeeded" | "failed" | "reconciliation_required";
  external_action_executed: boolean;
  provider_receipt_hash: string | null;
  cleanup_receipt_hash: string;
  exact_blocker: string | null;
  safe_resume_step: string | null;
}): void {
  const effect = readServiceReadinessEffect(input.binding.effect_key, input.binding.company_id);
  if (!effect) throw new Error("service_readiness_effect_not_found");
  if (effect.status !== "running") throw new Error("service_readiness_effect_terminal_transition_forbidden");
  if (!hashPattern.test(input.cleanup_receipt_hash) ||
      (input.provider_receipt_hash !== null && !hashPattern.test(input.provider_receipt_hash))) {
    throw new Error("service_readiness_receipt_hash_invalid");
  }
  if (input.status === "succeeded" && input.exact_blocker !== null) {
    throw new Error("service_readiness_success_blocker_fields_forbidden");
  }
  if (input.status === "succeeded" && input.external_action_executed && input.provider_receipt_hash === null) {
    throw new Error("service_readiness_external_success_provider_receipt_required");
  }
  const timestamp = new Date().toISOString();
  const terminalSql = `UPDATE service_readiness_effect_ledger
    SET status=${sqlValue(input.status)}, external_action_executed=${sqlValue(input.external_action_executed)},
        provider_receipt_hash=${sqlValue(input.provider_receipt_hash)}, cleanup_receipt_hash=${sqlValue(input.cleanup_receipt_hash)},
        exact_blocker=${sqlValue(input.exact_blocker)}, safe_resume_step=${sqlValue(input.safe_resume_step)},
        updated_at=${sqlValue(timestamp)}, terminal_at=${sqlValue(timestamp)}
   WHERE effect_key=${sqlValue(input.binding.effect_key)}
     AND company_id=${sqlValue(input.binding.company_id)}
     AND status='running'
     AND reservation_id=${sqlValue(input.reservation.reservation_id)}
     AND reservation_token_hash=${sqlValue(createHash("sha256").update(input.reservation.reservation_token, "utf8").digest("hex"))}
     AND capability_id=${sqlValue(input.binding.capability_id)}
     AND approval_id=${sqlValue(input.binding.approval_id)}
     AND approval_revision=${sqlValue(input.binding.approval_revision)}
     AND root_id=${sqlValue(input.binding.root_id)} AND workflow_id=${sqlValue(input.binding.workflow_id)}
     AND run_id=${sqlValue(input.binding.run_id)} AND stage_id=${sqlValue(input.binding.stage_id)}
     AND attempt_id=${sqlValue(input.binding.attempt_id)} AND fencing_token=${sqlValue(input.binding.fencing_token)}`;
  try {
    runSqlTransaction([
      {
        sql: `UPDATE approvals
                 SET decision_revision=decision_revision
               WHERE id=${sqlValue(input.binding.approval_id)}
                 AND company_id=${sqlValue(input.binding.company_id)}
                 AND status='approved' AND consumed_at IS NOT NULL
                 AND consumed_by_attempt_id=${sqlValue(input.binding.attempt_id)}
                 AND decision_revision=${sqlValue(input.binding.approval_revision + 1)}`,
        expectChanges: 1
      },
      { sql: terminalSql, expectChanges: 1 }
    ]);
  } catch (error) {
    const approvalStillConsumed = querySql<{ id: string }>(`
      SELECT id FROM approvals
       WHERE id=${sqlValue(input.binding.approval_id)}
         AND company_id=${sqlValue(input.binding.company_id)}
         AND status='approved' AND consumed_at IS NOT NULL
         AND consumed_by_attempt_id=${sqlValue(input.binding.attempt_id)}
         AND decision_revision=${sqlValue(input.binding.approval_revision + 1)}
       LIMIT 1
    `)[0];
    if (!approvalStillConsumed) throw new Error("service_readiness_external_approval_consumption_invalid");
    const after = readServiceReadinessEffect(input.binding.effect_key, input.binding.company_id);
    if (after?.status !== "running") throw new Error("service_readiness_effect_terminal_transition_forbidden");
    throw error;
  }
}

export function createSqlBackedRootOwnedIabExternalAtomicGateV1(
  options: IabExternalAtomicGateOptionsV1 = {}
): RootOwnedIabExternalAtomicGateV1 {
  const clockMs = clockFor(options);
  return {
    async assertApproval(binding) {
      assertApprovalBinding(binding, isoAt(clockMs));
    },

    async reserveAndConsume(input: {
      binding: IabExternalExecutorBindingV1;
      capability: IabExternalCapabilityV1;
      request: IabExternalEffectRequestV1;
    }): Promise<IabExternalReservationV1> {
      const { binding } = input;
      const initialNowMs = clockMs();
      const initialNow = new Date(initialNowMs).toISOString();
      const initialCapability = assertCapabilityBinding(input.capability, binding, initialNowMs);
      assertTrustedManifestHash(binding, initialCapability);
      const now = initialNow;
      assertApprovalBinding(binding, now);
      effectEvidence(binding);
      assertRequestBinding(input.request, binding);

      // Revalidate both approval and capability immediately before entering the
      // transaction.  This closes the TTL boundary without mutating state when
      // a caller's clock advances during readback.
      const commitNowMs = clockMs();
      const commitNow = new Date(commitNowMs).toISOString();
      const commitCapability = assertCapabilityBinding(input.capability, binding, commitNowMs);
      assertTrustedManifestHash(binding, commitCapability);
      assertApprovalBinding(binding, commitNow);

      const existing = readServiceReadinessEffect(binding.effect_key, binding.company_id);
      if (existing) {
        if (!sameEffectBinding(existing, binding)) throw new Error("iab_external_effect_binding_mismatch");
        throw new Error(`iab_external_effect_replay_forbidden:${binding.effect_key}`);
      }

      const reservationToken = randomBytes(32).toString("hex");
      const reservationId = `iab_reservation_${randomBytes(16).toString("hex")}`;
      const reservationTokenHash = createHash("sha256").update(reservationToken, "utf8").digest("hex");
      try {
        runSqlTransaction([approvalConsumeStep(binding, commitNow), effectReserveStep(binding, commitNow, reservationId, reservationTokenHash)]);
      } catch (error) {
        const approvalAfter = approvalFor(binding);
        const effectAfter = readServiceReadinessEffect(binding.effect_key, binding.company_id);
        const approvalConsumed = approvalAfter?.consumed_by_attempt_id === binding.attempt_id &&
          Number(approvalAfter.decision_revision) === binding.approval_revision + 1;
        if (effectAfter && approvalConsumed) {
          throw new Error("iab_external_effect_replay_forbidden");
        }
        if (effectAfter || approvalConsumed) {
          throw new Error(IAB_EXTERNAL_ATOMIC_GATE_PARTIAL_COMMIT_BLOCKER);
        }
        throw new Error(safeError(error, "iab_external_atomic_reservation_failed"));
      }

      const approvalAfter = approvalFor(binding);
      const effectAfter = readServiceReadinessEffect(binding.effect_key, binding.company_id);
      const approvalConsumed = approvalAfter?.consumed_by_attempt_id === binding.attempt_id &&
        Number(approvalAfter.decision_revision) === binding.approval_revision + 1;
      if (!approvalConsumed || !effectAfter || effectAfter.status !== "running" || !sameEffectBinding(effectAfter, binding)) {
        throw new Error(IAB_EXTERNAL_ATOMIC_GATE_PARTIAL_COMMIT_BLOCKER);
      }
      return reservation(binding, reservationId, reservationToken);
    },

    async transition(input) {
      assertReservation(input);
      const effect = readServiceReadinessEffect(input.binding.effect_key, input.binding.company_id);
      const reservationTokenHash = createHash("sha256").update(input.reservation.reservation_token, "utf8").digest("hex");
      if (!effect || effect.company_id !== input.binding.company_id ||
          effect.reservation_id !== input.reservation.reservation_id ||
          effect.reservation_token_hash !== reservationTokenHash) {
        throw new Error("iab_external_atomic_reservation_token_invalid");
      }
      transitionRootOwnedExternalEffect(input);
    }
  };
}

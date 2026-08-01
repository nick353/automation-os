import { createHash } from "node:crypto";

import {
  ServiceReadinessContractError,
  parseServiceReadinessEvidenceV1,
  type ServiceReadinessEffectClassV1,
  type ServiceReadinessEvidenceV1
} from "./foundationContracts.js";
import { canonicalJson } from "../automations/idempotency.js";
import { nowIso, querySql, runSqlTransaction, sqlValue, type SqlTransactionStep } from "../db/client.js";

/** The statuses persisted by the durable effect ledger. */
export type ServiceReadinessEffectLedgerStatusV1 =
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "reconciliation_required"
  | "cancelled";

export type ServiceReadinessEffectTransitionStatusV1 =
  | ServiceReadinessEffectLedgerStatusV1
  | "ambiguous";

/**
 * Durable effect identity.  Capability/session fields stay in the
 * request-scoped evidence envelope; this ledger binds only the effect
 * lineage and provider payload tuple that must be replay-safe.
 */
export type ServiceReadinessEffectLedgerEntryV1 = {
  company_id: string;
  root_id: string;
  workflow_id: string;
  run_id: string;
  stage_id: string;
  attempt_id: string;
  fencing_token: number;
  effect_key: string;
  provider: string;
  account_ref: string;
  target_hash: string;
  payload_hash: string;
  effect_class: ServiceReadinessEffectClassV1;
  status: ServiceReadinessEffectLedgerStatusV1;
  external_action_executed: boolean;
  provider_receipt_hash: string | null;
  cleanup_receipt_hash: string | null;
  exact_blocker: string | null;
  safe_resume_step: string | null;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
  reservation_id: string | null;
  reservation_token_hash: string | null;
  capability_id: string | null;
  approval_id: string | null;
  approval_revision: number | null;
};

export type ServiceReadinessEffectTransitionInputV1 = Pick<
  ServiceReadinessEvidenceV1,
  "root_id" | "workflow_id" | "run_id" | "stage_id" | "attempt_id" | "fencing_token"
> & {
  company_id?: string;
  capability_id?: string;
  approval_id?: string;
  approval_revision?: number;
  reservation_id?: string | null;
  reservation_token_hash?: string | null;
  effect_key: string;
  status: ServiceReadinessEffectTransitionStatusV1;
  external_action_executed?: boolean;
  provider_receipt_hash?: string | null;
  cleanup_receipt_hash?: string | null;
  exact_blocker?: string | null;
  safe_resume_step?: string | null;
};

export class ServiceReadinessEffectLedgerError extends ServiceReadinessContractError {
  constructor(code: string) {
    super(code);
    this.name = "ServiceReadinessEffectLedgerError";
  }
}

const hashPattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const effectClasses = new Set<ServiceReadinessEffectClassV1>([
  "internal_idempotent",
  "external_non_idempotent"
]);
const ledgerStatuses = new Set<ServiceReadinessEffectLedgerStatusV1>([
  "running",
  "succeeded",
  "failed",
  "blocked",
  "reconciliation_required",
  "cancelled"
]);
const bindingFields = [
  "root_id",
  "workflow_id",
  "run_id",
  "stage_id",
  "attempt_id",
  "fencing_token",
  "provider",
  "account_ref",
  "target_hash",
  "payload_hash",
  "effect_class"
] as const;

type LedgerRow = {
  company_id: string;
  effect_key: string;
  root_id: string;
  workflow_id: string;
  run_id: string;
  stage_id: string;
  attempt_id: string;
  fencing_token: number;
  provider: string;
  account_ref: string;
  target_hash: string;
  payload_hash: string;
  effect_class: ServiceReadinessEffectClassV1;
  status: ServiceReadinessEffectLedgerStatusV1;
  external_action_executed: number;
  provider_receipt_hash: string | null;
  cleanup_receipt_hash: string | null;
  exact_blocker: string | null;
  safe_resume_step: string | null;
  created_at: string;
  updated_at: string;
  terminal_at: string | null;
  reservation_id: string | null;
  reservation_token_hash: string | null;
  capability_id: string | null;
  approval_id: string | null;
  approval_revision: number | null;
};

/**
 * Stable JSON for the effect fingerprint.  Field order is explicit and does
 * not depend on caller object insertion order.
 */
function effectFingerprintPreimage(input: {
  company_id?: string;
  provider: string;
  account_ref: string;
  target_hash: string;
  payload_hash: string;
  effect_class: ServiceReadinessEffectClassV1;
}): string {
  const base = {
    account_ref: input.account_ref,
    effect_class: input.effect_class,
    payload_hash: input.payload_hash,
    provider: input.provider,
    target_hash: input.target_hash
  };
  return canonicalJson(input.company_id === undefined ? base : { company_id: input.company_id, ...base });
}

function assertFingerprintInput(input: {
  company_id?: unknown;
  provider: unknown;
  account_ref: unknown;
  target_hash: unknown;
  payload_hash: unknown;
  effect_class: unknown;
}): asserts input is {
  provider: string;
  account_ref: string;
  target_hash: string;
  payload_hash: string;
  effect_class: ServiceReadinessEffectClassV1;
} {
  if (
    typeof input.provider !== "string" ||
    !identifierPattern.test(input.provider) ||
    typeof input.account_ref !== "string" ||
    input.account_ref.length === 0 ||
    input.account_ref.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(input.account_ref) ||
    typeof input.target_hash !== "string" ||
    !hashPattern.test(input.target_hash) ||
    typeof input.payload_hash !== "string" ||
    !hashPattern.test(input.payload_hash) ||
    typeof input.effect_class !== "string" ||
    !effectClasses.has(input.effect_class as ServiceReadinessEffectClassV1)
  ) {
    throw new ServiceReadinessEffectLedgerError("service_readiness_effect_fingerprint_input_invalid");
  }
  if (input.company_id !== undefined &&
      (typeof input.company_id !== "string" || !identifierPattern.test(input.company_id))) {
    throw new ServiceReadinessEffectLedgerError("service_readiness_effect_company_id_invalid");
  }
}

/** Compute the canonical no-replay key for one provider effect. */
export function computeServiceReadinessEffectKey(input: {
  company_id?: string;
  provider: string;
  account_ref: string;
  target_hash: string;
  payload_hash: string;
  effect_class: ServiceReadinessEffectClassV1;
}): string {
  assertFingerprintInput(input);
  return createHash("sha256").update(effectFingerprintPreimage(input), "utf8").digest("hex");
}

export const computeServiceReadinessEffectFingerprint = computeServiceReadinessEffectKey;

function normalizeTerminalStatus(status: ServiceReadinessEffectTransitionStatusV1): ServiceReadinessEffectLedgerStatusV1 {
  if (status === "ambiguous") return "reconciliation_required";
  if (!ledgerStatuses.has(status)) throw new ServiceReadinessEffectLedgerError("service_readiness_effect_transition_status_invalid");
  return status;
}

function requiredHash(value: unknown, blocker: string): string {
  if (typeof value !== "string" || !hashPattern.test(value)) {
    throw new ServiceReadinessEffectLedgerError(blocker);
  }
  return value;
}

function nullableHash(value: unknown, blocker: string): string | null {
  if (value === undefined || value === null) return null;
  return requiredHash(value, blocker);
}

function nullableText(value: unknown, blocker: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 240 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ServiceReadinessEffectLedgerError(blocker);
  }
  return value;
}

function ledgerRowFromDb(row: LedgerRow | undefined): ServiceReadinessEffectLedgerEntryV1 | undefined {
  if (!row) return undefined;
  return {
    company_id: row.company_id ?? "legacy",
    effect_key: row.effect_key,
    root_id: row.root_id,
    workflow_id: row.workflow_id,
    run_id: row.run_id,
    stage_id: row.stage_id,
    attempt_id: row.attempt_id,
    fencing_token: Number(row.fencing_token),
    provider: row.provider,
    account_ref: row.account_ref,
    target_hash: row.target_hash,
    payload_hash: row.payload_hash,
    effect_class: row.effect_class,
    status: row.status,
    external_action_executed: Number(row.external_action_executed) === 1,
    provider_receipt_hash: row.provider_receipt_hash ?? null,
    cleanup_receipt_hash: row.cleanup_receipt_hash ?? null,
    exact_blocker: row.exact_blocker ?? null,
    safe_resume_step: row.safe_resume_step ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    terminal_at: row.terminal_at ?? null,
    reservation_id: row.reservation_id ?? null,
    reservation_token_hash: row.reservation_token_hash ?? null,
    capability_id: row.capability_id ?? null,
    approval_id: row.approval_id ?? null,
    approval_revision: row.approval_revision === null || row.approval_revision === undefined
      ? null
      : Number(row.approval_revision)
  };
}

function rowForEffect(effectKey: string, companyId?: string): LedgerRow | undefined {
  return querySql<LedgerRow>(
    `SELECT effect_key, root_id, workflow_id, run_id, stage_id, attempt_id,
            fencing_token, provider, account_ref, target_hash, payload_hash, effect_class, status,
            external_action_executed, provider_receipt_hash, cleanup_receipt_hash, exact_blocker,
            safe_resume_step, created_at, updated_at, terminal_at,
            company_id, reservation_id, reservation_token_hash, capability_id, approval_id, approval_revision
       FROM service_readiness_effect_ledger
      WHERE effect_key=${sqlValue(effectKey)}${companyId === undefined ? "" : ` AND company_id=${sqlValue(companyId)}`}
      LIMIT 1`
  )[0];
}

function assertEffectKey(effectKey: unknown): string {
  if (typeof effectKey !== "string" || !hashPattern.test(effectKey)) {
    throw new ServiceReadinessEffectLedgerError("service_readiness_effect_key_invalid");
  }
  return effectKey;
}

function bindingMatches(row: LedgerRow, evidence: ServiceReadinessEvidenceV1): boolean {
  if ((evidence.company_id ?? "legacy") !== (row.company_id ?? "legacy")) return false;
  for (const field of bindingFields) {
    if (row[field] !== evidence[field]) return false;
  }
  return true;
}

function transitionBindingMatches(row: LedgerRow, input: ServiceReadinessEffectTransitionInputV1): boolean {
  if (input.company_id !== undefined && row.company_id !== input.company_id) return false;
  if (input.capability_id !== undefined && row.capability_id !== input.capability_id) return false;
  if (input.approval_id !== undefined && row.approval_id !== input.approval_id) return false;
  if (input.approval_revision !== undefined && row.approval_revision !== input.approval_revision) return false;
  if (input.reservation_id !== undefined && row.reservation_id !== input.reservation_id) return false;
  if (input.reservation_token_hash !== undefined && row.reservation_token_hash !== input.reservation_token_hash) return false;
  for (const field of ["root_id", "workflow_id", "run_id", "stage_id", "attempt_id", "fencing_token"] as const) {
    if (row[field] !== input[field]) return false;
  }
  return true;
}

function reserveInsertSql(evidence: ServiceReadinessEvidenceV1, timestamp: string, effectKey: string): string {
  return `INSERT INTO service_readiness_effect_ledger
    (effect_key, company_id, reservation_id, reservation_token_hash, capability_id, approval_id, approval_revision,
     root_id, workflow_id, run_id, stage_id, attempt_id,
     fencing_token, provider, account_ref, target_hash, payload_hash, effect_class, status,
     external_action_executed, provider_receipt_hash, cleanup_receipt_hash, exact_blocker,
     safe_resume_step, created_at, updated_at, terminal_at)
   VALUES (${sqlValue(effectKey)}, ${sqlValue(evidence.company_id ?? "legacy")}, ${sqlValue(effectKey)}, NULL,
           ${sqlValue(evidence.effect_class === "external_non_idempotent" ? evidence.capability_id : "")},
           '', 0, ${sqlValue(evidence.root_id)}, ${sqlValue(evidence.workflow_id)},
           ${sqlValue(evidence.run_id)}, ${sqlValue(evidence.stage_id)}, ${sqlValue(evidence.attempt_id)},
           ${sqlValue(evidence.fencing_token)}, ${sqlValue(evidence.provider)}, ${sqlValue(evidence.account_ref)},
           ${sqlValue(evidence.target_hash)}, ${sqlValue(evidence.payload_hash)}, ${sqlValue(evidence.effect_class)},
           'running', ${sqlValue(evidence.external_action_executed)}, ${sqlValue(evidence.provider_receipt_hash)}, NULL, NULL, NULL,
           ${sqlValue(timestamp)}, ${sqlValue(timestamp)}, NULL)`;
}

/** Reserve one effect as running, rejecting replay and cross-binding. */
export function reserveServiceReadinessEffect(evidenceInput: ServiceReadinessEvidenceV1): ServiceReadinessEffectLedgerEntryV1 {
  let evidence: ServiceReadinessEvidenceV1;
  try {
    evidence = parseServiceReadinessEvidenceV1(evidenceInput);
  } catch (error) {
    if (error instanceof ServiceReadinessEffectLedgerError) throw error;
    throw error;
  }
  if (evidence.status !== "running") {
    throw new ServiceReadinessEffectLedgerError("service_readiness_effect_reserve_status_invalid");
  }
  if (evidence.effect_class === "external_non_idempotent") {
    throw new ServiceReadinessEffectLedgerError("service_readiness_external_atomic_gate_required");
  }
  const effectKey = computeServiceReadinessEffectKey({ ...evidence, company_id: evidence.company_id });
  if (evidence.effect_key !== effectKey) {
    throw new ServiceReadinessEffectLedgerError("service_readiness_effect_key_binding_mismatch");
  }

  const existing = rowForEffect(effectKey, evidence.company_id ?? "legacy");
  if (existing) {
    if (!bindingMatches(existing, evidence)) {
      throw new ServiceReadinessEffectLedgerError("service_readiness_effect_binding_mismatch");
    }
    throw new ServiceReadinessEffectLedgerError(`service_readiness_effect_replay_forbidden:${effectKey}`);
  }

  const timestamp = nowIso();
  try {
    runSqlTransaction([{ sql: reserveInsertSql(evidence, timestamp, effectKey), expectChanges: 1 }]);
  } catch (error) {
    // A concurrent reservation may have won the unique effect-key race.  Read
    // back the winner and classify it instead of leaking a raw SQL error.
    const raced = rowForEffect(effectKey, evidence.company_id ?? "legacy");
    if (raced) {
      if (!bindingMatches(raced, evidence)) {
        throw new ServiceReadinessEffectLedgerError("service_readiness_effect_binding_mismatch");
      }
      throw new ServiceReadinessEffectLedgerError(`service_readiness_effect_replay_forbidden:${effectKey}`);
    }
    throw error;
  }
  const reserved = ledgerRowFromDb(rowForEffect(effectKey, evidence.company_id ?? "legacy"));
  if (!reserved) throw new ServiceReadinessEffectLedgerError("service_readiness_effect_reservation_readback_missing");
  return reserved;
}

/** Transition exactly one running effect to a terminal state. */
export function transitionServiceReadinessEffect(input: ServiceReadinessEffectTransitionInputV1): ServiceReadinessEffectLedgerEntryV1 {
  const effectKey = assertEffectKey(input.effect_key);
  const row = rowForEffect(effectKey, input.company_id);
  if (!row) throw new ServiceReadinessEffectLedgerError("service_readiness_effect_not_found");
  if (row.effect_class === "external_non_idempotent") {
    throw new ServiceReadinessEffectLedgerError("service_readiness_external_atomic_gate_required");
  }
  if (!transitionBindingMatches(row, input)) {
    throw new ServiceReadinessEffectLedgerError("service_readiness_effect_binding_mismatch");
  }
  if (row.status !== "running") {
    throw new ServiceReadinessEffectLedgerError("service_readiness_effect_terminal_transition_forbidden");
  }
  const status = normalizeTerminalStatus(input.status);
  if (status === "running") {
    throw new ServiceReadinessEffectLedgerError("service_readiness_effect_transition_status_invalid");
  }
  const providerReceiptHash = input.provider_receipt_hash === undefined
    ? row.provider_receipt_hash
    : nullableHash(input.provider_receipt_hash, "service_readiness_provider_receipt_hash_invalid");
  const cleanupReceiptHash = input.cleanup_receipt_hash === undefined
    ? row.cleanup_receipt_hash
    : nullableHash(input.cleanup_receipt_hash, "service_readiness_cleanup_receipt_hash_invalid");
  if (cleanupReceiptHash === null) {
    throw new ServiceReadinessEffectLedgerError("service_readiness_terminal_cleanup_required");
  }
  const exactBlocker = nullableText(input.exact_blocker, "service_readiness_exact_blocker_invalid");
  const safeResumeStep = nullableText(input.safe_resume_step, "service_readiness_safe_resume_step_invalid");
  const externalActionExecuted = input.external_action_executed ?? row.external_action_executed === 1;
  if (typeof externalActionExecuted !== "boolean") {
    throw new ServiceReadinessEffectLedgerError("service_readiness_external_action_executed_invalid");
  }
  if (status === "succeeded" && exactBlocker !== null) {
    throw new ServiceReadinessEffectLedgerError("service_readiness_success_blocker_fields_forbidden");
  }

  const timestamp = nowIso();
  const terminalSql = `UPDATE service_readiness_effect_ledger
    SET status=${sqlValue(status)}, external_action_executed=${sqlValue(externalActionExecuted)},
        provider_receipt_hash=${sqlValue(providerReceiptHash)}, cleanup_receipt_hash=${sqlValue(cleanupReceiptHash)},
        exact_blocker=${sqlValue(exactBlocker)}, safe_resume_step=${sqlValue(safeResumeStep)},
        updated_at=${sqlValue(timestamp)}, terminal_at=${sqlValue(timestamp)}
  WHERE effect_key=${sqlValue(effectKey)} AND status='running'${input.company_id === undefined ? "" : ` AND company_id=${sqlValue(input.company_id)}`}
    ${input.reservation_id === undefined ? "" : `AND reservation_id=${sqlValue(input.reservation_id)}`}
    ${input.reservation_token_hash === undefined ? "" : `AND reservation_token_hash=${sqlValue(input.reservation_token_hash)}`}
    AND root_id=${sqlValue(input.root_id)} AND workflow_id=${sqlValue(input.workflow_id)}
    AND run_id=${sqlValue(input.run_id)} AND stage_id=${sqlValue(input.stage_id)}
    AND attempt_id=${sqlValue(input.attempt_id)} AND fencing_token=${sqlValue(input.fencing_token)}
    ${input.capability_id === undefined ? "" : `AND capability_id=${sqlValue(input.capability_id)}`}
    ${input.approval_id === undefined ? "" : `AND approval_id=${sqlValue(input.approval_id)}`}
    ${input.approval_revision === undefined ? "" : `AND approval_revision=${sqlValue(input.approval_revision)}`}`;
  try {
    const transitionSteps: SqlTransactionStep[] = [{ sql: terminalSql, expectChanges: 1 }];
    runSqlTransaction(transitionSteps);
  } catch (error) {
    const afterRace = rowForEffect(effectKey, input.company_id);
    if (afterRace && afterRace.status !== "running") {
      throw new ServiceReadinessEffectLedgerError("service_readiness_effect_terminal_transition_forbidden");
    }
    throw error;
  }
  const transitioned = ledgerRowFromDb(rowForEffect(effectKey, input.company_id));
  if (!transitioned) throw new ServiceReadinessEffectLedgerError("service_readiness_effect_transition_readback_missing");
  return transitioned;
}

/** Return one durable effect row, or undefined when the key is unknown. */
export function readServiceReadinessEffect(effectKeyInput: string, companyId?: string): ServiceReadinessEffectLedgerEntryV1 | undefined {
  const effectKey = assertEffectKey(effectKeyInput);
  const row = rowForEffect(effectKey, companyId);
  if (row?.effect_class === "external_non_idempotent" && companyId === undefined) {
    throw new ServiceReadinessEffectLedgerError("service_readiness_external_company_required");
  }
  return ledgerRowFromDb(row);
}

export const reserveServiceReadinessEffectV1 = reserveServiceReadinessEffect;
export const transitionServiceReadinessEffectV1 = transitionServiceReadinessEffect;
export const readServiceReadinessEffectV1 = readServiceReadinessEffect;
export const getServiceReadinessEffect = readServiceReadinessEffect;

/** Small object API for callers that prefer a ledger instance. */
export class ServiceReadinessEffectLedger {
  reserve(evidence: ServiceReadinessEvidenceV1): ServiceReadinessEffectLedgerEntryV1 {
    return reserveServiceReadinessEffect(evidence);
  }

  transition(input: ServiceReadinessEffectTransitionInputV1): ServiceReadinessEffectLedgerEntryV1 {
    return transitionServiceReadinessEffect(input);
  }

  read(effectKey: string, companyId?: string): ServiceReadinessEffectLedgerEntryV1 | undefined {
    return readServiceReadinessEffect(effectKey, companyId);
  }
}

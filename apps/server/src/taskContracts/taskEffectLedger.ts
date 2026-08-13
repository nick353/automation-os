import { nowIso, querySql, runSqlTransaction, sqlValue } from "../db/client.js";
import { operationKey, transitionEffect, type EffectEvent, type EffectRecordV1 } from "./taskOsAdvanced.js";

export type DurableTaskEffectRow = EffectRecordV1 & {
  company_id: string;
  trace_id: string;
  workflow_id: string;
  provider_receipt_hash: string | null;
  source_sync_hash: string | null;
  reconciliation_hash: string | null;
  cleanup_hash: string | null;
  restart_point: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
};

function safe(value: string, code: string): string {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > 500) throw new Error(code);
  return normalized;
}

function hash(value: string, code: string): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new Error(code);
  return normalized;
}

function row(value: DurableTaskEffectRow): DurableTaskEffectRow {
  return { ...value, external_action_executed: Boolean(value.external_action_executed), ambiguous: Boolean(value.ambiguous), retry_forbidden: Boolean(value.retry_forbidden) };
}

export function reserveDurableTaskEffect(input: { companyId: string; traceId: string; taskId: string; workflowId: string; targetHash: string; payloadHash: string; audienceHash: string; idempotencyKey: string }): { operationKey: string; replay: boolean; effect: DurableTaskEffectRow } {
  const companyId = safe(input.companyId, "task_effect_company_required");
  const traceId = safe(input.traceId, "task_effect_trace_required");
  const taskId = safe(input.taskId, "task_effect_task_required");
  const workflowId = safe(input.workflowId, "task_effect_workflow_required");
  const targetHash = hash(input.targetHash, "task_effect_target_hash_invalid");
  const payloadHash = hash(input.payloadHash, "task_effect_payload_hash_invalid");
  const audienceHash = hash(input.audienceHash, "task_effect_audience_hash_invalid");
  const key = operationKey({ taskId, targetHash, payloadHash, audienceHash, idempotencyKey: safe(input.idempotencyKey, "task_effect_idempotency_required") });
  const existing = querySql<DurableTaskEffectRow>(`SELECT * FROM task_effect_ledger WHERE company_id=${sqlValue(companyId)} AND operation_key=${sqlValue(key)} LIMIT 1`)[0];
  if (existing) return { operationKey: key, replay: true, effect: row(existing) };
  const now = nowIso();
  const effect: DurableTaskEffectRow = {
    schema: "automation_os_effect_state.v1",
    operation_key: key,
    company_id: companyId,
    trace_id: traceId,
    task_id: taskId,
    workflow_id: workflowId,
    target_hash: targetHash,
    payload_hash: payloadHash,
    audience_hash: audienceHash,
    state: "planned",
    external_action_executed: false,
    ambiguous: false,
    retry_forbidden: false,
    provider_receipt_hash: null,
    source_sync_hash: null,
    reconciliation_hash: null,
    cleanup_hash: null,
    exact_blocker: null,
    restart_point: "effect_planned",
    created_at: now,
    updated_at: now,
    closed_at: null
  };
  runSqlTransaction([{
    sql: `INSERT INTO task_effect_ledger
      (operation_key, company_id, trace_id, task_id, workflow_id, target_hash, payload_hash, audience_hash, state,
       external_action_executed, ambiguous, retry_forbidden, provider_receipt_hash, source_sync_hash,
       reconciliation_hash, cleanup_hash, exact_blocker, restart_point, created_at, updated_at, closed_at)
      VALUES (${sqlValue(key)}, ${sqlValue(companyId)}, ${sqlValue(traceId)}, ${sqlValue(taskId)}, ${sqlValue(workflowId)},
        ${sqlValue(targetHash)}, ${sqlValue(payloadHash)}, ${sqlValue(audienceHash)}, 'planned', 0, 0, 0, NULL, NULL, NULL, NULL, NULL,
        ${sqlValue("effect_planned")}, ${sqlValue(now)}, ${sqlValue(now)}, NULL)`,
    expectChanges: 1
  }]);
  return { operationKey: key, replay: false, effect };
}

export function transitionDurableTaskEffect(input: { companyId: string; operationKey: string; event: EffectEvent; providerReceiptHash?: string | null; sourceSyncHash?: string | null; reconciliationHash?: string | null; cleanupHash?: string | null; restartPoint?: string }): DurableTaskEffectRow {
  const companyId = safe(input.companyId, "task_effect_company_required");
  const operation = safe(input.operationKey, "task_effect_operation_required");
  const current = querySql<DurableTaskEffectRow>(`SELECT * FROM task_effect_ledger WHERE company_id=${sqlValue(companyId)} AND operation_key=${sqlValue(operation)} LIMIT 1`)[0];
  if (!current) throw new Error("task_effect_operation_missing");
  const currentRecord: EffectRecordV1 = row(current);
  const next = transitionEffect(currentRecord, input.event);
  const now = nowIso();
  const external = ["intent", "confirmed", "reconciled", "closed"].includes(next.state);
  const ambiguous = next.ambiguous;
  const blocker = next.exact_blocker;
  const closedAt = next.state === "closed" ? now : current.closed_at;
  runSqlTransaction([{
    sql: `UPDATE task_effect_ledger SET state=${sqlValue(next.state)}, external_action_executed=${external ? 1 : 0}, ambiguous=${ambiguous ? 1 : 0}, retry_forbidden=${next.retry_forbidden ? 1 : 0},
      provider_receipt_hash=${sqlValue(input.providerReceiptHash === undefined ? current.provider_receipt_hash : input.providerReceiptHash)},
      source_sync_hash=${sqlValue(input.sourceSyncHash === undefined ? current.source_sync_hash : input.sourceSyncHash)},
      reconciliation_hash=${sqlValue(input.reconciliationHash === undefined ? current.reconciliation_hash : input.reconciliationHash)},
      cleanup_hash=${sqlValue(input.cleanupHash === undefined ? current.cleanup_hash : input.cleanupHash)},
      exact_blocker=${sqlValue(blocker)}, restart_point=${sqlValue(input.restartPoint ?? (ambiguous ? "reconciliation_without_replay" : next.state))}, updated_at=${sqlValue(now)}, closed_at=${sqlValue(closedAt)}
      WHERE company_id=${sqlValue(companyId)} AND operation_key=${sqlValue(operation)}`,
    expectChanges: 1
  }]);
  const updated = querySql<DurableTaskEffectRow>(`SELECT * FROM task_effect_ledger WHERE company_id=${sqlValue(companyId)} AND operation_key=${sqlValue(operation)} LIMIT 1`)[0];
  if (!updated) throw new Error("task_effect_readback_missing");
  return row(updated);
}

export function getDurableTaskEffect(companyId: string, operationKeyValue: string): DurableTaskEffectRow | null {
  const current = querySql<DurableTaskEffectRow>(`SELECT * FROM task_effect_ledger WHERE company_id=${sqlValue(safe(companyId, "task_effect_company_required"))} AND operation_key=${sqlValue(safe(operationKeyValue, "task_effect_operation_required"))} LIMIT 1`)[0];
  return current ? row(current) : null;
}

export function completeDurableTaskEffect(input: { companyId: string; operationKey: string; providerReceiptHash: string; sourceSyncHash: string; reconciliationHash: string; cleanupHash: string }): DurableTaskEffectRow {
  hash(input.providerReceiptHash, "task_effect_provider_receipt_hash_invalid");
  hash(input.sourceSyncHash, "task_effect_source_sync_hash_invalid");
  hash(input.reconciliationHash, "task_effect_reconciliation_hash_invalid");
  hash(input.cleanupHash, "task_effect_cleanup_hash_invalid");
  let effect = transitionDurableTaskEffect({ companyId: input.companyId, operationKey: input.operationKey, event: "confirmed", providerReceiptHash: input.providerReceiptHash });
  effect = transitionDurableTaskEffect({ companyId: input.companyId, operationKey: input.operationKey, event: "reconciled", sourceSyncHash: input.sourceSyncHash, reconciliationHash: input.reconciliationHash });
  return transitionDurableTaskEffect({ companyId: input.companyId, operationKey: input.operationKey, event: "closed", cleanupHash: input.cleanupHash, restartPoint: "closed" });
}

export function admitAndStartDurableTaskEffect(companyId: string, operationKeyValue: string): DurableTaskEffectRow {
  let effect = getDurableTaskEffect(companyId, operationKeyValue);
  if (!effect) throw new Error("task_effect_operation_missing");
  if (effect.state === "planned") effect = transitionDurableTaskEffect({ companyId, operationKey: operationKeyValue, event: "admit" });
  if (effect.state === "admitted") effect = transitionDurableTaskEffect({ companyId, operationKey: operationKeyValue, event: "start" });
  return effect;
}

export function syncDurableTaskEffectFromWorker(input: { companyId: string; operationKey: string; status: "complete" | "partial" | "blocked"; externalActionExecuted: boolean; sameRunSourceSync: boolean; readbackVerified: boolean; cleanupVerified: boolean; providerReceiptHash?: string | null; sourceSyncHash?: string | null; reconciliationHash?: string | null; cleanupHash?: string | null }): DurableTaskEffectRow | null {
  let effect = getDurableTaskEffect(input.companyId, input.operationKey);
  if (!effect) return null;
  if (!input.externalActionExecuted) return effect;
  if (effect.state === "planned" || effect.state === "admitted") effect = admitAndStartDurableTaskEffect(input.companyId, input.operationKey);
  if (effect.state === "executing") effect = transitionDurableTaskEffect({ companyId: input.companyId, operationKey: input.operationKey, event: "intent_sent", providerReceiptHash: input.providerReceiptHash });
  if (input.status === "complete" && input.sameRunSourceSync && input.readbackVerified && input.cleanupVerified) {
    if (effect.state === "intent") effect = transitionDurableTaskEffect({ companyId: input.companyId, operationKey: input.operationKey, event: "confirmed", providerReceiptHash: input.providerReceiptHash });
    if (effect.state === "confirmed") effect = transitionDurableTaskEffect({ companyId: input.companyId, operationKey: input.operationKey, event: "reconciled", sourceSyncHash: input.sourceSyncHash, reconciliationHash: input.reconciliationHash });
    if (effect.state === "reconciled") effect = transitionDurableTaskEffect({ companyId: input.companyId, operationKey: input.operationKey, event: "closed", cleanupHash: input.cleanupHash, restartPoint: "closed" });
    return effect;
  }
  if (effect.state === "intent") return transitionDurableTaskEffect({ companyId: input.companyId, operationKey: input.operationKey, event: input.status === "blocked" ? "ambiguous" : "timeout", restartPoint: "reconciliation_without_replay" });
  return effect;
}

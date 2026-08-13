import assert from "node:assert/strict";
import test from "node:test";
import { querySql } from "../db/client.js";
import { completeDurableTaskEffect, reserveDurableTaskEffect, transitionDurableTaskEffect } from "../taskContracts/taskEffectLedger.js";
import { declareSourceOfTruth } from "../runs/sourceOfTruth.js";

const hash = "a".repeat(64);
const suffix = Date.now().toString(36);

test("durable Task Effect Ledger persists exactly-once operation and ambiguous no-replay state", () => {
  const companyId = `company_ledger_${suffix}`;
  const reserved = reserveDurableTaskEffect({ companyId, traceId: "trace_ledger", taskId: "task_ledger", workflowId: "generic-task", targetHash: hash, payloadHash: hash, audienceHash: hash, idempotencyKey: `idem_ledger_${suffix}` });
  assert.equal(reserved.replay, false);
  const replay = reserveDurableTaskEffect({ companyId, traceId: "trace_ledger", taskId: "task_ledger", workflowId: "generic-task", targetHash: hash, payloadHash: hash, audienceHash: hash, idempotencyKey: `idem_ledger_${suffix}` });
  assert.equal(replay.replay, true);
  transitionDurableTaskEffect({ companyId, operationKey: reserved.operationKey, event: "admit" });
  transitionDurableTaskEffect({ companyId, operationKey: reserved.operationKey, event: "start" });
  transitionDurableTaskEffect({ companyId, operationKey: reserved.operationKey, event: "intent_sent" });
  const ambiguous = transitionDurableTaskEffect({ companyId, operationKey: reserved.operationKey, event: "timeout" });
  assert.equal(ambiguous.state, "intent");
  assert.equal(ambiguous.external_action_executed, true);
  assert.equal(ambiguous.retry_forbidden, true);
  assert.equal(ambiguous.exact_blocker, "effect_ambiguous_reconciliation_required_no_replay");
  assert.ok(querySql(`SELECT operation_key FROM task_effect_ledger WHERE company_id='${companyId}'`).length === 1);
});

test("durable effect ledger closes only after receipt/source sync/reconciliation/cleanup hashes", () => {
  const companyId = `company_ledger_complete_${suffix}`;
  const reserved = reserveDurableTaskEffect({ companyId, traceId: "trace_complete", taskId: "task_complete", workflowId: "generic-task", targetHash: hash, payloadHash: hash, audienceHash: hash, idempotencyKey: `idem_complete_${suffix}` });
  transitionDurableTaskEffect({ companyId, operationKey: reserved.operationKey, event: "admit" });
  transitionDurableTaskEffect({ companyId, operationKey: reserved.operationKey, event: "start" });
  transitionDurableTaskEffect({ companyId, operationKey: reserved.operationKey, event: "intent_sent" });
  const completed = completeDurableTaskEffect({ companyId, operationKey: reserved.operationKey, providerReceiptHash: hash, sourceSyncHash: hash, reconciliationHash: hash, cleanupHash: hash });
  assert.equal(completed.state, "closed");
  assert.equal(completed.external_action_executed, true);
  assert.equal(completed.cleanup_hash, hash);
});

test("source of truth rejects production declaration on local SQLite", () => {
  assert.equal(declareSourceOfTruth({ kind: "production_aos", companyId: "company_1", runId: "run_1" }).exact_blocker, "production_aos_requires_postgres_source_of_truth");
  assert.equal(declareSourceOfTruth({ kind: "local_aos", companyId: "company_1", runId: "run_1" }).exact_blocker, null);
});

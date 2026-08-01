import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-effect-ledger-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");

const {
  computeServiceReadinessEffectKey,
  readServiceReadinessEffect,
  reserveServiceReadinessEffect,
  transitionServiceReadinessEffect
} = await import("../serviceReadiness/effectLedger.js");
const { querySql } = await import("../db/client.js");

const hashes = {
  target: "a".repeat(64),
  payload: "b".repeat(64),
  provider: "c".repeat(64),
  cleanup: "d".repeat(64)
};

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function baseEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const body = {
    schema: "service_readiness.evidence.v1",
    root_id: "root-company-a",
    workflow_id: "daily-ai",
    run_id: "run-20260722-01",
    stage_id: "publish",
    attempt_id: "attempt-1",
    fencing_token: 1,
    capability_id: "capability-1",
    turn_id: "turn-1",
    session_id: "session-1",
    nonce: "nonce-1",
    capability_mode: "read_only",
    provider: "linkedin",
    account_ref: "account-page-a",
    target_hash: hashes.target,
    payload_hash: hashes.payload,
    effect_class: "internal_idempotent",
    status: "running",
    external_action_executed: false,
    provider_receipt_hash: null,
    cleanup_receipt_hash: null,
    exact_blocker: null,
    safe_resume_step: null,
    ...overrides
  };
  return {
    ...body,
    effect_key:
      typeof overrides.effect_key === "string"
        ? overrides.effect_key
        : computeServiceReadinessEffectKey(body as {
            provider: string;
            account_ref: string;
            target_hash: string;
            payload_hash: string;
            effect_class: "internal_idempotent";
          })
  };
}

function transitionInput(
  evidence: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    root_id: evidence.root_id,
    workflow_id: evidence.workflow_id,
    run_id: evidence.run_id,
    stage_id: evidence.stage_id,
    attempt_id: evidence.attempt_id,
    fencing_token: evidence.fencing_token,
    effect_key: evidence.effect_key,
    status: "succeeded",
    external_action_executed: false,
    provider_receipt_hash: hashes.provider,
    cleanup_receipt_hash: hashes.cleanup,
    ...overrides
  };
}

test.after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

test("reserves one effect, rejects replay and cross-binding, and reads back terminal receipts", () => {
  const evidence = baseEvidence();
  const reserved = reserveServiceReadinessEffect(evidence as never);
  assert.equal(reserved.status, "running");
  assert.equal(reserved.effect_key, evidence.effect_key);
  assert.equal(reserved.provider_receipt_hash, null);
  assert.equal(reserved.cleanup_receipt_hash, null);

  assert.throws(
    () => reserveServiceReadinessEffect(evidence as never),
    /service_readiness_effect_replay_forbidden/
  );

  const crossBound = baseEvidence({ run_id: "run-20260722-other", effect_key: evidence.effect_key });
  assert.throws(
    () => reserveServiceReadinessEffect(crossBound as never),
    /service_readiness_effect_binding_mismatch/
  );

  const succeeded = transitionServiceReadinessEffect(transitionInput(evidence) as never);
  assert.equal(succeeded.status, "succeeded");
  assert.equal(succeeded.external_action_executed, false);
  assert.equal(succeeded.provider_receipt_hash, hashes.provider);
  assert.equal(succeeded.cleanup_receipt_hash, hashes.cleanup);
  assert.equal(readServiceReadinessEffect(evidence.effect_key as string)?.status, "succeeded");

  assert.throws(
    () => transitionServiceReadinessEffect(transitionInput(evidence, { status: "failed" }) as never),
    /service_readiness_effect_terminal_transition_forbidden/
  );
});

test("requires a cleanup receipt before a running effect can become terminal", () => {
  const evidence = baseEvidence({
    run_id: "run-20260722-no-cleanup",
    target_hash: sha256("https://example.test/no-cleanup")
  });
  reserveServiceReadinessEffect(evidence as never);
  assert.throws(
    () => transitionServiceReadinessEffect(transitionInput(evidence, { cleanup_receipt_hash: null }) as never),
    /service_readiness_terminal_cleanup_required/
  );
});

test("legacy effect ledger API refuses direct external reservations", () => {
  const evidence = baseEvidence({
    run_id: "run-20260722-ambiguous",
    target_hash: sha256("https://example.test/ambiguous"),
    effect_class: "external_non_idempotent"
  });
  assert.throws(
    () => reserveServiceReadinessEffect(evidence as never),
    /service_readiness_external_atomic_gate_required/
  );
});

test("rejects a caller effect key that is not the canonical provider binding", () => {
  const evidence = baseEvidence({
    run_id: "run-20260722-key-mismatch",
    effect_key: "e".repeat(64)
  });
  assert.throws(
    () => reserveServiceReadinessEffect(evidence as never),
    /service_readiness_effect_key_binding_mismatch/
  );
});

test("persists exactly one durable row and the status index is available", () => {
  const rows = querySql<{ count: number }>(
    "SELECT COUNT(*) AS count FROM service_readiness_effect_ledger"
  );
  assert.equal(Number(rows[0]?.count), 2);
  const indexes = querySql<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'service_readiness_effect_ledger_%'"
  ).map((row) => row.name);
  assert.deepEqual(indexes.sort(), [
    "service_readiness_effect_ledger_binding_idx",
    "service_readiness_effect_ledger_company_capability_idx",
    "service_readiness_effect_ledger_company_effect_idx",
    "service_readiness_effect_ledger_status_idx"
  ]);
});

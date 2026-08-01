import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import {
  JOB_MANAGER_WORKFLOW_CONTRACT_SCHEMA_V1,
  JobManagerEffectLedgerV1,
  parseJobManagerWorkflowContractV1,
  validateJobManagerWorkflowContractV1
} from "../serviceReadiness/workflowContracts/jobManager.js";

const targetUrl = "https://jobs.example.test/listing/123";
const targetHash = sha256(targetUrl);
const hashes = {
  payload: "b".repeat(64),
  provider: "c".repeat(64),
  cleanup: "d".repeat(64),
  message: "e".repeat(64)
};

function baseContract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: JOB_MANAGER_WORKFLOW_CONTRACT_SCHEMA_V1,
    root_id: "root-company-a",
    workflow_id: "job-application-manager",
    run_id: "run-20260722-01",
    stage_id: "submit",
    attempt_id: "attempt-1",
    fencing_token: 1,
    capability_id: "job-manager-capability",
    turn_id: "turn-1",
    session_id: "session-1",
    nonce: "nonce-1",
    capability_mode: "external",
    provider: "linkedin",
    account_ref: "linkedin-account-a",
    job_board: "linkedin",
    target_url: targetUrl,
    target_hash: targetHash,
    payload_hash: hashes.payload,
    job_id: "job-123",
    queue_id: "queue-123",
    role: "submit",
    effect_key: "job-manager:job-123:submit:payload",
    effect_class: "external_non_idempotent",
    status: "succeeded",
    external_action_executed: true,
    provider_receipt_hash: hashes.provider,
    message_thread_fingerprint_hash: hashes.message,
    capture_blocker: null,
    submitted_confirmed: true,
    readback_url: "https://jobs.example.test/submissions/receipt-123",
    cleanup_receipt_hash: hashes.cleanup,
    exact_blocker: null,
    safe_restart: null,
    ...overrides
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test("parses a valid submit contract and binds target_url to target_hash", () => {
  const parsed = parseJobManagerWorkflowContractV1(baseContract(), {
    expected_target_url: targetUrl
  });
  assert.equal(parsed.schema, JOB_MANAGER_WORKFLOW_CONTRACT_SCHEMA_V1);
  assert.equal(parsed.role, "submit");
  assert.equal(parsed.target_hash, targetHash);
  assert.equal(parsed.submitted_confirmed, true);
  assert.equal(parsed.readback_url, "https://jobs.example.test/submissions/receipt-123");
});

test("accepts a follow-up with an explicit Gmail identity capture blocker", () => {
  const parsed = parseJobManagerWorkflowContractV1(
    baseContract({
      provider: "gmail",
      role: "follow_up",
      status: "blocked",
      external_action_executed: false,
      provider_receipt_hash: null,
      message_thread_fingerprint_hash: null,
      capture_blocker: "gmail_message_thread_identity_unavailable",
      submitted_confirmed: false,
      readback_url: null,
      cleanup_receipt_hash: hashes.cleanup,
      exact_blocker: "gmail_message_thread_identity_unavailable",
      safe_restart: "capture_gmail_thread_identity"
    })
  );
  assert.equal(parsed.role, "follow_up");
  assert.equal(parsed.capture_blocker, "gmail_message_thread_identity_unavailable");
});

test("rejects a target hash that is not bound to target_url", () => {
  assert.throws(
    () => parseJobManagerWorkflowContractV1(baseContract({ target_hash: "a".repeat(64) })),
    /job_manager_target_hash_binding_mismatch/
  );
});

test("rejects unsupported roles", () => {
  const result = validateJobManagerWorkflowContractV1(baseContract({ role: "withdraw" }));
  assert.deepEqual(result, {
    ok: false,
    status: "blocked",
    exact_blocker: "job_manager_role_invalid"
  });
});

test("requires provider receipt and readback for confirmed external submit", () => {
  assert.throws(
    () => parseJobManagerWorkflowContractV1(baseContract({ provider_receipt_hash: null })),
    /job_manager_confirmed_provider_receipt_required/
  );
  assert.throws(
    () => parseJobManagerWorkflowContractV1(baseContract({ readback_url: null })),
    /job_manager_confirmed_readback_url_required/
  );
});

test("requires either a message/thread fingerprint or an explicit capture blocker", () => {
  assert.throws(
    () =>
      parseJobManagerWorkflowContractV1(
        baseContract({ message_thread_fingerprint_hash: null, capture_blocker: null })
      ),
    /job_manager_message_thread_identity_or_capture_blocker_required/
  );
  assert.throws(
    () =>
      parseJobManagerWorkflowContractV1(
        baseContract({ capture_blocker: "capture_pending" })
      ),
    /job_manager_capture_identity_and_blocker_mutually_exclusive/
  );
});

test("normalizes an ambiguous external result to reconciliation_required", () => {
  const parsed = parseJobManagerWorkflowContractV1(
    baseContract({
      status: "ambiguous",
      provider_receipt_hash: null,
      submitted_confirmed: false,
      readback_url: null,
      cleanup_receipt_hash: hashes.cleanup,
      exact_blocker: "provider_submit_readback_ambiguous",
      safe_restart: "reconcile_provider_receipt"
    })
  );
  assert.equal(parsed.status, "reconciliation_required");
  assert.equal(parsed.exact_blocker, "provider_submit_readback_ambiguous");
});

test("rejects unknown fields and an old request reuse marker", () => {
  assert.throws(
    () => parseJobManagerWorkflowContractV1(baseContract({ unexpected: true })),
    /job_manager_unknown_field:unexpected/
  );
  assert.throws(
    () => parseJobManagerWorkflowContractV1(baseContract({ request_reuse_marker: "old-request" })),
    /job_manager_old_request_reuse_marker_forbidden/
  );
});

test("rejects the legacy job-manager workflow alias", () => {
  const result = validateJobManagerWorkflowContractV1(baseContract({ workflow_id: "job-manager" }));
  assert.deepEqual(result, {
    ok: false,
    status: "blocked",
    exact_blocker: "job_manager_workflow_id_invalid"
  });
});

test("rejects duplicate effect keys through the bounded ledger", () => {
  const ledger = new JobManagerEffectLedgerV1();
  const first = parseJobManagerWorkflowContractV1(baseContract(), { ledger });
  assert.equal(ledger.has(first.effect_key), true);
  const replay = validateJobManagerWorkflowContractV1(baseContract(), { ledger });
  assert.deepEqual(replay, {
    ok: false,
    status: "blocked",
    exact_blocker: `job_manager_effect_replay_forbidden:${first.effect_key}`
  });
});

test("enforces the configured bounded effect ledger", () => {
  const ledger = new JobManagerEffectLedgerV1(1);
  parseJobManagerWorkflowContractV1(baseContract(), { ledger });
  const result = validateJobManagerWorkflowContractV1(
    baseContract({ effect_key: "job-manager:job-124:submit:payload" }),
    { ledger }
  );
  assert.deepEqual(result, {
    ok: false,
    status: "blocked",
    exact_blocker: "job_manager_effect_ledger_bound_exceeded"
  });
});

test("requires a fresh target binding when an expected URL is supplied", () => {
  const result = validateJobManagerWorkflowContractV1(baseContract(), {
    expected_target_url: "https://jobs.example.test/listing/other"
  });
  assert.deepEqual(result, {
    ok: false,
    status: "blocked",
    exact_blocker: "job_manager_target_url_binding_mismatch"
  });
});

test("rejects readback URLs when submission is not confirmed", () => {
  assert.throws(
    () => parseJobManagerWorkflowContractV1(baseContract({ submitted_confirmed: false })),
    /job_manager_unconfirmed_readback_url_forbidden/
  );
});

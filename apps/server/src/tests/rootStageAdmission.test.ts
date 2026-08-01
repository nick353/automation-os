import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import { computeServiceReadinessEffectKey } from "../serviceReadiness/effectLedger.js";
import {
  IAB_ROOT_STAGE_ADMISSION_SCHEMA_V1,
  IAB_EXTERNAL_EFFECT_CAPABILITY_BLOCKER,
  validateIabRootStageAdmissionV1
} from "../serviceReadiness/rootStageAdmission.js";
import { IAB_ROOT_STAGE_BINDING_SCHEMA_V1 } from "../serviceReadiness/iabRootBinding.js";
import { JOB_MANAGER_WORKFLOW_CONTRACT_SCHEMA_V1 } from "../serviceReadiness/contractRegistry.js";

const targetUrl = "https://jobs.example.test/listing/admission-1";
const targetHash = createHash("sha256").update(targetUrl, "utf8").digest("hex");
const hashes = {
  payload: "b".repeat(64),
  provider: "c".repeat(64),
  cleanup: "d".repeat(64),
  message: "e".repeat(64)
};

function contract(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: JOB_MANAGER_WORKFLOW_CONTRACT_SCHEMA_V1,
    root_id: "root-admission",
    workflow_id: "job-application-manager",
    run_id: "run-admission",
    stage_id: "pre_browser_readiness",
    attempt_id: "attempt-1",
    fencing_token: 1,
    capability_id: "iab-capability",
    turn_id: "turn-1",
    session_id: "session-1",
    nonce: "nonce-1",
    capability_mode: "read_only",
    provider: "linkedin",
    account_ref: "account-linkedin",
    job_board: "linkedin",
    target_url: targetUrl,
    target_hash: targetHash,
    payload_hash: hashes.payload,
    job_id: "job-admission",
    queue_id: "queue-admission",
    role: "follow_up",
    effect_key: "placeholder",
    effect_class: "internal_idempotent",
    status: "blocked",
    external_action_executed: false,
    provider_receipt_hash: hashes.provider,
    message_thread_fingerprint_hash: hashes.message,
    capture_blocker: null,
    submitted_confirmed: false,
    readback_url: null,
    cleanup_receipt_hash: hashes.cleanup,
    exact_blocker: "gmail_message_thread_identity_unavailable",
    safe_restart: "capture_gmail_thread_identity",
    ...overrides
  };
}

function root(effectKey: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: IAB_ROOT_STAGE_BINDING_SCHEMA_V1,
    surface: "in_app_browser",
    root_id: "root-admission",
    workflow_id: "job-application-manager",
    run_id: "run-admission",
    stage_id: "pre_browser_readiness",
    attempt_id: "attempt-1",
    fencing_token: 1,
    capability_id: "iab-capability",
    turn_id: "turn-1",
    session_id: "session-1",
    nonce: "nonce-1",
    iab_identity: {
      generation: "generation-1",
      project_id: "project-automation-os",
      thread_id: "thread-1",
      session_id: "session-1",
      turn_id: "turn-1",
      nonce: "nonce-1",
      stage: "pre_browser_readiness",
      attempt: 1
    },
    capability_mode: "read_only",
    effect_class: "internal_idempotent",
    effect_key: effectKey,
    external_action_executed: false,
    legacy_surfaces_forbidden: true,
    prior_receipt_reuse: false,
    ...overrides
  };
}

function packet(rootBinding: Record<string, unknown>, workflowContract: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { root_binding: rootBinding, workflow_contract: workflowContract, ...extra };
}

function expectedEffectKey(workflow: Record<string, unknown>): string {
  return computeServiceReadinessEffectKey({
    provider: workflow.provider as string,
    account_ref: workflow.account_ref as string,
    target_hash: workflow.target_hash as string,
    payload_hash: workflow.payload_hash as string,
    effect_class: workflow.effect_class as "internal_idempotent"
  });
}

test("admits a read-only root, workflow contract, and canonical effect key without action", () => {
  const workflow = contract();
  const effectKey = expectedEffectKey(workflow);
  const result = validateIabRootStageAdmissionV1(packet(root(effectKey), { ...workflow, effect_key: effectKey }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.status, "ok");
  assert.equal(result.value.schema, IAB_ROOT_STAGE_ADMISSION_SCHEMA_V1);
  assert.equal(result.value.effect_key, effectKey);
  assert.equal(result.value.iab_identity.session_id, "session-1");
  assert.equal(result.value.iab_identity.turn_id, "turn-1");
  assert.equal(result.value.iab_identity.nonce, "nonce-1");
  assert.equal(result.value.iab_identity.stage, "pre_browser_readiness");
  assert.equal(result.value.iab_identity.attempt, 1);
  assert.equal(result.value.external_action_executed, false);
});

test("blocks external mode at the IAB executor boundary", () => {
  const workflow = contract({ capability_mode: "external" });
  const result = validateIabRootStageAdmissionV1(packet(root(expectedEffectKey(workflow)), workflow));
  assert.deepEqual(result, {
    ok: false,
    status: "blocked",
    exact_blocker: IAB_EXTERNAL_EFFECT_CAPABILITY_BLOCKER
  });
});

test("blocks external non-idempotent effects at the read-only root admission", () => {
  const workflow = contract({ effect_class: "external_non_idempotent" });
  const effectKey = computeServiceReadinessEffectKey({
    provider: workflow.provider as string,
    account_ref: workflow.account_ref as string,
    target_hash: workflow.target_hash as string,
    payload_hash: workflow.payload_hash as string,
    effect_class: "external_non_idempotent"
  });
  const result = validateIabRootStageAdmissionV1(
    packet(root(effectKey, { effect_class: "external_non_idempotent" }), { ...workflow, effect_key: effectKey })
  );
  assert.deepEqual(result, {
    ok: false,
    status: "blocked",
    exact_blocker: IAB_EXTERNAL_EFFECT_CAPABILITY_BLOCKER
  });
});

test("blocks missing account, target, payload, provider, or receipt values", () => {
  for (const field of ["account_ref", "target_hash", "payload_hash", "provider", "provider_receipt_hash"]) {
    const workflow = contract({ [field]: null });
    const result = validateIabRootStageAdmissionV1(packet(root("a".repeat(64)), workflow));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.exact_blocker, IAB_EXTERNAL_EFFECT_CAPABILITY_BLOCKER);
  }
});

test("blocks legacy surfaces and prior receipt reuse", () => {
  const workflow = contract();
  const effectKey = expectedEffectKey(workflow);
  for (const rootOverrides of [
    { browser_handle: "old-tab" },
    { surface: "playwright" },
    { prior_receipt_reuse: true }
  ]) {
    const result = validateIabRootStageAdmissionV1(
      packet(root(effectKey, rootOverrides), { ...workflow, effect_key: effectKey })
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.exact_blocker, IAB_EXTERNAL_EFFECT_CAPABILITY_BLOCKER);
  }
});

test("never admits a claimed external action", () => {
  const workflow = contract({ external_action_executed: true });
  const result = validateIabRootStageAdmissionV1(packet(root("a".repeat(64)), workflow));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.exact_blocker, IAB_EXTERNAL_EFFECT_CAPABILITY_BLOCKER);
});

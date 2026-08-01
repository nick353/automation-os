import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPANY_RELEASE_EVIDENCE_SCHEMA_V1,
  COMPANY_RELEASE_READINESS_SCHEMA_V1,
  DAILY_AI_WORKFLOW_CONTRACT_SCHEMA_V1,
  JOB_MANAGER_WORKFLOW_CONTRACT_SCHEMA_V1,
  NISEN_PRINTS_SERVICE_READINESS_SCHEMA_V1,
  SERVICE_READINESS_SCHEMA_V1,
  validateServiceReadinessContractV1
} from "../serviceReadiness/contractRegistry.js";
import { buildBlockedCompanyReleaseEvidenceV1 } from "../serviceReadiness/releaseEvidence.js";

const hash = (letter: string) => letter.repeat(64);
const targetUrl = "https://jobs.example.test/listing/registry-1";
const targetHash = createHash("sha256").update(targetUrl, "utf8").digest("hex");

function daily(): Record<string, unknown> {
  return {
    schema: DAILY_AI_WORKFLOW_CONTRACT_SCHEMA_V1,
    root_id: "root-registry",
    workflow_id: "daily-ai",
    run_id: "run-registry-daily",
    stage_id: "publish",
    attempt_id: "attempt-1",
    fencing_token: 1,
    capability_id: "daily-capability",
    turn_id: "turn-1",
    session_id: "session-1",
    nonce: "nonce-1",
    capability_mode: "external",
    provider: "x",
    account_ref: "account-daily",
    platform: "x",
    queue_id: "queue-registry",
    post_surface: "x_feed",
    language: "ja",
    visual_style: "decision_card",
    media_receipt_hash: hash("e"),
    target_hash: hash("a"),
    payload_hash: hash("b"),
    effect_key: "daily-ai:registry",
    effect_class: "external_non_idempotent",
    status: "succeeded",
    external_action_executed: true,
    provider_receipt_hash: hash("c"),
    no_post: false,
    cleanup_receipt_hash: hash("d"),
    exact_blocker: null,
    safe_resume_step: null,
    blocker_owner: null
  };
}

function jobManager(): Record<string, unknown> {
  return {
    schema: JOB_MANAGER_WORKFLOW_CONTRACT_SCHEMA_V1,
    root_id: "root-registry",
    workflow_id: "job-application-manager",
    run_id: "run-registry-job",
    stage_id: "submit",
    attempt_id: "attempt-1",
    fencing_token: 1,
    capability_id: "job-capability",
    turn_id: "turn-1",
    session_id: "session-1",
    nonce: "nonce-1",
    capability_mode: "external",
    provider: "linkedin",
    account_ref: "account-job",
    job_board: "linkedin",
    target_url: targetUrl,
    target_hash: targetHash,
    payload_hash: hash("b"),
    job_id: "job-registry",
    queue_id: "queue-registry",
    role: "submit",
    effect_key: "job-manager:registry",
    effect_class: "external_non_idempotent",
    status: "succeeded",
    external_action_executed: true,
    provider_receipt_hash: hash("c"),
    message_thread_fingerprint_hash: hash("e"),
    capture_blocker: null,
    submitted_confirmed: true,
    readback_url: "https://jobs.example.test/submissions/registry-1",
    cleanup_receipt_hash: hash("d"),
    exact_blocker: null,
    safe_restart: null
  };
}

function nisenPrints(): Record<string, unknown> {
  return {
    schema: NISEN_PRINTS_SERVICE_READINESS_SCHEMA_V1,
    root_id: "root-registry",
    workflow_id: "nisenprints",
    run_id: "run-registry-nisen",
    stage_id: "publish",
    attempt_id: "attempt-1",
    fencing_token: 1,
    capability_id: "nisen-capability",
    turn_id: "turn-1",
    session_id: "session-1",
    nonce: "nonce-1",
    capability_mode: "external",
    status: "succeeded",
    effect_class: "external_non_idempotent",
    store: "etsy",
    account_ref: "account-nisen",
    mode: "full_publish",
    product_listing_target_hash: hash("a"),
    asset_media_hash: hash("b"),
    pinterest_board_target_hash: hash("c"),
    provider: "etsy",
    provider_receipt_hash: hash("d"),
    effect_key: "nisenprints:registry",
    external_action_executed: true,
    duplicate_lock_key: "listing:registry:pin:registry",
    cleanup_receipt_hash: hash("e"),
    exact_blocker: null,
    safe_restart: null
  };
}

function foundation(): Record<string, unknown> {
  return {
    schema: SERVICE_READINESS_SCHEMA_V1,
    root_id: "root-registry",
    workflow_id: "foundation",
    run_id: "run-registry-foundation",
    stage_id: "preflight",
    attempt_id: "attempt-1",
    fencing_token: 1,
    capability_id: "foundation-capability",
    turn_id: "turn-1",
    session_id: "session-1",
    nonce: "nonce-1",
    capability_mode: "read_only",
    provider: "local",
    account_ref: "account-foundation",
    target_hash: hash("a"),
    payload_hash: hash("b"),
    effect_key: "foundation:registry",
    effect_class: "internal_idempotent",
    status: "running",
    external_action_executed: false,
    provider_receipt_hash: null,
    cleanup_receipt_hash: null,
    exact_blocker: null,
    safe_resume_step: null
  };
}

function blockedReleasePacket(): Record<string, unknown> {
  const blocked = (exact_blocker: string, safe_resume_step: string) => ({
    status: "blocked",
    exact_blocker,
    blocker_owner: null,
    safe_resume_step
  });
  return {
    schema: COMPANY_RELEASE_READINESS_SCHEMA_V1,
    mode: "no_effect_readiness",
    status: "blocked",
    activation_requested: false,
    activation_authorized: false,
    external_action_executed: false,
    named_g0_approvers_and_decisions: blocked("g0_missing", "obtain G0 decisions"),
    mixed_file_hunk_allowlist_owner: blocked("allowlist_missing", "assign allowlist owner"),
    clean_candidate_sha_and_signed_manifest: blocked("candidate_missing", "create a clean candidate"),
    backup_restore_rollback_owner: blocked("backup_missing", "name rollback owner"),
    per_workflow_account_target_payload_receipt_contract: blocked("receipt_contract_missing", "define receipt contracts"),
    exact_blocker: "company_release_required_fields_missing",
    blocker_owner: null,
    safe_resume_step: "resolve required fields and revalidate"
  };
}

test("routes every supported adapter and the foundation parser", () => {
  for (const packet of [daily(), jobManager(), nisenPrints(), foundation()]) {
    const result = validateServiceReadinessContractV1(packet);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.execution_policy.mode, "no_effect");
      assert.equal(result.execution_policy.exact_blocker, "external_effect_capability_unavailable");
    }
  }
});

test("accepts expected current identity and cleanup options", () => {
  const packet = daily();
  const result = validateServiceReadinessContractV1(packet, {
    expected_identity: {
      root_id: "root-registry",
      workflow_id: "daily-ai",
      run_id: "run-registry-daily",
      stage_id: "publish",
      attempt_id: "attempt-1",
      fencing_token: 1,
      capability_id: "daily-capability",
      turn_id: "turn-1",
      session_id: "session-1",
      nonce: "nonce-1"
    },
    expected_cleanup_receipt_hash: hash("d")
  });
  assert.equal(result.ok, true);
});

test("returns an exact identity mismatch blocker", () => {
  const result = validateServiceReadinessContractV1(daily(), {
    expected_identity: {
      root_id: "different-root",
      workflow_id: "daily-ai",
      run_id: "run-registry-daily",
      stage_id: "publish",
      attempt_id: "attempt-1",
      fencing_token: 1,
      capability_id: "daily-capability",
      turn_id: "turn-1",
      session_id: "session-1",
      nonce: "nonce-1"
    }
  });
  assert.deepEqual(result, {
    ok: false,
    status: "blocked",
    schema: DAILY_AI_WORKFLOW_CONTRACT_SCHEMA_V1,
    exact_blocker: "service_readiness_identity_mismatch:root_id",
    execution_policy: { mode: "no_effect", exact_blocker: "external_effect_capability_unavailable" }
  });
});

test("rejects unknown schemas and legacy markers", () => {
  const unknown = validateServiceReadinessContractV1({ schema: "legacy.workflow.v0" });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.exact_blocker, "service_readiness_unknown_schema");

  const legacy = validateServiceReadinessContractV1({ ...daily(), browser_surface: "playwright" });
  assert.equal(legacy.ok, false);
  if (!legacy.ok) assert.equal(legacy.exact_blocker, "daily_ai_unknown_field:browser_surface");

  const oldRequest = validateServiceReadinessContractV1({ ...jobManager(), request_reuse_marker: "old" });
  assert.equal(oldRequest.ok, false);
  if (!oldRequest.ok) assert.equal(oldRequest.exact_blocker, "job_manager_old_request_reuse_marker_forbidden");
});

test("routes a blocked release packet through the company validator", () => {
  const result = validateServiceReadinessContractV1(blockedReleasePacket());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.status, "blocked");
    assert.equal(result.value.exact_blocker, "company_release_required_fields_missing");
    assert.equal(result.execution_policy.mode, "no_effect");
  }
});

test("routes the strict release-evidence envelope without granting execution", () => {
  const packet = buildBlockedCompanyReleaseEvidenceV1();
  assert.equal(packet.schema, COMPANY_RELEASE_EVIDENCE_SCHEMA_V1);
  const result = validateServiceReadinessContractV1(packet);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.schema, COMPANY_RELEASE_EVIDENCE_SCHEMA_V1);
    assert.equal(result.value.status, "blocked");
    assert.equal(result.execution_policy.mode, "no_effect");
    assert.equal(result.execution_policy.exact_blocker, "external_effect_capability_unavailable");
  }
});

test("company release contracts remain no-effect even when a capability object is supplied", () => {
  const packet = buildBlockedCompanyReleaseEvidenceV1();
  const result = validateServiceReadinessContractV1(packet, {
    approved_external_capability: { approved: true, capability_id: "unrelated-capability" }
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.execution_policy.mode, "no_effect");
});

test("does not expose an external execution capability by default", () => {
  const result = validateServiceReadinessContractV1(daily());
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.execution_policy, {
    mode: "no_effect",
    exact_blocker: "external_effect_capability_unavailable"
  });
});

test("approved capability descriptions never grant external execution without the root IAB executor", () => {
  const result = validateServiceReadinessContractV1(daily(), {
    approved_external_capability: { approved: true, capability_id: "daily-capability" }
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.execution_policy, {
    mode: "no_effect",
    exact_blocker: "external_effect_capability_unavailable"
  });
});

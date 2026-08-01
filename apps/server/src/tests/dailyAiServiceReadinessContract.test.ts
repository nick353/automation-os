import assert from "node:assert/strict";
import test from "node:test";

import {
  DAILY_AI_WORKFLOW_CONTRACT_SCHEMA_V1,
  DailyAiEffectLedgerV1,
  parseDailyAiWorkflowContractV1,
  validateDailyAiWorkflowContractV1
} from "../serviceReadiness/workflowContracts/dailyAi.js";

const hash = (letter: string) => letter.repeat(64);

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: DAILY_AI_WORKFLOW_CONTRACT_SCHEMA_V1,
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
    capability_mode: "external",
    provider: "x",
    account_ref: "account-ref:x-sandbox",
    platform: "x",
    queue_id: "queue-001",
    post_surface: "x_feed",
    language: "ja",
    visual_style: "decision_card",
    media_receipt_hash: hash("e"),
    target_hash: hash("a"),
    payload_hash: hash("b"),
    effect_key: "daily-ai:x:queue-001",
    effect_class: "external_non_idempotent",
    status: "succeeded",
    external_action_executed: true,
    provider_receipt_hash: hash("c"),
    no_post: false,
    cleanup_receipt_hash: hash("d"),
    exact_blocker: null,
    safe_resume_step: null,
    blocker_owner: null,
    ...overrides
  };
}

test("parses a valid X publish contract with Japanese language", () => {
  const parsed = parseDailyAiWorkflowContractV1(base());
  assert.equal(parsed.schema, DAILY_AI_WORKFLOW_CONTRACT_SCHEMA_V1);
  assert.equal(parsed.platform, "x");
  assert.equal(parsed.language, "ja");
  assert.equal(parsed.post_surface, "x_feed");
  assert.equal(parsed.external_action_executed, true);
});

test("accepts LinkedIn only with English language", () => {
  const parsed = parseDailyAiWorkflowContractV1(base({
    provider: "linkedin",
    platform: "linkedin",
    language: "en",
    post_surface: "linkedin_feed",
    effect_key: "daily-ai:linkedin:queue-001"
  }));
  assert.equal(parsed.platform, "linkedin");
  assert.equal(parsed.language, "en");
});

test("rejects a platform-language mismatch", () => {
  const result = validateDailyAiWorkflowContractV1(base({ language: "en" }));
  assert.deepEqual(result, {
    ok: false,
    status: "blocked",
    exact_blocker: "daily_ai_platform_language_mismatch"
  });
});

test("rejects unknown fields instead of silently carrying stale request data", () => {
  const result = validateDailyAiWorkflowContractV1(base({ stale_request_id: "old" }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.exact_blocker, "daily_ai_unknown_field:stale_request_id");
});

test("requires lowercase SHA-256 hashes for media and payload evidence", () => {
  for (const [field, value] of [
    ["media_receipt_hash", "A".repeat(64)],
    ["target_hash", "not-a-sha256"],
    ["payload_hash", "f".repeat(63)]
  ] as const) {
    const result = validateDailyAiWorkflowContractV1(base({ [field]: value }));
    assert.equal(result.ok, false);
  }
});

test("no_post is a safe stop and cannot claim an external action or provider receipt", () => {
  const parsed = parseDailyAiWorkflowContractV1(base({
    no_post: true,
    external_action_executed: false,
    provider_receipt_hash: null
  }));
  assert.equal(parsed.no_post, true);
  assert.equal(parsed.external_action_executed, false);
  assert.equal(parsed.provider_receipt_hash, null);

  const externalAction = validateDailyAiWorkflowContractV1(base({ no_post: true, external_action_executed: true }));
  assert.equal(externalAction.ok, false);
  if (!externalAction.ok) assert.equal(externalAction.exact_blocker, "daily_ai_no_post_external_action_forbidden");
  const providerReceipt = validateDailyAiWorkflowContractV1(base({
    no_post: true,
    external_action_executed: false,
    provider_receipt_hash: hash("f")
  }));
  assert.equal(providerReceipt.ok, false);
  if (!providerReceipt.ok) assert.equal(providerReceipt.exact_blocker, "daily_ai_no_post_provider_receipt_forbidden");
});

test("rejects an ambiguous success without external action and receipt", () => {
  const result = validateDailyAiWorkflowContractV1(base({
    external_action_executed: false,
    provider_receipt_hash: null
  }));
  assert.deepEqual(result, {
    ok: false,
    status: "blocked",
    exact_blocker: "daily_ai_success_receipt_or_external_action_missing"
  });
});

test("requires a blocker owner whenever a blocked state has an exact blocker", () => {
  const missingOwner = validateDailyAiWorkflowContractV1(base({
    status: "blocked",
    external_action_executed: false,
    provider_receipt_hash: null,
    cleanup_receipt_hash: hash("d"),
    exact_blocker: "iab_unavailable",
    safe_resume_step: "pre_browser_readiness"
  }));
  assert.equal(missingOwner.ok, false);
  if (!missingOwner.ok) assert.equal(missingOwner.exact_blocker, "daily_ai_blocker_owner_required");

  const blocked = parseDailyAiWorkflowContractV1(base({
    status: "blocked",
    external_action_executed: false,
    provider_receipt_hash: null,
    cleanup_receipt_hash: hash("d"),
    exact_blocker: "iab_unavailable",
    blocker_owner: "daily-ai-browser-lane",
    safe_resume_step: "pre_browser_readiness"
  }));
  assert.equal(blocked.exact_blocker, "iab_unavailable");
  assert.equal(blocked.blocker_owner, "daily-ai-browser-lane");
});

test("normalizes an ambiguous provider outcome to reconciliation_required", () => {
  const parsed = parseDailyAiWorkflowContractV1(base({
    status: "ambiguous",
    provider_receipt_hash: null,
    exact_blocker: "provider_readback_ambiguous",
    blocker_owner: "daily-ai-provider",
    safe_resume_step: "reconcile_provider_receipt"
  }));
  assert.equal(parsed.status, "reconciliation_required");
});

test("rejects duplicate effect keys through the bounded Daily AI ledger", () => {
  const ledger = new DailyAiEffectLedgerV1();
  parseDailyAiWorkflowContractV1(base(), { ledger });
  const result = validateDailyAiWorkflowContractV1(base(), { ledger });
  assert.deepEqual(result, {
    ok: false,
    status: "blocked",
    exact_blocker: "daily_ai_effect_replay_forbidden:daily-ai:x:queue-001"
  });
});

test("enforces the bounded replay ledger capacity", () => {
  const ledger = new DailyAiEffectLedgerV1(1);
  parseDailyAiWorkflowContractV1(base(), { ledger });
  const result = validateDailyAiWorkflowContractV1(base({ effect_key: "daily-ai:x:queue-002" }), { ledger });
  assert.deepEqual(result, {
    ok: false,
    status: "blocked",
    exact_blocker: "daily_ai_effect_ledger_bound_exceeded"
  });
});

test("requires cleanup evidence for terminal blocked outcomes", () => {
  const result = validateDailyAiWorkflowContractV1(base({
    status: "blocked",
    external_action_executed: false,
    provider_receipt_hash: null,
    cleanup_receipt_hash: null,
    exact_blocker: "preflight_blocked",
    blocker_owner: "daily-ai-preflight",
    safe_resume_step: "pre_browser_readiness"
  }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.exact_blocker, "service_readiness_terminal_cleanup_required");
});

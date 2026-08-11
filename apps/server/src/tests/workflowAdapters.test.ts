import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { prepareReferenceBrowserUseExternalIntentV1, prepareReferenceIabExternalIntentV1, readReferenceBrowserUseWorkflowAdaptersV1 } from "../serviceReadiness/workflowAdapters.js";

const hash = (letter: string) => letter.repeat(64);
const jobTargetHash = createHash("sha256").update("https://jobs.example.test/listing/123").digest("hex");

function daily(overrides: Record<string, unknown> = {}) {
  return {
    schema: "daily_ai.workflow_contract.v1",
    root_id: "root-daily",
    workflow_id: "daily-ai",
    run_id: "run-daily",
    stage_id: "publish",
    attempt_id: "attempt-daily",
    fencing_token: 1,
    capability_id: "cap-daily",
    turn_id: "turn-daily",
    session_id: "session-daily",
    nonce: "nonce-daily",
    capability_mode: "external",
    provider: "linkedin",
    account_ref: "account-daily",
    platform: "linkedin",
    queue_id: "queue-daily",
    post_surface: "linkedin_feed",
    language: "en",
    visual_style: "decision_card",
    media_receipt_hash: hash("e"),
    target_hash: hash("a"),
    payload_hash: hash("b"),
    effect_key: "daily-ai:linkedin:queue-daily",
    effect_class: "external_non_idempotent",
    status: "running",
    external_action_executed: false,
    provider_receipt_hash: null,
    no_post: false,
    cleanup_receipt_hash: null,
    exact_blocker: null,
    safe_resume_step: null,
    blocker_owner: null,
    ...overrides
  };
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    schema: "job_manager.workflow_contract.v1",
    root_id: "root-job",
    workflow_id: "job-application-manager",
    run_id: "run-job",
    stage_id: "submit",
    attempt_id: "attempt-job",
    fencing_token: 1,
    capability_id: "cap-job",
    turn_id: "turn-job",
    session_id: "session-job",
    nonce: "nonce-job",
    capability_mode: "external",
    provider: "linkedin",
    account_ref: "account-job",
    target_hash: jobTargetHash,
    payload_hash: hash("b"),
    effect_key: "job-manager:job:submit",
    effect_class: "external_non_idempotent",
    status: "running",
    external_action_executed: false,
    provider_receipt_hash: null,
    cleanup_receipt_hash: null,
    exact_blocker: null,
    job_board: "linkedin",
    target_url: "https://jobs.example.test/listing/123",
    job_id: "job-123",
    queue_id: "queue-job",
    role: "submit",
    message_thread_fingerprint_hash: hash("c"),
    capture_blocker: null,
    submitted_confirmed: false,
    readback_url: null,
    safe_restart: null,
    ...overrides
  };
}

function nisen(overrides: Record<string, unknown> = {}) {
  return {
    schema: "nisenprints.service_readiness.v1",
    root_id: "root-nisen",
    workflow_id: "nisenprints-workflow",
    run_id: "run-nisen",
    stage_id: "printify",
    attempt_id: "attempt-nisen",
    fencing_token: 1,
    capability_id: "cap-nisen",
    turn_id: "turn-nisen",
    session_id: "session-nisen",
    nonce: "nonce-nisen",
    capability_mode: "external",
    status: "running",
    effect_class: "external_non_idempotent",
    store: "printify",
    account_ref: "account-nisen",
    mode: "printify_recovery",
    product_listing_target_hash: hash("a"),
    asset_media_hash: hash("b"),
    pinterest_board_target_hash: null,
    provider: "printify",
    provider_receipt_hash: null,
    effect_key: "nisenprints:printify:recovery",
    external_action_executed: false,
    duplicate_lock_key: "listing:recovery",
    cleanup_receipt_hash: null,
    exact_blocker: null,
    safe_restart: null,
    ...overrides
  };
}

test("workflow adapters prepare a pending Daily AI, Job, and NisenPrints intent without side effects", () => {
  assert.equal(prepareReferenceIabExternalIntentV1({ workflow_id: "daily-ai", contract: daily() }).status, "ready");
  assert.equal(prepareReferenceIabExternalIntentV1({ workflow_id: "job-application-manager", contract: job() }).status, "ready");
  assert.equal(prepareReferenceIabExternalIntentV1({ workflow_id: "nisenprints", contract: nisen() }).status, "ready");
});

test("workflow adapters preserve independent exact blockers and reject receipt reuse", () => {
  const gmail = prepareReferenceIabExternalIntentV1({ workflow_id: "job-application-manager", contract: job({ message_thread_fingerprint_hash: null, capture_blocker: "gmail_message_thread_identity_unavailable", exact_blocker: "gmail_message_thread_identity_unavailable", safe_restart: "capture_gmail_thread_identity" }) });
  assert.equal(gmail.status, "blocked");
  assert.equal(gmail.exact_blocker, "gmail_message_thread_identity_unavailable");
  const noPost = prepareReferenceIabExternalIntentV1({ workflow_id: "daily-ai", contract: daily({ no_post: true }) });
  assert.equal(noPost.exact_blocker, "daily_ai_linkedin_no_post_or_iab_capability");
  const reused = prepareReferenceIabExternalIntentV1({ workflow_id: "nisenprints", contract: nisen({ external_action_executed: true, provider_receipt_hash: hash("c"), status: "succeeded", cleanup_receipt_hash: hash("d") }) });
  assert.equal(reused.exact_blocker, "external_effect_already_executed_reuse_forbidden");
});

test("Browser Use workflow adapters are canonical and cannot substitute IAB receipts", () => {
  const adapters = readReferenceBrowserUseWorkflowAdaptersV1();
  assert.deepEqual(adapters.map((adapter) => adapter.workflow_id), ["daily-ai", "job-application-manager", "nisenprints"]);
  for (const adapter of adapters) {
    assert.equal(adapter.browser_surface, "browser_use_cli");
    assert.equal(adapter.no_fallback, true);
    assert.match(adapter.adapter_entrypoint, /browser-use-cli-stage-adapter\.mjs$/);
    assert.equal(adapter.receipt_discriminator, "browser_use_cli_stage_observation.v1");
    assert.equal(adapter.iab_receipt_substitution, "forbidden");
    assert.equal(adapter.external_intent_schema, "service_readiness_browser_use_external_intent.v1");
    assert.equal(adapter.external_effect_ready, false);
    assert.equal(adapter.external_executor_status, "authorized_business_runner_pending");
    assert.equal(adapter.business_runner_entrypoint, "scripts/aos-portable-business-runner.mjs");
  }
});

test("Browser Use external intent is current, authority-bound, and never an IAB receipt", () => {
  for (const [workflow_id, contract] of [["daily-ai", daily()], ["job-application-manager", job()], ["nisenprints", nisen()]] as const) {
    const prepared = prepareReferenceBrowserUseExternalIntentV1({ workflow_id, contract });
    assert.equal(prepared.schema, "service_readiness_browser_use_external_intent.v1");
    assert.equal(prepared.browser_surface, "browser_use_cli");
    assert.equal(prepared.authority_required, true);
    assert.equal(prepared.external_effect_ready, false);
    assert.equal(prepared.external_executor_status, "authorized_business_runner_pending");
    assert.equal(prepared.business_runner_entrypoint, "scripts/aos-portable-business-runner.mjs");
    assert.equal(prepared.external_action_executed, false);
    assert.equal(JSON.stringify(prepared).includes("iab"), false);
  }
});

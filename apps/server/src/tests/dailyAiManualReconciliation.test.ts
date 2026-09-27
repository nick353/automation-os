import assert from "node:assert/strict";
import test from "node:test";
import { dailyAiPersistedEffectContext, validateDailyAiManualReconciliation } from "../runs/portableRunRecovery.js";

test("manual Daily AI recovery requires single-post scope, original cleanup and matching queue commit", () => {
  const evidence = {
    inputBundle: { execution_scope: "single_existing_post", account_ref: "daily_ai_social_readback", content_key: "draft", target_key: "draft:x" },
    original: { cleanup_verified: true }, providerUrl: "https://x.com/nichika2000823/status/123",
    sourceReadback: { queue_commit: { schema: "aos.daily_ai_provider_queue_commit.v1", status: "completed", content_key: "draft", platform: "x",
      row_checksum: "a".repeat(64), after: { x_post_id: "123", x_post_url: "https://x.com/nichika2000823/status/123" } } },
  };
  assert.doesNotThrow(() => validateDailyAiManualReconciliation(evidence));
  for (const patch of [
    { inputBundle: { ...evidence.inputBundle, execution_scope: "full_daily_ai" } },
    { original: { cleanup_verified: false } },
    { providerUrl: "https://x.com/other/status/123" },
    { sourceReadback: {} },
    { sourceReadback: { queue_commit: { ...evidence.sourceReadback.queue_commit, content_key: "other" } } },
    { sourceReadback: { queue_commit: { ...evidence.sourceReadback.queue_commit, after: { x_post_url: evidence.providerUrl, x_post_id: "456" } } } },
  ]) assert.throws(() => validateDailyAiManualReconciliation({ ...evidence, ...patch }), /evidence_invalid/);
});

test("manual Daily AI recovery accepts only a bound terminal cleanup receipt as supplemental evidence", () => {
  const inputBundle = {
    execution_scope: "single_existing_post", account_ref: "daily_ai_social_readback",
    content_key: "draft", target_key: "draft:x", payload_hash: "c".repeat(64),
  };
  const original = {
    run_id: "run-draft", workflow_id: "daily-ai-research-publish-run", step_id: "step-draft",
    cleanup_verified: false,
    operation: { task_id: "task-draft", target_key: "draft:x" },
    adapter_receipt: {
      execution_context: { owner_id: "automation_os_local" },
      session: { session_id: "session-draft" },
      tab: { id: "tab-draft" },
      reconciliation: { status: { tab: { leaseId: "lease-draft" } } },
    },
  };
  const queueCommit = {
    schema: "aos.daily_ai_provider_queue_commit.v1", status: "completed", content_key: "draft", platform: "x",
    row_checksum: "a".repeat(64), after: { x_post_id: "123", x_post_url: "https://x.com/nichika2000823/status/123" },
  };
  const cleanup = {
    schema: "aos.chrome_companion.cleanup_receipt.v1",
    evidence_source: "aos_chrome_companion_task_terminal_cleanup",
    company_id: "company-1", run_id: "run-draft", workflow_id: "daily-ai-research-publish-run", step_id: "step-draft",
    owner_id: "automation_os_local", task_id: "task-draft", session_id: "session-draft", lease_id: "lease-draft",
    tab_id: "tab-draft", target_key: "draft:x", session_closed: true,
    lease_released_by_session_close: true, remaining_work_retained: false, terminal_cleanup_confirmed: true,
  };
  const sourceReadback = {
    post_url: "https://x.com/nichika2000823/status/123", same_target: true, content_match: true,
    content_key: "draft", payload_hash: inputBundle.payload_hash, queue_commit: queueCommit, cleanup_receipt: cleanup,
  };
  const effectContext = {
    company_id: "company-1", run_id: "run-draft", workflow_id: "daily-ai-research-publish-run", step_id: "step-draft",
    owner_id: "automation_os_local", task_id: "task-draft", target_key: "draft:x",
  };
  assert.doesNotThrow(() => validateDailyAiManualReconciliation({
    inputBundle, original, providerUrl: sourceReadback.post_url, sourceReadback, effectContext,
  }));
  for (const patch of [
    { cleanup_receipt: { ...cleanup, session_id: "foreign-session" } },
    { cleanup_receipt: { ...cleanup, lease_released_by_session_close: false } },
    { cleanup_receipt: { ...cleanup, remaining_work_retained: true } },
    { cleanup_receipt: { ...cleanup, terminal_cleanup_confirmed: false } },
    { cleanup_receipt: { ...cleanup, schema: "arbitrary.v1" } },
  ]) {
    const invalidSource = { ...sourceReadback, cleanup_receipt: patch.cleanup_receipt };
    assert.throws(() => validateDailyAiManualReconciliation({
      inputBundle, original, providerUrl: sourceReadback.post_url, sourceReadback: invalidSource, effectContext,
    }), /evidence_invalid/);
  }
});

test("manual Daily AI recovery can bind a depth-limited receipt to same-run owner/task metadata", () => {
  const inputBundle = {
    execution_scope: "single_existing_post", account_ref: "daily_ai_social_readback",
    content_key: "draft", target_key: "draft:x", payload_hash: "c".repeat(64),
  };
  const providerUrl = "https://x.com/nichika2000823/status/123";
  const cleanup = {
    schema: "aos.chrome_companion.cleanup_receipt.v1",
    evidence_source: "aos_chrome_companion_task_terminal_cleanup",
    company_id: "company-1", run_id: "run-draft", workflow_id: "daily-ai-research-publish-run", step_id: "step-draft",
    owner_id: "owner-from-run", task_id: "task-from-run", session_id: "session-draft", lease_id: "lease-draft",
    tab_id: "tab-draft", target_key: "draft:x", session_closed: true,
    lease_released_by_session_close: true, remaining_work_retained: false, terminal_cleanup_confirmed: true,
  };
  const sourceReadback = {
    post_url: providerUrl, same_target: true, content_match: true,
    content_key: "draft", payload_hash: inputBundle.payload_hash,
    cleanup_receipt: cleanup,
    queue_commit: {
      schema: "aos.daily_ai_provider_queue_commit.v1", status: "completed", content_key: "draft", platform: "x",
      row_checksum: "a".repeat(64), after: { x_post_id: "123", x_post_url: providerUrl },
    },
  };
  // This mirrors the production fallback: the persisted run metadata is the
  // only source for owner/task when the remote receipt omitted its context.
  const metadata = {
    execution_context: { owner_id: "owner-from-run", run_id: "run-draft" },
    portable_workflow_invocation: { companion_task_id: "task-from-run", run_id: "run-draft" },
  };
  const effectContext = dailyAiPersistedEffectContext({
    run: { id: "run-draft", company_id: "company-1" } as any,
    metadata,
    original: { run_id: "run-draft", session_id: "session-draft", lease_id: "lease-draft", cleanup_verified: false },
    workflowId: "daily-ai-research-publish-run",
    stepId: "step-draft",
    inputBundle,
  });
  assert.deepEqual(effectContext, {
    company_id: "company-1", run_id: "run-draft", workflow_id: "daily-ai-research-publish-run", step_id: "step-draft",
    owner_id: "owner-from-run", task_id: "task-from-run", target_key: inputBundle.target_key,
  });
  assert.doesNotThrow(() => validateDailyAiManualReconciliation({
    inputBundle,
    original: { run_id: "run-draft", session_id: "session-draft", lease_id: "lease-draft", cleanup_verified: false },
    providerUrl,
    sourceReadback,
    effectContext,
  }));
  assert.throws(() => validateDailyAiManualReconciliation({
    inputBundle,
    original: { run_id: "run-draft", session_id: "session-draft", lease_id: "lease-draft", cleanup_verified: false },
    providerUrl,
    sourceReadback: { ...sourceReadback, cleanup_receipt: { ...cleanup, run_id: "run-foreign" } },
    effectContext,
  }), /evidence_invalid/);
  assert.throws(() => validateDailyAiManualReconciliation({
    inputBundle,
    original: { run_id: "run-draft", session_id: "session-draft", lease_id: "lease-draft", cleanup_verified: false },
    providerUrl,
    sourceReadback: { ...sourceReadback, cleanup_receipt: { ...cleanup, task_id: "task-foreign" } },
    effectContext,
  }), /evidence_invalid/);
  assert.deepEqual(dailyAiPersistedEffectContext({
    run: { id: "run-draft", company_id: "company-1" } as any,
    metadata: { execution_context: { owner_id: "owner-from-run" }, portable_workflow_invocation: { companion_task_id: "task-from-run" } },
    original: { cleanup_verified: false }, workflowId: "daily-ai-research-publish-run", stepId: "step-draft", inputBundle,
  }), {
    company_id: "company-1", run_id: "run-draft", workflow_id: "daily-ai-research-publish-run", step_id: "step-draft",
    target_key: inputBundle.target_key,
  });
  assert.deepEqual(dailyAiPersistedEffectContext({
    run: { id: "run-draft", company_id: "company-1" } as any,
    metadata: {
      execution_context: { owner_id: "foreign-owner", run_id: "run-foreign" },
      portable_workflow_invocation: { companion_task_id: "foreign-task", run_id: "run-foreign" },
    },
    original: { cleanup_verified: false }, workflowId: "daily-ai-research-publish-run", stepId: "step-draft", inputBundle,
  }), {
    company_id: "company-1", run_id: "run-draft", workflow_id: "daily-ai-research-publish-run", step_id: "step-draft",
    target_key: inputBundle.target_key,
  });
});

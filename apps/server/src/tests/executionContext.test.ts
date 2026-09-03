import assert from "node:assert/strict";
import test from "node:test";
import {
  AOS_EXECUTION_CONTEXT_SCHEMA_V1,
  buildAosExecutionContext,
  canContinueAosExecution,
  executionContextPolicy,
  requiresAosOwnerTransferProof,
  validateAosExecutionContext,
} from "../runs/executionContext.js";

test("normal Companion continuation is AOS-local and does not depend on Codex App", () => {
  const context = buildAosExecutionContext({
    runId: "run-context",
    taskId: "task-context",
    route: { backend: "aos_chrome_companion", surface: "aos_chrome_companion_profile_instance" },
  });
  assert.equal(context.schema, AOS_EXECUTION_CONTEXT_SCHEMA_V1);
  assert.equal(context.source, "aos_local");
  assert.equal(context.app_dependency, false);
  assert.equal(context.authority_scope, "same_owner");
  assert.equal(canContinueAosExecution(context), true);
  assert.equal(requiresAosOwnerTransferProof(context), false);
  assert.equal(validateAosExecutionContext(context).context_digest, context.context_digest);
  assert.deepEqual(executionContextPolicy(context), {
    source: "aos_local",
    app_dependency: false,
    same_owner_continuation: true,
    owner_transfer_proof_required: false,
    reconciliation_required: false,
    replay_allowed: false,
  });
});
test("owner transfer and unknown effect stay blocked until signed reconciliation", () => {
  const context = buildAosExecutionContext({
    runId: "run-context-transfer",
    taskId: "task-context-transfer",
    handoffState: "pending",
    effectState: "unknown",
    reconciliationState: "pending",
  });
  assert.equal(canContinueAosExecution(context), false);
  assert.equal(requiresAosOwnerTransferProof(context), true);
  assert.equal(executionContextPolicy(context).reconciliation_required, true);
  assert.throws(() => validateAosExecutionContext({ ...context, context_digest: "0".repeat(64) }), /aos_execution_context_digest_invalid/u);
});

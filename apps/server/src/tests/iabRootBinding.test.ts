import assert from "node:assert/strict";
import test from "node:test";

import {
  IAB_ROOT_STAGE_BINDING_SCHEMA_V1,
  parseIabRootStageBindingV1,
  validateIabRootStageBindingV1
} from "../serviceReadiness/iabRootBinding.js";

const effectKey = "a".repeat(64);

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: IAB_ROOT_STAGE_BINDING_SCHEMA_V1,
    surface: "in_app_browser",
    root_id: "root-company-a",
    workflow_id: "daily-ai",
    run_id: "run-20260722-01",
    stage_id: "pre_browser_readiness",
    attempt_id: "attempt-1",
    fencing_token: 1,
    capability_id: "iab-capability-1",
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

test("binds fresh IAB identity to one service stage", () => {
  const parsed = parseIabRootStageBindingV1(base());
  assert.equal(parsed.surface, "in_app_browser");
  assert.equal(parsed.workflow_id, "daily-ai");
  assert.equal(parsed.iab_identity.stage, parsed.stage_id);
  assert.equal(parsed.iab_identity.attempt, parsed.fencing_token);
});
test("keeps external capability blocked until a separate executor exists", () => {
  const result = validateIabRootStageBindingV1(base({ capability_mode: "external" }));
  assert.deepEqual(result, {
    ok: false,
    status: "blocked",
    exact_blocker: "iab_external_effect_capability_not_implemented"
  });
});

test("rejects cross-bound stage, turn, and fencing identity", () => {
  for (const [field, value, blocker] of [
    ["stage_id", "publish", "iab_root_binding_stage_mismatch"],
    ["turn_id", "turn-2", "iab_root_binding_turn_mismatch"],
    ["fencing_token", 2, "iab_root_binding_fencing_token_mismatch"]
  ] as const) {
    const result = validateIabRootStageBindingV1(base({ [field]: value }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.exact_blocker, blocker);
  }
});

test("rejects legacy browser handles and old receipt markers", () => {
  const legacy = validateIabRootStageBindingV1(base({ browser_handle: "old-tab" }));
  assert.equal(legacy.ok, false);
  if (!legacy.ok) assert.equal(legacy.exact_blocker, "iab_root_binding_unknown_field:browser_handle");
  const reuse = validateIabRootStageBindingV1(base({ prior_receipt_reuse: true }));
  assert.equal(reuse.ok, false);
  if (!reuse.ok) assert.equal(reuse.exact_blocker, "iab_root_binding_prior_receipt_reuse_forbidden");
});

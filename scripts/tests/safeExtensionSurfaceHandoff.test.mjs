import assert from "node:assert/strict";
import test from "node:test";

import {
  completeSafeExtensionSurfaceHandoff,
  evaluateSafeExtensionSurfaceHandoff,
  officialExtensionEnvironmentForHandoff,
} from "../safe-extension-surface-handoff.mjs";

const input = {
  workflow_id: "daily-ai-research-publish-run",
  run_id: "run-1",
  step_id: "reference_readback",
  idempotency_key: "idem-1",
};

function safeBlocked(overrides = {}) {
  return {
    status: "blocked",
    exact_blocker: "companion_profile_not_connected",
    external_action_executed: false,
    browser_backend: "aos_chrome_companion",
    browser_surface: "aos_chrome_companion_profile_instance",
    cleanup_verified: true,
    effects_mode: "read_only",
    read_only_stage_bound: true,
    mutation_dispatch_attempted: false,
    mutation_dispatch_count: 0,
    operation_effect_state: "none",
    reconciliation_required: false,
    ...overrides,
  };
}

test("admits one-way official handoff only after terminal no-effect cleanup", () => {
  const handoff = evaluateSafeExtensionSurfaceHandoff({ sourceResult: safeBlocked(), input });
  assert.equal(handoff.status, "ready_for_official_visual_preflight");
  assert.equal(handoff.handoff_count, 1);
  assert.equal(handoff.source_no_effect_verified, true);
  assert.equal(handoff.destination_visual_required, true);
  const environment = officialExtensionEnvironmentForHandoff({
    AOS_WEB_OPERATION_BACKEND: "aos_chrome_companion",
    AOS_WEB_OPERATION_BACKEND_FALLBACK_ALLOWED: "false",
  });
  assert.equal(environment.AOS_WEB_OPERATION_BACKEND, "chrome_plugin");
  assert.equal(environment.AOS_CHROME_PROFILE_SURFACE, "signed_chrome_extension_profile2");
  assert.equal(environment.AOS_WEB_OPERATION_BACKEND_FALLBACK_ALLOWED, "false");
});

test("blocks handoff for unknown effect, authentication, ambiguity, or cleanup loss", () => {
  for (const result of [
    safeBlocked({ operation_effect_state: "unknown", reconciliation_required: true }),
    safeBlocked({ exact_blocker: "auth_blocked:login_required" }),
    safeBlocked({ exact_blocker: "companion_adapter_target_ambiguous" }),
    safeBlocked({ cleanup_verified: false }),
  ]) {
    assert.equal(evaluateSafeExtensionSurfaceHandoff({ sourceResult: result, input }).status, "blocked");
  }
});

test("requires official visual, semantic, and cleanup proof to complete", () => {
  const handoff = evaluateSafeExtensionSurfaceHandoff({ sourceResult: safeBlocked(), input });
  const incomplete = completeSafeExtensionSurfaceHandoff(handoff, {
    status: "complete",
    external_action_executed: false,
    cleanup_verified: true,
    readback_verified: true,
    visual_readback_verified: false,
  });
  assert.equal(incomplete.status, "blocked");
  const complete = completeSafeExtensionSurfaceHandoff(handoff, {
    status: "complete",
    external_action_executed: false,
    cleanup_verified: true,
    readback_verified: true,
    visual_readback_verified: true,
  });
  assert.equal(complete.status, "completed");
  assert.equal(complete.destination_visual_verified, true);
});

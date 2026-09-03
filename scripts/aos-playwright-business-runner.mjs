#!/usr/bin/env node

// playwright_workflow_owned_adapter
//
// This is an explicit, fail-closed entrypoint for the Playwright selection.
// Provider-specific effect stages are intentionally not implemented yet. The
// runner exists so AOS can validate the current-run admission/action-plan
// boundary and return a stable, auditable blocker without falling back to a
// different browser surface.

const runId = String(process.env.AUTOMATION_OS_PORTABLE_BUSINESS_RUN_ID || "");
const stepId = String(process.env.AUTOMATION_OS_PORTABLE_BUSINESS_STEP_ID || "");
const workflowId = String(process.env.AUTOMATION_OS_PORTABLE_BUSINESS_WORKFLOW_ID || "");

process.stdout.write(`${JSON.stringify({
  status: "blocked",
  exact_blocker: "playwright_effect_stages_not_implemented",
  external_action_executed: false,
  browser_surface: "playwright",
  workflow_id: workflowId,
  run_id: runId,
  step_id: stepId,
  same_run_receipt: false,
  cleanup_verified: true,
  runner_receipt: {
    schema: "automation_os_playwright_workflow_owned_entrypoint.v1",
    adapter_mode: "entrypoint_only",
    effect_stages_implemented: false,
    browser_session_started: false,
    cleanup_verified: true,
    fallback_allowed: false,
    next_action: "implement workflow-specific Playwright provider stages with receipt, source sync, reconciliation, and group-only cleanup",
  },
})}\n`);

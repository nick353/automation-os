#!/usr/bin/env node

// Compatibility entrypoint only.  The former implementation launched a
// separate Chrome/CDP process and is intentionally retired.  Facebook/X
// browser work must enter through the registered Browser Use CLI workflow so
// the current-run authority, recording, effect ledger, and cleanup proof are
// bound together.
const result = {
  status: "blocked",
  exact_blocker: "browser_use_cli_workflow_adapter_missing",
  browser_surface: "browser_use_cli",
  legacy_surface: "direct_chrome_cdp_retired",
  external_action_executed: false,
  next_action: "Register a workflow-owned Browser Use CLI adapter and provide fresh authority/profile/port/readback before retrying."
};
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = 1;

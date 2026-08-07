#!/usr/bin/env node

// Historical filename retained for artifact/registry compatibility.  Do not
// launch Playwright, Chrome, or a raw CDP lane from this file.  The registered
// runner must be replaced by a workflow-owned Browser Use CLI adapter before
// any SNS operation is admitted.
const result = {
  status: "blocked",
  exact_blocker: "browser_use_cli_workflow_adapter_missing",
  browser_surface: "browser_use_cli",
  legacy_surface: "playwright_chrome_cdp_retired",
  external_action_executed: false,
  next_action: "Register a canonical Browser Use CLI adapter with fresh authority/profile/port/same-session readback and cleanup proof."
};
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = 1;

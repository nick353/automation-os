#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { startBrowserUseCliFlow } from "/Users/nichikatanaka/Documents/New project/browser-use-cli/lib/stage-adapter.mjs";

// Compatibility boundary for the historical AOS direct runner. The portable
// business runner in the selected backend owns the effectful adapter. Keeping
// this path as an explicit, receipt-producing stop prevents the legacy
// --image-path/--caption invocation from becoming an implicit fallback.
const ROUTE = "browser_use_cli_registered_runner";
const BLOCKER = "sns_multi_poster_portable_admission_required";
void startBrowserUseCliFlow;

function value(argv, key) {
  const index = argv.indexOf(`--${key}`);
  return index >= 0 ? String(argv[index + 1] || "") : "";
}

function writeResult(argv) {
  const runId = value(argv, "run-id") || "unknown-run";
  const outRoot = path.resolve(value(argv, "out-root") || process.cwd());
  const resultPath = path.join(outRoot, "artifacts", "runs", runId, "result.json");
  const result = {
    schema: "sns_multi_poster_browser_use_cli_compatibility_result.v1",
    route: ROUTE,
    status: "blocked",
    run_id: runId,
    browser_surface: "browser_use_cli",
    external_action_executed: false,
    same_run_receipt: false,
    readback_verified: false,
    cleanup_verified: true,
    exact_blocker: BLOCKER,
    next_action: "invoke the AOS portable business runner with fresh target/account/payload/audience/authority/approval/idempotency input",
    no_replay: true,
    provider_receipt: null,
    source_sync: null,
    reconciliation: null,
    canonical_stage_adapter: "/Users/nichikatanaka/Documents/New project/browser-use-cli/lib/stage-adapter.mjs",
  };
  fs.mkdirSync(path.dirname(resultPath), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(resultPath), 0o700);
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(resultPath, 0o600);
  process.stdout.write(`${JSON.stringify({ ...result, result_path: resultPath })}\n`);
  return 1;
}

try {
  process.exitCode = writeResult(process.argv.slice(2));
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    schema: "sns_multi_poster_browser_use_cli_compatibility_result.v1",
    route: ROUTE,
    status: "blocked",
    browser_surface: "browser_use_cli",
    external_action_executed: false,
    cleanup_verified: true,
    exact_blocker: String(error?.message || error),
  })}\n`);
  process.exitCode = 1;
}

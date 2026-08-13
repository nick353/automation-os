#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { runBrowserUseCliFlowCommand } from "/Users/nichikatanaka/Documents/New project/browser-use-cli/lib/stage-adapter.mjs";

// This adapter is the SNS provider entrypoint.  It deliberately stops before
// opening a browser until the current target/account/audience/authority/
// approval binding is supplied by the common effect kernel.  The import above
// keeps the provider on the canonical Browser Use CLI stage-adapter boundary;
// no provider-specific browser launcher is permitted here.
const ROUTE = "browser_use_cli_registered_runner";
const RESULT_SCHEMA = "sns_multi_poster_browser_use_cli_result.v1";
const BLOCKER = "sns_multi_poster_target_account_audience_authority_missing";
const IDENTIFIER = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,179}$/u;

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (!token.startsWith("--")) throw new Error("sns_multi_poster_argument_invalid");
    const key = token.slice(2).replaceAll("-", "_");
    const value = argv[index + 1];
    if (!value || String(value).startsWith("--")) throw new Error(`sns_multi_poster_${key}_missing`);
    values[key] = String(value);
    index += 1;
  }
  if (!IDENTIFIER.test(String(values.run_id || ""))) throw new Error("sns_multi_poster_run_id_invalid");
  if (!path.isAbsolute(String(values.out_root || ""))) throw new Error("sns_multi_poster_out_root_invalid");
  if (!String(values.image_path || "").trim()) throw new Error("sns_multi_poster_image_path_missing");
  if (!String(values.caption || "").trim()) throw new Error("sns_multi_poster_caption_missing");
  return values;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function main(argv = process.argv.slice(2)) {
  const input = parseArgs(argv);
  const runId = input.run_id;
  const runDir = path.resolve(input.out_root, "artifacts", "runs", runId);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(runDir, 0o700);
  const resultPath = path.join(runDir, "result.json");
  const payloadHash = sha256(JSON.stringify({ image_path: input.image_path, caption: input.caption }));
  const result = {
    schema: RESULT_SCHEMA,
    route: ROUTE,
    status: "blocked",
    run_id: runId,
    browser_surface: "browser_use_cli",
    effect_stage: "web_operation_effect",
    external_action_executed: false,
    target_binding: null,
    account_identity: null,
    audience: null,
    payload_hash: payloadHash,
    authority: null,
    approval: null,
    exact_blocker: BLOCKER,
    current_stage: "effect_admission",
    restart_point: "effect_admission",
    next_action: "Supply a fresh same-run target binding, account identity, audience, authority receipt, and approved idempotency key to the common web-operation effect kernel; do not replay this run.",
    cleanup_verified: true,
    provider_receipt: null,
    source_sync: null,
    reconciliation: null,
    canonical_stage_adapter: "/Users/nichikatanaka/Documents/New project/browser-use-cli/lib/stage-adapter.mjs",
    generated_at: new Date().toISOString()
  };
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(resultPath, 0o600);
  process.stdout.write(`${JSON.stringify({ ...result, result_path: resultPath })}\n`);
  return 1;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    schema: RESULT_SCHEMA,
    route: ROUTE,
    status: "blocked",
    browser_surface: "browser_use_cli",
    external_action_executed: false,
    exact_blocker: error instanceof Error ? error.message : String(error),
    cleanup_verified: true
  })}\n`);
  process.exitCode = 1;
}

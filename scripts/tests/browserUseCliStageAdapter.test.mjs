import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  BROWSER_USE_CLI_START_DESCRIPTOR_SCHEMA,
  BROWSER_USE_CLI_HELPER_OUTPUT_LIMIT_BYTES,
  parseBrowserUseCliStartDescriptor,
  validateBrowserUseCliLifecycleState,
  validateBrowserUseCliStageRequest,
  validateBrowserUseCliReadOnlyBatchCommands,
  runBrowserUseCliStage,
} from "/Users/nichikatanaka/.codex/skills/automation-kernel-run/scripts/browser-use-cli-stage-adapter.mjs";

const fixturePath = new URL("./fixtures/browser-use-recording-start.v1.json", import.meta.url);
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));

test("parses the strict navigation-free Browser Use start descriptor fixture", () => {
  const parsed = parseBrowserUseCliStartDescriptor(fixture, {
    automationId: fixture.automation_id,
    runId: fixture.run_id,
    stageId: fixture.stage_id,
    requestedSession: fixture.requested_session,
    port: fixture.port,
    allowedOrigins: fixture.allowed_origins,
    expiresAt: fixture.expires_at,
  });
  assert.equal(parsed.schema, BROWSER_USE_CLI_START_DESCRIPTOR_SCHEMA);
  assert.equal(parsed.effective_session, fixture.effective_session);
  assert.equal(parsed.process.root_pid, 4242);
  assert.deepEqual(parsed.lock_paths, fixture.lock_paths);
});

test("rejects start descriptor mismatches and extra fields", () => {
  assert.throws(() => parseBrowserUseCliStartDescriptor({ ...fixture, port: 19981 }, {
    automationId: fixture.automation_id,
    runId: fixture.run_id,
    stageId: fixture.stage_id,
    requestedSession: fixture.requested_session,
    port: fixture.port,
    allowedOrigins: fixture.allowed_origins,
    expiresAt: fixture.expires_at,
  }), /browser_use_cli_start_descriptor_binding_mismatch/);
  assert.throws(() => parseBrowserUseCliStartDescriptor({ ...fixture, secret: "must-not-pass" }, {
    automationId: fixture.automation_id,
    runId: fixture.run_id,
    stageId: fixture.stage_id,
    requestedSession: fixture.requested_session,
    port: fixture.port,
    allowedOrigins: fixture.allowed_origins,
    expiresAt: fixture.expires_at,
  }), /browser_use_cli_start_descriptor_additional_field/);
});

test("enforces lifecycle ordering and rejects replay/concurrency", () => {
  assert.deepEqual(validateBrowserUseCliLifecycleState("idle", "start"), "started");
  assert.deepEqual(validateBrowserUseCliLifecycleState("started", "command"), "commanded");
  assert.deepEqual(validateBrowserUseCliLifecycleState("commanded", "readback"), "readback");
  assert.deepEqual(validateBrowserUseCliLifecycleState("readback", "finalize"), "finalized");
  assert.throws(() => validateBrowserUseCliLifecycleState("idle", "command"), /browser_use_cli_lifecycle_start_required/);
  assert.throws(() => validateBrowserUseCliLifecycleState("finalized", "command"), /browser_use_cli_lifecycle_replay_rejected/);
  assert.throws(() => validateBrowserUseCliLifecycleState("commanded", "command"), /browser_use_cli_lifecycle_concurrent_command_rejected/);
});

test("public request validation remains no-side-effect and rejects forbidden commands", () => {
  const request = validateBrowserUseCliStageRequest({
    automationId: "automation-os-iab",
    runId: "fixture-run-20260727",
    stageId: "workflow",
    mode: "public",
    lifecycle: "single-use",
    command: ["open", "https://example.com"],
    postCommands: [["state"], ["get", "title"], ["get", "url"]],
  });
  assert.equal(request.mode, "public");
  assert.throws(() => validateBrowserUseCliStageRequest({
    automationId: "automation-os-iab",
    runId: "fixture-run-20260727",
    stageId: "workflow",
    mode: "public",
    lifecycle: "single-use",
    command: ["click", "submit"],
  }), /browser_use_cli_command_not_allowed/);
});

test("adaptive read-only batch accepts bounded exploration and rejects effects", () => {
  const commands = validateBrowserUseCliReadOnlyBatchCommands([
    ["open", "https://example.com"],
    ["eval", "location.href"],
    ["state"],
    ["get", "title"],
    ["screenshot", "/private/tmp/browser-use-cli-adaptive.png"],
  ]);
  assert.equal(commands.length, 5);
  assert.deepEqual(commands[1], ["eval", "location.href"]);
  assert.throws(() => validateBrowserUseCliReadOnlyBatchCommands([["click", "Post"]]), /browser_use_cli_read_only_batch_effectful_command_rejected/);
  assert.throws(() => validateBrowserUseCliReadOnlyBatchCommands([["eval", "document.body.innerText"]]), /browser_use_cli_read_only_batch_effectful_command_rejected/);
  assert.throws(() => validateBrowserUseCliReadOnlyBatchCommands(Array.from({ length: 9 }, () => ["state"])), /browser_use_cli_read_only_batch_commands_invalid/);
});

test("canonical and packaged helpers share the single-process batch transport contract", () => {
  const canonicalPath = "/Users/nichikatanaka/.local/bin/codex-browser-use";
  const packagedPath = "/Users/nichikatanaka/Documents/New project/browser-use-cli/bin/codex-browser-use";
  const canonical = fs.readFileSync(canonicalPath, "utf8");
  const packaged = fs.readFileSync(packagedPath, "utf8");
  assert.equal(canonical, packaged, "installed and package helper must remain byte-identical");
  for (const marker of [
    "browser_harness_batch_script",
    "jobs_literal = repr(jobs)",
    'transport": "single_browser_use_process"',
    "browser_process_count",
    "_cleanup_record_batch_transport_paths",
    ".batch-command-capture-",
  ]) {
    assert.ok(canonical.includes(marker), `batch transport marker missing: ${marker}`);
  }
});

test("dry-run does not launch helper and preserves cleanup proof", async () => {
  const artifactDir = fs.realpathSync(fs.mkdtempSync("/private/tmp/browser-use-cli-adapter-test-"));
  const result = await runBrowserUseCliStage({
    automationId: "automation-os-iab",
    runId: "fixture-run-20260727-dry",
    stageId: "workflow",
    session: "automation-os-iab-fixture-dry",
    mode: "public",
    lifecycle: "single-use",
    port: 19980,
    allowedOrigins: ["https://example.com"],
    command: ["open", "https://example.com"],
    postCommands: [["state"], ["get", "title"], ["get", "url"]],
    artifactDir,
    dryRun: true,
  });
  assert.equal(result.status, "dry_run");
  assert.equal(result.cleanup_verified, true);
  assert.equal(result.external_action_executed, false);
  assert.equal(result.helper_launched, false);
});

test("keeps the bounded helper JSON envelope parseable for large state readbacks", () => {
  assert.ok(BROWSER_USE_CLI_HELPER_OUTPUT_LIMIT_BYTES >= 4 * 1024 * 1024);
});

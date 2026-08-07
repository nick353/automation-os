import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BROWSER_USE_CLI_WORKFLOW_ADAPTER_MISSING_BLOCKER,
  inspectBrowserUseCliRunner
} from "../runs/browserUseCliRunnerGuard.js";

const root = mkdtempSync(join(tmpdir(), "automation-os-browser-use-runner-guard-"));

test("blocks an unmarked runner even when it has no legacy browser-driver signals", () => {
  const runner = join(root, "browser-use-runner.mjs");
  writeFileSync(runner, "export const browser_surface = 'browser_use_cli';\n", "utf8");
  chmodSync(runner, 0o700);
  const inspection = inspectBrowserUseCliRunner(runner);
  assert.equal(inspection.ok, false);
  assert.equal(inspection.exactBlocker, BROWSER_USE_CLI_WORKFLOW_ADAPTER_MISSING_BLOCKER);
  assert.deepEqual(inspection.forbiddenSignals, ["canonical_stage_adapter_missing"]);
});

test("admits a generic registered CLI surface with the shared stage adapter marker", () => {
  const runner = join(root, "browser-use-registered-runner.mjs");
  writeFileSync(runner, [
    "import { BROWSER_USE_CLI_SURFACE } from '../browser-use-cli/lib/stage-adapter.mjs';",
    "const route = 'browser_use_cli_registered_runner';",
    "export { BROWSER_USE_CLI_SURFACE, route };"
  ].join("\n"), "utf8");
  chmodSync(runner, 0o700);
  const inspection = inspectBrowserUseCliRunner(runner);
  assert.equal(inspection.ok, true);
  assert.equal(inspection.exactBlocker, null);
  assert.deepEqual(inspection.forbiddenSignals, []);
});

test("admits a registered Python wrapper only when it names the canonical helper", () => {
  const runner = join(root, "run-prompt-transfer-browser-use.py");
  writeFileSync(runner, [
    "BROWSER_USE_CLI_HELPER = '/Users/nichikatanaka/.local/bin/codex-browser-use'",
    "BROWSER_USE_CLI_ROUTE = 'browser_use_cli_registered_runner'",
  ].join("\n"), "utf8");
  chmodSync(runner, 0o700);
  const inspection = inspectBrowserUseCliRunner(runner);
  assert.equal(inspection.ok, true);
  assert.equal(inspection.exactBlocker, null);
  assert.deepEqual(inspection.forbiddenSignals, []);
});

test("blocks a runner whose path or source selects a legacy browser driver", () => {
  const runner = join(root, "run_daily_ai_playwright_cli.mjs");
  writeFileSync(runner, "connectOverCDP();\n", "utf8");
  const inspection = inspectBrowserUseCliRunner(runner);
  assert.equal(inspection.ok, false);
  assert.equal(inspection.exactBlocker, BROWSER_USE_CLI_WORKFLOW_ADAPTER_MISSING_BLOCKER);
  assert.ok(inspection.forbiddenSignals.length > 0);
});

test("blocks missing or unreadable runner paths without guessing a fallback", () => {
  const inspection = inspectBrowserUseCliRunner(join(root, "missing-runner.mjs"));
  assert.equal(inspection.ok, false);
  assert.equal(inspection.exactBlocker, BROWSER_USE_CLI_WORKFLOW_ADAPTER_MISSING_BLOCKER);
  assert.deepEqual(inspection.forbiddenSignals, ["runner_missing"]);
});

test("admits the Browser Use CLI stage adapter despite compatibility-only Chrome plugin names", () => {
  const runner = join(root, "run_daily_ai_browser_use_cli_registered.mjs");
  writeFileSync(
    runner,
    [
      "import { runBrowserUseCliFlowCommand, runBrowserUseCliCleanupProof } from '../browser-use-cli/lib/stage-adapter.mjs';",
      "import { runDailyAiChromePluginResume } from './run_daily_ai_chrome_plugin.mjs';",
      "export { runBrowserUseCliFlowCommand, runBrowserUseCliCleanupProof, runDailyAiChromePluginResume };"
    ].join("\n"),
    "utf8"
  );
  chmodSync(runner, 0o700);
  const inspection = inspectBrowserUseCliRunner(runner);
  assert.equal(inspection.ok, true);
  assert.equal(inspection.exactBlocker, null);
  assert.deepEqual(inspection.forbiddenSignals, []);
});

test("admits the registered Daily AI Browser Use CLI entry despite legacy module naming", () => {
  const runner = join(root, "run_daily_ai_registered_entry.mjs");
  writeFileSync(runner, `
    import { runDailyAiChromePluginResume } from "./run_daily_ai_chrome_plugin.mjs";
    const route = "browser_use_cli_registered_runner";
    export { runDailyAiChromePluginResume, route };
  `, "utf8");
  chmodSync(runner, 0o700);
  const inspection = inspectBrowserUseCliRunner(runner);
  assert.equal(inspection.ok, true);
  assert.equal(inspection.exactBlocker, null);
  assert.deepEqual(inspection.forbiddenSignals, []);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  defaultPromptTransferBrowserUseRunner,
  resolvePromptTransferBrowserUseRunner
} from "../runs/promptTransferRegisteredRunner.js";
import { inspectBrowserUseCliRunner } from "../runs/browserUseCliRunnerGuard.js";

test("Prompt Transfer defaults to the registered Browser Use CLI wrapper", () => {
  assert.match(defaultPromptTransferBrowserUseRunner, /run_prompt_transfer_ukiyoe_browser_use\.py$/u);
  const source = readFileSync(defaultPromptTransferBrowserUseRunner, "utf8");
  assert.match(source, /codex-browser-use/u);
  assert.match(source, /browser_use_cli_registered_runner/u);
  assert.deepEqual(resolvePromptTransferBrowserUseRunner().source, "default");
  const inspection = inspectBrowserUseCliRunner(defaultPromptTransferBrowserUseRunner);
  assert.equal(inspection.ok, true);
  assert.equal(inspection.exactBlocker, null);
  assert.deepEqual(inspection.forbiddenSignals, []);
});

test("Prompt Transfer does not guess a missing configured runner", () => {
  const result = resolvePromptTransferBrowserUseRunner({
    defaultRunnerPath: "/tmp/automation-os-prompt-transfer-runner-does-not-exist.py"
  });
  assert.equal(result.runner, undefined);
  assert.equal(result.defaultRunnerPath, "/tmp/automation-os-prompt-transfer-runner-does-not-exist.py");
});

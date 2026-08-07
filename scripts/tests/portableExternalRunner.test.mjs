import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildCodexExecArgs, buildPrompt, inspectCanonicalBrowserUseCli, selectCodexBin } from "../portable-external-runner.mjs";

test("AUTOMATION_OS_CODEX_BIN takes precedence over CODEX_CLI_PATH", () => {
  assert.equal(
    selectCodexBin({
      AUTOMATION_OS_CODEX_BIN: "/custom/automation-os/codex",
      CODEX_CLI_PATH: "/custom/launch-agent/codex"
    }),
    "/custom/automation-os/codex"
  );
});

test("CODEX_CLI_PATH is used when the explicit override is absent", () => {
  assert.equal(
    selectCodexBin({ CODEX_CLI_PATH: "/custom/launch-agent/codex" }),
    "/custom/launch-agent/codex"
  );
});

test("the stable fallback is used when neither path is configured", () => {
  assert.equal(selectCodexBin({}), "/usr/local/bin/codex");
});

test("portable exec skips the git trust check for authority-owned non-repository workdirs", () => {
  const args = buildCodexExecArgs({ cwd: "/tmp/workflow", lastMessagePath: "/tmp/receipt.json", prompt: "prompt" });
  assert.deepEqual(args.slice(0, 6), [
    "exec",
    "--ephemeral",
    "--sandbox", "danger-full-access",
    "--skip-git-repo-check",
    "--cd"
  ]);
  assert.deepEqual(args.slice(6), ["/tmp/workflow", "--output-last-message", "/tmp/receipt.json", "prompt"]);
});

test("portable prompt carries the approval state without requiring a Codex App thread", () => {
  const prompt = buildPrompt({
    workflow_id: "job-application-manager",
    run_id: "run-prompt-contract",
    step_id: "step-prompt-contract",
    source_trigger: "automation_os_scheduler",
    idempotency_key: "prompt-contract",
    spec: {
      cwd: "/tmp/workflow",
      authority: [],
      objective: "read-only contract probe"
    },
    effects: false,
    approvalGranted: false
  });
  assert.match(prompt, /external_effects=read_only/);
  assert.match(prompt, /external_approval=not_granted/);
  assert.match(prompt, /Browser contract: use only .* through .*stage-adapter\.mjs/);
  assert.match(prompt, /Codex App thread/);
});

test("portable external runner requires a canonical Browser Use CLI runtime readback", () => {
  const result = inspectCanonicalBrowserUseCli({
    runner: () => ({
      status: 0,
      error: null,
      stdout: JSON.stringify({ exact_blocker: null, runtime_drift: false, launch: false })
    })
  });
  assert.equal(result.ok, true);
  assert.equal(result.exact_blocker, null);
});

test("portable external runner fails closed when the canonical Browser Use CLI helper is missing", () => {
  const result = inspectCanonicalBrowserUseCli({
    helperPath: "/tmp/automation-os-missing-canonical-browser-use-cli",
    stageAdapterPath: "/tmp/automation-os-missing-stage-adapter",
    runtimeConfigPath: "/tmp/automation-os-missing-runtime-config"
  });
  assert.equal(result.ok, false);
  assert.equal(result.exact_blocker, "portable_external_browser_use_cli_helper_missing");
});

test("portable external runner refuses enabled effects without an approval marker", () => {
  const runnerPath = fileURLToPath(new URL("../portable-external-runner.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [
    runnerPath,
    "--workflow-id", "job-application-manager",
    "--run-id", "run-approval-guard",
    "--step-id", "step-approval-guard",
    "--source-trigger", "automation_os_scheduler",
    "--idempotency-key", "approval-guard-test"
  ], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS: "enabled",
      AUTOMATION_OS_CODEX_BIN: process.execPath
    }
  });
  assert.notEqual(result.status, 0);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.status, "blocked");
  assert.equal(receipt.exact_blocker, "portable_external_approval_required");
  assert.equal(receipt.external_action_executed, false);
});

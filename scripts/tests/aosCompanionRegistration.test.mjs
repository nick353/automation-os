import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const PROJECT_ROOT = "/Users/nichikatanaka/Documents/Codex/automation-os";
const MANIFEST_PATH = path.join(PROJECT_ROOT, ".codex/automation-kernel/manifests/aos-companion-2.json");
const CONFIG_PATH = path.join(PROJECT_ROOT, ".codex/automation-kernel/runners/aos-companion-2.config.json");
const AUTOMATION_PATH = "/Users/nichikatanaka/.codex/automations/aos-companion-2/automation.toml";

function registeredPrompt() {
  const source = fs.readFileSync(AUTOMATION_PATH, "utf8");
  const line = source.split("\n").find((item) => item.startsWith("prompt = "));
  assert.ok(line, "registered automation prompt is missing");
  return JSON.parse(line.slice("prompt = ".length));
}

test("registered Companion Root adapter matches the manifest runner", () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const runnerPath = path.resolve(PROJECT_ROOT, manifest.runner.path);
  const prompt = registeredPrompt();

  assert.equal(manifest.id, "aos-companion-2");
  assert.equal(runnerPath, path.join(PROJECT_ROOT, ".codex/automation-kernel/runners/aos-companion-2.mjs"));
  assert.equal(fs.statSync(runnerPath).isFile(), true);
  assert.equal(config.automation_id, manifest.id);
  assert.equal(path.resolve(config.command[1]), path.join(PROJECT_ROOT, "scripts/aos-hourly-companion-audit.mjs"));
  assert.match(prompt, /^POST_AUDIT_FIRST_V2/u);
  assert.match(prompt, /rootActionRequired=true/u);
  assert.match(prompt, /finalizeCurrentRootHourlyController/u);
  assert.match(prompt, /mcp__node_repl__js セル/u);
  assert.match(prompt, /Do not inject an API key/u);
  assert.match(prompt, /GOAL_PLAN_READBACK_ABSENCE_IS_NOT_A_STANDALONE_STOP_V1/u);
  assert.match(prompt, /goal_plan_readback_unavailable/u);
  assert.match(prompt, /an absent Goal\/Plan object alone is not a blocker/u);
  assert.match(prompt, /PROACTIVE_SAME_ROOT_REPAIR_CONTROLLER_V1/u);
  assert.match(prompt, /CURRENT_ROOT_REGISTERED_EXECUTE_ADAPTER_V1/u);
  assert.match(prompt, /deep-read every selected candidate up to the declared limit/u);
  assert.match(prompt, /CONTINUATION_LEDGER_RECONCILIATION_V1/u);
  assert.match(prompt, /continuation-ledger/u);
  assert.match(prompt, /intent_reserved or sent_unverified/u);
  assert.match(prompt, /CROSS_TASK_COMPANION_BOUNDARY_V1/u);
  assert.match(prompt, /never call any task-bound mcp__aos_chrome_companion__/u);
  assert.match(prompt, /TASK_OWNED_COMPANION_RELAY_V1/u);
  assert.match(prompt, /taskOwnedContinuationCandidateCount/u);
  assert.match(prompt, /task_owned_companion_relay/u);
  assert.match(prompt, /PER_CANDIDATE_PROGRESS_LOOP_V1/u);
  assert.match(prompt, /deliveryConfirmed=true/u);
  assert.match(prompt, /includeOutputs:true/u);
  assert.match(prompt, /functionCallOutput/u);
  assert.match(prompt, /wait_threads/u);
  assert.equal(prompt.includes(`runnerPath:"${runnerPath}"`), true);
  assert.equal(prompt.includes(`runnerPath:"${path.join(PROJECT_ROOT, ".codex/automation-kernel/runners/aos-companion.mjs")}"`), false);
});

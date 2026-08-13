#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  checkpointBrowserUseGoal,
  createBrowserUseGoalKernel,
  ensureBrowserUseGoalFlow,
  finalizeBrowserUseGoalFlow,
  readBrowserUseGoalState,
} from "./browser-use-goal-kernel.mjs";

const configuredRoot = String(process.env.AOS_CANARY_ARTIFACT_ROOT || "").trim();
const root = configuredRoot ? path.resolve(configuredRoot) : path.resolve(process.cwd(), "work/browser-use-goal-kernel-canary-20260812");
const runId = String(process.env.AOS_CANARY_RUN_ID || "no-effect-canary-20260812-r3");
const goalId = String(process.env.AOS_CANARY_GOAL_ID || "no-effect-canary-goal-r3");
const session = String(process.env.AOS_CANARY_SESSION || "aos-no-effect-canary-goal-session-r3");
const input = {
  workflow_id: "browser-use-goal-no-effect-canary",
  run_id: runId,
  step_id: "canary-readback",
  source_trigger: "codex_app_bridge",
  idempotency_key: runId,
};
const environment = {
  AUTOMATION_OS_ARTIFACT_ROOT: root,
  AUTOMATION_OS_BROWSER_GOAL_ID: goalId,
  AUTOMATION_OS_BROWSER_GOAL_TERMINAL: "1",
};
const kernel = createBrowserUseGoalKernel({ input, environment });
const spec = {
  automationId: "aos-no-effect-canary",
  stageId: "aos-no-effect-canary-goal",
  session,
  mode: "public",
  lifecycle: "single-use",
  authorityPath: "",
  authoritySha256: "",
  allowedOrigins: ["https://example.com"],
  port: 19980,
  approval: "approved",
  effectful: false,
  currentStage: input.step_id,
};

const ensured = await ensureBrowserUseGoalFlow({ kernel, spec });
let flow = ensured.flow;
const commands = [
  ["open", "https://example.com"],
  ["wait", "1"],
  ["get", "url"],
  ["get", "title"],
  ["state"],
  ["screenshot", path.join(flow.recording_dir, "no-effect-canary.png")],
];
const batch = await ensured.adapter.runBrowserUseCliFlowReadOnlyBatch({
  flow,
  authorityPath: "",
  commands,
  actionSequence: Number(flow.contract?.action_sequence || 0),
  actionNonces: commands.map((_, index) => `${input.run_id}-${index + 1}-${randomUUID()}`),
  captureReadback: true,
});
flow = batch;
const captured = batch.captured_readback || {};
checkpointBrowserUseGoal({
  kernel,
  status: "running",
  currentStage: input.step_id,
  lastReadback: {
    stage: input.step_id,
    title_length: String(captured["3"] || "").length,
    state_length: String(captured["4"] || "").length,
    origin: "https://example.com",
  },
  nextAction: "finalize_goal_flow_after_readback",
  restartPoint: "goal_flow_readback",
});
const completed = await finalizeBrowserUseGoalFlow({ kernel });
const state = readBrowserUseGoalState({ kernel });
process.stdout.write(`${JSON.stringify({
  status: completed.status,
  goal_status: state.status,
  external_action_executed: state.external_action_executed,
  cleanup_verified: completed.cleanup_verified,
  requested_session: state.requested_session,
  effective_session: state.effective_session,
  profile_root: state.profile_root,
  reserved_port: state.reserved_port,
  last_readback: state.last_readback,
  next_action: state.next_action,
  state_path: kernel.paths.statePath,
  lease_path: kernel.paths.leasePath,
  runtime: kernel.runtime,
}, null, 2)}\n`);

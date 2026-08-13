import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BROWSER_USE_GOAL_KERNEL_SCHEMA,
  CANONICAL_BROWSER_USE_ADAPTER,
  CANONICAL_BROWSER_USE_HELPER,
  CANONICAL_BROWSER_USE_RUNTIME,
  checkpointBrowserUseGoal,
  createBrowserUseGoalKernel,
  ensureBrowserUseGoalFlow,
  finalizeBrowserUseGoalFlow,
  recoverBrowserUseGoalFlow,
  readBrowserUseGoalState,
} from "../browser-use-goal-kernel.mjs";

function fixture() {
  const artifactRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aos-goal-kernel-")));
  const runId = "goal-kernel-fixture";
  const runRoot = path.join(artifactRoot, runId);
  fs.mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(runRoot, 0o700);
  const input = {
    workflow_id: "daily-ai-research-publish-run",
    run_id: runId,
    step_id: "research-stage-1",
    source_trigger: "codex_app_bridge",
    idempotency_key: "goal-kernel-idempotency-1",
  };
  const flow = {
    run_id: runId,
    automation_id: "daily-ai",
    lifecycle: "scheduled",
    port: 19882,
    profile: "/Users/nichikatanaka/.browser-use-cli/profiles/scheduled/daily-ai",
    session: "goal-session-effective",
    descriptor_path: "/Users/nichikatanaka/.browser-use-cli/recordings/goal-kernel-fixture__goal/descriptor.json",
    recording_dir: "/Users/nichikatanaka/.browser-use-cli/recordings/goal-kernel-fixture__goal",
    flow_id: "flow-fixture",
    lease_id: "lease-fixture",
    contract: {
      step_id: "daily-ai-daily-ai-research-publish-run-goal",
      requested_session: "goal-session-requested",
      effective_session: "goal-session-effective",
      flow_id: "flow-fixture",
      lease_id: "lease-fixture",
    },
  };
  const calls = { start: 0, resume: 0, writeLease: 0, finalize: 0 };
  const adapter = {
    async startBrowserUseCliFlow() {
      calls.start += 1;
      return flow;
    },
    writeBrowserUseCliFlowLease({ leasePath }) {
      calls.writeLease += 1;
      fs.writeFileSync(leasePath, `${JSON.stringify({ schema: "browser-use-flow-lease.v2", status: "held" })}\n`, { mode: 0o600 });
      fs.chmodSync(leasePath, 0o600);
      return { lease_id: flow.lease_id, lease_path: leasePath };
    },
    resumeBrowserUseCliFlowFromLease() {
      calls.resume += 1;
      return flow;
    },
    async finalizeBrowserUseCliFlowLease({ leasePath }) {
      calls.finalize += 1;
      fs.writeFileSync(leasePath, `${JSON.stringify({ schema: "browser-use-flow-lease.v2", status: "finalized" })}\n`, { mode: 0o600 });
      return { finalized: true, cleanup_verified: true, receipt_path: "/tmp/receipt.json", manifest_path: "/tmp/manifest.json" };
    },
  };
  const environment = {
    AUTOMATION_OS_ARTIFACT_ROOT: artifactRoot,
    AUTOMATION_OS_BROWSER_GOAL_ID: "goal-kernel-fixture-goal",
    AUTOMATION_OS_BROWSER_GOAL_RECOVERY_BUDGET: "1",
  };
  const kernel = createBrowserUseGoalKernel({ input, environment, adapter });
  const spec = {
    automationId: "daily-ai",
    stageId: "daily-ai-daily-ai-research-publish-run-goal",
    session: "goal-session-requested",
    mode: "authorized",
    lifecycle: "scheduled",
    authorityPath: "/tmp/authority.json",
    authoritySha256: "a".repeat(64),
    allowedOrigins: ["https://x.com"],
    port: 19882,
    approval: "approved",
    effectful: false,
    currentStage: input.step_id,
  };
  return { artifactRoot, input, flow, calls, adapter, environment, kernel, spec };
}

test("Goal ensure starts once, then resumes the same lease/session/profile/port", async () => {
  const f = fixture();
  const first = await ensureBrowserUseGoalFlow({ kernel: f.kernel, spec: f.spec });
  assert.equal(first.reused, false);
  assert.equal(f.calls.start, 1);
  assert.equal(f.calls.writeLease, 1);
  checkpointBrowserUseGoal({
    kernel: f.kernel,
    currentStage: "research-stage-2",
    lastReadback: { origin: "https://x.com", title_length: 12, state_length: 240 },
    nextAction: "reuse_goal_flow_for_next_stage",
  });
  const second = await ensureBrowserUseGoalFlow({ kernel: f.kernel, spec: { ...f.spec, currentStage: "research-stage-2" } });
  assert.equal(second.reused, true);
  assert.equal(second.resumed, true);
  assert.equal(f.calls.start, 1);
  assert.equal(f.calls.resume, 1);
  assert.equal(second.flow.session, "goal-session-effective");
  assert.equal(second.flow.profile, f.flow.profile);
  assert.equal(second.flow.port, 19882);
  assert.equal(readBrowserUseGoalState({ kernel: f.kernel }).current_stage, "research-stage-2");
  const completed = await finalizeBrowserUseGoalFlow({ kernel: f.kernel, authorityPath: f.spec.authorityPath });
  assert.equal(completed.status, "completed");
  assert.equal(completed.cleanup_verified, true);
  assert.equal(f.calls.finalize, 1);
});
test("transient recovery leaves a durable waiting checkpoint when the same lease cannot resume", async () => {
  const f = fixture();
  await ensureBrowserUseGoalFlow({ kernel: f.kernel, spec: f.spec });
  f.adapter.resumeBrowserUseCliFlowFromLease = () => {
    f.calls.resume += 1;
    throw new Error("browser_use_cli_network_timeout");
  };
  const recovered = await recoverBrowserUseGoalFlow({ kernel: f.kernel, spec: f.spec, error: new Error("network_timeout") });
  assert.equal(recovered.recovered, false);
  const state = readBrowserUseGoalState({ kernel: f.kernel });
  assert.equal(state.status, "waiting");
  assert.match(state.exact_blocker, /network_timeout/iu);
  assert.equal(state.next_action, "retry_goal_flow_from_durable_checkpoint");
  assert.equal(state.restart_point, "goal_flow_resume");
});

test("hard stops and ambiguous external effects fail close without replay", async () => {
  const f = fixture();
  await ensureBrowserUseGoalFlow({ kernel: f.kernel, spec: f.spec });
  const captcha = await recoverBrowserUseGoalFlow({ kernel: f.kernel, spec: f.spec, error: new Error("captcha_required") });
  assert.equal(captcha.terminal, true);
  assert.equal(readBrowserUseGoalState({ kernel: f.kernel }).status, "blocked");
  assert.equal(f.calls.start, 1);

  const effect = await recoverBrowserUseGoalFlow({ kernel: f.kernel, spec: f.spec, error: new Error("provider_receipt_missing"), effectUnknown: true });
  assert.equal(effect.terminal, true);
  const state = readBrowserUseGoalState({ kernel: f.kernel });
  assert.equal(state.effect_unknown, true);
  assert.equal(state.next_action, "wait_for_provider_source_readback_without_replay");
  assert.equal(f.calls.start, 1);
});

test("the kernel has one canonical helper, runtime, and adapter root", () => {
  assert.equal(CANONICAL_BROWSER_USE_HELPER, "/Users/nichikatanaka/.local/bin/codex-browser-use");
  assert.equal(CANONICAL_BROWSER_USE_RUNTIME, "/Users/nichikatanaka/.browser-use-cli/browser-use-runtime.toml");
  assert.equal(CANONICAL_BROWSER_USE_ADAPTER, "/Users/nichikatanaka/.codex/skills/automation-kernel-run/scripts/browser-use-cli-stage-adapter.mjs");
  assert.equal(BROWSER_USE_GOAL_KERNEL_SCHEMA, "automation_os_browser_use_goal_kernel.v1");
});

import { createHash } from "node:crypto";
import fs from "node:fs";

const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
const SOURCE_STATE_DIGEST = sha256("fixture-source-state");

function advance(flow, amount = 1) {
  return {
    ...flow,
    contract: {
      ...flow.contract,
      action_sequence: Number(flow.contract?.action_sequence || 0) + amount,
    },
  };
}

function candidate(targetText, present) {
  return {
    match_text_sha256: sha256(targetText),
    match_status: present ? "present" : "not_found",
    backend_present: present,
  };
}

export async function startBrowserUseCliFlow(input) {
  return {
    run_id: input.runId,
    automation_id: input.automationId,
    lifecycle: input.lifecycle,
    session: input.session,
    profile: "/fixture/browser-use-profile",
    port: input.port,
    flow_id: "fixture-browser-use-flow",
    lease_id: "fixture-browser-use-lease",
    descriptor_path: "/fixture/browser-use-descriptor.json",
    recording_dir: "/fixture/browser-use-recording",
    fixture_deleted: false,
    contract: {
      action_sequence: 0,
      step_id: input.stageId,
      flow_id: "fixture-browser-use-flow",
      lease_id: "fixture-browser-use-lease",
      requested_session: input.session,
      effective_session: input.session,
    },
  };
}

export function writeBrowserUseCliFlowLease({ flow, leasePath }) {
  fs.writeFileSync(leasePath, `${JSON.stringify({ schema: "browser-use-flow-lease.v2", status: "held" })}\n`, { mode: 0o600 });
  fs.chmodSync(leasePath, 0o600);
  return { lease_id: flow.lease_id, lease_path: leasePath };
}

export function resumeBrowserUseCliFlowFromLease() {
  return {
    run_id: "fixture-run",
    automation_id: "fixture-web",
    lifecycle: "scheduled",
    session: "fixture-session",
    profile: "/fixture/browser-use-profile",
    port: 19885,
    descriptor_path: "/fixture/browser-use-descriptor.json",
    recording_dir: "/fixture/browser-use-recording",
    contract: {
      action_sequence: 0,
      step_id: "aos-fixture-web-daily-ai-research-publish-run-goal",
      requested_session: "fixture-session",
      effective_session: "fixture-session",
    },
  };
}

export async function runBrowserUseCliFlowCommand({ flow }) {
  return advance(flow);
}

export async function runBrowserUseCliFlowTargetClick({ flow, targetText }) {
  const deleted = flow.fixture_deleted === true || targetText === "Delete";
  if (process.env.AUTOMATION_OS_WEB_OPERATION_FIXTURE_FAIL_AFTER_EFFECT === "1") throw new Error("fixture_effect_transport_unknown");
  return {
    ...advance(flow),
    fixture_deleted: deleted,
    target_result: {
      candidate: candidate(targetText, true),
      before_state: { state_sha256: SOURCE_STATE_DIGEST },
    },
  };
}

export async function runBrowserUseCliFlowTargetInspect({ flow, targetText }) {
  const present = !(flow.fixture_deleted === true && targetText === "Existing record");
  return {
    ...advance(flow),
    target_result: {
      candidate: candidate(targetText, present),
      before_state: { state_sha256: SOURCE_STATE_DIGEST },
    },
    command_completed: true,
  };
}

export async function runBrowserUseCliFlowReadOnlyBatch({ flow, commands = [] }) {
  return advance(flow, commands.length || 1);
}

export async function finalizeBrowserUseCliFlow({ flow }) {
  return {
    ...flow,
    finalized: true,
    receipt_path: "/fixture/browser-use-receipt.json",
    manifest_path: "/fixture/browser-use-manifest.json",
  };
}

export async function finalizeBrowserUseCliFlowLease() {
  return {
    finalized: true,
    cleanup_verified: true,
    receipt_path: "/fixture/browser-use-receipt.json",
    manifest_path: "/fixture/browser-use-manifest.json",
  };
}

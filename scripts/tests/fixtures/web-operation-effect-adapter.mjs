import { createHash } from "node:crypto";

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
    session: input.session,
    profile: "/fixture/browser-use-profile",
    port: input.port,
    fixture_deleted: false,
    contract: {
      action_sequence: 0,
      requested_session: input.session,
      effective_session: input.session,
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

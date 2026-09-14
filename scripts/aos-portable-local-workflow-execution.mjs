import { spawn } from "node:child_process";
import path from "node:path";

const rootPath = path.resolve(process.env.AUTOMATION_OS_REPO_ROOT || path.join(import.meta.dirname, ".."));
const localWorkflowIds = new Set(["daily-backup-safety-check", "obsidian-project-memory-audit", "nisenprints-existing-product-audit", "daily-ai-research-source-sync"]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Shortens to the issued claim/effect deadline; never renews authority. */
export function portableLocalExecutionDeadline(claim, now = Date.now()) {
  const lease = Date.parse(claim.lease_expires_at);
  const authority = claim.effect_authority ?? claim.portable_effect_authority;
  const effectDeadline = claim.execution_mode === "business_effect" ? Date.parse(authority?.expires_at) : lease;
  const deadline = Math.min(lease, effectDeadline) - 15_000;
  if (!Number.isFinite(deadline) || deadline <= now) throw new Error("portable_local_claim_deadline_expired");
  return deadline;
}

export async function runPortableLocalWorkflowOffThread(claim, input, { root = rootPath, env = process.env, timeoutMs = Infinity } = {}) {
  if (!localWorkflowIds.has(claim.workflow_id) || input.workflowId !== claim.workflow_id || input.runId !== claim.run_id) {
    throw new Error("portable_local_child_binding_invalid");
  }
  const deadline = portableLocalExecutionDeadline(claim);
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "aos-portable-local-workflow-child.mjs")], {
    cwd: root, env: { ...env, AUTOMATION_OS_REPO_ROOT: root },
    detached: process.platform !== "win32", stdio: ["pipe", "ignore", "pipe", "ipc"]
  });
  let response = null;
  let timedOut = false;
  let spawnFailed = false;
  const groupAlive = () => {
    if (!child.pid) return false;
    try { process.kill(process.platform === "win32" ? child.pid : -child.pid, 0); return true; }
    catch (error) { return error.code !== "ESRCH"; }
  };
  const signalGroup = (signal) => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch { /* only this directly spawned child's group is ever signalled */ }
  };
  child.stderr.on("data", () => {}); // Raw adapter errors may contain private paths.
  child.on("message", (value) => {
    if (!response && value?.schema === "aos.portable_local_child_result.v1"
      && value.run_id === claim.run_id && value.workflow_id === claim.workflow_id) response = value;
  });
  child.stdin.on("error", () => {});
  const result = await new Promise((resolve) => {
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), 1_000);
    }, Math.max(1, Math.min(deadline - Date.now(), timeoutMs)));
    child.once("error", () => { spawnFailed = true; });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ code, signal });
    });
    child.stdin.end(JSON.stringify({ schema: "aos.portable_local_child_request.v1", execution_mode: claim.execution_mode, deadline_ms: deadline, input }));
  });
  if (groupAlive()) {
    signalGroup("SIGTERM");
    for (let attempt = 0; attempt < 20 && groupAlive(); attempt += 1) await sleep(50);
    if (groupAlive()) signalGroup("SIGKILL");
    for (let attempt = 0; attempt < 20 && groupAlive(); attempt += 1) await sleep(50);
  }
  const cleanupVerified = !groupAlive();
  const receipt = response?.receipt;
  if (!timedOut && result.code === 0 && receipt?.workflow_id === claim.workflow_id
    && ["complete", "partial", "blocked"].includes(receipt.status) && typeof receipt.external_action_executed === "boolean") {
    return { ...receipt, cleanup_verified: receipt.cleanup_verified === true && cleanupVerified };
  }
  const business = claim.execution_mode === "business_effect";
  const knownNoExecution = spawnFailed || response?.execution_started === false;
  const externalAction = receipt?.external_action_executed === true ? true : business && !knownNoExecution ? null : false;
  return {
    status: "blocked", exact_blocker: timedOut ? "portable_local_child_deadline_exceeded" : response?.exact_blocker ?? "portable_local_child_receipt_missing",
    workflow_id: claim.workflow_id, external_action_executed: externalAction,
    read_only_stage_bound: !business, readback_verified: false, cleanup_verified: cleanupVerified,
    business_completion_verified: false, same_run_receipt: false, same_run_source_sync: false,
    adapter_result: { child_exit_code: result.code, child_signal: result.signal, timed_out: timedOut,
      operation_effect_state: externalAction === false ? "none" : "unknown", reconciliation_required: externalAction !== false, no_replay: true },
    runner_receipt: { business_proofs: {} }
  };
}

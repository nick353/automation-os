#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readPortableBusinessActionPlan } from "./portable-business-action-plan.mjs";
import { classifyChromePluginFailure } from "./chrome-plugin-failure-boundary.mjs";
import {
  CHROME_OPERATION_V1_ID,
  chromeOperationV1Descriptor,
  normalizeChromeOperationV1Payload,
} from "/Users/nichikatanaka/.codex/skills/chrome-plugin-stability/scripts/chrome_operation_v1.mjs";

const PROJECT_ROOT = "/Users/nichikatanaka/Documents/New project";
const BRIDGE_CLIENT = path.join(PROJECT_ROOT, "scripts", "browser_use", "chrome_extension_trusted_bridge_client.mjs");
const LEDGER_PYTHON = path.join(PROJECT_ROOT, ".venv", "bin", "python");
const LEDGER_SCRIPT = path.join(PROJECT_ROOT, "scripts", "job_applications", "opportunity_ledger_browser_submit.py");
const DEFAULT_LEDGER = path.join(PROJECT_ROOT, "artifacts", "shared", "opportunity-status-ledger.jsonl");
const ID = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,179}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const BUNDLE_SCHEMA = "automation_os_portable_workflow_input_bundle.v1";
const SURFACE = "signed_chrome_extension_profile2";
// The controller may issue an authority on Zeabur while this Mac worker
// validates it on a slightly skewed clock.  Keep the allowance bounded: a
// materially future-dated authority remains fail-closed.
const MAX_AUTHORITY_CLOCK_SKEW_MS = 30_000;

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function targetDigest(bundle) {
  const keys = [
    "account_ref", "target_key", "payload_hash", "content_key", "product_key", "asset_manifest_id",
    "job_url", "job_id", "application_url", "candidate_key", "bucket", "sequence", "attempt",
    "source_snapshot_id", "source_snapshot_expires_at", "supply_run_id", "company", "role", "audience",
    "resume_locale", "resume_sha256", "owner_ref", "authority_ref", "input_bundle_ref", "target_digest", "source_state_digest",
  ];
  return digest(JSON.stringify(Object.fromEntries(keys.filter((key) => key in bundle).map((key) => [key, bundle[key]]))));
}

function validateEffectAuthorityBinding(authority, input, bundleBytes, bundle) {
  const now = Date.now();
  const issuedAt = Date.parse(String(authority?.issued_at || ""));
  const expiresAt = Date.parse(String(authority?.expires_at || ""));
  const expectedId = `portable-effect-${digest([
    authority?.company_id, authority?.workflow_id, authority?.run_id, authority?.step_id,
    authority?.effect_stage, authority?.approval_id, authority?.idempotency_key,
    authority?.target_digest, authority?.input_bundle_sha256,
  ].join("\u001f")).slice(0, 32)}`;
  if (authority?.schema !== "automation_os_portable_external_effect_authority.v1"
    || authority?.issued_by !== "automation_os_portable_controller"
    || authority?.effect_class !== "external_non_idempotent"
    || authority?.browser_surface !== SURFACE
    || authority?.approval_status !== "approved"
    || authority?.external_action_authorized !== true
    || authority?.first_class_root_required !== false
    || authority?.app_dependency !== false
    || authority?.reconciliation_required !== true
    || authority?.reconciliation_owner !== "automation_os_portable_controller"
    || authority?.no_auto_retry !== true
    || !Number.isSafeInteger(authority?.timeout_ms) || Number(authority.timeout_ms) <= 0
    || !Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now + MAX_AUTHORITY_CLOCK_SKEW_MS || expiresAt <= now
    || authority?.authority_id !== expectedId
    || authority?.workflow_id !== input.workflow_id
    || authority?.run_id !== input.run_id
    || authority?.step_id !== input.step_id
    || authority?.idempotency_key !== input.idempotency_key
    || digest(bundleBytes) !== authority?.input_bundle_sha256
    || targetDigest(bundle) !== authority?.target_digest) {
    throw new Error("job_chrome_plugin_effect_authority_binding_invalid");
  }
}

function readEffectAuthority(input) {
  const rawPath = String(process.env.AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH || "").trim();
  const expected = String(process.env.AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256 || "");
  if (!rawPath || !path.isAbsolute(rawPath) || !fs.existsSync(rawPath) || !HASH.test(expected)) throw new Error("job_chrome_plugin_effect_authority_missing");
  const file = path.resolve(rawPath);
  let stat;
  let bytes;
  let authority;
  try {
    stat = fs.lstatSync(file);
    bytes = fs.readFileSync(file);
    authority = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("job_chrome_plugin_effect_authority_binding_invalid");
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
    || digest(bytes) !== expected
    || authority.workflow_id !== input.workflow_id
    || authority.run_id !== input.run_id
    || authority.step_id !== input.step_id
    || authority.approval_status !== "approved"
    || authority.external_action_authorized !== true
    || !HASH.test(String(authority.target_digest || ""))
    || !HASH.test(String(authority.payload_hash || ""))) {
    throw new Error("job_chrome_plugin_effect_authority_binding_invalid");
  }
  return { authority, sha256: expected, bytes };
}

function parseArgs(argv) {
  const value = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = String(argv[i] || "").replace(/^--/u, "").replaceAll("-", "_");
    if (!key || !argv[i + 1] || String(argv[i + 1]).startsWith("--")) throw new Error("job_chrome_plugin_argument_invalid");
    value[key] = String(argv[i + 1]);
  }
  for (const key of ["workflow_id", "run_id", "step_id", "source_trigger", "idempotency_key"]) {
    if (!ID.test(String(value[key] || ""))) throw new Error(`job_chrome_plugin_${key}_invalid`);
  }
  return value;
}

function runRoot(runId) {
  const root = path.resolve(process.env.AUTOMATION_OS_ARTIFACT_ROOT || path.join(process.cwd(), "data", "artifacts"));
  const resolved = path.resolve(root, runId);
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) throw new Error("job_chrome_plugin_artifact_root_invalid");
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  return resolved;
}

function lastJson(stdout) {
  for (const line of String(stdout || "").split(/\r?\n/u).map((x) => x.trim()).filter(Boolean).reverse()) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch { /* bridge diagnostics are ignored; the JSON contract is authoritative */ }
  }
  return null;
}

function readBundle(input) {
  const rawPath = String(process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_INPUT_BUNDLE_PATH || "").trim();
  if (!rawPath) throw new Error("job_chrome_plugin_input_bundle_missing");
  const requested = path.resolve(rawPath);
  const bytes = fs.readFileSync(requested);
  const value = JSON.parse(bytes.toString("utf8"));
  if (value?.schema !== BUNDLE_SCHEMA || value.workflow_id !== input.workflow_id || value.run_id !== input.run_id || !value.input || typeof value.input !== "object") {
    throw new Error("job_chrome_plugin_input_bundle_invalid");
  }
  const bundle = value.input;
  for (const key of ["job_url", "candidate_key", "bucket", "sequence", "attempt", "source_snapshot_id", "supply_run_id"]) {
    if (bundle[key] === undefined || bundle[key] === null || String(bundle[key]).trim() === "") throw new Error(`job_chrome_plugin_candidate_binding_missing:${key}`);
  }
  // Target admission uses zero-based candidate sequencing for the first
  // supplied opportunity. Keep the business runner aligned with that
  // contract; attempt remains one-based.
  if (!Number.isSafeInteger(Number(bundle.sequence)) || Number(bundle.sequence) < 0 || !Number.isSafeInteger(Number(bundle.attempt)) || Number(bundle.attempt) < 1) {
    throw new Error("job_chrome_plugin_candidate_binding_invalid");
  }
  return { path: requested, sha256: digest(bytes), bytes, input: bundle };
}

function ledger(input, bundle, operation, claimId, runDir) {
  const ledgerPath = String(process.env.AUTOMATION_OS_OPPORTUNITY_LEDGER_PATH || DEFAULT_LEDGER);
  const args = [
    LEDGER_SCRIPT, "--operation", operation, "--ledger-path", ledgerPath,
    "--opportunity-key", String(bundle.candidate_key), "--claim-id", claimId,
    "--company", String(bundle.company || ""), "--role", String(bundle.role || ""),
    "--source-url", String(bundle.job_url || ""), "--source-snapshot-id", String(bundle.source_snapshot_id || ""),
    ...(operation === "reconcile_not_submitted" ? ["--reconciliation-basis", "authoritative_readback_not_submitted"] : []),
  ];
  const child = spawnSync(LEDGER_PYTHON, args, { cwd: path.dirname(LEDGER_SCRIPT), env: { ...process.env, PYTHONNOUSERSITE: "1" }, encoding: "utf8", timeout: 120_000, maxBuffer: 256 * 1024 });
  const readback = lastJson(child.stdout);
  const artifactPath = path.join(runDir, `opportunity-ledger-${operation}.json`);
  fs.writeFileSync(artifactPath, JSON.stringify({ schema: "job_chrome_plugin_ledger_readback.v1", run_id: input.run_id, operation, readback }, null, 2), { mode: 0o600 });
  if (!readback || child.error || child.status !== 0 || readback.status === "blocked") {
    return { status: "blocked", exact_blocker: String(readback?.exact_blocker || `job_chrome_plugin_ledger_${operation}_failed`), artifact_path: artifactPath };
  }
  return { ...readback, status: operation === "claim" ? "claimed" : operation === "finalize" ? "submitted_confirmed" : String(readback.status || "reconciled"), artifact_path: artifactPath };
}

function outcomeFromBridge(result, bundle) {
  const outcomes = [
    ...(Array.isArray(result?.outcomes) ? result.outcomes : []),
    ...(Array.isArray(result?.result?.outcomes) ? result.result.outcomes : []),
  ];
  const matching = outcomes.find((item) => {
    const row = item?.pipelineRow || item?.pipeline_row || item || {};
    return String(row.key || row.job_key || row.job_id_or_canonical_key || "") === String(bundle.candidate_key);
  }) || outcomes[0] || {};
  const row = matching?.pipelineRow || matching?.pipeline_row || matching;
  const state = String(row?.state || matching?.state || "");
  const visible = row?.visible_submission_success === true || matching?.visible_submission_success === true;
  const actionCount = Number(row?.action_count ?? matching?.action_count ?? row?.external_action_count ?? matching?.external_action_count ?? 0);
  const receiptId = String(row?.receipt_id || matching?.receipt_id || result?.bridge_receipt_path || "");
  const syncOk = Boolean(row?.sync_readback_proof || matching?.sync_readback_proof) && Boolean(row?.readback_proof || matching?.readback_proof);
  return { state, visible_submission_success: visible, external_action_count: Number.isFinite(actionCount) ? actionCount : 0, receipt_id: receiptId, sync_ok: syncOk, artifact_uri: String(row?.artifact_uri || matching?.artifact_uri || result?.bridge_receipt_path || ""), raw: matching };
}

function output(value, code = 1) {
  process.stdout.write(`${JSON.stringify({
    chrome_operation: value.chrome_operation || chromeOperationV1Descriptor(),
    status: value.status || "blocked",
    exact_blocker: value.exact_blocker || null,
    external_action_executed: value.external_action_executed === true,
    browser_surface: SURFACE,
    same_run_receipt: value.same_run_receipt === true,
    cleanup_verified: value.cleanup_verified === true,
    llm_provider_neutral: true,
    app_dependency: false,
    ...(value.run_id ? { run_id: value.run_id } : {}),
    ...(value.step_id ? { step_id: value.step_id } : {}),
    ...(value.input_bundle_sha256 ? { input_bundle_sha256: value.input_bundle_sha256 } : {}),
    ...(value.action_plan_sha256 ? { action_plan_sha256: value.action_plan_sha256 } : {}),
    ...(value.adapter_result ? { adapter_result: value.adapter_result } : {}),
    ...(value.web_operation_lifecycle ? { web_operation_lifecycle: value.web_operation_lifecycle } : {}),
  })}\n`);
  return code;
}

/**
 * The trusted bridge client consumes stdin with `for await`, so the parent
 * must close the pipe after writing the request. `spawnSync({ input })` keeps
 * the synchronous parent blocked while the child waits for that EOF on some
 * macOS Node versions. Use an async child and an explicit end instead.
 */
function runBridgeClient(mode, payload, environment) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE_CLIENT, mode], {
      cwd: PROJECT_ROOT,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-4 * 1024 * 1024); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-256 * 1024); });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ...value, stdout, stderr });
    };
    const timeout = setTimeout(() => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch { /* the child may have exited at the deadline */ }
      finish({ error: new Error("job_chrome_plugin_bridge_client_timeout"), status: null, signal: "SIGTERM" });
    }, 20 * 60 * 1000);
    child.once("error", (error) => finish({ error, status: null, signal: null }));
    child.once("close", (status, signal) => finish({ error: null, status, signal }));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function main(argv = process.argv.slice(2)) {
  let input;
  let claimed = false;
  let browserActionStarted = false;
  let adapter = null;
  try {
    input = parseArgs(argv);
    if (input.workflow_id !== "job-application-manager") return output({ exact_blocker: "job_chrome_plugin_workflow_invalid", run_id: input.run_id, step_id: input.step_id });
    if (String(process.env.AOS_WEB_OPERATION_BACKEND || "") !== "chrome_plugin") return output({ exact_blocker: "web_operation_backend_surface_conflict:chrome_plugin_required", run_id: input.run_id, step_id: input.step_id });
    const bundle = readBundle(input);
    const runDir = runRoot(input.run_id);
    const authority = readEffectAuthority(input);
    validateEffectAuthorityBinding(authority.authority, input, bundle.bytes, bundle.input);
    const actionPlan = readPortableBusinessActionPlan({ workflowId: input.workflow_id, runId: input.run_id, stepId: input.step_id, sourceTrigger: input.source_trigger, idempotencyKey: input.idempotency_key, inputBundlePath: bundle.path });
    const claimId = `${input.run_id}:${bundle.input.bucket}:${bundle.input.candidate_key}`;
    const claim = ledger(input, bundle.input, "claim", claimId, runDir);
    if (claim.status !== "claimed") return output({ exact_blocker: claim.exact_blocker, run_id: input.run_id, step_id: input.step_id, input_bundle_sha256: bundle.sha256, action_plan_sha256: actionPlan.sha256, adapter_result: { ledger_claim: claim } });
    claimed = true;
    const outcomesJsonl = path.join(runDir, "submission", "outcomes.jsonl");
    fs.mkdirSync(path.dirname(outcomesJsonl), { recursive: true, mode: 0o700 });
    const jobUrl = String(bundle.input.job_url || bundle.input.application_url || "");
    const mode = /linkedin\.com\/jobs\//iu.test(jobUrl) ? "job" : "official-job";
    const payload = normalizeChromeOperationV1Payload({
      runId: input.run_id,
      schedulerRunId: input.run_id,
      scheduler_run_id: input.run_id,
      bridgeRunId: `${input.run_id}:${bundle.input.candidate_key}:attempt:${bundle.input.attempt}`,
      artifactDir: runDir,
      outcomesJsonl,
      company: String(bundle.input.company || ""),
      role: String(bundle.input.role || "Job application"),
      jobUrl,
      applicationUrl: String(bundle.input.application_url || jobUrl),
      jobKey: String(bundle.input.candidate_key),
      key: String(bundle.input.candidate_key),
      bucket: String(bundle.input.bucket),
      targetBucket: String(bundle.input.bucket),
      supplyRunId: String(bundle.input.supply_run_id),
      supply_run_id: String(bundle.input.supply_run_id),
      sequence: Number(bundle.input.sequence),
      attempt: Number(bundle.input.attempt),
      sourceSnapshotId: String(bundle.input.source_snapshot_id),
      source_snapshot_id: String(bundle.input.source_snapshot_id),
      receiptId: `${input.run_id}:${bundle.input.candidate_key}:attempt:${bundle.input.attempt}`,
      phone: String(bundle.input.phone || ""),
      accountRef: String(bundle.input.account_ref || ""),
      account_ref: String(bundle.input.account_ref || ""),
      autoSubmitFinal: true,
      // Keep ordinary official ATS applications on the historical successful
      // path: openTabs() -> claimTab() -> the same claimed handle.  The
      // target-scoped lane remains available for explicitly separate callers;
      // it must not replace this initial Profile 2 route.
      targetScopedAction: false,
      target_scoped_action: false,
      read_only: false,
      maxCandidatesPerBrowserChunk: 1,
      maxSelectedTotal: 1,
      targetReadyOrSubmitted: 1,
      applicationChannel: mode === "job" ? "LinkedIn Easy Apply" : "official_trusted_bridge",
      browserBackend: "chrome_plugin",
      browser_backend: "chrome_plugin",
      browserSurface: SURFACE,
      browser_surface: SURFACE,
      // Match the initial successful Chrome Plugin path: the trusted
      // foreground runtime does one fresh Profile 2 setup and hands the same
      // handle directly to the official ATS adapter. Recovery/retry is an
      // explicit exception, not part of every ordinary candidate attempt.
      chromePluginInitialPath: true,
      chrome_plugin_initial_path: true,
      chromeOperationId: CHROME_OPERATION_V1_ID,
      session_id: String(process.env.CODEX_SESSION_ID || ""),
      thread_id: String(process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || ""),
      turn_id: String(process.env.CODEX_TURN_ID || ""),
    });
    const bridge = await runBridgeClient(mode, payload, {
      ...process.env,
      AOS_WEB_OPERATION_BACKEND: "chrome_plugin",
      AUTOMATION_OS_BROWSER_SURFACE: SURFACE,
    });
    const result = lastJson(bridge.stdout);
    const bridgeFailureDetail = String(
      result?.exact_blocker ||
      result?.stop_reason ||
      bridge.error?.message ||
      bridge.stderr ||
      "",
    ).trim().replace(/\s+/gu, " ").slice(0, 240);
    adapter = outcomeFromBridge(result, bundle.input);
    browserActionStarted = adapter.external_action_count > 0 || adapter.state === "submitted_confirmed";
    const submitted = adapter.state === "submitted_confirmed" && adapter.visible_submission_success === true;
    const syncOk = submitted && adapter.sync_ok;
    if (submitted && syncOk) {
      const finalized = ledger(input, bundle.input, "finalize", claimId, runDir);
      if (finalized.status !== "submitted_confirmed") return output({ exact_blocker: `job_chrome_plugin_ledger_finalize_failed:${finalized.exact_blocker || "unknown"}`, external_action_executed: true, same_run_receipt: Boolean(adapter.receipt_id), cleanup_verified: true, run_id: input.run_id, step_id: input.step_id, input_bundle_sha256: bundle.sha256, action_plan_sha256: actionPlan.sha256, adapter_result: { ...adapter, ledger_finalize: finalized } });
    } else if (!browserActionStarted && claimed) {
      const reconciliation = ledger(input, bundle.input, "reconcile_not_submitted", `${claimId}:reconcile`, runDir);
      if (reconciliation.status !== "discovered") return output({ exact_blocker: reconciliation.exact_blocker, run_id: input.run_id, step_id: input.step_id, input_bundle_sha256: bundle.sha256, action_plan_sha256: actionPlan.sha256, adapter_result: { ...adapter, ledger_reconciliation: reconciliation } });
    }
    const exactBlocker = submitted && !syncOk
      ? "job_chrome_plugin_source_of_truth_readback_required"
      : classifyChromePluginFailure({
        exact_blocker: adapter.raw?.blocker_reason || result?.exact_blocker || "",
        message: bridgeFailureDetail || "job_chrome_plugin_submit_not_confirmed",
      }).exact_blocker;
    const failureBoundary = classifyChromePluginFailure({
      exact_blocker: adapter.raw?.blocker_reason || result?.exact_blocker || "",
      message: bridgeFailureDetail || "",
    });
    const cleanupVerified = bridge.error ? false : true;
    const sameRunReceipt = Boolean(adapter.receipt_id);
    const sourceStateDigest = fs.existsSync(path.join(runDir, "opportunity-ledger-finalize.json"))
      ? digest(fs.readFileSync(path.join(runDir, "opportunity-ledger-finalize.json")))
      : digest(JSON.stringify({ adapter, claimId }));
    const complete = submitted && syncOk && cleanupVerified && sameRunReceipt;
    const lifecycle = {
      schema: "automation_os_web_operation_lifecycle.v1",
      state: complete ? "cleaned" : browserActionStarted ? "effect_unknown" : "blocked",
      status: complete ? "complete" : "blocked",
      exact_blocker: complete ? null : exactBlocker,
      run_id: input.run_id,
      step_id: input.step_id,
      idempotency_key: input.idempotency_key,
      operation: "submit",
      target_digest: authority.authority.target_digest,
      payload_hash: authority.authority.payload_hash,
      source_state_digest: sourceStateDigest,
      dispatch_state: browserActionStarted ? "executed" : "not_started",
      dispatch_attempted: browserActionStarted,
      external_action_executed: browserActionStarted,
      same_run_receipt: sameRunReceipt,
      readback_verified: syncOk,
      cleanup_verified: cleanupVerified,
      no_replay: true,
    };
    return output({ status: complete ? "complete" : "blocked", exact_blocker: complete ? null : exactBlocker, external_action_executed: browserActionStarted, same_run_receipt: sameRunReceipt, cleanup_verified: cleanupVerified, run_id: input.run_id, step_id: input.step_id, input_bundle_sha256: bundle.sha256, action_plan_sha256: actionPlan.sha256, adapter_result: { ...adapter, ledger_finalized: complete, bridge_failure_detail: bridgeFailureDetail || undefined, failure_boundary: complete ? null : failureBoundary }, web_operation_lifecycle: lifecycle }, complete ? 0 : 1);
  } catch (error) {
    const failureBoundary = classifyChromePluginFailure(error);
    const message = failureBoundary.exact_blocker;
    if (claimed && !browserActionStarted && input) {
      try { ledger(input, readBundle(input).input, "reconcile_not_submitted", `${input.run_id}:reconcile`, runRoot(input.run_id)); } catch { /* preserve the primary blocker */ }
    }
    return output({ exact_blocker: message, external_action_executed: browserActionStarted, run_id: input?.run_id, step_id: input?.step_id, adapter_result: { ...adapter, failure_boundary: failureBoundary } });
  }
}

main().then((code) => { process.exitCode = code; });

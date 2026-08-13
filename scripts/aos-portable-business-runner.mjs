#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readPortableBusinessActionPlan } from "./portable-business-action-plan.mjs";
import { cleanupOwnedProcessGroup } from "./process-group-cleanup.mjs";

const PLANS = Object.freeze({
  "job-application-manager": { key: "JOB_APPLICATION", proof: ["submitted_confirmed", "same_run_source_of_truth_readback", "cleanup_receipt"] },
  "daily-ai-research-publish-run": { key: "DAILY_AI", proof: ["publish_url_or_exact_blocker", "feed_study_or_exact_blocker", "engagement_or_no_candidate_proof", "queue_sync", "cleanup_receipt"] },
  "nisenprints-daily-product-canva-printify-etsy-pinterest": { key: "NISENPRINTS", proof: ["generation_manifest", "etsy_listing", "pinterest_pin_url", "etsy_visit_site_match", "cleanup_receipt"] },
});
const ID = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,179}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const BLOCKERS = Object.freeze({
  disabled: "portable_external_effects_disabled",
  approval: "portable_external_approval_required",
  plan: "portable_external_business_plan_invalid",
  runner: "portable_external_business_runner_not_configured",
  invalidRunner: "portable_external_business_runner_invalid",
  forbiddenSurface: "portable_external_business_runner_forbidden_browser_surface",
  receipt: "portable_external_business_receipt_invalid",
  timeout: "portable_external_business_runner_timeout",
  actionPlan: "portable_external_action_plan_required",
  lifecycle: "portable_external_business_lifecycle_proof_missing",
  processGroupCleanup: "portable_external_process_group_cleanup_unverified",
});

const FORBIDDEN_BROWSER_SURFACE_RE = /(?:playwright|chrome[_-]?extension|chrome[_-]?plugin|in[_-]?app[_-]?browser|direct[_-]?cdp|\bcdp\b|codex\s+exec)/iu;
const CANONICAL_BROWSER_USE_CLI_MARKER_RE = /browser[_-]?use[_-]?cli|stage[_-]?adapter|codex-browser-use/iu;
const AOS_SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function aosRoot(environment = process.env) {
  return path.resolve(String(environment.AUTOMATION_OS_REPO_ROOT || AOS_SOURCE_ROOT));
}

function canonicalRunnerPath(workflowId, environment = process.env) {
  const root = aosRoot(environment);
  if (workflowId === "daily-ai-research-publish-run") return path.join(root, "scripts", "aos-daily-ai-business-runner.mjs");
  if (workflowId === "nisenprints-daily-product-canva-printify-etsy-pinterest") return path.join(root, "scripts", "aos-nisenprints-business-runner.mjs");
  return "";
}

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function output(value, code = 1) {
  process.stdout.write(`${JSON.stringify({
    status: value.status || "blocked",
    exact_blocker: value.exact_blocker || null,
    external_action_executed: value.external_action_executed === true,
    browser_surface: "browser_use_cli",
    llm_provider_neutral: true,
    app_dependency: false,
    ...(value.workflow_id ? { workflow_id: value.workflow_id } : {}),
    ...(value.run_id ? { run_id: value.run_id } : {}),
    ...(value.step_id ? { step_id: value.step_id } : {}),
    ...(value.binding_readback ? { binding_readback: value.binding_readback } : {}),
    ...(value.runner_receipt ? { runner_receipt: value.runner_receipt } : {}),
    ...(value.web_operation_lifecycle ? { web_operation_lifecycle: value.web_operation_lifecycle } : {}),
    ...(value.web_operation_contract ? { web_operation_contract: value.web_operation_contract } : {}),
  })}\n`);
  return code;
}
function args(argv) {
  const value = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = String(argv[index] || "").replace(/^--/u, "").replaceAll("-", "_");
    if (!key || !argv[index + 1] || String(argv[index + 1]).startsWith("--")) throw new Error("portable_external_business_argument_invalid");
    value[key] = String(argv[index + 1]);
    index += 1;
  }
  for (const key of ["workflow_id", "run_id", "step_id", "source_trigger", "idempotency_key"]) if (!ID.test(String(value[key] || ""))) throw new Error(`portable_external_business_${key}_invalid`);
  return value;
}
function readAdmission(input) {
  const file = path.resolve(String(process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_PATH || ""));
  const expected = String(process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_SHA256 || "");
  if (!file || !fs.existsSync(file) || !/^[a-f0-9]{64}$/u.test(expected)) throw new Error("portable_external_business_admission_invalid");
  const bytes = fs.readFileSync(file);
  const value = JSON.parse(bytes.toString("utf8"));
  if (digest(bytes) !== expected || value.workflow_id !== input.workflow_id || value.run_id !== input.run_id || value.step_id !== input.step_id || value.audience !== "portable_external_runner" || value.approval_status !== "approved" || value.browser_surface !== "browser_use_cli") throw new Error("portable_external_business_admission_invalid");
  if (Date.parse(String(value.expires_at || "")) <= Date.now()) throw new Error("portable_external_business_admission_expired");
  // Business effects are never admitted by the generic approval envelope
  // alone.  The AOS portable controller must issue and bind the effect
  // authority for every effects-enabled invocation; the environment flag is
  // retained only as a compatibility signal from the Mac worker and is not a
  // bypass switch.
  const authorityRequired = true;
  let authority = null;
  if (authorityRequired) {
    const authorityPath = path.resolve(String(process.env.AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH || ""));
    const authoritySha = String(process.env.AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256 || "");
    const authorityId = String(process.env.AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_ID || "");
    if (!authorityPath || !fs.existsSync(authorityPath) || !/^[a-f0-9]{64}$/u.test(authoritySha) || !authorityId) throw new Error("portable_external_effect_authority_missing");
    const authorityBytes = fs.readFileSync(authorityPath);
    try { authority = JSON.parse(authorityBytes.toString("utf8")); } catch { throw new Error("portable_external_effect_authority_invalid"); }
    if (digest(authorityBytes) !== authoritySha
      || authority.schema !== "automation_os_portable_external_effect_authority.v1"
      || authority.issued_by !== "automation_os_portable_controller"
      || authority.authority_id !== authorityId
      || authority.company_id === undefined
      || authority.workflow_id !== input.workflow_id
      || authority.run_id !== input.run_id
      || authority.step_id !== input.step_id
      || authority.idempotency_key !== input.idempotency_key
      || authority.approval_status !== "approved"
      || authority.external_action_authorized !== true
      || authority.first_class_root_required !== false
      || !HASH.test(String(authority.target_digest || ""))
      || !HASH.test(String(authority.input_bundle_sha256 || ""))
      || !HASH.test(String(authority.payload_hash || ""))
      || authority.timeout_controller !== "automation_os_portable_controller"
      || authority.reconciliation_required !== true
      || authority.reconciliation_owner !== "automation_os_portable_controller"
      || authority.no_auto_retry !== true
      || Date.parse(String(authority.expires_at || "")) <= Date.now()) throw new Error("portable_external_effect_authority_binding_invalid");
  }
  return { path: file, sha256: expected, authority };
}
export function runnerFor(workflowId, environment = process.env) {
  const plan = PLANS[workflowId];
  if (!plan) return "";
  const configured = String(environment[`AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_${plan.key}`] || "").trim();
  if (configured) return configured;
  // A LaunchAgent may preserve the explicit project root while dropping a
  // derived workflow variable during a long-lived worker refresh. Resolve
  // only the known canonical Browser Use CLI runner from that explicit root;
  // never select an arbitrary executable or a legacy browser surface.
  if (workflowId === "job-application-manager") {
    const projectRoot = String(environment.AUTOMATION_OS_BROWSER_USE_PROJECT_ROOT || "").trim();
    if (projectRoot) return path.join(projectRoot, "scripts", "browser_use", "job_manager_browser_use_cli_business_runner.mjs");
  }
  const canonical = canonicalRunnerPath(workflowId, environment);
  if (canonical && fs.existsSync(canonical) && fs.statSync(canonical).isFile()) return canonical;
  return "";
}

export function businessRunnerBindingEnvironment(environment = process.env) {
  const result = {};
  const projectRoot = String(environment.AUTOMATION_OS_BROWSER_USE_PROJECT_ROOT || "").trim();
  const packageHelper = projectRoot
    ? path.join(projectRoot, "browser-use-cli", "bin", "codex-browser-use")
    : "";
  const jobConfigured = String(environment.AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_JOB_APPLICATION || "").trim();
  const jobDerived = projectRoot
    ? path.join(projectRoot, "scripts", "browser_use", "job_manager_browser_use_cli_business_runner.mjs")
    : "";
  const job = jobConfigured || (jobDerived && fs.existsSync(jobDerived) ? jobDerived : "");
  if (projectRoot) result.AUTOMATION_OS_BROWSER_USE_PROJECT_ROOT = projectRoot;
  if (packageHelper && fs.existsSync(packageHelper) && fs.statSync(packageHelper).isFile()) {
    // Bind this workflow to the immutable package helper when the installed
    // global entrypoint is mid-generation with another live room.  The stage
    // adapter still proves helper/package parity because both paths are the
    // same canonical source; no alternate browser surface is introduced.
    result.BROWSER_USE_CLI_HELPER = packageHelper;
  }
  if (job) result.AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_JOB_APPLICATION = job;
  for (const [workflowId, key] of [
    ["daily-ai-research-publish-run", "DAILY_AI"],
    ["nisenprints-daily-product-canva-printify-etsy-pinterest", "NISENPRINTS"],
  ]) {
    const configured = String(environment[`AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_${key}`] || "").trim();
    const canonical = canonicalRunnerPath(workflowId, environment);
    if (configured) result[`AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_${key}`] = configured;
    else if (canonical && fs.existsSync(canonical) && fs.statSync(canonical).isFile()) result[`AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_${key}`] = canonical;
  }
  return result;
}

function validateRunnerSource(command) {
  let source;
  try {
    source = fs.readFileSync(command, "utf8");
  } catch {
    return BLOCKERS.invalidRunner;
  }
  // A basename check is not enough: legacy adapters can be renamed while
  // retaining a forbidden browser surface.  Business bindings must visibly
  // route through the canonical Browser Use CLI/stage-adapter contract and
  // must not contain a retired surface or Codex execution fallback.
  if (!CANONICAL_BROWSER_USE_CLI_MARKER_RE.test(source)) return BLOCKERS.forbiddenSurface;
  if (FORBIDDEN_BROWSER_SURFACE_RE.test(source)) return BLOCKERS.forbiddenSurface;
  return null;
}
function parseLastJson(stdout) {
  for (const line of String(stdout || "").split(/\r?\n/u).map((value) => value.trim()).filter(Boolean).reverse()) {
    try { const parsed = JSON.parse(line); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed; } catch (_) { /* progress output */ }
  }
  return null;
}

function businessOperationKind(workflowId) {
  return workflowId === "job-application-manager" ? "submit" : "publish";
}

function businessSourceSyncVerified(workflowId, receipt) {
  const adapter = receipt?.adapter_result && typeof receipt.adapter_result === "object" && !Array.isArray(receipt.adapter_result)
    ? receipt.adapter_result
    : {};
  const runnerReceipt = receipt?.runner_receipt && typeof receipt.runner_receipt === "object" && !Array.isArray(receipt.runner_receipt)
    ? receipt.runner_receipt
    : {};
  if (workflowId === "job-application-manager") {
    return adapter.state === "submitted_confirmed" && adapter.sync_ok === true && adapter.ledger_finalized === true;
  }
  return runnerReceipt.same_run_source_sync === true
    && runnerReceipt.business_proofs
    && typeof runnerReceipt.business_proofs === "object";
}

function strictBusinessLifecycleProof({ input, receipt, authority, externalActionExecuted }) {
  const lifecycle = receipt?.web_operation_lifecycle && typeof receipt.web_operation_lifecycle === "object" && !Array.isArray(receipt.web_operation_lifecycle)
    ? receipt.web_operation_lifecycle
    : null;
  if (!externalActionExecuted || !lifecycle || !authority) return false;
  return lifecycle.schema === "automation_os_web_operation_lifecycle.v1"
    && lifecycle.state === "cleaned"
    && lifecycle.status === "complete"
    && lifecycle.exact_blocker === null
    && lifecycle.run_id === input.run_id
    && lifecycle.step_id === input.step_id
    && lifecycle.idempotency_key === input.idempotency_key
    && lifecycle.operation === businessOperationKind(input.workflow_id)
    && lifecycle.target_digest === authority.target_digest
    && lifecycle.payload_hash === authority.payload_hash
    && /^[a-f0-9]{64}$/u.test(String(lifecycle.source_state_digest || ""))
    && lifecycle.dispatch_state === "executed"
    && lifecycle.dispatch_attempted === true
    && lifecycle.external_action_executed === true
    && lifecycle.same_run_receipt === true
    && lifecycle.readback_verified === true
    && lifecycle.cleanup_verified === true
    && lifecycle.no_replay === true;
}

export function buildBusinessWebOperationLifecycle({ input, receipt, authority, externalActionExecuted }) {
  const sameRunReceipt = receipt?.same_run_receipt === true && receipt?.run_id === input.run_id;
  const cleanupVerified = receipt?.cleanup_verified === true;
  const sourceSyncVerified = businessSourceSyncVerified(input.workflow_id, receipt);
  const lifecycleProofVerified = strictBusinessLifecycleProof({ input, receipt, authority, externalActionExecuted });
  const complete = externalActionExecuted
    && sameRunReceipt
    && cleanupVerified
    && sourceSyncVerified
    && lifecycleProofVerified
    && receipt?.status === "complete"
    && !receipt?.exact_blocker;
  const exactBlocker = complete
    ? null
    : externalActionExecuted
      ? (!lifecycleProofVerified
        ? BLOCKERS.lifecycle
        : sourceSyncVerified && sameRunReceipt && cleanupVerified
        ? String(receipt?.exact_blocker || "portable_external_business_runner_completion_invalid")
        : "portable_external_business_receipt_reconciliation_required")
      : String(receipt?.exact_blocker || "portable_external_business_effect_not_confirmed");
  return {
    schema: "automation_os_web_operation_lifecycle.v1",
    state: complete ? "cleaned" : externalActionExecuted ? "effect_unknown" : "blocked",
    status: complete ? "complete" : "blocked",
    exact_blocker: exactBlocker,
    restart_point: complete ? null : externalActionExecuted ? "same-run source-of-truth reconciliation; do not replay" : "fresh target-bound admission; use a new idempotency key for a new attempt",
    run_id: input.run_id,
    step_id: input.step_id,
    idempotency_key: input.idempotency_key,
    operation: businessOperationKind(input.workflow_id),
    target_digest: authority?.target_digest || null,
    payload_hash: authority?.payload_hash || null,
    source_state_digest: lifecycleProofVerified ? receipt.web_operation_lifecycle.source_state_digest : null,
    dispatch_state: lifecycleProofVerified ? receipt.web_operation_lifecycle.dispatch_state : "unknown",
    dispatch_attempted: lifecycleProofVerified,
    external_action_executed: externalActionExecuted,
    same_run_receipt: sameRunReceipt,
    readback_verified: sourceSyncVerified && sameRunReceipt,
    cleanup_verified: cleanupVerified,
    lifecycle_proof_verified: lifecycleProofVerified,
    no_replay: true,
  };
}
function runnerInvocation(command) {
  const executable = (fs.statSync(command).mode & 0o111) !== 0;
  return executable ? { bin: command, prefix: [] } : { bin: process.execPath, prefix: [command] };
}
export function runChild(command, input) {
  return new Promise((resolve) => {
    const invocation = runnerInvocation(command);
    const child = spawn(invocation.bin, [...invocation.prefix, "--workflow-id", input.workflow_id, "--run-id", input.run_id, "--step-id", input.step_id, "--source-trigger", input.source_trigger, "--idempotency-key", input.idempotency_key], {
      cwd: process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_WORKDIR || process.cwd(),
      env: {
        ...process.env,
        AUTOMATION_OS_BROWSER_SURFACE: "browser_use_cli",
        AUTOMATION_OS_BROWSER_NO_FALLBACK: "1",
        AUTOMATION_OS_BROWSER_REQUIRED: "1",
        AUTOMATION_OS_PORTABLE_BUSINESS_RUN_ID: input.run_id,
        AUTOMATION_OS_PORTABLE_BUSINESS_STEP_ID: input.step_id,
        AUTOMATION_OS_PORTABLE_BUSINESS_ADMISSION_PATH: input.admission.path,
        AUTOMATION_OS_PORTABLE_BUSINESS_ADMISSION_SHA256: input.admission.sha256,
        ...(input.input_bundle_path ? { AUTOMATION_OS_PORTABLE_BUSINESS_INPUT_BUNDLE_PATH: input.input_bundle_path } : {}),
        AUTOMATION_OS_WEB_OPERATION_CONTRACT_SCHEMA: "automation_os_web_operation_contract.v1",
        AUTOMATION_OS_WEB_OPERATION_ADAPTIVE: "semantic_live_state_bounded_exploration",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = ""; let stderr = ""; let settled = false; let cleanupStarted = false;
    const finish = (result) => { if (settled) return; settled = true; resolve(result); };
    const cleanup = (graceMs, timeout, code, signal, extra = {}) => {
      if (cleanupStarted) return;
      cleanupStarted = true;
      void cleanupOwnedProcessGroup(child, graceMs).then((processGroupCleanup) => finish({ code: child.exitCode ?? code, signal: child.signalCode || signal, timeout, stdout, stderr, processGroupCleanup, ...extra }));
    };
    const timeoutMs = Math.min(3_600_000, Math.max(1_000, Number(process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_TIMEOUT_MS || 900_000)));
    const timer = setTimeout(() => { cleanup(5_000, true, null, "SIGTERM"); }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => { clearTimeout(timer); cleanup(1_000, false, null, null, { error: String(error?.message || error) }); });
    child.once("exit", (code, signal) => { clearTimeout(timer); cleanup(1_000, false, code, signal); });
  });
}

async function main(argv = process.argv.slice(2)) {
  let input;
  try {
    input = args(argv);
    const inputBundlePath = String(process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_INPUT_BUNDLE_PATH || "").trim();
    if (inputBundlePath) input.input_bundle_path = inputBundlePath;
    const plan = PLANS[input.workflow_id];
    if (!plan) return output({ exact_blocker: BLOCKERS.plan, workflow_id: input.workflow_id, run_id: input.run_id, step_id: input.step_id });
    if (!/^(?:1|true|yes|on|enabled)$/iu.test(String(process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS || ""))) return output({ exact_blocker: BLOCKERS.disabled, workflow_id: input.workflow_id, run_id: input.run_id, step_id: input.step_id });
    if (String(process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL || "") !== "approved") return output({ exact_blocker: BLOCKERS.approval, workflow_id: input.workflow_id, run_id: input.run_id, step_id: input.step_id });
    const admission = readAdmission(input);
    const actionPlan = readPortableBusinessActionPlan({
      workflowId: input.workflow_id,
      runId: input.run_id,
      stepId: input.step_id,
      sourceTrigger: input.source_trigger,
      idempotencyKey: input.idempotency_key,
      inputBundlePath: input.input_bundle_path,
    });
    const genericWebOperation = Boolean(String(process.env.AUTOMATION_OS_PORTABLE_WEB_OPERATION_INTENT_PATH || "").trim());
    const command = genericWebOperation
      ? path.join(aosRoot(), "scripts", "aos-portable-browser-use-runner.mjs")
      : runnerFor(input.workflow_id);
    if (!command) return output({
      exact_blocker: BLOCKERS.runner,
      workflow_id: input.workflow_id,
      run_id: input.run_id,
      step_id: input.step_id,
      binding_readback: {
        explicit_binding_present: Boolean(String(process.env[`AUTOMATION_OS_PORTABLE_BUSINESS_RUNNER_${PLANS[input.workflow_id]?.key || ""}`] || "").trim()),
        project_root_present: Boolean(String(process.env.AUTOMATION_OS_BROWSER_USE_PROJECT_ROOT || "").trim()),
        resolved_default_present: Boolean(canonicalRunnerPath(input.workflow_id) && fs.existsSync(canonicalRunnerPath(input.workflow_id))),
      },
    });
    if (!path.isAbsolute(command) || !fs.existsSync(command) || !fs.statSync(command).isFile() || /(?:playwright|chrome_extension|in_app_browser|direct_cdp)/iu.test(path.basename(command))) return output({ exact_blocker: BLOCKERS.invalidRunner, workflow_id: input.workflow_id, run_id: input.run_id, step_id: input.step_id });
    const sourceBlocker = validateRunnerSource(command);
    if (sourceBlocker) return output({ exact_blocker: sourceBlocker, workflow_id: input.workflow_id, run_id: input.run_id, step_id: input.step_id });
    const child = await runChild(command, { ...input, admission, web_operation_contract: actionPlan.value.web_operation_contract });
    const receipt = parseLastJson(child.stdout);
    const externalActionExecuted = receipt?.external_action_executed === true;
    const receiptLifecycle = receipt?.web_operation_lifecycle && typeof receipt.web_operation_lifecycle === "object" ? receipt.web_operation_lifecycle : null;
    const effectUnknownReceipt = receiptLifecycle?.state === "effect_unknown" && receiptLifecycle?.no_replay === true;
    if (child.timeout) return output({ exact_blocker: BLOCKERS.timeout, external_action_executed: externalActionExecuted, workflow_id: input.workflow_id, run_id: input.run_id, step_id: input.step_id, runner_receipt: { process_group_cleanup: child.processGroupCleanup || null } });
    if (child.processGroupCleanup?.verified !== true) return output({ exact_blocker: BLOCKERS.processGroupCleanup, external_action_executed: externalActionExecuted, workflow_id: input.workflow_id, run_id: input.run_id, step_id: input.step_id, runner_receipt: { process_group_cleanup: child.processGroupCleanup || null } });
    if (!receipt || typeof receipt.external_action_executed !== "boolean" || receipt.browser_surface !== "browser_use_cli" || receipt.run_id !== input.run_id || (externalActionExecuted && (!receipt.same_run_receipt || receipt.cleanup_verified !== true) && !effectUnknownReceipt)) return output({ exact_blocker: BLOCKERS.receipt, external_action_executed: externalActionExecuted, workflow_id: input.workflow_id, run_id: input.run_id, step_id: input.step_id });
    if (genericWebOperation) {
      const lifecycle = receipt.web_operation_lifecycle && typeof receipt.web_operation_lifecycle === "object" ? receipt.web_operation_lifecycle : null;
      const status = receipt.status === "complete" && lifecycle?.status === "complete" && receipt.same_run_receipt === true && receipt.cleanup_verified === true
        ? "complete"
        : "blocked";
      return output({
        status,
        exact_blocker: status === "complete" ? null : String(receipt.exact_blocker || lifecycle?.exact_blocker || "portable_external_web_operation_receipt_invalid"),
        external_action_executed: externalActionExecuted,
        workflow_id: input.workflow_id,
        run_id: input.run_id,
        step_id: input.step_id,
        web_operation_contract: actionPlan.value.web_operation_contract,
        web_operation_lifecycle: lifecycle,
        runner_receipt: {
          generic_web_operation: true,
          command_sha256: digest(command),
          child_exit_status: child.code,
          child_signal: child.signal,
          process_group_cleanup: child.processGroupCleanup || null,
          web_operation_contract_schema: actionPlan.value.web_operation_contract.schema,
          ...(admission.authority ? { effect_authority_id: admission.authority.authority_id, effect_authority_sha256: String(process.env.AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256 || "") } : {}),
        },
      }, status === "complete" ? 0 : 1);
    }
    const status = receipt.status === "complete" || receipt.status === "partial" || receipt.status === "blocked" ? receipt.status : child.code === 0 ? "partial" : "blocked";
    const webOperationLifecycle = buildBusinessWebOperationLifecycle({ input, receipt, authority: admission.authority, externalActionExecuted });
    const normalizedStatus = externalActionExecuted || status === "complete"
      ? webOperationLifecycle.status === "complete" ? "complete" : "blocked"
      : status;
    const normalizedBlocker = webOperationLifecycle.status === "complete"
      ? null
      : webOperationLifecycle.exact_blocker || receipt.exact_blocker || (child.code === 0 ? null : "portable_external_business_runner_exit_nonzero");
    return output({ status: normalizedStatus, exact_blocker: normalizedBlocker, external_action_executed: externalActionExecuted, workflow_id: input.workflow_id, run_id: input.run_id, step_id: input.step_id, web_operation_contract: actionPlan.value.web_operation_contract, web_operation_lifecycle: webOperationLifecycle, runner_receipt: { plan_proofs: plan.proof, command_sha256: digest(command), child_exit_status: child.code, child_signal: child.signal, process_group_cleanup: child.processGroupCleanup || null, web_operation_contract_schema: actionPlan.value.web_operation_contract.schema, ...(admission.authority ? { effect_authority_id: admission.authority.authority_id, effect_authority_sha256: String(process.env.AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256 || "") } : {}) } }, normalizedStatus === "complete" && !normalizedBlocker ? 0 : 1);
  } catch (error) {
    return output({ exact_blocker: String(error?.message || error).slice(0, 240), external_action_executed: false, workflow_id: input?.workflow_id, run_id: input?.run_id, step_id: input?.step_id });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}

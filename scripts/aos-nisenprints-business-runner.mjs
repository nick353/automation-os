#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readPortableBusinessActionPlan, WEB_OPERATION_CONTRACT } from "./portable-business-action-plan.mjs";
import { buildPortableBusinessWebOperationLifecycle, readPortableBusinessEffectAuthority } from "./portable-business-lifecycle.mjs";

const ID = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,179}$/u;
const WORKFLOW_ID = "nisenprints-daily-product-canva-printify-etsy-pinterest";
const AOS_NISENPRINTS_PORT = 19884;
const AOS_NISENPRINTS_PROFILE = "/Users/nichikatanaka/.browser-use-cli/profiles/scheduled/nisenprints";
const DEFAULT_ROOT_RUNNER = "/Users/nichikatanaka/Documents/Etsy/.codex/automation-kernel/runners/nisenprints-daily-product-canva-printify-etsy-pinterest.mjs";
const CANONICAL_SOURCE_RE = /stage-adapter|browser-use-cli|codex-browser-use/iu;

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function output(value, code = 1) {
  process.stdout.write(`${JSON.stringify({
    status: value.status || "blocked",
    exact_blocker: value.exact_blocker || null,
    external_action_executed: value.external_action_executed === true,
    browser_surface: "browser_use_cli",
    same_run_receipt: value.same_run_receipt === true,
    cleanup_verified: value.cleanup_verified === true,
    llm_provider_neutral: true,
    app_dependency: false,
    ...(value.run_id ? { run_id: value.run_id } : {}),
    ...(value.step_id ? { step_id: value.step_id } : {}),
    ...(value.runner_receipt ? { runner_receipt: value.runner_receipt } : {}),
    ...(value.web_operation_lifecycle ? { web_operation_lifecycle: value.web_operation_lifecycle } : {}),
    web_operation_contract: value.web_operation_contract || WEB_OPERATION_CONTRACT,
  })}\n`);
  return code;
}
function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = String(argv[index] || "").replace(/^--/u, "").replaceAll("-", "_");
    if (!key || !argv[index + 1] || String(argv[index + 1]).startsWith("--")) throw new Error("nisenprints_business_argument_invalid");
    result[key] = String(argv[index + 1]);
    index += 1;
  }
  for (const key of ["workflow_id", "run_id", "step_id", "source_trigger", "idempotency_key"]) {
    if (!ID.test(String(result[key] || ""))) throw new Error(`nisenprints_business_${key}_invalid`);
  }
  return result;
}
function readAdmission(input) {
  const file = path.resolve(String(process.env.AUTOMATION_OS_PORTABLE_BUSINESS_ADMISSION_PATH || ""));
  const expected = String(process.env.AUTOMATION_OS_PORTABLE_BUSINESS_ADMISSION_SHA256 || "");
  if (!file || !fs.existsSync(file) || !/^[a-f0-9]{64}$/u.test(expected)) throw new Error("nisenprints_business_admission_missing");
  const bytes = fs.readFileSync(file);
  const value = JSON.parse(bytes.toString("utf8"));
  if (digest(bytes) !== expected || value.workflow_id !== input.workflow_id || value.run_id !== input.run_id || value.step_id !== input.step_id || value.audience !== "portable_external_runner" || value.approval_status !== "approved" || value.browser_surface !== "browser_use_cli") throw new Error("nisenprints_business_admission_binding_invalid");
  if (Date.parse(String(value.expires_at || "")) <= Date.now()) throw new Error("nisenprints_business_admission_expired");
}

function rootRunnerPath() {
  const configured = String(
    process.env.AUTOMATION_OS_NISENPRINTS_BROWSER_USE_RUNNER
      || DEFAULT_ROOT_RUNNER,
  ).trim();
  if (!path.isAbsolute(configured)) throw new Error("nisenprints_browser_use_cli_root_runner_path_invalid");
  let stat;
  try { stat = fs.statSync(configured); } catch { throw new Error("nisenprints_browser_use_cli_root_runner_missing"); }
  if (!stat.isFile() || (stat.mode & 0o111) === 0) throw new Error("nisenprints_browser_use_cli_root_runner_not_executable");
  const source = fs.readFileSync(configured, "utf8");
  if (!CANONICAL_SOURCE_RE.test(source)) {
    throw new Error("nisenprints_browser_use_cli_root_runner_surface_invalid");
  }
  return configured;
}

function artifactDirForRun(runId) {
  const artifactRoot = path.resolve(String(process.env.AUTOMATION_OS_ARTIFACT_ROOT || path.join(process.cwd(), "data", "artifacts")));
  const artifactDir = path.resolve(artifactRoot, runId);
  if (artifactDir !== artifactRoot && !artifactDir.startsWith(`${artifactRoot}${path.sep}`)) {
    throw new Error("nisenprints_browser_use_cli_artifact_binding_invalid");
  }
  fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(artifactDir, 0o700);
  return artifactDir;
}
function projectBusinessProofs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !value.business_proofs || typeof value.business_proofs !== "object" || Array.isArray(value.business_proofs)) return null;
  const allowed = ["generation_manifest", "etsy_listing", "pinterest_pin_url", "etsy_visit_site_match", "cleanup_receipt"];
  const result = {};
  for (const key of allowed) {
    const proof = value.business_proofs[key];
    if (proof === true || (proof && typeof proof === "object" && proof.verified === true)) result[key] = proof;
  }
  return Object.keys(result).length ? result : null;
}
function readRootBusinessReceipt(resultPath) {
  const file = path.resolve(String(resultPath || ""));
  if (!path.isAbsolute(file) || !fs.existsSync(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value;
  } catch (_) { return null; }
}

async function runReferenceReadback({ input, runner }) {
  const artifactDir = artifactDirForRun(input.run_id);
  // The root runner reads this value while importing.  It is deliberately
  // fixed to AOS's NisenPrints scheduled lane; the runner's historical
  // default remains unchanged for direct project-owned invocations.
  process.env.NISENPRINTS_BROWSER_USE_CLI_PORT = String(AOS_NISENPRINTS_PORT);
  process.env.NISENPRINTS_ARTIFACT_ROOT = path.dirname(artifactDir);
  process.env.AUTOMATION_OS_WEB_OPERATION_CONTRACT_SCHEMA = WEB_OPERATION_CONTRACT.schema;
  process.env.AUTOMATION_OS_WEB_OPERATION_ADAPTIVE = "semantic_live_state_bounded_exploration";
  const root = await import(runner);
  if (typeof root.runBrowserUseCliStage !== "function") throw new Error("nisenprints_browser_use_cli_root_stage_adapter_missing");
  const result = await root.runBrowserUseCliStage({
    stageId: "browser_preflight",
    runId: input.run_id,
    artifactDir,
  });
  return output({
    status: "blocked",
    exact_blocker: "nisenprints_browser_use_cli_reference_readback_only",
    run_id: input.run_id,
    step_id: input.step_id,
    same_run_receipt: true,
    cleanup_verified: result.cleanup_verified === true,
    runner_receipt: {
      schema: "aos_nisenprints_business_runner_receipt.v1",
      run_id: input.run_id,
      step_id: input.step_id,
      browser_surface: "browser_use_cli",
      external_action_executed: false,
      stage_id: "browser_preflight",
      readback_verified: result.readback_verified === true,
      cleanup_verified: result.cleanup_verified === true,
      root_runner: runner,
      reserved_profile: AOS_NISENPRINTS_PROFILE,
      reserved_port: AOS_NISENPRINTS_PORT,
    },
    web_operation_contract: WEB_OPERATION_CONTRACT,
  });
}

async function runApprovedBusiness(input, runner, actionPlan) {
  const artifactDir = artifactDirForRun(input.run_id);
  const authority = readPortableBusinessEffectAuthority(input);
  process.env.NISENPRINTS_BROWSER_USE_CLI_PORT = String(AOS_NISENPRINTS_PORT);
  process.env.NISENPRINTS_ARTIFACT_ROOT = path.dirname(artifactDir);
  process.env.AUTOMATION_OS_WEB_OPERATION_CONTRACT_SCHEMA = WEB_OPERATION_CONTRACT.schema;
  process.env.AUTOMATION_OS_WEB_OPERATION_ADAPTIVE = "semantic_live_state_bounded_exploration";
  const root = await import(runner);
  if (typeof root.runRegisteredAutomation !== "function") throw new Error("nisenprints_browser_use_cli_registered_runner_missing");
  const rootResult = await root.runRegisteredAutomation({ stage: "execute", runId: input.run_id, repairMode: "normal" });
  const result = rootResult?.result && typeof rootResult.result === "object" ? rootResult.result : rootResult;
  const rootReceipt = readRootBusinessReceipt(rootResult?.result_path || result?.result_path);
  const businessProofs = projectBusinessProofs(rootReceipt) || projectBusinessProofs(result) || projectBusinessProofs(rootResult);
  const sameRunSourceSync = rootReceipt?.same_run_source_sync === true || result?.same_run_source_sync === true || rootResult?.same_run_source_sync === true;
  const cleanupPath = String(result?.cleanup_proof || "");
  let cleanupVerified = false;
  if (cleanupPath && path.isAbsolute(cleanupPath) && fs.existsSync(cleanupPath)) {
    try {
      const cleanup = JSON.parse(fs.readFileSync(cleanupPath, "utf8"));
      cleanupVerified = cleanup?.schema === "automation_kernel_cleanup_proof.v1"
        && cleanup?.cleanup_complete === true
        && cleanup?.residual_owned_processes === 0;
    } catch (_) { cleanupVerified = false; }
  }
  const sameRunReceipt = result?.schema === "automation_kernel_result.v2"
    && result?.run_id === input.run_id
    && path.isAbsolute(String(rootResult?.result_path || ""))
    && fs.existsSync(String(rootResult.result_path));
  const succeeded = result?.terminal_status === "succeeded" && sameRunReceipt && cleanupVerified;
  const externalActionExecuted = succeeded && Array.isArray(result?.stage_results)
    && result.stage_results.some((stage) => stage?.details?.external_intent_observed === true);
  const resultPath = path.resolve(String(rootResult?.result_path || ""));
  const sourceStateDigest = sameRunReceipt
    ? (() => { try { return digest(fs.readFileSync(resultPath)); } catch (_) { return null; } })()
    : null;
  const exactBlocker = succeeded ? null : String(result?.exact_blocker || "nisenprints_business_proof_incomplete");
  const webOperationLifecycle = buildPortableBusinessWebOperationLifecycle({
    run_id: input.run_id,
    step_id: input.step_id,
    idempotency_key: input.idempotency_key,
    operation: "publish",
    authority,
    external_action_executed: externalActionExecuted,
    same_run_receipt: sameRunReceipt,
    readback_verified: sameRunSourceSync,
    cleanup_verified: cleanupVerified,
    source_state_digest: sourceStateDigest,
    exact_blocker: externalActionExecuted && succeeded && sameRunSourceSync && businessProofs ? null : exactBlocker,
  });
  return output({
    status: succeeded ? "complete" : "blocked",
    exact_blocker: exactBlocker,
    external_action_executed: externalActionExecuted,
    run_id: input.run_id,
    step_id: input.step_id,
    same_run_receipt: sameRunReceipt,
    cleanup_verified: cleanupVerified,
    web_operation_lifecycle: webOperationLifecycle,
    runner_receipt: {
      schema: "aos_nisenprints_business_runner_receipt.v1",
      run_id: input.run_id,
      step_id: input.step_id,
      browser_surface: "browser_use_cli",
      external_action_executed: externalActionExecuted,
      root_runner: runner,
      root_result_path: String(rootResult?.result_path || ""),
      cleanup_proof: cleanupPath,
      action_plan_sha256: actionPlan.sha256,
      reserved_profile: AOS_NISENPRINTS_PROFILE,
      reserved_port: AOS_NISENPRINTS_PORT,
      ...(businessProofs ? { business_proofs: businessProofs } : {}),
      ...(sameRunSourceSync ? { same_run_source_sync: true } : {}),
    },
    web_operation_contract: actionPlan.value.web_operation_contract,
  }, succeeded ? 0 : 1);
}
async function main(argv = process.argv.slice(2)) {
  let input;
  try {
    input = parseArgs(argv);
    if (input.workflow_id !== WORKFLOW_ID) return output({ exact_blocker: "nisenprints_business_workflow_invalid", run_id: input.run_id, step_id: input.step_id });
    readAdmission(input);
    if (/^(?:1|true|yes|on)$/iu.test(String(process.env.AUTOMATION_OS_PORTABLE_BUSINESS_NO_LAUNCH || ""))) {
      return output({ status: "blocked", exact_blocker: "nisenprints_browser_use_cli_no_launch_canary", run_id: input.run_id, step_id: input.step_id, same_run_receipt: true, cleanup_verified: true });
    }
    const runner = rootRunnerPath();
    if (String(process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_READ_ONLY_STAGE || "") === "reference_readback") {
      return await runReferenceReadback({ input, runner });
    }
    const actionPlan = readPortableBusinessActionPlan({
      workflowId: input.workflow_id,
      runId: input.run_id,
      stepId: input.step_id,
      sourceTrigger: input.source_trigger,
      idempotencyKey: input.idempotency_key,
    });
    return await runApprovedBusiness(input, runner, actionPlan);
  } catch (error) {
    return output({ exact_blocker: String(error?.message || error || "nisenprints_browser_use_cli_business_failed").slice(0, 240), run_id: input?.run_id, step_id: input?.step_id });
  }
}
main().then((code) => { process.exitCode = code; });

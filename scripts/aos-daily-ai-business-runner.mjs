#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readPortableBusinessActionPlan, WEB_OPERATION_CONTRACT } from "./portable-business-action-plan.mjs";
import { buildPortableBusinessWebOperationLifecycle, readPortableBusinessEffectAuthority } from "./portable-business-lifecycle.mjs";

const ID = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,179}$/u;
const PROJECT_ROOT = "/Users/nichikatanaka/Documents/New project";
const DEFAULT_REGISTERED_RUNNER = path.join(PROJECT_ROOT, "scripts", "run_daily_ai_browser_use_cli_registered.mjs");
const QUEUE_PATH = path.join(PROJECT_ROOT, "posting_queue.tsv");

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
    if (!key || !argv[index + 1] || String(argv[index + 1]).startsWith("--")) throw new Error("daily_ai_business_argument_invalid");
    result[key] = String(argv[index + 1]);
    index += 1;
  }
  for (const key of ["workflow_id", "run_id", "step_id", "source_trigger", "idempotency_key"]) {
    if (!ID.test(String(result[key] || ""))) throw new Error(`daily_ai_business_${key}_invalid`);
  }
  return result;
}
function readAdmission(input) {
  const file = path.resolve(String(process.env.AUTOMATION_OS_PORTABLE_BUSINESS_ADMISSION_PATH || ""));
  const expected = String(process.env.AUTOMATION_OS_PORTABLE_BUSINESS_ADMISSION_SHA256 || "");
  if (!file || !fs.existsSync(file) || !/^[a-f0-9]{64}$/u.test(expected)) throw new Error("daily_ai_business_admission_missing");
  const bytes = fs.readFileSync(file);
  const value = JSON.parse(bytes.toString("utf8"));
  if (digest(bytes) !== expected || value.workflow_id !== input.workflow_id || value.run_id !== input.run_id || value.step_id !== input.step_id || value.approval_status !== "approved" || value.browser_surface !== "browser_use_cli") throw new Error("daily_ai_business_admission_binding_invalid");
  if (Date.parse(String(value.expires_at || "")) <= Date.now()) throw new Error("daily_ai_business_admission_expired");
  return { path: file, sha256: expected };
}
function parseLastJson(stdout) {
  for (const line of String(stdout || "").split(/\r?\n/u).map((value) => value.trim()).filter(Boolean).reverse()) {
    try { const parsed = JSON.parse(line); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed; } catch (_) { /* progress output */ }
  }
  return null;
}
function registeredRunnerPath() {
  const configured = String(process.env.AUTOMATION_OS_DAILY_AI_BROWSER_USE_RUNNER || DEFAULT_REGISTERED_RUNNER).trim();
  if (!path.isAbsolute(configured)) throw new Error("daily_ai_browser_use_cli_registered_runner_path_invalid");
  if (!fs.existsSync(configured) || !fs.statSync(configured).isFile()) throw new Error("daily_ai_browser_use_cli_registered_runner_missing");
  const source = fs.readFileSync(configured, "utf8");
  if (!/(?:browser[_-]?use[_-]?cli|stage-adapter|codex-browser-use)/iu.test(source)) throw new Error("daily_ai_browser_use_cli_registered_runner_surface_invalid");
  return configured;
}
function readJsonRecord(file, root) {
  const candidate = path.resolve(String(file || ""));
  const base = path.resolve(root);
  if (!candidate || (candidate !== base && !candidate.startsWith(`${base}${path.sep}`)) || !fs.existsSync(candidate)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (_) { return null; }
}
function hasText(value) { return typeof value === "string" && value.trim().length > 0; }
function dailyBusinessProofs(summary, runId) {
  if (!summary || typeof summary !== "object") return null;
  const publish = summary.direct_publish && typeof summary.direct_publish === "object" ? summary.direct_publish : {};
  const feed = summary.post_publish_feed_study && typeof summary.post_publish_feed_study === "object" ? summary.post_publish_feed_study : {};
  const engagement = summary.direct_engagement && typeof summary.direct_engagement === "object" ? summary.direct_engagement : {};
  const postflight = summary.postflight_sync && typeof summary.postflight_sync === "object" ? summary.postflight_sync : {};
  const cleanup = summary.cleanup_proof && typeof summary.cleanup_proof === "object" ? summary.cleanup_proof : {};
  return {
    publish_url_or_exact_blocker: Boolean((Array.isArray(publish.receipts) && publish.receipts.some((item) => hasText(item?.post_url))) || publish.no_candidate_proof === true || hasText(publish.exact_blocker || publish.stop_reason)),
    feed_study_or_exact_blocker: Boolean(hasText(feed.artifact) || feed.no_candidate_proof === true || hasText(feed.exact_blocker || feed.stop_reason)),
    engagement_or_no_candidate_proof: Boolean((Array.isArray(engagement.receipts) && engagement.receipts.length > 0) || engagement.no_candidate_proof === true || hasText(engagement.exact_blocker || engagement.stop_reason)),
    queue_sync: Boolean(postflight.run_id === runId && postflight.queue_readback && hasText(postflight.queue_readback.sha256)),
    cleanup_receipt: cleanup.cleanup_verified === true,
  };
}
function dailySameRunSourceSync(summary, runId) {
  return Boolean(summary && summary.postflight_sync?.run_id === runId && summary.postflight_sync?.status === "completed" && summary.postflight_sync?.queue_readback?.sha256);
}
function dailySourceStateDigest(summary, receipt, outputDir) {
  const queueDigest = String(summary?.postflight_sync?.queue_readback?.sha256 || "");
  if (/^[a-f0-9]{64}$/u.test(queueDigest)) return queueDigest;
  const summaryPath = path.resolve(String(receipt?.summary_path || ""));
  const root = path.resolve(outputDir);
  if (summaryPath === root || !summaryPath.startsWith(`${root}${path.sep}`) || !fs.existsSync(summaryPath)) return null;
  try { return digest(fs.readFileSync(summaryPath)); } catch (_) { return null; }
}
function runRegisteredRunner(input, outputDir, runner) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runner], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        DAILY_AI_CLI_RUN_ID: input.run_id,
        DAILY_AI_CLI_OUTPUT_DIR: outputDir,
        DAILY_AI_QUEUE_PATH: QUEUE_PATH,
        DAILY_AI_CLI_ALLOW_POSTFLIGHT_SYNC: "0",
        AUTOMATION_OS_WEB_OPERATION_CONTRACT_SCHEMA: WEB_OPERATION_CONTRACT.schema,
        AUTOMATION_OS_WEB_OPERATION_ADAPTIVE: "semantic_live_state_bounded_exploration",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => resolve({ code: null, signal: null, stdout, stderr, error: String(error?.message || error) }));
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
async function main(argv = process.argv.slice(2)) {
  let input;
  try {
    input = parseArgs(argv);
    if (input.workflow_id !== "daily-ai-research-publish-run") return output({ exact_blocker: "daily_ai_business_workflow_invalid", run_id: input.run_id, step_id: input.step_id });
    readAdmission(input);
    if (/^(?:1|true|yes|on)$/iu.test(String(process.env.AUTOMATION_OS_PORTABLE_BUSINESS_NO_LAUNCH || ""))) {
      return output({ status: "blocked", exact_blocker: "daily_ai_browser_use_cli_no_launch_canary", run_id: input.run_id, step_id: input.step_id, same_run_receipt: true, cleanup_verified: true });
    }
    const runner = registeredRunnerPath();
    if (!fs.existsSync(QUEUE_PATH) || !fs.statSync(QUEUE_PATH).isFile()) return output({ exact_blocker: "daily_ai_browser_use_cli_queue_missing", run_id: input.run_id, step_id: input.step_id });
    const actionPlan = readPortableBusinessActionPlan({
      workflowId: input.workflow_id,
      runId: input.run_id,
      stepId: input.step_id,
      sourceTrigger: input.source_trigger,
      idempotencyKey: input.idempotency_key,
    });
    const artifactRoot = path.resolve(process.env.AUTOMATION_OS_ARTIFACT_ROOT?.trim() || path.join(process.cwd(), "data", "artifacts"));
    const outputDir = path.join(artifactRoot, input.run_id, "business-run", "daily-ai");
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    const child = await runRegisteredRunner(input, outputDir, runner);
    const receipt = parseLastJson(child.stdout);
    const summary = readJsonRecord(receipt?.summary_path, outputDir);
    const businessProofs = dailyBusinessProofs(summary, input.run_id);
    const sameRunSourceSync = dailySameRunSourceSync(summary, input.run_id);
    const external = receipt?.external_action_executed === true;
    const cleanup = receipt?.cleanup_verified === true;
    const status = receipt?.status === "complete" || receipt?.status === "partial" || receipt?.status === "blocked" ? receipt.status : "blocked";
    const exactBlocker = receipt?.exact_blocker || (child.error ? "daily_ai_browser_use_cli_registered_runner_spawn_failed" : "daily_ai_browser_use_cli_business_proof_incomplete");
    const sameRunReceipt = Boolean(receipt?.same_run_receipt && receipt?.run_id === input.run_id);
    const authority = readPortableBusinessEffectAuthority(input);
    const webOperationLifecycle = buildPortableBusinessWebOperationLifecycle({
      run_id: input.run_id,
      step_id: input.step_id,
      idempotency_key: input.idempotency_key,
      operation: "publish",
      authority,
      external_action_executed: external,
      same_run_receipt: sameRunReceipt,
      readback_verified: sameRunSourceSync,
      cleanup_verified: cleanup,
      source_state_digest: dailySourceStateDigest(summary, receipt, outputDir),
      exact_blocker: external && status === "complete" && !receipt?.exact_blocker ? null : exactBlocker,
    });
    return output({ status, exact_blocker: exactBlocker, external_action_executed: external, same_run_receipt: sameRunReceipt, cleanup_verified: cleanup, run_id: input.run_id, step_id: input.step_id, web_operation_contract: actionPlan.value.web_operation_contract, web_operation_lifecycle: webOperationLifecycle, runner_receipt: { child_exit_status: child.code, child_signal: child.signal, output_dir: outputDir, action_plan_sha256: actionPlan.sha256, web_operation_contract_schema: actionPlan.value.web_operation_contract.schema, ...(businessProofs ? { business_proofs: businessProofs } : {}), ...(sameRunSourceSync ? { same_run_source_sync: true } : {}) } }, status === "complete" && !receipt?.exact_blocker ? 0 : 1);
  } catch (error) {
    return output({ exact_blocker: String(error?.message || error || "daily_ai_browser_use_cli_business_failed").slice(0, 240), run_id: input?.run_id, step_id: input?.step_id });
  }
}
main().then((code) => { process.exitCode = code; });

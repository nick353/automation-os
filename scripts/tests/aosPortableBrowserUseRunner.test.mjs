import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PORTABLE_EXTERNAL_ACTION_PLAN_REQUIRED,
  PORTABLE_EXTERNAL_READ_ONLY_BUSINESS_PROOF_PENDING,
  PORTABLE_EXTERNAL_READ_ONLY_ROUTE_NOT_CONFIGURED,
  parsePortableRunnerArgs,
  routeForWorkflow,
} from "../aos-portable-browser-use-runner.mjs";

test("read-only authority uses the canonical Browser Use approval token", () => {
  const source = readFileSync(fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url)), "utf8");
  assert.match(source, /side_effect_scope: "read_only_preflight"[\s\S]{0,240}approval: "approved"/u);
  assert.doesNotMatch(source, /approval: "approved_read_only"/u);
});

test("screenshotPath is declared and bound to the run-owned recording directory before use", () => {
  const source = readFileSync(fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url)), "utf8");
  const declaration = source.indexOf('let screenshotPath = "";');
  const runOwnedAssignment = source.indexOf('screenshotPath = path.join(flow.recording_dir, "aos-readback.png");');
  const screenshotCommand = source.indexOf('["screenshot", screenshotPath]');
  const receiptReference = source.indexOf('screenshot_path: fs.existsSync(screenshotPath) ? screenshotPath : "",');
  assert.ok(declaration >= 0, "screenshotPath declaration must remain present");
  assert.ok(runOwnedAssignment > declaration, "screenshotPath must be generated after flow creation");
  assert.ok(screenshotCommand > runOwnedAssignment, "screenshot command must use the run-owned path");
  assert.ok(receiptReference > screenshotCommand, "receipt must reference the same declared path");
  assert.match(source, /path\.join\(flow\.recording_dir, "aos-readback\.png"\)/u);
});

test("AOS owns explicit read-only routes and lane bindings", () => {
  assert.equal(routeForWorkflow("job-application-manager").automation_id, "automation-3");
  assert.equal(routeForWorkflow("daily-ai-research-publish-run").port, 19882);
  assert.equal(routeForWorkflow("nisenprints-daily-product-canva-printify-etsy-pinterest").port, 19884);
  assert.equal(routeForWorkflow("nisenprints-daily-product-canva-printify-etsy-pinterest").target_url, "https://www.canva.com/");
  assert.equal(routeForWorkflow("prompt-transfer-ukiyoe"), null);
});

test("portable runner rejects malformed bindings before any browser command", () => {
  assert.throws(
    () => parsePortableRunnerArgs(["--workflow-id", "job-application-manager", "--run-id", "../outside"]),
    /portable_external_run_id_invalid/,
  );
});

test("enabled effects stop at action-plan gate without launching Browser Use CLI", () => {
  const runnerPath = fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [
    runnerPath,
    "--workflow-id", "job-application-manager",
    "--run-id", "run-action-plan-gate",
    "--step-id", "step-action-plan-gate",
    "--source-trigger", "automation_os_scheduler",
    "--idempotency-key", "action-plan-gate",
  ], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS: "enabled",
      AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL: "approved",
    },
  });
  assert.equal(result.status, 1);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.exact_blocker, PORTABLE_EXTERNAL_ACTION_PLAN_REQUIRED);
  assert.equal(receipt.external_action_executed, false);
});

test("read-only mode requires a fresh AOS admission and does not invent an unsupported route", () => {
  const runnerPath = fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "aos-portable-runner-test-"));
  const admissionPath = join(root, "admission.json");
  const payload = {
    schema: "automation_os_portable_external_admission.v1",
    workflow_id: "prompt-transfer-ukiyoe",
    run_id: "run-unsupported-route",
    step_id: "step-unsupported-route",
    source_trigger: "automation_os_scheduler",
    idempotency_key: "unsupported-route",
    effect_class: "external_non_idempotent",
    browser_surface: "browser_use_cli",
    approval_status: "approved",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const bytes = `${JSON.stringify(payload, null, 2)}\n`;
  writeFileSync(admissionPath, bytes, { mode: 0o600 });
  const result = spawnSync(process.execPath, [
    runnerPath,
    "--workflow-id", payload.workflow_id,
    "--run-id", payload.run_id,
    "--step-id", payload.step_id,
    "--source-trigger", payload.source_trigger,
    "--idempotency-key", payload.idempotency_key,
  ], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      AUTOMATION_OS_ARTIFACT_ROOT: root,
      AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS: "read_only",
      AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL: "approved",
      AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_PATH: admissionPath,
      AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_SHA256: createHash("sha256").update(bytes).digest("hex"),
    },
  });
  assert.equal(result.status, 1);
  const receipt = JSON.parse(result.stdout.trim());
  assert.equal(receipt.exact_blocker, `${PORTABLE_EXTERNAL_READ_ONLY_ROUTE_NOT_CONFIGURED}:prompt-transfer-ukiyoe`);
  assert.equal(receipt.external_action_executed, false);
});

test("candidate-supply read-only shortfall remains partial and cannot become business completion", () => {
  assert.equal(PORTABLE_EXTERNAL_READ_ONLY_BUSINESS_PROOF_PENDING, "portable_external_read_only_business_completion_proof_pending");
});

test("reference readback completes only after readback and cleanup, without business proof", () => {
  const source = readFileSync(fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url)), "utf8");
  assert.match(source, /const referenceReadback = environment\.AUTOMATION_OS_PORTABLE_EXTERNAL_READ_ONLY_STAGE === REFERENCE_READBACK_STAGE/u);
  assert.match(source, /finalized\?\.finalized !== true[\s\S]{0,220}referenceReadback[\s\S]{0,100}\? null/u);
  assert.match(source, /status: exactBlocker === null \? "complete"/u);
  assert.match(source, /external_executor_status: referenceReadback \? "reference_readback_completed"/u);
  assert.match(source, /reference_readback: referenceReadback/u);
});

test("Job candidate supply is an AOS-owned Browser Use CLI read-only stage", () => {
  const source = readFileSync(fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url)), "utf8");
  assert.match(source, /job_candidate_supply/u);
  assert.match(source, /JOB_CANDIDATE_SUPPLY_STAGE\s*=\s*["']candidate_supply["']/u);
  assert.match(source, /REFERENCE_READBACK_STAGE\s*=\s*["']reference_readback["']/u);
  assert.match(source, /AUTOMATION_OS_PORTABLE_EXTERNAL_READ_ONLY_STAGE\s*===\s*JOB_CANDIDATE_SUPPLY_STAGE/u);
  assert.match(source, /\[JOB_CANDIDATE_SUPPLY_STAGE, REFERENCE_READBACK_STAGE\]\.?includes\(/u);
  assert.match(source, /: ready\s*\n\s*\? null\s*\n\s*:\s*PORTABLE_EXTERNAL_READ_ONLY_BUSINESS_PROOF_PENDING/u);
  assert.match(source, /read_only_stage_bound:\s*true/u);
  assert.match(source, /same_run_receipt:\s*ready/u);
  assert.match(source, /job_manager_browser_use_cli_candidate_supply_adapter\.mjs/u);
  assert.match(source, /JOB_CANDIDATE_SUPPLY_PACKAGE_HELPER\s*=\s*["']\/Users\/nichikatanaka\/Documents\/New project\/browser-use-cli\/bin\/codex-browser-use["']/u);
  assert.match(source, /process\.env\.BROWSER_USE_CLI_HELPER\s*=\s*JOB_CANDIDATE_SUPPLY_PACKAGE_HELPER/u);
  assert.match(source, /browserFlowFinalize: true/u);
  assert.match(source, /external_action_executed: false/u);
  assert.doesNotMatch(source, /runJobManagerBrowserUseCliSubmit/u);
});

test("read-only routes use adapter-allowlisted captured URL and title probes", async () => {
  const source = readFileSync(fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url)), "utf8");
  assert.match(source, /\["eval", "location\.href"\]/u);
  assert.match(source, /\["eval", "document\.title"\]/u);
  assert.match(source, /\["get", "url"\]/u);
  assert.match(source, /\["get", "title"\]/u);
});

test("read-only navigation allows the canonical helper to reconcile same-origin login redirects", () => {
  const source = readFileSync(fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url)), "utf8");
  assert.match(source, /\["open", route\.target_url\]/u);
  assert.match(source, /same-origin[\s\S]{0,40}authenticated route/u);
});

test("read-only Browser Use runtime readback is returned to the AOS binding boundary", () => {
  const source = readFileSync(fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url)), "utf8");
  const runtimeReadback = source.indexOf("const browserRuntimeReadback = {");
  const adapterResult = source.indexOf("adapter_result: { browser_runtime_readback: browserRuntimeReadback");
  const effectiveSession = source.indexOf("effective_session: String(flow.contract?.effective_session || flow.session || \"\")");
  const cleanup = source.indexOf("cleanup_verified: finalized?.finalized === true");
  assert.ok(runtimeReadback >= 0, "read-only runner must construct runtime readback");
  assert.ok(effectiveSession > runtimeReadback, "effective session must come from the live flow contract");
  assert.ok(cleanup > runtimeReadback, "runtime readback must bind cleanup proof");
  assert.ok(adapterResult > cleanup, "runtime readback must cross the adapter_result boundary");
});

test("adaptive semantic target readback advances beyond the completed batch sequence", () => {
  const source = readFileSync(fileURLToPath(new URL("../aos-portable-browser-use-runner.mjs", import.meta.url)), "utf8");
  assert.match(
    source,
    /targetText: intent\.target\.semantic_query,[\s\S]{0,180}actionSequence: Number\(flow\.contract\?\.action_sequence \|\| 0\) \+ 1/u,
  );
});

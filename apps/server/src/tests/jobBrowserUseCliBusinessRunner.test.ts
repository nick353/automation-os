import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";

const runner = "/Users/nichikatanaka/Documents/New project/scripts/browser_use/job_manager_browser_use_cli_business_runner.mjs";
const sitePlaybook = "/Users/nichikatanaka/Documents/New project/scripts/browser_use/job_manager_browser_use_cli_site_playbook.mjs";

test("Job business runner keeps its immutable ledger-artifact writer defined at the call site", () => {
  const source = readFileSync(runner, "utf8");
  assert.match(source, /function writeImmutableJson\s*\(/u);
  assert.match(source, /return writeImmutableJson\(artifact,/u);
});

test("Job business runner reconciles claims when Browser Use start fails before the flow exists", () => {
  const source = readFileSync(runner, "utf8");
  const adapterCall = source.indexOf("const result = await runJobManagerBrowserUseCliSubmit(");
  const startedAssignment = source.indexOf("browserStarted = result?.browser_flow_started === true;", adapterCall);
  assert.ok(adapterCall >= 0, "business adapter call must remain explicit");
  assert.ok(startedAssignment > adapterCall, "browserStarted must use the adapter flow-start proof");
  assert.equal(source.slice(0, adapterCall).includes("browserStarted = true;"), false);
  assert.match(source, /if \(claimedBundle && !browserStarted\) \{/u);
});

test("Job site playbook discovers submit labels from semantic value attributes", async () => {
  const module = await import(`${pathToFileURL(sitePlaybook).href}?attribute-target-regression=${Date.now()}`);
  const labels = module.discoverActionLabels('<input type="submit" value="Submit application">', "submit");
  assert.ok(labels.includes("Submit application"));
  const semanticLabels = module.discoverActionLabels('<input type="submit">', "submit");
  assert.ok(semanticLabels.includes("__semantic__:type=submit"));
});

test("Job Browser Use CLI business runner admits only a same-run input bundle in no-launch mode", async () => {
  const artifactRoot = mkdtempSync(join(tmpdir(), "automation-os-job-business-runner-"));
  const runId = "run_job_business_input_bundle_canary";
  const runRoot = join(artifactRoot, runId);
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  chmodSync(runRoot, 0o700);
  const bundlePath = join(runRoot, "portable-input-bundle.v1.json");
  writeFileSync(bundlePath, `${JSON.stringify({
    schema: "automation_os_portable_workflow_input_bundle.v1",
    workflow_id: "job-application-manager",
    run_id: runId,
    input: {
      account_ref: "linkedin_authenticated_job_manager",
      job_url: "https://example.com/jobs/canary",
      application_url: "https://example.com/jobs/canary",
      candidate_key: "candidate-canary",
      bucket: "japan_targeted",
      sequence: 1,
      attempt: 1,
      source_snapshot_id: "snapshot-canary",
      supply_run_id: "supply-canary",
      payload_hash: "a".repeat(64)
    }
  }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(bundlePath, 0o600);
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
    const child = spawn(process.execPath, [runner, "--workflow-id", "job-application-manager", "--run-id", runId, "--step-id", "step_job_business_input_bundle_canary", "--source-trigger", "automation_os_scheduler", "--idempotency-key", "job-business-input-bundle-canary"], {
      env: {
        ...process.env,
        AUTOMATION_OS_ARTIFACT_ROOT: artifactRoot,
        AUTOMATION_OS_PORTABLE_BUSINESS_INPUT_BUNDLE_PATH: bundlePath,
        AUTOMATION_OS_PORTABLE_BUSINESS_NO_LAUNCH: "1"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolveResult({ code, stdout, stderr }));
  });
  assert.equal(result.code, 1, result.stderr);
  const receipt = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1) || "{}") as Record<string, unknown>;
  assert.equal(receipt.status, "blocked");
  assert.equal(receipt.exact_blocker, "job_manager_browser_use_cli_no_launch_canary");
  assert.equal(receipt.browser_surface, "browser_use_cli");
  assert.equal(receipt.external_action_executed, false);
  assert.equal(receipt.same_run_receipt, true);
  assert.equal(receipt.cleanup_verified, true);
});

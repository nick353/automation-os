import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const artifactRoot = mkdtempSync(join(tmpdir(), "automation-os-job-chrome-plugin-"));
process.env.AUTOMATION_OS_ARTIFACT_ROOT = artifactRoot;

const { runJobManagerChromePluginRegisteredRunner } = await import("../runs/jobManagerChromePluginRegisteredRunner.js");

test("Chrome Plugin Job route preserves Profile 2 and stops legacy runs before live work", () => {
  const result = runJobManagerChromePluginRegisteredRunner({
    runId: "job-chrome-plugin-route-test",
    workflowId: "job_submit_registered",
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.metadata.browser_surface, "signed_chrome_extension_profile2");
  assert.equal(result.metadata.browser_driver, "chrome_plugin");
  assert.equal(result.metadata.external_action_executed, false);
  assert.equal(result.metadata.browser_no_fallback, true);
  assert.equal(result.metadata.next_safe_route, "portable_external_worker");
  assert.equal(result.command.env.AOS_WEB_OPERATION_BACKEND, "chrome_plugin");
  assert.equal(result.command.env.AOS_CHROME_PROFILE_ID, "profile2");
  assert.equal(result.command.env.AOS_CHROME_PROFILE_NAME, "Profile 2");
  assert.equal(result.command.env.AOS_CHROME_PROFILE_SURFACE, "signed_chrome_extension_profile2");
  assert.equal(existsSync(result.artifactPath), true);
  const artifact = JSON.parse(readFileSync(result.artifactPath, "utf8")) as Record<string, unknown>;
  assert.equal(artifact.exact_blocker, "chrome_plugin_job_manager_portable_external_worker_required");
  assert.equal(artifact.status, "blocked");
});

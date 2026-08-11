import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const artifactRoot = mkdtempSync(join(tmpdir(), "automation-os-job-browser-use-cli-"));
process.env.AUTOMATION_OS_ARTIFACT_ROOT = artifactRoot;

const { runJobManagerBrowserUseCliRegisteredRunner } = await import("../runs/jobManagerBrowserUseCliRegisteredRunner.js");

test("Job registered fallback is Browser Use CLI-only and stops before live work", () => {
  const result = runJobManagerBrowserUseCliRegisteredRunner({
    runId: "job-browser-use-cli-only-test",
    workflowId: "job_submit_registered"
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.metadata.browser_surface, "browser_use_cli");
  assert.equal(result.metadata.browser_no_fallback, true);
  assert.equal(result.metadata.external_action_executed, false);
  assert.equal(result.metadata.next_safe_route, "portable_external_worker");
  assert.equal(result.command.bin, "/usr/local/bin/node");
  assert.equal(result.command.env.AUTOMATION_OS_BROWSER_SURFACE, "browser_use_cli");
  assert.equal(result.command.env.AUTOMATION_OS_BROWSER_NO_FALLBACK, "1");
  assert.doesNotMatch(result.command.display, /codex exec|playwright|chrome|direct.?cdp/i);
  assert.equal(existsSync(result.artifactPath), true);
  const artifact = JSON.parse(readFileSync(result.artifactPath, "utf8")) as Record<string, unknown>;
  assert.equal(artifact.exact_blocker, "browser_use_cli_job_manager_registered_runner_required");
  assert.equal(artifact.status, "blocked");
});

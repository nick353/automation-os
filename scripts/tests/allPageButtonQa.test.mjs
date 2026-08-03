import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(process.cwd());
const script = path.join(repoRoot, "scripts/all_page_button_qa.mjs");
const output = path.join(repoRoot, "work/qa/test-all-page-button-static-preflight.json");

test("all-page-button QA entrypoint is a tracked manifest preflight", () => {
  const result = spawnSync(process.execPath, [script, "--output", output], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(report.schema, "automation-os-ui-qa-preflight.v1");
  assert.equal(report.status, "passed");
  assert.equal(report.mode, "static_preflight");
  assert.equal(report.browser_surface, "browser_use_cli");
  assert.equal(report.runtime_qa.attempted, false);
  assert.equal(report.runtime_qa.exact_blocker, "fresh_browser_use_authority_required_for_runtime_screen_qa");
  assert.equal(report.control_manifest.entries, 188);
  assert.deepEqual(report.control_manifest.unclassified_rendered, []);
  assert.deepEqual(report.control_manifest.orphan_entries, []);
  assert.ok(report.route_contract.exact_path_markers.includes("#/chat"));
  assert.ok(report.route_contract.prefix_path_markers.includes("/performance"));
  assert.ok(report.route_contract.rendered_page_components.includes("TruthfulProductionStatusPage"));
  assert.ok(report.screen_cases.length >= 20);
  assert.ok(report.screen_cases.every((screen) => screen.control_count > 0));
  assert.ok(report.screen_cases.every((screen) => screen.runtime_qa.recording_required === true));
  assert.ok(report.screen_cases.every((screen) => screen.runtime_qa.status === "unverified"));
  assert.ok(report.screen_cases.every((screen) => screen.runtime_qa.exact_blocker === "fresh_browser_use_authority_required_for_runtime_screen_qa"));
  assert.ok(report.screen_cases.some((screen) => screen.case_id === "project-builder"));
  assert.ok(report.screen_cases.some((screen) => screen.case_id === "production-status"));
});

test("entrypoint does not import the obsolete Playwright worktree runner", () => {
  const source = fs.readFileSync(script, "utf8");
  assert.doesNotMatch(source, /work\/automation-os-new-deploy-repo/);
  assert.doesNotMatch(source, /from\s+["']playwright["']/);
  assert.doesNotMatch(source, /chromium\.launch\(/);
});

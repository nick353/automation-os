import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(process.cwd());
const script = path.join(repoRoot, "scripts/all_page_button_qa.mjs");
const output = path.join(repoRoot, "work/qa/test-all-page-button-static-preflight.json");

function readCurrentWebOperationConfig() {
  const configPath = process.env.AOS_WEB_OPERATION_BACKEND_CONFIG
    || process.env.AUTOMATION_OS_WEB_OPERATION_BACKEND_CONFIG
    || path.join(os.homedir(), ".social-flow", "web-operation-backend.json");
  return JSON.parse(fs.readFileSync(configPath, "utf8"));
}

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
  assert.ok(["aos_chrome_companion_profile_instance", "signed_chrome_extension_profile2", "browser_use_cli", "playwright"].includes(report.browser_surface));
  assert.equal(report.browser_surface, report.browser_configuration.browser_surface);
  const config = readCurrentWebOperationConfig();
  assert.equal(report.browser_configuration.backend, config.backend);
  assert.equal(report.browser_configuration.browser_surface, config.browser_surface);
  assert.equal(report.browser_configuration.preferred_backend, config.preferred_backend || config.backend);
  assert.equal(report.browser_configuration.preferred_browser_surface, config.preferred_browser_surface || config.browser_surface);
  assert.equal(report.browser_configuration.routing_mode, config.routing_mode || "unknown");
  assert.equal(report.browser_configuration.route_authority, config.route_authority || "unknown");
  assert.equal(report.browser_configuration.routing_policy.normal_default, config.routing_policy?.normal_default || "unknown");
  if (config.backend === "chrome_plugin") {
    assert.equal(report.browser_configuration.profile.surface, config.chrome_profile?.surface || "signed_chrome_extension_profile2");
  } else {
    assert.equal(report.browser_configuration.profile, null);
  }
  assert.equal(report.runtime_qa.attempted, false);
  assert.equal(report.runtime_qa.exact_blocker, "fresh_selected_browser_authority_required_for_runtime_screen_qa");
  const dispositionCount = Object.values(report.control_manifest.dispositions).reduce((sum, value) => sum + value, 0);
  assert.ok(report.control_manifest.entries > 0);
  assert.equal(dispositionCount, report.control_manifest.entries);
  assert.ok(report.control_manifest.rendered_patterns >= report.control_manifest.entries);
  assert.ok(report.control_manifest.native_interactive_controls.total > 0);
  assert.equal(report.control_manifest.native_interactive_controls.missing_control_id, 0);
  assert.deepEqual(report.control_manifest.native_interactive_controls.missing, []);
  assert.ok(report.control_manifest.custom_interactive_controls.total > 0);
  assert.equal(report.control_manifest.custom_interactive_controls.missing_control_id, 0);
  assert.deepEqual(report.control_manifest.custom_interactive_controls.missing, []);
  assert.deepEqual(report.control_manifest.unclassified_rendered, []);
  assert.deepEqual(report.control_manifest.orphan_entries, []);
  assert.ok(report.route_contract.exact_path_markers.includes("#/chat"));
  assert.ok(report.route_contract.prefix_path_markers.includes("/performance"));
  assert.ok(report.route_contract.rendered_page_components.includes("TruthfulProductionStatusPage"));
  assert.ok(report.screen_cases.length >= 20);
  assert.ok(report.screen_cases.every((screen) => screen.control_count > 0));
  assert.ok(report.screen_cases.every((screen) => screen.runtime_qa.recording_required === true));
  assert.ok(report.screen_cases.every((screen) => screen.runtime_qa.status === "unverified"));
  assert.ok(report.screen_cases.every((screen) => screen.runtime_qa.exact_blocker === "fresh_selected_browser_authority_required_for_runtime_screen_qa"));
  assert.ok(report.screen_cases.some((screen) => screen.case_id === "project-builder"));
  assert.ok(report.screen_cases.some((screen) => screen.case_id === "production-status"));
});

test("entrypoint does not import the obsolete Playwright worktree runner", () => {
  const source = fs.readFileSync(script, "utf8");
  assert.doesNotMatch(source, /work\/automation-os-new-deploy-repo/);
  assert.doesNotMatch(source, /from\s+["']playwright["']/);
  assert.doesNotMatch(source, /chromium\.launch\(/);
});

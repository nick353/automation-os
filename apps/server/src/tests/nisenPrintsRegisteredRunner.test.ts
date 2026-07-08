import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-nisenprints-registered-"));
process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_OUTPUT_ROOT = join(tempRoot, "nisenprints-node-runs");
const { evaluateNisenPrintsRegisteredSummary, resolveNisenPrintsPlaywrightRunner, runNisenPrintsRegisteredRunner } = await import("../runs/nisenPrintsRegisteredRunner.js");
const completeVisualAudit = makeVisualAudit("complete-visual-audit");

function makeVisualAudit(name: string, stage = "pinterest_visit_site") {
  const videoPath = join(tempRoot, `${name}.webm`);
  const qaPath = join(tempRoot, `${name}-gemini-video-qa.json`);
  writeFileSync(videoPath, "webm", "utf8");
  writeFileSync(
    qaPath,
    JSON.stringify({
      provider: "gemini",
      kind: "gemini_video_qa",
      status: "passed",
      verdict: "matches",
      completion_gate_alignment: "matches",
      completion_gate_matches: true,
      video_artifact_uri: pathToFileURL(videoPath).href
    }),
    "utf8"
  );
  return {
    provider: "gemini",
    stages: [
      {
        stage,
        status: "passed",
        verdict: "matches",
        completion_gate_alignment: "matches",
        completion_gate_matches: true,
        artifact_uri: pathToFileURL(qaPath).href,
        video_artifact_uri: pathToFileURL(videoPath).href
      }
    ]
  };
}

test("blocks NisenPrints registered runner when Playwright CLI runner is not configured", () => {
  const previousRunner = process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
  delete process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
  try {
    const result = runNisenPrintsRegisteredRunner({
      runId: "nisenprints-node-runner-missing",
      defaultRunnerPath: join(tempRoot, "missing-default-runner.mjs")
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.proof_gate.ok, false);
    assert.deepEqual(result.proof_gate.missing, ["nisenprints_playwright_runner_missing"]);
    assert.equal(result.exitStatus, null);
    assert.equal(result.command.bin, "node");
    assert.match(result.command.display, /not configured/);
  } finally {
    if (previousRunner === undefined) delete process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
    else process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER = previousRunner;
  }
});

test("exposes NisenPrints issue ledger summary from registered summary metadata", () => {
  const summaryPath = join(tempRoot, "nisenprints-issue-ledger-summary.json");
  writeFileSync(
    summaryPath,
    JSON.stringify({
      automation_os_run_id: "nisenprints-issue-ledger",
      run_id: "2026-06-17-issue-ledger",
      final_status: "blocked",
      stop_reason: "pinterest_pin_url_already_present_requires_read_only_verification",
      issue_ledger: [
        {
          stage: "pinterest_post",
          blocker_reason: "pinterest_pin_url_already_present_requires_read_only_verification",
          policy: {
            external_create_allowed: false,
            next_safe_action: "read_only_reconcile_existing_ids_before_rerun"
          }
        }
      ]
    }),
    "utf8"
  );

  const result = evaluateNisenPrintsRegisteredSummary(summaryPath);
  const issueSummary = result.metadata.issue_ledger_summary as Record<string, unknown>;
  assert.equal(result.status, "blocked");
  assert.equal(issueSummary.count, 1);
  assert.equal(issueSummary.latest_stage, "pinterest_post");
  assert.equal(issueSummary.external_create_allowed, false);
});

test("resolves NisenPrints Playwright CLI runner from env before default", () => {
  const previousRunner = process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
  process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER = "/tmp/env-nisenprints-runner.mjs";
  try {
    const resolved = resolveNisenPrintsPlaywrightRunner({ defaultRunnerPath: join(tempRoot, "default-runner.mjs") });

    assert.equal(resolved.runner, "/tmp/env-nisenprints-runner.mjs");
    assert.equal(resolved.source, "env");
  } finally {
    if (previousRunner === undefined) delete process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
    else process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER = previousRunner;
  }
});

test("runs NisenPrints registered runner from default Playwright CLI runner when env is unset", () => {
  const previousRunner = process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
  delete process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
  const fakeRunner = join(tempRoot, "fake-default-nisenprints-node-runner.mjs");
  writeFileSync(
    fakeRunner,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const videoPath = process.env.NISENPRINTS_OUTPUT_DIR + "/visit-site.webm";
const qaPath = process.env.NISENPRINTS_OUTPUT_DIR + "/gemini-video-qa.json";
writeFileSync(videoPath, "webm");
writeFileSync(qaPath, JSON.stringify({
  provider: "gemini",
  kind: "gemini_video_qa",
  status: "passed",
  verdict: "matches",
  completion_gate_alignment: "matches",
  completion_gate_matches: true,
  video_artifact_uri: pathToFileURL(videoPath).href
}));
writeFileSync(process.env.NISENPRINTS_REGISTERED_SUMMARY_PATH, JSON.stringify({
  automation_os_run_id: "nisenprints-default-runner-ok",
  run_id: "2026-06-17-test",
  run_slug: "fuji-test-cat",
  topic_name: "Fuji Test Cat",
  final_status: "playlite_flow_completed",
  stop_reason: "",
  etsy_listing_id: "4512345678",
  etsy_listing_url: "https://www.etsy.com/listing/4512345678/test",
  pinterest_pin_url: "https://www.pinterest.com/pin/982347737606212559/",
  pinterest_visit_site_listing_id: "4512345678",
  visual_audit: {
    provider: "gemini",
    stages: [{
      stage: "pinterest_visit_site",
      status: "passed",
      verdict: "matches",
      completion_gate_alignment: "matches",
      completion_gate_matches: true,
      artifact_uri: pathToFileURL(qaPath).href,
      video_artifact_uri: pathToFileURL(videoPath).href
    }]
  }
}));
`,
    "utf8"
  );
  chmodSync(fakeRunner, 0o755);
  try {
    const result = runNisenPrintsRegisteredRunner({
      runId: "nisenprints-default-runner-ok",
      defaultRunnerPath: fakeRunner
    });

    assert.equal(result.status, "complete");
    assert.equal(result.proof_gate.ok, true);
    assert.equal(result.command.bin, "node");
    assert.deepEqual(result.command.args, [fakeRunner]);
    assert.equal(result.command.env.NISENPRINTS_BROWSER_DRIVER, "playwright_cli");
    assert.equal(result.command.env.NISENPRINTS_REQUIRE_BROWSER_USE, "0");
    assert.equal(result.command.env.NISENPRINTS_RECORDING_REQUIRED, "0");
    assert.equal(result.command.env.NISENPRINTS_GEMINI_VIDEO_QA_REQUIRED, "0");
    assert.equal("BROWSER_USE_CDP_URL" in result.command.env, false);
    assert.equal("BROWSER_USE_SESSION" in result.command.env, false);
    assert.match(result.command.display, /NISENPRINTS_BROWSER_DRIVER=playwright_cli/);
    assert.doesNotMatch(result.command.display, /BROWSER_USE_/);
    assert.match(result.command.env.NISENPRINTS_REGISTERED_SUMMARY_PATH ?? "", /registered-playlite-cli-summary\.json$/);
  } finally {
    if (previousRunner === undefined) delete process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
    else process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER = previousRunner;
  }
});

test("passes output and registered summary env to configured NisenPrints runner", () => {
  const previousRunner = process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
  const fakeRunner = join(tempRoot, "fake-env-configured-nisenprints-node-runner.mjs");
  writeFileSync(
    fakeRunner,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const videoPath = process.env.NISENPRINTS_OUTPUT_DIR + "/visit-site.webm";
const qaPath = process.env.NISENPRINTS_OUTPUT_DIR + "/gemini-video-qa.json";
writeFileSync(videoPath, "webm");
writeFileSync(qaPath, JSON.stringify({
  provider: "gemini",
  kind: "gemini_video_qa",
  status: "passed",
  verdict: "matches",
  completion_gate_alignment: "matches",
  completion_gate_matches: true,
  video_artifact_uri: pathToFileURL(videoPath).href
}));
writeFileSync(process.env.NISENPRINTS_REGISTERED_SUMMARY_PATH, JSON.stringify({
  automation_os_run_id: process.env.AUTOMATION_OS_RUN_ID,
  run_id: "2026-06-17-env-test",
  run_slug: "fuji-env-test-cat",
  topic_name: "Fuji Env Test Cat",
  final_status: "playlite_flow_completed",
  stop_reason: "",
  output_dir_seen: process.env.NISENPRINTS_OUTPUT_DIR,
  summary_path_seen: process.env.NISENPRINTS_REGISTERED_SUMMARY_PATH,
  etsy_listing_id: "4512345678",
  etsy_listing_url: "https://www.etsy.com/listing/4512345678/test",
  pinterest_pin_url: "https://www.pinterest.com/pin/982347737606212559/",
  pinterest_visit_site_listing_id: "4512345678",
  visual_audit: {
    provider: "gemini",
    stages: [{
      stage: "pinterest_visit_site",
      status: "passed",
      verdict: "matches",
      completion_gate_alignment: "matches",
      completion_gate_matches: true,
      artifact_uri: pathToFileURL(qaPath).href,
      video_artifact_uri: pathToFileURL(videoPath).href
    }]
  }
}));
`,
    "utf8"
  );
  chmodSync(fakeRunner, 0o755);
  process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER = fakeRunner;
  try {
    const result = runNisenPrintsRegisteredRunner({
      runId: "nisenprints-env-runner-ok",
      defaultRunnerPath: join(tempRoot, "ignored-default-runner.mjs")
    });
    const summary = JSON.parse(readFileSync(result.summaryPath ?? "", "utf8"));

    assert.equal(result.status, "complete");
    assert.equal(result.command.args[0], fakeRunner);
    assert.equal(summary.automation_os_run_id, "nisenprints-env-runner-ok");
    assert.equal(summary.output_dir_seen, result.command.env.NISENPRINTS_OUTPUT_DIR);
    assert.equal(summary.summary_path_seen, result.command.env.NISENPRINTS_REGISTERED_SUMMARY_PATH);
    assert.equal(result.command.env.NISENPRINTS_REQUIRE_BROWSER_USE, "0");
    assert.equal(result.command.env.NISENPRINTS_RECORDING_REQUIRED, "0");
    assert.equal(result.command.env.NISENPRINTS_GEMINI_VIDEO_QA_REQUIRED, "0");
    assert.equal("BROWSER_USE_CDP_URL" in result.command.env, false);
    assert.equal("BROWSER_USE_SESSION" in result.command.env, false);
    assert.equal(result.summaryPath, result.command.env.NISENPRINTS_REGISTERED_SUMMARY_PATH);
  } finally {
    if (previousRunner === undefined) delete process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
    else process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER = previousRunner;
  }
});

test("does not read legacy NisenPrints Browser Use runner env", () => {
  const previousBrowserUseRunner = process.env.AUTOMATION_OS_NISENPRINTS_BROWSER_USE_RUNNER;
  const previousPlaywrightRunner = process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
  delete process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
  process.env.AUTOMATION_OS_NISENPRINTS_BROWSER_USE_RUNNER = join(tempRoot, "legacy-browser-use-runner-ignored.mjs");
  try {
    const result = runNisenPrintsRegisteredRunner({
      runId: "nisenprints-legacy-browser-use-env-ignored",
      defaultRunnerPath: join(tempRoot, "missing-playwright-default-runner.mjs")
    });

    assert.equal(result.status, "blocked");
    assert.deepEqual(result.proof_gate.missing, ["nisenprints_playwright_runner_missing"]);
    assert.equal(result.metadata.env_runner, "AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER");
  } finally {
    if (previousBrowserUseRunner === undefined) delete process.env.AUTOMATION_OS_NISENPRINTS_BROWSER_USE_RUNNER;
    else process.env.AUTOMATION_OS_NISENPRINTS_BROWSER_USE_RUNNER = previousBrowserUseRunner;
    if (previousPlaywrightRunner === undefined) delete process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
    else process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER = previousPlaywrightRunner;
  }
});

test("blocks NisenPrints registered runner when process exits nonzero even with complete summary", () => {
  const previousRunner = process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
  delete process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
  const fakeRunner = join(tempRoot, "fake-nonzero-nisenprints-node-runner.mjs");
  writeFileSync(
    fakeRunner,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const videoPath = process.env.NISENPRINTS_OUTPUT_DIR + "/visit-site.webm";
const qaPath = process.env.NISENPRINTS_OUTPUT_DIR + "/gemini-video-qa.json";
writeFileSync(videoPath, "webm");
writeFileSync(qaPath, JSON.stringify({
  provider: "gemini",
  kind: "gemini_video_qa",
  status: "passed",
  verdict: "matches",
  completion_gate_alignment: "matches",
  completion_gate_matches: true,
  video_artifact_uri: pathToFileURL(videoPath).href
}));
writeFileSync(process.env.NISENPRINTS_REGISTERED_SUMMARY_PATH, JSON.stringify({
  automation_os_run_id: "nisenprints-nonzero-runner",
  run_id: "2026-06-17-test",
  final_status: "playlite_flow_completed",
  stop_reason: "",
  etsy_listing_id: "4512345678",
  etsy_listing_url: "https://www.etsy.com/listing/4512345678/test",
  pinterest_pin_url: "https://www.pinterest.com/pin/982347737606212559/",
  pinterest_visit_site_listing_id: "4512345678"
}));
process.exit(7);
`,
    "utf8"
  );
  chmodSync(fakeRunner, 0o755);
  try {
    const result = runNisenPrintsRegisteredRunner({
      runId: "nisenprints-nonzero-runner",
      defaultRunnerPath: fakeRunner
    });

    assert.equal(result.status, "partial");
    assert.equal(result.proof_gate.ok, false);
    assert.equal(result.exitStatus, 7);
    assert.ok(result.proof_gate.missing.includes("nisenprints_runner_exit_0"));
    assert.equal(result.metadata.blocker, "nisenprints_runner_exit_nonzero");
  } finally {
    if (previousRunner === undefined) delete process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
    else process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER = previousRunner;
  }
});

test("blocks NisenPrints registered runner when summary run identity does not match Automation OS run", () => {
  const previousRunner = process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
  delete process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
  const fakeRunner = join(tempRoot, "fake-mismatched-run-id-nisenprints-node-runner.mjs");
  writeFileSync(
    fakeRunner,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const videoPath = process.env.NISENPRINTS_OUTPUT_DIR + "/visit-site.webm";
const qaPath = process.env.NISENPRINTS_OUTPUT_DIR + "/gemini-video-qa.json";
writeFileSync(videoPath, "webm");
writeFileSync(qaPath, JSON.stringify({
  provider: "gemini",
  kind: "gemini_video_qa",
  status: "passed",
  verdict: "matches",
  completion_gate_alignment: "matches",
  completion_gate_matches: true,
  video_artifact_uri: pathToFileURL(videoPath).href
}));
writeFileSync(process.env.NISENPRINTS_REGISTERED_SUMMARY_PATH, JSON.stringify({
  automation_os_run_id: "different-automation-os-run",
  run_id: "2026-06-17-test",
  final_status: "playlite_flow_completed",
  stop_reason: "",
  etsy_listing_id: "4512345678",
  etsy_listing_url: "https://www.etsy.com/listing/4512345678/test",
  pinterest_pin_url: "https://www.pinterest.com/pin/982347737606212559/",
  pinterest_visit_site_listing_id: "4512345678",
  visual_audit: {
    provider: "gemini",
    stages: [{
      stage: "pinterest_visit_site",
      status: "passed",
      verdict: "matches",
      completion_gate_alignment: "matches",
      completion_gate_matches: true,
      artifact_uri: pathToFileURL(qaPath).href,
      video_artifact_uri: pathToFileURL(videoPath).href
    }]
  }
}));
`,
    "utf8"
  );
  chmodSync(fakeRunner, 0o755);
  try {
    const result = runNisenPrintsRegisteredRunner({
      runId: "expected-automation-os-run",
      defaultRunnerPath: fakeRunner
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.proof_gate.ok, false);
    assert.ok(result.proof_gate.missing.includes("nisenprints_runner_identity"));
    assert.deepEqual(result.proof_gate.present, []);
    assert.deepEqual(result.proofs, []);
    assert.equal(result.metadata.blocker, "nisenprints_runner_identity_mismatch");
    assert.equal(result.metadata.expected_automation_os_run_id, "expected-automation-os-run");
  } finally {
    if (previousRunner === undefined) delete process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
    else process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER = previousRunner;
  }
});

test("blocks NisenPrints registered runner when summary run identity is missing", () => {
  const previousRunner = process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
  delete process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
  const fakeRunner = join(tempRoot, "fake-missing-run-id-nisenprints-node-runner.mjs");
  writeFileSync(
    fakeRunner,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const videoPath = process.env.NISENPRINTS_OUTPUT_DIR + "/visit-site.webm";
const qaPath = process.env.NISENPRINTS_OUTPUT_DIR + "/gemini-video-qa.json";
writeFileSync(videoPath, "webm");
writeFileSync(qaPath, JSON.stringify({
  provider: "gemini",
  kind: "gemini_video_qa",
  status: "passed",
  verdict: "matches",
  completion_gate_alignment: "matches",
  completion_gate_matches: true,
  video_artifact_uri: pathToFileURL(videoPath).href
}));
writeFileSync(process.env.NISENPRINTS_REGISTERED_SUMMARY_PATH, JSON.stringify({
  run_id: "2026-06-17-test",
  final_status: "playlite_flow_completed",
  stop_reason: "",
  etsy_listing_id: "4512345678",
  etsy_listing_url: "https://www.etsy.com/listing/4512345678/test",
  pinterest_pin_url: "https://www.pinterest.com/pin/982347737606212559/",
  pinterest_visit_site_listing_id: "4512345678",
  visual_audit: {
    provider: "gemini",
    stages: [{
      stage: "pinterest_visit_site",
      status: "passed",
      verdict: "matches",
      completion_gate_alignment: "matches",
      completion_gate_matches: true,
      artifact_uri: pathToFileURL(qaPath).href,
      video_artifact_uri: pathToFileURL(videoPath).href
    }]
  }
}));
`,
    "utf8"
  );
  chmodSync(fakeRunner, 0o755);
  try {
    const result = runNisenPrintsRegisteredRunner({
      runId: "expected-missing-automation-os-run",
      defaultRunnerPath: fakeRunner
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.proof_gate.ok, false);
    assert.ok(result.proof_gate.missing.includes("nisenprints_runner_identity"));
    assert.deepEqual(result.proof_gate.present, []);
    assert.deepEqual(result.proofs, []);
    assert.equal(result.metadata.blocker, "nisenprints_runner_identity_missing");
    assert.equal(result.metadata.expected_automation_os_run_id, "expected-missing-automation-os-run");
  } finally {
    if (previousRunner === undefined) delete process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
    else process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER = previousRunner;
  }
});

test("blocks NisenPrints registered runner identity mismatch before trusting partial summaries", () => {
  const previousRunner = process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
  delete process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
  const fakeRunner = join(tempRoot, "fake-partial-mismatched-run-id-nisenprints-node-runner.mjs");
  writeFileSync(
    fakeRunner,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.NISENPRINTS_REGISTERED_SUMMARY_PATH, JSON.stringify({
  automation_os_run_id: "different-partial-automation-os-run",
  run_id: "2026-06-17-test",
  final_status: "blocked",
  stop_reason: "canva_share_button_unavailable",
  blocked_stage: "canva_commit_export"
}));
`,
    "utf8"
  );
  chmodSync(fakeRunner, 0o755);
  try {
    const result = runNisenPrintsRegisteredRunner({
      runId: "expected-partial-automation-os-run",
      defaultRunnerPath: fakeRunner
    });

    assert.equal(result.status, "blocked");
    assert.ok(result.proof_gate.missing.includes("nisenprints_runner_identity"));
    assert.deepEqual(result.proof_gate.present, []);
    assert.deepEqual(result.proofs, []);
    assert.equal(result.metadata.blocker, "nisenprints_runner_identity_mismatch");
    assert.equal(result.metadata.expected_automation_os_run_id, "expected-partial-automation-os-run");
  } finally {
    if (previousRunner === undefined) delete process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
    else process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER = previousRunner;
  }
});

function writeSummary(payload: Record<string, unknown>): string {
  const path = join(tempRoot, `${String(payload.final_status ?? "summary")}-${Date.now()}-${Math.random()}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
}

function completeSummary(visual_audit: unknown): Record<string, unknown> {
  return {
    run_id: "2026-06-16-test",
    run_slug: "fuji-test-cat",
    topic_name: "Fuji Test Cat",
    final_status: "playlite_flow_completed",
    stop_reason: "",
    etsy_listing_id: "4512345678",
    etsy_listing_url: "https://www.etsy.com/listing/4512345678/test",
    pinterest_pin_url: "https://www.pinterest.com/pin/982347737606212559/",
    pinterest_visit_site_listing_id: "4512345678",
    visual_audit
  };
}

test("evaluates NisenPrints registered summary as complete only with strict proof fields", () => {
  const summaryPath = writeSummary({
    run_id: "2026-06-16-test",
    run_slug: "fuji-test-cat",
    topic_name: "Fuji Test Cat",
    final_status: "playlite_flow_completed",
    stop_reason: "",
    etsy_listing_id: "4512345678",
    etsy_listing_url: "https://www.etsy.com/listing/4512345678/test",
    pinterest_pin_url: "https://www.pinterest.com/pin/982347737606212559/",
    pinterest_visit_site_listing_id: "4512345678",
    visual_audit: completeVisualAudit
  });

  const evaluation = evaluateNisenPrintsRegisteredSummary(summaryPath);

  assert.equal(evaluation.status, "complete");
  assert.equal(evaluation.proof_gate.ok, true);
  assert.deepEqual(evaluation.proof_gate.missing, []);
  assert.ok(evaluation.proof_gate.present.includes("nisenprints_registered_summary"));
  assert.ok(evaluation.proof_gate.present.includes("etsy_visit_site_match_verified"));
});

test("evaluates NisenPrints registered summary as complete with absolute Browser Use QA and recording paths", () => {
  const videoPath = join(tempRoot, "absolute-path-recording.webm");
  const qaPath = join(tempRoot, "absolute-path-gemini-video-qa.json");
  writeFileSync(videoPath, "webm", "utf8");
  writeFileSync(
    qaPath,
    JSON.stringify({
      provider: "gemini",
      kind: "gemini_video_qa",
      status: "passed",
      verdict: "matches",
      completion_gate_alignment: "matches",
      completion_gate_matches: true,
      video_artifact_uri: videoPath
    }),
    "utf8"
  );
  const summaryPath = writeSummary(
    completeSummary({
      provider: "gemini",
      stages: [
        {
          stage: "pinterest_visit_site",
          status: "passed",
          verdict: "matches",
          completion_gate_alignment: "matches",
          completion_gate_matches: true,
          artifact_uri: qaPath,
          video_artifact_uri: videoPath
        }
      ]
    })
  );

  const evaluation = evaluateNisenPrintsRegisteredSummary(summaryPath);

  assert.equal(evaluation.status, "complete");
  assert.equal(evaluation.proof_gate.ok, true);
  assert.deepEqual(evaluation.proof_gate.missing, []);
});

test("blocks complete-looking NisenPrints summary when required Browser Use QA files are missing", () => {
  const summaryPath = writeSummary({
    run_id: "2026-06-16-test",
    run_slug: "fuji-test-cat",
    topic_name: "Fuji Test Cat",
    final_status: "playlite_flow_completed",
    stop_reason: "",
    etsy_listing_id: "4512345678",
    etsy_listing_url: "https://www.etsy.com/listing/4512345678/test",
    pinterest_pin_url: "https://www.pinterest.com/pin/982347737606212559/",
    pinterest_visit_site_listing_id: "4512345678",
    visual_audit: {
      provider: "gemini",
      stages: [
        {
          stage: "pinterest_visit_site",
          status: "passed",
          verdict: "matches",
          completion_gate_alignment: "matches",
          completion_gate_matches: true,
          artifact_uri: pathToFileURL(join(tempRoot, "missing-gemini-video-qa.json")).href,
          video_artifact_uri: pathToFileURL(join(tempRoot, "missing-recording.webm")).href
        }
      ]
    }
  });

  const evaluation = evaluateNisenPrintsRegisteredSummary(summaryPath, { recordingRequired: true, geminiVideoQaRequired: true });

  assert.equal(evaluation.status, "blocked");
  assert.equal(evaluation.proof_gate.ok, false);
  assert.ok(evaluation.proof_gate.missing.includes("browser_use_recording"));
  assert.ok(evaluation.proof_gate.missing.includes("gemini_video_qa"));
  assert.equal(evaluation.metadata.blocker, "browser_use_recording_gemini_qa_invalid");
});

test("keeps complete-looking NisenPrints summary complete when optional Browser Use QA artifact is only a string URI", () => {
  const qaPath = join(tempRoot, "string-only-gemini-video-qa.json");
  writeFileSync(qaPath, JSON.stringify({ provider: "gemini", kind: "gemini_video_qa" }), "utf8");
  const summaryPath = writeSummary(completeSummary(pathToFileURL(qaPath).href));

  const evaluation = evaluateNisenPrintsRegisteredSummary(summaryPath);

  assert.equal(evaluation.status, "complete");
  assert.equal(evaluation.proof_gate.ok, true);
  assert.deepEqual(evaluation.proof_gate.missing, []);
});

test("blocks complete-looking NisenPrints summary when required Browser Use Gemini QA JSON is invalid", () => {
  const videoPath = join(tempRoot, "invalid-json-recording.webm");
  const qaPath = join(tempRoot, "invalid-json-gemini-video-qa.json");
  writeFileSync(videoPath, "webm", "utf8");
  writeFileSync(qaPath, "{", "utf8");
  const summaryPath = writeSummary(
    completeSummary({
      provider: "gemini",
      stages: [
        {
          stage: "pinterest_visit_site",
          status: "passed",
          verdict: "matches",
          completion_gate_alignment: "matches",
          completion_gate_matches: true,
          artifact_uri: pathToFileURL(qaPath).href,
          video_artifact_uri: pathToFileURL(videoPath).href
        }
      ]
    })
  );

  const evaluation = evaluateNisenPrintsRegisteredSummary(summaryPath, { recordingRequired: true, geminiVideoQaRequired: true });

  assert.equal(evaluation.status, "blocked");
  assert.equal(evaluation.proof_gate.ok, false);
  assert.ok(evaluation.proof_gate.missing.includes("gemini_video_qa"));
  assert.match(evaluation.proof_summary, /gemini_video_qa_json_invalid/);
});

test("blocks complete-looking NisenPrints summary when required Browser Use Gemini QA video URI mismatches stage ledger video", () => {
  const ledgerVideoPath = join(tempRoot, "ledger-video.webm");
  const qaVideoPath = join(tempRoot, "qa-video.webm");
  const qaPath = join(tempRoot, "video-mismatch-gemini-video-qa.json");
  writeFileSync(ledgerVideoPath, "webm", "utf8");
  writeFileSync(qaVideoPath, "webm", "utf8");
  writeFileSync(
    qaPath,
    JSON.stringify({
      provider: "gemini",
      kind: "gemini_video_qa",
      status: "passed",
      verdict: "matches",
      completion_gate_alignment: "matches",
      completion_gate_matches: true,
      video_artifact_uri: pathToFileURL(qaVideoPath).href
    }),
    "utf8"
  );
  const summaryPath = writeSummary(
    completeSummary({
      provider: "gemini",
      stages: [
        {
          stage: "pinterest_visit_site",
          status: "passed",
          verdict: "matches",
          completion_gate_alignment: "matches",
          completion_gate_matches: true,
          artifact_uri: pathToFileURL(qaPath).href,
          video_artifact_uri: pathToFileURL(ledgerVideoPath).href
        }
      ]
    })
  );

  const evaluation = evaluateNisenPrintsRegisteredSummary(summaryPath, { recordingRequired: true, geminiVideoQaRequired: true });

  assert.equal(evaluation.status, "blocked");
  assert.equal(evaluation.proof_gate.ok, false);
  assert.ok(evaluation.proof_gate.missing.includes("gemini_video_qa"));
  assert.match(evaluation.proof_summary, /gemini_video_qa_video_uri_mismatch/);
});

test("keeps complete-looking NisenPrints summary complete when optional Browser Use video proof is only on a separate stage ledger entry", () => {
  const videoPath = join(tempRoot, "separate-entry-video.webm");
  const qaPath = join(tempRoot, "separate-entry-gemini-video-qa.json");
  writeFileSync(videoPath, "webm", "utf8");
  writeFileSync(
    qaPath,
    JSON.stringify({
      provider: "gemini",
      kind: "gemini_video_qa",
      status: "passed",
      verdict: "matches",
      completion_gate_alignment: "matches",
      completion_gate_matches: true,
      video_artifact_uri: pathToFileURL(videoPath).href
    }),
    "utf8"
  );
  const summaryPath = writeSummary(
    completeSummary({
      provider: "gemini",
      stages: [
        {
          stage: "pinterest_visit_site",
          status: "passed",
          verdict: "matches",
          completion_gate_alignment: "matches",
          completion_gate_matches: true,
          artifact_uri: pathToFileURL(qaPath).href
        },
        {
          stage: "pinterest_visit_site_recording",
          status: "passed",
          verdict: "matches",
          completion_gate_alignment: "matches",
          completion_gate_matches: true,
          video_artifact_uri: pathToFileURL(videoPath).href
        }
      ]
    })
  );

  const evaluation = evaluateNisenPrintsRegisteredSummary(summaryPath);

  assert.equal(evaluation.status, "complete");
  assert.equal(evaluation.proof_gate.ok, true);
  assert.deepEqual(evaluation.proof_gate.missing, []);
});

test("blocks NisenPrints completion when referenced Gemini QA explicitly fails completion gate", () => {
  const videoPath = join(tempRoot, "completion-mismatch-recording.webm");
  const qaPath = join(tempRoot, "completion-mismatch-gemini-video-qa.json");
  writeFileSync(videoPath, "webm", "utf8");
  writeFileSync(
    qaPath,
    JSON.stringify({
      provider: "gemini",
      kind: "gemini_video_qa",
      status: "passed",
      verdict: "matches",
      completion_gate_alignment: "conflict",
      completion_gate_matches: false,
      video_artifact_uri: pathToFileURL(videoPath).href
    }),
    "utf8"
  );
  const summaryPath = writeSummary(
    completeSummary({
      provider: "gemini",
      stages: [
        {
          stage: "pinterest_visit_site",
          status: "passed",
          verdict: "matches",
          completion_gate_alignment: "matches",
          completion_gate_matches: true,
          artifact_uri: pathToFileURL(qaPath).href,
          video_artifact_uri: pathToFileURL(videoPath).href
        }
      ]
    })
  );

  const evaluation = evaluateNisenPrintsRegisteredSummary(summaryPath);

  assert.equal(evaluation.status, "blocked");
  assert.equal(evaluation.proof_gate.ok, false);
  assert.ok(evaluation.proof_gate.missing.includes("gemini_video_qa"));
  assert.match(evaluation.proof_summary, /gemini_video_qa_completion_alignment/);
});

test("accepts playlite_flow_completed for NisenPrints Playwright runner", () => {
  const summaryPath = writeSummary({
    run_id: "2026-06-16-test",
    final_status: "playlite_flow_completed",
    stop_reason: "",
    etsy_listing_id: "4512345678",
    etsy_listing_url: "https://www.etsy.com/listing/4512345678/test",
    pinterest_pin_url: "https://www.pinterest.com/pin/982347737606212559/",
    pinterest_visit_site_listing_id: "4512345678",
    visual_audit: completeVisualAudit
  });

  const evaluation = evaluateNisenPrintsRegisteredSummary(summaryPath);

  assert.equal(evaluation.status, "complete");
  assert.equal(evaluation.proof_gate.ok, true);
});

test("blocks legacy browser_use_flow_completed for NisenPrints Playwright runner", () => {
  const summaryPath = writeSummary({
    run_id: "2026-06-16-test",
    final_status: "browser_use_flow_completed",
    stop_reason: "",
    etsy_listing_id: "4512345678",
    etsy_listing_url: "https://www.etsy.com/listing/4512345678/test",
    pinterest_pin_url: "https://www.pinterest.com/pin/982347737606212559/",
    pinterest_visit_site_listing_id: "4512345678",
    visual_audit: completeVisualAudit
  });

  const evaluation = evaluateNisenPrintsRegisteredSummary(summaryPath);

  assert.notEqual(evaluation.status, "complete");
  assert.equal(evaluation.metadata.blocker, "final_status=browser_use_flow_completed");
});

test("blocks NisenPrints registered summary when completion status lacks strict fields", () => {
  const summaryPath = writeSummary({
    run_id: "2026-06-16-test",
    final_status: "playlite_flow_completed",
    stop_reason: "",
    etsy_listing_id: "4512345678",
    etsy_listing_url: "https://www.etsy.com/listing/4512345678/test"
  });

  const evaluation = evaluateNisenPrintsRegisteredSummary(summaryPath);

  assert.equal(evaluation.status, "blocked");
  assert.equal(evaluation.proof_gate.ok, false);
  assert.ok(evaluation.proof_gate.missing.includes("pinterest_pin_url_verified"));
  assert.ok(evaluation.proof_gate.missing.includes("etsy_visit_site_match_verified"));
});

test("blocks NisenPrints registered summary when strict Etsy or Pinterest URLs are malformed", () => {
  const summaryPath = writeSummary({
    run_id: "2026-06-16-test",
    final_status: "playlite_flow_completed",
    stop_reason: "",
    etsy_listing_id: "4512345678",
    etsy_listing_url: "https://example.com/listing/4512345678/test",
    pinterest_pin_url: "https://evilpinterest.com/pin/982347737606212559/",
    pinterest_visit_site_listing_id: "4512345678"
  });

  const evaluation = evaluateNisenPrintsRegisteredSummary(summaryPath);

  assert.equal(evaluation.status, "blocked");
  assert.equal(evaluation.proof_gate.ok, false);
  assert.ok(evaluation.proof_gate.missing.includes("etsy_listing_published"));
  assert.ok(evaluation.proof_gate.missing.includes("pinterest_pin_url_verified"));
});

test("blocks hostile Pinterest lookalike domains in strict pin URL proof", () => {
  const summaryPath = writeSummary({
    run_id: "2026-06-16-test",
    final_status: "playlite_flow_completed",
    stop_reason: "",
    etsy_listing_id: "4512345678",
    etsy_listing_url: "https://www.etsy.com/listing/4512345678/test",
    pinterest_pin_url: "https://pinterest.com.evil.com/pin/982347737606212559/",
    pinterest_visit_site_listing_id: "4512345678"
  });

  const evaluation = evaluateNisenPrintsRegisteredSummary(summaryPath);

  assert.equal(evaluation.status, "blocked");
  assert.ok(evaluation.proof_gate.missing.includes("pinterest_pin_url_verified"));
});

test("does not let matching Gemini video QA fill missing NisenPrints strict fields", () => {
  const summaryPath = writeSummary({
    run_id: "2026-06-16-test",
    final_status: "playlite_flow_completed",
    stop_reason: "",
    etsy_listing_id: "4512345678",
    etsy_listing_url: "https://www.etsy.com/listing/4512345678/test",
    visual_audit: makeVisualAudit("missing-strict-fields")
  });

  const evaluation = evaluateNisenPrintsRegisteredSummary(summaryPath);

  assert.equal(evaluation.status, "blocked");
  assert.equal(evaluation.proof_gate.ok, false);
  assert.ok(evaluation.proof_gate.present.includes("gemini_video_qa"));
  assert.ok(evaluation.proof_gate.missing.includes("pinterest_pin_url_verified"));
  assert.ok(evaluation.proof_gate.missing.includes("etsy_visit_site_match_verified"));
  assert.ok(!evaluation.proof_gate.missing.includes("gemini_video_qa"));
});

test("attaches Gemini video QA proof without replacing NisenPrints strict proofs", () => {
  const summaryPath = writeSummary({
    run_id: "2026-06-16-test",
    final_status: "playlite_flow_completed",
    stop_reason: "",
    etsy_listing_id: "4512345678",
    etsy_listing_url: "https://www.etsy.com/listing/4512345678/test",
    pinterest_pin_url: "https://www.pinterest.com/pin/982347737606212559/",
    pinterest_visit_site_listing_id: "4512345678",
    visual_audit: makeVisualAudit("attached-qa", "etsy_media_ready")
  });

  const evaluation = evaluateNisenPrintsRegisteredSummary(summaryPath);

  assert.equal(evaluation.status, "complete");
  assert.equal(evaluation.proof_gate.ok, true);
  assert.ok(evaluation.proof_gate.present.includes("gemini_video_qa"));
  assert.ok(evaluation.proof_gate.present.includes("etsy_visit_site_match_verified"));
});

test("blocks NisenPrints completion when Gemini video QA sees a completion mismatch", () => {
  const summaryPath = writeSummary({
    run_id: "2026-06-16-test",
    final_status: "playlite_flow_completed",
    stop_reason: "",
    etsy_listing_id: "4512345678",
    etsy_listing_url: "https://www.etsy.com/listing/4512345678/test",
    pinterest_pin_url: "https://www.pinterest.com/pin/982347737606212559/",
    pinterest_visit_site_listing_id: "4512345678",
    gemini_video_qa: [
      {
        stage: "pinterest_visit_site",
        status: "blocked",
        completion_gate_alignment: "conflict",
        exact_blocker: "gemini_saw_visit_site_target_mismatch",
        repair_owner: "nisenprints_runner"
      }
    ]
  });

  const evaluation = evaluateNisenPrintsRegisteredSummary(summaryPath);

  assert.equal(evaluation.status, "blocked");
  assert.equal(evaluation.metadata.blocker, "gemini_video_qa_completion_mismatch");
  assert.ok(evaluation.proof_gate.missing.includes("gemini_video_qa_completion_alignment"));
  assert.match(evaluation.proof_summary, /gemini_saw_visit_site_target_mismatch/);
});

test("keeps blocked NisenPrints registered summary blocked with exact blocker", () => {
  const summaryPath = writeSummary({
    run_id: "2026-06-16-test",
    final_status: "blocked",
    stop_reason: "canva_export_lane_timeout"
  });

  const evaluation = evaluateNisenPrintsRegisteredSummary(summaryPath);

  assert.equal(evaluation.status, "blocked");
  assert.equal(evaluation.metadata.blocker, "canva_export_lane_timeout");
  assert.deepEqual(evaluation.proof_gate.present, ["nisenprints_registered_summary"]);
});

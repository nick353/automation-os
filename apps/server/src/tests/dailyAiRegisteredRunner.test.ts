import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { evaluateDailyAiRegisteredSummary, findDailyAiRegisteredSummary, runDailyAiRegisteredRunner } from "../runs/dailyAiRegisteredRunner.js";

function writeSummary(payload: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "automation-os-daily-ai-"));
  const path = join(dir, "registered-playwright-cli-summary.json");
  writeFileSync(path, JSON.stringify(payload, null, 2));
  return path;
}

const completeSummary = {
  run_id: "fixture-complete",
  stop_reason: "",
  direct_publish: { published: 1, receipts: [{ platform: "x", post_url: "https://x.com/demo/status/1" }] },
  post_publish_feed_study: { read: 15, external_read: 15 },
  direct_engagement: { sent: 2, receipts: [{ completion: "sent" }] },
  postflight_sync: { sheets_synced: 175 },
  final_buffer_refresh: { ship_now_buffer_count: 3 },
  cleanup_proof: { owned_process_count: 0 },
  full_flow_completion: { ok: true, failures: [] }
};

function withEnv<T>(updates: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(updates)) {
    previous.set(key, process.env[key]);
    const value = updates[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("marks Daily AI summary complete only with full flow ok and cleanup proof", () => {
  const result = evaluateDailyAiRegisteredSummary(writeSummary(completeSummary));

  assert.equal(result.status, "complete");
  assert.equal(result.proof_gate.ok, true);
  assert.equal(result.proofs.length, 7);
  assert.deepEqual(
    result.proofs.map((proof) => proof.proofType),
    [
      "daily_ai_publish",
      "daily_ai_feed_study",
      "daily_ai_engagement",
      "daily_ai_sync",
      "daily_ai_buffer",
      "daily_ai_cleanup",
      "daily_ai_registered_summary"
    ]
  );
  assert.ok(result.proofs.every((proof) => proof.uri.startsWith("file://")));
});

test("does not use legacy Playwright summaries as current Daily AI completion proof", () => {
  const dir = mkdtempSync(join(tmpdir(), "automation-os-daily-ai-current-"));
  const legacyDir = join(dir, "playwright-cli-runs", "legacy");
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(join(legacyDir, "registered-playwright-cli-summary.json"), JSON.stringify(completeSummary));

  const result = findDailyAiRegisteredSummary({
    outputDir: join(dir, "automation-os-daily-ai-runs", "current"),
    startedAtMs: Date.now()
  });

  assert.equal(result, undefined);
});

test("blocks Daily AI completion when Gemini QA contradicts completion", () => {
  const result = evaluateDailyAiRegisteredSummary(
    writeSummary({
      ...completeSummary,
      gemini_video_qa: {
        stages: [
          {
            stage: "direct_publish",
            status: "failed",
            verdict: "mismatch",
            completion_gate_alignment: "mismatch",
            exact_blocker: "gemini_saw_linkedin_publish_not_attempted",
            repair_owner: "daily_ai_runner"
          }
        ]
      }
    })
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.proof_gate.ok, false);
  assert.ok(result.proof_gate.present.includes("gemini_video_qa"));
  assert.ok(result.proof_gate.missing.includes("gemini_video_qa_completion_alignment"));
  assert.equal(result.metadata.blocker, "gemini_video_qa_completion_alignment");
  assert.equal("gemini_video_qa" in result.metadata, true);
});

test("does not treat successful preflight fields as a blocker", () => {
  const result = evaluateDailyAiRegisteredSummary(
    writeSummary({
      ...completeSummary,
      current_stage: "complete",
      stage_status: "completed",
      automation_health: {
        stage: "browser_preflight",
        completion_required: "daily_ai_cli_profile_and_auth_gate"
      },
      cdp_preflight: { ok: true, version: { Browser: "Chrome" } },
      profile_gate: { ok: true, expected_profile: "/Users/nichikatanaka/.daily-ai-playwright-chrome" }
    })
  );

  assert.equal(result.status, "complete");
  assert.equal(result.proof_gate.ok, true);
});

test("marks Daily AI summary partial when full flow gate is false", () => {
  const result = evaluateDailyAiRegisteredSummary(
    writeSummary({
      ...completeSummary,
      direct_publish: null,
      full_flow_completion: { ok: false, failures: ["publish_completion_missing"] }
    })
  );

  assert.equal(result.status, "partial");
  assert.equal(result.proof_gate.ok, false);
  assert.match(result.proof_summary, /publish_completion_missing/);
  assert.ok(result.proof_gate.missing.includes("daily_ai_publish"));
  assert.ok(!result.proofs.some((proof) => proof.proofType === "daily_ai_publish"));
});

test("exposes Daily AI issue ledger summary from runner summary metadata", () => {
  const result = evaluateDailyAiRegisteredSummary(
    writeSummary({
      ...completeSummary,
      direct_publish: null,
      full_flow_completion: { ok: false, failures: ["publish_partial_failure"] },
      issue_ledger: [
        {
          stage: "direct_publish",
          blocker_reason: "publish_partial_failure",
          policy: {
            repost_allowed: false,
            next_safe_action: "read_only_url_reconciliation_before_repost"
          }
        }
      ]
    })
  );

  const issueSummary = result.metadata.issue_ledger_summary as Record<string, unknown>;
  assert.equal(result.status, "partial");
  assert.equal(issueSummary.count, 1);
  assert.equal(issueSummary.latest_blocker, "publish_partial_failure");
  assert.equal(issueSummary.next_safe_action, "read_only_url_reconciliation_before_repost");
  assert.equal(issueSummary.repost_allowed, false);
});

test("marks Daily AI engagement candidate shortage with a stable blocker", () => {
  const result = evaluateDailyAiRegisteredSummary(
    writeSummary({
      ...completeSummary,
      full_flow_completion: {
        ok: false,
        failures: [
          "engagement_completion_missing",
          "engagement_action_target_missing:x:like_candidate:0/5,x:comment_candidate:0/2,linkedin:like_candidate:0/5,linkedin:comment_candidate:0/1",
          "engagement_platform_missing:x,linkedin"
        ]
      }
    })
  );

  assert.equal(result.status, "partial");
  assert.equal(result.metadata.blocker, "engagement_candidate_insufficient");
  assert.ok(result.proof_gate.missing.includes("engagement_candidate_insufficient"));
  assert.match(result.proof_summary, /engagement_action_target_missing/);
});

test("blocks Daily AI summary when full flow gate is missing", () => {
  const result = evaluateDailyAiRegisteredSummary(
    writeSummary({
      ...completeSummary,
      full_flow_completion: undefined
    })
  );

  assert.equal(result.status, "blocked");
  assert.match(result.proof_summary, /full_flow_completion/);
  assert.ok(result.proof_gate.missing.includes("full_flow_completion"));
});

test("blocks Daily AI summary when full flow says ok but required stages are missing", () => {
  const result = evaluateDailyAiRegisteredSummary(
    writeSummary({
      ...completeSummary,
      direct_publish: null,
      full_flow_completion: { ok: true, failures: [] }
    })
  );

  assert.equal(result.status, "blocked");
  assert.match(result.proof_summary, /required stages are missing/);
  assert.ok(result.proof_gate.missing.includes("daily_ai_publish"));
  assert.ok(!result.proofs.some((proof) => proof.proofType === "daily_ai_publish"));
});

test("keeps Daily AI blocked when direct publish proof is missing even if legacy Gemini fields exist", () => {
  const result = evaluateDailyAiRegisteredSummary(
    writeSummary({
      ...completeSummary,
      direct_publish: null,
      full_flow_completion: { ok: true, failures: [] },
      gemini_video_qa: {
        stages: [
          {
            stage: "direct_publish",
            status: "passed",
            verdict: "matches",
            completion_gate_alignment: "matches",
            completion_gate_matches: true,
            artifact_uri: "file:///tmp/daily-ai-gemini-report.json",
            video_artifact_uri: "file:///tmp/daily-ai-direct-publish.mp4"
          }
        ]
      }
    })
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.proof_gate.ok, false);
  assert.equal(result.proof_gate.present.includes("gemini_video_qa"), true);
  assert.ok(result.proof_gate.missing.includes("daily_ai_publish"));
  assert.ok(!result.proofs.some((proof) => proof.proofType === "daily_ai_publish"));
});

test("blocks missing, invalid, and preflight-blocked Daily AI summaries", () => {
  assert.equal(evaluateDailyAiRegisteredSummary(undefined).status, "blocked");

  const invalidPath = writeSummary(completeSummary);
  writeFileSync(invalidPath, "{");
  assert.equal(evaluateDailyAiRegisteredSummary(invalidPath).status, "blocked");

  const preflight = evaluateDailyAiRegisteredSummary(
    writeSummary({
      ...completeSummary,
      stop_reason: "connectOverCDP timeout",
      cdp_preflight: { ok: false },
      full_flow_completion: { ok: true, failures: [] }
    })
  );
  assert.equal(preflight.status, "blocked");
  assert.match(preflight.proof_summary, /connectOverCDP timeout/);
});

test("blocks Daily AI registered runner when process exits nonzero even with complete summary", () => {
  const dir = mkdtempSync(join(tmpdir(), "automation-os-daily-ai-runner-"));
  const runner = join(dir, "runner.mjs");
  writeFileSync(
    runner,
    [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const outputDir = process.env.DAILY_AI_CLI_OUTPUT_DIR;",
      "mkdirSync(outputDir, { recursive: true });",
      `writeFileSync(join(outputDir, "registered-playwright-cli-summary.json"), JSON.stringify({ ...${JSON.stringify(completeSummary)}, automation_os_run_id: process.env.AUTOMATION_OS_RUN_ID }, null, 2));`,
      "process.exit(1);"
    ].join("\n")
  );
  const previous = process.env.AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER;
  const previousOutputRoot = process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT;
  process.env.AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER = runner;
  process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT = join(dir, "runs");
  try {
    const result = runDailyAiRegisteredRunner({ runId: "daily-ai-nonzero", startedAtMs: Date.now() - 1_000 });
    assert.equal(result.status, "partial");
    assert.equal(result.proof_gate.ok, false);
    assert.ok(result.proof_gate.missing.includes("daily_ai_runner_exit_0"));
    assert.equal(result.metadata.blocker, "daily_ai_runner_exit_nonzero");
  } finally {
    if (previous === undefined) {
      delete process.env.AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER;
    } else {
      process.env.AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER = previous;
    }
    if (previousOutputRoot === undefined) {
      delete process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT;
    } else {
      process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT = previousOutputRoot;
    }
  }
});

test("blocks Daily AI registered runner when summary identity does not match Automation OS run", () => {
  const dir = mkdtempSync(join(tmpdir(), "automation-os-daily-ai-identity-"));
  const runner = join(dir, "runner.mjs");
  writeFileSync(
    runner,
    [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const outputDir = process.env.DAILY_AI_CLI_OUTPUT_DIR;",
      "mkdirSync(outputDir, { recursive: true });",
      `writeFileSync(join(outputDir, "registered-playwright-cli-summary.json"), JSON.stringify({ ...${JSON.stringify(completeSummary)}, automation_os_run_id: "different-run", run_id: process.env.DAILY_AI_CLI_RUN_ID }, null, 2));`
    ].join("\n")
  );
  const previous = process.env.AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER;
  const previousOutputRoot = process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT;
  process.env.AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER = runner;
  process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT = join(dir, "runs");
  try {
    const result = runDailyAiRegisteredRunner({ runId: "daily-ai-identity", startedAtMs: Date.now() - 1_000 });
    assert.equal(result.status, "blocked");
    assert.equal(result.proof_gate.ok, false);
    assert.ok(result.proof_gate.missing.includes("daily_ai_runner_identity"));
    assert.equal(result.metadata.blocker, "daily_ai_runner_identity_mismatch");
  } finally {
    if (previous === undefined) {
      delete process.env.AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER;
    } else {
      process.env.AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER = previous;
    }
    if (previousOutputRoot === undefined) {
      delete process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT;
    } else {
      process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT = previousOutputRoot;
    }
  }
});

test("Daily AI registered runner passes env run id and output dir to the Playwright CLI runner", () => {
  const dir = mkdtempSync(join(tmpdir(), "automation-os-daily-ai-env-"));
  const runner = join(dir, "runner.mjs");
  writeFileSync(
    runner,
    [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const outputDir = process.env.DAILY_AI_CLI_OUTPUT_DIR;",
      "if (!outputDir) throw new Error('DAILY_AI_CLI_OUTPUT_DIR missing');",
      "mkdirSync(outputDir, { recursive: true });",
      `writeFileSync(join(outputDir, "registered-playwright-cli-summary.json"), JSON.stringify({ ...${JSON.stringify(completeSummary)}, automation_os_run_id: process.env.AUTOMATION_OS_RUN_ID, run_id: process.env.DAILY_AI_CLI_RUN_ID }, null, 2));`
    ].join("\n")
  );
  const previous = process.env.AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER;
  const previousOutputRoot = process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT;
  process.env.AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER = runner;
  process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT = join(dir, "runs");
  try {
    const result = runDailyAiRegisteredRunner({ runId: "daily-ai/env contract", startedAtMs: Date.now() - 1_000 });
    const expectedCliRunId = "daily-ai_env_contract";

    assert.equal(result.status, "complete");
    assert.equal(result.metadata.automation_os_run_id, "daily-ai/env contract");
    assert.equal(result.metadata.run_id, expectedCliRunId);
    assert.equal(result.command.env.DAILY_AI_CLI_RUN_ID, expectedCliRunId);
    assert.equal(result.command.env.AUTOMATION_OS_RUN_ID, "daily-ai/env contract");
    assert.equal(result.command.env.DAILY_AI_CLI_STEP_TIMEOUT_MS, "2700000");
    assert.equal(result.command.env.DAILY_AI_CLI_REPLENISH_BUFFER_TIMEOUT_MS, "600000");
    assert.equal(result.command.env.DAILY_AI_RUNWAY_MCP_TIMEOUT_SECONDS, "300");
    assert.ok(Number(result.command.env.DAILY_AI_CLI_REPLENISH_BUFFER_TIMEOUT_MS) >= Number(result.command.env.DAILY_AI_RUNWAY_MCP_TIMEOUT_SECONDS) * 1000);
    assert.ok(Number.parseInt(result.command.env.DAILY_AI_CLI_STEP_TIMEOUT_MS, 10) > Number(result.command.env.DAILY_AI_CLI_REPLENISH_BUFFER_TIMEOUT_MS));
    assert.equal(result.command.env.DAILY_AI_CLI_BROWSER_VIDEO_QA, "no-post-preflight");
    assert.equal("DAILY_AI_CLI_PROOF_ONLY_NO_POST_PREFLIGHT" in result.command.env, false);
    assert.equal(result.command.env.DAILY_AI_CLI_RECORDING_REQUIRED, "0");
    assert.equal(result.command.env.DAILY_AI_CLI_EXTERNAL_VIDEO_QA_REQUIRED, "0");
    assert.equal(result.command.env.DAILY_AI_CDP_PORT, "9333");
    assert.equal(result.command.env.DAILY_AI_CLI_PROFILE_DIR, "/Users/nichikatanaka/.daily-ai-playwright-chrome");
    assert.equal(result.command.env.DAILY_AI_CLI_HEADLESS, "true");
    assert.equal(result.command.env.DAILY_AI_CLI_SHOW_BROWSER, "false");
    assert.equal("DAILY_AI_CLI_BROWSER_VIDEO_QA_SKIP_GEMINI" in result.command.env, false);
    assert.match(result.command.display, /DAILY_AI_CLI_STEP_TIMEOUT_MS=2700000/);
    assert.match(result.command.display, /DAILY_AI_CLI_REPLENISH_BUFFER_TIMEOUT_MS=600000/);
    assert.match(result.command.display, /DAILY_AI_RUNWAY_MCP_TIMEOUT_SECONDS=300/);
    assert.match(result.command.display, /DAILY_AI_CLI_BROWSER_VIDEO_QA=no-post-preflight/);
    assert.doesNotMatch(result.command.display, /DAILY_AI_CLI_PROOF_ONLY_NO_POST_PREFLIGHT=true/);
    assert.match(result.command.display, /DAILY_AI_CLI_RECORDING_REQUIRED=0/);
    assert.match(result.command.display, /DAILY_AI_CLI_EXTERNAL_VIDEO_QA_REQUIRED=0/);
    assert.match(result.command.display, /DAILY_AI_CDP_PORT=9333/);
    assert.match(result.command.display, /DAILY_AI_CLI_HEADLESS=true/);
    assert.match(result.command.display, /DAILY_AI_CLI_SHOW_BROWSER=false/);
    assert.doesNotMatch(result.command.display, /DAILY_AI_CLI_BROWSER_VIDEO_QA_SKIP_GEMINI/);
    assert.equal(result.command.env.PATH.startsWith("/Users/nichikatanaka/.local/bin:/opt/homebrew/bin:/usr/local/bin:"), true);
    assert.equal(result.summaryPath, join(result.command.env.DAILY_AI_CLI_OUTPUT_DIR, "registered-playwright-cli-summary.json"));
    assert.equal(existsSync(result.summaryPath), true);
  } finally {
    if (previous === undefined) {
      delete process.env.AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER;
    } else {
      process.env.AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER = previous;
    }
    if (previousOutputRoot === undefined) {
      delete process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT;
    } else {
      process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT = previousOutputRoot;
    }
  }
});

test("Daily AI registered runner does not pass Gemini key to child env", () => {
  const dir = mkdtempSync(join(tmpdir(), "automation-os-daily-ai-no-external-ai-env-"));
  const runner = join(dir, "runner.mjs");
  writeFileSync(
    runner,
    [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "if (process.env.GEMINI_API_KEY !== undefined) throw new Error('Gemini key must not be passed');",
      "const outputDir = process.env.DAILY_AI_CLI_OUTPUT_DIR;",
      "mkdirSync(outputDir, { recursive: true });",
      `writeFileSync(join(outputDir, "registered-playwright-cli-summary.json"), JSON.stringify({ ...${JSON.stringify(completeSummary)}, automation_os_run_id: process.env.AUTOMATION_OS_RUN_ID, run_id: process.env.DAILY_AI_CLI_RUN_ID }, null, 2));`
    ].join("\n")
  );

  withEnv(
    {
      AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER: runner,
      AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT: join(dir, "runs"),
      GEMINI_API_KEY: "AIza-test-daily-ai-gemini-key-1234567890"
    },
    () => {
      const result = runDailyAiRegisteredRunner({ runId: "daily-ai-no-external-ai-env", startedAtMs: Date.now() - 1_000 });

      assert.equal(result.status, "complete");
      assert.equal("GEMINI_API_KEY" in result.command.env, false);
      assert.doesNotMatch(result.command.display, /GEMINI_API_KEY=/);
      assert.doesNotMatch(result.command.display, /AIza-test-daily-ai-gemini-key/);
    }
  );
});

test("Daily AI registered runner leaves proof-only no-post preflight disabled by default", () => {
  const dir = mkdtempSync(join(tmpdir(), "automation-os-daily-ai-proof-only-default-"));
  const runner = join(dir, "runner.mjs");
  writeFileSync(
    runner,
    [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "if (process.env.DAILY_AI_CLI_PROOF_ONLY_NO_POST_PREFLIGHT !== undefined) throw new Error('proof-only no-post preflight should be absent by default');",
      "const outputDir = process.env.DAILY_AI_CLI_OUTPUT_DIR;",
      "mkdirSync(outputDir, { recursive: true });",
      `writeFileSync(join(outputDir, "registered-playwright-cli-summary.json"), JSON.stringify({ ...${JSON.stringify(completeSummary)}, automation_os_run_id: process.env.AUTOMATION_OS_RUN_ID, run_id: process.env.DAILY_AI_CLI_RUN_ID }, null, 2));`
    ].join("\n")
  );

  withEnv(
    {
      AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER: runner,
      AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT: join(dir, "runs"),
      AUTOMATION_OS_DAILY_AI_PROOF_ONLY_NO_POST_PREFLIGHT: undefined
    },
    () => {
      const result = runDailyAiRegisteredRunner({ runId: "daily-ai-proof-only-default", startedAtMs: Date.now() - 1_000 });

      assert.equal(result.status, "complete");
      assert.equal("DAILY_AI_CLI_PROOF_ONLY_NO_POST_PREFLIGHT" in result.command.env, false);
      assert.doesNotMatch(result.command.display, /DAILY_AI_CLI_PROOF_ONLY_NO_POST_PREFLIGHT=true/);
      assert.equal(result.command.env.DAILY_AI_CLI_BROWSER_VIDEO_QA, "no-post-preflight");
      assert.equal(result.command.env.DAILY_AI_CLI_RECORDING_REQUIRED, "0");
      assert.equal(result.command.env.DAILY_AI_CLI_EXTERNAL_VIDEO_QA_REQUIRED, "0");
    }
  );
});

test("Daily AI registered runner leaves proof-only no-post preflight disabled when opt-in env is false", () => {
  const dir = mkdtempSync(join(tmpdir(), "automation-os-daily-ai-proof-only-false-"));
  const runner = join(dir, "runner.mjs");
  writeFileSync(
    runner,
    [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "if (process.env.DAILY_AI_CLI_PROOF_ONLY_NO_POST_PREFLIGHT !== undefined) throw new Error('proof-only no-post preflight should be absent when opt-in is false');",
      "const outputDir = process.env.DAILY_AI_CLI_OUTPUT_DIR;",
      "mkdirSync(outputDir, { recursive: true });",
      `writeFileSync(join(outputDir, "registered-playwright-cli-summary.json"), JSON.stringify({ ...${JSON.stringify(completeSummary)}, automation_os_run_id: process.env.AUTOMATION_OS_RUN_ID, run_id: process.env.DAILY_AI_CLI_RUN_ID }, null, 2));`
    ].join("\n")
  );

  withEnv(
    {
      AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER: runner,
      AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT: join(dir, "runs"),
      AUTOMATION_OS_DAILY_AI_PROOF_ONLY_NO_POST_PREFLIGHT: "false"
    },
    () => {
      const result = runDailyAiRegisteredRunner({ runId: "daily-ai-proof-only-false", startedAtMs: Date.now() - 1_000 });

      assert.equal(result.status, "complete");
      assert.equal("DAILY_AI_CLI_PROOF_ONLY_NO_POST_PREFLIGHT" in result.command.env, false);
      assert.doesNotMatch(result.command.display, /DAILY_AI_CLI_PROOF_ONLY_NO_POST_PREFLIGHT=true/);
      assert.equal(result.command.env.DAILY_AI_CLI_BROWSER_VIDEO_QA, "no-post-preflight");
      assert.equal(result.command.env.DAILY_AI_CLI_RECORDING_REQUIRED, "0");
      assert.equal(result.command.env.DAILY_AI_CLI_EXTERNAL_VIDEO_QA_REQUIRED, "0");
    }
  );
});

test("Daily AI registered runner includes proof-only no-post preflight only when opt-in env is true", () => {
  const dir = mkdtempSync(join(tmpdir(), "automation-os-daily-ai-proof-only-"));
  const runner = join(dir, "runner.mjs");
  writeFileSync(
    runner,
    [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "if (process.env.DAILY_AI_CLI_PROOF_ONLY_NO_POST_PREFLIGHT !== 'true') throw new Error('proof-only no-post preflight opt-in missing');",
      "const outputDir = process.env.DAILY_AI_CLI_OUTPUT_DIR;",
      "mkdirSync(outputDir, { recursive: true });",
      `writeFileSync(join(outputDir, "registered-playwright-cli-summary.json"), JSON.stringify({ ...${JSON.stringify(completeSummary)}, automation_os_run_id: process.env.AUTOMATION_OS_RUN_ID, run_id: process.env.DAILY_AI_CLI_RUN_ID }, null, 2));`
    ].join("\n")
  );

  withEnv(
    {
      AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER: runner,
      AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT: join(dir, "runs"),
      AUTOMATION_OS_DAILY_AI_PROOF_ONLY_NO_POST_PREFLIGHT: "true"
    },
    () => {
      const result = runDailyAiRegisteredRunner({ runId: "daily-ai-proof-only", startedAtMs: Date.now() - 1_000 });

      assert.equal(result.status, "complete");
      assert.equal(result.command.env.DAILY_AI_CLI_PROOF_ONLY_NO_POST_PREFLIGHT, "true");
      assert.match(result.command.display, /DAILY_AI_CLI_PROOF_ONLY_NO_POST_PREFLIGHT=true/);
      assert.equal(result.command.env.DAILY_AI_CLI_BROWSER_VIDEO_QA, "no-post-preflight");
      assert.equal(result.command.env.DAILY_AI_CLI_RECORDING_REQUIRED, "0");
      assert.equal(result.command.env.DAILY_AI_CLI_EXTERNAL_VIDEO_QA_REQUIRED, "0");
    }
  );
});

test("Daily AI registered runner leaves proof-only no-post preflight disabled for missing runner by default", () => {
  const dir = mkdtempSync(join(tmpdir(), "automation-os-daily-ai-missing-proof-only-"));

  withEnv(
    {
      AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER: join(dir, "missing-runner.mjs"),
      AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT: join(dir, "runs"),
      AUTOMATION_OS_DAILY_AI_PROOF_ONLY_NO_POST_PREFLIGHT: undefined
    },
    () => {
      const result = runDailyAiRegisteredRunner({ runId: "daily-ai-missing-proof-only", startedAtMs: Date.now() - 1_000 });

      assert.equal(result.status, "blocked");
      assert.equal(result.stderrTail, "playwright_cli_callable_surface_missing");
      assert.equal("DAILY_AI_CLI_PROOF_ONLY_NO_POST_PREFLIGHT" in result.command.env, false);
      assert.doesNotMatch(result.command.display, /DAILY_AI_CLI_PROOF_ONLY_NO_POST_PREFLIGHT=true/);
      assert.equal(result.command.env.DAILY_AI_CLI_BROWSER_VIDEO_QA, "no-post-preflight");
      assert.equal(result.command.env.DAILY_AI_CLI_RECORDING_REQUIRED, "0");
      assert.equal(result.command.env.DAILY_AI_CLI_EXTERNAL_VIDEO_QA_REQUIRED, "0");
    }
  );
});

test("Daily AI registered runner includes proof-only no-post preflight for missing runner only when opt-in env is true", () => {
  const dir = mkdtempSync(join(tmpdir(), "automation-os-daily-ai-missing-proof-only-opt-in-"));

  withEnv(
    {
      AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER: join(dir, "missing-runner.mjs"),
      AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT: join(dir, "runs"),
      AUTOMATION_OS_DAILY_AI_PROOF_ONLY_NO_POST_PREFLIGHT: "true"
    },
    () => {
      const result = runDailyAiRegisteredRunner({ runId: "daily-ai-missing-proof-only-opt-in", startedAtMs: Date.now() - 1_000 });

      assert.equal(result.status, "blocked");
      assert.equal(result.stderrTail, "playwright_cli_callable_surface_missing");
      assert.equal(result.command.env.DAILY_AI_CLI_PROOF_ONLY_NO_POST_PREFLIGHT, "true");
      assert.match(result.command.display, /DAILY_AI_CLI_PROOF_ONLY_NO_POST_PREFLIGHT=true/);
      assert.equal(result.command.env.DAILY_AI_CLI_BROWSER_VIDEO_QA, "no-post-preflight");
      assert.equal(result.command.env.DAILY_AI_CLI_RECORDING_REQUIRED, "0");
      assert.equal(result.command.env.DAILY_AI_CLI_EXTERNAL_VIDEO_QA_REQUIRED, "0");
    }
  );
});

test("Daily AI registered runner source does not expose the removed Gemini skip env", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/runs/dailyAiRegisteredRunner.ts"), "utf8");

  assert.doesNotMatch(source, /DAILY_AI_CLI_BROWSER_VIDEO_QA_SKIP_GEMINI/);
  assert.match(source, /display: "Daily AI Playwright CLI registered runner is not configured"/);
  assert.match(source, /DAILY_AI_CLI_BROWSER_VIDEO_QA: "no-post-preflight"/);
  assert.match(source, /DAILY_AI_CLI_EXTERNAL_VIDEO_QA_REQUIRED: "0"/);
});

test("real Daily AI Playwright CLI runner honors env run id and output dir in summary-only mode", () => {
  const outputDir = mkdtempSync(join(tmpdir(), "automation-os-daily-ai-real-runner-"));
  const runnerPath = "/Users/nichikatanaka/Documents/New project/scripts/run_daily_ai_playwright_cli.mjs";
  const runId = "automation-os-contract-test";
  const automationRunId = "run_daily_ai_contract_test";
  const result = spawnSync("node", [runnerPath], {
    cwd: "/Users/nichikatanaka/Documents/New project",
    env: {
      ...process.env,
      AUTOMATION_OS_RUN_ID: automationRunId,
      DAILY_AI_CLI_RUN_ID: runId,
      DAILY_AI_CLI_OUTPUT_DIR: outputDir,
      DAILY_AI_CLI_SUMMARY_ONLY: "true"
    },
    encoding: "utf8",
    timeout: 30_000
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const summaryPath = join(outputDir, "registered-playwright-cli-summary.json");
  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as Record<string, unknown>;

  assert.equal(summary.run_id, runId);
  assert.equal(summary.automation_os_run_id, automationRunId);
  assert.equal(summary.current_stage, "summary_only");
  assert.equal(summary.stage_status, "completed");
});

test("blocks Daily AI registered runner when CLI run id does not match the env contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "automation-os-daily-ai-cli-identity-"));
  const runner = join(dir, "runner.mjs");
  writeFileSync(
    runner,
    [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const outputDir = process.env.DAILY_AI_CLI_OUTPUT_DIR;",
      "mkdirSync(outputDir, { recursive: true });",
      `writeFileSync(join(outputDir, "registered-playwright-cli-summary.json"), JSON.stringify({ ...${JSON.stringify(completeSummary)}, automation_os_run_id: process.env.AUTOMATION_OS_RUN_ID, run_id: "timestamp-run" }, null, 2));`
    ].join("\n")
  );
  const previous = process.env.AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER;
  const previousOutputRoot = process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT;
  process.env.AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER = runner;
  process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT = join(dir, "runs");
  try {
    const result = runDailyAiRegisteredRunner({ runId: "daily-ai-cli-identity", startedAtMs: Date.now() - 1_000 });
    assert.equal(result.status, "blocked");
    assert.equal(result.proof_gate.ok, false);
    assert.ok(result.proof_gate.missing.includes("daily_ai_cli_run_identity"));
    assert.equal(result.metadata.blocker, "daily_ai_cli_run_identity_mismatch");
  } finally {
    if (previous === undefined) {
      delete process.env.AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER;
    } else {
      process.env.AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER = previous;
    }
    if (previousOutputRoot === undefined) {
      delete process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT;
    } else {
      process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT = previousOutputRoot;
    }
  }
});

test("Daily AI registered runner has a bounded spawn timeout and timeout metadata", () => {
  const source = readFileSync(resolve(process.cwd(), "apps/server/src/runs/dailyAiRegisteredRunner.ts"), "utf8");

  assert.match(source, /AUTOMATION_OS_DAILY_AI_TIMEOUT_MS/);
  assert.match(source, /90 \* 60 \* 1000/);
  assert.match(source, /timeout: timeoutMs/);
  assert.match(source, /daily_ai_runner_timeout/);
  assert.match(source, /stderrTail/);
});

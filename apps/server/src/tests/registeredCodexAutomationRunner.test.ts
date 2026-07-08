import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-registered-codex-"));
process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(tempRoot, "artifacts");
process.env.AUTOMATION_OS_REGISTERED_SUMMARY_ROOT = join(tempRoot, "registered-summaries");

const { runRegisteredCodexAutomation } = await import("../runs/registeredCodexAutomationRunner.js");

function registeredSummary(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: "automation_os_registered_summary.v1",
    status: "complete",
    workflow_id: "job_submit_registered",
    run_id: "test-run",
    completion_claimed: true,
    exact_blocker: null,
    source_of_truth_proofs: [],
    cleanup_proof: { owned_processes_remaining: [] },
    ...overrides
  });
}

function writeFakeCodex(): string {
  const path = join(tempRoot, "fake-codex.cjs");
  writeFileSync(
    path,
    `#!/usr/bin/env node
	const fs = require("node:fs");
	if (process.env.FAKE_CODEX_REGISTERED_SUMMARY && process.env.AUTOMATION_OS_REGISTERED_SUMMARY_PATH) {
	  fs.writeFileSync(process.env.AUTOMATION_OS_REGISTERED_SUMMARY_PATH, process.env.FAKE_CODEX_REGISTERED_SUMMARY);
	}
	if (process.env.FAKE_CODEX_STDOUT) process.stdout.write(process.env.FAKE_CODEX_STDOUT);
	if (process.env.FAKE_CODEX_EXIT_STATUS) process.exit(Number(process.env.FAKE_CODEX_EXIT_STATUS));
	process.exit(0);
	`
  );
  chmodSync(path, 0o755);
  return path;
}

async function withFakeCodex<T>(fn: () => T | Promise<T>): Promise<T> {
  const previous = {
    codexBin: process.env.AUTOMATION_OS_CODEX_BIN,
	    fakeExitStatus: process.env.FAKE_CODEX_EXIT_STATUS,
	    fakeRegisteredSummary: process.env.FAKE_CODEX_REGISTERED_SUMMARY,
	    fakeStdout: process.env.FAKE_CODEX_STDOUT
	  };
  process.env.AUTOMATION_OS_CODEX_BIN = writeFakeCodex();
  try {
    return await fn();
  } finally {
    if (previous.codexBin === undefined) delete process.env.AUTOMATION_OS_CODEX_BIN;
    else process.env.AUTOMATION_OS_CODEX_BIN = previous.codexBin;
    if (previous.fakeExitStatus === undefined) delete process.env.FAKE_CODEX_EXIT_STATUS;
    else process.env.FAKE_CODEX_EXIT_STATUS = previous.fakeExitStatus;
	    if (previous.fakeRegisteredSummary === undefined) delete process.env.FAKE_CODEX_REGISTERED_SUMMARY;
	    else process.env.FAKE_CODEX_REGISTERED_SUMMARY = previous.fakeRegisteredSummary;
	    if (previous.fakeStdout === undefined) delete process.env.FAKE_CODEX_STDOUT;
	    else process.env.FAKE_CODEX_STDOUT = previous.fakeStdout;
	  }
	}

test("blocks successful job registered execution when Gemini video QA contradicts completion", async () =>
  withFakeCodex(async () => {
    const proofRoot = mkdtempSync(join(tempRoot, "job-submit-mismatch-qa-"));
    const recordingPath = join(proofRoot, "recording.mp4");
    const qaPath = join(proofRoot, "gemini-video-qa.json");
    writeFileSync(recordingPath, "mp4");
    writeFileSync(
      qaPath,
      JSON.stringify({
        provider: "gemini",
        kind: "gemini_video_qa",
        status: "failed",
        verdict: "mismatch",
        completion_gate_alignment: "mismatch",
        completion_gate_matches: false,
        exact_blocker: "gemini_saw_submit_confirmation_missing",
        video_artifact_uri: recordingPath
      })
    );
    process.env.FAKE_CODEX_STDOUT = "submitted_confirmed=1\napplication_appends=1\n";
    process.env.FAKE_CODEX_REGISTERED_SUMMARY = registeredSummary({
      run_id: "job-gemini-mismatch",
      workflow_id: "job_submit_registered",
      submitted_confirmed: 20,
      submitted_count_by_bucket: { japan_targeted: 20, overseas_global: 20 },
      application_appends: 20,
      gemini_video_qa: {
        stages: [
          {
            stage: "submit_confirmation",
            status: "failed",
            verdict: "mismatch",
            completion_gate_alignment: "mismatch",
            exact_blocker: "gemini_saw_submit_confirmation_missing",
            artifact_uri: pathToFileURL(qaPath).href,
            video_artifact_uri: pathToFileURL(recordingPath).href
          }
        ]
      }
    });

    const result = runRegisteredCodexAutomation({ runId: "job-gemini-mismatch-run", workflowId: "job_submit_registered" });

    assert.equal(result.status, "blocked");
    assert.equal(result.proof_gate.ok, false);
    assert.ok(result.proof_gate.missing.includes("gemini_video_qa_completion_alignment"));
    assert.ok(result.proof_gate.present.includes("gemini_video_qa"));
    assert.match(result.proof_summary, /Gemini video QA contradicts completion gate/);
    assert.equal(result.metadata.gemini_video_qa && typeof result.metadata.gemini_video_qa === "object", true);
    assert.deepEqual(result.command.args.slice(0, 5), ["exec", "--sandbox", "danger-full-access", "--cd", "/Users/nichikatanaka/Documents/New project"]);
    assert.match(result.command.args[result.command.args.length - 1], /Browser\/UI stages must use Playwright CLI/);
    assert.match(result.command.args[result.command.args.length - 1], /Capture Playwright artifacts/);
    assert.match(result.command.args[result.command.args.length - 1], /workflow-owned source-of-truth proof remains required/);
    assert.match(result.command.args[result.command.args.length - 1], /--submit-authorized/);
    assert.equal(result.command.env.AUTOMATION_OS_BROWSER_DRIVER, "playwright_cli");
    assert.match(String(result.command.env.PLAYWRIGHT_CLI_WRAPPER), /playwright_cli\.sh/);
    assert.equal(result.command.args.includes("--full-auto"), false);
    assert.doesNotMatch(result.command.display, /--full-auto/);
    assert.match(result.command.display, /--sandbox danger-full-access --cd "\/Users\/nichikatanaka\/Documents\/New project"/);
	  }));

test("blocks job submit registered execution when Codex exits zero without submitted_confirmed proof", async () =>
  withFakeCodex(async () => {
    process.env.FAKE_CODEX_STDOUT = [
      "今あなたがやることはありません。",
      "submitted_confirmed=0",
      "今回の submit queue は応募送信前に停止しました。",
      "exact_blocker=browser_use_cdp_lane_unavailable"
    ].join("\n");
    process.env.FAKE_CODEX_REGISTERED_SUMMARY = registeredSummary({
      workflow: "job-applications",
      workflow_id: "job_submit_registered",
      run_id: "job-submit-blocked-run",
      status: "blocked",
      completion_claimed: false,
      exact_blocker: "browser_use_cdp_lane_unavailable"
    });

    const result = runRegisteredCodexAutomation({ runId: "job-submit-blocked-run", workflowId: "job_submit_registered" });

    assert.equal(result.status, "blocked");
    assert.equal(result.proof_gate.ok, false);
    assert.ok(result.proof_gate.missing.includes("registered_workflow_reported_blocked"));
    assert.ok(result.proof_gate.missing.includes("submitted_confirmed_target_20_readback"));
    assert.ok(result.proof_gate.present.includes("job_submit_registered_codex_execution_blocked"));
    assert.match(result.proof_summary, /registered_workflow_reported_blocked/);
    assert.match(String(result.command.env.AUTOMATION_OS_REGISTERED_SUMMARY_PATH), /registered-summaries/);
  }));

test("blocks job submit partial success below the 20 submitted_confirmed target", async () =>
  withFakeCodex(async () => {
    process.env.FAKE_CODEX_STDOUT = [
      "今回の submit queue は partial_success です。",
      "application_appends=1",
      "blocked visual audit: job_video_qa_explicit_redacted_video_required"
    ].join("\n");
    process.env.FAKE_CODEX_REGISTERED_SUMMARY = registeredSummary({
      workflow: "job-applications",
      workflow_id: "job_submit_registered",
      run_id: "job-submit-partial-success-run",
      status: "partial_success",
      completion_claimed: false,
      exact_blocker: "target_unmet_with_retryable_and_user_review_blockers",
      application_appends: 1,
      submitted_count: 1,
      stage_visual_audits: [
        {
          provider: "gemini_video_qa",
          stage: "job_registered_video_qa",
          status: "blocked",
          verdict: "blocked",
          completion_gate_alignment: "mismatch",
          completion_gate_matches: false,
          exact_blocker: "job_video_qa_explicit_redacted_video_required",
          auxiliary_proof: true
        }
      ]
    });

    const result = runRegisteredCodexAutomation({ runId: "job-submit-partial-success-run", workflowId: "job_submit_registered" });

    assert.equal(result.status, "blocked");
    assert.equal(result.proof_gate.ok, false);
    assert.ok(result.proof_gate.missing.includes("submitted_confirmed_target_20_readback"));
    assert.ok(result.proof_gate.present.includes("gemini_video_qa"));
    assert.match(result.proof_summary, /submitted_confirmed_target_20_readback/);
    const gemini = result.metadata.gemini_video_qa as { status?: string; blocker_count?: number; stage_ledger?: Array<{ completion_claimed?: boolean }> };
    assert.equal(gemini.status, "present");
    assert.equal(gemini.blocker_count, 0);
    assert.equal(gemini.stage_ledger?.[0]?.completion_claimed, false);
  }));

test("blocks job submit registered execution unless both split buckets reach 20", async () =>
  withFakeCodex(async () => {
    process.env.FAKE_CODEX_STDOUT = "submitted_confirmed=40\napplication_appends=40\n";
    process.env.FAKE_CODEX_REGISTERED_SUMMARY = registeredSummary({
      workflow: "job-applications",
      workflow_id: "job_submit_registered",
      run_id: "job-submit-overseas-short-run",
      status: "complete",
      submitted_confirmed: 40,
      submitted_count_by_bucket: { japan_targeted: 30, overseas_global: 10 },
      application_appends: 40
    });

    const result = runRegisteredCodexAutomation({ runId: "job-submit-overseas-short-run", workflowId: "job_submit_registered" });

    assert.equal(result.status, "blocked");
    assert.equal(result.proof_gate.ok, false);
    assert.ok(result.proof_gate.missing.includes("submitted_confirmed_target_20_readback"));
  }));

test("completes job submit registered execution with 20 submitted_confirmed proof and no optional Browser Use recording QA", async () =>
  withFakeCodex(async () => {
    process.env.FAKE_CODEX_STDOUT = "submitted_confirmed=1\napplication_appends=1\n";
    process.env.FAKE_CODEX_REGISTERED_SUMMARY = registeredSummary({
      workflow: "job-applications",
      workflow_id: "job_submit_registered",
      run_id: "job-submit-no-visual-qa",
      status: "complete",
      submitted_count_by_bucket: { japan_targeted: 20, overseas_global: 20 },
      application_appends: 20
    });

    const result = runRegisteredCodexAutomation({ runId: "job-submit-no-visual-qa-run", workflowId: "job_submit_registered" });

    assert.equal(result.status, "complete");
    assert.equal(result.proof_gate.ok, true);
    assert.deepEqual(result.proof_gate.missing, []);
    assert.match(result.proof_summary, /complete: registered automation Codex execution exited successfully/);
  }));

test("completes job submit registered execution with 20 submitted_confirmed when optional Browser Use recording QA paths do not exist", async () =>
  withFakeCodex(async () => {
    process.env.FAKE_CODEX_STDOUT = "submitted_confirmed=1\napplication_appends=1\n";
    process.env.FAKE_CODEX_REGISTERED_SUMMARY = registeredSummary({
      workflow: "job-applications",
      workflow_id: "job_submit_registered",
      status: "complete",
      submitted_count_by_bucket: { japan_targeted: 20, overseas_global: 20 },
      application_appends: 20,
      gemini_video_qa: {
        stages: [
          {
            stage: "submit_confirmation",
            status: "passed",
            verdict: "pass",
            completion_gate_alignment: "aligned",
            completion_gate_matches: true,
            artifact_uri: pathToFileURL(join(tempRoot, "missing-gemini-video-qa.json")).href,
            video_artifact_uri: pathToFileURL(join(tempRoot, "missing-recording.mp4")).href
          }
        ]
      }
    });

    const result = runRegisteredCodexAutomation({ runId: "job-submit-missing-qa-files-run", workflowId: "job_submit_registered" });

    assert.equal(result.status, "complete");
    assert.equal(result.proof_gate.ok, true);
    assert.deepEqual(result.proof_gate.missing, []);
  }));

test("completes job submit registered execution with 20 submitted_confirmed proof and valid Browser Use recording QA", async () =>
  withFakeCodex(async () => {
    const proofRoot = mkdtempSync(join(tempRoot, "job-submit-valid-qa-"));
    const recordingPath = join(proofRoot, "recording.mp4");
    const qaPath = join(proofRoot, "gemini-video-qa.json");
    writeFileSync(recordingPath, "mp4");
    writeFileSync(
      qaPath,
      JSON.stringify({
        provider: "gemini",
        kind: "gemini_video_qa",
        status: "passed",
        verdict: "pass",
        completion_gate_alignment: "aligned",
        completion_gate_matches: true,
        video_artifact_uri: recordingPath
      })
    );
    process.env.FAKE_CODEX_STDOUT = "submitted_confirmed=1\napplication_appends=1\n";
    process.env.FAKE_CODEX_REGISTERED_SUMMARY = registeredSummary({
      workflow_id: "job_submit_registered",
      workflow: "job-applications",
      status: "complete",
      submitted_count_by_bucket: { japan_targeted: 20, overseas_global: 20 },
      application_appends: 20,
      gemini_video_qa: {
        stages: [
          {
            stage: "submit_confirmation",
            status: "passed",
            verdict: "pass",
            completion_gate_alignment: "aligned",
            completion_gate_matches: true,
            artifact_uri: pathToFileURL(qaPath).href,
            video_artifact_uri: pathToFileURL(recordingPath).href
          }
        ]
      }
    });

    const result = runRegisteredCodexAutomation({ runId: "job-submit-valid-qa-run", workflowId: "job_submit_registered" });

    assert.equal(result.status, "complete");
    assert.equal(result.proof_gate.ok, true);
    assert.ok(!result.proof_gate.missing.includes("browser_use_gemini_video_qa_missing"));
    assert.ok(!result.proof_gate.missing.includes("browser_use_recording_proof_missing"));
  }));

test("keeps failed job registered execution blocked even when Gemini video QA matches", async () =>
  withFakeCodex(async () => {
    process.env.FAKE_CODEX_EXIT_STATUS = "7";
    process.env.FAKE_CODEX_REGISTERED_SUMMARY = registeredSummary({
      workflow_id: "job_followup_registered",
      run_id: "job-gemini-matches",
      visual_audit: {
        provider: "gemini",
        stages: [
          {
            stage: "inbox_review",
            status: "passed",
            verdict: "matches",
            completion_gate_alignment: "matches",
            completion_gate_matches: true,
            artifact_uri: "file:///tmp/job-gemini-report.json"
          }
        ]
      }
    });

    const result = runRegisteredCodexAutomation({ runId: "job-gemini-matches-run", workflowId: "job_followup_registered" });

    assert.equal(result.status, "blocked");
    assert.equal(result.proof_gate.ok, false);
    assert.ok(result.proof_gate.missing.includes("job_followup_registered_codex_execution"));
    assert.ok(result.proof_gate.present.includes("gemini_video_qa"));
    assert.ok(!result.proof_gate.missing.includes("gemini_video_qa"));
    assert.match(result.proof_summary, /registered automation Codex execution did not complete/);
    assert.equal(result.metadata.gemini_video_qa && typeof result.metadata.gemini_video_qa === "object", true);
  }));

test("blocks job follow-up registered execution when Codex exits zero without registered summary and writes fail-closed fallback sidecar", async () =>
  withFakeCodex(async () => {
    process.env.FAKE_CODEX_STDOUT = "no follow-up action needed\n";

    const result = runRegisteredCodexAutomation({ runId: "job-followup-no-summary-run", workflowId: "job_followup_registered" });
    const summaryPath = String(result.command.env.AUTOMATION_OS_REGISTERED_SUMMARY_PATH);

    assert.equal(result.status, "blocked");
    assert.equal(result.proof_gate.ok, false);
    assert.ok(result.proof_gate.missing.includes("registered_summary_present"));
    assert.equal(result.metadata.registered_summary_present, false);
    assert.equal(result.metadata.registered_summary_fallback_written, true);
    assert.equal(result.metadata.registered_summary_fallback_path, summaryPath);
    assert.equal(result.metadata.registered_summary_fallback_reason, "registered_summary_missing");
    assert.equal(existsSync(summaryPath), true);

    const fallback = JSON.parse(readFileSync(summaryPath, "utf8")) as Record<string, unknown>;
    assert.equal(fallback.origin, "automation_os_fail_closed_fallback");
    assert.equal(fallback.status, "blocked");
    assert.equal(fallback.completion_claimed, false);
    assert.equal(fallback.exact_blocker, "registered_summary_missing");
    assert.equal(fallback.child_registered_summary_present, false);
    assert.equal(fallback.codex_exit_status, 0);
    assert.equal(fallback.timed_out, false);
    assert.equal(fallback.artifact_path, result.artifactPath);
    assert.equal(typeof fallback.generated_at, "string");
  }));

test("blocks job submit registered execution with submitted stdout when registered summary is missing", async () =>
  withFakeCodex(async () => {
    process.env.FAKE_CODEX_STDOUT = "submitted_confirmed=1\napplication_appends=1\n";

    const result = runRegisteredCodexAutomation({ runId: "job-submit-submitted-no-summary-run", workflowId: "job_submit_registered" });

    assert.equal(result.status, "blocked");
    assert.equal(result.proof_gate.ok, false);
    assert.ok(result.proof_gate.missing.includes("registered_summary_present"));
    assert.ok(result.proof_gate.missing.includes("submitted_confirmed_target_20_readback"));
    assert.equal(result.metadata.registered_summary_present, false);
    assert.equal(result.metadata.registered_summary_fallback_written, true);
    assert.equal(result.metadata.registered_summary_fallback_reason, "registered_summary_missing");
  }));

test("exposes Job registered issue ledger summary from sidecar metadata", async () =>
  withFakeCodex(async () => {
    process.env.FAKE_CODEX_STDOUT = "submitted_confirmed=0\n";
    process.env.FAKE_CODEX_REGISTERED_SUMMARY = registeredSummary({
      status: "blocked",
      run_id: "job-issue-ledger",
      completion_claimed: false,
      exact_blocker: "submitted_confirmed_guard_read_failed",
      issue_ledger: [
        {
          stage: "pre_submit_guard",
          blocker_reason: "submitted_confirmed_guard_read_failed",
          policy: {
            resubmit_allowed: false,
            next_safe_action: "restore_submitted_confirmed_readback_before_any_submit_retry"
          }
        }
      ]
    });

    const result = runRegisteredCodexAutomation({ runId: "job-issue-ledger-run", workflowId: "job_submit_registered" });
    const issueSummary = result.metadata.issue_ledger_summary as Record<string, unknown>;
    assert.equal(result.status, "blocked");
    assert.equal(issueSummary.count, 1);
    assert.equal(issueSummary.latest_blocker, "submitted_confirmed_guard_read_failed");
    assert.equal(issueSummary.resubmit_allowed, false);
  }));

test("keeps legacy submitted_confirmed job summary compatible", async () =>
  withFakeCodex(async () => {
    process.env.FAKE_CODEX_STDOUT = "submitted_confirmed=20\napplication_appends=20\n";
    process.env.FAKE_CODEX_REGISTERED_SUMMARY = registeredSummary({
      run_id: "job-legacy-submitted-confirmed",
      workflow_id: "job_submit_registered",
      submitted_confirmed: 20,
      application_appends: 20
    });

    const result = runRegisteredCodexAutomation({ runId: "job-legacy-submitted-confirmed-run", workflowId: "job_submit_registered" });

    assert.equal(result.status, "complete");
    assert.equal(result.proof_gate.ok, true);
  }));

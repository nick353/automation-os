import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Proof } from "./proofGate.js";
import { registeredBrowserLaneForWorkflow, visibleBrowserLaneForRecordReplay } from "./laneManager.js";
import { evaluateGeminiVideoQaAudit } from "./geminiVideoQa.js";
import { issueLedgerMetadata } from "./issueLedger.js";

export type DailyAiRegisteredStatus = "complete" | "partial" | "blocked";

export type DailyAiProofGate = {
  ok: boolean;
  missing: string[];
  present: string[];
};

export type DailyAiRegisteredEvaluation = {
  status: DailyAiRegisteredStatus;
  proof_gate: DailyAiProofGate;
  proof_summary: string;
  proofs: Proof[];
  metadata: Record<string, unknown>;
  summaryPath?: string;
};

export type DailyAiRegisteredRunResult = DailyAiRegisteredEvaluation & {
  command: {
    bin: string;
    args: string[];
    cwd: string;
    display: string;
    env: {
      PATH: string;
      DAILY_AI_CLI_RUN_ID: string;
      DAILY_AI_CLI_OUTPUT_DIR: string;
      DAILY_AI_BROWSER_DRIVER: string;
      DAILY_AI_CLI_BROWSER_VIDEO_QA: string;
      DAILY_AI_CLI_REQUIRE_BROWSER_USE: string;
      DAILY_AI_CLI_RECORDING_REQUIRED: string;
      DAILY_AI_CLI_EXTERNAL_VIDEO_QA_REQUIRED: string;
      DAILY_AI_CLI_REPLENISH_BUFFER_TIMEOUT_MS: string;
      DAILY_AI_RUNWAY_MCP_TIMEOUT_SECONDS: string;
      DAILY_AI_CDP_PORT: string;
      DAILY_AI_CLI_PROFILE_DIR: string;
      DAILY_AI_CLI_HEADLESS: string;
      DAILY_AI_CLI_SHOW_BROWSER: string;
      DAILY_AI_CLI_PROOF_ONLY_NO_POST_PREFLIGHT?: string;
      DAILY_AI_CLI_STEP_TIMEOUT_MS: string;
      AUTOMATION_OS_RUN_ID: string;
    };
  };
  exitStatus: number | null;
  signal: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
};

const summaryFileName = "registered-playwright-cli-summary.json";
const projectRoot = "/Users/nichikatanaka/Documents/New project";
const fixedOutputRoot = join(projectRoot, "artifacts", "automation-os-daily-ai-runs");
const defaultPlaywrightRunner = join(projectRoot, "scripts", "run_daily_ai_playwright_cli.mjs");
const defaultRunnerTimeoutMs = 90 * 60 * 1000;
const defaultCliStepTimeoutMs = 45 * 60 * 1000;
const playwrightRunnerMissing = "playwright_cli_callable_surface_missing";
const dailyAiRunnerPathPrefix = ["/Users/nichikatanaka/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"];

const proofSpecs = [
  ["daily_ai_publish", "Daily AI publish proof", "direct_publish"],
  ["daily_ai_feed_study", "Daily AI feed-study proof", "post_publish_feed_study"],
  ["daily_ai_engagement", "Daily AI engagement proof", "direct_engagement"],
  ["daily_ai_sync", "Daily AI postflight sync proof", "postflight_sync"],
  ["daily_ai_buffer", "Daily AI buffer proof", "final_buffer_refresh"],
  ["daily_ai_cleanup", "Daily AI cleanup proof", "cleanup_proof"],
  ["daily_ai_registered_summary", "Daily AI registered summary", null]
] as const;

export function dailyAiRegisteredOutputDir(runId: string): { cliRunId: string; outputDir: string } {
  const cliRunId = sanitizeRunId(runId);
  const outputRoot = (process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT || "").trim() || fixedOutputRoot;
  return {
    cliRunId,
    outputDir: join(outputRoot, cliRunId)
  };
}

export function runDailyAiRegisteredRunner(input: { runId: string; startedAtMs?: number }): DailyAiRegisteredRunResult {
  const startedAtMs = input.startedAtMs ?? Date.now();
  const dailyAiBrowserLane = visibleBrowserLaneForRecordReplay(registeredBrowserLaneForWorkflow("daily-ai-research-publish-run"));
  const { cliRunId, outputDir } = dailyAiRegisteredOutputDir(input.runId);
  const timeoutMs = dailyAiRunnerTimeoutMs();
  const runnerPath = buildDailyAiRunnerPath(process.env.PATH);
  const proofOnlyNoPostPreflightEnv = dailyAiProofOnlyNoPostPreflightEnv();
  const proofOnlyNoPostPreflightDisplay = proofOnlyNoPostPreflightEnv.DAILY_AI_CLI_PROOF_ONLY_NO_POST_PREFLIGHT
    ? "DAILY_AI_CLI_PROOF_ONLY_NO_POST_PREFLIGHT=true "
    : "";
  mkdirSync(outputDir, { recursive: true });
  const configuredRunner = (process.env.AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER || "").trim();
  const runner = configuredRunner
    ? (existsSync(configuredRunner) ? configuredRunner : "")
    : (existsSync(defaultPlaywrightRunner) ? defaultPlaywrightRunner : "");

  if (!runner) {
    const command = {
      bin: "node" as const,
      args: ["<Daily AI Playwright CLI registered runner missing>"],
      cwd: projectRoot,
      display: "Daily AI Playwright CLI registered runner is not configured",
      env: {
        PATH: runnerPath,
        DAILY_AI_CLI_RUN_ID: cliRunId,
        DAILY_AI_CLI_OUTPUT_DIR: outputDir,
        DAILY_AI_BROWSER_DRIVER: "playwright_cli",
        DAILY_AI_CLI_BROWSER_VIDEO_QA: "no-post-preflight",
        DAILY_AI_CLI_REQUIRE_BROWSER_USE: "0",
        DAILY_AI_CLI_RECORDING_REQUIRED: "0",
        DAILY_AI_CLI_EXTERNAL_VIDEO_QA_REQUIRED: "0",
        DAILY_AI_CLI_REQUIRE_FEED_STUDY: "false",
        DAILY_AI_CLI_REQUIRE_SHIP_NOW_BUFFER: "false",
        DAILY_AI_CLI_REPLENISH_BUFFER_TIMEOUT_MS: "600000",
        DAILY_AI_RUNWAY_MCP_TIMEOUT_SECONDS: "300",
        DAILY_AI_CDP_PORT: String(dailyAiBrowserLane?.cdpPort ?? 9333),
        DAILY_AI_CLI_PROFILE_DIR: dailyAiBrowserLane?.profileDir ?? "/Users/nichikatanaka/.daily-ai-playwright-chrome",
        DAILY_AI_CLI_HEADLESS: dailyAiBrowserLane?.laneVisibility === "headless" ? "true" : "false",
        DAILY_AI_CLI_SHOW_BROWSER: dailyAiBrowserLane?.laneVisibility === "visible" ? "true" : "false",
        ...proofOnlyNoPostPreflightEnv,
        DAILY_AI_CLI_STEP_TIMEOUT_MS: String(defaultCliStepTimeoutMs),
        AUTOMATION_OS_RUN_ID: input.runId
      }
    };
    if (proofOnlyNoPostPreflightDisplay) {
      command.display += ` ${proofOnlyNoPostPreflightDisplay.trim()}`;
    }
    const evaluation = blockedEvaluation(playwrightRunnerMissing, undefined, {
      browser_driver: "playwright_cli",
      default_runner: defaultPlaywrightRunner,
      required_env: "AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER"
    });
    return {
      ...evaluation,
      command,
      exitStatus: null,
      signal: null,
      stdoutTail: "",
      stderrTail: playwrightRunnerMissing
    };
  }

  const command = {
    bin: process.env.AUTOMATION_OS_NODE_BIN || "node",
    args: [runner],
    cwd: projectRoot,
    display:
      `DAILY_AI_CLI_RUN_ID=${JSON.stringify(cliRunId)} DAILY_AI_CLI_OUTPUT_DIR=${JSON.stringify(outputDir)} ` +
      `DAILY_AI_BROWSER_DRIVER=playwright_cli DAILY_AI_CLI_BROWSER_VIDEO_QA=no-post-preflight ` +
      `DAILY_AI_CLI_REQUIRE_BROWSER_USE=0 DAILY_AI_CLI_RECORDING_REQUIRED=0 DAILY_AI_CLI_EXTERNAL_VIDEO_QA_REQUIRED=0 ` +
      `DAILY_AI_CDP_PORT=${String(dailyAiBrowserLane?.cdpPort ?? 9333)} DAILY_AI_CLI_PROFILE_DIR=${JSON.stringify(
        dailyAiBrowserLane?.profileDir ?? "/Users/nichikatanaka/.daily-ai-playwright-chrome"
      )} DAILY_AI_CLI_HEADLESS=${dailyAiBrowserLane?.laneVisibility === "headless" ? "true" : "false"} DAILY_AI_CLI_SHOW_BROWSER=${
        dailyAiBrowserLane?.laneVisibility === "visible" ? "true" : "false"
      } ` +
      proofOnlyNoPostPreflightDisplay +
      `DAILY_AI_CLI_REPLENISH_BUFFER_TIMEOUT_MS=600000 ` +
      `DAILY_AI_RUNWAY_MCP_TIMEOUT_SECONDS=300 ` +
      `DAILY_AI_CLI_STEP_TIMEOUT_MS=${defaultCliStepTimeoutMs} ` +
      `PATH=${JSON.stringify(runnerPath)} ` +
      `AUTOMATION_OS_DAILY_AI_TIMEOUT_MS=${timeoutMs} node ${JSON.stringify(runner)}`,
    env: {
      PATH: runnerPath,
      DAILY_AI_CLI_RUN_ID: cliRunId,
      DAILY_AI_CLI_OUTPUT_DIR: outputDir,
      DAILY_AI_BROWSER_DRIVER: "playwright_cli",
      DAILY_AI_CLI_BROWSER_VIDEO_QA: "no-post-preflight",
      DAILY_AI_CLI_REQUIRE_BROWSER_USE: "0",
      DAILY_AI_CLI_RECORDING_REQUIRED: "0",
      DAILY_AI_CLI_EXTERNAL_VIDEO_QA_REQUIRED: "0",
      DAILY_AI_CLI_REQUIRE_FEED_STUDY: "false",
      DAILY_AI_CLI_REQUIRE_SHIP_NOW_BUFFER: "false",
      DAILY_AI_CLI_REPLENISH_BUFFER_TIMEOUT_MS: "600000",
      DAILY_AI_RUNWAY_MCP_TIMEOUT_SECONDS: "300",
      DAILY_AI_CDP_PORT: String(dailyAiBrowserLane?.cdpPort ?? 9333),
      DAILY_AI_CLI_PROFILE_DIR: dailyAiBrowserLane?.profileDir ?? "/Users/nichikatanaka/.daily-ai-playwright-chrome",
      DAILY_AI_CLI_HEADLESS: dailyAiBrowserLane?.laneVisibility === "headless" ? "true" : "false",
      DAILY_AI_CLI_SHOW_BROWSER: dailyAiBrowserLane?.laneVisibility === "visible" ? "true" : "false",
      ...proofOnlyNoPostPreflightEnv,
      DAILY_AI_CLI_STEP_TIMEOUT_MS: String(defaultCliStepTimeoutMs),
      AUTOMATION_OS_RUN_ID: input.runId
    }
  };

  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...command.env };
  delete childEnv.GEMINI_API_KEY;
  const result = spawnSync(command.bin, command.args, {
    cwd: projectRoot,
    env: childEnv,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    timeout: timeoutMs
  });

  const summaryPath = findDailyAiRegisteredSummary({ outputDir, startedAtMs });
  const timedOut = isSpawnTimeout(result.error);
  const baseEvaluation = timedOut ? timeoutEvaluation(evaluateDailyAiRegisteredSummary(summaryPath), timeoutMs, result.stderr) : evaluateDailyAiRegisteredSummary(summaryPath);
  const evaluation = enforceRunnerCompletionGate(baseEvaluation, { exitStatus: result.status, timedOut, runId: input.runId, cliRunId });
  return {
    ...evaluation,
    command,
    exitStatus: result.status,
    signal: result.signal,
    stdoutTail: tail(result.stdout),
    stderrTail: timedOut ? tail(`${result.stderr ?? ""}\nAutomation OS Daily AI runner timed out after ${timeoutMs}ms`) : tail(result.stderr)
  };
}

function buildDailyAiRunnerPath(existingPath: string | undefined): string {
  const existing = existingPath?.trim();
  return existing ? `${dailyAiRunnerPathPrefix.join(":")}:${existing}` : dailyAiRunnerPathPrefix.join(":");
}

function dailyAiProofOnlyNoPostPreflightEnv(): { DAILY_AI_CLI_PROOF_ONLY_NO_POST_PREFLIGHT?: "true" } {
  return process.env.AUTOMATION_OS_DAILY_AI_PROOF_ONLY_NO_POST_PREFLIGHT === "true"
    ? { DAILY_AI_CLI_PROOF_ONLY_NO_POST_PREFLIGHT: "true" }
    : {};
}

export function findDailyAiRegisteredSummary(input: { outputDir?: string; startedAtMs?: number } = {}): string | undefined {
  const fixedSummary = input.outputDir ? join(input.outputDir, summaryFileName) : undefined;
  if (fixedSummary && existsSync(fixedSummary)) return fixedSummary;
  return undefined;
}

export function evaluateDailyAiRegisteredSummary(summaryPath: string | undefined): DailyAiRegisteredEvaluation {
  if (!summaryPath) {
    return blockedEvaluation("summary_missing", undefined, undefined);
  }

  const summaryUri = pathToFileURL(summaryPath).href;
  let summary: unknown;
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch (error) {
    return blockedEvaluation("summary_invalid", summaryPath, {
      parse_error: String(error instanceof Error ? error.message : error)
    });
  }

  if (!isRecord(summary)) {
    return blockedEvaluation("summary_invalid", summaryPath, { reason: "summary_root_not_object" });
  }

  const fullFlow = isRecord(summary.full_flow_completion) ? summary.full_flow_completion : undefined;
  const cleanupProofPresent = hasValue(summary.cleanup_proof);
  const preflightBlocker = detectPreflightBlocker(summary);
  const proofStates = buildDailyAiProofs(summary, summaryPath);
  const fullFlowOk = fullFlow?.ok === true;
  const fullFlowFalse = fullFlow?.ok === false;
  const visualAudit = evaluateGeminiVideoQaAudit({
    summary,
    summaryPath,
    workflow: "daily_ai_registered",
    completionClaimed: fullFlowOk
  });
  const proofs = [...proofStates.filter((proof) => Boolean(proof.metadata?.stage_present)), ...visualAudit.proofs];
  const present = proofs.map((proof) => proof.proofType);
  const missing = proofStates.filter((proof) => !proof.metadata?.stage_present).map((proof) => proof.proofType);

  if (preflightBlocker) {
    return {
      status: "blocked",
      proof_gate: { ok: false, missing: [...new Set([...missing, "preflight_clearance"])], present },
      proof_summary: `blocked: ${preflightBlocker}`,
      proofs,
      metadata: baseMetadata(summary, summaryPath, {
        blocker: preflightBlocker,
        summary_uri: summaryUri,
        cleanup_proof_present: cleanupProofPresent,
        full_flow_ok: fullFlowOk
      }),
      summaryPath
    };
  }

  if (!fullFlow) {
    return {
      status: "blocked",
      proof_gate: { ok: false, missing: [...new Set([...missing, "full_flow_completion"])], present },
      proof_summary: "blocked: full_flow_completion is missing",
      proofs,
      metadata: baseMetadata(summary, summaryPath, {
        blocker: "full_flow_missing",
        summary_uri: summaryUri,
        cleanup_proof_present: cleanupProofPresent,
        full_flow_ok: false
      }),
      summaryPath
    };
  }

  if (fullFlowOk && visualAudit.blockers.length > 0) {
    return {
      status: "blocked",
      proof_gate: { ok: false, missing: [...new Set([...missing, "gemini_video_qa_completion_alignment"])], present },
      proof_summary: `blocked: ${visualAudit.blockers.join("; ")}`,
      proofs,
      metadata: baseMetadata(summary, summaryPath, {
        blocker: "gemini_video_qa_completion_alignment",
        summary_uri: summaryUri,
        cleanup_proof_present: cleanupProofPresent,
        full_flow_ok: true,
        gemini_video_qa: visualAudit.metadata
      }),
      summaryPath
    };
  }

  if (fullFlowOk && cleanupProofPresent && missing.length === 0) {
    return {
      status: "complete",
      proof_gate: { ok: true, missing: [], present },
      proof_summary: "complete: full_flow_completion.ok, required stages, and cleanup_proof are present",
      proofs,
      metadata: baseMetadata(summary, summaryPath, {
        summary_uri: summaryUri,
        cleanup_proof_present: true,
        full_flow_ok: true,
        ...(visualAudit.proofs.length > 0 ? { gemini_video_qa: visualAudit.metadata } : {})
      }),
      summaryPath
    };
  }

  if (fullFlowOk && missing.length > 0) {
    return {
      status: "blocked",
      proof_gate: { ok: false, missing, present },
      proof_summary: `blocked: full_flow_completion.ok but required stages are missing: ${missing.join(", ")}`,
      proofs,
      metadata: baseMetadata(summary, summaryPath, {
        blocker: "full_flow_ok_required_stage_missing",
        summary_uri: summaryUri,
        cleanup_proof_present: cleanupProofPresent,
        full_flow_ok: true,
        missing_required_stages: missing
      }),
      summaryPath
    };
  }

  if (fullFlowFalse) {
    const failures = Array.isArray(fullFlow.failures) ? fullFlow.failures.map(String) : [];
    const normalizedFailure = dailyAiFailureBlocker(failures);
    const failureMissing = normalizedFailure ? [normalizedFailure] : [];
    return {
      status: "partial",
      proof_gate: { ok: false, missing: [...new Set([...missing, ...failureMissing])], present },
      proof_summary: failures.length ? `partial: ${failures.join("; ")}` : "partial: full_flow_completion.ok is false",
      proofs,
      metadata: baseMetadata(summary, summaryPath, {
        summary_uri: summaryUri,
        cleanup_proof_present: cleanupProofPresent,
        full_flow_ok: false,
        ...(normalizedFailure ? { blocker: normalizedFailure } : {}),
        failures
      }),
      summaryPath
    };
  }

  return {
    status: "blocked",
    proof_gate: { ok: false, missing: [...new Set([...missing, cleanupProofPresent ? "full_flow_completion_ok" : "cleanup_proof"])], present },
    proof_summary: cleanupProofPresent ? "blocked: full_flow_completion.ok is not true" : "blocked: cleanup_proof is missing",
    proofs,
    metadata: baseMetadata(summary, summaryPath, {
      blocker: cleanupProofPresent ? "full_flow_not_ok" : "cleanup_proof_missing",
      summary_uri: summaryUri,
      cleanup_proof_present: cleanupProofPresent,
      full_flow_ok: false
    }),
    summaryPath
  };
}

function dailyAiFailureBlocker(failures: string[]): string | undefined {
  const joined = failures.join("\n").toLowerCase();
  if (/runway_mcp_repair_required|image_generation_unavailable|runway_mcp_result_handoff_missing/.test(joined)) {
    return "runway_mcp_repair_required";
  }
  if (/engagement_action_target_missing|engagement_candidate|like_candidate|comment_candidate|engagement_platform_missing/.test(joined)) {
    return "engagement_candidate_insufficient";
  }
  if (/buffer|ship_now|publishable/.test(joined)) return "publishable_buffer_insufficient";
  return undefined;
}

function buildDailyAiProofs(summary: Record<string, unknown>, summaryPath: string): Proof[] {
  const uri = pathToFileURL(summaryPath).href;
  return proofSpecs.map(([proofType, label, stage]) => ({
    proofType,
    label,
    uri,
    metadata: {
      source: "daily_ai_registered_summary",
      summary_path: summaryPath,
      summary_uri: uri,
      stage,
      stage_present: stage === null ? true : hasValue(summary[stage]),
      full_flow_ok: isRecord(summary.full_flow_completion) ? summary.full_flow_completion.ok === true : false,
      cleanup_proof_present: hasValue(summary.cleanup_proof)
    }
  }));
}

function blockedEvaluation(reason: string, summaryPath?: string, metadata: Record<string, unknown> = {}): DailyAiRegisteredEvaluation {
  return {
    status: "blocked",
    proof_gate: { ok: false, missing: [reason], present: [] },
    proof_summary: `blocked: ${reason}`,
    proofs: summaryPath ? buildDailyAiProofs({}, summaryPath).filter((proof) => Boolean(proof.metadata?.stage_present)) : [],
    metadata: { executor: "execute_daily_ai_registered", blocker: reason, ...metadata },
    summaryPath
  };
}

function timeoutEvaluation(evaluation: DailyAiRegisteredEvaluation, timeoutMs: number, stderr: string | Buffer | null | undefined): DailyAiRegisteredEvaluation {
  const status: DailyAiRegisteredStatus = evaluation.proofs.length > 0 ? "partial" : "blocked";
  const missing = [...new Set([...evaluation.proof_gate.missing, "daily_ai_runner_completed_before_timeout"])];
  return {
    ...evaluation,
    status,
    proof_gate: { ok: false, missing, present: evaluation.proof_gate.present },
    proof_summary: `${status}: Daily AI registered runner timed out after ${timeoutMs}ms`,
    metadata: {
      ...evaluation.metadata,
      blocker: "daily_ai_runner_timeout",
      runner_timeout_ms: timeoutMs,
      stderr_tail: tail(stderr, 2_000)
    }
  };
}

function enforceRunnerCompletionGate(
  evaluation: DailyAiRegisteredEvaluation,
  input: { exitStatus: number | null; timedOut: boolean; runId: string; cliRunId: string }
): DailyAiRegisteredEvaluation {
  if (input.exitStatus !== 0) {
    const status: DailyAiRegisteredStatus = evaluation.proofs.length > 0 ? "partial" : "blocked";
    return {
      ...evaluation,
      status,
      proof_gate: {
        ok: false,
        missing: [...new Set([...evaluation.proof_gate.missing, "daily_ai_runner_exit_0"])],
        present: evaluation.proof_gate.present
      },
      proof_summary: `${status}: Daily AI Playwright runner did not exit cleanly`,
      metadata: {
        ...evaluation.metadata,
        blocker: input.timedOut ? "daily_ai_runner_timeout" : "daily_ai_runner_exit_nonzero",
        runner_exit_status: input.exitStatus
      }
    };
  }
  const automationOsRunId = typeof evaluation.metadata.automation_os_run_id === "string" ? evaluation.metadata.automation_os_run_id : "";
  if (!automationOsRunId || automationOsRunId !== input.runId) {
    return {
      ...evaluation,
      status: "blocked",
      proof_gate: {
        ok: false,
        missing: [...new Set([...evaluation.proof_gate.missing, "daily_ai_runner_identity"])],
        present: evaluation.proof_gate.present
      },
      proof_summary: "blocked: Daily AI registered summary is missing or does not match the Automation OS run id",
      metadata: {
        ...evaluation.metadata,
        blocker: automationOsRunId ? "daily_ai_runner_identity_mismatch" : "daily_ai_runner_identity_missing",
        expected_automation_os_run_id: input.runId
      }
    };
  }
  const cliRunId = typeof evaluation.metadata.run_id === "string" ? evaluation.metadata.run_id : "";
  if (!cliRunId || cliRunId !== input.cliRunId) {
    return {
      ...evaluation,
      status: "blocked",
      proof_gate: {
        ok: false,
        missing: [...new Set([...evaluation.proof_gate.missing, "daily_ai_cli_run_identity"])],
        present: evaluation.proof_gate.present
      },
      proof_summary: "blocked: Daily AI registered summary is missing or does not match the CLI run id",
      metadata: {
        ...evaluation.metadata,
        blocker: cliRunId ? "daily_ai_cli_run_identity_mismatch" : "daily_ai_cli_run_identity_missing",
        expected_cli_run_id: input.cliRunId
      }
    };
  }
  return evaluation;
}

function baseMetadata(summary: Record<string, unknown>, summaryPath: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    executor: "execute_daily_ai_registered",
    summary_path: summaryPath,
    automation_os_run_id: typeof summary.automation_os_run_id === "string" ? summary.automation_os_run_id : undefined,
    run_id: typeof summary.run_id === "string" ? summary.run_id : undefined,
    stop_reason: typeof summary.stop_reason === "string" ? summary.stop_reason : undefined,
    current_stage: typeof summary.current_stage === "string" ? summary.current_stage : undefined,
    stage_status: typeof summary.stage_status === "string" ? summary.stage_status : undefined,
    ...issueLedgerMetadata(summary, summaryPath),
    ...extra
  };
}

function detectPreflightBlocker(summary: Record<string, unknown>): string | undefined {
  const stopReason = typeof summary.stop_reason === "string" && summary.stop_reason.trim() ? summary.stop_reason.trim() : "";
  const currentStage = typeof summary.current_stage === "string" ? summary.current_stage : "";
  const stageStatus = typeof summary.stage_status === "string" ? summary.stage_status : "";
  const cdpPreflight = isRecord(summary.cdp_preflight) ? summary.cdp_preflight : undefined;
  const profileGate = isRecord(summary.profile_gate) ? summary.profile_gate : undefined;

  if (cdpPreflight?.ok === false) {
    return stopReason || String(cdpPreflight.blocker || cdpPreflight.reason || "cdp_preflight_failed");
  }
  if (profileGate?.ok === false) {
    return stopReason || String(profileGate.blocker || profileGate.reason || "profile_gate_failed");
  }

  const haystack = [stopReason, currentStage, stageStatus]
    .filter((value) => value !== undefined && value !== null)
    .join(" ")
    .toLowerCase();

  if (!haystack) return undefined;
  if (/connectovercdp|local_automation_profile_unavailable|browser_unavailable|cdp_targets_unavailable|cdp_targets_invalid/.test(haystack)) {
    return stopReason || "preflight_blocker";
  }
  if (stageStatus === "failed" && /preflight|cdp|profile|open_cli_chrome/.test(currentStage.toLowerCase())) {
    return stopReason || "preflight_blocker";
  }
  return undefined;
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 120) || `daily-ai-${Date.now()}`;
}

function dailyAiRunnerTimeoutMs(): number {
  const raw = process.env.AUTOMATION_OS_DAILY_AI_TIMEOUT_MS;
  if (!raw) return defaultRunnerTimeoutMs;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : defaultRunnerTimeoutMs;
}

function isSpawnTimeout(error: Error | undefined): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
}

function tail(value: string | Buffer | null | undefined, maxLength = 8_000): string {
  const text = String(value ?? "");
  return text.length > maxLength ? text.slice(-maxLength) : text;
}

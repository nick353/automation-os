import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Proof } from "./proofGate.js";

export type PromptTransferRegisteredStatus = "complete" | "partial" | "blocked";

export type PromptTransferRegisteredRunResult = {
  status: PromptTransferRegisteredStatus;
  proof_gate: { ok: boolean; missing: string[]; present: string[] };
  proof_summary: string;
  proofs: Proof[];
  metadata: Record<string, unknown>;
  summaryPath?: string;
  command: {
    bin: string;
    args: string[];
    cwd: string;
    display: string;
    env: Record<string, string>;
  };
  exitStatus: number | null;
  signal: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
};

const projectRoot = "/Users/nichikatanaka/.agents/skills/prompt-transfer-ukiyoe";
export const defaultPromptTransferUkiyoeRunner = join(projectRoot, "scripts", "run_prompt_transfer_ukiyoe_playwright_sheets.py");
const defaultTimeoutMs = 15 * 60 * 1000;
const planReadyProofType = "prompt_transfer_plan_ready";
const externalCommitDoneProofType = "prompt_transfer_external_commit_done";
const externalCommitApprovalRequired = "prompt_transfer_external_commit_approval_required";
const playwrightRunnerMissing = "prompt_transfer_playwright_runner_missing";

export function resolvePromptTransferUkiyoeRunner(input: { defaultRunnerPath?: string } = {}): { runner?: string; source?: "env" | "default"; defaultRunnerPath: string } {
  const configured = (process.env.AUTOMATION_OS_PROMPT_TRANSFER_UKIYOE_RUNNER || "").trim();
  if (configured) {
    if (existsSync(configured)) return { runner: configured, source: "env", defaultRunnerPath: input.defaultRunnerPath ?? defaultPromptTransferUkiyoeRunner };
    return { defaultRunnerPath: configured };
  }
  const defaultRunnerPath = input.defaultRunnerPath ?? defaultPromptTransferUkiyoeRunner;
  if (existsSync(defaultRunnerPath)) return { runner: defaultRunnerPath, source: "default", defaultRunnerPath };
  return { defaultRunnerPath };
}

export function promptTransferOutputRoot() {
  return resolve(process.env.AUTOMATION_OS_PROMPT_TRANSFER_OUTPUT_ROOT || join(process.cwd(), "data", "artifacts", "prompt-transfer-ukiyoe"));
}

export function runPromptTransferRegisteredRunner(input: { runId: string; defaultRunnerPath?: string }): PromptTransferRegisteredRunResult {
  const outputRoot = promptTransferOutputRoot();
  mkdirSync(outputRoot, { recursive: true });
  const runId = sanitizeRunId(input.runId);
  const resultPath = join(outputRoot, "artifacts", "runs", runId, "result.json");
  const wrapperPath = join(outputRoot, "artifacts", "runs", runId, "ukiyoe_wrapper.json");
  const resolvedRunner = resolvePromptTransferUkiyoeRunner({ defaultRunnerPath: input.defaultRunnerPath });
  const sourceUrl = optionalEnv("AUTOMATION_OS_PROMPT_TRANSFER_SOURCE_URL");
  const targetUrl = optionalEnv("AUTOMATION_OS_PROMPT_TRANSFER_TARGET_URL");
  const theme = optionalEnv("AUTOMATION_OS_PROMPT_TRANSFER_THEME");

  if (!resolvedRunner.runner) {
    return blockedResult({
      runId,
      reason: playwrightRunnerMissing,
      summaryPath: undefined,
      metadata: {
        runner_source: "missing",
        default_runner_path: resolvedRunner.defaultRunnerPath,
        external_commit_requested: false,
        allow_external_commit: false
      },
      command: missingCommand(runId, outputRoot)
    });
  }

  const args = [resolvedRunner.runner, "--run-id", runId, "--out-root", outputRoot, "--commit", "--allow-external-commit"];
  if (sourceUrl) args.push("--source-url", sourceUrl);
  if (targetUrl) args.push("--target-url", targetUrl);
  if (theme) args.push("--theme", theme);
  const command = {
    bin: process.env.PYTHON || process.env.PYTHON3 || "python3",
    args,
    cwd: projectRoot,
    display: `python3 ${JSON.stringify(resolvedRunner.runner)} --run-id ${JSON.stringify(runId)} --out-root ${JSON.stringify(outputRoot)} --commit --allow-external-commit`,
    env: {
      AUTOMATION_OS_RUN_ID: runId,
      PROMPT_TRANSFER_EXTERNAL_COMMIT_REQUESTED: "1",
      PROMPT_TRANSFER_ALLOW_EXTERNAL_COMMIT: "1"
    }
  };
  const result = spawnSync(command.bin, command.args, {
    cwd: projectRoot,
    env: { ...process.env, ...command.env },
    encoding: "utf8",
    maxBuffer: 40 * 1024 * 1024,
    timeout: runnerTimeoutMs()
  });
  const summaryPath = existsSync(resultPath) ? resultPath : existsSync(wrapperPath) ? wrapperPath : undefined;
  const evaluation = evaluatePromptTransferSummary(summaryPath, {
    runId,
    resultPath,
    wrapperPath,
    outputRoot,
    exitStatus: result.status,
    timedOut: isSpawnTimeout(result.error),
    sourceUrlOverrideUsed: Boolean(sourceUrl),
    targetUrlOverrideUsed: Boolean(targetUrl)
  });
  return {
    ...evaluation,
    command,
    exitStatus: result.status,
    signal: result.signal,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr)
  };
}

export function evaluatePromptTransferSummary(
  summaryPath: string | undefined,
  input: {
    runId: string;
    resultPath?: string;
    wrapperPath?: string;
    outputRoot?: string;
    exitStatus?: number | null;
    timedOut?: boolean;
    sourceUrlOverrideUsed?: boolean;
    targetUrlOverrideUsed?: boolean;
  }
): Omit<PromptTransferRegisteredRunResult, "command" | "exitStatus" | "signal" | "stdoutTail" | "stderrTail"> {
  if (!summaryPath) {
    return blockedEvaluation("prompt_transfer_result_missing", undefined, { expected_result_path: input.resultPath, expected_wrapper_path: input.wrapperPath });
  }
  let summary: unknown;
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch (error) {
    return blockedEvaluation("prompt_transfer_result_invalid", summaryPath, { parse_error: error instanceof Error ? error.message : String(error) });
  }
  if (!isRecord(summary)) return blockedEvaluation("prompt_transfer_result_invalid", summaryPath, { reason: "summary_root_not_object" });
  const status = stringValue(summary.status);
  const exactBlocker = stringValue(summary.exact_blocker);
  if (input.timedOut) {
    return blockedEvaluation("prompt_transfer_runner_timeout", summaryPath, baseMetadata(summary, summaryPath, input));
  }
  if (input.exitStatus !== undefined && input.exitStatus !== null && input.exitStatus !== 0) {
    return blockedEvaluation("prompt_transfer_runner_exit_nonzero", summaryPath, baseMetadata(summary, summaryPath, input));
  }
  if (status === "success" && summary.commit_requested === true && summary.allow_external_commit === true && summary.committed === true) {
    const proof = {
      proofType: externalCommitDoneProofType,
      label: "Prompt Transfer Sheets save complete",
      uri: pathToFileURL(summaryPath).href,
      metadata: baseMetadata(summary, summaryPath, input)
    };
    return {
      status: "complete",
      proof_gate: { ok: true, missing: [], present: [externalCommitDoneProofType] },
      proof_summary: "complete: Prompt Transfer saved to Google Sheets with readback proof",
      proofs: [proof],
      metadata: {
        ...proof.metadata,
        executor: "execute_prompt_transfer_registered",
        blocker: undefined,
        external_commit_requested: true,
        allow_external_commit: true,
        committed: true,
        source_url_override_used: Boolean(input.sourceUrlOverrideUsed),
        target_url_override_used: Boolean(input.targetUrlOverrideUsed)
      },
      summaryPath
    };
  }
  if (status === "partial" || status === "success") {
    const proof = {
      proofType: planReadyProofType,
      label: "Prompt Transfer plan ready",
      uri: pathToFileURL(summaryPath).href,
      metadata: baseMetadata(summary, summaryPath, input)
    };
    return {
      status: "partial",
      proof_gate: { ok: false, missing: [externalCommitApprovalRequired], present: [planReadyProofType] },
      proof_summary: `partial: missing ${externalCommitApprovalRequired}`,
      proofs: [proof],
      metadata: {
        ...proof.metadata,
        executor: "execute_prompt_transfer_registered",
        blocker: externalCommitApprovalRequired,
        external_commit_requested: summary.commit_requested === true,
        allow_external_commit: summary.allow_external_commit === true,
        source_url_override_used: Boolean(input.sourceUrlOverrideUsed),
        target_url_override_used: Boolean(input.targetUrlOverrideUsed)
      },
      summaryPath
    };
  }
  return blockedEvaluation(exactBlocker || "prompt_transfer_plan_failed", summaryPath, baseMetadata(summary, summaryPath, input));
}

export function promptTransferArtifactSize(path: string | undefined): number {
  return path && existsSync(path) ? statSync(path).size : 0;
}

function missingCommand(runId: string, outputRoot: string) {
  return {
    bin: "python3",
    args: ["<Prompt Transfer Playwright/Sheets runner missing>"],
    cwd: projectRoot,
    display: "Prompt Transfer Playwright/Sheets runner missing; Browser Use wrapper will not be launched",
    env: {
      AUTOMATION_OS_RUN_ID: runId,
      PROMPT_TRANSFER_OUTPUT_ROOT: outputRoot,
      PROMPT_TRANSFER_EXTERNAL_COMMIT_REQUESTED: "0",
      PROMPT_TRANSFER_ALLOW_EXTERNAL_COMMIT: "0"
    }
  };
}

function blockedResult(input: { runId: string; reason: string; summaryPath?: string; metadata?: Record<string, unknown>; command: ReturnType<typeof missingCommand> }): PromptTransferRegisteredRunResult {
  const evaluation = blockedEvaluation(input.reason, input.summaryPath, input.metadata ?? {});
  return {
    ...evaluation,
    command: input.command,
    exitStatus: null,
    signal: null,
    stdoutTail: "",
    stderrTail: input.reason
  };
}

function blockedEvaluation(reason: string, summaryPath?: string, metadata: Record<string, unknown> = {}) {
  return {
    status: "blocked" as const,
    proof_gate: { ok: false, missing: [reason], present: [] },
    proof_summary: `blocked: ${reason}`,
    proofs: [],
    metadata: { executor: "execute_prompt_transfer_registered", blocker: reason, summary_path: summaryPath, ...metadata },
    summaryPath
  };
}

function baseMetadata(summary: Record<string, unknown>, summaryPath: string, input: Record<string, unknown>) {
  return {
    summary_path: summaryPath,
    summary_uri: pathToFileURL(summaryPath).href,
    artifact_uri: stringValue(summary.artifact_uri),
    run_id: stringValue(summary.run_id),
    status: stringValue(summary.status),
    exact_blocker: stringValue(summary.exact_blocker),
    commit_requested: summary.commit_requested === true,
    allow_external_commit: summary.allow_external_commit === true,
    output_root: input.outputRoot,
    result_path: input.resultPath,
    wrapper_path: input.wrapperPath,
    exit_status: input.exitStatus
  };
}

function runnerTimeoutMs(): number {
  const value = Number(process.env.AUTOMATION_OS_PROMPT_TRANSFER_TIMEOUT_MS || "");
  return Number.isFinite(value) && value > 0 ? value : defaultTimeoutMs;
}

function isSpawnTimeout(error: Error | undefined): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
}

function sanitizeRunId(value: string): string {
  return value.replace(/[^0-9A-Za-z_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "prompt-transfer-run";
}

function tail(value: string | Buffer | null | undefined, maxLength = 8_000): string {
  const text = String(value ?? "");
  return text.length > maxLength ? text.slice(-maxLength) : text;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

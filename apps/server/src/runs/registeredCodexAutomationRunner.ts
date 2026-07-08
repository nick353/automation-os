import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateGeminiVideoQaAudit } from "./geminiVideoQa.js";
import { issueLedgerMetadata } from "./issueLedger.js";
import { Proof } from "./proofGate.js";

export type RegisteredCodexAutomationStatus = "complete" | "blocked";

export type RegisteredCodexAutomationRunResult = {
  status: RegisteredCodexAutomationStatus;
  proof_gate: {
    ok: boolean;
    missing: string[];
    present: string[];
  };
  proof_summary: string;
  proofs: Proof[];
  metadata: Record<string, unknown>;
  command: {
    bin: string;
    args: string[];
    cwd: string;
    display: string;
    env: {
      AUTOMATION_OS_REGISTERED_WORKFLOW_ID: string;
      AUTOMATION_OS_RUN_ID: string;
      AUTOMATION_OS_REGISTERED_SUMMARY_PATH: string;
    } & Record<string, string>;
  };
  artifactPath: string;
  exitStatus: number | null;
  signal: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
};

const automationRoot = "/Users/nichikatanaka/.codex/automations";
const defaultTimeoutMs = 90 * 60 * 1000;
const defaultPlaywrightCliWrapper = "/Users/nichikatanaka/.codex/skills/playwright/scripts/playwright_cli.sh";

const workflows: Record<string, { cwd: string; automationToml: string; proofType: string; label: string }> = {
  job_submit_registered: {
    cwd: "/Users/nichikatanaka/Documents/New project",
    automationToml: join(automationRoot, "job-application-manager", "automation.toml"),
    proofType: "job_submit_registered_codex_execution",
    label: "Job submit registered Codex execution"
  },
  job_followup_registered: {
    cwd: "/Users/nichikatanaka/Documents/New project",
    automationToml: join(automationRoot, "job-application-manager", "automation.toml"),
    proofType: "job_followup_registered_codex_execution",
    label: "Job follow-up registered Codex execution"
  }
};

export function runRegisteredCodexAutomation(input: { runId: string; workflowId: string }): RegisteredCodexAutomationRunResult {
  const workflow = workflows[input.workflowId];
  if (!workflow) return blockedResult(input, "registered_workflow_runner_unknown", { workflow_id: input.workflowId });
  if (!existsSync(workflow.automationToml)) {
    return blockedResult(input, "automation_toml_missing", { workflow_id: input.workflowId, automation_toml: workflow.automationToml });
  }

  const prompt = readAutomationPrompt(workflow.automationToml);
  if (!prompt) {
    return blockedResult(input, "automation_prompt_missing", { workflow_id: input.workflowId, automation_toml: workflow.automationToml });
  }

  const artifactPath = artifactPathFor(input.runId, input.workflowId);
  const registeredSummaryPath = registeredSummaryPathFor({ artifactPath, workflowId: input.workflowId, workflowCwd: workflow.cwd, runId: input.runId });
  mkdirSync(dirname(artifactPath), { recursive: true });
  mkdirSync(dirname(registeredSummaryPath), { recursive: true });
  const timeoutMs = runnerTimeoutMs();
  const playwrightCli = process.env.AUTOMATION_OS_PLAYWRIGHT_CLI || defaultPlaywrightCliWrapper;
  const executablePrompt = [
    prompt,
    "",
    "Automation OS registered workflow execution:",
    `- automation_os_run_id=${input.runId}`,
    `- registered_workflow_id=${input.workflowId}`,
    `- Browser/UI stages must use Playwright CLI. Use PLAYWRIGHT_CLI_WRAPPER="${playwrightCli}" or the project Playwright runner; do not start Browser Use, browser_use.skill_cli.daemon, or browser-use temporary Chrome sessions.`,
    "- Capture Playwright artifacts for browser stages: screenshot, DOM/body text or snapshot, URL, attempt JSON, and cleanup/no-residual-process proof. Trace/video is useful when available, but workflow-owned source-of-truth proof remains required.",
    "- Stop with exact blocker playwright_cli_callable_surface_missing only when Playwright CLI and the project Playwright runner are both unavailable.",
    "- Current Automation OS policy authorizes non-billing external actions for this registered workflow: save, post, publish, send, submit, delete-in-scope, authenticated-session use, and application flow actions may proceed when the workflow has the needed context and an existing session/credential is available.",
    "- Default hard stops are billing, purchase, payment, and checkout only. Do not start paid checkout, purchase, paid subscription, paid usage upgrade, or payment-method changes.",
    "- CAPTCHA, OTP/security-code, identity verification, auth callable-surface gaps, and uncertain PII are not default hard stops. Do not bypass or invent them; capture screenshot, URL, DOM/body text or snapshot, attempt JSON, exact blocker, and cleanup proof, then continue via a lawful human-input evidence path or the next safe candidate/stage.",
    "- For job_submit_registered, official public-form submit is authorized with --submit-authorized when payment/billing is not involved and visible completion proof plus source-of-truth sync/readback can be captured. Authenticated job-platform work may use the trusted existing browser/session lane when available; otherwise capture human-input evidence instead of treating it as a broad approval blocker.",
    "- Write durable artifacts and source-of-truth proof exactly as the automation prompt requires.",
    "- Before exiting, always write JSON to AUTOMATION_OS_REGISTERED_SUMMARY_PATH. This summary sidecar is mandatory even for blocked/no-action runs.",
    "- The registered summary JSON must include at minimum: status, workflow_id, run_id, completion_claimed, exact_blocker, source_of_truth_proofs, cleanup_proof.",
    "- Use completion_claimed=false and a precise exact_blocker when blocked, no-action, stopped before external work, or unable to prove completion.",
    "- Gemini video QA fields are auxiliary only. Matching visual audits may be included when already produced, but they must not replace workflow-owned completion proof.",
    "- Do not bypass CAPTCHA, OTP/security-code, identity verification, assessments/tests, or missing completion proof; capture exact evidence and continue with the next safe candidate/stage when possible.",
    "- If strict completion proof is unavailable and no safe next candidate/stage exists, finish as blocked with exact blocker and artifact paths instead of turning non-billing work into an approval stop."
  ].join("\n");
  const command = {
    bin: process.env.AUTOMATION_OS_CODEX_BIN || "codex",
    args: ["exec", "--sandbox", "danger-full-access", "--cd", workflow.cwd, executablePrompt],
    cwd: workflow.cwd,
    display: `codex exec --sandbox danger-full-access --cd ${JSON.stringify(workflow.cwd)} ${JSON.stringify("<registered automation prompt>")}`,
    env: {
      AUTOMATION_OS_REGISTERED_WORKFLOW_ID: input.workflowId,
      AUTOMATION_OS_RUN_ID: input.runId,
      AUTOMATION_OS_REGISTERED_SUMMARY_PATH: registeredSummaryPath,
      PLAYWRIGHT_CLI_WRAPPER: playwrightCli,
      AUTOMATION_OS_BROWSER_DRIVER: "playwright_cli"
    }
  };

  let result;
  result = spawnSync(command.bin, command.args, {
    cwd: workflow.cwd,
    env: { ...process.env, ...command.env },
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024,
    timeout: timeoutMs
  });
  const timedOut = isSpawnTimeout(result.error);
  const stdoutTail = tail(result.stdout);
  const stderrTail = timedOut ? tail(`${result.stderr ?? ""}\nAutomation OS registered Codex automation timed out after ${timeoutMs}ms`) : tail(result.stderr);
  const succeeded = result.status === 0 && !timedOut && !result.error;
  const registeredSummary = readRegisteredSummary(registeredSummaryPath);
  const fallback = registeredSummary.summary
    ? { written: false, reason: undefined as string | undefined, path: registeredSummaryPath }
    : writeFailClosedRegisteredSummaryFallback({
        summaryPath: registeredSummaryPath,
        workflowId: input.workflowId,
        runId: input.runId,
        artifactPath,
        exitStatus: result.status,
        timedOut,
        stdoutTail,
        stderrTail,
        reason: registeredSummary.parseError ? "registered_summary_parse_error" : "registered_summary_missing",
        parseError: registeredSummary.parseError
      });
  const workflowContract = evaluateRegisteredWorkflowContract({
    workflowId: input.workflowId,
    succeeded,
    stdoutTail,
    registeredSummary: registeredSummary.summary
  });
  const visualAudit = evaluateGeminiVideoQaAudit({
    summary: registeredSummary.summary ?? {},
    summaryPath: registeredSummaryPath,
    workflow: input.workflowId,
    completionClaimed: registeredSummary.summary ? registeredSummaryCompletionClaimed(registeredSummary.summary) : succeeded
  });
  const visualAuditBlocksCompletion = succeeded && visualAudit.blockers.length > 0;
  const finalStatus: RegisteredCodexAutomationStatus =
    succeeded && workflowContract.ok && !visualAuditBlocksCompletion ? "complete" : "blocked";
  const proofType = finalStatus === "complete" ? workflow.proofType : `${workflow.proofType}_blocked`;
  const metadata = {
    executor: "execute_registered_codex_automation",
    workflow_id: input.workflowId,
    automation_toml: workflow.automationToml,
    cwd: workflow.cwd,
    registered_summary_path: registeredSummaryPath,
    browser_driver: "playwright_cli",
    playwright_cli_wrapper: playwrightCli,
    registered_summary_present: Boolean(registeredSummary.summary),
    registered_summary_parse_error: registeredSummary.parseError,
    registered_summary_fallback_written: fallback.written,
    registered_summary_fallback_path: fallback.path,
    registered_summary_fallback_reason: fallback.reason,
    fallback_written: fallback.written,
    fallback_path: fallback.path,
    fallback_reason: fallback.reason,
    gemini_video_qa: visualAudit.metadata,
    ...(registeredSummary.summary ? issueLedgerMetadata(registeredSummary.summary, registeredSummaryPath) : {}),
    exit_status: result.status,
    signal: result.signal,
    timed_out: timedOut,
    error_message: result.error ? String(result.error.message || result.error) : undefined
  };
  writeFileSync(
    artifactPath,
    JSON.stringify(
      {
        runId: input.runId,
        workflowId: input.workflowId,
        command,
        status: finalStatus,
        registeredSummaryPath,
        stdoutTail,
        stderrTail,
        metadata
      },
      null,
      2
    )
  );

  const proof: Proof = {
    proofType,
    label: succeeded ? workflow.label : `${workflow.label} blocked`,
    uri: pathToFileURL(artifactPath).href,
    metadata: { ...metadata, artifact_path: artifactPath }
  };
  const proofs = [proof, ...visualAudit.proofs];
  const missing = [
    ...(!succeeded ? [workflow.proofType] : []),
    ...workflowContract.missing,
    ...(visualAuditBlocksCompletion ? ["gemini_video_qa_completion_alignment"] : [])
  ];
  return {
    status: finalStatus,
    proof_gate: {
      ok: finalStatus === "complete",
      missing: [...new Set(missing)],
      present: proofs.map((candidate) => candidate.proofType)
    },
    proof_summary: !succeeded
      ? "blocked: registered automation Codex execution did not complete"
      : !workflowContract.ok
        ? `blocked: ${workflowContract.missing.join(", ")}`
        : visualAuditBlocksCompletion
          ? `blocked: Gemini video QA contradicts completion gate: ${visualAudit.blockers.join(", ")}`
          : "complete: registered automation Codex execution exited successfully",
    proofs,
    metadata,
    command,
    artifactPath,
    exitStatus: result.status,
    signal: result.signal,
    stdoutTail,
    stderrTail
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function blockedResult(input: { runId: string; workflowId: string }, reason: string, metadata: Record<string, unknown>): RegisteredCodexAutomationRunResult {
  const artifactPath = artifactPathFor(input.runId, input.workflowId);
  mkdirSync(dirname(artifactPath), { recursive: true });
  const command = {
    bin: process.env.AUTOMATION_OS_CODEX_BIN || "codex",
    args: [],
    cwd: process.cwd(),
    display: "registered automation runner unavailable",
    env: {
      AUTOMATION_OS_REGISTERED_WORKFLOW_ID: input.workflowId,
      AUTOMATION_OS_RUN_ID: input.runId,
      AUTOMATION_OS_REGISTERED_SUMMARY_PATH: registeredSummaryPathFor({ artifactPath, workflowId: input.workflowId, workflowCwd: process.cwd(), runId: input.runId })
    }
  };
  writeFileSync(artifactPath, JSON.stringify({ runId: input.runId, workflowId: input.workflowId, status: "blocked", reason, metadata }, null, 2));
  return {
    status: "blocked",
    proof_gate: { ok: false, missing: [reason], present: [] },
    proof_summary: `blocked: ${reason}`,
    proofs: [],
    metadata: { executor: "execute_registered_codex_automation", blocker: reason, ...metadata },
    command,
    artifactPath,
    exitStatus: null,
    signal: null,
    stdoutTail: "",
    stderrTail: reason
  };
}

function readAutomationPrompt(path: string): string {
  const source = readFileSync(path, "utf8");
  const match = source.match(/^prompt\s*=\s*("(?:\\.|[^"\\])*")/m);
  if (!match) return "";
  try {
    return JSON.parse(match[1]) as string;
  } catch {
    return "";
  }
}

function artifactPathFor(runId: string, workflowId: string): string {
  const root = process.env.AUTOMATION_OS_ARTIFACT_ROOT ? resolve(process.env.AUTOMATION_OS_ARTIFACT_ROOT) : resolve(process.cwd(), "data", "artifacts");
  return resolve(root, runId, `${workflowId}.json`);
}

function registeredSummaryPathFor(input: { artifactPath: string; workflowId: string; workflowCwd: string; runId: string }): string {
  if (input.workflowId === "job_submit_registered" || input.workflowId === "job_followup_registered") {
    const root = process.env.AUTOMATION_OS_REGISTERED_SUMMARY_ROOT
      ? resolve(process.env.AUTOMATION_OS_REGISTERED_SUMMARY_ROOT)
      : resolve(input.workflowCwd, "artifacts", "automation-os-registered-summaries");
    return resolve(root, input.runId, `${input.workflowId}-registered-summary.json`);
  }
  return resolve(dirname(input.artifactPath), `${input.workflowId}-registered-summary.json`);
}

const failClosedFallbackOrigin = "automation_os_fail_closed_fallback";

function readRegisteredSummary(summaryPath: string): { summary?: Record<string, unknown>; parseError?: string } {
  if (!existsSync(summaryPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(summaryPath, "utf8")) as unknown;
    if (!isRecord(parsed)) return { parseError: "registered_summary_root_not_object" };
    if (parsed.origin === failClosedFallbackOrigin) return { parseError: "registered_summary_fail_closed_fallback" };
    const missingFields = requiredRegisteredSummaryFields.filter((field) => !(field in parsed));
    if (missingFields.length > 0) return { parseError: `registered_summary_missing_required_fields:${missingFields.join(",")}` };
    return { summary: parsed };
  } catch (error) {
    return { parseError: String(error instanceof Error ? error.message : error) };
  }
}

const requiredRegisteredSummaryFields = [
  "status",
  "workflow_id",
  "run_id",
  "completion_claimed",
  "exact_blocker",
  "source_of_truth_proofs",
  "cleanup_proof"
];

function writeFailClosedRegisteredSummaryFallback(input: {
  summaryPath: string;
  workflowId: string;
  runId: string;
  artifactPath: string;
  exitStatus: number | null;
  timedOut: boolean;
  stdoutTail: string;
  stderrTail: string;
  reason: "registered_summary_missing" | "registered_summary_parse_error";
  parseError?: string;
}): { written: true; path: string; reason: string } {
  const exactBlocker = input.reason;
  const fallback = {
    origin: failClosedFallbackOrigin,
    status: "blocked",
    workflow_id: input.workflowId,
    run_id: input.runId,
    completion_claimed: false,
    exact_blocker: exactBlocker,
    source_of_truth_proofs: [],
    cleanup_proof: null,
    child_registered_summary_present: false,
    codex_exit_status: input.exitStatus,
    timed_out: input.timedOut,
    artifact_path: input.artifactPath,
    stdout_tail: input.stdoutTail,
    stderr_tail: input.stderrTail,
    registered_summary_parse_error: input.parseError,
    generated_at: new Date().toISOString()
  };
  mkdirSync(dirname(input.summaryPath), { recursive: true });
  writeFileSync(input.summaryPath, JSON.stringify(fallback, null, 2));
  return { written: true, path: input.summaryPath, reason: exactBlocker };
}

function runnerTimeoutMs(): number {
  const raw = process.env.AUTOMATION_OS_REGISTERED_CODEX_TIMEOUT_MS;
  if (!raw) return defaultTimeoutMs;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : defaultTimeoutMs;
}

function isSpawnTimeout(error: Error | undefined): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
}

function tail(value: string | Buffer | null | undefined, maxLength = 8_000): string {
  const text = String(value ?? "");
  return text.length > maxLength ? text.slice(-maxLength) : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function evaluateRegisteredWorkflowContract(input: {
  workflowId: string;
  succeeded: boolean;
  stdoutTail: string;
  registeredSummary?: Record<string, unknown>;
}): { ok: boolean; missing: string[] } {
  if (!input.succeeded) return { ok: false, missing: [] };
  const missing: string[] = [];
  const summaryStatus = typeof input.registeredSummary?.status === "string" ? input.registeredSummary.status : "";
  const text = `${input.stdoutTail}\n${JSON.stringify(input.registeredSummary ?? {})}`;
  const hasJobSubmitFullSuccessProof = input.workflowId === "job_submit_registered" && registeredSummaryHasJobSubmitFullSuccessProof(input.registeredSummary);
  if ((!hasJobSubmitFullSuccessProof && /blocked|submitted_confirmed=0|application_appends=0|未応募|応募送信前停止|source-of-truth.*未更新/i.test(text)) || summaryStatus === "blocked") {
    missing.push("registered_workflow_reported_blocked");
  }
  if (input.workflowId === "job_submit_registered" && !hasJobSubmitFullSuccessProof) {
    missing.push("submitted_confirmed_target_20_readback");
  }
  if (!input.registeredSummary) {
    missing.push("registered_summary_present");
  }
  return { ok: missing.length === 0, missing: [...new Set(missing)] };
}

function registeredSummaryCompletionClaimed(summary: Record<string, unknown>): boolean {
  return summary.completion_claimed === true;
}

function registeredSummaryHasJobSubmitFullSuccessProof(summary: Record<string, unknown> | undefined): boolean {
  if (!summary) return false;
  const status = stringValue(summary.status).toLowerCase();
  if (status !== "complete" && status !== "partial_success") return false;
  const bucketCounts = summary.submitted_count_by_bucket;
  if (isRecord(bucketCounts)) {
    return numberValue(bucketCounts.japan_targeted) >= 20 && numberValue(bucketCounts.overseas_global) >= 20;
  }
  if ("submitted_confirmed" in summary) return numberValue(summary.submitted_confirmed) >= 20;
  return numberValue(summary.japan_targeted_submitted_confirmed) >= 20 && numberValue(summary.overseas_global_submitted_confirmed) >= 20;
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export function registeredCodexArtifactSize(path: string): number {
  return existsSync(path) ? statSync(path).size : 0;
}

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluateGeminiVideoQaAudit } from "./geminiVideoQa.js";
import { issueLedgerMetadata } from "./issueLedger.js";
import { Proof } from "./proofGate.js";

export type NisenPrintsRegisteredStatus = "complete" | "partial" | "blocked";

export type NisenPrintsProofGate = {
  ok: boolean;
  missing: string[];
  present: string[];
};

export type NisenPrintsRegisteredEvaluation = {
  status: NisenPrintsRegisteredStatus;
  proof_gate: NisenPrintsProofGate;
  proof_summary: string;
  proofs: Proof[];
  metadata: Record<string, unknown>;
  summaryPath?: string;
};

export type NisenPrintsRegisteredRunResult = NisenPrintsRegisteredEvaluation & {
  command: {
    bin: string;
    args: string[];
    cwd: string;
    display: string;
    env: {
      NISENPRINTS_BROWSER_DRIVER: string;
      NISENPRINTS_REQUIRE_BROWSER_USE: string;
      NISENPRINTS_RECORDING_REQUIRED: string;
      NISENPRINTS_GEMINI_VIDEO_QA_REQUIRED: string;
      AUTOMATION_OS_RUN_ID?: string;
      NISENPRINTS_REGISTERED_SUMMARY_PATH?: string;
      NISENPRINTS_OUTPUT_DIR?: string;
      AUTOMATION_STAGE_TIMEOUT_MS?: string;
    };
  };
  exitStatus: number | null;
  signal: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
};

const projectRoot = "/Users/nichikatanaka/Documents/Etsy";
export const defaultNisenPrintsPlaywrightRunner = "/Users/nichikatanaka/Documents/Etsy/scripts/run_nisenprints_playwright_cli.mjs";
const summaryFileName = "registered-playlite-cli-summary.json";
const defaultRunnerTimeoutMs = 60 * 60 * 1000;
const playwrightRunnerMissing = "nisenprints_playwright_runner_missing";

const completeStatuses = new Set(["pinterest_posted", "playlite_flow_completed", "completed_context_verified"]);
const proofSpecs = [
  ["nisenprints_registered_summary", "NisenPrints registered summary", "summary"],
  ["generation_manifest_verified", "NisenPrints generation proof", "summary_complete"],
  ["etsy_listing_published", "NisenPrints Etsy listing proof", "etsy_listing"],
  ["pinterest_pin_url_verified", "NisenPrints Pinterest pin proof", "pinterest_pin"],
  ["etsy_visit_site_match_verified", "NisenPrints Pinterest Visit site proof", "visit_site_match"]
] as const;

export function resolveNisenPrintsPlaywrightRunner(input: { defaultRunnerPath?: string } = {}): { runner?: string; source?: "env" | "default"; defaultRunnerPath: string } {
  const configuredRunner = (process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER || "").trim();
  if (configuredRunner) return { runner: configuredRunner, source: "env", defaultRunnerPath: input.defaultRunnerPath ?? defaultNisenPrintsPlaywrightRunner };

  const defaultRunnerPath = input.defaultRunnerPath ?? defaultNisenPrintsPlaywrightRunner;
  if (existsSync(defaultRunnerPath)) return { runner: defaultRunnerPath, source: "default", defaultRunnerPath };
  return { defaultRunnerPath };
}

export function runNisenPrintsRegisteredRunner(input: { runId: string; startedAtMs?: number; defaultRunnerPath?: string }): NisenPrintsRegisteredRunResult {
  const timeoutMs = nisenPrintsRunnerTimeoutMs();
  const outputRoot = resolveNisenPrintsOutputRoot();
  mkdirSync(outputRoot, { recursive: true });
  const outputDir = join(outputRoot, sanitizeRunId(input.runId));
  mkdirSync(outputDir, { recursive: true });
  const registeredSummaryPath = join(outputDir, summaryFileName);
  const resolvedRunner = resolveNisenPrintsPlaywrightRunner({ defaultRunnerPath: input.defaultRunnerPath });

  if (!resolvedRunner.runner) {
    const command = {
      bin: "node",
      args: ["<NisenPrints Playwright CLI runner missing>"],
      cwd: projectRoot,
      display: "NisenPrints Playwright CLI runner is not configured and default runner is missing",
      env: {
        NISENPRINTS_BROWSER_DRIVER: "playwright_cli",
        NISENPRINTS_REQUIRE_BROWSER_USE: "0",
        NISENPRINTS_RECORDING_REQUIRED: "0",
        NISENPRINTS_GEMINI_VIDEO_QA_REQUIRED: "0",
        AUTOMATION_OS_RUN_ID: input.runId,
        NISENPRINTS_REGISTERED_SUMMARY_PATH: registeredSummaryPath,
        NISENPRINTS_OUTPUT_DIR: outputDir
      }
    };
    const evaluation = blockedEvaluation(playwrightRunnerMissing, undefined, {
      browser_driver: "playwright_cli",
      env_runner: "AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER",
      default_runner_path: resolvedRunner.defaultRunnerPath
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
    args: [resolvedRunner.runner],
    cwd: projectRoot,
    display:
      `cd ${JSON.stringify(projectRoot)} && NISENPRINTS_BROWSER_DRIVER=playwright_cli ` +
      `NISENPRINTS_REQUIRE_BROWSER_USE=0 NISENPRINTS_RECORDING_REQUIRED=0 NISENPRINTS_GEMINI_VIDEO_QA_REQUIRED=0 ` +
      `AUTOMATION_OS_RUN_ID=${JSON.stringify(input.runId)} ` +
      `NISENPRINTS_REGISTERED_SUMMARY_PATH=${JSON.stringify(registeredSummaryPath)} ` +
      `AUTOMATION_STAGE_TIMEOUT_MS=${JSON.stringify(process.env.AUTOMATION_STAGE_TIMEOUT_MS || "900000")} ${JSON.stringify(process.env.AUTOMATION_OS_NODE_BIN || "node")} ${JSON.stringify(resolvedRunner.runner)}`,
    env: {
      NISENPRINTS_BROWSER_DRIVER: "playwright_cli",
      NISENPRINTS_REQUIRE_BROWSER_USE: "0",
      NISENPRINTS_RECORDING_REQUIRED: "0",
      NISENPRINTS_GEMINI_VIDEO_QA_REQUIRED: "0",
      AUTOMATION_OS_RUN_ID: input.runId,
      NISENPRINTS_REGISTERED_SUMMARY_PATH: registeredSummaryPath,
      NISENPRINTS_OUTPUT_DIR: outputDir,
      AUTOMATION_STAGE_TIMEOUT_MS: process.env.AUTOMATION_STAGE_TIMEOUT_MS || "900000"
    }
  };

  const result = spawnSync(command.bin, command.args, {
    cwd: projectRoot,
    env: { ...process.env, ...command.env },
    encoding: "utf8",
    maxBuffer: 80 * 1024 * 1024,
    timeout: timeoutMs
  });

  const summaryPath = existsSync(registeredSummaryPath) ? registeredSummaryPath : undefined;
  const timedOut = isSpawnTimeout(result.error);
  const baseEvaluation = timedOut
    ? timeoutEvaluation(evaluateNisenPrintsRegisteredSummary(summaryPath, strictBrowserUseArtifactRequirements(command.env)), timeoutMs, result.stderr)
    : evaluateNisenPrintsRegisteredSummary(summaryPath, strictBrowserUseArtifactRequirements(command.env));
  const evaluation = enforceRunnerCompletionGate(baseEvaluation, {
    exitStatus: result.status,
    runId: input.runId,
    timedOut,
    summaryPath,
    expectedSummaryPath: registeredSummaryPath
  });

  return {
    ...evaluation,
    command,
    exitStatus: result.status,
    signal: result.signal,
    stdoutTail: tail(result.stdout),
    stderrTail: timedOut ? tail(`${result.stderr ?? ""}\nAutomation OS NisenPrints runner timed out after ${timeoutMs}ms`) : tail(result.stderr)
  };
}

function resolveNisenPrintsOutputRoot(): string {
  const configured = (process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_OUTPUT_ROOT || process.env.AUTOMATION_OS_NISENPRINTS_BROWSER_USE_OUTPUT_ROOT || "").trim();
  return configured ? resolve(configured) : join(projectRoot, "artifacts", "playlite-runs");
}

export function findNisenPrintsRegisteredSummary(input: { startedAtMs?: number } = {}): string | undefined {
  const candidates = listSummaryCandidates(resolveNisenPrintsOutputRoot())
    .filter((candidate) => input.startedAtMs === undefined || candidate.mtimeMs >= input.startedAtMs - 5_000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.path;
}

export function evaluateNisenPrintsRegisteredSummary(
  summaryPath: string | undefined,
  options: { recordingRequired?: boolean; geminiVideoQaRequired?: boolean } = {}
): NisenPrintsRegisteredEvaluation {
  if (!summaryPath) return blockedEvaluation("summary_missing");

  let summary: unknown;
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch (error) {
    return blockedEvaluation("summary_invalid", summaryPath, { parse_error: String(error instanceof Error ? error.message : error) });
  }
  if (!isRecord(summary)) return blockedEvaluation("summary_invalid", summaryPath, { reason: "summary_root_not_object" });

  const proofStates = buildNisenPrintsProofs(summary, summaryPath);
  const proofs = proofStates.filter((proof) => Boolean(proof.metadata?.stage_present));
  const missing = proofStates.filter((proof) => !proof.metadata?.stage_present).map((proof) => proof.proofType);
  const finalStatus = stringValue(summary.final_status);
  const stopReason = stringValue(summary.stop_reason);
  const completed = completeStatuses.has(finalStatus) && !stopReason;
  const visualAudit = evaluateGeminiVideoQaAudit({ summary, summaryPath, workflow: "NisenPrints", completionClaimed: completed });
  proofs.push(...visualAudit.proofs);
  const browserUseArtifactGate = evaluateBrowserUseArtifactGate({
    summary,
    visualAuditMetadata: visualAudit.metadata,
    completionClaimed: completed,
    recordingRequired: options.recordingRequired === true,
    geminiVideoQaRequired: options.geminiVideoQaRequired === true
  });
  const present = proofs.map((proof) => proof.proofType);

  if (completed && (visualAudit.blockers.length > 0 || browserUseArtifactGate.blockers.length > 0)) {
    const blockers = [...visualAudit.blockers, ...browserUseArtifactGate.blockers];
    const blockerKey = browserUseArtifactGate.blockers.length > 0 ? "browser_use_recording_gemini_qa_invalid" : "gemini_video_qa_completion_mismatch";
    return {
      status: "blocked",
      proof_gate: {
        ok: false,
        missing: [...new Set([...missing, ...browserUseArtifactGate.missing, "gemini_video_qa_completion_alignment"])],
        present: proofs.map((proof) => proof.proofType)
      },
      proof_summary: `blocked: optional recording/Gemini QA cannot support completion: ${blockers.join(", ")}`,
      proofs,
      metadata: baseMetadata(summary, summaryPath, {
        blocker: blockerKey,
        full_flow_ok: false,
        gemini_video_qa: visualAudit.metadata,
        browser_use_artifact_gate: browserUseArtifactGate.metadata
      }),
      summaryPath
    };
  }

  if (completed && missing.length === 0) {
    return {
      status: "complete",
      proof_gate: { ok: true, missing: [], present: proofs.map((proof) => proof.proofType) },
      proof_summary: "complete: NisenPrints Playwright runner completed with strict summary proofs",
      proofs,
      metadata: baseMetadata(summary, summaryPath, { full_flow_ok: true, gemini_video_qa: visualAudit.metadata, browser_use_artifact_gate: browserUseArtifactGate.metadata }),
      summaryPath
    };
  }

  if (completed) {
    return {
      status: "blocked",
      proof_gate: { ok: false, missing, present: proofs.map((proof) => proof.proofType) },
      proof_summary: `blocked: NisenPrints completion status is present but strict proofs are missing: ${missing.join(", ")}`,
      proofs,
      metadata: baseMetadata(summary, summaryPath, {
        blocker: "strict_proof_missing",
        full_flow_ok: false,
        gemini_video_qa: visualAudit.metadata,
        browser_use_artifact_gate: browserUseArtifactGate.metadata
      }),
      summaryPath
    };
  }

  const blocker = stopReason || stringValue(summary.blocker) || (finalStatus ? `final_status=${finalStatus}` : "completion_status_missing");
  return {
    status: proofs.length > 1 ? "partial" : "blocked",
    proof_gate: { ok: false, missing, present: proofs.map((proof) => proof.proofType) },
    proof_summary: `${proofs.length > 1 ? "partial" : "blocked"}: ${blocker}`,
    proofs,
    metadata: baseMetadata(summary, summaryPath, { blocker, full_flow_ok: false, gemini_video_qa: visualAudit.metadata, browser_use_artifact_gate: browserUseArtifactGate.metadata }),
    summaryPath
  };
}

function strictBrowserUseArtifactRequirements(env: NisenPrintsRegisteredRunResult["command"]["env"]): { recordingRequired: boolean; geminiVideoQaRequired: boolean } {
  return {
    recordingRequired: env.NISENPRINTS_RECORDING_REQUIRED === "1",
    geminiVideoQaRequired: env.NISENPRINTS_GEMINI_VIDEO_QA_REQUIRED === "1"
  };
}

function evaluateBrowserUseArtifactGate(input: {
  summary: Record<string, unknown>;
  visualAuditMetadata: ReturnType<typeof evaluateGeminiVideoQaAudit>["metadata"];
  completionClaimed: boolean;
  recordingRequired: boolean;
  geminiVideoQaRequired: boolean;
}): { blockers: string[]; missing: string[]; metadata: Record<string, unknown> } {
  const artifactRefs = collectBrowserUseArtifactRefs(input.summary, input.visualAuditMetadata);
  const recordingPath = artifactRefs.recordingPath;
  const geminiQaPath = artifactRefs.geminiQaPath;
  const blockers: string[] = [];
  const missing: string[] = [];

  if (input.recordingRequired) {
    if (!recordingPath) {
      missing.push("browser_use_recording");
      blockers.push("browser_use_recording_missing");
    } else if (!existsNonEmptyFile(recordingPath)) {
      missing.push("browser_use_recording");
      blockers.push("browser_use_recording_file_missing");
    }
  }

  if (input.geminiVideoQaRequired) {
    if (!geminiQaPath) {
      missing.push("gemini_video_qa");
      blockers.push("gemini_video_qa_artifact_missing");
    } else if (!existsNonEmptyFile(geminiQaPath)) {
      missing.push("gemini_video_qa");
      blockers.push("gemini_video_qa_file_missing");
    }
  }

  if (geminiQaPath && existsNonEmptyFile(geminiQaPath)) {
    const qaValidation = validateGeminiVideoQaArtifact({ geminiQaPath, recordingPath, completionClaimed: input.completionClaimed });
    if (!qaValidation.ok) {
      missing.push("gemini_video_qa");
      blockers.push(qaValidation.reason);
    }
  }

  return {
    blockers: [...new Set(blockers)],
    missing: [...new Set(missing)],
    metadata: {
      recording_required: input.recordingRequired,
      gemini_video_qa_required: input.geminiVideoQaRequired,
      recording_path: recordingPath || undefined,
      gemini_qa_path: geminiQaPath || undefined,
      blockers: [...new Set(blockers)]
    }
  };
}

function collectBrowserUseArtifactRefs(
  summary: Record<string, unknown>,
  visualAuditMetadata: ReturnType<typeof evaluateGeminiVideoQaAudit>["metadata"]
): { recordingPath?: string; geminiQaPath?: string } {
  const directRecordingPath =
    normalizeArtifactPath(summary.recording_path) ??
    normalizeArtifactPath(summary.recordingPath) ??
    normalizeArtifactPath(summary.video_artifact_uri) ??
    normalizeArtifactPath(summary.videoArtifactUri);
  const directGeminiQaPath =
    normalizeArtifactPath(summary.gemini_qa_path) ??
    normalizeArtifactPath(summary.geminiQaPath) ??
    normalizeArtifactPath(summary.gemini_video_qa_artifact_uri) ??
    normalizeArtifactPath(summary.geminiVideoQaArtifactUri);
  const ledgerRecordingPath = visualAuditMetadata.stage_ledger
    .map((entry) => normalizeArtifactPath(entry.video_artifact_uri))
    .find((value): value is string => Boolean(value));
  const ledgerGeminiQaPath = visualAuditMetadata.stage_ledger
    .map((entry) => normalizeArtifactPath(entry.artifact_uri))
    .find((value): value is string => Boolean(value));
  return {
    recordingPath: directRecordingPath ?? ledgerRecordingPath,
    geminiQaPath: directGeminiQaPath ?? ledgerGeminiQaPath
  };
}

function validateGeminiVideoQaArtifact(input: {
  geminiQaPath: string;
  recordingPath?: string;
  completionClaimed: boolean;
}): { ok: true } | { ok: false; reason: string } {
  let qa: unknown;
  try {
    qa = JSON.parse(readFileSync(input.geminiQaPath, "utf8"));
  } catch {
    return { ok: false, reason: "gemini_video_qa_json_invalid" };
  }
  if (!isRecord(qa) || !looksLikeGeminiQa(qa)) return { ok: false, reason: "gemini_video_qa_json_invalid" };
  if (input.recordingPath && !qaMatchesVideo(qa, input.recordingPath)) return { ok: false, reason: "gemini_video_qa_video_uri_mismatch" };

  const fileAudit = evaluateGeminiVideoQaAudit({
    summary: { gemini_video_qa: qa },
    summaryPath: input.geminiQaPath,
    workflow: "NisenPrints",
    completionClaimed: input.completionClaimed
  });
  if (fileAudit.blockers.length > 0 || qaContradictsCompletion(qa)) return { ok: false, reason: "gemini_video_qa_completion_alignment" };
  return { ok: true };
}

function buildNisenPrintsProofs(summary: Record<string, unknown>, summaryPath: string): Proof[] {
  const uri = pathToFileURL(summaryPath).href;
  const listingId = stringValue(summary.etsy_listing_id);
  const listingUrl = stringValue(summary.etsy_listing_url);
  const pinUrl = stringValue(summary.pinterest_pin_url);
  const visitSiteListingId = stringValue(summary.pinterest_visit_site_listing_id);
  const finalStatus = stringValue(summary.final_status);
  const completed = completeStatuses.has(finalStatus) && !stringValue(summary.stop_reason);
  return proofSpecs.map(([proofType, label, stage]) => ({
    proofType,
    label,
    uri,
    metadata: {
      source: "nisenprints_registered_summary",
      summary_path: summaryPath,
      summary_uri: uri,
      stage,
      stage_present:
        stage === "summary"
          ? true
          : stage === "summary_complete"
            ? completed
            : stage === "etsy_listing"
              ? completed && Boolean(listingId) && isValidEtsyListingUrl(listingUrl, listingId)
              : stage === "pinterest_pin"
                ? completed && isValidPinterestPinUrl(pinUrl)
                : completed && Boolean(listingId) && visitSiteListingId === listingId,
      final_status: finalStatus,
      stop_reason: stringValue(summary.stop_reason)
    }
  }));
}

function isValidEtsyListingUrl(value: string, listingId: string): boolean {
  if (!value || !listingId) return false;
  try {
    const url = new URL(value);
    if (!/(^|\.)etsy\.com$/i.test(url.hostname)) return false;
    return new RegExp(`/listing/${escapeRegExp(listingId)}(?:/|$)`).test(url.pathname);
  } catch {
    return false;
  }
}

function isValidPinterestPinUrl(value: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    if (url.hostname !== "pinterest.com" && !url.hostname.endsWith(".pinterest.com")) return false;
    return /^\/pin\/\d+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function existsNonEmptyFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile() && statSync(path).size > 0;
  } catch {
    return false;
  }
}

function looksLikeGeminiQa(record: Record<string, unknown>): boolean {
  return ["provider", "model", "kind", "type", "driver", "auditor"]
    .map((key) => String(record[key] ?? "").toLowerCase())
    .some((value) => value.includes("gemini") || value.includes("video_qa") || value.includes("video qa"));
}

function qaMatchesVideo(record: Record<string, unknown>, recordingPath: string): boolean {
  const expected = normalizeArtifactPath(recordingPath);
  const candidates = ["video_artifact_uri", "videoArtifactUri", "video_uri", "videoUri", "recording_uri", "recordingPath", "video_path", "videoPath"]
    .map((key) => normalizeArtifactPath(record[key]))
    .filter((value): value is string => Boolean(value));
  return Boolean(expected && candidates.includes(expected));
}

function qaContradictsCompletion(record: Record<string, unknown>): boolean {
  if (record.completion_gate_matches === false || record.completionGateMatches === false || record.completion_matches === false) return true;
  if (stringFieldIsBad(record.status) || stringFieldIsBad(record.verdict) || stringFieldIsBad(record.completion_gate_alignment || record.completionGateAlignment)) return true;
  return typeof record.exact_blocker === "string" && record.exact_blocker.trim().length > 0;
}

function stringFieldIsBad(value: unknown): boolean {
  return typeof value === "string" && /fail|failed|blocked|mismatch|conflict|veto|reject|error/.test(value.toLowerCase());
}

function normalizeArtifactPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const trimmed = value.trim();
    return resolve(trimmed.startsWith("file://") ? fileURLToPath(trimmed) : trimmed);
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function blockedEvaluation(reason: string, summaryPath?: string, metadata: Record<string, unknown> = {}): NisenPrintsRegisteredEvaluation {
  return {
    status: "blocked",
    proof_gate: { ok: false, missing: [reason], present: [] },
    proof_summary: `blocked: ${reason}`,
    proofs: [],
    metadata: { executor: "execute_nisenprints_registered", blocker: reason, ...metadata },
    summaryPath
  };
}

function timeoutEvaluation(evaluation: NisenPrintsRegisteredEvaluation, timeoutMs: number, stderr: string | Buffer | null | undefined): NisenPrintsRegisteredEvaluation {
  const status: NisenPrintsRegisteredStatus = evaluation.proofs.length > 0 ? "partial" : "blocked";
  return {
    ...evaluation,
    status,
    proof_gate: {
      ok: false,
      missing: [...new Set([...evaluation.proof_gate.missing, "nisenprints_runner_completed_before_timeout"])],
      present: evaluation.proof_gate.present
    },
    proof_summary: `${status}: NisenPrints registered runner timed out after ${timeoutMs}ms`,
    metadata: {
      ...evaluation.metadata,
      blocker: "nisenprints_runner_timeout",
      runner_timeout_ms: timeoutMs,
      stderr_tail: tail(stderr, 2_000)
    }
  };
}

function baseMetadata(summary: Record<string, unknown>, summaryPath: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    executor: "execute_nisenprints_registered",
    summary_path: summaryPath,
    summary_uri: pathToFileURL(summaryPath).href,
    automation_os_run_id: stringValue(summary.automation_os_run_id) || undefined,
    run_id: stringValue(summary.run_id) || undefined,
    run_slug: stringValue(summary.run_slug) || undefined,
    topic_name: stringValue(summary.topic_name) || undefined,
    resume_stage: stringValue(summary.resume_stage) || undefined,
    stop_reason: stringValue(summary.stop_reason) || undefined,
    final_status: stringValue(summary.final_status) || undefined,
    blocked_stage: stringValue(summary.blocked_stage) || undefined,
    ...issueLedgerMetadata(summary, summaryPath),
    ...extra
  };
}

function enforceRunnerCompletionGate(
  evaluation: NisenPrintsRegisteredEvaluation,
  input: { exitStatus: number | null; runId: string; timedOut: boolean; summaryPath?: string; expectedSummaryPath: string }
): NisenPrintsRegisteredEvaluation {
  const missing = new Set(evaluation.proof_gate.missing);
  const metadata: Record<string, unknown> = { ...evaluation.metadata, expected_summary_path: input.expectedSummaryPath };
  const summaryAutomationOsRunId = stringValue(metadata.automation_os_run_id);
  if (!summaryAutomationOsRunId || summaryAutomationOsRunId !== input.runId) {
    missing.add("nisenprints_runner_identity");
    return {
      ...evaluation,
      status: "blocked",
      proofs: [],
      proof_gate: { ok: false, missing: [...missing], present: [] },
      proof_summary: "blocked: NisenPrints registered summary is missing or does not match the Automation OS run id",
      metadata: {
        ...metadata,
        blocker: summaryAutomationOsRunId ? "nisenprints_runner_identity_mismatch" : "nisenprints_runner_identity_missing",
        expected_automation_os_run_id: input.runId
      }
    };
  }
  if (input.exitStatus !== 0) {
    missing.add("nisenprints_runner_exit_0");
    return {
      ...evaluation,
      status: evaluation.proofs.length > 0 ? "partial" : "blocked",
      proof_gate: { ok: false, missing: [...missing], present: evaluation.proof_gate.present },
      proof_summary: `${evaluation.proofs.length > 0 ? "partial" : "blocked"}: NisenPrints Playwright runner did not exit cleanly`,
      metadata: {
        ...metadata,
        blocker: input.timedOut ? "nisenprints_runner_timeout" : "nisenprints_runner_exit_nonzero",
        runner_exit_status: input.exitStatus
      }
    };
  }
  return {
    ...evaluation,
    metadata
  };
}

function listSummaryCandidates(root: string): Array<{ path: string; mtimeMs: number }> {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(root, entry.name, summaryFileName))
    .filter((candidate) => existsSync(candidate))
    .map((candidate) => ({ path: candidate, mtimeMs: statSync(candidate).mtimeMs }));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeRunId(value: string): string {
  return value.replace(/[^0-9A-Za-z_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "run";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nisenPrintsRunnerTimeoutMs(): number {
  const raw = process.env.AUTOMATION_OS_NISENPRINTS_TIMEOUT_MS;
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

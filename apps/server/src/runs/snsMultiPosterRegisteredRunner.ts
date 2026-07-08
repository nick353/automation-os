import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Proof } from "./proofGate.js";

export type SnsMultiPosterRegisteredStatus = "complete" | "partial" | "blocked";

export type SnsMultiPosterRegisteredRunResult = {
  status: SnsMultiPosterRegisteredStatus;
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

const serverSrcDir = fileURLToPath(new URL("..", import.meta.url));
const projectRoot = resolve(serverSrcDir, "../../..");
export const defaultSnsMultiPosterUkiyoeRunner = join(projectRoot, "scripts", "run_sns_multi_poster_ukiyoe_playwright_cli.mjs");
const defaultTimeoutMs = 5 * 60 * 1000;
const stagePlanProofType = "sns_multi_poster_stage_plan";
const summaryProofType = "sns_multi_poster_summary";
const externalPostDoneProofType = "sns_multi_poster_external_post_done";
const humanInputRequiredWithEvidenceProofType = "sns_multi_poster_human_input_required_with_evidence";
const externalPostNotExecuted = "sns_multi_poster_external_post_not_executed";
const inputRequired = "sns_multi_poster_input_required";
const defaultNisenPrintsRoot = "/Users/nichikatanaka/Documents/Etsy";

type ResolvedSnsMultiPosterInput = {
  imagePath?: string;
  caption?: string;
  source: "env" | "nisenprints_latest_completed" | "missing";
  manifestPath?: string;
  nisenPrintsRoot?: string;
  nisenPrintsRunId?: string;
  finalStatus?: string;
  resumeStage?: string;
  canvaExportDir?: string;
  missing?: string[];
};

export function resolveSnsMultiPosterUkiyoeRunner(input: { defaultRunnerPath?: string } = {}): { runner?: string; source?: "env" | "default"; defaultRunnerPath: string } {
  const configured = (process.env.AUTOMATION_OS_SNS_MULTI_POSTER_RUNNER || "").trim();
  if (configured) return { runner: configured, source: "env", defaultRunnerPath: input.defaultRunnerPath ?? defaultSnsMultiPosterUkiyoeRunner };
  const defaultRunnerPath = input.defaultRunnerPath ?? defaultSnsMultiPosterUkiyoeRunner;
  if (existsSync(defaultRunnerPath)) return { runner: defaultRunnerPath, source: "default", defaultRunnerPath };
  return { defaultRunnerPath };
}

export function snsMultiPosterOutputRoot() {
  return resolve(process.env.AUTOMATION_OS_SNS_MULTI_POSTER_OUTPUT_ROOT || join(process.cwd(), "data", "artifacts", "sns-multi-poster-ukiyoe"));
}

export function runSnsMultiPosterRegisteredRunner(input: { runId: string; defaultRunnerPath?: string }): SnsMultiPosterRegisteredRunResult {
  const outputRoot = snsMultiPosterOutputRoot();
  mkdirSync(outputRoot, { recursive: true });
  const runId = sanitizeRunId(input.runId);
  const resolvedInput = resolveSnsMultiPosterInputs();
  const imagePath = resolvedInput.imagePath;
  const caption = resolvedInput.caption;
  const command = baseCommand(runId, outputRoot, imagePath, caption, input.defaultRunnerPath, resolvedInput);

  if (!imagePath || !caption) {
    return blockedResult({
      reason: inputRequired,
      summaryPath: undefined,
      command,
      metadata: {
        external_action_executed: false,
        resolved_inputs: publicResolvedInputMetadata(resolvedInput),
        missing_inputs: [
          ...(!imagePath ? ["SNS_MULTI_POSTER_IMAGE_PATH"] : []),
          ...(!caption ? ["SNS_MULTI_POSTER_CAPTION"] : [])
        ]
      }
    });
  }
  if (!command.resolvedRunner.runner) {
    return blockedResult({
      reason: "sns_multi_poster_registered_runner_not_connected",
      summaryPath: undefined,
      command,
      metadata: {
        external_action_executed: false,
        runner_source: "missing",
        default_runner_path: command.resolvedRunner.defaultRunnerPath
      }
    });
  }

  const result = spawnSync(command.bin, command.args, {
    cwd: projectRoot,
    env: { ...process.env, ...command.env },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: runnerTimeoutMs()
  });
  const summaryPath = join(outputRoot, "artifacts", "runs", runId, "result.json");
  const evaluation = evaluateSnsMultiPosterSummary(existsSync(summaryPath) ? summaryPath : undefined, {
    runId,
    outputRoot,
    exitStatus: result.status,
    timedOut: isSpawnTimeout(result.error)
  });
  return {
    ...evaluation,
    metadata: {
      ...evaluation.metadata,
      resolved_inputs: publicResolvedInputMetadata(resolvedInput)
    },
    command,
    exitStatus: result.status,
    signal: result.signal,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr)
  };
}

export function evaluateSnsMultiPosterSummary(
  summaryPath: string | undefined,
  input: { runId: string; outputRoot?: string; exitStatus?: number | null; timedOut?: boolean }
): Omit<SnsMultiPosterRegisteredRunResult, "command" | "exitStatus" | "signal" | "stdoutTail" | "stderrTail"> {
  if (!summaryPath) return blockedEvaluation("sns_multi_poster_result_missing", undefined, { output_root: input.outputRoot });
  const resolvedSummaryPath = summaryPath;
  let summary: unknown;
  try {
    summary = JSON.parse(readFileSync(resolvedSummaryPath, "utf8"));
  } catch (error) {
    return blockedEvaluation("sns_multi_poster_result_invalid", resolvedSummaryPath, { parse_error: error instanceof Error ? error.message : String(error) });
  }
  if (!isRecord(summary)) return blockedEvaluation("sns_multi_poster_result_invalid", resolvedSummaryPath, { reason: "summary_root_not_object" });
  if (input.timedOut) return blockedEvaluation("sns_multi_poster_runner_timeout", resolvedSummaryPath, baseMetadata(summary, resolvedSummaryPath, input));
  if (input.exitStatus !== undefined && input.exitStatus !== null && input.exitStatus !== 0) {
    return blockedEvaluation("sns_multi_poster_runner_exit_nonzero", resolvedSummaryPath, baseMetadata(summary, resolvedSummaryPath, input));
  }
  const status = stringValue(summary.status) ?? "";
  if (summary.external_action_executed === true && ["success", "complete", "completed"].includes(status)) {
    const proofs: Proof[] = [
      {
        proofType: externalPostDoneProofType,
        label: "SNS Multi Poster external post complete",
        uri: pathToFileURL(resolvedSummaryPath).href,
        metadata: baseMetadata(summary, resolvedSummaryPath, input)
      },
      {
        proofType: summaryProofType,
        label: "SNS Multi Poster summary",
        uri: pathToFileURL(resolvedSummaryPath).href,
        metadata: baseMetadata(summary, resolvedSummaryPath, input)
      }
    ];
    return {
      status: "complete",
      proof_gate: { ok: true, missing: [], present: proofs.map((proof) => proof.proofType) },
      proof_summary: "complete: SNS Multi Poster posted with source-of-truth summary proof",
      proofs,
      metadata: {
        ...baseMetadata(summary, resolvedSummaryPath, input),
        executor: "execute_sns_multi_poster_registered",
        blocker: undefined,
        external_action_executed: true
      },
      summaryPath: resolvedSummaryPath
    };
  }
  if (summary.external_action_executed !== false) {
    return blockedEvaluation("sns_multi_poster_external_action_evidence_missing", resolvedSummaryPath, baseMetadata(summary, resolvedSummaryPath, input));
  }
  const exactBlocker = stringValue(summary.exact_blocker);
  if (status === "blocked" && exactBlocker === humanInputRequiredWithEvidenceProofType) {
    const evidencePath = stringValue(summary.evidence_path);
    const metadata = {
      ...baseMetadata(summary, resolvedSummaryPath, input),
      executor: "execute_sns_multi_poster_registered",
      blocker: exactBlocker,
      external_action_executed: false
    };
    const evidenceError = validateReadableEvidencePath(evidencePath);
    if (evidenceError) {
      const { blocker: _blocker, ...evidenceMissingMetadata } = metadata;
      return blockedEvaluation("sns_multi_poster_human_input_evidence_missing", resolvedSummaryPath, { ...evidenceMissingMetadata, evidence_error: evidenceError });
    }
    const proofs: Proof[] = [
      {
        proofType: humanInputRequiredWithEvidenceProofType,
        label: "SNS Multi Poster human input required evidence",
        uri: evidencePath ? pathToFileURL(evidencePath).href : pathToFileURL(resolvedSummaryPath).href,
        metadata
      },
      {
        proofType: summaryProofType,
        label: "SNS Multi Poster summary",
        uri: pathToFileURL(resolvedSummaryPath).href,
        metadata
      }
    ];
    return {
      status: "blocked",
      proof_gate: { ok: false, missing: [externalPostNotExecuted], present: proofs.map((proof) => proof.proofType) },
      proof_summary: `partial: missing ${externalPostNotExecuted}; captured ${exactBlocker}`,
      proofs,
      metadata,
      summaryPath: resolvedSummaryPath
    };
  }
  if (stringValue(summary.status) !== "partial") {
    return blockedEvaluation(stringValue(summary.exact_blocker) || "sns_multi_poster_stage_plan_failed", summaryPath, baseMetadata(summary, summaryPath, input));
  }

  const stagePlanPath = stringValue(summary.stage_plan_path);
  const proofs: Proof[] = [
    {
      proofType: stagePlanProofType,
      label: "SNS Multi Poster stage plan",
      uri: stagePlanPath ? pathToFileURL(stagePlanPath).href : pathToFileURL(summaryPath).href,
      metadata: baseMetadata(summary, summaryPath, input)
    },
    {
      proofType: summaryProofType,
      label: "SNS Multi Poster summary",
      uri: pathToFileURL(summaryPath).href,
      metadata: baseMetadata(summary, summaryPath, input)
    }
  ];
  return {
    status: "partial",
    proof_gate: { ok: false, missing: [externalPostNotExecuted], present: [stagePlanProofType, summaryProofType] },
    proof_summary: `partial: missing ${externalPostNotExecuted}`,
    proofs,
    metadata: {
      ...baseMetadata(summary, summaryPath, input),
      executor: "execute_sns_multi_poster_registered",
      blocker: externalPostNotExecuted,
      external_action_executed: false
    },
    summaryPath
  };
}

export function snsMultiPosterArtifactSize(path: string | undefined): number {
  return path && existsSync(path) ? statSync(path).size : 0;
}

function baseCommand(
  runId: string,
  outputRoot: string,
  imagePath: string | undefined,
  caption: string | undefined,
  defaultRunnerPath?: string,
  resolvedInput?: ResolvedSnsMultiPosterInput
) {
  const resolvedRunner = resolveSnsMultiPosterUkiyoeRunner({ defaultRunnerPath });
  const args = resolvedRunner.runner
    ? [resolvedRunner.runner, "--run-id", runId, "--out-root", outputRoot, "--image-path", imagePath ?? "", "--caption", caption ?? ""]
    : ["<SNS Multi Poster Ukiyoe Playwright CLI runner missing>"];
  return {
    bin: process.env.AUTOMATION_OS_NODE_BIN || "node",
    args,
    cwd: projectRoot,
    display: resolvedRunner.runner
      ? `node ${JSON.stringify(resolvedRunner.runner)} --run-id ${JSON.stringify(runId)} --out-root ${JSON.stringify(outputRoot)} --image-path "<SNS_MULTI_POSTER_IMAGE_PATH>" --caption "<SNS_MULTI_POSTER_CAPTION>"`
      : "SNS Multi Poster Ukiyoe Playwright CLI runner is not connected",
    env: {
      AUTOMATION_OS_RUN_ID: runId,
      SNS_MULTI_POSTER_APPROVED_EXTERNAL_ACTIONS: "post,publish",
      SNS_MULTI_POSTER_HARD_STOPS: "billing,purchase,payment,checkout",
      SNS_MULTI_POSTER_RESOLVED_INPUT_SOURCE: resolvedInput?.source ?? "missing"
    },
    resolvedRunner
  };
}

function resolveSnsMultiPosterInputs(): ResolvedSnsMultiPosterInput {
  const envImagePath = optionalEnv("SNS_MULTI_POSTER_IMAGE_PATH");
  const envCaption = optionalEnv("SNS_MULTI_POSTER_CAPTION");
  if (envImagePath && envCaption) {
    return { imagePath: envImagePath, caption: envCaption, source: "env" };
  }
  const latestCompleted = resolveLatestCompletedNisenPrintsInput();
  const imagePath = envImagePath ?? latestCompleted?.imagePath;
  const caption = envCaption ?? latestCompleted?.caption;
  const source = latestCompleted && (imagePath || caption) ? "nisenprints_latest_completed" : "missing";
  const missing = [
    ...(!imagePath ? ["SNS_MULTI_POSTER_IMAGE_PATH"] : []),
    ...(!caption ? ["SNS_MULTI_POSTER_CAPTION"] : [])
  ];
  return {
    ...latestCompleted,
    imagePath,
    caption,
    source,
    missing
  };
}

function resolveLatestCompletedNisenPrintsInput(): Omit<ResolvedSnsMultiPosterInput, "source" | "missing"> | undefined {
  const nisenPrintsRoot = resolve(process.env.AUTOMATION_OS_SNS_MULTI_POSTER_NISENPRINTS_ROOT || defaultNisenPrintsRoot);
  const manifestDir = join(nisenPrintsRoot, "artifacts", "publish_manifests");
  if (!existsSync(manifestDir)) return undefined;
  const candidates = readdirSync(manifestDir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => join(manifestDir, entry))
    .map((manifestPath) => ({ manifestPath, mtimeMs: safeMtimeMs(manifestPath), manifest: readJsonRecord(manifestPath) }))
    .filter((candidate) => candidate.manifest && isCompletedNisenPrintsManifest(candidate.manifest))
    .map((candidate) => {
      const canvaExportDir = stringValue(candidate.manifest?.canva_export_dir);
      const resolvedExportDir = canvaExportDir ? resolveRelativeTo(nisenPrintsRoot, canvaExportDir) : undefined;
      const imagePath = resolvedExportDir ? join(resolvedExportDir, "1.png") : undefined;
      return { ...candidate, canvaExportDir: resolvedExportDir, imagePath };
    })
    .filter((candidate) => candidate.imagePath && existsSync(candidate.imagePath))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const latest = candidates[0];
  if (!latest?.manifest || !latest.imagePath) return undefined;
  return {
    imagePath: latest.imagePath,
    caption: captionForNisenPrintsManifest(latest.manifest, latest.manifestPath),
    manifestPath: latest.manifestPath,
    nisenPrintsRoot,
    nisenPrintsRunId: stringValue(latest.manifest.run_id),
    finalStatus: stringValue(latest.manifest.final_status),
    resumeStage: stringValue(latest.manifest.resume_stage),
    canvaExportDir: latest.canvaExportDir
  };
}

function isCompletedNisenPrintsManifest(manifest: Record<string, unknown>): boolean {
  const finalStatus = stringValue(manifest.final_status);
  const resumeStage = stringValue(manifest.resume_stage);
  return finalStatus === "pinterest_posted" && Boolean(resumeStage && /^complete/.test(resumeStage));
}

function captionForNisenPrintsManifest(manifest: Record<string, unknown>, manifestPath: string): string {
  const haystack = [stringValue(manifest.topic), stringValue(manifest.run_id), basename(manifestPath)].join(" ").toLowerCase();
  if (haystack.includes("cosmos")) return "\u{1F338}";
  if (haystack.includes("hydrangea")) return "\u2614";
  if (haystack.includes("wisteria")) return "\u85E4";
  if (haystack.includes("magnolia")) return "\u767D";
  if (haystack.includes("maple")) return "\u{1F341}";
  if (haystack.includes("lotus")) return "\u84EE";
  if (haystack.includes("sakura")) return "\u685C";
  return "\u9759";
}

function publicResolvedInputMetadata(input: ResolvedSnsMultiPosterInput): Record<string, unknown> {
  return {
    source: input.source,
    image_path: input.imagePath,
    caption: input.caption,
    manifest_path: input.manifestPath,
    nisenprints_run_id: input.nisenPrintsRunId,
    final_status: input.finalStatus,
    resume_stage: input.resumeStage,
    canva_export_dir: input.canvaExportDir,
    missing: input.missing ?? []
  };
}

function readJsonRecord(path: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function safeMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function resolveRelativeTo(root: string, value: string): string {
  return value.startsWith("/") ? value : resolve(root, value);
}

function blockedResult(input: { reason: string; summaryPath?: string; metadata?: Record<string, unknown>; command: ReturnType<typeof baseCommand> }): SnsMultiPosterRegisteredRunResult {
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
    metadata: { executor: "execute_sns_multi_poster_registered", blocker: reason, summary_path: summaryPath, external_action_executed: false, ...metadata },
    summaryPath
  };
}

function baseMetadata(summary: Record<string, unknown>, summaryPath: string, input: Record<string, unknown>) {
  return {
    summary_path: summaryPath,
    summary_uri: pathToFileURL(summaryPath).href,
    stage_plan_path: stringValue(summary.stage_plan_path),
    run_id: stringValue(summary.run_id),
    status: stringValue(summary.status),
    exact_blocker: stringValue(summary.exact_blocker),
    evidence_path: stringValue(summary.evidence_path),
    evidence_reason: stringValue(summary.evidence_reason),
    external_action_executed: summary.external_action_executed === true,
    output_root: input.outputRoot,
    exit_status: input.exitStatus
  };
}

function validateReadableEvidencePath(path: string | undefined): string | undefined {
  if (!path) return "evidence_path_missing";
  try {
    readFileSync(path, "utf8");
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function runnerTimeoutMs(): number {
  const value = Number(process.env.AUTOMATION_OS_SNS_MULTI_POSTER_TIMEOUT_MS || "");
  return Number.isFinite(value) && value > 0 ? value : defaultTimeoutMs;
}

function isSpawnTimeout(error: Error | undefined): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
}

function sanitizeRunId(value: string): string {
  return value.replace(/[^0-9A-Za-z_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "sns-multi-poster-run";
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

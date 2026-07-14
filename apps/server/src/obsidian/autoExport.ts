import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { exportObsidianVault, type ObsidianBackupRetentionSummary, ObsidianExportOptions, ObsidianExportResult } from "./exporter.js";

export type ObsidianExportStatus = {
  enabled: boolean;
  ok: boolean | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  failureCount: number;
  nextRecoveryAt: string | null;
  health: "disabled" | "healthy" | "recovering" | "degraded" | "unknown";
  summary: string;
  nextStep: string;
  vaultPath: string | null;
  outputDir: string | null;
  files: string[];
  runs: number;
  proofs: number;
  docs: number;
  controlPanelFile: string | null;
  proofInboxFile: string | null;
  resumeContractFile: string | null;
  resumeContractJsonFile: string | null;
  missionFiles: string[];
  secondBrainFiles: string[];
  secondBrainPolicy: SecondBrainPolicy;
  secondBrainReviewMetadata: SecondBrainReviewMetadata;
  dashboardFiles: string[];
  projectGovernanceFiles: string[];
  orientationFiles: string[];
  templateFiles: string[];
  backupRetention?: ObsidianBackupRetentionSummary;
  generatedFileCheck: GeneratedFileCheck;
  reason: string | null;
};

export type GeneratedFileCheck = {
  ok: boolean;
  checkedAt: string | null;
  total: number;
  missing: string[];
  nonGenerated: string[];
  files: GeneratedFileCheckFile[];
};

export type GeneratedFileCheckFile = {
  path: string;
  kind: "markdown" | "base" | "json";
  exists: boolean;
  mtime: string | null;
  marker: "frontmatter" | "comment" | "not_applicable" | "missing";
  generated: boolean | "not_applicable";
};

export type SecondBrainPolicy = {
  autoApprovedScopes: string[];
  approvalRequiredScopes: string[];
};

export type SecondBrainReviewMetadata = {
  auto_process: string;
  processing_status: string;
  suggested_destination: string;
  progressive_summary: string;
  source_of_truth: string;
  external_action_required: boolean;
  approval_required: boolean;
};

export type PeriodicObsidianExportController = {
  enabled: boolean;
  intervalMs: number;
  stop: () => void;
};

export type ObsidianAutonomyLoopController = {
  enabled: boolean;
  recoveryRetryMs: number;
  weeklyDiagnosisMs: number;
  stop: () => void;
};

type ObsidianExportStatusDraft = Omit<ObsidianExportStatus, "health" | "summary" | "nextStep">;

const defaultPeriodicExportMs = 5 * 60 * 1000;
const defaultRecoveryRetryMs = 60 * 1000;
const defaultRecoveryRetryMaxMs = 30 * 60 * 1000;
const defaultWeeklyDiagnosisMs = 7 * 24 * 60 * 60 * 1000;
const defaultSecondBrainPolicy: SecondBrainPolicy = {
  autoApprovedScopes: [
    "obsidian_internal_capture",
    "obsidian_internal_normalize",
    "obsidian_internal_classify",
    "obsidian_internal_distill",
    "obsidian_internal_draft",
    "obsidian_internal_link",
    "obsidian_internal_review_digest"
  ],
  approvalRequiredScopes: [
    "billing_purchase_payment_checkout"
  ]
};
const defaultSecondBrainReviewMetadata: SecondBrainReviewMetadata = {
  auto_process: "obsidian_internal_only",
  processing_status: "queued",
  suggested_destination: "unknown",
  progressive_summary: "",
  source_of_truth: "handwritten Obsidian note",
  external_action_required: false,
  approval_required: false
};
const defaultGeneratedFileCheck: GeneratedFileCheck = {
  ok: true,
  checkedAt: null,
  total: 0,
  missing: [],
  nonGenerated: [],
  files: []
};
const defaultStatus: ObsidianExportStatus = {
  enabled: autoExportEnabled(),
  ok: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
  failureCount: 0,
  nextRecoveryAt: null,
  health: "unknown",
  summary: "",
  nextStep: "",
  vaultPath: null,
  outputDir: null,
  files: [],
  runs: 0,
  proofs: 0,
  docs: 0,
  controlPanelFile: null,
  proofInboxFile: null,
  resumeContractFile: null,
  resumeContractJsonFile: null,
  missionFiles: [],
  secondBrainFiles: [],
  secondBrainPolicy: defaultSecondBrainPolicy,
  secondBrainReviewMetadata: defaultSecondBrainReviewMetadata,
  dashboardFiles: [],
  projectGovernanceFiles: [],
  orientationFiles: [],
  templateFiles: [],
  generatedFileCheck: defaultGeneratedFileCheck,
  reason: null
};

let lastStatus: ObsidianExportStatus = readStatusFile();
let periodicTimer: ReturnType<typeof setInterval> | undefined;
let recoveryRetryTimer: ReturnType<typeof setTimeout> | undefined;
let weeklyDiagnosisTimer: ReturnType<typeof setTimeout> | undefined;
let exportInFlight = false;

export function getObsidianExportStatus(): ObsidianExportStatus {
  const persistedStatus = readPersistedStatusFile();
  if (persistedStatus) lastStatus = persistedStatus;
  return decorateStatus({ ...lastStatus, enabled: autoExportEnabled() });
}

export function runObsidianExportNow(reason = "manual", options: ObsidianExportOptions = {}): ObsidianExportStatus {
  return recordExportAttempt(reason, () => exportObsidianVault(options));
}

export function runObsidianAutoExportBestEffort(reason = "api_state_change"): ObsidianExportStatus {
  if (!autoExportEnabled()) {
    lastStatus = {
      ...lastStatus,
      enabled: false,
      ok: null,
      reason: "auto_export_disabled"
    };
    writeStatusFile(lastStatus);
    return getObsidianExportStatus();
  }
  if (!inlineAutoExportEnabled()) return queueDetachedAutoExport(reason);
  return recordExportAttempt(reason, () => exportObsidianVault());
}

export function startPeriodicObsidianExport(): PeriodicObsidianExportController {
  const intervalMs = periodicExportIntervalMs();
  if (!autoExportEnabled() || intervalMs <= 0) {
    return { enabled: false, intervalMs, stop: stopPeriodicObsidianExport };
  }
  if (!periodicTimer) {
    periodicTimer = setInterval(() => {
      runPeriodicExportTick();
    }, intervalMs);
    periodicTimer.unref?.();
  }
  return { enabled: true, intervalMs, stop: stopPeriodicObsidianExport };
}

export function stopPeriodicObsidianExport(): void {
  if (!periodicTimer) return;
  clearInterval(periodicTimer);
  periodicTimer = undefined;
}

export function startObsidianAutonomyLoops(): ObsidianAutonomyLoopController {
  const recoveryRetryMs = recoveryRetryDelayMs(lastStatus.failureCount);
  if (autoExportEnabled()) {
    scheduleRecoveryRetryFromStatus();
    startWeeklyDiagnosisLoop();
  }
  return {
    enabled: autoExportEnabled(),
    recoveryRetryMs,
    weeklyDiagnosisMs: defaultWeeklyDiagnosisMs,
    stop: stopObsidianAutonomyLoops
  };
}

export function stopObsidianAutonomyLoops(): void {
  stopRecoveryRetryTimer();
  stopWeeklyDiagnosisLoop();
}

export function periodicExportIntervalMs(): number {
  const raw = process.env.AUTOMATION_OS_OBSIDIAN_PERIODIC_EXPORT_MS;
  if (raw === undefined || raw.trim() === "") return defaultPeriodicExportMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultPeriodicExportMs;
  return Math.floor(parsed);
}

export function runPeriodicExportTick(reason = "periodic"): ObsidianExportStatus | undefined {
  return runObsidianAutoExportBestEffort(reason);
}

export function runObsidianExportAttemptForTest(reason: string, action: () => ObsidianExportResult): ObsidianExportStatus {
  return recordExportAttempt(reason, action);
}

function recordExportAttempt(reason: string, action: () => ObsidianExportResult): ObsidianExportStatus {
  if (exportInFlight) return recordSkippedExport(reason);
  exportInFlight = true;
  const attemptedAt = new Date().toISOString();
  try {
    const result = action();
    const generatedFileCheck = checkGeneratedFiles(result, attemptedAt);
    stopRecoveryRetryTimer();
    lastStatus = decorateStatus({
      enabled: autoExportEnabled(),
      ok: true,
      lastAttemptAt: attemptedAt,
      lastSuccessAt: attemptedAt,
      lastFailureAt: null,
      lastError: null,
      failureCount: 0,
      nextRecoveryAt: null,
      vaultPath: result.vaultPath,
      outputDir: result.outputDir,
      files: result.files,
      runs: result.runs,
      proofs: result.proofs,
      docs: result.docs,
      controlPanelFile: result.controlPanelFile ?? null,
      proofInboxFile: result.proofInboxFile ?? null,
      resumeContractFile: result.resumeContractFile ?? null,
      resumeContractJsonFile: result.resumeContractJsonFile ?? null,
      missionFiles: result.missionFiles,
      secondBrainFiles: result.secondBrainFiles,
      secondBrainPolicy: defaultSecondBrainPolicy,
      secondBrainReviewMetadata: lastStatus.secondBrainReviewMetadata,
      dashboardFiles: result.dashboardFiles,
      projectGovernanceFiles: result.projectGovernanceFiles ?? [],
      orientationFiles: result.orientationFiles,
      templateFiles: result.templateFiles,
      backupRetention: result.backupRetention,
      generatedFileCheck,
      reason
    });
  } catch (error) {
    const failureCount = (lastStatus.failureCount ?? 0) + 1;
    const nextRecoveryAt = new Date(Date.now() + recoveryRetryDelayMs(failureCount)).toISOString();
    lastStatus = decorateStatus({
      enabled: autoExportEnabled(),
      ok: false,
      lastAttemptAt: attemptedAt,
      lastSuccessAt: lastStatus.lastSuccessAt,
      lastFailureAt: attemptedAt,
      lastError: error instanceof Error ? error.message : "unknown_error",
      failureCount,
      nextRecoveryAt,
      vaultPath: null,
      outputDir: null,
      files: [],
      runs: 0,
      proofs: 0,
      docs: 0,
      controlPanelFile: null,
      proofInboxFile: null,
      resumeContractFile: null,
      resumeContractJsonFile: null,
      missionFiles: [],
      secondBrainFiles: [],
      secondBrainPolicy: defaultSecondBrainPolicy,
      secondBrainReviewMetadata: lastStatus.secondBrainReviewMetadata,
      dashboardFiles: [],
      projectGovernanceFiles: [],
      orientationFiles: [],
      templateFiles: [],
      backupRetention: undefined,
      generatedFileCheck: defaultGeneratedFileCheck,
      reason
    });
    scheduleRecoveryRetry(reason, failureCount);
  }
  try {
    writeStatusFile(lastStatus);
    return getObsidianExportStatus();
  } finally {
    exportInFlight = false;
  }
}

function recordSkippedExport(reason: string): ObsidianExportStatus {
  lastStatus = {
    ...lastStatus,
    enabled: autoExportEnabled(),
    lastAttemptAt: new Date().toISOString(),
    reason: `${reason}_skipped_export_in_flight`
  };
  lastStatus = decorateStatus(lastStatus);
  writeStatusFile(lastStatus);
  return getObsidianExportStatus();
}

function queueDetachedAutoExport(reason: string): ObsidianExportStatus {
  if (exportInFlight) return recordSkippedExport(reason);
  exportInFlight = true;
  lastStatus = {
    ...lastStatus,
    enabled: autoExportEnabled(),
    ok: null,
    lastAttemptAt: new Date().toISOString(),
    lastError: null,
    reason: `${reason}_queued`
  };
  lastStatus = decorateStatus(lastStatus);
  writeStatusFile(lastStatus);

  const cli = resolveExportCli();
  const child = spawn(cli.command, [...cli.args, `--reason=${reason}`], {
    cwd: process.cwd(),
    detached: true,
    env: process.env,
    stdio: "ignore"
  });
  child.once("error", (error) => {
    exportInFlight = false;
    const failureCount = (lastStatus.failureCount ?? 0) + 1;
    const attemptedAt = lastStatus.lastAttemptAt ?? new Date().toISOString();
    const nextRecoveryAt = new Date(Date.now() + recoveryRetryDelayMs(failureCount)).toISOString();
    lastStatus = {
      ...lastStatus,
      enabled: autoExportEnabled(),
      ok: false,
      lastAttemptAt: attemptedAt,
      lastFailureAt: attemptedAt,
      lastError: error.message,
      failureCount,
      nextRecoveryAt,
      reason
    };
    lastStatus = decorateStatus(lastStatus);
    scheduleRecoveryRetry(reason, failureCount);
    writeStatusFile(lastStatus);
  });
  child.once("exit", () => {
    exportInFlight = false;
    const persisted = readPersistedStatusFile();
    if (persisted) lastStatus = persisted;
  });
  child.unref();
  return getObsidianExportStatus();
}

function resolveExportCli(): { command: string; args: string[] } {
  const distCli = join(process.cwd(), "apps", "server", "dist", "cli", "exportObsidian.js");
  if (existsSync(distCli)) return { command: process.execPath, args: [distCli] };
  return {
    command: process.execPath,
    args: [...process.execArgv, join(process.cwd(), "apps", "server", "src", "cli", "exportObsidian.ts")]
  };
}

function inlineAutoExportEnabled(): boolean {
  if (process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT_DETACHED === "1") return false;
  if (process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT_INLINE === "1") return true;
  if (process.env.NODE_TEST_CONTEXT === "1") return true;
  return process.argv.some((arg) => arg.endsWith(".test.js") || arg.includes("/dist/tests/") || arg.includes("/src/tests/"));
}

function readStatusFile(): ObsidianExportStatus {
  return decorateStatus(readPersistedStatusFile() ?? { ...defaultStatus, enabled: autoExportEnabled() });
}

function readPersistedStatusFile(): ObsidianExportStatus | null {
  const path = resolveStatusFile();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ObsidianExportStatus>;
    return decorateStatus(normalizeStatus({ ...defaultStatus, ...parsed, enabled: autoExportEnabled() }));
  } catch {
    return null;
  }
}

function writeStatusFile(status: ObsidianExportStatus): void {
  const path = resolveStatusFile();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmpPath, JSON.stringify({ ...status, enabled: autoExportEnabled() }, null, 2));
    renameSync(tmpPath, path);
  } catch {
    // Status persistence is best-effort; export success must not depend on it.
  }
}

function normalizeStatus(status: ObsidianExportStatus): ObsidianExportStatus {
  return {
    ...status,
    files: Array.isArray(status.files) ? status.files : [],
    missionFiles: Array.isArray(status.missionFiles) ? status.missionFiles : [],
    secondBrainFiles: Array.isArray(status.secondBrainFiles) ? status.secondBrainFiles : [],
    secondBrainPolicy: normalizeSecondBrainPolicy(status.secondBrainPolicy),
    secondBrainReviewMetadata: normalizeSecondBrainReviewMetadata(status.secondBrainReviewMetadata),
    dashboardFiles: Array.isArray(status.dashboardFiles) ? status.dashboardFiles : [],
    projectGovernanceFiles: Array.isArray(status.projectGovernanceFiles) ? status.projectGovernanceFiles : [],
    orientationFiles: Array.isArray(status.orientationFiles) ? status.orientationFiles : [],
    templateFiles: Array.isArray(status.templateFiles) ? status.templateFiles : [],
    backupRetention: normalizeBackupRetention(status.backupRetention),
    generatedFileCheck: normalizeGeneratedFileCheck(status.generatedFileCheck),
    lastFailureAt: optionalString(status.lastFailureAt) ?? null,
    nextRecoveryAt: optionalString(status.nextRecoveryAt) ?? null,
    failureCount: typeof status.failureCount === "number" && Number.isFinite(status.failureCount) && status.failureCount >= 0 ? Math.floor(status.failureCount) : 0
  };
}

function decorateStatus(status: ObsidianExportStatusDraft): ObsidianExportStatus {
  const enabled = autoExportEnabled();
  const hostedLocalWorkerRequired = hostedRuntime() && process.env.AUTOMATION_OS_OBSIDIAN_HOSTED_EXPORT !== "1";
  const failureCount = typeof status.failureCount === "number" && Number.isFinite(status.failureCount) ? Math.max(0, Math.floor(status.failureCount)) : 0;
  const effectiveOk = hostedLocalWorkerRequired ? false : status.ok;
  const hasFailure = effectiveOk === false || Boolean(status.lastError) || failureCount > 0;
  const health: ObsidianExportStatus["health"] = !enabled
    ? "disabled"
    : effectiveOk === true
      ? failureCount > 0
        ? "recovering"
        : "healthy"
      : hasFailure
        ? "degraded"
        : "unknown";
  const summary =
    health === "healthy"
      ? "Obsidian export is running normally."
      : health === "recovering"
        ? `Obsidian export recovered, but ${failureCount} recent failure${failureCount === 1 ? "" : "s"} are still recorded.`
        : health === "degraded"
          ? status.lastError
            ? `Obsidian export needs attention: ${status.lastError}`
            : "Obsidian export needs attention."
          : health === "disabled"
            ? hostedLocalWorkerRequired
              ? "Obsidian export is handled by the Mac worker; the hosted control plane is read-only."
              : "Obsidian auto export is disabled."
            : "Obsidian export status is not yet known.";
  const nextStep =
    health === "healthy"
      ? "No action needed. Let the periodic and weekly loops continue."
      : health === "recovering"
        ? status.nextRecoveryAt
          ? `Wait for the scheduled retry at ${status.nextRecoveryAt}.`
          : "Wait for the scheduled retry."
        : health === "degraded"
          ? "Inspect the latest blocker, then let the recovery retry run or restart the server if the failure persists."
          : health === "disabled"
            ? hostedLocalWorkerRequired
              ? "Start or reconnect the Mac worker, then refresh this status."
              : "Re-enable AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT if you want the loop back on."
            : "Run a fresh export or inspect the persisted status file.";
  return {
    ...status,
    ok: effectiveOk,
    lastError: hostedLocalWorkerRequired ? null : status.lastError,
    reason: hostedLocalWorkerRequired ? "hosted_local_worker_required" : status.reason,
    health,
    summary,
    nextStep
  };
}

function normalizeBackupRetention(value: unknown): ObsidianBackupRetentionSummary | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ObsidianBackupRetentionSummary>;
  return {
    keepCount: typeof candidate.keepCount === "number" && Number.isFinite(candidate.keepCount) ? candidate.keepCount : 10,
    prunedDirs: Array.isArray(candidate.prunedDirs) ? candidate.prunedDirs.map(String) : [],
    skippedDirs: Array.isArray(candidate.skippedDirs) ? candidate.skippedDirs.map(String) : []
  };
}

function checkGeneratedFiles(result: ObsidianExportResult, checkedAt: string): GeneratedFileCheck {
  const targets = [
    ...result.files,
    result.controlPanelFile,
    result.proofInboxFile,
    result.resumeContractFile,
    result.resumeContractJsonFile,
    ...result.missionFiles,
    ...result.secondBrainFiles,
    ...result.dashboardFiles,
    ...(result.projectGovernanceFiles ?? []),
    ...result.orientationFiles,
    ...result.templateFiles
  ].filter((path): path is string => typeof path === "string" && path.length > 0);
  const uniqueTargets = [...new Set(targets)];
  const files = uniqueTargets.map(checkGeneratedFile);
  const missing = files.filter((file) => !file.exists).map((file) => file.path);
  const nonGenerated = files
    .filter((file) => file.exists && file.generated === false)
    .map((file) => file.path);
  return {
    ok: missing.length === 0 && nonGenerated.length === 0,
    checkedAt,
    total: files.length,
    missing,
    nonGenerated,
    files
  };
}

function checkGeneratedFile(path: string): GeneratedFileCheckFile {
  const kind = generatedFileKind(path);
  if (!existsSync(path)) {
    return { path, kind, exists: false, mtime: null, marker: "missing", generated: false };
  }
  const mtime = statSync(path).mtime.toISOString();
  if (kind === "json") {
    return { path, kind, exists: true, mtime, marker: "not_applicable", generated: "not_applicable" };
  }
  const body = readFileSync(path, "utf8");
  const marker = kind === "base" ? hasBaseGeneratedMarker(body) : hasMarkdownGeneratedFrontmatter(body);
  return {
    path,
    kind,
    exists: true,
    mtime,
    marker: marker ? (kind === "base" ? "comment" : "frontmatter") : "missing",
    generated: marker
  };
}

function generatedFileKind(path: string): GeneratedFileCheckFile["kind"] {
  if (path.endsWith(".base")) return "base";
  if (path.endsWith(".json")) return "json";
  return "markdown";
}

function hasMarkdownGeneratedFrontmatter(markdown: string): boolean {
  const match = markdown.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  return Boolean(match?.[1].split("\n").some((line) => line.trim() === "generated_by: automation-os"));
}

function hasBaseGeneratedMarker(body: string): boolean {
  return body.split("\n").slice(0, 5).some((line) => line.trim() === "# generated_by: automation-os");
}

function normalizeGeneratedFileCheck(value: unknown): GeneratedFileCheck {
  if (!value || typeof value !== "object") return defaultGeneratedFileCheck;
  const candidate = value as Partial<GeneratedFileCheck>;
  const files = Array.isArray(candidate.files)
    ? candidate.files.map(normalizeGeneratedFileCheckFile).filter((file): file is GeneratedFileCheckFile => Boolean(file))
    : [];
  const missing = Array.isArray(candidate.missing) ? candidate.missing.map(String) : [];
  const nonGenerated = Array.isArray(candidate.nonGenerated) ? candidate.nonGenerated.map(String) : [];
  return {
    ok: typeof candidate.ok === "boolean" ? candidate.ok : missing.length === 0 && nonGenerated.length === 0,
    checkedAt: optionalString(candidate.checkedAt) ?? null,
    total: typeof candidate.total === "number" && Number.isFinite(candidate.total) ? candidate.total : files.length,
    missing,
    nonGenerated,
    files
  };
}

function recoveryRetryDelayMs(failureCount: number): number {
  const count = Math.max(1, Math.floor(failureCount));
  return Math.min(defaultRecoveryRetryMaxMs, defaultRecoveryRetryMs * 2 ** Math.max(0, count - 1));
}

function scheduleRecoveryRetry(reason: string, failureCount: number): void {
  if (!autoExportEnabled()) return;
  stopRecoveryRetryTimer();
  const delayMs = recoveryRetryDelayMs(failureCount);
  recoveryRetryTimer = setTimeout(() => {
    recoveryRetryTimer = undefined;
    runObsidianAutoExportBestEffort(`recovery:${reason}`);
  }, delayMs);
  recoveryRetryTimer.unref?.();
}

function scheduleRecoveryRetryFromStatus(): void {
  if (!autoExportEnabled()) return;
  if (recoveryRetryTimer) return;
  if (lastStatus.ok !== false && !lastStatus.nextRecoveryAt) return;
  const nextRecoveryAt = lastStatus.nextRecoveryAt ? Date.parse(lastStatus.nextRecoveryAt) : NaN;
  const delayMs = Number.isFinite(nextRecoveryAt) ? Math.max(0, nextRecoveryAt - Date.now()) : recoveryRetryDelayMs(lastStatus.failureCount);
  recoveryRetryTimer = setTimeout(() => {
    recoveryRetryTimer = undefined;
    runObsidianAutoExportBestEffort("recovery:restore");
  }, delayMs);
  recoveryRetryTimer.unref?.();
}

function stopRecoveryRetryTimer(): void {
  if (!recoveryRetryTimer) return;
  clearTimeout(recoveryRetryTimer);
  recoveryRetryTimer = undefined;
}

function startWeeklyDiagnosisLoop(): void {
  if (!autoExportEnabled() || weeklyDiagnosisTimer) return;
  weeklyDiagnosisTimer = setTimeout(function tick() {
    weeklyDiagnosisTimer = undefined;
    runObsidianAutoExportBestEffort("weekly-diagnosis");
    startWeeklyDiagnosisLoop();
  }, defaultWeeklyDiagnosisMs);
  weeklyDiagnosisTimer.unref?.();
}

function stopWeeklyDiagnosisLoop(): void {
  if (!weeklyDiagnosisTimer) return;
  clearTimeout(weeklyDiagnosisTimer);
  weeklyDiagnosisTimer = undefined;
}

function normalizeGeneratedFileCheckFile(value: unknown): GeneratedFileCheckFile | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<GeneratedFileCheckFile>;
  const path = optionalString(candidate.path);
  if (!path) return null;
  const kind = candidate.kind === "base" || candidate.kind === "json" || candidate.kind === "markdown" ? candidate.kind : generatedFileKind(path);
  const generated = candidate.generated === "not_applicable" || typeof candidate.generated === "boolean" ? candidate.generated : false;
  const marker =
    candidate.marker === "frontmatter" || candidate.marker === "comment" || candidate.marker === "not_applicable" || candidate.marker === "missing"
      ? candidate.marker
      : "missing";
  return {
    path,
    kind,
    exists: candidate.exists === true,
    mtime: optionalString(candidate.mtime) ?? null,
    marker,
    generated
  };
}

function normalizeSecondBrainPolicy(policy: unknown): SecondBrainPolicy {
  if (!policy || typeof policy !== "object") return defaultSecondBrainPolicy;
  const candidate = policy as Partial<SecondBrainPolicy>;
  return {
    autoApprovedScopes: Array.isArray(candidate.autoApprovedScopes) ? candidate.autoApprovedScopes.map(String) : defaultSecondBrainPolicy.autoApprovedScopes,
    approvalRequiredScopes: Array.isArray(candidate.approvalRequiredScopes)
      ? candidate.approvalRequiredScopes.map(String)
      : defaultSecondBrainPolicy.approvalRequiredScopes
  };
}

function normalizeSecondBrainReviewMetadata(metadata: unknown): SecondBrainReviewMetadata {
  if (!metadata || typeof metadata !== "object") return defaultSecondBrainReviewMetadata;
  const candidate = metadata as Partial<SecondBrainReviewMetadata>;
  return {
    auto_process: optionalString(candidate.auto_process) ?? defaultSecondBrainReviewMetadata.auto_process,
    processing_status: optionalString(candidate.processing_status) ?? defaultSecondBrainReviewMetadata.processing_status,
    suggested_destination: optionalString(candidate.suggested_destination) ?? defaultSecondBrainReviewMetadata.suggested_destination,
    progressive_summary: optionalString(candidate.progressive_summary) ?? defaultSecondBrainReviewMetadata.progressive_summary,
    source_of_truth: optionalString(candidate.source_of_truth) ?? defaultSecondBrainReviewMetadata.source_of_truth,
    external_action_required:
      typeof candidate.external_action_required === "boolean"
        ? candidate.external_action_required
        : defaultSecondBrainReviewMetadata.external_action_required,
    approval_required:
      typeof candidate.approval_required === "boolean" ? candidate.approval_required : defaultSecondBrainReviewMetadata.approval_required
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function resolveStatusFile(): string {
  return resolve(process.env.AUTOMATION_OS_OBSIDIAN_STATUS_FILE ?? join(process.cwd(), "data", "obsidian-export-status.json"));
}

function autoExportEnabled(): boolean {
  if (hostedRuntime() && process.env.AUTOMATION_OS_OBSIDIAN_HOSTED_EXPORT !== "1") return false;
  if (process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT === "0") return false;
  if (process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT === "1") return true;
  return !process.env.NODE_TEST_CONTEXT;
}

function hostedRuntime(): boolean {
  return process.env.AUTOMATION_OS_HOSTED === "1"
    || Boolean(process.env.ZEABUR_GIT_COMMIT)
    || Boolean(process.env.ZEABUR_GIT_COMMIT_SHA)
    || Boolean(process.env.ZEABUR_SERVICE_ID);
}

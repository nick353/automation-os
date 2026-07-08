import { normalizeActionableObjective } from "../planner/responseConditions.js";
import { existsSync, readFileSync } from "node:fs";

export type RunSelectorRow = {
  id?: unknown;
  name?: unknown;
  status?: unknown;
  objective?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  metadata_json?: unknown;
};

const resumableStatuses = new Set(["blocked", "partial", "waiting_approval", "approval_required"]);
const supersedableStatuses = new Set(["blocked", "partial"]);
const staleNisenPrintsStatuses = new Set(["blocked", "partial", "waiting_approval", "approval_required"]);
const defaultNisenPrintsStatePath = "/Users/nichikatanaka/Documents/Etsy/STATE.md";
const registeredWorkflowIdByAdapter = new Map<string, string>([
  ["daily_ai_registered", "daily-ai-research-publish-run"],
  ["job_submit_registered", "job-application-manager"],
  ["job_followup_registered", "job-application-manager"],
  ["nisenprints_registered", "nisenprints-daily-product-canva-printify-etsy-pinterest"],
  ["prompt_transfer_registered", "prompt-transfer-ukiyoe"],
  ["sns_multi_poster_registered", "sns-multi-poster-ukiyoe"],
  ["x_authenticated_browser_lane_registered", "x-authenticated-browser-lane"]
]);
const canonicalRegisteredWorkflowIds = new Map<string, string>([
  ["job-application-daily-submit-queue", "job-application-manager"],
  ["job-application-follow-up-inbox-2", "job-application-manager"]
]);

export function selectResumeCandidateRun<T extends RunSelectorRow>(runs: T[]): T | undefined {
  return filterSupersededResumeRuns(aggregateLatestRegisteredWorkflowRuns(runs)).find((run) => resumableStatuses.has(String(run.status)));
}

export function selectAttentionRuns<T extends RunSelectorRow>(runs: T[]): T[] {
  return filterSupersededResumeRuns(aggregateLatestRegisteredWorkflowRuns(runs)).filter((run) => String(run.status) === "blocked" || String(run.status) === "partial");
}

export function selectActionQueueRuns<T extends RunSelectorRow>(runs: T[]): T[] {
  return filterSupersededResumeRuns(aggregateLatestRegisteredWorkflowRuns(runs)).filter((run) => resumableStatuses.has(String(run.status)));
}

export function aggregateLatestRegisteredWorkflowRuns<T extends RunSelectorRow>(runs: T[]): T[] {
  const latestByWorkflowKey = new Map<string, { run: T; order: number; index: number }>();
  runs.forEach((run, index) => {
    const workflowKey = registeredWorkflowKey(run);
    if (!workflowKey) return;
    const order = comparableRunOrder(run, index);
    const current = latestByWorkflowKey.get(workflowKey);
    if (!current || order > current.order || (order === current.order && index < current.index)) {
      latestByWorkflowKey.set(workflowKey, { run, order, index });
    }
  });
  return runs.filter((run) => {
    const workflowKey = registeredWorkflowKey(run);
    if (!workflowKey) return true;
    return latestByWorkflowKey.get(workflowKey)?.run === run;
  });
}

export function filterSupersededResumeRuns<T extends RunSelectorRow>(runs: T[]): T[] {
  const latestYouTubeCaptureByKey = latestYouTubeTranscriptCaptureRuns(runs);
  return runs.filter(
    (run, index) =>
      !isResumeSuppressedRun(run) &&
      !isHistoricalReceiptDemoRun(run) &&
      !isReceiptOnlyVerificationGapResumeNoise(run) &&
      !isLegacyNonBillingApprovalGateRun(run) &&
      !isNisenPrintsRunSupersededByCurrentState(run) &&
      !isSupersededYouTubeTranscriptCaptureRun(run, latestYouTubeCaptureByKey) &&
      !isRunSupersededByLaterComplete(run, runs, index)
  );
}

export function isRunSupersededByLaterComplete<T extends RunSelectorRow>(run: T, runs: T[], runIndex = runs.indexOf(run)): boolean {
  if (!supersedableStatuses.has(String(run.status))) return false;
  const key = runObjectiveKey(run);
  if (!key) return false;
  const runOrder = comparableRunOrder(run, runIndex);
  return runs.some((candidate, candidateIndex) => {
    if (candidate === run || String(candidate.status) !== "complete") return false;
    if (runObjectiveKey(candidate) !== key) return false;
    return comparableRunOrder(candidate, candidateIndex) > runOrder;
  });
}

function runObjectiveKey(run: RunSelectorRow): string {
  const objective = typeof run.objective === "string" ? run.objective : typeof run.name === "string" ? run.name : "";
  return normalizeActionableObjective(objective);
}

function latestYouTubeTranscriptCaptureRuns<T extends RunSelectorRow>(runs: T[]): Map<string, T> {
  const latest = new Map<string, { run: T; order: number; index: number }>();
  runs.forEach((run, index) => {
    const key = youtubeTranscriptCaptureKey(run);
    if (!key) return;
    const order = comparableRunOrder(run, index);
    const current = latest.get(key);
    if (!current || order > current.order || (order === current.order && index < current.index)) {
      latest.set(key, { run, order, index });
    }
  });
  return new Map([...latest.entries()].map(([key, value]) => [key, value.run]));
}

function isSupersededYouTubeTranscriptCaptureRun<T extends RunSelectorRow>(run: T, latestByKey: Map<string, T>): boolean {
  if (!supersedableStatuses.has(String(run.status))) return false;
  const key = youtubeTranscriptCaptureKey(run);
  if (!key) return false;
  const latest = latestByKey.get(key);
  return Boolean(latest && latest !== run);
}

function youtubeTranscriptCaptureKey(run: RunSelectorRow): string | null {
  const metadata = parseMetadata(run.metadata_json);
  if (!looksLikeYouTubeTranscriptCaptureRun(run, metadata)) return null;
  const capture = metadata.youtube_capture;
  const sourceUrl = firstNonEmptyString(
    capture && typeof capture === "object" ? (capture as { requestedUrl?: unknown }).requestedUrl : undefined,
    capture && typeof capture === "object" ? (capture as { sourceUrl?: unknown }).sourceUrl : undefined
  );
  const text = `${String(run.objective ?? "")} ${String(run.name ?? "")} ${sourceUrl ?? ""}`;
  const videoId = extractYouTubeVideoId(text);
  if (videoId) return `youtube_transcript:${videoId}`;
  if (!/youtube|youtu\.be|動画|台本|字幕|文字起こし/i.test(text)) return null;
  return `youtube_transcript:${normalizeActionableObjective(text)}`;
}

function looksLikeYouTubeTranscriptCaptureRun(run: RunSelectorRow, metadata: ParsedRunMetadata): boolean {
  if (metadata.youtube_capture && typeof metadata.youtube_capture === "object") return true;
  const text = `${String(run.objective ?? "")} ${String(run.name ?? "")}`.toLowerCase();
  if (!/台本|字幕|文字起こし|transcript/.test(text)) return false;
  return metadataListIncludes(metadata.research_plan_missing_proofs, "visible_source_snapshot:youtube")
    || metadataListIncludes(metadata.research_plan_required_proofs, "visible_source_snapshot:youtube")
    || proofGateMissingIncludes(metadata.proof_gate, "visible_source_snapshot:youtube");
}

function metadataListIncludes(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.some((item) => item === expected);
}

function proofGateMissingIncludes(value: unknown, expected: string): boolean {
  if (!value || typeof value !== "object") return false;
  return metadataListIncludes((value as { missing?: unknown }).missing, expected);
}

function extractYouTubeVideoId(text: string): string | null {
  return (
    text.match(/[?&]v=([a-zA-Z0-9_-]{6,})/)?.[1] ??
    text.match(/youtu\.be\/([a-zA-Z0-9_-]{6,})/)?.[1] ??
    text.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]{6,})/)?.[1] ??
    null
  );
}

function isHistoricalReceiptDemoRun(run: RunSelectorRow): boolean {
  if (!supersedableStatuses.has(String(run.status))) return false;
  const text = `${typeof run.objective === "string" ? run.objective : ""} ${typeof run.name === "string" ? run.name : ""}`;
  if (!/codex read-only demo/i.test(text)) return false;

  const metadata = parseMetadata(run.metadata_json);
  return metadata.worker_mode === "receipt_only";
}

function isResumeSuppressedRun(run: RunSelectorRow): boolean {
  if (!resumableStatuses.has(String(run.status))) return false;
  return isTruthyMetadataValue(parseMetadata(run.metadata_json).resume_suppressed);
}

function isReceiptOnlyVerificationGapResumeNoise(run: RunSelectorRow): boolean {
  if (!supersedableStatuses.has(String(run.status))) return false;
  const metadata = parseMetadata(run.metadata_json);
  if (!isReceiptOnlyMetadata(metadata)) return false;
  const proofGateVerificationGap = hasProofGateVerificationGap(metadata);
  const proofSummaryVerificationGap = hasProofSummaryVerificationGap(metadata);
  if (!proofGateVerificationGap && !proofSummaryVerificationGap) return false;
  const text = `${typeof run.objective === "string" ? run.objective : ""} ${typeof run.name === "string" ? run.name : ""}`;
  return /\bqa\b|test-only|test only|local qa|local check|browser use|read-only|readonly|demo|デモ|存在確認のみ|存在だけ|確認のみ|画面確認|unique create command/i.test(
    text
  );
}

function isReceiptOnlyMetadata(metadata: ParsedRunMetadata): boolean {
  return metadata.worker_mode === "receipt_only" || metadata.execution_mode === "receipt_only" || isTruthyMetadataValue(metadata.receipt_only);
}

function hasProofGateVerificationGap(metadata: ParsedRunMetadata): boolean {
  const proofGate = metadata.proof_gate;
  if (!proofGate || typeof proofGate !== "object") return false;
  const missing = (proofGate as { missing?: unknown }).missing;
  return Array.isArray(missing) && missing.some((item) => typeof item === "string" && item.includes("actual_execution_or_manual_verification"));
}

function hasProofSummaryVerificationGap(metadata: ParsedRunMetadata): boolean {
  return typeof metadata.proof_summary === "string" && metadata.proof_summary.includes("actual execution is not verified");
}

function isLegacyNonBillingApprovalGateRun(run: RunSelectorRow): boolean {
  if (!resumableStatuses.has(String(run.status))) return false;
  const metadata = parseMetadata(run.metadata_json);
  const publicText = `${String(run.name ?? "")} ${String(run.objective ?? "")}`;
  const text = `${publicText} ${JSON.stringify(metadata)}`;
  if (!/approval gate|approval_required|waiting_approval|requiresApproval|requires_approval/i.test(text)) return false;
  if (billingHardStopText(publicText) || metadataPlanBillingHardStop(metadata.plan)) return false;
  return metadataPlanRequiresApproval(metadata.plan) || /approval gate/i.test(text);
}

function metadataPlanRequiresApproval(plan: unknown): boolean {
  if (!plan || typeof plan !== "object") return false;
  if ((plan as { approvalRequired?: unknown }).approvalRequired === true) return true;
  const tasks = (plan as { tasks?: unknown }).tasks;
  return Array.isArray(tasks) && tasks.some((task) => Boolean(task && typeof task === "object" && (task as { requiresApproval?: unknown }).requiresApproval === true));
}

function metadataPlanBillingHardStop(plan: unknown): boolean {
  if (!plan || typeof plan !== "object") return false;
  const values: unknown[] = [(plan as { command?: unknown }).command];
  const tasks = (plan as { tasks?: unknown }).tasks;
  if (Array.isArray(tasks)) {
    for (const task of tasks) {
      if (!task || typeof task !== "object") continue;
      values.push((task as { name?: unknown }).name, (task as { action?: unknown }).action);
      const resources = (task as { resources?: unknown }).resources;
      if (Array.isArray(resources)) values.push(...resources);
    }
  }
  return values.some(billingHardStopText);
}

function billingHardStopText(value: unknown): boolean {
  const text = String(value ?? "")
    .replace(/billing[-_\s]*only/gi, "policy")
    .replace(/billing[-_\s]*purchase[-_\s]*payment[-_\s]*checkout[-_\s]*hard[-_\s]*stop/gi, "policy")
    .replace(/billing[-_\s]*only[-_\s]*hard[-_\s]*stop/gi, "policy")
    .replace(/課金停止/g, "policy")
    .replace(/課金・購入・支払い・決済だけ停止/g, "policy");
  return /billing|purchase|payment|checkout|課金|購入|支払い|決済/i.test(text);
}

type ParsedRunMetadata = {
  adapter?: unknown;
  ai_adapters?: unknown;
  registeredWorkflowId?: unknown;
  registered_workflow_id?: unknown;
  workflowId?: unknown;
  workflow_id?: unknown;
  AUTOMATION_OS_REGISTERED_WORKFLOW_ID?: unknown;
  worker_mode?: unknown;
  execution_mode?: unknown;
  receipt_only?: unknown;
  resume_suppressed?: unknown;
  proof_gate?: unknown;
  proof_summary?: unknown;
  youtube_capture?: unknown;
  research_plan_required_proofs?: unknown;
  research_plan_missing_proofs?: unknown;
  plan?: unknown;
  run_slug?: unknown;
  final_status?: unknown;
  resume_stage?: unknown;
  blocker?: unknown;
  stop_reason?: unknown;
  executor?: unknown;
  run_contract?: unknown;
};

function parseMetadata(value: unknown): ParsedRunMetadata {
  if (typeof value === "object" && value !== null) return value as ParsedRunMetadata;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? (parsed as ParsedRunMetadata) : {};
  } catch {
    return {};
  }
}

export function isTruthyMetadataValue(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "y", "on"].includes(value.trim().toLowerCase());
}

function registeredWorkflowKey(run: RunSelectorRow): string | null {
  const metadata = parseMetadata(run.metadata_json);
  const direct = firstNonEmptyString(
    metadata.registeredWorkflowId,
    metadata.registered_workflow_id,
    metadata.workflowId,
    metadata.workflow_id,
    metadata.AUTOMATION_OS_REGISTERED_WORKFLOW_ID
  );
  if (direct) return canonicalRegisteredWorkflowKey(direct);
  return workflowKeyFromPlanTasks(metadata.plan);
}

function workflowKeyFromPlanTasks(plan: unknown): string | null {
  if (!plan || typeof plan !== "object") return null;
  const tasks = (plan as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return null;
  for (const task of tasks) {
    if (!task || typeof task !== "object") continue;
    const adapter = firstNonEmptyString((task as { adapter?: unknown }).adapter);
    if (!adapter) continue;
    const workflowKey = registeredWorkflowIdByAdapter.get(adapter) ?? (adapter.endsWith("_registered") ? adapter : null);
    if (workflowKey) return canonicalRegisteredWorkflowKey(workflowKey);
  }
  return null;
}

function canonicalRegisteredWorkflowKey(workflowKey: string): string {
  return canonicalRegisteredWorkflowIds.get(workflowKey) ?? workflowKey;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function isNisenPrintsRunSupersededByCurrentState(run: RunSelectorRow): boolean {
  if (!staleNisenPrintsStatuses.has(String(run.status))) return false;
  const metadata = parseMetadata(run.metadata_json);
  if (!looksLikeNisenPrintsRun(run, metadata)) return false;
  const runSlug = extractRunSlug(run, metadata);
  if (!runSlug) return false;
  const state = readNisenPrintsCurrentState();
  if (!state || state.latestActiveRun !== runSlug) return false;
  if (state.finalStatus !== "canva_artifacts_present" || state.resumeStage !== "printify_product_copy" || state.blocker) return false;
  const rowFinalStatus = typeof metadata.final_status === "string" ? metadata.final_status : "";
  const rowResumeStage = typeof metadata.resume_stage === "string" ? metadata.resume_stage : "";
  const rowBlocker = typeof metadata.blocker === "string" ? metadata.blocker : "";
  const rowStopReason = typeof metadata.stop_reason === "string" ? metadata.stop_reason : "";
  return rowFinalStatus !== state.finalStatus || rowResumeStage !== state.resumeStage || Boolean(rowBlocker || rowStopReason);
}

function looksLikeNisenPrintsRun(run: RunSelectorRow, metadata: ParsedRunMetadata): boolean {
  const text = `${String(run.name ?? "")} ${String(run.objective ?? "")} ${String(metadata.executor ?? "")}`;
  if (/nisenprints/i.test(text)) return true;
  const contract = metadata.run_contract;
  return Boolean(contract && typeof contract === "object" && (contract as { workflow?: unknown }).workflow === "NisenPrints");
}

function extractRunSlug(run: RunSelectorRow, metadata: ParsedRunMetadata): string | null {
  if (typeof metadata.run_slug === "string" && metadata.run_slug.trim()) return metadata.run_slug.trim();
  const text = `${String(run.objective ?? "")} ${String(run.name ?? "")}`;
  return text.match(/\brun_id=([0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+)/i)?.[1] ?? null;
}

type NisenPrintsCurrentState = {
  latestActiveRun: string;
  finalStatus: string;
  resumeStage: string;
  blocker: string;
};

function readNisenPrintsCurrentState(): NisenPrintsCurrentState | null {
  const path = process.env.AUTOMATION_OS_NISENPRINTS_STATE_PATH || defaultNisenPrintsStatePath;
  if (!existsSync(path)) return null;
  try {
    return parseNisenPrintsState(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function parseNisenPrintsState(markdown: string): NisenPrintsCurrentState | null {
  const latestActiveRun = markdown.match(/latest active run:\s*`([^`]+)`/i)?.[1]?.trim() ?? "";
  const finalStatus = markdown.match(/final_status:\s*`([^`]*)`/i)?.[1]?.trim() ?? "";
  const resumeStage = markdown.match(/resume_stage:\s*`([^`]*)`/i)?.[1]?.trim() ?? "";
  const blocker = markdown.match(/blocker:\s*`([^`]*)`/i)?.[1]?.trim() ?? "";
  if (!latestActiveRun) return null;
  return { latestActiveRun, finalStatus, resumeStage, blocker };
}

function comparableRunOrder(run: RunSelectorRow, index: number): number {
  const updatedAt = parseTimestamp(run.updated_at);
  if (updatedAt !== undefined) return updatedAt;
  const createdAt = parseTimestamp(run.created_at);
  if (createdAt !== undefined) return createdAt;
  return -index;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

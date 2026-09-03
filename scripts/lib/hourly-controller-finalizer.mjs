import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { buildControllerExecutionReceipt, buildVerifierProjection } from "../aos-hourly-companion-audit.mjs";

export const HOURLY_CONTROLLER_RECEIPT_SCHEMA = "aos.companion_hourly_controller_receipt.v1";
const HOST_METADATA_HEADER = "x-codex-turn-metadata";
const FINALIZABLE_ACTIONS = new Set([
  "blocker_progress",
  "reconciliation",
  "repair",
  "verification",
  "refresh",
  "continuation",
  "independent_continuation",
]);
const CANONICAL_STATE_PATH = "/Users/nichikatanaka/.codex/automations/aos-companion-2/STATE.md";
const STATE_SYNC_START = "<!-- aos-companion-2:latest-finalizer-sync:start -->";
const STATE_SYNC_END = "<!-- aos-companion-2:latest-finalizer-sync:end -->";

// These blockers describe a missing scheduler callback, not a safety reason
// to suppress an official-App-only candidate. If the audit explicitly
// exposes such a candidate, finalization must fail closed until the Root has
// fresh-read that task and either continued it or recorded its own concrete
// task-level blocker.
const OFFICIAL_APP_ONLY_CONTINUATION_GAP_BLOCKERS = new Set([
  "cross_task_companion_callback_unavailable",
  "companion_continuation_callback_required",
  "companion_idle_reconciled_boundary_required",
  "companion_disconnected",
  "companion_refresh_callback_required",
  "companion_refresh_reflection_required",
  "companion_repair_callback_required",
  "companion_repair_verification_callback_required",
]);

function exactError(code, details = {}) {
  const error = new Error(code);
  error.exact_blocker = code;
  error.details = details;
  return error;
}

function boundedText(value, field, max = 500) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value ?? "").trim();
  if (text.length > max || !/^[\x20-\x7e]+$/u.test(text)) {
    throw exactError("hourly_controller_receipt_field_invalid", { field });
  }
  return text || null;
}

function boundedCount(value, field) {
  if (value === undefined || value === null || value === "") return null;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0 || count > 1_000_000) {
    throw exactError("hourly_controller_receipt_field_invalid", { field });
  }
  return count;
}

function privateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(fd, bytes, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
  return file;
}

function privateJsonNoReplace(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") return { path: file, created: false };
    throw error;
  }
  try {
    fs.writeFileSync(fd, bytes, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(file, 0o600);
  return { path: file, created: true };
}

function stateField(value, max = 800) {
  if (value === undefined || value === null || value === "") return "none";
  return String(value).replace(/[\r\n]+/gu, " ").trim().slice(0, max) || "none";
}

function stateSyncBlock({ receipt, receiptPath }) {
  const stages = Object.values(receipt?.executionReceipt?.stageReceipts || {});
  const notRunCount = stages.filter((stage) => stage?.status === "not_run").length;
  const deferredCount = stages.filter((stage) => stage?.status === "deferred").length;
  const notApplicableCount = stages.filter((stage) => stage?.status === "not_applicable").length;
  const continuations = [
    ...(Array.isArray(receipt?.controller?.continuations) ? receipt.controller.continuations : []),
    ...(Array.isArray(receipt?.controller?.independentContinuations) ? receipt.controller.independentContinuations : []),
  ];
  return [
    STATE_SYNC_START,
    "- state_sync_schema: aos.companion_state_sync.v1",
    `- latest_run_id: ${stateField(receipt?.runId, 256)}`,
    `- latest_controller_receipt: ${stateField(receiptPath, 1_000)}`,
    `- latest_controller_status: ${stateField(receipt?.controller?.status, 80)}`,
    `- latest_exact_blocker: ${stateField(receipt?.controller?.exactBlocker, 400)}`,
    `- external_action_executed: ${receipt?.executionReceipt?.externalActionExecuted === true ? "true" : "false"}`,
    `- not_run_stage_count: ${notRunCount}`,
    `- deferred_stage_count: ${deferredCount}`,
    `- not_applicable_stage_count: ${notApplicableCount}`,
    `- continuation_count: ${continuations.length}`,
    `- next_action_now: ${stateField(receipt?.controller?.nextActionNow, 1_000)}`,
    `- resume_trigger: ${stateField(receipt?.controller?.resumeTrigger, 800)}`,
    `- state_sync_source: ${stateField(receipt?.auditPath, 1_000)}`,
    `- state_sync_at: ${stateField(receipt?.finalizedAt, 80)}`,
    STATE_SYNC_END,
  ].join("\n");
}

function replaceFirstUpdatedLine(text, timestamp) {
  const replacement = `Updated: ${stateField(timestamp, 80)}`;
  if (/^Updated:\s*.*$/mu.test(text)) return text.replace(/^Updated:\s*.*$/mu, replacement);
  const newline = text.indexOf("\n");
  return newline >= 0 ? `${text.slice(0, newline)}\n\n${replacement}${text.slice(newline)}` : `${text}\n\n${replacement}\n`;
}

function replaceStateSyncBlock(text, block) {
  const escapedStart = STATE_SYNC_START.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const escapedEnd = STATE_SYNC_END.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matcher = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}(?:\\n)?`, "u");
  if (matcher.test(text)) return text.replace(matcher, `${block}\n`);
  const headingEnd = text.indexOf("\n");
  if (headingEnd < 0) return `${text}\n\n${block}\n`;
  return `${text.slice(0, headingEnd + 1)}\n${block}\n${text.slice(headingEnd + 1)}`;
}

function synchronizeStateFile({ statePath, receipt, receiptPath }) {
  if (typeof statePath !== "string" || !path.isAbsolute(statePath) || path.basename(statePath) !== "STATE.md") {
    throw exactError("hourly_controller_state_path_invalid");
  }
  let stat;
  let before;
  try {
    stat = fs.lstatSync(statePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("state_not_regular");
    before = fs.readFileSync(statePath, "utf8");
  } catch {
    throw exactError("hourly_controller_state_read_failed");
  }
  const block = stateSyncBlock({ receipt, receiptPath });
  const next = replaceStateSyncBlock(replaceFirstUpdatedLine(before, receipt?.finalizedAt), block);
  if (next === before) {
    return { status: "already_synchronized", path: statePath };
  }
  let current;
  try { current = fs.readFileSync(statePath, "utf8"); } catch { throw exactError("hourly_controller_state_read_failed"); }
  if (current !== before) throw exactError("hourly_controller_state_changed_during_sync");
  const temporary = `${statePath}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, stat.mode & 0o777);
    fs.writeFileSync(descriptor, next, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, statePath);
    fs.chmodSync(statePath, stat.mode & 0o777);
    return { status: "synchronized", path: statePath };
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch { /* preserve the original error */ }
    throw exactError("hourly_controller_state_sync_failed", { message: String(error?.message || error).slice(0, 300) });
  }
}

function statePathForAudit(auditPath, requested) {
  if (requested !== undefined && requested !== null) return requested;
  const canonicalArtifactRoot = "/Users/nichikatanaka/Documents/Codex/automation-os/.codex/automation-kernel/artifacts/aos-companion-2";
  return auditPath.startsWith(`${canonicalArtifactRoot}${path.sep}`) ? CANONICAL_STATE_PATH : null;
}

function currentRootMetadata(globals) {
  const metadata = globals?.nodeRepl?.requestMeta?.[HOST_METADATA_HEADER];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw exactError("codex_app_registered_automation_identity_capability_unavailable");
  }
  if (metadata.thread_source !== "automation") {
    throw exactError("current_root_execute_metadata_thread_source_invalid");
  }
  return {
    threadSource: "automation",
    sessionId: boundedText(metadata.session_id, "session_id", 256),
    threadId: boundedText(metadata.thread_id, "thread_id", 256),
    turnId: boundedText(metadata.turn_id, "turn_id", 256),
  };
}

function resultStatus(value) {
  if (!value || typeof value !== "object") return null;
  return boundedText(value.status ?? value.resultStatus, "result_status", 80);
}

function readbackSummary(value) {
  const source = value?.readback ?? value?.result?.readback ?? value?.readbackResult ?? value?.statusReadback ?? null;
  if (!source || typeof source !== "object") return { status: null, exactBlocker: null };
  return {
    status: boundedText(source.status, "readback_status", 80),
    exactBlocker: boundedText(source.exact_blocker ?? source.exactBlocker, "readback_exact_blocker", 300),
    goalPlanState: boundedText(source.goal_plan_state ?? source.goalPlanState, "goal_plan_state", 80),
  };
}

function compactCallbackEvidence(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw exactError("hourly_controller_callback_evidence_required");
  }
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw exactError("hourly_controller_callback_evidence_invalid", { index });
    }
    const stage = boundedText(entry.stage, "stage", 100);
    const tool = boundedText(entry.tool ?? entry.toolName, "tool", 180);
    const threadId = boundedText(entry.threadId ?? entry.thread_id, "thread_id", 256);
    if (!stage || !tool) throw exactError("hourly_controller_callback_evidence_invalid", { index });
    const result = entry.result && typeof entry.result === "object" ? entry.result : {};
    const readback = readbackSummary(entry);
    return {
      stage,
      tool,
      threadId,
      status: boundedText(entry.status ?? result.status ?? entry.resultStatus, "status", 80),
      resultStatus: resultStatus(result),
      exactBlocker: boundedText(entry.exact_blocker ?? entry.exactBlocker ?? result.exact_blocker ?? result.exactBlocker, "exact_blocker", 300),
      readbackStatus: readback.status,
      readbackExactBlocker: readback.exactBlocker,
      goalPlanState: readback.goalPlanState,
      externalActionExecuted: result.external_action_executed === true || result.externalActionExecuted === true,
      reflected: result.reflected === true || result.status === "reflected",
    };
  });
}

function compactFreshStatus(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    connected: source.connected === true,
    generation: boundedText(source.generation ?? source.runtimeGeneration ?? source.runtime_generation, "generation", 256),
    activeLeaseCount: Number.isFinite(Number(source.activeLeaseCount)) ? Number(source.activeLeaseCount) : null,
    pendingCount: Number.isFinite(Number(source.pendingCount)) ? Number(source.pendingCount) : null,
    queueCount: Number.isFinite(Number(source.queueCount)) ? Number(source.queueCount) : null,
    activeReconciliationCount: Number.isFinite(Number(source.activeReconciliationCount)) ? Number(source.activeReconciliationCount) : null,
  };
}

function compactContinuation(entry) {
  const result = entry?.result && typeof entry.result === "object" ? entry.result : {};
  const readback = readbackSummary(result);
  return {
    threadId: boundedText(entry?.threadId ?? entry?.thread_id, "continuation_thread_id", 256),
    idempotencyKey: boundedText(entry?.idempotencyKey ?? entry?.idempotency_key, "idempotency_key", 256),
    result: {
      status: boundedText(result.status, "continuation_status", 80),
      exactBlocker: boundedText(result.exact_blocker ?? result.exactBlocker, "continuation_exact_blocker", 300),
      readbackStatus: readback.status,
      readbackExactBlocker: readback.exactBlocker,
      goalPlanState: readback.goalPlanState,
      replayAllowed: result.replay_allowed === true || result.replayAllowed === true,
      externalActionExecuted: result.external_action_executed === true || result.externalActionExecuted === true,
    },
  };
}

function compactThreadInspection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    schema: boundedText(value.schema, "thread_inspection_schema", 160),
    source: boundedText(value.source, "thread_inspection_source", 160),
    mode: boundedText(value.mode, "thread_inspection_mode", 160),
    listedCount: boundedCount(value.listedCount, "listed_count"),
    eligibleTaskCount: boundedCount(value.eligibleTaskCount, "eligible_task_count"),
    skippedNonUserOwnedCount: boundedCount(value.skippedNonUserOwnedCount, "skipped_non_user_owned_count"),
    lightweightInspectionCount: boundedCount(value.lightweightInspectionCount, "lightweight_inspection_count"),
    lightweightReadCount: boundedCount(value.lightweightReadCount, "lightweight_read_count"),
    deepReadCandidateCount: boundedCount(value.deepReadCandidateCount, "deep_read_candidate_count"),
    deepReadAttemptedCount: boundedCount(value.deepReadAttemptedCount, "deep_read_attempted_count"),
    deepReadCount: boundedCount(value.deepReadCount, "deep_read_count"),
    deepReadTruncated: value.deepReadTruncated === true,
  };
}

function officialAppOnlyContinuationCandidateCount(audit) {
  if (Array.isArray(audit?.officialAppOnlyContinuationCandidates)) {
    return audit.officialAppOnlyContinuationCandidates.filter((candidate) => candidate && typeof candidate === "object").length;
  }
  return Number.isInteger(Number(audit?.officialAppOnlyContinuationCandidateCount))
    ? Math.max(0, Number(audit.officialAppOnlyContinuationCandidateCount))
    : 0;
}

function taskOwnedContinuationCandidateCount(audit) {
  if (Array.isArray(audit?.taskOwnedContinuationCandidates)) {
    return audit.taskOwnedContinuationCandidates.filter((candidate) => candidate && typeof candidate === "object").length;
  }
  return Number.isInteger(Number(audit?.taskOwnedContinuationCandidateCount))
    ? Math.max(0, Number(audit.taskOwnedContinuationCandidateCount))
    : 0;
}

function compactController(controller = {}) {
  const actions = Array.isArray(controller.actions) ? controller.actions.map((value) => String(value)) : [];
  for (const action of actions) {
    if (!FINALIZABLE_ACTIONS.has(action)) throw exactError("hourly_controller_action_invalid", { action });
  }
  return {
    schema: boundedText(controller.schema, "controller_schema", 160),
    status: boundedText(controller.status, "controller_status", 80),
    auditFingerprint: boundedText(controller.auditFingerprint ?? controller.audit_fingerprint, "audit_fingerprint", 160),
    exactBlocker: boundedText(controller.exact_blocker ?? controller.exactBlocker, "controller_exact_blocker", 300),
    exact_blocker: boundedText(controller.exact_blocker ?? controller.exactBlocker, "controller_exact_blocker", 300),
    externalActionExecuted: controller.external_action_executed === true || controller.externalActionExecuted === true,
    external_action_executed: controller.external_action_executed === true || controller.externalActionExecuted === true,
    threadInspection: compactThreadInspection(controller.threadInspection),
    actions,
    freshStatus: compactFreshStatus(controller.freshStatus ?? controller.fresh_status),
    blockerProgress: controller.blockerProgress
      ? {
          reason: boundedText(controller.blockerProgress.reason, "blocker_reason", 100),
          status: boundedText(controller.blockerProgress.status, "blocker_status", 80),
          attempted: controller.blockerProgress.attempted === true,
          resumeAllowed: controller.blockerProgress.resumeAllowed === true,
          exactBlocker: boundedText(controller.blockerProgress.exact_blocker ?? controller.blockerProgress.exactBlocker, "blocker_exact_blocker", 300),
        }
      : null,
    repair: controller.repair
      ? {
          attempted: controller.repair.attempted === true,
          threadId: boundedText(controller.repair.threadId ?? controller.repair.thread_id, "repair_thread_id", 256),
          playbookId: boundedText(controller.repair.playbookId, "playbook_id", 160),
          resultStatus: resultStatus(controller.repair.result),
        }
      : null,
    verification: controller.verification
      ? {
          resultStatus: resultStatus(controller.verification),
          continuationAllowed: controller.verification.continuationAllowed === true,
        }
      : null,
    refresh: controller.refresh
      ? {
          status: boundedText(controller.refresh.status, "refresh_status", 80),
          reflected: controller.refresh.reflected === true || controller.refresh.status === "reflected",
          generation: boundedText(controller.refresh.generation, "refresh_generation", 256),
        }
      : null,
    continuations: (Array.isArray(controller.continuations) ? controller.continuations : []).map(compactContinuation),
    independentContinuations: (Array.isArray(controller.independentContinuations) ? controller.independentContinuations : []).map(compactContinuation),
    nextActionNow: boundedText(controller.next_action_now ?? controller.nextActionNow, "next_action_now", 1_000),
    next_action_now: boundedText(controller.next_action_now ?? controller.nextActionNow, "next_action_now", 1_000),
    resumeTrigger: boundedText(controller.resume_trigger ?? controller.resumeTrigger, "resume_trigger", 600),
    resume_trigger: boundedText(controller.resume_trigger ?? controller.resumeTrigger, "resume_trigger", 600),
  };
}

function deferUnreachedStages(executionReceipt, controller) {
  const status = String(executionReceipt?.status || "");
  const exactBlocker = controller?.exact_blocker ?? controller?.exactBlocker ?? null;
  const blocked = Boolean(exactBlocker) || ["deferred", "blocked", "failed"].includes(status);
  const unreachedStatus = blocked ? "deferred" : "not_applicable";
  const unreachedBlocker = exactBlocker
    || (blocked ? "hourly_controller_stage_not_reached_after_blocker" : null);
  const stages = Object.fromEntries(Object.entries(executionReceipt.stageReceipts || {}).map(([stage, receipt]) => {
    if (receipt?.status !== "not_run") return [stage, receipt];
    return [stage, unreachedStatus === "deferred"
      ? {
          status: unreachedStatus,
          exactBlocker: unreachedBlocker,
          nextActionNow: controller?.next_action_now ?? controller?.nextActionNow ?? null,
          resumeTrigger: controller?.resume_trigger ?? controller?.resumeTrigger ?? null,
        }
      : {
          status: unreachedStatus,
          reason: "stage_not_selected_in_this_run",
        }];
  }));
  return { ...executionReceipt, stageReceipts: stages, stages };
}

function assertNoUnreachedStages(executionReceipt) {
  const unreached = Object.entries(executionReceipt?.stageReceipts || {})
    .filter(([, receipt]) => receipt?.status === "not_run")
    .map(([stage]) => stage);
  if (unreached.length > 0) {
    throw exactError("hourly_controller_unresolved_not_run_stage", { stages: unreached });
  }
}

function validateCompletion(controller, receipt, evidence) {
  if (controller.external_action_executed === true || controller.externalActionExecuted === true) {
    throw exactError("hourly_controller_external_effect_forbidden");
  }
  const actions = new Set(Array.isArray(controller.actions) ? controller.actions : []);
  if (receipt.complete !== true) return;
  if (!controller.freshStatus && !controller.fresh_status) {
    throw exactError("hourly_controller_fresh_status_proof_required");
  }
  const evidenceStages = new Set(evidence.map((entry) => entry.stage));
  for (const action of actions) {
    if (!evidenceStages.has(action) && !(action === "reconciliation" && evidenceStages.has("blocker_progress"))) {
      throw exactError("hourly_controller_callback_evidence_missing", { action });
    }
  }
  const continuations = [
    ...(Array.isArray(controller.continuations) ? controller.continuations : []),
    ...(Array.isArray(controller.independentContinuations) ? controller.independentContinuations : []),
  ];
  for (const continuation of continuations) {
    const result = continuation?.result;
    const status = String(result?.status || "");
    if (!["sent", "queued", "duplicate_suppressed"].includes(status)) {
      throw exactError("hourly_controller_continuation_result_not_terminal", { status });
    }
    const readback = readbackSummary(result);
    if (status !== "duplicate_suppressed" && readback.status !== "observed") {
      throw exactError("hourly_controller_continuation_readback_required");
    }
    if (status === "sent" && !["active", "continued", "in_progress", "resumed", "running", "verified"].includes(String(readback.goalPlanState || "").toLowerCase())) {
      throw exactError("hourly_controller_goal_plan_readback_required");
    }
    if (result?.external_action_executed === true || result?.externalActionExecuted === true) {
      throw exactError("hourly_controller_external_effect_forbidden");
    }
  }
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Persist the post-audit controller result after the current official Root has
 * actually called App tools. The immutable audit remains untouched; the
 * mutable audit gets a pointer to this append-only controller receipt.
 */
export function finalizeHourlyControllerReceipt({
  auditPath,
  controllerOutcome = null,
  callbackEvidence = [],
  statePath = undefined,
  globals = globalThis,
} = {}) {
  const root = currentRootMetadata(globals);
  if (typeof auditPath !== "string" || !path.isAbsolute(auditPath) || path.basename(auditPath) !== "aos-hourly-companion-audit.v1.json") {
    throw exactError("hourly_controller_audit_path_invalid");
  }
  let audit;
  try { audit = JSON.parse(fs.readFileSync(auditPath, "utf8")); }
  catch { throw exactError("hourly_controller_audit_read_failed"); }
  if (audit?.schema !== "aos.hourly_companion_audit.v1" || !audit.runId || !audit.auditFingerprint) {
    throw exactError("hourly_controller_audit_invalid");
  }
  if (audit.executionReceipt?.rootActionRequired !== true) {
    throw exactError("hourly_controller_root_action_not_required");
  }
  if (!controllerOutcome || typeof controllerOutcome !== "object" || Array.isArray(controllerOutcome)) {
    throw exactError("hourly_controller_outcome_required");
  }
  const evidence = compactCallbackEvidence(callbackEvidence);
  const compact = compactController({
    ...controllerOutcome,
    // The audit already contains bounded counts from the actual official
    // list/read callbacks. Carry those counts into the final controller
    // receipt without copying task bodies, titles, or raw transcripts.
    threadInspection: controllerOutcome.threadInspection ?? audit.threadInspection,
  });
  const officialOnlyCount = officialAppOnlyContinuationCandidateCount(audit);
  const taskOwnedRelayCount = taskOwnedContinuationCandidateCount(audit);
  const controllerBlocker = String(controllerOutcome.exact_blocker ?? controllerOutcome.exactBlocker ?? "");
  if ((officialOnlyCount > 0 || taskOwnedRelayCount > 0) && OFFICIAL_APP_ONLY_CONTINUATION_GAP_BLOCKERS.has(controllerBlocker)) {
    throw exactError("hourly_controller_official_app_only_continuation_required", {
      candidate_count: officialOnlyCount + taskOwnedRelayCount,
      official_app_only_candidate_count: officialOnlyCount,
      task_owned_relay_candidate_count: taskOwnedRelayCount,
      exact_blocker: controllerBlocker,
    });
  }
  const executionReceipt = deferUnreachedStages(buildControllerExecutionReceipt(compact), compact);
  assertNoUnreachedStages(executionReceipt);
  validateCompletion(controllerOutcome, executionReceipt, evidence);
  if (compact.auditFingerprint && compact.auditFingerprint !== audit.auditFingerprint) {
    throw exactError("hourly_controller_audit_fingerprint_mismatch");
  }
  const safeRunId = String(audit.runId).replace(/[^A-Za-z0-9._-]+/gu, "-");
  const receiptPath = path.join(path.dirname(auditPath), `aos-hourly-companion-controller-receipt-${safeRunId}.v1.json`);
  const resolvedStatePath = statePathForAudit(auditPath, statePath);
  if (fs.existsSync(receiptPath)) {
    let existingReceipt;
    try { existingReceipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")); }
    catch { throw exactError("hourly_controller_receipt_read_failed"); }
    const stateSync = resolvedStatePath
      ? synchronizeStateFile({ statePath: resolvedStatePath, receipt: existingReceipt, receiptPath })
      : null;
    return { created: false, exact_blocker: "hourly_controller_receipt_already_finalized", path: receiptPath, stateSync };
  }
  const receipt = {
    schema: HOURLY_CONTROLLER_RECEIPT_SCHEMA,
    runId: audit.runId,
    auditFingerprint: audit.auditFingerprint,
    root,
    controller: compact,
    executionReceipt,
    callbackEvidence: evidence,
    callbackEvidenceDigest: digest(evidence),
    finalizedAt: new Date().toISOString(),
    auditPath,
    immutableAuditPath: audit.immutableArtifactPath ?? null,
  };
  const created = privateJsonNoReplace(receiptPath, receipt);
  if (!created.created) return { created: false, exact_blocker: "hourly_controller_receipt_already_finalized", path: receiptPath };

  const updatedAudit = {
    ...audit,
    controllerReceiptPath: receiptPath,
    controllerReceiptSchema: HOURLY_CONTROLLER_RECEIPT_SCHEMA,
    controllerReceiptDigest: digest(receipt),
    controllerOutcome: compact,
    executionReceipt,
    externalActionExecuted: audit.externalActionExecuted === true || executionReceipt.externalActionExecuted === true,
  };
  privateJson(auditPath, updatedAudit);
  if (audit.verifierArtifactPath) {
    privateJson(audit.verifierArtifactPath, {
      ...buildVerifierProjection(updatedAudit),
      controllerReceiptPath: receiptPath,
      executionReceipt,
    });
  }
  const stateSync = resolvedStatePath
    ? synchronizeStateFile({ statePath: resolvedStatePath, receipt, receiptPath })
    : null;
  if (stateSync) {
    const synchronizedAudit = { ...updatedAudit, stateSync };
    privateJson(auditPath, synchronizedAudit);
    if (audit.verifierArtifactPath) {
      privateJson(audit.verifierArtifactPath, {
        ...buildVerifierProjection(synchronizedAudit),
        controllerReceiptPath: receiptPath,
        executionReceipt,
        stateSync,
      });
    }
  }
  return {
    created: true,
    path: receiptPath,
    auditPath,
    verifierArtifactPath: audit.verifierArtifactPath ?? null,
    executionReceipt,
    stateSync,
  };
}

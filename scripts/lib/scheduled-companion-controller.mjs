import fs from "node:fs";
import path from "node:path";

// The registered heartbeat imports this controller with a per-tick query
// parameter. Propagate that boundary to local dependencies too; otherwise a
// long-lived node_repl can retain an older bridge/dispatcher after a repair.
const heartbeatRun = new URL(import.meta.url).searchParams.get("heartbeat_run") || "controller";
const bridgeModuleUrl = new URL("./codex-app-server-companion-bridge.mjs", import.meta.url);
bridgeModuleUrl.searchParams.set("heartbeat_run", heartbeatRun);
const dispatchModuleUrl = new URL("./hourly-thread-dispatch.mjs", import.meta.url);
dispatchModuleUrl.searchParams.set("heartbeat_run", heartbeatRun);
const adapterModuleUrl = new URL("file:///Users/nichikatanaka/.codex/skills/automation-kernel-run/scripts/current-root-execute-adapter.mjs");
adapterModuleUrl.searchParams.set("heartbeat_run", heartbeatRun);
const [bridgeModule, dispatchModule, adapterModule] = await Promise.all([
  import(bridgeModuleUrl.href),
  import(dispatchModuleUrl.href),
  import(adapterModuleUrl.href),
]);
const { buildDiagnosticProjectionFromReview, collectRecentTaskReview } = bridgeModule;
const { createFileDispatchLedger } = dispatchModule;
const {
  finalizeCurrentRootHourlyController,
  runCurrentRootRegisteredAutomation,
} = adapterModule;

export const SCHEDULED_COMPANION_CONTROLLER_SCHEMA = "aos.scheduled_companion_controller.v1";
export const SCHEDULED_COMPANION_RUNNER_PATH = "/Users/nichikatanaka/Documents/Codex/automation-os/.codex/automation-kernel/runners/aos-companion-2.mjs";
export const SCHEDULED_COMPANION_ARTIFACT_ROOT = "/Users/nichikatanaka/Documents/Codex/automation-os/.codex/automation-kernel/artifacts/aos-companion-2";
export const SCHEDULED_COMPANION_LEDGER_ROOT = "/Users/nichikatanaka/.codex/automations/aos-companion-2/continuation-ledger";
export const SCHEDULED_COMPANION_MAX_CONTINUATIONS = 3;
const SCAN_STATE_PATH = path.join(SCHEDULED_COMPANION_LEDGER_ROOT, "scan-state.json");

export function selectFairCandidates(candidates, lastThreadId = null, limit = SCHEDULED_COMPANION_MAX_CONTINUATIONS) {
  const sorted = [...candidates].sort((a, b) => String(a.threadId).localeCompare(String(b.threadId)));
  const after = lastThreadId ? sorted.findIndex((item) => String(item.threadId) > lastThreadId) : 0;
  const start = after < 0 ? 0 : after;
  return [...sorted.slice(start), ...sorted.slice(0, start)].slice(0, limit);
}

function readScanState() {
  try { return JSON.parse(fs.readFileSync(SCAN_STATE_PATH, "utf8")); } catch { return {}; }
}

function saveScanState(value) {
  fs.mkdirSync(path.dirname(SCAN_STATE_PATH), { recursive: true, mode: 0o700 });
  const temporary = `${SCAN_STATE_PATH}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, SCAN_STATE_PATH);
}

function exactError(code, details = {}) {
  const error = new Error(code);
  error.exact_blocker = code;
  error.details = details;
  return error;
}

function text(value, max = 500) {
  return String(value ?? "")
    .replace(/[\u0000\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

function metadataFor(globals) {
  const metadata = globals?.nodeRepl?.requestMeta?.["x-codex-turn-metadata"];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw exactError("codex_app_registered_automation_identity_capability_unavailable");
  }
  for (const field of ["thread_id", "turn_id", "session_id"]) {
    if (!text(metadata[field], 256)) throw exactError("codex_app_registered_automation_identity_capability_unavailable", { field });
  }
  return metadata;
}

function readAudit(runId) {
  if (!text(runId, 256)) throw exactError("scheduled_companion_run_id_missing");
  const auditPath = path.join(SCHEDULED_COMPANION_ARTIFACT_ROOT, text(runId, 256), "aos-hourly-companion-audit.v1.json");
  let audit;
  try { audit = JSON.parse(fs.readFileSync(auditPath, "utf8")); }
  catch { throw exactError("scheduled_companion_audit_read_failed", { auditPath }); }
  if (audit?.schema !== "aos.hourly_companion_audit.v1" || !text(audit.runId, 256) || !text(audit.auditFingerprint, 256)) {
    throw exactError("scheduled_companion_audit_invalid", { auditPath });
  }
  return { audit, auditPath };
}

function freshStatusFromAudit(audit) {
  const stage = audit?.executionReceipt?.stages?.fresh_status
    || audit?.executionReceipt?.stageReceipts?.fresh_status
    || {};
  return {
    generation: stage.generation ?? null,
    activeLeaseCount: stage.activeLeaseCount ?? null,
    pendingCount: stage.pendingCount ?? null,
    queueCount: stage.queueCount ?? null,
    activeReconciliationCount: stage.activeReconciliationCount ?? null,
    connected: stage.connected === true,
  };
}

function threadInspectionFromAudit(audit) {
  const source = audit?.threadInspection || {};
  return {
    schema: source.schema || "aos.codex_app_thread_inspection.v1",
    source: source.source || "official_codex_app_server_bridge",
    mode: source.mode || "fresh_official_readback",
    listedCount: source.listedCount ?? audit?.executionReceipt?.stages?.thread_inventory?.listedCount ?? null,
    eligibleTaskCount: source.eligibleTaskCount ?? audit?.executionReceipt?.stages?.thread_inventory?.eligibleTaskCount ?? null,
    skippedNonUserOwnedCount: source.skippedNonUserOwnedCount ?? audit?.executionReceipt?.stages?.thread_inventory?.skippedNonUserOwnedCount ?? null,
    lightweightInspectionCount: source.lightweightInspectionCount ?? audit?.executionReceipt?.stages?.lightweight_thread_inspection?.inspectedCount ?? null,
    lightweightReadCount: source.lightweightReadCount ?? audit?.executionReceipt?.stages?.lightweight_thread_inspection?.readbackCount ?? null,
    deepReadCandidateCount: source.deepReadCandidateCount ?? audit?.executionReceipt?.stages?.deep_read_selection?.candidateCount ?? null,
    deepReadAttemptedCount: source.deepReadAttemptedCount ?? audit?.executionReceipt?.stages?.deep_read_selection?.attemptedCount ?? null,
    deepReadCount: source.deepReadCount ?? audit?.executionReceipt?.stages?.deep_read_selection?.readCount ?? null,
    deepReadTruncated: source.deepReadTruncated === true || audit?.executionReceipt?.stages?.deep_read_selection?.truncated === true,
  };
}

/** Collect diagnostics without sending or finalizing the Root's later work.
 * Only the current Root's native Desktop tools may perform continuations.
 */
export async function runScheduledCompanionController({ globals = globalThis, nativeThreads = [], nativeInventoryComplete = false } = {}) {
  const metadata = metadataFor(globals);
  const ledger = createFileDispatchLedger({ root: SCHEDULED_COMPANION_LEDGER_ROOT, scope: "global" });
  const recentReview = await collectRecentTaskReview({ runId: metadata.turn_id, nativeThreads, nativeInventoryComplete,
    pendingThreadIds: ledger.listPending().map((entry) => entry.threadId).filter(Boolean) });
  // Separate App Server snapshots can report a live Desktop task as interrupted.
  // Collect diagnostics here, but only the Root's native Desktop tools may send.
  let diagnostic;
  try { diagnostic = await runCompanionDiagnostic({ globals, recentReview }); }
  catch (error) { diagnostic = { status: "deferred", exact_blocker: error.exact_blocker || error.message }; }
  return { schema: SCHEDULED_COMPANION_CONTROLLER_SCHEMA, rootThreadId: metadata.thread_id, rootTurnId: metadata.turn_id,
    recentReview, diagnostic,
    rootActionRequired: true, continuationTransport: "native_desktop_only",
    nextAction: "Read every row and record context-specific decisions; Goal blocked is not a cause classification. Repair verified local defects, then fresh native Desktop read/wait before ledger-protected notifications. Finally call finalizeScheduledCompanionReview with actual controllerOutcome and callbackEvidence; never finalize during collection. Collection is not completed review." };
}

async function runCompanionDiagnostic({ globals = globalThis, recentReview } = {}) {
  const metadata = metadataFor(globals);
  const rootRunId = metadata.turn_id;
  const scanState = readScanState();
  const report = JSON.parse(fs.readFileSync(recentReview.reportPath, "utf8"));
  const bridge = buildDiagnosticProjectionFromReview({ report, rootRunId,
    excludeThreadIds: [metadata.thread_id], lastInspectedThreadId: scanState.lastInspectedThreadId });
  const rootResult = await runCurrentRootRegisteredAutomation({
    runnerPath: SCHEDULED_COMPANION_RUNNER_PATH,
    globals,
    threadReadbackProjection: bridge.projection,
  });
  const runId = rootResult?.run_id || rootResult?.runId;
  let source;
  try {
    source = readAudit(runId);
  } catch (error) {
    // Never relabel an arbitrary older audit as this natural run. Preserve
    // its diagnostic failure and let the Root continue the fresh review.
    return { status: "deferred", runId: runId || null, rootResult,
      readbackSource: bridge.source, reviewRunId: bridge.reviewRunId,
      exact_blocker: rootResult?.exact_blocker || rootResult?.exactBlocker || error.exact_blocker || error.message };
  }
  const { audit, auditPath } = source;
  saveScanState({ ...scanState, lastInspectedThreadId: bridge.lastInspectedThreadId || scanState.lastInspectedThreadId,
    updatedAt: new Date().toISOString() });
  return {
    status: audit.executionReceipt?.rootActionRequired === true ? "awaiting_root_review" : audit.executionReceipt?.status,
    readbackSource: bridge.source, reviewRunId: bridge.reviewRunId,
    snapshotOnlyCount: bridge.snapshotOnlyCount,
    runId, auditPath, auditFingerprint: audit.auditFingerprint, rootResult,
    freshStatus: freshStatusFromAudit(audit), threadInspection: threadInspectionFromAudit(audit),
    // No candidate disposition or final receipt exists until the Root reads
    // the tasks and performs/defers each actual authorized action.
    rootActionRequired: audit.executionReceipt?.rootActionRequired === true,
    controllerFinalized: false, external_action_executed: false,
  };
}

/** Close only the current natural run, after its per-task judgments/actions.
 * The existing finalizer validates actual completion/continuation evidence.
 */
export async function finalizeScheduledCompanionReview({ result, controllerOutcome, callbackEvidence = [], globals = globalThis } = {}) {
  const metadata = metadataFor(globals);
  if (result?.rootThreadId !== metadata.thread_id || result?.rootTurnId !== metadata.turn_id) {
    throw exactError("scheduled_companion_review_root_mismatch");
  }
  const report = JSON.parse(fs.readFileSync(result.recentReview.reportPath, "utf8"));
  if (report.runId !== metadata.turn_id || report.rows.some((row) => !row.decision)) {
    throw exactError("scheduled_companion_review_not_finished");
  }
  if (!result.diagnostic?.auditPath) return { status: "deferred", controllerFinalized: false,
    exact_blocker: result.diagnostic?.exact_blocker || "scheduled_companion_current_audit_missing", coverage: report.coverage };
  const { audit, auditPath } = readAudit(result.diagnostic.runId);
  if (auditPath !== result.diagnostic.auditPath || audit.auditFingerprint !== result.diagnostic.auditFingerprint) {
    throw exactError("scheduled_companion_review_audit_mismatch");
  }
  if (audit.executionReceipt?.rootActionRequired !== true) return { status: "review_recorded", controllerFinalized: false,
    reason: "diagnostic_did_not_request_callback", coverage: report.coverage };
  if (!controllerOutcome || typeof controllerOutcome !== "object") throw exactError("scheduled_companion_controller_outcome_required");
  return finalizeCurrentRootHourlyController({ auditPath, globals, callbackEvidence,
    controllerOutcome: { ...controllerOutcome, auditFingerprint: audit.auditFingerprint,
      threadInspection: controllerOutcome?.threadInspection ?? threadInspectionFromAudit(audit),
      freshStatus: controllerOutcome?.freshStatus ?? freshStatusFromAudit(audit) } });
}

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HOURLY_EXECUTION_STAGE_ORDER } from "../aos-hourly-companion-audit.mjs";

export const HOURLY_CAPABILITY_BLOCKER_RECEIPT_SCHEMA = "aos.companion_hourly_capability_blocker_receipt.v1";
const HOST_METADATA_HEADER = "x-codex-turn-metadata";
const REQUIRED_OFFICIAL_TOOLS = Object.freeze([
  "mcp__codex_app__list_threads",
  "mcp__codex_app__read_thread",
  "mcp__codex_app__send_message_to_thread",
]);

function exactError(code, details = {}) {
  const error = new Error(code);
  error.exact_blocker = code;
  error.details = details;
  return error;
}

function boundedText(value, field, max = 256) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max || !/^[\x20-\x7e]+$/u.test(text)) {
    throw exactError("hourly_capability_receipt_metadata_invalid", { field });
  }
  return text;
}

function currentRootMetadata(globals = globalThis) {
  const metadata = globals?.nodeRepl?.requestMeta?.[HOST_METADATA_HEADER];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw exactError("codex_app_registered_automation_identity_capability_unavailable");
  }
  if (metadata.thread_source !== "automation") {
    throw exactError("current_root_execute_metadata_thread_source_invalid");
  }
  return {
    threadSource: "automation",
    sessionId: boundedText(metadata.session_id, "session_id"),
    threadId: boundedText(metadata.thread_id, "thread_id"),
    turnId: boundedText(metadata.turn_id, "turn_id"),
  };
}

function safeRunPart(value, field) {
  const text = boundedText(value, field, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(text)) {
    throw exactError("hourly_capability_receipt_path_invalid", { field });
  }
  return text;
}

function exclusiveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
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

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function executionReceipt({ exactBlocker, nextActionNow, resumeTrigger, fallbackOrIndependentWork }) {
  const stageReceipts = Object.fromEntries(HOURLY_EXECUTION_STAGE_ORDER.map((stage) => [stage, {
    status: "deferred",
    exactBlocker,
    nextActionNow,
    resumeTrigger,
  }]));
  return {
    schema: "aos.companion_hourly_execution_receipt.v1",
    status: "deferred_before_projection",
    complete: false,
    auditOnly: false,
    rootExecution: "not_admitted",
    projectionCreated: false,
    externalActionExecuted: false,
    exactBlocker,
    nextActionNow,
    resumeTrigger,
    fallbackOrIndependentWork,
    stageOrder: HOURLY_EXECUTION_STAGE_ORDER,
    stageReceipts,
    stages: stageReceipts,
  };
}

function readback(file) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw exactError("hourly_capability_receipt_readback_failed", { path: file });
  }
  if (value?.schema !== HOURLY_CAPABILITY_BLOCKER_RECEIPT_SCHEMA) {
    throw exactError("hourly_capability_receipt_readback_invalid", { path: file });
  }
  return value;
}

/**
 * Record the official-App capability boundary before a fresh task projection
 * exists. This is diagnostic/continuation state only: it never creates an
 * identity, calls a task API, invokes the Kernel, or authorizes an effect.
 */
export function recordHourlyCapabilityBlocker({
  artifactRoot,
  automationId = "aos-companion-2",
  globals = globalThis,
  exactBlocker = "codex_app_thread_inventory_capability_unavailable",
  unavailableTools = REQUIRED_OFFICIAL_TOOLS,
  nextActionNow = "re-check the official App callable registry, then build one fresh host-bound projection and invoke the registered Root exactly once",
  resumeTrigger = "all required official list/read/send tools are callable and a fresh host-bound projection validates",
  fallbackOrIndependentWork = "retain prior immutable receipts and continue read-only AOS/Companion monitoring without reusing them as current proof",
} = {}) {
  const root = currentRootMetadata(globals);
  const selectedAutomationId = safeRunPart(automationId, "automation_id");
  if (typeof artifactRoot !== "string" || !path.isAbsolute(artifactRoot)) {
    throw exactError("hourly_capability_receipt_path_invalid", { field: "artifact_root" });
  }
  const blocker = safeRunPart(exactBlocker, "exact_blocker");
  const missing = [...new Set((Array.isArray(unavailableTools) ? unavailableTools : []).map((value) => safeRunPart(value, "unavailable_tool")))].sort();
  if (missing.length === 0) throw exactError("hourly_capability_receipt_missing_tools");
  const receipt = {
    schema: HOURLY_CAPABILITY_BLOCKER_RECEIPT_SCHEMA,
    version: 1,
    automationId: selectedAutomationId,
    recordedAt: new Date().toISOString(),
    root,
    capabilityCheck: {
      source: "official_scheduler_callable_registry",
      requiredTools: [...REQUIRED_OFFICIAL_TOOLS],
      unavailableTools: missing,
      projectionCreated: false,
      registeredRootInvoked: false,
    },
    exactBlocker: blocker,
    progressAttemptNow: "fresh callable-registry and host-identity readback; no task API fallback",
    nextActionNow: boundedText(nextActionNow, "next_action_now", 1_000),
    resumeTrigger: boundedText(resumeTrigger, "resume_trigger", 600),
    fallbackOrIndependentWork: boundedText(fallbackOrIndependentWork, "fallback_or_independent_work", 1_000),
    externalActionExecuted: false,
  };
  receipt.executionReceipt = executionReceipt(receipt);
  receipt.receiptDigest = digest(receipt);
  const file = path.join(
    artifactRoot,
    "capability-blockers",
    `${selectedAutomationId}-${safeRunPart(root.turnId, "turn_id")}.v1.json`,
  );
  const written = exclusiveJson(file, receipt);
  const stored = readback(file);
  if (stored.receiptDigest !== receipt.receiptDigest && written.created) {
    throw exactError("hourly_capability_receipt_readback_digest_mismatch", { path: file });
  }
  return {
    created: written.created,
    path: file,
    schema: stored.schema,
    receiptDigest: stored.receiptDigest,
    exactBlocker: stored.exactBlocker,
    executionReceipt: stored.executionReceipt,
    readback: {
      status: "observed",
      path: file,
      receiptDigest: stored.receiptDigest,
      externalActionExecuted: stored.externalActionExecuted === true,
    },
  };
}

export { REQUIRED_OFFICIAL_TOOLS, HOURLY_EXECUTION_STAGE_ORDER as HOURLY_STAGE_ORDER };

#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { validateCompanionIsolationBinding } from "./lib/companion-isolation-binding.mjs";
import {
  AOS_EXECUTION_CONTEXT_SCHEMA,
  buildAosExecutionContext,
  canContinueAosExecution,
  resolveAosExecutionContext,
  validateAosExecutionContext,
} from "./lib/aos-execution-context.mjs";

export {
  AOS_EXECUTION_CONTEXT_SCHEMA,
  buildAosExecutionContext,
  canContinueAosExecution,
  resolveAosExecutionContext,
  validateAosExecutionContext,
} from "./lib/aos-execution-context.mjs";

export const AOS_CHROME_COMPANION_ADAPTER_SCHEMA = "aos.chrome_companion_adapter.v1";
export const AOS_CHROME_COMPANION_SURFACE = "aos_chrome_companion_profile_instance";
export const AOS_CHROME_COMPANION_TASK_CONTRACT_SCHEMA = "aos.chrome_companion.task_contract.v1";
export const AOS_CHROME_COMPANION_TASK_CONTRACT_VERSION = 1;
export const AOS_CHROME_COMPANION_STANDARD_ROOT = join(homedir(), "Library", "Application Support", "AOS Chrome Companion", "app");
// A signed transaction may contain semantic preconditions, screenshot
// readback, and one verified visual fallback. Keep the caller deadline above
// the broker's per-operation 30s bound so queued foreground work returns a
// structured receipt instead of timing out the client while the broker is
// still finishing the same non-replayable transaction.
const AUTHORIZED_TRANSACTION_TIMEOUT_MS = 180_000;

function requiredString(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 240) {
    throw companionAdapterError("companion_adapter_input_invalid", `${field} must be a non-empty bounded string`);
  }
  return normalized;
}

function companionAdapterError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function normalizeUrl(value, field = "url") {
  let parsed;
  try {
    parsed = new URL(requiredString(value, field));
  } catch (error) {
    if (error?.code === "companion_adapter_input_invalid") throw error;
    throw companionAdapterError("companion_adapter_url_invalid", `${field} must be a valid URL`);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password) {
    throw companionAdapterError(
      "companion_adapter_url_not_allowed",
      `${field} must be a credential-free http(s) URL`,
    );
  }
  return parsed;
}

function allowedOriginSet(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw companionAdapterError("companion_adapter_allowed_origins_missing", "allowedOrigins is required");
  }
  return new Set(values.map((value) => normalizeUrl(value, "allowedOrigins entry").origin));
}

function digest(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function capabilityDigest(capabilities) {
  return digest(JSON.stringify([...new Set(capabilities)].sort()));
}

function requiredCapabilities(actions = []) {
  const capabilities = new Set(["page.snapshot", "page.screenshot", "page.query"]);
  for (const action of actions) {
    if (typeof action?.method !== "string") continue;
    capabilities.add(action.method);
    if (action.method === "page.selectOption" || action.params?.autoVisualProof === true) capabilities.add("page.inspectDropdown");
    if (action.method.startsWith("visual.") || action.params?.physicalFallback === "on_verified_no_effect") capabilities.add("visual.inspectTarget");
  }
  return [...capabilities].sort();
}

function taskCapabilityHandshake({ taskId, actions, schemaVersion = AOS_CHROME_COMPANION_TASK_CONTRACT_VERSION } = {}) {
  const capabilities = requiredCapabilities(actions);
  return {
    schema: AOS_CHROME_COMPANION_TASK_CONTRACT_SCHEMA,
    version: schemaVersion,
    taskId,
    requiredCapabilities: capabilities,
    capabilityDigest: capabilityDigest(capabilities),
  };
}

function validateCapabilityHandshake(handshake, expected) {
  if (!handshake || typeof handshake !== "object" || Array.isArray(handshake)) {
    throw companionAdapterError("companion_tool_schema_stale", "Companion did not return a task capability handshake");
  }
  if (handshake.schema !== expected.schema || handshake.version !== expected.version || handshake.taskId !== expected.taskId) {
    throw companionAdapterError("companion_tool_schema_stale", "Companion task schema handshake does not match this task", { expected, received: handshake });
  }
  const available = Array.isArray(handshake.availableCapabilities) ? new Set(handshake.availableCapabilities) : new Set();
  const missing = expected.requiredCapabilities.filter((capability) => !available.has(capability));
  if (missing.length > 0 || handshake.capabilityDigest !== capabilityDigest(handshake.availableCapabilities ?? [])) {
    throw companionAdapterError("companion_capability_handshake_failed", "Companion does not expose the required capabilities for this task", { missing, required: expected.requiredCapabilities, available: [...available].sort() });
  }
  return handshake;
}

async function materializeCompanionActions(actions, materialize) {
  const needsHostFiles = actions.some(action => ["page.upload", "page.uploadMultiple"].includes(action?.method)
    || (action?.method === "clipboard.write" && action.params?.formats !== undefined));
  if (!needsHostFiles) return actions.map(action => ({ ...action, params: action?.params ?? {} }));
  if (typeof materialize !== "function") {
    throw companionAdapterError("companion_file_materializer_unavailable", "Use the installed Companion client materializer for uploads and clipboard files", {
      operationEffectState: "none", mutationDispatchAttempted: false,
    });
  }
  const materialized = await materialize(actions);
  return materialized.map((action, index) => {
    if (["page.upload", "page.uploadMultiple"].includes(action?.method)) {
      // Installed versions before the shared materializer update dropped
      // these transaction-level fields while reading the file bytes.
      const original = actions[index]?.params ?? {};
      return { ...action, params: { ...action.params,
        ...(original.confirmationLocator !== undefined ? { confirmationLocator: original.confirmationLocator } : {}),
        ...(original.confirmationTimeoutMs !== undefined ? { confirmationTimeoutMs: original.confirmationTimeoutMs } : {}),
      } };
    }
    if (action?.method === "clipboard.write" && action.params?.formats?.some(format => format.filePath !== undefined)) {
      throw companionAdapterError("companion_file_materializer_outdated", "The installed materializer does not yet support clipboard files", {
        operationEffectState: "none", mutationDispatchAttempted: false,
      });
    }
    return action;
  });
}

function normalizedError(error) {
  return {
    code: String(error?.code || "companion_adapter_failed"),
    message: String(error?.message || error || "Companion adapter failed").replace(/\s+/gu, " ").slice(0, 400),
    ...(error?.details && typeof error.details === "object" ? { details: error.details } : {}),
  };
}

// A session-generation/ownership rejection happens before the broker can
// verify or dispatch the signed transaction.  It is therefore safe to open a
// fresh session and retry the same idempotency key once.  Timeout, unknown
// effect, and any post-dispatch error deliberately stay terminal so this
// adapter never replays an uncertain external action.
function isPreDispatchSessionRecoveryError(error) {
  if (!new Set(["session_generation_stale", "session_not_owned"]).has(String(error?.code || ""))) return false;
  if (error?.details?.mutationDispatchAttempted === true) return false;
  if (["unknown", "unknown_effect", "applied", "dispatched"].includes(String(error?.details?.operationEffectState || ""))) return false;
  return true;
}

function publicSnapshot(snapshot) {
  const frames = Array.isArray(snapshot?.frames)
    ? snapshot.frames.slice(0, 100).map((frame) => ({
      frame_id: Number.isSafeInteger(frame?.frameId) ? frame.frameId : null,
      url: String(frame?.url || ""),
      title: String(frame?.title || "").slice(0, 300),
      ready_state: String(frame?.readyState || "unknown"),
      page_instance_id: frame?.pageInstanceId ?? null,
      text_chars: Number.isSafeInteger(frame?.textChars) ? frame.textChars : 0,
      control_count: Number.isSafeInteger(frame?.controlCount) ? frame.controlCount : 0,
    }))
    : [];
  return {
    url: String(snapshot?.url || ""),
    title: String(snapshot?.title || "").slice(0, 300),
    ready_state: String(snapshot?.readyState || "unknown"),
    text_sha256: digest(snapshot?.text || ""),
    text_length: String(snapshot?.text || "").length,
    control_count: Array.isArray(snapshot?.controls) ? snapshot.controls.length : 0,
    frame_count: Number.isSafeInteger(snapshot?.frameCount) ? snapshot.frameCount : frames.length,
    semantic_empty: snapshot?.semanticEmpty === true,
    frames,
  };
}

function publicVisualReadback(screenshot) {
  const encoded = String(screenshot?.dataBase64 || "");
  if (!encoded) {
    throw companionAdapterError(
      "companion_visual_readback_missing",
      "Companion did not return screenshot evidence for the exact target tab",
    );
  }
  let bytes;
  try {
    bytes = Buffer.from(encoded, "base64");
  } catch {
    throw companionAdapterError("companion_visual_readback_invalid", "Companion screenshot evidence is invalid");
  }
  if (bytes.length === 0) {
    throw companionAdapterError("companion_visual_readback_empty", "Companion screenshot evidence is empty");
  }
  return {
    captured: true,
    mime_type: String(screenshot?.mimeType || "image/jpeg"),
    byte_length: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    tab_id: Number.isSafeInteger(screenshot?.tabId) ? screenshot.tabId : null,
    window_id: Number.isSafeInteger(screenshot?.windowId) ? screenshot.windowId : null,
    url: String(screenshot?.url || ""),
    title: String(screenshot?.title || "").slice(0, 300),
    restored: screenshot?.restored === true,
  };
}

function boundedTransactionVisualReadback(readback) {
  if (!readback || typeof readback !== "object") return null;
  return {
    captured: readback.captured === true,
    mime_type: String(readback.mime_type || readback.mimeType || "image/jpeg"),
    byte_length: Number.isSafeInteger(readback.byte_length)
      ? readback.byte_length
      : Number.isSafeInteger(readback.byteLength) ? readback.byteLength : 0,
    sha256: /^[a-f0-9]{64}$/u.test(String(readback.sha256 || "")) ? String(readback.sha256) : null,
    tab_id: Number.isSafeInteger(readback.tab_id)
      ? readback.tab_id
      : Number.isSafeInteger(readback.tabId) ? readback.tabId : null,
    window_id: Number.isSafeInteger(readback.window_id)
      ? readback.window_id
      : Number.isSafeInteger(readback.windowId) ? readback.windowId : null,
    url: String(readback.url || ""),
    title: String(readback.title || "").slice(0, 300),
    restored: readback.restored === true,
  };
}

function boundedTransactionReadback(transaction, fallbackUrl) {
  const source = transaction?.post && typeof transaction.post === "object"
    ? transaction.post
    : transaction?.pre && typeof transaction.pre === "object" ? transaction.pre : {};
  return {
    url: String(source.url || fallbackUrl || ""),
    title: String(source.title || "").slice(0, 300),
    ready_state: "unknown",
    text_sha256: /^[a-f0-9]{64}$/u.test(String(source.text_sha256 || "")) ? String(source.text_sha256) : null,
    text_length: null,
    control_count: null,
    frame_count: null,
    semantic_empty: false,
    frames: [],
  };
}

function readOnlyReceiptFromProvisionedTransaction(transaction, validated, startedAt) {
  const readback = boundedTransactionReadback(transaction, validated.startUrl);
  const visual = boundedTransactionVisualReadback(transaction?.visual_readback);
  const cleanupSource = transaction?.cleanup && typeof transaction.cleanup === "object" ? transaction.cleanup : {};
  const cleanup = {
    session_closed: cleanupSource.session_closed === true,
    lease_released_by_session_close: cleanupSource.lease_released_by_session_close === true,
    terminal_tab_cleanup: String(cleanupSource.terminal_tab_cleanup || (cleanupSource.closed === true ? "completed" : "not_confirmed")),
  };
  const target = {
    tab_id: Number.isSafeInteger(transaction?.tab?.id) ? transaction.tab.id : visual?.tab_id,
    window_id: Number.isSafeInteger(readback.window_id) ? readback.window_id : visual?.window_id,
    url: readback.url,
    title: readback.title,
    lease_id: null,
    task_owned: true,
  };
  const visualVerified = visual?.captured === true
    && /^[a-f0-9]{64}$/u.test(String(visual.sha256 || ""))
    && visual.url === readback.url
    && (visual.tab_id === null || visual.tab_id === target.tab_id);
  const cleanupVerified = cleanup.session_closed && cleanup.lease_released_by_session_close;
  const verified = transaction?.result === "verified"
    && transaction?.external_action_executed !== true
    && Boolean(readback.url)
    && Boolean(target.task_owned)
    && visualVerified
    && cleanupVerified;
  return {
    schema: AOS_CHROME_COMPANION_ADAPTER_SCHEMA,
    result: verified ? "verified" : "blocked",
    execution_surface: AOS_CHROME_COMPANION_SURFACE,
    operation_plane: "target_scoped_read_only_target_provision",
    run_id: validated.runId,
    task_id: validated.taskId,
    execution_context: validated.executionContext,
    authority_source: "aos_local",
    started_at: startedAt,
    profile: transaction?.profile ?? null,
    session: transaction?.session ?? null,
    target,
    readback,
    visual_readback: visual,
    visual_readback_required: true,
    visual_readback_verified: visualVerified,
    cleanup,
    official_extension_same_tab_coordination: "not_available",
    external_action_executed: false,
    mutation_dispatch_attempted: false,
    mutation_dispatch_count: 0,
    operation_effect_state: "none",
    reconciliation_required: false,
    replay_allowed: false,
    provider_receipt_trusted: false,
    exact_blocker: verified ? null : (transaction?.exact_blocker ?? {
      code: visualVerified ? "companion_adapter_target_provision_cleanup_unverified" : "companion_adapter_target_provision_readback_unverified",
      message: "The signed read-only target provision did not produce complete same-tab proof",
    }),
    target_provision: {
      attempted: true,
      signed_transaction: true,
      action_methods: ["page.delay", "page.screenshot"],
      external_action_executed: false,
    },
  };
}

async function captureActiveProvisionedVisual({ client, session, validated, transaction }) {
  const status = await client.request("status.get");
  const connectedProfiles = (status?.profiles || []).filter((profile) => profile.connected === true);
  const selectedProfiles = validated.profileInstanceId
    ? connectedProfiles.filter((profile) => profile.profileInstanceId === validated.profileInstanceId)
    : connectedProfiles;
  if (selectedProfiles.length !== 1) throw companionAdapterError("companion_profile_selection_ambiguous", "Expected one connected Companion profile for visual readback");
  const profile = selectedProfiles[0];
  const tabs = await client.request("operation.execute", {
    sessionId: session.sessionId,
    method: "tabs.list",
    params: {},
  });
  const transactionTabId = Number.isSafeInteger(transaction?.tab?.id) ? transaction.tab.id : null;
  const tab = transactionTabId !== null
    ? tabs.find((candidate) => Number(candidate?.id) === transactionTabId)
      || await client.request("operation.execute", {
        sessionId: session.sessionId,
        method: "tabs.get",
        params: { tabId: transactionTabId },
      })
    : resolveCompanionTargetTab(tabs, validated.target, [...validated.allowedOrigins], {
      taskId: validated.taskId,
      taskTabs: status?.taskTabs,
    });
  if (!tab || !Number.isSafeInteger(tab.id)) throw companionAdapterError("companion_adapter_target_not_found", "The signed provisioned tab was not available for fresh readback");
  if (transactionTabId === null) resolveCurrentTaskOwnedTabRecord(tab, profile, validated.taskId, status?.taskTabs);
  const lease = await client.request("lease.acquire", { sessionId: session.sessionId, tabId: tab.id });
  const snapshot = await client.request("operation.execute", {
    sessionId: session.sessionId,
    leaseId: lease.leaseId,
    method: "page.snapshot",
    params: { tabId: tab.id, maxTextChars: validated.maxTextChars },
  });
  assertSnapshotOrigin(snapshot, new Set(validated.allowedOrigins));
  const screenshot = await client.request("operation.execute", {
    sessionId: session.sessionId,
    leaseId: lease.leaseId,
    method: "page.screenshot",
    params: { tabId: tab.id, format: "jpeg", quality: 72, restoreActive: true },
  });
  assertSnapshotOrigin(screenshot, new Set(validated.allowedOrigins));
  const visual = publicVisualReadback(screenshot);
  const readback = publicSnapshot(snapshot);
  if ((visual.tab_id !== null && visual.tab_id !== tab.id) || visual.url !== readback.url) {
    throw companionAdapterError("companion_visual_semantic_mismatch", "Companion visual evidence and semantic readback do not identify the same page");
  }
  return {
    result: "verified",
    exact_blocker: null,
    target: {
      tab_id: tab.id,
      window_id: tab.windowId,
      url: tab.url,
      title: String(tab.title || "").slice(0, 300),
      lease_id: lease.leaseId,
      task_owned: true,
    },
    readback,
    visual_readback: visual,
    visual_readback_verified: true,
  };
}

async function readBackProvisionedTaskTab(validated, { client }) {
  let session = null;
  let lease = null;
  const receipt = {
    profile: null,
    session: null,
    target: null,
    readback: null,
    visual_readback: null,
    visual_readback_verified: false,
    cleanup: { session_closed: false, lease_released_by_session_close: false },
  };
  try {
    const status = await client.request("status.get");
    const connectedProfiles = (status?.profiles || []).filter((profile) => profile.connected === true);
    const selectedProfiles = validated.profileInstanceId
      ? connectedProfiles.filter((profile) => profile.profileInstanceId === validated.profileInstanceId)
      : connectedProfiles;
    if (selectedProfiles.length !== 1) {
      throw companionAdapterError(
        selectedProfiles.length === 0 ? "companion_profile_not_connected" : "companion_profile_selection_ambiguous",
        `Expected one connected Companion profile; received ${selectedProfiles.length}`,
      );
    }
    const profile = selectedProfiles[0];
    receipt.profile = {
      profile_instance_id: profile.profileInstanceId,
      generation: profile.generation,
      extension_runtime_id: profile.extensionRuntimeId,
      connected: true,
    };
    session = await client.request("session.open", {
      label: `aos:${validated.runId}:${validated.taskId}:readback`.slice(0, 128),
      taskId: validated.taskId,
      ...(validated.profileInstanceId ? { profileInstanceId: validated.profileInstanceId } : {}),
    });
    receipt.session = { session_id: session.sessionId, generation: session.generation };
    const tabs = await client.request("operation.execute", {
      sessionId: session.sessionId,
      method: "tabs.list",
      params: {},
    });
    const tab = resolveCompanionTargetTab(tabs, validated.target, [...validated.allowedOrigins], {
      taskId: validated.taskId,
      taskTabs: status?.taskTabs,
    });
    resolveCurrentTaskOwnedTabRecord(tab, profile, validated.taskId, status?.taskTabs);
    lease = await client.request("lease.acquire", { sessionId: session.sessionId, tabId: tab.id });
    receipt.target = {
      tab_id: tab.id,
      window_id: tab.windowId,
      url: tab.url,
      title: String(tab.title || "").slice(0, 300),
      lease_id: lease.leaseId,
      task_owned: true,
    };
    const snapshot = await client.request("operation.execute", {
      sessionId: session.sessionId,
      leaseId: lease.leaseId,
      method: "page.snapshot",
      params: { tabId: tab.id, maxTextChars: validated.maxTextChars },
    });
    assertSnapshotOrigin(snapshot, new Set(validated.allowedOrigins));
    receipt.readback = publicSnapshot(snapshot);
    const screenshot = await client.request("operation.execute", {
      sessionId: session.sessionId,
      leaseId: lease.leaseId,
      method: "page.screenshot",
      params: { tabId: tab.id, format: "jpeg", quality: 72, restoreActive: true },
    });
    assertSnapshotOrigin(screenshot, new Set(validated.allowedOrigins));
    receipt.visual_readback = publicVisualReadback(screenshot);
    if (receipt.visual_readback.tab_id !== null && receipt.visual_readback.tab_id !== tab.id) {
      throw companionAdapterError("companion_visual_readback_target_mismatch", "Screenshot evidence came from a different tab");
    }
    receipt.visual_readback_verified = receipt.visual_readback.url === receipt.readback.url;
    if (!receipt.visual_readback_verified) {
      throw companionAdapterError("companion_visual_semantic_mismatch", "Companion visual evidence and semantic readback do not identify the same page");
    }
    return receipt;
  } finally {
    if (session) {
      try {
        const closed = await client.request("session.close", { sessionId: session.sessionId, taskTerminal: true });
        receipt.cleanup.session_closed = closed?.closed === true;
        receipt.cleanup.lease_released_by_session_close = Boolean(lease && closed?.closed === true);
        receipt.cleanup.terminal_tab_cleanup = closed?.terminal_tab_cleanup?.status || "not_confirmed";
      } catch (error) {
        receipt.cleanup.error = normalizedError(error);
      }
    }
  }
}

function canProvisionReadOnlyTarget(error, validated, client) {
  return typeof client?.requestAuthorizedTransaction === "function"
    && Boolean(readOnlyProvisionStartUrl(validated))
    && new Set([
      "companion_adapter_target_not_found",
      "companion_adapter_foreign_task_tab",
      "companion_adapter_target_not_task_owned",
      "companion_adapter_target_ambiguous",
    ]).has(String(error?.code || ""));
}

function readOnlyProvisionStartUrl(validated) {
  if (validated?.startUrl) return validated.startUrl;
  try {
    return normalizeUrl(validated?.target?.url, "target.url").href;
  } catch {
    return null;
  }
}

function assertSnapshotOrigin(snapshot, allowedOrigins) {
  const parsed = normalizeUrl(snapshot?.url, "snapshot.url");
  if (!allowedOrigins.has(parsed.origin)) {
    throw companionAdapterError(
      "companion_adapter_target_origin_not_allowed",
      "The exact tab left the workflow origin allowlist",
      { observedOrigin: parsed.origin },
    );
  }
}

export function resolveCompanionTargetTab(tabs, target, allowedOriginsInput, ownership = {}) {
  if (!Array.isArray(tabs)) {
    throw companionAdapterError("companion_adapter_tab_inventory_invalid", "Companion tab inventory is invalid");
  }
  const allowedOrigins = allowedOriginSet(allowedOriginsInput);
  const currentTaskId = ownership?.taskId ? requiredString(ownership.taskId, "taskId") : null;
  const taskTabs = Array.isArray(ownership?.taskTabs) ? ownership.taskTabs : [];
  const tabId = target?.tabId;
  const exactUrl = target?.url ? normalizeUrl(target.url, "target.url").href : null;
  const title = target?.title ? requiredString(target.title, "target.title") : null;
  if (!Number.isSafeInteger(tabId) && !exactUrl && !title) {
    throw companionAdapterError(
      "companion_adapter_target_identity_missing",
      "target requires tabId, exact URL, or exact title",
    );
  }
  const matchingTabs = tabs.filter((tab) => {
    if (!Number.isSafeInteger(tab?.id)) return false;
    let parsed;
    try {
      parsed = normalizeUrl(tab.url, "tab.url");
    } catch {
      return false;
    }
    if (!allowedOrigins.has(parsed.origin)) return false;
    if (Number.isSafeInteger(tabId) && tab.id !== tabId) return false;
    if (exactUrl && parsed.href !== exactUrl) return false;
    if (title && String(tab.title || "") !== title) return false;
    return true;
  });
  const isForeignTaskTab = (tab) => {
    if (!currentTaskId) return false;
    const observedTaskIds = [];
    for (const value of [tab?.taskId, tab?.task_id]) {
      if (typeof value === "string" && value.trim()) observedTaskIds.push(value.trim());
    }
    for (const entry of taskTabs) {
      if (entry?.tabId !== tab.id) continue;
      for (const value of [entry?.taskId, entry?.task_id]) {
        if (typeof value === "string" && value.trim()) observedTaskIds.push(value.trim());
      }
    }
    return observedTaskIds.some((taskId) => taskId !== currentTaskId);
  };
  const foreignMatches = matchingTabs.filter(isForeignTaskTab);
  const candidates = matchingTabs.filter((tab) => !isForeignTaskTab(tab));
  if (candidates.length === 0 && foreignMatches.length > 0) {
    throw companionAdapterError(
      "companion_adapter_foreign_task_tab",
      "The exact target tab belongs to another task and cannot be used by this task",
      { candidateCount: foreignMatches.length },
    );
  }
  if (candidates.length === 0) {
    throw companionAdapterError("companion_adapter_target_not_found", "No exact allowlisted Companion tab matched");
  }
  if (candidates.length > 1) {
    throw companionAdapterError(
      "companion_adapter_target_ambiguous",
      "Several allowlisted Companion tabs matched the target",
      { candidateCount: candidates.length },
    );
  }
  return candidates[0];
}

function resolveCurrentTaskOwnedTabRecord(tab, profile, taskId, taskTabs) {
  const ownedRecord = (Array.isArray(taskTabs) ? taskTabs : []).find((entry) =>
    entry?.tabId === tab?.id
      && entry?.taskId === taskId
      && entry?.profileInstanceId === profile?.profileInstanceId
      && entry?.generation === profile?.generation
      && entry?.identityConsistent !== false
      && entry?.tabDisposition !== "ledger_only"
      && entry?.quarantine !== "stale_generation"
  );
  if (!ownedRecord) {
    throw companionAdapterError(
      "companion_adapter_target_not_task_owned",
      "The exact target tab has no current task-owned Companion record",
      {
        tabId: tab?.id ?? null,
        taskId,
        profileInstanceId: profile?.profileInstanceId ?? null,
        generation: profile?.generation ?? null,
      },
    );
  }
  return ownedRecord;
}

function validateTransactionInput(input) {
  const runId = requiredString(input?.runId, "runId");
  const taskId = requiredString(input?.taskId, "taskId");
  const mode = String(input?.mode || "read_only");
  if (!new Set(["read_only", "authorized"]).has(mode)) {
    throw companionAdapterError("companion_adapter_mutation_not_admitted", "Use mode=authorized with task-owned transaction actions");
  }
  if (mode === "authorized" && (!Array.isArray(input?.actions) || input.actions.length === 0)) {
    throw companionAdapterError(
      "companion_adapter_actions_missing",
      "Authorized transactions require at least one action",
    );
  }
  if (mode === "authorized" && !input?.startUrl) {
    throw companionAdapterError("companion_adapter_start_url_missing", "Authorized transactions require startUrl");
  }
  const idempotencyKey = mode === "authorized"
    ? requiredString(input?.idempotencyKey, "idempotencyKey")
    : undefined;
  let executionContext;
  try {
    executionContext = resolveAosExecutionContext({
      ...input,
      runId,
      taskId,
      effectState: mode === "authorized" ? (input?.effectState ?? "executing") : (input?.effectState ?? "none"),
      route: {
        backend: "aos_chrome_companion",
        surface: AOS_CHROME_COMPANION_SURFACE,
        ...(input?.executionContext?.route ?? input?.execution_context?.route ?? {}),
      },
    });
  } catch (error) {
    throw companionAdapterError("companion_adapter_execution_context_invalid", "AOS local execution context is invalid", { cause: normalizedError(error) });
  }
  if (executionContext.run_id !== runId || executionContext.task_id !== taskId) {
    throw companionAdapterError("companion_adapter_execution_context_binding_mismatch", "Execution context does not match this transaction", {
      expected: { runId, taskId },
      received: { runId: executionContext.run_id, taskId: executionContext.task_id },
    });
  }
  if (executionContext.route.surface !== AOS_CHROME_COMPANION_SURFACE || executionContext.route.backend !== "aos_chrome_companion") {
    throw companionAdapterError("companion_adapter_execution_context_surface_invalid", "Execution context must select the AOS Chrome Companion surface");
  }
  if (!canContinueAosExecution(executionContext)) {
    throw companionAdapterError("companion_adapter_execution_context_not_continuable", "AOS local context requires reconciliation or owner-transfer handling before dispatch", {
      effectState: executionContext.effect_state,
      reconciliationState: executionContext.reconciliation_state,
      handoffState: executionContext.handoff_state,
    });
  }
  return {
    runId,
    taskId,
    mode,
    target: input?.target,
    allowedOrigins: [...allowedOriginSet(input?.allowedOrigins)],
    maxTextChars: Math.min(Math.max(Number(input?.maxTextChars || 30_000), 1_000), 100_000),
    profileInstanceId: input?.profileInstanceId
      ? requiredString(input.profileInstanceId, "profileInstanceId")
      : undefined,
    startUrl: input?.startUrl ? normalizeUrl(input.startUrl, "startUrl").href : undefined,
    actions: Array.isArray(input?.actions) ? input.actions.slice(0, 32) : [],
    idempotencyKey,
    intent: input?.intent ? requiredString(input.intent, "intent") : undefined,
    capsule: input?.capsule && typeof input.capsule === "object" && !Array.isArray(input.capsule)
      ? input.capsule
      : undefined,
    reuseTaskTab: input?.reuseTaskTab !== false,
    keepTaskTab: input?.keepTaskTab === true,
    retainOnUnknown: input?.retainOnUnknown === true,
    requireCapabilityHandshake: input?.requireCapabilityHandshake === true,
    capabilityHandshake: input?.capabilityHandshake && typeof input.capabilityHandshake === "object" && !Array.isArray(input.capabilityHandshake)
      ? input.capabilityHandshake
      : undefined,
    precondition: input?.precondition && typeof input.precondition === "object" && !Array.isArray(input.precondition)
      ? input.precondition
      : undefined,
    executionContext,
  };
}

export async function executeAosChromeCompanionAuthorized(input, { client, materializeActions, afterTransaction }) {
  const validated = validateTransactionInput({ ...input, mode: "authorized" });
  const startedAt = new Date().toISOString();
  let session = null;
  const receipt = {
    schema: AOS_CHROME_COMPANION_ADAPTER_SCHEMA,
    result: "running",
    execution_surface: AOS_CHROME_COMPANION_SURFACE,
    operation_plane: "task_owned_authorized_transaction",
    run_id: validated.runId,
    task_id: validated.taskId,
    execution_context: validated.executionContext,
    authority_source: "aos_local",
    started_at: startedAt,
    official_extension_same_tab_coordination: "not_available",
    external_action_executed: false,
    replay_allowed: false,
    provider_receipt_trusted: false,
    cleanup: {
      session_closed: false,
      lease_released_by_session_close: false,
      terminal_tab_cleanup: "not_confirmed",
    },
    exact_blocker: null,
    reconciliation: { attempted: false, verified: false, replayed: false },
    session_recovery: { attempted: false, retried: false },
  };
  try {
    const actions = await materializeCompanionActions(validated.actions, materializeActions ?? client.materializeTransactionActions?.bind(client));
    const expectedHandshake = validated.capabilityHandshake && typeof validated.capabilityHandshake === "object"
      ? validated.capabilityHandshake
      : taskCapabilityHandshake({ taskId: validated.taskId, actions });
    const openSession = () => client.request("session.open", {
      label: `aos:${validated.runId}:${validated.taskId}`.slice(0, 128),
      taskId: validated.taskId,
      capabilityHandshake: expectedHandshake,
      ...(validated.profileInstanceId ? { profileInstanceId: validated.profileInstanceId } : {}),
    });
    session = await openSession();
    if (validated.requireCapabilityHandshake === true) {
      receipt.capability_handshake = validateCapabilityHandshake(session.capabilityHandshake, expectedHandshake);
    } else if (session.capabilityHandshake) {
      receipt.capability_handshake = session.capabilityHandshake;
    }
    receipt.session = { session_id: session.sessionId, generation: session.generation };
    const requestAuthorized = () => client.requestAuthorizedTransaction({
      sessionId: session.sessionId,
      runId: validated.runId,
      taskId: validated.taskId,
      startUrl: validated.startUrl,
      allowedOrigins: validated.allowedOrigins,
      actions,
      idempotencyKey: validated.idempotencyKey,
      ...(validated.intent ? { intent: validated.intent } : {}),
      ...(validated.capsule ? { capsule: validated.capsule } : {}),
      reuseTaskTab: validated.reuseTaskTab,
      keepTaskTab: validated.keepTaskTab,
      retainOnUnknown: validated.retainOnUnknown,
      ...(validated.precondition ? { precondition: validated.precondition } : {}),
    }, { timeoutMs: AUTHORIZED_TRANSACTION_TIMEOUT_MS });
    let result;
    try {
      result = await requestAuthorized();
    } catch (error) {
      if (!isPreDispatchSessionRecoveryError(error)) throw error;
      const staleSession = session;
      receipt.session_recovery = {
        attempted: true,
        retried: false,
        reason: String(error.code),
        from_session_id: staleSession.sessionId,
        from_generation: staleSession.generation ?? null,
      };
      // The broker may already have invalidated this session.  Closing it is
      // best effort and is never treated as evidence that the transaction ran.
      session = null;
      try {
        await client.request("session.close", { sessionId: staleSession.sessionId, taskTerminal: false });
      } catch {
        // stale/foreign sessions are expected to reject close
      }
      session = await openSession();
      if (validated.requireCapabilityHandshake === true) {
        receipt.capability_handshake = validateCapabilityHandshake(session.capabilityHandshake, expectedHandshake);
      } else if (session.capabilityHandshake) {
        receipt.capability_handshake = session.capabilityHandshake;
      }
      receipt.session = { session_id: session.sessionId, generation: session.generation };
      receipt.session_recovery = {
        ...receipt.session_recovery,
        retried: true,
        to_session_id: session.sessionId,
        to_generation: session.generation ?? null,
      };
      result = await requestAuthorized();
    }
    const { visual_readback: rawVisualReadback, ...boundedResult } = result;
    Object.assign(receipt, boundedResult, {
      execution_surface: AOS_CHROME_COMPANION_SURFACE,
      provider_receipt_trusted: false,
      external_action_executed: result.external_action_executed === true,
    });
    // Preserve the known partial result before validating optional visual
    // evidence. A target-provision caller may perform one fresh, same-session
    // read-only capture while the transaction's task tab is still retained.
    if (rawVisualReadback) {
      receipt.visual_readback = publicVisualReadback(rawVisualReadback);
      receipt.visual_readback_verified = true;
    } else {
      receipt.visual_readback = null;
      receipt.visual_readback_verified = false;
      receipt.result = "blocked";
      receipt.exact_blocker = companionAdapterError(
        "companion_visual_readback_missing",
        "Companion did not return screenshot evidence for the authorized transaction",
      );
    }
    if (typeof afterTransaction === "function") {
      const callbackResult = await afterTransaction({ client, session, validated, result, receipt });
      if (callbackResult && typeof callbackResult === "object" && !Array.isArray(callbackResult)) {
          Object.assign(receipt, callbackResult);
      }
    }
    return receipt;
  } catch (error) {
    receipt.result = "blocked";
    receipt.exact_blocker = normalizedError(error);
    if (session) {
      receipt.reconciliation.attempted = true;
      try {
        const status = await client.requestTaskStatus({
          sessionId: session.sessionId,
          runId: validated.runId,
          taskId: validated.taskId,
          idempotencyKey: validated.idempotencyKey,
        });
        receipt.reconciliation.status = status;
        receipt.reconciliation.verified = status?.reconciliation_required === false
          || status?.reconciliation?.required === false
          || status?.reconciliation_state === "resolved";
        if (status?.external_action_executed === true) receipt.external_action_executed = true;
      } catch (statusError) {
        receipt.reconciliation.error = normalizedError(statusError);
      }
    }
    return receipt;
  } finally {
    if (session) {
      try {
        const progress = receipt.outcome ?? receipt.action_progress;
        const retainRemaining = (progress?.applied_action_indices?.length > 0 && progress?.remaining_action_indices?.length > 0)
          || progress?.uncertain_action_indices?.length > 0 || progress?.reconciliation_required === true;
        const closed = await client.request("session.close", {
          sessionId: session.sessionId,
          taskTerminal: !retainRemaining,
        });
        receipt.cleanup.remaining_work_retained = Boolean(retainRemaining);
        receipt.cleanup.session_closed = closed?.closed === true;
        receipt.cleanup.lease_released_by_session_close = closed?.closed === true;
        receipt.cleanup.terminal_tab_cleanup = closed?.terminal_tab_cleanup?.status
          ?? (receipt.external_action_executed ? "unknown" : "not_applicable");
        if (closed?.terminal_tab_cleanup) receipt.cleanup.task_tab_cleanup = closed.terminal_tab_cleanup;
      } catch (error) {
        receipt.cleanup.error = normalizedError(error);
      }
    }
    const cleanupTerminal = !new Set(["not_confirmed", "unknown", "failed"]).has(String(receipt.cleanup.terminal_tab_cleanup));
    const actionReceiptsValid = Array.isArray(receipt.actions)
      && receipt.actions.length === validated.actions.length
      && receipt.actions.every((action) => action?.result?.ok === true);
    receipt.browser_receipt_verified = receipt.result === "verified"
      && actionReceiptsValid
      && receipt.visual_readback_verified === true
      && receipt.cleanup.session_closed === true
      && receipt.cleanup.lease_released_by_session_close === true
      && cleanupTerminal;
    // New broker outcomes explicitly separate browser work from provider
    // completion. Never promote unverified provider state from a screenshot.
    receipt.provider_receipt_trusted = receipt.browser_receipt_verified
      && (receipt.outcome?.schema === "aos.chrome_companion.transaction_outcome.v1"
        ? receipt.outcome.provider_completion === "verified"
        : true);
    receipt.provider_evidence_source = receipt.outcome ? "transaction_outcome" : "legacy_browser_receipt_unclassified";
    receipt.same_run_receipt = receipt.provider_receipt_trusted;
    receipt.cleanup_verified = receipt.cleanup.session_closed === true
      && receipt.cleanup.lease_released_by_session_close === true
      && cleanupTerminal;
    receipt.completed_at = new Date().toISOString();
  }
}

export async function executeAosChromeCompanionTransactionStatus(input, { client }) {
  const runId = requiredString(input?.runId, "runId");
  const taskId = requiredString(input?.taskId, "taskId");
  const idempotencyKey = requiredString(input?.idempotencyKey, "idempotencyKey");
  const receipt = {
    schema: AOS_CHROME_COMPANION_ADAPTER_SCHEMA,
    result: "running",
    execution_surface: AOS_CHROME_COMPANION_SURFACE,
    operation_plane: "signed_read_only_reconciliation_status",
    run_id: runId,
    task_id: taskId,
    execution_context: buildAosExecutionContext({ runId, taskId, effectState: "none", route: { backend: "aos_chrome_companion", surface: AOS_CHROME_COMPANION_SURFACE } }),
    authority_source: "aos_local",
    idempotency_key: idempotencyKey,
    external_action_executed: false,
    replay_allowed: false,
    exact_blocker: null,
  };
  let session = null;
  try {
    await client.request("status.get", {}, { timeoutMs: 5_000 });
    session = await client.request("session.open", {
      label: `aos-status:${runId}:${taskId}`.slice(0, 128),
      taskId,
    });
    const status = await client.requestTaskStatus({
      sessionId: session.sessionId,
      runId,
      taskId,
      idempotencyKey,
    });
    if (status?.schema !== "aos.chrome_companion.task_status.v1"
      || status.run_id !== runId || status.task_id !== taskId || status.idempotency_key !== idempotencyKey) {
      throw companionAdapterError("companion_status_binding_invalid", "Companion status response does not bind to the requested run, task, and operation");
    }
    Object.assign(receipt, status, { result: "verified" });
    return receipt;
  } catch (error) {
    receipt.result = "blocked";
    receipt.exact_blocker = normalizedError(error);
    return receipt;
  } finally {
    if (session) {
      try { await client.request("session.close", { sessionId: session.sessionId }); } catch (error) { receipt.cleanup_error = normalizedError(error); }
    }
    receipt.completed_at = new Date().toISOString();
  }
}

export async function executeAosChromeCompanionReadOnly(input, { client }) {
  const validated = validateTransactionInput(input);
  const startedAt = new Date().toISOString();
  let session = null;
  let lease = null;
  const receipt = {
    schema: AOS_CHROME_COMPANION_ADAPTER_SCHEMA,
    result: "running",
    execution_surface: AOS_CHROME_COMPANION_SURFACE,
    operation_plane: "target_scoped_read_only",
    run_id: validated.runId,
    task_id: validated.taskId,
    execution_context: validated.executionContext,
    authority_source: "aos_local",
    started_at: startedAt,
    profile: null,
    session: null,
    target: null,
    readback: null,
    visual_readback: null,
    visual_readback_required: true,
    visual_readback_verified: false,
    cleanup: { session_closed: false, lease_released_by_session_close: false },
    official_extension_same_tab_coordination: "not_available",
    external_action_executed: false,
    mutation_dispatch_attempted: false,
    mutation_dispatch_count: 0,
    operation_effect_state: "none",
    reconciliation_required: false,
    replay_allowed: false,
    exact_blocker: null,
  };

  try {
    const status = await client.request("status.get");
    const connectedProfiles = (status?.profiles || []).filter((profile) => profile.connected === true);
    const selectedProfiles = validated.profileInstanceId
      ? connectedProfiles.filter((profile) => profile.profileInstanceId === validated.profileInstanceId)
      : connectedProfiles;
    if (selectedProfiles.length !== 1) {
      throw companionAdapterError(
        selectedProfiles.length === 0 ? "companion_profile_not_connected" : "companion_profile_selection_ambiguous",
        `Expected one connected Companion profile; received ${selectedProfiles.length}`,
      );
    }
    const profile = selectedProfiles[0];
    receipt.profile = {
      profile_instance_id: profile.profileInstanceId,
      generation: profile.generation,
      extension_runtime_id: profile.extensionRuntimeId,
      connected: true,
    };

    session = await client.request("session.open", {
      label: `aos:${validated.runId}:${validated.taskId}`.slice(0, 128),
      taskId: validated.taskId,
      ...(validated.profileInstanceId ? { profileInstanceId: validated.profileInstanceId } : {}),
    });
    receipt.session = {
      session_id: session.sessionId,
      generation: session.generation,
    };

    const tabs = await client.request("operation.execute", {
      sessionId: session.sessionId,
      method: "tabs.list",
      params: {},
    });
    const tab = resolveCompanionTargetTab(tabs, validated.target, [...validated.allowedOrigins], {
      taskId: validated.taskId,
      taskTabs: status?.taskTabs,
    });
    resolveCurrentTaskOwnedTabRecord(tab, profile, validated.taskId, status?.taskTabs);
    lease = await client.request("lease.acquire", { sessionId: session.sessionId, tabId: tab.id });
    receipt.target = {
      tab_id: tab.id,
      window_id: tab.windowId,
      url: tab.url,
      title: String(tab.title || "").slice(0, 300),
      lease_id: lease.leaseId,
      task_owned: true,
    };

    const snapshot = await client.request("operation.execute", {
      sessionId: session.sessionId,
      leaseId: lease.leaseId,
      method: "page.snapshot",
      params: { tabId: tab.id, maxTextChars: validated.maxTextChars },
    });
    assertSnapshotOrigin(snapshot, new Set(validated.allowedOrigins));
    receipt.readback = publicSnapshot(snapshot);
    const screenshot = await client.request("operation.execute", {
      sessionId: session.sessionId,
      leaseId: lease.leaseId,
      method: "page.screenshot",
      params: { tabId: tab.id, format: "jpeg", quality: 72 },
    });
    assertSnapshotOrigin(screenshot, new Set(validated.allowedOrigins));
    receipt.visual_readback = publicVisualReadback(screenshot);
    if (receipt.visual_readback.tab_id !== null && receipt.visual_readback.tab_id !== tab.id) {
      throw companionAdapterError("companion_visual_readback_target_mismatch", "Screenshot evidence came from a different tab");
    }
    receipt.visual_readback_verified = receipt.visual_readback.captured === true
      && receipt.visual_readback.url === receipt.readback.url;
    if (!receipt.visual_readback_verified) {
      throw companionAdapterError(
        "companion_visual_semantic_mismatch",
        "Companion visual evidence and semantic readback do not identify the same page",
      );
    }
    receipt.result = "verified";
    return receipt;
  } catch (error) {
    if (canProvisionReadOnlyTarget(error, validated, client)) {
      const staleSession = session;
      session = null;
      if (staleSession) {
        try {
          const closed = await client.request("session.close", {
            sessionId: staleSession.sessionId,
            taskTerminal: false,
          });
          if (closed?.closed !== true) {
            throw companionAdapterError(
              "companion_adapter_target_provision_session_close_unverified",
              "The initial read-only session did not close before target provisioning",
            );
          }
          receipt.cleanup.session_closed = true;
        } catch (closeError) {
          receipt.result = "blocked";
          receipt.exact_blocker = normalizedError(closeError);
          return receipt;
        }
      }
      try {
        const provisionTarget = (idempotencyKey) => executeAosChromeCompanionAuthorized({
          runId: validated.runId,
          taskId: validated.taskId,
          mode: "authorized",
          startUrl: readOnlyProvisionStartUrl(validated),
          allowedOrigins: [...validated.allowedOrigins],
          profileInstanceId: validated.profileInstanceId,
          // A newly provisioned tab does not always receive the broker's
          // implicit visual receipt. Request the screenshot explicitly in
          // the same signed, no-effect transaction so target provisioning
          // has the same visual proof contract as an already-owned tab.
          actions: [
            { method: "page.delay", params: { milliseconds: 1_000 } },
            { method: "page.screenshot", params: { format: "jpeg", quality: 72 } },
          ],
          idempotencyKey,
          intent: "read_only_target_provision",
          reuseTaskTab: false,
          // Keep the newly created tab long enough for a separate, fresh
          // read-only session to capture the exact semantic and visual
          // proof. The tab is terminally cleaned up by that session.
          keepTaskTab: true,
          retainOnUnknown: false,
          effectState: "none",
          executionContext: validated.executionContext,
        }, {
          client,
          afterTransaction: async ({ client: transactionClient, session: transactionSession, result }) => {
            if (result?.visual_readback?.dataBase64
              || result?.external_action_executed === true
              || ["unknown", "unknown_effect", "dispatched", "applied"].includes(String(result?.effect_state || ""))) {
              return {};
            }
            return captureActiveProvisionedVisual({
              client: transactionClient,
              session: transactionSession,
              validated,
              transaction: result,
            });
          },
        });
        let provisionedReceipt = readOnlyReceiptFromProvisionedTransaction(
          await provisionTarget(`${validated.runId}:read-only-target-provision`),
          validated,
          startedAt,
        );
        if (provisionedReceipt.result !== "verified"
          && provisionedReceipt.external_action_executed === false
          && provisionedReceipt.cleanup.session_closed === true
          && provisionedReceipt.cleanup.lease_released_by_session_close === true) {
          try {
            const freshReadback = await readBackProvisionedTaskTab(validated, { client });
            if (freshReadback.visual_readback_verified === true
              && freshReadback.cleanup.session_closed === true
              && freshReadback.cleanup.lease_released_by_session_close === true) {
              provisionedReceipt = {
                ...provisionedReceipt,
                ...freshReadback,
                result: "verified",
                exact_blocker: null,
                target_provision: {
                  ...provisionedReceipt.target_provision,
                  attempts: 1,
                  fresh_readback_session: true,
                },
              };
            }
          } catch {
            // Preserve the bounded no-effect transaction failure below. A
            // fresh readback failure is not permission to replay an effect.
          }
        }
        // Visual capture can transiently miss while another profile-global
        // operation is draining. Retry once only after the first signed
        // transaction has proved no effect and completed session cleanup.
        // Never retry an unknown-effect or externally-effectful transaction.
        if (provisionedReceipt.result !== "verified"
          && provisionedReceipt.external_action_executed === false
          && provisionedReceipt.cleanup.session_closed === true
          && provisionedReceipt.cleanup.lease_released_by_session_close === true) {
          try {
            const retryReceipt = readOnlyReceiptFromProvisionedTransaction(
              await provisionTarget(`${validated.runId}:read-only-target-provision:retry-1`),
              validated,
              startedAt,
            );
            provisionedReceipt = {
              ...retryReceipt,
              target_provision: {
                ...retryReceipt.target_provision,
                attempts: 2,
              },
            };
          } catch {
            // Preserve the first bounded no-effect failure and its cleanup
            // evidence; a retry error is not permission to replay further.
          }
        }
        Object.assign(receipt, provisionedReceipt, {
          target_provision: provisionedReceipt.target_provision,
          initial_target_blocker: normalizedError(error),
        });
        return receipt;
      } catch (provisionError) {
        receipt.result = "blocked";
        receipt.exact_blocker = normalizedError(provisionError);
        receipt.target_provision = {
          attempted: true,
          signed_transaction: true,
          action_methods: ["page.delay", "page.screenshot"],
          external_action_executed: false,
        };
        return receipt;
      }
    }
    receipt.result = "blocked";
    receipt.exact_blocker = normalizedError(error);
    return receipt;
  } finally {
    if (session) {
      try {
        const closed = await client.request("session.close", { sessionId: session.sessionId });
        receipt.cleanup.session_closed = closed?.closed === true;
        receipt.cleanup.lease_released_by_session_close = Boolean(lease && closed?.closed === true);
      } catch (error) {
        receipt.cleanup.error = normalizedError(error);
      }
    }
    receipt.completed_at = new Date().toISOString();
  }
}

async function assertNoSymlinkComponents(path) {
  const absolute = resolve(path);
  const parts = absolute.split(sep).filter(Boolean);
  let current = absolute.startsWith(sep) ? sep : "";
  for (const part of parts) {
    current = current === sep ? join(current, part) : join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw companionAdapterError("companion_installation_symlink_rejected", "Companion installation path contains a symlink");
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
  }
}

export async function resolveCompanionInstallRoot(environment = process.env) {
  const configuredRoot = String(environment.AOS_CHROME_COMPANION_ROOT || "").trim();
  const root = configuredRoot ? (isAbsolute(configuredRoot) ? configuredRoot : resolve(configuredRoot)) : AOS_CHROME_COMPANION_STANDARD_ROOT;
  await assertNoSymlinkComponents(root);
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(root);
    const rootStat = await stat(canonicalRoot);
    if (!rootStat.isDirectory()) throw new Error("not_directory");
  } catch (error) {
    throw companionAdapterError("companion_installation_root_invalid", "Companion installation root is unavailable or invalid", { root, cause: error?.code || "invalid" });
  }
  if (canonicalRoot !== resolve(root)) throw companionAdapterError("companion_installation_root_not_canonical", "Companion installation root must be canonical and symlink-free");
  const modulePath = join(root, "src", "client", "broker-client.mjs");
  const packagePath = join(root, "package.json");
  await assertNoSymlinkComponents(packagePath);
  await assertNoSymlinkComponents(modulePath);
  let canonicalPackage;
  let canonicalModule;
  try {
    canonicalPackage = await realpath(packagePath);
    canonicalModule = await realpath(modulePath);
    const packageJson = JSON.parse(await readFile(canonicalPackage, "utf8"));
    if (packageJson.name !== "@aos/chrome-companion") throw new Error("package_name_invalid");
  } catch (error) {
    throw companionAdapterError("companion_broker_client_invalid", "Installed Companion package or entrypoint is invalid", { cause: error?.code || error?.message || "invalid" });
  }
  const contained = (candidate) => {
    const rel = relative(canonicalRoot, candidate);
    return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if (!contained(canonicalPackage) || !contained(canonicalModule)) throw companionAdapterError("companion_installation_containment_invalid", "Companion package and entrypoint must remain inside the canonical installation root");
  return canonicalRoot;
}

export async function loadCompanionBrokerClient(environment = process.env) {
  const isolated = environment.AOS_CHROME_COMPANION_REQUIRE_ISOLATED_PATHS === "1";
  if (!isolated && (environment.AOS_CHROME_COMPANION_ISOLATION_BINDING_PATH || environment.AOS_CHROME_COMPANION_ISOLATION_BINDING_SHA256)) {
    throw companionAdapterError("companion_isolation_mode_missing", "An isolation binding requires explicit isolated mode");
  }
  const isolationBinding = isolated ? await validateCompanionIsolationBinding(environment) : null;
  if (isolated) {
    const required = [
      "AOS_CHROME_COMPANION_ROOT",
      "AOS_CHROME_COMPANION_DATA_DIR",
      "AOS_CHROME_COMPANION_SOCKET",
      "AOS_CHROME_COMPANION_SECRET_FILE",
      "AOS_CHROME_COMPANION_AOS_ISSUER_SECRET_FILE",
    ];
    if (required.some((key) => !String(environment[key] || "").trim())) {
      throw companionAdapterError("companion_isolated_path_binding_missing", "Isolated Companion execution requires explicit root, data, socket, secret, and issuer paths");
    }
  }
  const root = await resolveCompanionInstallRoot(environment);
  const modulePath = join(root, "src", "client", "broker-client.mjs");
  if (isolated) {
    const paths = await import(pathToFileURL(join(root, "src", "shared", "paths.mjs")).href);
    const runtime = await import(pathToFileURL(join(root, "src", "shared", "task-runtime.mjs")).href);
    const expected = {
      root: resolve(String(environment.AOS_CHROME_COMPANION_ROOT)),
      dataDir: resolve(String(environment.AOS_CHROME_COMPANION_DATA_DIR)),
      socketPath: resolve(String(environment.AOS_CHROME_COMPANION_SOCKET)),
      secretPath: resolve(String(environment.AOS_CHROME_COMPANION_SECRET_FILE)),
      issuerSecretPath: resolve(String(environment.AOS_CHROME_COMPANION_AOS_ISSUER_SECRET_FILE)),
    };
    const contained = (parent, candidate) => {
      const rel = relative(parent, candidate);
      return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    };
    if (!contained(expected.dataDir, expected.socketPath)
      || !contained(expected.dataDir, expected.secretPath)
      || !contained(expected.dataDir, expected.issuerSecretPath)) {
      throw companionAdapterError("companion_isolated_transport_path_escape", "Companion transport paths must remain inside the explicit isolated data directory", { expected });
    }
    const resolved = {
      root,
      dataDir: resolve(paths.resolveDataDir(environment)),
      socketPath: resolve(paths.resolveBrokerSocketPath(environment)),
      secretPath: resolve(paths.resolveSecretPath(environment)),
      issuerSecretPath: resolve(runtime.resolveIssuerSecretPath("aos", environment)),
    };
    if (Object.entries(expected).some(([key, value]) => resolved[key] !== value)) {
      throw companionAdapterError("companion_isolated_path_binding_mismatch", "Resolved Companion paths do not match the explicit isolated binding", { expected, resolved });
    }
  }
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.BrokerClient?.connect !== "function") {
    throw companionAdapterError("companion_broker_client_invalid", "Installed Companion broker client is invalid");
  }
  const client = await module.BrokerClient.connect({ issuer: "aos", env: environment, ...(isolated ? { autoStart: false } : {}) });
  if (isolated) {
    let identity;
    try {
      identity = await client.request("status.get", {}, { timeoutMs: 5_000 });
      const build = await import(pathToFileURL(join(root, "src", "shared", "build-info.mjs")).href);
      if (identity?.brokerInstanceId !== isolationBinding.instanceId || identity?.expectedBuildId !== build.INSTALL_BUILD_ID || identity?.runtimeAttestation?.buildId !== build.INSTALL_BUILD_ID) {
        throw companionAdapterError("companion_isolated_broker_identity_mismatch", "Companion broker handshake identity does not match the selected installation", { expectedBuildId: build.INSTALL_BUILD_ID, receivedBuildId: identity?.runtimeAttestation?.buildId || identity?.expectedBuildId || null });
      }
      client.companionBrokerIdentity = Object.freeze({
        schema: "aos.chrome_companion.broker_identity.v1",
        expected_instance_id: isolationBinding.instanceId,
        observed_instance_id: identity.brokerInstanceId,
        expected_build_id: build.INSTALL_BUILD_ID,
        observed_build_id: identity.runtimeAttestation?.buildId || identity.expectedBuildId,
        build_match: true,
        observed_at: new Date().toISOString(),
      });
    } catch (error) {
      client.close();
      throw error;
    }
  }
  client.materializeTransactionActions = async actions => {
    const materializerPath = join(root, "src", "mcp", "action-materializer.mjs");
    await assertNoSymlinkComponents(materializerPath);
    const materializer = await import(pathToFileURL(materializerPath).href);
    if (typeof materializer.materializeTransactionActions !== "function") throw companionAdapterError("companion_file_materializer_unavailable", "Installed Companion does not expose its shared file materializer");
    return materializer.materializeTransactionActions(actions);
  };
  return client;
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) throw companionAdapterError("companion_adapter_input_missing", "Expected one JSON request on stdin");
  return JSON.parse(raw);
}

async function main() {
  const inputPathIndex = process.argv.indexOf("--input");
  const outputPathIndex = process.argv.indexOf("--output");
  const input = inputPathIndex >= 0
    ? JSON.parse(await readFile(resolve(process.argv[inputPathIndex + 1]), "utf8"))
    : await readStdinJson();
  const client = await loadCompanionBrokerClient();
  try {
    const receipt = input?.mode === "authorized"
      ? await executeAosChromeCompanionAuthorized(input, { client })
      : input?.mode === "status"
        ? await executeAosChromeCompanionTransactionStatus(input, { client })
        : await executeAosChromeCompanionReadOnly(input, { client });
    if (outputPathIndex >= 0) {
      const outputPath = resolve(process.argv[outputPathIndex + 1]);
      await mkdir(resolve(outputPath, ".."), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    }
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    if (receipt.result !== "verified") process.exitCode = 1;
  } finally {
    client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stdout.write(`${JSON.stringify({
      schema: AOS_CHROME_COMPANION_ADAPTER_SCHEMA,
      result: "blocked",
      execution_surface: AOS_CHROME_COMPANION_SURFACE,
      external_action_executed: false,
      replay_allowed: false,
      exact_blocker: normalizedError(error),
    }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { prepareDailyAiPublishPayload } from "/Users/nichikatanaka/Documents/New project/scripts/daily_ai_payload_binding.mjs";
import { companionActionsForIntent } from "./aos-chrome-companion-effect-executor.mjs";
import { executeAosChromeCompanionAuthorized, executeAosChromeCompanionTransactionStatus } from "./aos-chrome-companion-adapter.mjs";
import { AOS_CHROME_COMPANION_SURFACE } from "./aos-chrome-companion-adapter.mjs";

export const DAILY_AI_COMPANION_ADAPTER_SCHEMA = "aos.daily_ai_companion_adapter.v1";
export const DAILY_AI_PROVIDER_READBACK_SCHEMA = "aos.daily_ai_provider_readback.v1";

export function dailyAiCompanionIdempotencyKey(operation) {
  return `${operation.run_id}:${operation.approval_id}:${operation.target_key}`;
}

function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }

function persistStatusBoundaryDiagnostic({ operation, idempotencyKey, status, statusError, initialPreparation }) {
  const root = String(process.env.AUTOMATION_OS_ARTIFACT_ROOT || "").trim();
  if (!root) return null;
  try {
    const directory = path.join(path.resolve(root), operation.run_id, "business-run", "daily-ai");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const error = statusError ? { code: String(statusError.code || "status_request_failed"), message: String(statusError.message || statusError).replace(/\s+/gu, " ").slice(0, 400) } : null;
    const diagnostic = {
      schema: "aos.daily_ai.status_boundary_diagnostic.v1",
      captured_at: new Date().toISOString(),
      returned: !statusError,
      thrown: Boolean(statusError),
      error,
      wrapper_schema: status?.schema || null,
      result: status?.result || null,
      run_id: operation.run_id,
      task_id: operation.task_id,
      idempotency_key: idempotencyKey,
      binding: {
        run_present: nonEmpty(status?.run_id),
        task_present: nonEmpty(status?.task_id),
        key_present: nonEmpty(status?.idempotency_key),
        run_equal: status?.run_id === operation.run_id,
        task_equal: status?.task_id === operation.task_id,
        key_equal: status?.idempotency_key === idempotencyKey,
      },
      operation_state: status?.operation_state ?? status?.state ?? null,
      effect_state: status?.effect_state ?? status?.operation_effect_state ?? null,
      dispatch_count: status?.dispatch_count ?? null,
      reconciliation_required: status?.reconciliation_required ?? null,
      empty_ledger_status: status?.result === "blocked" && /task_status_not_found|no matching task operation exists/i.test(`${status?.exact_blocker?.code || ""} ${status?.exact_blocker?.message || ""}`),
      initial_preparation: initialPreparation,
      request_authorized_transaction_reached: false,
    };
    const file = path.join(directory, `status-boundary-${Date.now()}-${process.pid}.json`);
    fs.writeFileSync(file, `${JSON.stringify(diagnostic, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    return file;
  } catch (_) {
    return null;
  }
}

export function normalizeDailyAiCompanionIntent(intent) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)
    || intent.browser_surface !== AOS_CHROME_COMPANION_SURFACE) {
    throw new Error("daily_ai_companion_canonical_surface_invalid");
  }
  if (intent.route !== undefined
    && (!intent.route || typeof intent.route !== "object" || Array.isArray(intent.route)
      || intent.route.surface !== intent.browser_surface)) {
    throw new Error("daily_ai_companion_route_surface_conflict");
  }
  return Object.freeze({ ...intent, route: { ...(intent.route || {}), surface: intent.browser_surface } });
}

/**
 * Validate provider evidence independently of the broker receipt. A URL made
 * from a target key, or a generic broker completion flag, is not provider
 * evidence. The producer must supply the observed values from the owned tab.
 */
export function validateDailyAiProviderReadback(readback, expected = {}) {
  if (!readback || typeof readback !== "object" || Array.isArray(readback)
    || readback.schema !== DAILY_AI_PROVIDER_READBACK_SCHEMA
    || !nonEmpty(readback.run_id) || !nonEmpty(readback.task_id) || !nonEmpty(readback.approval_id)
    || !nonEmpty(readback.platform) || !nonEmpty(readback.account_ref)
    || !nonEmpty(readback.target_key) || !nonEmpty(readback.content_key)
    || !/^[a-f0-9]{64}$/u.test(String(readback.approved_payload_hash || ""))
    || !nonEmpty(readback.observed_post_id) || !nonEmpty(readback.observed_post_url)
    || !nonEmpty(readback.observed_author) || !nonEmpty(readback.observed_content)
    || !Number.isFinite(Date.parse(String(readback.observed_at || "")))
    || !Array.isArray(readback.semantic_refs) || readback.semantic_refs.length === 0
    || !Array.isArray(readback.screenshot_refs) || readback.screenshot_refs.length === 0) {
    throw new Error("daily_ai_provider_readback_invalid");
  }
  for (const key of ["run_id", "task_id", "approval_id", "platform", "account_ref", "target_key", "content_key"]) {
    if (expected[key] !== undefined && String(readback[key]) !== String(expected[key])) throw new Error("daily_ai_provider_readback_binding_mismatch");
  }
  if (expected.approvedPayloadHash !== undefined && readback.approved_payload_hash !== expected.approvedPayloadHash) throw new Error("daily_ai_provider_readback_payload_mismatch");
  if (expected.approvedProviderIdentity !== undefined && readback.observed_author !== expected.approvedProviderIdentity) throw new Error("daily_ai_provider_readback_author_mismatch");
  if (expected.observedContent !== undefined && readback.observed_content !== expected.observedContent) throw new Error("daily_ai_provider_readback_content_mismatch");
  if (expected.observedAtAfter !== undefined && Date.parse(String(readback.observed_at)) < Number(expected.observedAtAfter)) throw new Error("daily_ai_provider_readback_time_mismatch");
  if (expected.observedTabId !== undefined && String(readback.observed_tab_id || "") !== String(expected.observedTabId)) throw new Error("daily_ai_provider_readback_tab_mismatch");
  if (expected.observedSessionId !== undefined && String(readback.observed_session_id || "") !== String(expected.observedSessionId)) throw new Error("daily_ai_provider_readback_session_mismatch");
  if (readback.constructed_url === true || readback.generic_broker_receipt === true || readback.same_tab_verified !== true) throw new Error("daily_ai_provider_readback_same_tab_required");
  for (const ref of readback.screenshot_refs) {
    const encoded = String(ref?.image_bytes_base64 || "");
    if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) || encoded.length % 4 !== 0) throw new Error("daily_ai_provider_readback_image_invalid");
    const bytes = Buffer.from(encoded, "base64");
    const mime = String(ref?.mime_type || "").toLowerCase();
    const image = (mime === "image/png" && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
      || (mime === "image/jpeg" && bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")));
    if (!bytes.length || !image || !/^[a-f0-9]{64}$/u.test(String(ref?.sha256 || ""))
      || createHash("sha256").update(bytes).digest("hex") !== ref.sha256) throw new Error("daily_ai_provider_readback_image_invalid");
  }
  return Object.freeze({ ...readback, verified: true });
}

export function validateDailyAiCompanionBusinessInput({ row, platform, runId, taskId, approvalId, accountRef, approvedPayloadHash, approvedTargetKey, intent } = {}) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("daily_ai_companion_row_missing");
  if (![platform, runId, taskId, approvalId, accountRef, approvedPayloadHash, approvedTargetKey].every((value) => String(value || "").trim())) throw new Error("daily_ai_companion_binding_missing");
  if (!intent || typeof intent !== "object" || intent.route?.surface !== AOS_CHROME_COMPANION_SURFACE) throw new Error("daily_ai_companion_intent_missing");
  return true;
}

export function prepareDailyAiCompanionOperation({ row, platform, runId, taskId, approvalId, accountRef, approvedPayloadHash, approvedTargetKey, intent }) {
  validateDailyAiCompanionBusinessInput({ row, platform, runId, taskId, approvalId, accountRef, approvedPayloadHash, approvedTargetKey, intent });
  if (intent?.route?.surface && intent.route.surface !== AOS_CHROME_COMPANION_SURFACE) throw new Error("daily_ai_companion_surface_invalid");
  const prepared = prepareDailyAiPublishPayload({ row, platform, targetKey: `${row.id}:${platform}` });
  if (prepared.payload_hash !== approvedPayloadHash || prepared.target_key !== approvedTargetKey) throw new Error("daily_ai_companion_payload_binding_mismatch");
  const boundIntent = { ...intent, action_plan: { ...intent.action_plan, payload: { ...intent.action_plan.payload, body: prepared.payload.body } } };
  const actions = companionActionsForIntent(boundIntent).map((action) => action.method === "page.submit" ? { ...action, method: "page.click" } : action);
  if (actions.filter((action) => action.method === "page.click").length !== 1 || actions.some((action) => action.method === "page.submit")) throw new Error("daily_ai_companion_single_visible_submit_required");
  return Object.freeze({ schema: DAILY_AI_COMPANION_ADAPTER_SCHEMA, run_id: runId, task_id: taskId, approval_id: approvalId, account_ref: accountRef, provider_identity: String(intent.provider_identity || "").trim(), platform, target_key: prepared.target_key, content_key: String(row.id), payload_hash: prepared.payload_hash, actions, intent: boundIntent });
}

function providerPostUrl(snapshot, platform) {
  const values = [snapshot?.url, ...(Array.isArray(snapshot?.links) ? snapshot.links : []), ...(Array.isArray(snapshot?.card_urls) ? snapshot.card_urls : [])];
  const pattern = platform === "x" ? /^https?:\/\/(?:www\.)?x\.com\/[^/]+\/status\/\d+/u : /^https?:\/\/(?:www\.)?linkedin\.com\/feed\/update\/[^/?#]+/u;
  return values.map((value) => String(value || "").trim()).find((value) => pattern.test(value)) || "";
}

function providerPostId(url, platform) {
  const match = platform === "x" ? String(url).match(/\/status\/(\d+)/u) : String(url).match(/\/feed\/update\/([^/?#]+)/u);
  return match?.[1] || "";
}

export async function readDailyAiProviderAfterTransaction({ client, session, result, operation }) {
  const tabId = result?.tab?.id ?? result?.target?.tab_id ?? result?.task_tab?.tabId;
  if (tabId === undefined || tabId === null) throw new Error("daily_ai_provider_readback_tab_missing");
  const lease = await client.request("lease.acquire", { sessionId: session.sessionId, tabId });
  const execute = (method, params) => client.request("operation.execute", { sessionId: session.sessionId, leaseId: lease.leaseId, method, params: { tabId, ...params } });
  const snapshot = await execute("page.snapshot", { maxTextChars: 30_000 });
  const query = await execute("page.query", { query: operation.intent.action_plan?.readback?.semantic_query || operation.payload_hash, limit: 10 });
  const screenshot = await execute("page.screenshot", { format: "jpeg", quality: 72 });
  const postUrl = providerPostUrl(snapshot, operation.platform);
  const observedContent = String(snapshot?.text || snapshot?.state || "");
  const observedAuthor = String(snapshot?.author || "").trim();
  if (!postUrl || !providerPostId(postUrl, operation.platform) || !observedAuthor || (operation.provider_identity && observedAuthor !== operation.provider_identity) || !observedContent.includes(operation.intent.action_plan?.payload?.body || "") || query?.count < 1 || screenshot?.tabId !== undefined && screenshot.tabId !== tabId) {
    throw new Error("daily_ai_provider_readback_observation_mismatch");
  }
  return {
    provider_readback: {
      schema: DAILY_AI_PROVIDER_READBACK_SCHEMA,
      run_id: operation.run_id, task_id: operation.task_id, approval_id: operation.approval_id,
      platform: operation.platform, account_ref: operation.account_ref, target_key: operation.target_key,
      content_key: operation.target_key.slice(0, -(`:${operation.platform}`).length), approved_payload_hash: operation.payload_hash,
      observed_post_id: providerPostId(postUrl, operation.platform), observed_post_url: postUrl,
      observed_author: observedAuthor, observed_content: observedContent, observed_at: new Date().toISOString(),
      observed_tab_id: tabId, observed_session_id: session.sessionId, same_tab_verified: true,
      semantic_refs: [{ query: query.query, count: query.count, page_instance_id: query.pageInstanceId || null }],
      screenshot_refs: [{
        tab_id: screenshot.tabId ?? tabId, url: screenshot.url || snapshot.url || "", captured_at: screenshot.capturedAt || null,
        mime_type: screenshot.mimeType || screenshot.mime_type || "", image_bytes_base64: screenshot.dataBase64 || screenshot.data_base64 || "",
        sha256: createHash("sha256").update(Buffer.from(screenshot.dataBase64 || screenshot.data_base64 || "", "base64")).digest("hex"),
      }],
    },
  };
}

export async function executeDailyAiCompanionOperation({ operation, authority, client, materializeActions, afterTransaction }) {
  const expiry = Date.parse(String(authority?.expires_at || ""));
  if (!operation?.actions?.length || !client || authority?.run_id !== operation.run_id || authority?.task_id !== operation.task_id || authority?.approval_id !== operation.approval_id || authority?.account_ref !== operation.account_ref || authority?.surface !== AOS_CHROME_COMPANION_SURFACE || authority?.approval_status !== "approved" || !Number.isFinite(expiry) || expiry <= Date.now() || authority?.payload_hash !== operation.payload_hash || authority?.target_key !== operation.target_key) throw new Error("daily_ai_companion_authority_binding_missing");
  if (operation.actions.filter((action) => action.method === "page.click").length !== 1 || operation.actions.some((action) => action.method === "page.submit")) throw new Error("daily_ai_companion_single_visible_submit_required");
  if (typeof client.requestTaskStatus !== "function") throw new Error("daily_ai_companion_operation_status_missing");
  const idempotencyKey = dailyAiCompanionIdempotencyKey(operation);
  const statusClient = {
    request: typeof client.request === "function"
      ? client.request.bind(client)
      : async (method) => method === "session.open"
        ? { sessionId: "daily-ai-status-session" }
        : method === "session.close" ? { closed: true } : {},
    requestTaskStatus: async (params) => {
      const raw = await client.requestTaskStatus(params);
      if (raw?.run_id !== operation.run_id || raw?.task_id !== operation.task_id || raw?.idempotency_key !== idempotencyKey) throw new Error("daily_ai_companion_operation_status_binding_invalid");
      return raw;
    },
  };
  let status;
  let statusError = null;
  try {
    status = await executeAosChromeCompanionTransactionStatus({ runId: operation.run_id, taskId: operation.task_id, idempotencyKey }, { client: statusClient });
  } catch (error) {
    statusError = error;
  }
  const emptyLedgerStatus = status?.result === "blocked"
    && (status?.exact_blocker?.code === "task_status_not_found"
      || /task_status_not_found|no matching task operation exists/i.test(`${status?.exact_blocker?.code || ""} ${status?.exact_blocker?.message || ""}`));
  if (!emptyLedgerStatus && (status?.result !== "verified" || status.run_id !== operation.run_id || status.task_id !== operation.task_id || status.idempotency_key !== idempotencyKey)) throw new Error("daily_ai_companion_operation_status_binding_invalid");
  const operationState = String(status?.operation_state || status?.state || "");
  const effectState = String(status?.effect_state || status?.operation_effect_state || "");
  const initialPreparation = emptyLedgerStatus || operationState === "not_found" || effectState === "not_found" || status?.status === "not_found";
  persistStatusBoundaryDiagnostic({ operation, idempotencyKey, status, statusError, initialPreparation });
  if (statusError) throw statusError;
  if (!initialPreparation && (operationState !== "prepared" || effectState !== "no_dispatch" || !Number.isSafeInteger(status?.dispatch_count) || status.dispatch_count !== 0 || status.reconciliation_required !== false)) throw new Error("daily_ai_companion_replay_forbidden");
  return executeAosChromeCompanionAuthorized({ runId: operation.run_id, taskId: operation.task_id, mode: "authorized", startUrl: operation.intent.entry_url, allowedOrigins: [operation.intent.entry_url], actions: operation.actions, idempotencyKey, intent: "daily-ai-companion-publish", keepTaskTab: true, retainOnUnknown: true, requireCapabilityHandshake: true }, { client, materializeActions, afterTransaction });
}

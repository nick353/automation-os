import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { normalizeDailyAiCompanionIntent, prepareDailyAiCompanionOperation, executeDailyAiCompanionOperation, readDailyAiProviderAfterTransaction, validateDailyAiProviderReadback } from "../daily-ai-companion-adapter.mjs";
import { prepareDailyAiPublishPayload } from "/Users/nichikatanaka/Documents/New project/scripts/daily_ai_payload_binding.mjs";
import { TaskOperationLedger } from "/Users/nichikatanaka/Library/Application Support/AOS Chrome Companion/app/src/shared/task-runtime.mjs";

const row = { id: "daily-companion-1", x_text: "日本語のCompanion送信", content_format: "X自作判断カード型", keep_priority: "ship_now", status: "drafted" };
const intent = { entry_url: "https://x.com/home", route: { surface: "aos_chrome_companion_profile_instance" }, action_plan: { payload: { body: row.x_text }, steps: [{ action: "type", payload_key: "body" }, { action: "submit", target: { semantic_query: "Post" } }], readback: { semantic_query: "post", expected: "present" } } };
const binding = prepareDailyAiPublishPayload({ row, platform: "x", targetKey: "daily-companion-1:x" });

test("canonical browser surface supplies adapter route compatibility without changing the artifact", () => {
  const canonical = { browser_surface: "aos_chrome_companion_profile_instance", operation: "publish" };
  assert.equal(normalizeDailyAiCompanionIntent(canonical).route.surface, canonical.browser_surface);
  assert.throws(() => normalizeDailyAiCompanionIntent({ ...canonical, route: { surface: "browser_use_cli" } }), /route_surface_conflict/);
  assert.throws(() => normalizeDailyAiCompanionIntent({ ...canonical, browser_surface: "browser_use_cli" }), /canonical_surface_invalid/);
});

test("Companion preparation binds run approval account target and producer hash", async () => {
  const operation = prepareDailyAiCompanionOperation({ row, platform: "x", runId: "run-1", taskId: "task-1", approvalId: "approval-1", accountRef: "daily_ai_account", approvedPayloadHash: binding.payload_hash, approvedTargetKey: binding.target_key, intent });
  assert.equal(operation.payload_hash, binding.payload_hash);
  assert.ok(operation.actions.length > 0);
  assert.equal(operation.actions.filter((action) => action.method === "page.click").length, 1);
  assert.equal(operation.actions.some((action) => action.method === "page.submit"), false);
  assert.equal(operation.actions.find((action) => action.method === "page.type")?.params.text, row.x_text);
  assert.throws(() => prepareDailyAiCompanionOperation({ row, platform: "x", runId: "run-1", taskId: "task-1", approvalId: "approval-1", accountRef: "daily_ai_account", approvedPayloadHash: "0".repeat(64), approvedTargetKey: binding.target_key, intent }), /mismatch/);
});

test("expired, foreign, and already-executed operation status reject before transport", async () => {
  const operation = prepareDailyAiCompanionOperation({ row, platform: "x", runId: "run-1", taskId: "task-1", approvalId: "approval-1", accountRef: "daily_ai_account", approvedPayloadHash: binding.payload_hash, approvedTargetKey: binding.target_key, intent });
  const authority = { run_id: "run-1", task_id: "task-1", approval_id: "approval-1", account_ref: "daily_ai_account", surface: "aos_chrome_companion_profile_instance", approval_status: "approved", expires_at: new Date(Date.now() + 60_000).toISOString(), payload_hash: binding.payload_hash, target_key: binding.target_key };
  let transport = 0;
  const client = { requestTaskStatus: async () => ({ result: "readback", run_id: operation.run_id, task_id: operation.task_id, idempotency_key: `${operation.run_id}:${operation.approval_id}:${operation.target_key}`, state: "already_executed", effect_state: "already_executed" }), requestAuthorizedTransaction: async () => { transport += 1; } };
  await assert.rejects(() => executeDailyAiCompanionOperation({ operation, authority, client }), /status_binding_invalid|replay_forbidden/);
  assert.equal(transport, 0);
  await assert.rejects(() => executeDailyAiCompanionOperation({ operation, authority: { ...authority, expires_at: new Date(Date.now() - 1_000).toISOString() }, client }), /authority_binding_missing/);
  await assert.rejects(() => executeDailyAiCompanionOperation({ operation, authority: { ...authority, run_id: "foreign-run" }, client }), /authority_binding_missing/);
});

test("same prepared ledger operation becomes unknown and cannot dispatch again", async (t) => {
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "daily-ai-ledger-")), "ledger.json");
  const ledger = new TaskOperationLedger({ statePath });
  t.after(() => { for (const file of [statePath, `${statePath}.journal`]) { try { fs.unlinkSync(file); } catch {} } });
  const operation = prepareDailyAiCompanionOperation({ row, platform: "x", runId: "run-ledger", taskId: "task-ledger", approvalId: "approval-ledger", accountRef: "daily_ai_account", approvedPayloadHash: binding.payload_hash, approvedTargetKey: binding.target_key, intent });
  const key = `${operation.run_id}:${operation.approval_id}:${operation.target_key}`;
  await ledger.prepare({ idempotencyKey: key, fingerprint: operation.payload_hash, binding: { runId: operation.run_id, taskId: operation.task_id } });
  let transactions = 0;
  const authority = { run_id: operation.run_id, task_id: operation.task_id, approval_id: operation.approval_id, account_ref: operation.account_ref, surface: "aos_chrome_companion_profile_instance", approval_status: "approved", expires_at: new Date(Date.now() + 60_000).toISOString(), payload_hash: binding.payload_hash, target_key: binding.target_key };
  const capabilities = ["page.click", "page.query", "page.screenshot", "page.snapshot", "page.type"];
  const client = {
    requestTaskStatus: async () => {
      const entry = ledger.get(key);
      return { schema: "aos.chrome_companion.task_status.v1", result: "readback", run_id: operation.run_id, task_id: operation.task_id, state: entry?.state, operation_state: entry?.state, effect_state: entry?.effectState, idempotency_key: entry?.idempotencyKey, dispatch_count: entry?.dispatchCount, reconciliation_required: false };
    },
    request: async (method) => method === "session.open"
      ? { sessionId: "s", generation: 1, capabilityHandshake: { schema: "aos.chrome_companion.task_contract.v1", version: 1, taskId: operation.task_id, availableCapabilities: capabilities, capabilityDigest: createHash("sha256").update(JSON.stringify(capabilities)).digest("hex") } }
      : method === "session.close" ? { closed: true, terminal_tab_cleanup: { status: "completed" } } : {},
    requestAuthorizedTransaction: async () => {
      transactions += 1;
      await ledger.transition(key, "dispatched", { operationId: `transport-${transactions}`, dispatchCount: 1 });
      await ledger.transition(key, "unknown_effect", { effectState: "unknown_effect", dispatchCount: 1 });
      return { result: "blocked", operation_effect_state: "unknown_effect", actions: operation.actions.map(() => ({ result: { ok: true } })), visual_readback: { dataBase64: "AQ==" }, outcome: { schema: "aos.chrome_companion.transaction_outcome.v1", provider_completion: "unverified" }, external_action_executed: true };
    },
  };
  await executeDailyAiCompanionOperation({ operation, authority, client });
  assert.equal(ledger.get(key)?.state, "unknown_effect", JSON.stringify({ entry: ledger.get(key), transactions }));
  await assert.rejects(() => executeDailyAiCompanionOperation({ operation, authority, client, ledger }), /replay_forbidden/);
  assert.equal(transactions, 1);
});

test("status boundary rejects empty, foreign, completed, dispatched, known-effect, and NaN expiry before transaction", async () => {
  const operation = prepareDailyAiCompanionOperation({ row, platform: "x", runId: "run-status", taskId: "task-status", approvalId: "approval-status", accountRef: "daily_ai_account", approvedPayloadHash: binding.payload_hash, approvedTargetKey: binding.target_key, intent });
  const key = `${operation.run_id}:${operation.approval_id}:${operation.target_key}`;
  const baseAuthority = { run_id: operation.run_id, task_id: operation.task_id, approval_id: operation.approval_id, account_ref: operation.account_ref, surface: "aos_chrome_companion_profile_instance", approval_status: "approved", expires_at: new Date(Date.now() + 60_000).toISOString(), payload_hash: binding.payload_hash, target_key: binding.target_key };
  const variants = [
    ["empty", null], ["foreign", { run_id: "foreign-run" }],
    ["completed", { operation_state: "completed", effect_state: "known_effect" }],
    ["dispatched", { operation_state: "dispatched", effect_state: "known_effect" }],
    ["known-effect", { effect_state: "known_effect" }],
    ["dispatch-history", { dispatch_count: 1 }],
    ["reconciliation-required", { reconciliation_required: true }],
    ["missing-count", { dispatch_count: undefined }],
    ["negative-count", { dispatch_count: -1 }],
    ["string-count", { dispatch_count: "0" }],
    ["nan-count", { dispatch_count: Number.NaN }],
    ["missing-reconciliation", { reconciliation_required: undefined }],
  ];
  const validStatus = { schema: "aos.chrome_companion.task_status.v1", result: "readback", run_id: operation.run_id, task_id: operation.task_id, idempotency_key: key, operation_state: "prepared", state: "prepared", effect_state: "no_dispatch", dispatch_count: 0, reconciliation_required: false };
  for (const [name, status] of variants) {
    let transactions = 0;
    let closes = 0;
    const client = {
      requestTaskStatus: async () => status === null ? {} : ({ ...validStatus, ...status }),
      request: async (method) => method === "session.open" ? { sessionId: `${name}-session`, generation: 1 } : method === "session.close" ? (closes += 1, { closed: true }) : {},
      requestAuthorizedTransaction: async () => { transactions += 1; },
    };
    await assert.rejects(() => executeDailyAiCompanionOperation({ operation, authority: baseAuthority, client }), /status_binding_invalid|replay_forbidden/);
    assert.equal(transactions, 0, `${name} dispatched a transaction`);
    assert.equal(closes, 1, `${name} did not close its owned status session`);
  }
  let transactions = 0;
  let closes = 0;
  const nanClient = {
    requestTaskStatus: async () => ({ schema: "aos.chrome_companion.task_status.v1", result: "readback", run_id: operation.run_id, task_id: operation.task_id, idempotency_key: key, operation_state: "prepared", effect_state: "no_dispatch" }),
    request: async (method) => method === "session.open" ? { sessionId: "nan-session", generation: 1 } : method === "session.close" ? (closes += 1, { closed: true }) : {},
    requestAuthorizedTransaction: async () => { transactions += 1; },
  };
  await assert.rejects(() => executeDailyAiCompanionOperation({ operation, authority: { ...baseAuthority, expires_at: "not-a-date" }, client: nanClient }), /authority_binding_missing/);
  assert.equal(transactions, 0);
  assert.equal(closes, 0);
});

test("raw status identity fields cannot be supplied by the seeded receipt", async () => {
  const operation = prepareDailyAiCompanionOperation({ row, platform: "x", runId: "run-raw", taskId: "task-raw", approvalId: "approval-raw", accountRef: "daily_ai_account", approvedPayloadHash: binding.payload_hash, approvedTargetKey: binding.target_key, intent });
  const key = `${operation.run_id}:${operation.approval_id}:${operation.target_key}`;
  const authority = { run_id: operation.run_id, task_id: operation.task_id, approval_id: operation.approval_id, account_ref: operation.account_ref, surface: "aos_chrome_companion_profile_instance", approval_status: "approved", expires_at: new Date(Date.now() + 60_000).toISOString(), payload_hash: binding.payload_hash, target_key: binding.target_key };
  for (const field of ["run_id", "task_id", "idempotency_key"]) {
    let transactions = 0;
    let closes = 0;
    const raw = { schema: "aos.chrome_companion.task_status.v1", result: "readback", run_id: operation.run_id, task_id: operation.task_id, idempotency_key: key, operation_state: "prepared", state: "prepared", effect_state: "no_dispatch", dispatch_count: 0, reconciliation_required: false };
    delete raw[field];
    const client = {
      requestTaskStatus: async () => raw,
      request: async (method) => method === "session.open" ? { sessionId: `${field}-session` } : method === "session.close" ? (closes += 1, { closed: true }) : {},
      requestAuthorizedTransaction: async () => { transactions += 1; },
    };
    await assert.rejects(() => executeDailyAiCompanionOperation({ operation, authority, client }), /status_binding_invalid|replay_forbidden/);
    assert.equal(transactions, 0, `${field} dispatched a transaction`);
    assert.equal(closes, 1, `${field} did not close its owned status session`);
  }
});

test("missing proof blocks before Companion operation boundary", async () => {
  let called = false;
  await assert.rejects(() => executeDailyAiCompanionOperation({ operation: null, client: {} }), /authority_binding_missing/);
  assert.equal(called, false);
});

test("external Companion executor boundary is stubbed and receives one prepared operation", async () => {
  const operation = prepareDailyAiCompanionOperation({ row, platform: "x", runId: "run-1", taskId: "task-1", approvalId: "approval-1", accountRef: "daily_ai_account", approvedPayloadHash: binding.payload_hash, approvedTargetKey: binding.target_key, intent });
  let reached = 0;
  const capabilities = ["page.click", "page.query", "page.screenshot", "page.snapshot", "page.type"].sort();
  const capabilityDigest = createHash("sha256").update(JSON.stringify(capabilities)).digest("hex");
  const receipt = await executeDailyAiCompanionOperation({ operation, authority: { run_id: "run-1", task_id: "task-1", approval_id: "approval-1", account_ref: "daily_ai_account", surface: "aos_chrome_companion_profile_instance", approval_status: "approved", expires_at: new Date(Date.now() + 60_000).toISOString(), payload_hash: binding.payload_hash, target_key: binding.target_key }, client: { requestTaskStatus: async () => ({ schema: "aos.chrome_companion.task_status.v1", result: "readback", run_id: "run-1", task_id: "task-1", idempotency_key: "run-1:approval-1:daily-companion-1:x", operation_state: "prepared", state: "prepared", effect_state: "no_dispatch", dispatch_count: 0, reconciliation_required: false }), request: async (method) => method === "session.open" ? { sessionId: "session-1", generation: 1, capabilityHandshake: { schema: "aos.chrome_companion.task_contract.v1", version: 1, taskId: "task-1", availableCapabilities: capabilities, capabilityDigest } } : method === "session.close" ? { closed: true, terminal_tab_cleanup: { status: "completed" } } : {}, requestAuthorizedTransaction: async () => { reached += 1; return { result: "verified", run_id: "run-1", actions: operation.actions.map(() => ({ result: { ok: true } })), visual_readback: { dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", mimeType: "image/png" }, outcome: { schema: "aos.chrome_companion.transaction_outcome.v1", provider_completion: "unverified" }, external_action_executed: true }; } } });
  assert.equal(reached, 1, JSON.stringify(receipt));
  assert.equal(receipt.run_id, "run-1");
  assert.equal(receipt.result, "verified", JSON.stringify(receipt));
  assert.equal(receipt.exact_blocker, null, JSON.stringify(receipt));
  assert.equal(receipt.browser_receipt_verified, true);
  assert.equal(receipt.provider_receipt_trusted, false);
  assert.equal(receipt.cleanup_verified, true);
});

test("provider readback requires independently observed same-tab evidence", () => {
  const proof = {
    schema: "aos.daily_ai_provider_readback.v1", run_id: "run-proof", task_id: "task-proof", approval_id: "approval-proof",
    platform: "x", account_ref: "daily_ai_account", target_key: "daily-companion-1:x", content_key: "daily-companion-1",
    approved_payload_hash: binding.payload_hash, observed_post_id: "post-1", observed_post_url: "https://x.com/nichika2000823/status/1",
    observed_author: "nichika2000823", observed_content: row.x_text, observed_at: new Date().toISOString(),
    observed_tab_id: "tab-1", observed_session_id: "session-1", same_tab_verified: true,
    semantic_refs: [{ selector: "post" }], screenshot_refs: [{ ref: "screenshot-1", mime_type: "image/png", image_bytes_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", sha256: "" }],
  };
  proof.screenshot_refs[0].sha256 = createHash("sha256").update(Buffer.from(proof.screenshot_refs[0].image_bytes_base64, "base64")).digest("hex");
  assert.equal(validateDailyAiProviderReadback(proof, { run_id: "run-proof", task_id: "task-proof", approval_id: "approval-proof", observedTabId: "tab-1", observedSessionId: "session-1" }).verified, true);
  assert.throws(() => validateDailyAiProviderReadback({ ...proof, observed_content: "tampered" }, { approvedPayloadHash: binding.payload_hash, observedContent: row.x_text }), /readback/);
  assert.throws(() => validateDailyAiProviderReadback({ ...proof, same_tab_verified: false }), /same_tab/);
  assert.throws(() => validateDailyAiProviderReadback({ ...proof, generic_broker_receipt: true }), /same_tab/);
  assert.throws(() => validateDailyAiProviderReadback({ ...proof, observed_at: new Date(Date.now() - 86_400_000).toISOString() }, { observedAtAfter: Date.now() }), /readback/);
});

test("Daily AI callback reads the transaction-owned tab before generic cleanup", async () => {
  const operation = { ...prepareDailyAiCompanionOperation({ row, platform: "x", runId: "run-callback", taskId: "task-callback", approvalId: "approval-callback", accountRef: "daily_ai_account", approvedPayloadHash: binding.payload_hash, approvedTargetKey: binding.target_key, intent }), platform: "x" };
  const calls = [];
  const client = { request: async (method, params) => {
    calls.push({ method, params });
    if (method === "lease.acquire") return { leaseId: "lease-1" };
    if (method === "operation.execute" && params.method === "page.snapshot") return { url: "https://x.com/home", text: `${row.x_text} by observed-author`, author: "observed-author", links: ["https://x.com/observed-author/status/42"] };
    if (method === "operation.execute" && params.method === "page.query") return { query: params.params.query, count: 1, pageInstanceId: "document-7" };
    if (method === "operation.execute") return { tabId: 7, url: "https://x.com/observed-author/status/42", capturedAt: new Date().toISOString(), dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", mimeType: "image/png" };
    throw new Error(`unexpected:${method}`);
  } };
  const result = await readDailyAiProviderAfterTransaction({ client, session: { sessionId: "session-callback" }, result: { tab: { id: 7 } }, operation });
  assert.deepEqual(calls.map((call) => call.method), ["lease.acquire", "operation.execute", "operation.execute", "operation.execute"]);
  assert.equal(calls.every((call) => call.params?.sessionId === undefined || call.params.sessionId === "session-callback"), true);
  assert.equal(result.provider_readback.observed_post_url, "https://x.com/observed-author/status/42");
  assert.equal(result.provider_readback.observed_tab_id, 7);
});

test("provider identity mismatch is a hard no-proof/no-queue boundary", () => {
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const proof = { schema: "aos.daily_ai_provider_readback.v1", run_id: "r", task_id: "t", approval_id: "a", platform: "x", account_ref: "acct", target_key: "c:x", content_key: "c", approved_payload_hash: binding.payload_hash, observed_post_id: "1", observed_post_url: "https://x.com/wrong/status/1", observed_author: "wrong", observed_content: row.x_text, observed_at: new Date().toISOString(), observed_tab_id: 1, observed_session_id: "s", same_tab_verified: true, semantic_refs: [{ query: "body", count: 1 }], screenshot_refs: [{ mime_type: "image/png", image_bytes_base64: image, sha256: createHash("sha256").update(Buffer.from(image, "base64")).digest("hex") }] };
  assert.throws(() => validateDailyAiProviderReadback(proof, { approvedProviderIdentity: "approved" }), /author_mismatch/);
  assert.equal(validateDailyAiProviderReadback({ ...proof, observed_author: "approved" }, { approvedProviderIdentity: "approved" }).verified, true);
});

test("provider screenshot rejects AQ and accepts persisted valid image bytes", () => {
  const base = { schema: "aos.daily_ai_provider_readback.v1", run_id: "r", task_id: "t", approval_id: "a", platform: "x", account_ref: "acct", target_key: "c:x", content_key: "c", approved_payload_hash: binding.payload_hash, observed_post_id: "1", observed_post_url: "https://x.com/a/status/1", observed_author: "a", observed_content: row.x_text, observed_at: new Date().toISOString(), same_tab_verified: true, semantic_refs: [{ query: "body", count: 1 }] };
  assert.throws(() => validateDailyAiProviderReadback({ ...base, screenshot_refs: [{ mime_type: "image/jpeg", image_bytes_base64: "AQ==", sha256: createHash("sha256").update(Buffer.from("AQ==", "base64")).digest("hex") }] }), /image_invalid/);
  const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  assert.equal(validateDailyAiProviderReadback({ ...base, screenshot_refs: [{ mime_type: "image/png", image_bytes_base64: image, sha256: createHash("sha256").update(Buffer.from(image, "base64")).digest("hex") }] }).verified, true);
});

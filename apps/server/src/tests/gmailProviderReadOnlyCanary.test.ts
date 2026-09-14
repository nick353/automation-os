import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { runGmailProviderReadOnlyCanary, isGmailProviderToolEvent, validateGmailProviderReadOnlyCanaryPreflight } from "../connectors/gmailProviderReadOnlyCanary.js";
import type { CodexAppServerClient, CodexAppServerEvent } from "../codex/appServerClient.js";

const event: CodexAppServerEvent = { method: "item/completed", itemType: "mcpToolCall", toolName: "gmail_get_profile", serverName: "codex_apps", status: "completed", capturedAt: "2026-09-05T00:00:00Z" };

test("only a completed Gmail profile tool counts as provider readback", () => {
  assert.equal(isGmailProviderToolEvent(event), true);
  assert.equal(isGmailProviderToolEvent({ ...event, method: "item/started" }), false);
  assert.equal(isGmailProviderToolEvent({ ...event, status: "failed" }), false);
  assert.equal(isGmailProviderToolEvent({ ...event, toolName: "functions_exec" }), false);
  assert.equal(isGmailProviderToolEvent({ ...event, toolName: "gmail_search" }), false);
});

test("redacted provider email matches via same-turn hash without storing the address", async () => {
  const providerAccountHash = createHash("sha256").update("owner@example.com").digest("hex");
  const client = {
    startOrResumeThread: async () => "ephemeral-test",
    startTurn: async () => ({ status: "completed", providerAccountHash, events: [event],
      structured: { provider: "gmail", operation: "profile_read", provider_account: "[redacted-email]", provider_account_present: true, external_action_executed: false, data_persisted: false, exact_blocker: null } })
  } as unknown as CodexAppServerClient;
  const result = await runGmailProviderReadOnlyCanary({ client, runId: "same-run", companyId: "company-test", accountRef: "OWNER@example.com" });
  assert.equal(result.status, "completed");
  assert.equal(result.sourceSync.status, "verified");
  assert.equal(JSON.stringify(result).includes("owner@example.com"), false);
  const mismatch = await runGmailProviderReadOnlyCanary({ client, runId: "other-run", companyId: "company-test", accountRef: "other@example.com" });
  assert.equal(mismatch.exactBlocker, "gmail_provider_account_ref_mismatch");
  assert.equal(mismatch.providerReceipt, null);
});

test("actual profile structuredContent proof does not depend on model visibility of email", async () => {
  const client = { startOrResumeThread: async () => "t", startTurn: async () => ({
    status: "completed", events: [event], providerAccountHashSource: "gmail_profile_tool",
    providerAccountHash: createHash("sha256").update("owner@example.com").digest("hex"),
    structured: { provider: "gmail", operation: "profile_read", provider_account_present: false, provider_account: null,
      external_action_executed: false, data_persisted: false, exact_blocker: "Email not visible to model" }
  }) } as unknown as CodexAppServerClient;
  const r = await runGmailProviderReadOnlyCanary({ client, runId: "same-run", companyId: "c1", accountRef: "owner@example.com" });
  assert.equal(r.status, "completed");
  assert.equal(r.providerAccountPresent, true);
  assert.equal(r.sourceSync.status, "verified");
});

test("same-turn profile proof survives bounded event-tail eviction", async () => {
  const client = { startOrResumeThread: async () => "t", startTurn: async () => ({
    status: "completed", events: [], providerAccountHashSource: "gmail_profile_tool",
    providerAccountHash: createHash("sha256").update("owner@example.com").digest("hex"),
    structured: { provider: "gmail", operation: "profile_read", provider_account_present: false, provider_account: null,
      external_action_executed: false, data_persisted: false, exact_blocker: "Email not visible to model" }
  }) } as unknown as CodexAppServerClient;
  const r = await runGmailProviderReadOnlyCanary({ client, runId: "tail-eviction-run", companyId: "c1", accountRef: "owner@example.com" });
  assert.equal(r.status, "completed");
  assert.equal(r.providerToolCallObserved, true);
  assert.equal(r.providerReceipt?.externalActionExecuted, false);
});

test("turn failure or timeout stays blocked without a provider receipt", async () => {
  const client = {
    startOrResumeThread: async () => "t",
    startTurn: async () => ({ status: "timeout", exactBlocker: "gmail_provider_turn_timeout", events: [] })
  } as unknown as CodexAppServerClient;
  const result = await runGmailProviderReadOnlyCanary({ client, runId: "timeout-run", companyId: "c1", accountRef: "owner@example.com" });
  assert.equal(result.status, "blocked");
  assert.equal(result.exactBlocker, "gmail_provider_turn_timeout");
  assert.equal(result.providerReceipt, null);
  assert.equal(result.externalActionExecuted, false);
  assert.equal(result.secretMaterialIncluded, false);
});

test("missing raw account readback stays blocked and never persists account data", async () => {
  const client = {
    startOrResumeThread: async () => "t",
    startTurn: async () => ({ status: "completed", events: [event],
      structured: { provider: "gmail", operation: "profile_read", provider_account_present: false, provider_account: null,
        external_action_executed: false, data_persisted: false, exact_blocker: null } })
  } as unknown as CodexAppServerClient;
  const result = await runGmailProviderReadOnlyCanary({ client, runId: "missing-account-run", companyId: "c1", accountRef: "owner@example.com" });
  assert.equal(result.status, "blocked");
  assert.equal(result.exactBlocker, "gmail_provider_account_readback_missing");
  assert.equal(result.providerReceipt, null);
  assert.equal(JSON.stringify(result).includes("owner@example.com"), false);
});

test("registered runner pending stops before connector dispatch", async () => {
  let providerCalls = 0;
  const client = {
    startOrResumeThread: async () => { providerCalls += 1; return "must-not-start"; },
    startTurn: async () => { providerCalls += 1; throw new Error("must-not-call"); }
  } as unknown as CodexAppServerClient;
  const result = await runGmailProviderReadOnlyCanary({
    client,
    runId: "runner-pending-run",
    companyId: "company-test",
    accountRef: "owner@example.com",
    preflight: { runnerStatus: "runner_pending" }
  });
  assert.equal(providerCalls, 0);
  assert.equal(result.status, "blocked");
  assert.equal(result.exactBlocker, "registered_runner_pending");
  assert.equal(result.providerReceipt, null);
  assert.equal(result.externalActionExecuted, false);
  assert.deepEqual(Object.keys(result).sort(), [
    "cleanup", "companyId", "connector", "dataPersisted", "dataRead", "exactBlocker", "externalActionExecuted",
    "nextAction", "operation", "providerAccountHash", "providerAccountPresent", "providerReceipt",
    "providerToolCallObserved", "reconciliation", "runId", "schema", "secretMaterialIncluded", "sourceSync", "status", "transport"
  ].sort());
});

test("missing response capture is terminal and makes no provider call", async () => {
  let providerCalls = 0;
  const client = {
    startOrResumeThread: async () => { providerCalls += 1; return "must-not-start"; },
    startTurn: async () => { providerCalls += 1; throw new Error("must-not-call"); }
  } as unknown as CodexAppServerClient;
  const result = await runGmailProviderReadOnlyCanary({
    client,
    runId: "response-capture-run",
    companyId: "company-test",
    accountRef: "owner@example.com",
    preflight: { responseCaptureAvailable: false }
  });
  assert.equal(providerCalls, 0);
  assert.equal(result.exactBlocker, "gmail_connector_response_capture_unavailable");
  assert.equal(result.providerReceipt, null);
  assert.equal(result.externalActionExecuted, false);
});

test("missing context isolation is terminal and makes no provider call", async () => {
  let providerCalls = 0;
  const client = {
    startOrResumeThread: async () => { providerCalls += 1; return "must-not-start"; },
    startTurn: async () => { providerCalls += 1; throw new Error("must-not-call"); }
  } as unknown as CodexAppServerClient;
  const result = await runGmailProviderReadOnlyCanary({
    client,
    runId: "context-isolation-run",
    companyId: "company-test",
    accountRef: "owner@example.com",
    preflight: { contextIsolationAvailable: false }
  });
  assert.equal(providerCalls, 0);
  assert.equal(result.exactBlocker, "gmail_connector_context_isolation_unavailable");
  assert.equal(result.providerReceipt, null);
  assert.equal(result.externalActionExecuted, false);
});

test("preflight blocker names are canonical and default preflight is clear", () => {
  assert.equal(validateGmailProviderReadOnlyCanaryPreflight(), null);
  assert.equal(validateGmailProviderReadOnlyCanaryPreflight({ runnerStatus: "runner_pending" }), "registered_runner_pending");
  assert.equal(validateGmailProviderReadOnlyCanaryPreflight({ responseCaptureAvailable: false }), "gmail_connector_response_capture_unavailable");
  assert.equal(validateGmailProviderReadOnlyCanaryPreflight({ contextIsolationAvailable: false }), "gmail_connector_context_isolation_unavailable");
});

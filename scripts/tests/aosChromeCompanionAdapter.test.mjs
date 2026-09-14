import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AOS_CHROME_COMPANION_ADAPTER_SCHEMA,
  AOS_CHROME_COMPANION_SURFACE,
  executeAosChromeCompanionAuthorized,
  executeAosChromeCompanionReadOnly,
  executeAosChromeCompanionTransactionStatus,
  buildAosExecutionContext,
  canContinueAosExecution,
  resolveCompanionTargetTab,
  resolveCompanionInstallRoot,
} from "../aos-chrome-companion-adapter.mjs";

const ORIGIN = "https://automation.example.test";

test("Companion adapter creates a local AOS context without Codex App metadata", () => {
  const context = buildAosExecutionContext({
    runId: "run-local-context",
    taskId: "task-local-context",
    route: { backend: "aos_chrome_companion", surface: AOS_CHROME_COMPANION_SURFACE },
  });
  assert.equal(context.source, "aos_local");
  assert.equal(context.app_dependency, false);
  assert.equal(canContinueAosExecution(context), true);
});

test("Companion adapter resolves the standard macOS install without an env override", async () => {
  const root = await resolveCompanionInstallRoot({});
  assert.match(root, /Library\/Application Support\/AOS Chrome Companion\/app$/u);
});

function fakeClient({ tabs, snapshot, screenshot = null, taskTabs = [] }) {
  const calls = [];
  return {
    calls,
    async request(method, params = {}) {
      calls.push({ method, params });
      if (method === "status.get") {
        return {
          profiles: [{
            profileInstanceId: "profile_test",
            generation: "gen_test",
            extensionRuntimeId: "runtime_test",
            connected: true,
          }],
          taskTabs,
        };
      }
      if (method === "session.open") {
        return { sessionId: "session_test", generation: "gen_test" };
      }
      if (method === "lease.acquire") {
        return { leaseId: "lease_test", sessionId: params.sessionId, tabId: params.tabId };
      }
      if (method === "session.close") {
        return {
          closed: true,
          sessionId: params.sessionId,
          terminal_tab_cleanup: { ok: true, status: "completed", closed: [91], preserved: [] },
        };
      }
      if (method === "operation.execute" && params.method === "tabs.list") return tabs;
      if (method === "operation.execute" && params.method === "page.snapshot") return snapshot;
      if (method === "operation.execute" && params.method === "page.screenshot") {
        if (screenshot instanceof Error) throw screenshot;
        return screenshot || {
          dataBase64: Buffer.from("visual proof", "utf8").toString("base64"),
          mimeType: "image/jpeg",
          tabId: tabs[0]?.id,
          windowId: tabs[0]?.windowId,
          url: snapshot?.url,
          title: snapshot?.title,
          restored: true,
        };
      }
      throw new Error(`Unexpected request: ${method}:${params.method || ""}`);
    },
  };
}

test("target resolution rejects ambiguity and non-allowlisted tabs", () => {
  const tabs = [
    { id: 1, url: `${ORIGIN}/automation`, title: "Automation" },
    { id: 2, url: `${ORIGIN}/automation`, title: "Automation" },
    { id: 3, url: "https://foreign.example.test/", title: "Automation" },
  ];
  assert.throws(
    () => resolveCompanionTargetTab(tabs, { title: "Automation" }, [ORIGIN]),
    (error) => error.code === "companion_adapter_target_ambiguous",
  );
  assert.deepEqual(
    resolveCompanionTargetTab(tabs, { tabId: 1, url: `${ORIGIN}/automation` }, [ORIGIN]),
    tabs[0],
  );
  assert.throws(
    () => resolveCompanionTargetTab(tabs, { tabId: 3 }, [ORIGIN]),
    (error) => error.code === "companion_adapter_target_not_found",
  );
});

test("read-only transaction binds one exact tab, redacts page text, and closes its session", async () => {
  const client = fakeClient({
    tabs: [{ id: 41, windowId: 7, url: `${ORIGIN}/automation`, title: "Automation" }],
    taskTabs: [{
      tabId: 41,
      taskId: "task_test",
      profileInstanceId: "profile_test",
      generation: "gen_test",
      identityConsistent: true,
      tabDisposition: "retained",
    }],
    snapshot: {
      url: `${ORIGIN}/automation`,
      title: "Automation",
      readyState: "complete",
      text: "private page body must not be stored",
      controls: [{ role: "button", name: "Run" }],
    },
  });
  const receipt = await executeAosChromeCompanionReadOnly({
    runId: "run_test",
    taskId: "task_test",
    mode: "read_only",
    target: { tabId: 41, url: `${ORIGIN}/automation` },
    allowedOrigins: [ORIGIN],
  }, { client });

  assert.equal(receipt.schema, AOS_CHROME_COMPANION_ADAPTER_SCHEMA);
  assert.equal(receipt.execution_surface, AOS_CHROME_COMPANION_SURFACE);
  assert.equal(receipt.execution_context.source, "aos_local");
  assert.equal(receipt.execution_context.app_dependency, false);
  assert.equal(receipt.result, "verified");
  assert.equal(receipt.external_action_executed, false);
  assert.equal(receipt.replay_allowed, false);
  assert.equal(receipt.readback.text_length, 36);
  assert.match(receipt.readback.text_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(receipt).includes("private page body"), false);
  assert.equal(receipt.visual_readback_verified, true);
  assert.equal(receipt.target.task_owned, true);
  assert.match(receipt.visual_readback.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(receipt.visual_readback.byte_length, 12);
  assert.equal(JSON.stringify(receipt).includes("dataBase64"), false);
  assert.equal(receipt.mutation_dispatch_count, 0);
  assert.equal(receipt.cleanup.session_closed, true);
  assert.equal(receipt.cleanup.lease_released_by_session_close, true);
  const opened = client.calls.find((call) => call.method === "session.open");
  assert.equal(opened.params.taskId, "task_test");
  assert.deepEqual(client.calls.map((call) => [call.method, call.params.method || null]), [
    ["status.get", null],
    ["session.open", null],
    ["operation.execute", "tabs.list"],
    ["lease.acquire", null],
    ["operation.execute", "page.snapshot"],
    ["operation.execute", "page.screenshot"],
    ["session.close", null],
  ]);
});

test("read-only transaction rejects an unowned allowlisted tab before leasing it", async () => {
  const client = fakeClient({
    tabs: [{ id: 43, windowId: 7, url: `${ORIGIN}/automation`, title: "Automation" }],
    snapshot: {
      url: `${ORIGIN}/automation`,
      title: "Automation",
      readyState: "complete",
      text: "unowned tab must not be read",
      controls: [{ role: "button", name: "Run" }],
    },
  });
  const receipt = await executeAosChromeCompanionReadOnly({
    runId: "run_unowned_tab",
    taskId: "current_task",
    mode: "read_only",
    target: { tabId: 43, url: `${ORIGIN}/automation` },
    allowedOrigins: [ORIGIN],
  }, { client });

  assert.equal(receipt.result, "blocked");
  assert.equal(receipt.exact_blocker.code, "companion_adapter_target_not_task_owned");
  assert.equal(receipt.external_action_executed, false);
  assert.equal(receipt.mutation_dispatch_count, 0);
  assert.equal(receipt.cleanup.session_closed, true);
  assert.equal(receipt.cleanup.lease_released_by_session_close, false);
  assert.equal(client.calls.some((call) => call.method === "lease.acquire"), false);
  assert.equal(client.calls.some((call) => call.method === "operation.execute" && call.params.method === "page.snapshot"), false);
  assert.equal(client.calls.some((call) => call.method === "operation.execute" && call.params.method === "page.screenshot"), false);
});

test("read-only transaction provisions a task-owned tab through a signed no-effect transaction", async () => {
  const calls = [];
  const client = {
    async request(method, params = {}) {
      calls.push({ method, params });
      if (method === "status.get") {
        return {
          profiles: [{ profileInstanceId: "profile_test", generation: "gen_test", extensionRuntimeId: "runtime_test", connected: true }],
          taskTabs: [],
        };
      }
      if (method === "session.open") return { sessionId: `session_${calls.filter((call) => call.method === "session.open").length}`, generation: "gen_test" };
      if (method === "session.close") return { closed: true, terminal_tab_cleanup: { status: "completed", closed: [91], preserved: [] } };
      if (method === "operation.execute" && params.method === "tabs.list") {
        return [{ id: 43, windowId: 7, url: `${ORIGIN}/automation`, title: "Automation" }];
      }
      throw new Error(`Unexpected request: ${method}:${params.method || ""}`);
    },
    async requestAuthorizedTransaction(params) {
      calls.push({ method: "task.transaction", params });
      return {
        schema: "aos.chrome_companion.transaction.v1",
        result: "verified",
        external_action_executed: false,
        tab: { id: 91, groupId: null, reused: false },
        pre: {
          url: `${ORIGIN}/automation`,
          title: "Automation",
          window_id: 7,
          text_sha256: createHash("sha256").update("read-only page", "utf8").digest("hex"),
        },
        post: {
          url: `${ORIGIN}/automation`,
          title: "Automation",
          window_id: 7,
          text_sha256: createHash("sha256").update("read-only page", "utf8").digest("hex"),
        },
        actions: [{ method: "page.delay", result: { ok: true } }],
        visual_readback: {
          dataBase64: Buffer.from("provisioned visual proof", "utf8").toString("base64"),
          mimeType: "image/jpeg",
          tabId: 91,
          windowId: 7,
          url: `${ORIGIN}/automation`,
          title: "Automation",
          restored: true,
        },
        cleanup: { closed: true, retained: false },
      };
    },
  };
  const receipt = await executeAosChromeCompanionReadOnly({
    runId: "run_provision",
    taskId: "task_provision",
    mode: "read_only",
    target: { url: `${ORIGIN}/automation` },
    allowedOrigins: [ORIGIN],
  }, { client });

  assert.equal(receipt.result, "verified");
  assert.equal(receipt.external_action_executed, false);
  assert.equal(receipt.target_provision.signed_transaction, true);
  assert.equal(receipt.target.task_owned, true);
  assert.equal(receipt.target.tab_id, 91);
  assert.equal(receipt.readback.url, `${ORIGIN}/automation`);
  assert.equal(receipt.cleanup.session_closed, true);
  assert.equal(receipt.cleanup.lease_released_by_session_close, true);
  assert.equal(receipt.visual_readback_verified, true);
  assert.equal(JSON.stringify(receipt).includes("dataBase64"), false);
  assert.deepEqual(calls.map((call) => call.method), [
    "status.get",
    "session.open",
    "operation.execute",
    "session.close",
    "session.open",
    "task.transaction",
    "session.close",
  ]);
  const transaction = calls.find((call) => call.method === "task.transaction");
  assert.equal(transaction.params.intent, "read_only_target_provision");
  assert.equal(transaction.params.actions[0].method, "page.delay");
  assert.equal(transaction.params.actions[1].method, "page.screenshot");
  assert.equal(transaction.params.reuseTaskTab, false);
  assert.equal(transaction.params.keepTaskTab, true);
});

test("read-only target provisioning retries once after a cleaned-up visual miss", async () => {
  const calls = [];
  let transactionCount = 0;
  const client = {
    async request(method, params = {}) {
      calls.push({ method, params });
      if (method === "status.get") {
        return {
          profiles: [{ profileInstanceId: "profile_test", generation: "gen_test", extensionRuntimeId: "runtime_test", connected: true }],
          taskTabs: [],
        };
      }
      if (method === "session.open") return { sessionId: `session_${calls.filter((call) => call.method === "session.open").length}`, generation: "gen_test" };
      if (method === "session.close") return { closed: true, terminal_tab_cleanup: { status: "completed", closed: [91], preserved: [] } };
      if (method === "operation.execute" && params.method === "tabs.list") {
        return [{ id: 43, windowId: 7, url: `${ORIGIN}/automation`, title: "Automation" }];
      }
      throw new Error(`Unexpected request: ${method}:${params.method || ""}`);
    },
    async requestAuthorizedTransaction(params) {
      calls.push({ method: "task.transaction", params });
      transactionCount += 1;
      if (transactionCount === 1) {
        return {
          schema: "aos.chrome.companion.transaction.v1",
          result: "blocked",
          exact_blocker: { code: "companion_visual_readback_missing", message: "temporary visual miss" },
          external_action_executed: false,
          tab: { id: 91, groupId: null, reused: false },
          pre: { url: `${ORIGIN}/automation`, title: "Automation", window_id: 7 },
          post: { url: `${ORIGIN}/automation`, title: "Automation", window_id: 7 },
          cleanup: { closed: true, retained: false },
        };
      }
      return {
        schema: "aos.chrome.companion.transaction.v1",
        result: "verified",
        external_action_executed: false,
        tab: { id: 92, groupId: null, reused: false },
        pre: { url: `${ORIGIN}/automation`, title: "Automation", window_id: 8, text_sha256: "a".repeat(64) },
        post: { url: `${ORIGIN}/automation`, title: "Automation", window_id: 8, text_sha256: "a".repeat(64) },
        visual_readback: {
          dataBase64: Buffer.from("retry visual proof", "utf8").toString("base64"),
          mimeType: "image/jpeg",
          tabId: 92,
          windowId: 8,
          url: `${ORIGIN}/automation`,
          title: "Automation",
          restored: true,
        },
        cleanup: { closed: true, retained: false },
      };
    },
  };
  const receipt = await executeAosChromeCompanionReadOnly({
    runId: "run_provision_retry",
    taskId: "task_provision_retry",
    mode: "read_only",
    target: { url: `${ORIGIN}/automation` },
    allowedOrigins: [ORIGIN],
  }, { client });

  assert.equal(receipt.result, "verified");
  assert.equal(receipt.external_action_executed, false);
  assert.equal(receipt.target_provision.attempts, 2);
  assert.equal(receipt.target.tab_id, 92);
  assert.equal(receipt.cleanup.session_closed, true);
  assert.deepEqual(
    calls.filter((call) => call.method === "task.transaction").map((call) => call.params.idempotencyKey),
    ["run_provision_retry:read-only-target-provision", "run_provision_retry:read-only-target-provision:retry-1"],
  );
});

test("read-only transaction rejects a foreign task tab before leasing it", async () => {
  const client = fakeClient({
    tabs: [{ id: 42, windowId: 7, taskId: "foreign_task", url: `${ORIGIN}/automation`, title: "Automation" }],
    taskTabs: [{ tabId: 42, taskId: "foreign_task", profileInstanceId: "profile_test", generation: "gen_test" }],
    snapshot: {
      url: `${ORIGIN}/automation`,
      title: "Automation",
      readyState: "complete",
      text: "foreign task page must not be read",
      controls: [{ role: "button", name: "Run" }],
    },
  });
  const receipt = await executeAosChromeCompanionReadOnly({
    runId: "run_foreign_task",
    taskId: "current_task",
    mode: "read_only",
    target: { tabId: 42, url: `${ORIGIN}/automation` },
    allowedOrigins: [ORIGIN],
  }, { client });

  assert.equal(receipt.result, "blocked");
  assert.equal(receipt.exact_blocker.code, "companion_adapter_foreign_task_tab");
  assert.equal(receipt.external_action_executed, false);
  assert.equal(receipt.mutation_dispatch_count, 0);
  assert.equal(client.calls.some((call) => call.method === "lease.acquire"), false);
  assert.equal(client.calls.some((call) => call.method === "operation.execute" && call.params.method === "page.snapshot"), false);
  assert.equal(receipt.cleanup.session_closed, true);
});

test("read-only transaction blocks and cleans up when visual evidence is unavailable", async () => {
  const client = fakeClient({
    tabs: [{ id: 41, windowId: 7, url: `${ORIGIN}/automation`, title: "Automation" }],
    taskTabs: [{
      tabId: 41,
      taskId: "task_visual_block",
      profileInstanceId: "profile_test",
      generation: "gen_test",
      identityConsistent: true,
      tabDisposition: "retained",
    }],
    snapshot: {
      url: `${ORIGIN}/automation`,
      title: "Automation",
      readyState: "complete",
      text: "semantic state",
      controls: [],
    },
    screenshot: new Error("screen capture unavailable"),
  });
  const receipt = await executeAosChromeCompanionReadOnly({
    runId: "run_visual_block",
    taskId: "task_visual_block",
    mode: "read_only",
    target: { tabId: 41 },
    allowedOrigins: [ORIGIN],
  }, { client });
  assert.equal(receipt.result, "blocked");
  assert.equal(receipt.external_action_executed, false);
  assert.equal(receipt.mutation_dispatch_count, 0);
  assert.equal(receipt.cleanup.session_closed, true);
  assert.equal(receipt.cleanup.lease_released_by_session_close, true);
});

test("mutation requests fail closed before opening a Companion session", async () => {
  const client = fakeClient({ tabs: [], snapshot: null });
  await assert.rejects(
    executeAosChromeCompanionReadOnly({
      runId: "run_test",
      taskId: "task_test",
      mode: "click",
      target: { tabId: 41 },
      allowedOrigins: [ORIGIN],
    }, { client }),
    (error) => error.code === "companion_adapter_mutation_not_admitted",
  );
  assert.equal(client.calls.length, 0);
});

test("reconciliation status uses a fresh read-only session and never dispatches", async () => {
  const calls = [];
  const client = {
    async request(method, params = {}) {
      calls.push({ method, params });
      if (method === "status.get") return { profiles: [] };
      if (method === "session.open") return { sessionId: "fresh-status-session", generation: "gen" };
      if (method === "session.close") return { closed: true };
      throw new Error(`Unexpected request: ${method}`);
    },
    async requestTaskStatus(params) {
      calls.push({ method: "task.status", params });
      return {
        schema: "aos.chrome_companion.task_status.v1",
        result: "reconciliation_required",
        run_id: params.runId,
        task_id: params.taskId,
        idempotency_key: params.idempotencyKey,
        operation_id: "op-1",
        state: "unknown_effect",
        restart_point: "signed_task_status_readback",
        dispatch_count: 1,
      };
    },
  };
  const receipt = await executeAosChromeCompanionTransactionStatus({
    runId: "run-status", taskId: "task-status", idempotencyKey: "idem-status",
  }, { client });
  assert.equal(receipt.result, "verified");
  assert.equal(receipt.external_action_executed, false);
  assert.equal(receipt.state, "unknown_effect");
  assert.equal(receipt.dispatch_count, 1);
  assert.deepEqual(calls.map((call) => call.method), ["status.get", "session.open", "task.status", "session.close"]);
});

test("authorized transaction preserves authority, capsule, ownership, and terminal cleanup", async () => {
  const calls = [];
  const client = {
    async request(method, params = {}) {
      calls.push({ method, params });
      if (method === "session.open") return { sessionId: "session_authorized", generation: "gen" };
      if (method === "session.close") {
        return {
          closed: true,
          terminal_tab_cleanup: { ok: true, status: "completed", closed: [91], preserved: [] },
        };
      }
      throw new Error(`Unexpected request: ${method}`);
    },
    async requestAuthorizedTransaction(params) {
      calls.push({ method: "task.transaction", params });
      return {
        schema: "aos.chrome_companion.transaction.v1",
        result: "verified",
        external_action_executed: true,
        actions: [{ method: "page.type", result: { ok: true, typed: true } }],
        visual_readback: {
          kind: "screenshot",
          dataBase64: Buffer.from("authorized visual proof", "utf8").toString("base64"),
          mimeType: "image/jpeg",
          tabId: 91,
          windowId: 7,
          url: `${ORIGIN}/apply`,
          title: "Apply",
          restored: true,
        },
        cleanup: { closed: true, retained: false },
      };
    },
  };
  const capsule = { state: "ready", workflowType: "job_application" };
  const receipt = await executeAosChromeCompanionAuthorized({
    runId: "run_authorized",
    taskId: "task_authorized",
    idempotencyKey: "idem_authorized",
    intent: "submit_application",
    startUrl: `${ORIGIN}/apply`,
    allowedOrigins: [ORIGIN],
    actions: [{ method: "page.type", params: { locator: { label: "Name" }, text: "A" } }],
    capsule,
    reuseTaskTab: true,
    keepTaskTab: false,
  }, { client });

  assert.equal(receipt.result, "verified");
  assert.equal(receipt.external_action_executed, true);
  assert.equal(receipt.execution_context.source, "aos_local");
  assert.equal(receipt.provider_receipt_trusted, true);
  assert.equal(receipt.visual_readback_verified, true);
  const opened = calls.find((call) => call.method === "session.open");
  assert.equal(opened.params.taskId, "task_authorized");
  const transaction = calls.find((call) => call.method === "task.transaction");
  assert.equal(transaction.params.idempotencyKey, "idem_authorized");
  assert.equal(transaction.params.intent, "submit_application");
  assert.deepEqual(transaction.params.capsule, capsule);
  assert.equal(transaction.params.reuseTaskTab, true);
  assert.equal(transaction.params.keepTaskTab, false);
  const closed = calls.find((call) => call.method === "session.close");
  assert.equal(closed.params.taskTerminal, true);
  assert.equal(receipt.cleanup.session_closed, true);
  assert.equal(receipt.cleanup.terminal_tab_cleanup, "completed");
});

test("authorized Companion transactions require a task-scoped capability handshake when requested", async () => {
  const calls = [];
  const digest = (capabilities) => createHash("sha256").update(JSON.stringify([...new Set(capabilities)].sort())).digest("hex");
  const client = {
    async request(method, params = {}) {
      calls.push({ method, params });
      if (method === "session.open") {
        const required = params.capabilityHandshake.requiredCapabilities;
        return {
          sessionId: "session_handshake",
          generation: "gen_handshake",
          capabilityHandshake: {
            ...params.capabilityHandshake,
            availableCapabilities: required,
            capabilityDigest: digest(required),
          },
        };
      }
      if (method === "session.close") return { closed: true, terminal_tab_cleanup: { status: "completed", closed: [] } };
      throw new Error(`Unexpected request: ${method}`);
    },
    async requestAuthorizedTransaction(params) {
      calls.push({ method: "task.transaction", params });
      return {
        schema: "aos.chrome_companion.transaction.v1",
        result: "verified",
        external_action_executed: true,
        provider_receipt_trusted: true,
        cleanup_verified: true,
        actions: [{ method: "page.click", result: { clicked: true } }],
        visual_readback: {
          kind: "screenshot",
          dataBase64: Buffer.from("handshake visual", "utf8").toString("base64"),
          mimeType: "image/jpeg",
          tabId: 91,
          url: `${ORIGIN}/apply`,
          title: "Apply",
          restored: true,
        },
      };
    },
  };
  const receipt = await executeAosChromeCompanionAuthorized({
    runId: "run_handshake",
    taskId: "task_handshake",
    idempotencyKey: "idem_handshake",
    startUrl: `${ORIGIN}/apply`,
    allowedOrigins: [ORIGIN],
    requireCapabilityHandshake: true,
    actions: [{ method: "page.click", params: { locator: { text: "Submit" } } }],
  }, { client });
  assert.equal(receipt.result, "verified");
  assert.equal(receipt.capability_handshake.taskId, "task_handshake");
  assert.ok(receipt.capability_handshake.availableCapabilities.includes("page.click"));
  assert.equal(calls.find((call) => call.method === "session.open").params.capabilityHandshake.taskId, "task_handshake");
});

test("authorized transaction refreshes a stale session exactly once before dispatch", async () => {
  const calls = [];
  let openCount = 0;
  let transactionCount = 0;
  const client = {
    async request(method, params = {}) {
      calls.push({ method, params });
      if (method === "session.open") {
        openCount += 1;
        return { sessionId: `session_refresh_${openCount}`, generation: `gen_refresh_${openCount}` };
      }
      if (method === "session.close") return { closed: true };
      throw new Error(`Unexpected request: ${method}`);
    },
    async requestAuthorizedTransaction(params) {
      calls.push({ method: "task.transaction", params });
      transactionCount += 1;
      if (transactionCount === 1) {
        const error = new Error("session generation is stale");
        error.code = "session_generation_stale";
        error.details = { mutationDispatchAttempted: false, operationEffectState: "none" };
        throw error;
      }
      return {
        schema: "aos.chrome_companion.transaction.v1",
        result: "verified",
        external_action_executed: true,
        actions: [{ method: "page.click", result: { clicked: true } }],
        visual_readback: {
          dataBase64: Buffer.from("refresh proof", "utf8").toString("base64"),
          mimeType: "image/jpeg",
          tabId: 1,
          url: `${ORIGIN}/apply`,
          title: "Apply",
          restored: true,
        },
      };
    },
  };
  const receipt = await executeAosChromeCompanionAuthorized({
    runId: "run_refresh",
    taskId: "task_refresh",
    idempotencyKey: "idem_refresh",
    startUrl: `${ORIGIN}/apply`,
    allowedOrigins: [ORIGIN],
    actions: [{ method: "page.click", params: { locator: { text: "Continue" } } }],
  }, { client });
  assert.equal(receipt.result, "verified");
  assert.deepEqual(receipt.session_recovery, {
    attempted: true,
    retried: true,
    reason: "session_generation_stale",
    from_session_id: "session_refresh_1",
    from_generation: "gen_refresh_1",
    to_session_id: "session_refresh_2",
    to_generation: "gen_refresh_2",
  });
  assert.equal(transactionCount, 2);
  assert.deepEqual(calls.filter((call) => call.method === "task.transaction").map((call) => call.params.idempotencyKey), ["idem_refresh", "idem_refresh"]);
  assert.deepEqual(calls.filter((call) => call.method === "session.open").map((call) => call.params.taskId), ["task_refresh", "task_refresh"]);
  assert.equal(receipt.cleanup.session_closed, true);
});

test("authorized transaction requires an idempotency key before opening a session", async () => {
  const client = fakeClient({ tabs: [], snapshot: null });
  await assert.rejects(
    executeAosChromeCompanionAuthorized({
      runId: "run_authorized",
      taskId: "task_authorized",
      startUrl: `${ORIGIN}/apply`,
      allowedOrigins: [ORIGIN],
      actions: [{ method: "page.type", params: { locator: { label: "Name" }, text: "A" } }],
    }, { client }),
    (error) => error.code === "companion_adapter_input_invalid",
  );
  assert.equal(client.calls.length, 0);
});

test('new outcomes keep browser proof separate from provider completion and use the shared file materializer', async () => {
  let prepared = 0, dispatched = 0;
  const inputActions = [{ method: 'page.uploadMultiple', params: { filePaths: ['/fixture/resume.pdf'], confirmationLocator: { text: 'Attached' } } }];
  const client = {
    async materializeTransactionActions(actions) {
      prepared++; assert.deepEqual(actions, inputActions);
      return [{ method: 'page.uploadMultiple', params: { locator: { text: 'Resume' },
        files: [{ name: 'resume.pdf', size: 1024 * 1024, dataBase64: 'host-only-fixture' }] } }];
    },
    async request(method, params) {
      if (method === 'session.open') return { sessionId: 'shared-files', generation: 'generation' };
      if (method === 'session.close') return { closed: true, terminal_tab_cleanup: { status: 'completed' } };
      throw Error(method);
    },
    async requestAuthorizedTransaction(request) {
      dispatched++; assert.equal(request.actions[0].params.files[0].size, 1024 * 1024);
      assert.deepEqual(request.actions[0].params.confirmationLocator, { text: 'Attached' });
      assert.equal(request.actions[0].params.filePaths, undefined);
      return { result: 'verified', external_action_executed: true, actions: [{ method: 'page.uploadMultiple', result: { ok: true } }],
        outcome: { schema: 'aos.chrome_companion.transaction_outcome.v1', provider_completion: 'unverified', source_sync: 'unverified',
          applied_action_indices: [0], remaining_action_indices: [], uncertain_action_indices: [] },
        visual_readback: { dataBase64: Buffer.from('visual').toString('base64'), mimeType: 'image/png', tabId: 9 } };
    },
  };
  const result = await executeAosChromeCompanionAuthorized({ runId: 'shared-files-run', taskId: 'shared-files-task', idempotencyKey: 'shared-files-key',
    startUrl: ORIGIN + '/apply', allowedOrigins: [ORIGIN], actions: inputActions }, { client });
  assert.equal(prepared, 1); assert.equal(dispatched, 1); assert.equal(result.browser_receipt_verified, true);
  assert.equal(result.provider_receipt_trusted, false); assert.equal(result.same_run_receipt, false);
  assert.equal(result.outcome.provider_completion, 'unverified');
});

test('missing visual readback preserves applied actions and closes only the session while remaining work is retained', async () => {
  const closes = []; let dispatches = 0;
  const outcome = { schema: 'aos.chrome_companion.transaction_outcome.v1', provider_completion: 'unverified', source_sync: 'unverified',
    applied_action_indices: [0], remaining_action_indices: [1], uncertain_action_indices: [], reconciliation_required: false };
  const client = {
    async request(method, params) {
      if (method === 'session.open') return { sessionId: 'partial-session', generation: 'generation' };
      if (method === 'session.close') { closes.push(params); return { closed: true, terminal_tab_cleanup: { status: 'retained' } }; }
      throw Error(method);
    },
    async requestAuthorizedTransaction() { dispatches++; return { result: 'blocked', actions: [{ method: 'page.type', result: { ok: true } }],
      external_action_executed: false, outcome, visual_readback: null }; },
    async requestTaskStatus() { return { state: 'partial', external_action_executed: false }; },
  };
  const result = await executeAosChromeCompanionAuthorized({ runId: 'partial-run', taskId: 'partial-task', idempotencyKey: 'partial-key',
    startUrl: ORIGIN + '/apply', allowedOrigins: [ORIGIN], actions: [{ method: 'page.type', params: { text: 'A' } }, { method: 'page.click', params: { locator: { text: 'Submit' } } }] }, { client });
  assert.equal(dispatches, 1); assert.equal(result.actions.length, 1); assert.deepEqual(result.outcome, outcome);
  assert.equal(result.exact_blocker.code, 'companion_visual_readback_missing');
  assert.equal(closes[0].taskTerminal, false); assert.equal(result.cleanup.remaining_work_retained, true);
});

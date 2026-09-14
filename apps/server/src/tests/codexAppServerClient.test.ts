import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { PassThrough, Writable } from "node:stream";
import type { SpawnOptionsWithoutStdio } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodexAppServerClient, safeAppServerEnvironment, selectAppServerCommand, type AppServerChildLike, type AppServerWebSocketLike } from "../codex/appServerClient.js";

class FakeAppServerChild implements AppServerChildLike {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.receive(String(chunk));
      callback();
    }
  });
  private readonly errorListeners = new Set<(error: Error) => void>();
  private readonly closeListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  private threadCounter = 0;
  private turnCounter = 0;
  private pendingOutput: string[] = [];
  private outputFlushScheduled = false;

  constructor(
    private readonly completionDelayMs = 0,
    private readonly ignoreThreadStart = false,
    private readonly coalesceOutput = false,
    private readonly notificationBytes = 0,
    private readonly oversizedBeforeInitialize = false
  ) {}

  on(event: "error", listener: (error: Error) => void): this {
    if (event === "error") this.errorListeners.add(listener);
    return this;
  }

  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this {
    if (event === "close") this.closeListeners.add(listener);
    return this;
  }

  removeListener(event: "error" | "close", listener: ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void)): this {
    if (event === "error") this.errorListeners.delete(listener as (error: Error) => void);
    if (event === "close") this.closeListeners.delete(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
    return this;
  }

  kill(): boolean {
    for (const listener of this.closeListeners) listener(0, null);
    return true;
  }

  private receive(input: string): void {
    for (const line of input.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)) {
      const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
      if (message.method === "initialize") {
        if (this.oversizedBeforeInitialize && this.notificationBytes > 0) {
          this.send({ method: "server/diagnostic", params: { filler: "x".repeat(this.notificationBytes) } });
        }
        this.send({ id: message.id, result: { userAgent: "fake", platformFamily: "test", platformOs: "test" } });
      } else if (message.method === "thread/start") {
        if (this.ignoreThreadStart) continue;
        const id = `thr_fake_${++this.threadCounter}`;
        this.send({ id: message.id, result: { thread: { id } } });
        this.send({ method: "thread/started", params: { thread: { id } } });
        if (this.notificationBytes > 0) {
          for (let index = 0; index < 6; index += 1) {
            this.send({ method: "thread/diagnostic", params: { index, filler: "x".repeat(this.notificationBytes) } });
          }
        }
      } else if (message.method === "thread/resume") {
        const id = String(message.params?.threadId ?? "");
        this.send({ id: message.id, result: { thread: { id } } });
      } else if (message.method === "turn/start") {
        const threadId = String(message.params?.threadId ?? "");
        const turnId = `turn_fake_${++this.turnCounter}`;
        const text = JSON.stringify({
          intent: "answer_question",
          operation: "answer_question",
          title: "状態確認",
          reply: "現在状態をreadbackしました。",
          command: "状態を確認",
          visibleSteps: ["状態を読む"],
          backendChecks: ["source-of-truthを確認"],
          answered: ["状態"],
          openQuestions: [],
          nextAction: "確認を続ける",
          executionDecision: "demo_first",
          confidence: "high"
        });
        this.send({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
        this.send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "item_fake", delta: text } });
        this.send({ method: "item/completed", params: { threadId, turnId, item: { id: "item_fake", type: "agentMessage", text } } });
        const complete = () => this.send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
        if (this.completionDelayMs > 0) setTimeout(complete, this.completionDelayMs);
        else complete();
      }
    }
  }

  private send(message: Record<string, unknown>): void {
    const line = `${JSON.stringify(message)}\n`;
    if (!this.coalesceOutput) {
      this.stdout.write(line);
      return;
    }
    this.pendingOutput.push(line);
    if (this.outputFlushScheduled) return;
    this.outputFlushScheduled = true;
    queueMicrotask(() => {
      this.outputFlushScheduled = false;
      const output = this.pendingOutput.join("");
      this.pendingOutput = [];
      this.stdout.write(output);
    });
  }
}

test("CodexAppServerClient completes a read-only turn and resumes the same thread", async () => {
  const events: string[] = [];
  const turnEvents: string[] = [];
  let child: FakeAppServerChild | undefined;
  const client = new CodexAppServerClient({
    processFactory: () => {
      child = new FakeAppServerChild();
      return child;
    },
    onEvent: (event) => events.push(event.method)
  });

  const threadId = await client.startOrResumeThread();
  const first = await client.startTurn({ threadId, text: "システム全体を確認", onEvent: (event) => turnEvents.push(event.method) });
  const resumed = await client.startOrResumeThread(threadId);
  assert.equal(resumed, threadId);
  assert.equal(first.status, "completed");
  assert.equal(first.threadId, threadId);
  assert.equal(first.structured?.title, "状態確認");
  assert.match(first.text, /状態確認/u);
  assert.ok(events.includes("item/agentMessage/delta"));
  assert.ok(events.includes("turn/completed"));
  assert.ok(turnEvents.includes("item/agentMessage/delta"));
  assert.ok(turnEvents.includes("turn/completed"));
  client.close();
  assert.ok(child);
});

test("CodexAppServerClient separates turn completion timeout from the RPC timeout", async () => {
  const client = new CodexAppServerClient({
    timeoutMs: 20,
    turnTimeoutMs: 160,
    processFactory: () => new FakeAppServerChild(60)
  });
  try {
    const threadId = await client.startOrResumeThread();
    const result = await client.startTurn({ threadId, text: "completion may arrive after the RPC window" });
    assert.equal(result.status, "completed");
  } finally {
    client.close();
  }
});

test("CodexAppServerClient keeps RPC timeout behavior when a turn timeout is configured", async () => {
  const client = new CodexAppServerClient({
    timeoutMs: 20,
    turnTimeoutMs: 160,
    processFactory: () => new FakeAppServerChild(0, true)
  });
  try {
    await assert.rejects(client.startOrResumeThread(), /thread_start_timeout/u);
  } finally {
    client.close();
  }
});

test("CodexAppServerClient accepts multiple sub-limit JSONL lines in one stdout chunk", async () => {
  const client = new CodexAppServerClient({
    processFactory: () => new FakeAppServerChild(0, false, true, 100_000)
  });
  try {
    const threadId = await client.startOrResumeThread();
    assert.match(threadId, /^thr_fake_/u);
  } finally {
    client.close();
  }
});

test("CodexAppServerClient accepts one large but bounded JSONL line", async () => {
  const client = new CodexAppServerClient({
    processFactory: () => new FakeAppServerChild(0, false, true, 2_000_000, true)
  });
  try {
    const threadId = await client.startOrResumeThread();
    assert.match(threadId, /^thr_fake_/u);
  } finally {
    client.close();
  }
});

test("CodexAppServerClient rejects one oversized JSONL line", async () => {
  const client = new CodexAppServerClient({
    processFactory: () => new FakeAppServerChild(0, false, true, 64 * 1024 * 1024 + 1, true)
  });
  try {
    await assert.rejects(client.startOrResumeThread(), /codex_app_server_protocol_line_too_large/u);
  } finally {
    client.close();
  }
});

test("CodexAppServerClient reports the separate turn timeout blocker", async () => {
  const client = new CodexAppServerClient({
    timeoutMs: 160,
    turnTimeoutMs: 20,
    processFactory: () => new FakeAppServerChild(60)
  });
  try {
    const threadId = await client.startOrResumeThread();
    await assert.rejects(
      client.startTurn({ threadId, text: "completion is deliberately too slow" }),
      /codex_app_server_turn_timeout/u
    );
  } finally {
    client.close();
  }
});

class FakeAppServerWebSocket implements AppServerWebSocketLike {
  readonly sent: string[] = [];
  finalOutput: string | null = null;
  profileResultEmail: string | null = null;
  gmailPage: Record<string, unknown> | null = null;
  appListErrorCode: number | null = null;
  appListResponse: Record<string, unknown> = { data: [{ id: "connector_gmail", name: "Gmail", isAccessible: false, isEnabled: false, installUrl: "https://chatgpt.com/apps/gmail/connector_gmail" }], nextCursor: null };
  private readonly listeners = new Map<string, Set<(event: { data?: unknown; code?: number; reason?: string }) => void>>();
  private threadCounter = 0;
  private turnCounter = 0;

  private authenticated = false;

  constructor(
    readonly url: string,
    readonly init: { headers: Record<string, string> },
    private readonly rejectPluginInstall = false,
    private readonly pluginInstallErrorCode = -32601,
    private readonly commandExecResult: Record<string, unknown> = {}
  ) {
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(event: "open" | "message" | "error" | "close", listener: (event: { data?: unknown; code?: number; reason?: string }) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
    const message = JSON.parse(data) as { id?: number; method?: string; params?: Record<string, unknown> };
    if (message.method === "initialize") {
      queueMicrotask(() => this.emitMessage({ id: message.id, result: { userAgent: "remote-fake", platformFamily: "linux", platformOs: "linux" } }));
      return;
    }
    if (message.method === "plugin/install") {
      if (this.rejectPluginInstall) {
        queueMicrotask(() => this.emitMessage({ id: message.id, error: { code: this.pluginInstallErrorCode, message: "plugin install rejected by remote" } }));
        return;
      }
      queueMicrotask(() => this.emitMessage({ id: message.id, result: {
        authPolicy: "ON_INSTALL",
        appsNeedingAuth: [{ id: "connector_gmail", name: "Gmail", category: "Communication", description: "Gmail connector", installUrl: "https://accounts.example.test/authorize?state=test" }]
      } }));
      return;
    }
    if (message.method === "command/exec") {
      queueMicrotask(() => this.emitMessage({ id: message.id, result: this.commandExecResult }));
      return;
    }
    if (message.method === "app/installed") {
      queueMicrotask(() => this.emitMessage({ id: message.id, result: {
        apps: [{ id: "connector_gmail", runtimeName: "Gmail", enabled: true, callable: true }]
      } }));
      return;
    }
    if (message.method === "app/list") {
      queueMicrotask(() => this.emitMessage(this.appListErrorCode === null
        ? { id: message.id, result: this.appListResponse }
        : { id: message.id, error: { code: this.appListErrorCode, message: "catalog unavailable" } }));
      return;
    }
    if (message.method === "plugin/read") {
      queueMicrotask(() => this.emitMessage({ id: message.id, result: {
        plugin: { apps: [{ id: "connector_gmail", name: "Gmail" }] }
      } }));
      return;
    }
    if (message.method === "app/read") {
      queueMicrotask(() => this.emitMessage({ id: message.id, result: {
        apps: [{ id: "connector_gmail", name: "Gmail", isAccessible: false, isEnabled: false, installUrl: "https://chatgpt.com/apps/gmail/connector_gmail" }],
        missingAppIds: []
      } }));
      return;
    }
    if (message.method === "account/read") {
      queueMicrotask(() => this.emitMessage({ id: message.id, result: {
        account: this.authenticated ? { type: "chatgpt", planType: "pro" } : null,
        requiresOpenaiAuth: true
      } }));
      return;
    }
    if (message.method === "account/login/start") {
      this.authenticated = true;
      queueMicrotask(() => {
        this.emitMessage({ id: message.id, result: {
          type: "chatgptDeviceCode",
          loginId: "login-123",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-1234"
        } });
        this.emitMessage({ method: "account/login/completed", params: { loginId: "login-123", success: true, error: null } });
        this.emitMessage({ method: "account/updated", params: { authMode: "chatgpt", planType: "pro" } });
      });
      return;
    }
    if (message.method === "thread/start") {
      const id = `remote_thread_${++this.threadCounter}`;
      queueMicrotask(() => this.emitMessage({ id: message.id, result: { thread: { id } } }));
      return;
    }
    if (message.method === "turn/start") {
      const threadId = String(message.params?.threadId ?? "");
      const turnId = `remote_turn_${++this.turnCounter}`;
      queueMicrotask(() => {
        this.emitMessage({ id: message.id, result: { turn: { id: turnId, status: "inProgress" } } });
        this.emitMessage({ method: "item/agentMessage/delta", params: { threadId, turnId, delta: "remote read-only result" } });
        if (this.profileResultEmail) this.emitMessage({ method: "item/completed", params: { threadId, turnId,
          item: { id: "profile", type: "mcpToolCall", server: "codex_apps", tool: "gmail.get_profile", status: "completed", error: null,
            result: { content: [{ type: "text", text: "Profile retrieved" }], structuredContent: { email: this.profileResultEmail } } } } });
        if (this.gmailPage) this.emitMessage({ method: "item/completed", params: { threadId, turnId,
          item: { id: "search", type: "mcpToolCall", server: "codex_apps", tool: "gmail.search_emails", arguments: { query: "", max_results: 100 }, status: "completed", error: null,
            result: { content: [{ type: "text", text: "Search completed" }], structuredContent: this.gmailPage } } } });
        if (this.finalOutput) this.emitMessage({ method: "item/completed", params: { threadId, turnId, item: { id: "final", type: "agentMessage", text: this.finalOutput } } });
        this.emitMessage({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
      });
    }
  }

  close(): void {
    this.emit("close", { code: 1000, reason: "test" });
  }

  private emitMessage(message: Record<string, unknown>): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  private emit(event: string, payload: { data?: unknown; code?: number; reason?: string }): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

test("plugin access uses app/list separately from callable runtime and display metadata", async () => {
  let socket: FakeAppServerWebSocket | undefined;
  const client = new CodexAppServerClient({ remoteUrl: "wss://codex.example.test/app-server", remoteToken: "unit-test-token", timeoutMs: 1000,
    webSocketFactory: (url, init) => (socket = new FakeAppServerWebSocket(url, init)) });
  try {
    const first = await client.readPluginAccess({ pluginName: "gmail" });
    assert.equal(first.apps[0].isAccessible, false);
    assert.equal(first.apps[0].callable, true);
    socket!.appListResponse = { data: [{ id: "connector_gmail", name: "Gmail", isAccessible: true, isEnabled: true }], nextCursor: null };
    const second = await client.readPluginAccess({ pluginName: "gmail" });
    assert.equal(second.apps[0].isAccessible, true);
    assert.equal(second.apps[0].isEnabled, true);
    assert.equal(second.apps[0].callable, true);
    socket!.appListResponse = { data: [], nextCursor: null };
    const missing = await client.readPluginAccess({ pluginName: "gmail" });
    assert.equal(missing.apps[0].accessStateAvailable, false);
    assert.equal(missing.apps[0].isAccessible, false);
    socket!.appListResponse = { data: [], nextCursor: "repeated" };
    await assert.rejects(client.readPluginAccess({ pluginName: "gmail" }), /pagination_invalid/);
    socket!.appListErrorCode = -32603;
    const effective = await client.readPluginAccess({ pluginName: "gmail" });
    assert.equal(effective.apps[0].accessStateSource, "app/installed");
    assert.equal(effective.apps[0].isAccessible, true);
    assert.equal(effective.appListBlocker, "codex_app_server_request_rejected_code_-32603");
    socket!.appListErrorCode = -32602;
    await assert.rejects(client.readPluginAccess({ pluginName: "gmail" }), /code_-32602/);
  } finally { client.close(); }
});

test("actual profile structuredContent wins over missing or wrong model identity", async () => {
  const client = new CodexAppServerClient({ remoteUrl: "wss://codex.example.test/app-server", remoteToken: "unit-test-token", timeoutMs: 1000,
    webSocketFactory: (url, init) => {
      const socket = new FakeAppServerWebSocket(url, init);
      socket.profileResultEmail = "owner@example.com";
      socket.finalOutput = JSON.stringify({ provider_account: "wrong@example.com", provider_account_present: true });
      return socket;
    } });
  try {
    const threadId = await client.startOrResumeThread(undefined, { ephemeral: true });
    const r = await client.startTurn({ threadId, text: "Read profile" });
    assert.equal(r.providerAccountHashSource, "gmail_profile_tool");
    assert.equal(r.providerAccountHash, "c8cd3c6427301eaf6665bccacd65ddb614527acc843a15463e3faba57124c351");
    assert.equal(JSON.stringify(r).includes("owner@example.com"), false);
  } finally { client.close(); }
});

test("Gmail actual search metadata is bounded and address-redacted independently of model output", async () => {
  const client = new CodexAppServerClient({ remoteUrl: "wss://codex.example.test/app-server", remoteToken: "unit-test-token", timeoutMs: 1000,
    webSocketFactory: (url, init) => {
      const socket = new FakeAppServerWebSocket(url, init);
      socket.gmailPage = { emails: [{ id: "m1", subject: "Contact owner@example.com", snippet: "Summary", body: "Never capture full bodies" }], next_page_token: "cursor-2" };
      socket.finalOutput = JSON.stringify({ fetched_count: 0, items: [] });
      return socket;
    } });
  try {
    const threadId = await client.startOrResumeThread(undefined, { ephemeral: true });
    const r = await client.startTurn({ threadId, text: "Read metadata" });
    assert.equal(r.gmailSummaryPage?.messages.length, 1);
    assert.equal(r.gmailSummaryPage?.messages[0]?.id, "m1");
    assert.equal(r.gmailSummaryPage?.nextPageToken, "cursor-2");
    assert.equal(r.gmailSummaryPage?.unfiltered, true);
    assert.doesNotMatch(JSON.stringify(r.gmailSummaryPage), /owner@example.com|Never capture full bodies/);
  } finally { client.close(); }
});

test("provider identity can be compared without exposing its unredacted email", async () => {
  const client = new CodexAppServerClient({ remoteUrl: "wss://codex.example.test/app-server", remoteToken: "unit-test-token", timeoutMs: 1000,
    webSocketFactory: (url, init) => {
      const socket = new FakeAppServerWebSocket(url, init);
      socket.finalOutput = JSON.stringify({ provider_account: "owner@example.com", provider_account_present: true });
      return socket;
    } });
  try {
    const threadId = await client.startOrResumeThread(undefined, { ephemeral: true });
    const result = await client.startTurn({ threadId, text: "Read only profile" });
    const { createHash } = await import("node:crypto");
    assert.equal(result.providerAccountHash, createHash("sha256").update("owner@example.com").digest("hex"));
    assert.equal(result.structured?.provider_account, "[redacted-email]");
    assert.equal(JSON.stringify(result).includes("owner@example.com"), false);
  } finally { client.close(); }
});

test("Codex App Server remote websocket preserves auth boundary and completes a read-only turn", async () => {
  let socket: FakeAppServerWebSocket | undefined;
  const client = new CodexAppServerClient({
    remoteUrl: "wss://codex.example.test:4500/app-server",
    remoteToken: "unit-test-token",
    remoteCwd: "/workspace/company1",
    timeoutMs: 1_000,
    webSocketFactory: (url, init) => {
      socket = new FakeAppServerWebSocket(url, init);
      return socket;
    }
  });

  const threadId = await client.startOrResumeThread();
  const result = await client.startTurn({ threadId, text: "read-only remote status" });
  const requests = socket?.sent.map((value) => JSON.parse(value) as { method?: string; params?: Record<string, unknown> }) ?? [];
  const threadStart = requests.find((request) => request.method === "thread/start");
  const turnStart = requests.find((request) => request.method === "turn/start");
  assert.equal(socket?.url, "wss://codex.example.test:4500/app-server");
  assert.equal(socket?.init.headers.Authorization, "Bearer unit-test-token");
  assert.equal(threadStart?.params?.cwd, "/workspace/company1");
  assert.equal(threadStart?.params?.approvalPolicy, "never");
  assert.equal(threadStart?.params?.sandbox, "read-only");
  assert.equal(turnStart?.params?.cwd, "/workspace/company1");
  assert.equal(turnStart?.params?.approvalPolicy, "never");
  assert.equal(result.status, "completed");
  assert.match(result.text, /remote read-only result/u);
  assert.equal(JSON.stringify(requests).includes("unit-test-token"), false);
  client.close();
});

test("Codex App Server installs an exact Plugin and returns only the auth handoff metadata", async () => {
  let socket: FakeAppServerWebSocket | undefined;
  const client = new CodexAppServerClient({
    remoteUrl: "wss://codex.example.test:4500/app-server",
    remoteToken: "unit-test-token",
    timeoutMs: 1_000,
    webSocketFactory: (url, init) => {
      socket = new FakeAppServerWebSocket(url, init);
      return socket;
    }
  });

  const result = await client.installPlugin({ pluginName: "gmail", remoteMarketplaceName: "openai-curated" });
  const requests = socket?.sent.map((value) => JSON.parse(value) as { method?: string; params?: Record<string, unknown> }) ?? [];
  const install = requests.find((request) => request.method === "plugin/install");
  assert.deepEqual(install?.params, { pluginName: "gmail", remoteMarketplaceName: "openai-curated" });
  assert.equal(result.pluginName, "gmail");
  assert.equal(result.marketplaceName, "openai-curated");
  assert.equal(result.authPolicy, "ON_INSTALL");
  assert.deepEqual(result.appsNeedingAuth, [{
    id: "connector_gmail",
    name: "Gmail",
    category: "Communication",
    description: "Gmail connector",
    installUrl: "https://accounts.example.test/authorize?state=test"
  }]);
  client.close();
});

test("Codex App Server falls back once to the bounded CLI plugin add bridge for -32600", async () => {
  let socket: FakeAppServerWebSocket | undefined;
  const client = new CodexAppServerClient({
    remoteUrl: "wss://codex.example.test:4500/app-server",
    remoteToken: "unit-test-token",
    remoteCwd: "/workspace/company1",
    timeoutMs: 1_000,
    webSocketFactory: (url, init) => {
      socket = new FakeAppServerWebSocket(url, init, true, -32600, {
        exitCode: 0,
        stdout: JSON.stringify({
          pluginId: "linear@openai-curated",
          name: "linear",
          marketplaceName: "openai-curated",
          authPolicy: "ON_INSTALL",
          installedPath: "/data/must-not-leak"
        })
      });
      return socket;
    }
  });

  const result = await client.installPlugin({ pluginName: "linear", remoteMarketplaceName: "openai-curated" });
  const requests = socket?.sent.map((value) => JSON.parse(value) as { method?: string; params?: Record<string, unknown> }) ?? [];
  const command = requests.find((request) => request.method === "command/exec");
  assert.deepEqual(command?.params, {
    command: ["codex", "plugin", "add", "linear@openai-curated", "--json"],
    cwd: "/workspace/company1",
    sandboxPolicy: { type: "externalSandbox", networkAccess: "enabled" }
  });
  assert.equal(requests.filter((request) => request.method === "plugin/install").length, 1);
  assert.equal(result.pluginName, "linear");
  assert.equal(result.marketplaceName, "openai-curated");
  assert.equal(result.authPolicy, "ON_INSTALL");
  assert.deepEqual(result.appsNeedingAuth, [{
    id: "connector_gmail",
    name: "Gmail",
    category: null,
    description: null,
    installUrl: "https://chatgpt.com/apps/gmail/connector_gmail"
  }]);
  assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(command?.params).includes("unit-test-token"), false);
  client.close();
});

test("Codex App Server preserves only the remote protocol error code on Plugin rejection", async () => {
  const client = new CodexAppServerClient({
    remoteUrl: "wss://codex.example.test:4500/app-server",
    remoteToken: "unit-test-token",
    timeoutMs: 1_000,
    webSocketFactory: (url, init) => new FakeAppServerWebSocket(url, init, true)
  });

  await assert.rejects(
    client.installPlugin({ pluginName: "google-drive", remoteMarketplaceName: "openai-curated" }),
    /codex_app_server_request_rejected_code_-32601/u
  );
  client.close();
});

test("Codex App Server reads installed Plugin app access without treating callable as OAuth proof", async () => {
  let socket: FakeAppServerWebSocket | undefined;
  const client = new CodexAppServerClient({
    remoteUrl: "wss://codex.example.test:4500/app-server",
    remoteToken: "unit-test-token",
    timeoutMs: 1_000,
    webSocketFactory: (url, init) => {
      socket = new FakeAppServerWebSocket(url, init);
      return socket;
    }
  });

  const installed = await client.readInstalledApps({ forceRefresh: true });
  const plugin = await client.readPluginApps({ pluginName: "gmail", remoteMarketplaceName: "openai-curated" });
  const app = await client.readApp({ appId: plugin.apps[0].id });
  assert.deepEqual(installed, [{ id: "connector_gmail", runtimeName: "Gmail", enabled: true, callable: true }]);
  assert.deepEqual(plugin, { pluginName: "gmail", marketplaceName: "openai-curated", apps: [{ id: "connector_gmail", name: "Gmail" }] });
  assert.equal(app?.isAccessible, false);
  assert.equal(app?.isEnabled, false);
  assert.equal(app?.accessStateAvailable, true);
  assert.match(app?.installUrl ?? "", /^https:\/\/chatgpt\.com\/apps\/gmail\//u);
  assert.equal(JSON.stringify(socket?.sent).includes("unit-test-token"), false);
  client.close();
});

test("Codex App Server starts device auth and records same-connection completion readback", async () => {
  let socket: FakeAppServerWebSocket | undefined;
  const client = new CodexAppServerClient({
    remoteUrl: "wss://codex.example.test:4500/app-server",
    remoteToken: "unit-test-token",
    timeoutMs: 1_000,
    webSocketFactory: (url, init) => {
      socket = new FakeAppServerWebSocket(url, init);
      return socket;
    }
  });

  const login = await client.startDeviceCodeLogin();
  const account = await client.readAccount();
  const events = client.getAuthEventReadback();
  assert.deepEqual(login, {
    loginId: "login-123",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-1234"
  });
  assert.equal(account.accountPresent, true);
  assert.equal(events.loginCompletion?.success, true);
  assert.equal(events.accountUpdated?.authMode, "chatgpt");
  assert.equal(JSON.stringify(socket?.sent).includes("unit-test-token"), false);
  client.close();
});

test("default remote websocket transport sends the capability token as an Authorization header", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  let authorization: string | undefined;
  server.on("connection", (socket, request) => {
    authorization = request.headers.authorization;
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { id?: number; method?: string };
      if (message.method === "initialize") {
        socket.send(JSON.stringify({ id: message.id, result: { userAgent: "test", platformFamily: "linux", platformOs: "linux" } }));
      }
    });
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new CodexAppServerClient({
    remoteUrl: `ws://127.0.0.1:${address.port}`,
    remoteToken: "default-transport-test-token",
    timeoutMs: 1_000
  });
  try {
    await client.start();
    assert.equal(authorization, "Bearer default-transport-test-token");
  } finally {
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("safeAppServerEnvironment excludes API/database secrets", () => {
  const env = safeAppServerEnvironment({
    PATH: "/bin",
    HOME: "/tmp/home",
    CODEX_HOME: "/tmp/codex",
    CODEX_CLI_PATH: "/opt/codex/bin/codex",
    OPENAI_API_KEY: "secret",
    DATABASE_URL: "postgres://secret",
    AUTOMATION_OS_OPERATOR_TOKEN: "secret"
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.CODEX_HOME, "/tmp/codex");
  assert.equal(env.CODEX_CLI_PATH, "/opt/codex/bin/codex");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.AUTOMATION_OS_OPERATOR_TOKEN, undefined);
});

test("Codex App Server command selection ignores blanks and follows the configured CLI precedence", () => {
  const env = {
    AUTOMATION_OS_CODEX_APP_SERVER_COMMAND: "  /env/app-server  ",
    AUTOMATION_OS_CODEX_BIN: " /env/automation-codex ",
    CODEX_CLI_PATH: " /env/launch-agent-codex "
  };
  assert.equal(selectAppServerCommand({ command: "  /explicit/codex  " }, env), "/explicit/codex");
  assert.equal(selectAppServerCommand({}, env), "/env/app-server");
  assert.equal(selectAppServerCommand({}, { ...env, AUTOMATION_OS_CODEX_APP_SERVER_COMMAND: " " }), "/env/automation-codex");
  assert.equal(selectAppServerCommand({}, { ...env, AUTOMATION_OS_CODEX_APP_SERVER_COMMAND: " ", AUTOMATION_OS_CODEX_BIN: " " }), "/env/launch-agent-codex");
  assert.equal(selectAppServerCommand({}, {}), "codex");
});

test("Codex App Server child is started with an allowlisted environment and read-only no-network turn policy", async () => {
  const requests: Array<{ method?: string; params?: Record<string, unknown> }> = [];
  let spawnOptions: SpawnOptionsWithoutStdio | undefined;
  const previousCodexCliPath = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = "/opt/codex/bin/codex";
  const client = new CodexAppServerClient({
    cwd: "/tmp",
    workspaceRoot: "/tmp",
    processFactory: (_command, _args, options) => {
      spawnOptions = options;
      const child = new FakeAppServerChild();
      const originalReceive = (child as any).receive.bind(child);
      (child as any).receive = (input: string) => {
        for (const line of input.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)) {
          const message = JSON.parse(line) as { method?: string; params?: Record<string, unknown> };
          requests.push(message);
        }
        originalReceive(input);
      };
      return child;
    }
  });

  try {
    const threadId = await client.startOrResumeThread();
    await client.startTurn({ threadId, text: "read-only status" });

    assert.equal(spawnOptions?.cwd, realpathSync("/tmp"));
    assert.equal(spawnOptions?.env?.CODEX_CLI_PATH, "/opt/codex/bin/codex");
    assert.equal(spawnOptions?.env?.OPENAI_API_KEY, undefined);
    assert.equal(spawnOptions?.env?.DATABASE_URL, undefined);
    const threadStart = requests.find((request) => request.method === "thread/start");
    const turnStart = requests.find((request) => request.method === "turn/start");
    assert.equal(threadStart?.params?.approvalPolicy, "never");
    assert.equal(threadStart?.params?.sandbox, "read-only");
    assert.equal(turnStart?.params?.approvalPolicy, "never");
    assert.equal(turnStart?.params?.sandboxPolicy, undefined);
    assert.equal(turnStart?.params?.cwd, realpathSync("/tmp"));
  } finally {
    client.close();
    if (previousCodexCliPath === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = previousCodexCliPath;
  }
});

test("Codex App Server rejects a cwd outside the explicit workspace root before spawn", async () => {
  let spawned = false;
  const client = new CodexAppServerClient({
    cwd: "/tmp",
    workspaceRoot: process.cwd(),
    processFactory: () => {
      spawned = true;
      return new FakeAppServerChild();
    }
  });

  await assert.rejects(() => client.start(), (error: unknown) => {
    assert.equal((error as Error).message, "codex_app_server_cwd_outside_workspace");
    return true;
  });
  assert.equal(spawned, false);
});

test("Codex App Server rejects a symlinked cwd that escapes the workspace root", async () => {
  const root = mkdtempSync(join(tmpdir(), "automation-os-app-server-root-"));
  const outside = mkdtempSync(join(tmpdir(), "automation-os-app-server-outside-"));
  const link = join(root, "escape");
  mkdirSync(join(root, "inside"));
  symlinkSync(outside, link, "dir");
  const client = new CodexAppServerClient({
    cwd: link,
    workspaceRoot: root,
    processFactory: () => new FakeAppServerChild()
  });

  await assert.rejects(() => client.start(), (error: unknown) => {
    assert.equal((error as Error).message, "codex_app_server_cwd_outside_workspace");
    return true;
  });
});

test("Codex App Server rejects an invalid workspace root before spawn", async () => {
  let spawnCount = 0;
  const client = new CodexAppServerClient({
    workspaceRoot: join(tmpdir(), "automation-os-app-server-missing-root"),
    processFactory: () => {
      spawnCount += 1;
      return new FakeAppServerChild();
    }
  });

  await assert.rejects(() => client.start(), (error: unknown) => {
    assert.equal((error as Error).message, "codex_app_server_workspace_root_invalid");
    return true;
  });
  assert.equal(spawnCount, 0);
});

test("Codex App Server rejects a missing cwd before spawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "automation-os-app-server-cwd-root-"));
  let spawnCount = 0;
  const client = new CodexAppServerClient({
    cwd: join(root, "missing-cwd"),
    workspaceRoot: root,
    processFactory: () => {
      spawnCount += 1;
      return new FakeAppServerChild();
    }
  });

  await assert.rejects(() => client.start(), (error: unknown) => {
    assert.equal((error as Error).message, "codex_app_server_cwd_invalid");
    return true;
  });
  assert.equal(spawnCount, 0);
});

test("Codex App Server spawn failures use a stable blocker and never expose the thrown message", async () => {
  const client = new CodexAppServerClient({
    processFactory: () => {
      throw new Error("credential-like-text /Users/private/config");
    }
  });

  await assert.rejects(() => client.start(), (error: unknown) => {
    assert.equal((error as Error).message, "codex_app_server_spawn_failed");
    assert.doesNotMatch((error as Error).message, /credential-like-text|\/Users\/private\/config/u);
    return true;
  });
});

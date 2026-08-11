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
        this.send({ id: message.id, result: { userAgent: "fake", platformFamily: "test", platformOs: "test" } });
      } else if (message.method === "thread/start") {
        const id = `thr_fake_${++this.threadCounter}`;
        this.send({ id: message.id, result: { thread: { id } } });
        this.send({ method: "thread/started", params: { thread: { id } } });
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
        this.send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
      }
    }
  }

  private send(message: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
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

class FakeAppServerWebSocket implements AppServerWebSocketLike {
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: { data?: unknown; code?: number; reason?: string }) => void>>();
  private threadCounter = 0;
  private turnCounter = 0;

  constructor(readonly url: string, readonly init: { headers: Record<string, string> }) {
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
  assert.equal(turnStart?.params?.permissionProfile, ":read-only");
  assert.equal(result.status, "completed");
  assert.match(result.text, /remote read-only result/u);
  assert.equal(JSON.stringify(requests).includes("unit-test-token"), false);
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
    assert.equal(turnStart?.params?.permissionProfile, ":read-only");
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

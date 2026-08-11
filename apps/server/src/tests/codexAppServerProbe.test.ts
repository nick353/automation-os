import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { AppServerWebSocketLike } from "../codex/appServerClient.js";
import { clearAppServerProbeCache, probeCodexAppServerSurface, runCodexAppServerThreadTurnCanary } from "../codex/appServerProbe.js";

test.afterEach(() => {
  clearAppServerProbeCache();
});

class FakeStream extends EventEmitter {
  writes: string[] = [];
  ended = false;
  onWrite: ((chunk: string) => void) | null = null;

  write(chunk: Buffer | string): boolean {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    this.writes.push(text);
    this.onWrite?.(text);
    return true;
  }

  end(): boolean {
    this.ended = true;
    return true;
  }
}

class FakeChild extends EventEmitter {
  stdin = new FakeStream();
  stdout = new FakeStream();
  stderr = new FakeStream();
  killCalls: Array<string | number | undefined> = [];

  kill(signal?: string | number): boolean {
    this.killCalls.push(signal);
    return true;
  }
}

class FakeProbeWebSocket implements AppServerWebSocketLike {
  private readonly listeners = new Map<string, Set<(event: { data?: unknown; code?: number; reason?: string }) => void>>();

  constructor(readonly url: string, readonly init: { headers: Record<string, string> }, readonly emitErrorNotification = false, readonly accountPresent = true) {
    queueMicrotask(() => this.emit("open", {}));
  }

  addEventListener(event: "open" | "message" | "error" | "close", listener: (event: { data?: unknown; code?: number; reason?: string }) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  send(data: string): void {
    const message = JSON.parse(data) as { id?: number; method?: string; params?: Record<string, unknown> };
    if (message.method === "initialize") {
      queueMicrotask(() => this.emit("message", {
        data: JSON.stringify({ id: message.id, result: { userAgent: "remote-probe", platformFamily: "linux", platformOs: "linux" } })
      }));
      return;
    }
    if (message.method === "account/read") {
      queueMicrotask(() => this.emit("message", {
        data: JSON.stringify({
          id: message.id,
          result: this.accountPresent
            ? { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: false }
            : { requiresOpenaiAuth: true }
        })
      }));
      return;
    }
    if (message.method === "thread/start") {
      queueMicrotask(() => {
        this.emit("message", {
          data: JSON.stringify({ method: "thread/started", params: { thread: { id: "thread_canary_1" } } })
        });
        this.emit("message", {
          data: JSON.stringify({ id: message.id, result: { thread: { id: "thread_canary_1" } } })
        });
      });
      return;
    }
    if (message.method === "turn/start") {
      const threadId = String(message.params?.threadId ?? "thread_canary_1");
      queueMicrotask(() => {
        this.emit("message", {
          data: JSON.stringify({ method: "turn/started", params: { threadId, turn: { id: "turn_canary_1", status: "inProgress" } } })
        });
        this.emit("message", {
          data: JSON.stringify({ id: message.id, result: { turn: { id: "turn_canary_1", status: "inProgress" } } })
        });
        if (this.emitErrorNotification) {
          this.emit("message", {
            data: JSON.stringify({ method: "error", params: { error: { message: "upstream unavailable" } } })
          });
          return;
        }
        this.emit("message", {
          data: JSON.stringify({ method: "item/agentMessage/delta", params: { threadId, turnId: "turn_canary_1", delta: "ready" } })
        });
        this.emit("message", {
          data: JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: "turn_canary_1", status: "completed" } } })
        });
      });
    }
  }

  close(): void {
    this.emit("close", { code: 1000, reason: "probe" });
  }

  private emit(event: string, payload: { data?: unknown; code?: number; reason?: string }): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

test("app server probe stays blocked when disabled and does not spawn a process", async () => {
  clearAppServerProbeCache();
  let runnerCalls = 0;
  const result = await probeCodexAppServerSurface({
    enabled: false,
    command: "node",
    runner: () => {
      runnerCalls += 1;
      throw new Error("should not spawn when disabled");
    }
  });

  assert.equal(runnerCalls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.exactBlocker, "disabled");
});

test("app server probe can verify a remote websocket initialize without starting a thread or turn", async () => {
  clearAppServerProbeCache();
  let socket: FakeProbeWebSocket | undefined;
  const result = await probeCodexAppServerSurface({
    enabled: true,
    remoteUrl: "wss://codex.example.test:4500/",
    remoteToken: "unit-test-token",
    timeoutMs: 500,
    webSocketFactory: (url, init) => {
      socket = new FakeProbeWebSocket(url, init);
      return socket;
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.protocol, "websocket");
  assert.equal(result.initializedNotificationSent, true);
  assert.equal(result.threadStarted, false);
  assert.equal(result.turnStarted, false);
  assert.equal(result.externalActionExecuted, false);
  assert.equal(result.transportSupport, "experimental_remote_websocket");
  assert.equal(result.productionRemoteCutoverAllowed, false);
  assert.equal(result.productionPromotionBlocker, "codex_app_server_remote_transport_experimental_unsupported");
  assert.equal(socket?.url, "wss://codex.example.test:4500/");
  assert.equal(socket?.init.headers.Authorization, "Bearer unit-test-token");
});

test("remote thread-turn canary completes on one authenticated read-only connection and remains non-production", async () => {
  clearAppServerProbeCache();
  let socket: FakeProbeWebSocket | undefined;
  const result = await runCodexAppServerThreadTurnCanary({
    remoteUrl: "wss://codex.example.test:4500/",
    remoteToken: "unit-test-token",
    remoteCwd: "/workspace/company1",
    timeoutMs: 500,
    webSocketFactory: (url, init) => {
      socket = new FakeProbeWebSocket(url, init);
      return socket;
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.equal(result.initialized, true);
  assert.equal(result.accountRead, true);
  assert.equal(result.accountPresent, true);
  assert.equal(result.requiresOpenaiAuth, false);
  assert.equal(result.threadStarted, true);
  assert.equal(result.turnStarted, true);
  assert.equal(result.turnCompletionObserved, true);
  assert.equal(result.threadId, "thread_canary_1");
  assert.equal(result.turnId, "turn_canary_1");
  assert.equal(result.turnStatus, "completed");
  assert.ok(result.eventMethods.includes("turn/completed"));
  assert.equal(result.productionReady, false);
  assert.equal(result.productionRemoteCutoverAllowed, false);
  assert.equal(result.productionPromotionBlocker, "codex_app_server_remote_transport_experimental_unsupported");
  assert.equal(result.externalActionExecuted, false);
  assert.equal(socket?.init.headers.Authorization, "Bearer unit-test-token");
});

test("remote thread-turn canary records an error notification before a timeout", async () => {
  clearAppServerProbeCache();
  const result = await runCodexAppServerThreadTurnCanary({
    remoteUrl: "wss://codex.example.test:4500/",
    remoteToken: "unit-test-token",
    timeoutMs: 100,
    webSocketFactory: (url, init) => new FakeProbeWebSocket(url, init, true)
  });

  assert.equal(result.ok, false);
  assert.equal(result.exactBlocker, "codex_app_server_turn_timeout");
  assert.equal(result.threadStarted, true);
  assert.equal(result.turnStarted, true);
  assert.equal(result.errorNotificationObserved, true);
  assert.ok(result.eventMethods.includes("error"));
  assert.equal(result.externalActionExecuted, false);
});

test("remote thread-turn canary stops after account/read when the dedicated server is unauthenticated", async () => {
  clearAppServerProbeCache();
  const result = await runCodexAppServerThreadTurnCanary({
    remoteUrl: "wss://codex.example.test:4500/",
    remoteToken: "unit-test-token",
    timeoutMs: 100,
    webSocketFactory: (url, init) => new FakeProbeWebSocket(url, init, false, false)
  });

  assert.equal(result.ok, false);
  assert.equal(result.exactBlocker, "codex_app_server_chatgpt_login_required");
  assert.equal(result.initialized, true);
  assert.equal(result.accountRead, true);
  assert.equal(result.accountPresent, false);
  assert.equal(result.threadStarted, false);
  assert.equal(result.turnStarted, false);
  assert.equal(result.externalActionExecuted, false);
});

test("remote thread-turn canary deduplicates concurrent probes by endpoint", async () => {
  clearAppServerProbeCache();
  let factoryCalls = 0;
  const options = {
    remoteUrl: "wss://codex.example.test:4500/",
    remoteToken: "unit-test-token",
    remoteCwd: "/workspace/company1",
    timeoutMs: 500,
    webSocketFactory: (url: string, init: { headers: Record<string, string> }) => {
      factoryCalls += 1;
      return new FakeProbeWebSocket(url, init);
    }
  };
  const [first, second] = await Promise.all([
    runCodexAppServerThreadTurnCanary(options),
    runCodexAppServerThreadTurnCanary(options)
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(factoryCalls, 1);
});

test("remote thread-turn canary rate-limits repeated sequential probes", async () => {
  clearAppServerProbeCache();
  const options = {
    remoteUrl: "wss://codex.example.test:4500/",
    remoteToken: "unit-test-token",
    remoteCwd: "/workspace/company1",
    timeoutMs: 500,
    cooldownMs: 5_000,
    webSocketFactory: (url: string, init: { headers: Record<string, string> }) => new FakeProbeWebSocket(url, init)
  };
  const first = await runCodexAppServerThreadTurnCanary(options);
  const second = await runCodexAppServerThreadTurnCanary(options);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.exactBlocker, "codex_app_server_canary_rate_limited");
});

test("remote thread-turn canary refuses local stdio fallback without starting a process", async () => {
  clearAppServerProbeCache();
  const result = await runCodexAppServerThreadTurnCanary({ timeoutMs: 500 });
  assert.equal(result.ok, false);
  assert.equal(result.exactBlocker, "codex_app_server_remote_required_for_thread_turn_canary");
  assert.equal(result.threadStarted, false);
  assert.equal(result.turnStarted, false);
  assert.equal(result.externalActionExecuted, false);
});

test("remote app server probe fails closed before connecting when auth is absent", async () => {
  clearAppServerProbeCache();
  let factoryCalls = 0;
  const result = await probeCodexAppServerSurface({
    enabled: true,
    remoteUrl: "wss://codex.example.test:4500/",
    timeoutMs: 500,
    webSocketFactory: () => {
      factoryCalls += 1;
      throw new Error("must not connect");
    }
  });

  assert.equal(factoryCalls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.exactBlocker, "codex_app_server_remote_auth_missing");
  assert.equal(result.externalActionExecuted, false);
});

test("app server probe prefers the configured official Codex CLI when the command override is blank", async () => {
  clearAppServerProbeCache();
  const child = new FakeChild();
  child.stdin.onWrite = () => {
    child.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ id: 1, result: { userAgent: "Codex", platformFamily: "unix", platformOs: "macos" } }) + "\n")
    );
  };
  const previousProbeCommand = process.env.AUTOMATION_OS_CODEX_APP_SERVER_PROBE_COMMAND;
  const previousCodexBin = process.env.AUTOMATION_OS_CODEX_BIN;
  const previousCliPath = process.env.CODEX_CLI_PATH;
  process.env.AUTOMATION_OS_CODEX_APP_SERVER_PROBE_COMMAND = " ";
  process.env.AUTOMATION_OS_CODEX_BIN = " ";
  process.env.CODEX_CLI_PATH = "/usr/local/bin/codex";
  let observedCommand = "";
  try {
    const result = await probeCodexAppServerSurface({
      enabled: true,
      runner: (command) => {
        observedCommand = command;
        return child as never;
      }
    });
    assert.equal(observedCommand, "/usr/local/bin/codex");
    assert.equal(result.ok, true);
  } finally {
    if (previousProbeCommand === undefined) delete process.env.AUTOMATION_OS_CODEX_APP_SERVER_PROBE_COMMAND;
    else process.env.AUTOMATION_OS_CODEX_APP_SERVER_PROBE_COMMAND = previousProbeCommand;
    if (previousCodexBin === undefined) delete process.env.AUTOMATION_OS_CODEX_BIN;
    else process.env.AUTOMATION_OS_CODEX_BIN = previousCodexBin;
    if (previousCliPath === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = previousCliPath;
  }
});

test("app server probe accepts an official initialize response without version", async () => {
  clearAppServerProbeCache();
  const child = new FakeChild();
  child.stdin.onWrite = () => {
    child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            userAgent: "Codex",
            platformFamily: "linux",
            platformOs: "darwin"
          }
        }) + "\n"
      )
    );
    child.emit("close", 0, null);
  };
  const result = await probeCodexAppServerSurface({
    enabled: true,
    command: "node",
    runner: () => child as never
  });

  assert.equal(child.stdin.writes.length, 1);
  assert.match(child.stdin.writes[0], /"method":"initialize"/);
  assert.equal(result.ok, true);
  assert.equal(result.status, "ok");
  assert.equal(result.version, null);
});

test("app server probe resolves from initialize while the server remains alive", async () => {
  clearAppServerProbeCache();
  const child = new FakeChild();
  child.stdin.onWrite = () => {
    child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          id: 1,
          result: {
            userAgent: "Codex Desktop/0.145.0",
            platformFamily: "unix",
            platformOs: "macos"
          }
        }) + "\n"
      )
    );
  };
  const result = await probeCodexAppServerSurface({
    enabled: true,
    command: "node",
    timeoutMs: 500,
    runner: () => child as never
  });

  assert.equal(result.ok, true);
  assert.equal(result.exactBlocker, null);
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
});

test("app server probe scans JSONL lines until a matching initialize response appears", async () => {
  clearAppServerProbeCache();
  const child = new FakeChild();
  child.stdin.onWrite = () => {
    child.stdout.emit(
      "data",
      Buffer.from(
        [
          JSON.stringify({ jsonrpc: "2.0", id: 2, result: { userAgent: "Wrong", platformFamily: "linux", platformOs: "darwin" } }),
          JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: { userAgent: "Noise" } }),
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              userAgent: "Codex",
              platformFamily: "linux",
              platformOs: "darwin",
              version: "1.2.3"
            }
          })
        ].join("\n") + "\n"
      )
    );
    child.emit("close", 0, null);
  };
  const result = await probeCodexAppServerSurface({
    enabled: true,
    command: "node",
    runner: () => child as never
  });

  assert.equal(result.ok, true);
  assert.equal(result.userAgent, "Codex");
  assert.equal(result.version, "1.2.3");
});

test("app server probe rejects legacy nested serverInfo initialize payloads", async () => {
  clearAppServerProbeCache();
  const child = new FakeChild();
  child.stdin.onWrite = () => {
    child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            serverInfo: {
              userAgent: "Codex",
              platformFamily: "linux",
              platformOs: "darwin"
            }
          }
        }) + "\n"
      )
    );
    child.emit("close", 0, null);
  };
  const result = await probeCodexAppServerSurface({
    enabled: true,
    command: "node",
    runner: () => child as never
  });

  assert.equal(result.ok, false);
  assert.equal(result.exactBlocker, "protocol_error");
});

test("app server probe treats a matching initialize error as rejected", async () => {
  clearAppServerProbeCache();
  const child = new FakeChild();
  child.stdin.onWrite = () => {
    child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: {
            code: -32603,
            message: "initialize failed"
          }
        }) + "\n"
      )
    );
    child.emit("close", 0, null);
  };
  const result = await probeCodexAppServerSurface({
    enabled: true,
    command: "node",
    runner: () => child as never
  });

  assert.equal(result.ok, false);
  assert.equal(result.exactBlocker, "initialize_rejected");
});

test("app server probe redacts secrets and control characters from userAgent before truncation", async () => {
  clearAppServerProbeCache();
  const child = new FakeChild();
  child.stdin.onWrite = () => {
    child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            userAgent: "Codex\u0007Bearer secret-token token=abc123 api key=verysecret credential:keep-out",
            platformFamily: "linux",
            platformOs: "darwin"
          }
        }) + "\n"
      )
    );
    child.emit("close", 0, null);
  };
  const resultPromise = probeCodexAppServerSurface({
    enabled: true,
    command: "node",
    runner: () => child as never
  });

  const result = await resultPromise;

  assert.equal(result.ok, true);
  assert.ok(result.userAgent);
  assert.match(result.userAgent ?? "", /Codex/);
  assert.match(result.userAgent ?? "", /Bearer \[redacted\]/);
  assert.doesNotMatch(result.userAgent ?? "", /secret-token|abc123|verysecret|keep-out|\u0007/);
  assert.ok((result.userAgent ?? "").length <= 256);
});

test("app server probe preserves generic secret words while redacting credential values", async () => {
  clearAppServerProbeCache();
  const child = new FakeChild();
  child.stdin.onWrite = () => {
    child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            userAgent: "Codex secret browser Bearer token=abc123",
            platformFamily: "linux secret browser",
            platformOs: "darwin secret browser",
            version: "0.1.0 secret browser"
          }
        }) + "\n"
      )
    );
    child.emit("close", 0, null);
  };
  const result = await probeCodexAppServerSurface({
    enabled: true,
    command: "node",
    runner: () => child as never
  });

  assert.equal(result.ok, true);
  assert.match(result.userAgent ?? "", /\bsecret\b/);
  assert.doesNotMatch(result.userAgent ?? "", /token=abc123|abc123/);
  assert.match(result.userAgent ?? "", /Bearer \[redacted\]/);
});

test("app server probe allowlists env and redacts version, platform, and userAgent fields", async () => {
  clearAppServerProbeCache();
  const child = new FakeChild();
  const previousEnv = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    DATABASE_URL: process.env.DATABASE_URL,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    FAKE_APP_SERVER_PROBE_SECRET: process.env.FAKE_APP_SERVER_PROBE_SECRET
  };
  let spawnedEnv: NodeJS.ProcessEnv | undefined;
  process.env.OPENAI_API_KEY = "fake-openai-secret";
  process.env.DATABASE_URL = "postgres://fake-db-secret";
  process.env.AWS_SECRET_ACCESS_KEY = "fake-aws-secret";
  process.env.FAKE_APP_SERVER_PROBE_SECRET = "do-not-pass";
  child.stdin.onWrite = () => {
    child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            userAgent: "Codex\u0007 Bearer secret-token token=abc123 api key=verysecret",
            platformFamily: "linux secret=family-secret",
            platformOs: "darwin\u0000 password=platform-secret",
            version: "0.1.0 credential=version-secret"
          }
        }) + "\n"
      )
    );
    child.emit("close", 0, null);
  };

  try {
    const result = await probeCodexAppServerSurface({
      enabled: true,
      command: "node",
      runner: (_command, _args, options) => {
        spawnedEnv = options.env as NodeJS.ProcessEnv;
        return child as never;
      }
    });

    assert.equal(spawnedEnv?.OPENAI_API_KEY, undefined);
    assert.equal(spawnedEnv?.DATABASE_URL, undefined);
    assert.equal(spawnedEnv?.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(spawnedEnv?.FAKE_APP_SERVER_PROBE_SECRET, undefined);
    assert.equal(result.ok, true);
    assert.equal(result.status, "ok");
    assert.match(result.userAgent ?? "", /Codex/);
    assert.match(result.platformFamily ?? "", /linux/);
    assert.match(result.platformOs ?? "", /darwin/);
    assert.match(result.version ?? "", /0\.1\.0/);
    assert.doesNotMatch(result.userAgent ?? "", /secret-token|abc123|verysecret|\u0007/);
    assert.doesNotMatch(result.platformFamily ?? "", /family-secret|secret=/);
    assert.match(result.platformOs ?? "", /\bpassword\b/);
    assert.doesNotMatch(result.platformOs ?? "", /platform-secret|\u0000/);
    assert.match(result.version ?? "", /\bcredential\b/);
    assert.doesNotMatch(result.version ?? "", /version-secret/);
    assert.doesNotMatch(JSON.stringify(result), /fake-openai-secret|postgres:\/\/fake-db-secret|fake-aws-secret|do-not-pass/);
  } finally {
    if (previousEnv.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousEnv.OPENAI_API_KEY;
    if (previousEnv.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousEnv.DATABASE_URL;
    if (previousEnv.AWS_SECRET_ACCESS_KEY === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
    else process.env.AWS_SECRET_ACCESS_KEY = previousEnv.AWS_SECRET_ACCESS_KEY;
    if (previousEnv.FAKE_APP_SERVER_PROBE_SECRET === undefined) delete process.env.FAKE_APP_SERVER_PROBE_SECRET;
    else process.env.FAKE_APP_SERVER_PROBE_SECRET = previousEnv.FAKE_APP_SERVER_PROBE_SECRET;
  }
});

test("app server probe keeps multibyte stdout within the byte cap and still parses initialize", async () => {
  clearAppServerProbeCache();
  const child = new FakeChild();
  child.stdin.onWrite = () => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        userAgent: "Codex",
        platformFamily: "linux",
        platformOs: "darwin"
      }
    });
    child.stdout.emit("data", Buffer.from(`${payload}\n${"😀".repeat(40000)}\n`));
    child.emit("close", 0, null);
  };
  const resultPromise = probeCodexAppServerSurface({
    enabled: true,
    command: "node",
    runner: () => child as never
  });

  const result = await resultPromise;

  assert.equal(result.ok, true);
  assert.equal(result.platformFamily, "linux");
  assert.equal(result.platformOs, "darwin");
});

test("app server probe cleans up on timeout and escalates kill signals", async () => {
  clearAppServerProbeCache();
  const child = new FakeChild();
  const result = await probeCodexAppServerSurface({
    enabled: true,
    command: "node",
    timeoutMs: 5,
    runner: () => child as never
  });

  await delay(150);

  assert.equal(result.ok, false);
  assert.equal(result.exactBlocker, "initialize_timeout");
  assert.ok(child.killCalls.includes("SIGTERM"));
  assert.ok(child.killCalls.includes("SIGKILL"));
});

test("app server probe tolerates stdin EPIPE and still resolves from initialize output", async () => {
  clearAppServerProbeCache();
  const child = new FakeChild();
  child.stdin.onWrite = () => {
    child.stdin.emit("error", Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
    child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            userAgent: "Codex",
            platformFamily: "linux",
            platformOs: "darwin"
          }
        }) + "\n"
      )
    );
    child.emit("close", 0, null);
  };
  const resultPromise = probeCodexAppServerSurface({
    enabled: true,
    command: "node",
    runner: () => child as never
  });

  const result = await resultPromise;

  assert.equal(result.ok, true);
  assert.equal(result.exactBlocker, null);
});

test("app server probe caches fresh results by ttl and reuses a single in-flight probe", async () => {
  clearAppServerProbeCache();
  let now = 1_000_000;
  let runnerCalls = 0;
  const runner = () => {
    runnerCalls += 1;
    const child = new FakeChild();
    child.stdin.onWrite = () => {
      child.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              userAgent: "Codex",
              platformFamily: "linux",
              platformOs: "darwin"
            }
          }) + "\n"
        )
      );
      child.emit("close", 0, null);
    };
    return child as never;
  };

  const [first, second] = await Promise.all([
    probeCodexAppServerSurface({ enabled: true, command: "node", now: () => now, ttlMs: 30_000, runner }),
    probeCodexAppServerSurface({ enabled: true, command: "node", now: () => now, ttlMs: 30_000, runner })
  ]);
  assert.equal(runnerCalls, 1);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  const cached = await probeCodexAppServerSurface({ enabled: true, command: "node", now: () => now + 1_000, ttlMs: 30_000, runner });
  assert.equal(runnerCalls, 1);
  assert.equal(cached.ok, true);

  const expired = await probeCodexAppServerSurface({ enabled: true, command: "node", now: () => now + 31_000, ttlMs: 30_000, runner });
  assert.equal(runnerCalls, 2);
  assert.equal(expired.ok, true);
});

test("app server probe sends only initialize to the child process", async () => {
  clearAppServerProbeCache();
  const child = new FakeChild();
  child.stdin.onWrite = () => {
    child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            userAgent: "Codex",
            platformFamily: "linux",
            platformOs: "darwin"
          }
        }) + "\n"
      )
    );
    child.emit("close", 0, null);
  };
  const resultPromise = probeCodexAppServerSurface({
    enabled: true,
    command: "node",
    runner: () => child as never
  });

  await resultPromise;

  assert.equal(child.stdin.writes.length, 1);
  assert.match(child.stdin.writes[0], /"method":"initialize"/);
  assert.equal(child.stdin.ended, false);
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

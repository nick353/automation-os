import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { clearAppServerProbeCache, probeCodexAppServerSurface } from "../codex/appServerProbe.js";

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
  assert.equal(child.stdin.ended, true);
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

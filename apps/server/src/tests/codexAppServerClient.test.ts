import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import type { SpawnOptionsWithoutStdio } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CodexAppServerClient, safeAppServerEnvironment, type AppServerChildLike } from "../codex/appServerClient.js";

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

test("safeAppServerEnvironment excludes API/database secrets", () => {
  const env = safeAppServerEnvironment({
    PATH: "/bin",
    HOME: "/tmp/home",
    CODEX_HOME: "/tmp/codex",
    OPENAI_API_KEY: "secret",
    DATABASE_URL: "postgres://secret",
    AUTOMATION_OS_OPERATOR_TOKEN: "secret"
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.CODEX_HOME, "/tmp/codex");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.AUTOMATION_OS_OPERATOR_TOKEN, undefined);
});

test("Codex App Server child is started with an allowlisted environment and read-only no-network turn policy", async () => {
  const requests: Array<{ method?: string; params?: Record<string, unknown> }> = [];
  let spawnOptions: SpawnOptionsWithoutStdio | undefined;
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

  const threadId = await client.startOrResumeThread();
  await client.startTurn({ threadId, text: "read-only status" });

  assert.equal(spawnOptions?.cwd, realpathSync("/tmp"));
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
  client.close();
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

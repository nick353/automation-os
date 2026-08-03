import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { redactSensitiveText } from "../obsidian/redaction.js";
import { resolveBoundedWorkspacePath } from "../security/processEnvironment.js";

type WritableLike = {
  write(chunk: string): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
};

type ReadableLike = {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  removeListener(event: "data", listener: (chunk: Buffer | string) => void): unknown;
};

export type AppServerChildLike = {
  stdin: WritableLike;
  stdout: ReadableLike;
  stderr: ReadableLike;
  on(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
};

export type AppServerProcessFactory = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio
) => AppServerChildLike;

export type CodexAppServerEvent = {
  method: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  delta?: string;
  status?: string;
  capturedAt: string;
};

export type CodexAppServerTurnResult = {
  threadId: string;
  turnId: string;
  status: "completed" | "interrupted" | "failed" | "blocked";
  text: string;
  structured: Record<string, unknown> | null;
  events: CodexAppServerEvent[];
  exactBlocker?: string;
};

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type PendingCompletion = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type JsonRpcMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
};

const defaultTimeoutMs = 45_000;
const maxTimeoutMs = 120_000;
const maxLineBytes = 512 * 1024;
const maxEventsPerTurn = 160;

/**
 * A deliberately small JSONL client for the local Codex App Server.
 *
 * The client is worker-owned: it never exposes the process, credential
 * environment, or raw protocol messages to the web/API surface.
 */
export class CodexAppServerClient {
  private child: AppServerChildLike | null = null;
  private initialized = false;
  private connecting: Promise<void> | null = null;
  private nextRequestId = 1;
  private lineBuffer = "";
  private closed = false;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly completions = new Map<string, PendingCompletion>();
  private readonly recentCompletions = new Map<string, Record<string, unknown>>();
  private readonly turnEvents = new Map<string, CodexAppServerEvent[]>();
  private readonly turnText = new Map<string, string>();
  private readonly turnToThread = new Map<string, string>();
  private readonly turnListeners = new Map<string, (event: CodexAppServerEvent) => void>();
  private readonly pendingTurnListeners = new Map<string, (event: CodexAppServerEvent) => void>();

  constructor(private readonly options: {
    command?: string;
    cwd?: string;
    workspaceRoot?: string;
    timeoutMs?: number;
    processFactory?: AppServerProcessFactory;
    onEvent?: (event: CodexAppServerEvent) => void;
  } = {}) {}

  async start(): Promise<void> {
    if (this.initialized) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.startInternal().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async startOrResumeThread(threadId?: string): Promise<string> {
    await this.start();
    const cwd = appServerCwd(this.options.cwd, this.options.workspaceRoot ?? process.env.AUTOMATION_OS_WORKER_WORKSPACE_ROOT);
    const method = threadId?.trim() ? "thread/resume" : "thread/start";
    const params: Record<string, unknown> = threadId?.trim()
      ? {
          threadId: threadId.trim(),
          cwd,
          approvalPolicy: "never",
          sandbox: "read-only",
          serviceName: "automation_os_chat"
        }
      : {
          cwd,
          approvalPolicy: "never",
          sandbox: "read-only",
          serviceName: "automation_os_chat",
          ephemeral: false
        };
    const response = await this.request(method, params);
    const returnedThread = response.result && typeof response.result === "object"
      ? (response.result as Record<string, unknown>).thread
      : undefined;
    const returnedId = returnedThread && typeof returnedThread === "object"
      ? (returnedThread as Record<string, unknown>).id
      : undefined;
    if (typeof returnedId !== "string" || !returnedId.trim()) {
      throw new Error("codex_app_server_thread_id_missing");
    }
    return returnedId.trim();
  }

  async startTurn(input: {
    threadId: string;
    text: string;
    outputSchema?: Record<string, unknown>;
    onEvent?: (event: CodexAppServerEvent) => void;
  }): Promise<CodexAppServerTurnResult> {
    const threadId = input.threadId.trim();
    const text = redactSensitiveText(input.text).trim();
    if (!threadId) throw new Error("codex_app_server_thread_id_required");
    if (!text) throw new Error("codex_app_server_turn_text_required");
    await this.start();

    if (input.onEvent) this.pendingTurnListeners.set(threadId, input.onEvent);
    const responsePromise = this.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      cwd: appServerCwd(this.options.cwd, this.options.workspaceRoot ?? process.env.AUTOMATION_OS_WORKER_WORKSPACE_ROOT),
      approvalPolicy: "never",
      // Codex CLI 0.145+ removed the legacy sandboxPolicy.access shape for
      // restricted reads. Keep the turn on the built-in read-only profile so
      // the worker remains unable to approve or write external effects.
      permissionProfile: ":read-only",
      ...(input.outputSchema ? { outputSchema: input.outputSchema } : {})
    });
    let response: Record<string, unknown>;
    try {
      response = await responsePromise;
    } finally {
      if (this.pendingTurnListeners.get(threadId) === input.onEvent) this.pendingTurnListeners.delete(threadId);
    }
    const turn = response.result && typeof response.result === "object"
      ? (response.result as Record<string, unknown>).turn
      : undefined;
    const turnId = turn && typeof turn === "object" ? (turn as Record<string, unknown>).id : undefined;
    if (typeof turnId !== "string" || !turnId.trim()) {
      throw new Error("codex_app_server_turn_id_missing");
    }

    const key = turnKey(threadId, turnId);
    this.turnToThread.set(turnId, threadId);
    if (input.onEvent) this.turnListeners.set(key, input.onEvent);
    try {
      const completed = await this.waitForCompletion(key);
      const turnEvents = this.turnEvents.get(key) ?? [];
      const textOutput = this.turnText.get(key) ?? "";
      const status = completionStatus(completed);
      const exactBlocker = status === "blocked" || status === "failed"
        ? completionError(completed) ?? "codex_app_server_turn_failed"
        : undefined;
      return {
        threadId,
        turnId,
        status,
        text: redactSensitiveText(textOutput).slice(0, 24_000),
        structured: parseStructuredText(textOutput),
        events: turnEvents.slice(-maxEventsPerTurn),
        exactBlocker
      };
    } finally {
      this.turnListeners.delete(key);
    }
  }

  close(): void {
    this.closed = true;
    this.initialized = false;
    this.rejectAll(new Error("codex_app_server_closed"));
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // The worker owns this process; a close race is already terminal.
    }
  }

  private async startInternal(): Promise<void> {
    this.closed = false;
    const command = selectAppServerCommand(this.options);
    if (!command) throw new Error("codex_app_server_command_missing");
    const cwd = appServerCwd(this.options.cwd, this.options.workspaceRoot ?? process.env.AUTOMATION_OS_WORKER_WORKSPACE_ROOT);
    const factory = this.options.processFactory ?? (spawn as unknown as AppServerProcessFactory);
    let child: AppServerChildLike;
    try {
      child = factory(command, ["app-server", "--listen", "stdio://"], {
        cwd,
        env: safeAppServerEnvironment(process.env),
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch {
      throw new Error("codex_app_server_spawn_failed");
    }
    this.child = child;
    const onData = (chunk: Buffer | string) => this.consumeStdout(chunk);
    const onError = () => this.failConnection(new Error("codex_app_server_process_error"));
    const onClose = () => this.failConnection(new Error("codex_app_server_process_closed"));
    child.stdout.on("data", onData);
    child.stderr.on("data", () => {
      // stderr is intentionally not persisted or exposed.
    });
    child.stdin.on("error", onError);
    child.on("error", onError);
    child.once("close", onClose);

    const initialize = await this.request("initialize", {
      clientInfo: { name: "automation_os", title: "Automation OS", version: "0.1.0" },
      capabilities: {}
    });
    if (!initialize.result || initialize.error) throw new Error("codex_app_server_initialize_rejected");
    this.write({ method: "initialized", params: {} });
    this.initialized = true;
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const child = this.child;
    if (!child || this.closed) return Promise.reject(new Error("codex_app_server_unavailable"));
    const id = this.nextRequestId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method.replaceAll("/", "_")}_timeout`));
      }, boundedTimeout(this.options.timeoutMs));
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        void error;
        reject(new Error("codex_app_server_write_failed"));
      }
    });
  }

  private waitForCompletion(key: string): Promise<Record<string, unknown>> {
    const existing = this.recentCompletions.get(key);
    if (existing) {
      this.recentCompletions.delete(key);
      return Promise.resolve(existing);
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.completions.delete(key);
        reject(new Error("codex_app_server_turn_timeout"));
      }, boundedTimeout(this.options.timeoutMs));
      timer.unref?.();
      this.completions.set(key, { resolve, reject, timer });
    });
  }

  private write(message: Record<string, unknown>): void {
    const child = this.child;
    if (!child || this.closed) throw new Error("codex_app_server_unavailable");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private consumeStdout(chunk: Buffer | string): void {
    this.lineBuffer += String(chunk);
    if (Buffer.byteLength(this.lineBuffer, "utf8") > maxLineBytes) {
      this.failConnection(new Error("codex_app_server_protocol_line_too_large"));
      return;
    }
    while (true) {
      const newline = this.lineBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.lineBuffer.slice(0, newline).trim();
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        this.failConnection(new Error("codex_app_server_protocol_error"));
        return;
      }
      if (typeof message.method === "string" && typeof message.id === "number") this.handleServerRequest(message);
      else if (typeof message.id === "number") this.resolveResponse(message);
      else if (typeof message.method === "string") this.handleNotification(message);
    }
  }

  private resolveResponse(message: JsonRpcMessage): void {
    const pending = this.pending.get(message.id!);
    if (!pending) return;
    this.pending.delete(message.id!);
    clearTimeout(pending.timer);
    if (message.error) {
      pending.reject(new Error("codex_app_server_request_rejected"));
      return;
    }
    pending.resolve({ result: message.result, error: message.error });
  }

  private handleNotification(message: JsonRpcMessage): void {
    const params = message.params ?? {};
    const notificationTurnId = stringValue(params.turnId) ?? nestedString(params.turn, "id");
    const threadId = stringValue(params.threadId) ?? (notificationTurnId ? this.turnToThread.get(notificationTurnId) : undefined);
    const turnId = notificationTurnId;
    const itemId = stringValue(params.itemId) ?? nestedString(params.item, "id");
    const event: CodexAppServerEvent = {
      method: message.method!,
      ...(threadId ? { threadId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(itemId ? { itemId } : {}),
      ...(message.method === "item/agentMessage/delta" && stringValue(params.delta)
        ? { delta: redactSensitiveText(stringValue(params.delta)!).slice(0, 4_000) }
        : {}),
      ...(nestedString(params.turn, "status") ? { status: nestedString(params.turn, "status") } : {}),
      capturedAt: new Date().toISOString()
    };
    const key = threadId && turnId ? turnKey(threadId, turnId) : undefined;
    if (key) {
      const events = this.turnEvents.get(key) ?? [];
      events.push(event);
      this.turnEvents.set(key, events.slice(-maxEventsPerTurn));
      if (message.method === "item/agentMessage/delta" && event.delta) {
        this.turnText.set(key, `${this.turnText.get(key) ?? ""}${event.delta}`.slice(-24_000));
      }
      if (message.method === "item/completed") {
        const item = params.item;
        if (item && typeof item === "object" && nestedString(item as Record<string, unknown>, "type") === "agentMessage") {
          const finalText = nestedString(item as Record<string, unknown>, "text");
          if (finalText) this.turnText.set(key, redactSensitiveText(finalText).slice(-24_000));
        }
      }
      if (message.method === "turn/completed") {
        const waiter = this.completions.get(key);
        if (waiter) {
          this.completions.delete(key);
          clearTimeout(waiter.timer);
          waiter.resolve(params);
        } else {
          this.recentCompletions.set(key, params);
        }
      }
    }
    this.emitEvent(this.options.onEvent, event);
    if (key) this.emitEvent(this.turnListeners.get(key) ?? this.pendingTurnListeners.get(threadId ?? ""), event);
  }

  private emitEvent(listener: ((event: CodexAppServerEvent) => void) | undefined, event: CodexAppServerEvent): void {
    if (!listener) return;
    try {
      listener(event);
    } catch {
      // Progress observers must not break the worker-owned protocol stream.
    }
  }

  private handleServerRequest(message: JsonRpcMessage): void {
    // This client has no external-effect authority. Never approve or execute.
    try {
      this.write({ id: message.id, error: { code: -32000, message: "automation_os_approval_not_available" } });
    } catch {
      // The connection failure will reject the active turn.
    }
  }

  private failConnection(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.initialized = false;
    const child = this.child;
    this.child = null;
    this.rejectAll(error);
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        // The process is already gone or closing.
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    for (const [key, waiter] of this.completions) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
      this.completions.delete(key);
    }
  }
}

export function safeAppServerEnvironment(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH", "HOME", "CODEX_HOME", "CODEX_CLI_PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
    "USER", "LOGNAME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"
  ]);
  const output: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input)) {
    if (allowed.has(key) && typeof value === "string") output[key] = value;
  }
  output.AUTOMATION_OS_CODEX_APP_SERVER_CHILD = "1";
  return output;
}

export function selectAppServerCommand(
  options: { command?: string } = {},
  env: NodeJS.ProcessEnv = process.env
): string {
  return options.command?.trim()
    || env.AUTOMATION_OS_CODEX_APP_SERVER_COMMAND?.trim()
    || env.AUTOMATION_OS_CODEX_BIN?.trim()
    || env.CODEX_CLI_PATH?.trim()
    || "codex";
}

function boundedTimeout(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value <= 0) return defaultTimeoutMs;
  return Math.min(Math.floor(value), maxTimeoutMs);
}

function appServerCwd(value: string | undefined, workspaceRootValue: string | undefined): string {
  return resolveBoundedWorkspacePath(value, workspaceRootValue, {
    rootInvalid: "codex_app_server_workspace_root_invalid",
    pathInvalid: "codex_app_server_cwd_invalid",
    outside: "codex_app_server_cwd_outside_workspace"
  });
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nestedString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return stringValue((value as Record<string, unknown>)[key]);
}

function completionStatus(params: Record<string, unknown>): CodexAppServerTurnResult["status"] {
  const status = nestedString(params.turn, "status");
  if (status === "completed") return "completed";
  if (status === "interrupted") return "interrupted";
  if (status === "failed") return "failed";
  return "blocked";
}

function completionError(params: Record<string, unknown>): string | undefined {
  const error = params.turn && typeof params.turn === "object" ? (params.turn as Record<string, unknown>).error : undefined;
  if (!error || typeof error !== "object") return undefined;
  return "codex_app_server_turn_failed";
}

function parseStructuredText(text: string): Record<string, unknown> | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/iu, "").trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

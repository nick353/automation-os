import { spawn, spawnSync, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { resolveCodexBin } from "./codexBin.js";
import { CodexAppServerClient, type AppServerWebSocketFactory } from "./appServerClient.js";
import {
  codexAppServerRemotePromotionBlocker,
  getCodexAppServerConnectionReadback,
  hasCodexAppServerRemoteAuth,
  resolveCodexAppServerConnection
} from "./appServerConnection.js";

export type CodexAppServerProbeResult = {
  ok: boolean;
  status: "ok" | "blocked";
  generatedAt: string;
  timeoutMs: number;
  protocol: "stdio" | "websocket";
  endpoint?: string;
  platformFamily: string | null;
  platformOs: string | null;
  version: string | null;
  userAgent: string | null;
  platform: NodeJS.Platform;
  exactBlocker:
    | "disabled"
    | "command_unavailable"
    | "initialize_timeout"
    | "initialize_rejected"
    | "protocol_error"
    | "version_unavailable"
    | "codex_app_server_remote_url_invalid"
    | "codex_app_server_remote_tls_required"
    | "codex_app_server_remote_auth_missing"
    | "codex_app_server_remote_cwd_invalid"
    | "codex_app_server_remote_connect_failed"
    | "codex_app_server_remote_initialize_failed"
    | null;
  transportSupport: "supported_local_stdio" | "experimental_remote_websocket";
  productionRemoteCutoverAllowed: boolean | null;
  productionPromotionBlocker: string | null;
  initializedNotificationSent: boolean;
  threadStarted: false;
  turnStarted: false;
  externalActionExecuted: false;
};

export type CodexAppServerThreadTurnCanaryResult = {
  schema: "codex_app_server_thread_turn_canary.v1";
  ok: boolean;
  status: "ok" | "blocked";
  generatedAt: string;
  timeoutMs: number;
  protocol: "websocket";
  endpoint?: string;
  transportSupport: "experimental_remote_websocket";
  productionReady: false;
  productionRemoteCutoverAllowed: false;
  productionPromotionBlocker: string;
  initialized: boolean;
  accountRead: boolean;
  accountPresent: boolean | null;
  requiresOpenaiAuth: boolean | null;
  threadStarted: boolean;
  turnStarted: boolean;
  turnCompletionObserved: boolean;
  errorNotificationObserved: boolean;
  threadId?: string;
  turnId?: string;
  turnStatus?: string;
  eventMethods: string[];
  exactBlocker: string | null;
  externalActionExecuted: false;
};

type AppServerProbeRunner = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams | AppServerProbeChildLike;

type AppServerProbeChildLike = Pick<ChildProcessWithoutNullStreams, "stdin" | "stdout" | "stderr" | "kill" | "on" | "once" | "removeListener"> &
  Partial<Pick<ChildProcessWithoutNullStreams, "pid">>;

type ProbeCacheEntry = {
  expiresAt: number;
  result: CodexAppServerProbeResult;
};

type ProbeState = {
  stdoutChunks: Buffer[];
  stdoutBytes: number;
  closed: boolean;
  closeStatus: number | null;
  closeSignal: NodeJS.Signals | null;
  stdinBroken: boolean;
  spawned: boolean;
  timedOut: boolean;
};

const defaultTimeoutMs = 1500;
const maxTimeoutMs = 5000;
const defaultTtlMs = 30_000;
const maxTtlMs = 5 * 60 * 1000;
const maxOutputBytes = 64 * 1024;
const maxUserAgentLength = 256;

const probeCache = new Map<string, ProbeCacheEntry>();
const inflightProbes = new Map<string, Promise<CodexAppServerProbeResult>>();
const inflightCanaries = new Map<string, Promise<CodexAppServerThreadTurnCanaryResult>>();
const lastCanaryStartedAt = new Map<string, number>();
let latestProbeCache: ProbeCacheEntry | null = null;

export function clearAppServerProbeCache(): void {
  probeCache.clear();
  inflightProbes.clear();
  lastCanaryStartedAt.clear();
  latestProbeCache = null;
}

export function getLatestAppServerProbeSnapshot(now: number = Date.now()): CodexAppServerProbeResult | null {
  if (!latestProbeCache || latestProbeCache.expiresAt <= now) return null;
  return latestProbeCache.result;
}

/**
 * Runs one same-connection, read-only remote protocol canary. This is kept
 * separate from the inventory probe because it intentionally creates an
 * ephemeral thread and turn; it never uses local stdio and never permits
 * caller-supplied prompt text.
 */
export function runCodexAppServerThreadTurnCanary(options: {
  remoteUrl?: string;
  remoteToken?: string;
  remoteCwd?: string;
  timeoutMs?: number;
  cooldownMs?: number;
  webSocketFactory?: AppServerWebSocketFactory;
} = {}): Promise<CodexAppServerThreadTurnCanaryResult> {
  const readback = getCodexAppServerConnectionReadback({
    remoteUrl: options.remoteUrl,
    remoteToken: options.remoteToken,
    remoteCwd: options.remoteCwd
  });
  const key = JSON.stringify({ endpoint: readback.endpoint, remoteCwd: options.remoteCwd ?? null });
  const existing = inflightCanaries.get(key);
  if (existing) return existing;
  const promise = runCodexAppServerThreadTurnCanaryInternal(options).finally(() => {
    if (inflightCanaries.get(key) === promise) inflightCanaries.delete(key);
  });
  inflightCanaries.set(key, promise);
  return promise;
}

async function runCodexAppServerThreadTurnCanaryInternal(options: {
  remoteUrl?: string;
  remoteToken?: string;
  remoteCwd?: string;
  timeoutMs?: number;
  cooldownMs?: number;
  webSocketFactory?: AppServerWebSocketFactory;
}): Promise<CodexAppServerThreadTurnCanaryResult> {
  const generatedAt = new Date().toISOString();
  const timeoutMs = normalizeCanaryTimeoutMs(options.timeoutMs ?? Number(process.env.AUTOMATION_OS_CODEX_APP_SERVER_CANARY_TIMEOUT_MS ?? 60_000));
  const productionPromotionBlocker = codexAppServerRemotePromotionBlocker;
  let connection: ReturnType<typeof resolveCodexAppServerConnection>;
  try {
    connection = resolveCodexAppServerConnection({
      remoteUrl: options.remoteUrl,
      remoteToken: options.remoteToken,
      remoteCwd: options.remoteCwd
    });
  } catch (error) {
    return buildThreadTurnCanaryBlocked({
      generatedAt,
      timeoutMs,
      exactBlocker: threadTurnCanaryBlocker(error, "codex_app_server_remote_url_invalid"),
      endpoint: getCodexAppServerConnectionReadback({
        remoteUrl: options.remoteUrl,
        remoteToken: options.remoteToken,
        remoteCwd: options.remoteCwd
      }).endpoint,
      productionPromotionBlocker
    });
  }

  if (connection.mode !== "remote_websocket") {
    return buildThreadTurnCanaryBlocked({
      generatedAt,
      timeoutMs,
      exactBlocker: "codex_app_server_remote_required_for_thread_turn_canary",
      endpoint: getCodexAppServerConnectionReadback({
        remoteUrl: options.remoteUrl,
        remoteToken: options.remoteToken,
        remoteCwd: options.remoteCwd
      }).endpoint,
      productionPromotionBlocker
    });
  }

  const cooldownMs = normalizeCanaryCooldownMs(options.cooldownMs ?? Number(process.env.AUTOMATION_OS_CODEX_APP_SERVER_CANARY_COOLDOWN_MS ?? 10_000));
  const now = Date.now();
  const previousStart = lastCanaryStartedAt.get(connection.endpoint) ?? 0;
  if (previousStart > 0 && now - previousStart < cooldownMs) {
    return buildThreadTurnCanaryBlocked({
      generatedAt,
      timeoutMs,
      exactBlocker: "codex_app_server_canary_rate_limited",
      endpoint: getCodexAppServerConnectionReadback({
        remoteUrl: options.remoteUrl,
        remoteToken: options.remoteToken,
        remoteCwd: options.remoteCwd
      }).endpoint,
      productionPromotionBlocker
    });
  }
  lastCanaryStartedAt.set(connection.endpoint, now);

  const eventMethods: string[] = [];
  let threadId: string | undefined;
  let initialized = false;
  let accountRead = false;
  let accountPresent: boolean | null = null;
  let requiresOpenaiAuth: boolean | null = null;
  let threadStarted = false;
  let turnStarted = false;
  let errorNotificationObserved = false;
  const observeEvent = (event: { method: string }) => {
    if (event.method === "error") errorNotificationObserved = true;
    if (event.method === "thread/started") threadStarted = true;
    if (event.method === "turn/started") turnStarted = true;
    if (eventMethods.length < 64 && !eventMethods.includes(event.method)) eventMethods.push(event.method);
  };
  const client = new CodexAppServerClient({
    remoteUrl: options.remoteUrl,
    remoteToken: options.remoteToken,
    remoteCwd: options.remoteCwd,
    timeoutMs,
    webSocketFactory: options.webSocketFactory,
    onEvent: observeEvent
  });
  try {
    await client.start();
    initialized = true;
    const account = await client.readAccount();
    accountRead = true;
    accountPresent = account.accountPresent;
    requiresOpenaiAuth = account.requiresOpenaiAuth;
    if (!account.accountPresent) {
      return {
        ...buildThreadTurnCanaryBlocked({
          generatedAt,
          timeoutMs,
          exactBlocker: "codex_app_server_chatgpt_login_required",
          endpoint: getCodexAppServerConnectionReadback({
            remoteUrl: options.remoteUrl,
            remoteToken: options.remoteToken,
            remoteCwd: options.remoteCwd
          }).endpoint,
          productionPromotionBlocker
        }),
        initialized,
        accountRead,
        accountPresent,
        requiresOpenaiAuth,
        eventMethods
      };
    }
    // Keep the canary thread ephemeral so a technical probe does not create a
    // durable conversation in the remote App Server state store.
    threadId = await client.startOrResumeThread(undefined, { ephemeral: true });
    threadStarted = true;
    const turn = await client.startTurn({
      threadId,
      text: "Read-only protocol canary. Return a short readiness statement. Do not use tools, modify files, access external services, or perform any side effect.",
      onEvent: observeEvent
    });
    turnStarted = true;
    for (const event of turn.events) {
      if (eventMethods.length >= 64 || eventMethods.includes(event.method)) continue;
      eventMethods.push(event.method);
    }
    const turnCompletionObserved = eventMethods.includes("turn/completed");
    const completed = turn.status === "completed" && turnCompletionObserved;
    return {
      schema: "codex_app_server_thread_turn_canary.v1",
      ok: completed,
      status: completed ? "ok" : "blocked",
      generatedAt,
      timeoutMs,
      protocol: "websocket",
      endpoint: getCodexAppServerConnectionReadback({
        remoteUrl: options.remoteUrl,
        remoteToken: options.remoteToken,
        remoteCwd: options.remoteCwd
      }).endpoint,
      transportSupport: "experimental_remote_websocket",
      productionReady: false,
      productionRemoteCutoverAllowed: false,
      productionPromotionBlocker,
      initialized,
      accountRead,
      accountPresent,
      requiresOpenaiAuth,
      threadStarted,
      turnStarted,
      turnCompletionObserved,
      errorNotificationObserved,
      threadId,
      turnId: turn.turnId,
      turnStatus: turn.status,
      eventMethods,
      exactBlocker: completed ? null : turn.exactBlocker ?? "codex_app_server_turn_completion_not_verified",
      externalActionExecuted: false
    };
  } catch (error) {
    return {
      ...buildThreadTurnCanaryBlocked({
        generatedAt,
        timeoutMs,
        exactBlocker: threadTurnCanaryBlocker(error, "codex_app_server_remote_thread_turn_failed"),
        endpoint: getCodexAppServerConnectionReadback({
          remoteUrl: options.remoteUrl,
          remoteToken: options.remoteToken,
          remoteCwd: options.remoteCwd
        }).endpoint,
        productionPromotionBlocker
      }),
        initialized,
        accountRead,
        accountPresent,
        requiresOpenaiAuth,
        threadStarted,
      turnStarted,
      threadId,
      eventMethods,
      errorNotificationObserved
    };
  } finally {
    client.close();
  }
}

export async function probeCodexAppServerSurface(options: {
  enabled?: boolean;
  now?: () => number;
  timeoutMs?: number;
  ttlMs?: number;
  command?: string;
  args?: string[];
  remoteUrl?: string;
  remoteToken?: string;
  remoteCwd?: string;
  webSocketFactory?: AppServerWebSocketFactory;
  runner?: AppServerProbeRunner;
  forceRefresh?: boolean;
} = {}): Promise<CodexAppServerProbeResult> {
  const now = options.now ?? Date.now;
  const nowMs = now();
  const enabled = options.enabled ?? process.env.AUTOMATION_OS_CODEX_APP_SERVER_PROBE_ENABLED === "1";
  const timeoutMs = normalizeProbeTimeoutMs(options.timeoutMs ?? Number(process.env.AUTOMATION_OS_CODEX_APP_SERVER_PROBE_TIMEOUT_MS ?? defaultTimeoutMs));
  const ttlMs = normalizeProbeTtlMs(options.ttlMs ?? Number(process.env.AUTOMATION_OS_CODEX_APP_SERVER_PROBE_TTL_MS ?? defaultTtlMs));
  const command = options.command?.trim() || resolveCodexBin(["AUTOMATION_OS_CODEX_APP_SERVER_PROBE_COMMAND"]);
  const args = options.args ?? ["app-server", "--listen", "stdio://"];
  const remoteConfigured = options.remoteUrl?.trim() || process.env.AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_URL?.trim();
  const cacheKey = JSON.stringify({
    enabled,
    command,
    args,
    timeoutMs,
    ttlMs,
    remoteUrl: remoteConfigured || null,
    remoteAuthConfigured: Boolean(remoteConfigured) && hasCodexAppServerRemoteAuth({
      remoteToken: options.remoteToken
    }),
    remoteCwd: options.remoteCwd || process.env.AUTOMATION_OS_CODEX_APP_SERVER_REMOTE_CWD || null
  });

  if (!options.forceRefresh) {
    const cached = probeCache.get(cacheKey);
    if (cached && cached.expiresAt > nowMs) return cached.result;
    const inflight = inflightProbes.get(cacheKey);
    if (inflight) return inflight;
  }

  const probePromise = enabled
    ? remoteConfigured
      ? runRemoteProbe({
          timeoutMs,
          generatedAt: new Date(nowMs).toISOString(),
          remoteUrl: options.remoteUrl,
          remoteToken: options.remoteToken,
          remoteCwd: options.remoteCwd,
          webSocketFactory: options.webSocketFactory
        })
      : runProbe({ command, args, timeoutMs, runner: options.runner, generatedAt: new Date(nowMs).toISOString() })
    : Promise.resolve(
        buildBlockedResult({
          generatedAt: new Date(nowMs).toISOString(),
          timeoutMs,
          exactBlocker: "disabled"
        })
      );

  const wrapped = probePromise
    .then((result) => {
      const entry = { expiresAt: nowMs + ttlMs, result };
      probeCache.set(cacheKey, entry);
      latestProbeCache = entry;
      return result;
    })
    .finally(() => {
      inflightProbes.delete(cacheKey);
    });

  inflightProbes.set(cacheKey, wrapped);
  return wrapped;
}

async function runProbe(input: {
  command: string;
  args: string[];
  timeoutMs: number;
  runner?: AppServerProbeRunner;
  generatedAt: string;
}): Promise<CodexAppServerProbeResult> {
  if (!input.command) {
    return buildBlockedResult({
      generatedAt: input.generatedAt,
      timeoutMs: input.timeoutMs,
      exactBlocker: "command_unavailable"
    });
  }
  if (!commandExists(input.command)) {
    return buildBlockedResult({
      generatedAt: input.generatedAt,
      timeoutMs: input.timeoutMs,
      exactBlocker: "command_unavailable"
    });
  }

  const runner = input.runner ?? spawn;
  let child: ChildProcessWithoutNullStreams | AppServerProbeChildLike;
  try {
    child = runner(input.command, input.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: buildAppServerProbeEnv()
    });
  } catch {
    return buildBlockedResult({
      generatedAt: input.generatedAt,
      timeoutMs: input.timeoutMs,
      exactBlocker: "command_unavailable"
    });
  }

  const state: ProbeState = {
    stdoutChunks: [],
    stdoutBytes: 0,
    closed: false,
    closeStatus: null,
    closeSignal: null,
    stdinBroken: false,
    spawned: true,
    timedOut: false
  };

  return await new Promise<CodexAppServerProbeResult>((resolve) => {
    let settled = false;
    const cleanup = () => {
      child.stdout.removeListener("data", onStdout);
      child.stderr.removeListener("data", onStderr);
      child.stdin.removeListener("error", onStdinError);
      child.removeListener("close", onClose);
      child.removeListener("error", onChildError);
    };

    const finish = (result: CodexAppServerProbeResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      clearTimeout(timeoutHandle);
      resolve(result);
    };

    const onStdout = (chunk: Buffer | string) => {
      appendBounded(state, chunk);
      const parsed = parseInitializeResponse(readStdout(state));
      if (!parsed) return;
      if (parsed.error) {
        finish(
          buildBlockedResult({
            generatedAt: input.generatedAt,
            timeoutMs: input.timeoutMs,
            exactBlocker: "initialize_rejected"
          })
        );
        return;
      }
      if (!parsed.userAgent || !parsed.platformFamily || !parsed.platformOs) return;
      try {
        // Current Codex CLI keeps app-server alive after initialize. The probe
        // is inventory-only, so terminate the worker-owned child once the
        // initialize response itself has been verified.
        child.kill("SIGTERM");
      } catch {
        // The process may have exited between the response and cleanup.
      }
      finish({
        ok: true,
        status: "ok",
        generatedAt: input.generatedAt,
        timeoutMs: input.timeoutMs,
        protocol: "stdio",
        platformFamily: parsed.platformFamily,
        platformOs: parsed.platformOs,
        version: normalizeProbeField(parsed.version),
        userAgent: truncateProbeField(parsed.userAgent),
        platform: process.platform,
        exactBlocker: null,
        transportSupport: "supported_local_stdio",
        productionRemoteCutoverAllowed: null,
        productionPromotionBlocker: null,
        initializedNotificationSent: false,
        threadStarted: false,
        turnStarted: false,
        externalActionExecuted: false
      });
    };
    const onStderr = (_chunk: Buffer | string) => {
      // Intentionally ignore stderr to keep the probe secret-safe.
    };
    const onStdinError = (_error: NodeJS.ErrnoException) => {
      state.stdinBroken = true;
    };
    const onChildError = (_error: Error) => {
      if (state.closed) return;
      state.closed = true;
      finish(
        buildBlockedResult({
          generatedAt: input.generatedAt,
          timeoutMs: input.timeoutMs,
          exactBlocker: state.timedOut ? "initialize_timeout" : "initialize_rejected"
        })
      );
    };
    const onClose = (status: number | null, signal: NodeJS.Signals | null) => {
      state.closed = true;
      state.closeStatus = status;
      state.closeSignal = signal;
      const parsed = parseInitializeResponse(readStdout(state));
      if (state.timedOut) {
        finish(
          buildBlockedResult({
            generatedAt: input.generatedAt,
            timeoutMs: input.timeoutMs,
            exactBlocker: "initialize_timeout"
          })
        );
        return;
      }
      if (!parsed) {
        finish(
          buildBlockedResult({
            generatedAt: input.generatedAt,
            timeoutMs: input.timeoutMs,
            exactBlocker: status === 0 && signal === null ? "protocol_error" : "initialize_rejected"
          })
        );
        return;
      }
      if (parsed.error) {
        finish(
          buildBlockedResult({
            generatedAt: input.generatedAt,
            timeoutMs: input.timeoutMs,
            exactBlocker: "initialize_rejected"
          })
        );
        return;
      }
      if (!parsed.userAgent || !parsed.platformFamily || !parsed.platformOs) {
        finish(
          buildBlockedResult({
            generatedAt: input.generatedAt,
            timeoutMs: input.timeoutMs,
            exactBlocker: "protocol_error"
          })
        );
        return;
      }
      finish({
        ok: true,
        status: "ok",
        generatedAt: input.generatedAt,
        timeoutMs: input.timeoutMs,
        protocol: "stdio",
        platformFamily: parsed.platformFamily,
        platformOs: parsed.platformOs,
        version: normalizeProbeField(parsed.version),
        userAgent: truncateProbeField(parsed.userAgent),
        platform: process.platform,
        exactBlocker: null,
        transportSupport: "supported_local_stdio",
        productionRemoteCutoverAllowed: null,
        productionPromotionBlocker: null,
        initializedNotificationSent: false,
        threadStarted: false,
        turnStarted: false,
        externalActionExecuted: false
      });
    };

    const timeoutHandle = setTimeout(() => {
      state.timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 100).unref?.();
      finish(
        buildBlockedResult({
          generatedAt: input.generatedAt,
          timeoutMs: input.timeoutMs,
          exactBlocker: "initialize_timeout"
        })
      );
    }, input.timeoutMs);
    timeoutHandle.unref?.();

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.stdin.on("error", onStdinError);
    child.once("close", onClose);
    child.once("error", onChildError);

    const initializeRequest = JSON.stringify({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "automation_os",
          title: "Automation OS",
          version: "0.1.0"
        },
        capabilities: {}
      }
    });

    try {
      child.stdin.write(`${initializeRequest}\n`);
    } catch {
      state.stdinBroken = true;
    }
  });
}

async function runRemoteProbe(input: {
  timeoutMs: number;
  generatedAt: string;
  remoteUrl?: string;
  remoteToken?: string;
  remoteCwd?: string;
  webSocketFactory?: AppServerWebSocketFactory;
}): Promise<CodexAppServerProbeResult> {
  let connection: ReturnType<typeof resolveCodexAppServerConnection>;
  try {
    connection = resolveCodexAppServerConnection({
      remoteUrl: input.remoteUrl,
      remoteToken: input.remoteToken,
      remoteCwd: input.remoteCwd
    });
  } catch (error) {
    return buildBlockedResult({
      generatedAt: input.generatedAt,
      timeoutMs: input.timeoutMs,
      exactBlocker: remoteProbeBlocker(error, "codex_app_server_remote_url_invalid"),
      protocol: "websocket",
      endpoint: getCodexAppServerConnectionReadback({
        remoteUrl: input.remoteUrl,
        remoteToken: input.remoteToken,
        remoteCwd: input.remoteCwd
      }).endpoint
    });
  }
  if (connection.mode !== "remote_websocket") {
    return buildBlockedResult({
      generatedAt: input.generatedAt,
      timeoutMs: input.timeoutMs,
      exactBlocker: "codex_app_server_remote_url_invalid",
      protocol: "websocket",
      endpoint: "invalid://redacted"
    });
  }
  const client = new CodexAppServerClient({
    remoteUrl: input.remoteUrl,
    remoteToken: input.remoteToken,
    remoteCwd: input.remoteCwd,
    timeoutMs: input.timeoutMs,
    webSocketFactory: input.webSocketFactory
  });
  try {
    await client.start();
    return {
      ok: true,
      status: "ok",
      generatedAt: input.generatedAt,
      timeoutMs: input.timeoutMs,
      protocol: "websocket",
      endpoint: getCodexAppServerConnectionReadback({
        remoteUrl: input.remoteUrl,
        remoteToken: input.remoteToken,
        remoteCwd: input.remoteCwd
      }).endpoint,
      platformFamily: "remote",
      platformOs: "remote",
      version: null,
      userAgent: "Codex App Server remote websocket",
      platform: process.platform,
      exactBlocker: null,
      transportSupport: "experimental_remote_websocket",
      productionRemoteCutoverAllowed: false,
      productionPromotionBlocker: codexAppServerRemotePromotionBlocker,
      initializedNotificationSent: true,
      threadStarted: false,
      turnStarted: false,
      externalActionExecuted: false
    };
  } catch (error) {
    return buildBlockedResult({
      generatedAt: input.generatedAt,
      timeoutMs: input.timeoutMs,
      exactBlocker: remoteProbeBlocker(error, "codex_app_server_remote_initialize_failed"),
      protocol: "websocket",
      endpoint: getCodexAppServerConnectionReadback({
        remoteUrl: input.remoteUrl,
        remoteToken: input.remoteToken,
        remoteCwd: input.remoteCwd
      }).endpoint
    });
  } finally {
    client.close();
  }
}

function buildBlockedResult(input: {
  generatedAt: string;
  timeoutMs: number;
  exactBlocker: NonNullable<CodexAppServerProbeResult["exactBlocker"]>;
  protocol?: CodexAppServerProbeResult["protocol"];
  endpoint?: string;
}): CodexAppServerProbeResult {
  return {
    ok: false,
    status: "blocked",
    generatedAt: input.generatedAt,
    timeoutMs: input.timeoutMs,
    protocol: input.protocol ?? "stdio",
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    platformFamily: null,
    platformOs: null,
    version: null,
    userAgent: null,
    platform: process.platform,
    exactBlocker: input.exactBlocker,
    transportSupport: input.protocol === "websocket" ? "experimental_remote_websocket" : "supported_local_stdio",
    productionRemoteCutoverAllowed: input.protocol === "websocket" ? false : null,
    productionPromotionBlocker: input.protocol === "websocket" ? input.exactBlocker : null,
    initializedNotificationSent: false,
    threadStarted: false,
    turnStarted: false,
    externalActionExecuted: false
  };
}

function remoteProbeBlocker(
  error: unknown,
  fallback: Extract<NonNullable<CodexAppServerProbeResult["exactBlocker"]>, `codex_app_server_remote_${string}`>
): NonNullable<CodexAppServerProbeResult["exactBlocker"]> {
  const value = error instanceof Error ? error.message : "";
  if (value === "codex_app_server_remote_url_invalid") return value;
  if (value === "codex_app_server_remote_tls_required") return value;
  if (value === "codex_app_server_remote_auth_missing") return value;
  if (value === "codex_app_server_remote_cwd_invalid") return value;
  if (value === "codex_app_server_remote_connect_failed") return value;
  return fallback;
}

function buildThreadTurnCanaryBlocked(input: {
  generatedAt: string;
  timeoutMs: number;
  exactBlocker: string;
  endpoint?: string;
  productionPromotionBlocker: string;
}): CodexAppServerThreadTurnCanaryResult {
  return {
    schema: "codex_app_server_thread_turn_canary.v1",
    ok: false,
    status: "blocked",
    generatedAt: input.generatedAt,
    timeoutMs: input.timeoutMs,
    protocol: "websocket",
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    transportSupport: "experimental_remote_websocket",
    productionReady: false,
    productionRemoteCutoverAllowed: false,
    productionPromotionBlocker: input.productionPromotionBlocker,
    initialized: false,
    accountRead: false,
    accountPresent: null,
    requiresOpenaiAuth: null,
    threadStarted: false,
    turnStarted: false,
    turnCompletionObserved: false,
    errorNotificationObserved: false,
    eventMethods: [],
    exactBlocker: input.exactBlocker,
    externalActionExecuted: false
  };
}

function threadTurnCanaryBlocker(error: unknown, fallback: string): string {
  const value = error instanceof Error ? error.message : "";
  const known = new Set([
    "codex_app_server_remote_url_invalid",
    "codex_app_server_remote_tls_required",
    "codex_app_server_remote_auth_missing",
    "codex_app_server_remote_cwd_invalid",
    "codex_app_server_remote_connect_failed",
    "codex_app_server_remote_initialize_failed",
    "codex_app_server_initialize_rejected",
    "codex_app_server_thread_id_missing",
    "codex_app_server_turn_id_missing",
    "codex_app_server_turn_timeout",
    "codex_app_server_turn_failed",
    "codex_app_server_unavailable",
    "codex_app_server_closed"
  ]);
  return known.has(value) ? value : fallback;
}

function parseInitializeResponse(stdout: string): {
  userAgent: string | null;
  platformFamily: string | null;
  platformOs: string | null;
  version: string | null;
  error: boolean;
} | null {
  const text = stdout.trim();
  if (!text) return null;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const parsed = parseJsonRecord(line);
    if (!parsed) continue;
    if (!isInitializeResponseEnvelope(parsed)) continue;
    if (parsed.error !== undefined) {
      return { userAgent: null, platformFamily: null, platformOs: null, version: null, error: true };
    }
    const result = parsed.result && typeof parsed.result === "object" ? (parsed.result as Record<string, unknown>) : null;
    if (!result) continue;
    const userAgent = normalizeProbeField(result.userAgent);
    const platformFamily = normalizeProbeField(result.platformFamily);
    const platformOs = normalizeProbeField(result.platformOs);
    const version = normalizeProbeField(result.version);
    if (userAgent && platformFamily && platformOs) {
      return { userAgent, platformFamily, platformOs, version, error: false };
    }
  }
  return null;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isInitializeResponseEnvelope(parsed: Record<string, unknown>): boolean {
  if (parsed.id !== 1) return false;
  if ("method" in parsed) return false;
  const hasResult = Object.prototype.hasOwnProperty.call(parsed, "result");
  const hasError = Object.prototype.hasOwnProperty.call(parsed, "error");
  return hasResult !== hasError;
}

function appendBounded(state: ProbeState, chunk: Buffer | string): void {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (!buffer.length) return;
  const remainingBytes = maxOutputBytes - state.stdoutBytes;
  if (remainingBytes <= 0) return;
  const bounded = truncateUtf8Buffer(buffer, remainingBytes);
  if (!bounded.length) return;
  state.stdoutChunks.push(bounded);
  state.stdoutBytes += bounded.length;
}

function readStdout(state: ProbeState): string {
  return Buffer.concat(state.stdoutChunks, state.stdoutBytes).toString("utf8");
}

function normalizeProbeTimeoutMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return defaultTimeoutMs;
  return Math.min(Math.floor(value), maxTimeoutMs);
}

function normalizeProbeTtlMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return defaultTtlMs;
  return Math.min(Math.floor(value), maxTtlMs);
}

function normalizeCanaryTimeoutMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 60_000;
  return Math.min(Math.floor(value), 120_000);
}

function normalizeCanaryCooldownMs(value: number): number {
  if (!Number.isFinite(value)) return 10_000;
  return Math.min(Math.max(Math.trunc(value), 0), 5 * 60 * 1000);
}

function commandExists(command: string): boolean {
  const result = spawnSync("sh", ["-lc", `command -v ${shellEscape(command)}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildAppServerProbeEnv(): NodeJS.ProcessEnv {
  const allowedEnv = new Set(["PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "TERM", "USER", "LOGNAME", "PWD", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (allowedEnv.has(key) || key.startsWith("LC_")) {
      env[key] = value;
    }
  }
  return env;
}

function truncateProbeField(value: string): string {
  const sanitized = sanitizeProbeText(value);
  return sanitized.length > maxUserAgentLength ? sanitized.slice(0, maxUserAgentLength) : sanitized;
}

function normalizeProbeField(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const sanitized = truncateProbeField(value);
  return sanitized || null;
}

function sanitizeProbeText(value: string): string {
  const withoutControlChars = value.replace(/[\u0000-\u001f\u007f]+/g, " ");
  const redacted = withoutControlChars
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\b(?:api[_ -]?key|token|credential|password|secret)\b(?:\s*[:=]\s*|\s+)[^\s,;]+/gi, (match) => {
      const key = match.split(/[:=\s]/, 1)[0] ?? "secret";
      return `${key} [redacted]`;
    });
  return redacted.replace(/\s+/g, " ").trim();
}

function truncateUtf8Buffer(buffer: Buffer, maxBytes: number): Buffer {
  if (buffer.length <= maxBytes) return buffer;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let length = maxBytes; length > 0; length -= 1) {
    try {
      decoder.decode(buffer.subarray(0, length));
      return buffer.subarray(0, length);
    } catch {
      // keep backing up until the slice is valid UTF-8
    }
  }
  return Buffer.alloc(0);
}

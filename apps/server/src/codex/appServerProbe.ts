import { spawn, spawnSync, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";

export type CodexAppServerProbeResult = {
  ok: boolean;
  status: "ok" | "blocked";
  generatedAt: string;
  timeoutMs: number;
  protocol: "stdio";
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
    | null;
  initializedNotificationSent: false;
  threadStarted: false;
  turnStarted: false;
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
let latestProbeCache: ProbeCacheEntry | null = null;

export function clearAppServerProbeCache(): void {
  probeCache.clear();
  inflightProbes.clear();
  latestProbeCache = null;
}

export function getLatestAppServerProbeSnapshot(now: number = Date.now()): CodexAppServerProbeResult | null {
  if (!latestProbeCache || latestProbeCache.expiresAt <= now) return null;
  return latestProbeCache.result;
}

export async function probeCodexAppServerSurface(options: {
  enabled?: boolean;
  now?: () => number;
  timeoutMs?: number;
  ttlMs?: number;
  command?: string;
  args?: string[];
  runner?: AppServerProbeRunner;
  forceRefresh?: boolean;
} = {}): Promise<CodexAppServerProbeResult> {
  const now = options.now ?? Date.now;
  const nowMs = now();
  const enabled = options.enabled ?? process.env.AUTOMATION_OS_CODEX_APP_SERVER_PROBE_ENABLED === "1";
  const timeoutMs = normalizeProbeTimeoutMs(options.timeoutMs ?? Number(process.env.AUTOMATION_OS_CODEX_APP_SERVER_PROBE_TIMEOUT_MS ?? defaultTimeoutMs));
  const ttlMs = normalizeProbeTtlMs(options.ttlMs ?? Number(process.env.AUTOMATION_OS_CODEX_APP_SERVER_PROBE_TTL_MS ?? defaultTtlMs));
  const command = (options.command ?? process.env.AUTOMATION_OS_CODEX_APP_SERVER_PROBE_COMMAND ?? "codex").trim();
  const args = options.args ?? ["app-server", "--listen", "stdio://"];
  const cacheKey = JSON.stringify({ enabled, command, args, timeoutMs, ttlMs });

  if (!options.forceRefresh) {
    const cached = probeCache.get(cacheKey);
    if (cached && cached.expiresAt > nowMs) return cached.result;
    const inflight = inflightProbes.get(cacheKey);
    if (inflight) return inflight;
  }

  const probePromise = enabled
    ? runProbe({ command, args, timeoutMs, runner: options.runner, generatedAt: new Date(nowMs).toISOString() })
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
      child.stdin.end();
    } catch {
      state.stdinBroken = true;
    }
  });
}

function buildBlockedResult(input: {
  generatedAt: string;
  timeoutMs: number;
  exactBlocker: NonNullable<CodexAppServerProbeResult["exactBlocker"]>;
}): CodexAppServerProbeResult {
  return {
    ok: false,
    status: "blocked",
    generatedAt: input.generatedAt,
    timeoutMs: input.timeoutMs,
    protocol: "stdio",
    platformFamily: null,
    platformOs: null,
    version: null,
    userAgent: null,
    platform: process.platform,
    exactBlocker: input.exactBlocker,
    initializedNotificationSent: false,
    threadStarted: false,
    turnStarted: false,
    externalActionExecuted: false
  };
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

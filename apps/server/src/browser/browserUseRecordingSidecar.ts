import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveBuiltInBrowserUseScript } from "./browserUseBuiltIns.js";
import { readStoredSecretByKind } from "../secrets/secretStore.js";

type CliOptions = {
  manifestPath: string;
  recordingPath: string;
  geminiQaPath: string;
  targetUrl: string;
  session: string;
  cdpUrl: string;
  profile?: string;
  durationMs: number;
  geminiRunner?: string;
};

type CdpTarget = {
  id?: string;
  type?: string;
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
};

const defaultDurationMs = 3500;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(dirname(options.recordingPath), { recursive: true });
  const frameDir = join(dirname(options.recordingPath), "recording-frames");
  mkdirSync(frameDir, { recursive: true });

  const manifest = readManifest(options.manifestPath);
  writeSidecarManifest(options.manifestPath, {
    ...manifest,
    recordingSidecar: {
      status: "running",
      driver: "cdp_screencast_recorder",
      session: options.session,
      cdpUrl: options.cdpUrl,
      targetUrl: options.targetUrl,
      recordingPath: options.recordingPath,
      geminiQaPath: options.geminiQaPath,
      startedAt: new Date().toISOString()
    }
  });

  try {
    const target = await findCdpTarget(options.cdpUrl, options.targetUrl);
    if (!target.webSocketDebuggerUrl) throw new Error("browser_use_recording_cdp_target_missing_websocket");

    const frames = await captureScreencastFrames({
      wsUrl: target.webSocketDebuggerUrl,
      frameDir,
      durationMs: options.durationMs
    });
    if (frames.length === 0) throw new Error("browser_use_recording_no_frames_captured");

    encodeRecording({ frameDir, recordingPath: options.recordingPath });
    if (!existsNonEmptyFile(options.recordingPath)) throw new Error("browser_use_recording_video_missing_after_encode");

    const qaOk = runGeminiQaRunner(options);
    writeSidecarManifest(options.manifestPath, {
      ...readManifest(options.manifestPath),
      recordingSidecar: {
        status: qaOk ? "ok" : "blocked",
        reason: qaOk ? "browser_use_recording_sidecar_completed" : "browser_use_gemini_video_qa_runner_missing_or_failed",
        driver: "cdp_screencast_recorder",
        session: options.session,
        cdpUrl: options.cdpUrl,
        targetUrl: options.targetUrl,
        targetId: target.id ?? null,
        targetTitle: target.title ?? null,
        targetPageUrl: target.url ?? null,
        recordingPath: options.recordingPath,
        recordingUri: pathToFileURL(options.recordingPath).href,
        geminiQaPath: options.geminiQaPath,
        geminiQaUri: existsSync(options.geminiQaPath) ? pathToFileURL(options.geminiQaPath).href : null,
        frameCount: frames.length,
        completedAt: new Date().toISOString(),
        exactBlocker: qaOk ? null : "browser_use_gemini_video_qa_runner_missing_or_failed"
      }
    });
    if (!qaOk) process.exit(2);
  } catch (error) {
    const blocker = error instanceof CdpDiscoveryError ? error.blocker : error instanceof Error ? error.message : "browser_use_recording_sidecar_failed";
    writeSidecarManifest(options.manifestPath, {
      ...readManifest(options.manifestPath),
      recordingSidecar: {
        status: "blocked",
        reason: blocker,
        driver: "cdp_screencast_recorder",
        session: options.session,
        cdpUrl: options.cdpUrl,
        targetUrl: options.targetUrl,
        recordingPath: options.recordingPath,
        geminiQaPath: options.geminiQaPath,
        completedAt: new Date().toISOString(),
        exactBlocker: blocker,
        attemptCount: error instanceof CdpDiscoveryError ? error.attemptCount : null,
        lastError: error instanceof CdpDiscoveryError ? error.lastError : error instanceof Error ? error.message : String(error)
      }
    });
    throw error;
  }
}

function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing_value_for_${arg.slice(2)}`);
    values.set(arg, value);
    index += 1;
  }
  const required = (key: string): string => {
    const value = values.get(`--${key}`)?.trim();
    if (!value) throw new Error(`missing_required_arg_${key}`);
    return value;
  };
  return {
    manifestPath: resolve(required("manifest")),
    recordingPath: resolve(required("recording")),
    geminiQaPath: resolve(required("gemini-qa")),
    targetUrl: required("target-url"),
    session: required("session"),
    cdpUrl: required("cdp-url"),
    profile: values.get("--profile"),
    durationMs: positiveInt(process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_DURATION_MS, defaultDurationMs),
    geminiRunner:
      firstNonEmpty(values.get("--gemini-runner")) ?? firstNonEmpty(process.env.AUTOMATION_OS_BROWSER_USE_GEMINI_QA_RUNNER) ?? builtInGeminiRunnerPath()
  };
}

export async function findCdpTarget(cdpUrl: string, targetUrl: string): Promise<CdpTarget> {
  await fetchCdpJsonWithRetry(new URL("/json/version", ensureTrailingSlash(cdpUrl)).toString(), "browser_use_recording_cdp_version_unavailable");
  const targets = (await fetchCdpJsonWithRetry(
    new URL("/json/list", ensureTrailingSlash(cdpUrl)).toString(),
    "browser_use_recording_cdp_targets_unavailable"
  )) as unknown;
  if (!Array.isArray(targets)) throw new CdpDiscoveryError("browser_use_recording_cdp_targets_invalid", 1, "CDP /json/list did not return an array");
  const pages = targets.filter((target): target is CdpTarget => isRecord(target) && target.type === "page");
  const expected = new URL(targetUrl);
  const matching = pages.find((target) => {
    if (!target.url) return false;
    try {
      const actual = new URL(target.url);
      return actual.origin === expected.origin && actual.pathname === expected.pathname && actual.search === expected.search && actual.hash === expected.hash;
    } catch {
      return false;
    }
  });
  const target = matching;
  if (!target) throw new Error("browser_use_recording_cdp_target_mismatch");
  if (!target.webSocketDebuggerUrl) throw new Error("browser_use_recording_cdp_target_missing_websocket");
  return target;
}

class CdpDiscoveryError extends Error {
  constructor(
    readonly blocker: string,
    readonly attemptCount: number,
    readonly lastError: string
  ) {
    super(`${blocker}: attempts=${attemptCount}; last_error=${lastError}`);
  }
}

async function fetchCdpJsonWithRetry(url: string, blocker: string): Promise<unknown> {
  const maxAttempts = positiveInt(process.env.AUTOMATION_OS_BROWSER_USE_CDP_RETRY_ATTEMPTS, 4);
  const backoffMs = positiveInt(process.env.AUTOMATION_OS_BROWSER_USE_CDP_RETRY_BACKOFF_MS, 150);
  let lastError = "not_attempted";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fetchJson(url);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < maxAttempts) await delay(backoffMs * attempt);
    }
  }
  throw new CdpDiscoveryError(blocker, maxAttempts, lastError);
}

async function captureScreencastFrames(input: { wsUrl: string; frameDir: string; durationMs: number }): Promise<string[]> {
  const transport = await CdpWebSocketTransport.connect(input.wsUrl);
  const frames: string[] = [];
  transport.on("Page.screencastFrame", (params) => {
    if (!isRecord(params) || typeof params.data !== "string") return;
    const sessionId = typeof params.sessionId === "number" ? params.sessionId : undefined;
    const framePath = join(input.frameDir, `frame-${String(frames.length + 1).padStart(5, "0")}.jpg`);
    writeFileSync(framePath, Buffer.from(params.data, "base64"));
    frames.push(framePath);
    if (sessionId !== undefined) void transport.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
  });
  try {
    await transport.send("Page.enable");
    await transport.send("Page.startScreencast", { format: "jpeg", quality: 80, everyNthFrame: 1 });
    await delay(input.durationMs);
    await transport.send("Page.stopScreencast").catch(() => undefined);
    if (frames.length === 0) {
      const screenshot = await transport.send("Page.captureScreenshot", { format: "jpeg", quality: 80 });
      const data = extractScreenshotData(screenshot);
      if (data) {
        const framePath = join(input.frameDir, "frame-00001.jpg");
        writeFileSync(framePath, Buffer.from(data, "base64"));
        frames.push(framePath);
      }
    }
  } finally {
    await transport.close().catch(() => undefined);
  }
  return frames;
}

function encodeRecording(input: { frameDir: string; recordingPath: string }): void {
  const frames = readdirSync(input.frameDir).filter((name) => /^frame-\d+\.jpg$/.test(name));
  if (frames.length === 0) throw new Error("browser_use_recording_no_frames_for_encode");
  const attempts = [
    ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"],
    ["-c:v", "h264_videotoolbox", "-pix_fmt", "yuv420p", "-movflags", "+faststart"],
    ["-c:v", "mpeg4", "-pix_fmt", "yuv420p"]
  ];
  const errors: string[] = [];
  for (const codecArgs of attempts) {
    const ffmpeg = spawnSync(
      "ffmpeg",
      ["-y", "-hide_banner", "-loglevel", "error", "-framerate", "4", "-i", join(input.frameDir, "frame-%05d.jpg"), ...codecArgs, input.recordingPath],
      { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
    );
    if (ffmpeg.status === 0 && existsNonEmptyFile(input.recordingPath)) return;
    errors.push(ffmpeg.stderr || ffmpeg.stdout || String(ffmpeg.status));
  }
  throw new Error(`browser_use_recording_ffmpeg_failed: ${errors.join("\n--- fallback ---\n")}`);
}

function runGeminiQaRunner(options: CliOptions): boolean {
  if (!options.geminiRunner) {
    writeBlockedGeminiQa(options, "browser_use_gemini_video_qa_runner_missing");
    return false;
  }
  const result = spawnSync(
    options.geminiRunner,
    ["--video", options.recordingPath, "--output", options.geminiQaPath, "--manifest", options.manifestPath, "--target-url", options.targetUrl],
    {
      encoding: "utf8",
      env: geminiRunnerEnv(),
      maxBuffer: 20 * 1024 * 1024,
      timeout: positiveInt(process.env.AUTOMATION_OS_BROWSER_USE_GEMINI_QA_TIMEOUT_MS, 120000)
    }
  );
  if (result.status !== 0 || !existsNonEmptyFile(options.geminiQaPath)) {
    writeBlockedGeminiQa(options, "browser_use_gemini_video_qa_runner_failed", { stdout: tail(result.stdout), stderr: tail(result.stderr), exitStatus: result.status });
    return false;
  }
  return true;
}

function geminiRunnerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (env.GEMINI_API_KEY && env.GEMINI_API_KEY.trim()) return env;
  try {
    const stored = readStoredSecretByKind("gemini");
    if (stored && stored.trim()) env.GEMINI_API_KEY = stored.trim();
  } catch {
    // Keep the runner fail-closed; the blocker is written by the QA runner.
  }
  return env;
}

function writeBlockedGeminiQa(options: CliOptions, blocker: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    options.geminiQaPath,
    `${JSON.stringify(
      {
        provider: "gemini",
        kind: "gemini_video_qa",
        status: "blocked",
        verdict: "blocked",
        completion_gate_alignment: "blocked",
        completion_gate_matches: false,
        exact_blocker: blocker,
        video_artifact_uri: options.recordingPath,
        target_url: options.targetUrl,
        ...extra
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

class CdpWebSocketTransport {
  private id = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private listeners = new Map<string, Array<(params: unknown) => void>>();

  private constructor(private readonly socket: WebSocketLike) {}

  static connect(url: string): Promise<CdpWebSocketTransport> {
    const WebSocketCtor = globalThis.WebSocket as WebSocketConstructor | undefined;
    if (!WebSocketCtor) return Promise.reject(new Error("browser_use_recording_websocket_unavailable"));
    return new Promise((resolveConnect, rejectConnect) => {
      const socket = new WebSocketCtor(url) as WebSocketLike;
      const transport = new CdpWebSocketTransport(socket);
      socket.addEventListener("open", () => resolveConnect(transport), { once: true });
      socket.addEventListener("error", () => rejectConnect(new Error("browser_use_recording_websocket_connect_failed")), { once: true });
      socket.addEventListener("message", (event) => transport.onMessage(event));
      socket.addEventListener("close", () => transport.rejectAll(new Error("browser_use_recording_websocket_closed")));
    });
  }

  on(method: string, listener: (params: unknown) => void): void {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.id;
    const message = JSON.stringify({ id, method, params });
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
      this.socket.send(message);
    });
  }

  async close(): Promise<void> {
    this.rejectAll(new Error("browser_use_recording_websocket_closed"));
    this.socket.close();
  }

  private onMessage(event: { data: unknown }): void {
    const text = typeof event.data === "string" ? event.data : Buffer.isBuffer(event.data) ? event.data.toString("utf8") : "";
    if (!text) return;
    const message = JSON.parse(text) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
    if (message.method) {
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message ?? "cdp_error"));
    else pending.resolve({ result: message.result });
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`browser_use_recording_cdp_http_${response.status}`);
  return response.json();
}

function extractScreenshotData(envelope: unknown): string | null {
  if (!isRecord(envelope) || !isRecord(envelope.result) || typeof envelope.result.data !== "string") return null;
  return envelope.result.data;
}

function readManifest(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeSidecarManifest(path: string, value: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function existsNonEmptyFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile() && statSync(path).size > 0;
  } catch {
    return false;
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function firstNonEmpty(value: string | undefined): string | undefined {
  return value && value.trim() ? value.trim() : undefined;
}

function builtInGeminiRunnerPath(): string | undefined {
  return resolveBuiltInBrowserUseScript("geminiVideoQaRunner.js");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function tail(value: string | Buffer | null | undefined): string {
  return String(value ?? "").slice(-2000);
}

type WebSocketConstructor = new (url: string) => WebSocketLike;
type WebSocketLike = {
  send(message: string): void;
  close(): void;
  addEventListener(type: "open" | "error" | "close", listener: () => void, options?: { once?: boolean }): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

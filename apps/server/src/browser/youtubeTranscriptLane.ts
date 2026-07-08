import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { registeredBrowserLaneForWorkflow } from "../runs/laneManager.js";

const registeredLane = registeredBrowserLaneForWorkflow("youtube-visible-transcript-capture");

export const youtubeTranscriptLane = {
  name: "youtube_visible_transcript_cdp",
  port: registeredLane?.cdpPort ?? 9337,
  profileDir: registeredLane?.profileDir ?? "/Users/nichikatanaka/.youtube-transcript-playwright-chrome",
  profileDirectory: "Default",
  homeUrl: "https://www.youtube.com/",
  versionUrl: `http://127.0.0.1:${registeredLane?.cdpPort ?? 9337}/json/version`
} as const;

const defaultChromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const healthCheckTimeoutMs = 2000;

export type YouTubeTranscriptChromeCommand = {
  bin: string;
  args: string[];
  laneName: string;
  port: number;
  profileDir: string;
};

export type YouTubeTranscriptChromeOpenResult = YouTubeTranscriptChromeCommand & {
  ok: boolean;
  pid?: number;
  url: string;
  exactBlocker?: string;
  summary: string;
};

export type YouTubeTranscriptChromeHealthResult =
  | {
      ok: true;
      laneName: typeof youtubeTranscriptLane.name;
      port: typeof youtubeTranscriptLane.port;
      profileDir: typeof youtubeTranscriptLane.profileDir;
      endpoint: typeof youtubeTranscriptLane.versionUrl;
      browser?: string;
      webSocketDebuggerUrl?: string;
      raw: Record<string, unknown>;
    }
  | {
      ok: false;
      laneName: typeof youtubeTranscriptLane.name;
      port: typeof youtubeTranscriptLane.port;
      profileDir: typeof youtubeTranscriptLane.profileDir;
      endpoint: typeof youtubeTranscriptLane.versionUrl;
      exactBlocker: string;
      summary: string;
    };

export type YouTubeTranscriptChromeEnsureResult =
  | {
      ok: true;
      laneName: typeof youtubeTranscriptLane.name;
      port: typeof youtubeTranscriptLane.port;
      profileDir: typeof youtubeTranscriptLane.profileDir;
      health: Extract<YouTubeTranscriptChromeHealthResult, { ok: true }>;
      opened?: YouTubeTranscriptChromeOpenResult;
      attempts: number;
    }
  | {
      ok: false;
      laneName: typeof youtubeTranscriptLane.name;
      port: typeof youtubeTranscriptLane.port;
      profileDir: typeof youtubeTranscriptLane.profileDir;
      exactBlocker: string;
      summary: string;
      opened?: YouTubeTranscriptChromeOpenResult;
      attempts: number;
    };

export function buildOpenYouTubeTranscriptChromeCommand(
  chromePath = process.env.AUTOMATION_OS_YOUTUBE_TRANSCRIPT_CHROME_BIN || defaultChromePath
): YouTubeTranscriptChromeCommand {
  return {
    bin: chromePath,
    args: [
      `--remote-debugging-port=${youtubeTranscriptLane.port}`,
      `--user-data-dir=${youtubeTranscriptLane.profileDir}`,
      `--profile-directory=${youtubeTranscriptLane.profileDirectory}`,
      youtubeTranscriptLane.homeUrl
    ],
    laneName: youtubeTranscriptLane.name,
    port: youtubeTranscriptLane.port,
    profileDir: youtubeTranscriptLane.profileDir
  };
}

export async function openYouTubeTranscriptChrome(): Promise<YouTubeTranscriptChromeOpenResult> {
  mkdirSync(youtubeTranscriptLane.profileDir, { recursive: true });
  const command = buildOpenYouTubeTranscriptChromeCommand();
  const child = spawn(command.bin, command.args, {
    detached: true,
    stdio: "ignore"
  });
  const spawnError = await observeSpawnError(child, 300);
  if (spawnError) {
    return {
      ok: false,
      ...command,
      url: youtubeTranscriptLane.homeUrl,
      exactBlocker: "youtube_transcript_cdp_open_failed",
      summary: spawnError.message
    };
  }
  child.unref();
  return {
    ok: true,
    ...command,
    pid: child.pid,
    url: youtubeTranscriptLane.homeUrl,
    summary: "Opened the fixed YouTube visible transcript CDP lane without fallback."
  };
}

export async function getYouTubeTranscriptChromeHealth(fetchImpl: typeof fetch = fetch): Promise<YouTubeTranscriptChromeHealthResult> {
  try {
    const response = await withTimeout(fetchImpl(youtubeTranscriptLane.versionUrl), "youtube_transcript_cdp_health_timeout", healthCheckTimeoutMs);
    if (!response.ok) {
      return blocked(`youtube_transcript_cdp_http_${response.status}`, `CDP version endpoint returned HTTP ${response.status}`);
    }
    const raw = await withTimeout(response.json() as Promise<Record<string, unknown>>, "youtube_transcript_cdp_health_timeout", healthCheckTimeoutMs);
    return {
      ok: true,
      laneName: youtubeTranscriptLane.name,
      port: youtubeTranscriptLane.port,
      profileDir: youtubeTranscriptLane.profileDir,
      endpoint: youtubeTranscriptLane.versionUrl,
      browser: typeof raw.Browser === "string" ? raw.Browser : undefined,
      webSocketDebuggerUrl: typeof raw.webSocketDebuggerUrl === "string" ? raw.webSocketDebuggerUrl : undefined,
      raw
    };
  } catch (error) {
    return blocked(
      "youtube_transcript_cdp_unavailable",
      error instanceof Error ? error.message : "CDP version endpoint is unavailable"
    );
  }
}

export async function ensureYouTubeTranscriptChromeReady(options: {
  fetchImpl?: typeof fetch;
  openImpl?: () => YouTubeTranscriptChromeOpenResult | Promise<YouTubeTranscriptChromeOpenResult>;
  attempts?: number;
  delayMs?: number;
  delayImpl?: (ms: number) => Promise<void>;
} = {}): Promise<YouTubeTranscriptChromeEnsureResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const openImpl = options.openImpl ?? openYouTubeTranscriptChrome;
  const attempts = Math.max(1, options.attempts ?? 10);
  const delayMs = Math.max(0, options.delayMs ?? 500);
  const delayImpl = options.delayImpl ?? delay;

  const initialHealth = await getYouTubeTranscriptChromeHealth(fetchImpl);
  if (initialHealth.ok) return ready(initialHealth, 1);

  let opened: YouTubeTranscriptChromeOpenResult | undefined;
  try {
    opened = await openImpl();
  } catch (error) {
    return ensureBlocked(
      "youtube_transcript_cdp_open_failed",
      error instanceof Error ? error.message : "Failed to open YouTube transcript CDP lane",
      1
    );
  }
  if (!opened.ok) {
    return ensureBlocked(opened.exactBlocker ?? "youtube_transcript_cdp_open_failed", opened.summary, 1, opened);
  }

  let lastHealth: YouTubeTranscriptChromeHealthResult = initialHealth;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (delayMs > 0) await delayImpl(delayMs);
    lastHealth = await getYouTubeTranscriptChromeHealth(fetchImpl);
    if (lastHealth.ok) return ready(lastHealth, attempt + 1, opened);
  }

  return ensureBlocked(
    lastHealth.exactBlocker,
    `YouTube transcript CDP lane did not become ready after opening: ${lastHealth.summary}`,
    attempts + 1,
    opened
  );
}

function blocked(exactBlocker: string, summary: string): YouTubeTranscriptChromeHealthResult {
  return {
    ok: false,
    laneName: youtubeTranscriptLane.name,
    port: youtubeTranscriptLane.port,
    profileDir: youtubeTranscriptLane.profileDir,
    endpoint: youtubeTranscriptLane.versionUrl,
    exactBlocker,
    summary
  };
}

function ready(
  health: Extract<YouTubeTranscriptChromeHealthResult, { ok: true }>,
  attempts: number,
  opened?: YouTubeTranscriptChromeOpenResult
): Extract<YouTubeTranscriptChromeEnsureResult, { ok: true }> {
  return {
    ok: true,
    laneName: youtubeTranscriptLane.name,
    port: youtubeTranscriptLane.port,
    profileDir: youtubeTranscriptLane.profileDir,
    health,
    ...(opened ? { opened } : {}),
    attempts
  };
}

function ensureBlocked(
  exactBlocker: string,
  summary: string,
  attempts: number,
  opened?: YouTubeTranscriptChromeOpenResult
): Extract<YouTubeTranscriptChromeEnsureResult, { ok: false }> {
  return {
    ok: false,
    laneName: youtubeTranscriptLane.name,
    port: youtubeTranscriptLane.port,
    profileDir: youtubeTranscriptLane.profileDir,
    exactBlocker,
    summary,
    ...(opened ? { opened } : {}),
    attempts
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function withTimeout<T>(promise: Promise<T>, exactBlocker: string, timeoutMs: number): Promise<T> {
  return new Promise((resolveTimeout, rejectTimeout) => {
    const timer = setTimeout(() => rejectTimeout(new Error(exactBlocker)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveTimeout(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectTimeout(error);
      }
    );
  });
}

function observeSpawnError(child: ChildProcess, timeoutMs: number): Promise<Error | undefined> {
  return new Promise((resolveObserve) => {
    const timer = setTimeout(() => {
      child.off("error", onError);
      resolveObserve(undefined);
    }, timeoutMs);
    const onError = (error: Error) => {
      clearTimeout(timer);
      resolveObserve(error);
    };
    child.once("error", onError);
  });
}

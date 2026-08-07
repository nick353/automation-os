import { registeredBrowserLaneForWorkflow } from "../runs/laneManager.js";
import { getBrowserHealth } from "./health.js";

const registeredLane = registeredBrowserLaneForWorkflow("youtube-visible-transcript-capture");

export const youtubeTranscriptLane = {
  name: "youtube_visible_transcript_browser_use_cli",
  port: registeredLane?.cdpPort ?? 9337,
  profileDir: registeredLane?.profileDir ?? "[fresh-browser-use-profile-required]",
  homeUrl: "https://www.youtube.com/",
  versionUrl: "browser-use-cli://youtube/transcript-session"
} as const;

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
  _ignoredLegacyChromePath?: string
): YouTubeTranscriptChromeCommand {
  const command = getBrowserHealth().browserUseCli.command || "/Users/nichikatanaka/.local/bin/codex-browser-use";
  return {
    bin: command,
    args: [
      "--session",
      "aos-youtube-transcript",
      "open",
      youtubeTranscriptLane.homeUrl
    ],
    laneName: youtubeTranscriptLane.name,
    port: youtubeTranscriptLane.port,
    profileDir: youtubeTranscriptLane.profileDir
  };
}

export async function openYouTubeTranscriptChrome(): Promise<YouTubeTranscriptChromeOpenResult> {
  const command = buildOpenYouTubeTranscriptChromeCommand();
  return {
    ok: false,
    ...command,
    url: youtubeTranscriptLane.homeUrl,
    exactBlocker: getBrowserHealth().browserUseCli.available ? "browser_use_authority_required" : "browser_use_cli_missing",
    summary: "YouTube transcriptはcanonical Browser Use CLIのfresh authority/sessionからのみ実行します。Chrome/CDPの直接起動はしません。"
  };
}

export async function getYouTubeTranscriptChromeHealth(fetchImpl: typeof fetch = fetch): Promise<YouTubeTranscriptChromeHealthResult> {
  void fetchImpl;
  const browserUse = getBrowserHealth().browserUseCli;
  return blocked(
    browserUse.available ? "browser_use_authority_required" : "browser_use_cli_missing",
    browserUse.available
      ? "Browser Use CLIはfresh authority/profile/portとsame-session readbackが必要です。"
      : "Canonical Browser Use CLI helper is unavailable."
  );
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

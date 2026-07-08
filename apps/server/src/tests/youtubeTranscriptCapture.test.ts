import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { YouTubeTranscriptCdpClient } from "../obsidian/youtubeTranscriptCapture.js";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-youtube-transcript-"));
process.env.AUTOMATION_OS_OBSIDIAN_AUTO_EXPORT = "0";
process.env.NODE_TEST_CONTEXT = "1";
const previousAllowCustomVault = process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = "1";

test.after(() => {
  if (previousAllowCustomVault === undefined) delete process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT;
  else process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT = previousAllowCustomVault;
});

const {
  runYouTubeTranscriptCapture,
  validateYouTubeTranscriptUrl,
  transcriptRevealExpression,
  transcriptExtractionExpression
} = await import("../obsidian/youtubeTranscriptCapture.js");
const {
  ensureYouTubeTranscriptChromeReady,
  getYouTubeTranscriptChromeHealth,
  youtubeTranscriptLane
} = await import("../browser/youtubeTranscriptLane.js");

test("YouTube transcript capture extracts fake visible segments and writes redacted artifacts", async () => {
  const vaultPath = createVault("success");
  const artifactRoot = join(tempRoot, "artifacts-success");
  const cdpClient = new FakeCdpClient({
    title: "Video sample_value_1234567890ABCDEF",
    currentUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&token=sample-token",
    officialPanelVisible: true,
    panelHeadings: ["Transcript"],
    segments: [
      { selector: "ytd-transcript-segment-renderer", timestamp: "0:01", text: "Hello test@example.com" },
      { selector: "ytd-transcript-segment-renderer", timestamp: "0:03", text: "Bearer sample_value_1234567890ABCDEF" }
    ]
  });

  const result = await runYouTubeTranscriptCapture({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&token=sample-token",
    vaultPath,
    artifactRoot,
    capturedAt: "2026-06-16T13:00:00.000Z",
    cdpClient
  });

  assert.equal(result.ok, true);
  assert.equal(cdpClient.openedUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ&token=sample-token");
  assert.equal(cdpClient.closed, true);
  if (!result.ok) throw new Error("expected capture success");
  assert.equal(result.segmentCount, 2);
  assert.equal(existsSync(result.files.manifest), true);
  assert.equal(existsSync(result.files.stageOpen), true);
  assert.equal(existsSync(result.files.stageTranscript), true);
  assert.equal(existsSync(result.files.pageRedacted), true);
  assert.equal(existsSync(result.files.transcriptRedacted), true);
  assert.equal(existsSync(result.files.ingest), true);

  const transcript = readFileSync(result.files.transcriptRedacted, "utf8");
  const combined = [
    readFileSync(result.files.manifest, "utf8"),
    readFileSync(result.files.stageTranscript, "utf8"),
    readFileSync(result.files.pageRedacted, "utf8"),
    transcript,
    readFileSync(result.ingest.path, "utf8")
  ].join("\n");

  assert.match(transcript, /0:01 Hello \[redacted-email\]/);
  assert.match(combined, /source_type: "youtube_transcript_capture"/);
  assert.match(combined, /token=\[redacted\]/);
  assert.match(combined, /\[redacted-token\]/);
  assert.doesNotMatch(combined, /secret-token|sample_value_1234567890ABCDEF|test@example\.com/);
  assert.doesNotMatch(combined, /<html|<body|localStorage|cookie/iu);
});

test("YouTube transcript URL validation accepts only watch or youtu.be video URLs", () => {
  assert.equal(validateYouTubeTranscriptUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ").ok, true);
  assert.equal(validateYouTubeTranscriptUrl("https://youtu.be/dQw4w9WgXcQ").ok, true);

  const rejected = [
    "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://studio.youtube.com/video/dQw4w9WgXcQ/edit",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/upload",
    "https://accounts.youtube.com/",
    "https://example.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch"
  ];
  for (const url of rejected) {
    assert.equal(validateYouTubeTranscriptUrl(url).ok, false, url);
  }
});

test("YouTube transcript expressions avoid prohibited full-page and write/action APIs", async () => {
  const expression = `${transcriptRevealExpression}\n${transcriptExtractionExpression}`;
  assert.match(transcriptRevealExpression, /\.click\(\)/u);
  assert.doesNotMatch(expression, /document\.body\.innerText|document\.documentElement\.innerText|localStorage|cookie/iu);
  assert.doesNotMatch(expression, /dispatchEvent|submit|input|download|share|like|subscribe|comment|save/iu);
  assert.doesNotMatch(transcriptExtractionExpression, /\[class\*='segment'\]|\[aria-label\*='Transcript'\]/u);
  assert.doesNotMatch(transcriptExtractionExpression, /target-id\*='transcript'|document\.querySelector\("ytd-transcript-renderer"\)/u);
  assert.doesNotMatch(transcriptExtractionExpression, /\|\| document/u);
  assert.match(transcriptExtractionExpression, /target-id='engagement-panel-searchable-transcript'/u);
  assert.doesNotMatch(expression, /querySelectorAll\(["']body["']\)/iu);

  const cdpClient = new CaptureExpressionCdpClient();
  const result = await runYouTubeTranscriptCapture({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    vaultPath: createVault("expression"),
    artifactRoot: join(tempRoot, "artifacts-expression"),
    capturedAt: "2026-06-16T13:01:00.000Z",
    cdpClient
  });
  assert.equal(result.ok, false);
  assert.equal(cdpClient.closed, true);
  assert.match(cdpClient.expressions.join("\n"), /visible_transcript_control_click/);
  assert.match(cdpClient.expressions.join("\n"), /ytd-transcript-segment-renderer/);
  if (result.ok) throw new Error("expected capture to block without the official transcript panel");
  assert.equal(result.exactBlocker, "youtube_transcript_official_panel_not_visible");
});

test("YouTube transcript capture blocks fake segments when the official panel is not visible", async () => {
  const result = await runYouTubeTranscriptCapture({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    vaultPath: createVault("fake-segments"),
    artifactRoot: join(tempRoot, "artifacts-fake-segments"),
    capturedAt: "2026-06-16T13:02:00.000Z",
    cdpClient: new FakeCdpClient({
      title: "Fake segments outside panel",
      currentUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      officialPanelVisible: false,
      panelHeadings: [],
      visibleTextSamples: [{ selector: "visible_transcript_controls", text: "Show transcript test@example.com" }],
      segments: [
        { selector: "ytd-transcript-segment-renderer", timestamp: "0:01", text: "This must not become proof" }
      ]
    })
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected fake segments without official panel to block");
  assert.equal(result.exactBlocker, "youtube_transcript_official_panel_not_visible");
  assert.equal(existsSync(result.files?.stageTranscript ?? ""), true);
  assert.equal(existsSync(result.files?.pageRedacted ?? ""), true);
  assert.equal(existsSync(result.files?.transcriptRedacted ?? ""), true);
  assert.equal(existsSync(result.files?.ingest ?? ""), true);
  const pageRedacted = readFileSync(result.files?.pageRedacted ?? "", "utf8");
  assert.match(pageRedacted, /youtube_transcript_official_panel_not_visible/);
  assert.match(pageRedacted, /Show transcript \[redacted-email\]/);
  assert.doesNotMatch(pageRedacted, /This must not become proof/);
});

test("YouTube transcript capture falls back to public timedtext captions when the official panel is not visible", async () => {
  const captionBaseUrl = "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en";
  const playerResponse = {
    videoDetails: { title: "Public Caption Video" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: captionBaseUrl,
            name: { simpleText: "English" },
            languageCode: "en",
            vssId: ".en"
          }
        ]
      }
    }
  };
  const fetchedUrls: string[] = [];
  const result = await runYouTubeTranscriptCapture({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    vaultPath: createVault("public-timedtext"),
    artifactRoot: join(tempRoot, "artifacts-public-timedtext"),
    capturedAt: "2026-06-16T13:02:30.000Z",
    cdpClient: new FakeCdpClient({
      title: "No official panel",
      currentUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      officialPanelVisible: false,
      panelHeadings: [],
      visibleTextSamples: [{ selector: "visible_transcript_controls", text: "Show transcript" }],
      segments: []
    }),
    async publicCaptionFetch(url) {
      fetchedUrls.push(String(url));
      if (String(url).includes("/watch?")) {
        return new Response(`<script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script>`, {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      return new Response(JSON.stringify({
        events: [
          { tStartMs: 1000, segs: [{ utf8: "Never gonna give you up" }] },
          { tStartMs: 2500, segs: [{ utf8: "Never gonna let you down" }] }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected public timedtext fallback to capture");
  assert.equal(result.segmentCount, 2);
  assert.equal(result.sourceTitle, "Public Caption Video");
  assert.equal(fetchedUrls.length, 2);
  assert.match(fetchedUrls[1], /fmt=json3/);
  const transcript = readFileSync(result.files.transcriptRedacted, "utf8");
  const stage = readFileSync(result.files.stageTranscript, "utf8");
  assert.match(transcript, /0:01 Never gonna give you up/);
  assert.match(transcript, /0:02 Never gonna let you down/);
  assert.match(stage, /public YouTube timedtext captionTracks/);
  assert.match(stage, /publicCaptionFallback/);
});

test("YouTube transcript capture records transcript endpoint diagnostic when public captions are unavailable", async () => {
  const artifactRoot = join(tempRoot, "artifacts-transcript-endpoint-diagnostic");
  const playerResponse = {
    videoDetails: { title: "Endpoint Only Video" },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: []
      }
    }
  };
  const initialData = {
    engagementPanels: [
      {
        engagementPanelSectionListRenderer: {
          content: {
            continuationItemRenderer: {
              continuationEndpoint: {
                getTranscriptEndpoint: {
                  params: "transcript-params"
                }
              }
            }
          }
        }
      }
    ]
  };

  const result = await runYouTubeTranscriptCapture({
    url: "https://www.youtube.com/watch?v=5MgBikgcWnY",
    vaultPath: createVault("transcript-endpoint-diagnostic"),
    artifactRoot,
    capturedAt: "2026-06-16T13:02:45.000Z",
    publicCaptionOnly: true,
    async publicCaptionFetch(url) {
      assert.match(String(url), /\/watch\?/);
      return new Response(
        `<script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script>
         <script>var ytInitialData = ${JSON.stringify(initialData)};</script>`,
        {
          status: 200,
          headers: { "content-type": "text/html" }
        }
      );
    }
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected endpoint-only transcript to block");
  assert.equal(result.exactBlocker, "youtube_transcript_endpoint_requires_youtube_context");
  const stage = readFileSync(result.files?.stageTranscript ?? "", "utf8");
  assert.match(stage, /youtube_transcript_endpoint_requires_youtube_context/);
  assert.match(stage, /"present": true/);
  assert.match(stage, /"paramsCount": 1/);
  assert.doesNotMatch(stage, /transcript-params/);
});

test("YouTube transcript capture writes manifest-listed artifacts on CDP failure", async () => {
  const result = await runYouTubeTranscriptCapture({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    vaultPath: createVault("cdp-failure"),
    artifactRoot: join(tempRoot, "artifacts-cdp-failure"),
    capturedAt: "2026-06-16T13:03:00.000Z",
    cdpClient: new FailingOpenCdpClient()
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected CDP failure to block");
  assert.equal(result.exactBlocker, "youtube_transcript_cdp_failed");
  for (const artifactPath of Object.values(result.files ?? {})) {
    assert.equal(existsSync(artifactPath), true, artifactPath);
  }
  const ingest = readFileSync(result.files?.ingest ?? "", "utf8");
  assert.match(ingest, /blocked_capture_not_ingested/);
});

test("YouTube transcript lane ensure opens the fixed CDP lane when health is unavailable", async () => {
  const seen: string[] = [];
  let openCalled = 0;
  const result = await ensureYouTubeTranscriptChromeReady({
    attempts: 3,
    delayMs: 0,
    async fetchImpl(url) {
      seen.push(String(url));
      if (seen.length === 1) throw new Error("connect ECONNREFUSED 127.0.0.1:9337");
      return new Response(JSON.stringify({ Browser: "Chrome/Test", webSocketDebuggerUrl: "ws://127.0.0.1:9337/devtools/browser/test" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    },
    openImpl() {
      openCalled += 1;
      return {
        ok: true,
        bin: "/Applications/Test Chrome.app/Contents/MacOS/Google Chrome",
        args: ["--remote-debugging-port=9337"],
        laneName: youtubeTranscriptLane.name,
        port: youtubeTranscriptLane.port,
        profileDir: youtubeTranscriptLane.profileDir,
        pid: 12345,
        url: youtubeTranscriptLane.homeUrl,
        summary: "opened for test"
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(openCalled, 1);
  assert.deepEqual(seen, [youtubeTranscriptLane.versionUrl, youtubeTranscriptLane.versionUrl]);
  if (!result.ok) throw new Error("expected lane ensure to succeed");
  assert.equal(result.opened?.pid, 12345);
  assert.equal(result.health.webSocketDebuggerUrl, "ws://127.0.0.1:9337/devtools/browser/test");
});

test("YouTube transcript lane ensure returns a clear CDP blocker when Chrome never becomes ready", async () => {
  let openCalled = 0;
  const result = await ensureYouTubeTranscriptChromeReady({
    attempts: 2,
    delayMs: 0,
    async fetchImpl() {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9337");
    },
    openImpl() {
      openCalled += 1;
      return {
        ok: true,
        bin: "/Applications/Test Chrome.app/Contents/MacOS/Google Chrome",
        args: ["--remote-debugging-port=9337"],
        laneName: youtubeTranscriptLane.name,
        port: youtubeTranscriptLane.port,
        profileDir: youtubeTranscriptLane.profileDir,
        pid: 12345,
        url: youtubeTranscriptLane.homeUrl,
        summary: "opened for test"
      };
    }
  });

  assert.equal(result.ok, false);
  assert.equal(openCalled, 1);
  if (result.ok) throw new Error("expected lane ensure to block");
  assert.equal(result.exactBlocker, "youtube_transcript_cdp_unavailable");
  assert.match(result.summary, /did not become ready/);
  assert.equal(result.opened?.pid, 12345);
});

test("YouTube transcript lane ensure converts Chrome open failure into a CDP blocker", async () => {
  let openCalled = 0;
  const result = await ensureYouTubeTranscriptChromeReady({
    attempts: 2,
    delayMs: 0,
    async fetchImpl() {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9337");
    },
    openImpl() {
      openCalled += 1;
      return {
        ok: false,
        bin: "/Applications/Missing Chrome.app/Contents/MacOS/Google Chrome",
        args: ["--remote-debugging-port=9337"],
        laneName: youtubeTranscriptLane.name,
        port: youtubeTranscriptLane.port,
        profileDir: youtubeTranscriptLane.profileDir,
        url: youtubeTranscriptLane.homeUrl,
        exactBlocker: "youtube_transcript_cdp_open_failed",
        summary: "spawn ENOENT"
      };
    }
  });

  assert.equal(result.ok, false);
  assert.equal(openCalled, 1);
  if (result.ok) throw new Error("expected lane ensure to block");
  assert.equal(result.exactBlocker, "youtube_transcript_cdp_open_failed");
  assert.match(result.summary, /spawn ENOENT/);
});

test("YouTube transcript health check is bounded when CDP never responds", async () => {
  const startedAt = Date.now();
  const result = await getYouTubeTranscriptChromeHealth(async () => new Promise<Response>(() => undefined));

  assert.equal(result.ok, false);
  assert.equal(result.exactBlocker, "youtube_transcript_cdp_unavailable");
  assert.match(result.summary, /youtube_transcript_cdp_health_timeout/);
  assert.ok(Date.now() - startedAt < 3000);
});

function createVault(name: string): string {
  const vault = join(tempRoot, `vault-${name}`);
  mkdirSync(join(vault, "09_Inbox"), { recursive: true });
  return vault;
}

class FakeCdpClient implements YouTubeTranscriptCdpClient {
  openedUrl = "";
  closed = false;
  evaluateCalls = 0;

  constructor(private readonly page: Record<string, unknown>) {}

  async openUrl(url: string): Promise<{ targetId: string; webSocketDebuggerUrl: string }> {
    this.openedUrl = url;
    return { targetId: "target-fake", webSocketDebuggerUrl: "ws://127.0.0.1:9337/devtools/page/fake" };
  }

  async evaluate(expression: string): Promise<unknown> {
    this.evaluateCalls += 1;
    assert.doesNotMatch(expression, /document\.body\.innerText|document\.documentElement\.innerText|localStorage|cookie/iu);
    assert.doesNotMatch(expression, /dispatchEvent|submit|input|download|share|like|subscribe|comment|save/iu);
    if (/visible_transcript_control_click/.test(expression)) {
      return { title: this.page.title, currentUrl: this.page.currentUrl, revealAttempted: true, revealMethod: "visible_transcript_control_click" };
    }
    return this.page;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class CaptureExpressionCdpClient implements YouTubeTranscriptCdpClient {
  expressions: string[] = [];
  closed = false;

  async openUrl(): Promise<{ targetId: string; webSocketDebuggerUrl: string }> {
    return { targetId: "target-fake", webSocketDebuggerUrl: "ws://127.0.0.1:9337/devtools/page/fake" };
  }

  async evaluate(expression: string): Promise<unknown> {
    this.expressions.push(expression);
    if (/visible_transcript_control_click/.test(expression)) {
      return { currentUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", revealAttempted: false, revealMethod: null };
    }
    return { title: "No transcript", currentUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", panelHeadings: [], segments: [] };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FailingOpenCdpClient implements YouTubeTranscriptCdpClient {
  closed = false;

  async openUrl(): Promise<{ targetId: string; webSocketDebuggerUrl: string }> {
    throw new Error("youtube_transcript_cdp_target_missing_websocket");
  }

  async evaluate(): Promise<unknown> {
    throw new Error("should_not_evaluate_after_open_failure");
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

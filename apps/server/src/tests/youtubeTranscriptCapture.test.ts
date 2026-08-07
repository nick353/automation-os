import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { YouTubeTranscriptBrowserUseCliReadback } from "../obsidian/youtubeTranscriptCapture.js";

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
  validateYouTubeTranscriptUrl
} = await import("../obsidian/youtubeTranscriptCapture.js");
const {
  ensureYouTubeTranscriptChromeReady,
  getYouTubeTranscriptChromeHealth,
  youtubeTranscriptLane
} = await import("../browser/youtubeTranscriptLane.js");

test("YouTube transcript capture uses Browser Use CLI readback and writes redacted caption artifacts", async () => {
  const vaultPath = createVault("success");
  const artifactRoot = join(tempRoot, "artifacts-success");
  const browserUseCliReadback = new FakeBrowserUseCliReadback();
  const playerResponse = {
    videoDetails: { title: "Video sample_value_1234567890ABCDEF" },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [{
      baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en",
      name: { simpleText: "English" },
      languageCode: "en",
      vssId: ".en"
    }] } }
  };

  const result = await runYouTubeTranscriptCapture({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&token=sample-token",
    vaultPath,
    artifactRoot,
    capturedAt: "2026-06-16T13:00:00.000Z",
    browserUseCliReadback,
    async publicCaptionFetch(url) {
      if (String(url).includes("/watch?")) {
        return new Response(`<script>var ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script>`, { status: 200 });
      }
      return new Response(JSON.stringify({ events: [
        { tStartMs: 1000, segs: [{ utf8: "Hello test@example.com" }] },
        { tStartMs: 3000, segs: [{ utf8: "Bearer sample_value_1234567890ABCDEF" }] }
      ] }), { status: 200 });
    }
  });

  assert.equal(result.ok, true);
  assert.equal(browserUseCliReadback.inputs.length, 1);
  assert.equal(browserUseCliReadback.inputs[0]?.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ&token=sample-token");
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
  assert.match(readFileSync(result.files.stageOpen, "utf8"), /browser_use_cli/);
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
    publicCaptionOnly: true,
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

test("YouTube transcript capture preserves the CLI blocker and writes manifest-listed artifacts", async () => {
  const result = await runYouTubeTranscriptCapture({
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    vaultPath: createVault("browser-use-cli-failure"),
    artifactRoot: join(tempRoot, "artifacts-browser-use-cli-failure"),
    capturedAt: "2026-06-16T13:03:00.000Z",
    browserUseCliReadback: {
      async openAndRead() {
        return { ok: false as const, exactBlocker: "browser_use_cli_authority_required", summary: "fresh CLI proof required" };
      }
    },
    publicCaptionFetch: async () => new Response("not a YouTube player response", { status: 200 })
  });

  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected Browser Use CLI failure to block");
  assert.equal(result.exactBlocker, "browser_use_cli_authority_required");
  for (const artifactPath of Object.values(result.files ?? {})) {
    assert.equal(existsSync(artifactPath), true, artifactPath);
  }
  const ingest = readFileSync(result.files?.ingest ?? "", "utf8");
  assert.match(ingest, /blocked_capture_not_ingested/);
});

test("YouTube transcript lane requires fresh Browser Use authority before opening", async () => {
  const seen: string[] = [];
  let openCalled = 0;
  const result = await ensureYouTubeTranscriptChromeReady({
    attempts: 3,
    delayMs: 0,
    async fetchImpl(url) {
      seen.push(String(url));
      return new Response("unexpected legacy CDP probe", { status: 500 });
    },
    openImpl() {
      openCalled += 1;
      return {
        ok: true,
        bin: "/Users/nichikatanaka/.local/bin/codex-browser-use",
        args: ["--session", "test", "open", youtubeTranscriptLane.homeUrl],
        laneName: youtubeTranscriptLane.name,
        port: youtubeTranscriptLane.port,
        profileDir: youtubeTranscriptLane.profileDir,
        url: youtubeTranscriptLane.homeUrl,
        summary: "opened for test"
      };
    }
  });

  assert.equal(result.ok, false);
  assert.equal(openCalled, 1);
  assert.deepEqual(seen, []);
  if (result.ok) throw new Error("expected fresh Browser Use authority to be required");
  assert.equal(result.exactBlocker, "browser_use_authority_required");
});

test("YouTube transcript lane does not treat a legacy open result as Browser Use readiness", async () => {
  let openCalled = 0;
  const result = await ensureYouTubeTranscriptChromeReady({
    attempts: 2,
    delayMs: 0,
    async fetchImpl() {
      throw new Error("legacy CDP probe must not be used");
    },
    openImpl() {
      openCalled += 1;
      return {
        ok: true,
        bin: "/Users/nichikatanaka/.local/bin/codex-browser-use",
        args: ["--session", "test", "open", youtubeTranscriptLane.homeUrl],
        laneName: youtubeTranscriptLane.name,
        port: youtubeTranscriptLane.port,
        profileDir: youtubeTranscriptLane.profileDir,
        url: youtubeTranscriptLane.homeUrl,
        summary: "opened for test"
      };
    }
  });

  assert.equal(result.ok, false);
  assert.equal(openCalled, 1);
  if (result.ok) throw new Error("expected lane ensure to block");
  assert.equal(result.exactBlocker, "browser_use_authority_required");
  assert.match(result.summary, /did not become ready/);
  assert.equal(result.opened?.ok, true);
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
        bin: "/Users/nichikatanaka/.local/bin/codex-browser-use",
        args: ["--session", "test", "open", youtubeTranscriptLane.homeUrl],
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

test("YouTube transcript health check is bounded without probing legacy CDP", async () => {
  const startedAt = Date.now();
  const result = await getYouTubeTranscriptChromeHealth(async () => new Response("unexpected legacy CDP probe", { status: 500 }));

  assert.equal(result.ok, false);
  assert.equal(result.exactBlocker, "browser_use_authority_required");
  assert.match(result.summary, /fresh authority/);
  assert.ok(Date.now() - startedAt < 3000);
});

function createVault(name: string): string {
  const vault = join(tempRoot, `vault-${name}`);
  mkdirSync(join(vault, "09_Inbox"), { recursive: true });
  return vault;
}

class FakeBrowserUseCliReadback implements YouTubeTranscriptBrowserUseCliReadback {
  inputs: Array<{ url: string; runId: string; session: string; automationId: string; artifactDir: string }> = [];

  async openAndRead(input: { url: string; runId: string; session: string; automationId: string; artifactDir: string }) {
    this.inputs.push(input);
    return {
      ok: true as const,
      currentUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      title: "Video sample_value_1234567890ABCDEF",
      readback: { state: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Video sample_value_1234567890ABCDEF" } },
      receipt: join(input.artifactDir, "receipt.json")
    };
  }
}

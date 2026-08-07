import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeId } from "../db/client.js";
import { youtubeTranscriptLane } from "../browser/youtubeTranscriptLane.js";
import { runObsidianIngest, type ObsidianIngestResult } from "./ingest.js";
import { redactSensitiveText } from "./redaction.js";
import { guardObsidianVaultPath } from "./vaultGuard.js";

const defaultArtifactRoot = "data/artifacts/youtube-transcript-captures";
const browserUseCliTimeoutMs = 30000;
const execFileAsync = promisify(execFile);

export type YouTubeTranscriptBrowserUseCliReadback = {
  openAndRead(input: {
    url: string;
    runId: string;
    session: string;
    automationId: string;
    artifactDir: string;
  }): Promise<YouTubeTranscriptBrowserUseCliReadbackResult>;
};

export type YouTubeTranscriptBrowserUseCliReadbackResult =
  | {
      ok: true;
      currentUrl: string;
      title: string;
      readback: Record<string, unknown>;
      receipt?: string;
    }
  | {
      ok: false;
      exactBlocker: string;
      summary: string;
      readback?: Record<string, unknown>;
    };

export type YouTubeTranscriptCaptureInput = {
  url?: string;
  sourceTitle?: string;
  vaultPath?: string;
  capturedAt?: string;
  artifactRoot?: string;
  browserUseCliReadback?: YouTubeTranscriptBrowserUseCliReadback;
  publicCaptionFetch?: typeof fetch;
  publicCaptionOnly?: boolean;
};

export type YouTubeTranscriptCaptureFiles = {
  manifest: string;
  stageOpen: string;
  stageTranscript: string;
  pageRedacted: string;
  transcriptRedacted: string;
  ingest: string;
};

export type YouTubeTranscriptCaptureResult =
  | {
      ok: true;
      status: "captured";
      captureId: string;
      artifactDir: string;
      requestedUrl: string;
      currentUrl: string;
      sourceTitle: string;
      files: YouTubeTranscriptCaptureFiles;
      ingest: Extract<ObsidianIngestResult, { ok: true }>;
      segmentCount: number;
      transcriptBytes: number;
    }
  | {
      ok: false;
      status: "blocked" | "rejected";
      captureId: string;
      artifactDir?: string;
      requestedUrl?: string;
      exactBlocker: string;
      summary: string;
      files?: Partial<YouTubeTranscriptCaptureFiles>;
      ingest?: ObsidianIngestResult;
    };

export async function runYouTubeTranscriptCapture(input: YouTubeTranscriptCaptureInput): Promise<YouTubeTranscriptCaptureResult> {
  const captureId = makeId("youtube_transcript");
  const capturedAt = normalizeCapturedAt(input.capturedAt);
  if (!capturedAt) return rejected(captureId, "youtube_transcript_captured_at_invalid", "capturedAt must be an ISO-compatible timestamp", redactUnknown(input.url));

  const parsed = validateYouTubeTranscriptUrl(input.url);
  if (!parsed.ok) return rejected(captureId, parsed.exactBlocker, parsed.summary, redactUnknown(input.url));

  const vaultGuard = guardObsidianVaultPath(input.vaultPath);
  if (!vaultGuard.ok) return rejected(captureId, vaultGuard.error, vaultGuard.summary, redactSensitiveText(parsed.url.toString()), vaultGuard.vaultPath);

  const artifactDir = resolve(input.artifactRoot ?? defaultArtifactRoot, captureId);
  mkdirSync(artifactDir, { recursive: true });
  const files = captureFiles(artifactDir);
  const requestedUrl = redactSensitiveText(parsed.url.toString());
  const manifestBase = {
    captureId,
    laneName: youtubeTranscriptLane.name,
    cdpPort: youtubeTranscriptLane.port,
    profileDir: youtubeTranscriptLane.profileDir,
    requestedUrl,
    artifactDir,
    createdAt: capturedAt,
    files
  };

  if (input.publicCaptionOnly) {
    writeJson(files.stageOpen, {
      status: "skipped",
      requestedUrl,
      laneName: youtubeTranscriptLane.name,
      cdpPort: youtubeTranscriptLane.port,
      reason: "public_caption_only"
    });
    const fallback = await capturePublicTimedTextFallback({
      url: parsed.url,
      fetchImpl: input.publicCaptionFetch ?? fetch
    });
    if (fallback.ok) {
      return persistCapturedTranscript({
        input,
        vaultPath: vaultGuard.vaultPath,
        files,
        manifestBase,
        artifactDir,
        captureId,
        requestedUrl,
        currentUrl: parsed.url.toString(),
        sourceTitle: fallback.title,
        transcriptText: fallback.transcriptText,
        segmentCount: fallback.segmentCount,
        capturedAt,
        extractionMethods: ["public YouTube timedtext captionTracks", fallback.trackName].filter(Boolean),
        stage: {
          status: "ok",
          requestedUrl,
          currentUrl: redactSensitiveText(parsed.url.toString()),
          title: redactSensitiveText(fallback.title),
          publicCaptionFallback: {
            status: "captured",
            trackName: fallback.trackName,
            languageCode: fallback.languageCode,
            segmentCount: fallback.segmentCount
          }
        }
      });
    }
    return blocked({
      files,
      manifestBase,
      artifactDir,
      captureId,
      requestedUrl,
      exactBlocker: fallback.exactBlocker,
      summary: fallback.summary,
      stage: {
        status: "blocked",
        exactBlocker: fallback.exactBlocker,
        summary: fallback.summary,
        requestedUrl,
        currentUrl: redactSensitiveText(parsed.url.toString()),
        publicCaptionFallback: {
          status: "blocked",
          exactBlocker: fallback.exactBlocker,
          summary: fallback.summary,
          transcriptEndpoint: fallback.transcriptEndpoint
        }
      }
    });
  }

  const cliReadback = input.browserUseCliReadback ?? createBrowserUseCliReadback();
  const cliResult = await cliReadback.openAndRead({
    url: parsed.url.toString(),
    runId: captureId,
    session: `aos-youtube-${captureId}`,
    automationId: "youtube-visible-transcript-capture",
    artifactDir
  });
  const safeCliReadback = cliResult.ok ? redactReadback(cliResult.readback) as Record<string, unknown> : undefined;
  writeJson(files.stageOpen, {
    status: cliResult.ok ? "ok" : "blocked",
    requestedUrl,
    surface: "browser_use_cli",
    laneName: youtubeTranscriptLane.name,
    ...(cliResult.ok
      ? { currentUrl: redactSensitiveText(cliResult.currentUrl), title: redactSensitiveText(cliResult.title), readback: safeCliReadback }
      : { exactBlocker: cliResult.exactBlocker, summary: redactSensitiveText(cliResult.summary) })
  });

  const fallback = await capturePublicTimedTextFallback({
    url: parsed.url,
    fetchImpl: input.publicCaptionFetch ?? fetch
  });
  if (fallback.ok) {
    return persistCapturedTranscript({
      input,
      vaultPath: vaultGuard.vaultPath,
      files,
      manifestBase,
      artifactDir,
      captureId,
      requestedUrl,
      currentUrl: cliResult.ok ? cliResult.currentUrl : parsed.url.toString(),
      sourceTitle: fallback.title || (cliResult.ok ? cliResult.title : "YouTube transcript capture"),
      transcriptText: fallback.transcriptText,
      segmentCount: fallback.segmentCount,
      capturedAt,
      extractionMethods: [
        ...(cliResult.ok ? ["Browser Use CLI public state/title/url readback"] : []),
        "public YouTube timedtext captionTracks",
        fallback.trackName
      ].filter(Boolean),
      stage: {
        status: "ok",
        requestedUrl,
        currentUrl: redactSensitiveText(cliResult.ok ? cliResult.currentUrl : parsed.url.toString()),
        title: redactSensitiveText((normalizeScalar(input.sourceTitle) ?? fallback.title ?? (cliResult.ok ? cliResult.title : "YouTube transcript capture"))),
        browserUseCliReadback: cliResult.ok ? safeCliReadback : {
          status: "blocked",
          exactBlocker: cliResult.exactBlocker,
          summary: redactSensitiveText(cliResult.summary)
        },
        publicCaptionFallback: {
          status: "captured",
          trackName: fallback.trackName,
          languageCode: fallback.languageCode,
          segmentCount: fallback.segmentCount
        }
      }
    });
  }

  const exactBlocker = cliResult.ok ? fallback.exactBlocker : cliResult.exactBlocker;
  const summary = cliResult.ok
    ? fallback.summary
    : `${cliResult.summary}; ${fallback.summary}`;
  return blocked({
    files,
    manifestBase,
    artifactDir,
    captureId,
    requestedUrl,
    exactBlocker,
    summary: redactSensitiveText(summary),
    stage: {
      status: "blocked",
      exactBlocker,
      summary: redactSensitiveText(summary),
      requestedUrl,
      browserUseCliReadback: cliResult.ok ? safeCliReadback : {
        status: "blocked",
        exactBlocker: cliResult.exactBlocker,
        summary: redactSensitiveText(cliResult.summary)
      },
      publicCaptionFallback: {
        status: "blocked",
        exactBlocker: fallback.exactBlocker,
        summary: fallback.summary,
        transcriptEndpoint: fallback.transcriptEndpoint
      }
    }
  });
}

export function validateYouTubeTranscriptUrl(value: unknown):
  | { ok: true; url: URL }
  | { ok: false; exactBlocker: string; summary: string } {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, exactBlocker: "youtube_transcript_url_required", summary: "url is required" };
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, exactBlocker: "youtube_transcript_url_invalid", summary: "url must be a valid absolute URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, exactBlocker: "youtube_transcript_scheme_blocked", summary: "only https YouTube video URLs are allowed" };
  }
  const host = url.hostname.toLowerCase();
  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0] ?? "";
    if (!id || id === "shorts") return { ok: false, exactBlocker: "youtube_transcript_url_unsupported", summary: "only youtu.be video URLs are allowed" };
    return { ok: true, url };
  }
  if (host !== "www.youtube.com" && host !== "youtube.com" && host !== "m.youtube.com") {
    return { ok: false, exactBlocker: "youtube_transcript_host_blocked", summary: "only YouTube watch URLs are allowed" };
  }
  const path = url.pathname.replace(/\/+$/u, "") || "/";
  if (path !== "/watch") {
    return { ok: false, exactBlocker: "youtube_transcript_url_unsupported", summary: "only YouTube watch URLs are allowed" };
  }
  if (!url.searchParams.get("v")) {
    return { ok: false, exactBlocker: "youtube_transcript_video_id_required", summary: "YouTube watch URL must include a video id" };
  }
  return { ok: true, url };
}

function createBrowserUseCliReadback(): YouTubeTranscriptBrowserUseCliReadback {
  const helper = process.env.AUTOMATION_OS_BROWSER_USE_CLI?.trim()
    || process.env.BROWSER_USE_CLI_PATH?.trim()
    || "/Users/nichikatanaka/.local/bin/codex-browser-use";
  return {
    async openAndRead(input) {
      const args = [
        "public",
        "--run-id", input.runId,
        "--session", input.session,
        "--automation-id", input.automationId,
        "--lifecycle", "single-use",
        "--allowed-origin", "https://www.youtube.com",
        "--allowed-origin", "https://youtu.be",
        "--allowed-origin", "https://m.youtube.com",
        "--post-command-json", JSON.stringify([["state"], ["get", "title"], ["get", "url"]]),
        "--artifact-dir", input.artifactDir,
        "--",
        "open", input.url
      ];
      try {
        const result = await execFileAsync(helper, args, {
          encoding: "utf8",
          timeout: browserUseCliTimeoutMs,
          maxBuffer: 512 * 1024
        });
        const parsed = parseLastJsonLine(result.stdout);
        if (!parsed || parsed.status !== "completed" || parsed.finalized !== true) {
          return {
            ok: false,
            exactBlocker: stringValue(parsed?.exact_blocker) || "browser_use_cli_receipt_missing",
            summary: "Browser Use CLI did not return a finalized public read-only receipt"
          };
        }
        const readback = isRecord(parsed.captured_readback) ? parsed.captured_readback : {};
        const currentUrl = findReadbackString(readback, ["currentUrl", "url"]);
        const title = findReadbackString(readback, ["title"]);
        if (!currentUrl || !title) {
          return {
            ok: false,
            exactBlocker: "browser_use_cli_semantic_readback_unavailable",
            summary: "Browser Use CLI receipt lacks the required same-run URL/title readback",
            readback: redactReadback(readback) as Record<string, unknown>
          };
        }
        const validatedUrl = validateYouTubeTranscriptUrl(currentUrl);
        if (!validatedUrl.ok) {
          return {
            ok: false,
            exactBlocker: "browser_use_cli_navigation_readback_mismatch",
            summary: "Browser Use CLI readback is not a YouTube video URL",
            readback: redactReadback(readback) as Record<string, unknown>
          };
        }
        return {
          ok: true,
          currentUrl: validatedUrl.url.toString(),
          title: redactSensitiveText(title),
          readback: redactReadback(readback) as Record<string, unknown>,
          receipt: stringValue(parsed.receipt)
        };
      } catch (error) {
        const stdout = isRecord(error) && typeof error.stdout === "string" ? error.stdout : "";
        const parsed = parseLastJsonLine(stdout);
        return {
          ok: false,
          exactBlocker: stringValue(parsed?.exact_blocker) || (error instanceof Error && /timed out|timeout/i.test(error.message)
            ? "browser_use_cli_timeout"
            : "browser_use_cli_unavailable"),
          summary: "Browser Use CLI public read-only execution was not completed"
        };
      }
    }
  };
}

function parseLastJsonLine(value: string): Record<string, unknown> | null {
  const lines = String(value || "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // helper diagnostics are intentionally ignored; only the final JSON receipt is trusted
    }
  }
  return null;
}

function findReadbackString(value: unknown, keys: string[]): string {
  if (!isRecord(value)) return "";
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  for (const child of Object.values(value)) {
    const found = findReadbackString(child, keys);
    if (found) return found;
  }
  return "";
}

function redactReadback(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[redacted-depth]";
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.slice(0, 32).map((item) => redactReadback(item, depth + 1));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) => [key, redactReadback(item, depth + 1)]));
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function blocked(input: {
  files: YouTubeTranscriptCaptureFiles;
  manifestBase: Record<string, unknown>;
  artifactDir: string;
  captureId: string;
  requestedUrl: string;
  exactBlocker: string;
  summary: string;
  stage: Record<string, unknown>;
}): Extract<YouTubeTranscriptCaptureResult, { ok: false }> {
  writeJson(input.files.stageTranscript, input.stage);
  writeJson(input.files.pageRedacted, {
    captureId: input.captureId,
    requestedUrl: input.requestedUrl,
    currentUrl: typeof input.stage.currentUrl === "string" ? input.stage.currentUrl : null,
    title: typeof input.stage.title === "string" ? redactSensitiveText(input.stage.title) : null,
    status: "blocked",
    exactBlocker: input.exactBlocker,
    officialPanelVisible: Boolean(input.stage.officialPanelVisible),
    panelHeadings: Array.isArray(input.stage.panelHeadings) ? input.stage.panelHeadings.map((item) => redactSensitiveText(String(item))).slice(0, 5) : [],
    visibleTextSamples: Array.isArray(input.stage.visibleTextSamples)
      ? input.stage.visibleTextSamples.flatMap((item) => {
          if (!isRecord(item)) return [];
          const selector = typeof item.selector === "string" ? item.selector : "";
          const text = typeof item.text === "string" ? redactSensitiveText(item.text) : "";
          return selector && text ? [{ selector, text }] : [];
        }).slice(0, 8)
      : [],
    segmentCount: typeof input.stage.segmentCount === "number" ? input.stage.segmentCount : 0
  });
  writeFileSync(input.files.transcriptRedacted, "", "utf8");
  writeJson(input.files.ingest, { ok: false, status: "skipped", reason: "blocked_capture_not_ingested", exactBlocker: input.exactBlocker });
  writeJson(input.files.manifest, { ...input.manifestBase, status: "blocked", exactBlocker: input.exactBlocker });
  return {
    ok: false,
    status: "blocked",
    captureId: input.captureId,
    artifactDir: input.artifactDir,
    requestedUrl: input.requestedUrl,
    exactBlocker: input.exactBlocker,
    summary: input.summary,
    files: input.files
  };
}

function persistCapturedTranscript(input: {
  input: YouTubeTranscriptCaptureInput;
  vaultPath: string;
  files: YouTubeTranscriptCaptureFiles;
  manifestBase: Record<string, unknown>;
  artifactDir: string;
  captureId: string;
  requestedUrl: string;
  currentUrl: string;
  sourceTitle: string;
  transcriptText: string;
  segmentCount: number;
  capturedAt: string;
  extractionMethods: string[];
  stage: Record<string, unknown>;
}): YouTubeTranscriptCaptureResult {
  const redactedTitle = redactSensitiveText((normalizeScalar(input.input.sourceTitle) ?? input.sourceTitle) || "YouTube transcript capture");
  const redactedCurrentUrl = redactSensitiveText(input.currentUrl);
  const redactedTranscript = redactSensitiveText(input.transcriptText);
  writeJson(input.files.stageTranscript, {
    ...input.stage,
    status: "ok",
    requestedUrl: input.requestedUrl,
    currentUrl: redactedCurrentUrl,
    title: redactedTitle,
    segmentCount: input.segmentCount,
    transcriptBytes: Buffer.byteLength(redactedTranscript),
    extractionMethods: input.extractionMethods
  });
  writeJson(input.files.pageRedacted, {
    captureId: input.captureId,
    requestedUrl: input.requestedUrl,
    currentUrl: redactedCurrentUrl,
    title: redactedTitle,
    segmentCount: input.segmentCount
  });
  writeFileSync(input.files.transcriptRedacted, redactedTranscript, "utf8");

  const ingest = runObsidianIngest({
    vaultPath: input.vaultPath,
    sourceUrl: redactedCurrentUrl,
    sourceTitle: redactedTitle,
    sourceType: "youtube_transcript_capture",
    text: [
      `Capture ID: ${input.captureId}`,
      `Lane: ${youtubeTranscriptLane.name}`,
      `Artifact directory: ${input.artifactDir}`,
      "",
      redactedTranscript
    ].join("\n"),
    capturedAt: input.capturedAt
  });
  writeJson(input.files.ingest, ingest);
  if (!ingest.ok) {
    writeJson(input.files.manifest, { ...input.manifestBase, status: "blocked", exactBlocker: ingest.error, currentUrl: redactedCurrentUrl, segmentCount: input.segmentCount });
    return { ok: false, status: "blocked", captureId: input.captureId, artifactDir: input.artifactDir, requestedUrl: input.requestedUrl, exactBlocker: ingest.error, summary: ingest.summary, files: input.files, ingest };
  }

  writeJson(input.files.manifest, {
    ...input.manifestBase,
    status: "captured",
    currentUrl: redactedCurrentUrl,
    sourceTitle: redactedTitle,
    ingestFile: ingest.path,
    segmentCount: input.segmentCount,
    transcriptBytes: Buffer.byteLength(redactedTranscript),
    extractionMethods: input.extractionMethods
  });
  return {
    ok: true,
    status: "captured",
    captureId: input.captureId,
    artifactDir: input.artifactDir,
    requestedUrl: input.requestedUrl,
    currentUrl: redactedCurrentUrl,
    sourceTitle: redactedTitle,
    files: input.files,
    ingest,
    segmentCount: input.segmentCount,
    transcriptBytes: Buffer.byteLength(redactedTranscript)
  };
}

type PublicTimedTextFallbackResult =
  | {
      ok: true;
      title: string;
      trackName: string;
      languageCode: string;
      segmentCount: number;
      transcriptText: string;
    }
  | {
      ok: false;
      exactBlocker: string;
      summary: string;
      transcriptEndpoint?: TranscriptEndpointDiagnostic;
    };

type TranscriptEndpointDiagnostic = {
  present: boolean;
  paramsCount: number;
  source: "ytInitialData";
};

async function capturePublicTimedTextFallback(input: { url: URL; fetchImpl: typeof fetch }): Promise<PublicTimedTextFallbackResult> {
  try {
    const watchResponse = await fetchWithTimeout(input.fetchImpl, input.url.toString(), "youtube_public_captions_watch_timeout", browserUseCliTimeoutMs);
    if (!watchResponse.ok) return { ok: false, exactBlocker: `youtube_public_captions_watch_http_${watchResponse.status}`, summary: `watch page returned HTTP ${watchResponse.status}` };
    const watchHtml = await withTimeout(watchResponse.text(), "youtube_public_captions_watch_timeout", browserUseCliTimeoutMs);
    const playerResponse = extractInitialPlayerResponse(watchHtml);
    if (!playerResponse) return { ok: false, exactBlocker: "youtube_public_captions_player_response_missing", summary: "ytInitialPlayerResponse was not found" };
    const transcriptEndpoint = extractTranscriptEndpointDiagnostic(watchHtml);
    const tracks = captionTracksFromPlayerResponse(playerResponse);
    if (tracks.length === 0) {
      if (transcriptEndpoint.present) {
        return {
          ok: false,
          exactBlocker: "youtube_transcript_endpoint_requires_youtube_context",
          summary: "YouTube exposes a transcript endpoint, but no public captionTracks were available",
          transcriptEndpoint
        };
      }
      return { ok: false, exactBlocker: "youtube_public_captions_tracks_missing", summary: "No public captionTracks were available", transcriptEndpoint };
    }
    const selected = selectCaptionTrack(tracks);
    const captionUrl = timedTextJsonUrl(selected.baseUrl);
    if (!captionUrl) return { ok: false, exactBlocker: "youtube_public_captions_url_invalid", summary: "caption track baseUrl was invalid", transcriptEndpoint };
    const captionResponse = await fetchWithTimeout(input.fetchImpl, captionUrl, "youtube_public_captions_timedtext_timeout", browserUseCliTimeoutMs);
    if (!captionResponse.ok) {
      if (transcriptEndpoint.present) {
        return {
          ok: false,
          exactBlocker: "youtube_transcript_endpoint_requires_youtube_context",
          summary: `timedtext returned HTTP ${captionResponse.status}; YouTube transcript endpoint is present but not public-fetchable`,
          transcriptEndpoint
        };
      }
      return { ok: false, exactBlocker: `youtube_public_captions_timedtext_http_${captionResponse.status}`, summary: `timedtext returned HTTP ${captionResponse.status}`, transcriptEndpoint };
    }
    const captionBody = await withTimeout(captionResponse.text(), "youtube_public_captions_timedtext_timeout", browserUseCliTimeoutMs);
    const transcript = parseTimedTextBody(captionBody);
    if (!transcript.transcriptText.trim()) {
      if (transcriptEndpoint.present) {
        return {
          ok: false,
          exactBlocker: "youtube_transcript_endpoint_requires_youtube_context",
          summary: "Public captions were empty; YouTube transcript endpoint is present but requires YouTube page context",
          transcriptEndpoint
        };
      }
      return { ok: false, exactBlocker: "youtube_public_captions_empty", summary: "Public captions were empty", transcriptEndpoint };
    }
    return {
      ok: true,
      title: videoTitleFromPlayerResponse(playerResponse) ?? "YouTube transcript capture",
      trackName: selected.name,
      languageCode: selected.languageCode,
      segmentCount: transcript.segmentCount,
      transcriptText: transcript.transcriptText
    };
  } catch (error) {
    const summary = error instanceof Error ? error.message : "public timedtext caption fallback failed";
    return {
      ok: false,
      exactBlocker: /timeout/i.test(summary) ? "youtube_public_captions_timeout" : "youtube_public_captions_failed",
      summary: redactSensitiveText(summary)
    };
  }
}

function extractTranscriptEndpointDiagnostic(html: string): TranscriptEndpointDiagnostic {
  const initialData = extractInitialData(html);
  if (!initialData) return { present: false, paramsCount: 0, source: "ytInitialData" };
  let paramsCount = 0;
  walkJson(initialData, (value) => {
    if (!isRecord(value)) return;
    const endpoint = isRecord(value.getTranscriptEndpoint) ? value.getTranscriptEndpoint : null;
    if (endpoint && typeof endpoint.params === "string" && endpoint.params.trim()) paramsCount += 1;
  });
  return { present: paramsCount > 0, paramsCount, source: "ytInitialData" };
}

function extractInitialData(html: string): Record<string, unknown> | null {
  const marker = "ytInitialData";
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = html.indexOf("{", markerIndex);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return parseJsonObject(html.slice(start, index + 1));
    }
  }
  return null;
}

function walkJson(value: unknown, visit: (value: unknown) => void): void {
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visit);
    return;
  }
  if (!isRecord(value)) return;
  for (const item of Object.values(value)) walkJson(item, visit);
}

async function fetchWithTimeout(fetchImpl: typeof fetch, url: string, exactBlocker: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(exactBlocker)), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(exactBlocker);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

type CaptionTrack = {
  baseUrl: string;
  name: string;
  languageCode: string;
  kind?: string;
  vssId?: string;
};

function extractInitialPlayerResponse(html: string): Record<string, unknown> | null {
  const marker = "ytInitialPlayerResponse";
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = html.indexOf("{", markerIndex);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return parseJsonObject(html.slice(start, index + 1));
      }
    }
  }
  return null;
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function captionTracksFromPlayerResponse(playerResponse: Record<string, unknown>): CaptionTrack[] {
  const captions = isRecord(playerResponse.captions) ? playerResponse.captions : {};
  const renderer = isRecord(captions.playerCaptionsTracklistRenderer) ? captions.playerCaptionsTracklistRenderer : {};
  const tracks = Array.isArray(renderer.captionTracks) ? renderer.captionTracks : [];
  return tracks.flatMap((track) => {
    if (!isRecord(track) || typeof track.baseUrl !== "string" || !track.baseUrl.trim()) return [];
    return [{
      baseUrl: track.baseUrl,
      name: captionTrackName(track.name),
      languageCode: typeof track.languageCode === "string" ? track.languageCode : "",
      kind: typeof track.kind === "string" ? track.kind : undefined,
      vssId: typeof track.vssId === "string" ? track.vssId : undefined
    }];
  });
}

function captionTrackName(value: unknown): string {
  if (!isRecord(value)) return "caption track";
  if (typeof value.simpleText === "string" && value.simpleText.trim()) return value.simpleText.trim();
  const runs = Array.isArray(value.runs) ? value.runs : [];
  const text = runs.flatMap((run) => isRecord(run) && typeof run.text === "string" ? [run.text] : []).join("");
  return text.trim() || "caption track";
}

function selectCaptionTrack(tracks: CaptionTrack[]): CaptionTrack {
  return (
    tracks.find((track) => track.kind !== "asr" && /^\.?en\b/i.test(track.vssId ?? track.languageCode)) ??
    tracks.find((track) => track.kind !== "asr") ??
    tracks.find((track) => /^\.?en\b/i.test(track.vssId ?? track.languageCode)) ??
    tracks[0]
  );
}

function timedTextJsonUrl(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("fmt", "json3");
    return url.toString();
  } catch {
    return null;
  }
}

function parseTimedTextBody(body: string): { segmentCount: number; transcriptText: string } {
  const jsonTranscript = parseTimedTextJson(body);
  if (jsonTranscript.segmentCount > 0) return jsonTranscript;
  return parseTimedTextXml(body);
}

function parseTimedTextJson(body: string): { segmentCount: number; transcriptText: string } {
  try {
    const parsed = JSON.parse(body);
    if (!isRecord(parsed) || !Array.isArray(parsed.events)) return { segmentCount: 0, transcriptText: "" };
    const lines = parsed.events.flatMap((event) => {
      if (!isRecord(event) || !Array.isArray(event.segs)) return [];
      const text = event.segs.flatMap((segment) => isRecord(segment) && typeof segment.utf8 === "string" ? [segment.utf8] : []).join("");
      const normalized = normalizeWhitespace(text);
      if (!normalized) return [];
      const timestamp = typeof event.tStartMs === "number" ? msTimestamp(event.tStartMs) : "";
      return [`${timestamp} ${normalized}`.trim()];
    });
    return { segmentCount: lines.length, transcriptText: lines.join("\n") };
  } catch {
    return { segmentCount: 0, transcriptText: "" };
  }
}

function parseTimedTextXml(body: string): { segmentCount: number; transcriptText: string } {
  const lines = [...body.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/giu)].flatMap((match) => {
    const attrs = match[1] ?? "";
    const rawText = match[2] ?? "";
    const text = normalizeWhitespace(decodeHtmlEntities(rawText.replace(/<[^>]+>/gu, "")));
    if (!text) return [];
    const start = attrs.match(/\bstart="([^"]+)"/u)?.[1];
    const timestamp = start ? secondsTimestamp(Number(start)) : "";
    return [`${timestamp} ${text}`.trim()];
  });
  return { segmentCount: lines.length, transcriptText: lines.join("\n") };
}

function videoTitleFromPlayerResponse(playerResponse: Record<string, unknown>): string | null {
  const details = isRecord(playerResponse.videoDetails) ? playerResponse.videoDetails : {};
  return typeof details.title === "string" && details.title.trim() ? details.title.trim() : null;
}

function msTimestamp(ms: number): string {
  return secondsTimestamp(ms / 1000);
}

function secondsTimestamp(secondsValue: number): string {
  if (!Number.isFinite(secondsValue) || secondsValue < 0) return "";
  const totalSeconds = Math.floor(secondsValue);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&#39;|&apos;/gu, "'");
}

function rejected(captureId: string, exactBlocker: string, summary: string, requestedUrl?: string, artifactDir?: string): Extract<YouTubeTranscriptCaptureResult, { ok: false }> {
  return {
    ok: false,
    status: "rejected",
    captureId,
    ...(artifactDir ? { artifactDir } : {}),
    ...(requestedUrl ? { requestedUrl } : {}),
    exactBlocker,
    summary: redactSensitiveText(summary)
  };
}

function captureFiles(artifactDir: string): YouTubeTranscriptCaptureFiles {
  return {
    manifest: join(artifactDir, "manifest.json"),
    stageOpen: join(artifactDir, "stage-open.json"),
    stageTranscript: join(artifactDir, "stage-transcript.json"),
    pageRedacted: join(artifactDir, "page-redacted.json"),
    transcriptRedacted: join(artifactDir, "transcript-redacted.txt"),
    ingest: join(artifactDir, "ingest.json")
  };
}

function normalizeCapturedAt(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return new Date().toISOString();
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeScalar(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function redactUnknown(value: unknown): string | undefined {
  return typeof value === "string" ? redactSensitiveText(value) : undefined;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

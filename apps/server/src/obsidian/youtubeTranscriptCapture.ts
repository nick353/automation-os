import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeId } from "../db/client.js";
import { ensureYouTubeTranscriptChromeReady, youtubeTranscriptLane } from "../browser/youtubeTranscriptLane.js";
import { runObsidianIngest, type ObsidianIngestResult } from "./ingest.js";
import { redactSensitiveText } from "./redaction.js";
import { guardObsidianVaultPath } from "./vaultGuard.js";

const defaultArtifactRoot = "data/artifacts/youtube-transcript-captures";
const maxExtractionAttemptCount = 3;
const maxRevealAttemptCount = 3;
const cdpOpenTimeoutMs = 15000;
const cdpEvaluateTimeoutMs = 12000;
const cdpCloseTimeoutMs = 5000;

export const transcriptRevealExpression = `(() => {
  const normalizeText = (value) => String(value || "").replace(/\\s+/gu, " ").trim();
  const isTranscriptControl = (element) => {
    const text = normalizeText([element.textContent, element.getAttribute("aria-label"), element.getAttribute("title")].filter(Boolean).join(" "));
    return /show transcript|transcript|文字起こし|トランスクリプト|字幕を表示/iu.test(text);
  };
  const descriptionTranscriptSection = document.querySelector("ytd-video-description-transcript-section-renderer");
  const descriptionTranscriptControl = descriptionTranscriptSection?.querySelector?.("button, yt-button-shape, ytd-button-renderer, #primary-button");
  if (descriptionTranscriptSection instanceof HTMLElement) {
    descriptionTranscriptSection.scrollIntoView({ block: "center" });
  }
  if (descriptionTranscriptControl instanceof HTMLElement) {
    descriptionTranscriptControl.scrollIntoView({ block: "center" });
    const rect = descriptionTranscriptControl.getBoundingClientRect();
    descriptionTranscriptControl.click();
    return {
      title: document.title,
      currentUrl: String(location.href),
      revealAttempted: true,
      revealMethod: "description_transcript_section_click",
      clickTarget: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    };
  }
  const visibleButtons = Array.from(document.querySelectorAll("button, ytd-button-renderer, tp-yt-paper-button"))
    .filter((element) => element instanceof HTMLElement && element.offsetParent !== null);
  const control = visibleButtons.find(isTranscriptControl);
  if (control instanceof HTMLElement) {
    control.click();
  }
  return {
    title: document.title,
    currentUrl: String(location.href),
    revealAttempted: Boolean(control),
    revealMethod: control ? "visible_transcript_control_click" : null
  };
})()`;

export const transcriptExtractionExpression = `(() => {
  const normalizeText = (value) => String(value || "").replace(/\\s+/gu, " ").trim();
  const sampleVisibleText = (selector, label) => Array.from(document.querySelectorAll(selector))
    .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
    .map((element) => normalizeText(element.textContent).slice(0, 240))
    .filter(Boolean)
    .slice(0, 3)
    .map((text) => ({ selector: label, text }));
  const panel = document.querySelector("ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-searchable-transcript']");
  const transcriptRoot = panel?.querySelector?.("ytd-transcript-renderer");
  const segments = [];
  if (transcriptRoot) {
    for (const row of Array.from(transcriptRoot.querySelectorAll("ytd-transcript-segment-renderer"))) {
      const textNode = row.querySelector("yt-formatted-string.segment-text") || row.querySelector(".segment-text");
      const text = normalizeText(textNode?.textContent);
      const timestamp = normalizeText(row.querySelector(".segment-timestamp, [class*='timestamp']")?.textContent);
      if (text) segments.push({ selector: "ytd-transcript-segment-renderer", timestamp, text });
    }
  }
  const headingRoot = transcriptRoot || panel;
  const panelHeadings = headingRoot
    ? Array.from(headingRoot.querySelectorAll("h2, h3, yt-formatted-string"))
        .map((element) => normalizeText(element.textContent))
        .filter((text) => /transcript|文字起こし|トランスクリプト/iu.test(text))
        .slice(0, 5)
    : [];
  return {
    title: document.title,
    currentUrl: String(location.href),
    officialPanelVisible: Boolean(transcriptRoot),
    panelHeadings,
    visibleTextSamples: [
      ...sampleVisibleText("button, ytd-button-renderer, tp-yt-paper-button", "visible_transcript_controls"),
      ...sampleVisibleText("ytd-player-error-message-renderer, .ytp-error-content-wrap", "player_error"),
      ...sampleVisibleText("ytd-consent-bump-v2-lightbox, tp-yt-paper-dialog", "consent_or_dialog")
    ].slice(0, 8),
    segments
  };
})()`;

export type YouTubeTranscriptCdpClient = {
  openUrl(url: string): Promise<{ targetId?: string; webSocketDebuggerUrl?: string }>;
  evaluate(expression: string): Promise<unknown>;
  clickAt?(x: number, y: number): Promise<void>;
  close?(): Promise<void>;
};

export type YouTubeTranscriptCaptureInput = {
  url?: string;
  sourceTitle?: string;
  vaultPath?: string;
  capturedAt?: string;
  artifactRoot?: string;
  cdpClient?: YouTubeTranscriptCdpClient;
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

type ExtractedTranscript = {
  title: string;
  currentUrl: string;
  panelHeadings: string[];
  visibleTextSamples: Array<{ selector: string; text: string }>;
  officialPanelVisible: boolean;
  segments: Array<{ selector: string; timestamp: string; text: string }>;
  transcriptText: string;
  segmentCount: number;
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

  const cdpClient = input.cdpClient ?? createCdpClient();
  try {
    if (!input.cdpClient) {
      const laneReady = await ensureYouTubeTranscriptChromeReady();
      if (!laneReady.ok) {
        writeJson(files.stageOpen, {
          status: "blocked",
          requestedUrl,
          laneName: youtubeTranscriptLane.name,
          cdpPort: youtubeTranscriptLane.port,
          profileDir: youtubeTranscriptLane.profileDir,
          exactBlocker: laneReady.exactBlocker,
          summary: redactSensitiveText(laneReady.summary),
          attempts: laneReady.attempts,
          opened: laneReady.opened ? { pid: laneReady.opened.pid ?? null, url: laneReady.opened.url } : null
        });
        return blocked({
          files,
          manifestBase,
          artifactDir,
          captureId,
          requestedUrl,
          exactBlocker: laneReady.exactBlocker,
          summary: laneReady.summary,
          stage: {
            status: "blocked",
            exactBlocker: laneReady.exactBlocker,
            summary: redactSensitiveText(laneReady.summary),
            requestedUrl,
            laneName: youtubeTranscriptLane.name,
            cdpPort: youtubeTranscriptLane.port,
            profileDir: youtubeTranscriptLane.profileDir,
            attempts: laneReady.attempts
          }
        });
      }
    }
    const opened = await withTimeout(cdpClient.openUrl(parsed.url.toString()), "youtube_transcript_cdp_open_timeout", cdpOpenTimeoutMs);
    writeJson(files.stageOpen, {
      status: "ok",
      requestedUrl,
      laneName: youtubeTranscriptLane.name,
      cdpPort: youtubeTranscriptLane.port,
      targetId: opened.targetId ?? null,
      webSocketDebuggerUrl: opened.webSocketDebuggerUrl ? redactSensitiveText(opened.webSocketDebuggerUrl) : null
    });

    const revealResult = await revealWithBoundedRetry(cdpClient);
    await clickRevealTargetIfSupported(cdpClient, revealResult);
    const firstExtraction = await withTimeout(cdpClient.evaluate(transcriptExtractionExpression), "youtube_transcript_cdp_evaluate_timeout", cdpEvaluateTimeoutMs);
    const extraction = await extractWithBoundedRetry(cdpClient, firstExtraction);
    const currentUrlValidation = validateYouTubeTranscriptUrl(extraction.currentUrl);
    if (!currentUrlValidation.ok) {
      return blocked({
        files,
        manifestBase,
        artifactDir,
        captureId,
        requestedUrl,
        exactBlocker: currentUrlValidation.exactBlocker,
        summary: currentUrlValidation.summary,
        stage: {
          status: "blocked",
          exactBlocker: currentUrlValidation.exactBlocker,
          requestedUrl,
          currentUrl: redactSensitiveText(extraction.currentUrl),
          title: redactSensitiveText(extraction.title),
          reveal: summarizeReveal(revealResult),
          visibleTextSamples: extraction.visibleTextSamples.map((sample) => ({ selector: sample.selector, text: redactSensitiveText(sample.text) })),
          segmentCount: extraction.segmentCount
        }
      });
    }
    if (!extraction.officialPanelVisible || extraction.segmentCount === 0 || !extraction.transcriptText.trim()) {
      const exactBlocker = extraction.officialPanelVisible ? "youtube_transcript_segments_not_visible" : "youtube_transcript_official_panel_not_visible";
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
            reveal: summarizeReveal(revealResult),
            officialPanelVisible: extraction.officialPanelVisible,
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
        exactBlocker,
        summary: extraction.officialPanelVisible
          ? "No visible YouTube transcript segments were found after opening the transcript panel"
          : "The official YouTube transcript panel was not visible after the reveal attempt",
        stage: {
          status: "blocked",
          exactBlocker,
          requestedUrl,
          currentUrl: redactSensitiveText(extraction.currentUrl),
          title: redactSensitiveText(extraction.title),
          reveal: summarizeReveal(revealResult),
          officialPanelVisible: extraction.officialPanelVisible,
          panelHeadings: extraction.panelHeadings,
          visibleTextSamples: extraction.visibleTextSamples.map((sample) => ({ selector: sample.selector, text: redactSensitiveText(sample.text) })),
          segmentCount: extraction.segmentCount,
          publicCaptionFallback: {
            status: "blocked",
            exactBlocker: fallback.exactBlocker,
            summary: fallback.summary,
            transcriptEndpoint: fallback.transcriptEndpoint
          }
        }
      });
    }

    return persistCapturedTranscript({
      input,
      vaultPath: vaultGuard.vaultPath,
      files,
      manifestBase,
      artifactDir,
      captureId,
      requestedUrl,
      currentUrl: extraction.currentUrl,
      sourceTitle: extraction.title,
      transcriptText: extraction.transcriptText,
      segmentCount: extraction.segmentCount,
      capturedAt,
      extractionMethods: ["document.title", "location.href", "visible transcript panel selectors"],
      stage: {
        status: "ok",
        requestedUrl,
        currentUrl: redactSensitiveText(extraction.currentUrl),
        title: redactSensitiveText((normalizeScalar(input.sourceTitle) ?? extraction.title) || "YouTube transcript capture"),
        reveal: summarizeReveal(revealResult),
        panelHeadings: extraction.panelHeadings.map(redactSensitiveText),
        segmentCount: extraction.segmentCount
      }
    });
  } catch (error) {
    const summary = error instanceof Error ? error.message : "CDP transcript capture failed";
    const exactBlocker = runtimeExactBlocker(summary);
    if (!existsSync(files.stageOpen)) {
      writeJson(files.stageOpen, { status: "blocked", requestedUrl, laneName: youtubeTranscriptLane.name, cdpPort: youtubeTranscriptLane.port, exactBlocker });
    }
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
          cdpFallbackFrom: exactBlocker,
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
      exactBlocker,
      summary: redactSensitiveText(summary),
      stage: {
        status: "blocked",
        exactBlocker,
        summary: redactSensitiveText(summary),
        requestedUrl,
        publicCaptionFallback: {
          status: "blocked",
          exactBlocker: fallback.exactBlocker,
          summary: fallback.summary,
          transcriptEndpoint: fallback.transcriptEndpoint
        }
      }
    });
  } finally {
    const closePromise = cdpClient.close?.();
    if (closePromise) await withTimeout(closePromise, "youtube_transcript_cdp_close_timeout", cdpCloseTimeoutMs).catch(() => undefined);
  }
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

function createCdpClient(): YouTubeTranscriptCdpClient {
  return new ChromeCdpClient();
}

class ChromeCdpClient implements YouTubeTranscriptCdpClient {
  private transport?: CdpWebSocketTransport;

  async openUrl(url: string): Promise<{ targetId?: string; webSocketDebuggerUrl?: string }> {
    const target = await openCdpTarget(url);
    const wsUrl = typeof target.webSocketDebuggerUrl === "string" ? target.webSocketDebuggerUrl : undefined;
    if (!wsUrl) throw new Error("youtube_transcript_cdp_target_missing_websocket");
      this.transport = await CdpWebSocketTransport.connect(wsUrl, cdpOpenTimeoutMs);
      await this.transport.send("Runtime.enable", undefined, cdpEvaluateTimeoutMs);
    return { targetId: typeof target.id === "string" ? target.id : undefined, webSocketDebuggerUrl: wsUrl };
  }

  async evaluate(expression: string): Promise<unknown> {
    if (!this.transport) throw new Error("youtube_transcript_cdp_not_connected");
    await delay(1200);
    const envelope = await this.transport.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, cdpEvaluateTimeoutMs);
    return parseRuntimeEvaluateByValue(envelope);
  }

  async clickAt(x: number, y: number): Promise<void> {
    if (!this.transport) throw new Error("youtube_transcript_cdp_not_connected");
    await this.transport.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, cdpEvaluateTimeoutMs);
    await this.transport.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, cdpEvaluateTimeoutMs);
    await this.transport.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, cdpEvaluateTimeoutMs);
    await delay(1200);
  }

  async close(): Promise<void> {
    await this.transport?.close();
  }
}

class CdpWebSocketTransport {
  private id = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  private constructor(private readonly socket: WebSocketLike) {}

  static connect(url: string, timeoutMs: number): Promise<CdpWebSocketTransport> {
    const WebSocketCtor = globalThis.WebSocket as WebSocketConstructor | undefined;
    if (!WebSocketCtor) return Promise.reject(new Error("youtube_transcript_websocket_unavailable"));
    return new Promise((resolveConnect, rejectConnect) => {
      const socket = new WebSocketCtor(url) as WebSocketLike;
      const transport = new CdpWebSocketTransport(socket);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        rejectConnect(new Error("youtube_transcript_websocket_connect_timeout"));
      }, timeoutMs);
      socket.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveConnect(transport);
      }, { once: true });
      socket.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectConnect(new Error("youtube_transcript_websocket_connect_failed"));
      }, { once: true });
      socket.addEventListener("message", (event) => transport.onMessage(event));
      socket.addEventListener("close", () => transport.rejectAll(new Error("youtube_transcript_websocket_closed")));
    });
  }

  send(method: string, params?: Record<string, unknown>, timeoutMs = cdpEvaluateTimeoutMs): Promise<unknown> {
    const id = ++this.id;
    const message = JSON.stringify({ id, method, params });
    return new Promise((resolveSend, rejectSend) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new Error("youtube_transcript_cdp_send_timeout"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveSend(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectSend(error);
        }
      });
      this.socket.send(message);
    });
  }

  async close(): Promise<void> {
    this.rejectAll(new Error("youtube_transcript_websocket_closed"));
    this.socket.close();
  }

  private onMessage(event: { data: unknown }): void {
    const text = typeof event.data === "string" ? event.data : Buffer.isBuffer(event.data) ? event.data.toString("utf8") : "";
    if (!text) return;
    const message = JSON.parse(text) as { id?: number; result?: unknown; error?: { message?: string } };
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

export function parseRuntimeEvaluateByValue(envelope: unknown): unknown {
  if (!isRecord(envelope) || !hasOwn(envelope, "result")) throw new Error("youtube_transcript_runtime_evaluate_missing_result");
  const evaluateResult = envelope.result;
  if (!isRecord(evaluateResult)) throw new Error("youtube_transcript_runtime_evaluate_missing_result");
  if (evaluateResult.exceptionDetails !== undefined) throw new Error("youtube_transcript_runtime_evaluate_exception");
  if (!hasOwn(evaluateResult, "result") || !isRecord(evaluateResult.result)) throw new Error("youtube_transcript_runtime_evaluate_missing_remote_object");
  const remoteObject = evaluateResult.result;
  if (hasOwn(remoteObject, "value")) return remoteObject.value;
  if (typeof remoteObject.objectId === "string" && remoteObject.objectId.trim()) throw new Error("youtube_transcript_runtime_evaluate_object_id_only");
  return undefined;
}

async function openCdpTarget(url: string): Promise<Record<string, unknown>> {
  const encoded = encodeURIComponent(url);
  const endpoint = `http://127.0.0.1:${youtubeTranscriptLane.port}/json/new?${encoded}`;
  let response = await fetch(endpoint, { method: "PUT" });
  if (response.status === 405 || response.status === 404) response = await fetch(endpoint);
  if (!response.ok) throw new Error(`youtube_transcript_cdp_new_target_http_${response.status}`);
  return await response.json() as Record<string, unknown>;
}

async function extractWithBoundedRetry(cdpClient: YouTubeTranscriptCdpClient, firstValue: unknown): Promise<ExtractedTranscript> {
  let extracted = normalizeExtractedTranscript(firstValue);
  let attempts = 1;
  while (extracted.segmentCount === 0 && attempts < maxExtractionAttemptCount) {
    extracted = normalizeExtractedTranscript(await withTimeout(cdpClient.evaluate(transcriptExtractionExpression), "youtube_transcript_cdp_evaluate_timeout", cdpEvaluateTimeoutMs));
    attempts += 1;
  }
  return extracted;
}

async function revealWithBoundedRetry(cdpClient: YouTubeTranscriptCdpClient): Promise<unknown> {
  let result: unknown;
  for (let attempt = 1; attempt <= maxRevealAttemptCount; attempt += 1) {
    result = await withTimeout(cdpClient.evaluate(transcriptRevealExpression), "youtube_transcript_cdp_evaluate_timeout", cdpEvaluateTimeoutMs);
    if (summarizeReveal(result).revealAttempted) return result;
    if (attempt < maxRevealAttemptCount) await delay(800);
  }
  return result;
}

async function clickRevealTargetIfSupported(cdpClient: YouTubeTranscriptCdpClient, revealResult: unknown): Promise<void> {
  if (!cdpClient.clickAt) return;
  const page = isRecord(revealResult) ? revealResult : {};
  const target = isRecord(page.clickTarget) ? page.clickTarget : undefined;
  const x = typeof target?.x === "number" ? target.x : undefined;
  const y = typeof target?.y === "number" ? target.y : undefined;
  if (x === undefined || y === undefined) return;
  await withTimeout(cdpClient.clickAt(x, y), "youtube_transcript_cdp_click_timeout", cdpEvaluateTimeoutMs);
}

function normalizeExtractedTranscript(value: unknown): ExtractedTranscript {
  const page = isRecord(value) ? value : {};
  const rawSegments = Array.isArray(page.segments) ? page.segments : [];
  const seen = new Set<string>();
  const segments = rawSegments.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const text = normalizeWhitespace(typeof entry.text === "string" ? entry.text : "");
    const timestamp = normalizeWhitespace(typeof entry.timestamp === "string" ? entry.timestamp : "");
    const selector = normalizeWhitespace(typeof entry.selector === "string" ? entry.selector : "");
    if (!text || !selector || !isAllowedSegmentSelector(selector)) return [];
    const key = `${timestamp}\0${text}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ selector, timestamp, text }];
  });
  const transcriptText = segments.map((segment) => segment.timestamp ? `${segment.timestamp} ${segment.text}` : segment.text).join("\n");
  return {
    title: typeof page.title === "string" ? page.title : "",
    currentUrl: typeof page.currentUrl === "string" ? page.currentUrl : "",
    panelHeadings: Array.isArray(page.panelHeadings) ? page.panelHeadings.filter((item): item is string => typeof item === "string").slice(0, 5) : [],
    visibleTextSamples: normalizeVisibleTextSamples(page.visibleTextSamples),
    officialPanelVisible: Boolean(page.officialPanelVisible),
    segments,
    transcriptText,
    segmentCount: segments.length
  };
}

function isAllowedSegmentSelector(selector: string): boolean {
  return [
    "ytd-transcript-segment-renderer"
  ].includes(selector);
}

function summarizeReveal(value: unknown) {
  const page = isRecord(value) ? value : {};
  return {
    currentUrl: redactSensitiveText(typeof page.currentUrl === "string" ? page.currentUrl : ""),
    revealAttempted: Boolean(page.revealAttempted),
    revealMethod: typeof page.revealMethod === "string" ? page.revealMethod : null
  };
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
    const watchResponse = await fetchWithTimeout(input.fetchImpl, input.url.toString(), "youtube_public_captions_watch_timeout", cdpEvaluateTimeoutMs);
    if (!watchResponse.ok) return { ok: false, exactBlocker: `youtube_public_captions_watch_http_${watchResponse.status}`, summary: `watch page returned HTTP ${watchResponse.status}` };
    const watchHtml = await withTimeout(watchResponse.text(), "youtube_public_captions_watch_timeout", cdpEvaluateTimeoutMs);
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
    const captionResponse = await fetchWithTimeout(input.fetchImpl, captionUrl, "youtube_public_captions_timedtext_timeout", cdpEvaluateTimeoutMs);
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
    const captionBody = await withTimeout(captionResponse.text(), "youtube_public_captions_timedtext_timeout", cdpEvaluateTimeoutMs);
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

function runtimeExactBlocker(summary: string): string {
  if (/runtime_evaluate_object_id_only/.test(summary)) return "youtube_transcript_runtime_evaluate_object_id_only";
  if (/runtime_evaluate_exception/.test(summary)) return "youtube_transcript_runtime_evaluate_exception";
  if (/timeout/i.test(summary)) return "youtube_transcript_cdp_timeout";
  if (/fetch failed|cdp_unavailable|connection refused/i.test(summary)) return "youtube_transcript_cdp_unavailable";
  if (/websocket|cdp|target/i.test(summary)) return "youtube_transcript_cdp_failed";
  return "youtube_transcript_capture_failed";
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

function normalizeVisibleTextSamples(value: unknown): Array<{ selector: string; text: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const selector = normalizeWhitespace(typeof entry.selector === "string" ? entry.selector : "");
    const text = normalizeWhitespace(typeof entry.text === "string" ? entry.text : "").slice(0, 240);
    return selector && text ? [{ selector, text }] : [];
  }).slice(0, 8);
}

function redactUnknown(value: unknown): string | undefined {
  return typeof value === "string" ? redactSensitiveText(value) : undefined;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

type WebSocketConstructor = new (url: string) => WebSocketLike;
type WebSocketLike = {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "error" | "close", listener: () => void, options?: { once?: boolean }): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
};

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { makeId } from "../db/client.js";
import { xLearningLane } from "../browser/xLearningLane.js";
import { runObsidianIngest, type ObsidianIngestResult } from "./ingest.js";
import { redactSensitiveText } from "./redaction.js";
import { guardObsidianVaultPath } from "./vaultGuard.js";

const defaultArtifactRoot = "data/artifacts/authenticated-browser-captures";
const extractionExpression = `(() => {
  const normalizeText = (value) => String(value || "").replace(/\\s+/gu, " ").trim();
  const primarySelector = "article [data-testid='tweetText']";
  const primaryCandidates = Array.from(document.querySelectorAll(primarySelector)).map((element) => ({
    method: "data-testid=tweetText",
    selector: primarySelector,
    text: normalizeText(element.innerText)
  }));
  const textCandidates = primaryCandidates.some((candidate) => candidate.text)
    ? primaryCandidates
    : Array.from(document.querySelectorAll("article")).map((element) => ({
      method: "article.innerText:fallback",
      selector: "article",
      text: normalizeText(element.innerText)
    }));
  return {
    title: document.title,
    currentUrl: String(location.href),
    textCandidates
  };
})()`;

type ExtractedTextCandidate = {
  method: string;
  selector: string;
  text: string;
};

type ExtractedPage = {
  title: string;
  currentUrl: string;
  textCandidates: ExtractedTextCandidate[];
  captureText: string;
  extractionMethods: string[];
  candidateStats: ExtractedCandidateStats;
};

type ExtractedCandidateStats = {
  rawCandidateCount: number;
  acceptedCandidateCount: number;
  emptyTextCandidateCount: number;
  nonAllowlistedCandidateCount: number;
  duplicateCandidateCount: number;
};

type NormalizedTextCandidates = {
  candidates: ExtractedTextCandidate[];
  stats: ExtractedCandidateStats;
};

type ExtractionAttemptSummary = {
  attempt: number;
  currentUrl: string;
  currentUrlValid: boolean;
  currentUrlBlocker: string | null;
  candidateStats: ExtractedCandidateStats;
  wouldBlocker: string | null;
};

type ExtractionRetryResult = {
  extracted: ExtractedPage;
  extractionAttemptCount: number;
  extractionAttempts: ExtractionAttemptSummary[];
};

const allowedTextCandidatePairs = new Set([
  "data-testid=tweetText\0article [data-testid='tweetText']",
  "article.innerText:fallback\0article"
]);
const reservedTwitterPathSegments = new Set(["bookmarks", "compose", "explore", "home", "i", "intent", "messages", "notifications", "search", "settings", "status"]);
const maxExtractionAttemptCount = 3;

export type AuthenticatedBrowserCaptureInput = {
  url?: string;
  sourceTitle?: string;
  vaultPath?: string;
  capturedAt?: string;
  artifactRoot?: string;
  cdpClient?: AuthenticatedBrowserCdpClient;
};

export type AuthenticatedBrowserCdpClient = {
  openUrl(url: string): Promise<{ targetId?: string; webSocketDebuggerUrl?: string }>;
  evaluate(expression: string): Promise<unknown>;
  close?(): Promise<void>;
};

export type AuthenticatedBrowserCaptureResult =
  | {
      ok: true;
      status: "captured";
      captureId: string;
      artifactDir: string;
      requestedUrl: string;
      currentUrl: string;
      sourceTitle: string;
      files: AuthenticatedBrowserCaptureFiles;
      ingest: Extract<ObsidianIngestResult, { ok: true }>;
    }
  | {
      ok: false;
      status: "blocked" | "rejected";
      captureId: string;
      artifactDir?: string;
      requestedUrl?: string;
      exactBlocker: string;
      summary: string;
      files?: Partial<AuthenticatedBrowserCaptureFiles>;
      ingest?: ObsidianIngestResult;
    };

export type AuthenticatedBrowserCaptureFiles = {
  manifest: string;
  stageOpen: string;
  stageExtract: string;
  pageRedacted: string;
  bodyRedacted: string;
  ingest: string;
};

export async function runAuthenticatedBrowserCapture(input: AuthenticatedBrowserCaptureInput): Promise<AuthenticatedBrowserCaptureResult> {
  const captureId = makeId("xauth_capture");
  const capturedAt = normalizeCapturedAt(input.capturedAt);
  if (!capturedAt) return rejected(captureId, "x_auth_capture_captured_at_invalid", "capturedAt must be an ISO-compatible timestamp", redactUnknown(input.url));

  const parsed = validateCaptureUrl(input.url);
  if (!parsed.ok) return rejected(captureId, parsed.exactBlocker, parsed.summary, redactUnknown(input.url));

  const vaultGuard = guardObsidianVaultPath(input.vaultPath);
  if (!vaultGuard.ok) return rejected(captureId, vaultGuard.error, vaultGuard.summary, redactSensitiveText(parsed.url.toString()), vaultGuard.vaultPath);

  const artifactDir = resolve(input.artifactRoot ?? defaultArtifactRoot, captureId);
  mkdirSync(artifactDir, { recursive: true });
  const files = captureFiles(artifactDir);
  const requestedUrl = redactSensitiveText(parsed.url.toString());
  const manifestBase = {
    captureId,
    laneName: xLearningLane.name,
    cdpPort: xLearningLane.port,
    profileDir: xLearningLane.profileDir,
    requestedUrl,
    artifactDir,
    createdAt: capturedAt,
    files
  };

  const cdpClient = input.cdpClient ?? createCdpClient();
  let opened: Awaited<ReturnType<AuthenticatedBrowserCdpClient["openUrl"]>>;
  try {
    opened = await cdpClient.openUrl(parsed.url.toString());
  } catch (error) {
    const summary = error instanceof Error ? error.message : "CDP open failed";
    writeJson(files.stageOpen, { status: "blocked", exactBlocker: "x_auth_capture_cdp_open_failed", summary: redactSensitiveText(summary), requestedUrl });
    writeJson(files.manifest, { ...manifestBase, status: "blocked", exactBlocker: "x_auth_capture_cdp_open_failed" });
    return { ok: false, status: "blocked", captureId, artifactDir, requestedUrl, exactBlocker: "x_auth_capture_cdp_open_failed", summary: redactSensitiveText(summary), files };
  }

  writeJson(files.stageOpen, {
    status: "ok",
    requestedUrl,
    laneName: xLearningLane.name,
    cdpPort: xLearningLane.port,
    targetId: opened.targetId ?? null,
    webSocketDebuggerUrl: opened.webSocketDebuggerUrl ? redactSensitiveText(opened.webSocketDebuggerUrl) : null
  });

  try {
    const extractionResult = await extractWithBoundedNoTextRetry(cdpClient, await cdpClient.evaluate(extractionExpression));
    const { extracted, extractionAttemptCount, extractionAttempts } = extractionResult;
    const currentUrlValidation = validateCaptureUrl(extracted.currentUrl);
    if (!currentUrlValidation.ok) {
      writeJson(files.stageExtract, {
        status: "blocked",
        exactBlocker: currentUrlValidation.exactBlocker,
        summary: currentUrlValidation.summary,
        requestedUrl,
        currentUrl: redactSensitiveText(extracted.currentUrl),
        candidateStats: extracted.candidateStats,
        extractionMethods: extracted.extractionMethods,
        extractionAttemptCount,
        extractionAttempts
      });
      writeJson(files.manifest, {
        ...manifestBase,
        status: "blocked",
        exactBlocker: currentUrlValidation.exactBlocker,
        currentUrl: redactSensitiveText(extracted.currentUrl),
        candidateStats: extracted.candidateStats,
        extractionAttemptCount,
        extractionAttempts
      });
      return { ok: false, status: "blocked", captureId, artifactDir, requestedUrl, exactBlocker: currentUrlValidation.exactBlocker, summary: currentUrlValidation.summary, files };
    }

    const redactedTitle = redactSensitiveText((normalizeScalar(input.sourceTitle) ?? extracted.title) || "X authenticated browser capture");
    const redactedCurrentUrl = redactSensitiveText(extracted.currentUrl);
    const bodySource = extracted.captureText;
    const redactedBody = redactSensitiveText(bodySource);
    const candidateBlocker = textCandidateExactBlocker(extracted.candidateStats, redactedBody);
    if (candidateBlocker) {
      writeJson(files.stageExtract, {
        status: "blocked",
        exactBlocker: candidateBlocker,
        summary: textCandidateBlockerSummary(candidateBlocker),
        requestedUrl,
        currentUrl: redactedCurrentUrl,
        candidateStats: extracted.candidateStats,
        extractionMethods: extracted.extractionMethods,
        extractionAttemptCount,
        extractionAttempts
      });
      writeJson(files.manifest, {
        ...manifestBase,
        status: "blocked",
        exactBlocker: candidateBlocker,
        currentUrl: redactedCurrentUrl,
        candidateStats: extracted.candidateStats,
        extractionAttemptCount,
        extractionAttempts
      });
      return {
        ok: false,
        status: "blocked",
        captureId,
        artifactDir,
        requestedUrl,
        exactBlocker: candidateBlocker,
        summary: textCandidateBlockerSummary(candidateBlocker),
        files
      };
    }

    const screenshot = {
      status: "skipped",
      exactBlocker: "x_auth_capture_screenshot_skipped_dom_redaction_not_proven",
      summary: "Screenshot was skipped because sidebar, account, and media redaction was not proven before artifact save."
    };
    writeJson(files.stageExtract, {
      status: "ok",
      requestedUrl,
      currentUrl: redactedCurrentUrl,
      title: redactedTitle,
      bodyTextBytes: Buffer.byteLength(redactedBody),
      candidateStats: extracted.candidateStats,
      extractionMethods: extracted.extractionMethods,
      extractionAttemptCount,
      extractionAttempts,
      screenshot
    });
    writeJson(files.pageRedacted, {
      captureId,
      requestedUrl,
      currentUrl: redactedCurrentUrl,
      title: redactedTitle,
      bodyText: redactedBody
    });
    writeFileSync(files.bodyRedacted, redactedBody, "utf8");

    const ingest = runObsidianIngest({
      vaultPath: vaultGuard.vaultPath,
      sourceUrl: redactedCurrentUrl,
      sourceTitle: redactedTitle,
      sourceType: "authenticated_browser_capture",
      text: [
        `Capture ID: ${captureId}`,
        `Lane: ${xLearningLane.name}`,
        `Artifact directory: ${artifactDir}`,
        "",
        redactedBody
      ].join("\n"),
      capturedAt
    });
    writeJson(files.ingest, ingest);
    if (!ingest.ok) {
      writeJson(files.manifest, {
        ...manifestBase,
        status: "blocked",
        exactBlocker: ingest.error,
        currentUrl: redactedCurrentUrl,
        candidateStats: extracted.candidateStats,
        extractionMethods: extracted.extractionMethods,
        extractionAttemptCount,
        extractionAttempts
      });
      return { ok: false, status: "blocked", captureId, artifactDir, requestedUrl, exactBlocker: ingest.error, summary: ingest.summary, files, ingest };
    }

    writeJson(files.manifest, {
      ...manifestBase,
      status: "captured",
      currentUrl: redactedCurrentUrl,
      sourceTitle: redactedTitle,
      ingestFile: ingest.path,
      candidateStats: extracted.candidateStats,
      extractionMethods: extracted.extractionMethods,
      extractionAttemptCount,
      extractionAttempts,
      screenshot
    });
    return {
      ok: true,
      status: "captured",
      captureId,
      artifactDir,
      requestedUrl,
      currentUrl: redactedCurrentUrl,
      sourceTitle: redactedTitle,
      files,
      ingest
    };
  } catch (error) {
    const summary = error instanceof Error ? error.message : "CDP extraction failed";
    const exactBlocker = runtimeEvaluateExactBlocker(summary) ?? "x_auth_capture_cdp_extract_failed";
    writeJson(files.stageExtract, { status: "blocked", exactBlocker, summary: redactSensitiveText(summary), requestedUrl });
    writeJson(files.manifest, { ...manifestBase, status: "blocked", exactBlocker });
    return { ok: false, status: "blocked", captureId, artifactDir, requestedUrl, exactBlocker, summary: redactSensitiveText(summary), files };
  } finally {
    await cdpClient.close?.().catch(() => undefined);
  }
}

export function validateCaptureUrl(value: unknown):
  | { ok: true; url: URL }
  | { ok: false; exactBlocker: string; summary: string } {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, exactBlocker: "x_auth_capture_url_required", summary: "url is required" };
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, exactBlocker: "x_auth_capture_url_invalid", summary: "url must be a valid absolute URL" };
  }
  if (url.protocol !== "https:") {
    return { ok: false, exactBlocker: "x_auth_capture_scheme_blocked", summary: "only https X/Twitter URLs are allowed" };
  }
  if (!isAllowedTwitterHost(url.hostname)) {
    return { ok: false, exactBlocker: "x_auth_capture_host_blocked", summary: "only X/Twitter hosts are allowed" };
  }
  if (isForbiddenTwitterPath(url.pathname)) {
    return { ok: false, exactBlocker: "x_auth_capture_forbidden_path", summary: "capture URL points to a posting, DM, settings, notification, or home surface" };
  }
  if (!isAllowedTwitterReadPath(url.pathname)) {
    return { ok: false, exactBlocker: "x_auth_capture_unsupported_read_path", summary: "only X/Twitter status or thread read URLs are allowed" };
  }
  return { ok: true, url };
}

function createCdpClient(): AuthenticatedBrowserCdpClient {
  return new ChromeCdpClient();
}

class ChromeCdpClient implements AuthenticatedBrowserCdpClient {
  private transport?: CdpWebSocketTransport;

  async openUrl(url: string): Promise<{ targetId?: string; webSocketDebuggerUrl?: string }> {
    const target = await openCdpTarget(url);
    const wsUrl = typeof target.webSocketDebuggerUrl === "string" ? target.webSocketDebuggerUrl : undefined;
    if (!wsUrl) throw new Error("x_auth_capture_cdp_target_missing_websocket");
    this.transport = await CdpWebSocketTransport.connect(wsUrl);
    await this.transport.send("Runtime.enable");
    return {
      targetId: typeof target.id === "string" ? target.id : undefined,
      webSocketDebuggerUrl: wsUrl
    };
  }

  async evaluate(expression: string): Promise<unknown> {
    if (!this.transport) throw new Error("x_auth_capture_cdp_not_connected");
    await delay(1200);
    const envelope = await this.transport.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    return parseRuntimeEvaluateByValue(envelope);
  }

  async close(): Promise<void> {
    await this.transport?.close();
  }
}

class CdpWebSocketTransport {
  private id = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  private constructor(private readonly socket: WebSocketLike) {}

  static connect(url: string): Promise<CdpWebSocketTransport> {
    const WebSocketCtor = globalThis.WebSocket as WebSocketConstructor | undefined;
    if (!WebSocketCtor) return Promise.reject(new Error("x_auth_capture_websocket_unavailable"));
    return new Promise((resolveConnect, rejectConnect) => {
      const socket = new WebSocketCtor(url) as WebSocketLike;
      const transport = new CdpWebSocketTransport(socket);
      socket.addEventListener("open", () => resolveConnect(transport), { once: true });
      socket.addEventListener("error", () => rejectConnect(new Error("x_auth_capture_websocket_connect_failed")), { once: true });
      socket.addEventListener("message", (event) => transport.onMessage(event));
      socket.addEventListener("close", () => transport.rejectAll(new Error("x_auth_capture_websocket_closed")));
    });
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
    this.rejectAll(new Error("x_auth_capture_websocket_closed"));
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
  if (!isRecord(envelope) || !hasOwn(envelope, "result")) {
    throw new Error("x_auth_capture_runtime_evaluate_missing_result");
  }

  const evaluateResult = envelope.result;
  if (!isRecord(evaluateResult)) {
    throw new Error("x_auth_capture_runtime_evaluate_missing_result");
  }

  if (evaluateResult.exceptionDetails !== undefined) {
    throw new Error("x_auth_capture_runtime_evaluate_exception");
  }

  if (!hasOwn(evaluateResult, "result") || !isRecord(evaluateResult.result)) {
    throw new Error("x_auth_capture_runtime_evaluate_missing_remote_object");
  }

  const remoteObject = evaluateResult.result;
  if (hasOwn(remoteObject, "value")) return remoteObject.value;
  if (typeof remoteObject.objectId === "string" && remoteObject.objectId.trim()) {
    throw new Error("x_auth_capture_runtime_evaluate_object_id_only");
  }
  return undefined;
}

type WebSocketConstructor = new (url: string) => WebSocketLike;
type WebSocketLike = {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "error" | "close", listener: () => void, options?: { once?: boolean }): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
};

async function openCdpTarget(url: string): Promise<Record<string, unknown>> {
  const encoded = encodeURIComponent(url);
  const endpoint = `http://127.0.0.1:${xLearningLane.port}/json/new?${encoded}`;
  let response = await fetch(endpoint, { method: "PUT" });
  if (response.status === 405 || response.status === 404) response = await fetch(endpoint);
  if (!response.ok) throw new Error(`x_auth_capture_cdp_new_target_http_${response.status}`);
  return await response.json() as Record<string, unknown>;
}

function normalizeExtractedPage(value: unknown): ExtractedPage {
  const page = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const { candidates: textCandidates, stats } = normalizeTextCandidates(page.textCandidates);
  return {
    title: typeof page.title === "string" ? page.title : "",
    currentUrl: typeof page.currentUrl === "string" ? page.currentUrl : "",
    textCandidates,
    captureText: textCandidates.map((candidate) => candidate.text).join("\n\n"),
    extractionMethods: ["document.title", "location.href", ...new Set(textCandidates.map((candidate) => candidate.method))],
    candidateStats: stats
  };
}

async function extractWithBoundedNoTextRetry(cdpClient: AuthenticatedBrowserCdpClient, firstValue: unknown): Promise<ExtractionRetryResult> {
  let extracted = normalizeExtractedPage(firstValue);
  const extractionAttempts: ExtractionAttemptSummary[] = [summarizeExtractionAttempt(1, extracted)];

  while (shouldRetryNoTextExtraction(extracted) && extractionAttempts.length < maxExtractionAttemptCount) {
    extracted = normalizeExtractedPage(await cdpClient.evaluate(extractionExpression));
    extractionAttempts.push(summarizeExtractionAttempt(extractionAttempts.length + 1, extracted));
  }

  return {
    extracted,
    extractionAttemptCount: extractionAttempts.length,
    extractionAttempts
  };
}

function shouldRetryNoTextExtraction(extracted: ExtractedPage): boolean {
  return validateCaptureUrl(extracted.currentUrl).ok && extracted.candidateStats.rawCandidateCount === 0;
}

function summarizeExtractionAttempt(attempt: number, extracted: ExtractedPage): ExtractionAttemptSummary {
  const currentUrlValidation = validateCaptureUrl(extracted.currentUrl);
  const redactedBody = redactSensitiveText(extracted.captureText);
  const candidateBlocker = currentUrlValidation.ok ? textCandidateExactBlocker(extracted.candidateStats, redactedBody) : undefined;
  return {
    attempt,
    currentUrl: redactSensitiveText(extracted.currentUrl),
    currentUrlValid: currentUrlValidation.ok,
    currentUrlBlocker: currentUrlValidation.ok ? null : currentUrlValidation.exactBlocker,
    candidateStats: extracted.candidateStats,
    wouldBlocker: currentUrlValidation.ok ? candidateBlocker ?? null : currentUrlValidation.exactBlocker
  };
}

function normalizeTextCandidates(value: unknown): NormalizedTextCandidates {
  const stats: ExtractedCandidateStats = {
    rawCandidateCount: Array.isArray(value) ? value.length : 0,
    acceptedCandidateCount: 0,
    emptyTextCandidateCount: 0,
    nonAllowlistedCandidateCount: 0,
    duplicateCandidateCount: 0
  };
  if (!Array.isArray(value)) return { candidates: [], stats };
  const seen = new Set<string>();
  const candidates: ExtractedTextCandidate[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const text = normalizeWhitespace(typeof candidate.text === "string" ? candidate.text : "");
    if (!text) {
      stats.emptyTextCandidateCount += 1;
      continue;
    }
    const method = normalizeScalar(candidate.method);
    const selector = normalizeScalar(candidate.selector);
    if (!method || !selector || !isAllowedTextCandidate(method, selector)) {
      stats.nonAllowlistedCandidateCount += 1;
      continue;
    }
    if (seen.has(text)) {
      stats.duplicateCandidateCount += 1;
      continue;
    }
    seen.add(text);
    candidates.push({
      method,
      selector,
      text
    });
  }
  stats.acceptedCandidateCount = candidates.length;
  return { candidates, stats };
}

function isAllowedTextCandidate(method: string, selector: string): boolean {
  return allowedTextCandidatePairs.has(`${method}\0${selector}`);
}

function textCandidateExactBlocker(stats: ExtractedCandidateStats, redactedBody: string): string | undefined {
  if (stats.nonAllowlistedCandidateCount > 0) return "x_auth_capture_non_allowlisted_text_candidates";
  if (redactedBody.trim()) return undefined;
  if (stats.rawCandidateCount === 0) return "x_auth_capture_no_text_candidates";
  if (stats.acceptedCandidateCount === 0 && stats.emptyTextCandidateCount > 0) return "x_auth_capture_empty_text_candidates";
  return "x_auth_capture_allowlist_container_empty";
}

function textCandidateBlockerSummary(exactBlocker: string): string {
  if (exactBlocker === "x_auth_capture_no_text_candidates") return "No tweet or thread body candidate containers were found on the authenticated X/Twitter page";
  if (exactBlocker === "x_auth_capture_non_allowlisted_text_candidates") return "Only non-allowlisted X/Twitter text candidates were found; no body text was saved";
  if (exactBlocker === "x_auth_capture_empty_text_candidates") return "Allowlisted X/Twitter body candidate containers were empty";
  return "No tweet or thread body text was available from the allowlisted X/Twitter containers";
}

function captureFiles(artifactDir: string): AuthenticatedBrowserCaptureFiles {
  return {
    manifest: join(artifactDir, "manifest.json"),
    stageOpen: join(artifactDir, "stage-open.json"),
    stageExtract: join(artifactDir, "stage-extract.json"),
    pageRedacted: join(artifactDir, "page-redacted.json"),
    bodyRedacted: join(artifactDir, "body-redacted.txt"),
    ingest: join(artifactDir, "ingest.json")
  };
}

function isAllowedTwitterHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "x.com" || host === "twitter.com";
}

function isForbiddenTwitterPath(pathname: string): boolean {
  const path = normalizeTwitterPath(pathname);
  return path === "/" || path === "/home" || path.startsWith("/home/")
    || path === "/intent" || path.startsWith("/intent/")
    || path.startsWith("/compose")
    || path.startsWith("/i/flow")
    || path.startsWith("/settings")
    || path.startsWith("/messages")
    || path.startsWith("/notifications");
}

function isAllowedTwitterReadPath(pathname: string): boolean {
  const path = normalizeTwitterPath(pathname).replace(/\/$/u, "");
  if (/^\/i\/web\/status\/\d+$/u.test(path)) return true;
  const match = path.match(/^\/([a-z0-9_]{1,15})\/status\/\d+$/u);
  return Boolean(match && !reservedTwitterPathSegments.has(match[1]));
}

function normalizeTwitterPath(pathname: string): string {
  return pathname.toLowerCase().replace(/\/+/gu, "/");
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeScalar(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function runtimeEvaluateExactBlocker(value: string): string | undefined {
  return value.startsWith("x_auth_capture_runtime_evaluate_") ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function normalizeCapturedAt(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return new Date().toISOString();
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || Number.isNaN(Date.parse(trimmed))) return undefined;
  return trimmed;
}

function redactUnknown(value: unknown): string | undefined {
  return typeof value === "string" ? redactSensitiveText(value) : undefined;
}

function rejected(captureId: string, exactBlocker: string, summary: string, requestedUrl?: string, vaultPath?: string): Extract<AuthenticatedBrowserCaptureResult, { status: "rejected" }> {
  return {
    ok: false,
    status: "rejected",
    captureId,
    exactBlocker,
    summary: redactSensitiveText(summary),
    requestedUrl,
    vaultPath
  } as Extract<AuthenticatedBrowserCaptureResult, { status: "rejected" }> & { vaultPath?: string };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

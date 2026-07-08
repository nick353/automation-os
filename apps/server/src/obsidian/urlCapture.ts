import { lookup } from "node:dns/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { makeId, nowIso } from "../db/client.js";
import { runObsidianIngest, type ObsidianIngestResult } from "./ingest.js";
import { redactSensitiveText } from "./redaction.js";
import { guardObsidianVaultPath } from "./vaultGuard.js";

const defaultArtifactRoot = "data/artifacts/url-captures";
const defaultMaxBytes = 512 * 1024;
const defaultTimeoutMs = 10_000;
const maxRedirects = 5;

export type UrlCaptureFetch = (target: UrlCaptureRequestTarget, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<UrlCaptureResponse>;
export type UrlCaptureResolver = (hostname: string) => Promise<string[]>;

export type UrlCaptureRequestTarget = {
  url: URL;
  address: string;
  hostname: string;
  port: number;
  hostHeader: string;
  servername: string;
};

export type UrlCaptureResponse = {
  status: number;
  statusText?: string;
  url?: string;
  headers?: {
    get(name: string): string | null;
    entries?(): IterableIterator<[string, string]> | Iterable<[string, string]>;
  };
  body?: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | null;
  arrayBuffer?(): Promise<ArrayBuffer>;
  text?(): Promise<string>;
};

export type UrlCaptureInput = {
  url?: string;
  sourceTitle?: string;
  vaultPath?: string;
  capturedAt?: string;
  timeoutMs?: number;
  maxBytes?: number;
  artifactRoot?: string;
  fetchImpl?: UrlCaptureFetch;
  resolveHostnames?: UrlCaptureResolver;
};

export type UrlCaptureResult =
  | {
      ok: true;
      status: "captured";
      captureId: string;
      requestedUrl: string;
      finalUrl: string;
      sourceTitle: string;
      contentType: "html" | "text";
      bytes: number;
      ingest: Extract<ObsidianIngestResult, { ok: true }>;
    }
  | {
      ok: false;
      status: "blocked";
      captureId: string;
      requestedUrl: string;
      finalUrl?: string;
      exactBlocker: string;
      summary: string;
      artifactDir: string;
      manifestFile: string;
      blockerFile: string;
      responseFile: string;
      contentFile: string;
      ingest: Extract<ObsidianIngestResult, { ok: true }>;
    }
  | {
      ok: false;
      status: "rejected";
      captureId: string;
      exactBlocker: string;
      summary: string;
      requestedUrl?: string;
      vaultPath?: string;
    };

let testFetchImpl: UrlCaptureFetch | undefined;
let testResolver: UrlCaptureResolver | undefined;

export function setUrlCaptureFetchImplForTests(fetchImpl?: UrlCaptureFetch, resolveHostnames?: UrlCaptureResolver): void {
  testFetchImpl = fetchImpl;
  testResolver = resolveHostnames;
}

export async function runUrlCapture(input: UrlCaptureInput): Promise<UrlCaptureResult> {
  const captureId = makeId("capture");
  const capturedAt = normalizeCapturedAt(input.capturedAt);
  if (!capturedAt) {
    return rejected(captureId, "url_capture_captured_at_invalid", "capturedAt must be an ISO-compatible timestamp");
  }

  const parsed = parseHttpUrl(input.url);
  if (!parsed.ok) return rejected(captureId, parsed.exactBlocker, parsed.summary, redactUnknown(input.url));

  const vaultGuard = guardObsidianVaultPath(input.vaultPath);
  if (!vaultGuard.ok) {
    return {
      ok: false,
      status: "rejected",
      captureId,
      exactBlocker: vaultGuard.error,
      summary: vaultGuard.summary,
      requestedUrl: redactSensitiveText(parsed.url.toString()),
      vaultPath: vaultGuard.vaultPath
    };
  }

  const fetchImpl = input.fetchImpl ?? testFetchImpl ?? defaultFetch;
  const resolveHostnames = input.resolveHostnames ?? testResolver ?? defaultResolveHostnames;
  if (isTwitterUrl(parsed.url)) {
    return createBlockedResult({
      captureId,
      capturedAt,
      requestedUrl: parsed.url.toString(),
      finalUrl: parsed.url.toString(),
      exactBlocker: "url_capture_x_twitter_blocked",
      summary: "X/Twitter pages are blocked because the usable content is authentication and JavaScript gated",
      sourceTitle: input.sourceTitle,
      vaultPath: vaultGuard.vaultPath,
      artifactRoot: input.artifactRoot,
      redirects: [],
      response: undefined,
      content: ""
    });
  }

  const initialHostGuard = await resolvePublicHttpTarget(parsed.url, resolveHostnames);
  if (!initialHostGuard.ok) return rejected(captureId, initialHostGuard.exactBlocker, initialHostGuard.summary, redactSensitiveText(parsed.url.toString()));

  const maxBytes = normalizePositiveInteger(input.maxBytes, defaultMaxBytes);
  const timeoutMs = normalizePositiveInteger(input.timeoutMs, defaultTimeoutMs);
  const redirects: string[] = [];
  let currentUrl = parsed.url;
  let currentTarget = initialHostGuard.target;
  let response: UrlCaptureResponse;
  let body = "";
  let responseContentType = "";

  try {
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      const fetched = await requestWithTimeout(fetchImpl, currentTarget, timeoutMs, maxBytes);
      response = fetched.response;
      body = fetched.body;
      responseContentType = response.headers?.get("content-type") ?? "";
      const location = response.headers?.get("location");
      if (isRedirectStatus(response.status)) {
        if (!location) {
          return createBlockedResult({
            captureId,
            capturedAt,
            requestedUrl: parsed.url.toString(),
            finalUrl: currentUrl.toString(),
            exactBlocker: "url_capture_redirect_missing_location",
            summary: "redirect response did not include a Location header",
            sourceTitle: input.sourceTitle,
            vaultPath: vaultGuard.vaultPath,
            artifactRoot: input.artifactRoot,
            redirects,
            response,
            content: ""
          });
        }
        const nextUrl = new URL(location, currentUrl);
        const redirectUrl = parseHttpUrl(nextUrl.toString());
        if (!redirectUrl.ok) {
          return createBlockedResult({
            captureId,
            capturedAt,
            requestedUrl: parsed.url.toString(),
            finalUrl: nextUrl.toString(),
            exactBlocker: "url_capture_redirect_scheme_blocked",
            summary: redirectUrl.summary,
            sourceTitle: input.sourceTitle,
            vaultPath: vaultGuard.vaultPath,
            artifactRoot: input.artifactRoot,
            redirects,
            response,
            content: ""
          });
        }
        if (isTwitterUrl(redirectUrl.url)) {
          return createBlockedResult({
            captureId,
            capturedAt,
            requestedUrl: parsed.url.toString(),
            finalUrl: redirectUrl.url.toString(),
            exactBlocker: "url_capture_x_twitter_blocked",
            summary: "X/Twitter pages are blocked because the usable content is authentication and JavaScript gated",
            sourceTitle: input.sourceTitle,
            vaultPath: vaultGuard.vaultPath,
            artifactRoot: input.artifactRoot,
            redirects: [...redirects, redirectUrl.url.toString()],
            response,
            content: ""
          });
        }
        const redirectGuard = await resolvePublicHttpTarget(redirectUrl.url, resolveHostnames);
        if (!redirectGuard.ok) {
          return createBlockedResult({
            captureId,
            capturedAt,
            requestedUrl: parsed.url.toString(),
            finalUrl: redirectUrl.url.toString(),
            exactBlocker: "url_capture_private_redirect",
            summary: redirectGuard.summary,
            sourceTitle: input.sourceTitle,
            vaultPath: vaultGuard.vaultPath,
            artifactRoot: input.artifactRoot,
            redirects: [...redirects, redirectUrl.url.toString()],
            response,
            content: ""
          });
        }
        redirects.push(redirectUrl.url.toString());
        currentUrl = redirectUrl.url;
        currentTarget = redirectGuard.target;
        continue;
      }
      break;
    }
  } catch (error) {
    const exactBlocker = error instanceof Error && error.message === "url_capture_max_bytes_exceeded" ? error.message : isAbortLikeError(error) ? "url_capture_fetch_timeout" : "url_capture_fetch_failed";
    return createBlockedResult({
      captureId,
      capturedAt,
      requestedUrl: parsed.url.toString(),
      finalUrl: currentUrl.toString(),
      exactBlocker,
      summary: error instanceof Error ? error.message : "URL fetch failed",
      sourceTitle: input.sourceTitle,
      vaultPath: vaultGuard.vaultPath,
      artifactRoot: input.artifactRoot,
      redirects,
      response: undefined,
      content: ""
    });
  }

  const finalResponse = response!;
  if (redirects.length > maxRedirects) {
    return createBlockedResult({
      captureId,
      capturedAt,
      requestedUrl: parsed.url.toString(),
      finalUrl: currentUrl.toString(),
      exactBlocker: "url_capture_too_many_redirects",
      summary: `redirect limit exceeded (${maxRedirects})`,
      sourceTitle: input.sourceTitle,
      vaultPath: vaultGuard.vaultPath,
      artifactRoot: input.artifactRoot,
      redirects,
      response: finalResponse,
      content: body
    });
  }
  if (finalResponse.status === 401 || finalResponse.status === 403) {
    return createBlockedResult({
      captureId,
      capturedAt,
      requestedUrl: parsed.url.toString(),
      finalUrl: currentUrl.toString(),
      exactBlocker: `url_capture_http_${finalResponse.status}`,
      summary: `remote server returned HTTP ${finalResponse.status}`,
      sourceTitle: input.sourceTitle,
      vaultPath: vaultGuard.vaultPath,
      artifactRoot: input.artifactRoot,
      redirects,
      response: finalResponse,
      content: body
    });
  }
  if (finalResponse.status < 200 || finalResponse.status >= 300) {
    return createBlockedResult({
      captureId,
      capturedAt,
      requestedUrl: parsed.url.toString(),
      finalUrl: currentUrl.toString(),
      exactBlocker: `url_capture_http_${finalResponse.status}`,
      summary: `remote server returned HTTP ${finalResponse.status}`,
      sourceTitle: input.sourceTitle,
      vaultPath: vaultGuard.vaultPath,
      artifactRoot: input.artifactRoot,
      redirects,
      response: finalResponse,
      content: body
    });
  }

  const extracted = extractReadableContent(body, responseContentType);
  if (!extracted.ok) {
    return createBlockedResult({
      captureId,
      capturedAt,
      requestedUrl: parsed.url.toString(),
      finalUrl: currentUrl.toString(),
      exactBlocker: extracted.exactBlocker,
      summary: extracted.summary,
      sourceTitle: input.sourceTitle,
      vaultPath: vaultGuard.vaultPath,
      artifactRoot: input.artifactRoot,
      redirects,
      response: finalResponse,
      content: body
    });
  }

  const redactedText = redactSensitiveText(extracted.text);
  const sourceTitle = redactSensitiveText(normalizeScalar(input.sourceTitle) ?? extracted.title ?? currentUrl.hostname);
  const ingest = runObsidianIngest({
    vaultPath: vaultGuard.vaultPath,
    sourceUrl: redactSensitiveText(currentUrl.toString()),
    sourceTitle,
    sourceType: "url_capture",
    text: redactedText,
    capturedAt
  });
  if (!ingest.ok) {
    return rejected(captureId, ingest.error, ingest.summary, redactSensitiveText(parsed.url.toString()), ingest.vaultPath);
  }

  return {
    ok: true,
    status: "captured",
    captureId,
    requestedUrl: redactSensitiveText(parsed.url.toString()),
    finalUrl: redactSensitiveText(currentUrl.toString()),
    sourceTitle,
    contentType: extracted.contentType,
    bytes: Buffer.byteLength(redactedText),
    ingest
  };
}

async function createBlockedResult(input: {
  captureId: string;
  capturedAt: string;
  requestedUrl: string;
  finalUrl?: string;
  exactBlocker: string;
  summary: string;
  sourceTitle?: string;
  vaultPath: string;
  artifactRoot?: string;
  redirects: string[];
  response?: UrlCaptureResponse;
  content: string;
}): Promise<Extract<UrlCaptureResult, { status: "blocked" | "rejected" }>> {
  const artifactDir = resolve(input.artifactRoot ?? defaultArtifactRoot, input.captureId);
  mkdirSync(artifactDir, { recursive: true });
  const redactedRequestedUrl = redactSensitiveText(input.requestedUrl);
  const redactedFinalUrl = input.finalUrl ? redactSensitiveText(input.finalUrl) : undefined;
  const redactedContent = redactSensitiveText(input.content);
  const contentFile = join(artifactDir, "content.txt");
  const responseFile = join(artifactDir, "response.json");
  const blockerFile = join(artifactDir, "blocker.json");
  const manifestFile = join(artifactDir, "manifest.json");
  writeFileSync(contentFile, redactedContent);
  writeJson(responseFile, responseArtifact(input.response, redactedFinalUrl));
  writeJson(blockerFile, {
    captureId: input.captureId,
    exactBlocker: input.exactBlocker,
    summary: redactSensitiveText(input.summary),
    requestedUrl: redactedRequestedUrl,
    finalUrl: redactedFinalUrl ?? null
  });
  writeJson(manifestFile, {
    captureId: input.captureId,
    status: "blocked",
    exactBlocker: input.exactBlocker,
    requestedUrl: redactedRequestedUrl,
    finalUrl: redactedFinalUrl ?? null,
    redirects: input.redirects.map(redactSensitiveText),
    artifactDir,
    createdAt: input.capturedAt,
    files: {
      manifest: manifestFile,
      blocker: blockerFile,
      response: responseFile,
      content: contentFile
    }
  });

  const ingest = runObsidianIngest({
    vaultPath: input.vaultPath,
    sourceUrl: redactedFinalUrl ?? redactedRequestedUrl,
    sourceTitle: redactSensitiveText(normalizeScalar(input.sourceTitle) ?? `Blocked URL Capture - ${hostLabel(redactedFinalUrl ?? redactedRequestedUrl)}`),
    sourceType: "url_capture_blocked",
    text: [
      "URL capture was blocked before creating a normal inbox capture.",
      "",
      `Exact blocker: ${input.exactBlocker}`,
      `Summary: ${redactSensitiveText(input.summary)}`,
      `Capture ID: ${input.captureId}`,
      `Requested URL: ${redactedRequestedUrl}`,
      redactedFinalUrl ? `Final URL: ${redactedFinalUrl}` : undefined,
      `Artifact directory: ${artifactDir}`
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n"),
    capturedAt: input.capturedAt
  });
  if (!ingest.ok) {
    return rejected(input.captureId, ingest.error, ingest.summary, redactedRequestedUrl, ingest.vaultPath);
  }

  return {
    ok: false,
    status: "blocked",
    captureId: input.captureId,
    requestedUrl: redactedRequestedUrl,
    finalUrl: redactedFinalUrl,
    exactBlocker: input.exactBlocker,
    summary: redactSensitiveText(input.summary),
    artifactDir,
    manifestFile,
    blockerFile,
    responseFile,
    contentFile,
    ingest
  };
}

function parseHttpUrl(value: unknown):
  | { ok: true; url: URL }
  | { ok: false; exactBlocker: string; summary: string } {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, exactBlocker: "url_capture_url_required", summary: "url is required" };
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, exactBlocker: "url_capture_scheme_blocked", summary: "only http and https URLs are allowed" };
    }
    return { ok: true, url };
  } catch {
    return { ok: false, exactBlocker: "url_capture_url_invalid", summary: "url must be a valid absolute URL" };
  }
}

async function resolvePublicHttpTarget(url: URL, resolveHostnames: UrlCaptureResolver): Promise<{ ok: true; target: UrlCaptureRequestTarget } | { ok: false; exactBlocker: string; summary: string }> {
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { ok: false, exactBlocker: "url_capture_localhost_blocked", summary: "localhost URLs are not allowed" };
  }
  const literalBlocker = privateIpBlocker(hostname);
  if (literalBlocker) return { ok: false, exactBlocker: literalBlocker, summary: `${hostname} is not a public address` };
  let addresses = [stripIpv6Brackets(hostname)];
  if (isIP(addresses[0]) === 0) {
    try {
      addresses = await resolveHostnames(hostname);
    } catch {
      return { ok: false, exactBlocker: "url_capture_dns_lookup_failed", summary: `DNS lookup failed for ${hostname}` };
    }
    if (addresses.length === 0) return { ok: false, exactBlocker: "url_capture_dns_lookup_failed", summary: `DNS lookup returned no addresses for ${hostname}` };
  }
  for (const address of addresses) {
    const blocker = privateIpBlocker(address);
    if (blocker) return { ok: false, exactBlocker: blocker, summary: `${hostname} resolved to a non-public address` };
  }
  const address = stripIpv6Brackets(addresses[0]);
  if (isIP(address) === 0) return { ok: false, exactBlocker: "url_capture_dns_lookup_failed", summary: `DNS lookup returned a non-address for ${hostname}` };
  return {
    ok: true,
    target: {
      url,
      address,
      hostname,
      port: Number(url.port) || (url.protocol === "https:" ? 443 : 80),
      hostHeader: url.host,
      servername: stripIpv6Brackets(url.hostname)
    }
  };
}

function privateIpBlocker(hostname: string): string | undefined {
  const normalized = stripIpv6Zone(hostname.replace(/^\[|\]$/g, "").toLowerCase());
  if (normalized === "169.254.169.254") return "url_capture_metadata_address";
  if (normalized === "0" || normalized === "localhost") return "url_capture_private_address";
  if (isIP(normalized) === 6) {
    const bytes = parseIpv6Bytes(normalized);
    if (!bytes) return "url_capture_private_address";
    const mapped = mappedIpv4FromIpv6(bytes);
    if (mapped) return privateIpv4Blocker(mapped) ?? undefined;
    if (bytes.every((byte) => byte === 0)) return "url_capture_private_address";
    if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return "url_capture_private_address";
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return "url_capture_private_address";
    if ((bytes[0] & 0xfe) === 0xfc) return "url_capture_private_address";
  }
  if (isIP(normalized) === 4) return privateIpv4Blocker(normalized);
  return undefined;
}

function privateIpv4Blocker(address: string): string | undefined {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return "url_capture_private_address";
  const [a, b, c, d] = parts;
  if (a === 169 && b === 254 && c === 169 && d === 254) return "url_capture_metadata_address";
  if (a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127) {
    return "url_capture_private_address";
  }
  return undefined;
}

function parseIpv6Bytes(address: string): number[] | undefined {
  const normalized = address.toLowerCase();
  const doubleColonParts = normalized.split("::");
  if (doubleColonParts.length > 2) return undefined;
  const left = parseIpv6Groups(doubleColonParts[0]);
  const right = parseIpv6Groups(doubleColonParts[1] ?? "");
  if (!left || !right) return undefined;
  const fill = doubleColonParts.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0 || doubleColonParts.length === 1 && left.length + right.length !== 8) return undefined;
  const groups = [...left, ...Array(fill).fill(0), ...right];
  if (groups.length !== 8) return undefined;
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
}

function parseIpv6Groups(value: string): number[] | undefined {
  if (!value) return [];
  const rawGroups = value.split(":");
  const groups: number[] = [];
  for (const rawGroup of rawGroups) {
    if (!rawGroup) return undefined;
    if (rawGroup.includes(".")) {
      const ipv4 = parseIpv4Parts(rawGroup);
      if (!ipv4) return undefined;
      groups.push(ipv4[0] << 8 | ipv4[1], ipv4[2] << 8 | ipv4[3]);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/iu.test(rawGroup)) return undefined;
    groups.push(Number.parseInt(rawGroup, 16));
  }
  return groups;
}

function parseIpv4Parts(address: string): [number, number, number, number] | undefined {
  if (isIP(address) !== 4) return undefined;
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return [parts[0], parts[1], parts[2], parts[3]];
}

function mappedIpv4FromIpv6(bytes: number[]): string | undefined {
  if (!bytes.slice(0, 10).every((byte) => byte === 0) || bytes[10] !== 0xff || bytes[11] !== 0xff) return undefined;
  return bytes.slice(12, 16).join(".");
}

async function requestWithTimeout(fetchImpl: UrlCaptureFetch, target: UrlCaptureRequestTarget, timeoutMs: number, maxBytes: number): Promise<{ response: UrlCaptureResponse; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(target, {
      signal: controller.signal,
      headers: requestHeadersForTarget(target)
    });
    const body = isRedirectStatus(response.status) ? "" : await readResponseText(response, maxBytes, controller.signal);
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseText(response: UrlCaptureResponse, maxBytes: number, signal: AbortSignal): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (isWebReadable(response.body)) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await raceWithAbort(reader.read(), signal);
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("url_capture_max_bytes_exceeded");
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }
  if (isAsyncReadable(response.body)) {
    const iterator = response.body[Symbol.asyncIterator]();
    let completed = false;
    try {
      while (true) {
        const { done, value } = await raceWithAbort(iterator.next(), signal);
        if (done) {
          completed = true;
          break;
        }
        if (!value) continue;
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        total += chunk.byteLength;
        if (total > maxBytes) throw new Error("url_capture_max_bytes_exceeded");
        chunks.push(chunk);
      }
    } finally {
      if (!completed && typeof iterator.return === "function") {
        void iterator.return().catch(() => undefined);
      }
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }
  if (response.arrayBuffer) {
    const buffer = Buffer.from(await raceWithAbort(response.arrayBuffer(), signal));
    if (buffer.byteLength > maxBytes) throw new Error("url_capture_max_bytes_exceeded");
    return buffer.toString("utf8");
  }
  if (response.text) {
    const text = await raceWithAbort(response.text(), signal);
    if (Buffer.byteLength(text) > maxBytes) throw new Error("url_capture_max_bytes_exceeded");
    return text;
  }
  return "";
}

function extractReadableContent(body: string, contentType: string):
  | { ok: true; text: string; title?: string; contentType: "html" | "text" }
  | { ok: false; exactBlocker: string; summary: string } {
  const normalizedType = contentType.toLowerCase();
  const looksHtml = /<\/?[a-z][\s\S]*>/iu.test(body);
  if (normalizedType && !normalizedType.includes("text/html") && !normalizedType.includes("text/plain") && !normalizedType.includes("application/xhtml+xml")) {
    return { ok: false, exactBlocker: "url_capture_body_unextractable", summary: `unsupported content type: ${contentType}` };
  }
  if (normalizedType.includes("text/plain") || !looksHtml) {
    const text = collapseWhitespace(decodeHtmlEntities(body));
    return classifyExtractedText(text, undefined, "text");
  }

  const title = decodeHtmlEntities(body.match(/<title[^>]*>([\s\S]*?)<\/title>/iu)?.[1] ?? "").trim();
  const withoutHidden = body
    .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/giu, " ");
  const text = collapseWhitespace(
    decodeHtmlEntities(
      withoutHidden
        .replace(/<(br|p|div|li|h[1-6]|section|article|header|footer|tr)\b[^>]*>/giu, "\n")
        .replace(/<[^>]+>/gu, " ")
    )
  );
  return classifyExtractedText(text, title || undefined, "html");
}

function classifyExtractedText(text: string, title: string | undefined, contentType: "html" | "text"):
  | { ok: true; text: string; title?: string; contentType: "html" | "text" }
  | { ok: false; exactBlocker: string; summary: string } {
  if (!text.trim()) return { ok: false, exactBlocker: "url_capture_body_unextractable", summary: "no readable text could be extracted" };
  const lower = `${title ?? ""}\n${text}`.toLowerCase();
  if (/\b(log in|login|sign in|signin|authenticate)\b/u.test(lower) && /\b(required|continue|to view|to read|account|session)\b/u.test(lower)) {
    return { ok: false, exactBlocker: "url_capture_login_wall", summary: "page appears to be behind a login wall" };
  }
  if (/enable javascript|requires javascript|javascript is disabled|please enable js|turn on javascript/u.test(lower)) {
    return { ok: false, exactBlocker: "url_capture_js_only", summary: "page appears to require JavaScript for readable content" };
  }
  return { ok: true, text, title, contentType };
}

function responseArtifact(response: UrlCaptureResponse | undefined, url?: string): Record<string, unknown> {
  if (!response) return { status: null, url: url ?? null, headers: {} };
  return {
    status: response.status,
    statusText: redactSensitiveText(response.statusText ?? ""),
    url: url ?? (response.url ? redactSensitiveText(response.url) : null),
    headers: redactHeaders(response.headers)
  };
}

function redactHeaders(headers: UrlCaptureResponse["headers"]): Record<string, string> {
  if (!headers?.entries) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    out[key] = /authorization|cookie|set-cookie|token|secret|api-key/u.test(lower) ? "[redacted]" : redactSensitiveText(value);
  }
  return out;
}

function defaultFetch(target: UrlCaptureRequestTarget, init: { signal: AbortSignal; headers: Record<string, string> }): Promise<UrlCaptureResponse> {
  const client = target.url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let responseBody: { destroy(error?: Error): void } | undefined;
    const abort = () => {
      const error = abortError();
      request.destroy(error);
      responseBody?.destroy?.(error);
    };
    const request = client(
      {
        protocol: target.url.protocol,
        hostname: target.address,
        port: target.port,
        path: `${target.url.pathname}${target.url.search}`,
        method: "GET",
        headers: init.headers,
        servername: target.servername
      },
      (response) => {
        responseBody = response;
        response.once("close", () => init.signal.removeEventListener("abort", abort));
        resolve({
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? "",
          url: target.url.toString(),
          headers: responseHeaders(response.headers),
          body: response
        });
      }
    );
    request.once("error", (error) => {
      init.signal.removeEventListener("abort", abort);
      reject(error);
    });
    init.signal.addEventListener("abort", abort, { once: true });
    if (init.signal.aborted) abort();
    else request.end();
  });
}

async function defaultResolveHostnames(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function isTwitterUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === "x.com" || host.endsWith(".x.com") || host === "twitter.com" || host.endsWith(".twitter.com");
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeScalar(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeCapturedAt(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return nowIso();
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || Number.isNaN(Date.parse(trimmed))) return undefined;
  return trimmed;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\r/g, "").replace(/[ \t\f\v]+/g, " ").replace(/\n\s+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;|&apos;/giu, "'");
}

function hostLabel(value: string): string {
  try {
    return new URL(value).hostname || "unknown";
  } catch {
    return "unknown";
  }
}

function requestHeadersForTarget(target: UrlCaptureRequestTarget): Record<string, string> {
  return {
    host: target.hostHeader,
    "user-agent": "automation-os-url-capture/1.0",
    accept: "text/html,text/plain;q=0.9,*/*;q=0.1"
  };
}

function responseHeaders(headers: Record<string, string | string[] | undefined>): UrlCaptureResponse["headers"] {
  const normalized = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    normalized.set(key.toLowerCase(), Array.isArray(value) ? value.join(", ") : value);
  }
  return {
    get(name: string): string | null {
      return normalized.get(name.toLowerCase()) ?? null;
    },
    entries(): IterableIterator<[string, string]> {
      return normalized.entries();
    }
  };
}

function stripIpv6Brackets(value: string): string {
  return value.replace(/^\[|\]$/g, "");
}

function stripIpv6Zone(value: string): string {
  return value.replace(/%.+$/u, "");
}

function redactUnknown(value: unknown): string | undefined {
  return typeof value === "string" ? redactSensitiveText(value) : undefined;
}

function isWebReadable(value: UrlCaptureResponse["body"]): value is ReadableStream<Uint8Array> {
  return Boolean(value && "getReader" in value && typeof value.getReader === "function");
}

function isAsyncReadable(value: UrlCaptureResponse["body"]): value is AsyncIterable<Uint8Array> {
  return Boolean(value && Symbol.asyncIterator in value);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function abortError(): Error {
  const error = new Error("url_capture_fetch_timeout");
  error.name = "AbortError";
  return error;
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message === "url_capture_fetch_timeout");
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function rejected(captureId: string, exactBlocker: string, summary: string, requestedUrl?: string, vaultPath?: string): Extract<UrlCaptureResult, { status: "rejected" }> {
  return {
    ok: false,
    status: "rejected",
    captureId,
    exactBlocker,
    summary: redactSensitiveText(summary),
    requestedUrl: requestedUrl ? redactSensitiveText(requestedUrl) : undefined,
    vaultPath
  };
}

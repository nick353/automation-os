import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isIP } from "node:net";
import { redactSensitiveText } from "./obsidian/redaction.js";

export type LoadReadinessRunOptions = {
  targetUrl?: string;
  targetUrls?: string[];
  concurrency?: number;
  durationMs?: number;
  timeoutMs?: number;
  readToken?: string;
  allowProductionHosts?: boolean;
  outputPath?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

export type LoadReadinessSummary = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  concurrency: number;
  timeoutMs: number;
  targetUrls: string[];
  requestCount: number;
  successCount: number;
  failureCount: number;
  statusCounts: Record<string, number>;
  errorCounts: Record<string, number>;
  latencyMs: {
    sampleSize: number;
    min: number | null;
    max: number | null;
    average: number | null;
    p50: number | null;
    p95: number | null;
    p99: number | null;
  };
  targets: Array<{
    targetUrl: string;
    requestCount: number;
    successCount: number;
    failureCount: number;
    statusCounts: Record<string, number>;
    errorCounts: Record<string, number>;
    latencyMs: {
      sampleSize: number;
      min: number | null;
      max: number | null;
      average: number | null;
      p50: number | null;
      p95: number | null;
      p99: number | null;
    };
  }>;
};

export type LoadReadinessReport = LoadReadinessSummary & {
  ok: boolean;
  status: "ok" | "blocked";
  exactBlocker: string | null;
  evidencePath: string;
  targetUrlsRedacted: string[];
  summary: string;
};

const DEFAULT_SAFE_LOCAL_ENDPOINTS = [
  "http://127.0.0.1:5173/",
  "http://127.0.0.1:8787/api/health",
  "http://127.0.0.1:8787/api/mvp/state"
];

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_DURATION_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_CONCURRENCY = 256;

type TargetRecord = {
  targetUrl: string;
  requestCount: number;
  successCount: number;
  failureCount: number;
  statusCounts: Map<string, number>;
  errorCounts: Map<string, number>;
  latencies: number[];
};

type MeasurementState = {
  startedAt: number;
  finishedAt: number;
  requestCount: number;
  successCount: number;
  failureCount: number;
  statusCounts: Map<string, number>;
  errorCounts: Map<string, number>;
  latencies: number[];
  targets: Map<string, TargetRecord>;
};

export async function runLoadReadiness(options: LoadReadinessRunOptions = {}): Promise<LoadReadinessReport> {
  const now = options.now ?? (() => Date.now());
  const startedAtMs = now();
  const durationMs = normalizePositiveInteger(options.durationMs ?? DEFAULT_DURATION_MS, "durationMs");
  const concurrency = normalizePositiveInteger(options.concurrency ?? DEFAULT_CONCURRENCY, "concurrency", MAX_CONCURRENCY);
  const timeoutMs = normalizePositiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const rawTargets = (options.targetUrls?.length ? options.targetUrls : options.targetUrl ? [options.targetUrl] : DEFAULT_SAFE_LOCAL_ENDPOINTS).map((value) => validateLoadTargetUrl(value, Boolean(options.allowProductionHosts)));
  const targetUrls = Array.from(new Set(rawTargets));

  if (targetUrls.length === 0) {
    throw new Error("load_readiness_target_url_required");
  }

  const evidencePath = resolveEvidencePath(options.outputPath, startedAtMs);
  const state = createMeasurementState(targetUrls);
  const deadlineMs = startedAtMs + durationMs;
  let scheduled = 0;

  const workers = Array.from({ length: concurrency }, async () => {
    while (now() < deadlineMs) {
      const index = scheduled % targetUrls.length;
      scheduled += 1;
      const targetUrl = targetUrls[index];
      const target = state.targets.get(targetUrl);
      if (!target) throw new Error("load_readiness_internal_target_missing");
      const requestStartedAt = now();
      try {
        const response = await fetchWithTimeout(fetchImpl, targetUrl, timeoutMs, options.readToken);
        const requestEndedAt = now();
        const latency = Math.max(0, requestEndedAt - requestStartedAt);
        if (response.status < 200 || response.status >= 300) {
          recordHttpFailure(state, target, response.status, latency);
        } else {
          recordSuccess(state, target, response.status, latency);
        }
      } catch (error) {
        const requestEndedAt = now();
        const latency = Math.max(0, requestEndedAt - requestStartedAt);
        recordFailure(state, target, normalizeErrorCode(error, options.readToken), latency);
      }
      if (now() >= deadlineMs) break;
      await sleep(0);
    }
  });

  await Promise.all(workers);

  state.finishedAt = now();
  const summary = finalizeSummary(state, targetUrls, startedAtMs, durationMs, concurrency, timeoutMs, options.readToken);
  const report: LoadReadinessReport = {
    ...summary,
    ok: summary.failureCount === 0,
    status: summary.failureCount === 0 ? "ok" : "blocked",
    exactBlocker: summary.failureCount === 0 ? null : "load_readiness_requests_failed",
    evidencePath,
    targetUrlsRedacted: targetUrls.map((value) => redactLoadText(value, options.readToken)),
    summary: buildSummaryText(summary, evidencePath)
  };

  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

export function validateLoadTargetUrl(input: string, allowProductionHosts = false): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("load_target_url_parse_failed");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("load_target_url_must_use_http");
  }
  if (parsed.username || parsed.password) {
    throw new Error("load_target_url_credentials_not_allowed");
  }
  if (!allowProductionHosts && !isSafeLocalHost(parsed.hostname)) {
    throw new Error("load_target_url_production_host_blocked");
  }
  return parsed.toString();
}

export function parseLoadReadinessArgs(args: string[]): LoadReadinessRunOptions & { help?: boolean } {
  const options: LoadReadinessRunOptions & { help?: boolean } = {};
  const urls: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--allow-production-hosts") {
      options.allowProductionHosts = true;
      continue;
    }
    const [key, inlineValue] = arg.split(/=(.*)/s, 2);
    const value = inlineValue ?? args[index + 1];
    const consumedSeparateValue = inlineValue === undefined;
    if (key === "--url" || key === "--target-url") {
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      urls.push(value);
      if (consumedSeparateValue) index += 1;
      continue;
    }
    if (key === "--concurrency") {
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      options.concurrency = parsePositiveInteger(value, key);
    } else if (key === "--duration-ms") {
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      options.durationMs = parsePositiveInteger(value, key);
    } else if (key === "--timeout-ms") {
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      options.timeoutMs = parsePositiveInteger(value, key);
    } else if (key === "--output") {
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      options.outputPath = value;
    } else if (key === "--allow-production-hosts") {
      options.allowProductionHosts = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
    if (consumedSeparateValue) index += 1;
  }
  if (urls.length > 0) options.targetUrls = urls;
  return options;
}

function createMeasurementState(targetUrls: string[]): MeasurementState {
  return {
    startedAt: 0,
    finishedAt: 0,
    requestCount: 0,
    successCount: 0,
    failureCount: 0,
    statusCounts: new Map(),
    errorCounts: new Map(),
    latencies: [],
    targets: new Map(
      targetUrls.map((targetUrl) => [
        targetUrl,
        {
          targetUrl,
          requestCount: 0,
          successCount: 0,
          failureCount: 0,
          statusCounts: new Map(),
          errorCounts: new Map(),
          latencies: []
        }
      ])
    )
  };
}

function recordSuccess(state: MeasurementState, target: TargetRecord, status: number, latencyMs: number): void {
  state.requestCount += 1;
  state.successCount += 1;
  target.requestCount += 1;
  target.successCount += 1;
  target.latencies.push(latencyMs);
  state.latencies.push(latencyMs);
  bumpCount(state.statusCounts, String(status));
  bumpCount(target.statusCounts, String(status));
}

function recordHttpFailure(state: MeasurementState, target: TargetRecord, status: number, latencyMs: number): void {
  state.requestCount += 1;
  state.failureCount += 1;
  target.requestCount += 1;
  target.failureCount += 1;
  target.latencies.push(latencyMs);
  state.latencies.push(latencyMs);
  bumpCount(state.statusCounts, String(status));
  bumpCount(target.statusCounts, String(status));
  bumpCount(state.errorCounts, `http_${status}`);
  bumpCount(target.errorCounts, `http_${status}`);
}

function recordFailure(state: MeasurementState, target: TargetRecord, errorCode: string, latencyMs: number): void {
  state.requestCount += 1;
  state.failureCount += 1;
  target.requestCount += 1;
  target.failureCount += 1;
  target.latencies.push(latencyMs);
  state.latencies.push(latencyMs);
  bumpCount(state.errorCounts, errorCode);
  bumpCount(target.errorCounts, errorCode);
}

function finalizeSummary(
  state: MeasurementState,
  targetUrls: string[],
  startedAtMs: number,
  durationMs: number,
  concurrency: number,
  timeoutMs: number,
  readToken = ""
): LoadReadinessSummary {
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    finishedAt: new Date(state.finishedAt || Date.now()).toISOString(),
    durationMs,
    concurrency,
    timeoutMs,
    targetUrls: targetUrls.map((value) => redactLoadText(value, readToken)),
    requestCount: state.requestCount,
    successCount: state.successCount,
    failureCount: state.failureCount,
    statusCounts: mapToSortedObject(state.statusCounts),
    errorCounts: mapToSortedObject(state.errorCounts),
    latencyMs: summarizeLatencies(state.latencies),
    targets: targetUrls.map((targetUrl) => {
      const target = state.targets.get(targetUrl);
      if (!target) throw new Error("load_readiness_internal_target_missing");
      return {
        targetUrl: redactLoadText(target.targetUrl, readToken),
        requestCount: target.requestCount,
        successCount: target.successCount,
        failureCount: target.failureCount,
        statusCounts: mapToSortedObject(target.statusCounts),
        errorCounts: mapToSortedObject(target.errorCounts),
        latencyMs: summarizeLatencies(target.latencies)
      };
    })
  };
}

function buildSummaryText(summary: LoadReadinessSummary, evidencePath: string): string {
  return [
    `load readiness ${summary.requestCount} requests (${summary.successCount} ok, ${summary.failureCount} failed)`,
    `p50=${formatLatency(summary.latencyMs.p50)}ms p95=${formatLatency(summary.latencyMs.p95)}ms p99=${formatLatency(summary.latencyMs.p99)}ms`,
    `evidence=${evidencePath}`
  ].join(" | ");
}

function formatLatency(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(1);
}

async function fetchWithTimeout(fetchImpl: typeof fetch, targetUrl: string, timeoutMs: number, readToken = ""): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("load_request_timeout")), timeoutMs);
  try {
    return await fetchImpl(targetUrl, {
      method: "HEAD",
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
      headers: {
        accept: "application/json, text/plain, */*",
        pragma: "no-cache",
        "cache-control": "no-store",
        ...(readToken.trim() ? { "x-automation-os-token": readToken.trim() } : {})
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeErrorCode(error: unknown, readToken = ""): string {
  if (error instanceof Error && error.name === "AbortError") return "request_timeout";
  if (error instanceof Error && error.message === "load_request_timeout") return "request_timeout";
  if (error instanceof Error && error.message) return `fetch_error:${sanitizeErrorToken(error.message, readToken)}`;
  return "fetch_error:unknown";
}

function sanitizeErrorToken(value: string, readToken = ""): string {
  return redactLoadText(value, readToken).replace(/[^a-z0-9:_-]+/giu, "_").slice(0, 64) || "unknown";
}

function resolveEvidencePath(outputPath: string | undefined, startedAtMs: number): string {
  if (outputPath) return resolve(outputPath);
  const stamp = new Date(startedAtMs).toISOString().replaceAll(":", "-");
  return resolve("work", "qa", `load-readiness-${stamp}.json`);
}

function summarizeLatencies(values: number[]): LoadReadinessSummary["latencyMs"] {
  if (values.length === 0) {
    return { sampleSize: 0, min: null, max: null, average: null, p50: null, p95: null, p99: null };
  }
  const sorted = [...values].sort((left, right) => left - right);
  const sampleSize = sorted.length;
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    sampleSize,
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
    average: total / sampleSize,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99)
  };
}

function percentile(sortedValues: number[], percentileValue: number): number {
  if (sortedValues.length === 0) return NaN;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * percentileValue) - 1));
  return sortedValues[index] ?? sortedValues.at(-1)!;
}

function bumpCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function mapToSortedObject(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function normalizePositiveInteger(value: number, name: string, max?: number): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  if (max !== undefined && value > max) throw new Error(`${name} must be <= ${max}`);
  return value;
}

function parsePositiveInteger(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${key} must be a positive integer`);
  return parsed;
}

function redactLoadText(value: string, readToken = ""): string {
  const token = readToken.trim();
  return redactSensitiveText(token ? value.split(token).join("[redacted]") : value);
}

function isSafeLocalHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "[::1]") return true;
  if (isIP(host) === 4) return host.split(".")[0] === "127";
  return false;
}

function normalizeHost(hostname: string): string {
  const host = hostname.toLowerCase();
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

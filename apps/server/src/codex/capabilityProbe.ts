import { spawnSync, type SpawnSyncOptions } from "node:child_process";

export type CapabilityAxisState = {
  configured: boolean;
  enabled: boolean;
  verified: boolean;
  connected: boolean;
};

export type McpProbeEntry = {
  name: string;
  status: string;
  enabled: boolean;
  connected: boolean;
  source: "json" | "text";
};

export type McpProbeResult = {
  generatedAt: string;
  ttlMs: number;
  command: string;
  args: string[];
  status: "ok" | "blocked";
  exactBlocker: string | null;
  state: CapabilityAxisState;
  parsedFrom: "json" | "text" | "none";
  entries: McpProbeEntry[];
  rawOutputSample: string;
};

type ProbeCacheEntry = {
  expiresAt: number;
  result: McpProbeResult;
};

type Runner = (command: string, args: string[], options: SpawnSyncOptions) => ReturnType<typeof spawnSync>;

const probeCache = new Map<string, ProbeCacheEntry>();
let latestProbeCache: ProbeCacheEntry | null = null;

export function clearCapabilityProbeCache(): void {
  probeCache.clear();
  latestProbeCache = null;
}

export function getLatestCapabilityProbeSnapshot(now: number = Date.now()): McpProbeResult | null {
  if (!latestProbeCache) return null;
  if (latestProbeCache.expiresAt <= now) return null;
  return latestProbeCache.result;
}

export function probeCodexMcpSurface(options: {
  now?: () => number;
  ttlMs?: number;
  command?: string;
  args?: string[];
  runner?: Runner;
} = {}): McpProbeResult {
  const now = options.now ?? Date.now;
  const ttlMs = normalizeTtlMs(options.ttlMs ?? Number(process.env.AUTOMATION_OS_CAPABILITY_PROBE_TTL_MS ?? 30_000));
  const command = (options.command ?? process.env.AUTOMATION_OS_CODEX_MCP_PROBE_COMMAND ?? "codex").trim();
  const args = options.args ?? ["mcp", "list"];
  const cacheKey = JSON.stringify({ command, args });
  const cached = probeCache.get(cacheKey);
  const nowMs = now();
  if (ttlMs > 0 && cached && cached.expiresAt > nowMs) return cached.result;

  const runner = options.runner ?? spawnSync;
  const execution = runReadOnlyProbe({ command, args, runner });
  const parsed = parseMcpListOutput(execution.stdout);
  const probeStatus = execution.status === "ok" && parsed.parseOk ? "ok" : "blocked";
  const exactBlocker = execution.status === "blocked" ? execution.exactBlocker : parsed.parseOk ? null : "mcp_probe_parse_failed";
  const state = buildProbeAxisState(execution, parsed);
  const result: McpProbeResult = {
    generatedAt: new Date(nowMs).toISOString(),
    ttlMs,
    command,
    args,
    status: probeStatus,
    exactBlocker,
    state,
    parsedFrom: parsed.parsedFrom,
    entries: parsed.entries,
    rawOutputSample: parsed.rawOutputSample
  };

  if (ttlMs > 0) {
    const entry = {
      expiresAt: nowMs + ttlMs,
      result
    };
    probeCache.set(cacheKey, entry);
    latestProbeCache = entry;
  } else {
    latestProbeCache = {
      expiresAt: nowMs,
      result
    };
  }

  return result;
}

export function parseMcpListOutput(stdout: string): {
  parsedFrom: "json" | "text" | "none";
  entries: McpProbeEntry[];
  rawOutputSample: string;
  parseOk: boolean;
} {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {
      parsedFrom: "none",
      entries: [],
      rawOutputSample: "",
      parseOk: true
    };
  }

  const jsonParsed = parseMcpListJson(trimmed);
  if (jsonParsed) {
    return {
      parsedFrom: "json",
      entries: jsonParsed.entries,
      rawOutputSample: trimmed.slice(0, 500),
      parseOk: jsonParsed.parseOk
    };
  }

  const textParsed = parseMcpListText(trimmed);
  if (textParsed.parseOk) {
    return {
      parsedFrom: "text",
      entries: textParsed.entries,
      rawOutputSample: trimmed.slice(0, 500),
      parseOk: true
    };
  }

  return {
    parsedFrom: "none",
    entries: [],
    rawOutputSample: trimmed.slice(0, 500),
    parseOk: false
  };
}

function runReadOnlyProbe(input: { command: string; args: string[]; runner: Runner }): {
  status: "ok" | "blocked";
  exactBlocker: string | null;
  stdout: string;
} {
  if (!input.command) {
    return {
      status: "blocked",
      exactBlocker: "mcp_probe_command_missing",
      stdout: ""
    };
  }

  const result = input.runner(input.command, input.args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
    timeout: 2500,
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.error) {
    return {
      status: "blocked",
      exactBlocker: "mcp_probe_command_unavailable",
      stdout: ""
    };
  }

  if (result.status !== 0) {
    return {
      status: "blocked",
      exactBlocker: "mcp_probe_exit_nonzero",
      stdout: typeof result.stdout === "string" ? result.stdout : ""
    };
  }

  return {
    status: "ok",
    exactBlocker: null,
    stdout: typeof result.stdout === "string" ? result.stdout : ""
  };
}

function buildProbeAxisState(execution: { status: "ok" | "blocked"; exactBlocker: string | null }, parsed: { parseOk: boolean; entries: McpProbeEntry[] }): CapabilityAxisState {
  const configured = execution.exactBlocker !== "mcp_probe_command_missing" && execution.exactBlocker !== "mcp_probe_command_unavailable";
  const enabled = execution.status === "ok" && parsed.parseOk;
  const connected = enabled && parsed.entries.some((entry) => entry.connected);
  return {
    configured,
    enabled,
    verified: enabled,
    connected
  };
}

function parseMcpListJson(stdout: string): { entries: McpProbeEntry[]; parseOk: boolean } | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (Array.isArray(parsed) && parsed.length === 0) return { entries: [], parseOk: true };
    const entries = collectMcpEntriesFromJson(parsed);
    if (entries.length > 0) return { entries, parseOk: true };
    if (isExplicitEmptyMcpJson(parsed)) return { entries: [], parseOk: true };
    return null;
  } catch {
    return null;
  }
}

function collectMcpEntriesFromJson(value: unknown): McpProbeEntry[] {
  const entries: McpProbeEntry[] = [];
  const items = collectJsonItemArray(value);
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = firstString(record.name, record.id, record.server, record.tool, record.label);
    if (!name) continue;
    const status = firstString(record.status, record.state) ?? "unknown";
    const enabled = readBoolean(record.enabled, record.configured, record.available);
    const connected = readBoolean(record.connected, record.ready, record.active, record.available);
    entries.push({
      name,
      status,
      enabled: enabled || connected,
      connected,
      source: "json"
    });
  }
  return entries;
}

function collectJsonItemArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["servers", "mcpServers", "tools", "items", "capabilities"]) {
    const nested = record[key];
    if (Array.isArray(nested)) return nested;
  }
  return [];
}

function isExplicitEmptyMcpJson(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  for (const key of ["servers", "mcpServers", "tools", "items", "capabilities"]) {
    const nested = record[key];
    if (Array.isArray(nested)) return nested.length === 0;
  }
  return false;
}

function parseMcpListText(stdout: string): { entries: McpProbeEntry[]; parseOk: boolean } {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const entries: McpProbeEntry[] = [];
  let parseOk = false;

  for (const line of lines) {
    if (/^(name|server|tool)\b/i.test(line) && /status|connected|enabled|available/i.test(line)) {
      parseOk = true;
      continue;
    }

    const parsed = parseMcpTextLine(line);
    if (parsed) {
      entries.push(parsed);
      parseOk = true;
    }
  }

  return { entries, parseOk };
}

function parseMcpTextLine(line: string): McpProbeEntry | null {
  const structured = line.includes("|") || line.includes("\t") || /^[-•]\s*/.test(line) || /^(name|server|tool)\s*:/i.test(line);
  if (!structured) return null;
  const segments = line.includes("|") ? line.split("|").map((segment) => segment.trim()).filter(Boolean) : line.split(/\s{2,}/).map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return null;

  const [first, second, third] = segments;
  const status = firstString(second, third, "unknown") ?? "unknown";
  const name = normalizeMcpName(first);
  if (!name) return null;
  const connected = /connected|ready|available|online|active/i.test(`${first} ${second} ${third}`);
  const enabled = connected || /enabled|configured|loadable|present/i.test(`${first} ${second} ${third}`);

  return {
    name,
    status,
    enabled,
    connected,
    source: "text"
  };
}

function normalizeMcpName(value: string | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/^[-•\s]+/, "").replace(/\s*\(.*\)\s*$/, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function normalizeTtlMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), 300_000);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readBoolean(...values: unknown[]): boolean {
  return values.some((value) => value === true || value === "true" || value === 1);
}

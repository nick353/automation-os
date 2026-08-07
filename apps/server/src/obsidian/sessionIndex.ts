import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type SessionReviewStatus = "pending_human_review" | "human_reviewed";

export type RedactedSessionIndexEntry = {
  file: string;
  sessionId: string;
  mtime: string;
  cwd: string;
  lastUser: string;
  lastAssistant: string;
  threadSource: string;
  parentThreadId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  sourceHash: string;
  blockerClass: string;
  exactBlocker: string;
  nextAction: string;
  restartPoint: string;
  coverage: "head_tail_metadata";
  reviewStatus: SessionReviewStatus;
  promotionAllowed: boolean;
};

export type SessionPromotionReview = {
  reviewedBy: string;
  reviewedAt: string;
  approved: boolean;
  promotionRequested: boolean;
};

export type SessionPromotionDecision = {
  allowed: boolean;
  reason: "human_review_required" | "promotion_not_requested" | "approved";
  entry: RedactedSessionIndexEntry;
};

export type SessionIndexBuildResult = {
  outputPath: string;
  entries: RedactedSessionIndexEntry[];
  scannedFiles: number;
  indexedEntries: number;
  skippedFiles: number;
  coverage: "head_tail_metadata";
};

type RawSessionEntry = Omit<RedactedSessionIndexEntry, "reviewStatus" | "promotionAllowed">;

export function redactSessionText(value: unknown, maxLength = 240): string {
  const text = String(value ?? "none").replace(/\s+/g, " ").trim();
  const redacted = text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\/\s:@]+):([^\/\s@]+)@/gi, "$1[redacted-auth]@")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted-jwt]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [redacted]")
    .replace(/\b(?:password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*['"]?[^'"\s,)}]+/gi, "$1=[redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/\b[A-Za-z0-9_=-]{32,}\b/g, (token) => (isLocatorToken(token) ? token : "[redacted-token]"));
  if (redacted.length <= maxLength) return redacted || "none";
  return `${redacted.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

export function buildRedactedSessionIndex(entries: RawSessionEntry[]): RedactedSessionIndexEntry[] {
  const seen = new Set<string>();
  return entries
    .map((entry) => ({
      ...entry,
      file: redactSessionText(entry.file, 160),
      sessionId: redactSessionText(entry.sessionId, 80),
      cwd: redactSessionText(entry.cwd, 240),
      lastUser: redactSessionText(entry.lastUser, 180),
      lastAssistant: redactSessionText(entry.lastAssistant, 180),
      reviewStatus: "pending_human_review" as const,
      promotionAllowed: false
    }))
    .filter((entry) => {
      if (seen.has(entry.sessionId)) return false;
      seen.add(entry.sessionId);
      return true;
    });
}

export function decideSessionPromotion(entry: RedactedSessionIndexEntry, review?: SessionPromotionReview): SessionPromotionDecision {
  if (!review || !review.approved || !review.reviewedBy || !review.reviewedAt) {
    return { allowed: false, reason: "human_review_required", entry };
  }
  if (!review.promotionRequested) return { allowed: false, reason: "promotion_not_requested", entry };
  return { allowed: true, reason: "approved", entry: { ...entry, reviewStatus: "human_reviewed", promotionAllowed: true } };
}

export function buildAndWriteRedactedSessionIndex(options: {
  sessionsDir?: string;
  outputPath?: string;
  maxFiles?: number;
} = {}): SessionIndexBuildResult {
  const sessionsDir = resolve(options.sessionsDir ?? process.env.AUTOMATION_OS_CODEX_SESSIONS_DIR ?? join(homedir(), ".codex", "sessions"));
  const outputPath = resolve(options.outputPath ?? process.env.AUTOMATION_OS_CODEX_SESSION_INDEX ?? join(homedir(), ".codex", "session-index.jsonl"));
  const paths = existsSync(sessionsDir) ? listJsonlFiles(sessionsDir).slice(0, options.maxFiles ?? Number.POSITIVE_INFINITY) : [];
  const rawEntries: RawSessionEntry[] = [];
  let skippedFiles = 0;
  for (const file of paths) {
    const stat = safeStat(file);
    if (!stat) {
      skippedFiles += 1;
      continue;
    }
    try {
      rawEntries.push(readSessionIndexEntry(file, sessionsDir, stat));
    } catch {
      skippedFiles += 1;
    }
  }
  const entries = buildRedactedSessionIndex(rawEntries);
  mkdirSync(dirname(outputPath), { recursive: true });
  const tmpPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : ""), { encoding: "utf8", mode: 0o600 });
  renameSync(tmpPath, outputPath);
  return {
    outputPath,
    entries,
    scannedFiles: paths.length,
    indexedEntries: entries.length,
    skippedFiles,
    coverage: "head_tail_metadata"
  };
}

/**
 * Read the already-redacted session index without touching the raw session tree.
 * Automatic exports use this path so the 20GB+ Codex session directory is not
 * recursively scanned on every timer tick.
 */
export function readRedactedSessionIndex(inputPath?: string): RedactedSessionIndexEntry[] {
  const outputPath = resolve(inputPath ?? process.env.AUTOMATION_OS_CODEX_SESSION_INDEX ?? join(homedir(), ".codex", "session-index.jsonl"));
  if (!existsSync(outputPath)) return [];
  try {
    return readFileSync(outputPath, "utf8")
      .split("\n")
      .map((line) => parseJson(line))
      .filter(isRedactedSessionIndexEntry)
      .sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime));
  } catch {
    return [];
  }
}

function readSessionIndexEntry(file: string, sessionsDir: string, stat: { size: number; mtime: Date }): RawSessionEntry {
  const slices = readFileSlices(file, 32 * 1024, 96 * 1024);
  const lines = `${slices.head}\n${slices.tail}`.split("\n");
  let sessionId = basenameSessionId(file);
  let cwd = "unknown";
  let threadSource = "unknown";
  let parentThreadId: string | null = null;
  let startedAt: string | null = null;
  let lastUser = "none";
  let lastAssistant = "none";
  let exactBlocker = "none";
  for (const line of lines) {
    const record = parseJson(line);
    if (!record) continue;
    const timestamp = stringValue(record.timestamp);
    if (timestamp && !startedAt) startedAt = timestamp;
    const payload = objectValue(record.payload);
    if (record.type === "session_meta") {
      sessionId = stringValue(payload?.id) ?? sessionId;
      cwd = stringValue(payload?.cwd) ?? cwd;
      threadSource = stringValue(payload?.thread_source)
        ?? stringValue(payload?.threadSource)
        ?? stringValue(payload?.source)
        ?? stringValue(payload?.originator)
        ?? threadSource;
      parentThreadId = stringValue(payload?.parent_thread_id) ?? stringValue(payload?.parentThreadId) ?? parentThreadId;
    }
    if (record.type === "turn_context") cwd = stringValue(payload?.cwd) ?? cwd;
    if (record.type === "event_msg" && payload?.type === "user_message") lastUser = stringValue(payload.message) ?? lastUser;
    if (record.type === "response_item") {
      const message = objectValue(payload);
      if (message?.type === "message") {
        const role = stringValue(message.role);
        const text = extractMessageText(message.content);
        if (role === "user") lastUser = text || lastUser;
        if (role === "assistant") lastAssistant = text || lastAssistant;
      }
    }
    const lineText = `${stringValue(payload?.message) ?? ""} ${line}`;
    const blocker = lineText.match(/(?:exact[_ ]?blocker|blocker)\s*[:=]\s*["'`]?([a-z0-9_.:-]{4,120})/i);
    if (blocker) exactBlocker = blocker[1];
  }
  const sourceHash = createHash("sha256").update(`${file}|${stat.size}|${stat.mtime.toISOString()}`).digest("hex");
  return {
    file: file.startsWith(`${sessionsDir}/`) ? file.slice(sessionsDir.length + 1) : file,
    sessionId,
    mtime: stat.mtime.toISOString(),
    cwd,
    lastUser,
    lastAssistant,
    threadSource,
    parentThreadId,
    startedAt,
    endedAt: stat.mtime.toISOString(),
    sourceHash,
    blockerClass: classifySessionBlocker(exactBlocker === "none" ? `${lastUser} ${lastAssistant}` : exactBlocker),
    exactBlocker,
    nextAction: "unknown",
    restartPoint: cwd,
    coverage: "head_tail_metadata"
  };
}

function classifySessionBlocker(value: string): string {
  const normalized = value.toLowerCase();
  if (/captcha|\botp\b|security[_ -]?code|identity|human[_ -]?input/.test(normalized)) return "human_review";
  if (/secret|password|billing|purchase|payment|checkout|delete|external[_ -]?effect[_ -]?(?:ambiguous|uncertain)/.test(normalized)) return "hard_block";
  if (/project_not_resolved|connector|wrong_surface|scope_mismatch|route_pending/.test(normalized)) return "route_pending";
  if (/readback|receipt|coverage|proof|unverified/.test(normalized)) return "unverified";
  if (/timeout|timed[_ -]?out|econnreset|temporar|retry/.test(normalized)) return "retryable";
  if (/blocked|blocker/.test(normalized)) return "unknown_blocker";
  return "none";
}

function readFileSlices(file: string, headBytes: number, tailBytes: number): { head: string; tail: string } {
  const stat = statSync(file);
  const fd = openSync(file, "r");
  try {
    const headLength = Math.min(stat.size, headBytes);
    const headBuffer = Buffer.alloc(headLength);
    readSync(fd, headBuffer, 0, headLength, 0);
    const tailLength = Math.min(stat.size, tailBytes);
    const tailBuffer = Buffer.alloc(tailLength);
    readSync(fd, tailBuffer, 0, tailLength, Math.max(0, stat.size - tailLength));
    return { head: headBuffer.toString("utf8"), tail: tailBuffer.toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

function listJsonlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return listJsonlFiles(file);
    return entry.isFile() && entry.name.endsWith(".jsonl") ? [file] : [];
  });
}

function safeStat(file: string): { size: number; mtime: Date } | null {
  try {
    const stat = statSync(file);
    return stat.isFile() ? { size: stat.size, mtime: stat.mtime } : null;
  } catch {
    return null;
  }
}

function basenameSessionId(file: string): string {
  const name = file.split("/").pop() ?? file;
  const match = name.match(/rollout-[^-]+-[^-]+-[^-]+-[^-]+-([0-9a-f-]{20,})\.jsonl$/i);
  return match?.[1] ?? name.replace(/\.jsonl$/, "");
}

function parseJson(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isRedactedSessionIndexEntry(value: Record<string, unknown> | null): value is RedactedSessionIndexEntry {
  return Boolean(
    value
      && typeof value.file === "string"
      && typeof value.sessionId === "string"
      && typeof value.mtime === "string"
      && typeof value.cwd === "string"
      && typeof value.lastUser === "string"
      && typeof value.lastAssistant === "string"
      && typeof value.threadSource === "string"
      && (value.parentThreadId === null || typeof value.parentThreadId === "string")
      && typeof value.reviewStatus === "string"
      && typeof value.promotionAllowed === "boolean"
  );
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function extractMessageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      const object = objectValue(item);
      return stringValue(object?.text) ?? stringValue(object?.value) ?? "";
    })
    .filter(Boolean)
    .join(" ");
}

function isLocatorToken(token: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)
    || /^rollout-\d{4}-\d{2}-\d{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9a-f-]+(?:\.jsonl)?$/i.test(token);
}

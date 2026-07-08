import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { guardObsidianVaultPath } from "./vaultGuard.js";

const inboxFolder = "09_Inbox";
const defaultSourceType = "capture";

export type ObsidianIngestInput = {
  sourceUrl?: string;
  sourceTitle?: string;
  sourceType?: string;
  text?: string;
  vaultPath?: string;
  capturedAt?: string;
  statusFile?: string;
};

export type ObsidianIngestResult =
  | {
      ok: true;
      vaultPath: string;
      inboxDir: string;
      file: string;
      path: string;
      sourceType: string;
      capturedAt: string;
      bytes: number;
    }
  | {
      ok: false;
      vaultPath: string;
      inboxDir?: string;
      error: string;
      summary: string;
    };

export function runObsidianIngest(input: ObsidianIngestInput): ObsidianIngestResult {
  const vaultGuard = guardObsidianVaultPath(input.vaultPath);
  if (!vaultGuard.ok) {
    const result: ObsidianIngestResult = {
      ok: false,
      vaultPath: vaultGuard.vaultPath,
      error: vaultGuard.error,
      summary: vaultGuard.summary
    };
    writeOptionalStatusFile(result, input.statusFile);
    return result;
  }

  const sourceType = normalizeScalar(input.sourceType) || defaultSourceType;
  const text = typeof input.text === "string" ? input.text : "";
  if (!text.trim()) {
    const result: ObsidianIngestResult = {
      ok: false,
      vaultPath: vaultGuard.vaultPath,
      error: "obsidian_ingest_text_required",
      summary: "text is required"
    };
    writeOptionalStatusFile(result, input.statusFile);
    return result;
  }

  const capturedAt = normalizeCapturedAt(input.capturedAt);
  if (!capturedAt) {
    const result: ObsidianIngestResult = {
      ok: false,
      vaultPath: vaultGuard.vaultPath,
      error: "obsidian_ingest_captured_at_invalid",
      summary: "capturedAt must be an ISO-compatible timestamp"
    };
    writeOptionalStatusFile(result, input.statusFile);
    return result;
  }

  const vaultPath = vaultGuard.vaultPath;
  mkdirSync(vaultPath, { recursive: true });
  const vaultRealPath = realpathSync(vaultPath);
  const inboxDir = join(vaultPath, inboxFolder);
  const inboxGuard = ensureInboxDirectory({ vaultRealPath, inboxDir });
  if (!inboxGuard.ok) {
    const result: ObsidianIngestResult = {
      ok: false,
      vaultPath,
      inboxDir,
      error: inboxGuard.error,
      summary: inboxGuard.summary
    };
    writeOptionalStatusFile(result, input.statusFile);
    return result;
  }

  const title = normalizeScalar(input.sourceTitle) || sourceType;
  const filename = allocateFilename(inboxDir, safeFilenameStem(title || sourceType));
  const path = join(inboxDir, filename);
  const markdown = renderInboxMarkdown({
    sourceUrl: normalizeScalar(input.sourceUrl),
    sourceTitle: title,
    sourceType,
    text,
    capturedAt
  });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;

  writeFileSync(tmpPath, markdown);
  try {
    const tmpRealPath = realpathSync(tmpPath);
    const tmpBlocker = realpathBlocker({ vaultRealPath, realPath: tmpRealPath });
    if (tmpBlocker) {
      rmSync(tmpPath, { force: true });
      const result: ObsidianIngestResult = {
        ok: false,
        vaultPath,
        inboxDir,
        error: tmpBlocker,
        summary: "temporary ingest file resolved outside the vault"
      };
      writeOptionalStatusFile(result, input.statusFile);
      return result;
    }
    const preRenameInbox = lstatSync(inboxDir);
    if (preRenameInbox.isSymbolicLink() || !preRenameInbox.isDirectory()) {
      rmSync(tmpPath, { force: true });
      const result: ObsidianIngestResult = {
        ok: false,
        vaultPath,
        inboxDir,
        error: "obsidian_inbox_not_directory",
        summary: "09_Inbox must be a real directory"
      };
      writeOptionalStatusFile(result, input.statusFile);
      return result;
    }
    renameSync(tmpPath, path);
    const targetRealPath = realpathSync(path);
    const targetBlocker = realpathBlocker({ vaultRealPath, realPath: targetRealPath });
    if (targetBlocker) {
      rmSync(path, { force: true });
      const result: ObsidianIngestResult = {
        ok: false,
        vaultPath,
        inboxDir,
        error: targetBlocker,
        summary: "ingested file resolved outside the vault"
      };
      writeOptionalStatusFile(result, input.statusFile);
      return result;
    }
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }

  const result: ObsidianIngestResult = {
    ok: true,
    vaultPath,
    inboxDir,
    file: join(inboxFolder, filename),
    path,
    sourceType,
    capturedAt,
    bytes: Buffer.byteLength(markdown)
  };
  writeOptionalStatusFile(result, input.statusFile);
  return result;
}

function ensureInboxDirectory(input: { vaultRealPath: string; inboxDir: string }):
  | { ok: true }
  | { ok: false; error: string; summary: string } {
  if (existsSync(input.inboxDir)) {
    const stat = lstatSync(input.inboxDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return { ok: false, error: "obsidian_inbox_not_directory", summary: "09_Inbox must be a real directory" };
    }
  } else {
    mkdirSync(input.inboxDir, { recursive: true });
  }
  const inboxRealPath = realpathSync(input.inboxDir);
  const blocker = realpathBlocker({ vaultRealPath: input.vaultRealPath, realPath: inboxRealPath });
  if (blocker) return { ok: false, error: blocker, summary: "09_Inbox resolved outside the vault" };
  return { ok: true };
}

function renderInboxMarkdown(input: { sourceUrl?: string; sourceTitle: string; sourceType: string; text: string; capturedAt: string }): string {
  const sourceUrl = input.sourceUrl || "unknown";
  const sourceOfTruth = sourceUrl !== "unknown" ? sourceUrl : `obsidian-ingest:${input.sourceType}`;
  const fence = codeFenceFor(input.text);
  return [
    "---",
    "kind: inbox",
    "needs_classification: yes",
    "auto_process: obsidian_internal_only",
    "processing_status: queued",
    "suggested_destination: unknown",
    `source_url: ${yamlString(sourceUrl)}`,
    `source_type: ${yamlString(input.sourceType)}`,
    `capture_type: ${yamlString(input.sourceType)}`,
    `source_title: ${yamlString(input.sourceTitle)}`,
    `captured_at: ${yamlString(input.capturedAt)}`,
    `source_of_truth: ${yamlString(sourceOfTruth)}`,
    "external_action_required: false",
    "approval_required: false",
    "---",
    "",
    `# ${escapeMarkdownHeading(input.sourceTitle)}`,
    "",
    "## Source Pointer",
    "",
    `- Source URL: ${sourceUrl === "unknown" ? "`unknown`" : markdownAutolink(sourceUrl)}`,
    `- Source type: \`${escapeInlineCode(input.sourceType)}\``,
    `- Captured at: \`${escapeInlineCode(input.capturedAt)}\``,
    "",
    "## Content",
    "",
    `${fence}text`,
    input.text.replace(/\s+$/u, ""),
    fence,
    ""
  ].join("\n");
}

function allocateFilename(inboxDir: string, stem: string): string {
  let index = 1;
  while (true) {
    const suffix = index === 1 ? "" : `-${index}`;
    const filename = `${stem}${suffix}.md`;
    if (!existsSync(join(inboxDir, filename))) return filename;
    index += 1;
  }
}

function safeFilenameStem(value: string): string {
  const sanitized = value
    .normalize("NFKD")
    .replace(/[\\/]+/g, " ")
    .replace(/\.\.+/g, " ")
    .replace(/[\u0000-\u001f\u007f:*?"<>|]/g, " ")
    .replace(/[^A-Za-z0-9._ -]+/g, " ")
    .replace(/\s+/g, "-")
    .replace(/[-.]+$/g, "")
    .replace(/^[-.]+/g, "")
    .slice(0, 80);
  return sanitized || "obsidian-capture";
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function normalizeScalar(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeCapturedAt(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return new Date().toISOString();
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || Number.isNaN(Date.parse(trimmed))) return undefined;
  return trimmed;
}

function codeFenceFor(text: string): string {
  const matches = text.match(/`{3,}/g) ?? [];
  const longest = matches.reduce((max, fence) => Math.max(max, fence.length), 2);
  return "`".repeat(longest + 1);
}

function escapeMarkdownHeading(value: string): string {
  return value.replace(/\r?\n/g, " ").trim() || "Untitled Capture";
}

function markdownAutolink(value: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/[<>\s]/.test(value)) return `<${value}>`;
  return `\`${escapeInlineCode(value)}\``;
}

function escapeInlineCode(value: string): string {
  return value.replace(/`/g, "\\`");
}

function writeOptionalStatusFile(result: ObsidianIngestResult, statusFile?: string): void {
  if (!statusFile) return;
  const path = resolve(statusFile);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(result, null, 2));
  renameSync(tmpPath, path);
}

function realpathBlocker(input: { vaultRealPath: string; realPath: string }): string | undefined {
  const rel = relative(input.vaultRealPath, input.realPath);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes(".."))) return undefined;
  return "realpath_outside_vault";
}

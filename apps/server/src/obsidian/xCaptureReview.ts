import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { guardObsidianVaultPath } from "./vaultGuard.js";

const inboxFolder = "09_Inbox";
const controlPanelFolder = "01_Control Panel";
const queueFilename = "X Capture Review Queue.md";
const processorName = "automation-os-x-capture-review";
const defaultOutputRoot = join(process.cwd(), "data", "x-capture-review");

export type XCaptureReviewCategory =
  | "workflow_idea"
  | "tool_candidate"
  | "memory_pattern"
  | "obsidian_pattern"
  | "agent_coordination"
  | "ignore";

export type XCapturePromotionTarget = "Decision" | "Runbook" | "Skill draft" | "Automation OS issue" | "Test idea" | "None";

export type XCaptureReviewOptions = {
  vaultPath?: string;
  outputRoot?: string;
  reviewedAt?: string;
};

export type XCaptureReviewItem = {
  file: string;
  title: string;
  sourceUrl?: string;
  sourceType?: string;
  category: XCaptureReviewCategory;
  promotionTargets: XCapturePromotionTarget[];
  actionability: "high" | "medium" | "low";
  risk: "low" | "medium" | "high";
  recommendation: string;
  evidenceExcerpt: string;
};

export type XCaptureReviewResult =
  | {
      ok: true;
      vaultPath: string;
      reviewedAt: string;
      scanned: number;
      reviewed: number;
      jsonPath: string;
      queuePath: string;
      items: XCaptureReviewItem[];
    }
  | {
      ok: false;
      vaultPath: string;
      reviewedAt: string;
      error: string;
      summary: string;
      scanned: number;
      reviewed: number;
      items: XCaptureReviewItem[];
    };

type ParsedFrontmatter = {
  values: Record<string, string>;
  body: string;
};

export function runXCaptureReview(options: XCaptureReviewOptions = {}): XCaptureReviewResult {
  const reviewedAt = normalizeReviewedAt(options.reviewedAt);
  const vaultGuard = guardObsidianVaultPath(options.vaultPath);
  if (!vaultGuard.ok) {
    return {
      ok: false,
      vaultPath: vaultGuard.vaultPath,
      reviewedAt,
      error: vaultGuard.error,
      summary: vaultGuard.summary,
      scanned: 0,
      reviewed: 0,
      items: []
    };
  }

  const vaultPath = vaultGuard.vaultPath;
  mkdirSync(vaultPath, { recursive: true });
  const vaultRealPath = realpathSync(vaultPath);
  const inboxDir = join(vaultPath, inboxFolder);
  const inboxGuard = ensureRealDirectoryInsideVault({ vaultRealPath, dir: inboxDir, label: inboxFolder, create: false });
  if (!inboxGuard.ok) return blocked({ vaultPath, reviewedAt, error: inboxGuard.error, summary: inboxGuard.summary });

  const notes = collectXCaptureNotes({ vaultPath, vaultRealPath, inboxDir });
  const items = notes.map((note) => reviewXCaptureNote(note));
  const outputRoot = resolve(options.outputRoot ?? defaultOutputRoot);
  mkdirSync(outputRoot, { recursive: true });
  const jsonPath = join(outputRoot, `review-${dateToken(reviewedAt)}.json`);
  const controlPanelDir = join(vaultPath, controlPanelFolder);
  const controlPanelGuard = ensureRealDirectoryInsideVault({ vaultRealPath, dir: controlPanelDir, label: controlPanelFolder, create: true });
  if (!controlPanelGuard.ok) {
    return blocked({ vaultPath, reviewedAt, error: controlPanelGuard.error, summary: controlPanelGuard.summary, scanned: notes.length, items });
  }
  const queuePath = join(controlPanelDir, queueFilename);
  const existingGuard = generatedFileGuard(queuePath);
  if (!existingGuard.ok) {
    return blocked({ vaultPath, reviewedAt, error: existingGuard.error, summary: existingGuard.summary, scanned: notes.length, items });
  }

  writeJsonAtomic(jsonPath, {
    generatedBy: processorName,
    reviewedAt,
    vaultPath,
    sourceGlob: "09_Inbox/X-auth-capture-*.md",
    boundary: {
      externalFetch: false,
      post: false,
      move: false,
      delete: false,
      browserSessionChange: false
    },
    scanned: notes.length,
    reviewed: items.length,
    items
  });
  writeTextAtomic(queuePath, renderQueueMarkdown({ reviewedAt, jsonPath, items }));

  return {
    ok: true,
    vaultPath,
    reviewedAt,
    scanned: notes.length,
    reviewed: items.length,
    jsonPath,
    queuePath,
    items
  };
}

function collectXCaptureNotes(input: { vaultPath: string; vaultRealPath: string; inboxDir: string }) {
  if (!existsSync(input.inboxDir)) return [];
  return readdirSync(input.inboxDir)
    .filter((entry) => entry.startsWith("X-auth-capture-") && entry.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b))
    .flatMap((entry) => {
      const path = join(input.inboxDir, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) return [];
      const realPath = realpathSync(path);
      if (realpathBlocker({ vaultRealPath: input.vaultRealPath, realPath })) return [];
      const markdown = readFileSync(path, "utf8");
      const parsed = parseFrontmatter(markdown);
      return [
        {
          path,
          file: relative(input.vaultPath, path),
          filename: entry,
          frontmatter: parsed.values,
          body: parsed.body
        }
      ];
    });
}

function reviewXCaptureNote(note: {
  file: string;
  filename: string;
  frontmatter: Record<string, string>;
  body: string;
}): XCaptureReviewItem {
  const title = frontmatterValue(note.frontmatter, "source_title", "sourceTitle", "title") || titleFromFilename(note.filename);
  const sourceUrl = frontmatterValue(note.frontmatter, "source_url", "sourceUrl");
  const sourceType = frontmatterValue(note.frontmatter, "source_type", "sourceType", "capture_type", "captureType");
  const text = `${title}\n${note.body}`.toLowerCase();
  const category = classify(text);
  return {
    file: note.file,
    title,
    sourceUrl,
    sourceType,
    category,
    promotionTargets: promotionTargets(category),
    actionability: actionability(category),
    risk: risk(category, text),
    recommendation: recommendation(category),
    evidenceExcerpt: excerpt(note.body)
  };
}

function classify(text: string): XCaptureReviewCategory {
  if (/(agentmemory|memory\.md|persistent memory|memory pattern|mem0|vector memory|remember)/iu.test(text)) return "memory_pattern";
  if (/(notebooklm|gemini|obsidian|second brain|knowledge graph)/iu.test(text)) return "obsidian_pattern";
  if (/(claude code|codex|agent workflow|sub.?agent|orchestrator|multi.?agent|agentic)/iu.test(text)) return "agent_coordination";
  if (/(tool|library|framework|product|app|extension)/iu.test(text)) return "tool_candidate";
  if (/(workflow|automation|pipeline|process|queue)/iu.test(text)) return "workflow_idea";
  return "ignore";
}

function promotionTargets(category: XCaptureReviewCategory): XCapturePromotionTarget[] {
  if (category === "agent_coordination") return ["Runbook", "Test idea"];
  if (category === "memory_pattern") return ["Decision", "Runbook"];
  if (category === "obsidian_pattern") return ["Automation OS issue", "Runbook"];
  if (category === "workflow_idea") return ["Runbook", "Automation OS issue"];
  if (category === "tool_candidate") return ["Decision"];
  return ["None"];
}

function actionability(category: XCaptureReviewCategory): XCaptureReviewItem["actionability"] {
  if (category === "ignore") return "low";
  if (category === "tool_candidate") return "medium";
  return "high";
}

function risk(category: XCaptureReviewCategory, text: string): XCaptureReviewItem["risk"] {
  if (category === "tool_candidate" || /(external|publish|send|submit|buy|delete|login|token|api key)/iu.test(text)) return "medium";
  if (category === "ignore") return "low";
  return "low";
}

function recommendation(category: XCaptureReviewCategory): string {
  switch (category) {
    case "agent_coordination":
      return "Extract stage gates, proof requirements, and review checks into an Automation OS runbook or test idea before changing production workflows.";
    case "memory_pattern":
      return "Compare against current MEMORY.md and Obsidian Second Brain before adopting; promote only explicit durable patterns.";
    case "obsidian_pattern":
      return "Use as input for capture summarization, duplicate detection, and review queue improvements inside the existing Second Brain boundary.";
    case "workflow_idea":
      return "Translate into a small runbook or Automation OS issue with source-of-truth and proof gates.";
    case "tool_candidate":
      return "Evaluate as a decision record first; do not install or connect external tooling from the post alone.";
    case "ignore":
      return "Keep in Inbox unless a future task provides stronger local relevance.";
  }
}

function renderQueueMarkdown(input: { reviewedAt: string; jsonPath: string; items: XCaptureReviewItem[] }): string {
  const ready = input.items.filter((item) => item.category !== "ignore");
  const lines = [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: x-capture-review-queue",
    `generated_at: ${yamlQuote(input.reviewedAt)}`,
    "source_of_truth: data/x-capture-review JSON plus Obsidian 09_Inbox X authenticated capture notes",
    "---",
    "",
    "# X Capture Review Queue",
    "",
    "Generated review queue for X authenticated captures. This page does not fetch URLs, move notes, post, publish, send, submit, delete, or change browser sessions.",
    "",
    "## Summary",
    "",
    `- Reviewed captures: ${input.items.length}`,
    `- Ready to promote: ${ready.length}`,
    `- JSON proof: \`${input.jsonPath}\``,
    "",
    "## Ready To Promote",
    ""
  ];

  if (ready.length === 0) {
    lines.push("No X captures are ready to promote.", "");
  } else {
    for (const item of ready) {
      lines.push(
        `### ${item.title}`,
        "",
        `- File: [[${item.file.replace(/\.md$/u, "")}]]`,
        `- Category: ${item.category}`,
        `- Promotion target: ${item.promotionTargets.join(", ")}`,
        `- Actionability: ${item.actionability}`,
        `- Risk: ${item.risk}`,
        `- Recommendation: ${item.recommendation}`,
        `- Evidence: ${item.evidenceExcerpt}`,
        ""
      );
    }
  }

  const ignored = input.items.filter((item) => item.category === "ignore");
  if (ignored.length > 0) {
    lines.push("## Keep In Inbox", "");
    for (const item of ignored) lines.push(`- [[${item.file.replace(/\.md$/u, "")}]] - ${item.title}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function parseFrontmatter(markdown: string): ParsedFrontmatter {
  if (!markdown.startsWith("---\n")) return { values: {}, body: markdown };
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) return { values: {}, body: markdown };
  const frontmatter = markdown.slice(4, end).split(/\r?\n/u);
  const values: Record<string, string> = {};
  for (const line of frontmatter) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/u);
    if (!match) continue;
    values[match[1]] = unquoteScalar(match[2]);
  }
  return { values, body: markdown.slice(end + 5).trim() };
}

function ensureRealDirectoryInsideVault(input: { vaultRealPath: string; dir: string; label: string; create: boolean }):
  | { ok: true }
  | { ok: false; error: string; summary: string } {
  if (!existsSync(input.dir)) {
    if (!input.create) return { ok: true };
    mkdirSync(input.dir, { recursive: true });
  }
  const stat = lstatSync(input.dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return { ok: false, error: "obsidian_x_capture_review_directory_invalid", summary: `${input.label} must be a real directory` };
  }
  const realPath = realpathSync(input.dir);
  const blocker = realpathBlocker({ vaultRealPath: input.vaultRealPath, realPath });
  if (blocker) return { ok: false, error: blocker, summary: `${input.label} resolved outside the vault` };
  return { ok: true };
}

function generatedFileGuard(path: string): { ok: true } | { ok: false; error: string; summary: string } {
  if (!existsSync(path)) return { ok: true };
  const markdown = readFileSync(path, "utf8");
  if (/^generated_by:\s*automation-os\s*$/m.test(markdown)) return { ok: true };
  return {
    ok: false,
    error: "obsidian_x_capture_review_non_generated_target",
    summary: "refusing to overwrite non-generated X Capture Review Queue note"
  };
}

function writeJsonAtomic(path: string, payload: unknown) {
  writeTextAtomic(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function writeTextAtomic(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, text);
  try {
    renameSync(tmpPath, path);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

function blocked(input: {
  vaultPath: string;
  reviewedAt: string;
  error: string;
  summary: string;
  scanned?: number;
  items?: XCaptureReviewItem[];
}): XCaptureReviewResult {
  return {
    ok: false,
    vaultPath: input.vaultPath,
    reviewedAt: input.reviewedAt,
    error: input.error,
    summary: input.summary,
    scanned: input.scanned ?? 0,
    reviewed: input.items?.length ?? 0,
    items: input.items ?? []
  };
}

function realpathBlocker(input: { vaultRealPath: string; realPath: string }): string | undefined {
  const rel = relative(input.vaultRealPath, input.realPath);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return undefined;
  return "obsidian_x_capture_review_path_escaped_vault";
}

function frontmatterValue(values: Record<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = values[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function titleFromFilename(filename: string): string {
  return basename(filename, ".md").replace(/^X-auth-capture-/u, "").replace(/-/gu, " ");
}

function excerpt(text: string): string {
  const clean = redact(text)
    .replace(/^---[\s\S]*?---/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  return clean.length > 220 ? `${clean.slice(0, 217)}...` : clean || "No body excerpt available.";
}

function redact(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[redacted-email]")
    .replace(/\b(?:sk|pk|xox|ghp|github_pat)_[A-Za-z0-9_=-]{12,}\b/gu, "[redacted-token]")
    .replace(/([?&](?:access_token|token|key|api_key|password|auth)=)[^&\s)]+/giu, "$1[redacted]");
}

function normalizeReviewedAt(value?: string): string {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function dateToken(iso: string): string {
  return iso.slice(0, 10).replace(/-/gu, "");
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

function unquoteScalar(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

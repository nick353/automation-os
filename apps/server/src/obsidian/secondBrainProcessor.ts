import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { guardObsidianVaultPath, resolveConfiguredObsidianVaultPath } from "./vaultGuard.js";

const defaultStatusFile = join(process.cwd(), "data", "second-brain-processor-status.json");
const targetFolders = ["05_Projects", "06_Research", "07_Decisions", "08_Runbooks", "09_Inbox"];
const destinationAllowlist = new Set([...targetFolders, "unknown"]);
const processorName = "automation-os-second-brain-processor";
const upsertKeys = [
  "auto_process",
  "processing_status",
  "suggested_destination",
  "progressive_summary",
  "distillation",
  "next_use",
  "unresolved_question",
  "review_cycle",
  "external_action_required",
  "approval_required",
  "processed_by",
  "processed_at"
];
const optionalUpsertKeys = ["source_url", "source_of_truth"];
const aliasCleanupKeys = new Set([
  "suggestedDestination",
  "nextUse",
  "unresolvedQuestion",
  "reviewCycle",
  "externalActionRequired",
  "approvalRequired",
  "sourceUrl",
  "sourceOfTruth"
]);

export type SecondBrainProcessorOptions = {
  vaultPath?: string;
  apply?: boolean;
  statusFile?: string;
  processedAt?: string;
};

export type SecondBrainNoteResult = {
  file: string;
  status: "updated" | "would_update" | "unchanged" | "skipped" | "blocked";
  reason: string;
  suggestedDestination?: string;
  backupFile?: string;
};

export type SecondBrainProcessorResult = {
  ok: boolean;
  apply: boolean;
  vaultPath: string;
  statusFile?: string;
  processedAt: string;
  scanned: number;
  eligible: number;
  updated: number;
  wouldUpdate: number;
  unchanged: number;
  skipped: number;
  blocked: number;
  results: SecondBrainNoteResult[];
};

type ParsedFrontmatter = {
  hasFrontmatter: boolean;
  start: number;
  end: number;
  lines: string[];
  bodyStart: number;
  values: Record<string, string>;
};

type TargetMarkdownFile = {
  path: string;
  rel: string;
  realPath: string;
};

type NoteSignals = {
  basename: string;
  title: string;
  sourceTitle?: string;
  sourceType?: string;
  captureType?: string;
  sourceUrl?: string;
  sourceOfTruth?: string;
  body: string;
  contentText: string;
  contentExcerpt: string;
  placeholders: Set<string>;
  observedCategories: Set<string>;
};

type ReviewMetadataField = "progressive_summary" | "distillation" | "next_use" | "unresolved_question" | "review_cycle";

export function resolveSecondBrainVaultPath(input?: string): string {
  return resolveConfiguredObsidianVaultPath(input);
}

export function runSecondBrainProcessor(options: SecondBrainProcessorOptions = {}): SecondBrainProcessorResult {
  const apply = options.apply === true;
  const processedAt = options.processedAt ?? new Date().toISOString();
  const vaultGuard = guardObsidianVaultPath(options.vaultPath);
  if (!vaultGuard.ok) return blockedProcessorResult({ apply, vaultPath: vaultGuard.vaultPath, processedAt, reason: vaultGuard.error });
  const vaultPath = vaultGuard.vaultPath;
  const vaultRealPath = existsSync(vaultPath) ? realpathSync(vaultPath) : resolve(vaultPath);
  const results: SecondBrainNoteResult[] = [];
  const files = collectTargetMarkdownFiles(vaultPath, vaultRealPath);
  let eligible = 0;

  for (const candidate of files) {
    const markdown = readFileSync(candidate.path, "utf8");
    const parsed = parseFrontmatter(markdown);
    const skipReason = skipReasonForNote({ vaultPath, path: candidate.path, markdown, frontmatter: parsed.values });
    if (skipReason) {
      results.push({ file: candidate.rel, status: skipReason.status, reason: skipReason.reason });
      continue;
    }
    eligible += 1;
    if (frontmatterFlagIsTrue(parsed.values.external_action_required, parsed.values.externalActionRequired, parsed.values.approval_required, parsed.values.approvalRequired)) {
      results.push({ file: candidate.rel, status: "blocked", reason: "external_or_approval_required_true" });
      continue;
    }

    const updates = buildUpdates({ path: candidate.path, markdown, frontmatter: parsed.values, processedAt });
    const suggestedDestination = String(updates.suggested_destination);
    const nextMarkdown = upsertFrontmatter(markdown, parsed, updates);
    if (nextMarkdown === markdown) {
      results.push({ file: candidate.rel, status: "unchanged", reason: "already_review_ready", suggestedDestination });
      continue;
    }

    if (!apply) {
      results.push({ file: candidate.rel, status: "would_update", reason: "dry_run", suggestedDestination });
      continue;
    }

    const prewriteBlockReason = realpathBlocker({ vaultRealPath, realPath: realpathSync(candidate.path) });
    if (prewriteBlockReason) {
      results.push({ file: candidate.rel, status: "blocked", reason: prewriteBlockReason, suggestedDestination });
      continue;
    }
    const backupFile = backupNoteBeforeUpdate({ vaultPath, vaultRealPath, path: candidate.path, processedAt });
    writeMarkdownAtomic(candidate.path, nextMarkdown);
    results.push({ file: candidate.rel, status: "updated", reason: "frontmatter_updated", suggestedDestination, backupFile });
  }

  const result: SecondBrainProcessorResult = {
    ok: true,
    apply,
    vaultPath,
    statusFile: apply ? resolveStatusFile(options.statusFile) : undefined,
    processedAt,
    scanned: files.length,
    eligible,
    updated: results.filter((result) => result.status === "updated").length,
    wouldUpdate: results.filter((result) => result.status === "would_update").length,
    unchanged: results.filter((result) => result.status === "unchanged").length,
    skipped: results.filter((result) => result.status === "skipped").length,
    blocked: results.filter((result) => result.status === "blocked").length,
    results
  };
  if (apply) writeStatusFile(result, options.statusFile);
  return result;
}

function blockedProcessorResult(input: {
  apply: boolean;
  vaultPath: string;
  processedAt: string;
  reason: string;
}): SecondBrainProcessorResult {
  return {
    ok: false,
    apply: input.apply,
    vaultPath: input.vaultPath,
    processedAt: input.processedAt,
    scanned: 0,
    eligible: 0,
    updated: 0,
    wouldUpdate: 0,
    unchanged: 0,
    skipped: 0,
    blocked: 1,
    results: [
      {
        file: ".",
        status: "blocked",
        reason: input.reason
      }
    ]
  };
}

function collectTargetMarkdownFiles(vaultPath: string, vaultRealPath: string): TargetMarkdownFile[] {
  return targetFolders.flatMap((folder) => {
    const root = join(vaultPath, folder);
    if (!existsSync(root)) return [];
    const stat = lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return [];
    return readMarkdownFiles(root, vaultPath, vaultRealPath);
  });
}

function readMarkdownFiles(dir: string, vaultPath: string, vaultRealPath: string): TargetMarkdownFile[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = join(dir, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return [];
      if (stat.isDirectory()) {
        if (shouldSkipDirectoryName(entry)) return [];
        return readMarkdownFiles(path, vaultPath, vaultRealPath);
      }
      if (!stat.isFile() || !entry.endsWith(".md")) return [];
      const realPath = realpathSync(path);
      if (realpathBlocker({ vaultRealPath, realPath })) return [];
      return [{ path, rel: relative(vaultPath, path), realPath }];
    })
    .sort((left, right) => left.rel.localeCompare(right.rel));
}

function shouldSkipDirectoryName(name: string): boolean {
  const lower = name.toLowerCase();
  return name === ".backups" || name === ".obsidian" || lower === "templates" || lower === "_templates" || lower.includes("generated");
}

function skipReasonForNote(input: {
  vaultPath: string;
  path: string;
  markdown: string;
  frontmatter: Record<string, string>;
}): { status: "skipped" | "blocked"; reason: string } | undefined {
  const rel = relative(input.vaultPath, input.path);
  if (!targetFolders.some((folder) => rel === folder || rel.startsWith(`${folder}${sep}`))) {
    return { status: "skipped", reason: "outside_target_folders" };
  }
  if (hasGeneratedByMarker(input.markdown) || input.frontmatter.generated_by === "automation-os") {
    return { status: "skipped", reason: "generated_by_automation_os" };
  }
  if (frontmatterFlagIsTrue(input.frontmatter.workflow_owned, input.frontmatter.workflowOwned)) {
    return { status: "skipped", reason: "workflow_owned" };
  }
  if (!isExplicitlyOptedIn(input.frontmatter)) {
    return { status: "skipped", reason: "not_explicitly_opted_in" };
  }
  return undefined;
}

function isExplicitlyOptedIn(frontmatter: Record<string, string>): boolean {
  if (String(frontmatter.auto_process ?? "").trim() === "obsidian_internal_only") return true;
  return frontmatterFlagIsTrue(frontmatter.needs_classification, frontmatter.needsClassification);
}

function buildUpdates(input: { path: string; markdown: string; frontmatter: Record<string, string>; processedAt: string }): Record<string, string | boolean> {
  const signals = buildNoteSignals(input);
  const summary = reusableFieldValue({
    value: input.frontmatter.progressive_summary,
    field: "progressive_summary",
    signals,
    fallback: () => summarizeSignals(signals)
  });
  const destination = resolveDestination({
    canonicalRaw: firstPresentString(input.frontmatter.suggested_destination),
    aliasRaw: firstPresentString(input.frontmatter.suggestedDestination),
    frontmatter: input.frontmatter,
    signals
  });
  const sourcePointerUpdates = canonicalSourcePointerUpdates(input.frontmatter);
  const semanticUpdates: Record<string, string | boolean> = {
    auto_process: "obsidian_internal_only",
    processing_status: "review_ready",
    suggested_destination: destination,
    progressive_summary: summary,
    distillation: reusableFieldValue({
      value: input.frontmatter.distillation,
      field: "distillation",
      signals,
      fallback: () => distillSignals(signals, summary)
    }),
    next_use: reusableFieldValue({
      value: firstPresentString(input.frontmatter.next_use, input.frontmatter.nextUse),
      field: "next_use",
      signals,
      fallback: () => inferNextUse(destination, summary)
    }),
    unresolved_question: reusableFieldValue({
      value: firstPresentString(input.frontmatter.unresolved_question, input.frontmatter.unresolvedQuestion),
      field: "unresolved_question",
      signals,
      fallback: () => inferUnresolvedQuestion(signals)
    }),
    review_cycle: reusableFieldValue({
      value: firstPresentString(input.frontmatter.review_cycle, input.frontmatter.reviewCycle),
      field: "review_cycle",
      signals,
      fallback: () => defaultReviewCycle(destination)
    }),
    external_action_required: false,
    approval_required: false,
    processed_by: processorName
  };
  return {
    ...semanticUpdates,
    ...sourcePointerUpdates,
    processed_at: shouldPreserveProcessedAt({ frontmatter: input.frontmatter, updates: semanticUpdates }) ? String(input.frontmatter.processed_at) : input.processedAt
  };
}

function buildNoteSignals(input: { path: string; markdown: string; frontmatter: Record<string, string> }): NoteSignals {
  const body = stripFrontmatter(input.markdown);
  const fileBasename = basename(input.path, ".md");
  const title = firstPresentString(input.frontmatter.title) ?? fileBasename;
  const sourceTitle = firstPresentString(input.frontmatter.source_title, input.frontmatter.sourceTitle);
  const sourceType = firstPresentString(input.frontmatter.source_type, input.frontmatter.sourceType);
  const captureType = firstPresentString(input.frontmatter.capture_type, input.frontmatter.captureType, sourceType);
  const sourceUrl = firstPresentString(input.frontmatter.source_url, input.frontmatter.sourceUrl);
  const sourceOfTruth = firstPresentString(input.frontmatter.source_of_truth, input.frontmatter.sourceOfTruth);
  const contentText = extractObservedContent(body, title, sourceTitle, fileBasename);
  const contentExcerpt = shortSnippet(contentText || body || title, 220);
  const placeholders = new Set(
    [title, sourceTitle, fileBasename, stripXTitleSuffix(sourceTitle), stripXTitleSuffix(title)]
      .filter((value): value is string => Boolean(value))
      .map(normalizePlaceholder)
      .filter(Boolean)
  );
  const observedCategories = categorizeSignals({
    text: [title, sourceTitle, sourceType, captureType, sourceUrl, sourceOfTruth, contentText, body].filter(Boolean).join("\n"),
    sourceType,
    captureType,
    sourceUrl,
    sourceOfTruth,
    contentText
  });
  return {
    basename: fileBasename,
    title,
    sourceTitle,
    sourceType,
    captureType,
    sourceUrl,
    sourceOfTruth,
    body,
    contentText,
    contentExcerpt,
    placeholders,
    observedCategories
  };
}

function reusableFieldValue(input: {
  value: string | undefined;
  field: ReviewMetadataField;
  signals: NoteSignals;
  fallback: () => string;
}): string {
  const value = firstPresentString(input.value);
  if (value && !isPlaceholderFieldValue({ value, field: input.field, signals: input.signals })) return value;
  return input.fallback();
}

function isPlaceholderFieldValue(input: {
  value: string;
  field: ReviewMetadataField;
  signals: NoteSignals;
}): boolean {
  const normalized = normalizePlaceholder(input.value);
  if (!normalized) return true;
  if (input.signals.placeholders.has(normalized)) return true;
  if (isAuthenticatedCaptureEvidenceFieldValue(input.value)) return true;
  if (["review and classify", "review note", "review note source", "review note title"].includes(normalized)) return true;
  if (input.field === "distillation" && normalized === normalizePlaceholder(`Review note: ${input.signals.title}`)) return true;
  if (input.field === "next_use" && normalized === normalizePlaceholder("Review and classify.")) return true;
  if (input.field === "next_use" && isAuthenticatedCaptureEvidenceNextUseValue(input.value)) return true;
  return false;
}

function isAuthenticatedCaptureEvidenceFieldValue(value: string): boolean {
  return /^(capture id|lane|artifact directory):/i.test(value.trim());
}

function isAuthenticatedCaptureEvidenceNextUseValue(value: string): boolean {
  return /^use as research context:\s*capture id:/i.test(value.trim());
}

function resolveDestination(input: {
  canonicalRaw: string | undefined;
  aliasRaw: string | undefined;
  frontmatter: Record<string, string>;
  signals: NoteSignals;
}): string {
  const canonicalRaw = input.canonicalRaw?.trim();
  const aliasRaw = input.aliasRaw?.trim();
  if (canonicalRaw) {
    const normalized = normalizeDestination(canonicalRaw);
    if (normalized !== "unknown") return normalized;
    if (canonicalRaw.toLowerCase() !== "unknown") return "unknown";
    if (aliasRaw && normalizeDestination(aliasRaw) === "unknown" && aliasRaw.toLowerCase() !== "unknown") return "unknown";
    if (shouldPreserveCanonicalUnknownDestination(input.frontmatter, input.signals)) return "unknown";
    return inferDestination(input.signals);
  }
  if (aliasRaw) {
    const normalized = normalizeDestination(aliasRaw);
    if (normalized !== "unknown") return normalized;
    if (aliasRaw.toLowerCase() !== "unknown") return "unknown";
  }
  return inferDestination(input.signals);
}

function shouldPreserveCanonicalUnknownDestination(frontmatter: Record<string, string>, signals: NoteSignals): boolean {
  if (frontmatter.processing_status !== "review_ready") return false;
  if (frontmatter.processed_by !== processorName) return false;
  if (String(frontmatter.suggested_destination ?? "").trim().toLowerCase() !== "unknown") return false;
  return !hasPlaceholderOwnedReviewMetadata(frontmatter, signals);
}

function hasPlaceholderOwnedReviewMetadata(frontmatter: Record<string, string>, signals: NoteSignals): boolean {
  const fields: Array<{ field: ReviewMetadataField; value: string | undefined }> = [
    { field: "progressive_summary", value: frontmatter.progressive_summary },
    { field: "distillation", value: frontmatter.distillation },
    { field: "next_use", value: firstPresentString(frontmatter.next_use, frontmatter.nextUse) },
    { field: "unresolved_question", value: firstPresentString(frontmatter.unresolved_question, frontmatter.unresolvedQuestion) },
    { field: "review_cycle", value: firstPresentString(frontmatter.review_cycle, frontmatter.reviewCycle) }
  ];
  return fields.some(({ field, value }) => {
    const current = firstPresentString(value);
    return current ? isPlaceholderFieldValue({ value: current, field, signals }) : false;
  });
}

function canonicalSourcePointerUpdates(frontmatter: Record<string, string>): Record<string, string> {
  const updates: Record<string, string> = {};
  if (!firstPresentString(frontmatter.source_url)) {
    const sourceUrl = firstPresentString(frontmatter.sourceUrl);
    if (sourceUrl) updates.source_url = sourceUrl;
  }
  if (!firstPresentString(frontmatter.source_of_truth)) {
    const sourceOfTruth = firstPresentString(frontmatter.sourceOfTruth);
    if (sourceOfTruth) updates.source_of_truth = sourceOfTruth;
  }
  return updates;
}

function inferDestination(signals: NoteSignals): string {
  const scores: Record<string, number> = {
    "05_Projects": 0,
    "06_Research": 0,
    "07_Decisions": 0,
    "08_Runbooks": 0,
    "09_Inbox": 1
  };

  if (signals.observedCategories.has("project")) scores["05_Projects"] += 3;
  if (signals.observedCategories.has("research")) scores["06_Research"] += 3;
  if (signals.observedCategories.has("source_backed")) scores["06_Research"] += 2;
  if (signals.observedCategories.has("social_capture")) scores["06_Research"] += 2;
  if (signals.observedCategories.has("decision")) scores["07_Decisions"] += 4;
  if (signals.observedCategories.has("runbook")) scores["08_Runbooks"] += 4;
  if (signals.observedCategories.has("actionable") && signals.observedCategories.has("project")) scores["05_Projects"] += 1;
  if (signals.observedCategories.has("question")) scores["06_Research"] += 1;

  const ranked = Object.entries(scores).sort((left, right) => right[1] - left[1]);
  const [bestDestination, bestScore] = ranked[0] ?? ["09_Inbox", 0];
  const [, secondScore] = ranked[1] ?? ["unknown", 0];
  if (bestDestination === "09_Inbox") return "09_Inbox";
  if (bestScore >= 3 && bestScore - secondScore >= 1) return bestDestination;
  return "09_Inbox";
}

function categorizeSignals(input: {
  text: string;
  sourceType?: string;
  captureType?: string;
  sourceUrl?: string;
  sourceOfTruth?: string;
  contentText: string;
}): Set<string> {
  const categories = new Set<string>();
  const text = input.text;
  const pointer = [input.sourceUrl, input.sourceOfTruth].filter(Boolean).join("\n");
  const capture = [input.sourceType, input.captureType].filter(Boolean).join("\n");

  if (/source of truth|state\.md|automation\.toml|runbook|procedure|playbook|checklist|復旧手順|手順|運用|正本|再現|繰り返し/i.test(text)) {
    categories.add("runbook");
  }
  if (/\bdecision\b|\bdecided\b|\badr\b|trade-?off|採用理由|判断|決定|却下|revisit/i.test(text)) {
    categories.add("decision");
  }
  if (/\bproject\b|\bobjective\b|\bmilestone\b|\bdeliverable\b|\broadmap\b|\btodo\b|プロジェクト|実装|次の一手/i.test(text)) {
    categories.add("project");
  }
  if (/\bresearch\b|\bstudy\b|\bpaper\b|\binsight\b|\bcompare\b|\bcomparison\b|\bhypothesis\b|調査|研究|論文|比較|仮説|知見/i.test(text)) {
    categories.add("research");
  }
  if (/\bhttps?:\/\//i.test(pointer) || /url_capture|article|authenticated_browser_capture/i.test(capture)) {
    categories.add("source_backed");
  }
  if (/authenticated_browser_capture/i.test(capture) && /\b(x\.com|twitter\.com)\b/i.test(pointer)) {
    categories.add("social_capture");
  }
  if (/\?|\bquestion\b|unresolved|問い|課題/i.test(text)) {
    categories.add("question");
  }
  if (/\bnext\b|\baction\b|\bship\b|\bfix\b|\bbuild\b|\bimplement\b|TODO|次|対応|修正|実装/i.test(text)) {
    categories.add("actionable");
  }
  if (input.contentText.trim() && /authenticated_browser_capture|url_capture|article/i.test(capture)) {
    categories.add("research");
  }
  return categories;
}

function extractObservedContent(body: string, title: string, sourceTitle?: string, fileBasename?: string): string {
  const contentSection = body.match(/(?:^|\n)##\s+Content\s*\n([\s\S]*)/i)?.[1] ?? body;
  const fenced = contentSection.match(/```[^\n]*\n([\s\S]*?)\n```/);
  const raw = fenced?.[1] ?? contentSection;
  const placeholderValues = new Set(
    [title, sourceTitle, fileBasename, "Source Pointer", "Content"]
      .filter((value): value is string => Boolean(value))
      .map(normalizePlaceholder)
  );
  const lines = raw
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").replace(/^[-*]\s*/, "").trim())
    .filter((line) => line && !line.startsWith("```"))
    .filter((line) => !/^source (url|type):|^captured at:/i.test(line))
    .filter((line) => !isAuthenticatedCaptureEvidenceHeader(line))
    .filter((line) => !placeholderValues.has(normalizePlaceholder(line)));
  return lines.join("\n").trim();
}

function isAuthenticatedCaptureEvidenceHeader(line: string): boolean {
  return /^(capture id|lane|artifact directory):/i.test(line);
}

function summarizeSignals(signals: NoteSignals): string {
  return shortSnippet(firstMeaningfulSentence(signals.contentText) ?? signals.contentExcerpt ?? signals.title, 180);
}

function distillSignals(signals: NoteSignals, summary: string): string {
  const sentence = firstMeaningfulSentence(signals.contentText);
  if (sentence) return shortSnippet(sentence, 220);
  return summary || `Review note: ${signals.title}`;
}

function inferNextUse(destination: string, summary?: string): string {
  const suffix = summary ? ` ${shortSnippet(summary, 120)}` : "";
  if (destination === "05_Projects") return `Use in project planning:${suffix}`;
  if (destination === "06_Research") return `Use as research context:${suffix}`;
  if (destination === "07_Decisions") return `Use when revisiting the decision:${suffix}`;
  if (destination === "08_Runbooks") return `Use as operational guidance:${suffix}`;
  return `Review during inbox triage:${suffix}`;
}

function inferUnresolvedQuestion(signals: NoteSignals): string {
  const question = signals.contentText
    .split(/\n|(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .find((line) => line.endsWith("?") || /^(question|q):/i.test(line));
  return question ? shortSnippet(question.replace(/^(question|q):\s*/i, ""), 180) : "none";
}

function firstMeaningfulSentence(text: string): string | undefined {
  return text
    .split(/\n|(?<=[.!?])\s+/)
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .find((line) => line.length > 0);
}

function normalizePlaceholder(value: string | undefined): string {
  return String(value ?? "")
    .replace(/[`*_#[\]()]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[.:;!?]+$/g, "")
    .trim()
    .toLowerCase();
}

function stripXTitleSuffix(value: string | undefined): string | undefined {
  const stripped = String(value ?? "")
    .replace(/\s+[/|]\s+X\s*$/i, "")
    .replace(/\s+[/|]\s+Twitter\s*$/i, "")
    .trim();
  return stripped || undefined;
}

function shouldPreserveProcessedAt(input: { frontmatter: Record<string, string>; updates: Record<string, string | boolean> }): boolean {
  if (input.frontmatter.processing_status !== "review_ready") return false;
  if (input.frontmatter.processed_by !== processorName) return false;
  if (!firstPresentString(input.frontmatter.processed_at)) return false;
  return Object.entries(input.updates).every(([key, value]) => frontmatterValueMatches(input.frontmatter[key], value));
}

function frontmatterValueMatches(current: string | undefined, next: string | boolean): boolean {
  if (current === undefined) return false;
  if (typeof next === "boolean") return String(current).trim().toLowerCase() === String(next);
  return current.trim() === next;
}

function normalizeDestination(value: string | undefined): string {
  const destination = String(value ?? "").trim();
  return destinationAllowlist.has(destination) ? destination : "unknown";
}

function parseFrontmatter(markdown: string): ParsedFrontmatter {
  if (!markdown.startsWith("---\n")) {
    return { hasFrontmatter: false, start: 0, end: 0, lines: [], bodyStart: 0, values: {} };
  }
  const end = markdown.indexOf("\n---", 4);
  if (end < 0) {
    return { hasFrontmatter: false, start: 0, end: 0, lines: [], bodyStart: 0, values: {} };
  }
  const closingEnd = markdown.startsWith("\n", end + 4) ? end + 5 : end + 4;
  const raw = markdown.slice(4, end);
  const lines = raw.split("\n");
  return {
    hasFrontmatter: true,
    start: 0,
    end,
    lines,
    bodyStart: closingEnd,
    values: Object.fromEntries(
      lines
        .map((line) => line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/))
        .filter((line): line is RegExpMatchArray => Boolean(line))
        .map((line) => [line[1], parseFrontmatterScalar(line[2])])
    )
  };
}

function upsertFrontmatter(markdown: string, parsed: ParsedFrontmatter, updates: Record<string, string | boolean>): string {
  const lines = parsed.hasFrontmatter ? parsed.lines.filter((line) => !isAliasCleanupLine(line)) : [];
  const keys = [...upsertKeys, ...optionalUpsertKeys.filter((key) => Object.prototype.hasOwnProperty.call(updates, key))];
  for (const key of keys) {
    const value = updates[key];
    const nextLine = `${key}: ${formatYamlScalar(value)}`;
    const index = lines.findIndex((line) => line.match(new RegExp(`^${escapeRegExp(key)}:\\s*`)));
    if (index >= 0) {
      lines[index] = nextLine;
    } else {
      lines.push(nextLine);
    }
  }
  const body = parsed.hasFrontmatter ? markdown.slice(parsed.bodyStart) : markdown;
  return `---\n${lines.join("\n")}\n---\n${body.replace(/^\n?/, "")}`;
}

function isAliasCleanupLine(line: string): boolean {
  const key = line.match(/^([A-Za-z0-9_-]+):\s*/)?.[1];
  return key ? aliasCleanupKeys.has(key) : false;
}

function formatYamlScalar(value: string | boolean): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === "" || /[:#\n\r]|^\s|\s$/.test(value)) return JSON.stringify(value);
  return value;
}

function writeMarkdownAtomic(path: string, markdown: string): void {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  renameSync(tmpPath, path);
}

function backupNoteBeforeUpdate(input: { vaultPath: string; vaultRealPath: string; path: string; processedAt: string }): string {
  const rel = relative(input.vaultPath, input.path);
  if (rel.startsWith("..") || rel === "" || rel.split(sep).includes("..")) {
    throw new Error(`Refusing to back up note outside vault: ${input.path}`);
  }
  const blocker = realpathBlocker({ vaultRealPath: input.vaultRealPath, realPath: realpathSync(input.path) });
  if (blocker) throw new Error(`Refusing to back up note outside vault realpath: ${input.path}`);
  const backupFile = join(".backups", "second-brain-processor", safeTimestamp(input.processedAt), rel);
  const backupPath = join(input.vaultPath, backupFile);
  mkdirSync(dirname(backupPath), { recursive: true });
  copyFileSync(input.path, backupPath);
  return backupFile;
}

function writeStatusFile(result: SecondBrainProcessorResult, statusFile?: string): void {
  const path = resolveStatusFile(statusFile);
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(result, null, 2));
  renameSync(tmpPath, path);
}

function resolveStatusFile(statusFile?: string): string {
  return resolve(statusFile ?? process.env.AUTOMATION_OS_SECOND_BRAIN_PROCESSOR_STATUS_FILE ?? defaultStatusFile);
}

function hasGeneratedByMarker(markdown: string): boolean {
  if (markdown.split("\n").slice(0, 3).some((line) => line.trim() === "# generated_by: automation-os")) return true;
  const parsed = parseFrontmatter(markdown);
  return parsed.values.generated_by === "automation-os";
}

function parseFrontmatterScalar(raw: string): string {
  const trimmed = raw.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function frontmatterFlagIsTrue(...values: unknown[]): boolean {
  return values.some((value) => ["yes", "true", "1"].includes(String(value ?? "").trim().toLowerCase()));
}

function firstPresentString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function defaultReviewCycle(destination: string): string {
  return destination === "07_Decisions" || destination === "08_Runbooks" ? "monthly" : "weekly";
}

function shortSnippet(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text || "none";
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeTimestamp(timestamp: string): string {
  return timestamp.replace(/[^0-9A-Za-z_.-]+/g, "-");
}

function realpathBlocker(input: { vaultRealPath: string; realPath: string }): string | undefined {
  const rel = relative(input.vaultRealPath, input.realPath);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return undefined;
  return "realpath_outside_vault";
}

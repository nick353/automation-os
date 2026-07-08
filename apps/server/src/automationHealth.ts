import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export type AutomationHealthSeverity = "info" | "warning" | "blocker";

export type AutomationHealthIssue = {
  severity: AutomationHealthSeverity;
  code: string;
  message: string;
  path?: string;
  expected?: unknown;
  actual?: unknown;
};

export type AutomationTomlRecord = {
  id: string;
  kind: string;
  name: string;
  status: string;
  prompt: string;
  rrule: string;
  model: string;
  reasoning_effort: string;
  cwds: string[];
  path: string;
  dir: string;
};

export type AutomationDbRecord = {
  id: string;
  prompt: string;
  status: string;
  rrule: string;
  name: string;
  model: string;
  reasoning_effort: string;
  cwds: string[];
};

export type AutomationHealthEntry = {
  id: string;
  name: string;
  status: string;
  automation_toml: string;
  cwds: string[];
  db: {
    found: boolean;
    parity: "ok" | "drift" | "missing" | "unchecked";
    row?: AutomationDbRecord;
  };
  entrypoints: Array<{
    command: string;
    target: string;
    resolved_path?: string;
    exists: boolean;
  }>;
  authority_files: Array<{
    label: string;
    path: string;
    exists: boolean;
  }>;
  browser_lane_hints: string[];
  lock_process_hints: string[];
  latest_artifacts: Array<{
    scope: "automation_dir" | "cwd";
    path: string;
    mtime_ms: number;
  }>;
  video_qa: {
    likely_required: boolean;
    wording_found: string[];
    status: "ok" | "warning" | "blocker" | "not_required";
  };
  issues: AutomationHealthIssue[];
};

export type AutomationHealthReport = {
  generated_at: string;
  automation_root: string;
  db_path: string;
  report_path: string;
  summary: {
    total: number;
    active: number;
    inactive: number;
    ok: number;
    warnings: number;
    blockers: number;
    db_drift: number;
    missing_entrypoints: number;
    video_qa_issues: number;
  };
  issues: AutomationHealthIssue[];
  automations: AutomationHealthEntry[];
};

export type AutomationHealthOptions = {
  automationRoot?: string;
  dbPath?: string;
  outputRoot?: string;
  now?: Date;
  psText?: string;
};

const DEFAULT_AUTOMATION_ROOT = join(homedir(), ".codex", "automations");
const DEFAULT_CODEX_DB = join(homedir(), ".codex", "sqlite", "codex-dev.db");
const VIDEO_QA_TERMS = [
  "stage_visual_audits",
  "gemini_video_qa",
  "video qa",
  "visual audits",
  "auxiliary proof",
  "completion veto",
  "no-post-preflight",
  "recommendation_status=pass",
  "anomaly_detected=false"
];

const BROWSER_LANE_TERMS = [
  "9333",
  "9334",
  "9335",
  "Profile 2",
  ".daily-ai-playwright-chrome",
  ".nisenprints-playwright-chrome",
  "chrome_extension",
  "write lock"
];

const AUTHORITY_MARKERS = [
  "AGENTS.md",
  "STATE.md",
  "SKILL.md",
  "README.md",
  "automation.toml",
  "memory.md",
  "automation memory",
  "_shared/RUNBOOK.md",
  "STAGE_OBSERVATION_SCHEMA.md"
];

function timestampForPath(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "").replace("Z", "Z");
}

function unquoteTomlString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("\"")) return trimmed;
  try {
    return JSON.parse(trimmed) as string;
  } catch {
    return trimmed.slice(1, trimmed.endsWith("\"") ? -1 : undefined);
  }
}

function parseTomlArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[")) return [];
  try {
    return JSON.parse(trimmed) as string[];
  } catch {
    return [...trimmed.matchAll(/"((?:\\.|[^"])*)"/g)].map((match) => unquoteTomlString(`"${match[1]}"`));
  }
}

export function parseAutomationToml(source: string, path: string): AutomationTomlRecord {
  const fields = parseTomlFields(source);
  const dir = dirname(path);
  const id = unquoteTomlString(fields.get("id") ?? `"${basename(dir)}"`);
  const cwds = parseTomlArray(fields.get("cwds") ?? "[]");
  const cwd = fields.has("cwd") ? unquoteTomlString(fields.get("cwd") ?? "") : "";
  return {
    id,
    kind: unquoteTomlString(fields.get("kind") ?? "\"\""),
    name: unquoteTomlString(fields.get("name") ?? `"${id}"`),
    status: unquoteTomlString(fields.get("status") ?? "\"UNKNOWN\""),
    prompt: unquoteTomlString(fields.get("prompt") ?? "\"\""),
    rrule: unquoteTomlString(fields.get("rrule") ?? "\"\""),
    model: unquoteTomlString(fields.get("model") ?? "\"\""),
    reasoning_effort: unquoteTomlString(fields.get("reasoning_effort") ?? "\"\""),
    cwds: cwds.length > 0 ? cwds : cwd ? [cwd] : [],
    path,
    dir
  };
}

function parseTomlFields(source: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2];
    if (value === "\"\"\"" || value === "'''") {
      const delimiter = value;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && lines[index] !== delimiter) {
        body.push(lines[index]);
        index += 1;
      }
      fields.set(key, JSON.stringify(body.join("\n")));
      continue;
    }
    fields.set(key, value);
  }
  return fields;
}

function listAutomationTomls(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, "automation.toml"))
    .filter((path) => existsSync(path))
    .sort();
}

function sqliteJsonQuery(dbPath: string, sql: string): { rows: unknown[]; issue?: AutomationHealthIssue } {
  if (!existsSync(dbPath)) {
    return { rows: [], issue: { severity: "blocker", code: "db_missing", message: "codex-dev.db is missing", path: dbPath } };
  }
  const result = spawnSync("sqlite3", ["-readonly", "-json", dbPath, sql], { encoding: "utf8" });
  if (result.status !== 0) {
    return {
      rows: [],
      issue: {
        severity: "blocker",
        code: "db_read_failed",
        message: (result.stderr || `sqlite3 exited with ${result.status}`).trim(),
        path: dbPath
      }
    };
  }
  try {
    return { rows: result.stdout.trim() ? (JSON.parse(result.stdout) as unknown[]) : [] };
  } catch (error) {
    return {
      rows: [],
      issue: {
        severity: "blocker",
        code: "db_json_parse_failed",
        message: error instanceof Error ? error.message : String(error),
        path: dbPath
      }
    };
  }
}

function loadDbRows(dbPath: string): { rows: Map<string, AutomationDbRecord>; issue?: AutomationHealthIssue } {
  const query = sqliteJsonQuery(dbPath, "SELECT id,name,prompt,status,rrule,model,reasoning_effort,cwds FROM automations ORDER BY id;");
  const rows = new Map<string, AutomationDbRecord>();
  for (const row of query.rows as Array<{
    id?: string;
    name?: string;
    prompt?: string;
    status?: string;
    rrule?: string;
    model?: string | null;
    reasoning_effort?: string | null;
    cwds?: string;
  }>) {
    if (!row.id) continue;
    rows.set(row.id, {
      id: row.id,
      name: row.name ?? "",
      prompt: row.prompt ?? "",
      status: row.status ?? "",
      rrule: row.rrule ?? "",
      model: row.model ?? "",
      reasoning_effort: row.reasoning_effort ?? "",
      cwds: parseJsonArray(row.cwds ?? "[]")
    });
  }
  return { rows, issue: query.issue };
}

function parseJsonArray(source: string): string[] {
  try {
    const parsed = JSON.parse(source) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function resolveCandidatePath(target: string, cwd: string): string {
  return isAbsolute(target) ? target : resolve(cwd, target);
}

function extractEntrypoints(prompt: string, cwds: string[]): AutomationHealthEntry["entrypoints"] {
  const cwd = cwds[0] ?? process.cwd();
  const entrypoints: AutomationHealthEntry["entrypoints"] = [];
  const commandRegex =
    /\b(node|python3?|tsx|bash|sh)\s+(?!-)([^\s"'`]+(?:\.(?:mjs|cjs|js|ts|py|sh)|\/[^\s"'`]+))/g;
  for (const match of prompt.matchAll(commandRegex)) {
    const target = cleanToken(match[2]);
    const resolved = resolveCandidatePath(target, cwd);
    entrypoints.push({ command: match[1], target, resolved_path: resolved, exists: existsSync(resolved) });
  }

  const uvRegex = /\buv\s+run\s+(?:python3?|node)?\s*([^\s"'`]+(?:\.(?:py|js|mjs|ts)|\/[^\s"'`]+))/g;
  for (const match of prompt.matchAll(uvRegex)) {
    const target = cleanToken(match[1]);
    const resolved = resolveCandidatePath(target, cwd);
    entrypoints.push({ command: "uv run", target, resolved_path: resolved, exists: existsSync(resolved) });
  }

  const npmRegex = /\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g;
  for (const match of prompt.matchAll(npmRegex)) {
    const packageJson = resolveCandidatePath("package.json", cwd);
    const scripts = existsSync(packageJson) ? readPackageScripts(packageJson) : {};
    const target = match[1];
    entrypoints.push({
      command: "npm run",
      target,
      resolved_path: packageJson,
      exists: Object.prototype.hasOwnProperty.call(scripts, target)
    });
  }
  for (const command of extractShellEntrypointCommands(prompt)) {
    if (["node", "python", "python3", "tsx", "bash", "sh", "uv", "npm", "codex"].includes(command)) continue;
    const resolved = resolveCommandPath(command, cwd);
    entrypoints.push({ command: "path", target: command, resolved_path: resolved.path, exists: resolved.exists });
  }
  return uniqueBy(entrypoints, (entry) => `${entry.command}\0${entry.target}\0${entry.resolved_path ?? ""}`);
}

function extractShellEntrypointCommands(prompt: string): string[] {
  const commands: string[] = [];
  let inEntrypointBlock = false;
  for (const rawLine of prompt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^(default entrypoint|explicit start entrypoint|parent\/child orchestration entrypoints|then run|registered entrypoint)/i.test(line)) {
      inEntrypointBlock = true;
      continue;
    }
    if (!line) {
      inEntrypointBlock = false;
      continue;
    }
    const command = parseShellCommandLine(line, inEntrypointBlock);
    if (command) commands.push(command);
  }
  return uniqueBy(commands, (command) => command);
}

function parseShellCommandLine(line: string, inEntrypointBlock: boolean): string | null {
  const body = line.replace(/^[-*]\s+/, "").trim();
  if (!body || body.endsWith(":")) return null;
  const tokens = body.split(/\s+/).filter(Boolean);
  while (tokens[0]?.includes("=") && !tokens[0].startsWith("/") && !tokens[0].startsWith("./") && !tokens[0].startsWith("../")) {
    tokens.shift();
  }
  const command = tokens[0];
  if (!command) return null;
  if (/^[A-Z]/.test(command)) return null;
  if (/^(no-post-preflight|recommendation_status|anomaly_detected|safe|completion)$/i.test(command)) return null;
  if (!inEntrypointBlock && !/^[./A-Za-z0-9_-]*-[A-Za-z0-9_.-]+$/.test(command)) return null;
  if (/^(Run|Use|First|Fresh-read|Do|Keep|Current|Before|After|If|When|For|Hard|Done|Authority)$/i.test(command)) return null;
  return cleanToken(command);
}

function resolveCommandPath(command: string, cwd: string): { path: string; exists: boolean } {
  const candidates = isAbsolute(command)
    ? [command]
    : [
        resolve(cwd, command),
        join(cwd, "scripts", command),
        join(homedir(), ".local", "bin", command),
        join("/opt/homebrew/bin", command),
        join("/usr/local/bin", command),
        join("/usr/bin", command),
        join("/bin", command)
      ];
  const found = candidates.find((candidate) => existsSync(candidate));
  return { path: found ?? candidates[0], exists: Boolean(found) };
}

function readPackageScripts(packageJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as { scripts?: Record<string, unknown> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

function cleanToken(token: string): string {
  return token.replace(/[),.;:]+$/g, "");
}

function uniqueBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function extractAuthorityFiles(automation: AutomationTomlRecord): AutomationHealthEntry["authority_files"] {
  const prompt = automation.prompt;
  const files: AutomationHealthEntry["authority_files"] = [];
  const absolutePathRegex = /\/Users\/[^\s"'`,)]+/g;
  for (const match of prompt.matchAll(absolutePathRegex)) {
    const path = cleanToken(match[0]);
    if (looksLikeAuthority(path)) {
      files.push({ label: basename(path), path, exists: existsSync(path) });
    }
  }

  const relativeAuthorityRegex = /(?:^|[\s`"'])((?:\.{1,2}\/|[A-Za-z0-9_.-]+\/)[^\s"'`,)]*(?:AGENTS\.md|STATE\.md|SKILL\.md|memory\.md|RUNBOOK\.md|STAGE_OBSERVATION_SCHEMA\.md))/g;
  for (const match of prompt.matchAll(relativeAuthorityRegex)) {
    const token = cleanToken(match[1]);
    for (const cwd of automation.cwds.length > 0 ? automation.cwds : [process.cwd()]) {
      const path = resolveCandidatePath(token, cwd);
      files.push({ label: basename(token), path, exists: existsSync(path) });
    }
  }

  const generalAuthorityRegex =
    /(?:^|[\s`"'])((?:\.{1,2}\/|[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:md|json|jsonl|tsv|toml|yaml|yml))/g;
  for (const match of prompt.matchAll(generalAuthorityRegex)) {
    const token = cleanToken(match[1]);
    if (!isAuthorityToken(token)) continue;
    const bases = automation.cwds.length > 0 ? automation.cwds : [process.cwd()];
    const candidates = token.includes("/")
      ? [
          ...bases.map((cwd) => resolveCandidatePath(token, cwd)),
          join(homedir(), ".agents", "skills", automation.id, token),
          join(automation.dir, token)
        ]
      : [...bases.map((cwd) => join(cwd, token)), join(automation.dir, token)];
    for (const path of candidates) {
      files.push({ label: basename(token), path, exists: existsSync(path) });
    }
  }

  for (const marker of AUTHORITY_MARKERS) {
    if (!prompt.includes(marker)) continue;
    for (const candidate of authorityCandidates(marker, automation)) {
      files.push({ label: marker, path: candidate, exists: existsSync(candidate) });
    }
  }
  return uniqueBy(files, (entry) => entry.path);
}

function looksLikeAuthority(path: string): boolean {
  return AUTHORITY_MARKERS.some((marker) => path.includes(marker.replace("automation memory", "memory.md"))) || /\/artifacts(\/|$)/.test(path) || isAuthorityToken(path);
}

function isAuthorityToken(token: string): boolean {
  return /(^|\/)(AGENTS|STATE|SKILL|README|RUNBOOK|STAGE_OBSERVATION_SCHEMA)\.md$/i.test(token) || /(references|docs|contract|queue|source|sources|manifest|memory|automation\.toml|artifacts)/i.test(token);
}

function authorityCandidates(marker: string, automation: AutomationTomlRecord): string[] {
  const cwds = automation.cwds.length > 0 ? automation.cwds : [process.cwd()];
  if (marker === "automation memory") return [join(automation.dir, "memory.md")];
  if (marker.startsWith("_shared/")) return [join(dirname(automation.dir), marker)];
  if (marker === "STAGE_OBSERVATION_SCHEMA.md") return [join(dirname(automation.dir), "_shared", marker)];
  if (marker === "automation.toml") return [automation.path];
  if (marker === "STATE.md" && /confirmed queue STATE\.md/i.test(automation.prompt)) {
    return [
      ...cwds.map((cwd) => join(cwd, marker)),
      join(automation.dir, marker),
      join(dirname(automation.dir), "confirmed-job-applications-daily-queue", "STATE.md")
    ];
  }
  if (marker === "memory.md") return [join(automation.dir, "memory.md"), ...cwds.map((cwd) => join(cwd, marker))];
  return [...cwds.map((cwd) => join(cwd, marker)), join(automation.dir, marker)];
}

function detectBrowserLaneHints(prompt: string): string[] {
  return BROWSER_LANE_TERMS.filter((term) => prompt.includes(term));
}

function readPsText(options: AutomationHealthOptions): string {
  if (typeof options.psText === "string") return options.psText;
  const result = spawnSync("ps", ["aux"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout : "";
}

function detectProcessHints(automation: AutomationTomlRecord, entrypoints: AutomationHealthEntry["entrypoints"], psText: string): string[] {
  const terms = [automation.id, ...automation.cwds, ...entrypoints.map((entry) => basename(entry.target)).filter(Boolean)];
  const lines = psText.split(/\r?\n/);
  return lines.filter((line) => terms.some((term) => term && line.includes(term))).slice(0, 20);
}

function latestArtifact(scope: "automation_dir" | "cwd", root: string): AutomationHealthEntry["latest_artifacts"][number] | null {
  const artifactRoot = join(root, "artifacts");
  if (!existsSync(artifactRoot)) return null;
  let latest: AutomationHealthEntry["latest_artifacts"][number] | null = null;
  const visit = (dir: string, depth: number): void => {
    if (depth > 4) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = statSync(path);
      if (!latest || stat.mtimeMs > latest.mtime_ms) latest = { scope, path, mtime_ms: stat.mtimeMs };
    }
  };
  visit(artifactRoot, 0);
  return latest;
}

function detectVideoQa(automation: AutomationTomlRecord): AutomationHealthEntry["video_qa"] {
  const prompt = automation.prompt;
  const lower = `${automation.id}\n${automation.name}\n${automation.status}\n${prompt}`.toLowerCase();
  const wordingFound = VIDEO_QA_TERMS.filter((term) => lower.includes(term.toLowerCase()));
  if (automation.status !== "ACTIVE") return { likely_required: false, wording_found: wordingFound, status: "not_required" };
  const likelyRequired =
    /(publish|post|posting|pinterest|etsy|printify|linkedin|direct_publish|write|writes|send|submit|calendar|sheets)/.test(lower) &&
    !/(inactive|historical proof only|do not run)/.test(lower);
  if (!likelyRequired) return { likely_required: false, wording_found: wordingFound, status: "not_required" };
  if (wordingFound.length >= 3) return { likely_required: true, wording_found: wordingFound, status: "ok" };
  return {
    likely_required: true,
    wording_found: wordingFound,
    status: wordingFound.length === 0 ? "blocker" : "warning"
  };
}

function buildAutomationEntry(automation: AutomationTomlRecord, dbRow: AutomationDbRecord | undefined, psText: string): AutomationHealthEntry {
  const issues: AutomationHealthIssue[] = [];
  const isActive = automation.status === "ACTIVE";
  const db: AutomationHealthEntry["db"] = dbRow
    ? { found: true, parity: "ok" as const, row: dbRow }
    : { found: false, parity: "missing" as const, row: undefined };

  if (!dbRow) {
    issues.push({
      severity: isActive ? "blocker" : "info",
      code: "db_row_missing",
      message: "automation row missing from codex-dev.db",
      path: automation.path
    });
  } else {
    const parityChecks: Array<[keyof AutomationDbRecord, unknown, unknown]> = [
      ["name", automation.name, dbRow.name],
      ["prompt", automation.prompt, dbRow.prompt],
      ["status", automation.status, dbRow.status],
      ["rrule", automation.rrule, dbRow.rrule],
      ["model", automation.model, dbRow.model],
      ["reasoning_effort", automation.reasoning_effort, dbRow.reasoning_effort],
      ["cwds", automation.cwds, dbRow.cwds]
    ];
    for (const [field, expected, actual] of parityChecks) {
      const ok = Array.isArray(expected) && Array.isArray(actual) ? arraysEqual(expected, actual) : expected === actual;
      if (!ok) {
        db.parity = "drift";
        issues.push({
          severity: isActive ? "blocker" : "warning",
          code: `db_${field}_drift`,
          message: `TOML and DB ${field} differ`,
          path: automation.path,
          expected,
          actual
        });
      }
    }
  }

  const entrypoints = extractEntrypoints(automation.prompt, automation.cwds);
  for (const entrypoint of entrypoints) {
    if (!entrypoint.exists) {
      issues.push({
        severity: isActive ? "blocker" : "warning",
        code: "entrypoint_missing",
        message: `Entrypoint target is missing: ${entrypoint.command} ${entrypoint.target}`,
        path: entrypoint.resolved_path
      });
    }
  }

  const authorityFiles = extractAuthorityFiles(automation);
  const existingAuthorityLabels = new Set(authorityFiles.filter((authority) => authority.exists).map((authority) => authority.label));
  for (const authority of authorityFiles) {
    if (!authority.exists && !existingAuthorityLabels.has(authority.label)) {
      issues.push({
        severity: authority.label === "memory.md" || authority.label === "automation memory" ? "info" : "warning",
        code: "authority_file_missing",
        message: `Referenced authority file is missing: ${authority.label}`,
        path: authority.path
      });
    }
  }

  const videoQa = detectVideoQa(automation);
  if (videoQa.status === "blocker" || videoQa.status === "warning") {
    issues.push({
      severity: videoQa.status,
      code: "video_qa_wording_missing",
      message: "Likely publish/write automation is missing durable video QA gate wording",
      expected: VIDEO_QA_TERMS,
      actual: videoQa.wording_found
    });
  }

  return {
    id: automation.id,
    name: automation.name,
    status: automation.status,
    automation_toml: automation.path,
    cwds: automation.cwds,
    db: dbRow ? db : { found: false, parity: "missing" },
    entrypoints,
    authority_files: authorityFiles,
    browser_lane_hints: detectBrowserLaneHints(automation.prompt),
    lock_process_hints: detectProcessHints(automation, entrypoints, psText),
    latest_artifacts: [
      latestArtifact("automation_dir", automation.dir),
      ...automation.cwds.map((cwd) => latestArtifact("cwd", cwd))
    ].filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== null),
    video_qa: videoQa,
    issues
  };
}

function buildDbOnlyEntry(dbRow: AutomationDbRecord, automationRoot: string, psText: string): AutomationHealthEntry {
  const automation: AutomationTomlRecord = {
    id: dbRow.id,
    kind: "",
    name: dbRow.name,
    status: dbRow.status,
    prompt: dbRow.prompt,
    rrule: dbRow.rrule,
    model: dbRow.model,
    reasoning_effort: dbRow.reasoning_effort,
    cwds: dbRow.cwds,
    path: join(automationRoot, dbRow.id, "automation.toml"),
    dir: join(automationRoot, dbRow.id)
  };
  const entry = buildAutomationEntry(automation, dbRow, psText);
  entry.db.parity = "missing";
  entry.issues.unshift({
    severity: dbRow.status === "ACTIVE" ? "blocker" : "warning",
    code: "toml_missing_for_db_row",
    message: "DB row exists but automation.toml is missing",
    path: automation.path
  });
  return entry;
}

function summarize(entries: AutomationHealthEntry[]): AutomationHealthReport["summary"] {
  const activeEntries = entries.filter((entry) => entry.status === "ACTIVE");
  const activeWithIssue = activeEntries.filter((entry) => entry.issues.some((issue) => issue.severity === "warning" || issue.severity === "blocker"));
  return {
    total: entries.length,
    active: activeEntries.length,
    inactive: entries.filter((entry) => entry.status !== "ACTIVE").length,
    ok: activeEntries.length - activeWithIssue.length,
    warnings: activeEntries.reduce((count, entry) => count + entry.issues.filter((issue) => issue.severity === "warning").length, 0),
    blockers: activeEntries.reduce((count, entry) => count + entry.issues.filter((issue) => issue.severity === "blocker").length, 0),
    db_drift: activeEntries.filter((entry) => entry.db.parity === "drift").length,
    missing_entrypoints: activeEntries.reduce((count, entry) => count + entry.entrypoints.filter((item) => !item.exists).length, 0),
    video_qa_issues: activeEntries.filter((entry) => entry.video_qa.status === "warning" || entry.video_qa.status === "blocker").length
  };
}

export function runAutomationHealth(options: AutomationHealthOptions = {}): AutomationHealthReport {
  const automationRoot = options.automationRoot ?? DEFAULT_AUTOMATION_ROOT;
  const dbPath = options.dbPath ?? DEFAULT_CODEX_DB;
  const now = options.now ?? new Date();
  const outputRoot = options.outputRoot ?? join(process.cwd(), "artifacts", "automation-health");
  const reportPath = join(outputRoot, `${timestampForPath(now)}.json`);
  const tomlPaths = listAutomationTomls(automationRoot);
  const dbRows = loadDbRows(dbPath);
  const psText = readPsText(options);
  const reportIssues: AutomationHealthIssue[] = dbRows.issue ? [dbRows.issue] : [];
  const entries = tomlPaths
    .map((path) => parseAutomationToml(readFileSync(path, "utf8"), path))
    .sort((left, right) => {
      if (left.status === right.status) return left.id.localeCompare(right.id);
      return left.status === "ACTIVE" ? -1 : 1;
    })
    .map((automation) => buildAutomationEntry(automation, dbRows.rows.get(automation.id), psText));
  const tomlIds = new Set(entries.map((entry) => entry.id));
  for (const dbRow of dbRows.rows.values()) {
    if (!tomlIds.has(dbRow.id)) entries.push(buildDbOnlyEntry(dbRow, automationRoot, psText));
  }

  const report: AutomationHealthReport = {
    generated_at: now.toISOString(),
    automation_root: automationRoot,
    db_path: dbPath,
    report_path: reportPath,
    summary: summarize(entries),
    issues: reportIssues,
    automations: entries
  };
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

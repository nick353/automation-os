#!/usr/bin/env node

import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const home = process.env.HOME || "/Users/nichikatanaka";
const codexHome = process.env.CODEX_HOME || path.join(home, ".codex");
const notesDir = process.env.PROJECT_HANDOFF_NOTES_DIR || path.join(codexHome, "memories", "extensions", "ad_hoc", "notes");
const obsidianVault = process.env.PROJECT_HANDOFF_OBSIDIAN_VAULT || process.env.AUTOMATION_OS_OBSIDIAN_VAULT || path.join(home, "Documents", "Obsidian Vault");
const obsidianFile = path.join(obsidianVault, "00_Start Here", "Project Handoff Index.md");
const registryPath = process.env.AUTOMATION_OS_PROJECT_REGISTRY || path.join(home, "Documents", "Codex", "automation-os", "data", "project-registry.json");
const generatedObsidianFiles = {
  actionQueue: path.join(obsidianVault, "10_Dashboards", "Generated Action Queue Candidates.md"),
  handoffInbox: path.join(obsidianVault, "09_Inbox", "Generated Project Handoff Inbox.md"),
  proofLocators: path.join(obsidianVault, "04_Proof Pointers", "Generated Proof Locators.md"),
  decisionLocators: path.join(obsidianVault, "07_Decisions", "Generated Decision Locators.md"),
  runbookLocators: path.join(obsidianVault, "08_Runbooks", "Generated Runbook Locators.md"),
  weeklyReview: path.join(obsidianVault, "10_Dashboards", "Generated Weekly Project Review.md"),
  cleanupCandidates: path.join(obsidianVault, "10_Dashboards", "Generated Notes Cleanup Candidates.md"),
  projectTemplate: path.join(obsidianVault, "05_Projects", "Generated Project Template.md")
};
const generatedRoleReadmes = [
  { role: "projects_folder_readme", file: path.join(obsidianVault, "05_Projects", "README.generated.md"), folder: "05_Projects", purpose: "project-owned workspaces and generated context packs" },
  { role: "research_folder_readme", file: path.join(obsidianVault, "06_Research", "README.generated.md"), folder: "06_Research", purpose: "research notes and source locators" },
  { role: "decisions_folder_readme", file: path.join(obsidianVault, "07_Decisions", "README.generated.md"), folder: "07_Decisions", purpose: "decision records and generated decision locators" },
  { role: "runbooks_folder_readme", file: path.join(obsidianVault, "08_Runbooks", "README.generated.md"), folder: "08_Runbooks", purpose: "operator runbooks and generated runbook locators" },
  { role: "inbox_folder_readme", file: path.join(obsidianVault, "09_Inbox", "README.generated.md"), folder: "09_Inbox", purpose: "handoff inboxes and unprocessed project notes" },
  { role: "dashboards_folder_readme", file: path.join(obsidianVault, "10_Dashboards", "README.generated.md"), folder: "10_Dashboards", purpose: "generated dashboard surfaces and review queues" }
];
const generatedLocatorText = "generated locator, not execution proof";
const freshReadBoundaryText = "Fresh-read boundary: before acting, read the project-owned STATE.md, AGENTS.md, automation.toml, Skill/docs, and latest artifacts/readbacks directly.";
const maxScanDepth = Number.parseInt(process.env.PROJECT_HANDOFF_SCAN_MAX_DEPTH || "6", 10);
const maxScanDirs = Number.parseInt(process.env.PROJECT_HANDOFF_SCAN_MAX_DIRS || "2500", 10);
const maxDiscoveredProjects = Number.parseInt(process.env.PROJECT_HANDOFF_MAX_DISCOVERED_PROJECTS || "80", 10);
const maxProjects = Number.parseInt(process.env.PROJECT_HANDOFF_MAX_PROJECTS || "120", 10);
const maxDirEntries = Number.parseInt(process.env.PROJECT_HANDOFF_MAX_DIR_ENTRIES || "500", 10);
const staleThresholdHours = Number.parseFloat(process.env.PROJECT_HANDOFF_STALE_HOURS || "24");

const projectSpecs = [
  {
    id: "local-codex",
    label: "Local Codex",
    root: codexHome,
    artifacts: ["sessions", "memories", "automations", "runtime"]
  },
  {
    id: "new-project",
    label: "Daily AI / Job automations",
    root: path.join(home, "Documents", "New project"),
    artifacts: ["artifacts", path.join("artifacts", "run-summaries"), path.join("artifacts", "playwright-cli-runs")]
  },
  {
    id: "etsy",
    label: "NisenPrints / Etsy",
    root: path.join(home, "Documents", "Etsy"),
    artifacts: ["artifacts"]
  },
  {
    id: "automation-os",
    label: "Automation OS",
    root: path.join(home, "Documents", "Codex", "automation-os"),
    artifacts: ["artifacts", path.join("data", "artifacts")]
  },
  {
    id: "apparel-ai-workspace",
    label: "Apparel AI Workspace",
    root: path.join(home, "Desktop", "アパレル１"),
    artifacts: ["artifacts", "output", "screenshots"]
  },
  {
    id: "apparel-heavy-chain",
    label: "Apparel Heavy Chain",
    root: path.join(home, "Desktop", "アパレル１", "heavy-chain"),
    artifacts: ["artifacts", "output", "screenshots"]
  },
  {
    id: "prompt-transfer",
    label: "Prompt Transfer",
    root: path.join(home, ".agents", "skills", "prompt-transfer"),
    artifacts: ["artifacts"]
  },
  {
    id: "prompt-transfer-ukiyoe",
    label: "Prompt Transfer Ukiyoe",
    root: path.join(home, ".agents", "skills", "prompt-transfer-ukiyoe"),
    artifacts: ["artifacts"]
  }
];

const authorityFiles = [
  "STATE.md",
  "AGENTS.md",
  "config.toml",
  "SKILL.md",
  "automation.toml",
  "package.json",
  "PROJECT_DESIGN.md",
  "GOAL.md",
  "current-run-contract.md",
  path.join("references", "current-run-contract.md"),
  "memory.md"
];

const discoveryMarkers = [
  "STATE.md",
  "PROJECT_DESIGN.md",
  "GOAL.md"
];

const defaultArtifactRoots = [
  "artifacts",
  path.join("data", "artifacts"),
  "output",
  "verification"
];

const excludedDirectories = new Set([
  "node_modules",
  ".git",
  ".backups",
  "dist",
  "build",
  ".next",
  "coverage",
  "artifacts",
  "backup-repos",
  "backups",
  "Library",
  "Applications",
  "Downloads",
  ".Codex",
  ".codex",
  ".cache",
  ".turbo",
  ".tmp",
  "tmp",
  "temp",
  "codex-tmp",
  ".codex-tmp",
  "codex-skills",
  "external-repos",
  "goals",
  "output",
  "screenshots",
  "snapshots",
  "test-results",
  "verification",
  "work",
  "worktrees",
  ".venv",
  "venv",
  "__pycache__"
]);

const discoveryRoots = [
  path.join(home, "Documents"),
  path.join(home, "Desktop", "アパレル１"),
  path.join(home, ".agents", "skills")
];

function exists(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}

function statSafe(file) {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function realpathOrResolve(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function uniqueArtifactRoots(roots) {
  const seen = new Set();
  const result = [];
  for (const root of [...(roots || []), ...defaultArtifactRoots]) {
    if (seen.has(root)) continue;
    seen.add(root);
    result.push(root);
  }
  return result;
}

function slugFromPath(root) {
  const relative = path.relative(home, root);
  const source = relative && !relative.startsWith("..") ? relative : root;
  return source
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "project";
}

function shortHash(input) {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, 8);
}

function labelFromPath(root) {
  const base = path.basename(root);
  const cleaned = base.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return root;
  return cleaned.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function hasDiscoveryMarker(dir) {
  if (discoveryMarkers.some((marker) => exists(path.join(dir, marker)))) return true;

  const skillsRoot = path.join(home, ".agents", "skills");
  const relativeToSkills = path.relative(skillsRoot, dir);
  const isManagedSkill = relativeToSkills
    && !relativeToSkills.startsWith(`..${path.sep}`)
    && relativeToSkills !== ".."
    && !path.isAbsolute(relativeToSkills);
  return Boolean(isManagedSkill && exists(path.join(dir, "SKILL.md")));
}

function shouldSkipDirectory(name) {
  const normalized = name.toLowerCase();
  return excludedDirectories.has(name) || excludedDirectories.has(normalized) || normalized.includes("codex-tmp");
}

function readRegistryProjectSpecs() {
  if (!exists(registryPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8"));
    if (!Array.isArray(parsed.projects)) return [];
    return parsed.projects
      .filter((project) => project && typeof project.id === "string" && typeof project.root === "string")
      .map((project) => ({
        id: project.id,
        label: typeof project.label === "string" ? project.label : project.id,
        root: project.root,
        artifacts: Array.isArray(project.artifact_roots) ? project.artifact_roots.map(String) : defaultArtifactRoots
      }));
  } catch {
    return [];
  }
}

function discoverProjectSpecs() {
  const found = [];
  const visited = new Set();
  let scannedDirs = 0;

  function addCandidate(dir) {
    found.push({
      id: slugFromPath(dir),
      label: labelFromPath(dir),
      root: dir,
      artifacts: defaultArtifactRoots
    });
  }

  function walk(dir, depth) {
    if (depth < 0 || scannedDirs >= maxScanDirs || found.length >= maxDiscoveredProjects) return;
    const stats = statSafe(dir);
    if (!stats?.isDirectory()) return;
    const canonical = realpathOrResolve(dir);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    scannedDirs += 1;

    if (hasDiscoveryMarker(dir)) addCandidate(dir);

    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !shouldSkipDirectory(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name, "en"))
        .slice(0, maxDirEntries);
    } catch {
      return;
    }

    for (const entry of entries) {
      walk(path.join(dir, entry.name), depth - 1);
      if (scannedDirs >= maxScanDirs || found.length >= maxDiscoveredProjects) return;
    }
  }

  for (const root of discoveryRoots) {
    walk(root, maxScanDepth);
  }

  return found.sort((a, b) => a.root.localeCompare(b.root, "en"));
}

function buildProjectSpecs() {
  const specs = [];
  const seen = new Set();
  const seenIds = new Set();

  function add(spec) {
    const canonical = realpathOrResolve(spec.root);
    if (seen.has(canonical)) return;
    seen.add(canonical);
    const baseId = spec.id || slugFromPath(spec.root);
    const id = seenIds.has(baseId) ? `${baseId}-${shortHash(canonical)}` : baseId;
    seenIds.add(id);
    specs.push({
      ...spec,
      id,
      label: spec.label || labelFromPath(spec.root),
      artifacts: uniqueArtifactRoots(spec.artifacts)
    });
  }

  const registrySpecs = readRegistryProjectSpecs();
  for (const spec of registrySpecs.length > 0 ? registrySpecs : projectSpecs) add(spec);
  if (process.env.PROJECT_HANDOFF_ENABLE_DISCOVERY === "1") {
    for (const spec of discoverProjectSpecs()) add(spec);
  }
  return specs.slice(0, maxProjects);
}

function redact(input) {
  return String(input)
    .replace(/https?:\/\/[^\s)>'"]+/gi, "[redacted_url]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted_email]")
    .replace(/(authorization|bearer|token|secret|password|passwd|cookie|api[_ -]?key)\s*[:=]\s*["']?[^"'\s]+/gi, "$1=[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "[redacted_openai_key]")
    .replace(/[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, "[redacted_jwt]")
    .replace(/[A-Za-z0-9+/=]{80,}/g, "[redacted_high_entropy]");
}

function normalizeWhitespace(input) {
  return String(input).replace(/\s+/g, " ").trim();
}

function stripMarkdownNoise(input) {
  return normalizeWhitespace(String(input)
    .replace(/^[-*]\s+/, "")
    .replace(/^#+\s+/, "")
    .replace(/^\[[ xX-]\]\s+/, "")
    .replace(/^`+|`+$/g, "")
    .replace(/^["']+|["']+$/g, ""));
}

function summarizeFile(file) {
  const text = redact(fs.readFileSync(file, "utf8"));
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("---") && !line.startsWith("# generated_by:"))
    .slice(0, 8);
  const joined = lines.join(" / ");
  return joined.length > 420 ? `${joined.slice(0, 417)}...` : joined;
}

function readRedactedLines(file) {
  return redact(fs.readFileSync(file, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("---") && !line.startsWith("# generated_by:"));
}

const contextExtractors = [
  {
    field: "currentState",
    patterns: [
      /^(?:[-*]\s*)?(?:current[_ -]?state|state|status|final[_ -]?status|latest[_ -]?run(?:[_ -]?status)?)\s*[:=]\s*(.+)$/i,
      /^#+\s*(?:current state|state|status)\s*[:\-]\s*(.+)$/i
    ]
  },
  {
    field: "nextActions",
    patterns: [
      /^(?:[-*]\s*)?(?:next[_ -]?action|next|resume|todo|action(?:[_ -]?candidate)?)\s*[:=]\s*(.+)$/i,
      /^#+\s*(?:next actions?|todo|resume)\s*[:\-]\s*(.+)$/i
    ]
  },
  {
    field: "blockers",
    patterns: [
      /^(?:[-*]\s*)?(?:blocker|blocked|blocking|missing|auth[_ -]?required|requires[_ -]?human|failure|error)\s*[:=]\s*(.+)$/i,
      /^#+\s*(?:blockers?|blocked|known blockers?)\s*[:\-]\s*(.+)$/i
    ]
  },
  {
    field: "riskGates",
    patterns: [
      /^(?:[-*]\s*)?(?:risk[_ -]?gate|gate|approval[_ -]?gate|proof[_ -]?gate|write[_ -]?lock|irreversible|submit[_ -]?authorized|human[_ -]?gate)\s*[:=]\s*(.+)$/i,
      /^#+\s*(?:risk gates?|gates?|approval gates?)\s*[:\-]\s*(.+)$/i
    ]
  },
  {
    field: "maturityCandidate",
    patterns: [
      /^(?:[-*]\s*)?(?:maturity(?:[_ -]?candidate)?|readiness|stage)\s*[:=]\s*(.+)$/i,
      /^#+\s*(?:maturity|readiness|stage)\s*[:\-]\s*(.+)$/i
    ]
  }
];

const latestArtifactKeys = new Set(["latest_artifact", "latest_artifact_pointer"]);

const locatorExtractors = [
  {
    field: "proofLocators",
    patterns: [
      /^(?:[-*]\s*)?(?:proof|proof[_ -]?locator|evidence|artifact|recording|readback)\s*[:=]\s*(.+)$/i,
      /^#+\s*(?:proof|evidence|artifacts?)\s*[:\-]\s*(.+)$/i
    ]
  },
  {
    field: "decisionLocators",
    patterns: [
      /^(?:[-*]\s*)?(?:decision|decision[_ -]?locator|adr|decided)\s*[:=]\s*(.+)$/i,
      /^#+\s*(?:decisions?|adr)\s*[:\-]\s*(.+)$/i
    ]
  },
  {
    field: "runbookLocators",
    patterns: [
      /^(?:[-*]\s*)?(?:runbook|runbook[_ -]?locator|procedure|playbook|how[_ -]?to)\s*[:=]\s*(.+)$/i,
      /^#+\s*(?:runbooks?|procedures?|playbooks?)\s*[:\-]\s*(.+)$/i
    ]
  }
];

const operationSignalCategories = [
  {
    field: "executionPrecheck",
    label: "Execution Precheck",
    aliases: [
      "execution_precheck",
      "precheck",
      "pre_run_check",
      "prerun_check",
      "before_run",
      "before_execution",
      "run_confirmation",
      "manual_confirmation",
      "risk_gate",
      "approval_gate",
      "proof_gate",
      "write_lock",
      "human_gate"
    ]
  },
  {
    field: "evidence",
    label: "Evidence locator",
    aliases: [
      "evidence",
      "evidence_locator",
      "proof",
      "proof_locator",
      "artifact",
      "artifact_locator",
      "recording",
      "readback",
      "readback_result",
      "screen_proof"
    ]
  },
  {
    field: "stopConditions",
    label: "Stop Conditions",
    aliases: [
      "stop_condition",
      "stop_conditions",
      "hard_stop",
      "stop_if",
      "blocker",
      "blocked",
      "blocking",
      "auth_required",
      "requires_human",
      "failure",
      "error"
    ]
  },
  {
    field: "weeklyReview",
    label: "Weekly Review",
    aliases: [
      "weekly_review",
      "weekly_review_item",
      "review_item",
      "review",
      "review_signal",
      "weekly_check",
      "retrospective"
    ]
  },
  {
    field: "unfinishedDetection",
    label: "Unfinished Detection",
    aliases: [
      "unfinished",
      "unfinished_detection",
      "incomplete",
      "pending",
      "open_loop",
      "needs_completion",
      "completion_gap",
      "follow_up",
      "next_action",
      "todo"
    ]
  }
];

const operationSignalByAlias = new Map();
for (const category of operationSignalCategories) {
  for (const alias of category.aliases) {
    operationSignalByAlias.set(alias, category.field);
    operationSignalByAlias.set(alias.replace(/_/g, "-"), category.field);
    operationSignalByAlias.set(alias.replace(/_/g, " "), category.field);
  }
}

const contextPackReverseInputBlockedKeys = new Set([
  "proof",
  "proof_locator",
  "artifact",
  "artifact_locator",
  "screen_proof",
  "next_action",
  "next",
  "todo",
  "follow_up"
]);

function emptyOperationSignals() {
  return Object.fromEntries(operationSignalCategories.map((category) => [category.field, []]));
}

function normalizedSignalKey(input) {
  return String(input).trim().toLowerCase().replace(/[-\s]+/g, "_");
}

function parseKeyValueLine(line) {
  const match = String(line).match(/^(?:[-*]\s*)?([A-Za-z][A-Za-z0-9_ -]{1,64})\s*[:=]\s*(.+)$/);
  if (!match) return null;
  return {
    key: normalizedSignalKey(match[1]),
    value: match[2]
  };
}

function addUnique(target, value, maxItems = 6) {
  const cleaned = stripMarkdownNoise(value).replace(/\s+\(locator\/pointer, not proof\)$/i, "");
  const normalized = cleaned.toLowerCase();
  if (!cleaned || normalized === "none" || normalized === "none explicit" || normalized === "none found") return;
  if (target.includes(cleaned)) return;
  if (target.length >= maxItems) return;
  target.push(cleaned.length > 360 ? `${cleaned.slice(0, 357)}...` : cleaned);
}

function extractExplicitFields(file) {
  const extracted = {
    currentState: [],
    nextActions: [],
    blockers: [],
    riskGates: [],
    maturityCandidate: [],
    sourceOfTruth: [],
    relatedProjects: [],
    proofLocators: [],
    decisionLocators: [],
    runbookLocators: [],
    latestArtifactPointers: [],
    operationSignals: emptyOperationSignals()
  };
  let activeSection = null;
  for (const line of readRedactedLines(file).slice(0, 220)) {
    const sectionMatch = line.match(/^(source[_ -]?of[_ -]?truth|related[_ -]?projects|proof[_ -]?locator)\s*:\s*$/i);
    if (sectionMatch) {
      const key = normalizedSignalKey(sectionMatch[1]);
      activeSection = key === "source_of_truth" ? "sourceOfTruth" : key === "related_projects" ? "relatedProjects" : "proofLocators";
      continue;
    }
    if (activeSection) {
      if (line.startsWith("#")) {
        activeSection = null;
      } else {
        const bullet = line.match(/^[-*]\s+(.+)$/);
        if (bullet) {
          addUnique(extracted[activeSection], bullet[1].replace(/`/g, ""), 12);
          continue;
        }
      }
    }
    const keyValue = parseKeyValueLine(line);
    if (keyValue) {
      activeSection = null;
      if (keyValue.key === "source_of_truth") {
        addUnique(extracted.sourceOfTruth, keyValue.value.replace(/`/g, ""), 12);
        continue;
      }
      if (keyValue.key === "related_projects") {
        addUnique(extracted.relatedProjects, keyValue.value.replace(/`/g, ""), 12);
        continue;
      }
      if (latestArtifactKeys.has(keyValue.key)) {
        addUnique(extracted.latestArtifactPointers, keyValue.value);
        continue;
      }
      const operationSignalField = operationSignalByAlias.get(keyValue.key);
      if (operationSignalField) addUnique(extracted.operationSignals[operationSignalField], keyValue.value);
    }
    for (const extractor of [...contextExtractors, ...locatorExtractors]) {
      for (const pattern of extractor.patterns) {
        const match = line.match(pattern);
        if (!match) continue;
        addUnique(extracted[extractor.field], match[1] || line);
        break;
      }
    }
  }
  return extracted;
}

function extractContextPackOperationSignals(file) {
  const extracted = {
    operationSignals: emptyOperationSignals()
  };
  for (const line of readRedactedLines(file).slice(0, 220)) {
    const keyValue = parseKeyValueLine(line);
    if (!keyValue) continue;
    if (contextPackReverseInputBlockedKeys.has(keyValue.key)) continue;
    const operationSignalField = operationSignalByAlias.get(keyValue.key);
    if (operationSignalField) addUnique(extracted.operationSignals[operationSignalField], keyValue.value);
  }
  return extracted;
}

function mergeExtractedFields(target, extracted) {
  for (const key of Object.keys(extracted)) {
    if (key === "operationSignals") continue;
    for (const value of extracted[key]) addUnique(target[key], value);
  }
  mergeOperationSignals(target.operationSignals, extracted.operationSignals);
}

function mergeOperationSignals(target, source) {
  for (const category of operationSignalCategories) {
    for (const value of source?.[category.field] || []) addUnique(target[category.field], value);
  }
}

function hasOperationSignals(operationSignals) {
  return operationSignalCategories.some((category) => operationSignals[category.field]?.length > 0);
}

function renderOperationSignals(operationSignals, options = {}) {
  const lines = [options.heading || "## Operation Signals"];
  if (!hasOperationSignals(operationSignals)) {
    lines.push("- none explicit");
    lines.push("");
    return lines;
  }
  for (const category of operationSignalCategories) {
    const values = operationSignals[category.field] || [];
    if (values.length === 0) {
      lines.push(`- ${category.label}: none explicit`);
    } else {
      for (const value of values) {
        const suffix = category.field === "evidence" ? " (locator/pointer, not proof)" : "";
        lines.push(`- ${category.label}: ${value}${suffix}`);
      }
    }
  }
  lines.push("");
  return lines;
}

function contextPackPathFor(projectId) {
  return path.join(obsidianVault, "05_Projects", "Generated Context Packs", `${projectId}.md`);
}

function contextPackObsidianLink(snapshot) {
  return `[[05_Projects/Generated Context Packs/${snapshot.id}|Context Pack]]`;
}

function newestEntryUnder(root, maxDepth = 2) {
  const found = [];
  function walk(dir, depth) {
    if (depth < 0) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 250);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (shouldSkipDirectory(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const stats = statSafe(full);
      if (!stats) continue;
      found.push({ path: full, mtimeMs: stats.mtimeMs, isDirectory: entry.isDirectory() });
      if (entry.isDirectory()) walk(full, depth - 1);
    }
  }
  walk(root, maxDepth);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found[0] || null;
}

function ageHoursFromMtime(now, mtimeMs) {
  if (!Number.isFinite(mtimeMs)) return null;
  return Math.max(0, (now.getTime() - mtimeMs) / 36e5);
}

function freshnessFor(now, label, entry) {
  if (!entry || !Number.isFinite(entry.mtimeMs)) {
    return { label, status: "missing", ageHours: null, mtime: "missing" };
  }
  const ageHours = ageHoursFromMtime(now, entry.mtimeMs);
  return {
    label,
    status: ageHours > staleThresholdHours ? "stale" : "fresh",
    ageHours: Number(ageHours.toFixed(2)),
    mtime: new Date(entry.mtimeMs).toISOString(),
    relative: entry.relative
  };
}

function freshnessDifferences(state, artifact, readback) {
  const pairs = [
    ["state_vs_artifact", state, artifact],
    ["state_vs_readback", state, readback],
    ["artifact_vs_readback", artifact, readback]
  ];
  return Object.fromEntries(pairs.map(([name, left, right]) => {
    if (!Number.isFinite(left?.ageHours) || !Number.isFinite(right?.ageHours)) return [name, null];
    return [name, Number(Math.abs(left.ageHours - right.ageHours).toFixed(2))];
  }));
}

function staleRank(freshness) {
  function rankWeight(entry) {
    if (entry.status === "missing") return Number.POSITIVE_INFINITY;
    return Number.isFinite(entry.ageHours) ? entry.ageHours : -1;
  }
  return [freshness.state, freshness.artifact, freshness.readback]
    .filter((entry) => entry.status !== "fresh")
    .sort((a, b) => {
      const left = rankWeight(a);
      const right = rankWeight(b);
      if (left === right) return a.label.localeCompare(b.label, "en");
      if (left === Number.POSITIVE_INFINITY) return -1;
      if (right === Number.POSITIVE_INFINITY) return 1;
      return right - left;
    })
    .map((entry) => `${entry.label}:${entry.status}${entry.ageHours === null ? "" : `:${entry.ageHours}h`}`);
}

function newestAuthorityEntry(files, relative) {
  const match = files.find((file) => file.relative === relative);
  if (!match) return null;
  return { relative: match.relative, mtimeMs: match.mtimeMs };
}

function readbackCandidateFromArtifacts(artifacts) {
  return artifacts
    .filter((artifact) => /readback/i.test(artifact.latest || ""))
    .sort((a, b) => b.latestMtimeMs - a.latestMtimeMs)[0] || null;
}

function textCorpus(snapshot, options = {}) {
  return [
    snapshot.label,
    snapshot.root,
    snapshot.currentState,
    snapshot.nextActions,
    snapshot.blockers,
    snapshot.riskGates,
    snapshot.proofLocators,
    options.includeLatestArtifactPointers === false ? [] : snapshot.latestArtifactPointers,
    snapshot.artifacts.map((artifact) => artifact.latest),
    ...operationSignalCategories.map((category) => snapshot.operationSignals[category.field])
  ].flat(Infinity).filter(Boolean).join("\n");
}

function auditOperationSignals(operationSignals) {
  const missing = operationSignalCategories
    .filter((category) => (operationSignals[category.field] || []).length === 0)
    .map((category) => category.label);
  return {
    missing,
    present: operationSignalCategories
      .filter((category) => (operationSignals[category.field] || []).length > 0)
      .map((category) => category.label)
  };
}

function candidateGoalText(snapshot) {
  const unfinished = snapshot.operationSignals.unfinishedDetection[0] || snapshot.nextActions[0];
  if (!unfinished || unfinished === "none explicit") return null;
  const stop = snapshot.operationSignals.stopConditions[0] || snapshot.blockers[0] || "external send/publish/delete/auth/PII requires an explicit user stop";
  return [
    `Goal: ${unfinished}`,
    "Done: current STATE/artifact/readback agree and generated surfaces remain locator-only.",
    "Verify: fresh-read project STATE.md plus required readback artifact; do not use Context Pack as proof.",
    `Stop: ${stop}`
  ].join(" / ");
}

function browserUseProofGate(snapshot) {
  const corpus = textCorpus(snapshot, { includeLatestArtifactPointers: false });
  const relevant = /browser[_ -]?use(?:\s+(?:completion|proof|required|native|primary|pending))?|browser_use_(?:required|completion)|browser\s+(?:proof|lane)|recording-qa-manifest|gemini\s+video\s+qa|video\s+qa/i.test(corpus);
  const has = {
    recording: /recording|video|\.webm|\.mp4/i.test(corpus),
    gemini: /gemini|video[_ -]?qa/i.test(corpus),
    readback: snapshot.freshness.readback.status === "fresh",
    noResidualProcess: /no residual|residual process|cleanup proof|process cleanup/i.test(corpus)
  };
  const missing = !relevant ? [] : Object.entries(has)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return {
    relevant,
    required: ["recording", "gemini", "readback", "noResidualProcess"],
    missing,
    status: !relevant ? "not_applicable" : missing.length === 0 ? "pass" : "missing_required_proof",
    note: "Browser Use completion requires recording, Gemini QA, readback artifact, and no residual process proof."
  };
}

function projectSnapshot(spec, now = new Date()) {
  const rootExists = exists(spec.root);
  const files = [];
  const extracted = {
    currentState: [],
    nextActions: [],
    blockers: [],
    riskGates: [],
    maturityCandidate: [],
    sourceOfTruth: [],
    relatedProjects: [],
    proofLocators: [],
    decisionLocators: [],
    runbookLocators: [],
    latestArtifactPointers: [],
    operationSignals: emptyOperationSignals()
  };
  for (const relative of authorityFiles) {
    const file = path.join(spec.root, relative);
    if (!exists(file)) continue;
    const stats = statSafe(file);
    mergeExtractedFields(extracted, extractExplicitFields(file));
    files.push({
      relative,
      mtimeMs: stats?.mtimeMs,
      mtime: stats ? new Date(stats.mtimeMs).toISOString() : "unknown",
      summary: summarizeFile(file)
    });
  }
  const artifacts = [];
  for (const relative of spec.artifacts) {
    const artifactRoot = path.join(spec.root, relative);
    if (!exists(artifactRoot)) continue;
    const newest = newestEntryUnder(artifactRoot);
    artifacts.push({
      relative,
      latest: newest ? path.relative(spec.root, newest.path) : relative,
      latestMtimeMs: newest?.mtimeMs,
      latestMtime: newest ? new Date(newest.mtimeMs).toISOString() : "unknown"
    });
  }
  const stateFreshness = freshnessFor(now, "STATE", newestAuthorityEntry(files, "STATE.md"));
  const newestArtifact = artifacts.filter((artifact) => Number.isFinite(artifact.latestMtimeMs)).sort((a, b) => b.latestMtimeMs - a.latestMtimeMs)[0];
  const readbackArtifact = readbackCandidateFromArtifacts(artifacts);
  const artifactFreshness = freshnessFor(now, "artifact", newestArtifact && { relative: newestArtifact.latest, mtimeMs: newestArtifact.latestMtimeMs });
  const readbackFreshness = freshnessFor(now, "readback", readbackArtifact && { relative: readbackArtifact.latest, mtimeMs: readbackArtifact.latestMtimeMs });
  const freshness = {
    staleThresholdHours,
    state: stateFreshness,
    artifact: artifactFreshness,
    readback: readbackFreshness,
    differencesHours: freshnessDifferences(stateFreshness, artifactFreshness, readbackFreshness)
  };
  freshness.staleRanking24h = staleRank(freshness);
  const contextPackPath = contextPackPathFor(spec.id);
  if (exists(contextPackPath)) {
    try {
      const contextPackMarkdown = fs.readFileSync(contextPackPath, "utf8");
      if (isGeneratedByAutomationOs(contextPackMarkdown) && /kind:\s*project_context_pack/i.test(contextPackMarkdown)) {
        mergeOperationSignals(extracted.operationSignals, extractContextPackOperationSignals(contextPackPath).operationSignals);
      }
    } catch {
      // Ignore stale or unreadable generated context packs; source files remain authoritative.
    }
  }
  const maturityCandidate = extracted.maturityCandidate[0] || (rootExists ? "fresh_read_required" : "missing_root");
  const snapshot = {
    ...spec,
    rootExists,
    files,
    artifacts,
    currentState: extracted.currentState,
    nextActions: extracted.nextActions,
    blockers: extracted.blockers,
    riskGates: extracted.riskGates,
    sourceOfTruth: extracted.sourceOfTruth,
    relatedProjects: extracted.relatedProjects,
    maturityCandidate,
    contextPackPath,
    operationSignals: extracted.operationSignals,
    proofLocators: extracted.proofLocators,
    decisionLocators: extracted.decisionLocators,
    runbookLocators: extracted.runbookLocators,
    latestArtifactPointers: extracted.latestArtifactPointers,
    freshness
  };
  snapshot.operationSignalAudit = auditOperationSignals(snapshot.operationSignals);
  snapshot.candidateGoal = candidateGoalText(snapshot);
  snapshot.browserUseProofGate = browserUseProofGate(snapshot);
  return snapshot;
}

function frontmatter(kind, now) {
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    `kind: ${kind}`,
    `updated_at: ${now.toISOString()}`,
    "---",
    "",
    generatedLocatorText,
    "",
    freshReadBoundaryText,
    ""
  ];
}

function renderList(label, items, empty = "none found") {
  const lines = [`## ${label}`];
  if (!items || items.length === 0) {
    lines.push(`- ${empty}`);
  } else {
    for (const item of items) lines.push(`- ${item}`);
  }
  lines.push("");
  return lines;
}

function renderFreshness(snapshot) {
  const lines = ["## Freshness Audit"];
  lines.push(`- Stale threshold: ${snapshot.freshness.staleThresholdHours}h`);
  for (const entry of [snapshot.freshness.state, snapshot.freshness.artifact, snapshot.freshness.readback]) {
    const age = entry.ageHours === null ? "unknown" : `${entry.ageHours}h`;
    const relative = entry.relative ? ` (${entry.relative})` : "";
    lines.push(`- ${entry.label}: ${entry.status} age=${age} mtime=${entry.mtime}${relative}`);
  }
  lines.push(`- Freshness deltas: STATE/artifact=${snapshot.freshness.differencesHours.state_vs_artifact ?? "unknown"}h, STATE/readback=${snapshot.freshness.differencesHours.state_vs_readback ?? "unknown"}h, artifact/readback=${snapshot.freshness.differencesHours.artifact_vs_readback ?? "unknown"}h`);
  lines.push(`- 24h stale ranking: ${snapshot.freshness.staleRanking24h.length === 0 ? "none" : snapshot.freshness.staleRanking24h.join(", ")}`);
  lines.push("");
  return lines;
}

function renderProofGate(snapshot) {
  const lines = ["## Proof Gate Audit"];
  lines.push(`- Context Pack gate: read-first locator only; not proof.`);
  lines.push(`- Readback artifact required: ${snapshot.freshness.readback.status}${snapshot.freshness.readback.relative ? ` (${snapshot.freshness.readback.relative})` : ""}`);
  lines.push(`- No residual process proof required: ${snapshot.browserUseProofGate.missing.includes("noResidualProcess") ? "missing" : "present"}`);
  lines.push(`- Browser Use proof gate: ${snapshot.browserUseProofGate.status}`);
  lines.push(`- Browser Use missing: ${snapshot.browserUseProofGate.missing.length === 0 ? "none" : snapshot.browserUseProofGate.missing.join(", ")}`);
  lines.push(`- Latest artifact: locator/pointer only, not proof.`);
  lines.push("");
  return lines;
}

function renderOperationSignalAudit(snapshot) {
  const lines = ["## Missing Operation Signals Audit"];
  lines.push(`- Missing: ${snapshot.operationSignalAudit.missing.length === 0 ? "none" : snapshot.operationSignalAudit.missing.join(", ")}`);
  lines.push(`- Present: ${snapshot.operationSignalAudit.present.length === 0 ? "none" : snapshot.operationSignalAudit.present.join(", ")}`);
  if (snapshot.candidateGoal) lines.push(`- Candidate Goal: ${snapshot.candidateGoal}`);
  lines.push("");
  return lines;
}

function renderContextPack(now, snapshot) {
  const lines = [
    ...frontmatter("project_context_pack", now),
    `# ${snapshot.label} Context Pack`,
    "",
    `- Project id: \`${snapshot.id}\``,
    `- Root: \`${snapshot.root}\``,
    `- Exists: ${snapshot.rootExists ? "yes" : "no"}`,
    `- Maturity candidate: ${snapshot.maturityCandidate}`,
    ""
  ];
  lines.push(...renderList("Current State", snapshot.currentState, "none explicit"));
  lines.push(...renderList("Next Actions", snapshot.nextActions, "none explicit"));
  lines.push(...renderList("Blockers", snapshot.blockers, "none explicit"));
  lines.push(...renderList("Risk Gates", snapshot.riskGates, "none explicit"));
  lines.push(...renderList("Source Of Truth", snapshot.sourceOfTruth, "none explicit"));
  lines.push(...renderList("Related Projects", snapshot.relatedProjects, "none explicit"));
  lines.push(...renderOperationSignals(snapshot.operationSignals));
  lines.push(...renderFreshness(snapshot));
  lines.push(...renderProofGate(snapshot));
  lines.push(...renderOperationSignalAudit(snapshot));
  lines.push("## Authority Files");
  if (snapshot.files.length === 0) {
    lines.push("- none found");
  } else {
    for (const file of snapshot.files) {
      lines.push(`- \`${file.relative}\` (${file.mtime}): ${file.summary || "empty"}`);
    }
  }
  lines.push("");
  lines.push("## Latest Artifact Locators");
  const latestPointers = [
    ...snapshot.latestArtifactPointers.map((value) => ({ relative: "latest_artifact", latest: value, latestMtime: "explicit latest_artifact key" })),
    ...snapshot.artifacts
  ];
  if (latestPointers.length === 0) {
    lines.push("- none found");
  } else {
    for (const artifact of latestPointers) {
      lines.push(`- \`${artifact.relative}\`: latest=\`${artifact.latest}\` mtime=${artifact.latestMtime} (locator/pointer, not proof)`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function renderActionQueue(now, snapshots) {
  const lines = [
    ...frontmatter("action_queue_candidates", now),
    "# Generated Action Queue Candidates",
    ""
  ];
  for (const snapshot of snapshots) {
    lines.push(`## ${snapshot.label}`);
    lines.push(`- Context Pack: ${contextPackObsidianLink(snapshot)}`);
    lines.push(`- Maturity candidate: ${snapshot.maturityCandidate}`);
    lines.push(`- Execution precheck: ${snapshot.operationSignals.executionPrecheck[0] || "none explicit"}`);
    lines.push(`- Evidence locator: ${snapshot.operationSignals.evidence[0] || "none explicit"} (locator/pointer, not proof)`);
    lines.push(`- Readback artifact: ${snapshot.freshness.readback.status}${snapshot.freshness.readback.relative ? ` (${snapshot.freshness.readback.relative})` : ""}`);
    lines.push(`- Browser Use missing proof: ${snapshot.browserUseProofGate.missing.length === 0 ? "none" : snapshot.browserUseProofGate.missing.join(", ")}`);
    lines.push(`- 24h stale ranking: ${snapshot.freshness.staleRanking24h.length === 0 ? "none" : snapshot.freshness.staleRanking24h.join(", ")}`);
    if (snapshot.candidateGoal) lines.push(`- Candidate Goal: ${snapshot.candidateGoal}`);
    lines.push(`- Stop condition: ${snapshot.operationSignals.stopConditions[0] || "none explicit"}`);
    lines.push(`- Unfinished detection: ${snapshot.operationSignals.unfinishedDetection[0] || "none explicit"}`);
    if (snapshot.nextActions.length === 0) {
      lines.push("- Next action candidate: none explicit");
    } else {
      for (const action of snapshot.nextActions) lines.push(`- Next action candidate: ${action}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function renderHandoffInbox(now, snapshots) {
  const lines = [
    ...frontmatter("project_handoff_inbox", now),
    "# Generated Project Handoff Inbox",
    ""
  ];
  for (const snapshot of snapshots) {
    lines.push(`## ${snapshot.label}`);
    lines.push(`- Context Pack: ${contextPackObsidianLink(snapshot)}`);
    lines.push(`- Root: \`${snapshot.root}\``);
    lines.push(`- Exists: ${snapshot.rootExists ? "yes" : "no"}`);
    lines.push(`- Current state: ${snapshot.currentState[0] || "none explicit"}`);
    lines.push(`- Next action candidate: ${snapshot.nextActions[0] || "none explicit"}`);
    lines.push(`- Blocker: ${snapshot.blockers[0] || "none explicit"}`);
    lines.push(`- Execution precheck: ${snapshot.operationSignals.executionPrecheck[0] || "none explicit"}`);
    lines.push(`- Stop condition: ${snapshot.operationSignals.stopConditions[0] || "none explicit"}`);
    lines.push(`- Unfinished detection: ${snapshot.operationSignals.unfinishedDetection[0] || "none explicit"}`);
    lines.push(`- Missing operation signals: ${snapshot.operationSignalAudit.missing.length === 0 ? "none" : snapshot.operationSignalAudit.missing.join(", ")}`);
    lines.push(`- Readback artifact: ${snapshot.freshness.readback.status}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function renderLocatorDashboard(now, snapshots, kind, title, field, fallbackFromArtifacts = false) {
  const lines = [
    ...frontmatter(kind, now),
    `# ${title}`,
    ""
  ];
  for (const snapshot of snapshots) {
    const values = snapshot[field] || [];
    lines.push(`## ${snapshot.label}`);
    lines.push(`- Context Pack: ${contextPackObsidianLink(snapshot)}`);
    if (values.length === 0) {
      lines.push("- Locator: none explicit");
    } else {
      for (const value of values) lines.push(`- Locator: ${value}`);
    }
    if (fallbackFromArtifacts && snapshot.artifacts.length > 0) {
      for (const artifact of snapshot.artifacts) {
        lines.push(`- Latest artifact pointer: \`${artifact.latest}\` (${artifact.latestMtime}) (locator/pointer, not proof)`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function renderWeeklyReview(now, snapshots) {
  const lines = [
    ...frontmatter("weekly_project_review", now),
    "# Generated Weekly Project Review",
    "",
    "Start Goal/Resume work by opening the relevant Context Pack as the read-first locator, then fresh-read project-owned truth. Obsidian pages are not proof.",
    ""
  ];
  for (const snapshot of snapshots) {
    lines.push(`## ${snapshot.label}`);
    lines.push(`- Context Pack: ${contextPackObsidianLink(snapshot)}`);
    lines.push(`- Maturity candidate: ${snapshot.maturityCandidate}`);
    lines.push(`- Current state: ${snapshot.currentState[0] || "none explicit"}`);
    lines.push(`- Next action candidate: ${snapshot.nextActions[0] || "none explicit"}`);
    lines.push(`- Blocker: ${snapshot.blockers[0] || "none explicit"}`);
    lines.push(`- Execution precheck: ${snapshot.operationSignals.executionPrecheck[0] || "none explicit"}`);
    lines.push(`- Evidence locator: ${snapshot.operationSignals.evidence[0] || snapshot.proofLocators[0] || "none explicit"} (locator/pointer, not proof)`);
    lines.push(`- Readback artifact required: ${snapshot.freshness.readback.status}`);
    lines.push(`- Browser Use missing proof: ${snapshot.browserUseProofGate.missing.length === 0 ? "none" : snapshot.browserUseProofGate.missing.join(", ")}`);
    lines.push(`- 24h stale ranking: ${snapshot.freshness.staleRanking24h.length === 0 ? "none" : snapshot.freshness.staleRanking24h.join(", ")}`);
    lines.push(`- Stop condition: ${snapshot.operationSignals.stopConditions[0] || "none explicit"}`);
    lines.push(`- Weekly review signal: ${snapshot.operationSignals.weeklyReview[0] || "none explicit"}`);
    lines.push(`- Unfinished detection: ${snapshot.operationSignals.unfinishedDetection[0] || "none explicit"}`);
    if (snapshot.candidateGoal) lines.push(`- Candidate Goal: ${snapshot.candidateGoal}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function findCleanupCandidates() {
  const candidates = [];
  const maxFiles = 800;

  function add(file, reason) {
    if (candidates.some((candidate) => candidate.file === file && candidate.reason === reason)) return;
    candidates.push({ file, reason });
  }

  function walk(dir, depth = 5) {
    if (depth < 0 || candidates.length >= maxFiles) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).slice(0, maxDirEntries);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (shouldSkipDirectory(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth - 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      let markdown = "";
      try {
        markdown = fs.readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const relative = path.relative(obsidianVault, full);
      const hasFrontmatterMarker = isGeneratedByAutomationOs(markdown);
      const generatedName = /\bGenerated\b|\.generated\.md$/i.test(entry.name);
      const bodyMarker = /generated_by:\s*automation-os/i.test(markdown) && !hasFrontmatterMarker;
      const oldGeneratedText = /generated locator, not execution proof|Fresh-read boundary:/i.test(markdown) && !hasFrontmatterMarker;
      if (generatedName && !hasFrontmatterMarker) add(relative, "generated_name_missing_frontmatter_marker");
      if (bodyMarker) add(relative, "generated_marker_outside_frontmatter_manual_review");
      if (oldGeneratedText) add(relative, "generated_boundary_text_missing_frontmatter_marker");
    }
  }

  walk(obsidianVault);
  return candidates.sort((a, b) => a.file.localeCompare(b.file, "en") || a.reason.localeCompare(b.reason, "en"));
}

function renderCleanupCandidates(now) {
  const candidates = findCleanupCandidates();
  const lines = [
    ...frontmatter("notes_cleanup_candidates", now),
    "# Generated Notes Cleanup Candidates",
    "",
    "This page is a manual review list only. The collector never deletes, moves, or overwrites candidate notes during cleanup.",
    ""
  ];
  if (candidates.length === 0) {
    lines.push("- No manual review candidates found.");
  } else {
    for (const candidate of candidates) {
      lines.push(`- Manual review candidate: \`${candidate.file}\` (${candidate.reason})`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function renderRoleReadme(now, folder, purpose) {
  const lines = [
    ...frontmatter("folder_role_readme", now),
    `# ${folder} Folder Role`,
    "",
    `- Role: ${purpose}.`,
    "- Goal/Resume entry: use generated Context Packs as read-first locators, then read project-owned STATE.md, AGENTS.md, automation.toml, Skill/docs, and latest artifacts/readbacks.",
    "- Boundary: Obsidian generated pages are locators only, not execution proof.",
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function renderProjectTemplate(now) {
  const lines = [
    ...frontmatter("project_template", now),
    "# Generated Project Template",
    "",
    "Use this as a locator scaffold for new project notes. Do not treat this page, or any Obsidian generated page, as execution proof.",
    "",
    "## Read First",
    "- Context Pack pattern: `05_Projects/Generated Context Packs/<project-id>.md`",
    "- Project-owned STATE.md",
    "- Latest artifacts/readbacks",
    "",
    "## Current State",
    "- none explicit",
    "",
    "## Next Action",
    "- none explicit",
    "",
    "## Proof Locators",
    "- none explicit",
    ""
  ];
  return `${lines.join("\n")}\n`;
}

function renderMemoryNote(now, snapshots) {
  const lines = [
    ...frontmatter("project_handoff_auto_snapshot", now),
    "# Project handoff auto snapshot",
    "",
    `${now.toISOString()}: Scheduled Obsidian maintenance created this multi-project continuation note automatically. [ad-hoc note]`,
    "",
    "This is a generated locator, not execution proof. Fresh-read each project's STATE/artifacts/Skill before irreversible work.",
    ""
  ];
  for (const snapshot of snapshots) {
    lines.push(`## ${snapshot.label}`);
    lines.push(`- root: ${snapshot.root}`);
    lines.push(`- exists: ${snapshot.rootExists ? "yes" : "no"}`);
    if (snapshot.files.length === 0) {
      lines.push("- authority_files: none found");
    } else {
      for (const file of snapshot.files) {
        lines.push(`- ${file.relative} (${file.mtime}): ${file.summary || "empty"}`);
      }
    }
    if (snapshot.artifacts.length === 0) {
      lines.push("- artifacts: none found");
    } else {
      for (const artifact of snapshot.artifacts) {
        lines.push(`- artifact ${artifact.relative}: latest=${artifact.latest} mtime=${artifact.latestMtime} locator/pointer_not_proof`);
      }
    }
    lines.push(...renderOperationSignals(snapshot.operationSignals, { heading: "### operationSignals" }));
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function renderObsidianIndex(now, snapshots) {
  const lines = [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: project_handoff_index",
    `updated_at: ${now.toISOString()}`,
    "---",
    "",
    "# Project Handoff Index",
    "",
    "Generated by scheduled Obsidian maintenance. This page is a quick locator for current project state; execution truth remains in each project-owned STATE, Skill, docs, and artifacts.",
    "",
    "generated locator, not execution proof",
    "",
    "Fresh-read boundary: before acting, read the project-owned STATE.md, AGENTS.md, automation.toml, Skill/docs, and latest artifacts/readbacks directly.",
    "",
    "Auto-resume triggers: if a new Codex session is asked `AutomationOSは何をやっていた?`, `<project>は何をやっていた?`, `あと何をやる?`, `どこまで進んだ?`, `前回の続き`, or after a crash/restart, read this locator first, then `Resume Current Work.md`, `Resume Contract.md`, the target project context pack, and finally the project-owned STATE/artifacts before answering. This applies to every indexed project, not only Automation OS.",
    "",
    "Session memory boundary: chat/session snippets are hints only. Do not ask the user to re-explain until these locators and project-owned source-of-truth files have been fresh-read.",
    "Obsidian autonomy memo: [[Obsidian Autonomy Ops Memo]]",
    ""
  ];
  for (const snapshot of snapshots) {
    lines.push(`## ${snapshot.label}`);
    lines.push(`- Context Pack: ${contextPackObsidianLink(snapshot)}`);
    lines.push(`- Root: \`${snapshot.root}\``);
    lines.push(`- Exists: ${snapshot.rootExists ? "yes" : "no"}`);
    lines.push(`- Maturity candidate: ${snapshot.maturityCandidate}`);
    lines.push(`- Next action candidate: ${snapshot.nextActions[0] || "none explicit"}`);
    const primary = snapshot.files[0];
    if (primary) {
      lines.push(`- Primary: \`${primary.relative}\` (${primary.mtime})`);
      lines.push(`- Summary: ${primary.summary || "empty"}`);
    } else {
      lines.push("- Primary: none found");
    }
    const artifact = snapshot.artifacts[0];
    if (artifact) {
      lines.push(`- Latest artifact pointer: \`${artifact.latest}\` (${artifact.latestMtime}) (locator/pointer, not proof)`);
    } else {
      lines.push("- Latest artifact pointer: none found");
    }
    lines.push(`- Execution precheck: ${snapshot.operationSignals.executionPrecheck[0] || "none explicit"}`);
    lines.push(`- Evidence locator: ${snapshot.operationSignals.evidence[0] || "none explicit"} (locator/pointer, not proof)`);
    lines.push(`- Stop condition: ${snapshot.operationSignals.stopConditions[0] || "none explicit"}`);
    lines.push(`- Weekly review signal: ${snapshot.operationSignals.weeklyReview[0] || "none explicit"}`);
    lines.push(`- Unfinished detection: ${snapshot.operationSignals.unfinishedDetection[0] || "none explicit"}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function writeIfGenerated(file, content) {
  if (exists(file)) {
    const existing = fs.readFileSync(file, "utf8");
    if (!isGeneratedByAutomationOs(existing)) {
      return { ok: false, reason: "non_generated_target_exists", file };
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, redact(content), "utf8");
  fs.renameSync(tmp, file);
  return { ok: true, file };
}

function readbackGeneratedFile(entry) {
  const file = entry?.file;
  const checks = {
    exists: false,
    generatedBy: false,
    locatorBoundary: false,
    freshReadBoundary: false
  };
  if (!entry?.ok) {
    return {
      role: entry?.role,
      projectId: entry?.projectId,
      ok: false,
      file,
      reason: entry?.reason || "write_failed",
      checks
    };
  }
  if (!file) {
    return {
      role: entry.role,
      projectId: entry.projectId,
      ok: false,
      file,
      reason: "missing_file_path",
      checks
    };
  }
  if (!exists(file)) {
    return {
      role: entry.role,
      projectId: entry.projectId,
      ok: false,
      file,
      reason: "generated_file_missing",
      checks
    };
  }
  checks.exists = true;
  let markdown = "";
  try {
    markdown = fs.readFileSync(file, "utf8");
  } catch (error) {
    return {
      role: entry.role,
      projectId: entry.projectId,
      ok: false,
      file,
      reason: `readback_failed:${error.code || error.message}`,
      checks
    };
  }
  checks.generatedBy = isGeneratedByAutomationOs(markdown);
  checks.locatorBoundary = markdown.includes(generatedLocatorText);
  checks.freshReadBoundary = markdown.includes("Fresh-read boundary");
  const missing = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  return {
    role: entry.role,
    projectId: entry.projectId,
    ok: missing.length === 0,
    file,
    reason: missing.length === 0 ? undefined : `readback_missing_${missing.join("_")}`,
    checks
  };
}

function isGeneratedByAutomationOs(markdown) {
  const lines = markdown.split(/\r?\n/).slice(0, 40);
  if (lines[0]?.trim() !== "---") return false;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return false;
  return lines.slice(1, end).some((line) => line.trim() === "generated_by: automation-os");
}

function removeStaleGeneratedContextPacks(snapshots) {
  const dir = path.join(obsidianVault, "05_Projects", "Generated Context Packs");
  if (!exists(dir)) return [];
  const expected = new Set(snapshots.map((snapshot) => path.resolve(snapshot.contextPackPath)));
  const removed = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file = path.join(dir, entry.name);
    if (expected.has(path.resolve(file))) continue;
    let markdown = "";
    try {
      markdown = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!isGeneratedByAutomationOs(markdown) || !/kind:\s*project_context_pack/i.test(markdown)) continue;
    fs.unlinkSync(file);
    removed.push(file);
  }
  return removed;
}

function acquireVaultWriteLock(owner) {
  if (process.env.PROJECT_HANDOFF_LOCK_HELD === "1") return () => {};
  const key = crypto.createHash("sha256").update(path.resolve(obsidianVault)).digest("hex").slice(0, 16);
  const lockPath = process.env.AUTOMATION_OS_OBSIDIAN_WRITE_LOCK || path.join(os.tmpdir(), `automation-os-obsidian-${key}.lock`);
  if (exists(lockPath)) {
    let record = null;
    try {
      record = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    } catch {
      // Invalid locks are still treated as active until the stale timeout passes.
    }
    let live = false;
    if (Number.isInteger(record?.pid)) {
      try {
        process.kill(record.pid, 0);
        live = true;
      } catch {
        live = false;
      }
    }
    const hasPid = Number.isInteger(record?.pid);
    const ageMs = Date.now() - (statSafe(lockPath)?.mtimeMs || Date.now());
    if (!live && (hasPid || ageMs >= 6 * 60 * 60 * 1000)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Fail closed below if another process won the recovery race.
      }
    }
  }
  const fd = fs.openSync(lockPath, "wx", 0o600);
  const acquiredAt = new Date().toISOString();
  fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, owner, vaultPath: path.resolve(obsidianVault), acquiredAt })}\n`, "utf8");
  fs.closeSync(fd);
  return () => {
    try {
      const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      if (current.pid === process.pid && current.acquiredAt === acquiredAt) fs.unlinkSync(lockPath);
    } catch {
      // Best-effort cleanup only.
    }
  };
}

function runMain() {
  const now = new Date();
  const snapshots = buildProjectSpecs().map((spec) => projectSnapshot(spec, now));
  fs.mkdirSync(notesDir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const memoryFile = path.join(notesDir, `${stamp}-project-handoffs-auto.md`);
  const generatedResults = [];
  if (process.env.PROJECT_HANDOFF_WRITE_MEMORY_NOTE !== "0") {
    generatedResults.push({ role: "memory_note", ...writeIfGenerated(memoryFile, renderMemoryNote(now, snapshots)) });
  }
  const removedStaleContextPacks = removeStaleGeneratedContextPacks(snapshots);
  const obsidian = writeIfGenerated(obsidianFile, renderObsidianIndex(now, snapshots));
  generatedResults.push({ role: "project_handoff_index", ...obsidian });
  for (const snapshot of snapshots) {
    generatedResults.push({
      role: "context_pack",
      projectId: snapshot.id,
      ...writeIfGenerated(snapshot.contextPackPath, renderContextPack(now, snapshot))
    });
  }
  generatedResults.push({ role: "action_queue_candidates", ...writeIfGenerated(generatedObsidianFiles.actionQueue, renderActionQueue(now, snapshots)) });
  generatedResults.push({ role: "project_handoff_inbox", ...writeIfGenerated(generatedObsidianFiles.handoffInbox, renderHandoffInbox(now, snapshots)) });
  generatedResults.push({
    role: "proof_locators",
    ...writeIfGenerated(
      generatedObsidianFiles.proofLocators,
      renderLocatorDashboard(now, snapshots, "proof_locators", "Generated Proof Locators", "proofLocators", false)
    )
  });
  generatedResults.push({
    role: "decision_locators",
    ...writeIfGenerated(
      generatedObsidianFiles.decisionLocators,
      renderLocatorDashboard(now, snapshots, "decision_locators", "Generated Decision Locators", "decisionLocators")
    )
  });
  generatedResults.push({
    role: "runbook_locators",
    ...writeIfGenerated(
      generatedObsidianFiles.runbookLocators,
      renderLocatorDashboard(now, snapshots, "runbook_locators", "Generated Runbook Locators", "runbookLocators")
    )
  });
  generatedResults.push({
    role: "weekly_review",
    ...writeIfGenerated(generatedObsidianFiles.weeklyReview, renderWeeklyReview(now, snapshots))
  });
  generatedResults.push({
    role: "cleanup_candidates",
    ...writeIfGenerated(generatedObsidianFiles.cleanupCandidates, renderCleanupCandidates(now))
  });
  generatedResults.push({
    role: "project_template",
    ...writeIfGenerated(generatedObsidianFiles.projectTemplate, renderProjectTemplate(now))
  });
  for (const readme of generatedRoleReadmes) {
    generatedResults.push({
      role: readme.role,
      ...writeIfGenerated(readme.file, renderRoleReadme(now, readme.folder, readme.purpose))
    });
  }
  const allGeneratedOk = generatedResults.every((entry) => entry.ok);
  const readbackResults = generatedResults.map(readbackGeneratedFile);
  const allReadbackOk = readbackResults.every((entry) => entry.ok);
  const ok = allGeneratedOk && allReadbackOk;
  const result = {
    ok,
    memoryFile,
    obsidianFile: obsidian.file,
    obsidianReason: obsidian.reason,
    generatedFiles: generatedResults.map((entry) => ({
      role: entry.role,
      projectId: entry.projectId,
      ok: entry.ok,
      file: entry.file,
      reason: entry.reason
    })),
    readbackResults: readbackResults.map((entry) => ({
      role: entry.role,
      projectId: entry.projectId,
      ok: entry.ok,
      file: entry.file,
      reason: entry.reason,
      checks: entry.checks
    })),
    contextPacks: snapshots.map((snapshot) => ({
      id: snapshot.id,
      label: snapshot.label,
      file: snapshot.contextPackPath,
      obsidianLink: contextPackObsidianLink(snapshot),
      currentState: snapshot.currentState,
      nextActions: snapshot.nextActions,
      blockers: snapshot.blockers,
      riskGates: snapshot.riskGates,
      operationSignals: snapshot.operationSignals,
      latestArtifactPointers: snapshot.latestArtifactPointers,
      missingOperationSignals: snapshot.operationSignalAudit.missing,
      freshness: snapshot.freshness,
      candidateGoal: snapshot.candidateGoal,
      browserUseProofGate: snapshot.browserUseProofGate,
      maturityCandidate: snapshot.maturityCandidate
    })),
    projects: snapshots.map((snapshot) => ({
      id: snapshot.id,
      exists: snapshot.rootExists,
      authorityFiles: snapshot.files.map((file) => file.relative),
      artifactRoots: snapshot.artifacts.map((artifact) => artifact.relative),
      contextPackPath: snapshot.contextPackPath
    })),
    removedStaleContextPacks
  };
  console.log(redact(JSON.stringify(result)));
  if (!ok && process.env.PROJECT_HANDOFF_STRICT === "1") process.exitCode = 1;
}

function main() {
  let release;
  try {
    release = acquireVaultWriteLock("project-handoff-collector");
    runMain();
  } catch (error) {
    console.log(redact(JSON.stringify({ ok: false, exactBlocker: error?.code === "EEXIST" ? "obsidian_vault_write_locked" : error?.message || "project_handoff_collector_failed" })));
    process.exitCode = 1;
  } finally {
    release?.();
  }
}

main();

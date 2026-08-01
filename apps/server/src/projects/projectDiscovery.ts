import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { loadProjectRegistry, resolveProjectRegistryPath, type ProjectRegistry, type ProjectRegistryProject } from "./projectAuditor.js";

export type ProjectDiscoveryCandidate = {
  root: string;
  label: string;
  markers: string[];
};

export type ProjectDiscoveryResult = {
  ok: boolean;
  dryRun: boolean;
  registryPath: string;
  scannedDirectories: number;
  candidates: ProjectDiscoveryCandidate[];
  registered: ProjectRegistryProject[];
  alreadyRegistered: string[];
  skippedNested: string[];
  removedDuplicateLocators: string[];
};

export type ProjectDiscoveryOptions = {
  roots?: Array<{ path: string; maxDepth: number }>;
  registryPath?: string;
  vaultPath?: string;
  write?: boolean;
  generatedAt?: string;
  maxDirectories?: number;
};

const markerFiles = ["STATE.md", "AGENTS.md", "PROJECT_DESIGN.md", "GOAL.md", "SKILL.md", "automation.toml", "package.json"];
const artifactRoots = ["artifacts", "output", "goals", "work", "test-results", "screenshots"];
const excludedDirectoryNames = new Set([
  ".git",
  ".backups",
  ".cache",
  ".next",
  ".tmp",
  ".venv",
  "artifacts",
  "backup-repos",
  "backups",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "output",
  "snapshots",
  "test-results",
  "tmp",
  "venv",
  "verification",
  "worktrees",
  "__pycache__"
]);

export function defaultProjectDiscoveryRoots(home = homedir()): Array<{ path: string; maxDepth: number }> {
  return [
    { path: join(home, "Documents"), maxDepth: 2 },
    { path: join(home, "Documents", "Codex", "external-repos"), maxDepth: 3 },
    { path: join(home, "Documents", "Codex", "projects"), maxDepth: 4 },
    { path: join(home, "Desktop"), maxDepth: 4 },
    { path: join(home, ".agents", "skills"), maxDepth: 2 }
  ];
}

export function discoverProjectCandidates(options: ProjectDiscoveryOptions = {}): {
  candidates: ProjectDiscoveryCandidate[];
  scannedDirectories: number;
} {
  const roots = options.roots ?? defaultProjectDiscoveryRoots();
  const maxDirectories = options.maxDirectories ?? 5000;
  const candidates: ProjectDiscoveryCandidate[] = [];
  const visited = new Set<string>();
  let scannedDirectories = 0;

  function walk(path: string, depth: number): void {
    if (depth < 0 || scannedDirectories >= maxDirectories || !existsSync(path)) return;
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      return;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const canonical = canonicalPath(path);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    scannedDirectories += 1;

    const markers = markerFiles.filter((file) => existsSync(join(path, file)));
    if (isDurableCandidate(markers)) {
      candidates.push({ root: canonical, label: labelFor(path), markers });
      return;
    }

    let entries = [];
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      if (!entry.isDirectory() || shouldSkipDirectory(entry.name)) continue;
      walk(join(path, entry.name), depth - 1);
      if (scannedDirectories >= maxDirectories) return;
    }
  }

  for (const root of roots) walk(resolve(root.path), root.maxDepth);
  return {
    candidates: candidates.sort((left, right) => left.root.localeCompare(right.root, "en")),
    scannedDirectories
  };
}

export function syncDiscoveredProjects(options: ProjectDiscoveryOptions = {}): ProjectDiscoveryResult {
  const registryPath = resolveProjectRegistryPath(options.registryPath);
  const registry = loadProjectRegistry(registryPath);
  const { projects: activeProjects, removedIds: removedDuplicateLocators } = removeDuplicateLocatorEntries(registry.projects);
  const discovery = discoverProjectCandidates(options);
  const registeredRoots = new Map(activeProjects.map((project) => [canonicalPath(project.root), project]));
  const registered: ProjectRegistryProject[] = [];
  const alreadyRegistered: string[] = [];
  const skippedNested: string[] = [];

  for (const candidate of discovery.candidates) {
    const canonical = canonicalPath(candidate.root);
    if (registeredRoots.has(canonical)) {
      alreadyRegistered.push(candidate.root);
      continue;
    }
    const parent = activeProjects.find((project) => isNestedUnder(canonical, canonicalPath(project.root)));
    if (parent) {
      skippedNested.push(candidate.root);
      continue;
    }
    const entry = buildDiscoveredRegistryEntry(candidate, { ...registry, projects: activeProjects }, options.vaultPath);
    registered.push(entry);
    registeredRoots.set(canonical, entry);
  }

  if (options.write === true && (registered.length > 0 || removedDuplicateLocators.length > 0)) {
    const next: ProjectRegistry = {
      ...registry,
      updated_at: (options.generatedAt ?? new Date().toISOString()).slice(0, 10),
      projects: [...activeProjects, ...registered].sort((left, right) => left.id.localeCompare(right.id, "en"))
    };
    atomicWrite(registryPath, `${JSON.stringify(next, null, 2)}\n`);
  }

  return {
    ok: true,
    dryRun: options.write !== true,
    registryPath,
    scannedDirectories: discovery.scannedDirectories,
    candidates: discovery.candidates,
    registered,
    alreadyRegistered,
    skippedNested,
    removedDuplicateLocators
  };
}

function buildDiscoveredRegistryEntry(
  candidate: ProjectDiscoveryCandidate,
  registry: ProjectRegistry,
  vaultPath?: string
): ProjectRegistryProject {
  const id = uniqueId(candidate.root, registry.projects.map((project) => project.id));
  const detectedArtifacts = artifactRoots.filter((name) => existsSync(join(candidate.root, name)));
  const contextPack = vaultPath ? join(resolve(vaultPath), "05_Projects", "Generated Context Packs", `${id}.md`) : undefined;
  return {
    id,
    label: candidate.label,
    aliases: [basename(candidate.root), candidate.label],
    root: candidate.root,
    owner_layer: "locator_only_candidate",
    obsidian: true,
    authority_files: ["STATE.md", ...candidate.markers.filter((file) => file !== "STATE.md")],
    artifact_roots: detectedArtifacts.length > 0 ? detectedArtifacts : ["artifacts"],
    source_of_truth: [join(candidate.root, "STATE.md")],
    related_projects: ["automation-os", "local-codex"],
    allowed_automation: ["safe_auto_fix", "read_only_audit"],
    approval_required: ["external_api_write", "github_push", "deploy", "delete", "external_service_settings_change", "secret_change"],
    human_only: ["billing", "purchase", "payment", "checkout", "paid_subscription", "invoice", "captcha", "otp", "security_code", "identity_verification"],
    context_pack: contextPack,
    discovery: {
      mode: "automatic",
      status: "locator_only_candidate",
      markers: candidate.markers
    }
  };
}

function isDurableCandidate(markers: string[]): boolean {
  const markerSet = new Set(markers);
  return markerSet.has("STATE.md") || (markerSet.has("PROJECT_DESIGN.md") && markerSet.has("GOAL.md"));
}

function shouldSkipDirectory(name: string): boolean {
  const normalized = name.toLowerCase();
  return excludedDirectoryNames.has(normalized) || normalized.startsWith("backup-") || normalized.startsWith("snapshot-");
}

function labelFor(path: string): string {
  for (const file of ["STATE.md", "PROJECT_DESIGN.md", "GOAL.md"]) {
    const target = join(path, file);
    if (!existsSync(target)) continue;
    const heading = readFileSync(target, "utf8").match(/^#\s+(.+)$/m)?.[1]?.trim();
    if (heading) return heading.replace(/\s+(?:Current State|State|Project Design|Goal)$/i, "").trim();
  }
  return basename(path).replace(/[-_]+/g, " ").trim() || path;
}

function uniqueId(root: string, existingIds: string[]): string {
  const base = basename(root)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "project";
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  const candidate = `auto-${base}-${hash}`;
  if (!existingIds.includes(candidate)) return candidate;
  return `auto-project-${hash}`;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path).normalize("NFC");
  } catch {
    return resolve(path).normalize("NFC");
  }
}

function removeDuplicateLocatorEntries(projects: ProjectRegistryProject[]): {
  projects: ProjectRegistryProject[];
  removedIds: string[];
} {
  const preferredRoots = new Set(
    projects
      .filter((project) => project.discovery?.status !== "locator_only_candidate")
      .map((project) => canonicalPath(project.root))
  );
  const removedIds: string[] = [];
  const filtered = projects.filter((project) => {
    const duplicateLocator =
      project.discovery?.status === "locator_only_candidate" && preferredRoots.has(canonicalPath(project.root));
    if (duplicateLocator) removedIds.push(project.id);
    return !duplicateLocator;
  });
  return { projects: filtered, removedIds };
}

function isNestedUnder(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, path);
}

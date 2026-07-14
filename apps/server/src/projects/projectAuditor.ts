import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { buildDefaultProjectRegistry } from "./defaultProjectRegistry.js";

export type ProjectAutomationClass = "safe_auto_fix" | "approval_required_fix" | "human_only";
export type ProjectHealthStatus = "ok" | "attention" | "blocked";

export type ProjectRegistry = {
  schema_version: number;
  updated_at: string;
  policy: {
    default_surface: string;
    safe_auto_fix: string[];
    approval_required_fix: string[];
    human_only: string[];
  };
  projects: ProjectRegistryProject[];
};

export type ProjectRegistryProject = {
  id: string;
  label: string;
  root: string;
  owner_layer: string;
  obsidian: boolean;
  authority_files: string[];
  artifact_roots: string[];
  source_of_truth: string[];
  related_projects: string[];
  allowed_automation: string[];
  approval_required: string[];
  human_only: string[];
  context_pack?: string;
};

export type ProjectAuditIssue = {
  severity: "info" | "warning" | "blocked";
  code: string;
  message: string;
};

export type ProjectAuditItem = {
  project: ProjectRegistryProject;
  status: ProjectHealthStatus;
  automationClass: ProjectAutomationClass;
  rootExists: boolean;
  statePath: string;
  stateExists: boolean;
  stateMtime: string | null;
  contextPackExists: boolean;
  contextPackHasLocatorBoundary: boolean;
  authority: Array<{ path: string; exists: boolean; mtime: string | null }>;
  artifacts: Array<{ path: string; exists: boolean; latest: string | null; latestMtime: string | null }>;
  issues: ProjectAuditIssue[];
  safeFixes: string[];
  approvalRequired: string[];
  humanOnly: string[];
  nextAction: string;
};

export type ProjectAuditResult = {
  ok: boolean;
  generatedAt: string;
  registryPath: string;
  summary: {
    projects: number;
    ok: number;
    attention: number;
    blocked: number;
    safeAutoFixes: number;
    approvalRequired: number;
    humanOnly: number;
  };
  policy: ProjectRegistry["policy"];
  projects: ProjectAuditItem[];
};

export type ProjectRegistrationInput = {
  id: string;
  label: string;
  root: string;
  ownerLayer?: string;
  registryPath?: string;
  obsidian?: boolean;
  relatedProjects?: string[];
  artifactRoots?: string[];
  approvalRequired?: string[];
  humanOnly?: string[];
  allowedAutomation?: string[];
  write?: boolean;
  update?: boolean;
  generatedAt?: string;
};

export type ProjectRegistrationResult = {
  ok: boolean;
  dryRun: boolean;
  registryPath: string;
  statePath: string;
  entry: ProjectRegistryProject;
  stateCreated: boolean;
  registryUpdated: boolean;
  existingProject: boolean;
  nextSteps: string[];
  error?: string;
};

type DirectoryEntry = {
  name: string;
  isDirectory: () => boolean;
};

const staleStateHours = Number.parseFloat(process.env.AUTOMATION_OS_PROJECT_AUDIT_STALE_STATE_HOURS || "72");

function defaultRegistryPath(): string {
  return resolve(process.cwd(), "data", "project-registry.json");
}

export function resolveProjectRegistryPath(input?: string): string {
  return resolve(input || process.env.AUTOMATION_OS_PROJECT_REGISTRY || defaultRegistryPath());
}

export function loadProjectRegistry(input?: string): ProjectRegistry {
  const registryPath = resolveProjectRegistryPath(input);
  if (!existsSync(registryPath) && !input && !process.env.AUTOMATION_OS_PROJECT_REGISTRY) {
    const fallback = buildDefaultProjectRegistry();
    validateProjectRegistry(fallback, "defaultProjectRegistry");
    return fallback;
  }
  const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as ProjectRegistry;
  validateProjectRegistry(parsed, registryPath);
  return parsed;
}

export function auditProjects(options: { registryPath?: string; obsidianVaultPath?: string; generatedAt?: string } = {}): ProjectAuditResult {
  const registryPath = resolveProjectRegistryPath(options.registryPath);
  const registry = loadProjectRegistry(options.registryPath);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const projects = registry.projects.map((project) => auditProject(project, options.obsidianVaultPath));
  const summary = {
    projects: projects.length,
    ok: projects.filter((project) => project.status === "ok").length,
    attention: projects.filter((project) => project.status === "attention").length,
    blocked: projects.filter((project) => project.status === "blocked").length,
    safeAutoFixes: projects.reduce((total, project) => total + project.safeFixes.length, 0),
    approvalRequired: projects.reduce((total, project) => total + project.approvalRequired.length, 0),
    humanOnly: projects.reduce((total, project) => total + project.humanOnly.length, 0)
  };
  return {
    ok: summary.blocked === 0,
    generatedAt,
    registryPath,
    summary,
    policy: registry.policy,
    projects
  };
}

export function writeProjectAuditStatus(result: ProjectAuditResult, outputPath = resolve(process.cwd(), "data", "project-audit-status.json")): string {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  return outputPath;
}

export function registerProject(input: ProjectRegistrationInput): ProjectRegistrationResult {
  const registryPath = resolveProjectRegistryPath(input.registryPath);
  const registry = loadProjectRegistry(registryPath);
  const root = resolve(input.root);
  const statePath = join(root, "STATE.md");
  const existingIndex = registry.projects.findIndex((project) => project.id === input.id);
  const existingProject = existingIndex >= 0;
  if (existingProject && !input.update) {
    return registrationResult(input, registryPath, statePath, buildRegistryEntry(input), false, false, true, `Project id already exists: ${input.id}`);
  }
  const entry = existingProject ? { ...registry.projects[existingIndex], ...buildRegistryEntry(input) } : buildRegistryEntry(input);
  const dryRun = input.write !== true;
  const stateExists = existsSync(statePath);
  let stateCreated = false;
  let registryUpdated = false;
  if (!dryRun) {
    mkdirSync(root, { recursive: true });
    if (!stateExists) {
      atomicWrite(statePath, renderProjectStateTemplate(entry, input.generatedAt ?? new Date().toISOString()));
      stateCreated = true;
    }
    const nextRegistry: ProjectRegistry = {
      ...registry,
      updated_at: (input.generatedAt ?? new Date().toISOString()).slice(0, 10),
      projects: existingProject
        ? registry.projects.map((project, index) => (index === existingIndex ? entry : project))
        : [...registry.projects, entry].sort((left, right) => left.id.localeCompare(right.id))
    };
    validateProjectRegistry(nextRegistry, registryPath);
    atomicWrite(registryPath, `${JSON.stringify(nextRegistry, null, 2)}\n`);
    registryUpdated = true;
  }
  return registrationResult(input, registryPath, statePath, entry, stateCreated, registryUpdated, existingProject);
}

export function buildRegistryEntry(input: ProjectRegistrationInput): ProjectRegistryProject {
  const root = resolve(input.root);
  return {
    id: input.id,
    label: input.label,
    root,
    owner_layer: input.ownerLayer ?? "project_workspace",
    obsidian: input.obsidian ?? true,
    authority_files: ["STATE.md"],
    artifact_roots: input.artifactRoots ?? ["artifacts"],
    source_of_truth: [join(root, "STATE.md"), join(root, "artifacts")],
    related_projects: input.relatedProjects ?? ["automation-os", "local-codex"],
    allowed_automation: input.allowedAutomation ?? ["safe_auto_fix", "read_only_audit"],
    approval_required: input.approvalRequired ?? [
      "external_api_write",
      "github_push",
      "deploy",
      "delete",
      "external_service_settings_change",
      "secret_change"
    ],
    human_only: input.humanOnly ?? [
      "billing",
      "purchase",
      "payment",
      "checkout",
      "paid_subscription",
      "invoice",
      "captcha",
      "otp",
      "security_code",
      "identity_verification"
    ]
  };
}

export function renderProjectStateTemplate(project: ProjectRegistryProject, generatedAt: string): string {
  return [
    `# ${project.label} Current State`,
    "",
    `Updated: ${generatedAt.slice(0, 10)}`,
    "",
    "This file is the project-owned source of truth entrypoint for Codex/Obsidian resume. Generated Obsidian pages are locators, not execution proof.",
    "",
    "## Obsidian Context Fields",
    "",
    `current_state: New project registered in Automation OS Project Registry. Replace this line with the current real state before execution.`,
    `next_action: Fresh-read this STATE.md, project authority files, latest artifacts/readbacks, and update current_state/blocker before any external action.`,
    "blocker: initial_state_needs_project_owner_update",
    `risk_gate: Do not use generated Obsidian pages as permission to publish, send, submit, save, sync, delete, deploy, change secrets, change external settings, or make billing/purchase/payment/checkout decisions.`,
    "maturity_candidate: newly_registered_requires_fresh_read",
    "source_of_truth:",
    ...project.source_of_truth.map((source) => `- ${source}`),
    "proof_locator:",
    ...project.artifact_roots.map((artifactRoot) => `- ${join(project.root, artifactRoot)}`),
    "related_projects:",
    ...project.related_projects.map((relatedProject) => `- ${relatedProject}`),
    "",
    "## Boundary",
    "",
    `Owner layer: ${project.owner_layer}`,
    `Allowed automation: ${project.allowed_automation.join(", ")}`,
    `Approval required: ${project.approval_required.join(", ")}`,
    `Human only: ${project.human_only.join(", ")}`,
    "",
    "Before this project is treated as execution-ready, replace the initial placeholder state with real project facts and proof locators."
  ].join("\n");
}

function validateProjectRegistry(registry: ProjectRegistry, registryPath: string): void {
  if (!registry || typeof registry !== "object") throw new Error(`Invalid project registry: ${registryPath}`);
  if (!Array.isArray(registry.projects)) throw new Error(`Project registry missing projects array: ${registryPath}`);
  const ids = new Set<string>();
  for (const project of registry.projects) {
    if (!project.id || ids.has(project.id)) throw new Error(`Project registry has missing or duplicate project id: ${project.id}`);
    ids.add(project.id);
    if (!project.root || !isAbsolute(project.root)) throw new Error(`Project ${project.id} root must be absolute`);
    if (!project.authority_files?.length) throw new Error(`Project ${project.id} must declare authority_files`);
    if (!project.source_of_truth?.length) throw new Error(`Project ${project.id} must declare source_of_truth`);
  }
}

function registrationResult(
  input: ProjectRegistrationInput,
  registryPath: string,
  statePath: string,
  entry: ProjectRegistryProject,
  stateCreated: boolean,
  registryUpdated: boolean,
  existingProject: boolean,
  error?: string
): ProjectRegistrationResult {
  return {
    ok: !error,
    dryRun: input.write !== true,
    registryPath,
    statePath,
    entry,
    stateCreated,
    registryUpdated,
    existingProject,
    nextSteps: [
      input.write === true ? "Run npm run project:audit to verify registry health." : "Re-run with --write to create STATE.md and update the registry.",
      "Run npm run obsidian:export to refresh Project Health and Project Action Queue.",
      "Fresh-read the new project STATE.md and replace placeholder current_state/blocker before execution."
    ],
    error
  };
}

function atomicWrite(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmpPath = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, body.endsWith("\n") ? body : `${body}\n`);
  renameSync(tmpPath, file);
}

function auditProject(project: ProjectRegistryProject, obsidianVaultPath?: string): ProjectAuditItem {
  const rootExists = existsSync(project.root);
  const statePath = join(project.root, "STATE.md");
  const stateExists = existsSync(statePath);
  const stateMtime = mtimeIso(statePath);
  const contextPackPath = resolveContextPack(project, obsidianVaultPath);
  const contextPackExists = Boolean(contextPackPath && existsSync(contextPackPath));
  const contextPackHasLocatorBoundary = contextPackExists && contextPackPath ? hasLocatorBoundary(contextPackPath) : false;
  const authority = project.authority_files.map((relativePath) => {
    const path = join(project.root, relativePath);
    return { path, exists: existsSync(path), mtime: mtimeIso(path) };
  });
  const artifacts = project.artifact_roots.map((relativePath) => {
    const path = join(project.root, relativePath);
    const latest = newestEntry(path, 2);
    return { path, exists: existsSync(path), latest: latest?.path ?? null, latestMtime: latest?.mtime ?? null };
  });
  const issues: ProjectAuditIssue[] = [];
  if (!rootExists) issues.push({ severity: "blocked", code: "project_root_missing", message: "Project root path does not exist." });
  if (!stateExists) issues.push({ severity: "blocked", code: "state_missing", message: "STATE.md is required before this project can be treated as a durable execution target." });
  if (stateMtime && hoursSince(stateMtime) > staleStateHours) {
    issues.push({ severity: "warning", code: "state_stale", message: `STATE.md is older than ${staleStateHours}h; fresh-read before acting.` });
  }
  for (const file of authority.filter((file) => !file.exists)) {
    issues.push({ severity: file.path.endsWith("STATE.md") ? "blocked" : "warning", code: "authority_file_missing", message: `Missing authority file: ${file.path}` });
  }
  if (project.obsidian && !contextPackExists) {
    issues.push({ severity: "warning", code: "context_pack_missing", message: "Generated Obsidian Context Pack is missing." });
  }
  if (project.obsidian && contextPackExists && !contextPackHasLocatorBoundary) {
    issues.push({ severity: "warning", code: "context_pack_boundary_missing", message: "Context Pack does not carry the locator-not-proof boundary." });
  }
  if (project.approval_required.length === 0) {
    issues.push({ severity: "warning", code: "approval_boundary_missing", message: "No approval_required operations are registered." });
  }
  if (project.human_only.length === 0) {
    issues.push({ severity: "warning", code: "human_only_boundary_missing", message: "No human_only operations are registered." });
  }

  const safeFixes = suggestSafeFixes(project, { stateExists, contextPackExists, contextPackHasLocatorBoundary });
  const status = issues.some((issue) => issue.severity === "blocked") ? "blocked" : issues.some((issue) => issue.severity === "warning") ? "attention" : "ok";
  return {
    project,
    status,
    automationClass: classifyAutomation(project),
    rootExists,
    statePath,
    stateExists,
    stateMtime,
    contextPackExists,
    contextPackHasLocatorBoundary,
    authority,
    artifacts,
    issues,
    safeFixes,
    approvalRequired: project.approval_required,
    humanOnly: project.human_only,
    nextAction: nextActionFor(status, project)
  };
}

function classifyAutomation(project: ProjectRegistryProject): ProjectAutomationClass {
  if (project.human_only.length > 0 && project.allowed_automation.every((item) => item !== "safe_auto_fix")) return "human_only";
  if (project.approval_required.length > 0 && project.allowed_automation.every((item) => item !== "safe_auto_fix")) return "approval_required_fix";
  return "safe_auto_fix";
}

function suggestSafeFixes(
  project: ProjectRegistryProject,
  state: { stateExists: boolean; contextPackExists: boolean; contextPackHasLocatorBoundary: boolean }
): string[] {
  const fixes: string[] = [];
  if (!state.stateExists) fixes.push("state_template_scaffold");
  if (project.obsidian && !state.contextPackExists) fixes.push("obsidian_export");
  if (project.obsidian && state.contextPackExists && !state.contextPackHasLocatorBoundary) fixes.push("generated_markdown_refresh");
  fixes.push("link_existence_audit");
  return fixes;
}

function nextActionFor(status: ProjectHealthStatus, project: ProjectRegistryProject): string {
  if (status === "blocked") return `Create or repair the project-owned STATE.md / authority files before using ${project.label} as an execution target.`;
  if (status === "attention") return `Fresh-read ${project.label} source-of-truth files and update stale or missing locator proof before execution.`;
  return `Read ${project.label} STATE.md and latest proof before any project action; generated Obsidian pages remain locators.`;
}

function resolveContextPack(project: ProjectRegistryProject, obsidianVaultPath?: string): string | null {
  if (project.context_pack) return project.context_pack;
  if (!obsidianVaultPath) return null;
  return join(obsidianVaultPath, "05_Projects", "Generated Context Packs", `${project.id}.md`);
}

function hasLocatorBoundary(path: string): boolean {
  const text = readFileSync(path, "utf8");
  return /generated locator, not execution proof/i.test(text) && /Fresh-read boundary/i.test(text);
}

function mtimeIso(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

function hoursSince(iso: string): number {
  return Math.max(0, (Date.now() - Date.parse(iso)) / 36e5);
}

function newestEntry(root: string, depth: number): { path: string; mtime: string; mtimeMs: number } | null {
  if (!existsSync(root)) return null;
  const found: Array<{ path: string; mtime: string; mtimeMs: number }> = [];
  function walk(dir: string, remainingDepth: number): void {
    if (remainingDepth < 0) return;
    let entries: DirectoryEntry[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.slice(0, 250)) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".backups") continue;
      const path = join(dir, entry.name);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      found.push({ path, mtime: stats.mtime.toISOString(), mtimeMs: stats.mtimeMs });
      if (entry.isDirectory()) walk(path, remainingDepth - 1);
    }
  }
  walk(root, depth);
  found.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return found[0] ?? null;
}

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditProjects, loadProjectRegistry, registerProject, renderProjectStateTemplate, writeProjectAuditStatus } from "../projects/projectAuditor.js";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-project-auditor-"));

test("Project Auditor separates healthy projects, safe fixes, and approval boundaries", () => {
  const projectRoot = join(tempRoot, "project");
  const vaultRoot = join(tempRoot, "vault");
  const contextPack = join(vaultRoot, "05_Projects", "Generated Context Packs", "project.md");
  mkdirSync(join(projectRoot, "artifacts"), { recursive: true });
  mkdirSync(join(vaultRoot, "05_Projects", "Generated Context Packs"), { recursive: true });
  writeFileSync(join(projectRoot, "STATE.md"), "current_state: ok\nnext_action: read proof\n");
  writeFileSync(join(projectRoot, "AGENTS.md"), "# Agents\n");
  writeFileSync(join(projectRoot, "artifacts", "proof.json"), "{}\n");
  writeFileSync(contextPack, "generated locator, not execution proof\n\nFresh-read boundary: read STATE.md first.\n");
  const registryPath = join(tempRoot, "registry.json");
  writeFileSync(
    registryPath,
    JSON.stringify(
      {
        schema_version: 1,
        updated_at: "2026-06-23",
        policy: {
          default_surface: "read_first_locator_only",
          safe_auto_fix: ["obsidian_export"],
          approval_required_fix: ["external_api_write"],
          human_only: ["billing"]
        },
        projects: [
          {
            id: "project",
            label: "Project",
            root: projectRoot,
            owner_layer: "project_workspace",
            obsidian: true,
            authority_files: ["STATE.md", "AGENTS.md"],
            artifact_roots: ["artifacts"],
            source_of_truth: [join(projectRoot, "STATE.md")],
            related_projects: [],
            allowed_automation: ["safe_auto_fix", "read_only_audit"],
            approval_required: ["external_api_write"],
            human_only: ["billing"],
            context_pack: contextPack
          }
        ]
      },
      null,
      2
    )
  );

  const result = auditProjects({ registryPath, obsidianVaultPath: vaultRoot, generatedAt: "2026-06-23T00:00:00.000Z" });

  assert.equal(result.ok, true);
  assert.equal(result.summary.projects, 1);
  assert.equal(result.summary.ok, 1);
  assert.equal(result.projects[0].status, "ok");
  assert.equal(result.projects[0].contextPackHasLocatorBoundary, true);
  assert.deepEqual(result.projects[0].approvalRequired, ["external_api_write"]);
  assert.deepEqual(result.projects[0].humanOnly, ["billing"]);
});

test("Project Auditor blocks registry entries without STATE.md", () => {
  const projectRoot = join(tempRoot, "missing-state-project");
  mkdirSync(projectRoot, { recursive: true });
  const registryPath = join(tempRoot, "missing-state-registry.json");
  writeFileSync(
    registryPath,
    JSON.stringify(
      {
        schema_version: 1,
        updated_at: "2026-06-23",
        policy: {
          default_surface: "read_first_locator_only",
          safe_auto_fix: ["state_template_scaffold"],
          approval_required_fix: [],
          human_only: ["billing"]
        },
        projects: [
          {
            id: "missing-state",
            label: "Missing State",
            root: projectRoot,
            owner_layer: "project_workspace",
            obsidian: true,
            authority_files: ["STATE.md"],
            artifact_roots: [],
            source_of_truth: [join(projectRoot, "STATE.md")],
            related_projects: [],
            allowed_automation: ["safe_auto_fix"],
            approval_required: ["external_api_write"],
            human_only: ["billing"]
          }
        ]
      },
      null,
      2
    )
  );

  const result = auditProjects({ registryPath });
  const statusFile = writeProjectAuditStatus(result, join(tempRoot, "status", "project-audit-status.json"));

  assert.equal(result.ok, false);
  assert.equal(result.summary.blocked, 1);
  assert.ok(result.projects[0].issues.some((issue) => issue.code === "state_missing"));
  assert.ok(result.projects[0].safeFixes.includes("state_template_scaffold"));
  assert.equal(existsSync(statusFile), true);
  assert.equal(JSON.parse(readFileSync(statusFile, "utf8")).summary.blocked, 1);
});

test("Project Auditor falls back to the source default registry when runtime data registry is absent", () => {
  const previousCwd = process.cwd();
  const emptyRoot = join(tempRoot, "fresh-checkout-without-data-registry");
  mkdirSync(emptyRoot, { recursive: true });
  try {
    process.chdir(emptyRoot);
    const registry = loadProjectRegistry();
    const audit = auditProjects({ generatedAt: "2026-07-15T00:00:00.000Z" });
    assert.ok(registry.projects.length > 0);
    assert.equal(registry.projects.some((project) => project.id === "automation-os"), true);
    assert.equal(audit.summary.projects, registry.projects.length);
    assert.equal(audit.registryPath, join(process.cwd(), "data", "project-registry.json"));
  } finally {
    process.chdir(previousCwd);
  }
});

test("Project Auditor still fails explicit missing registry paths", () => {
  assert.throws(
    () => loadProjectRegistry(join(tempRoot, "missing-explicit-registry.json")),
    /ENOENT/
  );
});

test("registerProject dry-run returns STATE template and does not write files", () => {
  const projectRoot = join(tempRoot, "dry-run-project");
  const registryPath = createRegistry("dry-run-registry.json");
  const result = registerProject({
    id: "dry-run-project",
    label: "Dry Run Project",
    root: projectRoot,
    registryPath,
    generatedAt: "2026-06-23T00:00:00.000Z"
  });
  const template = renderProjectStateTemplate(result.entry, "2026-06-23T00:00:00.000Z");

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.registryUpdated, false);
  assert.equal(result.stateCreated, false);
  assert.equal(existsSync(projectRoot), false);
  assert.match(template, /current_state: New project registered/);
  assert.match(template, /Approval required:/);
});

test("registerProject write creates STATE.md and registry entry", () => {
  const projectRoot = join(tempRoot, "write-project");
  const registryPath = createRegistry("write-registry.json");
  const result = registerProject({
    id: "write-project",
    label: "Write Project",
    root: projectRoot,
    registryPath,
    relatedProjects: ["automation-os"],
    artifactRoots: ["artifacts", "proof"],
    write: true,
    generatedAt: "2026-06-23T00:00:00.000Z"
  });
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { projects: Array<{ id: string; artifact_roots: string[] }> };
  const state = readFileSync(join(projectRoot, "STATE.md"), "utf8");

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, false);
  assert.equal(result.registryUpdated, true);
  assert.equal(result.stateCreated, true);
  assert.ok(registry.projects.some((project) => project.id === "write-project"));
  assert.deepEqual(registry.projects.find((project) => project.id === "write-project")?.artifact_roots, ["artifacts", "proof"]);
  assert.match(state, /# Write Project Current State/);
  assert.match(state, /blocker: initial_state_needs_project_owner_update/);
});

test("registerProject refuses duplicate ids unless update is explicit", () => {
  const projectRoot = join(tempRoot, "duplicate-project");
  const registryPath = createRegistry("duplicate-registry.json");
  registerProject({ id: "duplicate-project", label: "Duplicate Project", root: projectRoot, registryPath, write: true });

  const duplicate = registerProject({ id: "duplicate-project", label: "Duplicate Project 2", root: projectRoot, registryPath, write: true });
  const updated = registerProject({ id: "duplicate-project", label: "Duplicate Project 2", root: projectRoot, registryPath, write: true, update: true });

  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error, "Project id already exists: duplicate-project");
  assert.equal(updated.ok, true);
  assert.equal(updated.existingProject, true);
});

function createRegistry(name: string): string {
  const registryPath = join(tempRoot, name);
  writeFileSync(
    registryPath,
    JSON.stringify(
      {
        schema_version: 1,
        updated_at: "2026-06-23",
        policy: {
          default_surface: "read_first_locator_only",
          safe_auto_fix: ["state_template_scaffold", "obsidian_export"],
          approval_required_fix: ["external_api_write"],
          human_only: ["billing"]
        },
        projects: []
      },
      null,
      2
    )
  );
  return registryPath;
}

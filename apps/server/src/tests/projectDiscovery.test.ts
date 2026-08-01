import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { auditProjects } from "../projects/projectAuditor.js";
import { discoverProjectCandidates, syncDiscoveredProjects } from "../projects/projectDiscovery.js";

test("Project discovery requires durable markers and skips generated dependency trees", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-os-project-discovery-"));
  const durable = join(root, "durable");
  const designOnly = join(root, "design-only");
  const dependency = join(root, "node_modules", "noise");
  mkdirSync(durable, { recursive: true });
  mkdirSync(designOnly, { recursive: true });
  mkdirSync(dependency, { recursive: true });
  writeFileSync(join(durable, "STATE.md"), "# Durable Current State\ncurrent_state: active\n");
  writeFileSync(join(durable, "AGENTS.md"), "# Agents\n");
  writeFileSync(join(designOnly, "PROJECT_DESIGN.md"), "# Design Only Project Design\n");
  writeFileSync(join(designOnly, "GOAL.md"), "# Goal\n");
  writeFileSync(join(dependency, "STATE.md"), "# Noise State\n");

  const result = discoverProjectCandidates({ roots: [{ path: root, maxDepth: 4 }] });
  assert.deepEqual(result.candidates.map((candidate) => candidate.root).sort(), [realpathSync(designOnly), realpathSync(durable)].sort());
  assert.equal(result.candidates.some((candidate) => candidate.root.includes("node_modules")), false);
});

test("Project discovery writes new projects as locator-only candidates", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-os-project-sync-"));
  const project = join(root, "future-project");
  const vault = join(root, "vault");
  mkdirSync(project, { recursive: true });
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(project, "STATE.md"), "# Future Project Current State\ncurrent_state: active\n");
  writeFileSync(join(project, "PROJECT_DESIGN.md"), "# Future Project Design\n");
  const registryPath = join(root, "registry.json");
  writeFileSync(registryPath, JSON.stringify(emptyRegistry(), null, 2));

  const preview = syncDiscoveredProjects({ roots: [{ path: root, maxDepth: 2 }], registryPath, vaultPath: vault });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.registered.length, 1);
  assert.equal(JSON.parse(readFileSync(registryPath, "utf8")).projects.length, 0);

  const applied = syncDiscoveredProjects({ roots: [{ path: root, maxDepth: 2 }], registryPath, vaultPath: vault, write: true });
  assert.equal(applied.registered.length, 1);
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { projects: Array<{ owner_layer: string; context_pack: string }> };
  assert.equal(registry.projects[0].owner_layer, "locator_only_candidate");
  assert.match(registry.projects[0].context_pack, /Generated Context Packs/);
  assert.equal(existsSync(join(project, "STATE.md")), true);

  const audit = auditProjects({ registryPath, obsidianVaultPath: vault });
  assert.equal(audit.projects[0].status, "attention");
  assert.ok(audit.projects[0].issues.some((issue) => issue.code === "auto_discovered_locator_requires_registration_review"));
});

test("Project discovery removes an automatic locator that duplicates a registered root", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-os-project-dedupe-"));
  const project = join(root, "registered-project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "STATE.md"), "# Registered Project Current State\n");
  const registryPath = join(root, "registry.json");
  const base = emptyRegistry();
  writeFileSync(
    registryPath,
    JSON.stringify(
      {
        ...base,
        projects: [
          registryProject("registered", project, "project_workspace"),
          {
            ...registryProject("auto-duplicate", project, "locator_only_candidate"),
            discovery: { mode: "automatic", status: "locator_only_candidate", markers: ["STATE.md"] }
          }
        ]
      },
      null,
      2
    )
  );

  const result = syncDiscoveredProjects({ roots: [{ path: root, maxDepth: 2 }], registryPath, write: true });

  assert.deepEqual(result.removedDuplicateLocators, ["auto-duplicate"]);
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { projects: Array<{ id: string }> };
  assert.deepEqual(registry.projects.map((entry) => entry.id), ["registered"]);
});

test("Project audit warns on old STATE only when newer project-owned files exist", () => {
  const root = mkdtempSync(join(tmpdir(), "automation-os-project-audit-freshness-"));
  const project = join(root, "project");
  const artifacts = join(project, "artifacts");
  const outside = join(root, "outside-proof.json");
  const outsideArtifacts = join(root, "outside-artifacts");
  mkdirSync(artifacts, { recursive: true });
  mkdirSync(outsideArtifacts, { recursive: true });
  const statePath = join(project, "STATE.md");
  const generatedStatusPath = join(artifacts, "obsidian-export-status.json");
  writeFileSync(statePath, "# Current State\n");
  writeFileSync(generatedStatusPath, "{}\n");
  writeFileSync(outside, "{\"outside\":true}\n");
  writeFileSync(join(outsideArtifacts, "outside-run.json"), "{\"outside\":true}\n");
  symlinkSync(outside, join(artifacts, "outside-link.json"));
  const oldMtime = new Date(Date.now() - 96 * 60 * 60 * 1000);
  utimesSync(statePath, oldMtime, oldMtime);

  const registryPath = join(root, "registry.json");
  const entry = {
    ...registryProject("freshness", project, "project_workspace"),
    obsidian: false,
    artifact_roots: ["artifacts", "../outside-artifacts"]
  };
  writeFileSync(registryPath, JSON.stringify({ ...emptyRegistry(), projects: [entry] }, null, 2));

  const inactive = auditProjects({ registryPath });
  assert.equal(inactive.projects[0].status, "ok");
  assert.ok(inactive.projects[0].issues.some((issue) => issue.code === "state_aged_without_newer_project_activity"));
  assert.equal(inactive.projects[0].issues.some((issue) => issue.code === "state_stale"), false);
  assert.equal(inactive.projects[0].artifacts[0].latest, null);
  assert.deepEqual(inactive.projects[0].artifacts[1], {
    path: outsideArtifacts,
    exists: false,
    latest: null,
    latestMtime: null
  });

  const actualArtifact = join(artifacts, "run-result.json");
  const generatedMarkdown = join(artifacts, "generated-status.md");
  writeFileSync(actualArtifact, "{\"ok\":true}\n");
  writeFileSync(generatedMarkdown, "---\ngenerated_by: automation-os\nkind: generated-status\n---\n");
  const actualMtime = new Date(Date.now() - 5 * 60 * 1000);
  const generatedMtime = new Date(Date.now() + 60 * 1000);
  utimesSync(actualArtifact, actualMtime, actualMtime);
  utimesSync(generatedStatusPath, generatedMtime, generatedMtime);
  utimesSync(generatedMarkdown, generatedMtime, generatedMtime);
  const active = auditProjects({ registryPath });
  assert.equal(active.projects[0].status, "attention");
  assert.ok(active.projects[0].issues.some((issue) => issue.code === "state_stale" && issue.message.includes(actualArtifact)));
  assert.equal(active.projects[0].artifacts[0].latest, realpathSync(actualArtifact));
});

function emptyRegistry() {
  return {
    schema_version: 1,
    updated_at: "2026-07-15",
    policy: {
      default_surface: "read_first_locator_only",
      safe_auto_fix: ["obsidian_export"],
      approval_required_fix: ["external_api_write"],
      human_only: ["billing"]
    },
    projects: []
  };
}

function registryProject(id: string, root: string, ownerLayer: string) {
  return {
    id,
    label: id,
    root,
    owner_layer: ownerLayer,
    obsidian: true,
    authority_files: ["STATE.md"],
    artifact_roots: ["artifacts"],
    source_of_truth: [join(root, "STATE.md")],
    related_projects: ["automation-os"],
    allowed_automation: ["read_only_audit"],
    approval_required: ["external_api_write"],
    human_only: ["billing"]
  };
}

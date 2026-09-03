import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const collector = path.join(__dirname, "..", "project-handoff-collector.mjs");
const fixtureRoot = process.env.PROJECT_HANDOFF_TEST_TMPDIR || path.join(__dirname, "..", ".test-tmp");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function makeFixture() {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(fixtureRoot, "project-handoff-collector."));
  const home = path.join(root, "home");
  const codexHome = path.join(root, "codex-home");
  const vault = path.join(root, "Obsidian Vault");
  const notes = path.join(root, "notes");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  return { root, home, codexHome, vault, notes };
}

function cleanupFixture(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

function runCollector(fixture, extraEnv = {}) {
  const stdout = execFileSync(process.execPath, [collector], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      HOME: fixture.home,
      CODEX_HOME: fixture.codexHome,
      PROJECT_HANDOFF_OBSIDIAN_VAULT: fixture.vault,
      PROJECT_HANDOFF_NOTES_DIR: fixture.notes,
      PROJECT_HANDOFF_SCAN_MAX_DEPTH: "6",
      PROJECT_HANDOFF_SCAN_MAX_DIRS: "500",
      PROJECT_HANDOFF_MAX_DISCOVERED_PROJECTS: "40",
      PROJECT_HANDOFF_MAX_PROJECTS: "80",
      PROJECT_HANDOFF_ENABLE_DISCOVERY: "1",
      ...extraEnv
    },
    encoding: "utf8"
  });
  return JSON.parse(stdout);
}

function runCollectorRaw(fixture, extraEnv = {}) {
  const child = spawnSync(process.execPath, [collector], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      HOME: fixture.home,
      CODEX_HOME: fixture.codexHome,
      PROJECT_HANDOFF_OBSIDIAN_VAULT: fixture.vault,
      PROJECT_HANDOFF_NOTES_DIR: fixture.notes,
      PROJECT_HANDOFF_SCAN_MAX_DEPTH: "6",
      PROJECT_HANDOFF_SCAN_MAX_DIRS: "500",
      PROJECT_HANDOFF_MAX_DISCOVERED_PROJECTS: "40",
      PROJECT_HANDOFF_MAX_PROJECTS: "80",
      PROJECT_HANDOFF_ENABLE_DISCOVERY: "1",
      ...extraEnv
    },
    encoding: "utf8"
  });
  return {
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    json: child.stdout ? JSON.parse(child.stdout) : null
  };
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

function touchOld(file, hoursAgo) {
  const date = new Date(Date.now() - hoursAgo * 36e5);
  fs.utimesSync(file, date, date);
}

test("discovers bounded project candidates and excludes heavy directories", (t) => {
  const fixture = makeFixture();
  t.after(() => cleanupFixture(fixture));
  write(path.join(fixture.home, "Documents", "New project", "STATE.md"), "seed state\n");
  write(path.join(fixture.home, "Documents", "Dynamic Tool", "STATE.md"), "current_state: ready\n");
  write(path.join(fixture.home, "Documents", "Dynamic Tool", "artifacts", "run.json"), "{}\n");
  write(path.join(fixture.home, "Documents", "Dynamic Tool", "node_modules", "Hidden", "STATE.md"), "hidden\n");
  write(path.join(fixture.home, "Documents", "Dynamic Tool", "codex-tmp", "Hidden Tmp", "STATE.md"), "hidden tmp\n");
  write(path.join(fixture.home, "Documents", "Dynamic Tool", ".codex-tmp-home", "skills", "Hidden Skill", "SKILL.md"), "hidden skill\n");
  write(path.join(fixture.home, "Documents", "Cafe", "STATE.md"), "current_state: ready\n");
  write(path.join(fixture.home, "Documents", "Café", "STATE.md"), "current_state: ready\n");
  write(path.join(fixture.home, "Desktop", "アパレル１", "heavy-chain", "STATE.md"), "ready\n");
  write(path.join(fixture.home, "Desktop", "アパレル１", "アパレルAI", "automation.toml"), "[automation]\n");
  write(path.join(fixture.home, "Desktop", "アパレル１", "アパレルAI", "STATE.md"), "current_state: ready\n");
  write(path.join(fixture.codexHome, "automations", "Nightly Check", "current-run-contract.md"), "contract\n");
  write(path.join(fixture.home, ".agents", "skills", "custom-skill", "SKILL.md"), "# Skill\n");

  const result = runCollector(fixture);
  const ids = result.projects.map((project) => project.id);
  const labels = result.projects.map((project) => project.id === "new-project" ? "Daily AI / Job automations" : null);
  const index = fs.readFileSync(path.join(fixture.vault, "00_Start Here", "Project Handoff Index.md"), "utf8");

  assert.equal(result.ok, true);
  assert.equal(ids.filter((id) => id === "new-project").length, 1);
  assert.equal(labels.includes("Daily AI / Job automations"), true);
  assert.equal(ids.some((id) => id.includes("dynamic-tool")), true);
  assert.equal(ids.some((id) => id.includes("hidden")), false);
  assert.equal(ids.some((id) => id.includes("hidden-tmp")), false);
  assert.equal(ids.some((id) => id.includes("hidden-skill")), false);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.includes("documents-cafe"), true);
  assert.equal(ids.some((id) => /^documents-cafe-[a-f0-9]{8}$/.test(id)), true);
  assert.match(index, /## Apparel Heavy Chain/);
  assert.match(index, /## アパレルAI/);
  assert.match(index, /Nightly Check/);
  assert.match(index, /custom-skill/);
  assert.match(index, /Latest artifact pointer: `artifacts\/run.json`/);
});

test("generates context packs, index links, action candidates, and locators", (t) => {
  const fixture = makeFixture();
  t.after(() => cleanupFixture(fixture));
  write(
    path.join(fixture.home, "Documents", "Context Project", "STATE.md"),
    [
      "# State",
      "current_state: Ready for QA",
      "next_action: Run browser proof",
      "blocker: none",
      "blocked: ``",
      "risk_gate: submit requires human approval",
      "execution_precheck: confirm Profile 2 browser lane before run",
      "evidence: artifacts/proof.json",
      "latest_artifact: artifacts/latest-run.json",
      "stop_condition: stop if auth is missing",
      "weekly_review: check stale locator pointers",
      "unfinished_detection: browser proof still pending",
      "maturity_candidate: pilot",
      "proof_locator: artifacts/proof.json",
      "decision_locator: docs/decisions/001.md",
      "runbook_locator: docs/runbooks/resume.md",
      "This generic sentence should not be inferred.",
      "Stop if a normal sentence mentions auth without a key value."
    ].join("\n")
  );
  write(path.join(fixture.home, "Documents", "Context Project", "artifacts", "proof.json"), "{}\n");
  write(path.join(fixture.home, "Documents", "Context Project", "artifacts", "readback.json"), "{}\n");

  const result = runCollector(fixture);
  const project = result.contextPacks.find((entry) => entry.id === "documents-context-project");
  assert.ok(project);
  assert.equal(project.maturityCandidate, "pilot");
  assert.deepEqual(project.currentState, ["Ready for QA"]);
  assert.deepEqual(project.nextActions, ["Run browser proof"]);
  assert.deepEqual(project.blockers, []);
  assert.deepEqual(project.riskGates, ["submit requires human approval"]);
  assert.deepEqual(project.operationSignals.executionPrecheck, ["submit requires human approval", "confirm Profile 2 browser lane before run"]);
  assert.deepEqual(project.operationSignals.evidence, ["artifacts/proof.json"]);
  assert.deepEqual(project.latestArtifactPointers, ["artifacts/latest-run.json"]);
  assert.deepEqual(project.operationSignals.stopConditions, ["stop if auth is missing"]);
  assert.deepEqual(project.operationSignals.weeklyReview, ["check stale locator pointers"]);
  assert.deepEqual(project.operationSignals.unfinishedDetection, ["Run browser proof", "browser proof still pending"]);
  assert.equal(project.freshness.readback.status, "fresh");
  assert.match(project.freshness.readback.relative, /readback\.json$/);
  assert.match(project.candidateGoal, /^Goal: Run browser proof/);
  assert.deepEqual(project.browserUseProofGate.missing, ["recording", "gemini", "noResidualProcess"]);

  const contextPack = read(path.join(fixture.vault, "05_Projects", "Generated Context Packs", "documents-context-project.md"));
  const index = read(path.join(fixture.vault, "00_Start Here", "Project Handoff Index.md"));
  const actionQueue = read(path.join(fixture.vault, "10_Dashboards", "Generated Action Queue Candidates.md"));
  const inbox = read(path.join(fixture.vault, "09_Inbox", "Generated Project Handoff Inbox.md"));
  const proofLocators = read(path.join(fixture.vault, "04_Proof Pointers", "Generated Proof Locators.md"));
  const decisionLocators = read(path.join(fixture.vault, "07_Decisions", "Generated Decision Locators.md"));
  const runbookLocators = read(path.join(fixture.vault, "08_Runbooks", "Generated Runbook Locators.md"));
  const weeklyReview = read(path.join(fixture.vault, "10_Dashboards", "Generated Weekly Project Review.md"));
  const cleanupCandidates = read(path.join(fixture.vault, "10_Dashboards", "Generated Notes Cleanup Candidates.md"));
  const projectTemplate = read(path.join(fixture.vault, "05_Projects", "Generated Project Template.md"));
  const projectsReadme = read(path.join(fixture.vault, "05_Projects", "README.generated.md"));
  const researchReadme = read(path.join(fixture.vault, "06_Research", "README.generated.md"));
  const decisionsReadme = read(path.join(fixture.vault, "07_Decisions", "README.generated.md"));
  const runbooksReadme = read(path.join(fixture.vault, "08_Runbooks", "README.generated.md"));
  const inboxReadme = read(path.join(fixture.vault, "09_Inbox", "README.generated.md"));
  const dashboardsReadme = read(path.join(fixture.vault, "10_Dashboards", "README.generated.md"));

  for (const generated of [
    contextPack,
    index,
    actionQueue,
    inbox,
    proofLocators,
    decisionLocators,
    runbookLocators,
    weeklyReview,
    cleanupCandidates,
    projectTemplate,
    projectsReadme,
    researchReadme,
    decisionsReadme,
    runbooksReadme,
    inboxReadme,
    dashboardsReadme
  ]) {
    assert.match(generated, /generated_by: automation-os/);
    assert.match(generated, /generated locator, not execution proof/);
    assert.match(generated, /Fresh-read boundary:/);
  }
  assert.match(index, /\[\[05_Projects\/Generated Context Packs\/documents-context-project\|Context Pack\]\]/);
  assert.match(index, /Next action candidate: Run browser proof/);
  assert.match(index, /Auto-resume triggers:/);
  assert.match(index, /AutomationOSは何をやっていた/);
  assert.match(index, /<project>は何をやっていた/);
  assert.match(index, /every indexed project/);
  assert.match(index, /Session memory boundary:/);
  assert.match(index, /Obsidian autonomy memo: \[\[Obsidian Autonomy Ops Memo\]\]/);
  assert.match(index, /Maturity candidate: pilot/);
  assert.match(index, /Execution precheck: submit requires human approval/);
  assert.match(index, /Evidence locator: artifacts\/proof\.json \(locator\/pointer, not proof\)/);
  assert.match(index, /Stop condition: stop if auth is missing/);
  assert.match(index, /Weekly review signal: check stale locator pointers/);
  assert.match(index, /Unfinished detection: Run browser proof/);
  assert.match(contextPack, /## Current State\n- Ready for QA/);
  assert.match(contextPack, /## Operation Signals/);
  assert.match(contextPack, /Execution Precheck: confirm Profile 2 browser lane before run/);
  assert.match(contextPack, /Evidence locator: artifacts\/proof\.json \(locator\/pointer, not proof\)/);
  assert.doesNotMatch(contextPack, /Evidence locator: artifacts\/latest-run\.json/);
  assert.match(contextPack, /Stop Conditions: stop if auth is missing/);
  assert.match(contextPack, /Weekly Review: check stale locator pointers/);
  assert.match(contextPack, /Unfinished Detection: browser proof still pending/);
  assert.match(contextPack, /## Freshness Audit/);
  assert.match(contextPack, /STATE\/artifact=/);
  assert.match(contextPack, /24h stale ranking:/);
  assert.match(contextPack, /## Proof Gate Audit/);
  assert.match(contextPack, /Context Pack gate: read-first locator only; not proof/);
  assert.match(contextPack, /Readback artifact required: fresh \(artifacts\/readback\.json\)/);
  assert.match(contextPack, /No residual process proof required: missing/);
  assert.match(contextPack, /Browser Use missing: recording, gemini, noResidualProcess/);
  assert.match(contextPack, /Latest artifact: locator\/pointer only, not proof/);
  assert.match(contextPack, /## Missing Operation Signals Audit/);
  assert.match(contextPack, /Candidate Goal: Goal: Run browser proof/);
  assert.match(contextPack, /`latest_artifact`: latest=`artifacts\/latest-run\.json` mtime=explicit latest_artifact key \(locator\/pointer, not proof\)/);
  assert.doesNotMatch(contextPack, /generic sentence should not be inferred/);
  assert.doesNotMatch(contextPack, /normal sentence mentions auth/);
  assert.match(actionQueue, /Next action candidate: Run browser proof/);
  assert.match(actionQueue, /Execution precheck: submit requires human approval/);
  assert.match(actionQueue, /Evidence locator: artifacts\/proof\.json \(locator\/pointer, not proof\)/);
  assert.match(actionQueue, /Readback artifact: fresh \(artifacts\/readback\.json\)/);
  assert.match(actionQueue, /Browser Use missing proof: recording, gemini, noResidualProcess/);
  assert.match(actionQueue, /Candidate Goal: Goal: Run browser proof/);
  assert.match(actionQueue, /Stop condition: stop if auth is missing/);
  assert.match(actionQueue, /Unfinished detection: Run browser proof/);
  assert.match(inbox, /Current state: Ready for QA/);
  assert.match(inbox, /Missing operation signals: none/);
  assert.match(inbox, /Readback artifact: fresh/);
  assert.match(proofLocators, /Locator: artifacts\/proof\.json/);
  assert.doesNotMatch(proofLocators, /artifacts\/latest-run\.json/);
  assert.doesNotMatch(proofLocators, /Latest artifact pointer:/);
  assert.match(decisionLocators, /Locator: docs\/decisions\/001\.md/);
  assert.match(runbookLocators, /Locator: docs\/runbooks\/resume\.md/);
  assert.match(weeklyReview, /read-first locator/);
  assert.match(weeklyReview, /Weekly review signal: check stale locator pointers/);
  assert.match(weeklyReview, /Evidence locator: artifacts\/proof\.json \(locator\/pointer, not proof\)/);
  assert.match(weeklyReview, /Readback artifact required: fresh/);
  assert.match(weeklyReview, /Browser Use missing proof: recording, gemini, noResidualProcess/);
  assert.match(weeklyReview, /24h stale ranking:/);
  assert.match(projectTemplate, /Context Pack pattern: `05_Projects\/Generated Context Packs\/<project-id>\.md`/);
  assert.doesNotMatch(projectTemplate, /\[\[[^\]]*<project-id>/);
  assert.match(projectsReadme, /Goal\/Resume entry/);
  assert.equal(result.generatedFiles.some((entry) => entry.role === "context_pack" && entry.projectId === "documents-context-project" && entry.ok), true);
  assert.equal(result.generatedFiles.some((entry) => entry.role === "weekly_review" && entry.ok), true);
  assert.equal(result.generatedFiles.some((entry) => entry.role === "cleanup_candidates" && entry.ok), true);
  assert.equal(result.generatedFiles.some((entry) => entry.role === "project_template" && entry.ok), true);
  assert.equal(result.generatedFiles.some((entry) => entry.role === "projects_folder_readme" && entry.ok), true);
  assert.equal(result.readbackResults.every((entry) => entry.ok), true);
  assert.equal(result.readbackResults.some((entry) => entry.role === "context_pack" && entry.projectId === "documents-context-project"), true);
});

test("refuses to overwrite handwritten Obsidian index", (t) => {
  const fixture = makeFixture();
  t.after(() => cleanupFixture(fixture));
  const indexFile = path.join(fixture.vault, "00_Start Here", "Project Handoff Index.md");
  write(path.join(fixture.home, "Documents", "Dynamic Tool", "STATE.md"), "state\n");
  write(indexFile, "# Handwritten\n\nKeep this file.\n");

  const result = runCollector(fixture);
  const index = fs.readFileSync(indexFile, "utf8");

  assert.equal(result.ok, false);
  assert.equal(result.obsidianReason, "non_generated_target_exists");
  assert.equal(index, "# Handwritten\n\nKeep this file.\n");
});

test("uses generated context pack operation signals as input without sourcing handwritten packs", (t) => {
  const fixture = makeFixture();
  t.after(() => cleanupFixture(fixture));
  const contextPack = path.join(fixture.vault, "05_Projects", "Generated Context Packs", "documents-pack-source-project.md");
  write(path.join(fixture.home, "Documents", "Pack Source Project", "STATE.md"), "current_state: Ready\n");
  write(
    contextPack,
    [
      "---",
      "system: automation-os",
      "generated_by: automation-os",
      "kind: project_context_pack",
      "---",
      "",
      "generated locator, not execution proof",
      "",
      "Fresh-read boundary: before acting, read source files.",
      "",
      "current_state: Stale generated state",
      "next_action: Stale generated action",
      "execution_precheck: read STATE.md before run",
      "evidence: artifacts/readback.json",
      "proof_locator: artifacts/stale-proof.json",
      "stop_condition: stop on missing auth",
      "blocked: none explicit",
      "weekly_review: inspect stale pointers",
      "unfinished_detection: pending live proof",
      "A normal sentence with pending work is not a signal."
    ].join("\n")
  );

  const result = runCollector(fixture);
  const project = result.contextPacks.find((entry) => entry.id === "documents-pack-source-project");
  const rendered = read(contextPack);

  assert.deepEqual(project.operationSignals.executionPrecheck, ["read STATE.md before run"]);
  assert.deepEqual(project.operationSignals.evidence, ["artifacts/readback.json"]);
  assert.deepEqual(project.operationSignals.stopConditions, ["stop on missing auth"]);
  assert.deepEqual(project.operationSignals.weeklyReview, ["inspect stale pointers"]);
  assert.deepEqual(project.operationSignals.unfinishedDetection, ["pending live proof"]);
  assert.deepEqual(project.currentState, ["Ready"]);
  assert.deepEqual(project.nextActions, []);
  assert.match(rendered, /Execution Precheck: read STATE\.md before run/);
  assert.doesNotMatch(rendered, /Stale generated state|Stale generated action|stale-proof/);
  assert.doesNotMatch(rendered, /normal sentence with pending work/);
});

test("latest_artifact readback-looking path does not satisfy Browser Use readback proof gate", (t) => {
  const fixture = makeFixture();
  t.after(() => cleanupFixture(fixture));
  write(
    path.join(fixture.home, "Documents", "Latest Locator Project", "STATE.md"),
    [
      "current_state: Browser Use pending",
      "latest_artifact: artifacts/readback.json"
    ].join("\n")
  );

  const result = runCollector(fixture);
  const project = result.contextPacks.find((entry) => entry.id === "documents-latest-locator-project");
  const rendered = read(path.join(fixture.vault, "05_Projects", "Generated Context Packs", "documents-latest-locator-project.md"));

  assert.deepEqual(project.latestArtifactPointers, ["artifacts/readback.json"]);
  assert.equal(project.freshness.readback.status, "missing");
  assert.equal(project.browserUseProofGate.status, "missing_required_proof");
  assert.equal(project.browserUseProofGate.missing.includes("readback"), true);
  assert.match(rendered, /Readback artifact required: missing/);
  assert.match(rendered, /Browser Use missing: recording, gemini, readback, noResidualProcess/);
  assert.doesNotMatch(rendered, /Evidence locator: artifacts\/readback\.json/);
});

test("does not reverse-input non-context Obsidian generated surfaces or handwritten notes", (t) => {
  const fixture = makeFixture();
  t.after(() => cleanupFixture(fixture));
  write(path.join(fixture.home, "Documents", "Reverse Input Project", "STATE.md"), "current_state: Fresh STATE\n");
  write(
    path.join(fixture.vault, "10_Dashboards", "Generated Action Queue Candidates.md"),
    [
      "---",
      "system: automation-os",
      "generated_by: automation-os",
      "kind: action_queue_candidates",
      "---",
      "",
      "execution_precheck: stale action queue precheck",
      "unfinished_detection: stale action queue todo"
    ].join("\n")
  );
  write(
    path.join(fixture.vault, "10_Dashboards", "Generated Weekly Project Review.md"),
    [
      "---",
      "system: automation-os",
      "generated_by: automation-os",
      "kind: weekly_project_review",
      "---",
      "",
      "weekly_review: stale weekly review signal"
    ].join("\n")
  );
  write(
    path.join(fixture.vault, "04_Proof Pointers", "Generated Proof Locators.md"),
    [
      "---",
      "system: automation-os",
      "generated_by: automation-os",
      "kind: proof_locators",
      "---",
      "",
      "evidence: artifacts/stale-proof.json"
    ].join("\n")
  );
  write(path.join(fixture.vault, "09_Inbox", "Handwritten Project Note.md"), "next_action: stale handwritten action\n");

  const result = runCollector(fixture);
  const project = result.contextPacks.find((entry) => entry.id === "documents-reverse-input-project");
  const rendered = read(path.join(fixture.vault, "05_Projects", "Generated Context Packs", "documents-reverse-input-project.md"));

  assert.deepEqual(project.currentState, ["Fresh STATE"]);
  assert.deepEqual(project.operationSignals.executionPrecheck, []);
  assert.deepEqual(project.operationSignals.weeklyReview, []);
  assert.deepEqual(project.operationSignals.evidence, []);
  assert.deepEqual(project.operationSignals.unfinishedDetection, []);
  assert.doesNotMatch(rendered, /stale action queue|stale weekly|stale-proof|stale handwritten/);
});

test("reports 24h stale ranking and STATE artifact readback freshness differences", (t) => {
  const fixture = makeFixture();
  t.after(() => cleanupFixture(fixture));
  const state = path.join(fixture.home, "Documents", "Stale Project", "STATE.md");
  const readback = path.join(fixture.home, "Documents", "Stale Project", "artifacts", "readback.json");
  write(state, "current_state: stale state\n");
  write(readback, "{}\n");
  touchOld(state, 50);
  touchOld(readback, 30);

  const result = runCollector(fixture, { PROJECT_HANDOFF_STALE_HOURS: "24" });
  const project = result.contextPacks.find((entry) => entry.id === "documents-stale-project");
  const rendered = read(path.join(fixture.vault, "05_Projects", "Generated Context Packs", "documents-stale-project.md"));

  assert.equal(project.freshness.state.status, "stale");
  assert.equal(project.freshness.artifact.status, "stale");
  assert.equal(project.freshness.readback.status, "stale");
  assert.equal(project.freshness.staleRanking24h.length, 3);
  assert.match(project.freshness.staleRanking24h.join(","), /STATE:stale/);
  assert.equal(typeof project.freshness.differencesHours.state_vs_readback, "number");
  assert.match(rendered, /STATE: stale age=/);
  assert.match(rendered, /readback: stale age=/);
  assert.match(rendered, /Freshness deltas: STATE\/artifact=/);
  assert.match(rendered, /24h stale ranking: .*STATE:stale/);
});

test("refuses to overwrite handwritten generated context pack", (t) => {
  const fixture = makeFixture();
  t.after(() => cleanupFixture(fixture));
  const contextPack = path.join(fixture.vault, "05_Projects", "Generated Context Packs", "documents-guarded-project.md");
  write(path.join(fixture.home, "Documents", "Guarded Project", "STATE.md"), "next_action: continue\n");
  write(contextPack, "# Handwritten context\n\nKeep this file.\n");

  const result = runCollector(fixture);
  const preserved = read(contextPack);
  const generated = result.generatedFiles.find((entry) => entry.role === "context_pack" && entry.projectId === "documents-guarded-project");

  assert.equal(result.ok, false);
  assert.equal(generated.reason, "non_generated_target_exists");
  assert.equal(preserved, "# Handwritten context\n\nKeep this file.\n");
});

test("does not treat a handwritten heading as generated marker", (t) => {
  const fixture = makeFixture();
  t.after(() => cleanupFixture(fixture));
  const indexFile = path.join(fixture.vault, "00_Start Here", "Project Handoff Index.md");
  write(path.join(fixture.home, "Documents", "Heading Marker Project", "STATE.md"), "next_action: continue\n");
  write(indexFile, "# generated_by: automation-os\n\nHandwritten note that must survive.\n");

  const result = runCollector(fixture);
  const index = fs.readFileSync(indexFile, "utf8");

  assert.equal(result.ok, false);
  assert.equal(result.obsidianReason, "non_generated_target_exists");
  assert.equal(index, "# generated_by: automation-os\n\nHandwritten note that must survive.\n");
});

test("writes generated README files without overwriting handwritten README", (t) => {
  const fixture = makeFixture();
  t.after(() => cleanupFixture(fixture));
  const handwrittenReadme = path.join(fixture.vault, "05_Projects", "README.md");
  write(path.join(fixture.home, "Documents", "Readme Project", "STATE.md"), "next_action: continue\n");
  write(handwrittenReadme, "# Human README\n\nKeep this handwritten folder guide.\n");

  const result = runCollector(fixture);
  const preserved = read(handwrittenReadme);
  const generated = read(path.join(fixture.vault, "05_Projects", "README.generated.md"));

  assert.equal(result.ok, true);
  assert.equal(preserved, "# Human README\n\nKeep this handwritten folder guide.\n");
  assert.match(generated, /generated_by: automation-os/);
  assert.match(generated, /05_Projects Folder Role/);
  assert.match(generated, /not execution proof/);
});

test("cleanup candidates are listed without deleting or moving files", (t) => {
  const fixture = makeFixture();
  t.after(() => cleanupFixture(fixture));
  const suspicious = path.join(fixture.vault, "10_Dashboards", "Generated Old Surface.md");
  write(path.join(fixture.home, "Documents", "Cleanup Project", "STATE.md"), "next_action: continue\n");
  write(suspicious, "# Generated Old Surface\n\nGenerated-looking handwritten file without frontmatter.\n");

  const result = runCollector(fixture);
  const cleanup = read(path.join(fixture.vault, "10_Dashboards", "Generated Notes Cleanup Candidates.md"));

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(suspicious), true);
  assert.equal(read(suspicious), "# Generated Old Surface\n\nGenerated-looking handwritten file without frontmatter.\n");
  assert.match(cleanup, /Manual review candidate: `10_Dashboards\/Generated Old Surface\.md`/);
  assert.match(cleanup, /generated_name_missing_frontmatter_marker/);
  assert.doesNotMatch(cleanup, /deleted|moved/i);
});

test("strict mode exits nonzero when a handwritten generated target blocks write and readback", (t) => {
  const fixture = makeFixture();
  t.after(() => cleanupFixture(fixture));
  const weekly = path.join(fixture.vault, "10_Dashboards", "Generated Weekly Project Review.md");
  write(path.join(fixture.home, "Documents", "Strict Project", "STATE.md"), "next_action: continue\n");
  write(weekly, "# Handwritten weekly review\n\nDo not overwrite.\n");

  const result = runCollectorRaw(fixture, { PROJECT_HANDOFF_STRICT: "1" });
  const blocked = result.json.generatedFiles.find((entry) => entry.role === "weekly_review");
  const readback = result.json.readbackResults.find((entry) => entry.role === "weekly_review");

  assert.equal(result.status, 1);
  assert.equal(result.json.ok, false);
  assert.equal(blocked.reason, "non_generated_target_exists");
  assert.equal(readback.reason, "non_generated_target_exists");
  assert.equal(read(weekly), "# Handwritten weekly review\n\nDo not overwrite.\n");
});

test("immediately reclaims a Vault lock owned by a dead process", (t) => {
  const fixture = makeFixture();
  t.after(() => cleanupFixture(fixture));
  const lockPath = path.join(fixture.root, "vault-write.lock");
  write(path.join(fixture.home, "Documents", "Dead Lock Project", "STATE.md"), "next_action: continue\n");
  write(lockPath, `${JSON.stringify({ pid: 999_999_999, owner: "dead-writer", acquiredAt: new Date().toISOString() })}\n`);

  const result = runCollector(fixture, { AUTOMATION_OS_OBSIDIAN_WRITE_LOCK: lockPath });

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(lockPath), false);
});

test("keeps a Vault lock owned by a live process closed", (t) => {
  const fixture = makeFixture();
  t.after(() => cleanupFixture(fixture));
  const lockPath = path.join(fixture.root, "vault-write.lock");
  write(lockPath, `${JSON.stringify({ pid: process.pid, owner: "live-writer", acquiredAt: new Date().toISOString() })}\n`);

  const result = runCollectorRaw(fixture, { AUTOMATION_OS_OBSIDIAN_WRITE_LOCK: lockPath });

  assert.equal(result.status, 1);
  assert.equal(result.json.exactBlocker, "obsidian_vault_write_locked");
  assert.equal(fs.existsSync(lockPath), true);
});

test("redacts secrets from generated handoff files", (t) => {
  const fixture = makeFixture();
  t.after(() => cleanupFixture(fixture));
  write(
    path.join(fixture.home, "Documents", "Secret Project", "STATE.md"),
    [
      "# State",
      "token=sk-1234567890abcdefghijklmnop",
      "email: user@example.com",
      "url: https://example.com/private?token=secret",
      "blob: abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqr"
    ].join("\n")
  );

  runCollector(fixture);
  const index = fs.readFileSync(path.join(fixture.vault, "00_Start Here", "Project Handoff Index.md"), "utf8");
  const contextPack = read(path.join(fixture.vault, "05_Projects", "Generated Context Packs", "documents-secret-project.md"));
  const noteFile = fs.readdirSync(fixture.notes).find((name) => name.endsWith("-project-handoffs-auto.md"));
  const note = fs.readFileSync(path.join(fixture.notes, noteFile), "utf8");

  assert.doesNotMatch(index, /sk-1234567890/);
  assert.doesNotMatch(index, /user@example\.com/);
  assert.doesNotMatch(index, /https:\/\/example\.com/);
  assert.doesNotMatch(note, /sk-1234567890/);
  assert.doesNotMatch(contextPack, /sk-1234567890/);
  assert.doesNotMatch(contextPack, /user@example\.com/);
  assert.doesNotMatch(contextPack, /https:\/\/example\.com/);
  assert.match(index, /\[redacted_email\]/);
  assert.match(index, /\[redacted_url\]/);
  assert.match(note, /\[redacted_high_entropy\]/);
  assert.match(contextPack, /\[redacted_email\]/);
  assert.match(contextPack, /\[redacted_url\]/);
});

test("uses deterministic maturity fallback when no explicit maturity exists", (t) => {
  const fixture = makeFixture();
  t.after(() => cleanupFixture(fixture));
  write(path.join(fixture.home, "Documents", "Fallback Project", "STATE.md"), "current_state: no maturity line\n");

  const result = runCollector(fixture);
  const pack = result.contextPacks.find((entry) => entry.id === "documents-fallback-project");
  const contextPack = read(path.join(fixture.vault, "05_Projects", "Generated Context Packs", "documents-fallback-project.md"));

  assert.equal(pack.maturityCandidate, "fresh_read_required");
  assert.match(contextPack, /Maturity candidate: fresh_read_required/);
});

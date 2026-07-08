import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseAutomationToml, runAutomationHealth } from "../automationHealth.js";

function tempFixture() {
  const root = mkdtempSync(join(tmpdir(), "automation-health-"));
  const automationRoot = join(root, "automations");
  const cwd = join(root, "project");
  const dbPath = join(root, "codex-dev.db");
  const outputRoot = join(root, "reports");
  mkdirSync(automationRoot, { recursive: true });
  mkdirSync(join(cwd, "scripts"), { recursive: true });
  mkdirSync(join(cwd, "artifacts"), { recursive: true });
  writeFileSync(join(cwd, "scripts", "run_demo.mjs"), "console.log('demo');\n");
  writeFileSync(join(cwd, "AGENTS.md"), "# Agents\n");
  writeFileSync(join(cwd, "STATE.md"), "# State\n");
  writeFileSync(join(cwd, "artifact.json"), "{}\n");
  writeFileSync(join(cwd, "artifacts", "latest.json"), "{}\n");
  return { root, automationRoot, cwd, dbPath, outputRoot };
}

function toml(input: {
  id: string;
  cwd: string;
  prompt?: string;
  status?: string;
  rrule?: string;
  model?: string;
  reasoningEffort?: string;
}): string {
  const prompt =
    input.prompt ??
    `Run node scripts/run_demo.mjs. First read AGENTS.md, STATE.md, and automation memory. Browser QA gate: no-post-preflight recommendation_status=pass anomaly_detected=false completion veto.`;
  return [
    'version = 1',
    `id = "${input.id}"`,
    'kind = "cron"',
    `name = "${input.id}"`,
    `prompt = ${JSON.stringify(prompt)}`,
    `status = "${input.status ?? "ACTIVE"}"`,
    `rrule = "${input.rrule ?? "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0"}"`,
    `model = "${input.model ?? ""}"`,
    `reasoning_effort = "${input.reasoningEffort ?? ""}"`,
    `cwds = [${JSON.stringify(input.cwd)}]`
  ].join("\n");
}

function writeAutomation(automationRoot: string, id: string, body: string): string {
  const dir = join(automationRoot, id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "automation.toml");
  writeFileSync(path, `${body}\n`);
  writeFileSync(join(dir, "memory.md"), "# Memory\n");
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  writeFileSync(join(dir, "artifacts", "automation-latest.json"), "{}\n");
  return path;
}

function createDb(
  dbPath: string,
  rows: Array<{
    id: string;
    name?: string;
    prompt: string;
    status: string;
    rrule: string;
    model?: string;
    reasoningEffort?: string;
    cwds: string[];
  }>
) {
  const sql = [
    "CREATE TABLE automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, next_run_at INTEGER, last_run_at INTEGER, cwds TEXT NOT NULL, rrule TEXT NOT NULL, model TEXT, reasoning_effort TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);",
    ...rows.map(
      (row) =>
        `INSERT INTO automations (id,name,prompt,status,cwds,rrule,model,reasoning_effort,created_at,updated_at) VALUES (${sqlString(row.id)},${sqlString(row.name ?? row.id)},${sqlString(row.prompt)},${sqlString(row.status)},${sqlString(JSON.stringify(row.cwds))},${sqlString(row.rrule)},${sqlString(row.model ?? "")},${sqlString(row.reasoningEffort ?? "")},1,1);`
    )
  ].join("\n");
  const result = spawnSync("sqlite3", [dbPath], { input: sql, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

test("active automation with matching DB row reports parity OK and writes report", () => {
  const fixture = tempFixture();
  const id = "demo-publish";
  const body = toml({ id, cwd: fixture.cwd });
  const parsedPrompt = JSON.parse(body.match(/^prompt = (.*)$/m)?.[1] ?? "\"\"");
  writeAutomation(fixture.automationRoot, id, body);
  createDb(fixture.dbPath, [
    {
      id,
      prompt: parsedPrompt,
      status: "ACTIVE",
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
      cwds: [fixture.cwd]
    }
  ]);

  const report = runAutomationHealth({
    automationRoot: fixture.automationRoot,
    dbPath: fixture.dbPath,
    outputRoot: fixture.outputRoot,
    now: new Date("2026-06-16T00:00:00.000Z"),
    psText: ""
  });
  const entry = report.automations[0];

  assert.equal(report.summary.active, 1);
  assert.equal(report.summary.db_drift, 0);
  assert.equal(report.summary.missing_entrypoints, 0);
  assert.equal(entry.db.parity, "ok");
  assert.equal(entry.entrypoints[0]?.exists, true);
  assert.equal(entry.latest_artifacts.length, 2);
  assert.equal(existsSync(report.report_path), true);
  assert.match(readFileSync(report.report_path, "utf8"), /"summary"/);
});

test("DB drift is reported as a blocker", () => {
  const fixture = tempFixture();
  const id = "demo-drift";
  const body = toml({ id, cwd: fixture.cwd });
  const parsedPrompt = JSON.parse(body.match(/^prompt = (.*)$/m)?.[1] ?? "\"\"");
  writeAutomation(fixture.automationRoot, id, body);
  createDb(fixture.dbPath, [
    {
      id,
      prompt: `${parsedPrompt} stale`,
      status: "ACTIVE",
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
      cwds: [fixture.cwd]
    }
  ]);

  const report = runAutomationHealth({ automationRoot: fixture.automationRoot, dbPath: fixture.dbPath, outputRoot: fixture.outputRoot, psText: "" });

  assert.equal(report.summary.db_drift, 1);
  assert.ok(report.automations[0]?.issues.some((issue) => issue.code === "db_prompt_drift" && issue.severity === "blocker"));
});

test("DB name model and reasoning drift are reported", () => {
  const fixture = tempFixture();
  const id = "demo-model-drift";
  const body = toml({ id, cwd: fixture.cwd, model: "gpt-5.5", reasoningEffort: "low" });
  const parsedPrompt = JSON.parse(body.match(/^prompt = (.*)$/m)?.[1] ?? "\"\"");
  writeAutomation(fixture.automationRoot, id, body);
  createDb(fixture.dbPath, [
    {
      id,
      name: "stale name",
      prompt: parsedPrompt,
      status: "ACTIVE",
      rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
      model: "gpt-5.4",
      reasoningEffort: "medium",
      cwds: [fixture.cwd]
    }
  ]);

  const report = runAutomationHealth({ automationRoot: fixture.automationRoot, dbPath: fixture.dbPath, outputRoot: fixture.outputRoot, psText: "" });
  const issueCodes = report.automations[0]?.issues.map((issue) => issue.code) ?? [];

  assert.ok(issueCodes.includes("db_name_drift"));
  assert.ok(issueCodes.includes("db_model_drift"));
  assert.ok(issueCodes.includes("db_reasoning_effort_drift"));
});

test("active DB-only row is reported as a blocker", () => {
  const fixture = tempFixture();
  const id = "demo-db-only";
  const prompt = "Run node scripts/run_demo.mjs. no-post-preflight recommendation_status=pass anomaly_detected=false completion veto.";
  createDb(fixture.dbPath, [{ id, prompt, status: "ACTIVE", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0", cwds: [fixture.cwd] }]);

  const report = runAutomationHealth({ automationRoot: fixture.automationRoot, dbPath: fixture.dbPath, outputRoot: fixture.outputRoot, psText: "" });

  assert.equal(report.summary.active, 1);
  assert.equal(report.summary.blockers, 1);
  assert.equal(report.automations[0]?.db.parity, "missing");
  assert.ok(report.automations[0]?.issues.some((issue) => issue.code === "toml_missing_for_db_row" && issue.severity === "blocker"));
});

test("missing entrypoint is reported without executing anything", () => {
  const fixture = tempFixture();
  const id = "demo-missing-entrypoint";
  const prompt = "Run node scripts/missing.mjs after reading AGENTS.md and STATE.md. no-post-preflight recommendation_status=pass anomaly_detected=false completion veto.";
  const body = toml({ id, cwd: fixture.cwd, prompt });
  writeAutomation(fixture.automationRoot, id, body);
  createDb(fixture.dbPath, [{ id, prompt, status: "ACTIVE", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0", cwds: [fixture.cwd] }]);

  const report = runAutomationHealth({ automationRoot: fixture.automationRoot, dbPath: fixture.dbPath, outputRoot: fixture.outputRoot, psText: "" });

  assert.equal(report.summary.missing_entrypoints, 1);
  assert.ok(report.automations[0]?.issues.some((issue) => issue.code === "entrypoint_missing"));
});

test("publish automation without video QA wording is blocked", () => {
  const fixture = tempFixture();
  const id = "demo-publish-no-video-qa";
  const prompt = "Publish the post and write updates. Run node scripts/run_demo.mjs. First read AGENTS.md and STATE.md.";
  const body = toml({ id, cwd: fixture.cwd, prompt });
  writeAutomation(fixture.automationRoot, id, body);
  createDb(fixture.dbPath, [{ id, prompt, status: "ACTIVE", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0", cwds: [fixture.cwd] }]);

  const report = runAutomationHealth({ automationRoot: fixture.automationRoot, dbPath: fixture.dbPath, outputRoot: fixture.outputRoot, psText: "" });
  const issue = report.automations[0]?.issues.find((candidate) => candidate.code === "video_qa_wording_missing");

  assert.equal(report.summary.video_qa_issues, 1);
  assert.equal(issue?.severity, "blocker");
});

test("read-only discovery wording does not suppress video QA for write/send workflows", () => {
  const fixture = tempFixture();
  const id = "demo-readonly-write-mixed";
  const prompt = "Do read-only discovery first, then send safe follow-ups and write Sheets updates. Run node scripts/run_demo.mjs.";
  const body = toml({ id, cwd: fixture.cwd, prompt });
  writeAutomation(fixture.automationRoot, id, body);
  createDb(fixture.dbPath, [{ id, prompt, status: "ACTIVE", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0", cwds: [fixture.cwd] }]);

  const report = runAutomationHealth({ automationRoot: fixture.automationRoot, dbPath: fixture.dbPath, outputRoot: fixture.outputRoot, psText: "" });
  const issue = report.automations[0]?.issues.find((candidate) => candidate.code === "video_qa_wording_missing");

  assert.equal(report.summary.video_qa_issues, 1);
  assert.equal(issue?.severity, "blocker");
});

test("parser supports multiline prompt and singular cwd TOML shape", () => {
  const parsed = parseAutomationToml(
    [
      'id = "ghostty-codex-autocontinue"',
      'name = "Ghostty Codex Auto-Continue"',
      `cwd = "/tmp/demo-cwd"`,
      'prompt = """',
      "Default entrypoint:",
      "- ghostty-codex-standby status",
      '"""'
    ].join("\n"),
    "/tmp/automations/ghostty-codex-autocontinue/automation.toml"
  );

  assert.equal(parsed.id, "ghostty-codex-autocontinue");
  assert.deepEqual(parsed.cwds, ["/tmp/demo-cwd"]);
  assert.match(parsed.prompt, /ghostty-codex-standby status/);
});

test("PATH-style entrypoints and general authority files are detected", () => {
  const fixture = tempFixture();
  const id = "demo-path-command";
  writeFileSync(join(fixture.cwd, "ghostty-codex-standby"), "#!/bin/sh\n");
  mkdirSync(join(fixture.cwd, "references"), { recursive: true });
  writeFileSync(join(fixture.cwd, "references", "current-run-contract.md"), "# Contract\n");
  writeFileSync(join(fixture.cwd, "sources.json"), "{}\n");
  const prompt = [
    "Default entrypoint:",
    "- ghostty-codex-standby status",
    "First read references/current-run-contract.md, sources.json, README.md, AGENTS.md, and STATE.md."
  ].join("\n");
  writeFileSync(join(fixture.cwd, "README.md"), "# Readme\n");
  const body = toml({ id, cwd: fixture.cwd, prompt });
  writeAutomation(fixture.automationRoot, id, body);
  createDb(fixture.dbPath, [{ id, prompt, status: "ACTIVE", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0", cwds: [fixture.cwd] }]);

  const report = runAutomationHealth({ automationRoot: fixture.automationRoot, dbPath: fixture.dbPath, outputRoot: fixture.outputRoot, psText: "" });
  const entry = report.automations[0];
  const authorityPaths = entry?.authority_files.map((item) => item.path) ?? [];

  assert.equal(entry?.entrypoints.some((item) => item.target === "ghostty-codex-standby" && item.exists), true);
  assert.ok(authorityPaths.includes(join(fixture.cwd, "references", "current-run-contract.md")));
  assert.ok(authorityPaths.includes(join(fixture.cwd, "sources.json")));
});

test("capitalized prose with hyphen is not treated as an entrypoint", () => {
  const fixture = tempFixture();
  const id = "demo-prose-command";
  const prompt = [
    "Run node scripts/run_demo.mjs.",
    "Same-profile concurrency rule: Profile 2 may be shared only for read-only stages.",
    "no-post-preflight recommendation_status=pass anomaly_detected=false completion veto."
  ].join("\n");
  const body = toml({ id, cwd: fixture.cwd, prompt });
  writeAutomation(fixture.automationRoot, id, body);
  createDb(fixture.dbPath, [{ id, prompt, status: "ACTIVE", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0", cwds: [fixture.cwd] }]);

  const report = runAutomationHealth({ automationRoot: fixture.automationRoot, dbPath: fixture.dbPath, outputRoot: fixture.outputRoot, psText: "" });
  const entrypointTargets = report.automations[0]?.entrypoints.map((entrypoint) => entrypoint.target) ?? [];

  assert.deepEqual(entrypointTargets, ["scripts/run_demo.mjs"]);
  assert.equal(report.summary.missing_entrypoints, 0);
});

test("skill reference files resolve relative to matching skill directory", () => {
  const fixture = tempFixture();
  const id = "demo-skill-reference";
  const previousHome = process.env.HOME;
  process.env.HOME = fixture.root;
  const skillRef = join(fixture.root, ".agents", "skills", id, "references");
  mkdirSync(skillRef, { recursive: true });
  writeFileSync(join(skillRef, "current-run-contract.md"), "# Contract\n");
  const prompt = "Run node scripts/run_demo.mjs. First read references/current-run-contract.md, AGENTS.md, and STATE.md.";
  const body = toml({ id, cwd: fixture.cwd, prompt });
  writeAutomation(fixture.automationRoot, id, body);
  createDb(fixture.dbPath, [{ id, prompt, status: "ACTIVE", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0", cwds: [fixture.cwd] }]);

  try {
    const report = runAutomationHealth({ automationRoot: fixture.automationRoot, dbPath: fixture.dbPath, outputRoot: fixture.outputRoot, psText: "" });
    assert.equal(report.summary.warnings, 0);
    assert.ok(report.automations[0]?.authority_files.some((authority) => authority.path.endsWith(`${id}/references/current-run-contract.md`) && authority.exists));
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("inactive publish automation issues do not count as run-blocking summary blockers", () => {
  const fixture = tempFixture();
  const id = "demo-inactive-publish";
  const prompt = "Publish the post and write updates. Run node scripts/missing.mjs.";
  const body = toml({ id, cwd: fixture.cwd, prompt, status: "INACTIVE" });
  writeAutomation(fixture.automationRoot, id, body);
  createDb(fixture.dbPath, [{ id, prompt: `${prompt} stale`, status: "INACTIVE", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0", cwds: [fixture.cwd] }]);

  const report = runAutomationHealth({ automationRoot: fixture.automationRoot, dbPath: fixture.dbPath, outputRoot: fixture.outputRoot, psText: "" });

  assert.equal(report.summary.active, 0);
  assert.equal(report.summary.blockers, 0);
  assert.equal(report.summary.video_qa_issues, 0);
  assert.equal(report.automations[0]?.video_qa.status, "not_required");
});

test("confirmed queue STATE reference resolves to sibling automation state", () => {
  const fixture = tempFixture();
  const id = "job-application-follow-up-inbox-2";
  const prompt = "Read confirmed queue STATE.md only as historical proof when needed. Run node scripts/run_demo.mjs.";
  const body = toml({ id, cwd: fixture.cwd, prompt });
  writeAutomation(fixture.automationRoot, id, body);
  const confirmedDir = join(fixture.automationRoot, "confirmed-job-applications-daily-queue");
  mkdirSync(confirmedDir, { recursive: true });
  writeFileSync(join(confirmedDir, "STATE.md"), "# Confirmed state\n");
  createDb(fixture.dbPath, [{ id, prompt, status: "ACTIVE", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0", cwds: [fixture.cwd] }]);

  const report = runAutomationHealth({ automationRoot: fixture.automationRoot, dbPath: fixture.dbPath, outputRoot: fixture.outputRoot, psText: "" });

  assert.equal(report.summary.warnings, 0);
  assert.ok(report.automations[0]?.authority_files.some((authority) => authority.path.endsWith("confirmed-job-applications-daily-queue/STATE.md") && authority.exists));
});

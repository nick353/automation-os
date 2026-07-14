import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-maintenance-"));
const currentProjectRoot = process.cwd();
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.AUTOMATION_OS_RESUME_CONTRACT_PATH = join(tempRoot, "resume-contract.json");

const db = await import("../db/client.js");
const obsidian = await import("../obsidian/exporter.js");

test("cleanDevData resets run records and removes local artifacts", () => {
  db.initDb();
  db.resetDemoData();
  const artifactRoot = join(tempRoot, "data", "artifacts");
  const artifactDir = join(artifactRoot, "run_test");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "receipt.json"), "{}");

  db.insert("runs", {
    id: "run_test",
    name: "Test run",
    status: "partial",
    objective: "cleanup test",
    created_at: db.nowIso(),
    updated_at: db.nowIso(),
    metadata_json: {}
  });
  db.insert("worker_events", {
    id: "evt_test",
    run_id: "run_test",
    step_id: null,
    lane_id: null,
    event_type: "worker_completed",
    message: "test event",
    created_at: db.nowIso(),
    metadata_json: {}
  });

  const dryRun = db.cleanDevData({ artifactRoot, dryRun: true });

  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.artifactsRemoved, true);
  assert.equal(existsSync(artifactRoot), true);
  assert.equal(db.querySql("SELECT * FROM runs").length, 1);

  const backupRoot = join(tempRoot, "data", "backups");
  const result = db.cleanDevData({ artifactRoot, backupRoot, backupTimestamp: "2026-06-06T00:00:00.000Z" });

  assert.equal(result.artifactsRemoved, true);
  assert.equal(result.dryRun, false);
  assert.ok(result.backupDir);
  assert.ok(result.artifactManifest);
  assert.ok(existsSync(result.backupDir));
  assert.ok(existsSync(result.artifactManifest));
  assert.ok(result.databaseBackups.some((file) => file.endsWith("automation-os.sqlite")));
  assert.match(readFileSync(result.artifactManifest, "utf8"), /receipt\.json/);
  assert.equal(existsSync(artifactRoot), false);
  assert.equal(db.querySql("SELECT * FROM runs").length, 0);
  assert.equal(db.querySql("SELECT * FROM worker_events").length, 0);
});

test("exportObsidianVault writes wiki-linked run, proof, and docs markdown", () => {
  db.initDb();
  db.resetDemoData();
  const now = db.nowIso();
  const docsDir = join(tempRoot, "docs");
  const vaultPath = join(tempRoot, "Obsidian Vault");
  const automationsRoot = join(tempRoot, "automations");
  const codexSessionsDir = join(tempRoot, "codex-sessions");
  const memoryFile = join(tempRoot, "MEMORY.md");
  const codexSkillRoot = join(tempRoot, "codex-skills");
  const agentSkillRoot = join(tempRoot, "agent-skills");
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(join(automationsRoot, "demo-automation"), { recursive: true });
  mkdirSync(join(codexSessionsDir, "2026", "06", "11"), { recursive: true });
  mkdirSync(join(codexSkillRoot, "obsidian-sync"), { recursive: true });
  mkdirSync(join(agentSkillRoot, "daily-runner"), { recursive: true });
  mkdirSync(join(vaultPath, "05_Projects"), { recursive: true });
  mkdirSync(join(vaultPath, "05_Projects", "Nested"), { recursive: true });
  mkdirSync(join(vaultPath, "00_Start Here"), { recursive: true });
  mkdirSync(join(vaultPath, "01_Control Panel"), { recursive: true });
  mkdirSync(join(vaultPath, "09_Inbox"), { recursive: true });
  writeFileSync(join(docsDir, "06-control-panel.md"), "# Control Panel\n\nQuick Start first.");
  writeFileSync(join(automationsRoot, "demo-automation", "automation.toml"), "name = \"Demo automation\"\nstatus = \"ACTIVE\"\n");
  writeFileSync(join(codexSkillRoot, "obsidian-sync", "SKILL.md"), "---\nname: Obsidian Sync\n---\n\n# Obsidian Sync\n");
  writeFileSync(join(agentSkillRoot, "daily-runner", "SKILL.md"), "---\nname: Daily Runner\n---\n\n# Daily Runner\n");
  writeFileSync(
    join(vaultPath, "00_Start Here", "Project Handoff Index.md"),
    `---\ngenerated_by: automation-os\nkind: project-handoff-index\n---\n\n# Project Handoff Index\n\n- Automation OS: ${currentProjectRoot}\n- Demo: /tmp/demo-project/STATE.md\n`
  );
  writeFileSync(
    memoryFile,
    [
      "# Task Group: Automation OS test memory",
      "",
      `scope: \`${currentProjectRoot}\` generated control surface tests.`,
      `applies_to: cwd_family=${currentProjectRoot} and /tmp/other-project; source stays external.`,
      "- rollout summary (cwd=/tmp/work-2, updated_at=2026-06-11T00:00:00Z)",
      `- automation candidate cwd=${automationsRoot}/demo-automation`
    ].join("\n")
  );
  writeFileSync(
    join(vaultPath, "01_Control Panel", "Command Queue.md"),
    "---\nkind: command-queue\nstatus: active\nsource_of_truth: handwritten queue\n---\n\n# Command Queue\n\n- [ ] priority: high | CodexにWeekly Reviewから改善案を作らせる\n- [x] priority: low | 完了済みは拾わない\n"
  );
  writeFileSync(
    join(vaultPath, "09_Inbox", "Raw Codex Request.md"),
    "---\nkind: inbox\nstatus: open\npriority: medium\nnext_action: Codexに未分類メモを整理させる\nsource_of_truth: inbox note\n---\n\n# Raw Codex Request\n"
  );
  writeFileSync(
    join(vaultPath, "09_Inbox", "Article URL.md"),
    [
      "---",
      "title: Article URL",
      "needsClassification: yes",
      "status: open",
      "sourceUrl: https://example.com/ai-systems",
      "captureType: article",
      "sourceOfTruth: source URL",
      "suggestedDestination: 06_Research",
      "---",
      "",
      "# Article URL",
      "",
      "Research memo about AI systems."
    ].join("\n")
  );
  writeFileSync(
    join(vaultPath, "09_Inbox", "Review Ready Candidate.md"),
    [
      "---",
      "title: Review Ready Candidate",
      "needsClassification: yes",
      "status: open",
      "processing_status: review_ready",
      "sourceUrl: https://example.com/review-ready",
      "captureType: article",
      "sourceOfTruth: source URL",
      "suggestedDestination: 06_Research",
      "---",
      "",
      "# Review Ready Candidate",
      "",
      "Research memo that was already processed and should remain review_ready in generated processor queue."
    ].join("\n")
  );
  writeFileSync(
    join(vaultPath, "09_Inbox", "Approval Required Research.md"),
    [
      "---",
      "title: Approval Required Research",
      "needsClassification: yes",
      "status: open",
      "sourceUrl: https://example.com/approval-required",
      "captureType: article",
      "sourceOfTruth: source URL",
      "suggestedDestination: 06_Research",
      "external_action_required: true",
      "approval_required: true",
      "---",
      "",
      "# Approval Required Research",
      "",
      "Research memo that stays in an allowlisted destination but still needs explicit approval."
    ].join("\n")
  );
  writeFileSync(
    join(vaultPath, "09_Inbox", "External Required Research.md"),
    [
      "---",
      "title: External Required Research",
      "needsClassification: yes",
      "status: open",
      "sourceUrl: https://example.com/external-required",
      "captureType: article",
      "sourceOfTruth: source URL",
      "suggestedDestination: 06_Research",
      "external_action_required: true",
      "---",
      "",
      "# External Required Research",
      "",
      "Research memo that stays in an allowlisted destination but still marks an external action boundary."
    ].join("\n")
  );
  writeFileSync(
    join(vaultPath, "09_Inbox", "Secret Source.md"),
    [
      "---",
      "title: Secret Source",
      "kind: inbox",
      "status: open",
      "sourceUrl: https://user:pass@example.com/private?access_token=N9sK2LmP8qRwT5yUi3OpAzXcVbNmQ1We",
      "sourceOfTruth: Bearer sk-testsecret1234567890",
      "suggestedDestination: ../../Secrets",
      "---",
      "",
      "# Secret Source",
      "",
      "Classify this only after redacting the source pointer."
    ].join("\n")
  );
  writeFileSync(
    join(vaultPath, "09_Inbox", "Loose Thought.md"),
    "---\nkind: inbox\nstatus: open\nsource_of_truth: handwritten thought\n---\n\n# Loose Thought\n\nKeep this for later: https://example.com/loose\n"
  );
  writeFileSync(
    join(vaultPath, "09_Inbox", "Research Capture.md"),
    "---\nkind: research\nstatus: active\nnext_action: これは未分類依頼ではない\nsource_of_truth: research note\n---\n\n# Research Capture\n\n- [ ] priority: high | research unchecked task should stay out of intake\n"
  );
  writeFileSync(
    join(vaultPath, "09_Inbox", "Generated Inbox Helper.md"),
    "---\ngenerated_by: automation-os\nkind: inbox\nneeds_classification: yes\n---\n\n# Generated Inbox Helper\n\nGenerated notes must stay out.\n"
  );
  writeFileSync(
    join(vaultPath, "05_Projects", "Demo Project.md"),
    "---\ntitle: Demo Project\nkind: project\nstatus: active\nsource_of_truth: local test fixture\n---\n\n# Demo Project\n"
  );
  writeFileSync(
    join(vaultPath, "05_Projects", "Nested", "Project Index.md"),
    "---\ntitle: Nested Project Index\nkind: project\nstatus: active\nsource_of_truth: nested handwritten note\n---\n\n# Nested Project Index\n"
  );
  mkdirSync(join(vaultPath, "05_Projects", "_templates"), { recursive: true });
  writeFileSync(join(vaultPath, "05_Projects", "_templates", "Hidden Template.md"), "# Hidden Template\n");
  writeFileSync(join(vaultPath, "05_Projects", "Generated Helper.md"), "---\ngenerated_by: automation-os\n---\n\n# Generated Helper\n");
  const locatorSessionId = "019eb511-0e2c-71a0-ba4b-aaee602a347a";
  const locatorSessionFilename = `rollout-2026-06-11T10-20-30-${locatorSessionId}.jsonl`;
  for (let index = 0; index < 12; index += 1) {
    const path = join(codexSessionsDir, "2026", "06", "11", index === 5 ? locatorSessionFilename : `rollout-session-${index}.jsonl`);
    const userText =
      index === 5
        ? "Resume Automation OS from https://bot:sample@example.com/private with AWS_SECRET_ACCESS_KEY=sample-aws-secret-value, jwt sample-jwt-value, sessionid=sample-session-value, and N9sK2LmP8qRwT5yUi3OpAzXcVbNmQ1We."
        : index === 11
          ? "Continue Obsidian sync with token sample-token-1234567890 and a concise resume brief."
          : `Older user request ${index}`;
    const assistantText =
      index === 5
        ? "I will keep Cookie connect.sid=s%3Asamplecookie and REFRESH_TOKEN=refresh-sample-value out of snippets."
        : index === 11
          ? "I will inspect generated files and keep access_token=sample-token out of snippets."
          : `Older assistant summary ${index}`;
    const cwd =
      index === 11
        ? "/tmp/unrelated-global-latest"
        : index === 5 || index === 4
          ? join(process.cwd(), "apps", "server")
          : `/tmp/work-${index}`;
    writeFileSync(
      path,
      [
        JSON.stringify({ session_meta: { payload: { id: index === 5 ? locatorSessionId : `session_${index}`, cwd } } }),
        JSON.stringify({ type: "response_item", item: { type: "message", role: "user", content: [{ type: "input_text", text: userText }] } }),
        JSON.stringify({
          type: "response_item",
          item: { type: "message", role: "assistant", content: [{ type: "output_text", text: assistantText }] }
        })
      ].join("\n")
    );
    const mtime = new Date(Date.UTC(2026, 5, 11, 0, 0, index));
    utimesSync(path, mtime, mtime);
  }
  const previousAutomationsRoot = process.env.AUTOMATION_OS_CODEX_AUTOMATIONS_ROOT;
  const previousCapabilitiesHome = process.env.AUTOMATION_OS_CAPABILITIES_HOME;
  const previousCodexSkillRoots = process.env.AUTOMATION_OS_CODEX_SKILL_ROOTS;
  const previousAgentSkillRoots = process.env.AUTOMATION_OS_AGENT_SKILL_ROOTS;
  process.env.AUTOMATION_OS_CODEX_AUTOMATIONS_ROOT = automationsRoot;
  process.env.AUTOMATION_OS_CAPABILITIES_HOME = tempRoot;
  process.env.AUTOMATION_OS_CODEX_SKILL_ROOTS = codexSkillRoot;
  process.env.AUTOMATION_OS_AGENT_SKILL_ROOTS = agentSkillRoot;

  db.insert("runs", {
    id: "run_obsidian",
    name: "Obsidian export run",
    status: "complete",
    objective: "Generate LLM Wiki material",
    created_at: now,
    updated_at: now,
    metadata_json: {
      command: "export",
      worker_mode: "receipt_only",
      run_contract_summary: { beginnerLabel: "Etsy Sync", progress: { done: 3, total: 3, ok: true } }
    }
  });
  db.insert("proofs", {
    id: "proof_obsidian",
    run_id: "run_obsidian",
    step_id: null,
    proof_type: "worker_receipt",
    label: "Export receipt",
    uri: "file:///tmp/export.json",
    size_bytes: 123,
    created_at: now,
    metadata_json: { demo: true }
  });
  db.insert("runs", {
    id: "run_blocked_obsidian",
    name: "Blocked Obsidian follow-up",
    status: "blocked",
    objective: "Resume only after blocker is understood",
    created_at: "2000-01-01T00:00:00.000Z",
    updated_at: "2000-01-01T00:00:00.000Z",
    metadata_json: {
      stop_reason: "waiting for explicit proof",
      proof_summary: "partial: exact blocker retained"
    }
  });
  db.insert("system_checks", {
    id: "check_obsidian",
    kind: "browser_check",
    status: "ok",
    target_url: "http://127.0.0.1:5173/#sources",
    summary: "Local UI verified",
    artifact_uri: "file:///tmp/screen.png",
    created_at: now,
    metadata_json: { screenshotPath: "/tmp/screen.png", consolePath: "/tmp/console.log", consoleErrorCount: 2 }
  });
  db.insert("bridge_actions", {
    id: "bridge_obsidian",
    capability_id: "local_browser_check",
    label: "画面を開いて確認",
    status: "ok",
    risk_level: "safe",
    target: "http://127.0.0.1:5173/#sources",
    summary: "Bridge verified",
    created_at: now,
    metadata_json: { screenshotPath: "/tmp/screen.png" }
  });
  db.insert("bridge_executions", {
    id: "bridge_exec_obsidian",
    capability_id: "chrome_authenticated_action",
    approval_id: "approval_obsidian",
    status: "blocked",
    executor_status: "not_connected",
    summary: "Approved but executor is not connected",
    created_at: now,
    updated_at: now,
    metadata_json: { policyDecision: "billing_confirmed_but_executor_not_connected" }
  });
  db.insert("knowledge_notes", {
    id: "knowledge_obsidian",
    note_type: "bridge_snapshot",
    title: "Trusted Bridge execution and billing-only boundary",
    body: "Safe local checks can run immediately. Only billing, purchase, payment, checkout, paid subscription, invoice, or 請求 are hard stops.",
    tags_json: ["trusted-bridge", "billing-only"],
    source_ref: "bridge_actions",
    created_at: now,
    updated_at: now,
    metadata_json: { demo: true }
  });

  const result = obsidian.exportObsidianVault({ vaultPath, docsDir, codexSessionsDir, codexMemoryFile: memoryFile });
  const index = readFileSync(join(result.outputDir, "Automation OS Index.md"), "utf8");
  const runs = readFileSync(join(result.outputDir, "Runs.md"), "utf8");
  const proofs = readFileSync(join(result.outputDir, "Proofs.md"), "utf8");
  const knowledge = readFileSync(join(result.outputDir, "Knowledge.md"), "utf8");
  const docs = readFileSync(join(result.outputDir, "Docs.md"), "utf8");
  const today = readFileSync(join(vaultPath, "00_Start Here", "Today.md"), "utf8");
  const dailyBrief = readFileSync(join(vaultPath, "00_Start Here", "Codex Daily Brief.md"), "utf8");
  const projectCockpit = readFileSync(join(vaultPath, "00_Start Here", "Project Cockpit.md"), "utf8");
  const resumeCurrentWork = readFileSync(join(vaultPath, "00_Start Here", "Resume Current Work.md"), "utf8");
  const resumeContractNote = readFileSync(join(vaultPath, "00_Start Here", "Resume Contract.md"), "utf8");
  assert.ok(result.resumeContractJsonFile);
  const userAgentsPath = join(homedir(), "AGENTS.md");
  const codexAgentsPath = join(homedir(), ".codex", "AGENTS.md");
  const resumeContractJson = JSON.parse(readFileSync(result.resumeContractJsonFile, "utf8")) as {
    readFirst: Array<{ label: string; path: string }>;
    projects: Array<{ cwd: string; authorityFiles: Array<{ path: string }>; latestArtifact?: { path: string } | null }>;
    authorityFiles: Array<{ path: string }>;
    latestArtifact?: { path: string } | null;
    memoryHints: Array<{ path: string }>;
    resumeRule: string;
    generatedAt: string;
  };
  const projectHandoffIndex = readFileSync(join(vaultPath, "00_Start Here", "Project Handoff Index.md"), "utf8");
  const proofInbox = readFileSync(join(vaultPath, "04_Proof Pointers", "Proof Inbox.md"), "utf8");
  const automationDashboard = readFileSync(join(vaultPath, "10_Dashboards", "Automation Dashboard.base"), "utf8");
  const controlPanel = readFileSync(join(vaultPath, "01_Control Panel", "Automation Control Panel.md"), "utf8");
  const actionQueue = readFileSync(join(vaultPath, "01_Control Panel", "Action Queue.md"), "utf8");
  const commandQueue = readFileSync(join(vaultPath, "01_Control Panel", "Command Queue.md"), "utf8");
  const commandQueueIntake = readFileSync(join(vaultPath, "01_Control Panel", "Command Queue Intake.md"), "utf8");
  const conversationMemoryCards = readFileSync(join(vaultPath, "01_Control Panel", "Conversation Memory Cards.md"), "utf8");
  const userSignals = readFileSync(join(vaultPath, "01_Control Panel", "User Signals.md"), "utf8");
  const secondBrainIntake = readFileSync(join(vaultPath, "01_Control Panel", "Second Brain Intake.md"), "utf8");
  const secondBrainAutoProcessor = readFileSync(join(vaultPath, "01_Control Panel", "Second Brain Auto Processor.md"), "utf8");
  const secondBrainWeeklyDigest = readFileSync(join(vaultPath, "00_Start Here", "Second Brain Weekly Digest.md"), "utf8");
  const activeSessions = readFileSync(join(vaultPath, "01_Control Panel", "Active Sessions.md"), "utf8");
  const skillRegistry = readFileSync(join(vaultPath, "01_Control Panel", "Skill Registry.md"), "utf8");
  const codexAppParityLedger = readFileSync(join(vaultPath, "01_Control Panel", "Codex App Parity Ledger.md"), "utf8");
  const projectMemoryMap = readFileSync(join(vaultPath, "00_Start Here", "Project Memory Map.md"), "utf8");
  const selfDiagnosis = readFileSync(join(vaultPath, "00_Start Here", "Obsidian x Codex Self Diagnosis.md"), "utf8");
  const weeklyCheck = readFileSync(join(vaultPath, "00_Start Here", "Obsidian x Codex Weekly Check.md"), "utf8");
  const decisionLog = readFileSync(join(vaultPath, "07_Decisions", "Decision Log.md"), "utf8");
  const failureFixLog = readFileSync(join(vaultPath, "07_Decisions", "Failure Fix Log.md"), "utf8");
  const weeklyReview = readFileSync(join(vaultPath, "00_Start Here", "Weekly Review.md"), "utf8");
  const secondBrainReviewBase = readFileSync(join(vaultPath, "10_Dashboards", "Second Brain Review.base"), "utf8");
  const blockerRadar = readFileSync(join(vaultPath, "10_Dashboards", "Blocker Radar.md"), "utf8");
  const successPaths = readFileSync(join(vaultPath, "10_Dashboards", "Success Paths.md"), "utf8");
  const projectIndex = readFileSync(join(vaultPath, "05_Projects", "Project Index.md"), "utf8");
  const projectTemplate = readFileSync(join(vaultPath, "90_Templates", "project-note.md"), "utf8");
  const dailyUrlTemplate = readFileSync(join(vaultPath, "90_Templates", "daily-url-capture.md"), "utf8");
  const thoughtTemplate = readFileSync(join(vaultPath, "90_Templates", "thought-capture.md"), "utf8");
  const articleTemplate = readFileSync(join(vaultPath, "90_Templates", "article-memo.md"), "utf8");

  assert.deepEqual(result.files.map((file) => file.split("/").at(-1)), [
    "Automation OS Index.md",
    "Runs.md",
    "Proofs.md",
    "Knowledge.md",
    "Docs.md",
    "Run Ledger.md"
  ]);
  assert.match(index, /generated_by: automation-os/);
  assert.match(index, /\[\[Runs\]\]/);
  assert.match(index, /\[\[Proofs\]\]/);
  assert.match(index, /\[\[Knowledge\]\]/);
  assert.match(index, /\[\[Docs\]\]/);
  assert.match(index, /Latest browser check: ok - Local UI verified/);
  assert.match(index, /## System Checks/);
  assert.match(index, /### check_obsidian/);
  assert.match(index, /Target URL: http:\/\/127\.0\.0\.1:5173\/#sources/);
  assert.match(index, /Artifact URI: file:\/\/\/tmp\/screen\.png/);
  assert.match(index, /screenshotPath: \/tmp\/screen\.png/);
  assert.match(index, /consolePath: \/tmp\/console\.log/);
  assert.match(index, /consoleErrorCount: 2/);
  assert.match(runs, /run_obsidian/);
  assert.match(runs, /\[\[Proofs#proof_obsidian\|Export receipt\]\]/);
  assert.match(proofs, /\[\[Runs#run_obsidian\|Obsidian export run\]\]/);
  assert.match(knowledge, /Trusted Bridge execution and billing-only boundary/);
  assert.match(knowledge, /Bridge verified/);
  assert.match(knowledge, /Trusted Bridge Executor Ledger/);
  assert.match(knowledge, /bridge_exec_obsidian/);
  assert.match(knowledge, /Executor: not_connected/);
  assert.match(knowledge, /Safe local checks can run immediately/);
  assert.match(knowledge, /Only billing, purchase, payment, checkout, paid subscription, invoice, or 請求 are hard stops/);
  assert.match(docs, /Quick Start first/);
  assert.equal(result.controlPanelFile, join(vaultPath, "01_Control Panel", "Automation Control Panel.md"));
  assert.match(controlPanel, /generated_by: automation-os/);
  assert.match(controlPanel, /demo-automation/);
  assert.match(controlPanel, /automation:demo-automation/);
  assert.match(controlPanel, /read-only inventory/);
  assert.ok(result.missionFiles.length >= 11);
  assert.ok(result.missionFiles.some((file) => file.endsWith(join("00_Start Here", "Today.md"))));
  assert.ok(result.missionFiles.some((file) => file.endsWith(join("00_Start Here", "Codex Daily Brief.md"))));
  assert.ok(result.missionFiles.some((file) => file.endsWith(join("00_Start Here", "Project Cockpit.md"))));
  assert.ok(result.missionFiles.some((file) => file.endsWith(join("00_Start Here", "Resume Current Work.md"))));
  assert.ok(result.missionFiles.some((file) => file.endsWith(join("00_Start Here", "Resume Contract.md"))));
  assert.ok(result.missionFiles.some((file) => file.endsWith(join("01_Control Panel", "Action Queue.md"))));
  assert.ok(result.missionFiles.some((file) => file.endsWith(join("01_Control Panel", "Command Queue Intake.md"))));
  assert.ok(result.missionFiles.some((file) => file.endsWith(join("01_Control Panel", "Active Sessions.md"))));
  assert.ok(result.missionFiles.some((file) => file.endsWith(join("01_Control Panel", "Conversation Memory Cards.md"))));
  assert.ok(result.missionFiles.some((file) => file.endsWith(join("01_Control Panel", "User Signals.md"))));
  assert.ok(result.missionFiles.some((file) => file.endsWith(join("01_Control Panel", "Skill Registry.md"))));
  assert.ok(result.missionFiles.some((file) => file.endsWith(join("01_Control Panel", "Codex App Parity Ledger.md"))));
  assert.ok(result.missionFiles.some((file) => file.endsWith(join("00_Start Here", "Project Memory Map.md"))));
  assert.ok(result.missionFiles.some((file) => file.endsWith(join("00_Start Here", "Obsidian Autonomy Ops Memo.md"))));
  assert.ok(result.missionFiles.some((file) => file.endsWith(join("00_Start Here", "Obsidian x Codex Self Diagnosis.md"))));
  assert.ok(result.missionFiles.some((file) => file.endsWith(join("00_Start Here", "Obsidian x Codex Weekly Check.md"))));
  assert.ok(result.missionFiles.some((file) => file.endsWith(join("07_Decisions", "Decision Log.md"))));
  assert.ok(result.missionFiles.some((file) => file.endsWith(join("07_Decisions", "Failure Fix Log.md"))));
  assert.ok(result.missionFiles.some((file) => file.endsWith(join("00_Start Here", "Weekly Review.md"))));
  assert.equal(result.secondBrainFiles.length, 3);
  assert.ok(result.secondBrainFiles.some((file) => file.endsWith(join("01_Control Panel", "Second Brain Intake.md"))));
  assert.ok(result.secondBrainFiles.some((file) => file.endsWith(join("01_Control Panel", "Second Brain Auto Processor.md"))));
  assert.ok(result.secondBrainFiles.some((file) => file.endsWith(join("00_Start Here", "Second Brain Weekly Digest.md"))));
  assert.match(today, /generated_by: automation-os/);
  assert.match(today, /# Today/);
  assert.match(today, /Project Cockpit/);
  assert.match(today, /Conversation Memory Cards/);
  assert.match(today, /Failure Fix Log/);
  assert.match(today, /Resume Rule/);
  assert.match(today, /Obsidian Autonomy Ops Memo/);
  assert.match(today, /Obsidian x Codex Self Diagnosis/);
  assert.match(dailyBrief, /generated_by: automation-os/);
  assert.match(dailyBrief, /Codex Daily Brief/);
  assert.match(dailyBrief, /Latest run: \[\[Runs#run_obsidian\|Obsidian export run\]\] \(complete\)/);
  assert.match(dailyBrief, /Open command queue items: 2/);
  assert.match(projectCockpit, /generated_by: automation-os/);
  assert.match(projectCockpit, /# Project Cockpit/);
  assert.match(selfDiagnosis, /generated_by: automation-os/);
  assert.match(selfDiagnosis, /Current score:/);
  assert.match(weeklyCheck, /generated_by: automation-os/);
  assert.match(weeklyCheck, /Current score:/);
  assert.match(projectCockpit, /全project横断/);
  assert.match(projectCockpit, /Recent Run Proof Surface/);
  assert.match(resumeCurrentWork, /generated_by: automation-os/);
  assert.match(resumeCurrentWork, /# Resume Current Work/);
  assert.match(resumeCurrentWork, /Latest run: \[\[Runs#run_obsidian\|Obsidian export run\]\] \(complete/);
  assert.match(resumeCurrentWork, /Resume candidate: \[\[Runs#run_blocked_obsidian\|Blocked Obsidian follow-up\]\] \(blocked/);
  assert.match(resumeCurrentWork, /Obsidian Autonomy Ops Memo/);
  assert.match(resumeCurrentWork, /## Current Action Queue/);
  assert.match(resumeCurrentWork, /- \[\[Runs#run_blocked_obsidian\|Blocked Obsidian follow-up\]\] \(blocked/);
  assert.match(resumeCurrentWork, /Latest system check: ok - Local UI verified/);
  assert.match(resumeCurrentWork, /Latest bridge execution: blocked\/not_connected - Approved but executor is not connected/);
  assert.match(resumeCurrentWork, /Latest knowledge: Trusted Bridge execution and billing-only boundary/);
  assert.match(resumeCurrentWork, /Latest Codex session: 019eb511-0e2c-71a0-ba4b-aaee602a347a/);
  assert.match(resumeCurrentWork, /## Auto Resume Triggers/);
  assert.match(resumeCurrentWork, /AutomationOSは何をやっていた/);
  assert.match(resumeCurrentWork, /This applies to every project/);
  assert.match(resumeCurrentWork, /## Source Of Truth Ladder/);
  assert.match(resumeCurrentWork, /Chat\/session memory: hint only/);
  assert.doesNotMatch(resumeCurrentWork, /Latest Codex session: session_11/);
  assert.match(resumeCurrentWork, /\[redacted-auth\]/);
  assert.match(resumeCurrentWork, /AWS_SECRET_ACCESS_KEY=\[redacted\]/);
  assert.match(resumeCurrentWork, /\[redacted-jwt\]/);
  assert.match(resumeCurrentWork, /sessionid=\[redacted-session\]/);
  assert.match(resumeCurrentWork, /\[redacted-token\]/);
  assert.match(resumeCurrentWork, /connect\.sid=\[redacted-session\]/);
  assert.match(resumeCurrentWork, /REFRESH_TOKEN=\[redacted\]/);
  assert.doesNotMatch(resumeCurrentWork, /supersecret/);
  assert.doesNotMatch(resumeCurrentWork, /AbCdEfGhIjKlMnOpQrStUvWxYz123456/);
  assert.doesNotMatch(resumeCurrentWork, /eyJhbGciOiJIUzI1Ni/);
  assert.doesNotMatch(resumeCurrentWork, /abc123secretvalue/);
  assert.doesNotMatch(resumeCurrentWork, /N9sK2LmP8qRwT5yUi3OpAzXcVbNmQ1We/);
  assert.doesNotMatch(resumeCurrentWork, /refreshsecretvalue/);
  assert.doesNotMatch(resumeCurrentWork, /sk-testsecret1234567890/);
  assert.doesNotMatch(resumeCurrentWork, /verysecret/);
  assert.match(resumeContractNote, /# Resume Contract/);
  assert.match(resumeContractNote, /Project Handoff Index/);
  assert.match(resumeContractNote, /## Natural Resume Triggers/);
  assert.match(resumeContractNote, /AutomationOSは何をやっていた/);
  assert.match(resumeContractNote, /<project>は何をやっていた/);
  assert.match(resumeContractNote, /resume-contract\.json/);
  assert.ok(result.resumeContractFile?.endsWith(join("00_Start Here", "Resume Contract.md")));
  assert.ok(result.resumeContractJsonFile?.endsWith("resume-contract.json"));
  assert.ok(resumeContractJson.readFirst.some((entry) => entry.label === "Project Handoff Index"));
  assert.ok(resumeContractJson.readFirst.some((entry) => entry.label === "User AGENTS" && entry.path === userAgentsPath));
  assert.ok(resumeContractJson.readFirst.some((entry) => entry.label === "Codex AGENTS" && entry.path === codexAgentsPath));
  assert.ok(resumeContractJson.projects.some((project) => project.cwd === homedir()));
  assert.ok(resumeContractJson.projects.some((project) => project.cwd === join(homedir(), ".codex")));
  assert.ok(resumeContractJson.projects.some((project) => project.cwd === currentProjectRoot));
  assert.ok(resumeContractJson.authorityFiles.some((entry) => entry.path === userAgentsPath));
  assert.ok(resumeContractJson.authorityFiles.some((entry) => entry.path === codexAgentsPath));
  assert.ok(resumeContractJson.authorityFiles.some((entry) => entry.path.endsWith("automation.toml") || entry.path.endsWith("AGENTS.md")));
  assert.ok(resumeContractJson.latestArtifact?.path.includes("artifacts/"));
  assert.ok(resumeContractJson.memoryHints.some((entry) => entry.path.includes("automation-os")));
  assert.match(resumeContractJson.resumeRule, /Before asking the user to restate context/);
  assert.match(resumeContractJson.resumeRule, /Natural resume questions/);
  assert.match(resumeContractJson.resumeRule, /AutomationOSは何をやっていた/);
  assert.match(resumeContractJson.resumeRule, /<project>は何をやっていた/);
  assert.match(projectHandoffIndex, /# Project Handoff Index/);
  assert.match(projectHandoffIndex, /\/tmp\/demo-project\/STATE\.md/);
  assert.equal(result.proofInboxFile, join(vaultPath, "04_Proof Pointers", "Proof Inbox.md"));
  assert.match(proofInbox, /generated_by: automation-os/);
  assert.match(proofInbox, /file:\/\/\/tmp\/export\.json/);
  assert.equal(result.dashboardFiles.length, 7);
  assert.ok(result.dashboardFiles.some((file) => file.endsWith(join("10_Dashboards", "Automation Dashboard.base"))));
  assert.ok(result.dashboardFiles.some((file) => file.endsWith(join("10_Dashboards", "Second Brain Review.base"))));
  assert.ok(result.dashboardFiles.some((file) => file.endsWith(join("10_Dashboards", "Blocker Radar.md"))));
  assert.ok(result.dashboardFiles.some((file) => file.endsWith(join("10_Dashboards", "Success Paths.md"))));
  assert.ok(result.projectGovernanceFiles?.some((file) => file.endsWith(join("10_Dashboards", "Project Health.md"))));
  assert.ok(result.projectGovernanceFiles?.some((file) => file.endsWith(join("data", "project-audit-status.json"))));
  assert.match(automationDashboard, /# generated_by: automation-os/);
  assert.match(automationDashboard, /file\.inFolder\(\"02_Automations\"\)/);
  assert.match(secondBrainReviewBase, /# generated_by: automation-os/);
  assert.match(secondBrainReviewBase, /file\.inFolder\(\"09_Inbox\"\)/);
  assert.match(secondBrainReviewBase, /auto_process:/);
  assert.match(secondBrainReviewBase, /processing_status:/);
  assert.match(secondBrainReviewBase, /suggested_destination:/);
  assert.match(secondBrainReviewBase, /progressive_summary:/);
  assert.match(secondBrainReviewBase, /source_of_truth:/);
  assert.match(secondBrainReviewBase, /external_action_required:/);
  assert.match(actionQueue, /generated_by: automation-os/);
  assert.match(actionQueue, /Action Queue/);
  assert.match(actionQueue, /demo-automation/);
  assert.match(actionQueue, /CodexにWeekly Reviewから改善案を作らせる/);
  assert.doesNotMatch(commandQueue, /generated_by: automation-os/);
  assert.match(commandQueueIntake, /generated_by: automation-os/);
  assert.match(commandQueueIntake, /CodexにWeekly Reviewから改善案を作らせる/);
  assert.match(commandQueueIntake, /Codexに未分類メモを整理させる/);
  assert.doesNotMatch(commandQueueIntake, /完了済みは拾わない/);
  assert.match(conversationMemoryCards, /generated_by: automation-os/);
  assert.match(conversationMemoryCards, /# Conversation Memory Cards/);
  assert.match(conversationMemoryCards, /Resume continuity/);
  assert.match(conversationMemoryCards, /Obsidian as working memory/);
  assert.match(userSignals, /generated_by: automation-os/);
  assert.match(userSignals, /# User Signals/);
  assert.match(userSignals, /Proactive Defaults/);
  assert.match(userSignals, /resume_continuity/);
  assert.match(blockerRadar, /generated_by: automation-os/);
  assert.match(blockerRadar, /# Blocker Radar/);
  assert.match(blockerRadar, /proof_or_readback_missing|source_of_truth_boundary|other/);
  assert.match(successPaths, /generated_by: automation-os/);
  assert.match(successPaths, /# Success Paths/);
  assert.match(successPaths, /Obsidian export run/);
  assert.match(failureFixLog, /generated_by: automation-os/);
  assert.match(failureFixLog, /# Failure Fix Log/);
  assert.match(failureFixLog, /Recent Failures And Fix Targets/);
  assert.match(failureFixLog, /Blocked Obsidian follow-up/);
  assert.match(failureFixLog, /Recent Successful Verifications/);
  assert.doesNotMatch(commandQueueIntake, /これは未分類依頼ではない/);
  assert.doesNotMatch(commandQueueIntake, /research unchecked task should stay out of intake/);
  assert.match(secondBrainIntake, /generated_by: automation-os/);
  assert.match(secondBrainIntake, /read-only classification suggestion/);
  assert.match(secondBrainIntake, /Do not move files/);
  assert.match(secondBrainIntake, /Preserve the source pointer/);
  assert.match(secondBrainIntake, /Raw Codex Request/);
  assert.match(secondBrainIntake, /Article URL/);
  assert.match(secondBrainIntake, /https:\/\/example\.com\/ai-systems/);
  assert.match(secondBrainIntake, /Suggested destination: 06_Research/);
  assert.match(secondBrainIntake, /Approval Required Research/);
  assert.match(secondBrainIntake, /External Required Research/);
  assert.match(secondBrainIntake, /Secret Source/);
  assert.match(secondBrainIntake, /Source URL: https:\/\/\[redacted-auth\]@example\.com\/private\?access_token=\[redacted\]/);
  assert.match(secondBrainIntake, /Source of truth: Bearer \[redacted-token\]/);
  assert.match(secondBrainIntake, /Suggested destination: unknown/);
  assert.match(secondBrainIntake, /frontmatter suggested_destination outside allowlist; kept as unknown/);
  assert.match(secondBrainIntake, /Source pointer to preserve: https:\/\/\[redacted-auth\]@example\.com\/private\?access_token=\[redacted\]/);
  assert.doesNotMatch(secondBrainIntake, /\.\.\/\.\.\/Secrets/);
  assert.doesNotMatch(secondBrainIntake, /user:pass/);
  assert.doesNotMatch(secondBrainIntake, /N9sK2LmP8qRwT5yUi3OpAzXcVbNmQ1We/);
  assert.doesNotMatch(secondBrainIntake, /sk-testsecret1234567890/);
  assert.match(secondBrainIntake, /Loose Thought/);
  assert.match(secondBrainIntake, /Suggested destination: 09_Inbox/);
  assert.doesNotMatch(secondBrainIntake, /Research Capture/);
  assert.doesNotMatch(secondBrainIntake, /Generated Inbox Helper/);
  assert.match(secondBrainAutoProcessor, /generated_by: automation-os/);
  assert.match(secondBrainAutoProcessor, /kind: second-brain-auto-processor/);
  assert.match(secondBrainAutoProcessor, /auto_approval_boundary: obsidian_internal_only/);
  assert.match(secondBrainAutoProcessor, /approval_mode: auto_obsidian_internal/);
  assert.match(secondBrainAutoProcessor, /Capture -> Normalize -> Classify -> Distill -> Draft -> Link -> Review Digest/);
  assert.match(secondBrainAutoProcessor, /## Auto-approved internal operations/);
  assert.match(secondBrainAutoProcessor, /## Billing-only hard stops/);
  assert.match(secondBrainAutoProcessor, /## Queue/);
  assert.match(secondBrainAutoProcessor, /Source redaction: enabled/);
  assert.match(secondBrainAutoProcessor, /Destination allowlist: 05_Projects, 06_Research, 07_Decisions, 08_Runbooks, 09_Inbox, unknown/);
  assert.match(secondBrainAutoProcessor, /Raw Codex Request/);
  assert.match(secondBrainAutoProcessor, /Review Ready Candidate[\s\S]*processing_status: review_ready/);
  assert.match(secondBrainAutoProcessor, /Approval Required Research[\s\S]*suggested_destination: 06_Research/);
  assert.match(secondBrainAutoProcessor, /Approval Required Research[\s\S]*external_action_required: true/);
  assert.match(secondBrainAutoProcessor, /Approval Required Research[\s\S]*approval_required: true/);
  assert.match(secondBrainAutoProcessor, /External Required Research[\s\S]*suggested_destination: 06_Research/);
  assert.match(secondBrainAutoProcessor, /External Required Research[\s\S]*external_action_required: true/);
  assert.match(secondBrainAutoProcessor, /External Required Research[\s\S]*approval_required: false/);
  assert.match(secondBrainAutoProcessor, /Secret Source/);
  assert.match(secondBrainAutoProcessor, /source_url: https:\/\/\[redacted-auth\]@example\.com\/private\?access_token=\[redacted\]/);
  assert.match(secondBrainAutoProcessor, /source_of_truth: Bearer \[redacted-token\]/);
  assert.match(secondBrainAutoProcessor, /suggested_destination: unknown/);
  assert.match(secondBrainAutoProcessor, /external_action_required: true/);
  assert.doesNotMatch(secondBrainAutoProcessor, /\.\.\/\.\.\/Secrets/);
  assert.doesNotMatch(secondBrainAutoProcessor, /user:pass/);
  assert.doesNotMatch(secondBrainAutoProcessor, /N9sK2LmP8qRwT5yUi3OpAzXcVbNmQ1We/);
  assert.doesNotMatch(secondBrainAutoProcessor, /sk-testsecret1234567890/);
  assert.match(activeSessions, /generated_by: automation-os/);
  assert.match(activeSessions, /# Active Sessions/);
  assert.match(activeSessions, /## session_11/);
  assert.match(activeSessions, /CWD: \/tmp\/unrelated-global-latest/);
  assert.match(activeSessions, /## 019eb511-0e2c-71a0-ba4b-aaee602a347a/);
  assert.match(activeSessions, /rollout-2026-06-11T10-20-30-019eb511-0e2c-71a0-ba4b-aaee602a347a\.jsonl/);
  assert.doesNotMatch(activeSessions, /## \[redacted-token\]/);
  assert.doesNotMatch(activeSessions, /rollout-2026-06-11T10-20-30-\[redacted-token\]\.jsonl/);
  assert.match(activeSessions, /\[redacted-token\]/);
  assert.match(activeSessions, /\[redacted-auth\]/);
  assert.match(activeSessions, /AWS_SECRET_ACCESS_KEY=\[redacted\]/);
  assert.match(activeSessions, /\[redacted-jwt\]/);
  assert.match(activeSessions, /sessionid=\[redacted-session\]/);
  assert.doesNotMatch(activeSessions, /sk-testsecret1234567890/);
  assert.doesNotMatch(activeSessions, /verysecret/);
  assert.doesNotMatch(activeSessions, /supersecret/);
  assert.doesNotMatch(activeSessions, /AbCdEfGhIjKlMnOpQrStUvWxYz123456/);
  assert.doesNotMatch(activeSessions, /eyJhbGciOiJIUzI1Ni/);
  assert.doesNotMatch(activeSessions, /abc123secretvalue/);
  assert.doesNotMatch(activeSessions, /^## session_0$/m);
  assert.doesNotMatch(activeSessions, /^## session_1$/m);
  assert.match(codexAppParityLedger, /generated_by: automation-os/);
  assert.match(codexAppParityLedger, /# Codex App Parity Ledger/);
  assert.match(codexAppParityLedger, /Skills \/ Plugins \/ Automations/);
  assert.match(codexAppParityLedger, /Protected external actions/);
  assert.match(codexAppParityLedger, /blocked_by_executor/);
  assert.match(
    codexAppParityLedger,
    /id=bridge_exec_obsidian, capability_id=chrome_authenticated_action, status=blocked, executor_status=not_connected, receipt=missing/
  );
  assert.match(codexAppParityLedger, /Git \/ terminal \/ worktree \/ cloud threads \/ Computer Use \/ IDE sync/);
  assert.match(codexAppParityLedger, /read-only audit rows first/);
  assert.match(codexAppParityLedger, /not executor connections/);
  assert.match(codexAppParityLedger, /gap/);
  assert.doesNotMatch(codexAppParityLedger, /Home, Sources, generated vault notes/);
  assert.match(skillRegistry, /generated_by: automation-os/);
  assert.match(skillRegistry, /# Skill Registry/);
  assert.match(skillRegistry, /codex_skill: 1/);
  assert.match(skillRegistry, /agent_skill: 1/);
  assert.match(skillRegistry, /### Obsidian Sync/);
  assert.match(skillRegistry, /ID: skill:obsidian-sync/);
  assert.match(skillRegistry, /Status: read_only_indexed/);
  assert.match(skillRegistry, /Path: `~\/codex-skills\/obsidian-sync`/);
  assert.match(skillRegistry, /### Daily Runner/);
  assert.match(skillRegistry, /ID: skill:daily-runner/);
  assert.match(skillRegistry, /Path: `~\/agent-skills\/daily-runner`/);
  assert.match(skillRegistry, /\[\[Automation Control Panel\]\]/);
  assert.match(projectMemoryMap, /generated_by: automation-os/);
  assert.match(projectMemoryMap, /# Project Memory Map/);
  assert.match(projectMemoryMap, /Obsidianはcontrol surface/);
  assert.match(projectMemoryMap, /execution source of truthはSTATE\/artifacts\/skills\/docs\/db/);
  assert.match(projectMemoryMap, new RegExp(`### ${join(process.cwd(), "apps", "server").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(projectMemoryMap, /Session count: 2/);
  assert.match(projectMemoryMap, /Latest session id: 019eb511-0e2c-71a0-ba4b-aaee602a347a/);
  assert.match(projectMemoryMap, /rollout-2026-06-11T10-20-30-019eb511-0e2c-71a0-ba4b-aaee602a347a\.jsonl/);
  assert.match(projectMemoryMap, /### \/tmp\/unrelated-global-latest/);
  assert.match(projectMemoryMap, /Latest session id: session_11/);
  assert.match(projectMemoryMap, /### demo-automation/);
  assert.match(projectMemoryMap, /Path: `.*demo-automation\/automation\.toml`/);
  assert.match(projectMemoryMap, /Memory hints: .*demo-automation/);
  assert.equal(projectMemoryMap.split("\n").some((line) => line.startsWith("- Memory hints:") && line.includes(currentProjectRoot)), true);
  assert.match(projectMemoryMap, /\[redacted-token\]/);
  assert.match(projectMemoryMap, /\[redacted-auth\]/);
  assert.doesNotMatch(projectMemoryMap, /supersecret/);
  assert.doesNotMatch(projectMemoryMap, /sk-testsecret1234567890/);
  assert.match(decisionLog, /generated_by: automation-os/);
  assert.match(decisionLog, /run_obsidian/);
  assert.match(decisionLog, /CodexにWeekly Reviewから改善案を作らせる/);
  assert.doesNotMatch(decisionLog, /これは未分類依頼ではない/);
  assert.doesNotMatch(decisionLog, /research unchecked task should stay out of intake/);
  assert.match(weeklyReview, /generated_by: automation-os/);
  assert.match(weeklyReview, /Runs updated in 7 days: 1/);
  assert.match(weeklyReview, /Open command queue items: 2/);
  assert.match(weeklyReview, /Obsidian x Codex self score: `2\/5`/);
  assert.match(weeklyReview, /Weekly fix: focus on レビューと改善 only\./);
  assert.match(weeklyReview, /Obsidian Autonomy Ops Memo/);
  assert.match(weeklyReview, /Obsidian x Codex Weekly Check/);
  assert.doesNotMatch(weeklyReview, /これは未分類依頼ではない/);
  assert.doesNotMatch(weeklyReview, /research unchecked task should stay out of intake/);
  assert.match(secondBrainWeeklyDigest, /generated_by: automation-os/);
  assert.match(secondBrainWeeklyDigest, /# Second Brain Weekly Digest/);
  assert.match(secondBrainWeeklyDigest, /does not canonicalize notes/);
  assert.match(secondBrainWeeklyDigest, /Unclassified count: 3/);
  assert.match(secondBrainWeeklyDigest, /preserve source pointer: https:\/\/\[redacted-auth\]@example\.com\/private\?access_token=\[redacted\]/);
  assert.match(secondBrainWeeklyDigest, /source_of_truth=Bearer \[redacted-token\]/);
  assert.match(secondBrainWeeklyDigest, /09_Inbox: \[\[09_Inbox\/Research Capture\|Research Capture\]\] \| kind=research/);
  assert.doesNotMatch(secondBrainWeeklyDigest, /\.\.\/\.\.\/Secrets/);
  assert.doesNotMatch(secondBrainWeeklyDigest, /user:pass/);
  assert.doesNotMatch(secondBrainWeeklyDigest, /N9sK2LmP8qRwT5yUi3OpAzXcVbNmQ1We/);
  assert.doesNotMatch(secondBrainWeeklyDigest, /sk-testsecret1234567890/);
  assert.doesNotMatch(secondBrainWeeklyDigest, /Generated Inbox Helper/);
  assert.equal(result.orientationFiles.length, 5);
  assert.ok(result.orientationFiles.some((file) => file.endsWith(join("05_Projects", "Project Index.md"))));
  assert.ok(result.orientationFiles.some((file) => file.endsWith(join("07_Decisions", "Decision Index.md"))));
  assert.ok(result.orientationFiles.some((file) => file.endsWith(join("09_Inbox", "Inbox Index.md"))));
  assert.equal(result.templateFiles.length, 8);
  assert.ok(result.templateFiles.some((file) => file.endsWith(join("90_Templates", "project-note.md"))));
  assert.ok(result.templateFiles.some((file) => file.endsWith(join("90_Templates", "daily-url-capture.md"))));
  assert.ok(result.templateFiles.some((file) => file.endsWith(join("90_Templates", "thought-capture.md"))));
  assert.ok(result.templateFiles.some((file) => file.endsWith(join("90_Templates", "article-memo.md"))));
  assert.match(projectIndex, /generated_by: automation-os/);
  assert.match(projectIndex, /Demo Project/);
  assert.match(projectIndex, /local test fixture/);
  assert.match(projectIndex, /Nested Project Index/);
  assert.match(projectIndex, /nested handwritten note/);
  assert.doesNotMatch(projectIndex, /Hidden Template/);
  assert.doesNotMatch(projectIndex, /Generated Helper/);
  assert.match(projectTemplate, /generated_by: automation-os/);
  assert.match(projectTemplate, /template_kind: project/);
  assert.match(projectTemplate, /auto_process: obsidian_internal_only/);
  assert.match(projectTemplate, /progressive_summary: ""/);
  assert.match(projectTemplate, /External action required: false/);
  assert.match(dailyUrlTemplate, /template_kind: inbox/);
  assert.match(dailyUrlTemplate, /Source URL/);
  assert.match(dailyUrlTemplate, /Auto process: obsidian_internal_only/);
  assert.match(dailyUrlTemplate, /Unresolved question:/);
  assert.match(thoughtTemplate, /template_kind: inbox/);
  assert.match(thoughtTemplate, /Capture type: thought/);
  assert.match(thoughtTemplate, /approval_required: false/);
  assert.match(articleTemplate, /template_kind: research/);
  assert.match(articleTemplate, /Suggested destination: 06_Research/);
  assert.match(articleTemplate, /Next use:/);

  writeFileSync(join(docsDir, "09-local-worker.md"), "# Local Worker\n\nUpdated.");
  obsidian.exportObsidianVault({ vaultPath, docsDir });
  const backupDirs = readdirSync(join(result.outputDir, ".backups"));
  assert.ok(backupDirs.length > 0);
  assert.ok(existsSync(join(result.outputDir, ".backups", backupDirs[0], "Runs.md")));
  if (previousAutomationsRoot === undefined) {
    delete process.env.AUTOMATION_OS_CODEX_AUTOMATIONS_ROOT;
  } else {
    process.env.AUTOMATION_OS_CODEX_AUTOMATIONS_ROOT = previousAutomationsRoot;
  }
  if (previousCapabilitiesHome === undefined) {
    delete process.env.AUTOMATION_OS_CAPABILITIES_HOME;
  } else {
    process.env.AUTOMATION_OS_CAPABILITIES_HOME = previousCapabilitiesHome;
  }
  if (previousCodexSkillRoots === undefined) {
    delete process.env.AUTOMATION_OS_CODEX_SKILL_ROOTS;
  } else {
    process.env.AUTOMATION_OS_CODEX_SKILL_ROOTS = previousCodexSkillRoots;
  }
  if (previousAgentSkillRoots === undefined) {
    delete process.env.AUTOMATION_OS_AGENT_SKILL_ROOTS;
  } else {
    process.env.AUTOMATION_OS_AGENT_SKILL_ROOTS = previousAgentSkillRoots;
  }
});

test("exportObsidianVault prunes old generated timestamp backups without deleting manual backups", () => {
  db.initDb();
  db.resetDemoData();
  const previousRetentionCount = process.env.AUTOMATION_OS_OBSIDIAN_BACKUP_RETENTION_COUNT;
  process.env.AUTOMATION_OS_OBSIDIAN_BACKUP_RETENTION_COUNT = "2";
  try {
    const docsDir = join(tempRoot, "backup-retention-docs");
    const vaultPath = join(tempRoot, "Backup Retention Vault");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "10-obsidian-export.md"), "# Obsidian export\n");

    const result = obsidian.exportObsidianVault({ vaultPath, docsDir, codexSessionsDir: join(tempRoot, "missing-retention-sessions") });
    const backupRoot = join(result.outputDir, ".backups");
    for (const timestamp of ["2026-01-01T00-00-00.000Z", "2026-01-02T00-00-00.000Z", "2026-01-03T00-00-00.000Z"]) {
      mkdirSync(join(backupRoot, timestamp), { recursive: true });
      writeFileSync(join(backupRoot, timestamp, "Runs.md"), "---\ngenerated_by: automation-os\n---\n\n# Runs\n");
    }
    mkdirSync(join(backupRoot, "manual-cleanup", "20260616T000000Z-root-files"), { recursive: true });
    writeFileSync(join(backupRoot, "manual-cleanup", "20260616T000000Z-root-files", "note.md"), "manual backup\n");
    mkdirSync(join(backupRoot, "2026-01-04T00-00-00.000Z"), { recursive: true });
    writeFileSync(join(backupRoot, "2026-01-04T00-00-00.000Z", "Runs.md"), "# handwritten backup\n");
    mkdirSync(join(backupRoot, "2026-01-05T00-00-00.000Z"), { recursive: true });
    writeFileSync(join(backupRoot, "2026-01-05T00-00-00.000Z", "Runs.md"), "# generated_by: automation-os\n\n# Comment-only Markdown backup\n");

    const refreshed = obsidian.exportObsidianVault({ vaultPath, docsDir, codexSessionsDir: join(tempRoot, "missing-retention-sessions") });

    assert.equal(refreshed.backupRetention?.keepCount, 2);
    assert.ok(refreshed.backupRetention?.prunedDirs.some((dir) => dir.endsWith("2026-01-01T00-00-00.000Z")));
    assert.ok(refreshed.backupRetention?.prunedDirs.some((dir) => dir.endsWith("2026-01-02T00-00-00.000Z")));
    assert.equal(existsSync(join(backupRoot, "2026-01-01T00-00-00.000Z")), false);
    assert.equal(existsSync(join(backupRoot, "2026-01-02T00-00-00.000Z")), false);
    assert.equal(existsSync(join(backupRoot, "2026-01-03T00-00-00.000Z")), true);
    assert.equal(existsSync(join(backupRoot, "2026-01-04T00-00-00.000Z")), true);
    assert.equal(existsSync(join(backupRoot, "2026-01-05T00-00-00.000Z")), true);
    assert.equal(existsSync(join(backupRoot, "manual-cleanup", "20260616T000000Z-root-files", "note.md")), true);
    assert.ok(refreshed.backupRetention?.skippedDirs.some((dir) => dir.endsWith("manual-cleanup")));
    assert.ok(refreshed.backupRetention?.skippedDirs.some((dir) => dir.endsWith("2026-01-04T00-00-00.000Z")));
    assert.ok(refreshed.backupRetention?.skippedDirs.some((dir) => dir.endsWith("2026-01-05T00-00-00.000Z")));
  } finally {
    if (previousRetentionCount === undefined) {
      delete process.env.AUTOMATION_OS_OBSIDIAN_BACKUP_RETENTION_COUNT;
    } else {
      process.env.AUTOMATION_OS_OBSIDIAN_BACKUP_RETENTION_COUNT = previousRetentionCount;
    }
  }
});

test("exportObsidianVault keeps superseded partial runs in history but out of resume attention", () => {
  db.initDb();
  db.resetDemoData();
  const docsDir = join(tempRoot, "superseded-docs");
  const vaultPath = join(tempRoot, "Superseded Vault");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "10-obsidian-export.md"), "# Obsidian export\n");

  db.insert("runs", {
    id: "run_old_partial",
    name: "Codexでdocs/10-obsidian-export.md存在確認のみ。存在したら1文で終了。",
    status: "partial",
    objective: "Codexでdocs/10-obsidian-export.md存在確認のみ。存在したら1文で終了。",
    created_at: "2026-06-12T13:16:00.000Z",
    updated_at: "2026-06-12T13:16:25.000Z",
    metadata_json: {
      proof_summary: "partial: executable Codex proof captured, but receipt-only worker steps still need actual execution or manual verification"
    }
  });
  db.insert("runs", {
    id: "run_later_complete",
    name: "Codexでdocs/10-obsidian-export.md存在確認のみ",
    status: "complete",
    objective: "Codexでdocs/10-obsidian-export.md存在確認のみ",
    created_at: "2026-06-12T13:17:00.000Z",
    updated_at: "2026-06-12T13:17:56.000Z",
    metadata_json: {
      proof_summary: "complete: executable worker finished"
    }
  });

  const result = obsidian.exportObsidianVault({ vaultPath, docsDir, codexSessionsDir: join(tempRoot, "missing-sessions") });
  const runs = readFileSync(join(result.outputDir, "Runs.md"), "utf8");
  const resumeCurrentWork = readFileSync(join(vaultPath, "00_Start Here", "Resume Current Work.md"), "utf8");
  const weeklyReview = readFileSync(join(vaultPath, "00_Start Here", "Weekly Review.md"), "utf8");
  const dailyBrief = readFileSync(join(vaultPath, "00_Start Here", "Codex Daily Brief.md"), "utf8");
  const actionQueue = readFileSync(join(vaultPath, "01_Control Panel", "Action Queue.md"), "utf8");

  assert.match(runs, /run_old_partial/);
  assert.match(runs, /run_later_complete/);
  assert.match(resumeCurrentWork, /Latest run: \[\[Runs#run_later_complete\|Codexでdocs\/10-obsidian-export\.md存在確認のみ\]\] \(complete/);
  assert.match(resumeCurrentWork, /Resume candidate: none/);
  assert.doesNotMatch(resumeCurrentWork, /run_old_partial/);
  assert.doesNotMatch(resumeCurrentWork, /Resume from \[\[Runs#run_old_partial/);
  assert.doesNotMatch(weeklyReview, /run_old_partial/);
  assert.doesNotMatch(dailyBrief, /Run attention: \[\[Runs#run_old_partial/);
  assert.doesNotMatch(actionQueue, /run_old_partial/);
  assert.doesNotMatch(actionQueue, /run_later_complete/);
});

test("exportObsidianVault hides read-only docs existence partials superseded by equivalent complete runs", () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM runs;");
  const docsDir = join(tempRoot, "readonly-existence-docs");
  const vaultPath = join(tempRoot, "Readonly Existence Vault");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "09-local-worker.md"), "# Local worker\n");

  db.insert("runs", {
    id: "run_mqaq5jp2_c9tryo",
    name: "Codexでread-only確認: docs/09-local-worker.mdの存在だけを確認し、1文で終了。新しいcodex execは禁止。ファイル変更禁止。",
    status: "partial",
    objective: "Codexでread-only確認: docs/09-local-worker.mdの存在だけを確認し、1文で終了。新しいcodex execは禁止。ファイル変更禁止。",
    created_at: "2026-06-12T09:28:00.000Z",
    updated_at: "2026-06-12T09:29:56.513Z",
    metadata_json: {
      proof_summary: "partial: executable Codex proof captured, but receipt-only worker steps still need actual execution or manual verification"
    }
  });
  db.insert("runs", {
    id: "run_mqaq1rbu_kvdkqz",
    name: "CodexでAutomation OS docs/09-local-worker.mdをread-only確認",
    status: "blocked",
    objective: "CodexでAutomation OS docs/09-local-worker.mdをread-only確認",
    created_at: "2026-06-12T09:26:04.698Z",
    updated_at: "2026-06-12T09:28:05.966Z",
    metadata_json: {
      proof_summary: "blocked: codex read-only execution did not complete"
    }
  });
  db.insert("runs", {
    id: "run_mqaybgak_wq8t3d",
    name: "Codexでdocs/09-local-worker.md存在確認のみ",
    status: "complete",
    objective: "Codexでdocs/09-local-worker.md存在確認のみ",
    created_at: "2026-06-12T13:17:00.000Z",
    updated_at: "2026-06-12T13:17:56.614Z",
    metadata_json: {
      proof_summary: "complete: executable worker finished"
    }
  });

  const result = obsidian.exportObsidianVault({ vaultPath, docsDir, codexSessionsDir: join(tempRoot, "missing-readonly-sessions") });
  const runs = readFileSync(join(result.outputDir, "Runs.md"), "utf8");
  const resumeCurrentWork = readFileSync(join(vaultPath, "00_Start Here", "Resume Current Work.md"), "utf8");
  const dailyBrief = readFileSync(join(vaultPath, "00_Start Here", "Codex Daily Brief.md"), "utf8");
  const weeklyReview = readFileSync(join(vaultPath, "00_Start Here", "Weekly Review.md"), "utf8");
  const actionQueue = readFileSync(join(vaultPath, "01_Control Panel", "Action Queue.md"), "utf8");

  assert.match(runs, /run_mqaq5jp2_c9tryo/);
  assert.match(runs, /run_mqaq1rbu_kvdkqz/);
  assert.match(runs, /run_mqaybgak_wq8t3d/);
  assert.match(resumeCurrentWork, /Resume candidate: none/);
  assert.doesNotMatch(resumeCurrentWork, /run_mqaq5jp2_c9tryo/);
  assert.doesNotMatch(resumeCurrentWork, /run_mqaq1rbu_kvdkqz/);
  assert.doesNotMatch(dailyBrief, /run_mqaq5jp2_c9tryo/);
  assert.doesNotMatch(dailyBrief, /run_mqaq1rbu_kvdkqz/);
  assert.doesNotMatch(weeklyReview, /run_mqaq5jp2_c9tryo/);
  assert.doesNotMatch(weeklyReview, /run_mqaq1rbu_kvdkqz/);
  assert.doesNotMatch(actionQueue, /run_mqaq5jp2_c9tryo/);
  assert.doesNotMatch(actionQueue, /run_mqaq1rbu_kvdkqz/);
});

test("exportObsidianVault keeps historical receipt-only demo runs in history but out of current attention", () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM runs;");
  const docsDir = join(tempRoot, "historical-demo-docs");
  const vaultPath = join(tempRoot, "Historical Demo Vault");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "09-local-worker.md"), "# Local worker\n");

  db.insert("runs", {
    id: "run_mqap1z4i_wks1og",
    name: "Codex read-only demo 3: Automation OS local worker receipt proofを確認",
    status: "partial",
    objective: "Codex read-only demo 3: Automation OS local worker receipt proofを確認",
    created_at: "2026-06-12T08:58:15.186Z",
    updated_at: "2026-06-12T08:58:15.853Z",
    metadata_json: {
      worker_mode: "receipt_only",
      proof_gate: { ok: false, missing: ["actual_execution_or_manual_verification"], present: ["worker_receipt"] },
      proof_summary: "partial: worker receipts captured, actual execution is not verified"
    }
  });
  db.insert("runs", {
    id: "run_real_receipt_partial",
    name: "Real receipt-only work",
    status: "partial",
    objective: "Real receipt-only work",
    created_at: "2026-06-12T09:00:00.000Z",
    updated_at: "2026-06-12T09:00:00.000Z",
    metadata_json: {
      worker_mode: "receipt_only",
      proof_gate: { ok: false, missing: ["actual_execution_or_manual_verification"], present: ["worker_receipt"] },
      proof_summary: "partial: worker receipts captured, actual execution is not verified"
    }
  });

  const result = obsidian.exportObsidianVault({ vaultPath, docsDir, codexSessionsDir: join(tempRoot, "missing-demo-sessions") });
  const runs = readFileSync(join(result.outputDir, "Runs.md"), "utf8");
  const resumeCurrentWork = readFileSync(join(vaultPath, "00_Start Here", "Resume Current Work.md"), "utf8");
  const dailyBrief = readFileSync(join(vaultPath, "00_Start Here", "Codex Daily Brief.md"), "utf8");
  const actionQueue = readFileSync(join(vaultPath, "01_Control Panel", "Action Queue.md"), "utf8");

  assert.match(runs, /run_mqap1z4i_wks1og/);
  assert.match(resumeCurrentWork, /run_real_receipt_partial/);
  assert.doesNotMatch(resumeCurrentWork, /run_mqap1z4i_wks1og/);
  assert.doesNotMatch(dailyBrief, /run_mqap1z4i_wks1og/);
  assert.doesNotMatch(actionQueue, /run_mqap1z4i_wks1og/);
});

test("exportObsidianVault keeps receipt-only QA and suppressed historical gaps out of resume and action queue", () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM runs;");
  const docsDir = join(tempRoot, "receipt-qa-gap-docs");
  const vaultPath = join(tempRoot, "Receipt QA Gap Vault");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "10-obsidian-export.md"), "# Obsidian export\n");

  db.insert("runs", {
    id: "run_mqfzf01a_gisjyh",
    name: "QA unique create command 1781574418874",
    status: "partial",
    objective: "QA unique create command 1781574418874",
    created_at: "2026-06-16T01:47:10.000Z",
    updated_at: "2026-06-16T01:47:10.635Z",
    metadata_json: {
      worker_mode: "receipt_only",
      proof_gate: { ok: false, missing: ["actual_execution_or_manual_verification"], present: ["worker_receipt"] },
      proof_summary: "partial: worker receipts captured, actual execution is not verified"
    }
  });
  db.insert("runs", {
    id: "run_local_worker_receipt_gap",
    name: "毎日の作業を相談しながら自動化したい",
    status: "partial",
    objective: "毎日の作業を相談しながら自動化したい",
    created_at: "2026-06-16T01:45:00.000Z",
    updated_at: "2026-06-16T01:45:00.000Z",
    metadata_json: {
      worker_mode: "receipt_only",
      plan: {
        tasks: [{ adapter: "local_worker", resources: ["local_worker"] }],
        lanes: [{ role: "Local Worker", resourceLocks: ["local_worker"] }]
      },
      resume_suppressed: true,
      proof_gate: { ok: false, missing: ["actual_execution_or_manual_verification"], present: ["worker_receipt"] },
      proof_summary: "partial: worker receipts captured, actual execution is not verified"
    }
  });
  db.insert("runs", {
    id: "run_real_receipt_partial",
    name: "Real receipt-only work",
    status: "partial",
    objective: "Real receipt-only work",
    created_at: "2026-06-16T01:40:00.000Z",
    updated_at: "2026-06-16T01:40:00.000Z",
    metadata_json: {
      worker_mode: "receipt_only",
      proof_gate: { ok: false, missing: ["actual_execution_or_manual_verification"], present: ["worker_receipt"] },
      proof_summary: "partial: worker receipts captured, actual execution is not verified"
    }
  });

  const result = obsidian.exportObsidianVault({ vaultPath, docsDir, codexSessionsDir: join(tempRoot, "missing-qa-gap-sessions") });
  const runs = readFileSync(join(result.outputDir, "Runs.md"), "utf8");
  const resumeCurrentWork = readFileSync(join(vaultPath, "00_Start Here", "Resume Current Work.md"), "utf8");
  const actionQueue = readFileSync(join(vaultPath, "01_Control Panel", "Action Queue.md"), "utf8");

  assert.match(runs, /run_mqfzf01a_gisjyh/);
  assert.match(runs, /run_local_worker_receipt_gap/);
  assert.match(resumeCurrentWork, /run_real_receipt_partial/);
  assert.doesNotMatch(resumeCurrentWork, /Resume candidate: \[\[Runs#run_mqfzf01a_gisjyh/);
  assert.doesNotMatch(resumeCurrentWork, /Resume from \[\[Runs#run_mqfzf01a_gisjyh/);
  assert.doesNotMatch(resumeCurrentWork, /Resume candidate: \[\[Runs#run_local_worker_receipt_gap/);
  assert.doesNotMatch(resumeCurrentWork, /Resume from \[\[Runs#run_local_worker_receipt_gap/);
  assert.doesNotMatch(actionQueue, /run_mqfzf01a_gisjyh/);
  assert.doesNotMatch(actionQueue, /run_local_worker_receipt_gap/);
  assert.match(actionQueue, /run_real_receipt_partial/);
});

test("exportObsidianVault keeps queued cancelled and complete history out of resume action surfaces", () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM runs;");
  const docsDir = join(tempRoot, "action-queue-history-docs");
  const vaultPath = join(tempRoot, "Action Queue History Vault");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "10-obsidian-export.md"), "# Obsidian export\n");

  db.insert("runs", {
    id: "run_queued_qa_history",
    name: "Queued QA history should stay historical",
    status: "queued",
    objective: "Queued QA history should stay historical",
    created_at: "2026-06-16T01:00:00.000Z",
    updated_at: "2026-06-16T01:00:00.000Z",
    metadata_json: {
      proof_summary: "queued: QA run was never started"
    }
  });
  db.insert("runs", {
    id: "run_cancelled_nisenprints_history",
    name: "Cancelled NisenPrints history should stay historical",
    status: "cancelled",
    objective: "Cancelled NisenPrints history should stay historical",
    created_at: "2026-06-16T01:05:00.000Z",
    updated_at: "2026-06-16T01:05:00.000Z",
    metadata_json: {
      proof_summary: "cancelled: duplicate NisenPrints lane"
    }
  });
  db.insert("runs", {
    id: "run_complete_history",
    name: "Complete history should stay historical",
    status: "complete",
    objective: "Complete history should stay historical",
    created_at: "2026-06-16T01:10:00.000Z",
    updated_at: "2026-06-16T01:10:00.000Z",
    metadata_json: {
      proof_summary: "complete: executable worker finished"
    }
  });
  db.insert("runs", {
    id: "run_blocked_current_action",
    name: "Blocked current action",
    status: "blocked",
    objective: "Blocked current action",
    created_at: "2026-06-16T01:15:00.000Z",
    updated_at: "2026-06-16T01:15:00.000Z",
    metadata_json: {
      proof_summary: "blocked: exact blocker needs review"
    }
  });
  db.insert("runs", {
    id: "run_partial_stale_detail_current_action",
    name: "Daily AI stale detail should not leak in resume action queue",
    status: "partial",
    objective: "Daily AI current action with superseded detail",
    created_at: "2026-06-16T01:14:00.000Z",
    updated_at: "2026-06-16T01:14:00.000Z",
    metadata_json: {
      proof_summary: "partial: ship_now_buffer_below_target:2/3; runway_mcp_workspace_limit"
    }
  });

  const result = obsidian.exportObsidianVault({ vaultPath, docsDir, codexSessionsDir: join(tempRoot, "missing-action-queue-history-sessions") });
  const runs = readFileSync(join(result.outputDir, "Runs.md"), "utf8");
  const resumeCurrentWork = readFileSync(join(vaultPath, "00_Start Here", "Resume Current Work.md"), "utf8");
  const actionQueue = readFileSync(join(vaultPath, "01_Control Panel", "Action Queue.md"), "utf8");

  assert.match(runs, /run_queued_qa_history/);
  assert.match(runs, /run_cancelled_nisenprints_history/);
  assert.match(runs, /run_complete_history/);
  assert.match(runs, /run_blocked_current_action/);
  assert.match(runs, /run_partial_stale_detail_current_action/);
  assert.match(resumeCurrentWork, /run_blocked_current_action/);
  assert.match(resumeCurrentWork, /## Current Action Queue/);
  const resumeActionQueueSection = resumeCurrentWork.split("## Current Action Queue")[1]?.split("## Auto Resume Triggers")[0] ?? "";
  assert.match(resumeActionQueueSection, /run_partial_stale_detail_current_action/);
  assert.doesNotMatch(resumeActionQueueSection, /ship_now_buffer_below_target:2\/3/);
  assert.doesNotMatch(resumeActionQueueSection, /runway_mcp_workspace_limit/);
  assert.doesNotMatch(resumeCurrentWork, /run_queued_qa_history/);
  assert.doesNotMatch(resumeCurrentWork, /run_cancelled_nisenprints_history/);
  assert.doesNotMatch(resumeCurrentWork, /run_complete_history/);
  assert.match(actionQueue, /run_blocked_current_action/);
  assert.doesNotMatch(actionQueue, /run_queued_qa_history/);
  assert.doesNotMatch(actionQueue, /run_cancelled_nisenprints_history/);
  assert.doesNotMatch(actionQueue, /run_complete_history/);
});

test("exportObsidianVault does not turn resume-suppressed receipt-only verification gaps into next resume move", () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM runs; DELETE FROM bridge_executions;");
  const docsDir = join(tempRoot, "receipt-gap-next-move-docs");
  const vaultPath = join(tempRoot, "Receipt Gap Next Move Vault");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "10-obsidian-export.md"), "# Obsidian export\n");

  db.insert("runs", {
    id: "run_local_worker_receipt_gap_only",
    name: "毎日の作業を相談しながら自動化したい",
    status: "partial",
    objective: "毎日の作業を相談しながら自動化したい",
    created_at: "2026-06-16T01:45:00.000Z",
    updated_at: "2026-06-16T01:45:00.000Z",
    metadata_json: {
      worker_mode: "receipt_only",
      plan: {
        tasks: [{ adapter: "local_worker", resources: ["local_worker"] }],
        lanes: [{ role: "Local Worker", resourceLocks: ["local_worker"] }]
      },
      resume_suppressed: true,
      proof_gate: { ok: false, missing: ["actual_execution_or_manual_verification"], present: ["worker_receipt"] },
      proof_summary: "partial: worker receipts captured, actual execution is not verified"
    }
  });

  obsidian.exportObsidianVault({ vaultPath, docsDir, codexSessionsDir: join(tempRoot, "missing-gap-next-move-sessions") });
  const resumeCurrentWork = readFileSync(join(vaultPath, "00_Start Here", "Resume Current Work.md"), "utf8");
  const actionQueue = readFileSync(join(vaultPath, "01_Control Panel", "Action Queue.md"), "utf8");

  assert.match(resumeCurrentWork, /Resume candidate: none/);
  assert.match(resumeCurrentWork, /No current resume candidate/);
  assert.doesNotMatch(resumeCurrentWork, /Latest run is partial/);
  assert.doesNotMatch(resumeCurrentWork, /Resume from \[\[Runs#run_local_worker_receipt_gap_only/);
  assert.doesNotMatch(actionQueue, /run_local_worker_receipt_gap_only/);
});

test("exportObsidianVault refuses to overwrite non-generated notes", () => {
  const docsDir = join(tempRoot, "guarded-docs");
  const vaultPath = join(tempRoot, "Guarded Vault");
  const outputDir = join(vaultPath, "02_Systems", "automation-os");
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(docsDir, "06-control-panel.md"), "# Control Panel\n");
  writeFileSync(join(outputDir, "Runs.md"), "---\nsystem: personal\n---\n\n# Hand written note\n");

  assert.throws(() => obsidian.exportObsidianVault({ vaultPath, docsDir }), /Refusing to overwrite non-generated/);
});

test("exportObsidianVault does not promote unrelated Codex sessions into resume brief", () => {
  const docsDir = join(tempRoot, "unrelated-session-docs");
  const vaultPath = join(tempRoot, "Unrelated Session Vault");
  const codexSessionsDir = join(tempRoot, "unrelated-codex-sessions");
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(join(codexSessionsDir, "2026", "06", "11"), { recursive: true });
  writeFileSync(join(docsDir, "06-control-panel.md"), "# Control Panel\n");
  const sessionPath = join(codexSessionsDir, "2026", "06", "11", "rollout-global-latest.jsonl");
  writeFileSync(
    sessionPath,
    [
      JSON.stringify({ session_meta: { payload: { id: "global_latest", cwd: "/tmp/other-project" } } }),
      JSON.stringify({ type: "response_item", item: { type: "message", role: "user", content: [{ type: "input_text", text: "Unrelated latest work" }] } })
    ].join("\n")
  );

  obsidian.exportObsidianVault({ vaultPath, docsDir, codexSessionsDir });
  const resumeCurrentWork = readFileSync(join(vaultPath, "00_Start Here", "Resume Current Work.md"), "utf8");
  const projectMemoryMap = readFileSync(join(vaultPath, "00_Start Here", "Project Memory Map.md"), "utf8");
  const activeSessions = readFileSync(join(vaultPath, "01_Control Panel", "Active Sessions.md"), "utf8");

  assert.match(resumeCurrentWork, /Latest Codex session: none \(no current-project Codex session found/);
  assert.doesNotMatch(resumeCurrentWork, /Latest Codex session: global_latest/);
  assert.match(projectMemoryMap, /# Project Memory Map/);
  assert.match(projectMemoryMap, /### \/tmp\/other-project/);
  assert.match(projectMemoryMap, /Latest session id: global_latest/);
  assert.match(activeSessions, /## global_latest/);
});

test("Codex App Parity Ledger keeps the latest blocked Browser Use proof visible", () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM system_checks; DELETE FROM bridge_executions;");
  const docsDir = join(tempRoot, "ledger-browser-use-docs");
  const vaultPath = join(tempRoot, "Ledger Browser Use Vault");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "06-control-panel.md"), "# Control Panel\n");

  db.insert("system_checks", {
    id: "browser_use_old_ok",
    kind: "browser_use_check",
    status: "ok",
    target_url: "http://127.0.0.1:5173/#sources",
    summary: "Older Browser Use proof should not win",
    artifact_uri: "file:///tmp/browser-use-old.png",
    created_at: "2026-06-12T00:00:00.000Z",
    metadata_json: {
      metadata: {
        driver: "browser_use_cli",
        cleanup: { status: "ok", reason: "unique_session_closed" }
      }
    }
  });
  db.insert("system_checks", {
    id: "browser_use_latest_blocked",
    kind: "browser_use_check",
    status: "blocked",
    target_url: "http://127.0.0.1:5173/#sources",
    summary: "Browser Use cleanup failed",
    artifact_uri: "file:///tmp/browser-use-blocked.png",
    created_at: "2026-06-12T01:00:00.000Z",
    metadata_json: {
      metadata: {
        driver: "browser_use_cli",
        cleanup: { status: "blocked", reason: "close_failed" }
      }
    }
  });

  obsidian.exportObsidianVault({ vaultPath, docsDir });
  const ledger = readFileSync(join(vaultPath, "01_Control Panel", "Codex App Parity Ledger.md"), "utf8");

  assert.match(
    ledger,
    /Browser Use local screen checks \| Sources, system_checks, Browser Use result panel \| blocked \| .*id=browser_use_latest_blocked/
  );
  assert.match(ledger, /cleanup\.status=blocked/);
  assert.match(ledger, /cleanup\.reason=close_failed/);
  assert.doesNotMatch(ledger, /Browser Use local screen checks \| .*covered_local/);
});

test("Codex App Parity Ledger promotes only completed connected protected executions", () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM system_checks; DELETE FROM bridge_actions; DELETE FROM bridge_executions;");
  const docsDir = join(tempRoot, "ledger-protected-docs");
  const vaultPath = join(tempRoot, "Ledger Protected Vault");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "06-control-panel.md"), "# Control Panel\n");

  db.insert("bridge_executions", {
    id: "protected_old_blocked",
    capability_id: "chrome_authenticated_action",
    approval_id: "approval_old",
    status: "blocked",
    executor_status: "not_connected",
    summary: "Old blocked execution should not win",
    created_at: "2026-06-12T00:00:00.000Z",
    updated_at: "2026-06-12T00:00:00.000Z",
    metadata_json: { policyDecision: "blocked" }
  });
  db.insert("bridge_executions", {
    id: "protected_latest_completed",
    capability_id: "chrome_authenticated_action",
    approval_id: "approval_completed",
    status: "completed",
    executor_status: "connected",
    summary: "Executor completed the protected action",
    created_at: "2026-06-12T01:00:00.000Z",
    updated_at: "2026-06-12T01:05:00.000Z",
    metadata_json: { receipt: "receipt://protected/latest" }
  });

  obsidian.exportObsidianVault({ vaultPath, docsDir });
  const ledger = readFileSync(join(vaultPath, "01_Control Panel", "Codex App Parity Ledger.md"), "utf8");

  assert.match(
    ledger,
    /Protected external actions \| Approvals, Trusted Bridge executor ledger \| covered \| .*id=protected_latest_completed/
  );
  assert.match(ledger, /executor_status=connected/);
  assert.match(ledger, /receipt=receipt:\/\/protected\/latest/);
  assert.match(ledger, /updated_at=2026-06-12T01:05:00\.000Z/);
  assert.doesNotMatch(ledger, /Protected external actions \| .*blocked_by_executor/);
});

test("Codex App Parity Ledger does not promote safe or receiptless executor executions", () => {
  db.initDb();
  db.resetDemoData();
  db.execSql("DELETE FROM system_checks; DELETE FROM bridge_actions; DELETE FROM bridge_executions;");
  const docsDir = join(tempRoot, "ledger-protected-negative-docs");
  const vaultPath = join(tempRoot, "Ledger Protected Negative Vault");
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, "06-control-panel.md"), "# Control Panel\n");

  db.insert("bridge_executions", {
    id: "protected_missing_receipt",
    capability_id: "chrome_authenticated_action",
    approval_id: "approval_missing_receipt",
    status: "completed",
    executor_status: "connected",
    summary: "Executor claims completion but did not store a receipt",
    created_at: "2026-06-12T01:00:00.000Z",
    updated_at: "2026-06-12T01:05:00.000Z",
    metadata_json: { note: "missing completion receipt" }
  });
  db.insert("bridge_executions", {
    id: "safe_completed_connected",
    capability_id: "local_browser_check",
    approval_id: null,
    status: "completed",
    executor_status: "connected",
    summary: "Safe local capability should not satisfy protected external actions",
    created_at: "2026-06-12T02:00:00.000Z",
    updated_at: "2026-06-12T02:05:00.000Z",
    metadata_json: { receipt: "receipt://safe/latest" }
  });

  obsidian.exportObsidianVault({ vaultPath, docsDir });
  const ledger = readFileSync(join(vaultPath, "01_Control Panel", "Codex App Parity Ledger.md"), "utf8");

  assert.match(
    ledger,
    /Protected external actions \| Approvals, Trusted Bridge executor ledger \| blocked_by_executor \| .*id=protected_missing_receipt/
  );
  assert.match(ledger, /receipt=missing/);
  assert.doesNotMatch(ledger, /Protected external actions \| .*id=safe_completed_connected/);
  assert.doesNotMatch(ledger, /Protected external actions \| .*covered \|/);
});

test("exportObsidianVault refuses to overwrite non-generated control panel note", () => {
  const docsDir = join(tempRoot, "guarded-control-docs");
  const vaultPath = join(tempRoot, "Guarded Control Vault");
  const controlPanelDir = join(vaultPath, "01_Control Panel");
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(controlPanelDir, { recursive: true });
  writeFileSync(join(docsDir, "06-control-panel.md"), "# Control Panel\n");
  writeFileSync(join(controlPanelDir, "Automation Control Panel.md"), "---\nsystem: personal\n---\n\n# Hand written note\n");

  assert.throws(() => obsidian.exportObsidianVault({ vaultPath, docsDir }), /Refusing to overwrite non-generated/);
});

test("exportObsidianVault refuses to overwrite non-generated mission control notes", () => {
  const docsDir = join(tempRoot, "guarded-mission-docs");
  const vaultPath = join(tempRoot, "Guarded Mission Vault");
  const startHereDir = join(vaultPath, "00_Start Here");
  const controlPanelDir = join(vaultPath, "01_Control Panel");
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(startHereDir, { recursive: true });
  mkdirSync(controlPanelDir, { recursive: true });
  writeFileSync(join(docsDir, "06-control-panel.md"), "# Control Panel\n");
  writeFileSync(join(startHereDir, "Codex Daily Brief.md"), "# generated_by: automation-os\n\n# Comment-only daily brief\n");
  assert.throws(() => obsidian.exportObsidianVault({ vaultPath, docsDir }), /Refusing to overwrite non-generated/);

  writeFileSync(join(startHereDir, "Codex Daily Brief.md"), "---\nsystem: personal\n---\n\n# Hand written daily brief\n");
  assert.throws(() => obsidian.exportObsidianVault({ vaultPath, docsDir }), /Refusing to overwrite non-generated/);
  assert.equal(existsSync(join(controlPanelDir, "Command Queue.md")), false);

  writeFileSync(join(startHereDir, "Codex Daily Brief.md"), "---\ngenerated_by: automation-os\n---\n\n# Generated daily brief\n");
  writeFileSync(join(startHereDir, "Resume Current Work.md"), "---\nsystem: personal\n---\n\n# Hand written resume\n");
  assert.throws(() => obsidian.exportObsidianVault({ vaultPath, docsDir }), /Refusing to overwrite non-generated/);

  writeFileSync(join(startHereDir, "Resume Current Work.md"), "---\ngenerated_by: automation-os\n---\n\n# Generated resume\n");
  writeFileSync(join(startHereDir, "Resume Contract.md"), "---\nsystem: personal\n---\n\n# Hand written resume contract\n");
  assert.throws(() => obsidian.exportObsidianVault({ vaultPath, docsDir }), /Refusing to overwrite non-generated/);

  writeFileSync(join(startHereDir, "Resume Contract.md"), "---\ngenerated_by: automation-os\n---\n\n# Generated resume contract\n");
  writeFileSync(join(startHereDir, "Project Memory Map.md"), "---\nsystem: personal\n---\n\n# Hand written memory map\n");
  assert.throws(() => obsidian.exportObsidianVault({ vaultPath, docsDir }), /Refusing to overwrite non-generated/);

  writeFileSync(join(startHereDir, "Project Memory Map.md"), "---\ngenerated_by: automation-os\n---\n\n# Generated memory map\n");
  writeFileSync(join(controlPanelDir, "Action Queue.md"), "---\nsystem: personal\n---\n\n# Hand written action queue\n");
  assert.throws(() => obsidian.exportObsidianVault({ vaultPath, docsDir }), /Refusing to overwrite non-generated/);

  writeFileSync(join(controlPanelDir, "Action Queue.md"), "---\ngenerated_by: automation-os\n---\n\n# Generated action queue\n");
  writeFileSync(join(controlPanelDir, "Active Sessions.md"), "---\nsystem: personal\n---\n\n# Hand written sessions\n");
  assert.throws(() => obsidian.exportObsidianVault({ vaultPath, docsDir }), /Refusing to overwrite non-generated/);

  writeFileSync(join(controlPanelDir, "Active Sessions.md"), "---\ngenerated_by: automation-os\n---\n\n# Generated sessions\n");
  writeFileSync(join(controlPanelDir, "Skill Registry.md"), "---\nsystem: personal\n---\n\n# Hand written skill registry\n");
  assert.throws(() => obsidian.exportObsidianVault({ vaultPath, docsDir }), /Refusing to overwrite non-generated/);

  writeFileSync(join(controlPanelDir, "Skill Registry.md"), "---\ngenerated_by: automation-os\n---\n\n# Generated skill registry\n");
  writeFileSync(join(controlPanelDir, "Codex App Parity Ledger.md"), "---\nsystem: personal\n---\n\n# Hand written parity ledger\n");
  assert.throws(() => obsidian.exportObsidianVault({ vaultPath, docsDir }), /Refusing to overwrite non-generated/);
});

test("exportObsidianVault refuses to overwrite non-generated Second Brain notes", () => {
  const docsDir = join(tempRoot, "guarded-second-brain-docs");
  const vaultPath = join(tempRoot, "Guarded Second Brain Vault");
  const startHereDir = join(vaultPath, "00_Start Here");
  const controlPanelDir = join(vaultPath, "01_Control Panel");
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(startHereDir, { recursive: true });
  mkdirSync(controlPanelDir, { recursive: true });
  writeFileSync(join(docsDir, "06-control-panel.md"), "# Control Panel\n");
  writeFileSync(join(controlPanelDir, "Second Brain Intake.md"), "---\nsystem: personal\n---\n\n# Hand written second brain intake\n");
  assert.throws(() => obsidian.exportObsidianVault({ vaultPath, docsDir }), /Refusing to overwrite non-generated/);

  writeFileSync(join(controlPanelDir, "Second Brain Intake.md"), "---\ngenerated_by: automation-os\n---\n\n# Generated second brain intake\n");
  writeFileSync(join(controlPanelDir, "Second Brain Auto Processor.md"), "---\nsystem: personal\n---\n\n# Hand written second brain processor\n");
  assert.throws(() => obsidian.exportObsidianVault({ vaultPath, docsDir }), /Refusing to overwrite non-generated/);

  writeFileSync(join(controlPanelDir, "Second Brain Auto Processor.md"), "---\ngenerated_by: automation-os\n---\n\n# Generated second brain processor\n");
  writeFileSync(join(startHereDir, "Second Brain Weekly Digest.md"), "---\nsystem: personal\n---\n\n# Hand written second brain digest\n");
  assert.throws(() => obsidian.exportObsidianVault({ vaultPath, docsDir }), /Refusing to overwrite non-generated/);
});

test("exportObsidianVault refuses to overwrite non-generated proof inbox and dashboards", () => {
  const docsDir = join(tempRoot, "guarded-dashboard-docs");
  const vaultPath = join(tempRoot, "Guarded Dashboard Vault");
  const proofDir = join(vaultPath, "04_Proof Pointers");
  const dashboardDir = join(vaultPath, "10_Dashboards");
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(proofDir, { recursive: true });
  mkdirSync(dashboardDir, { recursive: true });
  writeFileSync(join(docsDir, "06-control-panel.md"), "# Control Panel\n");
  writeFileSync(join(proofDir, "Proof Inbox.md"), "---\nsystem: personal\n---\n\n# Hand written proof inbox\n");
  assert.throws(() => obsidian.exportObsidianVault({ vaultPath, docsDir }), /Refusing to overwrite non-generated/);

  writeFileSync(join(proofDir, "Proof Inbox.md"), "---\ngenerated_by: automation-os\n---\n\n# Generated proof inbox\n");
  writeFileSync(join(dashboardDir, "Automation Dashboard.base"), "filters:\n  and: []\n");
  assert.throws(() => obsidian.exportObsidianVault({ vaultPath, docsDir }), /Refusing to overwrite non-generated/);

  writeFileSync(join(dashboardDir, "Automation Dashboard.base"), "# generated_by: automation-os\nfilters:\n  and: []\n");
  writeFileSync(join(dashboardDir, "Second Brain Review.base"), "filters:\n  and: []\n");
  assert.throws(() => obsidian.exportObsidianVault({ vaultPath, docsDir }), /Refusing to overwrite non-generated/);
});

test("exportObsidianVault refuses to overwrite non-generated orientation index", () => {
  const docsDir = join(tempRoot, "guarded-orientation-docs");
  const vaultPath = join(tempRoot, "Guarded Orientation Vault");
  const projectsDir = join(vaultPath, "05_Projects");
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(projectsDir, { recursive: true });
  writeFileSync(join(docsDir, "06-control-panel.md"), "# Control Panel\n");
  writeFileSync(join(projectsDir, "Project Index.md"), "---\nsystem: personal\n---\n\n# Hand written note\n");

  assert.throws(() => obsidian.exportObsidianVault({ vaultPath, docsDir }), /Refusing to overwrite non-generated/);
});

test("exportObsidianVault refuses to overwrite non-generated generated template", () => {
  const docsDir = join(tempRoot, "guarded-template-docs");
  const vaultPath = join(tempRoot, "Guarded Template Vault");
  const templateDir = join(vaultPath, "90_Templates");
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(join(docsDir, "06-control-panel.md"), "# Control Panel\n");
  writeFileSync(join(templateDir, "project-note.md"), "---\nsystem: personal\n---\n\n# Hand written template\n");

  assert.throws(() => obsidian.exportObsidianVault({ vaultPath, docsDir }), /Refusing to overwrite non-generated/);
});

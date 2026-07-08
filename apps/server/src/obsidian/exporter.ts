import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getCodexCapabilities } from "../codex/capabilities.js";
import { buildCodexAppParityLedgerItems, type CodexAppParityLedgerItem } from "../codex/parityLedger.js";
import { querySql } from "../db/client.js";
import { buildResumeContract, renderResumeContractMarkdown, resolveResumeContractPath, writeResumeContract } from "../resumeContract.js";
import { selectActionQueueRuns, selectAttentionRuns, selectResumeCandidateRun } from "../runs/selectors.js";
import { auditProjects, writeProjectAuditStatus, type ProjectAuditItem, type ProjectAuditResult } from "../projects/projectAuditor.js";
import { defaultObsidianVaultPath, resolveConfiguredObsidianVaultPath } from "./vaultGuard.js";

const defaultOutputSubdir = join("02_Systems", "automation-os");
const defaultStartHereSubdir = "00_Start Here";
const defaultControlPanelSubdir = "01_Control Panel";
const defaultProofPointerSubdir = "04_Proof Pointers";
const defaultDashboardSubdir = "10_Dashboards";
const controlPanelFilename = "Automation Control Panel.md";
const todayFilename = "Today.md";
const dailyBriefFilename = "Codex Daily Brief.md";
const projectCockpitFilename = "Project Cockpit.md";
const resumeCurrentWorkFilename = "Resume Current Work.md";
const resumeContractFilename = "Resume Contract.md";
const resumeContractJsonFilename = "resume-contract.json";
const actionQueueFilename = "Action Queue.md";
const commandQueueFilename = "Command Queue.md";
const commandQueueIntakeFilename = "Command Queue Intake.md";
const secondBrainIntakeFilename = "Second Brain Intake.md";
const secondBrainAutoProcessorFilename = "Second Brain Auto Processor.md";
const secondBrainWeeklyDigestFilename = "Second Brain Weekly Digest.md";
const secondBrainReviewBaseFilename = "Second Brain Review.base";
const defaultGeneratedBackupRetentionCount = 10;
const protectedBackupDirectoryNames = new Set(["manual-cleanup", "second-brain-processor"]);
const activeSessionsFilename = "Active Sessions.md";
const conversationMemoryCardsFilename = "Conversation Memory Cards.md";
const userSignalsFilename = "User Signals.md";
const skillRegistryFilename = "Skill Registry.md";
const codexAppParityLedgerFilename = "Codex App Parity Ledger.md";
const projectMemoryMapFilename = "Project Memory Map.md";
const decisionLogFilename = "Decision Log.md";
const failureFixLogFilename = "Failure Fix Log.md";
const weeklyReviewFilename = "Weekly Review.md";
const proofInboxFilename = "Proof Inbox.md";
const projectHealthFilename = "Project Health.md";
const blockerRadarFilename = "Blocker Radar.md";
const successPathsFilename = "Success Paths.md";
const projectActionQueueFilename = "Project Action Queue.md";
const runLedgerFilename = "Run Ledger.md";
const approvalLedgerFilename = "Approval Ledger.md";
const dashboardBases = [
  { filename: "Automation Dashboard.base", title: "Automation Dashboard", folder: "02_Automations" },
  { filename: "Action Queue.base", title: "Action Queue", folder: "01_Control Panel" },
  { filename: "Proof Dashboard.base", title: "Proof Dashboard", folder: "04_Proof Pointers" },
  { filename: "Decision Dashboard.base", title: "Decision Dashboard", folder: "07_Decisions" },
  { filename: secondBrainReviewBaseFilename, title: "Second Brain Review", folder: "09_Inbox" }
];
const orientationIndexes = [
  { subdir: "05_Projects", filename: "Project Index.md", title: "Project Index", description: "Codex app work units and current project notes." },
  { subdir: "06_Research", filename: "Research Index.md", title: "Research Index", description: "Research notes, comparisons, source captures, and unresolved questions." },
  { subdir: "07_Decisions", filename: "Decision Index.md", title: "Decision Index", description: "Short decision records for Codex app, automations, projects, and workflow choices." },
  { subdir: "08_Runbooks", filename: "Runbook Index.md", title: "Runbook Index", description: "Human-readable recovery and repeatable operation procedures." },
  { subdir: "09_Inbox", filename: "Inbox Index.md", title: "Inbox Index", description: "Temporary capture area for unsorted notes before Codex classifies them." }
];
const secondBrainDestinationAllowlist = new Set(["05_Projects", "06_Research", "07_Decisions", "08_Runbooks", "09_Inbox", "unknown"]);
const orientationTemplates = [
  {
    filename: "project-note.md",
    title: "Project Note Template",
    kind: "project",
    body: [
      "# {{title}}",
      "",
      "- Status: active",
      "- Auto process: obsidian_internal_only",
      "- Processing status: draft",
      "- Progressive summary: ",
      "- Distillation: ",
      "- Next use: ",
      "- Unresolved question: ",
      "- Review cycle: weekly",
      "- External action required: false",
      "- Approval required: false",
      "- Source of truth: ",
      "- Next action: ",
      "- Blocker: none"
    ].join("\n")
  },
  {
    filename: "research-note.md",
    title: "Research Note Template",
    kind: "research",
    body: [
      "# {{title}}",
      "",
      "- Question: ",
      "- Sources: ",
      "- Auto process: obsidian_internal_only",
      "- Processing status: draft",
      "- Progressive summary: ",
      "- Distillation: ",
      "- Next use: ",
      "- Unresolved question: ",
      "- Review cycle: weekly",
      "- External action required: false",
      "- Approval required: false",
      "- Current answer: ",
      "- Unresolved: "
    ].join("\n")
  },
  {
    filename: "decision-record.md",
    title: "Decision Record Template",
    kind: "decision",
    body: [
      "# {{title}}",
      "",
      "- Decision: ",
      "- Reason: ",
      "- Auto process: obsidian_internal_only",
      "- Processing status: draft",
      "- Progressive summary: ",
      "- Distillation: ",
      "- Next use: ",
      "- Unresolved question: ",
      "- Review cycle: monthly",
      "- External action required: false",
      "- Approval required: false",
      "- Revisit when: ",
      "- Source of truth impact: "
    ].join("\n")
  },
  {
    filename: "runbook.md",
    title: "Runbook Template",
    kind: "runbook",
    body: [
      "# {{title}}",
      "",
      "- Scope: ",
      "- Preconditions: ",
      "- Auto process: obsidian_internal_only",
      "- Processing status: draft",
      "- Progressive summary: ",
      "- Distillation: ",
      "- Next use: ",
      "- Unresolved question: ",
      "- Review cycle: monthly",
      "- External action required: false",
      "- Approval required: false",
      "- Steps: ",
      "- Stop condition: ",
      "- Proof to capture: "
    ].join("\n")
  },
  {
    filename: "inbox-capture.md",
    title: "Inbox Capture Template",
    kind: "inbox",
    body: [
      "# {{title}}",
      "",
      "- Captured from: ",
      "- Needs classification: yes",
      "- Auto process: obsidian_internal_only",
      "- Processing status: captured",
      "- Progressive summary: ",
      "- Distillation: ",
      "- Next use: ",
      "- Unresolved question: ",
      "- Review cycle: weekly",
      "- External action required: false",
      "- Approval required: false",
      "- Suggested destination: ",
      "- Source of truth: unknown"
    ].join("\n")
  },
  {
    filename: "daily-url-capture.md",
    title: "Daily URL Capture Template",
    kind: "inbox",
    body: [
      "# {{title}}",
      "",
      "- Source URL: ",
      "- Capture type: url",
      "- Needs classification: yes",
      "- Auto process: obsidian_internal_only",
      "- Processing status: captured",
      "- Progressive summary: ",
      "- Distillation: ",
      "- Next use: ",
      "- Unresolved question: ",
      "- Review cycle: weekly",
      "- External action required: false",
      "- Approval required: false",
      "- Suggested destination: 09_Inbox",
      "- Source of truth: source_url",
      "",
      "## Note",
      "",
      "- Why it matters: ",
      "- Keep for review: yes"
    ].join("\n")
  },
  {
    filename: "thought-capture.md",
    title: "Thought Capture Template",
    kind: "inbox",
    body: [
      "# {{title}}",
      "",
      "- Capture type: thought",
      "- Needs classification: yes",
      "- Auto process: obsidian_internal_only",
      "- Processing status: captured",
      "- Progressive summary: ",
      "- Distillation: ",
      "- Next use: ",
      "- Unresolved question: ",
      "- Review cycle: weekly",
      "- External action required: false",
      "- Approval required: false",
      "- Suggested destination: 09_Inbox",
      "- Source of truth: handwritten note",
      "",
      "## Thought",
      "",
      ""
    ].join("\n")
  },
  {
    filename: "article-memo.md",
    title: "Article Memo Template",
    kind: "research",
    body: [
      "# {{title}}",
      "",
      "- Source URL: ",
      "- Capture type: article",
      "- Source of truth: source_url",
      "- Auto process: obsidian_internal_only",
      "- Processing status: draft",
      "- Progressive summary: ",
      "- Distillation: ",
      "- Next use: ",
      "- Unresolved question: ",
      "- Review cycle: weekly",
      "- External action required: false",
      "- Approval required: false",
      "- Suggested destination: 06_Research",
      "",
      "## Summary",
      "",
      "- Key point: ",
      "- Open question: ",
      "- Revisit when: "
    ].join("\n")
  }
];

type RunRow = {
  id: string;
  name: string;
  status: string;
  objective: string;
  created_at: string;
  updated_at: string;
  metadata_json: string;
};

type ProofRow = {
  id: string;
  run_id: string;
  proof_type: string;
  label: string;
  uri: string;
  size_bytes: number;
  created_at: string;
  metadata_json: string;
};

type DocRow = {
  file: string;
  title: string;
  body: string;
};

type SystemCheckRow = {
  id: string;
  kind: string;
  status: string;
  target_url: string | null;
  summary: string;
  artifact_uri: string | null;
  created_at: string;
  metadata_json: string;
};

type BridgeActionRow = {
  id: string;
  capability_id: string;
  label: string;
  status: string;
  risk_level: string;
  target: string | null;
  summary: string;
  created_at: string;
  metadata_json: string;
};

type BridgeExecutionRow = {
  id: string;
  capability_id: string;
  approval_id: string | null;
  status: string;
  executor_status: string;
  summary: string;
  created_at: string;
  updated_at: string;
  metadata_json: string;
};

type KnowledgeNoteRow = {
  id: string;
  note_type: string;
  title: string;
  body: string;
  tags_json: string;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: string;
};

type ResearchPlanRow = {
  id: string;
  title: string;
  status: string;
  command: string;
  sources_json: string;
  visible_flow_json: string;
  source_of_truth_json: string;
  proof_boundary_json: string;
  approval_boundary_json: string;
  metadata_json: string;
  demo_check_id: string | null;
  run_id: string | null;
  created_at: string;
  updated_at: string;
};

type VaultNoteRow = {
  file: string;
  title: string;
  kind: string;
  status: string;
  updated: string;
  sourceOfTruth: string;
};

type CommandQueueItem = {
  file: string;
  title: string;
  priority: string;
  status: string;
  command: string;
  sourceOfTruth: string;
  blocker: string;
};

type SecondBrainClassificationCandidate = {
  file: string;
  title: string;
  kind: string;
  status: string;
  processingStatus: string;
  sourceUrl: string;
  captureType: string;
  sourceOfTruth: string;
  suggestedDestination: string;
  externalActionRequired: boolean;
  approvalRequired: boolean;
  reason: string;
  excerpt: string;
};

type SecondBrainDigestNote = {
  file: string;
  title: string;
  folder: string;
  kind: string;
  status: string;
  sourceOfTruth: string;
};

type CodexSessionSummary = {
  file: string;
  sessionId: string;
  mtime: string;
  cwd: string;
  lastUser: string;
  lastAssistant: string;
};

type MemoryProjectHint = {
  path: string;
  note: string;
};

type UserConcernSignal = {
  id: string;
  label: string;
  count: number;
  evidence: string[];
  preferredBehavior: string;
  proactiveDefault: string;
  avoid: string;
};

export type ObsidianExportOptions = {
  vaultPath?: string;
  outputSubdir?: string;
  startHereSubdir?: string;
  controlPanelSubdir?: string;
  proofPointerSubdir?: string;
  dashboardSubdir?: string;
  docsDir?: string;
  codexSessionsDir?: string;
  codexMemoryFile?: string;
  resumeContractPath?: string;
};

export type ObsidianExportResult = {
  vaultPath: string;
  outputDir: string;
  files: string[];
  runs: number;
  proofs: number;
  docs: number;
  controlPanelFile?: string;
  proofInboxFile?: string;
  resumeContractFile?: string;
  resumeContractJsonFile?: string;
  missionFiles: string[];
  secondBrainFiles: string[];
  dashboardFiles: string[];
  orientationFiles: string[];
  templateFiles: string[];
  projectGovernanceFiles?: string[];
  projectAuditStatusFile?: string;
  backupRetention?: ObsidianBackupRetentionSummary;
};

export type ObsidianBackupRetentionSummary = {
  keepCount: number;
  prunedDirs: string[];
  skippedDirs: string[];
};

export function resolveObsidianVaultPath(input?: string): string {
  return resolveConfiguredObsidianVaultPath(input);
}

export function exportObsidianVault(options: ObsidianExportOptions = {}): ObsidianExportResult {
  const vaultPath = resolveObsidianVaultPath(options.vaultPath);
  const startHereSubdir = options.startHereSubdir ?? defaultStartHereSubdir;
  const outputDir = join(vaultPath, options.outputSubdir ?? defaultOutputSubdir);
  const startHereDir = join(vaultPath, startHereSubdir);
  const controlPanelDir = join(vaultPath, options.controlPanelSubdir ?? defaultControlPanelSubdir);
  const proofPointerDir = join(vaultPath, options.proofPointerSubdir ?? defaultProofPointerSubdir);
  const dashboardDir = join(vaultPath, options.dashboardSubdir ?? defaultDashboardSubdir);
  const docsDir = options.docsDir ?? resolve(process.cwd(), "docs");
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(startHereDir, { recursive: true });
  mkdirSync(controlPanelDir, { recursive: true });
  mkdirSync(proofPointerDir, { recursive: true });
  mkdirSync(dashboardDir, { recursive: true });
  for (const index of orientationIndexes) {
    mkdirSync(join(vaultPath, index.subdir), { recursive: true });
  }
  const templateDir = join(vaultPath, "90_Templates");
  mkdirSync(templateDir, { recursive: true });

  const runs = querySql<RunRow>("SELECT * FROM runs ORDER BY created_at DESC LIMIT 200");
  const proofs = querySql<ProofRow>("SELECT * FROM proofs ORDER BY created_at DESC LIMIT 500");
  const checks = querySql<SystemCheckRow>("SELECT * FROM system_checks ORDER BY created_at DESC LIMIT 20");
  const bridgeActions = querySql<BridgeActionRow>("SELECT * FROM bridge_actions ORDER BY created_at DESC LIMIT 50");
  const bridgeExecutions = querySql<BridgeExecutionRow>("SELECT * FROM bridge_executions ORDER BY created_at DESC LIMIT 50");
  const knowledgeNotes = querySql<KnowledgeNoteRow>("SELECT * FROM knowledge_notes ORDER BY updated_at DESC LIMIT 100");
  const researchPlans = querySql<ResearchPlanRow>("SELECT * FROM research_plans ORDER BY updated_at DESC LIMIT 20");
  const docs = readDocs(docsDir);
  const capabilities = getCodexCapabilities();
  const codexSessions = readCodexSessions(options.codexSessionsDir);
  const memoryHints = readMemoryProjectHints(options.codexMemoryFile);
  const exportTimestamp = new Date().toISOString();
  const resumeContractJsonPath = resolveExportResumeContractPath(vaultPath, startHereSubdir, options.resumeContractPath);
  const resumeContract = buildResumeContract({
    vaultPath,
    startHereSubdir,
    contractPath: resumeContractJsonPath,
    codexMemoryFile: options.codexMemoryFile,
    generatedAt: exportTimestamp
  });
  const projectAudit = auditProjects({ obsidianVaultPath: vaultPath, generatedAt: exportTimestamp });
  const projectAuditStatusFile = writeProjectAuditStatus(projectAudit);
  const filenames = ["Automation OS Index.md", "Runs.md", "Proofs.md", "Knowledge.md", "Docs.md", runLedgerFilename];
  assertGeneratedTargets(outputDir, filenames);
  assertGeneratedTargets(startHereDir, [
    todayFilename,
    dailyBriefFilename,
    projectCockpitFilename,
    resumeCurrentWorkFilename,
    resumeContractFilename,
    projectMemoryMapFilename,
    weeklyReviewFilename,
    secondBrainWeeklyDigestFilename
  ]);
  assertGeneratedTargets(controlPanelDir, [
    controlPanelFilename,
    actionQueueFilename,
    commandQueueIntakeFilename,
    projectActionQueueFilename,
    approvalLedgerFilename,
    conversationMemoryCardsFilename,
    userSignalsFilename,
    secondBrainIntakeFilename,
    secondBrainAutoProcessorFilename,
    activeSessionsFilename,
    skillRegistryFilename,
    codexAppParityLedgerFilename
  ]);
  assertGeneratedTargets(join(vaultPath, "07_Decisions"), [decisionLogFilename, failureFixLogFilename]);
  assertGeneratedTargets(proofPointerDir, [proofInboxFilename]);
  assertGeneratedTargets(dashboardDir, [...dashboardBases.map((base) => base.filename), projectHealthFilename, blockerRadarFilename, successPathsFilename]);
  for (const index of orientationIndexes) {
    assertGeneratedTargets(join(vaultPath, index.subdir), [index.filename]);
  }
  assertGeneratedTargets(templateDir, orientationTemplates.map((template) => template.filename));

  ensureCommandQueueSeed(controlPanelDir);
  const commandQueue = readCommandQueue(vaultPath);
  const secondBrainCandidates = readSecondBrainClassificationCandidates(vaultPath);
  const secondBrainDigestNotes = readSecondBrainDigestNotes(vaultPath);
  const resumeContractJsonFile = writeResumeContract(resumeContract, resumeContractJsonPath);

  const files = [
    writeMarkdown(
      outputDir,
      "Automation OS Index.md",
      renderIndex({ runs, proofs, docs, checks, bridgeActions, bridgeExecutions, knowledgeNotes, generatedAt: exportTimestamp }),
      exportTimestamp
    ),
    writeMarkdown(outputDir, "Runs.md", renderRuns(runs, proofs), exportTimestamp),
    writeMarkdown(outputDir, "Proofs.md", renderProofs(proofs, runs), exportTimestamp),
    writeMarkdown(outputDir, "Knowledge.md", renderKnowledge({ bridgeActions, bridgeExecutions, knowledgeNotes, checks }), exportTimestamp),
    writeMarkdown(outputDir, "Docs.md", renderDocs(docs), exportTimestamp),
    writeMarkdown(outputDir, runLedgerFilename, renderRunLedger({ runs, proofs, bridgeExecutions, generatedAt: exportTimestamp }), exportTimestamp)
  ];
  const controlPanelFile = writeMarkdown(
    controlPanelDir,
    controlPanelFilename,
    renderAutomationControlPanel({
      automations: capabilities.capabilities.automations,
      roots: capabilities.roots,
      researchPlans,
      generatedAt: exportTimestamp
    }),
    exportTimestamp
  );
  const proofInboxFile = writeMarkdown(
    proofPointerDir,
    proofInboxFilename,
    renderProofInbox({ runs, proofs, bridgeExecutions, generatedAt: exportTimestamp }),
    exportTimestamp
  );
  const missionFiles = [
    writeMarkdown(
      startHereDir,
      todayFilename,
      renderTodayDashboard({
        runs,
        proofs,
        checks,
        bridgeExecutions,
        commandQueue,
        projectAudit,
        codexSessions,
        generatedAt: exportTimestamp
      }),
      exportTimestamp
    ),
    writeMarkdown(
      startHereDir,
      dailyBriefFilename,
      renderCodexDailyBrief({
        runs,
        proofs,
        checks,
        bridgeExecutions,
        automations: capabilities.capabilities.automations,
        commandQueue,
        researchPlans,
        generatedAt: exportTimestamp
      }),
      exportTimestamp
    ),
    writeMarkdown(
      startHereDir,
      projectCockpitFilename,
      renderProjectCockpit({ projectAudit, runs, proofs, commandQueue, codexSessions, memoryHints, generatedAt: exportTimestamp }),
      exportTimestamp
    ),
    writeMarkdown(
      controlPanelDir,
      actionQueueFilename,
      renderActionQueue({
        runs,
        proofs,
        bridgeExecutions,
        automations: capabilities.capabilities.automations,
        commandQueue,
        generatedAt: exportTimestamp
      }),
      exportTimestamp
    ),
    writeMarkdown(
      controlPanelDir,
      projectActionQueueFilename,
      renderProjectActionQueue({ projectAudit, generatedAt: exportTimestamp }),
      exportTimestamp
    ),
    writeMarkdown(
      controlPanelDir,
      approvalLedgerFilename,
      renderApprovalLedger({ projectAudit, bridgeExecutions, generatedAt: exportTimestamp }),
      exportTimestamp
    ),
    writeMarkdown(
      controlPanelDir,
      commandQueueIntakeFilename,
      renderCommandQueueIntake({ commandQueue, generatedAt: exportTimestamp }),
      exportTimestamp
    ),
    writeMarkdown(
      startHereDir,
      resumeCurrentWorkFilename,
      renderResumeCurrentWork({
        runs,
        checks,
        bridgeActions,
        bridgeExecutions,
        knowledgeNotes,
        codexSessions,
        generatedAt: exportTimestamp
      }),
      exportTimestamp
    ),
    writeMarkdown(startHereDir, resumeContractFilename, renderResumeContractMarkdown(resumeContract), exportTimestamp),
    writeMarkdown(
      controlPanelDir,
      activeSessionsFilename,
      renderActiveSessions({ codexSessions, generatedAt: exportTimestamp }),
      exportTimestamp
    ),
    writeMarkdown(
      controlPanelDir,
      conversationMemoryCardsFilename,
      renderConversationMemoryCards({ codexSessions, memoryHints, knowledgeNotes, generatedAt: exportTimestamp }),
      exportTimestamp
    ),
    writeMarkdown(
      controlPanelDir,
      userSignalsFilename,
      renderUserSignals({ codexSessions, memoryHints, knowledgeNotes, generatedAt: exportTimestamp }),
      exportTimestamp
    ),
    writeMarkdown(
      controlPanelDir,
      skillRegistryFilename,
      renderSkillRegistry({ capabilities, generatedAt: exportTimestamp }),
      exportTimestamp
    ),
    writeMarkdown(
      controlPanelDir,
      codexAppParityLedgerFilename,
      renderCodexAppParityLedger({
        items: buildCodexAppParityLedgerItems({ capabilities, checks, bridgeExecutions }),
        generatedAt: exportTimestamp
      }),
      exportTimestamp
    ),
    writeMarkdown(
      startHereDir,
      projectMemoryMapFilename,
      renderProjectMemoryMap({
        codexSessions,
        automations: capabilities.capabilities.automations,
        memoryHints,
        generatedAt: exportTimestamp
      }),
      exportTimestamp
    ),
    writeMarkdown(
      join(vaultPath, "07_Decisions"),
      decisionLogFilename,
      renderDecisionLog({ runs, bridgeExecutions, commandQueue, generatedAt: exportTimestamp }),
      exportTimestamp
    ),
    writeMarkdown(
      join(vaultPath, "07_Decisions"),
      failureFixLogFilename,
      renderFailureFixLog({ runs, proofs, bridgeExecutions, knowledgeNotes, generatedAt: exportTimestamp }),
      exportTimestamp
    ),
    writeMarkdown(
      startHereDir,
      weeklyReviewFilename,
      renderWeeklyReview({ runs, proofs, bridgeExecutions, commandQueue, generatedAt: exportTimestamp }),
      exportTimestamp
    )
  ];
  const secondBrainFiles = [
    writeMarkdown(
      controlPanelDir,
      secondBrainIntakeFilename,
      renderSecondBrainIntake({ candidates: secondBrainCandidates, generatedAt: exportTimestamp }),
      exportTimestamp
    ),
    writeMarkdown(
      controlPanelDir,
      secondBrainAutoProcessorFilename,
      renderSecondBrainAutoProcessor({ candidates: secondBrainCandidates, generatedAt: exportTimestamp }),
      exportTimestamp
    ),
    writeMarkdown(
      startHereDir,
      secondBrainWeeklyDigestFilename,
      renderSecondBrainWeeklyDigest({
        notes: secondBrainDigestNotes,
        candidates: secondBrainCandidates,
        generatedAt: exportTimestamp
      }),
      exportTimestamp
    )
  ];
  const dashboardFiles = [
    ...dashboardBases.map((base) =>
      writeMarkdown(dashboardDir, base.filename, renderDashboardBase({ ...base, generatedAt: exportTimestamp }), exportTimestamp)
    ),
    writeMarkdown(dashboardDir, blockerRadarFilename, renderBlockerRadar({ runs, bridgeExecutions, projectAudit, generatedAt: exportTimestamp }), exportTimestamp),
    writeMarkdown(dashboardDir, successPathsFilename, renderSuccessPaths({ runs, proofs, knowledgeNotes, generatedAt: exportTimestamp }), exportTimestamp)
  ];
  const projectGovernanceFiles = [
    writeMarkdown(dashboardDir, projectHealthFilename, renderProjectHealth({ projectAudit, generatedAt: exportTimestamp }), exportTimestamp)
  ];
  const orientationFiles = orientationIndexes.map((index) =>
    writeMarkdown(
      join(vaultPath, index.subdir),
      index.filename,
      renderOrientationIndex({
        ...index,
        notes: readVaultNotes(vaultPath, index.subdir, index.filename),
        generatedAt: exportTimestamp
      }),
      exportTimestamp
    )
  );
  const templateFiles = orientationTemplates.map((template) =>
    writeMarkdown(templateDir, template.filename, renderTemplate({ ...template, generatedAt: exportTimestamp }), exportTimestamp)
  );
  const backupRetention = pruneGeneratedBackupRetention([
    ...files,
    controlPanelFile,
    proofInboxFile,
    join(startHereDir, resumeContractFilename),
    resumeContractJsonFile,
    ...missionFiles,
    ...secondBrainFiles,
    ...dashboardFiles,
    ...projectGovernanceFiles,
    ...orientationFiles,
    ...templateFiles
  ]);

  return {
    vaultPath,
    outputDir,
    files,
    runs: runs.length,
    proofs: proofs.length,
    docs: docs.length,
    controlPanelFile,
    proofInboxFile,
    resumeContractFile: join(startHereDir, resumeContractFilename),
    resumeContractJsonFile,
    missionFiles,
    secondBrainFiles,
    dashboardFiles,
    projectGovernanceFiles: [...projectGovernanceFiles, projectAuditStatusFile],
    projectAuditStatusFile,
    orientationFiles,
    templateFiles,
    backupRetention
  };
}

function resolveExportResumeContractPath(vaultPath: string, startHereSubdir: string, resumeContractPath?: string): string {
  if (resumeContractPath || process.env.AUTOMATION_OS_RESUME_CONTRACT_PATH) {
    return resolveResumeContractPath(resumeContractPath);
  }
  if (resolve(vaultPath) === resolve(defaultObsidianVaultPath)) {
    return resolveResumeContractPath();
  }
  return join(vaultPath, startHereSubdir, resumeContractJsonFilename);
}

function assertGeneratedTargets(outputDir: string, filenames: string[]): void {
  for (const filename of filenames) {
    const path = join(outputDir, filename);
    if (!existsSync(path)) continue;
    const existing = readFileSync(path, "utf8");
    if (!hasGeneratedMarkerForFilename(filename, existing)) {
      throw new Error(`Refusing to overwrite non-generated Obsidian file: ${path}`);
    }
  }
}

function writeMarkdown(outputDir: string, filename: string, body: string, exportTimestamp: string): string {
  const path = join(outputDir, filename);
  if (existsSync(path)) {
    const backupDir = join(outputDir, ".backups", safeTimestamp(exportTimestamp));
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(path, join(backupDir, filename));
  }
  const tmpPath = join(outputDir, `.${filename}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, body.endsWith("\n") ? body : `${body}\n`);
  renameSync(tmpPath, path);
  return path;
}

function pruneGeneratedBackupRetention(paths: string[]): ObsidianBackupRetentionSummary {
  const keepCount = generatedBackupRetentionCount();
  const backupRoots = [
    ...new Set(
      paths
        .filter((path): path is string => typeof path === "string" && path.length > 0)
        .map((path) => join(dirname(path), ".backups"))
    )
  ];
  const prunedDirs: string[] = [];
  const skippedDirs: string[] = [];

  for (const backupRoot of backupRoots) {
    if (!existsSync(backupRoot)) continue;
    const candidates: { name: string; path: string }[] = [];
    for (const entry of readdirSync(backupRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(backupRoot, entry.name);
      if (protectedBackupDirectoryNames.has(entry.name)) {
        skippedDirs.push(path);
        continue;
      }
      if (!isGeneratedTimestampBackupDirName(entry.name) || !isGeneratedBackupDir(path)) {
        skippedDirs.push(path);
        continue;
      }
      candidates.push({ name: entry.name, path });
    }

    for (const candidate of candidates.sort((left, right) => right.name.localeCompare(left.name)).slice(keepCount)) {
      rmSync(candidate.path, { recursive: true, force: true });
      prunedDirs.push(candidate.path);
    }
  }

  return { keepCount, prunedDirs, skippedDirs };
}

function generatedBackupRetentionCount(): number {
  const raw = process.env.AUTOMATION_OS_OBSIDIAN_BACKUP_RETENTION_COUNT;
  if (raw === undefined || raw.trim() === "") return defaultGeneratedBackupRetentionCount;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultGeneratedBackupRetentionCount;
  return Math.floor(parsed);
}

function isGeneratedTimestampBackupDirName(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:\.\d{3})?Z$/.test(name);
}

function isGeneratedBackupDir(dir: string): boolean {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  if (files.length === 0 || files.length !== entries.length) return false;
  return files.every((entry) => {
    if (!entry.name.endsWith(".md") && !entry.name.endsWith(".base")) return false;
    return hasGeneratedMarkerForFilename(entry.name, readFileSync(join(dir, entry.name), "utf8"));
  });
}

function renderIndex(input: {
  runs: RunRow[];
  proofs: ProofRow[];
  docs: DocRow[];
  checks: SystemCheckRow[];
  bridgeActions: BridgeActionRow[];
  bridgeExecutions: BridgeExecutionRow[];
  knowledgeNotes: KnowledgeNoteRow[];
  generatedAt: string;
}): string {
  const latestRun = input.runs[0];
  const latestCheck = input.checks[0];
  const statuses = countBy(input.runs, (run) => run.status);
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Automation OS Index",
    "",
    "Automation OS の実行履歴、証拠、設計ドキュメントを LLM が読みやすい形にまとめた入口です。",
    "",
    "## Start Here",
    "",
    "- [[Runs]] - 実行履歴、目的、状態、関連 proof の概要",
    "- [[Proofs]] - DB に保存された evidence receipts の一覧",
    "- [[Knowledge]] - Bridge、UI検証、認証情報再利用方針、運用スナップショット",
    "- [[Docs]] - docs/*.md の内容を1ページに統合した設計知識",
    "",
    "## Current Snapshot",
    "",
    `- Latest run: ${latestRun ? `[[Runs#${anchor(latestRun.id)}|${latestRun.name}]] (${latestRun.status})` : "none"}`,
    `- Runs indexed: ${input.runs.length}`,
    `- Proofs indexed: ${input.proofs.length}`,
    `- Latest browser check: ${latestCheck ? `${latestCheck.status} - ${latestCheck.summary}` : "none"}`,
    `- Bridge actions indexed: ${input.bridgeActions.length}`,
    `- Bridge executions indexed: ${input.bridgeExecutions.length}`,
    `- Knowledge notes indexed: ${input.knowledgeNotes.length}`,
    `- Docs indexed: ${input.docs.length}`,
    `- Status mix: ${Object.entries(statuses)
      .map(([status, count]) => `${status}=${count}`)
      .join(", ") || "none"}`,
    "",
    "## System Checks",
    "",
    ...renderSystemChecks(input.checks.slice(0, 5)),
    "",
    "## LLM Reading Order",
    "",
    "1. [[Automation OS Index]] で現在地を確認する。",
    "2. [[Runs]] で run の目的、状態、metadata summary を読む。",
    "3. [[Proofs]] で証拠URIと run_id の対応を見る。",
    "4. [[Knowledge]] で Trusted Bridge、UI検証、認証情報再利用方針を見る。",
    "5. [[Docs]] で設計上の source of truth と運用ルールを確認する。"
  ].join("\n");
}

function renderSystemChecks(checks: SystemCheckRow[]): string[] {
  if (checks.length === 0) return ["No system checks indexed yet."];
  return checks.flatMap((check) => {
    const metadata = parseJson<Record<string, unknown>>(check.metadata_json, {});
    return [
      `### ${check.id}`,
      "",
      `- Status: ${check.status}`,
      `- Created: ${check.created_at}`,
      `- Target URL: ${check.target_url ?? "none"}`,
      `- Artifact URI: ${check.artifact_uri ?? "none"}`,
      `- Summary: ${check.summary}`,
      `- screenshotPath: ${formatMetadataValue(metadata.screenshotPath)}`,
      `- domPath: ${formatMetadataValue(metadata.domPath)}`,
      `- consolePath: ${formatMetadataValue(metadata.consolePath)}`,
      `- consoleErrorCount: ${formatMetadataValue(metadata.consoleErrorCount)}`,
      ""
    ];
  });
}

function renderRuns(runs: RunRow[], proofs: ProofRow[]): string {
  const proofsByRun = groupBy(proofs, (proof) => proof.run_id);
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: runs-index",
    "---",
    "",
    "# Runs",
    "",
    "Each run keeps the user objective, status, sanitized metadata, and links to stored receipts.",
    "",
    ...runs.flatMap((run) => {
      const metadata = parseJson<Record<string, unknown>>(run.metadata_json, {});
      const linkedProofs = proofsByRun.get(run.id) ?? [];
      const contract = metadata.run_contract_summary ?? metadata.run_contract;
      return [
        `## ${run.id}`,
        "",
        `- Name: ${run.name}`,
        `- Status: ${run.status}`,
        `- Objective: ${run.objective}`,
        `- Created: ${run.created_at}`,
        `- Updated: ${run.updated_at}`,
        `- Proofs: ${linkedProofs.length ? linkedProofs.map((proof) => `[[Proofs#${anchor(proof.id)}|${proof.label}]]`).join(", ") : "none"}`,
        contract ? `- Contract summary: ${inlineJson(contract)}` : "- Contract summary: none",
        "",
        "```json",
        JSON.stringify(compactMetadata(metadata), null, 2),
        "```",
        ""
      ];
    }),
    runs.length === 0 ? "No runs indexed yet." : ""
  ].join("\n");
}

function renderProofs(proofs: ProofRow[], runs: RunRow[]): string {
  const runsById = new Map(runs.map((run) => [run.id, run]));
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: proofs-index",
    "---",
    "",
    "# Proofs",
    "",
    "Evidence receipts are indexed as durable pointers. Large artifacts stay in their original files or URIs.",
    "",
    ...proofs.flatMap((proof) => {
      const run = runsById.get(proof.run_id);
      return [
        `## ${proof.id}`,
        "",
        `- Label: ${proof.label}`,
        `- Type: ${proof.proof_type}`,
        `- Run: ${run ? `[[Runs#${anchor(run.id)}|${run.name}]]` : proof.run_id}`,
        `- URI: ${proof.uri}`,
        `- Size bytes: ${proof.size_bytes}`,
        `- Created: ${proof.created_at}`,
        "",
        "```json",
        JSON.stringify(parseJson(proof.metadata_json, {}), null, 2),
        "```",
        ""
      ];
    }),
    proofs.length === 0 ? "No proofs indexed yet." : ""
  ].join("\n");
}

function renderKnowledge(input: {
  bridgeActions: BridgeActionRow[];
  bridgeExecutions: BridgeExecutionRow[];
  knowledgeNotes: KnowledgeNoteRow[];
  checks: SystemCheckRow[];
}): string {
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: knowledge-index",
    "---",
    "",
    "# Knowledge",
    "",
    "Automation OS が次の相談や自動化作成で参照する、運用状態・安全境界・検証結果のWikiです。",
    "",
    "## Knowledge Notes",
    "",
    ...input.knowledgeNotes.flatMap((note) => [
      `### ${note.title}`,
      "",
      `- Type: ${note.note_type}`,
      `- Source: ${note.source_ref ?? "none"}`,
      `- Updated: ${note.updated_at}`,
      `- Tags: ${parseJson<string[]>(note.tags_json, []).join(", ") || "none"}`,
      "",
      note.body.trim(),
      ""
    ]),
    input.knowledgeNotes.length === 0 ? "No knowledge notes indexed yet." : "",
    "",
    "## Trusted Bridge Actions",
    "",
    ...input.bridgeActions.flatMap((action) => [
      `### ${action.id}`,
      "",
      `- Capability: ${action.capability_id}`,
      `- Label: ${action.label}`,
      `- Status: ${action.status}`,
      `- Risk: ${action.risk_level}`,
      `- Target: ${action.target ?? "none"}`,
      `- Summary: ${action.summary}`,
      `- Created: ${action.created_at}`,
      "",
      "```json",
      JSON.stringify(parseJson(action.metadata_json, {}), null, 2),
      "```",
      ""
    ]),
    input.bridgeActions.length === 0 ? "No bridge actions indexed yet." : "",
    "",
    "## Trusted Bridge Executor Ledger",
    "",
    ...input.bridgeExecutions.flatMap((execution) => [
      `### ${execution.id}`,
      "",
      `- Capability: ${execution.capability_id}`,
      `- Approval: ${execution.approval_id ?? "none"}`,
      `- Status: ${execution.status}`,
      `- Executor: ${execution.executor_status}`,
      `- Summary: ${execution.summary}`,
      `- Created: ${execution.created_at}`,
      "",
      "```json",
      JSON.stringify(parseJson(execution.metadata_json, {}), null, 2),
      "```",
      ""
    ]),
    input.bridgeExecutions.length === 0 ? "No bridge executor attempts indexed yet." : "",
    "",
    "## UI Verification",
    "",
    ...renderSystemChecks(input.checks.slice(0, 8))
  ].join("\n");
}

function renderDocs(docs: DocRow[]): string {
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: docs-index",
    "---",
    "",
    "# Docs",
    "",
    "This page mirrors local docs into one Obsidian-readable LLM Wiki surface.",
    "",
    "## Document Map",
    "",
    ...docs.map((doc) => `- [[Docs#${anchor(doc.title)}|${doc.title}]] (${doc.file})`),
    docs.length === 0 ? "- No docs found." : "",
    "",
    ...docs.flatMap((doc) => [`## ${doc.title}`, "", `Source: \`${doc.file}\``, "", doc.body.trim(), ""])
  ].join("\n");
}

function renderAutomationControlPanel(input: {
  automations: ReturnType<typeof getCodexCapabilities>["capabilities"]["automations"];
  roots: ReturnType<typeof getCodexCapabilities>["roots"];
  researchPlans: ResearchPlanRow[];
  generatedAt: string;
}): string {
  const automationRoot = input.roots.automations;
  const latestResearchPlans = input.researchPlans.slice(0, 5);
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: automation-control-panel",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Automation Control Panel",
    "",
    "Codex App 用の登録済みAutomation一覧です。このページは read-only inventory で、Automationを実行しません。",
    "",
    "## Summary",
    "",
    `- Automations indexed: ${input.automations.length}`,
    `- Research plans indexed: ${input.researchPlans.length}`,
    `- Automations root: ${automationRoot?.path ?? "unknown"}`,
    `- Root exists: ${automationRoot?.exists ?? false}`,
    "",
    "## Registered Automations",
    "",
    input.automations.length
      ? input.automations
          .map((automation) =>
            [
              `### ${automation.name}`,
              "",
              `- ID: ${automation.id}`,
              `- Status: ${automation.status}`,
              `- Kind: ${automation.kind}`,
              `- Path: \`${automation.path}\``,
              `- Source of truth: automation.toml, Skill/docs, STATE.md, queue, and artifacts stay authoritative.`,
              `- Next artifacts: inspect the workflow-owned STATE.md and latest artifacts before acting.`,
              `- Do not do: do not send, submit, publish, delete, or write externally from this note alone.`,
              ""
            ].join("\n")
          )
          .join("\n")
      : "No registered automations found.",
    "",
    "## Research Planner",
    "",
    "Research Planner entries are pre-start plan evidence only. They explain sources, visible flow, source of truth, proof boundary, and approval boundary; they do not prove completion.",
    "",
    latestResearchPlans.length
      ? latestResearchPlans
          .map((plan) =>
            [
              `### ${plan.title}`,
              "",
              `- Status: ${plan.status}`,
              `- Command: ${plan.command}`,
              `- Sources: ${renderResearchPlanSources(plan)}`,
              `- Demo check: ${plan.demo_check_id ?? "none"}`,
              `- Run: ${plan.run_id ?? "none"}`,
              `- Boundary: research_plan_snapshot is not completion proof.`,
              ""
            ].join("\n")
          )
          .join("\n")
      : "No research plans saved yet.",
    "",
    "## Safety Boundary",
    "",
    "Automation execution must go through the registered entrypoint, Automation OS run/approval/executor flow, or the workflow-owned runner. Research plans and this generated note are inventory/planning only."
  ].join("\n");
}

function renderResearchPlanSources(plan: ResearchPlanRow): string {
  const sources = parseJson<Array<{ label?: string; enabled?: boolean }>>(plan.sources_json, []);
  const enabled = sources.filter((source) => source.enabled).map((source) => source.label).filter(Boolean);
  return enabled.length ? enabled.join(" / ") : "none";
}

function renderSkillRegistry(input: { capabilities: ReturnType<typeof getCodexCapabilities>; generatedAt: string }): string {
  const skills = input.capabilities.capabilities.skills;
  const codexSkills = skills.filter((skill) => skill.kind === "codex_skill");
  const agentSkills = skills.filter((skill) => skill.kind === "agent_skill");
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: skill-registry",
    "status: active",
    "priority: medium",
    "source_of_truth: getCodexCapabilities() read-only inventory",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Skill Registry",
    "",
    "Codexが見つけたSkillを、初心者が確認しやすい短い一覧にしたページです。このページはSkillを実行しません。",
    "",
    "## Summary",
    "",
    `- codex_skill: ${codexSkills.length}`,
    `- agent_skill: ${agentSkills.length}`,
    `- total skills: ${skills.length}`,
    "",
    "## codex_skill",
    "",
    ...renderSkillRegistryItems(codexSkills),
    "",
    "## agent_skill",
    "",
    ...renderSkillRegistryItems(agentSkills),
    "",
    "## Plugins / Automations",
    "",
    "Plugins and registered automations are listed in [[Automation Control Panel]], which remains the read-only control panel source for those inventories.",
    "",
    "## Boundary",
    "",
    "A Skill path is a locator. Before using it, read the Skill instructions and keep execution proof in the workflow-owned STATE, artifacts, docs, or DB."
  ].join("\n");
}

function renderSkillRegistryItems(skills: ReturnType<typeof getCodexCapabilities>["capabilities"]["skills"]): string[] {
  if (skills.length === 0) return ["No skills indexed yet."];
  return skills.map((skill) =>
    [
      `### ${skill.name}`,
      "",
      `- ID: ${skill.id}`,
      `- Status: ${skill.status}`,
      `- Path: \`${skill.path}\``,
      ""
    ].join("\n")
  );
}

function renderCodexAppParityLedger(input: { items: CodexAppParityLedgerItem[]; generatedAt: string }): string {
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: codex-app-parity-ledger",
    "status: active",
    "priority: high",
    "source_of_truth: getCodexCapabilities(), system_checks, bridge_executions, and generated Obsidian receipts",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Codex App Parity Ledger",
    "",
    "Automation OS を Codex app の上位互換にするための監査台帳です。ここは実行面ではなく、表示・実行境界・証跡の対応状況を読むページです。",
    "",
    "| Capability | Current surface | Status | Execution boundary | Latest proof | Next safe addition |",
    "|---|---|---|---|---|---|",
    ...input.items.map((item) =>
      [
        item.capability,
        item.currentSurface,
        item.status,
        item.executionBoundary,
        item.latestProof,
        item.nextSafeAddition
      ].map(markdownTableCell).join(" | ")
    ).map((row) => `| ${row} |`),
    "",
    "## Rule",
    "",
    "A covered row means Automation OS can display and prove the boundary. Browser Use local checks require an ok CLI receipt with an artifact and acceptable cleanup proof. Protected actions require the latest protected/external executor ledger row to be completed with a connected executor and a completion receipt. Git, terminal, worktree, cloud threads, Computer Use, and IDE sync rows are read-only audit rows first; they are not executor connections."
  ].join("\n");
}

function renderProofInbox(input: {
  runs: RunRow[];
  proofs: ProofRow[];
  bridgeExecutions: BridgeExecutionRow[];
  generatedAt: string;
}): string {
  const runsById = new Map(input.runs.map((run) => [run.id, run]));
  const proofItems = input.proofs.slice(0, 30).map((proof) => {
    const run = runsById.get(proof.run_id);
    return [
      `### ${proof.id}`,
      "",
      `- Run: ${run ? `[[Runs#${anchor(run.id)}|${run.name}]]` : proof.run_id}`,
      `- Type: ${proof.proof_type}`,
      `- Label: ${proof.label}`,
      `- URI: ${proof.uri}`,
      `- Created: ${proof.created_at}`,
      ""
    ].join("\n");
  });
  const bridgeItems = input.bridgeExecutions
    .filter((execution) => execution.status === "blocked" || execution.executor_status !== "connected")
    .slice(0, 10)
    .map((execution) =>
      [
        `### ${execution.id}`,
        "",
        `- Capability: ${execution.capability_id}`,
        `- Status: ${execution.status}/${execution.executor_status}`,
        `- Approval: ${execution.approval_id ?? "none"}`,
        `- Summary: ${execution.summary}`,
        ""
      ].join("\n")
    );
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: proof-inbox",
    "status: active",
    "priority: high",
    "source_of_truth: Automation OS proofs and bridge executor ledger",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Proof Inbox",
    "",
    "Codex app が完了判断の前に読む証拠ポインター集です。本文は短く保ち、artifact body は元ファイルに残します。",
    "",
    "## Proof Pointers",
    "",
    proofItems.length ? proofItems.join("\n") : "No proof pointers indexed yet.",
    "",
    "## Bridge / Blocker Pointers",
    "",
    bridgeItems.length ? bridgeItems.join("\n") : "No bridge blockers indexed yet.",
    "",
    "## Rule",
    "",
    "Completion claims must point to a run summary, receipt, artifact URI, or explicit no-action proof.",
    "Research Planner snapshots are explicitly excluded from completion proof; visible source artifacts and DB/readback proof are required for research-plan completion."
  ].join("\n");
}

function renderCodexDailyBrief(input: {
  runs: RunRow[];
  proofs: ProofRow[];
  checks: SystemCheckRow[];
  bridgeExecutions: BridgeExecutionRow[];
  automations: ReturnType<typeof getCodexCapabilities>["capabilities"]["automations"];
  commandQueue: CommandQueueItem[];
  researchPlans: ResearchPlanRow[];
  generatedAt: string;
}): string {
  const latestRun = input.runs[0];
  const latestResearchPlan = input.researchPlans[0];
  const blockedRuns = selectAttentionRuns(input.runs).slice(0, 5);
  const latestCheck = input.checks[0];
  const executorBlocked = input.bridgeExecutions.filter((execution) => execution.executor_status !== "connected" || execution.status === "blocked").slice(0, 5);
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: codex-daily-brief",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Codex Daily Brief",
    "",
    "Codex app が最初に読む今日の運用入口です。このページは状況整理だけを行い、Automationを実行しません。",
    "",
    "## Today",
    "",
    `- Latest run: ${latestRun ? `[[Runs#${anchor(latestRun.id)}|${latestRun.name}]] (${latestRun.status})` : "none"}`,
    `- Latest research plan: ${latestResearchPlan ? `${latestResearchPlan.title} (${latestResearchPlan.status})` : "none"}`,
    `- Registered automations: ${input.automations.length}`,
    `- Proof pointers indexed: ${input.proofs.length}`,
    `- Open command queue items: ${input.commandQueue.length}`,
    `- Latest local screen check: ${latestCheck ? `${latestCheck.status} - ${latestCheck.summary}` : "none"}`,
    "",
    "## Read First",
    "",
    "- [[Automation Control Panel]]",
    "- [[Action Queue]]",
    "- [[Command Queue]]",
    "- [[Command Queue Intake]]",
    "- [[Proof Inbox]]",
    "- [[Weekly Review]]",
    "- [[Automation Dashboard]]",
    "- [[Project Index]]",
    "- [[Proofs]]",
    "- [[Knowledge]]",
    "",
    "## Attention",
    "",
    ...renderAttentionItems({ blockedRuns, executorBlocked }),
    "",
    "## Safety Boundary",
    "",
    "- Do not send, submit, publish, delete, or write to external systems from this brief alone.",
    "- Research Planner snapshots are pre-start plans only; verify run/proof/artifact/DB readback before treating work as complete.",
    "- Check the workflow-owned STATE.md, queue, source system, and latest artifacts before resuming an automation.",
    "- If another terminal or lane is already running the same workflow, stop and do read-only verification later."
  ].join("\n");
}

function renderTodayDashboard(input: {
  runs: RunRow[];
  proofs: ProofRow[];
  checks: SystemCheckRow[];
  bridgeExecutions: BridgeExecutionRow[];
  commandQueue: CommandQueueItem[];
  projectAudit: ProjectAuditResult;
  codexSessions: CodexSessionSummary[];
  generatedAt: string;
}): string {
  const attentionRuns = selectAttentionRuns(input.runs).slice(0, 4);
  const resumeCandidate = selectResumeCandidateRun(input.runs);
  const latestSession = input.codexSessions[0];
  const latestCheck = input.checks[0];
  const projectAttention = input.projectAudit.projects.filter((project) => project.status !== "ok").slice(0, 5);
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: daily-orientation",
    "status: active",
    "priority: high",
    "source_of_truth: Resume Contract plus project-owned STATE/artifacts/readback",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Today",
    "",
    "今日Codexが最初に読む入口です。ここは全project共通の地図で、実行許可や完了証跡ではありません。",
    "",
    "## First Read",
    "",
    "- [[Resume Current Work]]",
    "- [[Project Cockpit]]",
    "- [[Conversation Memory Cards]]",
    "- [[User Signals]]",
    "- [[Blocker Radar]]",
    "- [[Success Paths]]",
    "- [[Failure Fix Log]]",
    "",
    "## Current State",
    "",
    `- Latest run: ${formatRunBrief(input.runs[0])}`,
    `- Resume candidate: ${formatRunBrief(resumeCandidate)}`,
    `- Project attention: ${input.projectAudit.summary.attention}; blocked: ${input.projectAudit.summary.blocked}`,
    `- Open command queue items: ${input.commandQueue.length}`,
    `- Proof pointers indexed: ${input.proofs.length}`,
    `- Latest local check: ${latestCheck ? `${latestCheck.status} - ${shortSnippet(latestCheck.summary, 120)}` : "none"}`,
    `- Latest session locator: ${latestSession ? `${latestSession.cwd} / ${latestSession.sessionId}` : "none"}`,
    "",
    "## Needs Attention",
    "",
    attentionRuns.length
      ? attentionRuns.map((run) => `- Run: [[Runs#${anchor(run.id)}|${run.name}]] (${run.status}) - ${shortSnippet(run.objective, 140)}`).join("\n")
      : "- No blocked or partial runs in the latest export window.",
    projectAttention.length
      ? projectAttention.map((project) => `- Project: ${project.project.label} (${project.status}) - ${project.nextAction}`).join("\n")
      : "- No project health attention beyond runs.",
    "",
    "## Resume Rule",
    "",
    "When the user asks what any project was doing or what remains, read this page, then `Resume Current Work`, `Project Handoff Index`, and the target project's STATE/AGENTS/automation.toml/Skill/latest artifact before answering."
  ].join("\n");
}

function renderProjectCockpit(input: {
  projectAudit: ProjectAuditResult;
  runs: RunRow[];
  proofs: ProofRow[];
  commandQueue: CommandQueueItem[];
  codexSessions: CodexSessionSummary[];
  memoryHints: MemoryProjectHint[];
  generatedAt: string;
}): string {
  const sessionsByProject = groupSessionsByCwd(input.codexSessions);
  const proofByRun = groupBy(input.proofs, (proof) => proof.run_id);
  const recentRuns = input.runs.slice(0, 8);
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: project-cockpit",
    "status: active",
    "priority: high",
    "source_of_truth: data/project-registry.json, project-owned STATE.md, run artifacts, and Codex session locators",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Project Cockpit",
    "",
    "全project横断の再開コックピットです。Obsidianは入口、完了判定はproject-owned source of truthで行います。",
    "",
    "## Snapshot",
    "",
    `- Projects: ${input.projectAudit.summary.projects}`,
    `- OK / Attention / Blocked: ${input.projectAudit.summary.ok} / ${input.projectAudit.summary.attention} / ${input.projectAudit.summary.blocked}`,
    `- Recent runs indexed: ${input.runs.length}`,
    `- Proof pointers indexed: ${input.proofs.length}`,
    `- Open command queue items: ${input.commandQueue.length}`,
    `- Recent session projects: ${sessionsByProject.length}`,
    "",
    "## Projects",
    "",
    input.projectAudit.projects.length
      ? input.projectAudit.projects.map((item) => renderCockpitProjectItem(item, input.memoryHints)).join("\n")
      : "No projects registered.",
    "",
    "## Recent Run Proof Surface",
    "",
    recentRuns.length
      ? recentRuns
          .map((run) => {
            const linkedProofs = proofByRun.get(run.id) ?? [];
            return `- [[Runs#${anchor(run.id)}|${run.name}]] (${run.status}) proof_count=${linkedProofs.length}; proof=${linkedProofs[0]?.uri ?? "missing"}`;
          })
          .join("\n")
      : "- No recent runs indexed.",
    "",
    "## Session Locators",
    "",
    sessionsByProject.length
      ? sessionsByProject
          .slice(0, 12)
          .map((project) => `- ${project.cwd}: ${project.count} session(s), latest=${project.latest.mtime}, last_user=${project.latest.lastUser}`)
          .join("\n")
      : "- No session locators indexed."
  ].join("\n");
}

function renderActionQueue(input: {
  runs: RunRow[];
  proofs: ProofRow[];
  bridgeExecutions: BridgeExecutionRow[];
  automations: ReturnType<typeof getCodexCapabilities>["capabilities"]["automations"];
  commandQueue: CommandQueueItem[];
  generatedAt: string;
}): string {
  const proofByRun = groupBy(input.proofs, (proof) => proof.run_id);
  const recentRuns = selectActionQueueRuns(input.runs).slice(0, 8);
  const commandActions = input.commandQueue.slice(0, 8).map((item) => ({
    priority: item.priority,
    owner: item.title,
    status: item.status,
    action: item.command,
    sourceOfTruth: item.sourceOfTruth,
    requiredProof: "Codex response, run receipt, or explicit no-action proof"
  }));
  const automationActions = input.automations.slice(0, 8).map((automation) => ({
    priority: automation.status === "missing" ? "low" : "medium",
    owner: automation.id,
    status: automation.status,
    action: "Review source of truth and latest artifact before asking Codex to resume.",
    sourceOfTruth: "automation.toml, Skill/docs, STATE.md, queue, artifacts",
    requiredProof: "latest run-summary, receipt, or no-action proof"
  }));
  const runActions = recentRuns.map((run) => {
    const proofs = proofByRun.get(run.id) ?? [];
    return {
      priority: run.status === "blocked" || run.status === "partial" ? "high" : "medium",
      owner: run.id,
      status: run.status,
      action: "Inspect exact blocker, source of truth, and latest proof before continuing.",
      sourceOfTruth: "run metadata plus workflow-owned STATE/artifacts",
      requiredProof: proofs.length ? proofs.map((proof) => proof.uri).slice(0, 2).join(", ") : "missing proof pointer"
    };
  });
  const executorActions = input.bridgeExecutions.slice(0, 5).map((execution) => ({
    priority: execution.status === "blocked" ? "high" : "medium",
    owner: execution.capability_id,
    status: `${execution.status}/${execution.executor_status}`,
    action: "Resolve bridge executor state before assuming protected external work happened.",
    sourceOfTruth: "Trusted Bridge executor ledger",
    requiredProof: execution.summary
  }));
  const actions = [...commandActions, ...runActions, ...executorActions, ...automationActions].slice(0, 24);
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: codex-action-queue",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Action Queue",
    "",
    "Codex app に次へ頼む候補を並べた自動生成キューです。ここは実行正本ではなく、行動前の確認リストです。",
    "",
    "## Queue",
    "",
    actions.length
      ? actions
          .map((item) =>
            [
              `### ${item.owner}`,
              "",
              `- Priority: ${item.priority}`,
              `- Status: ${item.status}`,
              `- Next action: ${item.action}`,
              `- Source of truth: ${item.sourceOfTruth}`,
              `- Required proof: ${item.requiredProof}`,
              `- Safe to run: read-only review only unless an explicit registered entrypoint or approval flow is used.`,
              ""
            ].join("\n")
          )
          .join("\n")
      : "No action candidates indexed yet.",
    "",
    "## Rule",
    "",
    "Codex should treat this queue as a planner. External writes still require the workflow runner, registered automation entrypoint, or approved Trusted Bridge path."
  ].join("\n");
}

function renderProjectHealth(input: { projectAudit: ProjectAuditResult; generatedAt: string }): string {
  const audit = input.projectAudit;
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: project-health",
    "status: active",
    "priority: high",
    "source_of_truth: data/project-registry.json plus each project-owned STATE.md/artifacts/readback",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Project Health",
    "",
    "全プロジェクトを混線させないための自動監査ダッシュボードです。ここは実行証跡ではなく、次に読む正本と境界を示すlocatorです。",
    "",
    "## Summary",
    "",
    `- Projects: ${audit.summary.projects}`,
    `- OK: ${audit.summary.ok}`,
    `- Attention: ${audit.summary.attention}`,
    `- Blocked: ${audit.summary.blocked}`,
    `- Safe auto-fix candidates: ${audit.summary.safeAutoFixes}`,
    `- Approval-required operations registered: ${audit.summary.approvalRequired}`,
    `- Human-only operations registered: ${audit.summary.humanOnly}`,
    `- Registry: \`${audit.registryPath}\``,
    "",
    "## Projects",
    "",
    audit.projects
      .map((item) =>
        [
          `### ${item.project.label}`,
          "",
          `- Project id: \`${item.project.id}\``,
          `- Status: ${item.status}`,
          `- Owner layer: ${item.project.owner_layer}`,
          `- Root exists: ${item.rootExists ? "yes" : "no"}`,
          `- STATE.md: ${item.stateExists ? `present (${item.stateMtime})` : "missing"}`,
          `- Context Pack boundary: ${item.contextPackExists ? (item.contextPackHasLocatorBoundary ? "locator_not_proof_ok" : "missing_boundary") : "missing"}`,
          `- Automation class: ${item.automationClass}`,
          `- Next action: ${item.nextAction}`,
          `- Source of truth: ${item.project.source_of_truth.map((source) => `\`${source}\``).join(", ")}`,
          `- Related projects: ${item.project.related_projects.join(", ") || "none"}`,
          `- Issues: ${item.issues.length ? item.issues.map((issue) => `${issue.severity}:${issue.code}`).join(", ") : "none"}`,
          ""
        ].join("\n")
      )
      .join("\n"),
    "## Rule",
    "",
    "Obsidianで見えている状態は入口です。実行前には必ずProject Registry、対象projectのSTATE.md、最新artifact/readback、必要なDB行をfresh-readしてください。"
  ].join("\n");
}

function renderBlockerRadar(input: {
  runs: RunRow[];
  bridgeExecutions: BridgeExecutionRow[];
  projectAudit: ProjectAuditResult;
  generatedAt: string;
}): string {
  const runBlockers = selectAttentionRuns(input.runs).slice(0, 30).map((run) => {
    const metadata = compactMetadata(parseJson<Record<string, unknown>>(run.metadata_json, {}));
    const text = `${run.name} ${run.objective} ${formatMetadataValue(metadata.stop_reason ?? metadata.proof_gate ?? metadata.proof_summary ?? "")}`;
    return {
      source: `run:${run.id}`,
      title: run.name,
      status: run.status,
      category: classifyBlockerText(text),
      detail: shortSnippet(text, 220),
      next: "Read run metadata, project STATE, queue/readback, and latest artifact before retry."
    };
  });
  const bridgeBlockers = input.bridgeExecutions
    .filter((execution) => execution.status === "blocked" || execution.executor_status !== "connected")
    .slice(0, 20)
    .map((execution) => ({
      source: `bridge:${execution.id}`,
      title: execution.capability_id,
      status: `${execution.status}/${execution.executor_status}`,
      category: classifyBlockerText(execution.summary),
      detail: shortSnippet(execution.summary, 220),
      next: "Resolve executor/callable-surface state before assuming protected work happened."
    }));
  const projectBlockers = input.projectAudit.projects
    .filter((project) => project.status !== "ok")
    .slice(0, 30)
    .flatMap((project) =>
      (project.issues.length ? project.issues : [{ severity: project.status, code: "project_attention", message: project.nextAction }]).map((issue) => ({
        source: `project:${project.project.id}`,
        title: project.project.label,
        status: project.status,
        category: classifyBlockerText(`${issue.code} ${issue.message}`),
        detail: `${issue.severity}:${issue.code} - ${shortSnippet(issue.message, 180)}`,
        next: project.nextAction
      }))
    );
  const rows = [...runBlockers, ...bridgeBlockers, ...projectBlockers].slice(0, 80);
  const categoryMix = countBy(rows, (row) => row.category);
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: blocker-radar",
    "status: active",
    "priority: high",
    "source_of_truth: Automation OS runs, bridge ledger, and Project Auditor",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Blocker Radar",
    "",
    "止まっている理由を横断分類し、次回Codexが同じ説明を求めずに該当sourceを読みに行くための面です。",
    "",
    "## Summary",
    "",
    `- Blockers indexed: ${rows.length}`,
    `- Category mix: ${formatCounts(categoryMix)}`,
    "",
    "## Radar",
    "",
    rows.length
      ? rows
          .map((row) =>
            [
              `### ${row.source}`,
              "",
              `- Title: ${row.title}`,
              `- Status: ${row.status}`,
              `- Category: ${row.category}`,
              `- Detail: ${row.detail}`,
              `- Next read/action: ${row.next}`,
              ""
            ].join("\n")
          )
          .join("\n")
      : "No blockers indexed.",
    "",
    "## Rule",
    "",
    "If a category repeats, promote the fix into AGENTS.md, STATE.md, Skill/runbook, registered automation prompt, or proof gate. Do not leave repeated blockers as chat-only knowledge."
  ].join("\n");
}

function renderSuccessPaths(input: { runs: RunRow[]; proofs: ProofRow[]; knowledgeNotes: KnowledgeNoteRow[]; generatedAt: string }): string {
  const proofsByRun = groupBy(input.proofs, (proof) => proof.run_id);
  const successfulRuns = input.runs.filter((run) => run.status === "complete" || run.status === "completed").slice(0, 30);
  const knowledgeWins = input.knowledgeNotes
    .filter((note) => /success|勝ち筋|worked|成功|receipt|proof/i.test(`${note.title}\n${note.body}`))
    .slice(0, 12);
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: success-paths",
    "status: active",
    "priority: high",
    "source_of_truth: completed runs, proof pointers, and knowledge notes",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Success Paths",
    "",
    "うまくいった実行の証跡と、次回再利用すべき勝ち筋をまとめます。成功メモは必ずproof/readbackに戻して確認します。",
    "",
    "## Completed Runs",
    "",
    successfulRuns.length
      ? successfulRuns
          .map((run) => {
            const metadata = compactMetadata(parseJson<Record<string, unknown>>(run.metadata_json, {}));
            const linkedProofs = proofsByRun.get(run.id) ?? [];
            return [
              `### ${run.id}`,
              "",
              `- Name: ${run.name}`,
              `- Updated: ${run.updated_at}`,
              `- Objective: ${shortSnippet(run.objective, 180)}`,
              `- Proof count: ${linkedProofs.length}`,
              `- Proof pointers: ${linkedProofs.length ? linkedProofs.slice(0, 3).map((proof) => proof.uri).join(", ") : "missing"}`,
              `- Completion basis: ${formatMetadataValue(metadata.proof_summary ?? metadata.run_contract_summary ?? metadata.proof_gate ?? "status only")}`,
              "- Promote if useful: STATE.md, Skill/runbook, registered automation prompt, tests, proof gate, or project docs.",
              ""
            ].join("\n");
          })
          .join("\n")
      : "No completed runs indexed.",
    "",
    "## Knowledge Wins",
    "",
    knowledgeWins.length
      ? knowledgeWins.map((note) => `- ${note.title}: ${shortSnippet(note.body, 180)}`).join("\n")
      : "- No success-path knowledge notes indexed.",
    "",
    "## Regression Rule",
    "",
    "When a future run diverges from a recorded success path, classify it as `success_path_regression` and compare expected account, lane, UI entry, selector/AX signal, source-of-truth update, completion proof, and cleanup proof."
  ].join("\n");
}

function renderProjectActionQueue(input: { projectAudit: ProjectAuditResult; generatedAt: string }): string {
  const rows = input.projectAudit.projects
    .flatMap((item) => [
      ...item.safeFixes.map((fix) => ({
        project: item.project,
        className: "safe_auto_fix",
        action: fix,
        status: item.status,
        boundary: "local generated files or local status only"
      })),
      ...item.approvalRequired.map((action) => ({
        project: item.project,
        className: "approval_required_fix",
        action,
        status: item.status,
        boundary: "prepare evidence, then wait for explicit approval"
      })),
      ...item.humanOnly.map((action) => ({
        project: item.project,
        className: "human_only",
        action,
        status: item.status,
        boundary: "human must perform or approve in the real service"
      }))
    ])
    .slice(0, 80);
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: project-action-queue",
    "status: active",
    "priority: high",
    "source_of_truth: data/project-registry.json and Project Health audit result",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Project Action Queue",
    "",
    "Project Auditor が分類した整理候補です。`safe_auto_fix` だけが自動整理候補で、`approval_required_fix` と `human_only` は実行許可ではありません。",
    "",
    "## Queue",
    "",
    rows.length
      ? rows
          .map((row) =>
            [
              `### ${row.project.label} / ${row.action}`,
              "",
              `- Class: ${row.className}`,
              `- Project status: ${row.status}`,
              `- Boundary: ${row.boundary}`,
              `- Source of truth: ${row.project.source_of_truth.map((source) => `\`${source}\``).join(", ")}`,
              `- Related projects: ${row.project.related_projects.join(", ") || "none"}`,
              ""
            ].join("\n")
          )
          .join("\n")
      : "No project action candidates indexed.",
    "",
    "## Rule",
    "",
    "このキューは整理計画です。外部write、投稿、応募、公開、削除、デプロイ、設定変更、秘密情報変更、課金系操作はここから自動実行しません。"
  ].join("\n");
}

function renderRunLedger(input: { runs: RunRow[]; proofs: ProofRow[]; bridgeExecutions: BridgeExecutionRow[]; generatedAt: string }): string {
  const proofsByRun = groupBy(input.proofs, (proof) => proof.run_id);
  const rows = input.runs.slice(0, 80);
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: run-ledger",
    "status: active",
    "priority: medium",
    "source_of_truth: Automation OS DB runs/proofs/bridge_executions",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Run Ledger",
    "",
    "Automation OS実行履歴の読み取り用台帳です。詳細の正本はDB行とrun-owned artifactです。",
    "",
    "## Runs",
    "",
    rows.length
      ? rows
          .map((run) => {
            const metadata = compactMetadata(parseJson<Record<string, unknown>>(run.metadata_json, {}));
            const linkedProofs = proofsByRun.get(run.id) ?? [];
            return [
              `### ${run.id}`,
              "",
              `- Name: ${run.name}`,
              `- Status: ${run.status}`,
              `- Updated: ${run.updated_at}`,
              `- Objective: ${shortSnippet(run.objective, 220)}`,
              `- Proof count: ${linkedProofs.length}`,
              `- Proof pointers: ${linkedProofs.length ? linkedProofs.slice(0, 3).map((proof) => proof.uri).join(", ") : "none"}`,
              `- Stop/proof basis: ${formatMetadataValue(metadata.stop_reason ?? metadata.proof_summary ?? metadata.proof_gate ?? metadata.run_contract_summary ?? "status only")}`,
              ""
            ].join("\n");
          })
          .join("\n")
      : "No runs indexed.",
    "",
    "## Bridge Executions",
    "",
    input.bridgeExecutions.length
      ? input.bridgeExecutions
          .slice(0, 30)
          .map((execution) => `- ${execution.capability_id}: ${execution.status}/${execution.executor_status} updated=${execution.updated_at} summary=${shortSnippet(execution.summary, 180)}`)
          .join("\n")
      : "- No bridge executions indexed."
  ].join("\n");
}

function renderApprovalLedger(input: { projectAudit: ProjectAuditResult; bridgeExecutions: BridgeExecutionRow[]; generatedAt: string }): string {
  const projectRows = input.projectAudit.projects.filter((item) => item.approvalRequired.length || item.humanOnly.length);
  const approvalExecutions = input.bridgeExecutions.filter((execution) => execution.approval_id || execution.status === "blocked");
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: approval-ledger",
    "status: active",
    "priority: high",
    "source_of_truth: data/project-registry.json plus Automation OS approvals/bridge ledgers",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Approval Ledger",
    "",
    "承認が必要な操作と、人間だけが扱う操作の台帳です。このページは承認そのものではありません。",
    "",
    "## Project Boundaries",
    "",
    projectRows
      .map((item) =>
        [
          `### ${item.project.label}`,
          "",
          `- Approval required: ${item.approvalRequired.join(", ") || "none"}`,
          `- Human only: ${item.humanOnly.join(", ") || "none"}`,
          `- Allowed automation: ${item.project.allowed_automation.join(", ") || "none"}`,
          `- Source of truth: ${item.project.source_of_truth.map((source) => `\`${source}\``).join(", ")}`,
          ""
        ].join("\n")
      )
      .join("\n"),
    "## Recent Approval-Like Executions",
    "",
    approvalExecutions.length
      ? approvalExecutions
          .slice(0, 40)
          .map((execution) => `- ${execution.capability_id}: ${execution.status}/${execution.executor_status}; approval_id=${execution.approval_id ?? "none"}; ${shortSnippet(execution.summary, 180)}`)
          .join("\n")
      : "- No approval-linked bridge executions indexed.",
    "",
    "## Rule",
    "",
    "billing / purchase / payment / checkout / paid_subscription / invoice / CAPTCHA / OTP / security_code / identity verification はAIが自動突破しません。証跡を残し、人間入力または明示承認を待ちます。"
  ].join("\n");
}

function renderCommandQueueIntake(input: { commandQueue: CommandQueueItem[]; generatedAt: string }): string {
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: command-queue-intake",
    "status: active",
    "priority: high",
    "source_of_truth: 01_Control Panel/Command Queue.md and 09_Inbox handwritten notes",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Command Queue Intake",
    "",
    "Obsidianに手書きされたCodexへの依頼を、自動実行前の候補として整理した入口です。このページ自体は外部操作を実行しません。",
    "",
    "## Open Items",
    "",
    input.commandQueue.length
      ? input.commandQueue
          .map((item) =>
            [
              `### ${item.title}`,
              "",
              `- Priority: ${item.priority}`,
              `- Status: ${item.status}`,
              `- Command: ${item.command}`,
              `- Source note: [[${item.file.replace(/\.md$/, "")}|${item.file}]]`,
              `- Source of truth: ${item.sourceOfTruth}`,
              `- Blocker: ${item.blocker}`,
              `- Safe first step: read source note, verify source of truth, then decide whether to start a Codex run.`,
              ""
            ].join("\n")
          )
          .join("\n")
      : "No open handwritten command items indexed yet.",
    "",
    "## Intake Rule",
    "",
    "Unchecked tasks in `Command Queue.md` or notes with `kind: inbox` / `needs_classification: yes` are suggestions only. Codex must still apply the registered workflow, approval, and proof rules before acting."
  ].join("\n");
}

function renderSecondBrainIntake(input: { candidates: SecondBrainClassificationCandidate[]; generatedAt: string }): string {
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: second-brain-intake",
    "status: active",
    "priority: high",
    "source_of_truth: handwritten 09_Inbox notes only",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Second Brain Intake",
    "",
    "Handwritten `09_Inbox` notes that explicitly opt into classification. This page is a read-only classification suggestion surface.",
    "",
    "## Boundary",
    "",
    "- Read-only classification suggestion only.",
    "- Do not move files, rename files, write outside Obsidian, publish, submit, or perform any external operation from this note.",
    "- Preserve the source pointer before creating any project, research, decision, or runbook note.",
    "",
    "## Classification Suggestions",
    "",
    input.candidates.length
      ? input.candidates.map((candidate) => renderSecondBrainCandidate(candidate)).join("\n")
      : "No handwritten inbox notes need classification.",
    "",
    "## Safe Review Rule",
    "",
    "When destination confidence is low, leave the note in `09_Inbox` with `unknown` instead of forcing it into a project folder."
  ].join("\n");
}

function renderSecondBrainCandidate(candidate: SecondBrainClassificationCandidate): string {
  const sourceUrl = redactSecondBrainPointer(candidate.sourceUrl);
  const sourceOfTruth = redactSecondBrainPointer(candidate.sourceOfTruth);
  const suggestedDestination = normalizeSecondBrainDestination(candidate.suggestedDestination);
  const sourcePointer = sourceUrl !== "unknown" ? sourceUrl : sourceOfTruth;
  return [
    `### [[${candidate.file.replace(/\.md$/, "")}|${candidate.title}]]`,
    "",
    `- File: \`${candidate.file}\``,
    `- Kind: ${candidate.kind}`,
    `- Status: ${candidate.status}`,
    `- Source URL: ${sourceUrl}`,
    `- Capture type: ${candidate.captureType}`,
    `- Source of truth: ${sourceOfTruth}`,
    `- Suggested destination: ${suggestedDestination}`,
    `- Reason: ${candidate.reason}`,
    `- Source pointer to preserve: ${sourcePointer}`,
    `- Safe next move: review only; keep file in place unless a human or explicit Codex task asks for a note copy.`,
    "",
    "> " + candidate.excerpt,
    ""
  ].join("\n");
}

function renderSecondBrainAutoProcessor(input: { candidates: SecondBrainClassificationCandidate[]; generatedAt: string }): string {
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: second-brain-auto-processor",
    "status: active",
    "priority: high",
    "auto_approval_boundary: obsidian_internal_only",
    "approval_mode: auto_obsidian_internal",
    "source_of_truth: Second Brain classification candidates from handwritten 09_Inbox notes",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Second Brain Auto Processor",
    "",
    "Obsidian内部の知識処理だけを auto-approved として進めるための作業面です。外部送信、投稿、応募、削除、外部ファイル操作はsource-of-truthと証跡を確認して進め、課金・購入・支払い・決済だけ停止します。",
    "",
    "## Pipeline",
    "",
    "Capture -> Normalize -> Classify -> Distill -> Draft -> Link -> Review Digest",
    "",
    "- Capture: handwritten `09_Inbox` notes that opted into classification.",
    "- Normalize: keep file path, source URL, capture type, and source of truth with redaction.",
    "- Classify: map only to the destination allowlist `05_Projects`, `06_Research`, `07_Decisions`, `08_Runbooks`, `09_Inbox`, or `unknown`.",
    "- Distill: add progressive_summary, distillation, next_use, and unresolved_question fields inside Obsidian notes.",
    "- Draft: create or update Obsidian-only draft content without treating it as source-of-truth completion proof.",
    "- Link: add wiki links between Obsidian notes while preserving the source pointer.",
    "- Review Digest: surface processing_status, external_action_required, and billing_only_review flags for human review.",
    "",
    "## Auto-approved internal operations",
    "",
    "- Read handwritten Obsidian notes and generated Automation OS review surfaces.",
    "- Redact source pointers, normalize fields, classify to the destination allowlist, summarize, distill, draft, and link notes inside the Obsidian vault.",
    "- Update Obsidian-only metadata fields such as auto_process, processing_status, suggested_destination, progressive_summary, source_of_truth, external_action_required, and billing_only_review.",
    "",
    "## Billing-only hard stops",
    "",
    "- Stop only when billing, purchase, payment, checkout, paid subscription, invoice, or 請求 would be required.",
    "- Publishing, sending, submitting, applying, deleting, external-service changes, workflow-owned STATE/queue/artifact/DB changes, credential/session changes, or destinations outside the allowlist require source-of-truth evidence and readback, not a generic approval stop.",
    "- CAPTCHA, OTP/security code, identity/auth callable-surface gaps, and uncertain PII are recorded as human-input evidence and then routed to the next safe candidate/stage when possible.",
    "",
    "## Queue",
    "",
    `- Source redaction: ${input.candidates.length ? "enabled for source_url and source_of_truth" : "no candidates"}`,
    "- Destination allowlist: 05_Projects, 06_Research, 07_Decisions, 08_Runbooks, 09_Inbox, unknown",
    "",
    input.candidates.length
      ? input.candidates.map((candidate) => renderSecondBrainAutoProcessorQueueItem(candidate)).join("\n")
      : "No Second Brain classification candidates are queued.",
    "",
    "## Queue Rule",
    "",
    "Use the existing Second Brain classification candidates as the queue. Keep redacted source pointers and normalized destination values visible before any internal draft or link update."
  ].join("\n");
}

function renderSecondBrainAutoProcessorQueueItem(candidate: SecondBrainClassificationCandidate): string {
  const sourceUrl = redactSecondBrainPointer(candidate.sourceUrl);
  const sourceOfTruth = redactSecondBrainPointer(candidate.sourceOfTruth);
  const suggestedDestination = normalizeSecondBrainDestination(candidate.suggestedDestination);
  const unknownDestination = suggestedDestination === "unknown";
  const externalActionRequired = unknownDestination || candidate.externalActionRequired ? "true" : "false";
  const approvalRequired = unknownDestination || candidate.approvalRequired ? "true" : "false";
  return [
    `### [[${candidate.file.replace(/\.md$/, "")}|${candidate.title}]]`,
    "",
    `- auto_process: obsidian_internal_only`,
    `- processing_status: ${candidate.processingStatus}`,
    `- suggested_destination: ${suggestedDestination}`,
    `- progressive_summary: ${candidate.excerpt}`,
    `- source_url: ${sourceUrl}`,
    `- source_of_truth: ${sourceOfTruth}`,
    `- distillation: ${candidate.reason}`,
    `- next_use: draft Obsidian-only note or link after review of the redacted source pointer`,
    `- unresolved_question: confirm whether the suggested destination is enough for durable reuse`,
    `- review_cycle: weekly`,
    `- external_action_required: ${externalActionRequired}`,
    `- approval_required: ${approvalRequired}`,
    ""
  ].join("\n");
}

function renderSecondBrainWeeklyDigest(input: {
  notes: SecondBrainDigestNote[];
  candidates: SecondBrainClassificationCandidate[];
  generatedAt: string;
}): string {
  const folderCounts = countBy(input.notes, (note) => note.folder);
  const kindCounts = countBy(input.notes, (note) => note.kind);
  const statusCounts = countBy(input.notes, (note) => note.status);
  const sourceCounts = countBy(input.notes, (note) => redactSecondBrainPointer(note.sourceOfTruth));
  const unclassified = input.candidates.filter((candidate) => {
    const destination = normalizeSecondBrainDestination(candidate.suggestedDestination);
    return destination === "unknown" || destination === "09_Inbox";
  });
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: second-brain-weekly-digest",
    "status: active",
    "priority: medium",
    "source_of_truth: handwritten notes in 05_Projects, 06_Research, 07_Decisions, 08_Runbooks, and 09_Inbox",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Second Brain Weekly Digest",
    "",
    "Handwritten Second Brain notes are summarized for review. This digest does not canonicalize notes or change any source of truth.",
    "",
    "## Boundary",
    "",
    "- Read-only weekly digest only.",
    "- Do not move files or treat this digest as canonical truth.",
    "- Preserve source_url, source_of_truth, and file path before making any manual review move.",
    "",
    "## Snapshot",
    "",
    `- Handwritten notes indexed: ${input.notes.length}`,
    `- Classification candidates: ${input.candidates.length}`,
    `- Unclassified count: ${unclassified.length}`,
    `- Folders: ${formatCounts(folderCounts)}`,
    `- Kind mix: ${formatCounts(kindCounts)}`,
    `- Status mix: ${formatCounts(statusCounts)}`,
    `- Source of truth mix: ${formatCounts(sourceCounts)}`,
    "",
    "## Next Review Moves",
    "",
    ...renderSecondBrainReviewMoves(input.candidates),
    "",
    "## Folder Rollup",
    "",
    ...renderSecondBrainFolderRollup(input.notes)
  ].join("\n");
}

function renderSecondBrainReviewMoves(candidates: SecondBrainClassificationCandidate[]): string[] {
  if (candidates.length === 0) return ["- No classification review moves suggested."];
  return candidates.slice(0, 12).map((candidate) => {
    const suggestedDestination = normalizeSecondBrainDestination(candidate.suggestedDestination);
    const destination = suggestedDestination === "unknown" ? "09_Inbox" : suggestedDestination;
    const sourceUrl = redactSecondBrainPointer(candidate.sourceUrl);
    const sourceOfTruth = redactSecondBrainPointer(candidate.sourceOfTruth);
    return `- Review [[${candidate.file.replace(/\.md$/, "")}|${candidate.title}]]; suggested destination: ${destination}; preserve source pointer: ${
      sourceUrl !== "unknown" ? sourceUrl : sourceOfTruth
    }.`;
  });
}

function renderSecondBrainFolderRollup(notes: SecondBrainDigestNote[]): string[] {
  if (notes.length === 0) return ["No handwritten notes indexed yet."];
  return notes.slice(0, 40).map((note) =>
    `- ${note.folder}: [[${note.file.replace(/\.md$/, "")}|${note.title}]] | kind=${note.kind} | status=${note.status} | source_of_truth=${redactSecondBrainPointer(note.sourceOfTruth)}`
  );
}

function renderResumeCurrentWork(input: {
  runs: RunRow[];
  checks: SystemCheckRow[];
  bridgeActions: BridgeActionRow[];
  bridgeExecutions: BridgeExecutionRow[];
  knowledgeNotes: KnowledgeNoteRow[];
  codexSessions: CodexSessionSummary[];
  generatedAt: string;
}): string {
  const latestRun = input.runs[0];
  const blockedRun = selectResumeCandidateRun(input.runs);
  const actionQueueRuns = selectActionQueueRuns(input.runs).slice(0, 5);
  const latestCheck = input.checks[0];
  const latestBridgeAction = input.bridgeActions[0];
  const latestBridgeExecution = input.bridgeExecutions[0];
  const latestKnowledge = input.knowledgeNotes[0];
  const latestSession = selectResumeCodexSession(input.codexSessions);
  const sessionSummary = latestSession
    ? `${latestSession.sessionId} (${latestSession.cwd})`
    : "none (no current-project Codex session found; see Active Sessions for latest global locators)";
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: resume-current-work",
    "status: active",
    "priority: high",
    "source_of_truth: Automation OS DB plus ~/.codex/sessions summaries",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Resume Current Work",
    "",
    "次回Codexが最初に読む短い再開ブリーフです。ここは要約だけで、実行正本ではありません。",
    "",
    "## Current Brief",
    "",
    `- Latest run: ${formatRunBrief(latestRun)}`,
    `- Resume candidate: ${formatRunBrief(blockedRun)}`,
    `- Latest system check: ${latestCheck ? `${latestCheck.status} - ${shortSnippet(latestCheck.summary, 160)}` : "none"}`,
    `- Latest bridge action: ${latestBridgeAction ? `${latestBridgeAction.status} - ${shortSnippet(latestBridgeAction.label, 120)}` : "none"}`,
    `- Latest bridge execution: ${
      latestBridgeExecution
        ? `${latestBridgeExecution.status}/${latestBridgeExecution.executor_status} - ${shortSnippet(latestBridgeExecution.summary, 160)}`
        : "none"
    }`,
    `- Latest knowledge: ${latestKnowledge ? `${latestKnowledge.title} - ${shortSnippet(latestKnowledge.body, 160)}` : "none"}`,
    `- Latest Codex session: ${sessionSummary}`,
    "",
    "## Next Codex Move",
    "",
    inferResumeMove({ latestRun, blockedRun, latestBridgeExecution, latestCheck }),
    "",
    "## Current Action Queue",
    "",
    actionQueueRuns.length
      ? actionQueueRuns.map((run) => `- ${formatResumeActionQueueRun(run)}`).join("\n")
      : "- No current action queue runs.",
    "",
    "## Auto Resume Triggers",
    "",
    "- If the user asks `AutomationOSは何をやっていた?`, `<project>は何をやっていた?`, `あと何をやる?`, `どこまで進んだ?`, `前回の続き`, or mentions a crash/new session, use this note as the entrypoint without asking the user to restate context.",
    "- This applies to every project indexed by the handoff system, not only Automation OS.",
    "- Then read `Project Handoff Index.md`, `Project Memory Map.md`, `Resume Contract.md`, and the target project's `STATE.md` / `AGENTS.md` / `automation.toml` / Skill/docs / latest artifacts directly.",
    "- Answer with confirmed current state, exact blocker, next action, and what remains unverified; do not treat this generated brief as completion proof.",
    "",
    "## Source Of Truth Ladder",
    "",
    "- 1. `resume-contract.json` and Obsidian Start Here notes: locator only.",
    "- 2. Project-owned `STATE.md`, `AGENTS.md`, `automation.toml`, Skill/docs, queue/readback, and latest artifacts: execution truth.",
    "- 3. Chat/session memory: hint only; use it only after the source-of-truth files above are fresh-read.",
    "",
    "## Session Hint",
    "",
    latestSession
      ? [
          `- Modified: ${latestSession.mtime}`,
          `- Last user: ${latestSession.lastUser}`,
          `- Last assistant: ${latestSession.lastAssistant}`
        ].join("\n")
      : "- No recent Codex session summary indexed.",
    "",
    "## Guardrail",
    "",
    "Before external writes, inspect the workflow-owned STATE.md, queue, artifacts, and billing-only proof boundary. Do not rely on this generated summary alone."
  ].join("\n");
}

function formatResumeActionQueueRun(run: RunRow): string {
  return `[[Runs#${anchor(run.id)}|${shortSnippet(run.name, 90)}]] (${run.status}, updated ${run.updated_at})`;
}

function renderActiveSessions(input: { codexSessions: CodexSessionSummary[]; generatedAt: string }): string {
  const activeSessions = input.codexSessions.slice(0, 10);
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: active-codex-sessions",
    "status: active",
    "priority: medium",
    "source_of_truth: ~/.codex/sessions latest jsonl files",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Active Sessions",
    "",
    "Codex session jsonl の最新10件だけを短く要約します。本文ログ、秘密、token、長文出力は保存しません。",
    "",
    activeSessions.length
      ? activeSessions.map((session) => renderActiveSessionItem(session)).join("\n")
      : "No recent Codex sessions found.",
    "",
    "## Rule",
    "",
    "Use this as a locator only. Open the original session or workspace state before making a completion claim."
  ].join("\n");
}

function renderConversationMemoryCards(input: {
  codexSessions: CodexSessionSummary[];
  memoryHints: MemoryProjectHint[];
  knowledgeNotes: KnowledgeNoteRow[];
  generatedAt: string;
}): string {
  const signals = extractUserConcernSignals(input.codexSessions, input.knowledgeNotes);
  const latestSessions = input.codexSessions.slice(0, 8);
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: conversation-memory-cards",
    "status: active",
    "priority: high",
    "source_of_truth: recent Codex session summaries and explicit memory hints; locator only",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Conversation Memory Cards",
    "",
    "ユーザーが繰り返し気にしていることを、次回Codexが先回りするためのカードです。会話記憶はhintであり、実作業前には必ずproject-owned source of truthを読み直します。",
    "",
    "## Cards",
    "",
    signals.length ? signals.map(renderUserSignalCard).join("\n") : "No repeated user concern signals detected yet.",
    "",
    "## Latest Session Hints",
    "",
    latestSessions.length
      ? latestSessions
          .map((session) => `- ${session.mtime} | ${session.cwd} | user=${session.lastUser} | assistant=${session.lastAssistant}`)
          .join("\n")
      : "- No recent sessions indexed.",
    "",
    "## Explicit Memory Hints",
    "",
    input.memoryHints.length
      ? input.memoryHints.slice(0, 12).map((hint) => `- ${hint.path}: ${hint.note}`).join("\n")
      : "- No explicit MEMORY.md project hints indexed.",
    "",
    "## Rule",
    "",
    "Do not answer from this page alone. Use it to choose what to read first, what to verify, and which concern to handle without asking the user to repeat it."
  ].join("\n");
}

function renderUserSignals(input: {
  codexSessions: CodexSessionSummary[];
  memoryHints: MemoryProjectHint[];
  knowledgeNotes: KnowledgeNoteRow[];
  generatedAt: string;
}): string {
  const signals = extractUserConcernSignals(input.codexSessions, input.knowledgeNotes);
  const signalMix = Object.fromEntries(signals.map((signal) => [signal.id, signal.count]));
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: user-signal-ledger",
    "status: active",
    "priority: high",
    "source_of_truth: recent Codex session summaries; inferred preferences are hints only",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# User Signals",
    "",
    "ユーザーの気にしている傾向をCodexの初動へ反映するための台帳です。確定した好みではなく、最近の会話からのsignalとして扱います。",
    "",
    "## Signal Mix",
    "",
    `- Signals detected: ${signals.length}`,
    `- Mix: ${formatCounts(signalMix)}`,
    `- Session summaries scanned: ${input.codexSessions.length}`,
    `- Knowledge notes scanned: ${input.knowledgeNotes.length}`,
    `- Memory hints indexed: ${input.memoryHints.length}`,
    "",
    "## Proactive Defaults",
    "",
    signals.length
      ? signals.map((signal) => `- ${signal.label}: ${signal.proactiveDefault}`).join("\n")
      : "- No proactive defaults inferred yet.",
    "",
    "## Boundaries",
    "",
    "- Explain confirmed / unconfirmed / next action separately when a task may be incomplete.",
    "- Read Obsidian locators first, then project-owned STATE/AGENTS/automation.toml/Skill/latest artifacts before resuming.",
    "- Do not cross billing, purchase, payment, checkout, CAPTCHA, OTP, security code, or identity verification without a human blocker note.",
    "",
    "## Refresh Rule",
    "",
    "This ledger is regenerated by Obsidian export. If the user corrects a preference, update durable AGENTS/STATE/Skill guidance or MEMORY.md rather than relying on chat memory."
  ].join("\n");
}

function renderProjectMemoryMap(input: {
  codexSessions: CodexSessionSummary[];
  automations: ReturnType<typeof getCodexCapabilities>["capabilities"]["automations"];
  memoryHints: MemoryProjectHint[];
  generatedAt: string;
}): string {
  const projects = groupSessionsByCwd(input.codexSessions);
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: project-memory-map",
    "status: active",
    "priority: high",
    "source_of_truth: ~/.codex/sessions locators, registered automations, and optional MEMORY.md hints",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Project Memory Map",
    "",
    "recent Codex sessionsをcwdごとにまとめたproject locatorです。Obsidianはcontrol surfaceで、execution source of truthはSTATE/artifacts/skills/docs/dbに残します。",
    "",
    "## Recent Codex Session Projects",
    "",
    projects.length
      ? projects.map((project) => renderProjectLocatorItem(project, input.memoryHints)).join("\n")
      : "No recent Codex session projects found.",
    "",
    "## Registered Automation Project Candidates",
    "",
    input.automations.length
      ? input.automations
          .map((automation) =>
            [
              `### ${automation.name}`,
              "",
              `- Path: \`${automation.path}\``,
              `- ID: ${automation.id}`,
              `- Status: ${automation.status}`,
              `- Memory hints: ${formatMemoryHints(input.memoryHints, automation.path)}`,
              `- Source of truth: automation.toml, workflow Skill/docs, STATE.md, queues, artifacts, and DB receipts.`,
              ""
            ].join("\n")
          )
          .join("\n")
      : "No registered automation candidates found.",
    "",
    "## Boundary",
    "",
    "Use this note to find the right project quickly. Do not treat it as proof of completion or as permission to resume external writes."
  ].join("\n");
}

function groupSessionsByCwd(sessions: CodexSessionSummary[]): Array<{
  cwd: string;
  count: number;
  latest: CodexSessionSummary;
}> {
  const grouped = groupBy(sessions, (session) => session.cwd || "unknown");
  return Array.from(grouped.entries())
    .map(([cwd, items]) => ({
      cwd,
      count: items.length,
      latest: [...items].sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime))[0]
    }))
    .sort((a, b) => Date.parse(b.latest.mtime) - Date.parse(a.latest.mtime));
}

function renderProjectLocatorItem(project: { cwd: string; count: number; latest: CodexSessionSummary }, memoryHints: MemoryProjectHint[]): string {
  return [
    `### ${project.cwd}`,
    "",
    `- CWD: ${project.cwd}`,
    `- Session count: ${project.count}`,
    `- Latest modified: ${project.latest.mtime}`,
    `- Latest session id: ${project.latest.sessionId}`,
    `- Latest file: \`${project.latest.file}\``,
    `- Last user: ${project.latest.lastUser}`,
    `- Last assistant: ${project.latest.lastAssistant}`,
    `- Memory hints: ${formatMemoryHints(memoryHints, project.cwd)}`,
    ""
  ].join("\n");
}

function renderCockpitProjectItem(item: ProjectAuditItem, memoryHints: MemoryProjectHint[]): string {
  const latestArtifact = item.artifacts.find((artifact) => artifact.latest) ?? item.artifacts[0];
  return [
    `### ${item.project.label}`,
    "",
    `- Project id: \`${item.project.id}\``,
    `- Status: ${item.status}`,
    `- Root: \`${item.project.root}\` (${item.rootExists ? "exists" : "missing"})`,
    `- STATE.md: ${item.stateExists ? `present (${item.stateMtime})` : "missing"}`,
    `- Source of truth: ${item.project.source_of_truth.map((source) => `\`${source}\``).join(", ")}`,
    `- Latest artifact pointer: ${latestArtifact ? `${latestArtifact.path} latest=${latestArtifact.latest ?? "none"} mtime=${latestArtifact.latestMtime ?? "unknown"}` : "none"}`,
    `- Memory hints: ${formatMemoryHints(memoryHints, item.project.root)}`,
    `- Next action: ${item.nextAction}`,
    `- Issues: ${item.issues.length ? item.issues.map((issue) => `${issue.severity}:${issue.code}`).join(", ") : "none"}`,
    ""
  ].join("\n");
}

function formatMemoryHints(memoryHints: MemoryProjectHint[], path: string): string {
  const matched = memoryHints.filter((hint) => pathsMayReferToSameProject(path, hint.path)).slice(0, 3);
  if (matched.length === 0) return "none";
  return matched.map((hint) => `${shortSnippet(hint.path, 180)} - ${hint.note}`).join("; ");
}

function extractUserConcernSignals(sessions: CodexSessionSummary[], knowledgeNotes: KnowledgeNoteRow[]): UserConcernSignal[] {
  const specs = [
    {
      id: "resume_continuity",
      label: "Resume continuity",
      pattern: /どこまで|前回|続き|落ち|クラッシュ|セッション|覚えて|説明しなく|resume|handoff/i,
      preferredBehavior: "Start from Obsidian locators and project-owned STATE/artifacts before asking the user to restate context.",
      proactiveDefault: "For any resume-like question, read Resume Current Work, Project Handoff Index, Project Cockpit, and the target project source-of-truth first.",
      avoid: "Do not ask the user to re-explain a project before checking available locators."
    },
    {
      id: "obsidian_as_memory",
      label: "Obsidian as working memory",
      pattern: /Obsidian|メモ|記憶|覚え|vault|second brain/i,
      preferredBehavior: "Keep Obsidian as the readable memory/control surface while preserving source-of-truth boundaries.",
      proactiveDefault: "Create or update generated Obsidian surfaces when a recurring workflow would otherwise live only in chat.",
      avoid: "Do not treat generated Obsidian pages as completion proof."
    },
    {
      id: "proactive_defaults",
      label: "Proactive defaults",
      pattern: /先に|自動|言う必要|言わなく|やってくれ|傾向|先回り|proactive/i,
      preferredBehavior: "Infer the likely next read/check/fix from durable state and act on low-risk local improvements.",
      proactiveDefault: "When a repeated concern appears, promote it into AGENTS.md, STATE.md, Skill/runbook, tests, or generated dashboard surfaces.",
      avoid: "Do not leave durable behavior as a chat promise."
    },
    {
      id: "proof_rigor",
      label: "Proof rigor",
      pattern: /証跡|確認|本当に|完了|未確認|readback|proof|artifact|検証/i,
      preferredBehavior: "Separate confirmed state, unverified state, blocker, and complete conditions.",
      proactiveDefault: "Before saying complete, check user-visible result, readback/artifact, cleanup proof, and source-of-truth update where applicable.",
      avoid: "Do not equate a local edit or screenshot with end-to-end completion."
    },
    {
      id: "scope_beyond_one_project",
      label: "All-project scope",
      pattern: /全て|全部|すべて|automation OSにかぎらず|全プロジェクト|横断/i,
      preferredBehavior: "Apply resume/memory behavior across all registered projects, not only Automation OS.",
      proactiveDefault: "Route generic project questions through Project Cockpit and Project Health before narrowing to one workflow.",
      avoid: "Do not overfit a fix to only the example project named in the chat."
    },
    {
      id: "safety_boundaries",
      label: "Human safety boundaries",
      pattern: /勝手|承認|支払|購入|課金|認証|OTP|CAPTCHA|本人確認|応募|投稿|送信/i,
      preferredBehavior: "Proceed with read-only/local preparation, then stop at human-only or approval-required gates.",
      proactiveDefault: "Record exact blocker and resume condition instead of trying to cross protected external steps.",
      avoid: "Do not automate protected external actions or identity/security steps."
    }
  ];
  const texts = [
    ...sessions.flatMap((session) => [session.lastUser, session.lastAssistant]),
    ...knowledgeNotes.flatMap((note) => [note.title, note.body])
  ].filter((text) => text && text !== "none");
  return specs
    .map((spec) => {
      const evidence = texts
        .filter((text) => spec.pattern.test(text))
        .slice(0, 4)
        .map((text) => shortSnippet(text, 180));
      return {
        id: spec.id,
        label: spec.label,
        count: evidence.length,
        evidence,
        preferredBehavior: spec.preferredBehavior,
        proactiveDefault: spec.proactiveDefault,
        avoid: spec.avoid
      };
    })
    .filter((signal) => signal.count > 0);
}

function renderUserSignalCard(signal: UserConcernSignal): string {
  return [
    `### ${signal.label}`,
    "",
    `- Signal id: ${signal.id}`,
    `- Count: ${signal.count}`,
    `- Preferred behavior: ${signal.preferredBehavior}`,
    `- Proactive default: ${signal.proactiveDefault}`,
    `- Avoid: ${signal.avoid}`,
    `- Evidence: ${signal.evidence.join(" | ") || "none"}`,
    ""
  ].join("\n");
}

function classifyBlockerText(value: unknown): string {
  const text = String(value ?? "").toLowerCase();
  if (/captcha|otp|security code|本人確認|identity|verification/.test(text)) return "human_identity_or_security";
  if (/payment|billing|purchase|checkout|invoice|支払|課金|購入/.test(text)) return "billing_or_purchase_boundary";
  if (/auth|login|credential|permission|認証|権限/.test(text)) return "auth_or_permission";
  if (/proof|artifact|readback|receipt|証跡|確認|completion/.test(text)) return "proof_or_readback_missing";
  if (/surface|selector|playwright|browser|ui|dom|screenshot|callable/.test(text)) return "browser_surface";
  if (/timeout|timed out|stale|hang|crash|落ち/.test(text)) return "runner_stability";
  if (/rate|quota|limit|429/.test(text)) return "quota_or_limit";
  if (/state\.md|source of truth|正本|handoff|context/.test(text)) return "source_of_truth_boundary";
  if (/regression|success_path_regression|勝ち筋/.test(text)) return "success_path_regression";
  return "other";
}

function renderActiveSessionItem(session: CodexSessionSummary): string {
  return [
    `## ${session.sessionId}`,
    "",
    `- Modified: ${session.mtime}`,
    `- File: \`${session.file}\``,
    `- CWD: ${session.cwd}`,
    `- Last user: ${session.lastUser}`,
    `- Last assistant: ${session.lastAssistant}`,
    ""
  ].join("\n");
}

function renderDecisionLog(input: {
  runs: RunRow[];
  bridgeExecutions: BridgeExecutionRow[];
  commandQueue: CommandQueueItem[];
  generatedAt: string;
}): string {
  const decidedRuns = input.runs.filter((run) => ["complete", "blocked", "partial", "cancelled"].includes(run.status)).slice(0, 20);
  const bridgeDecisions = input.bridgeExecutions
    .filter((execution) => execution.approval_id || execution.status === "blocked")
    .slice(0, 10);
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: decision-log",
    "status: active",
    "priority: medium",
    "source_of_truth: Automation OS runs, bridge executor ledger, and Obsidian command intake",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Decision Log",
    "",
    "Codex app が次回の判断で参照する、最近の完了・停止・承認境界の要約です。長い根拠本文は元artifactに残します。",
    "",
    "## Run Decisions",
    "",
    decidedRuns.length
      ? decidedRuns
          .map((run) => {
            const metadata = compactMetadata(parseJson<Record<string, unknown>>(run.metadata_json, {}));
            return [
              `### ${run.id}`,
              "",
              `- Status: ${run.status}`,
              `- Objective: ${run.objective}`,
              `- Updated: ${run.updated_at}`,
              `- Decision basis: ${formatMetadataValue(metadata.stop_reason ?? metadata.proof_gate ?? metadata.run_contract_summary ?? "run status and proof pointers")}`,
              `- Revisit when: source-of-truth STATE, queue, or artifact changes.`,
              ""
            ].join("\n");
          })
          .join("\n")
      : "No recent run decisions indexed yet.",
    "",
    "## Bridge / Approval Decisions",
    "",
    bridgeDecisions.length
      ? bridgeDecisions
          .map((execution) =>
            [
              `### ${execution.id}`,
              "",
              `- Capability: ${execution.capability_id}`,
              `- Approval: ${execution.approval_id ?? "none"}`,
              `- Status: ${execution.status}/${execution.executor_status}`,
              `- Decision basis: ${execution.summary}`,
              ""
            ].join("\n")
          )
          .join("\n")
      : "No recent bridge decisions indexed yet.",
    "",
    "## Pending Human Decisions",
    "",
    input.commandQueue.length
      ? input.commandQueue.map((item) => `- ${item.priority}: [[${item.file.replace(/\.md$/, "")}|${item.title}]] - ${item.command}`).join("\n")
      : "- No pending handwritten command decisions indexed."
  ].join("\n");
}

function renderFailureFixLog(input: {
  runs: RunRow[];
  proofs: ProofRow[];
  bridgeExecutions: BridgeExecutionRow[];
  knowledgeNotes: KnowledgeNoteRow[];
  generatedAt: string;
}): string {
  const proofsByRun = groupBy(input.proofs, (proof) => proof.run_id);
  const failedOrStoppedRuns = input.runs.filter((run) => ["blocked", "partial", "failed", "cancelled"].includes(run.status)).slice(0, 20);
  const completedRuns = input.runs.filter((run) => run.status === "complete" || run.status === "completed").slice(0, 20);
  const bridgeFailures = input.bridgeExecutions
    .filter((execution) => execution.status === "blocked" || execution.executor_status !== "connected")
    .slice(0, 12);
  const fixNotes = input.knowledgeNotes
    .filter((note) => /fix|repair|resolved|pass|成功|修正|直し|再発防止|test|proof gate/i.test(`${note.title}\n${note.body}`))
    .slice(0, 12);
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: failure-fix-log",
    "status: active",
    "priority: high",
    "source_of_truth: Automation OS runs/proofs/bridge ledger, tests, and knowledge notes",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Failure Fix Log",
    "",
    "失敗した条件、どう直したか、うまくいった証跡を人間が後から読むためのログです。ここは要約であり、完了判定はrun/proof/readback/test/artifactに戻します。",
    "",
    "## Recent Failures And Fix Targets",
    "",
    failedOrStoppedRuns.length
      ? failedOrStoppedRuns
          .map((run) => {
            const metadata = compactMetadata(parseJson<Record<string, unknown>>(run.metadata_json, {}));
            const reason = metadata.stop_reason ?? metadata.proof_gate ?? metadata.proof_summary ?? metadata.run_contract_summary ?? run.objective;
            const category = classifyBlockerText(`${run.name} ${run.objective} ${formatMetadataValue(reason)}`);
            const linkedProofs = proofsByRun.get(run.id) ?? [];
            return [
              `### ${run.id}`,
              "",
              `- Failed/stopped condition: ${run.status}`,
              `- Workflow: ${run.name}`,
              `- Category: ${category}`,
              `- Observed reason: ${shortSnippet(formatMetadataValue(reason), 260)}`,
              `- Fix location: AGENTS.md, STATE.md, Skill/runbook, registered automation prompt, proof gate, or tests depending on repeatability.`,
              `- Verification to require: ${linkedProofs.length ? linkedProofs.slice(0, 3).map((proof) => proof.uri).join(", ") : "fresh run/proof/readback/test evidence missing"}`,
              `- Next resume read: run metadata, project STATE, queue/readback, latest artifact, and related tests.`,
              ""
            ].join("\n");
          })
          .join("\n")
      : "No failed, blocked, partial, or cancelled runs indexed.",
    "",
    "## Recent Successful Verifications",
    "",
    completedRuns.length
      ? completedRuns
          .map((run) => {
            const metadata = compactMetadata(parseJson<Record<string, unknown>>(run.metadata_json, {}));
            const linkedProofs = proofsByRun.get(run.id) ?? [];
            return [
              `### ${run.id}`,
              "",
              `- Successful condition: ${run.status}`,
              `- Workflow: ${run.name}`,
              `- Verification basis: ${shortSnippet(formatMetadataValue(metadata.proof_summary ?? metadata.run_contract_summary ?? metadata.proof_gate ?? "status only"), 240)}`,
              `- Proof/readback: ${linkedProofs.length ? linkedProofs.slice(0, 3).map((proof) => proof.uri).join(", ") : "missing proof pointer"}`,
              `- Reuse rule: promote stable fixes into tests, proof gates, AGENTS.md, STATE.md, Skill/runbook, or registered automation prompt.`,
              ""
            ].join("\n");
          })
          .join("\n")
      : "No completed runs indexed.",
    "",
    "## Bridge / Callable Surface Fixes",
    "",
    bridgeFailures.length
      ? bridgeFailures
          .map((execution) => `- ${execution.capability_id}: ${execution.status}/${execution.executor_status}; fix/readback target=${shortSnippet(execution.summary, 220)}`)
          .join("\n")
      : "- No bridge or callable-surface failures indexed.",
    "",
    "## Fix Notes",
    "",
    fixNotes.length
      ? fixNotes.map((note) => `- ${note.title}: ${shortSnippet(note.body, 220)}`).join("\n")
      : "- No explicit fix notes indexed.",
    "",
    "## Rule",
    "",
    "A failure is only considered fixed when the correction is in a durable layer and a targeted test, dry-run, readback, or artifact verifies the original failure mode no longer occurs."
  ].join("\n");
}

function renderWeeklyReview(input: {
  runs: RunRow[];
  proofs: ProofRow[];
  bridgeExecutions: BridgeExecutionRow[];
  commandQueue: CommandQueueItem[];
  generatedAt: string;
}): string {
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentRuns = input.runs.filter((run) => Date.parse(run.updated_at) >= since);
  const recentProofs = input.proofs.filter((proof) => Date.parse(proof.created_at) >= since);
  const recentBridge = input.bridgeExecutions.filter((execution) => Date.parse(execution.updated_at) >= since);
  const statusMix = countBy(recentRuns, (run) => run.status);
  const blockers = selectAttentionRuns(recentRuns).slice(0, 8);
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: weekly-review",
    "status: active",
    "priority: medium",
    "source_of_truth: Automation OS recent runs, proofs, bridge ledger, and command intake",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Weekly Review",
    "",
    "Codex app とAutomation群の7日間レビューです。改善候補を出すための要約で、実行正本ではありません。",
    "",
    "## Snapshot",
    "",
    `- Runs updated in 7 days: ${recentRuns.length}`,
    `- Proofs created in 7 days: ${recentProofs.length}`,
    `- Bridge executions updated in 7 days: ${recentBridge.length}`,
    `- Open command queue items: ${input.commandQueue.length}`,
    `- Status mix: ${Object.entries(statusMix)
      .map(([status, count]) => `${status}=${count}`)
      .join(", ") || "none"}`,
    "",
    "## Needs Attention",
    "",
    blockers.length
      ? blockers.map((run) => `- [[Runs#${anchor(run.id)}|${run.name}]] is ${run.status}; inspect exact blocker and latest proof before retry.`).join("\n")
      : "- No blocked or partial runs updated in the last 7 days.",
    "",
    "## Suggested Improvement Loop",
    "",
    "- Promote repeated blockers into runbooks or registered automation checks.",
    "- Convert useful handwritten command items into project notes, decisions, or explicit Codex runs.",
    "- Keep proof claims linked to receipts, artifacts, or no-action evidence before marking work complete."
  ].join("\n");
}

function renderAttentionItems(input: { blockedRuns: RunRow[]; executorBlocked: BridgeExecutionRow[] }): string[] {
  const items = [
    ...input.blockedRuns.map((run) => `- Run attention: [[Runs#${anchor(run.id)}|${run.name}]] is ${run.status}.`),
    ...input.executorBlocked.map((execution) => `- Bridge attention: ${execution.capability_id} is ${execution.status}/${execution.executor_status} - ${execution.summary}`)
  ];
  return items.length ? items : ["- No blocked or partial runs indexed in the latest export window."];
}

function renderDashboardBase(input: { filename: string; title: string; folder: string; generatedAt: string }): string {
  if (input.filename === secondBrainReviewBaseFilename) return renderSecondBrainReviewBase(input);
  return [
    "# generated_by: automation-os",
    `# generated_at: ${input.generatedAt}`,
    "filters:",
    "  and:",
    "    - 'file.ext == \"md\"'",
    `    - 'file.inFolder(\"${input.folder}\")'`,
    "properties:",
    "  file.name:",
    "    displayName: Note",
    "  status:",
    "    displayName: Status",
    "  priority:",
    "    displayName: Priority",
    "  owner:",
    "    displayName: Owner",
    "  source_of_truth:",
    "    displayName: Source of truth",
    "  required_proof:",
    "    displayName: Required proof",
    "  next_action:",
    "    displayName: Next action",
    "  blocker:",
    "    displayName: Blocker",
    "  file.mtime:",
    "    displayName: Modified",
    "views:",
    "  - type: table",
    `    name: ${JSON.stringify(input.title)}`,
    "    limit: 100",
    "    order:",
    "      - file.name",
    "      - status",
    "      - priority",
    "      - owner",
    "      - source_of_truth",
    "      - required_proof",
    "      - next_action",
    "      - blocker",
    "      - file.mtime"
  ].join("\n");
}

function renderSecondBrainReviewBase(input: { title: string; folder: string; generatedAt: string }): string {
  return [
    "# generated_by: automation-os",
    `# generated_at: ${input.generatedAt}`,
    "filters:",
    "  and:",
    "    - 'file.ext == \"md\"'",
    `    - 'file.inFolder(\"${input.folder}\")'`,
    "properties:",
    "  file.name:",
    "    displayName: Note",
    "  auto_process:",
    "    displayName: Auto process",
    "  processing_status:",
    "    displayName: Processing status",
    "  suggested_destination:",
    "    displayName: Suggested destination",
    "  progressive_summary:",
    "    displayName: Progressive summary",
    "  source_of_truth:",
    "    displayName: Source of truth",
    "  external_action_required:",
    "    displayName: External action required",
    "  approval_required:",
    "    displayName: Approval required",
    "  file.mtime:",
    "    displayName: Modified",
    "views:",
    "  - type: table",
    `    name: ${JSON.stringify(input.title)}`,
    "    limit: 100",
    "    order:",
    "      - file.name",
    "      - auto_process",
    "      - processing_status",
    "      - suggested_destination",
    "      - progressive_summary",
    "      - source_of_truth",
    "      - external_action_required",
    "      - approval_required",
    "      - file.mtime"
  ].join("\n");
}

function renderOrientationIndex(input: {
  subdir: string;
  filename: string;
  title: string;
  description: string;
  notes: VaultNoteRow[];
  generatedAt: string;
}): string {
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: vault-orientation-index",
    `folder: ${input.subdir}`,
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    `# ${input.title}`,
    "",
    input.description,
    "",
    "## Boundary",
    "",
    "This generated index is an orientation surface only. Project decisions, execution state, and external actions must stay in their source-of-truth files, systems, or artifacts.",
    "",
    "## Notes",
    "",
    input.notes.length
      ? input.notes
          .map((note) =>
            [
              `### [[${note.file.replace(/\.md$/, "")}|${note.title}]]`,
              "",
              `- File: \`${note.file}\``,
              `- Kind: ${note.kind}`,
              `- Status: ${note.status}`,
              `- Updated: ${note.updated}`,
              `- Source of truth: ${note.sourceOfTruth}`,
              ""
            ].join("\n")
          )
          .join("\n")
      : "No notes indexed yet.",
    "",
    "## Capture Rule",
    "",
    "New unsorted work starts as a handwritten note under `09_Inbox/`. Codex may classify it into Projects, Research, Decisions, or Runbooks only after preserving any source-of-truth pointer."
  ].join("\n");
}

function renderTemplate(input: { filename: string; title: string; kind: string; body: string; generatedAt: string }): string {
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: obsidian-template",
    `template_kind: ${input.kind}`,
    "auto_process: obsidian_internal_only",
    "processing_status: draft",
    "progressive_summary: \"\"",
    "distillation: \"\"",
    "next_use: \"\"",
    "unresolved_question: \"\"",
    "review_cycle: weekly",
    "external_action_required: false",
    "approval_required: false",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    input.body
  ].join("\n");
}

function ensureCommandQueueSeed(controlPanelDir: string): void {
  const path = join(controlPanelDir, commandQueueFilename);
  if (existsSync(path)) return;
  writeFileSync(
    path,
    [
      "---",
      "kind: command-queue",
      "status: active",
      "source_of_truth: handwritten Obsidian command queue",
      "---",
      "",
      "# Command Queue",
      "",
      "Codex App に後で頼みたいことを短く置く場所です。未完了タスクだけが `Command Queue Intake` に拾われます。",
      "",
      "## Queue",
      "",
      "- ここに `- [ ] priority: medium | Codexに頼みたいこと` の形で追加する。",
      "",
      "## Rule",
      "",
      "外部送信、応募、投稿、削除を含む依頼はsource of truthとproof条件を確認して進める。課金・購入・支払い・決済だけ停止する。"
    ].join("\n")
  );
}

function readCommandQueue(vaultPath: string): CommandQueueItem[] {
  const candidates = [
    join(vaultPath, defaultControlPanelSubdir, commandQueueFilename),
    ...readMarkdownFilesIfExists(join(vaultPath, "09_Inbox"))
  ];
  return candidates
    .flatMap((path) => readCommandQueueFromFile(vaultPath, path))
    .filter((item) => item.status !== "done" && item.status !== "complete")
    .slice(0, 50);
}

function readCommandQueueFromFile(vaultPath: string, path: string): CommandQueueItem[] {
  if (!existsSync(path) || !statSync(path).isFile()) return [];
  const body = readFileSync(path, "utf8");
  const frontmatter = parseFrontmatter(body);
  if (frontmatter.generated_by === "automation-os") return [];
  const rel = relative(vaultPath, path);
  const title = String(frontmatter.title ?? basename(path, ".md"));
  const frontmatterCommand = frontmatter.command ?? frontmatter.next_action ?? frontmatter.nextAction;
  const kind = String(frontmatter.kind ?? "");
  const needsClassification = String(frontmatter.needs_classification ?? frontmatter.needsClassification ?? "");
  const isCommandQueue = rel === join(defaultControlPanelSubdir, commandQueueFilename);
  const isInboxCandidate = rel.startsWith("09_Inbox/") && (kind === "inbox" || needsClassification === "yes");
  if ((!isCommandQueue && !isInboxCandidate) || frontmatter.status === "done") return [];
  const items = extractUncheckedTasks(body).map((task, index) => ({
    file: rel,
    title: `${title} #${index + 1}`,
    priority: extractInlineField(task, "priority") ?? String(frontmatter.priority ?? "medium"),
    status: extractInlineField(task, "status") ?? "open",
    command: stripInlineFields(task),
    sourceOfTruth: String(frontmatter.source_of_truth ?? frontmatter.sourceOfTruth ?? "handwritten Obsidian note"),
    blocker: String(frontmatter.blocker ?? "none")
  }));
  if (items.length) return items;
  if (!frontmatterCommand) return [];
  return [
    {
      file: rel,
      title,
      priority: String(frontmatter.priority ?? "medium"),
      status: String(frontmatter.status ?? "open"),
      command: String(frontmatterCommand),
      sourceOfTruth: String(frontmatter.source_of_truth ?? frontmatter.sourceOfTruth ?? "handwritten Obsidian note"),
      blocker: String(frontmatter.blocker ?? "none")
    }
  ];
}

function readSecondBrainClassificationCandidates(vaultPath: string): SecondBrainClassificationCandidate[] {
  const inboxDir = join(vaultPath, "09_Inbox");
  if (!existsSync(inboxDir)) return [];
  return readMarkdownFiles(inboxDir)
    .map((path) => readSecondBrainCandidateFromFile(vaultPath, path))
    .filter((candidate): candidate is SecondBrainClassificationCandidate => Boolean(candidate))
    .slice(0, 80);
}

function readSecondBrainCandidateFromFile(vaultPath: string, path: string): SecondBrainClassificationCandidate | undefined {
  if (!existsSync(path) || !statSync(path).isFile()) return undefined;
  const body = readFileSync(path, "utf8");
  const frontmatter = parseFrontmatter(body);
  if (frontmatter.generated_by === "automation-os") return undefined;
  const rel = relative(vaultPath, path);
  if (!rel.startsWith("09_Inbox/")) return undefined;
  const kind = String(frontmatter.kind ?? "").trim();
  const needsClassification = String(frontmatter.needs_classification ?? frontmatter.needsClassification ?? "").trim().toLowerCase();
  if (kind !== "inbox" && needsClassification !== "yes") return undefined;
  const rawSourceUrl = firstPresentString(frontmatter.source_url, frontmatter.sourceUrl) ?? extractFirstUrl(body) ?? "unknown";
  const rawSourceOfTruth = firstPresentString(frontmatter.source_of_truth, frontmatter.sourceOfTruth) ?? rawSourceUrl;
  const sourceUrl = redactSecondBrainPointer(rawSourceUrl);
  const sourceOfTruth = redactSecondBrainPointer(rawSourceOfTruth);
  const captureType =
    firstPresentString(frontmatter.capture_type, frontmatter.captureType, frontmatter.source_type, frontmatter.sourceType) ??
    inferCaptureType({ sourceUrl, body });
  const title = String(frontmatter.title ?? basename(path, ".md"));
  const processingStatus = firstPresentString(frontmatter.processing_status, frontmatter.processingStatus) ?? "queued";
  const suggested = firstPresentString(frontmatter.suggested_destination, frontmatter.suggestedDestination);
  const inferred = suggested ? normalizeSecondBrainSuggestedDestination(suggested) : inferSecondBrainDestination({ title, body, captureType });
  return {
    file: rel,
    title,
    kind: kind || "inbox",
    status: String(frontmatter.status ?? "open"),
    processingStatus,
    sourceUrl,
    captureType,
    sourceOfTruth: sourceOfTruth || "unknown",
    suggestedDestination: inferred.destination,
    externalActionRequired: frontmatterFlagIsTrue(frontmatter.external_action_required, frontmatter.externalActionRequired),
    approvalRequired: frontmatterFlagIsTrue(frontmatter.approval_required, frontmatter.approvalRequired),
    reason: inferred.reason,
    excerpt: shortSnippet(stripFrontmatter(body), 220)
  };
}

function readSecondBrainDigestNotes(vaultPath: string): SecondBrainDigestNote[] {
  const folders = ["05_Projects", "06_Research", "07_Decisions", "08_Runbooks", "09_Inbox"];
  return folders
    .flatMap((folder) => {
      const dir = join(vaultPath, folder);
      if (!existsSync(dir)) return [];
      return readMarkdownFiles(dir).map((path) => readSecondBrainDigestNoteFromFile(vaultPath, folder, path));
    })
    .filter((note): note is SecondBrainDigestNote => Boolean(note))
    .sort((a, b) => a.file.localeCompare(b.file));
}

function readSecondBrainDigestNoteFromFile(vaultPath: string, folder: string, path: string): SecondBrainDigestNote | undefined {
  if (!existsSync(path) || !statSync(path).isFile()) return undefined;
  const body = readFileSync(path, "utf8");
  const frontmatter = parseFrontmatter(body);
  if (frontmatter.generated_by === "automation-os") return undefined;
  const rel = relative(vaultPath, path);
  return {
    file: rel,
    title: String(frontmatter.title ?? basename(path, ".md")),
    folder,
    kind: String(frontmatter.kind ?? "note"),
    status: String(frontmatter.status ?? "unknown"),
    sourceOfTruth: redactSecondBrainPointer(frontmatter.source_of_truth ?? frontmatter.sourceOfTruth ?? "unknown")
  };
}

function normalizeSecondBrainSuggestedDestination(value: string): { destination: string; reason: string } {
  const destination = normalizeSecondBrainDestination(value);
  if (destination === "unknown") {
    return { destination, reason: "frontmatter suggested_destination outside allowlist; kept as unknown" };
  }
  return { destination, reason: "frontmatter suggested_destination" };
}

function normalizeSecondBrainDestination(value: unknown): string {
  const destination = String(value ?? "").trim();
  return secondBrainDestinationAllowlist.has(destination) ? destination : "unknown";
}

function redactSecondBrainPointer(value: unknown): string {
  const text = redactSensitive(String(value ?? "unknown").trim());
  return text || "unknown";
}

function inferCaptureType(input: { sourceUrl: string; body: string }): string {
  if (input.sourceUrl !== "unknown") return "url";
  if (/\barticle\b|記事|論文|paper/i.test(input.body)) return "article";
  return "note";
}

function inferSecondBrainDestination(input: { title: string; body: string; captureType: string }): { destination: string; reason: string } {
  const text = `${input.title}\n${stripFrontmatter(input.body)}`;
  if (/source of truth|正本|STATE\.md|runbook|手順|復旧手順|repeatable/i.test(text)) {
    return { destination: "08_Runbooks", reason: "mentions repeatable procedure or source-of-truth operation" };
  }
  if (/decision|decided|判断|決定|採用理由|revisit/i.test(text)) {
    return { destination: "07_Decisions", reason: "mentions a decision or revisit condition" };
  }
  if (input.captureType === "article" || /\bresearch\b|調査|比較|source_url|sourceUrl|question|unresolved/i.test(text)) {
    return { destination: "06_Research", reason: "looks like source-backed research material" };
  }
  if (/\bproject\b|プロジェクト|objective|milestone|deliverable/i.test(text)) {
    return { destination: "05_Projects", reason: "mentions project/objective structure" };
  }
  return { destination: "09_Inbox", reason: "insufficient signal; keep in inbox for safe review" };
}

function readCodexSessions(inputDir?: string): CodexSessionSummary[] {
  const sessionsDir = resolve(inputDir ?? process.env.AUTOMATION_OS_CODEX_SESSIONS_DIR ?? join(homedir(), ".codex", "sessions"));
  if (!existsSync(sessionsDir)) return [];
  try {
    return listJsonlFiles(sessionsDir)
      .flatMap((path) => {
        try {
          return [{ path, stat: statSync(path) }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, 50)
      .map(({ path, stat }) => summarizeCodexSession(path, sessionsDir, stat.mtime));
  } catch {
    return [];
  }
}

function readMemoryProjectHints(inputFile?: string): MemoryProjectHint[] {
  const memoryFile = resolve(inputFile ?? process.env.AUTOMATION_OS_CODEX_MEMORY_FILE ?? join(homedir(), ".codex", "memories", "MEMORY.md"));
  if (!existsSync(memoryFile)) return [];
  const hints: MemoryProjectHint[] = [];
  for (const line of safeReadText(memoryFile).split("\n").slice(0, 2500)) {
    for (const path of extractMemoryPaths(line)) {
      hints.push({
        path,
        note: shortSnippet(line.replace(/^\s*[-#]+\s*/, ""), 180)
      });
    }
  }
  const seen = new Set<string>();
  return hints
    .filter((hint) => {
      const key = `${hint.path}\n${hint.note}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 80);
}

function extractMemoryPaths(line: string): string[] {
  const paths: string[] = [];
  for (const match of line.matchAll(/scope:\s*`([^`]+)`/g)) {
    paths.push(match[1].trim());
  }
  for (const match of line.matchAll(/\bcwd(?:_family)?=([^;\),\n]+)/g)) {
    const raw = match[1].trim().replace(/^`|`$/g, "");
    paths.push(...raw.split(/\s+and\s+|,\s*/).map((entry) => entry.trim()));
  }
  return paths
    .map((path) => path.replace(/^`|`$/g, ""))
    .filter((path) => path.startsWith("/") || path.startsWith("~/"))
}

function pathsMayReferToSameProject(left: string, right: string): boolean {
  const leftPaths = normalizeComparablePaths(left.replace(/^`|`$/g, ""));
  const rightPaths = normalizeComparablePaths(right.replace(/^`|`$/g, ""));
  if (leftPaths.length === 0 || rightPaths.length === 0) return left === right;
  return leftPaths.some((leftPath) => rightPaths.some((rightPath) => isSameOrInside(leftPath, rightPath) || isSameOrInside(rightPath, leftPath)));
}

function normalizeComparablePaths(path: string): string[] {
  const trimmed = path.trim();
  if (!trimmed) return [];
  if (!trimmed.startsWith("~/")) return [resolve(isAbsolute(trimmed) ? trimmed : join(process.cwd(), trimmed))];
  const suffix = trimmed.slice(2);
  return Array.from(new Set([homedir(), process.env.AUTOMATION_OS_CAPABILITIES_HOME].filter((root): root is string => Boolean(root)).map((root) => resolve(root, suffix))));
}

function selectResumeCodexSession(sessions: CodexSessionSummary[]): CodexSessionSummary | undefined {
  return sessions.find((session) => isCurrentProjectCwd(session.cwd));
}

function isCurrentProjectCwd(cwd: string): boolean {
  if (!cwd || cwd === "unknown") return false;
  const sessionCwd = normalizeSessionPath(cwd);
  if (!sessionCwd) return false;
  return currentProjectRoots().some((root) => isSameOrInside(sessionCwd, root));
}

function currentProjectRoots(): string[] {
  return Array.from(new Set([process.cwd(), "/Users/nichikatanaka/Documents/Codex/automation-os"].map((path) => resolve(path))));
}

function normalizeSessionPath(path: string): string | undefined {
  const trimmed = path.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2));
  return resolve(isAbsolute(trimmed) ? trimmed : join(process.cwd(), trimmed));
}

function isSameOrInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function listJsonlFiles(dir: string): string[] {
  try {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      try {
        const stat = statSync(path);
        if (stat.isDirectory()) return listJsonlFiles(path);
        return entry.endsWith(".jsonl") ? [path] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function summarizeCodexSession(path: string, sessionsDir: string, mtime: Date): CodexSessionSummary {
  const rel = relative(sessionsDir, path);
  const fallbackId = basename(path, ".jsonl").replace(/^rollout-/, "");
  let sessionId = fallbackId;
  let cwd = "unknown";
  let lastUser = "none";
  let lastAssistant = "none";
  const lines = safeReadText(path).split("\n").filter(Boolean);
  for (const line of lines) {
    const parsed = parseJson<Record<string, unknown>>(line, {});
    const foundSessionId = findFirstStringByKey(parsed, ["id", "thread_id", "threadId", "session_id", "sessionId"]);
    if (foundSessionId && sessionId === fallbackId) sessionId = shortSnippet(foundSessionId, 80);
    const foundCwd = findFirstStringByKey(parsed, ["cwd", "workdir", "working_directory", "current_dir", "currentDirectory"]);
    if (foundCwd) cwd = shortSnippet(foundCwd, 120);
    const message = extractCodexMessage(parsed);
    if (message?.role === "user") lastUser = shortSnippet(message.text, 180);
    if (message?.role === "assistant") lastAssistant = shortSnippet(message.text, 180);
  }
  return {
    file: shortSnippet(rel, 160),
    sessionId: shortSnippet(sessionId, 80),
    mtime: mtime.toISOString(),
    cwd,
    lastUser,
    lastAssistant
  };
}

function safeReadText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function extractCodexMessage(value: unknown): { role: "user" | "assistant"; text: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.type === "response_item" && record.item) return extractCodexMessage(record.item);
  const role = typeof record.role === "string" ? record.role : undefined;
  if (role !== "user" && role !== "assistant") {
    for (const key of ["message", "payload", "item"]) {
      const nested = extractCodexMessage(record[key]);
      if (nested) return nested;
    }
    return undefined;
  }
  const text = extractText(record.content) || extractText(record.text) || extractText(record.message);
  return text ? { role, text } : undefined;
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join(" ");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of ["text", "input_text", "output_text", "content", "value"]) {
    const text = extractText(record[key]);
    if (text) return text;
  }
  return "";
}

function findFirstStringByKey(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstStringByKey(item, keys);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === "string" && record[key].trim()) return record[key];
  }
  for (const nested of Object.values(record)) {
    const found = findFirstStringByKey(nested, keys);
    if (found) return found;
  }
  return undefined;
}

function extractUncheckedTasks(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => line.match(/^\s*[-*]\s+\[\s\]\s+(.+)$/)?.[1]?.trim())
    .filter((task): task is string => Boolean(task));
}

function extractInlineField(text: string, field: string): string | undefined {
  const pattern = new RegExp(`(?:^|\\|)\\s*${field}\\s*:\\s*([^|]+)`, "i");
  return text.match(pattern)?.[1]?.trim();
}

function stripInlineFields(text: string): string {
  return text
    .split("|")
    .map((part) => part.trim())
    .filter((part) => !/^(priority|status)\s*:/i.test(part))
    .join(" | ")
    .trim();
}

function readDocs(docsDir: string): DocRow[] {
  if (!existsSync(docsDir)) return [];
  return readdirSync(docsDir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => {
      const path = join(docsDir, file);
      if (!statSync(path).isFile()) return undefined;
      const body = readFileSync(path, "utf8");
      return {
        file: relative(process.cwd(), path),
        title: basename(file, ".md"),
        body
      };
    })
    .filter((doc): doc is DocRow => Boolean(doc));
}

function readVaultNotes(vaultPath: string, subdir: string, generatedFilename: string): VaultNoteRow[] {
  const dir = join(vaultPath, subdir);
  const generatedPath = join(dir, generatedFilename);
  if (!existsSync(dir)) return [];
  return readMarkdownFiles(dir)
    .filter((path) => path !== generatedPath)
    .map((path) => {
      const body = readFileSync(path, "utf8");
      const frontmatter = parseFrontmatter(body);
      if (frontmatter.generated_by === "automation-os") return undefined;
      const rel = relative(vaultPath, path);
      const title = String(frontmatter.title ?? basename(path, ".md"));
      return {
        file: rel,
        title,
        kind: String(frontmatter.kind ?? frontmatter.template ?? "note"),
        status: String(frontmatter.status ?? "unknown"),
        updated: String(frontmatter.updated ?? "unknown"),
        sourceOfTruth: String(frontmatter.source_of_truth ?? frontmatter.sourceOfTruth ?? "note")
      };
    })
    .filter((note): note is VaultNoteRow => Boolean(note))
    .sort((a, b) => a.file.localeCompare(b.file));
}

function readMarkdownFiles(dir: string): string[] {
  return readMarkdownFilesFrom(dir, dir);
}

function readMarkdownFilesIfExists(dir: string): string[] {
  return existsSync(dir) ? readMarkdownFiles(dir) : [];
}

function readMarkdownFilesFrom(dir: string, rootDir: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      if (entry === ".backups" || entry === ".obsidian") return [];
      if (dir === rootDir && (entry === "Templates" || entry === "_templates")) return [];
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return readMarkdownFilesFrom(path, rootDir);
      return entry.endsWith(".md") ? [path] : [];
    })
    .sort();
}

function parseFrontmatter(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  return Object.fromEntries(
    match[1]
      .split("\n")
      .map((line) => line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/))
      .filter((line): line is RegExpMatchArray => Boolean(line))
      .map((line) => [line[1], line[2].trim().replace(/^["']|["']$/g, "")])
  );
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function firstPresentString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function frontmatterFlagIsTrue(...values: unknown[]): boolean {
  return values.some((value) => String(value ?? "").trim().toLowerCase() === "true");
}

function extractFirstUrl(markdown: string): string | undefined {
  return stripFrontmatter(markdown).match(/\bhttps?:\/\/[^\s<>)\]]+/i)?.[0];
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(([left], [right]) => left.localeCompare(right));
  return entries.length ? entries.map(([key, count]) => `${key}=${count}`).join(", ") : "none";
}

function compactMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const allowed = [
    "command",
    "worker_protocol",
    "worker_mode",
    "proof_gate",
    "run_contract_summary",
    "contract_version",
    "daily_ai_status",
    "proof_summary",
    "stop_reason"
  ];
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => allowed.includes(key)));
}

function countBy<T>(items: T[], pick: (item: T) => string): Record<string, number> {
  return items.reduce<Record<string, number>>((acc, item) => {
    const key = pick(item);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

function groupBy<T>(items: T[], pick: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = pick(item);
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return map;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return parseJson<Record<string, unknown>>(value, {});
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function optionalLowerString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function markdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function inlineJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("[[", "[ [").replaceAll("]]", "] ]");
}

function formatMetadataValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "none";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return inlineJson(value);
}

function formatRunBrief(run: RunRow | undefined): string {
  if (!run) return "none";
  const metadata = compactMetadata(parseJson<Record<string, unknown>>(run.metadata_json, {}));
  const basis = metadata.stop_reason ?? metadata.proof_summary ?? metadata.proof_gate ?? metadata.run_contract_summary ?? run.objective;
  return `[[Runs#${anchor(run.id)}|${shortSnippet(run.name, 90)}]] (${run.status}, updated ${run.updated_at}) - ${shortSnippet(formatMetadataValue(basis), 180)}`;
}

function inferResumeMove(input: {
  latestRun: RunRow | undefined;
  blockedRun: RunRow | undefined;
  latestBridgeExecution: BridgeExecutionRow | undefined;
  latestCheck: SystemCheckRow | undefined;
}): string {
  if (input.blockedRun) {
    return `- Resume from ${formatRunBrief(input.blockedRun)}. Inspect exact blocker, source-of-truth state, queue, and latest proof before retrying.`;
  }
  if (input.latestBridgeExecution && (input.latestBridgeExecution.status === "blocked" || input.latestBridgeExecution.executor_status !== "connected")) {
    return `- Resolve bridge boundary first: ${shortSnippet(input.latestBridgeExecution.summary, 180)}`;
  }
  if (!input.latestCheck || input.latestCheck.status !== "ok") {
    return "- Run a local screen/system check before claiming the control surface is healthy.";
  }
  if (input.latestRun) {
    if (input.latestRun.status === "partial" || input.latestRun.status === "blocked") {
      return "- No current resume candidate. Start from the next explicit user request, then verify source-of-truth state before acting.";
    }
    return `- Latest run is ${input.latestRun.status}; verify proof pointers, then choose the next explicit user request.`;
  }
  return "- No run history is indexed yet. Start with the user request, then create a run/proof trail.";
}

function shortSnippet(value: unknown, maxLength: number): string {
  const text = redactSensitive(String(value ?? "none").replace(/\s+/g, " ").trim());
  if (text.length <= maxLength) return text || "none";
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function redactSensitive(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\/\s:@]+):([^\/\s@]+)@/gi, "$1[redacted-auth]@")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted-jwt]")
    .replace(/\b(?:sk|rk|pk|ghp|github_pat|xox[baprs]?)-[A-Za-z0-9_-]{8,}\b/g, "[redacted-token]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [redacted]")
    .replace(/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*[:=]\s*['"]?[^'"\s,)}]+/g, "$1=[redacted]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*['\"]?[^'\"\\s,)}]+/gi, "$1=[redacted]")
    .replace(/\b(session[_-]?token|sessionid|session_id|connect\.sid|auth[_-]?token|csrf[_-]?token|csrftoken|xsrf[_-]?token|sid)\s*=\s*[^;\s,]+/gi, "$1=[redacted-session]")
    .replace(/\[redacted\][A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/\b[A-Za-z0-9_=-]{32,}\b/g, redactHighEntropyToken);
}

function redactHighEntropyToken(token: string): string {
  if (isCodexLocatorToken(token)) return token;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[+/=_-]/].filter((pattern) => pattern.test(token)).length;
  const uniqueChars = new Set(token).size;
  if (classes >= 2 && uniqueChars >= 16) return "[redacted-token]";
  return token;
}

function isCodexLocatorToken(token: string): boolean {
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  if (new RegExp(`^${uuidPattern.source}$`, "i").test(token)) return true;
  if (new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-${uuidPattern.source}(?:\\.jsonl)?$`, "i").test(token)) {
    return true;
  }
  return false;
}

function hasGeneratedMarkerForFilename(filename: string, body: string): boolean {
  if (filename.endsWith(".base")) return hasBaseGeneratedMarker(body);
  if (filename.endsWith(".md")) return hasMarkdownGeneratedFrontmatter(body);
  return false;
}

function hasMarkdownGeneratedFrontmatter(markdown: string): boolean {
  const match = markdown.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  return Boolean(match?.[1].split("\n").some((line) => line.trim() === "generated_by: automation-os"));
}

function hasBaseGeneratedMarker(body: string): boolean {
  return body.split("\n").slice(0, 5).some((line) => line.trim() === "# generated_by: automation-os");
}

function safeTimestamp(timestamp: string): string {
  return timestamp.replace(/[^0-9A-Za-z_.-]+/g, "-");
}

function anchor(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

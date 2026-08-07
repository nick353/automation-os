import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getCodexCapabilities } from "../codex/capabilities.js";
import { buildCodexAppParityLedgerItems, type CodexAppParityLedgerItem } from "../codex/parityLedger.js";
import { querySql } from "../db/client.js";
import { buildResumeContract, renderResumeContractMarkdown, resolveResumeContractPath, writeResumeContract } from "../resumeContract.js";
import { selectActionQueueRuns, selectAttentionRuns, selectResumeCandidateRun } from "../runs/selectors.js";
import { auditProjects, writeProjectAuditStatus, type ProjectAuditItem, type ProjectAuditResult } from "../projects/projectAuditor.js";
import { defaultObsidianVaultPath, resolveConfiguredObsidianVaultPath } from "./vaultGuard.js";
import { buildAndWriteRedactedSessionIndex, readRedactedSessionIndex } from "./sessionIndex.js";
import { withVaultWriteLockSync } from "./vaultWriteLock.js";

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
const decisionDashboardBaseFilename = "Decision Dashboard.base";
const legacyDecisionDashboardTemplateId = "decision-dashboard-legacy-v1";
const legacyDecisionDashboardBase = [
  "filters:",
  "  and:",
  "    - file.ext == \"md\"",
  "    - file.inFolder(\"07_Decisions\")",
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
  "    name: Decision Dashboard",
  "    order:",
  "      - file.name",
  "      - status",
  "      - priority",
  "      - owner",
  "      - source_of_truth",
  "      - required_proof",
  "      - next_action",
  "      - blocker",
  "      - file.mtime",
  "    limit: 100"
].join("\n");
let skipNonGeneratedFiles = false;
let skippedNonGeneratedFiles: string[] = [];
let legacyAdoptionMetadata: ObsidianLegacyAdoptionMetadata | null = null;
let activeExportRunId = "";
const activeSessionsFilename = "Active Sessions.md";
const conversationMemoryCardsFilename = "Conversation Memory Cards.md";
const sessionKnowledgeDigestFilename = "Session Knowledge Digest.md";
const userSignalsFilename = "User Signals.md";
const skillRegistryFilename = "Skill Registry.md";
const skillCandidatesFilename = "Skill Candidates.md";
const codexAppParityLedgerFilename = "Codex App Parity Ledger.md";
const projectMemoryMapFilename = "Project Memory Map.md";
const knowledgeReuseLedgerFilename = "Knowledge Reuse Ledger.md";
const obsidianCodexSelfDiagnosisFilename = "Obsidian x Codex Self Diagnosis.md";
const obsidianCodexWeeklyCheckFilename = "Obsidian x Codex Weekly Check.md";
const obsidianAutonomyOpsMemoFilename = "Obsidian Autonomy Ops Memo.md";
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
const secondBrainPromotionTargetFolders = ["05_Projects", "06_Research", "07_Decisions", "08_Runbooks", "09_Inbox"];
const secondBrainPromotionDestinationAllowlist = new Set(["05_Projects", "06_Research", "07_Decisions", "08_Runbooks"]);
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
  progressiveSummary: string;
  distillation: string;
  nextUse: string;
  unresolvedQuestion: string;
  reviewCycle: string;
  distillationQuality: string;
  knowledgeReuseStatus: string;
  processedAt: string;
  sourceKey: string;
  duplicateSourceCount: number;
  duplicateSourceFiles: string[];
};

type AutoPromotedSecondBrainKnowledge = {
  file: string;
  title: string;
  destination: string;
  progressiveSummary: string;
  distillation: string;
  nextUse: string;
  sourceUrl: string;
  sourceOfTruth: string;
  contentSha256: string;
};

type SecondBrainDigestNote = {
  file: string;
  title: string;
  folder: string;
  kind: string;
  status: string;
  sourceOfTruth: string;
};

type KnowledgeUseReceipt = {
  usedAt: string;
  projectId: string;
  projectLabel: string;
  projectRoot: string;
  match: string;
  contextPackPath: string | null;
  contextPackAvailable: boolean;
  authorityFilesAvailable: number;
  sourceOfTruthAvailable: number;
};

type SkillCandidateNote = {
  file: string;
  title: string;
  kind: string;
  reason: string;
  knowledgeReuseStatus: string;
  distillation: string;
  nextUse: string;
};

type CodexSessionSummary = {
  file: string;
  sessionId: string;
  mtime: string;
  cwd: string;
  lastUser: string;
  lastAssistant: string;
  threadSource: string;
  parentThreadId: string | null;
};

type SessionIndexInventory = {
  path: string;
  available: boolean;
  indexedEntries: number;
  pendingHumanReview: number;
  promotionAllowed: number;
  latestMtime: string | null;
};

type ProjectProofPointer = {
  id: string;
  projectId: string;
  projectLabel: string;
  artifactRoot: string;
  path: string;
  mtime: string;
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
  codexSessionIndexFile?: string;
  refreshCodexSessionIndex?: boolean;
  codexMemoryFile?: string;
  knowledgeUseLedgerFile?: string;
  resumeContractPath?: string;
  skipNonGenerated?: boolean;
};

export type ObsidianLegacyAdoptionMetadata = {
  status: "adopted" | "blocked" | "post_write_failed";
  export_run_id: string;
  target_path: string;
  template_id: string;
  pre_sha256: string;
  post_sha256: string | null;
  backup_path: string | null;
  backup_sha256: string | null;
  readback: {
    attempted: boolean;
    ok: boolean;
    sha256: string | null;
    error: string | null;
  };
  reason?: string;
};

class ObsidianLegacyAdoptionError extends Error {
  constructor(public readonly metadata: ObsidianLegacyAdoptionMetadata) {
    super(`legacy_adoption_${metadata.status}:${metadata.reason ?? "unknown"}`);
    this.name = "ObsidianLegacyAdoptionError";
  }
}

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
  parityManifestFile?: string;
  legacyAdoption?: ObsidianLegacyAdoptionMetadata | null;
  skippedNonGeneratedFiles?: string[];
  exportRunId?: string;
  backupRetention?: ObsidianBackupRetentionSummary;
};

export type ObsidianBackupRetentionSummary = {
  keepCount: number;
  prunedDirs: string[];
  skippedDirs: string[];
};

export function matchesLegacyDecisionDashboardBase(body: string): boolean {
  return body === legacyDecisionDashboardBase || body === `${legacyDecisionDashboardBase}\n`;
}

export function resolveObsidianVaultPath(input?: string): string {
  return resolveConfiguredObsidianVaultPath(input);
}

export function exportObsidianVault(options: ObsidianExportOptions = {}): ObsidianExportResult {
  const vaultPath = resolveObsidianVaultPath(options.vaultPath);
  return withVaultWriteLockSync(vaultPath, "automation-os-export", () => exportObsidianVaultUnlocked(options, vaultPath));
}

function exportObsidianVaultUnlocked(options: ObsidianExportOptions, vaultPath: string): ObsidianExportResult {
  skipNonGeneratedFiles = options.skipNonGenerated === true || process.env.AUTOMATION_OS_OBSIDIAN_SKIP_NON_GENERATED === "1";
  skippedNonGeneratedFiles = [];
  legacyAdoptionMetadata = null;
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
  const exportRunId = process.env.AUTOMATION_OS_OBSIDIAN_EXPORT_RUN_ID || randomUUID();
  activeExportRunId = exportRunId;

  const runs = querySql<RunRow>("SELECT * FROM runs ORDER BY created_at DESC LIMIT 200");
  const proofs = querySql<ProofRow>("SELECT * FROM proofs ORDER BY created_at DESC LIMIT 500");
  const checks = querySql<SystemCheckRow>("SELECT * FROM system_checks ORDER BY created_at DESC LIMIT 20");
  const bridgeActions = querySql<BridgeActionRow>("SELECT * FROM bridge_actions ORDER BY created_at DESC LIMIT 50");
  const bridgeExecutions = querySql<BridgeExecutionRow>("SELECT * FROM bridge_executions ORDER BY created_at DESC LIMIT 50");
  const knowledgeNotes = querySql<KnowledgeNoteRow>("SELECT * FROM knowledge_notes ORDER BY updated_at DESC LIMIT 100");
  const researchPlans = querySql<ResearchPlanRow>("SELECT * FROM research_plans ORDER BY updated_at DESC LIMIT 20");
  const docs = readDocs(docsDir);
  const capabilities = getCodexCapabilities();
  const codexSessions = readCodexSessions(
    options.codexSessionsDir,
    options.codexSessionIndexFile,
    options.refreshCodexSessionIndex !== true
  );
  refreshCodexSessionIndexIfNeeded(options);
  const sessionIndexInventory = readSessionIndexInventory(options.codexSessionIndexFile);
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
  const projectProofPointers = collectProjectProofPointers(projectAudit);
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
    knowledgeReuseLedgerFilename,
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
    sessionKnowledgeDigestFilename,
    userSignalsFilename,
    secondBrainIntakeFilename,
    secondBrainAutoProcessorFilename,
    activeSessionsFilename,
    skillRegistryFilename,
    skillCandidatesFilename,
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
  const autoPromotedKnowledge = readAutoPromotedSecondBrainKnowledge(vaultPath);
  const skillCandidates = readSkillCandidateNotes(vaultPath);
  const knowledgeUseReceipts = readKnowledgeUseReceipts(options.knowledgeUseLedgerFile);
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
    writeMarkdown(outputDir, "Knowledge.md", renderKnowledge({ bridgeActions, bridgeExecutions, knowledgeNotes, checks, autoPromotedKnowledge }), exportTimestamp),
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
    renderProofInbox({ runs, proofs, projectProofPointers, bridgeExecutions, generatedAt: exportTimestamp }),
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
        projectProofPointers,
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
      sessionKnowledgeDigestFilename,
      renderSessionKnowledgeDigest({ codexSessions, sessionIndexInventory, generatedAt: exportTimestamp }),
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
      startHereDir,
      knowledgeReuseLedgerFilename,
      renderKnowledgeReuseLedger({ receipts: knowledgeUseReceipts, generatedAt: exportTimestamp }),
      exportTimestamp
    ),
    writeMarkdown(
      startHereDir,
      obsidianAutonomyOpsMemoFilename,
      renderObsidianAutonomyOpsMemo({ generatedAt: exportTimestamp }),
      exportTimestamp
    ),
    writeMarkdown(
      startHereDir,
      obsidianCodexSelfDiagnosisFilename,
      renderObsidianCodexSelfDiagnosis({
        projectAudit,
        commandQueue,
        proofs,
        projectProofPointers,
        runs,
        generatedAt: exportTimestamp
      }),
      exportTimestamp
    ),
    writeMarkdown(
      startHereDir,
      obsidianCodexWeeklyCheckFilename,
      renderObsidianCodexWeeklyCheck({
        projectAudit,
        commandQueue,
        proofs,
        projectProofPointers,
        runs,
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
      renderWeeklyReview({ runs, proofs, projectProofPointers, bridgeExecutions, commandQueue, projectAudit, generatedAt: exportTimestamp }),
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
      renderSecondBrainAutoProcessor({ candidates: secondBrainCandidates, autoPromotedCount: autoPromotedKnowledge.length, generatedAt: exportTimestamp }),
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
    ),
    writeMarkdown(
      controlPanelDir,
      skillCandidatesFilename,
      renderSkillCandidates({ candidates: skillCandidates, receipts: knowledgeUseReceipts, generatedAt: exportTimestamp }),
      exportTimestamp
    )
  ];
  const dashboardFiles = [
    ...dashboardBases.map((base) =>
      writeMarkdown(
        dashboardDir,
        base.filename,
        renderDashboardBase({ ...base, generatedAt: exportTimestamp }),
        exportTimestamp,
        base.filename === decisionDashboardBaseFilename
      )
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
  const parityManifestFile = writeParityManifest(
    join(outputDir, "obsidian-export-manifest.json"),
    exportRunId,
    exportTimestamp,
    legacyAdoptionMetadata,
    [
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
    ]
  );

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
    parityManifestFile,
    legacyAdoption: legacyAdoptionMetadata,
    skippedNonGeneratedFiles: [...new Set(skippedNonGeneratedFiles)],
    exportRunId,
    orientationFiles,
    templateFiles,
    backupRetention
  };
}

type ObsidianParityManifest = {
  generated_by: "automation-os";
  schema_version: 1;
  export_run_id: string;
  generated_at: string;
  coverage_epoch: string;
  source_revision: string | null;
  generator_version: string;
  files: Array<{ path: string; sha256: string; size_bytes: number; mtime: string }>;
  skipped_non_generated_files: string[];
  legacy_adoption: ObsidianLegacyAdoptionMetadata | null;
};

function writeParityManifest(
  path: string,
  exportRunId: string,
  generatedAt: string,
  legacyAdoption: ObsidianLegacyAdoptionMetadata | null,
  targets: string[]
): string {
  if (existsSync(path)) {
    try {
      const existing = JSON.parse(readFileSync(path, "utf8")) as Partial<ObsidianParityManifest>;
      if (existing.generated_by !== "automation-os") {
        throw new Error(`Refusing to overwrite non-generated Obsidian file: ${path}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Refusing to overwrite")) throw error;
      throw new Error(`Refusing to overwrite invalid generated Obsidian manifest: ${path}`);
    }
  }
  const files = [...new Set(targets)]
    .filter((target): target is string => typeof target === "string" && existsSync(target) && statSync(target).isFile())
    .map((target) => {
      const stat = statSync(target);
      return {
        path: target,
        sha256: createHash("sha256").update(readFileSync(target)).digest("hex"),
        size_bytes: stat.size,
        mtime: stat.mtime.toISOString()
    };
  });
  validateLegacyAdoptionAudit(legacyAdoption, exportRunId, files);
  const manifest: ObsidianParityManifest = {
    generated_by: "automation-os",
    schema_version: 1,
    export_run_id: exportRunId,
    generated_at: generatedAt,
    coverage_epoch: generatedAt,
    source_revision: process.env.GIT_COMMIT || process.env.SOURCE_REVISION || null,
    generator_version: "automation-os:obsidian-export:v1",
    files,
    legacy_adoption: legacyAdoption,
    skipped_non_generated_files: [...new Set(skippedNonGeneratedFiles)]
  };
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const manifestFd = openSync(tmpPath, "r");
  try {
    fsyncSync(manifestFd);
  } finally {
    closeSync(manifestFd);
  }
  renameSync(tmpPath, path);
  fsyncDirectory(dirname(path));
  return path;
}

function validateLegacyAdoptionAudit(
  adoption: ObsidianLegacyAdoptionMetadata | null,
  exportRunId: string,
  files: Array<{ path: string; sha256: string; size_bytes: number; mtime: string }>
): void {
  if (!adoption) return;
  if (adoption.export_run_id !== exportRunId) throw new Error("legacy_adoption_run_id_mismatch");
  if (adoption.template_id !== legacyDecisionDashboardTemplateId) throw new Error("legacy_adoption_template_id_mismatch");
  if (resolve(adoption.target_path) !== adoption.target_path) throw new Error("legacy_adoption_target_not_canonical");
  if (adoption.status !== "adopted") return;
  const targetStat = lstatSync(adoption.target_path);
  if (targetStat.isSymbolicLink() || !targetStat.isFile() || targetStat.nlink > 1) throw new Error("legacy_adoption_target_readback_not_regular");
  const targetBytes = readFileSync(adoption.target_path);
  const targetSha256 = createHash("sha256").update(targetBytes).digest("hex");
  if (!adoption.post_sha256 || targetSha256 !== adoption.post_sha256) throw new Error("legacy_adoption_target_hash_mismatch");
  if (!adoption.readback.attempted || !adoption.readback.ok || adoption.readback.sha256 !== targetSha256) throw new Error("legacy_adoption_readback_proof_mismatch");
  if (!adoption.backup_path || !adoption.backup_sha256 || resolve(adoption.backup_path) !== adoption.backup_path) throw new Error("legacy_adoption_backup_proof_missing");
  const backupStat = lstatSync(adoption.backup_path);
  if (backupStat.isSymbolicLink() || !backupStat.isFile() || backupStat.nlink > 1) throw new Error("legacy_adoption_backup_not_regular");
  const backupSha256 = createHash("sha256").update(readFileSync(adoption.backup_path)).digest("hex");
  if (backupSha256 !== adoption.backup_sha256 || backupSha256 !== adoption.pre_sha256) throw new Error("legacy_adoption_backup_proof_mismatch");
  if (!files.some((file) => resolve(file.path) === adoption.target_path && file.sha256 === targetSha256)) throw new Error("legacy_adoption_manifest_target_missing");
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
      if (filename === decisionDashboardBaseFilename && matchesLegacyDecisionDashboardBase(existing)) continue;
      if (skipNonGeneratedFiles) {
        skippedNonGeneratedFiles.push(path);
        continue;
      }
      throw new Error(`Refusing to overwrite non-generated Obsidian file: ${path}`);
    }
  }
}

function writeMarkdown(outputDir: string, filename: string, body: string, exportTimestamp: string, allowLegacyAdoption = false): string {
  const path = join(outputDir, filename);
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (!hasGeneratedMarkerForFilename(filename, existing)) {
      if (allowLegacyAdoption && matchesLegacyDecisionDashboardBase(existing)) {
        return adoptLegacyDecisionDashboard(path, body, exportTimestamp);
      }
      if (skipNonGeneratedFiles) {
        skippedNonGeneratedFiles.push(path);
        return path;
      }
      throw new Error(`Refusing to overwrite non-generated Obsidian file: ${path}`);
    }
    const backupDir = join(outputDir, ".backups", safeTimestamp(exportTimestamp));
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(path, join(backupDir, filename));
  }
  const tmpPath = join(outputDir, `.${filename}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, body.endsWith("\n") ? body : `${body}\n`);
  renameSync(tmpPath, path);
  return path;
}

function adoptLegacyDecisionDashboard(path: string, renderedBody: string, exportTimestamp: string): string {
  const metadataBase: ObsidianLegacyAdoptionMetadata = {
    status: "blocked",
    export_run_id: activeExportRunId,
    target_path: resolve(path),
    template_id: legacyDecisionDashboardTemplateId,
    pre_sha256: "",
    post_sha256: null,
    backup_path: null,
    backup_sha256: null,
    readback: { attempted: false, ok: false, sha256: null, error: null }
  };
  try {
    const canonicalPath = resolve(path);
    const fileStat = lstatSync(canonicalPath);
    if (fileStat.isSymbolicLink() || fileStat.nlink > 1) {
      throw new Error("legacy_adoption_path_not_regular");
    }
    const original = readFileSync(canonicalPath);
    const preSha256 = createHash("sha256").update(original).digest("hex");
    const backupPath = `${canonicalPath}.bak-${safeTimestamp(exportTimestamp)}-${randomUUID().slice(0, 8)}`;
    const backupFd = openSync(backupPath, "wx", 0o600);
    try {
      writeSync(backupFd, original);
      fsyncSync(backupFd);
    } finally {
      closeSync(backupFd);
    }
    const backupSha256 = createHash("sha256").update(readFileSync(backupPath)).digest("hex");
    if (backupSha256 !== preSha256) throw new Error("legacy_adoption_backup_hash_mismatch");
    fsyncDirectory(dirname(canonicalPath));

    const beforeRenameStat = lstatSync(canonicalPath);
    const beforeRenameBytes = readFileSync(canonicalPath);
    const beforeRenameSha256 = createHash("sha256").update(beforeRenameBytes).digest("hex");
    if (
      beforeRenameStat.isSymbolicLink() ||
      beforeRenameStat.nlink !== fileStat.nlink ||
      beforeRenameStat.dev !== fileStat.dev ||
      beforeRenameStat.ino !== fileStat.ino ||
      beforeRenameSha256 !== preSha256
    ) {
      throw new Error("legacy_adoption_target_changed_before_rename");
    }

    const tempPath = `${canonicalPath}.${process.pid}.${Date.now()}.tmp`;
    const rendered = renderedBody.endsWith("\n") ? renderedBody : `${renderedBody}\n`;
    const renderedBytes = Buffer.from(rendered, "utf8");
    const tempFd = openSync(tempPath, "wx", 0o600);
    try {
      writeSync(tempFd, renderedBytes);
      fsyncSync(tempFd);
    } finally {
      closeSync(tempFd);
    }
    renameSync(tempPath, canonicalPath);
    fsyncDirectory(dirname(canonicalPath));
    const postSha256 = createHash("sha256").update(readFileSync(canonicalPath)).digest("hex");
    const expectedPostSha256 = createHash("sha256").update(renderedBytes).digest("hex");
    const readbackOk = postSha256 === expectedPostSha256 && hasBaseGeneratedMarker(readFileSync(canonicalPath, "utf8"));
    const metadata: ObsidianLegacyAdoptionMetadata = {
      status: readbackOk ? "adopted" : "post_write_failed",
      export_run_id: activeExportRunId,
      target_path: canonicalPath,
      template_id: legacyDecisionDashboardTemplateId,
      pre_sha256: preSha256,
      post_sha256: postSha256,
      backup_path: backupPath,
      backup_sha256: backupSha256,
      readback: { attempted: true, ok: readbackOk, sha256: postSha256, error: readbackOk ? null : "legacy_adoption_post_write_readback_mismatch" },
      reason: readbackOk ? undefined : "legacy_adoption_post_write_readback_mismatch"
    };
    legacyAdoptionMetadata = metadata;
    if (!readbackOk) throw new ObsidianLegacyAdoptionError(metadata);
    return path;
  } catch (error) {
    const metadata = error instanceof ObsidianLegacyAdoptionError ? error.metadata : { ...metadataBase, reason: error instanceof Error ? error.message : "legacy_adoption_failed" };
    legacyAdoptionMetadata = metadata;
    throw new ObsidianLegacyAdoptionError(metadata);
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
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
  autoPromotedKnowledge: AutoPromotedSecondBrainKnowledge[];
}): string {
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: knowledge-index",
    `auto_promoted_internal_knowledge_count: ${input.autoPromotedKnowledge.length}`,
    "auto_promoted_internal_knowledge_read_only: true",
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
    "## Auto-promoted internal knowledge",
    "",
    "Only handwritten, review-ready Second Brain notes that pass every fail-closed eligibility check are shown here.",
    "This is internal/read-only knowledge and is never authorization for external action.",
    "",
    input.autoPromotedKnowledge.length
      ? input.autoPromotedKnowledge.map((knowledge) => renderAutoPromotedSecondBrainKnowledge(knowledge)).join("\n")
      : "No reviewed Second Brain notes met the fail-closed promotion predicate.",
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

function renderAutoPromotedSecondBrainKnowledge(knowledge: AutoPromotedSecondBrainKnowledge): string {
  return [
    `### [[${knowledge.file.replace(/\.md$/, "")}|${shortSnippet(knowledge.title, 160)}]]`,
    "",
    "- promotion_status: auto_promoted",
    "- eligibility: eligible",
    `- destination: ${knowledge.destination}`,
    `- progressive_summary: ${shortSnippet(knowledge.progressiveSummary, 420)}`,
    `- distillation: ${shortSnippet(knowledge.distillation, 420)}`,
    `- next_use: ${shortSnippet(knowledge.nextUse, 420)}`,
    `- source_url: ${redactSecondBrainPointer(knowledge.sourceUrl)}`,
    `- source_of_truth: ${redactSecondBrainPointer(knowledge.sourceOfTruth)}`,
    `- content_sha256: ${knowledge.contentSha256}`,
    "- external_action_authorized: false",
    "- rule: internal/read-only knowledge only; not external-action authorization.",
    ""
  ].join("\n");
}

function renderDocs(docs: DocRow[]): string {
  const docsByPath = new Map(docs.map((doc) => [resolve(process.cwd(), doc.file), doc]));
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
    ...docs.flatMap((doc) => [
      `## ${doc.title}`,
      "",
      `Source: \`${doc.file}\``,
      "",
      normalizeEmbeddedDocLinks(doc, docsByPath).trim(),
      ""
    ])
  ].join("\n");
}

function normalizeEmbeddedDocLinks(doc: DocRow, docsByPath: Map<string, DocRow>): string {
  return doc.body.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label: string, rawTarget: string) => {
    const target = rawTarget.trim();
    if (/^(?:https?:|mailto:|#)/i.test(target)) return match;
    const pathPart = target.split("#", 1)[0];
    if (pathPart.endsWith(".md")) {
      const absoluteTarget = resolve(process.cwd(), dirname(doc.file), pathPart);
      const targetDoc = docsByPath.get(absoluteTarget);
      if (targetDoc) return `[[Docs#${anchor(targetDoc.title)}|${label}]]`;
    }
    return `${label} (\`${target}\`)`;
  });
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

function renderKnowledgeReuseLedger(input: { receipts: KnowledgeUseReceipt[]; generatedAt: string }): string {
  const recent = [...input.receipts].sort((left, right) => right.usedAt.localeCompare(left.usedAt));
  const sevenDaysAgo = Date.parse(input.generatedAt) - 7 * 24 * 60 * 60 * 1000;
  const recentWeek = recent.filter((receipt) => Date.parse(receipt.usedAt) >= sevenDaysAgo);
  const projectCounts = countBy(recent, (receipt) => receipt.projectId || "unknown");
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: knowledge-reuse-ledger",
    "status: active",
    "source_of_truth: data/obsidian-knowledge-use-ledger.jsonl",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Knowledge Reuse Ledger",
    "",
    "CodexがObsidian project memoryを実際に解決したread receiptです。ユーザーの検索文や会話本文は保存しません。",
    "",
    "## Summary",
    "",
    `- Total resolutions: ${recent.length}`,
    `- Last 7 days: ${recentWeek.length}`,
    `- Projects used: ${Object.keys(projectCounts).length}`,
    `- Project mix: ${formatCounts(projectCounts)}`,
    "",
    "## Recent Uses",
    "",
    ...(recent.length
      ? recent.slice(0, 50).map((receipt) =>
          `- ${receipt.usedAt} | ${receipt.projectLabel || receipt.projectId} | match=${receipt.match} | authority=${receipt.authorityFilesAvailable} | source_of_truth=${receipt.sourceOfTruthAvailable} | context_pack=${receipt.contextPackAvailable ? "available" : "missing"}`
        )
      : ["- No project-memory use has been recorded yet."]),
    "",
    "## Boundary",
    "",
    "This receipt proves that a locator was used. It does not prove task completion, correctness, approval, or that generated Obsidian text was treated as authority. Fresh-read project-owned truth remains required."
  ].join("\n");
}

function renderSkillCandidates(input: { candidates: SkillCandidateNote[]; receipts: KnowledgeUseReceipt[]; generatedAt: string }): string {
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: skill-candidates",
    "status: active",
    "source_of_truth: handwritten notes with skill_candidate true",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Skill Candidates",
    "",
    "Second Brainが検出した反復可能な判断・手順の候補です。このページはSkillを作成、更新、実行、インストールしません。",
    "",
    "## Summary",
    "",
    `- Candidates: ${input.candidates.length}`,
    `- Project-memory resolutions recorded: ${input.receipts.length}`,
    "",
    "## Candidates",
    "",
    ...(input.candidates.length
      ? input.candidates.map((candidate) =>
          [
            `### [[${candidate.file.replace(/\.md$/, "")}|${candidate.title}]]`,
            "",
            `- File: \`${candidate.file}\``,
            `- Kind: ${candidate.kind}`,
            `- Knowledge reuse status: ${candidate.knowledgeReuseStatus}`,
            `- Candidate reason: ${shortSnippet(candidate.reason, 220)}`,
            `- Distillation: ${shortSnippet(candidate.distillation, 260)}`,
            `- Next use: ${shortSnippet(candidate.nextUse, 220)}`,
            ""
          ].join("\n")
        )
      : ["No Skill candidates are currently marked in handwritten notes."]),
    "",
    "## Promotion Rule",
    "",
    "Promote a candidate only after the same judgment or procedure is reused in real work, its source-of-truth and stop conditions are explicit, and a user-requested Skill creation or an existing Skill maintenance task authorizes the change. Never auto-install from this page."
  ].join("\n");
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
  projectProofPointers: ProjectProofPointer[];
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
  const projectItems = input.projectProofPointers.slice(0, 40).map((pointer) =>
    [
      `### ${pointer.projectLabel}`,
      "",
      `- Project: ${pointer.projectId}`,
      `- Artifact root: ${redactSensitive(pointer.artifactRoot)}`,
      `- Latest file locator: ${redactSensitive(pointer.path)}`,
      `- Modified: ${pointer.mtime}`,
      `- Classification: locator only; not DB proof or completion proof`,
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
    "## Project-Owned Artifact Locators",
    "",
    "These are fresh-read entrypoints from registered project artifact roots. They do not satisfy a proof gate by themselves.",
    "",
    projectItems.length ? projectItems.join("\n") : "No project-owned artifact locators indexed yet.",
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

function computeObsidianCodexSelfDiagnosis(input: {
  projectAudit: ProjectAuditResult;
  commandQueue: CommandQueueItem[];
  proofs: ProofRow[];
  runs: RunRow[];
}): { score: number; weakestItem: string; why: string } {
  let score = 5;
  if (input.projectAudit.summary.blocked > 0) score -= 2;
  else if (input.projectAudit.summary.attention > 0) score -= 2;
  if (input.commandQueue.length > 0) score -= 1;
  if (input.proofs.length === 0) score -= 1;
  score = Math.max(0, Math.min(5, score));
  const weakestItem =
    input.projectAudit.summary.attention > 0 || input.proofs.length === 0
      ? "レビューと改善"
      : input.commandQueue.length > 0
        ? "コマンドキュー"
        : "なし";
  const why =
    input.projectAudit.summary.attention > 0
      ? "入口と導線は整っているが、改善ループの自動回収を継続する余地がある"
      : input.commandQueue.length > 0
        ? "未処理の入力が残っている"
        : input.proofs.length === 0
          ? "証跡が少なく、改善の裏取りが薄い"
          : "自動ループは概ね整っている";
  return { score, weakestItem, why };
}

function renderObsidianCodexSelfDiagnosis(input: {
  projectAudit: ProjectAuditResult;
  commandQueue: CommandQueueItem[];
  proofs: ProofRow[];
  projectProofPointers: ProjectProofPointer[];
  runs: RunRow[];
  generatedAt: string;
}): string {
  const diagnosis = computeObsidianCodexSelfDiagnosis(input);
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: obsidian-codex-self-diagnosis",
    "status: active",
    "priority: medium",
    "source_of_truth: Automation OS export plus Obsidian control-panel links",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Obsidian x Codex Self Diagnosis",
    "",
    "This page is auto-generated from the current Obsidian/Codex control panel state. You do not need to fill it in by hand.",
    "",
    "## Score",
    "",
    `- Current date: ${input.generatedAt.slice(0, 10)}`,
    `- Current score: \`${diagnosis.score}/5\``,
    `- Weakest item: \`${diagnosis.weakestItem}\``,
    `- Why: ${diagnosis.why}`,
    `- DB completion proofs: ${input.proofs.length}`,
    `- Project artifact locators: ${input.projectProofPointers.length} (locator only; not proof)`,
    "",
    "## Read First",
    "",
    "- [[Today]]",
    "- [[Resume Current Work]]",
    "- [[Weekly Review]]",
    "- [[Project Handoff Index]]",
    "",
    "## Rule",
    "",
    "- Keep Obsidian as locator plus operating memory, not as execution proof.",
    "- Fix only one weak item per cycle and let the next export re-score the surface."
  ].join("\n");
}

function renderObsidianCodexWeeklyCheck(input: {
  projectAudit: ProjectAuditResult;
  commandQueue: CommandQueueItem[];
  proofs: ProofRow[];
  projectProofPointers: ProjectProofPointer[];
  runs: RunRow[];
  generatedAt: string;
}): string {
  const diagnosis = computeObsidianCodexSelfDiagnosis(input);
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: obsidian-codex-weekly-check",
    "status: active",
    "priority: medium",
    "source_of_truth: Automation OS export plus Obsidian weekly review links",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Obsidian x Codex Weekly Check",
    "",
    "This page is auto-generated. It is meant to be read, not hand-filled.",
    "",
    "## Check",
    "",
    `- Current score: \`${diagnosis.score} / 5\``,
    `- Weakest item: \`${diagnosis.weakestItem}\``,
    `- DB completion proofs: ${input.proofs.length}`,
    `- Project artifact locators: ${input.projectProofPointers.length}`,
    `- One fix for this week: ${diagnosis.weakestItem === "なし" ? "none needed" : "focus on the weakest item only"}`,
    "",
    "## Short Review",
    "",
    "1. Did `Today` and `Resume Current Work` actually help restart work?",
    "2. Did `Project Handoff Index` and `Project Memory Map` lead to real reuse?",
    "3. Did `Weekly Review` capture one concrete improvement?",
    "",
    "## Rule",
    "",
    "- Fix only one weak item per week.",
    "- Keep Obsidian as locator plus operating memory, not as execution proof."
  ].join("\n");
}

function renderTodayDashboard(input: {
  runs: RunRow[];
  proofs: ProofRow[];
  checks: SystemCheckRow[];
  bridgeExecutions: BridgeExecutionRow[];
  commandQueue: CommandQueueItem[];
  projectAudit: ProjectAuditResult;
  projectProofPointers: ProjectProofPointer[];
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
    "- [[Obsidian Autonomy Ops Memo]]",
    "- [[Obsidian x Codex Self Diagnosis]]",
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
    `- DB proof pointers indexed: ${input.proofs.length}`,
    `- Project artifact locators indexed: ${input.projectProofPointers.length}`,
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

function renderSecondBrainAutoProcessor(input: { candidates: SecondBrainClassificationCandidate[]; autoPromotedCount: number; generatedAt: string }): string {
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
    `- Auto-promoted internal knowledge eligible count: ${input.autoPromotedCount}`,
    "- Auto-promotion rule: review_ready + processor proof + substantive reuse fields only; internal/read-only and never external-action authorization.",
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
  const duplicateFiles = candidate.duplicateSourceFiles.length
    ? candidate.duplicateSourceFiles.map((file) => `[[${file.replace(/\.md$/, "")}|${file}]]`).join(", ")
    : "none";
  return [
    `### [[${candidate.file.replace(/\.md$/, "")}|${candidate.title}]]`,
    "",
    `- auto_process: obsidian_internal_only`,
    `- processing_status: ${candidate.processingStatus}`,
    `- suggested_destination: ${suggestedDestination}`,
    `- progressive_summary: ${safeSecondBrainValue(candidate.progressiveSummary, 360)}`,
    `- source_url: ${sourceUrl}`,
    `- source_of_truth: ${sourceOfTruth}`,
    `- source_key: ${candidate.sourceKey}`,
    `- duplicate_source_group: ${candidate.duplicateSourceCount}`,
    `- duplicate_source_files: ${duplicateFiles}`,
    `- distillation: ${safeSecondBrainValue(candidate.distillation, 360)}`,
    `- next_use: ${safeSecondBrainValue(candidate.nextUse, 360)}`,
    `- unresolved_question: ${safeSecondBrainValue(candidate.unresolvedQuestion, 360)}`,
    `- review_cycle: ${safeSecondBrainValue(candidate.reviewCycle, 120)}`,
    `- distillation_quality: ${safeSecondBrainValue(candidate.distillationQuality, 120)}`,
    `- knowledge_reuse_status: ${safeSecondBrainValue(candidate.knowledgeReuseStatus, 120)}`,
    `- processed_at: ${safeSecondBrainValue(candidate.processedAt, 120)}`,
    `- excerpt_for_locator_only: ${safeSecondBrainValue(candidate.excerpt, 220)}`,
    `- external_action_required: ${externalActionRequired}`,
    `- approval_required: ${approvalRequired}`,
    ""
  ].join("\n");
}

function safeSecondBrainValue(value: string, maxLength: number): string {
  return shortSnippet(redactSensitive(value), maxLength) || "not_present";
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
  const latestGlobalSession = input.codexSessions[0];
  const sessionSummary = latestSession
    ? `${latestSession.sessionId} (${latestSession.cwd})`
    : "none (no current-project Codex session found; see Active Sessions for latest global locators)";
  const globalSessionSummary = latestGlobalSession
    ? `${latestGlobalSession.sessionId} (${latestGlobalSession.cwd})`
    : "none";
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
    `- Latest current-project Codex session: ${sessionSummary}`,
    `- Latest global user-owned session locator: ${globalSessionSummary}`,
    "",
    "## Next Codex Move",
    "",
    inferResumeMove({ latestRun, blockedRun, latestBridgeExecution, latestCheck }),
    "",
    "## Weekly Automation",
    "",
    "- [[Obsidian Autonomy Ops Memo]]",
    "- [[Obsidian x Codex Self Diagnosis]]",
    "- [[Obsidian x Codex Weekly Check]]",
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
          "- Scope: current project",
          `- Modified: ${latestSession.mtime}`,
          `- Last user: ${shortSnippet(latestSession.lastUser, 180)}`,
          `- Last assistant: ${shortSnippet(latestSession.lastAssistant, 180)}`
        ].join("\n")
      : latestGlobalSession
        ? [
            "- No current-project Codex session summary indexed.",
            `- Latest global locator only: ${latestGlobalSession.sessionId} (${latestGlobalSession.cwd})`,
            `- Modified: ${latestGlobalSession.mtime}`,
            "- Do not use this other-project locator to choose the current project's Next Codex Move."
          ].join("\n")
        : "- No recent user-owned Codex session summary indexed.",
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
    "ユーザー所有のCodex session jsonlから最新10件だけを短く要約します。subagent session、本文ログ、秘密、token、長文出力は保存しません。",
    "",
    activeSessions.length
      ? activeSessions.map((session) => renderActiveSessionItem(session)).join("\n")
      : "No recent user-owned Codex sessions found.",
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

function renderSessionKnowledgeDigest(input: {
  codexSessions: CodexSessionSummary[];
  sessionIndexInventory: SessionIndexInventory;
  generatedAt: string;
}): string {
  const projects = groupSessionsByCwd(input.codexSessions);
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: codex-session-knowledge-digest",
    "status: active",
    "priority: high",
    "coverage: all_redacted_session_index_inventory_plus_latest_50_user_owned_head_tail_detail",
    "raw_transcript_stored: false",
    "review_status: pending_human_review",
    "knowledge_reuse_status: locator_only",
    "promotion_allowed: false",
    "source_of_truth: ~/.codex/sessions bounded session metadata; project-owned STATE/AGENTS/artifacts remain authoritative",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Session Knowledge Digest",
    "",
    "セッションを跨いで再開候補・繰り返しの詰まり・次に読む場所を見つけるためのcompact digestです。全文ログやraw transcriptを知識として自動昇格させません。",
    "",
    "## Coverage and Boundary",
    "",
    `- All-session redacted index entries: ${input.sessionIndexInventory.available ? input.sessionIndexInventory.indexedEntries : "unavailable"}`,
    `- Session index readback: ${input.sessionIndexInventory.available ? input.sessionIndexInventory.path : "unavailable"}`,
    `- Session index mtime: ${input.sessionIndexInventory.latestMtime ?? "unknown"}`,
    `- Index review status: pending_human_review=${input.sessionIndexInventory.pendingHumanReview}; promotion_allowed=${input.sessionIndexInventory.promotionAllowed}`,
    `- Session summaries indexed: ${input.codexSessions.length}`,
    "- Detail coverage: up to 50 user-owned sessions selected after scanning a bounded recent file window; subagent sessions are excluded.",
    "- All-session inventory is count/status metadata from the redacted session index; it is not a transcript export.",
    "- Read mode: bounded head/tail metadata and short redacted hints only.",
    "- Promotion: disabled until a human explicitly reviews the original session and project-owned source of truth.",
    "- Obsidian role: locator and review surface, not completion proof or execution authorization.",
    "",
    "## Project Mix",
    projects.length
      ? projects.map((project) => `- ${project.cwd}: ${project.count} session(s); latest=${project.latest.sessionId} (${project.latest.mtime})`).join("\n")
      : "- No user-owned sessions indexed.",
    "",
    "## Session Entries",
    input.codexSessions.length
      ? input.codexSessions.map((session) => renderSessionKnowledgeDigestItem(session)).join("\n")
      : "No user-owned sessions indexed.",
    "",
    "## Resume Rule",
    "",
    "Use an entry to choose the next source read. Before claiming reuse or completion, open the original session plus the current project STATE/AGENTS, latest artifact, and readback.",
    ""
  ].join("\n");
}

function renderSessionKnowledgeDigestItem(session: CodexSessionSummary): string {
  const blockerClass = classifyBlockerText(`${session.lastUser} ${session.lastAssistant}`);
  return [
    `### ${session.sessionId}`,
    "",
    `- modified: ${session.mtime}`,
    `- file: \`${session.file}\``,
    `- cwd: ${session.cwd}`,
    `- thread_source: ${session.threadSource}`,
    `- blocker_class_hint: ${blockerClass}`,
    `- last_user_hint: ${safeSessionHint(session.lastUser)}`,
    `- last_assistant_hint: ${safeSessionHint(session.lastAssistant)}`,
    "- review_status: pending_human_review",
    "- knowledge_reuse_status: locator_only",
    "- promotion_allowed: false",
    ""
  ].join("\n");
}

function safeSessionHint(value: string): string {
  return shortSnippet(redactSensitive(value), 180) || "none";
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

function renderObsidianAutonomyOpsMemo(input: { generatedAt: string }): string {
  return [
    "---",
    "system: automation-os",
    "generated_by: automation-os",
    "kind: obsidian-autonomy-ops-memo",
    "status: active",
    "priority: medium",
    "source_of_truth: docs/14-obsidian-autonomy-ops-memo.md and current startup contract",
    `generated_at: ${input.generatedAt}`,
    "---",
    "",
    "# Obsidian Autonomy Ops Memo",
    "",
    "This page is the Vault-facing summary for the current Obsidian x Codex autonomy contract.",
    "",
    "## Automatic Now",
    "",
    "- Server login recovery starts Obsidian auto export by default.",
    "- The periodic export timer defaults to 5 minutes.",
    "- Detached exports invoke registry discovery, Context Pack refresh, Second Brain canary processing, and project audit at most once per 30 minutes.",
    "- New durable projects are discovered as locator-only candidates; canonical Muscle AI and Heavy Chain roots are registered.",
    "- The global obsidian-project-memory Skill resolves project context and requires a fresh-read of project-owned truth.",
    "- Vault writers share one atomic lock, and Second Brain verifies note preimages before replacement.",
    "- The guarded private Git backup runs at most once per 6 hours and stops on privacy, secret, or divergence gates.",
    "- SQLite fallback is allowed when stored Postgres cannot be restored cleanly.",
    "- Self diagnosis and weekly check pages are regenerated on every export.",
    "",
    "## Read First",
    "",
    "- [[Today]]",
    "- [[Resume Current Work]]",
    "- [[Obsidian x Codex Self Diagnosis]]",
    "- [[Obsidian x Codex Weekly Check]]",
    "",
    "## Still Matters",
    "",
    "- Postgres remains the preferred source of truth when its stored secret is valid again.",
    "- Generated Obsidian pages are review surfaces and locators, not execution proof.",
    "- Markdown content cannot authorize commands, approvals, external writes, or project promotion.",
    "- If startup defaults change, rebuild, re-test, and reinstall the LaunchAgent.",
    "",
    "## Source",
    "",
    "- Docs copy: docs/14-obsidian-autonomy-ops-memo.md"
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

function collectProjectProofPointers(projectAudit: ProjectAuditResult): ProjectProofPointer[] {
  const seen = new Set<string>();
  return projectAudit.projects
    .flatMap((item) =>
      item.artifacts
        .filter((artifact) => artifact.exists && artifact.latest && artifact.latestMtime)
        .map((artifact) => ({
          id: `${item.project.id}:${artifact.latest}`,
          projectId: item.project.id,
          projectLabel: item.project.label,
          artifactRoot: artifact.path,
          path: artifact.latest as string,
          mtime: artifact.latestMtime as string
        }))
    )
    .sort((left, right) => Date.parse(right.mtime) - Date.parse(left.mtime))
    .filter((pointer) => {
      const key = resolve(pointer.path);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
  const latestArtifactPointer = latestArtifact
    ? redactSensitive(`${latestArtifact.path} latest=${latestArtifact.latest ?? "none"} mtime=${latestArtifact.latestMtime ?? "unknown"}`)
    : "none";
  return [
    `### ${item.project.label}`,
    "",
    `- Project id: \`${item.project.id}\``,
    `- Status: ${item.status}`,
    `- Root: \`${item.project.root}\` (${item.rootExists ? "exists" : "missing"})`,
    `- STATE.md: ${item.stateExists ? `present (${item.stateMtime})` : "missing"}`,
    `- Source of truth: ${item.project.source_of_truth.map((source) => `\`${source}\``).join(", ")}`,
    `- Latest artifact pointer: ${latestArtifactPointer}`,
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
    `- Thread source: ${session.threadSource}`,
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
  projectProofPointers: ProjectProofPointer[];
  bridgeExecutions: BridgeExecutionRow[];
  commandQueue: CommandQueueItem[];
  projectAudit: ProjectAuditResult;
  generatedAt: string;
}): string {
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recentRuns = input.runs.filter((run) => Date.parse(run.updated_at) >= since);
  const recentProofs = input.proofs.filter((proof) => Date.parse(proof.created_at) >= since);
  const recentBridge = input.bridgeExecutions.filter((execution) => Date.parse(execution.updated_at) >= since);
  const statusMix = countBy(recentRuns, (run) => run.status);
  const blockers = selectAttentionRuns(recentRuns).slice(0, 8);
  const diagnosis = computeObsidianCodexSelfDiagnosis({
    projectAudit: input.projectAudit,
    commandQueue: input.commandQueue,
    proofs: input.proofs,
    runs: input.runs
  });
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
    `- Project artifact locators indexed: ${input.projectProofPointers.length} (locator only)`,
    `- Bridge executions updated in 7 days: ${recentBridge.length}`,
    `- Open command queue items: ${input.commandQueue.length}`,
    `- Status mix: ${Object.entries(statusMix)
      .map(([status, count]) => `${status}=${count}`)
      .join(", ") || "none"}`,
    `- Obsidian x Codex self score: \`${diagnosis.score}/5\``,
    `- Weakest item: \`${diagnosis.weakestItem}\``,
    "",
    "## Needs Attention",
    "",
    blockers.length
      ? blockers.map((run) => `- [[Runs#${anchor(run.id)}|${run.name}]] is ${run.status}; inspect exact blocker and latest proof before retry.`).join("\n")
      : "- No blocked or partial runs updated in the last 7 days.",
    "",
    "## Suggested Improvement Loop",
    "",
    "- Review [[Obsidian Autonomy Ops Memo]] first if the startup contract changed.",
    "- Promote repeated blockers into runbooks or registered automation checks.",
    "- Convert useful handwritten command items into project notes, decisions, or explicit Codex runs.",
    "- Keep proof claims linked to receipts, artifacts, or no-action evidence before marking work complete.",
    `- Weekly fix: ${diagnosis.weakestItem === "なし" ? "none needed" : `focus on ${diagnosis.weakestItem} only`}.`,
    "- Review [[Obsidian x Codex Self Diagnosis]] and open [[Obsidian x Codex Weekly Check]] to keep the weakest item to one per cycle."
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
    "  distillation:",
    "    displayName: Distillation",
    "  next_use:",
    "    displayName: Next use",
    "  unresolved_question:",
    "    displayName: Unresolved question",
    "  review_cycle:",
    "    displayName: Review cycle",
    "  distillation_quality:",
    "    displayName: Distillation quality",
    "  knowledge_reuse_status:",
    "    displayName: Knowledge reuse status",
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
    "      - distillation",
    "      - next_use",
    "      - unresolved_question",
    "      - review_cycle",
    "      - distillation_quality",
    "      - knowledge_reuse_status",
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
  const candidates = readMarkdownFiles(inboxDir)
    .map((path) => readSecondBrainCandidateFromFile(vaultPath, path))
    .filter((candidate): candidate is SecondBrainClassificationCandidate => Boolean(candidate));
  const groups = groupBy(candidates, (candidate) => candidate.sourceKey);
  return candidates
    .map((candidate) => {
      const group = groups.get(candidate.sourceKey) ?? [candidate];
      return {
        ...candidate,
        duplicateSourceCount: group.length,
        duplicateSourceFiles: group.map((item) => item.file).filter((file) => file !== candidate.file)
      };
    })
    .slice(0, 80);
}

function readAutoPromotedSecondBrainKnowledge(vaultPath: string): AutoPromotedSecondBrainKnowledge[] {
  const vaultRoot = resolve(vaultPath);
  let vaultRealPath: string;
  try {
    vaultRealPath = realpathSync(vaultRoot);
  } catch {
    return [];
  }
  return secondBrainPromotionTargetFolders
    .flatMap((folder) => {
      const root = join(vaultRoot, folder);
      try {
        if (!existsSync(root)) return [];
        const rootStat = lstatSync(root);
        if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return [];
        return readSafeSecondBrainMarkdownFiles(root, vaultRoot, vaultRealPath);
      } catch {
        return [];
      }
    })
    .map((path) => readAutoPromotedSecondBrainKnowledgeFromFile(vaultRoot, path))
    .filter((knowledge): knowledge is AutoPromotedSecondBrainKnowledge => Boolean(knowledge))
    .sort((left, right) => left.file.localeCompare(right.file));
}

function readSafeSecondBrainMarkdownFiles(dir: string, vaultRoot: string, vaultRealPath: string): string[] {
  try {
    return readdirSync(dir)
      .flatMap((entry) => {
        if (entry === ".backups" || entry === ".obsidian" || entry.toLowerCase() === "templates" || entry.toLowerCase() === "_templates" || entry.toLowerCase().includes("generated")) {
          return [];
        }
        const path = join(dir, entry);
        let pathStat;
        try {
          pathStat = lstatSync(path);
        } catch {
          return [];
        }
        if (pathStat.isSymbolicLink()) return [];
        if (pathStat.isDirectory()) return readSafeSecondBrainMarkdownFiles(path, vaultRoot, vaultRealPath);
        if (!pathStat.isFile() || !entry.endsWith(".md")) return [];
        let realPath: string;
        try {
          realPath = realpathSync(path);
        } catch {
          return [];
        }
        const relativeRealPath = relative(vaultRealPath, realPath);
        if (relativeRealPath === ".." || relativeRealPath.startsWith(`..${sep}`) || isAbsolute(relativeRealPath)) return [];
        const relativeVaultPath = relative(vaultRoot, path);
        if (!secondBrainPromotionTargetFolders.some((folder) => relativeVaultPath === folder || relativeVaultPath.startsWith(`${folder}${sep}`))) {
          return [];
        }
        return [path];
      })
      .sort();
  } catch {
    return [];
  }
}

function readAutoPromotedSecondBrainKnowledgeFromFile(vaultRoot: string, path: string): AutoPromotedSecondBrainKnowledge | undefined {
  try {
    const markdown = readFileSync(path, "utf8");
    const frontmatter = parseFrontmatter(markdown);
    if (Object.hasOwn(frontmatter, "generated_by") || frontmatterFlagIsAffirmative(frontmatter.skill_candidate)) return undefined;
    if (frontmatter.auto_process !== "obsidian_internal_only") return undefined;
    if (frontmatter.processing_status !== "review_ready") return undefined;
    if (frontmatter.processed_by !== "automation-os-second-brain-processor") return undefined;
    if (!secondBrainDestinationAllowlist.has(frontmatter.suggested_destination) || !secondBrainPromotionDestinationAllowlist.has(frontmatter.suggested_destination)) {
      return undefined;
    }
    if (frontmatter.knowledge_reuse_status !== "ready" || frontmatter.distillation_quality !== "substantive") return undefined;
    if (!frontmatterFlagIsExplicitFalse(frontmatter.external_action_required) || !frontmatterFlagIsExplicitFalse(frontmatter.approval_required)) {
      return undefined;
    }

    const progressiveSummary = firstPresentString(frontmatter.progressive_summary);
    const distillation = firstPresentString(frontmatter.distillation);
    const nextUse = firstPresentString(frontmatter.next_use);
    const sourceOfTruth = firstPresentString(frontmatter.source_of_truth);
    if (!isSubstantiveSecondBrainValue(progressiveSummary) || !isSubstantiveSecondBrainValue(distillation) || !isSubstantiveSecondBrainValue(nextUse) || !isSubstantiveSecondBrainValue(sourceOfTruth)) {
      return undefined;
    }
    const sourceUrl = firstPresentString(frontmatter.source_url) ?? "unknown";
    if ((sourceUrl !== "unknown" && redactSecondBrainPointer(sourceUrl) !== sourceUrl) || redactSecondBrainPointer(sourceOfTruth) !== sourceOfTruth) {
      return undefined;
    }

    return {
      file: relative(vaultRoot, path),
      title: firstPresentString(frontmatter.title) ?? basename(path, ".md"),
      destination: frontmatter.suggested_destination,
      progressiveSummary,
      distillation,
      nextUse,
      sourceUrl,
      sourceOfTruth,
      contentSha256: createHash("sha256").update(markdown, "utf8").digest("hex")
    };
  } catch {
    return undefined;
  }
}

function isSubstantiveSecondBrainValue(value: string | undefined): value is string {
  if (!value) return false;
  const normalized = value.replace(/\s+/g, " ").trim().toLowerCase();
  if (normalized.length < 24) return false;
  return !new Set(["unknown", "none", "n/a", "na", "null", "todo", "tbd", "draft", "review_needed", "review needed", "review and classify.", "source_url", "source_of_truth", "handwritten note", "note"]).has(normalized);
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
  const progressiveSummary = firstPresentString(frontmatter.progressive_summary, frontmatter.progressiveSummary) ?? "not_present";
  const distillation = firstPresentString(frontmatter.distillation) ?? "not_present";
  const nextUse = firstPresentString(frontmatter.next_use, frontmatter.nextUse) ?? "not_present";
  const unresolvedQuestion = firstPresentString(frontmatter.unresolved_question, frontmatter.unresolvedQuestion) ?? "not_present";
  const reviewCycle = firstPresentString(frontmatter.review_cycle, frontmatter.reviewCycle) ?? "not_set";
  const distillationQuality = firstPresentString(frontmatter.distillation_quality, frontmatter.distillationQuality) ?? "not_set";
  const knowledgeReuseStatus = firstPresentString(frontmatter.knowledge_reuse_status, frontmatter.knowledgeReuseStatus) ?? "not_set";
  const processedAt = firstPresentString(frontmatter.processed_at, frontmatter.processedAt) ?? "not_set";
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
    excerpt: shortSnippet(stripFrontmatter(body), 220),
    progressiveSummary,
    distillation,
    nextUse,
    unresolvedQuestion,
    reviewCycle,
    distillationQuality,
    knowledgeReuseStatus,
    processedAt,
    sourceKey: canonicalSecondBrainSourceKey(sourceUrl !== "unknown" ? sourceUrl : sourceOfTruth, rel),
    duplicateSourceCount: 1,
    duplicateSourceFiles: []
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

function readKnowledgeUseReceipts(configuredPath?: string): KnowledgeUseReceipt[] {
  const ledgerPath = resolve(
    configuredPath ??
      process.env.AUTOMATION_OS_OBSIDIAN_KNOWLEDGE_USE_LEDGER ??
      join(process.cwd(), "data", "obsidian-knowledge-use-ledger.jsonl")
  );
  if (!existsSync(ledgerPath)) return [];
  return readJsonlEdges(ledgerPath)
    .map((line) => parseKnowledgeUseReceipt(line))
    .filter((receipt): receipt is KnowledgeUseReceipt => Boolean(receipt))
    .sort((left, right) => right.usedAt.localeCompare(left.usedAt))
    .slice(0, 500);
}

function parseKnowledgeUseReceipt(line: string): KnowledgeUseReceipt | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const usedAt = firstPresentString(value.usedAt);
    const projectId = firstPresentString(value.projectId);
    const projectRoot = firstPresentString(value.projectRoot);
    if (!usedAt || !projectId || !projectRoot || !Number.isFinite(Date.parse(usedAt))) return undefined;
    return {
      usedAt,
      projectId: shortSnippet(projectId, 120),
      projectLabel: shortSnippet(firstPresentString(value.projectLabel) ?? projectId, 160),
      projectRoot: redactSensitive(projectRoot),
      match: shortSnippet(firstPresentString(value.match) ?? "unknown", 80),
      contextPackPath: firstPresentString(value.contextPackPath) ? redactSensitive(String(value.contextPackPath)) : null,
      contextPackAvailable: value.contextPackAvailable === true,
      authorityFilesAvailable: safeNonNegativeInteger(value.authorityFilesAvailable),
      sourceOfTruthAvailable: safeNonNegativeInteger(value.sourceOfTruthAvailable)
    };
  } catch {
    return undefined;
  }
}

function safeNonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function readSkillCandidateNotes(vaultPath: string): SkillCandidateNote[] {
  const folders = ["05_Projects", "06_Research", "07_Decisions", "08_Runbooks", "09_Inbox"];
  return folders
    .flatMap((folder) => readMarkdownFilesIfExists(join(vaultPath, folder)))
    .map((path) => readSkillCandidateNote(vaultPath, path))
    .filter((candidate): candidate is SkillCandidateNote => Boolean(candidate))
    .sort((left, right) => left.file.localeCompare(right.file));
}

function readSkillCandidateNote(vaultPath: string, path: string): SkillCandidateNote | undefined {
  if (!existsSync(path) || !statSync(path).isFile()) return undefined;
  const body = readFileSync(path, "utf8");
  const frontmatter = parseFrontmatter(body);
  if (frontmatter.generated_by === "automation-os" || !frontmatterFlagIsTrue(frontmatter.skill_candidate)) return undefined;
  return {
    file: relative(vaultPath, path),
    title: firstPresentString(frontmatter.title, frontmatter.source_title, frontmatter.sourceTitle) ?? basename(path, ".md"),
    kind: firstPresentString(frontmatter.kind) ?? "note",
    reason: firstPresentString(frontmatter.skill_candidate_reason) ?? "repeatable judgment or procedure detected",
    knowledgeReuseStatus: firstPresentString(frontmatter.knowledge_reuse_status) ?? "unknown",
    distillation: firstPresentString(frontmatter.distillation) ?? "none",
    nextUse: firstPresentString(frontmatter.next_use) ?? "review before promotion"
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

function canonicalSecondBrainSourceKey(value: string, fallbackFile: string): string {
  const redacted = redactSecondBrainPointer(value);
  if (redacted === "unknown" || redacted.includes("[REDACTED]")) {
    return `file:${createHash("sha256").update(fallbackFile, "utf8").digest("hex").slice(0, 16)}`;
  }
  try {
    const url = new URL(redacted);
    if (!/^https?:$/.test(url.protocol)) throw new Error("unsupported_source_protocol");
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_[^=]+|fbclid|gclid|s|sub_rt)$/i.test(key)) url.searchParams.delete(key);
    }
    const canonical = url.toString().replace(/\/$/, "");
    return `url:${createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16)}`;
  } catch {
    return `pointer:${createHash("sha256").update(redacted, "utf8").digest("hex").slice(0, 16)}`;
  }
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

function readCodexSessions(inputDir?: string, inputIndexFile?: string, preferRedactedIndex = false): CodexSessionSummary[] {
  const configuredSessionsDir = inputDir ?? process.env.AUTOMATION_OS_CODEX_SESSIONS_DIR;
  const sessionsDir = resolve(configuredSessionsDir ?? join(homedir(), ".codex", "sessions"));
  if (!existsSync(sessionsDir)) return [];
  const explicitIndex = inputIndexFile !== undefined || Boolean(process.env.AUTOMATION_OS_CODEX_SESSION_INDEX);
  const explicitSessionsDir = configuredSessionsDir !== undefined;
  if (preferRedactedIndex && (explicitIndex || !explicitSessionsDir)) {
    const indexedSessions = readRedactedSessionIndex(inputIndexFile)
      .filter((entry) => entry.parentThreadId === null)
      .slice(0, 50)
      .map((entry): CodexSessionSummary => ({
        file: entry.file,
        sessionId: entry.sessionId,
        mtime: entry.mtime,
        cwd: entry.cwd,
        lastUser: entry.lastUser,
        lastAssistant: entry.lastAssistant,
        threadSource: entry.threadSource,
        parentThreadId: entry.parentThreadId
      }));
    if (indexedSessions.length > 0) return indexedSessions;
  }
  try {
    const candidates = listJsonlFiles(sessionsDir)
      .flatMap((path) => {
        try {
          return [{ path, stat: statSync(path) }];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, 300);
    const sessions: CodexSessionSummary[] = [];
    const seen = new Set<string>();
    for (const { path, stat } of candidates) {
      const metadata = readCodexSessionMetadata(path);
      if (!["user", "legacy"].includes(metadata.threadSource) || metadata.hasSubagentSource) continue;
      const session = summarizeCodexSession(path, sessionsDir, stat.mtime, metadata);
      if (seen.has(session.sessionId)) continue;
      seen.add(session.sessionId);
      sessions.push(session);
      if (sessions.length >= 50) break;
    }
    return sessions;
  } catch {
    return [];
  }
}

function readSessionIndexInventory(inputFile?: string): SessionIndexInventory {
  const path = resolve(inputFile ?? process.env.AUTOMATION_OS_CODEX_SESSION_INDEX ?? join(homedir(), ".codex", "session-index.jsonl"));
  const unavailable: SessionIndexInventory = {
    path,
    available: false,
    indexedEntries: 0,
    pendingHumanReview: 0,
    promotionAllowed: 0,
    latestMtime: null
  };
  if (!existsSync(path)) return unavailable;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return unavailable;
    let indexedEntries = 0;
    let pendingHumanReview = 0;
    let promotionAllowed = 0;
    for (const line of safeReadText(path).split("\n")) {
      const entry = parseJson<Record<string, unknown>>(line, {});
      if (!firstPresentString(entry.sessionId, entry.session_id, entry.file)) continue;
      indexedEntries += 1;
      if (String(entry.reviewStatus ?? "") === "pending_human_review") pendingHumanReview += 1;
      if (entry.promotionAllowed === true) promotionAllowed += 1;
    }
    return {
      path,
      available: true,
      indexedEntries,
      pendingHumanReview,
      promotionAllowed,
      latestMtime: stat.mtime.toISOString()
    };
  } catch {
    return unavailable;
  }
}

function refreshCodexSessionIndexIfNeeded(options: ObsidianExportOptions): void {
  const shouldRefresh = options.refreshCodexSessionIndex === true;
  if (!shouldRefresh) return;
  try {
    buildAndWriteRedactedSessionIndex({
      sessionsDir: options.codexSessionsDir,
      outputPath: options.codexSessionIndexFile
    });
  } catch {
    // A stale redacted index remains a locator-only fallback; export must not fail open on session indexing.
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

type CodexSessionMetadata = {
  sessionId: string | null;
  cwd: string | null;
  threadSource: string;
  parentThreadId: string | null;
  hasSubagentSource: boolean;
};

function summarizeCodexSession(path: string, sessionsDir: string, mtime: Date, metadata = readCodexSessionMetadata(path)): CodexSessionSummary {
  const rel = relative(sessionsDir, path);
  const fallbackId = basename(path, ".jsonl").replace(/^rollout-/, "");
  const sessionId = metadata.sessionId ?? fallbackId;
  const cwd = metadata.cwd ?? "unknown";
  let lastUser = "none";
  let lastAssistant = "none";
  const lines = readJsonlEdges(path);
  for (const line of lines) {
    const parsed = parseJson<Record<string, unknown>>(line, {});
    const message = extractCodexTranscriptMessage(parsed);
    if (message?.role === "user") lastUser = shortSnippet(message.text, 180);
    if (message?.role === "assistant") lastAssistant = shortSnippet(message.text, 180);
  }
  return {
    file: shortSnippet(rel, 160),
    sessionId: shortSnippet(sessionId, 80),
    mtime: mtime.toISOString(),
    cwd,
    lastUser,
    lastAssistant,
    threadSource: metadata.threadSource,
    parentThreadId: metadata.parentThreadId
  };
}

function readCodexSessionMetadata(path: string): CodexSessionMetadata {
  for (const line of readJsonlSegment(path, 0, 1024 * 1024, false)) {
    const parsed = parseJson<Record<string, unknown>>(line, {});
    const metadata = extractCodexSessionMetadata(parsed);
    if (metadata) return metadata;
  }
  return { sessionId: null, cwd: null, threadSource: "legacy", parentThreadId: null, hasSubagentSource: false };
}

function extractCodexSessionMetadata(value: unknown): CodexSessionMetadata | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  let payload: Record<string, unknown> | undefined;
  if (record.type === "session_meta" && record.payload && typeof record.payload === "object") {
    payload = record.payload as Record<string, unknown>;
  } else if (record.session_meta && typeof record.session_meta === "object") {
    const wrapped = record.session_meta as Record<string, unknown>;
    payload = wrapped.payload && typeof wrapped.payload === "object" ? (wrapped.payload as Record<string, unknown>) : wrapped;
  }
  if (!payload) return undefined;
  const source = payload.source;
  return {
    sessionId: firstString(payload.id, payload.thread_id, payload.threadId, payload.session_id, payload.sessionId),
    cwd: firstString(payload.cwd, payload.workdir, payload.working_directory, payload.current_dir, payload.currentDirectory),
    threadSource: firstString(payload.thread_source, payload.threadSource) ?? "legacy",
    parentThreadId: firstString(payload.parent_thread_id, payload.parentThreadId),
    hasSubagentSource: Boolean(source && typeof source === "object" && "subagent" in (source as Record<string, unknown>))
  };
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function readJsonlEdges(path: string): string[] {
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  const headBytes = 1024 * 1024;
  const tailBytes = 2 * 1024 * 1024;
  if (size <= headBytes + tailBytes) return readJsonlSegment(path, 0, size, false);
  return [
    ...readJsonlSegment(path, 0, headBytes, false),
    ...readJsonlSegment(path, Math.max(0, size - tailBytes), tailBytes, true)
  ];
}

function readJsonlSegment(path: string, start: number, length: number, dropFirstPartialLine: boolean): string[] {
  if (length <= 0) return [];
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = text.split("\n");
    if (dropFirstPartialLine && start > 0) lines.shift();
    if (start + bytesRead < statSync(path).size) lines.pop();
    return lines.filter((line) => line.trim().length > 0 && line.length <= 4 * 1024 * 1024);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function safeReadText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function extractCodexTranscriptMessage(value: unknown): { role: "user" | "assistant"; text: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.type === "event_msg" && record.payload && typeof record.payload === "object") {
    const payload = record.payload as Record<string, unknown>;
    if (payload.type === "user_message") {
      const text = extractText(payload.message);
      if (text && !isSyntheticSessionUserText(text)) return { role: "user", text };
    }
  }
  if (record.type === "response_item") {
    const nested = record.payload ?? record.item;
    if (nested && typeof nested === "object") return extractCodexTranscriptMessage(nested);
  }
  const role = typeof record.role === "string" ? record.role : undefined;
  if (role !== "user" && role !== "assistant") return undefined;
  const text = extractText(record.content) || extractText(record.text) || extractText(record.message);
  if (role === "user" && isSyntheticSessionUserText(text)) return undefined;
  return text ? { role, text } : undefined;
}

function isSyntheticSessionUserText(text: string): boolean {
  return /^(?:\s*<(?:recommended_plugins|subagent_notification|codex_delegation|hook_prompt|permissions instructions|skills_instructions|environment_context|apps_instructions|plugins_instructions)(?:\s|>)|\s*# AGENTS\.md instructions for\b)/i.test(
    text
  );
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

function frontmatterFlagIsAffirmative(...values: unknown[]): boolean {
  return values.some((value) => ["true", "yes", "1"].includes(String(value ?? "").trim().toLowerCase()));
}

function frontmatterFlagIsExplicitFalse(value: unknown): boolean {
  return String(value ?? "").trim().toLowerCase() === "false";
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
    .replace(/\bjwt\s+[A-Za-z0-9._-]+\b/gi, "jwt [redacted-jwt]")
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

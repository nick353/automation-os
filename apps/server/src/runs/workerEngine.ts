import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { getCodexCapabilities, type CodexCapabilitiesSummary } from "../codex/capabilities.js";
import { resolveCodexBin } from "../codex/codexBin.js";
import {
  buildCanonicalExecutionRoutingMetadata,
  buildExecutionRoutingSnapshot,
  inferExecutionRoutingSource,
  readCanonicalExecutionRoutingDecision,
  type ExecutionRoutingExactBlocker,
  type ExecutionRoutingSource,
  type ExecutionRoutingSnapshot
} from "../codex/executionRouting.js";
import { countConsoleErrors } from "../browser/localCheck.js";
import { runBrowserUseLocalCheck } from "../browser/browserUseLocalCheck.js";
import { sanitizeDashboardRows } from "../dashboardSanitizer.js";
import { dbBackend, execSql, insert, makeId, nowIso, querySql, querySqlAsync, runSqlScriptAsync, sqlValue, type SqlValue } from "../db/client.js";
import { decomposeGoal, PlannedTask } from "../planner/decompose.js";
import { createApprovalRequest, requiresApproval } from "./approvalGate.js";
import { runDailyAiRegisteredRunner } from "./dailyAiRegisteredRunner.js";
import { allocateParallelLanes, LaneAllocation } from "./laneManager.js";
import { browserUseLaneFor, profileLockPathFor } from "../serviceReadiness/browserUseLifecycle.js";
import { runNisenPrintsRegisteredRunner } from "./nisenPrintsRegisteredRunner.js";
import { evaluateRunContractProofGate, summarizeProofGate, type ProofEvaluation } from "./proofGate.js";
import { promptTransferArtifactSize, runPromptTransferRegisteredRunner } from "./promptTransferRegisteredRunner.js";
import {
  jobManagerBrowserUseCliArtifactSize,
  runJobManagerBrowserUseCliRegisteredRunner
} from "./jobManagerBrowserUseCliRegisteredRunner.js";
import { resolveRunContract, RUN_CONTRACT_VERSION, RunContract } from "./runContracts.js";
import { runSnsMultiPosterRegisteredRunner, snsMultiPosterArtifactSize } from "./snsMultiPosterRegisteredRunner.js";
import { registeredBrowserWorkflowCommonBoundaryBlocker } from "./registeredBrowserBoundary.js";
import {
  buildServiceReadinessBrowserUseRuntimeBindingV1,
  buildServiceReadinessRuntimeBindingV1,
  deriveServiceReadinessRootId,
  referenceWorkflowIdFromMetadata,
  validateServiceReadinessBrowserUseAuthorizedAdapterContractV1,
  SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_CONTRACT_BLOCKER,
  type ServiceReadinessBrowserUseRuntimeBindingV1,
  type ServiceReadinessRuntimeBindingV1
} from "../serviceReadiness/runtimeBinding.js";
import { BROWSER_USE_HELPER_PATH, BROWSER_USE_RUNTIME_CONFIG_PATH } from "../serviceReadiness/browserUseCanonical.js";
import { redactWorkerOutput, resolveWorkerWorkspacePath, safeWorkerEnvironment } from "../security/processEnvironment.js";
import { PORTABLE_EXECUTION_SOURCE } from "./portableWorkerIsolation.js";
import { runPortableExternalWorker } from "./portableExternalWorker.js";
import {
  PORTABLE_EXTERNAL_EFFECTS_DISABLED_BLOCKER,
  PORTABLE_WORKER_CANARY_MODE,
  PORTABLE_WORKER_EXTERNAL_MODE,
  portableWorkerModeForAdapter,
  portableWorkflowIdForWorkerAdapter,
  runPortableWorkflowNoEffect
} from "./portableWorkflowWorker.js";
import { portableWorkflowManifests, type PortableWorkflowId } from "./portableWorkflowContract.js";
import { localWorkflowIdForWorkerAdapter, runPortableLocalWorkflowReadOnly } from "./portableLocalWorkflow.js";
import {
  buildPortableExternalApprovalBinding,
  buildPortableTargetBoundApprovalReceipt,
  portableBusinessTargetDigest,
  portableExternalApprovalResourceLocks,
  type PortableExternalApprovalBindingV1
} from "./portableExternalApprovalBinding.js";
import {
  issuePortableExternalEffectAuthorityV1,
  type PortableExternalEffectAuthorityV1
} from "./portableExternalEffectAuthority.js";

export type WorkerAdapter =
  | "child_codex"
  | "codex_cli"
  | "playwright_cli"
  | "browser_use_cli"
  | "daily_ai_registered"
  | "nisenprints_registered"
  | "job_submit_registered"
  | "job_followup_registered"
  | "prompt_transfer_registered"
  | "sns_multi_poster_registered"
  | "x_authenticated_browser_lane_registered"
  | "email_review_registered"
  | "local_backup_registered"
  | "obsidian_audit_registered"
  | "local_worker";
export type WorkerMode =
  | "execute_child_codex"
  | "execute_codex"
  | "execute_playwright"
  | "execute_browser_use"
  | "execute_daily_ai_registered"
  | "execute_nisenprints_registered"
  | "execute_job_submit_registered"
  | "execute_job_followup_registered"
  | "execute_prompt_transfer_registered"
  | "execute_sns_multi_poster_registered"
  | "execute_x_authenticated_browser_lane_registered"
  | "execute_registered_codex_automation"
  | "human_input_required_with_evidence"
  | "execute_portable_local_read_only"
  | "receipt_only";

export type WorkerCommandSpec = {
  bin: string;
  args: string[];
  env?: Record<string, string>;
  display: string;
};

export type WorkerAdapterPolicyClassification = "browser_use_cli" | "legacy_browser_backed" | "in_app_browser_root_owned" | "extension_backed" | "non_browser";

export type WorkerAdapterPolicySnapshot = {
  adapter: WorkerAdapter;
  classification: WorkerAdapterPolicyClassification;
  exactBlocker: ExecutionRoutingExactBlocker;
  evidence: string[];
};

export type CommandRunPlan = {
  command: string;
  runContract?: RunContract;
  contractVersion?: string;
  tasks: Array<PlannedTask & { adapter: WorkerAdapter; requiresApproval: boolean; collisionWith: string[] }>;
  lanes: LaneAllocation[];
  collisions: Array<{ resource: string; taskIds: string[] }>;
  approvalRequired: boolean;
  approvalResources: string[];
  collisionOverrideResources: string[];
};

type StepRow = {
  id: string;
  run_id: string;
  name: string;
  status: string;
  lane_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  metadata_json: string;
};

type LaneRow = {
  id: string;
  cdp_port: number;
  profile_dir: string;
  workdir: string;
  browser_use_session: string | null;
  browser_use_cdp_url: string | null;
  browser_use_profile: string | null;
  profile_strategy: string | null;
  lane_visibility: string | null;
};

type ChildCodexProofRow = {
  run_id: string;
  proof_type: string;
  step_id: string | null;
  uri: string;
  metadata_json: string;
};

type CodexProofRow = {
  run_id: string;
  proof_type: string;
  step_id: string | null;
  uri: string;
  metadata_json: string;
};

const browserUseAdapterEntryPoint = "/Users/nichikatanaka/.codex/skills/automation-kernel-run/scripts/browser-use-cli-stage-adapter.mjs";
const browserUseHelper = BROWSER_USE_HELPER_PATH;
const browserUseRuntimeConfig = BROWSER_USE_RUNTIME_CONFIG_PATH;
export const BROWSER_USE_CLI_REQUIRED_BLOCKER = "browser_use_cli_required";
export const BROWSER_USE_CLI_WORKFLOW_ADAPTER_MISSING_BLOCKER = "browser_use_cli_workflow_adapter_missing";
export const BROWSER_USE_CLI_EXTERNAL_EFFECTS_DISABLED_BLOCKER = "browser_use_cli_external_effects_disabled";
export const BROWSER_USE_CLI_STALE_RECONCILIATION_REQUIRED_BLOCKER = "browser_use_cli_stale_reconciliation_required";

type ChildRunRow = {
  id: string;
  step_id: string | null;
  role: string;
  status: string;
  exit_status: number | null;
  result_uri: string | null;
};

type WorkerProcessResult = {
  pid?: number;
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  errorMessage?: string;
};

type CodexReadonlyExecutionResult = {
  artifact: ReturnType<typeof writeWorkerArtifact>;
  proofType: "codex_readonly_execution" | "codex_readonly_blocked";
  stepStatus: "completed" | "blocked";
  laneStatus: "idle" | "blocked";
  laneProgress: 100 | 50;
  laneHealth: "good" | "blocked";
  pid?: number;
  exitStatus: number | null;
  signal: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
  timedOut: boolean;
  errorMessage?: string;
};

type ChildCodexExecutionResult = {
  resultArtifact: ReturnType<typeof writeNamedWorkerArtifact>;
  promptArtifact: ReturnType<typeof writeTextArtifact>;
  command: WorkerCommandSpec;
  proofType: "child_codex_result" | "child_codex_blocked";
  stepStatus: "completed" | "blocked";
  laneStatus: "idle" | "blocked";
  laneProgress: 100 | 50;
  laneHealth: "good" | "blocked";
  childRunId: string;
  pid?: number;
  exitStatus: number | null;
  signal: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
  timedOut: boolean;
  blocker?: string;
  errorMessage?: string;
};

type RegisteredExecutionResult = {
  workerMode: Exclude<WorkerMode, "execute_child_codex" | "execute_codex" | "receipt_only">;
  status: "complete" | "partial" | "blocked";
  proof_gate: Record<string, unknown>;
  proof_summary: string;
  metadata: Record<string, unknown>;
};

type CanonicalRouteBlockContext = {
  routeDecision: ExecutionRoutingSnapshot | null;
  routeDecisionFingerprint: string | null;
  routeSource: ExecutionRoutingSource;
  routeReadback: ExecutionRoutingSnapshot;
  effectiveRouteReadback: ExecutionRoutingSnapshot;
  adapterPolicy: WorkerAdapterPolicySnapshot;
  workerMode: WorkerMode;
  command: WorkerCommandSpec;
  lane?: LaneRow;
  runnerSafety?: ReturnType<typeof runnerSafetyMetadata>;
  exactBlocker: ExecutionRoutingSnapshot["exactBlocker"];
};

export type RunWorkerProgressState = {
  progressed: boolean;
  counts: {
    stepsStarted: number;
    stepsCompleted: number;
    stepsStatusProgressed: number;
    workerStartedEvents: number;
    workerCompletedEvents: number;
    workerBlockedEvents: number;
    proofs: number;
  };
};

export function chooseWorkerAdapter(task: Pick<PlannedTask, "name" | "resources">): WorkerAdapter {
  const haystack = `${task.name} ${task.resources.join(" ")}`.toLowerCase();
  const dailyAiIntent = /daily[\s_-]*ai|daily-ai-research-publish-run/.test(haystack);
  const nisenPrintsIntent = /nisenprints|nisenprints-daily-product-canva-printify-etsy-pinterest/.test(haystack);
  const jobSubmitIntent = /job application manager|job-application-manager|job application daily submit queue|job-application-daily-submit-queue/.test(haystack);
  const jobFollowupIntent = /post-application manager|job-application-follow-up-inbox-2|follow-up inbox/.test(haystack);
  const promptTransferIntent = /prompt transfer|prompt-transfer|prompt_transfer|ukiyoe.*sheets|浮世絵.*転記/.test(haystack);
  const snsMultiPosterIntent = /sns multi poster|sns-multi-poster|sns_multi_poster/.test(haystack);
  const xAuthenticatedLaneIntent = /x authenticated browser lane|x-authenticated-browser-lane|x_authenticated_browser_lane/.test(haystack);
  const emailReviewIntent = /email review|email-review-reply|gmail review|mail review|email_review_registered/.test(haystack);
  const localBackupIntent = /daily backup|daily-backup-safety-check|local backup|backup snapshot/.test(haystack);
  const obsidianAuditIntent = /obsidian.*(?:audit|memory)|obsidian-project-memory-audit|obsidian_audit_registered/.test(haystack);
  const explicitBrowserUseIntent = /browser[\s_-]*use/.test(haystack);
  const codeMaintenanceStructuralIntent = /executor|workerengine|コード|code|実装|レビュー|review|修正|設計|調査|docs?|ドキュメント/.test(haystack);
  const codeMaintenanceIntent = /executor|workerengine|コード|code|実装|レビュー|review|修正|設計|調査|qa|確認|test|テスト|docs?|ドキュメント/.test(haystack);
  const structuralCodeIntent = /executor|workerengine|コード|code|実装|修正|設計|調査|qa|確認|test|テスト|docs?|ドキュメント/.test(haystack);
  if (emailReviewIntent && !structuralCodeIntent) return "email_review_registered";
  if (localBackupIntent && !structuralCodeIntent) return "local_backup_registered";
  if (obsidianAuditIntent && !structuralCodeIntent) return "obsidian_audit_registered";
  const dailyAiRunIntent =
    /\bdaily[\s_-]*ai\b\s*(social_publish)?$|daily-ai-research-publish-run|publish|post|投稿|実行|回して|run|完走|full[\s_-]*flow/.test(
      haystack
    );
  if (dailyAiIntent && !codeMaintenanceIntent && dailyAiRunIntent) {
    return "daily_ai_registered";
  }
  if (nisenPrintsIntent && !codeMaintenanceIntent && /registered workflow|full publish|approval\/proof gate|公開|実行|同期|sync|run|reference|read[_ -]?only|preflight|canary/.test(haystack)) {
    return "nisenprints_registered";
  }
  if (jobFollowupIntent && !codeMaintenanceIntent) {
    return "job_followup_registered";
  }
  if (jobSubmitIntent && !codeMaintenanceIntent) {
    return "job_submit_registered";
  }
  if (promptTransferIntent && !codeMaintenanceIntent) {
    return "prompt_transfer_registered";
  }
  if (snsMultiPosterIntent && !codeMaintenanceIntent) {
    return "sns_multi_poster_registered";
  }
  if (xAuthenticatedLaneIntent && !codeMaintenanceIntent) {
    return "x_authenticated_browser_lane_registered";
  }
  if (explicitBrowserUseIntent && !codeMaintenanceStructuralIntent) {
    return "browser_use_cli";
  }
  if (codeMaintenanceIntent || /research|調査|watchtower|codex|code|コード|実装|レビュー|review|修正|qa|確認|test|テスト/.test(haystack)) {
    return "child_codex";
  }
  if (/playwright|browser use|browser|chrome|runway|mcp/.test(haystack)) {
    return "browser_use_cli";
  }
  if (/x\.com|twitter|linkedin|pinterest|投稿|publish/.test(haystack) && !codeMaintenanceIntent) {
    return "browser_use_cli";
  }
  return "local_worker";
}

export function planCommandRun(command: string): CommandRunPlan {
  const runContract = resolveRunContract(command);
  const decomposedTasks = decomposeGoal(command);
  const lanePlan = allocateParallelLanes(
    decomposedTasks.map((task) => ({
      id: task.id,
      name: task.name,
      role: task.laneRole,
      resources: task.resources,
      dangerousAction: task.dangerousAction
    }))
  );
  const collisionOverrideResources = [
    ...new Set(lanePlan.collisions.map((collision) => collision.resource).filter((resource) => resource !== "local_worker" && resource !== "research_cache"))
  ];
  const tasks = decomposedTasks.map((task, index) => {
    const collisionWith = (lanePlan.lanes[index]?.collisionWith ?? []).filter((resource) => collisionOverrideResources.includes(resource));
    const adapter = chooseWorkerAdapter(task);
    return {
      ...task,
      adapter,
      collisionWith,
      requiresApproval: requiresApproval({ action: task.name, resources: task.resources, dangerousAction: task.dangerousAction })
    };
  });
  const approvalResources = [
    ...new Set([
      ...tasks.filter((task) => task.requiresApproval).flatMap((task) => task.resources)
    ])
  ];
  return {
    command,
    ...(runContract ? { runContract, contractVersion: RUN_CONTRACT_VERSION } : {}),
    tasks,
    lanes: lanePlan.lanes,
    collisions: lanePlan.collisions,
    approvalRequired: approvalResources.length > 0,
    approvalResources,
    collisionOverrideResources
  };
}

export function buildWorkerCommand(input: {
  adapter: WorkerAdapter;
  taskName: string;
  lane?: Pick<LaneRow, "cdp_port" | "profile_dir" | "workdir">;
  nisenprintsDefaultRunnerPath?: string;
}): WorkerCommandSpec {
  if (input.adapter === "child_codex") {
    const childCwd = resolveWorkerWorkspacePath(
      process.env.AUTOMATION_OS_CHILD_CODEX_CWD,
      process.env.AUTOMATION_OS_WORKER_WORKSPACE_ROOT
    );
    const bin = resolveCodexBin(["AUTOMATION_OS_CHILD_CODEX_BIN"]);
    return {
      bin,
      args: ["exec", "--sandbox", "read-only", "--cd", childCwd, input.taskName],
      display: `${bin} exec --sandbox read-only --cd ${JSON.stringify(childCwd)} ${JSON.stringify(
        input.taskName
      )}`
    };
  }
  if (input.adapter === "codex_cli") {
    const bin = resolveCodexBin();
    return {
      bin,
      args: ["exec", "--sandbox", "read-only", input.taskName],
      display: `${bin} exec --sandbox read-only ${JSON.stringify(input.taskName)}`
    };
  }
  const browserUseCliCommand = (workflowId: string, requirement: string): WorkerCommandSpec => {
    const scheduledWorkflow = new Set([
      "daily-ai-research-publish-run",
      "nisenprints-daily-product-canva-printify-etsy-pinterest",
      "job-application-manager",
      "x-authenticated-browser-lane"
    ]).has(workflowId);
    const automaticLane = browserUseLaneFor({
      lifecycle: scheduledWorkflow ? "scheduled" : "single_use",
      ownerKey: input.taskName,
      workflowId
    });
    // The lifecycle allocator is authoritative. A persisted lane snapshot is
    // descriptive readback only and must not override a fresh profile/port
    // binding for the current workflow.
    const laneProfile = automaticLane.profile_dir;
    const lanePort = automaticLane.reserved_port;
    const laneSession = automaticLane.session;
    const session = laneSession;
    return {
      bin: "/usr/local/bin/node",
      args: [browserUseAdapterEntryPoint],
      env: {
        AUTOMATION_OS_BROWSER_SURFACE: "browser_use_cli",
        AUTOMATION_OS_BROWSER_DRIVER: "browser_use_cli",
        AUTOMATION_OS_BROWSER_ADAPTER: browserUseAdapterEntryPoint,
        AUTOMATION_OS_BROWSER_HELPER: browserUseHelper,
        AUTOMATION_OS_BROWSER_RUNTIME_CONFIG: browserUseRuntimeConfig,
        AUTOMATION_OS_BROWSER_NO_FALLBACK: "1",
        AUTOMATION_OS_BROWSER_WORKFLOW_ID: workflowId,
        AUTOMATION_OS_BROWSER_REQUIRED: "1",
        AUTOMATION_OS_BROWSER_REQUIREMENT: requirement,
        AUTOMATION_OS_BROWSER_SESSION: session,
        AUTOMATION_OS_BROWSER_LIFECYCLE: automaticLane.lifecycle,
        AUTOMATION_OS_BROWSER_PROFILE: laneProfile,
        AUTOMATION_OS_BROWSER_PORT: String(lanePort),
        AUTOMATION_OS_BROWSER_SESSION_BINDING: laneSession,
        AUTOMATION_OS_BROWSER_LOCK: automaticLane.lock_path
      },
      display: `node ${JSON.stringify(browserUseAdapterEntryPoint)} AUTOMATION_OS_BROWSER_SURFACE=browser_use_cli AUTOMATION_OS_BROWSER_WORKFLOW_ID=${JSON.stringify(workflowId)} AUTOMATION_OS_BROWSER_LIFECYCLE=${automaticLane.lifecycle} AUTOMATION_OS_BROWSER_PORT=${lanePort} AUTOMATION_OS_BROWSER_PROFILE=${JSON.stringify(laneProfile)} AUTOMATION_OS_BROWSER_REQUIREMENT=${JSON.stringify(requirement)} AUTOMATION_OS_BROWSER_SESSION=${JSON.stringify(session)}`
    };
  };
  if (input.adapter === "browser_use_cli") {
    return browserUseCliCommand("browser-use-cli", "current_run_authority_and_same_session_readback_required");
  }
  if (input.adapter === "playwright_cli") {
    return browserUseCliCommand("browser-check", BROWSER_USE_CLI_REQUIRED_BLOCKER);
  }
  if (input.adapter === "daily_ai_registered") {
    return browserUseCliCommand("daily-ai-research-publish-run", "current_run_authority_and_same_session_readback_required");
  }
  if (input.adapter === "nisenprints_registered") {
    return browserUseCliCommand("nisenprints-daily-product-canva-printify-etsy-pinterest", "current_run_authority_and_same_session_readback_required");
  }
  if (input.adapter === "prompt_transfer_registered") {
    return browserUseCliCommand("prompt-transfer-ukiyoe", BROWSER_USE_CLI_WORKFLOW_ADAPTER_MISSING_BLOCKER);
  }
  if (input.adapter === "sns_multi_poster_registered") {
    return browserUseCliCommand("sns-multi-poster-ukiyoe", BROWSER_USE_CLI_WORKFLOW_ADAPTER_MISSING_BLOCKER);
  }
  if (input.adapter === "job_submit_registered" || input.adapter === "job_followup_registered") {
    const workflowId = "job-application-manager";
    return browserUseCliCommand(workflowId, "current_run_authority_and_same_session_readback_required");
  }
  if (isHumanInputRequiredWithEvidenceAdapter(input.adapter)) {
    const workflowId = humanInputRequiredWithEvidenceWorkflowId(input.adapter);
    return browserUseCliCommand(workflowId, "human_input_required_with_evidence");
  }
  return {
    bin: "automation-os-local-worker",
    args: [input.taskName],
    display: `automation-os-local-worker ${JSON.stringify(input.taskName)}`
  };
}

export function workerModeForAdapter(adapter: WorkerAdapter): WorkerMode {
  switch (adapter) {
    case "child_codex":
      return "execute_child_codex";
    case "codex_cli":
      return "execute_codex";
    case "playwright_cli":
      return "execute_playwright";
    case "browser_use_cli":
      return "execute_browser_use";
    case "daily_ai_registered":
      return "execute_daily_ai_registered";
    case "nisenprints_registered":
      return "execute_nisenprints_registered";
    case "job_submit_registered":
      return "execute_job_submit_registered";
    case "job_followup_registered":
      return "execute_job_followup_registered";
    case "prompt_transfer_registered":
      return "execute_prompt_transfer_registered";
    case "sns_multi_poster_registered":
      return "execute_sns_multi_poster_registered";
    case "x_authenticated_browser_lane_registered":
      return "human_input_required_with_evidence";
    case "email_review_registered":
    case "local_backup_registered":
    case "obsidian_audit_registered":
      return "execute_portable_local_read_only";
    case "local_worker":
      return "receipt_only";
    default:
      return assertNever(adapter);
  }
}

export function resolveWorkerAdapterPolicy(adapter: WorkerAdapter): WorkerAdapterPolicySnapshot {
  switch (adapter) {
    case "playwright_cli":
      return {
        adapter,
        classification: "browser_use_cli",
        exactBlocker: BROWSER_USE_CLI_REQUIRED_BLOCKER,
        evidence: [
          `entrypoint:${browserUseAdapterEntryPoint}`,
          `helper:${browserUseHelper}`,
          `runtime:${browserUseRuntimeConfig}`,
          "surface:browser_use_cli",
          "legacy_playwright_route:disabled",
          "no_fallback:true"
        ]
      };
    case "browser_use_cli":
      return {
        adapter,
        classification: "browser_use_cli",
        exactBlocker: null,
        evidence: [
          `entrypoint:${browserUseAdapterEntryPoint}`,
          `helper:${browserUseHelper}`,
          `runtime:${browserUseRuntimeConfig}`,
          "surface:browser_use_cli",
          "no_fallback:true",
          "binding:run-session-stage-attempt-authority-profile-port-lock-readback"
        ]
      };
    case "daily_ai_registered":
      return {
        adapter,
        classification: "browser_use_cli",
        exactBlocker: null,
        evidence: [
          `entrypoint:${browserUseAdapterEntryPoint}`,
          `helper:${browserUseHelper}`,
          `runtime:${browserUseRuntimeConfig}`,
          "surface:browser_use_cli",
          "workflow_adapter_registry:aos.workflow_adapter_registry.v1",
          "workflow_adapter:daily-ai-research-publish-run",
          "workflow_authority:automation_os_control_plane",
          "workflow_provider_selectable:true",
          "workflow_external_action_allowed:false",
          "no_fallback:true"
        ]
      };
    case "nisenprints_registered":
      return {
        adapter,
        classification: "browser_use_cli",
        exactBlocker: null,
        evidence: [
          `entrypoint:${browserUseAdapterEntryPoint}`,
          `helper:${browserUseHelper}`,
          `runtime:${browserUseRuntimeConfig}`,
          "surface:browser_use_cli",
          "workflow_adapter_registry:aos.workflow_adapter_registry.v1",
          "workflow_adapter:nisenprints-daily-product-canva-printify-etsy-pinterest",
          "workflow_authority:automation_os_control_plane",
          "workflow_provider_selectable:true",
          "workflow_external_action_allowed:false",
          "no_fallback:true"
        ]
      };
    case "job_submit_registered":
    case "job_followup_registered":
      return {
        adapter,
        classification: "browser_use_cli",
        exactBlocker: null,
        evidence: [
          `entrypoint:${browserUseAdapterEntryPoint}`,
          `helper:${browserUseHelper}`,
          `runtime:${browserUseRuntimeConfig}`,
          "surface:browser_use_cli",
          "workflow:job-application-manager",
          "registered_codex_browser_fallback:disabled",
          "live_route:portable_external_worker",
          "no_fallback:true"
        ]
      };
    case "prompt_transfer_registered":
      return {
        adapter,
        classification: "browser_use_cli",
        exactBlocker: BROWSER_USE_CLI_WORKFLOW_ADAPTER_MISSING_BLOCKER,
        evidence: [
          `entrypoint:${browserUseAdapterEntryPoint}`,
          `helper:${browserUseHelper}`,
          `runtime:${browserUseRuntimeConfig}`,
          "surface:browser_use_cli",
          "legacy_prompt_transfer_runner:disabled",
          "required:workflow-owned-browser-use-cli-adapter",
          "no_fallback:true"
        ]
      };
    case "sns_multi_poster_registered":
      return {
        adapter,
        classification: "browser_use_cli",
        exactBlocker: BROWSER_USE_CLI_WORKFLOW_ADAPTER_MISSING_BLOCKER,
        evidence: [
          `entrypoint:${browserUseAdapterEntryPoint}`,
          `helper:${browserUseHelper}`,
          `runtime:${browserUseRuntimeConfig}`,
          "surface:browser_use_cli",
          "legacy_sns_multi_poster_runner:disabled",
          "required:workflow-owned-browser-use-cli-adapter",
          "no_fallback:true"
        ]
      };
    case "x_authenticated_browser_lane_registered":
      return {
        adapter,
        classification: "browser_use_cli",
        exactBlocker: null,
        evidence: [
          "workflow:x-authenticated-browser-lane",
          `entrypoint:${browserUseAdapterEntryPoint}`,
          `helper:${browserUseHelper}`,
          `runtime:${browserUseRuntimeConfig}`,
          "surface:browser_use_cli",
          "mode:human_input_required_with_evidence",
          "legacy_extension_surface:disabled",
          "no_fallback:true"
        ]
      };
    case "email_review_registered":
    case "local_backup_registered":
    case "obsidian_audit_registered":
      return {
        adapter,
        classification: "non_browser",
        exactBlocker: null,
        evidence: [
          "surface:mac_local_worker",
          "worker_protocol:mac_worker_polling_required",
          "execution_mode:read_only",
          "external_action_executed:false",
          "codex_is_not_authority:true"
        ]
      };
    case "child_codex":
    case "codex_cli":
    case "local_worker":
      return {
        adapter,
        classification: "non_browser",
        exactBlocker: null,
        evidence: [`adapter:${adapter}`]
      };
    default:
      return assertNever(adapter);
  }
}

export function classifyWorkerCommandSpec(command: WorkerCommandSpec): {
  classification: WorkerAdapterPolicyClassification;
  signals: string[];
} {
  if (
    command.env?.AUTOMATION_OS_BROWSER_SURFACE === "browser_use_cli" &&
    command.env?.AUTOMATION_OS_BROWSER_DRIVER === "browser_use_cli" &&
    command.env?.AUTOMATION_OS_BROWSER_ADAPTER === browserUseAdapterEntryPoint &&
    command.env?.AUTOMATION_OS_BROWSER_NO_FALLBACK === "1"
  ) {
    return { classification: "browser_use_cli", signals: ["browser-use", "shared-adapter"] };
  }
  if (
    portableExternalEffectsEnabled() &&
    command.env?.DAILY_AI_BROWSER_DRIVER === "browser_use_cli" &&
    command.env?.DAILY_AI_CLI_REQUIRE_BROWSER_USE === "1" &&
    command.env?.DAILY_AI_CLI_RECORDING_REQUIRED === "1"
  ) {
    return { classification: "browser_use_cli", signals: ["browser-use", "daily-ai-registered"] };
  }
  const haystack = [
    command.bin,
    ...command.args,
    command.display,
    ...Object.entries(command.env ?? {}).map(([key, value]) => `${key}=${value}`)
  ]
    .join("\n")
    .toLowerCase();
  const signals = [
    ...matchCommandSignal(haystack, /playwright/gi, "playwright"),
    ...matchCommandSignal(haystack, /browser[\s_-]*use/gi, "browser-use"),
    ...matchCommandSignal(haystack, /cdp|remote-debugging-port/gi, "cdp"),
    ...matchCommandSignal(haystack, /profile(?:_dir|directory)?|user-data-dir/gi, "profile"),
    ...matchCommandSignal(haystack, /temporary chrome|launcher/gi, "launcher")
  ];
  const iabRootOwned = command.env?.AUTOMATION_OS_BROWSER_SURFACE === "in_app_browser"
    && command.env?.AUTOMATION_OS_BROWSER_DRIVER === "codex_in_app_browser";
  if (iabRootOwned) {
    return { classification: "legacy_browser_backed", signals: [...signals, "in-app-browser-disabled"] };
  }
  if (signals.length === 0) {
    return { classification: "non_browser", signals };
  }
  if (signals.includes("browser-use")) {
    return { classification: "legacy_browser_backed", signals };
  }
  if (signals.includes("playwright") || signals.includes("cdp") || signals.includes("profile") || signals.includes("launcher")) {
    return { classification: "legacy_browser_backed", signals };
  }
  return { classification: "non_browser", signals };
}

function portableExternalEffectsEnabled(): boolean {
  const value = (
    process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS
    || process.env.AUTOMATION_OS_EXTERNAL_EFFECTS
    || ""
  ).trim();
  return /^(?:1|true|yes|on|enabled)$/i.test(value);
}

function matchCommandSignal(haystack: string, pattern: RegExp, label: string): string[] {
  return pattern.test(haystack) ? [label] : [];
}

function assertNever(value: never): never {
  throw new Error(`Unhandled worker adapter policy: ${String(value)}`);
}

export type StartCommandRunOptions = {
  metadata?: Record<string, unknown>;
  /** Internal AOS-owned routing snapshot for fixed portable workflows. */
  executionRouting?: ExecutionRoutingSnapshot;
  deferWorker?: boolean;
  companyId?: string | null;
  prepareOnly?: boolean;
  /** Internal isolated reference canary marker; never accepted from API metadata. */
  referenceWorkflowCanary?: boolean;
  /** Internal preallocated run id used to bind artifacts before queue admission. */
  runId?: string;
};

function resolveAuthorizedCompanyId(options: StartCommandRunOptions): string | null {
  if (!Object.prototype.hasOwnProperty.call(options, "companyId")) return null;
  const companyId = typeof options.companyId === "string" ? options.companyId.trim() : "";
  if (!companyId) {
    throw new Error("company_id_required");
  }
  return companyId;
}

function getRunCompanyId(runId: string): string | null {
  const run = querySql<{ company_id: string | null }>(`SELECT company_id FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  if (!run) return null;
  return typeof run.company_id === "string" && run.company_id.trim() ? run.company_id.trim() : null;
}

type CommandRunSummary = {
  runId: string;
  run: Record<string, unknown>;
  steps: Record<string, unknown>[];
  approvals: Record<string, unknown>[];
  proofs: Record<string, unknown>[];
  children: Record<string, unknown>[];
};

async function startCommandRunPostgresFast(input: {
  command: string;
  options: StartCommandRunOptions;
  plan: CommandRunPlan;
  routeDecision: ExecutionRoutingSnapshot;
  metadata: Record<string, unknown>;
  referenceWorkflowCanary: boolean;
  companyId: string | null;
  runId: string;
  now: string;
  serviceReadinessWorkflowId: string | null;
  serviceReadinessRootId: string | null;
}): Promise<CommandRunSummary> {
  const { command, options, plan, routeDecision, metadata, referenceWorkflowCanary, companyId, runId, now, serviceReadinessWorkflowId, serviceReadinessRootId } = input;
  const runMetadata = {
    ...metadata,
    command,
    ...(referenceWorkflowCanary ? { reference_workflow_canary: true } : {}),
    plan,
    ...buildCanonicalExecutionRoutingMetadata(routeDecision),
    ...(plan.runContract ? { run_contract: plan.runContract, contract_version: plan.contractVersion } : {}),
    ...(serviceReadinessWorkflowId
      ? {
          service_readiness_root_id: serviceReadinessRootId,
          service_readiness_workflow_id: serviceReadinessWorkflowId,
          service_readiness_surface: "browser_use_cli",
          service_readiness_capability_mode: "read_only",
          service_readiness_external_action_executed: false,
          service_readiness_legacy_surfaces_forbidden: true,
          service_readiness_prior_receipt_reuse: false
        }
      : {}),
    ai_adapters: ["codex_cli", "chatgpt_subscription", "browser_use_cli"],
    browser_use_lane_bindings: plan.lanes.map((lane) => ({
      lifecycle: lane.lifecycle,
      reserved_port: lane.cdpPort,
      profile_dir: lane.profileDir,
      session: lane.browserUseSession,
      surface: "browser_use_cli",
      allocation: lane.lifecycle === "scheduled" ? "workflow_reserved" : "run_derived",
      cleanup: "owner_process_port_profile_flow_lease"
    })),
    openai_api: "not_required"
  };
  const stepRows = plan.tasks.map((task, index) => {
    const lane = plan.lanes[index];
    if (!lane) throw new Error(`service_readiness_browser_use_lane_missing:${index}`);
    const stepId = `${runId}_step_${index + 1}`;
    const stepMetadata = {
      resources: task.resources,
      dangerous_action: task.dangerousAction,
      requires_approval: task.requiresApproval,
      collision_with: task.collisionWith,
      collision_override_required: task.collisionWith.length > 0,
      adapter: task.adapter,
      parallel_safe: task.parallelSafe,
      ...(typeof metadata.read_only_stage === "string" ? { read_only_stage: metadata.read_only_stage } : {}),
      routing_source: routeDecision.source,
      routing_controller: routeDecision.controller.name,
      ...(serviceReadinessWorkflowId
        ? {
            service_readiness_runtime_binding: buildBrowserUseRuntimeBindingForLane({
              runId,
              workflowId: serviceReadinessWorkflowId,
              stageId: stepId,
              attemptId: `attempt:${runId}:step:${index + 1}`,
              ownerKey: lane.taskId,
              port: lane.cdpPort,
              profileRoot: lane.browserUseProfile,
              requestedSessionId: lane.browserUseSession,
              lifecycle: lane.lifecycle
            })
          }
        : {}),
      ...buildCanonicalExecutionRoutingMetadata(routeDecision)
    };
    return { id: stepId, lane, task, metadata: stepMetadata };
  });
  const approval = plan.approvalRequired && !options.prepareOnly
    ? createApprovalRequest({
        runId,
        title: `Approve command run: ${command.slice(0, 80)}`,
        requestedBy: "control-panel",
        approvalGroupId: `${runId}_approval_group`,
        resourceLocks: plan.approvalResources,
        priority: "high"
      })
    : null;
  const runStatus = options.prepareOnly ? "preparing" : plan.approvalRequired ? "waiting_approval" : "queued";
  const statements: string[] = [
    `INSERT INTO runs
     (id, company_id, automation_id, automation_version_id, name, status, objective, created_at, updated_at, metadata_json, execution_source, quarantined)
     VALUES (${sqlValue(runId)}, ${sqlValue(companyId)}, ${sqlValue(referenceWorkflowCanary ? "reference_workflow_canary" : null)}, NULL,
             ${sqlValue(command.slice(0, 72) || "Automation OS command")}, ${sqlValue(runStatus)}, ${sqlValue(command)},
             ${sqlValue(now)}, ${sqlValue(now)}, ${sqlValue(runMetadata)}, ${sqlValue(PORTABLE_EXECUTION_SOURCE)}, 0)`
  ];
  for (const { lane, task } of stepRows) {
    statements.push(`INSERT INTO lanes
      (id, run_id, role, cdp_port, profile_dir, workdir, browser_use_session, browser_use_cdp_url, browser_use_profile,
       profile_strategy, lane_visibility, status, current_task, progress, health, resource_locks_json, updated_at)
      VALUES (${sqlValue(`${runId}_${lane.id}`)}, ${sqlValue(runId)}, ${sqlValue(lane.role)}, ${sqlValue(lane.cdpPort)},
              ${sqlValue(lane.profileDir)}, ${sqlValue(lane.workdir)}, ${sqlValue(lane.browserUseSession)}, ${sqlValue(lane.browserUseCdpUrl)},
              ${sqlValue(lane.browserUseProfile)}, ${sqlValue(lane.profileStrategy)}, ${sqlValue(lane.laneVisibility)},
              ${sqlValue(options.prepareOnly ? "blocked" : task.requiresApproval ? "blocked" : "active")}, ${sqlValue(task.name)},
              ${sqlValue(options.prepareOnly || task.requiresApproval ? 0 : 10)},
              ${sqlValue(options.prepareOnly ? "preparing" : lane.collisionWith.length ? "collision" : task.requiresApproval ? "approval_required" : "good")},
              ${sqlValue(lane.resourceLocks)}, ${sqlValue(now)})`);
  }
  for (const { id, lane, task, metadata: stepMetadata } of stepRows) {
    statements.push(`INSERT INTO run_steps
      (id, run_id, company_id, name, status, lane_id, started_at, completed_at, metadata_json)
      VALUES (${sqlValue(id)}, ${sqlValue(runId)}, ${sqlValue(companyId)}, ${sqlValue(task.name)},
              ${sqlValue(options.prepareOnly ? "preparing" : task.requiresApproval ? "waiting_approval" : "queued")},
              ${sqlValue(`${runId}_${lane.id}`)}, ${sqlValue(options.prepareOnly || task.requiresApproval ? null : now)}, NULL,
              ${sqlValue(stepMetadata)})`);
  }
  if (approval) {
    statements.push(`INSERT INTO approvals
      (id, run_id, title, requested_by, status, priority, company_id, approval_group_id, resource_locks_json, created_at, decided_at, decision_note)
      VALUES (${sqlValue(approval.id)}, ${sqlValue(runId)}, ${sqlValue(approval.title)}, ${sqlValue(approval.requestedBy)},
              ${sqlValue(approval.status)}, ${sqlValue(approval.priority)}, ${sqlValue(companyId)}, ${sqlValue(approval.approvalGroupId)},
              ${sqlValue(approval.resourceLocks)}, ${sqlValue(approval.createdAt)}, NULL, NULL)`);
  }
  statements.push(`INSERT INTO worker_events
    (id, company_id, run_id, step_id, lane_id, event_type, message, created_at, metadata_json)
    VALUES (${sqlValue(makeId("evt"))}, ${sqlValue(companyId)}, ${sqlValue(runId)}, NULL, NULL,
            'run_created', 'Command run created', ${sqlValue(now)}, ${sqlValue({ plan })})`);
  await runSqlScriptAsync(statements);
  return {
    runId,
    run: { id: runId, status: runStatus },
    steps: stepRows.map(({ id, lane, task, metadata }) => ({ id, run_id: runId, name: task.name, status: options.prepareOnly ? "preparing" : task.requiresApproval ? "waiting_approval" : "queued", lane_id: `${runId}_${lane.id}`, metadata_json: JSON.stringify(metadata) })),
    approvals: approval ? [{ id: approval.id, run_id: runId, status: approval.status }] : [],
    proofs: [],
    children: []
  };
}

function insertRunProof(runId: string, row: Record<string, SqlValue>): void {
  const run = querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  const runMetadata = parseJson<Record<string, unknown>>(run?.metadata_json ?? "{}", {});
  const registeredWorkflowStart = runMetadata.registered_workflow_start;
  const rowMetadata = typeof row.metadata_json === "object" && row.metadata_json !== null && !Array.isArray(row.metadata_json)
    ? row.metadata_json as Record<string, unknown>
    : typeof row.metadata_json === "string"
      ? parseJson<Record<string, unknown>>(row.metadata_json, {})
      : {};
  const stepId = typeof row.step_id === "string" && row.step_id.trim() ? row.step_id.trim() : null;
  const runtimeBinding = stepId ? serviceReadinessRuntimeBindingForStep(runId, stepId, runMetadata) : null;
  insert("proofs", {
    ...row,
    ...(registeredWorkflowStart && typeof registeredWorkflowStart === "object" && !Array.isArray(registeredWorkflowStart)
      ? {
          metadata_json: {
            ...rowMetadata,
            registered_workflow_start: registeredWorkflowStart,
            ...(runtimeBinding ? { service_readiness_runtime_binding: runtimeBinding } : {})
          }
        }
      : runtimeBinding
        ? { metadata_json: { ...rowMetadata, service_readiness_runtime_binding: runtimeBinding } }
        : {}),
    company_id: getRunCompanyId(runId)
  });
}

function serviceReadinessRuntimeBindingForStep(
  runId: string,
  stepId: string,
  runMetadata: Record<string, unknown> = getRunMetadata(runId)
): ServiceReadinessRuntimeBindingV1 | ServiceReadinessBrowserUseRuntimeBindingV1 | null {
  const workflowId = referenceWorkflowIdFromMetadata(runMetadata);
  if (!workflowId) return null;
  const rootId = typeof runMetadata.service_readiness_root_id === "string" && runMetadata.service_readiness_root_id.trim()
    ? runMetadata.service_readiness_root_id.trim()
    : deriveServiceReadinessRootId(runId);
  const step = querySql<{ metadata_json: string; lane_id: string | null }>(`SELECT metadata_json, lane_id FROM run_steps WHERE id=${sqlValue(stepId)} AND run_id=${sqlValue(runId)} LIMIT 1`)[0];
  const stepMetadata = parseJson<Record<string, unknown>>(step?.metadata_json ?? "{}", {});
  if (runMetadata.service_readiness_surface === "browser_use_cli" || runMetadata.reference_workflow_canary === true) {
    const lane = step?.lane_id
      ? querySql<LaneRow>(`SELECT cdp_port, profile_dir, browser_use_session, browser_use_profile FROM lanes WHERE id=${sqlValue(step.lane_id)} LIMIT 1`)[0]
      : undefined;
    if (!lane) return null;
    return buildBrowserUseRuntimeBindingForLane({
      runId,
      workflowId,
      stageId: stepId,
      attemptId: `attempt:${runId}:step:${stepId}`,
      ownerKey: `${runId}_${stepId}`,
      port: lane.cdp_port,
      profileRoot: lane.browser_use_profile ?? lane.profile_dir,
      requestedSessionId: lane.browser_use_session ?? `browser-use-${runId}-${stepId}`
    });
  }
  const existing = stepMetadata.service_readiness_runtime_binding;
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    const built = buildServiceReadinessRuntimeBindingV1({
      root_id: rootId,
      workflow_id: workflowId,
      run_id: runId,
      stage_id: stepId,
      attempt_id: typeof (existing as Record<string, unknown>).attempt_id === "string" ? (existing as Record<string, unknown>).attempt_id as string : `attempt:${runId}:step:${stepId}`,
      fencing_token: Number.isSafeInteger((existing as Record<string, unknown>).fencing_token)
        ? Number((existing as Record<string, unknown>).fencing_token)
        : 1,
      effect_key: typeof (existing as Record<string, unknown>).effect_key === "string" ? (existing as Record<string, unknown>).effect_key as string : null,
      capability_id: typeof (existing as Record<string, unknown>).capability_id === "string" ? (existing as Record<string, unknown>).capability_id as string : null,
      iab_identity: (existing as Record<string, unknown>).iab_identity && typeof (existing as Record<string, unknown>).iab_identity === "object"
        ? (existing as Record<string, unknown>).iab_identity as ServiceReadinessRuntimeBindingV1["iab_identity"]
        : null
    });
    return built;
  }
  return buildServiceReadinessRuntimeBindingV1({
    root_id: rootId,
    workflow_id: workflowId,
    run_id: runId,
    stage_id: stepId,
    attempt_id: `attempt:${runId}:step:${stepId}`,
    fencing_token: 1
  });
}

function browserUseLifecycleForPort(port: number): "scheduled" | "single_use" | "temporary" {
  if (port >= 19880 && port <= 19899) return "scheduled";
  if (port >= 19980 && port <= 19999) return "single_use";
  if (port >= 20080 && port <= 20099) return "temporary";
  throw new Error("service_readiness_browser_use_lane_port_invalid");
}

function buildBrowserUseRuntimeBindingForLane(input: {
  runId: string;
  workflowId: string;
  stageId: string;
  attemptId: string;
  ownerKey: string;
  port: number;
  profileRoot: string;
  requestedSessionId: string;
  lifecycle?: "scheduled" | "single_use" | "temporary";
}): ServiceReadinessBrowserUseRuntimeBindingV1 {
  const lifecycle = input.lifecycle ?? browserUseLifecycleForPort(input.port);
  const lockPath = profileLockPathFor(input.profileRoot);
  const authorityDigest = createHash("sha256").update(JSON.stringify({
    schema: "aos.browser_use_planned_binding.v1",
    run_id: input.runId,
    workflow_id: input.workflowId,
    stage_id: input.stageId,
    attempt_id: input.attemptId,
    profile_root: input.profileRoot,
    reserved_port: input.port,
    requested_session_id: input.requestedSessionId
  }), "utf8").digest("hex");
  return buildServiceReadinessBrowserUseRuntimeBindingV1({
    root_id: deriveServiceReadinessRootId(input.runId),
    workflow_id: input.workflowId,
    run_id: input.runId,
    stage_id: input.stageId,
    attempt_id: input.attemptId,
    authority_digest: authorityDigest,
    requested_session_id: input.requestedSessionId,
    effective_session_id: null,
    profile_root: input.profileRoot,
    reserved_port: input.port,
    lock_path: lockPath,
    process_identity: null,
    readback_status: "required",
    mode: "authorized"
  });
}

export async function startCommandRun(command: string, options: StartCommandRunOptions = {}) {
  const plan = planCommandRun(command);
  const routeDecision = options.executionRouting ?? buildExecutionRoutingSnapshot({
      command,
      source: inferExecutionRoutingSource(options.metadata),
      phase: "route_decision"
    });
  const metadata = sanitizeRunMetadata(options.metadata);
  const referenceWorkflowCanary = options.referenceWorkflowCanary === true;
  const companyId = resolveAuthorizedCompanyId(options);
  const runId = options.runId ?? makeId("run");
  const serviceReadinessWorkflowId = referenceWorkflowIdFromMetadata(metadata);
  const serviceReadinessRootId = serviceReadinessWorkflowId ? deriveServiceReadinessRootId(runId) : null;
  const now = nowIso();
  if (dbBackend === "postgres") {
    const fastResult = await startCommandRunPostgresFast({
      command,
      options,
      plan,
      routeDecision,
      metadata,
      referenceWorkflowCanary,
      companyId,
      runId,
      now,
      serviceReadinessWorkflowId,
      serviceReadinessRootId
    });
    if (options.deferWorker) return fastResult;
    await runWorkerCycle(runId);
    return summarizeRun(runId);
  }
  insert("runs", {
    id: runId,
    ...(referenceWorkflowCanary ? { automation_id: "reference_workflow_canary" } : {}),
    company_id: companyId,
    name: command.slice(0, 72) || "Automation OS command",
    status: options.prepareOnly ? "preparing" : plan.approvalRequired ? "waiting_approval" : "queued",
    objective: command,
    created_at: now,
    updated_at: now,
    metadata_json: {
      ...metadata,
      command,
      ...(referenceWorkflowCanary ? { reference_workflow_canary: true } : {}),
      plan,
      ...buildCanonicalExecutionRoutingMetadata(routeDecision),
      ...(plan.runContract ? { run_contract: plan.runContract, contract_version: plan.contractVersion } : {}),
      ...(serviceReadinessWorkflowId
        ? {
            service_readiness_root_id: serviceReadinessRootId,
            service_readiness_workflow_id: serviceReadinessWorkflowId,
            service_readiness_surface: "browser_use_cli",
            service_readiness_capability_mode: "read_only",
            service_readiness_external_action_executed: false,
            service_readiness_legacy_surfaces_forbidden: true,
            service_readiness_prior_receipt_reuse: false
          }
        : {}),
      ai_adapters: ["codex_cli", "chatgpt_subscription", "browser_use_cli"],
      browser_use_lane_bindings: plan.lanes.map((lane) => ({
        lifecycle: lane.lifecycle,
        reserved_port: lane.cdpPort,
        profile_dir: lane.profileDir,
        session: lane.browserUseSession,
        surface: "browser_use_cli",
        allocation: lane.lifecycle === "scheduled" ? "workflow_reserved" : "run_derived",
        cleanup: "owner_process_port_profile_flow_lease"
      })),
      openai_api: "not_required"
    }
  });

  plan.lanes.forEach((lane, index) => {
    const task = plan.tasks[index];
    insert("lanes", {
      id: `${runId}_${lane.id}`,
      run_id: runId,
      role: lane.role,
      cdp_port: lane.cdpPort,
      profile_dir: lane.profileDir,
      workdir: lane.workdir,
      browser_use_session: lane.browserUseSession,
      browser_use_cdp_url: lane.browserUseCdpUrl,
      browser_use_profile: lane.browserUseProfile,
      profile_strategy: lane.profileStrategy,
      lane_visibility: lane.laneVisibility,
      status: options.prepareOnly ? "blocked" : task?.requiresApproval ? "blocked" : "active",
      current_task: task?.name ?? "standby",
      progress: options.prepareOnly || task?.requiresApproval ? 0 : 10,
      health: options.prepareOnly ? "preparing" : lane.collisionWith.length ? "collision" : task?.requiresApproval ? "approval_required" : "good",
      resource_locks_json: lane.resourceLocks,
      updated_at: now
    });
  });

  plan.tasks.forEach((task, index) => {
    const lane = plan.lanes[index];
    if (!lane) throw new Error(`service_readiness_browser_use_lane_missing:${index}`);
    insert("run_steps", {
      id: `${runId}_step_${index + 1}`,
      run_id: runId,
      company_id: companyId,
      name: task.name,
      status: options.prepareOnly ? "preparing" : task.requiresApproval ? "waiting_approval" : "queued",
      lane_id: `${runId}_${plan.lanes[index]?.id}`,
      started_at: options.prepareOnly || task.requiresApproval ? null : now,
      completed_at: null,
      metadata_json: {
        resources: task.resources,
        dangerous_action: task.dangerousAction,
        requires_approval: task.requiresApproval,
        collision_with: task.collisionWith,
        collision_override_required: task.collisionWith.length > 0,
        adapter: task.adapter,
        parallel_safe: task.parallelSafe,
        ...(typeof metadata.read_only_stage === "string" ? { read_only_stage: metadata.read_only_stage } : {}),
        routing_source: routeDecision.source,
        routing_controller: routeDecision.controller.name,
        ...(serviceReadinessWorkflowId
          ? {
                service_readiness_runtime_binding: buildBrowserUseRuntimeBindingForLane({
                  runId,
                  workflowId: serviceReadinessWorkflowId,
                  stageId: `${runId}_step_${index + 1}`,
                  attemptId: `attempt:${runId}:step:${index + 1}`,
                  ownerKey: lane.taskId,
                  port: lane.cdpPort,
                  profileRoot: lane.browserUseProfile,
                  requestedSessionId: lane.browserUseSession,
                  lifecycle: lane.lifecycle
                })
            }
          : {}),
        ...buildCanonicalExecutionRoutingMetadata(routeDecision)
      }
    });
  });

  if (plan.approvalRequired && !options.prepareOnly) {
    const persistedCompanyId = getRunCompanyId(runId);
    const approval = createApprovalRequest({
      runId,
      title: `Approve command run: ${command.slice(0, 80)}`,
      requestedBy: "control-panel",
      approvalGroupId: `${runId}_approval_group`,
      resourceLocks: plan.approvalResources,
      priority: "high"
    });
    insert("approvals", {
      id: approval.id,
      run_id: approval.runId,
      title: approval.title,
      requested_by: approval.requestedBy,
      status: approval.status,
      priority: approval.priority,
      company_id: persistedCompanyId,
      approval_group_id: approval.approvalGroupId,
      resource_locks_json: approval.resourceLocks,
      created_at: approval.createdAt,
      decided_at: null,
      decision_note: null
    });
  }

  logWorkerEvent({ runId, eventType: "run_created", message: "Command run created", metadata: { plan } });
  if (options.deferWorker) {
    return summarizeRun(runId);
  }
  await runWorkerCycle(runId);
  return summarizeRun(runId);
}

export async function resumeRunAfterApproval(runId: string) {
  if (!runId) return undefined;
  return runWorkerCycle(runId);
}

export async function runWorkerOnce(runId?: string) {
  const runIds = runId
    ? querySql<{ id: string }>(`SELECT id FROM runs WHERE id=${sqlValue(runId)} AND execution_source=${sqlValue(PORTABLE_EXECUTION_SOURCE)} AND quarantined=0 AND NOT EXISTS (SELECT 1 FROM durable_jobs WHERE durable_jobs.run_id=runs.id)`).map((row) => row.id)
    : querySql<{ id: string }>(`SELECT id FROM runs WHERE status IN ('queued', 'running', 'waiting_approval') AND execution_source=${sqlValue(PORTABLE_EXECUTION_SOURCE)} AND quarantined=0 AND NOT EXISTS (SELECT 1 FROM durable_jobs WHERE durable_jobs.run_id=runs.id) ORDER BY created_at ASC`).map(
      (row) => row.id
    );
  const summaries = [];
  for (const id of runIds) {
    summaries.push(await runWorkerCycle(id));
  }
  return summaries;
}

/**
 * Mac's durable worker owns this narrow queue in addition to the durable_jobs
 * tables.  Portable workflow starts are intentionally persisted as runs so
 * the AOS API can bind the input bundle and idempotency receipt before any
 * worker is online.  A durable-only worker must still pick those rows up;
 * otherwise the run remains queued forever even though the worker is healthy.
 *
 * Keep this selector stricter than runWorkerOnce: only AOS portable invocations
 * explicitly handed to the Mac worker are eligible.  Legacy/local runs and
 * durable_jobs rows stay on their existing lanes.
 */
export async function runPortableMacWorkerOnce(targetRunId?: string) {
  const rows = await querySqlAsync<{ id: string; metadata_json: string }>(`
    SELECT id, metadata_json FROM runs
    WHERE status IN ('queued', 'running', 'waiting_approval')
      AND execution_source=${sqlValue(PORTABLE_EXECUTION_SOURCE)}
      AND quarantined=0
      AND NOT EXISTS (SELECT 1 FROM durable_jobs WHERE durable_jobs.run_id=runs.id)
      ${targetRunId ? `AND id=${sqlValue(targetRunId)}` : ""}
    ORDER BY created_at ASC, id ASC
    LIMIT 50
  `);
  const runIds = rows
    .filter((row) => {
      const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
      const invocation = metadata.portable_workflow_invocation;
      return metadata.worker_protocol === "mac_worker_polling_required"
        && metadata.worker_mode === "queued_for_mac_worker"
        && invocation && typeof invocation === "object" && !Array.isArray(invocation);
    })
    .map((row) => row.id);
  const summaries = [];
  for (const id of runIds) {
    const row = rows.find((candidate) => candidate.id === id);
    const metadata = parseJson<Record<string, unknown>>(row?.metadata_json, {});
    const plan = metadata.plan && typeof metadata.plan === "object" && !Array.isArray(metadata.plan)
      ? metadata.plan as Record<string, unknown>
      : undefined;
    const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
    const adapter = typeof tasks[0] === "object" && tasks[0] !== null && !Array.isArray(tasks[0])
      ? String((tasks[0] as Record<string, unknown>).adapter ?? "")
      : "";
    const localWorkflowId = localWorkflowIdForWorkerAdapter(adapter);
    if (localWorkflowId && isPortableLocalRun(metadata, localWorkflowId)) {
      summaries.push(await runPortableLocalWorkerCycle(id));
    } else {
      summaries.push(await runWorkerCycle(id));
    }
  }
  return summaries;
}

/**
 * The Mac-owned portable local queue is also the PostgreSQL worker's narrow
 * read-only boundary.  Keep it on the async pool: the generic worker engine
 * still has legacy synchronous callers, but a queued local receipt must not
 * spawn a blocking postgres child for every intermediate read/write.
 */
async function runPortableLocalWorkerCycle(runId: string) {
  const run = (await querySqlAsync<{
    id: string;
    status: string;
    company_id: string | null;
    metadata_json: string;
  }>(`SELECT id, status, company_id, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`))[0];
  if (!run) return { runId, status: "missing" };

  const steps = await querySqlAsync<StepRow>(`SELECT * FROM run_steps WHERE run_id=${sqlValue(runId)} ORDER BY id ASC`);
  const step = steps.find((candidate) => candidate.status === "queued" || candidate.status === "waiting_approval");
  if (!step) return { runId, status: run.status };

  const runMetadata = parseJson<Record<string, unknown>>(run.metadata_json, {});
  const metadata = parseJson<Record<string, unknown>>(step.metadata_json, {});
  const selectedAdapter = String(metadata.adapter ?? "local_worker") as WorkerAdapter;
  const workflowId = localWorkflowIdForWorkerAdapter(selectedAdapter);
  if (!workflowId || !isPortableLocalRun(runMetadata, workflowId)) {
    return { runId, status: "skipped", exactBlocker: "portable_local_worker_route_not_bound" };
  }

  const now = nowIso();
  await runSqlScriptAsync([
    `UPDATE runs SET status='running', updated_at=${sqlValue(now)}, metadata_json=${sqlValue({
      ...runMetadata,
      worker_protocol: "mac_worker_polling_required",
      worker_mode: "queued_for_mac_worker",
      active_step_id: step.id,
      active_adapter: selectedAdapter
    })} WHERE id=${sqlValue(runId)}`,
    `UPDATE run_steps SET status='running', started_at=COALESCE(started_at, ${sqlValue(now)}) WHERE id=${sqlValue(step.id)}`,
    `UPDATE lanes SET status='active', progress=50, updated_at=${sqlValue(now)} WHERE id=${sqlValue(step.lane_id)}`
  ]);

  const receipt = runPortableLocalWorkflowReadOnly({
    workflowId,
    workerRole: process.env.AUTOMATION_OS_WORKER_ROLE?.trim()
  });
  const artifact = writeNamedWorkerArtifact(runId, `${step.id}-portable-local-worker.json`, {
    schema: "aos.portable_local_worker_receipt.v1",
    ...receipt,
    run_id: runId,
    step_id: step.id,
    adapter: selectedAdapter,
    created_at: now
  });
  const completed = receipt.status === "complete" && receipt.exact_blocker === null;
  const stepStatus = completed ? "completed" : "blocked";
  const laneStatus = completed ? "idle" : "blocked";
  const proofGate = completed
    ? { ok: true, missing: [] as string[], present: ["portable_local_worker_receipt", "cleanup_verified"] }
    : { ok: false, missing: [receipt.exact_blocker ?? "portable_local_worker_business_completion_pending"], present: ["portable_local_worker_receipt", "cleanup_verified"] };
  const proofSummary = completed
    ? "complete: Mac local read-only adapter returned a verified receipt"
    : `blocked: ${receipt.exact_blocker ?? "portable_local_worker_business_completion_pending"}`;
  const proofMetadata = {
    adapter: selectedAdapter,
    execution_mode: "portable_local_read_only",
    workflow_id: workflowId,
    exact_blocker: receipt.exact_blocker,
    readback_verified: receipt.readback_verified,
    business_completion_verified: false,
    external_action_executed: false,
    ...(runMetadata.registered_workflow_start && typeof runMetadata.registered_workflow_start === "object" && !Array.isArray(runMetadata.registered_workflow_start)
      ? { registered_workflow_start: runMetadata.registered_workflow_start }
      : {})
  };
  const updatedStepMetadata = {
    ...metadata,
    adapter: selectedAdapter,
    execution_mode: "portable_local_read_only",
    portable_local_workflow_id: workflowId,
    portable_local_receipt: receipt,
    portable_local_artifact: artifact.uri,
    proof_gate: proofGate,
    proof_summary: proofSummary,
    exact_blocker: receipt.exact_blocker,
    external_action_executed: false,
    business_completion_verified: false
  };
  const portableLocalWorkerMetadata = {
    workflow_id: workflowId,
    adapter: selectedAdapter,
    artifact_uri: artifact.uri,
    receipt,
    external_action_executed: false,
    business_completion_verified: false
  };
  const finalStatus = completed ? "complete" : "blocked";
  const finalRunMetadata = {
    ...runMetadata,
    worker_protocol: "mac_worker_polling_required",
    worker_mode: "queued_for_mac_worker",
    active_step_id: null,
    active_adapter: null,
    portable_local_worker: portableLocalWorkerMetadata,
    proof_gate: proofGate,
    proof_summary: proofSummary
  };
  await runSqlScriptAsync([
    `INSERT INTO proofs
      (id, run_id, step_id, proof_type, label, uri, size_bytes, created_at, metadata_json, company_id)
      VALUES (${sqlValue(makeId("proof"))}, ${sqlValue(runId)}, ${sqlValue(step.id)}, 'worker_receipt',
              ${sqlValue(`${workflowId} Mac local worker read-only receipt`)}, ${sqlValue(artifact.uri)},
              ${sqlValue(artifact.sizeBytes)}, ${sqlValue(now)}, ${sqlValue(proofMetadata)}, ${sqlValue(run.company_id)})`,
    `UPDATE run_steps SET status=${sqlValue(stepStatus)}, completed_at=${sqlValue(now)}, metadata_json=${sqlValue(updatedStepMetadata)} WHERE id=${sqlValue(step.id)}`,
    `UPDATE lanes SET status=${sqlValue(laneStatus)}, progress=${completed ? 100 : 50}, health=${sqlValue(completed ? "good" : "blocked")}, updated_at=${sqlValue(now)} WHERE id=${sqlValue(step.lane_id)}`,
    `INSERT INTO worker_events
      (id, company_id, run_id, step_id, lane_id, event_type, message, created_at, metadata_json)
      VALUES (${sqlValue(makeId("evt"))}, ${sqlValue(run.company_id)}, ${sqlValue(runId)}, ${sqlValue(step.id)},
              ${sqlValue(step.lane_id)}, ${sqlValue(completed ? "worker_completed" : "worker_blocked")},
              ${sqlValue(proofSummary)}, ${sqlValue(now)}, ${sqlValue({
                adapter: selectedAdapter,
                workflow_id: workflowId,
                artifact_uri: artifact.uri,
                exact_blocker: receipt.exact_blocker,
                external_action_executed: false,
                business_completion_verified: false
              })})`,
    `UPDATE runs SET status=${sqlValue(finalStatus)}, updated_at=${sqlValue(now)}, metadata_json=${sqlValue(finalRunMetadata)} WHERE id=${sqlValue(runId)}`
  ]);

  return {
    runId,
    status: finalStatus,
    workerMode: "execute_portable_local_read_only" as const,
    proof_gate: proofGate,
    proof_summary: proofSummary,
    metadata: { portable_local_worker: portableLocalWorkerMetadata }
  };
}

export async function runWorkerCycle(runId: string) {
  const run = querySql<{ id: string; status: string }>(`SELECT id, status FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  if (!run) return { runId, status: "missing" };
  if (run.status === "preparing") {
    return summarizeRun(runId);
  }

  reconcileStaleChildCodexRuns(runId);
  reconcileStaleDailyAiRegisteredRuns(runId);
  reconcileStaleRegisteredCodexAutomationRuns(runId);

  const approvals = querySql<{ status: string }>(`SELECT status FROM approvals WHERE run_id=${sqlValue(runId)}`);
  const hasRejectedApproval = approvals.some((approval) => approval.status === "rejected");
  const hasCancelledApproval = approvals.some((approval) => approval.status === "cancelled");
  const hasPendingApproval = approvals.some((approval) => approval.status === "pending");
  const protectedStepsAllowed = approvalsAllowProtectedSteps(approvals);
  if (hasRejectedApproval) {
    updateRunStatus(runId, "blocked", { stop_reason: "approval_rejected" });
    return summarizeRun(runId);
  }
  if (hasCancelledApproval) {
    updateRunStatus(runId, "cancelled", { stop_reason: "approval_cancelled" });
    return summarizeRun(runId);
  }

  const steps = querySql<StepRow>(`SELECT * FROM run_steps WHERE run_id=${sqlValue(runId)} ORDER BY id ASC`);
  let blockedByApproval = false;
  const registeredExecutionResults: RegisteredExecutionResult[] = [];
  for (const step of steps) {
    if (step.status === "completed" || step.status === "running") continue;
    const metadata = parseJson<Record<string, unknown>>(step.metadata_json, {});
    const stepAwaitingExecution = step.status === "queued" || step.status === "waiting_approval";
    const portableExternalWorkflowId = portableExternalApprovalWorkflowId(runId, metadata);
    if (portableExternalWorkflowId && stepAwaitingExecution) {
      const approvalStatus = ensurePortableExternalApproval({
        runId,
        step,
        metadata,
        workflowId: portableExternalWorkflowId
      });
      metadata.requires_approval = true;
      if (approvalStatus !== "approved") {
        blockedByApproval = true;
        continue;
      }
    }
    const registeredExternalWorkflowId = registeredExternalApprovalWorkflowId(runId, metadata);
    if (
      registeredExternalWorkflowId
      && stepAwaitingExecution
    ) {
      const approvalStatus = ensureRegisteredExternalApproval({
        runId,
        step,
        metadata,
        workflowId: registeredExternalWorkflowId
      });
      metadata.requires_approval = true;
      if (approvalStatus !== "approved") {
        blockedByApproval = true;
        continue;
      }
    }
    const readOnlyStage = portableExternalReadOnlyStage(runId, metadata);
    if (portableRemoteBusinessMacWorkerRequired(runId, metadata)) {
      // The Zeabur control plane may create the approval, but it must never
      // execute Browser Use. The approved business run is delivered through
      // /api/portable-worker/claim to the authenticated Mac worker only.
      execSql(`UPDATE run_steps SET metadata_json=${sqlValue({
        ...metadata,
        execution_mode: "portable_external_remote_mac_worker_business",
        worker_mode: "waiting_for_mac_worker",
        exact_blocker: null,
        external_action_executed: false
      })} WHERE id=${sqlValue(step.id)};`);
      continue;
    }
    const requires = Boolean(metadata.requires_approval);
    if (requires && !protectedStepsAllowed) {
      blockedByApproval = true;
      continue;
    }
    if (step.status === "waiting_approval" || step.status === "queued") {
      const result = await completeWorkerStep(step, metadata, protectedStepsAllowed || readOnlyStage !== null);
      if (result) {
        registeredExecutionResults.push(result);
      } else {
        const currentRunStatus = querySql<{ status: string }>(`SELECT status FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0]?.status;
        if (currentRunStatus === "blocked") break;
      }
    }
  }
  const blockedRouteRun = querySql<{ status: string }>(`SELECT status FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0]?.status === "blocked";
  if (blockedRouteRun) {
    return summarizeRun(runId);
  }
  const registeredExecutionResult = aggregateRegisteredExecutionResults(registeredExecutionResults);

  const remaining = querySql<{ status: string }>(
    `SELECT status FROM run_steps WHERE run_id=${sqlValue(runId)} AND status NOT IN ('completed', 'skipped')`
  );
  const hasBlockedStep = remaining.some((step) => step.status === "blocked");
  const childCodexStepIds = steps.filter(isChildCodexStep).map((step) => step.id);
  const hasChildCodexStep = childCodexStepIds.length > 0;
  const codexStepIds = steps.filter(isCodexReadonlyStep).map((step) => step.id);
  const hasCodexStep = codexStepIds.length > 0;
  const playwrightStepIds = steps.filter(isPlaywrightStep).map((step) => step.id);
  const hasPlaywrightStep = playwrightStepIds.length > 0;
  const hasDailyAiRegisteredStep = steps.some(isDailyAiRegisteredStep);
  const hasNisenPrintsRegisteredStep = steps.some(isNisenPrintsRegisteredStep);
  const hasRegisteredCodexAutomationStep = steps.some(isRegisteredCodexAutomationStep);
  const hasPromptTransferRegisteredStep = steps.some(isPromptTransferRegisteredStep);
  const hasSnsMultiPosterRegisteredStep = steps.some(isSnsMultiPosterRegisteredStep);
  const hasHumanInputRequiredWithEvidenceStep = steps.some(isHumanInputRequiredWithEvidenceStep);
  const receiptOnlyStepIds = steps.filter(isReceiptOnlyStep).map((step) => step.id);
  const workerMode: WorkerMode = registeredExecutionResult
    ? registeredExecutionResult.workerMode
    : hasDailyAiRegisteredStep
      ? "execute_daily_ai_registered"
      : hasNisenPrintsRegisteredStep
        ? "execute_nisenprints_registered"
        : hasRegisteredCodexAutomationStep
          ? "execute_registered_codex_automation"
          : hasPromptTransferRegisteredStep
            ? "execute_prompt_transfer_registered"
            : hasSnsMultiPosterRegisteredStep
              ? "execute_sns_multi_poster_registered"
              : hasHumanInputRequiredWithEvidenceStep
                ? "human_input_required_with_evidence"
                : hasChildCodexStep
                  ? "execute_child_codex"
                  : hasCodexStep
                    ? "execute_codex"
                    : hasPlaywrightStep
                      ? "execute_playwright"
                      : "receipt_only";
  const workerReceipts = querySql<{ proof_type: string; step_id: string | null; metadata_json: string }>(
    `SELECT proof_type, step_id, metadata_json FROM proofs WHERE run_id=${sqlValue(runId)} AND proof_type='worker_receipt' ORDER BY created_at ASC`
  );
  const nonCodexWorkerReceipts = workerReceipts.filter((proof) => {
    const metadata = parseJson<Record<string, unknown>>(proof.metadata_json, {});
    return metadata.adapter !== "codex_cli" && !isChildCodexMetadata(metadata);
  });
  const hasReceiptOnlyProofInExecutableRun = workerMode !== "receipt_only" && receiptOnlyStepIds.length > 0;
  const derivedStatus = registeredExecutionResult
    ? deriveRegisteredExecutionRunStatus({
        blockedByApproval,
        hasPendingApproval,
        hasBlockedStep,
        remainingSteps: remaining.length,
        registeredStatus: registeredExecutionResult.status
      })
    : deriveRunStatus({
        blockedByApproval,
        hasPendingApproval,
        hasBlockedStep,
        remainingSteps: remaining.length,
        workerMode,
        hasReceiptOnlyProofInExecutableRun
      });
  const baseStatus = derivedStatus === "complete" && hasReceiptOnlyProofInExecutableRun ? "partial" : derivedStatus;
  const codexExecutionProofs = querySql<CodexProofRow>(
    `SELECT run_id, proof_type, step_id, uri, metadata_json FROM proofs WHERE run_id=${sqlValue(runId)} AND proof_type IN ('codex_readonly_execution', 'codex_readonly_blocked') ORDER BY created_at ASC`
  );
  const childCodexExecutionProofs = querySql<ChildCodexProofRow>(
    `SELECT run_id, proof_type, step_id, uri, metadata_json FROM proofs WHERE run_id=${sqlValue(
      runId
    )} AND proof_type IN ('child_codex_result', 'child_codex_blocked', 'parent_only_result') ORDER BY created_at ASC`
  );
  const browserUseExecutionProofs = querySql<CodexProofRow>(
    `SELECT run_id, proof_type, step_id, uri, metadata_json FROM proofs WHERE run_id=${sqlValue(
      runId
    )} AND proof_type IN ('browser_use_check', 'browser_use_blocked', 'playwright_check', 'playwright_blocked') ORDER BY created_at ASC`
  );
  const childRuns = querySql<ChildRunRow>(
    `SELECT id, step_id, role, status, exit_status, result_uri FROM child_runs WHERE parent_run_id=${sqlValue(runId)} ORDER BY created_at ASC`
  );
  const runMetadata = getRunMetadata(runId);
  // Reference readback is a bounded, no-effect verification stage.  It may
  // carry the workflow's normal run contract for provenance, but it must not
  // be downgraded to partial merely because publish/commerce business proofs
  // are intentionally absent from this stage.  Business contracts remain
  // enforced for candidate/effect stages.
  const runContract = getRunContractForProofEvaluation(runId, runMetadata);
  const contractProofGate = runContract ? evaluateStoredContractProofGate(runId, runContract) : undefined;
  const executableProofGate = evaluateExecutableWorkerProofGate({
    status: baseStatus,
    workerMode,
    codexExecutionProofs,
    codexStepIds,
    childCodexExecutionProofs,
    childRuns,
    childCodexStepIds,
    browserUseExecutionProofs: workerMode === "execute_playwright" || workerMode === "execute_browser_use" ? browserUseExecutionProofs : [],
    browserUseStepIds: workerMode === "execute_playwright" || workerMode === "execute_browser_use" ? playwrightStepIds : [],
    workerReceipts: nonCodexWorkerReceipts.map((proof) => proof.proof_type),
    receiptOnlyStepIds
  });
  const registeredProofGate = registeredExecutionResult?.proof_gate;
  const coercedRegisteredProofGate = registeredExecutionResult ? coerceProofGate(registeredProofGate) : undefined;
  const storedRegisteredProofGate = registeredExecutionResult ? undefined : storedRegisteredProofGateForSteps(steps);
  const storedIssueLedgerMetadata = registeredExecutionResult ? {} : issueLedgerMetadataFromSteps(steps);
  const effectiveRegisteredProofGate = coercedRegisteredProofGate ?? storedRegisteredProofGate;
  const proofGate = mergeProofGates(effectiveRegisteredProofGate ?? contractProofGate, executableProofGate);
  const status = deriveFinalRunStatus({
    baseStatus,
    contractProofGate,
    executableProofGate,
    registeredProofGate: effectiveRegisteredProofGate
  });
  const preserveMacWorkerQueue = runMetadata.worker_protocol === "mac_worker_polling_required"
    && runMetadata.worker_mode === "queued_for_mac_worker";
  updateRunStatus(runId, status, {
    worker_protocol: preserveMacWorkerQueue ? "mac_worker_polling_required" : "local_worker_v1",
    worker_mode: preserveMacWorkerQueue ? "queued_for_mac_worker" : workerMode,
    active_step_id: null,
    active_adapter: null,
    ...storedIssueLedgerMetadata,
    ...(registeredExecutionResult?.metadata ?? {}),
    proof_gate: proofGate,
    proof_summary: summarizeWorkerProofGate({
      status,
      workerMode,
      proofGate,
      registeredExecutionResult,
      hasReceiptOnlyProofInExecutableRun
    })
  });
  return summarizeRun(runId);
}

export function approvalsAllowProtectedSteps(approvals: Array<{ status: string }>): boolean {
  return approvals.length > 0 && approvals.every((approval) => approval.status === "approved");
}

export function deriveRunStatus(input: {
  blockedByApproval: boolean;
  hasPendingApproval: boolean;
  hasBlockedStep?: boolean;
  hasReceiptOnlyProofInExecutableRun?: boolean;
  remainingSteps: number;
  workerMode: WorkerMode;
}): "waiting_approval" | "running" | "blocked" | "complete" | "partial" {
  if (input.blockedByApproval || (input.hasPendingApproval && input.remainingSteps > 0)) return "waiting_approval";
  if (input.hasBlockedStep) return "blocked";
  if (input.remainingSteps > 0) return "running";
  if (input.workerMode !== "receipt_only" && input.hasReceiptOnlyProofInExecutableRun) {
    return "partial";
  }
  return input.workerMode === "receipt_only" ? "partial" : "complete";
}

function evaluateExecutableWorkerProofGate(input: {
  status: "waiting_approval" | "running" | "blocked" | "complete" | "partial";
  workerMode: WorkerMode;
  codexExecutionProofs: CodexProofRow[];
  codexStepIds: string[];
  childCodexExecutionProofs: ChildCodexProofRow[];
  childRuns: ChildRunRow[];
  childCodexStepIds: string[];
  browserUseExecutionProofs: CodexProofRow[];
  browserUseStepIds: string[];
  workerReceipts: string[];
  receiptOnlyStepIds: string[];
}) {
  const codexProofGate = evaluateCodexReadonlyResultProofs(input.codexExecutionProofs, input.childRuns);
  const childProofGate = evaluateChildCodexResultProofs(input.childCodexExecutionProofs, input.childRuns);
  const browserUseProofGate = evaluateBrowserUseResultProofs(input.browserUseExecutionProofs);
  const present = [...codexProofGate.present, ...childProofGate.present, ...browserUseProofGate.present, ...input.workerReceipts];
  const missing = [
    ...(input.codexStepIds.length > 0
      ? input.codexStepIds
          .filter((stepId) => !codexProofGate.validResultStepIds.has(stepId))
          .map((stepId) => codexProofGate.invalidResultReasons.get(stepId) ?? `codex_readonly_execution:${stepId}`)
      : []),
    ...(input.childCodexStepIds.length > 0
      ? input.childCodexStepIds
          .filter((stepId) => !childProofGate.validResultStepIds.has(stepId))
          .map((stepId) => childProofGate.invalidResultReasons.get(stepId) ?? `child_codex_result:${stepId}`)
      : []),
    ...(input.browserUseStepIds.length > 0
      ? input.browserUseStepIds
          .filter((stepId) => !browserUseProofGate.validResultStepIds.has(stepId))
          .map((stepId) => browserUseProofGate.invalidResultReasons.get(stepId) ?? `playwright_check:${stepId}`)
      : []),
    ...input.receiptOnlyStepIds.map((stepId) => `actual_execution_or_manual_verification:${stepId}`),
    ...(input.status === "running" ? ["unfinished_steps"] : [])
  ];
  return {
    ok: input.status === "complete" && missing.length === 0,
    missing: [...new Set(missing)],
    present
  };
}

function evaluateBrowserUseResultProofs(proofs: CodexProofRow[]) {
  const validResultStepIds = new Set<string>();
  const invalidResultReasons = new Map<string, string>();
  const present: string[] = [];
  const validResultTypes = new Set<string>();

  for (const proof of proofs) {
    const stepId = typeof proof.step_id === "string" && proof.step_id.length > 0 ? proof.step_id : undefined;
    if (proof.proof_type === "browser_use_blocked" || proof.proof_type === "playwright_blocked") {
      const blockedType = proof.proof_type;
      present.push(blockedType);
      if (stepId) present.push(`${blockedType}:${stepId}`);
      continue;
    }
    if ((proof.proof_type !== "browser_use_check" && proof.proof_type !== "playwright_check") || !stepId) continue;
    const artifactCheck = validateBrowserUseResultArtifact({ uri: proof.uri, runId: proof.run_id, stepId });
    if (!artifactCheck.ok) {
      invalidResultReasons.set(stepId, `${proof.proof_type}_artifact_${artifactCheck.reason}:${stepId}`);
      continue;
    }
    validResultTypes.add(proof.proof_type);
    present.push(`${proof.proof_type}:${stepId}`);
    if (proof.proof_type === "browser_use_check" || proof.proof_type === "playwright_check") {
      validResultStepIds.add(stepId);
    }
  }

  return {
    validResultStepIds,
    invalidResultReasons,
    present: uniqueStrings([...validResultTypes, ...present])
  };
}

function evaluateCodexReadonlyResultProofs(proofs: CodexProofRow[], childRuns: ChildRunRow[]) {
  const childRunById = new Map(childRuns.map((childRun) => [childRun.id, childRun]));
  const validResultStepIds = new Set<string>();
  const invalidResultReasons = new Map<string, string>();
  const present: string[] = [];
  let hasValidResult = false;

  for (const proof of proofs) {
    const stepId = typeof proof.step_id === "string" && proof.step_id.length > 0 ? proof.step_id : undefined;
    if (proof.proof_type === "codex_readonly_blocked") {
      present.push("codex_readonly_blocked");
      if (stepId) present.push(`codex_readonly_blocked:${stepId}`);
      continue;
    }
    if (proof.proof_type !== "codex_readonly_execution" || !stepId) continue;
    const metadata = parseJson<Record<string, unknown>>(proof.metadata_json, {});
    const childRunId = typeof metadata.child_run_id === "string" && metadata.child_run_id.length > 0 ? metadata.child_run_id : undefined;
    if (!childRunId) {
      invalidResultReasons.set(stepId, `codex_readonly_child_run_id_missing:${stepId}`);
      continue;
    }
    const childRun = childRunById.get(childRunId);
    if (childRun?.status !== "completed" || childRun.role !== "codex_cli" || childRun.exit_status !== 0 || childRun.step_id !== stepId) {
      invalidResultReasons.set(stepId, `codex_readonly_child_run_incomplete_or_mismatch:${stepId}`);
      continue;
    }
    if (childRun.result_uri !== proof.uri) {
      invalidResultReasons.set(stepId, `codex_readonly_result_uri_mismatch:${stepId}`);
      continue;
    }
    const artifactCheck = validateCodexReadonlyResultArtifact({ uri: proof.uri, runId: proof.run_id, stepId });
    if (!artifactCheck.ok) {
      invalidResultReasons.set(stepId, `codex_readonly_result_artifact_${artifactCheck.reason}:${stepId}`);
      continue;
    }
    validResultStepIds.add(stepId);
    hasValidResult = true;
    present.push(`codex_readonly_execution:${stepId}`);
  }

  return {
    validResultStepIds,
    invalidResultReasons,
    present: uniqueStrings([...(hasValidResult ? ["codex_readonly_execution"] : []), ...present])
  };
}

function evaluateChildCodexResultProofs(proofs: ChildCodexProofRow[], childRuns: ChildRunRow[]) {
  const childRunById = new Map(childRuns.map((childRun) => [childRun.id, childRun]));
  const validResultStepIds = new Set<string>();
  const invalidResultReasons = new Map<string, string>();
  const present: string[] = [];
  let hasChildCodexResult = false;
  let hasParentOnlyResult = false;

  for (const proof of proofs) {
    if (proof.proof_type === "child_codex_blocked") {
      present.push("child_codex_blocked");
      const stepId = typeof proof.step_id === "string" && proof.step_id.length > 0 ? proof.step_id : undefined;
      if (stepId) present.push(`child_codex_blocked:${stepId}`);
      continue;
    }
    if (proof.proof_type === "parent_only_result") {
      const stepId = typeof proof.step_id === "string" && proof.step_id.length > 0 ? proof.step_id : undefined;
      if (!stepId) continue;
      const artifactCheck = validateParentOnlyResultArtifact({ uri: proof.uri, runId: proof.run_id, stepId });
      if (!artifactCheck.ok) {
        invalidResultReasons.set(stepId, `parent_only_result_artifact_${artifactCheck.reason}:${stepId}`);
        continue;
      }
      validResultStepIds.add(stepId);
      hasParentOnlyResult = true;
      present.push(`parent_only_result:${stepId}`);
      continue;
    }
    if (proof.proof_type !== "child_codex_result") continue;
    const stepId = typeof proof.step_id === "string" && proof.step_id.length > 0 ? proof.step_id : undefined;
    if (!stepId) continue;
    const metadata = parseJson<Record<string, unknown>>(proof.metadata_json, {});
    const childRunId = typeof metadata.child_run_id === "string" && metadata.child_run_id.length > 0 ? metadata.child_run_id : undefined;
    if (!childRunId) {
      invalidResultReasons.set(stepId, `child_codex_child_run_id_missing:${stepId}`);
      continue;
    }
    const childRun = childRunId ? childRunById.get(childRunId) : undefined;
    if (childRun?.status !== "completed" || childRun.role !== "child_codex" || childRun.exit_status !== 0 || childRun.step_id !== stepId) {
      invalidResultReasons.set(stepId, `child_codex_child_run_incomplete_or_mismatch:${stepId}`);
      continue;
    }
    if (childRun.result_uri !== proof.uri) {
      invalidResultReasons.set(stepId, `child_codex_result_uri_mismatch:${stepId}`);
      continue;
    }
    const artifactCheck = validateChildCodexResultArtifact({ uri: proof.uri, runId: proof.run_id, stepId, childRunId });
    if (!artifactCheck.ok) {
      invalidResultReasons.set(stepId, `child_codex_result_artifact_${artifactCheck.reason}:${stepId}`);
      continue;
    }
    validResultStepIds.add(stepId);
    hasChildCodexResult = true;
    present.push(`child_codex_result:${stepId}`);
  }

  return {
    validResultStepIds,
    invalidResultReasons,
    present: uniqueStrings([...(hasChildCodexResult ? ["child_codex_result"] : []), ...(hasParentOnlyResult ? ["parent_only_result"] : []), ...present])
  };
}

function validateCodexReadonlyResultArtifact(input: {
  uri: string;
  runId: string;
  stepId: string;
}): { ok: true } | { ok: false; reason: "missing" | "invalid" } {
  try {
    if (!input.uri.startsWith("file://")) return { ok: false, reason: "invalid" };
    if (!existsSync(new URL(input.uri))) return { ok: false, reason: "missing" };
    const artifact = parseJson<Record<string, unknown>>(readFileSync(new URL(input.uri), "utf8"), {});
    const ok =
      artifact.runId === input.runId &&
      artifact.stepId === input.stepId &&
      artifact.mode === "execute_codex_readonly" &&
      artifact.exitStatus === 0;
    return ok ? { ok: true } : { ok: false, reason: "invalid" };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

function validateChildCodexResultArtifact(input: {
  uri: string;
  runId: string;
  stepId: string;
  childRunId: string;
}): { ok: true } | { ok: false; reason: "missing" | "invalid" } {
  try {
    if (!input.uri.startsWith("file://")) return { ok: false, reason: "invalid" };
    if (!existsSync(new URL(input.uri))) return { ok: false, reason: "missing" };
    const artifact = parseJson<Record<string, unknown>>(readFileSync(new URL(input.uri), "utf8"), {});
    const ok =
      artifact.runId === input.runId &&
      artifact.stepId === input.stepId &&
      artifact.childRunId === input.childRunId &&
      artifact.mode === "child_codex" &&
      artifact.exitStatus === 0;
    return ok ? { ok: true } : { ok: false, reason: "invalid" };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

function validateParentOnlyResultArtifact(input: {
  uri: string;
  runId: string;
  stepId: string;
}): { ok: true } | { ok: false; reason: "missing" | "invalid" } {
  try {
    if (!input.uri.startsWith("file://")) return { ok: false, reason: "invalid" };
    if (!existsSync(new URL(input.uri))) return { ok: false, reason: "missing" };
    const artifact = parseJson<Record<string, unknown>>(readFileSync(new URL(input.uri), "utf8"), {});
    const ok =
      artifact.runId === input.runId &&
      artifact.stepId === input.stepId &&
      artifact.mode === "parent_only" &&
      artifact.exitStatus === 0;
    return ok ? { ok: true } : { ok: false, reason: "invalid" };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

function validateBrowserUseResultArtifact(input: {
  uri: string;
  runId: string;
  stepId: string;
}): { ok: true } | { ok: false; reason: "missing" | "invalid" } {
  try {
    if (!input.uri.startsWith("file://")) return { ok: false, reason: "invalid" };
    if (!existsSync(new URL(input.uri))) return { ok: false, reason: "missing" };
    const artifact = parseJson<Record<string, unknown>>(readFileSync(new URL(input.uri), "utf8"), {});
    if (artifact.mode === "playwright_cli") {
      const playwrightCheck = artifact.playwrightCheck && typeof artifact.playwrightCheck === "object" ? (artifact.playwrightCheck as Record<string, unknown>) : {};
      const metadata = playwrightCheck.metadata && typeof playwrightCheck.metadata === "object" ? (playwrightCheck.metadata as Record<string, unknown>) : {};
      const missingArtifacts = Array.isArray(metadata.missingArtifacts) ? metadata.missingArtifacts : [];
      const artifactTargetUrl = normalizeLocalTargetUrl(artifact.targetUrl);
      const playwrightTargetUrl = normalizeLocalTargetUrl(playwrightCheck.targetUrl);
      const consolePath = normalizeArtifactPath(playwrightCheck.consolePath);
      const ok =
        artifact.runId === input.runId &&
        artifact.stepId === input.stepId &&
        artifact.status === "ok" &&
        playwrightCheck.status === "ok" &&
        Boolean(artifactTargetUrl && playwrightTargetUrl && artifactTargetUrl === playwrightTargetUrl) &&
        existsNonEmptyArtifact(playwrightCheck.screenshotPath) &&
        existsNonEmptyArtifact(playwrightCheck.domPath) &&
        existsArtifact(consolePath) &&
        countConsoleErrors(consolePath) === 0 &&
        missingArtifacts.length === 0;
      return ok ? { ok: true } : { ok: false, reason: "invalid" };
    }
    const browserUseCheck = artifact.browserUseCheck && typeof artifact.browserUseCheck === "object" ? (artifact.browserUseCheck as Record<string, unknown>) : {};
    const metadata = browserUseCheck.metadata && typeof browserUseCheck.metadata === "object" ? (browserUseCheck.metadata as Record<string, unknown>) : {};
    const recordingQa = metadata.recordingQa && typeof metadata.recordingQa === "object" ? (metadata.recordingQa as Record<string, unknown>) : {};
    const geminiVideoQa = metadata.geminiVideoQa && typeof metadata.geminiVideoQa === "object" ? (metadata.geminiVideoQa as Record<string, unknown>) : {};
    const recordingSidecar = metadata.recordingSidecar && typeof metadata.recordingSidecar === "object" ? (metadata.recordingSidecar as Record<string, unknown>) : {};
    const recordingPath = normalizeArtifactPath(metadata.recordingPath) ?? normalizeArtifactPath(recordingQa.plannedVideoPath) ?? normalizeArtifactPath(recordingQa.videoArtifactUri);
    const geminiQaPath = normalizeArtifactPath(metadata.geminiQaPath) ?? normalizeArtifactPath(geminiVideoQa.artifactUri) ?? normalizeArtifactPath(recordingQa.artifactUri);
    const manifestPath = normalizeArtifactPath(recordingQa.manifestPath);
    const recordingFileOk = recordingPath ? existsNonEmptyFile(recordingPath) : false;
    const geminiQaFileOk = recordingPath && geminiQaPath ? validateGeminiVideoQaFile(geminiQaPath, recordingPath).ok : false;
    const manifestOk =
      manifestPath && recordingPath && geminiQaPath
        ? validateBrowserUseRecordingQaManifest({ manifestPath, recordingQa, recordingPath, geminiQaPath }).ok
        : false;
    const targetUrlOk =
      manifestPath && geminiQaPath
        ? validateBrowserUseTargetUrlBinding({ artifact, browserUseCheck, manifestPath, geminiQaPath }).ok
        : false;
    const ok =
      artifact.runId === input.runId &&
      artifact.stepId === input.stepId &&
      artifact.mode === "browser_use_cli" &&
      artifact.status === "ok" &&
      browserUseCheck.status === "ok" &&
      recordingQa.status === "present" &&
      !recordingQa.reason &&
      geminiVideoQa.status === "present" &&
      recordingSidecar.attempted === true &&
      recordingSidecar.status === "ok" &&
      recordingFileOk &&
      geminiQaFileOk &&
      manifestOk &&
      targetUrlOk;
    return ok ? { ok: true } : { ok: false, reason: "invalid" };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

function validateBrowserUseTargetUrlBinding(input: {
  artifact: Record<string, unknown>;
  browserUseCheck: Record<string, unknown>;
  manifestPath: string;
  geminiQaPath: string;
}): { ok: true } | { ok: false } {
  try {
    const manifest = parseJson<Record<string, unknown>>(readFileSync(input.manifestPath, "utf8"), {});
    const sidecar = manifest.recordingSidecar && typeof manifest.recordingSidecar === "object" ? (manifest.recordingSidecar as Record<string, unknown>) : {};
    const geminiQa = parseJson<Record<string, unknown>>(readFileSync(input.geminiQaPath, "utf8"), {});
    const values = [
      input.artifact.targetUrl,
      input.browserUseCheck.targetUrl,
      manifest.targetUrl,
      sidecar.targetPageUrl ?? sidecar.targetUrl,
      geminiQa.target_url ?? geminiQa.targetUrl
    ];
    const normalized = values.map((value) => normalizeLocalTargetUrl(value));
    if (normalized.some((value) => !value)) return { ok: false };
    return new Set(normalized).size === 1 ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function validateBrowserUseRecordingQaManifest(input: {
  manifestPath: string;
  recordingQa: Record<string, unknown>;
  recordingPath: string;
  geminiQaPath: string;
}): { ok: true } | { ok: false } {
  if (!existsNonEmptyFile(input.manifestPath)) return { ok: false };
  try {
    const manifest = parseJson<Record<string, unknown>>(readFileSync(input.manifestPath, "utf8"), {});
    const manifestRecordingQa =
      manifest.recordingQa && typeof manifest.recordingQa === "object" ? (manifest.recordingQa as Record<string, unknown>) : {};
    const artifactUri = normalizeArtifactPath(input.recordingQa.artifactUri);
    const videoArtifactUri = normalizeArtifactPath(input.recordingQa.videoArtifactUri);
    const manifestArtifactUri = normalizeArtifactPath(manifestRecordingQa.artifactUri);
    const manifestVideoArtifactUri = normalizeArtifactPath(manifestRecordingQa.videoArtifactUri);
    const manifestPath = normalizeArtifactPath(manifestRecordingQa.manifestPath);
    const expectedManifestPath = normalizeArtifactPath(input.recordingQa.manifestPath);
    const recordingQaMatchesManifest =
      manifestRecordingQa.status === input.recordingQa.status &&
      (manifestRecordingQa.reason ?? null) === (input.recordingQa.reason ?? null) &&
      manifestArtifactUri === artifactUri &&
      manifestVideoArtifactUri === videoArtifactUri;
    return recordingQaMatchesManifest &&
      input.recordingQa.status === "present" &&
      !input.recordingQa.reason &&
      artifactUri === input.geminiQaPath &&
      videoArtifactUri === input.recordingPath &&
      manifestPath === expectedManifestPath &&
      manifestPath === input.manifestPath &&
      existsNonEmptyFile(input.recordingPath) &&
      validateGeminiVideoQaFile(input.geminiQaPath, input.recordingPath).ok
      ? { ok: true }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

function validateGeminiVideoQaFile(path: string, recordingPath: string): { ok: true } | { ok: false } {
  if (!existsNonEmptyFile(path)) return { ok: false };
  try {
    const qa = parseJson<Record<string, unknown>>(readFileSync(path, "utf8"), {});
    return looksLikeGeminiQa(qa) && qaMatchesVideo(qa, recordingPath) && qaPassesCompletionGate(qa) ? { ok: true } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function existsNonEmptyFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile() && statSync(path).size > 0;
  } catch {
    return false;
  }
}

function existsArtifact(value: unknown): boolean {
  const path = normalizeArtifactPath(value);
  return Boolean(path && existsSync(path));
}

function existsNonEmptyArtifact(value: unknown): boolean {
  const path = normalizeArtifactPath(value);
  return Boolean(path && existsNonEmptyFile(path));
}

function looksLikeGeminiQa(record: Record<string, unknown>): boolean {
  return ["provider", "model", "kind", "type", "driver", "auditor"]
    .map((key) => String(record[key] ?? "").toLowerCase())
    .some((value) => value.includes("gemini") || value.includes("video_qa") || value.includes("video qa"));
}

function qaMatchesVideo(record: Record<string, unknown>, recordingPath: string): boolean {
  const expected = normalizeArtifactPath(recordingPath);
  const candidates = ["video_artifact_uri", "videoArtifactUri", "video_uri", "videoUri", "recording_uri", "recordingPath", "video_path", "videoPath"]
    .map((key) => normalizeArtifactPath(record[key]))
    .filter((value): value is string => Boolean(value));
  return Boolean(expected && candidates.includes(expected));
}

function normalizeLocalTargetUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1" && host !== "[::1]") return null;
    const normalizedHost = host === "localhost" ? "127.0.0.1" : host === "::1" ? "[::1]" : host;
    return `${url.protocol}//${normalizedHost}${url.port ? `:${url.port}` : ""}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function qaPassesCompletionGate(record: Record<string, unknown>): boolean {
  if (record.completion_gate_matches === false || record.completionGateMatches === false) return false;
  if (stringFieldIsBad(record.status) || stringFieldIsBad(record.verdict) || stringFieldIsBad(record.completion_gate_alignment)) return false;
  if (typeof record.exact_blocker === "string" && record.exact_blocker.trim()) return false;
  return (
    stringFieldIsGood(record.status) ||
    stringFieldIsGood(record.verdict) ||
    stringFieldIsGood(record.completion_gate_alignment) ||
    record.completion_gate_matches === true ||
    record.completionGateMatches === true
  );
}

function stringFieldIsBad(value: unknown): boolean {
  return typeof value === "string" && /fail|failed|blocked|mismatch|conflict|veto|reject|error/.test(value.toLowerCase());
}

function stringFieldIsGood(value: unknown): boolean {
  return typeof value === "string" && /^(ok|pass|passed|success|aligned|match|matched)$/i.test(value.trim());
}

function normalizeArtifactPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const trimmed = value.trim();
    return resolve(trimmed.startsWith("file://") ? fileURLToPath(trimmed) : trimmed);
  } catch {
    return null;
  }
}

function isChildCodexStep(step: Pick<StepRow, "metadata_json">): boolean {
  return isChildCodexMetadata(parseJson<Record<string, unknown>>(step.metadata_json, {}));
}

function isCodexReadonlyStep(step: Pick<StepRow, "metadata_json">): boolean {
  const metadata = parseJson<Record<string, unknown>>(step.metadata_json, {});
  return metadata.adapter === "codex_cli" || metadata.execution_mode === "execute_codex_readonly";
}

function isPlaywrightStep(step: Pick<StepRow, "metadata_json">): boolean {
  const metadata = parseJson<Record<string, unknown>>(step.metadata_json, {});
  return (
    metadata.adapter === "playwright_cli" ||
    metadata.execution_mode === "playwright_cli" ||
    metadata.execution_mode === "execute_playwright" ||
    metadata.adapter === "browser_use_cli" ||
    metadata.execution_mode === "browser_use_cli" ||
    metadata.execution_mode === "execute_browser_use"
  );
}

function isNisenPrintsRegisteredStep(step: Pick<StepRow, "metadata_json">): boolean {
  const metadata = parseJson<Record<string, unknown>>(step.metadata_json, {});
  return metadata.adapter === "nisenprints_registered" || metadata.execution_mode === "execute_nisenprints_registered";
}

function isDailyAiRegisteredStep(step: Pick<StepRow, "metadata_json">): boolean {
  const metadata = parseJson<Record<string, unknown>>(step.metadata_json, {});
  return metadata.adapter === "daily_ai_registered" || metadata.execution_mode === "execute_daily_ai_registered";
}

function isRegisteredCodexAutomationStep(step: Pick<StepRow, "metadata_json">): boolean {
  const metadata = parseJson<Record<string, unknown>>(step.metadata_json, {});
  return (
    metadata.adapter === "job_submit_registered" ||
    metadata.adapter === "job_followup_registered" ||
    metadata.execution_mode === "execute_registered_codex_automation" ||
    metadata.execution_mode === "execute_job_submit_registered" ||
    metadata.execution_mode === "execute_job_followup_registered"
  );
}

function isPromptTransferRegisteredStep(step: Pick<StepRow, "metadata_json">): boolean {
  const metadata = parseJson<Record<string, unknown>>(step.metadata_json, {});
  return metadata.adapter === "prompt_transfer_registered" || metadata.execution_mode === "execute_prompt_transfer_registered";
}

function isSnsMultiPosterRegisteredStep(step: Pick<StepRow, "metadata_json">): boolean {
  const metadata = parseJson<Record<string, unknown>>(step.metadata_json, {});
  return metadata.adapter === "sns_multi_poster_registered" || metadata.execution_mode === "execute_sns_multi_poster_registered";
}

function isHumanInputRequiredWithEvidenceStep(step: Pick<StepRow, "metadata_json">): boolean {
  const metadata = parseJson<Record<string, unknown>>(step.metadata_json, {});
  return (
    isHumanInputRequiredWithEvidenceAdapter(metadata.adapter) ||
    metadata.execution_mode === legacyProofOnlyExternalWriteBoundaryMode() ||
    metadata.execution_mode === "human_input_required_with_evidence" ||
    metadata.execution_mode === "execute_fail_closed_registered_workflow"
  );
}

function isHumanInputRequiredWithEvidenceAdapter(
  value: unknown
): value is Extract<WorkerAdapter, "x_authenticated_browser_lane_registered"> {
  return value === "x_authenticated_browser_lane_registered";
}

function humanInputRequiredWithEvidenceWorkflowId(
  adapter: Extract<WorkerAdapter, "x_authenticated_browser_lane_registered">
): string {
  const map = {
    x_authenticated_browser_lane_registered: "x-authenticated-browser-lane"
  } as const;
  return map[adapter];
}

function runnerSafetyMetadata(kind: "billing_only") {
  return {
    version: "runner_safety_contract_v1",
    kind: "billing_only_external_action_policy",
    publicKind: kind === "billing_only" ? "billing_only_hard_stop" : kind,
    publicLabel: "課金停止",
    external_action_policy: "billing_only_hard_stop",
    external_action_boundary: "billing_purchase_payment_checkout_hard_stop",
    externalActionBoundary: "billing_purchase_payment_checkout_hard_stop",
    default_hard_stops: ["billing", "purchase", "payment", "checkout"],
    defaultHardStops: ["billing", "purchase", "payment", "checkout"],
    human_input_required_with_evidence: ["captcha", "otp", "security_code", "identity_verification"],
    humanInputRequiredWithEvidence: ["captcha", "otp", "security_code", "identity_verification"],
    approved_external_actions: ["post", "save", "send", "submit", "publish"],
    approvedExternalActions: ["post", "save", "send", "submit", "publish"],
    external_action_executed: false,
    externalActionExecutedByRehearsal: false
  };
}

function registeredRunnerSafetyMetadataForAdapter(adapter: WorkerAdapter) {
  if (
    adapter === "daily_ai_registered" ||
    adapter === "nisenprints_registered" ||
    adapter === "job_submit_registered" ||
    adapter === "job_followup_registered" ||
    adapter === "prompt_transfer_registered"
  ) {
    return runnerSafetyMetadata("billing_only");
  }
  if (adapter === "sns_multi_poster_registered" || isHumanInputRequiredWithEvidenceAdapter(adapter)) {
    return runnerSafetyMetadata("billing_only");
  }
  return undefined;
}

function humanInputRequiredWithEvidenceRunner(input: {
  adapter: Extract<WorkerAdapter, "x_authenticated_browser_lane_registered">;
  runId: string;
  stepId: string;
  command: WorkerCommandSpec;
  createdAt: string;
}) {
  const workflowId = humanInputRequiredWithEvidenceWorkflowId(input.adapter);
  const exactBlocker = "x_authenticated_browser_lane_human_input_required_with_evidence";
  const proofType = `${input.adapter}_blocked`;
  const proof_gate = {
    ok: false,
    missing: [exactBlocker],
    present: [`${input.adapter}:human_input_required_with_evidence`, proofType]
  };
  const artifact = writeNamedWorkerArtifact(input.runId, `${input.stepId}-${input.adapter}-blocked.json`, {
    runId: input.runId,
    stepId: input.stepId,
    workflowId,
    adapter: input.adapter,
    command: input.command,
    commandDisplay: input.command.display,
    mode: "human_input_required_with_evidence",
    status: "blocked",
    exactBlocker,
    dryRun: true,
    externalActionExecuted: false,
    runnerSafety: runnerSafetyMetadata("billing_only"),
    approvalBoundary: "billing_purchase_payment_checkout_hard_stop",
    completionBoundary: "approved_x_action_or_callable_surface_human_input_evidence",
    hardStops: ["billing", "purchase", "payment", "checkout"],
    humanInputRequiredWithEvidence: ["captcha", "otp", "security_code", "identity_verification", "auth_callable_surface"],
    createdAt: input.createdAt
  });
  return {
    workflowId,
    exactBlocker,
    proofType,
    label: `${workflowId} blocked`,
    artifact,
    proof_gate,
    proof_summary: `blocked: ${exactBlocker}`,
    metadata: {
      adapter: input.adapter,
      workflow_id: workflowId,
      execution_mode: "human_input_required_with_evidence",
      exact_blocker: exactBlocker,
      approval_boundary: "billing_purchase_payment_checkout_hard_stop",
      completion_boundary: "approved_x_action_or_callable_surface_human_input_evidence",
      dry_run: true,
      external_action_executed: false,
      hard_stops: ["billing", "purchase", "payment", "checkout"],
      human_input_required_with_evidence: ["captcha", "otp", "security_code", "identity_verification", "auth_callable_surface"],
      runner_safety: runnerSafetyMetadata("billing_only"),
      proof_gate,
      artifact_uri: artifact.uri
    }
  };
}

function isReceiptOnlyStep(step: Pick<StepRow, "metadata_json">): boolean {
  const metadata = parseJson<Record<string, unknown>>(step.metadata_json, {});
  return metadata.execution_mode === "receipt_only" || metadata.receipt_only === true;
}

function isChildCodexMetadata(metadata: Record<string, unknown>): boolean {
  if (metadata.adapter === "codex_cli" || metadata.execution_mode === "execute_codex_readonly") return false;
  return (
    metadata.adapter === "child_codex" ||
    metadata.execution_mode === "child_codex" ||
    (typeof metadata.child_run_id === "string" && metadata.child_run_id.length > 0)
  );
}

function deriveFinalRunStatus(input: {
  baseStatus: "waiting_approval" | "running" | "blocked" | "complete" | "partial";
  contractProofGate?: ProofEvaluation;
  executableProofGate: ProofEvaluation;
  registeredProofGate?: ProofEvaluation;
}): "waiting_approval" | "running" | "blocked" | "complete" | "partial" {
  if (input.baseStatus === "waiting_approval" || input.baseStatus === "running" || input.baseStatus === "blocked") {
    return input.baseStatus;
  }
  if (input.baseStatus !== "complete") return input.baseStatus;
  if (input.contractProofGate && !input.contractProofGate.ok) return "partial";
  if (input.registeredProofGate && !input.registeredProofGate.ok) return "partial";
  if (!input.executableProofGate.ok) return "partial";
  return "complete";
}

function mergeProofGates(...gates: Array<ProofEvaluation | undefined>): ProofEvaluation {
  const effectiveGates = gates.filter((gate): gate is ProofEvaluation => Boolean(gate));
  if (effectiveGates.length === 0) return { ok: true, missing: [], present: [] };
  return {
    ok: effectiveGates.every((gate) => gate.ok),
    missing: uniqueStrings(effectiveGates.flatMap((gate) => gate.missing)),
    present: uniqueStrings(effectiveGates.flatMap((gate) => gate.present))
  };
}

function coerceProofGate(value: unknown): ProofEvaluation | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return {
    ok: Boolean((value as Record<string, unknown>).ok),
    missing: proofGateList(value, "missing"),
    present: proofGateList(value, "present")
  };
}

function storedRegisteredProofGateForSteps(steps: StepRow[]): ProofEvaluation | undefined {
  const gates = steps
    .map((step) => parseJson<Record<string, unknown>>(step.metadata_json, {}))
    .filter(
      (metadata) =>
        metadata.adapter === "nisenprints_registered" ||
        metadata.adapter === "daily_ai_registered" ||
        metadata.adapter === "job_submit_registered" ||
        metadata.adapter === "job_followup_registered" ||
        metadata.execution_mode === "execute_registered_codex_automation" ||
        metadata.adapter === "prompt_transfer_registered" ||
        metadata.execution_mode === "execute_prompt_transfer_registered" ||
        metadata.adapter === "sns_multi_poster_registered" ||
        metadata.execution_mode === "execute_sns_multi_poster_registered" ||
        isHumanInputRequiredWithEvidenceAdapter(metadata.adapter)
    )
    .map((metadata) => coerceProofGate(metadata.proof_gate))
    .filter((gate): gate is ProofEvaluation => Boolean(gate));
  if (gates.length === 0) return undefined;
  return mergeProofGates(...gates);
}

function issueLedgerMetadataFromSteps(steps: StepRow[]): Record<string, unknown> {
  const summaries = steps
    .map((step) => parseJson<Record<string, unknown>>(step.metadata_json, {}))
    .map((metadata) => metadata.issue_ledger_summary)
    .filter((summary): summary is Record<string, unknown> => typeof summary === "object" && summary !== null && !Array.isArray(summary));
  const latest = summaries[summaries.length - 1];
  return latest ? { issue_ledger_summary: latest } : {};
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function summarizeWorkerProofGate(input: {
  status: "waiting_approval" | "running" | "blocked" | "complete" | "partial";
  workerMode: WorkerMode;
  proofGate: ProofEvaluation;
  registeredExecutionResult?: RegisteredExecutionResult;
  hasReceiptOnlyProofInExecutableRun: boolean;
}): string {
  if (input.proofGate.missing.length > 0) return summarizeProofGate(input.proofGate);
  if (input.registeredExecutionResult) return input.registeredExecutionResult.proof_summary;
  if (input.workerMode === "receipt_only") return "partial: worker receipts captured, actual execution is not verified";
  if (input.status === "complete") return "complete: executable worker finished";
  if (input.status === "blocked") return "blocked: codex read-only execution did not complete";
  if (input.hasReceiptOnlyProofInExecutableRun) {
    return "partial: executable Codex proof captured, but receipt-only worker steps still need actual execution or manual verification";
  }
  return "partial: unfinished steps remain";
}

function proofGateList(value: unknown, key: "present" | "missing"): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const raw = (value as Record<string, unknown>)[key];
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

function aggregateRegisteredExecutionResults(results: RegisteredExecutionResult[]): RegisteredExecutionResult | undefined {
  if (results.length === 0) return undefined;
  if (results.length === 1) return results[0];
  const proof_gate = mergeProofGates(...results.map((result) => coerceProofGate(result.proof_gate)));
  const status: RegisteredExecutionResult["status"] = results.some((result) => result.status === "blocked")
    ? "blocked"
    : results.some((result) => result.status === "partial")
      ? "partial"
      : "complete";
  return {
    workerMode: results.at(-1)?.workerMode ?? "human_input_required_with_evidence",
    status,
    proof_gate,
    proof_summary: proof_gate.missing.length > 0 ? summarizeProofGate(proof_gate) : results.map((result) => result.proof_summary).join("; "),
    metadata: Object.assign({}, ...results.map((result) => result.metadata))
  };
}

function deriveRegisteredExecutionRunStatus(input: {
  blockedByApproval: boolean;
  hasPendingApproval: boolean;
  hasBlockedStep: boolean;
  remainingSteps: number;
  registeredStatus: "complete" | "partial" | "blocked";
}): "waiting_approval" | "running" | "blocked" | "complete" | "partial" {
  if (input.blockedByApproval || (input.hasPendingApproval && input.remainingSteps > 0)) return "waiting_approval";
  if (input.hasBlockedStep || input.registeredStatus === "blocked") return "blocked";
  if (input.remainingSteps > 0) return "running";
  return input.registeredStatus;
}

function isPortableWorkerCanaryRun(runId: string): boolean {
  const run = querySql<{ execution_source: string; metadata_json: string }>(
    `SELECT execution_source, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`
  )[0];
  if (run?.execution_source !== PORTABLE_EXECUTION_SOURCE) return false;
  const metadata = parseJson<Record<string, unknown>>(run.metadata_json, {});
  const invocation = metadata.portable_workflow_invocation;
  if (!invocation || typeof invocation !== "object" || Array.isArray(invocation)) return false;
  if (process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE === PORTABLE_WORKER_CANARY_MODE) return true;
  const portableWorker = metadata.portable_worker;
  return Boolean(portableWorker && typeof portableWorker === "object" && !Array.isArray(portableWorker)
    && (portableWorker as Record<string, unknown>).mode === PORTABLE_WORKER_CANARY_MODE);
}

function isPortableWorkerExternalRun(runId: string): boolean {
  const run = querySql<{ execution_source: string; automation_id: string | null; metadata_json: string }>(
    `SELECT execution_source, automation_id, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`
  )[0];
  if (run?.execution_source !== PORTABLE_EXECUTION_SOURCE) return false;
  if (run.automation_id === "reference_workflow_canary") return false;
  const metadata = parseJson<Record<string, unknown>>(run.metadata_json, {});
  const invocation = metadata.portable_workflow_invocation;
  if (!invocation || typeof invocation !== "object" || Array.isArray(invocation)) return false;
  if (process.env.AUTOMATION_OS_PORTABLE_WORKER_MODE === PORTABLE_WORKER_EXTERNAL_MODE) return true;
  const portableWorker = metadata.portable_worker;
  if (portableWorker && typeof portableWorker === "object" && !Array.isArray(portableWorker)
    && (portableWorker as Record<string, unknown>).mode === PORTABLE_WORKER_EXTERNAL_MODE) return true;
  // A fixed workflow admitted through the portable entrypoint must never fall
  // back to a legacy per-workflow runner just because the server process did
  // not inherit an explicit mode. The external adapter itself still enforces
  // approval, adapter configuration, and read-only/effect policy.
  return !isPortableWorkerCanaryRun(runId);
}

function portableExternalApprovalWorkflowId(runId: string, metadata: Record<string, unknown>): PortableWorkflowId | null {
  if (!isPortableWorkerExternalRun(runId)) return null;
  if (portableExternalReadOnlyStage(runId, metadata)) return null;
  const adapter = typeof metadata.adapter === "string" ? metadata.adapter : "";
  const workflowId = portableWorkflowIdForWorkerAdapter(adapter);
  if (!workflowId || portableWorkflowManifests[workflowId]?.external_effect_policy !== "approval_required") return null;
  return workflowId;
}

function portableExternalReadOnlyStage(runId: string, metadata: Record<string, unknown>): "candidate_supply" | "reference_readback" | "web_operation_read" | null {
  const run = querySql<{ execution_source: string; metadata_json: string }>(
    `SELECT execution_source, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`
  )[0];
  if (run?.execution_source !== PORTABLE_EXECUTION_SOURCE) return null;
  const runMetadata = parseJson<Record<string, unknown>>(run.metadata_json, {});
  const invocation = runMetadata.portable_workflow_invocation;
  const portableWorker = runMetadata.portable_worker;
  const invocationRecord = invocation && typeof invocation === "object" && !Array.isArray(invocation)
    ? invocation as Record<string, unknown>
    : {};
  const workerRecord = portableWorker && typeof portableWorker === "object" && !Array.isArray(portableWorker)
    ? portableWorker as Record<string, unknown>
    : {};
  const webIntent = invocationRecord.web_operation_intent;
  if (webIntent && typeof webIntent === "object" && !Array.isArray(webIntent)
    && (webIntent as Record<string, unknown>).operation === "read") return "web_operation_read";
  const stage = invocationRecord.read_only_stage ?? workerRecord.read_only_stage ?? metadata.read_only_stage;
  const workflowId = invocationRecord.workflow_id ?? workerRecord.workflow_id;
  if (stage === "candidate_supply" && workflowId === "job-application-manager") return "candidate_supply";
  if (stage === "reference_readback" && (workflowId === "daily-ai-research-publish-run" || workflowId === "nisenprints-daily-product-canva-printify-etsy-pinterest")) {
    return "reference_readback";
  }
  return null;
}

function portableRemoteBusinessMacWorkerRequired(runId: string, metadata: Record<string, unknown>): boolean {
  const run = querySql<{ execution_source: string; metadata_json: string }>(
    `SELECT execution_source, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`
  )[0];
  if (run?.execution_source !== PORTABLE_EXECUTION_SOURCE) return false;
  const runMetadata = parseJson<Record<string, unknown>>(run.metadata_json, {});
  const invocation = runMetadata.portable_workflow_invocation;
  const worker = runMetadata.portable_worker;
  const invocationRecord = invocation && typeof invocation === "object" && !Array.isArray(invocation)
    ? invocation as Record<string, unknown>
    : {};
  const workerRecord = worker && typeof worker === "object" && !Array.isArray(worker)
    ? worker as Record<string, unknown>
    : {};
  const effectStage = invocationRecord.effect_stage ?? workerRecord.effect_stage ?? metadata.effect_stage;
  const inputBundle = runMetadata.portable_input_bundle;
  return runMetadata.worker_protocol === "mac_worker_polling_required"
    && runMetadata.worker_mode === "queued_for_mac_worker"
    && typeof effectStage === "string"
    && Boolean(inputBundle && typeof inputBundle === "object" && !Array.isArray(inputBundle))
    && typeof (inputBundle as Record<string, unknown>).sha256 === "string";
}

function registeredExternalApprovalWorkflowId(runId: string, metadata: Record<string, unknown>): PortableWorkflowId | null {
  // Portable canary runs are intentionally read-only and portable external
  // runs use the more specific manifest-bound gate above. Every other
  // registered runner must enter the same approval boundary before its
  // runner, browser, connector, or workspace-write handoff is possible.
  if (isPortableWorkerExternalRun(runId) || isPortableWorkerCanaryRun(runId) || isReferenceWorkflowCanaryRun(runId)) return null;
  const adapter = typeof metadata.adapter === "string" ? metadata.adapter : "";
  const workflowId = portableWorkflowIdForWorkerAdapter(adapter);
  if (!workflowId || portableWorkflowManifests[workflowId]?.external_effect_policy !== "approval_required") return null;
  return workflowId;
}

function isReferenceWorkflowCanaryRun(runId: string): boolean {
  const run = querySql<{ execution_source: string; automation_id: string | null; metadata_json: string }>(
    `SELECT execution_source, automation_id, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`
  )[0];
  if (run?.execution_source !== PORTABLE_EXECUTION_SOURCE || run.automation_id !== "reference_workflow_canary") return false;
  const metadata = parseJson<Record<string, unknown>>(run.metadata_json, {});
  return metadata.reference_workflow_canary === true;
}

function ensurePortableExternalApproval(input: {
  runId: string;
  step: StepRow;
  metadata: Record<string, unknown>;
  workflowId: PortableWorkflowId;
}): "pending" | "approved" {
  const runMetadata = getRunMetadata(input.runId);
  const invocation = runMetadata.portable_workflow_invocation;
  const invocationRecord = invocation && typeof invocation === "object" && !Array.isArray(invocation)
    ? invocation as Record<string, unknown>
    : {};
  const bundleRecord = runMetadata.portable_input_bundle;
  const bundle = bundleRecord && typeof bundleRecord === "object" && !Array.isArray(bundleRecord)
    ? bundleRecord as Record<string, unknown>
    : {};
  const effectStage = typeof invocationRecord.effect_stage === "string" ? invocationRecord.effect_stage : "";
  const bundleSha = typeof bundle.sha256 === "string" ? bundle.sha256 : "";
  if (!effectStage || !bundleSha || !bundle.input || typeof bundle.input !== "object" || Array.isArray(bundle.input)) {
    return ensurePortableExternalApprovalWithoutTarget(input);
  }
  const binding = portableExternalApprovalBindingForRun(input.runId, input.step, runMetadata, input.workflowId);
  const resourceLocks = portableExternalApprovalResourceLocks({
    workflowId: input.workflowId,
    inputBundleSha256: binding.input_bundle_sha256,
    targetDigest: binding.target_digest,
    idempotencyKey: binding.idempotency_key
  });
  const approvals = querySql<{
    id: string;
    status: string;
    company_id: string | null;
    run_id: string | null;
    step_id: string | null;
    action_kind: string | null;
    policy_version: string | null;
    expires_at: string | null;
    resource_locks_json: string;
  }>(
    `SELECT id, status, company_id, run_id, step_id, action_kind, policy_version, expires_at, resource_locks_json
       FROM approvals WHERE run_id=${sqlValue(input.runId)} ORDER BY created_at ASC`
  );
  const approvalStatus = approvalStatusForPortableBinding(approvals, input, binding, resourceLocks[1]);
  if (approvalStatus) return approvalStatus;

  const approval = createApprovalRequest({
    runId: input.runId,
    title: `Approve external effects: ${input.workflowId}`,
    requestedBy: "automation-os-portable-worker",
    approvalGroupId: `${input.runId}_portable_external_approval_group`,
    resourceLocks,
    priority: "high"
  });
  const inputBundle = portableApprovalInputBundle(input.metadata);
  const payloadHash = typeof inputBundle.payload_hash === "string" && /^[a-f0-9]{64}$/u.test(inputBundle.payload_hash)
    ? inputBundle.payload_hash
    : null;
  const approvalExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  insert("approvals", {
    id: approval.id,
    run_id: approval.runId,
    title: approval.title,
    requested_by: approval.requestedBy,
    status: approval.status,
    priority: approval.priority,
    company_id: getRunCompanyId(input.runId),
    step_id: input.step.id,
    approval_group_id: approval.approvalGroupId,
    action_kind: binding.effect_stage,
    target_account_ref_id: typeof inputBundle.account_ref === "string" ? inputBundle.account_ref : `company:${binding.company_id}`,
    payload_hash: payloadHash,
    policy_version: "automation_os_portable_external_approval_binding.v1",
    expires_at: approvalExpiresAt,
    resource_locks_json: approval.resourceLocks,
    created_at: approval.createdAt,
    decided_at: null,
    decision_note: null
  });
  const metadata = {
    ...input.metadata,
    portable_workflow_invocation: runMetadata.portable_workflow_invocation,
    portable_input_bundle: runMetadata.portable_input_bundle,
    portable_target_bound_approval_binding: binding,
    portable_target_bound_approval_receipt: buildPortableTargetBoundApprovalReceipt({
      approvalId: approval.id,
      approvalStatus: "pending",
      binding
    }),
    requires_approval: true,
    approval_required_reason: "portable_external_effect_policy_approval_required",
    external_effect_policy: "approval_required",
    exact_blocker: "portable_external_approval_required",
    external_action_executed: false
  };
  const runMetadataWithApproval = {
    ...runMetadata,
    portable_target_bound_approval_binding: binding,
    portable_target_bound_approval_receipt: metadata.portable_target_bound_approval_receipt,
    approval_id: approval.id,
    approval_status: "pending",
    requires_approval: true,
    approval_required_reason: "portable_external_effect_policy_approval_required",
    external_effect_policy: "approval_required",
    exact_blocker: "portable_external_approval_required",
    external_action_executed: false
  };
  execSql(
    `UPDATE runs SET metadata_json=${sqlValue(runMetadataWithApproval)}, updated_at=${sqlValue(nowIso())} WHERE id=${sqlValue(input.runId)};
     UPDATE run_steps SET status='waiting_approval', started_at=NULL, completed_at=NULL, metadata_json=${sqlValue(metadata)} WHERE id=${sqlValue(input.step.id)};
     UPDATE lanes SET status='blocked', progress=0, health='approval_required', updated_at=${sqlValue(nowIso())} WHERE id=${sqlValue(input.step.lane_id)};`
  );
  logWorkerEvent({
    runId: input.runId,
    stepId: input.step.id,
    laneId: input.step.lane_id ?? undefined,
    eventType: "worker_blocked",
    message: "portable external effects require explicit approval",
    metadata: {
      workflow_id: input.workflowId,
      exact_blocker: "portable_external_approval_required",
      external_action_executed: false
    }
  });
  return "pending";
}

function ensurePortableExternalApprovalWithoutTarget(input: {
  runId: string;
  step: StepRow;
  metadata: Record<string, unknown>;
  workflowId: PortableWorkflowId;
}): "pending" | "approved" {
  const resourceLock = `portable_external:${input.workflowId}`;
  const approvals = querySql<{ status: string; resource_locks_json: string }>(
    `SELECT status, resource_locks_json FROM approvals WHERE run_id=${sqlValue(input.runId)} ORDER BY created_at ASC`
  );
  const approvalStatus = approvalStatusForResource(approvals, resourceLock);
  if (approvalStatus) return approvalStatus;
  const approval = createApprovalRequest({
    runId: input.runId,
    title: `Approve external effects: ${input.workflowId}`,
    requestedBy: "automation-os-portable-worker",
    approvalGroupId: `${input.runId}_portable_external_approval_group`,
    resourceLocks: [resourceLock],
    priority: "high"
  });
  insert("approvals", {
    id: approval.id,
    run_id: approval.runId,
    title: approval.title,
    requested_by: approval.requestedBy,
    status: approval.status,
    priority: approval.priority,
    company_id: getRunCompanyId(input.runId),
    approval_group_id: approval.approvalGroupId,
    resource_locks_json: approval.resourceLocks,
    created_at: approval.createdAt,
    decided_at: null,
    decision_note: null
  });
  const metadata = {
    ...input.metadata,
    requires_approval: true,
    approval_required_reason: "portable_external_effect_policy_approval_required",
    external_effect_policy: "approval_required",
    exact_blocker: "portable_external_approval_required",
    external_action_executed: false
  };
  execSql(
    `UPDATE run_steps SET status='waiting_approval', started_at=NULL, completed_at=NULL, metadata_json=${sqlValue(metadata)} WHERE id=${sqlValue(input.step.id)};
     UPDATE lanes SET status='blocked', progress=0, health='approval_required', updated_at=${sqlValue(nowIso())} WHERE id=${sqlValue(input.step.lane_id)};`
  );
  logWorkerEvent({
    runId: input.runId,
    stepId: input.step.id,
    laneId: input.step.lane_id ?? undefined,
    eventType: "worker_blocked",
    message: "portable external effects require explicit target-bound input before business admission",
    metadata: {
      workflow_id: input.workflowId,
      exact_blocker: "portable_external_approval_required",
      external_action_executed: false,
      target_bound_business_admission: false
    }
  });
  return "pending";
}

function localPortableExternalEffectAuthority(input: {
  runId: string;
  companyId: string | null;
  stepId: string;
  workflowId: PortableWorkflowId;
  runMetadata: Record<string, unknown>;
}): PortableExternalEffectAuthorityV1 | null {
  const invocation = isRecord(input.runMetadata.portable_workflow_invocation)
    ? input.runMetadata.portable_workflow_invocation
    : {};
  const bundleRecord = isRecord(input.runMetadata.portable_input_bundle)
    ? input.runMetadata.portable_input_bundle
    : {};
  const bundle = isRecord(bundleRecord.input) ? bundleRecord.input : null;
  const effectStage = typeof invocation.effect_stage === "string" ? invocation.effect_stage.trim() : "";
  const idempotencyKey = typeof invocation.idempotency_key === "string" ? invocation.idempotency_key.trim() : "";
  const approvalId = typeof input.runMetadata.approval_id === "string"
    ? input.runMetadata.approval_id.trim()
    : isRecord(input.runMetadata.portable_target_bound_approval_receipt)
      && typeof input.runMetadata.portable_target_bound_approval_receipt.approval_id === "string"
      ? input.runMetadata.portable_target_bound_approval_receipt.approval_id.trim()
      : "";
  const inputBundleSha256 = typeof bundleRecord.sha256 === "string" ? bundleRecord.sha256.trim() : "";
  const binding = isRecord(input.runMetadata.portable_target_bound_approval_binding)
    ? input.runMetadata.portable_target_bound_approval_binding
    : {};
  const targetDigest = typeof binding.target_digest === "string"
    ? binding.target_digest.trim()
    : bundle ? portableBusinessTargetDigest(bundle) : "";
  if (!input.companyId || !effectStage || !idempotencyKey || !approvalId || !bundle || !/^[a-f0-9]{64}$/u.test(inputBundleSha256) || !/^[a-f0-9]{64}$/u.test(targetDigest)) {
    return null;
  }
  const payloadHash = typeof bundle.payload_hash === "string" && /^[a-f0-9]{64}$/u.test(bundle.payload_hash)
    ? bundle.payload_hash
    : null;
  try {
    return issuePortableExternalEffectAuthorityV1({
      companyId: input.companyId,
      workflowId: input.workflowId,
      runId: input.runId,
      stepId: input.stepId,
      effectStage,
      approvalId,
      idempotencyKey,
      targetDigest,
      inputBundleSha256,
      payloadHash,
      leaseExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
    });
  } catch {
    return null;
  }
}

function portableApprovalInputBundle(metadata: Record<string, unknown>): Record<string, unknown> {
  const bundle = metadata.portable_input_bundle;
  const record = bundle && typeof bundle === "object" && !Array.isArray(bundle)
    ? bundle as Record<string, unknown>
    : {};
  const input = record.input;
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

function portableExternalApprovalBindingForRun(
  runId: string,
  step: StepRow,
  metadata: Record<string, unknown>,
  workflowId: PortableWorkflowId
): PortableExternalApprovalBindingV1 {
  const invocation = metadata.portable_workflow_invocation;
  const invocationRecord = invocation && typeof invocation === "object" && !Array.isArray(invocation)
    ? invocation as Record<string, unknown>
    : {};
  const bundle = metadata.portable_input_bundle;
  const bundleRecord = bundle && typeof bundle === "object" && !Array.isArray(bundle)
    ? bundle as Record<string, unknown>
    : {};
  const inputBundle = portableApprovalInputBundle(metadata);
  const bundleSha = typeof bundleRecord.sha256 === "string" ? bundleRecord.sha256 : "";
  const effectStage = typeof invocationRecord.effect_stage === "string" ? invocationRecord.effect_stage : "";
  const idempotencyKey = typeof invocationRecord.idempotency_key === "string" ? invocationRecord.idempotency_key : "";
  return buildPortableExternalApprovalBinding({
    companyId: getRunCompanyId(runId) || "",
    workflowId,
    runId,
    stepId: step.id,
    effectStage,
    idempotencyKey,
    inputBundleSha256: bundleSha,
    inputBundle
  });
}

function approvalStatusForPortableBinding(
  approvals: Array<{
    id: string;
    status: string;
    company_id: string | null;
    run_id: string | null;
    step_id: string | null;
    action_kind: string | null;
    policy_version: string | null;
    expires_at: string | null;
    resource_locks_json: string;
  }>,
  input: { runId: string; step: StepRow; workflowId: PortableWorkflowId },
  binding: PortableExternalApprovalBindingV1,
  targetLock: string
): "pending" | "approved" | null {
  const matching = approvals.filter((approval) => {
    const locks = parseJson<unknown>(approval.resource_locks_json, []);
    return Array.isArray(locks)
      && locks.includes(targetLock)
      && approval.company_id === binding.company_id
      && approval.run_id === input.runId
      && approval.step_id === input.step.id
      && approval.action_kind === binding.effect_stage
      && approval.policy_version === "automation_os_portable_external_approval_binding.v1"
      && (!approval.expires_at || Date.parse(approval.expires_at) > Date.now());
  });
  if (matching.some((approval) => approval.status === "approved")) return "approved";
  if (matching.some((approval) => approval.status === "pending")) return "pending";
  return null;
}

function ensureRegisteredExternalApproval(input: {
  runId: string;
  step: StepRow;
  metadata: Record<string, unknown>;
  workflowId: PortableWorkflowId;
}): "pending" | "approved" {
  const approvals = querySql<{ status: string; resource_locks_json: string }>(
    `SELECT status, resource_locks_json FROM approvals WHERE run_id=${sqlValue(input.runId)} ORDER BY created_at ASC`
  );
  const approvalStatus = approvalStatusForResource(approvals, `registered_external:${input.workflowId}`);
  if (approvalStatus) return approvalStatus;

  const approval = createApprovalRequest({
    runId: input.runId,
    title: `Approve registered external effects: ${input.workflowId}`,
    requestedBy: "automation-os-worker",
    approvalGroupId: `${input.runId}_registered_external_approval_group`,
    resourceLocks: [`registered_external:${input.workflowId}`],
    priority: "high"
  });
  insert("approvals", {
    id: approval.id,
    run_id: approval.runId,
    title: approval.title,
    requested_by: approval.requestedBy,
    status: approval.status,
    priority: approval.priority,
    company_id: getRunCompanyId(input.runId),
    approval_group_id: approval.approvalGroupId,
    resource_locks_json: approval.resourceLocks,
    created_at: approval.createdAt,
    decided_at: null,
    decision_note: null
  });
  const metadata = {
    ...input.metadata,
    requires_approval: true,
    approval_required_reason: "registered_external_effect_policy_approval_required",
    external_effect_policy: "approval_required",
    exact_blocker: "registered_external_approval_required",
    external_action_executed: false
  };
  execSql(
    `UPDATE run_steps SET status='waiting_approval', started_at=NULL, completed_at=NULL, metadata_json=${sqlValue(metadata)} WHERE id=${sqlValue(input.step.id)};
     UPDATE lanes SET status='blocked', progress=0, health='approval_required', updated_at=${sqlValue(nowIso())} WHERE id=${sqlValue(input.step.lane_id)};`
  );
  logWorkerEvent({
    runId: input.runId,
    stepId: input.step.id,
    laneId: input.step.lane_id ?? undefined,
    eventType: "worker_blocked",
    message: "registered external effects require explicit approval",
    metadata: {
      workflow_id: input.workflowId,
      exact_blocker: "registered_external_approval_required",
      external_action_executed: false
    }
  });
  return "pending";
}

function approvalStatusForResource(
  approvals: Array<{ status: string; resource_locks_json: string }>,
  resourceLock: string
): "pending" | "approved" | null {
  const matching = approvals.filter((approval) => {
    const locks = parseJson<unknown>(approval.resource_locks_json, []);
    return Array.isArray(locks) && locks.includes(resourceLock);
  });
  if (matching.some((approval) => approval.status === "approved")) return "approved";
  if (matching.some((approval) => approval.status === "pending")) return "pending";
  return null;
}

export function materializePortableInputBundleForMacWorker(input: {
  runId: string;
  workflowId: PortableWorkflowId;
  input: Record<string, unknown>;
}): string {
  const allowedKeys = new Set([
    "job_url", "application_url", "candidate_key", "bucket", "sequence", "attempt",
    "source_snapshot_id", "supply_run_id", "remaining", "margin", "company", "role"
  ]);
  const safeInput: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input.input)) {
    if (!allowedKeys.has(key) || /(token|cookie|password|secret|authorization|storage[_-]?state|credential|profile[_-]?path)/iu.test(key)) {
      throw new Error("portable_external_input_bundle_inline_invalid");
    }
    if (typeof raw === "string") {
      if (raw.length > 1000) throw new Error("portable_external_input_bundle_inline_invalid");
      safeInput[key] = raw;
    } else if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) {
      safeInput[key] = raw;
    } else {
      throw new Error("portable_external_input_bundle_inline_invalid");
    }
  }
  if (safeInput.bucket !== undefined && safeInput.bucket !== "japan_targeted" && safeInput.bucket !== "overseas_global") {
    throw new Error("portable_external_input_bundle_inline_invalid");
  }
  for (const key of ["remaining", "margin"]) {
    if (safeInput[key] !== undefined && (!Number.isSafeInteger(safeInput[key]) || Number(safeInput[key]) < 0 || Number(safeInput[key]) > 20)) {
      throw new Error("portable_external_input_bundle_inline_invalid");
    }
  }
  const artifactRoot = resolve(process.env.AUTOMATION_OS_ARTIFACT_ROOT?.trim() || resolve(process.cwd(), "data", "artifacts"));
  const runRoot = resolve(artifactRoot, input.runId);
  if (runRoot === artifactRoot || !runRoot.startsWith(`${artifactRoot}${sep}`)) {
    throw new Error("portable_external_input_bundle_run_path_invalid");
  }
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  chmodSync(runRoot, 0o700);
  const bytes = `${JSON.stringify({
    schema: "automation_os_portable_workflow_input_bundle.v1",
    workflow_id: input.workflowId,
    run_id: input.runId,
    input: safeInput
  }, null, 2)}\n`;
  const bundlePath = resolve(runRoot, "portable-input-bundle.v1.json");
  if (existsSync(bundlePath)) {
    const stat = lstatSync(bundlePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      throw new Error("portable_external_input_bundle_immutable_collision");
    }
    const existingBytes = readFileSync(bundlePath, "utf8");
    if (existingBytes !== bytes) {
      let existing: unknown;
      try {
        existing = JSON.parse(existingBytes);
      } catch {
        throw new Error("portable_external_input_bundle_immutable_collision");
      }
      const existingRecord = existing && typeof existing === "object" && !Array.isArray(existing)
        ? existing as Record<string, unknown>
        : null;
      const existingInput = existingRecord?.input;
      if (!existingRecord
        || existingRecord.schema !== "automation_os_portable_workflow_input_bundle.v1"
        || existingRecord.workflow_id !== input.workflowId
        || existingRecord.run_id !== input.runId
        || !existingInput || typeof existingInput !== "object" || Array.isArray(existingInput)
        || !isDeepStrictEqual(existingInput, safeInput)) {
        throw new Error("portable_external_input_bundle_immutable_collision");
      }
    }
    chmodSync(bundlePath, 0o600);
    return bundlePath;
  }
  writeFileSync(bundlePath, bytes, { flag: "wx", mode: 0o600 });
  chmodSync(bundlePath, 0o600);
  return bundlePath;
}

async function completePortableExternalWorkerStep(input: {
  step: StepRow;
  metadata: Record<string, unknown>;
  selectedAdapter: WorkerAdapter;
  workflowId: PortableWorkflowId;
  now: string;
  approvalGranted: boolean;
}): Promise<RegisteredExecutionResult> {
  const runMetadataRow = querySql<{ metadata_json: string; company_id: string | null }>(
    `SELECT metadata_json, company_id FROM runs WHERE id=${sqlValue(input.step.run_id)} LIMIT 1`
  )[0];
  const runMetadata = parseJson<Record<string, unknown>>(runMetadataRow?.metadata_json ?? "{}", {});
  const invocation = typeof runMetadata.portable_workflow_invocation === "object"
    && runMetadata.portable_workflow_invocation !== null
    && !Array.isArray(runMetadata.portable_workflow_invocation)
    ? runMetadata.portable_workflow_invocation as Record<string, unknown>
    : {};
  const sourceTrigger = typeof invocation.source_trigger === "string" ? invocation.source_trigger : "codex_app_bridge";
  const idempotencyKey = typeof invocation.idempotency_key === "string" && invocation.idempotency_key.trim()
      ? invocation.idempotency_key
      : `automation-os:${input.workflowId}:${input.step.run_id}`;
  const webOperationIntent = invocation.web_operation_intent
    && typeof invocation.web_operation_intent === "object"
    && !Array.isArray(invocation.web_operation_intent)
    ? invocation.web_operation_intent as Record<string, unknown>
    : null;
  const inputBundle = typeof runMetadata.portable_input_bundle === "object"
    && runMetadata.portable_input_bundle !== null
    && !Array.isArray(runMetadata.portable_input_bundle)
    ? runMetadata.portable_input_bundle as Record<string, unknown>
    : {};
  const inputBundlePath = typeof invocation.input_bundle_path === "string" && invocation.input_bundle_path.trim()
    ? invocation.input_bundle_path
    : typeof inputBundle.path === "string" && inputBundle.path.trim()
      ? inputBundle.path
      : undefined;
  const inlineInput = inputBundle.input && typeof inputBundle.input === "object" && !Array.isArray(inputBundle.input)
    ? inputBundle.input as Record<string, unknown>
    : null;
  const localInputBundlePath = inlineInput
    ? materializePortableInputBundleForMacWorker({ runId: input.step.run_id, workflowId: input.workflowId, input: inlineInput })
    : undefined;
  const readOnlyStage = portableExternalReadOnlyStage(input.step.run_id, input.metadata);
  const effectAuthority = readOnlyStage === null && input.approvalGranted
    ? localPortableExternalEffectAuthority({
      runId: input.step.run_id,
      companyId: runMetadataRow?.company_id ?? null,
      stepId: input.step.id,
      workflowId: input.workflowId,
      runMetadata
    })
    : null;
  const result = await runPortableExternalWorker({
    workflowId: input.workflowId,
    runId: input.step.run_id,
    stepId: input.step.id,
    sourceTrigger,
    idempotencyKey,
    approvalGranted: input.approvalGranted,
    inputBundlePath: localInputBundlePath ?? inputBundlePath,
    readOnlyStage,
    effectAuthority,
    webOperationIntent
  });
  const businessCompletionVerified = readOnlyStage === null
    && result.response?.business_completion_verified === true;
  const artifact = writeWorkerArtifact(input.step.run_id, input.step.id, {
    schema: "automation_os_portable_external_worker_receipt_v1",
    workflow_id: input.workflowId,
    run_id: input.step.run_id,
    step_id: input.step.id,
    source_trigger: sourceTrigger,
    idempotency_key: idempotencyKey,
    status: result.status,
    exact_blocker: result.exactBlocker,
      external_action_executed: result.externalActionExecuted,
      business_completion_verified: businessCompletionVerified,
      read_only_stage: readOnlyStage,
      exit_status: result.exitStatus,
    signal: result.signal,
    portable_external_admission_path: result.admissionPath || null,
    portable_external_admission_sha256: result.admissionSha256 || null,
    portable_external_action_plan_path: result.actionPlanPath || null,
    portable_external_action_plan_sha256: result.actionPlanSha256 || null,
    portable_web_operation_intent_path: result.webOperationIntentPath || null,
    portable_web_operation_intent_sha256: result.webOperationIntentSha256 || null,
    process_group_cleanup: result.processGroupCleanup || null,
    stdout_tail: result.stdoutTail,
    stderr_tail: result.stderrTail,
    created_at: input.now
  });
  const proofGate = {
    ok: result.status === "complete" && !result.exactBlocker,
    missing: result.exactBlocker ? [result.exactBlocker] : [],
    present: ["automation_os_portable_external_worker_receipt_v1"]
  };
  const proofSummary = result.exactBlocker
    ? `blocked: ${result.exactBlocker}`
    : `${result.status}: portable external worker receipt captured`;
  const stepStatus = result.status === "complete" && !result.exactBlocker ? "completed" : "blocked";
  const laneStatus = stepStatus === "completed" ? "idle" : "blocked";
  const runtimeReadback = result.response?.adapter_result && typeof result.response.adapter_result === "object"
    && result.response.adapter_result !== null && !Array.isArray(result.response.adapter_result)
    && (result.response.adapter_result as Record<string, unknown>).browser_runtime_readback
    && typeof (result.response.adapter_result as Record<string, unknown>).browser_runtime_readback === "object"
    && !Array.isArray((result.response.adapter_result as Record<string, unknown>).browser_runtime_readback)
    ? (result.response.adapter_result as Record<string, unknown>).browser_runtime_readback as Record<string, unknown>
    : null;
  const existingRuntimeBinding = input.metadata.service_readiness_runtime_binding;
  const runtimeBinding = existingRuntimeBinding && typeof existingRuntimeBinding === "object"
    && !Array.isArray(existingRuntimeBinding)
    ? existingRuntimeBinding as Record<string, unknown>
    : null;
  const effectiveSession = runtimeReadback && typeof runtimeReadback.effective_session === "string"
    ? runtimeReadback.effective_session.trim()
    : "";
  const runtimeReadbackVerified = result.externalActionExecuted === false
    && Boolean(runtimeReadback)
    && effectiveSession.length > 0
    && runtimeReadback?.cleanup_verified === true;
  const enrichedMetadata = {
    ...input.metadata,
    ...(runtimeBinding && runtimeReadback
      ? {
        service_readiness_runtime_binding: {
          ...runtimeBinding,
          effective_session_id: effectiveSession || runtimeBinding.effective_session_id || null,
          profile_root: typeof runtimeReadback.profile_root === "string" && runtimeReadback.profile_root.trim()
            ? runtimeReadback.profile_root
            : runtimeBinding.profile_root,
          reserved_port: Number.isSafeInteger(Number(runtimeReadback.reserved_port)) && Number(runtimeReadback.reserved_port) > 0
            ? Number(runtimeReadback.reserved_port)
            : runtimeBinding.reserved_port,
          readback_status: runtimeReadbackVerified ? "verified" : "blocked",
          status: runtimeReadbackVerified ? "verified" : "blocked",
          exact_blocker: runtimeReadbackVerified ? null : (runtimeBinding.exact_blocker || "service_readiness_browser_use_runtime_readback_missing"),
          external_action_executed: result.externalActionExecuted,
        },
      }
      : {}),
  };
  execSql(
    `UPDATE run_steps SET status=${sqlValue(stepStatus)}, completed_at=${sqlValue(input.now)}, metadata_json=${sqlValue({
      ...enrichedMetadata,
      adapter: input.selectedAdapter,
      execution_mode: "portable_external",
      portable_workflow_id: input.workflowId,
      source_trigger: sourceTrigger,
      idempotency_key: idempotencyKey,
      portable_external_artifact: artifact.uri,
      portable_external_receipt: {
        status: result.status,
        exact_blocker: result.exactBlocker,
        external_action_executed: result.externalActionExecuted,
        exit_status: result.exitStatus,
        signal: result.signal,
        process_group_cleanup: result.processGroupCleanup || null
      },
      proof_gate: proofGate,
      proof_summary: proofSummary,
      exact_blocker: result.exactBlocker,
      external_action_executed: result.externalActionExecuted,
      business_completion_verified: businessCompletionVerified
    })} WHERE id=${sqlValue(input.step.id)};
     UPDATE lanes SET status=${sqlValue(laneStatus)}, progress=${stepStatus === "completed" ? 100 : 50}, health=${sqlValue(laneStatus === "idle" ? "good" : "blocked")}, updated_at=${sqlValue(input.now)} WHERE id=${sqlValue(input.step.lane_id)};`
  );
  insertRunProof(input.step.run_id, {
    id: makeId("proof"),
    run_id: input.step.run_id,
    step_id: input.step.id,
    proof_type: "worker_receipt",
    label: `${input.workflowId} portable external worker receipt`,
    uri: artifact.uri,
    size_bytes: artifact.sizeBytes,
    created_at: input.now,
    metadata_json: {
      adapter: input.selectedAdapter,
      execution_mode: "portable_external",
      portable_workflow_id: input.workflowId,
      source_trigger: sourceTrigger,
      idempotency_key: idempotencyKey,
      external_action_executed: result.externalActionExecuted,
      exact_blocker: result.exactBlocker,
      business_completion_verified: businessCompletionVerified
    }
  });
  logWorkerEvent({
    runId: input.step.run_id,
    stepId: input.step.id,
    laneId: input.step.lane_id ?? undefined,
    eventType: stepStatus === "completed" ? "worker_completed" : "worker_blocked",
    message: proofSummary,
    metadata: {
      adapter: input.selectedAdapter,
      execution_mode: "portable_external",
      portable_workflow_id: input.workflowId,
      artifact_uri: artifact.uri,
      exact_blocker: result.exactBlocker,
      external_action_executed: result.externalActionExecuted,
      business_completion_verified: businessCompletionVerified
    }
  });
  return {
    workerMode: portableWorkerModeForAdapter(input.selectedAdapter),
    status: result.status,
    proof_gate: proofGate,
    proof_summary: proofSummary,
    metadata: {
      adapter: input.selectedAdapter,
      execution_mode: "portable_external",
      portable_workflow_id: input.workflowId,
      portable_external_artifact: artifact.uri,
      exact_blocker: result.exactBlocker,
      external_action_executed: result.externalActionExecuted,
      business_completion_verified: businessCompletionVerified,
      portable_external_worker: {
        exit_status: result.exitStatus,
        signal: result.signal,
        process_group_cleanup: result.processGroupCleanup || null,
        stdout_tail: result.stdoutTail,
        stderr_tail: result.stderrTail,
        business_completion_verified: businessCompletionVerified
      }
    }
  };
}

function completePortableWorkerCanaryStep(input: {
  step: StepRow;
  metadata: Record<string, unknown>;
  selectedAdapter: WorkerAdapter;
  workflowId: PortableWorkflowId;
  now: string;
}): RegisteredExecutionResult {
  // The run metadata is the authoritative source for the trigger and
  // idempotency binding. Step metadata can be a reduced snapshot and was
  // previously causing scheduler-launched receipts to fall back to the App
  // bridge trigger even though the run itself was correctly bound.
  const runMetadataRow = querySql<{ metadata_json: string }>(
    `SELECT metadata_json FROM runs WHERE id=${sqlValue(input.step.run_id)} LIMIT 1`
  )[0];
  const runMetadata = parseJson<Record<string, unknown>>(runMetadataRow?.metadata_json ?? "{}", {});
  const portableInvocation = typeof runMetadata.portable_workflow_invocation === "object"
    && runMetadata.portable_workflow_invocation !== null
    && !Array.isArray(runMetadata.portable_workflow_invocation)
    ? runMetadata.portable_workflow_invocation as Record<string, unknown>
    : {};
  const registeredStart = runMetadata.registered_workflow_start ?? input.metadata.registered_workflow_start;
  const registeredStartRecord = typeof registeredStart === "object" && registeredStart !== null
    ? registeredStart as Record<string, unknown>
    : {};
  const sourceTrigger = portableInvocation.source_trigger === "automation_os_scheduler"
    || portableInvocation.source_trigger === "automation_os_ui"
    || portableInvocation.source_trigger === "codex_app_bridge"
    || portableInvocation.source_trigger === "launchd"
    || portableInvocation.source_trigger === "github_actions"
    ? portableInvocation.source_trigger
    : registeredStartRecord.source === "scheduler"
      ? "automation_os_scheduler" as const
      : "codex_app_bridge" as const;
  const idempotencyKey = typeof portableInvocation.idempotency_key === "string" && portableInvocation.idempotency_key.trim()
    ? portableInvocation.idempotency_key
    : typeof input.metadata.idempotency_key === "string" && input.metadata.idempotency_key.trim()
      ? input.metadata.idempotency_key
      : `automation-os:${input.workflowId}:${input.step.run_id}`;
  const portable = runPortableWorkflowNoEffect({
    runId: input.step.run_id,
    workflowId: input.workflowId,
    sourceTrigger,
    idempotencyKey
  });
  const artifact = writeWorkerArtifact(input.step.run_id, input.step.id, {
    ...portable.receipt,
    workflow_id: input.workflowId,
    source_trigger: sourceTrigger,
    idempotency_key: idempotencyKey,
    exact_blocker: PORTABLE_EXTERNAL_EFFECTS_DISABLED_BLOCKER,
    external_action_executed: false,
    created_at: input.now
  });
  const proofGate = {
    ok: false,
    missing: [PORTABLE_EXTERNAL_EFFECTS_DISABLED_BLOCKER],
    present: [portable.receipt.schema]
  };
  const proofSummary = `blocked: ${PORTABLE_EXTERNAL_EFFECTS_DISABLED_BLOCKER}`;
  insertRunProof(input.step.run_id, {
    id: makeId("proof"),
    run_id: input.step.run_id,
    step_id: input.step.id,
    proof_type: "worker_receipt",
    label: `${input.workflowId} portable worker canary receipt`,
    uri: artifact.uri,
    size_bytes: artifact.sizeBytes,
    created_at: input.now,
    metadata_json: {
      adapter: input.selectedAdapter,
      execution_mode: "portable_canary",
      portable_workflow_id: input.workflowId,
      source_trigger: sourceTrigger,
      idempotency_key: idempotencyKey,
      external_action_executed: false
    }
  });
  execSql(
    `UPDATE run_steps SET status='blocked', completed_at=${sqlValue(input.now)}, metadata_json=${sqlValue({
      ...input.metadata,
      adapter: input.selectedAdapter,
      execution_mode: "portable_canary",
      worker_mode: portableWorkerModeForAdapter(input.selectedAdapter),
      portable_workflow_id: input.workflowId,
      source_trigger: sourceTrigger,
      idempotency_key: idempotencyKey,
      portable_canary_receipt: portable.receipt,
      portable_canary_artifact: artifact.uri,
      proof_gate: proofGate,
      proof_summary: proofSummary,
      exact_blocker: PORTABLE_EXTERNAL_EFFECTS_DISABLED_BLOCKER,
      external_action_executed: false
    })} WHERE id=${sqlValue(input.step.id)};
     UPDATE lanes SET status='blocked', progress=50, health='blocked', updated_at=${sqlValue(input.now)} WHERE id=${sqlValue(input.step.lane_id)};`
  );
  logWorkerEvent({
    runId: input.step.run_id,
    stepId: input.step.id,
    laneId: input.step.lane_id ?? undefined,
    eventType: "worker_blocked",
    message: proofSummary,
    metadata: {
      adapter: input.selectedAdapter,
      execution_mode: "portable_canary",
      portable_workflow_id: input.workflowId,
      artifact_uri: artifact.uri,
      external_action_executed: false
    }
  });
  return {
    workerMode: portableWorkerModeForAdapter(input.selectedAdapter),
    status: "blocked",
    proof_gate: proofGate,
    proof_summary: proofSummary,
    metadata: {
      adapter: input.selectedAdapter,
      execution_mode: "portable_canary",
      portable_workflow_id: input.workflowId,
      portable_canary_receipt: portable.receipt,
      portable_canary_artifact: artifact.uri,
      exact_blocker: PORTABLE_EXTERNAL_EFFECTS_DISABLED_BLOCKER,
      external_action_executed: false
    }
  };
}

function isPortableLocalRun(metadata: Record<string, unknown>, workflowId: string): boolean {
  const invocation = metadata.portable_workflow_invocation;
  if (!invocation || typeof invocation !== "object" || Array.isArray(invocation)) return false;
  return (invocation as Record<string, unknown>).workflow_id === workflowId
    && metadata.worker_protocol === "mac_worker_polling_required"
    && metadata.worker_mode === "queued_for_mac_worker";
}

function completePortableLocalWorkerStep(input: {
  step: StepRow;
  metadata: Record<string, unknown>;
  selectedAdapter: WorkerAdapter;
  workflowId: Parameters<typeof runPortableLocalWorkflowReadOnly>[0]["workflowId"];
  now: string;
}): RegisteredExecutionResult {
  const receipt = runPortableLocalWorkflowReadOnly({
    workflowId: input.workflowId,
    workerRole: process.env.AUTOMATION_OS_WORKER_ROLE?.trim()
  });
  const artifact = writeNamedWorkerArtifact(input.step.run_id, `${input.step.id}-portable-local-worker.json`, {
    schema: "aos.portable_local_worker_receipt.v1",
    ...receipt,
    run_id: input.step.run_id,
    step_id: input.step.id,
    adapter: input.selectedAdapter,
    created_at: input.now
  });
  insertRunProof(input.step.run_id, {
    id: makeId("proof"),
    run_id: input.step.run_id,
    step_id: input.step.id,
    proof_type: "worker_receipt",
    label: `${input.workflowId} Mac local worker read-only receipt`,
    uri: artifact.uri,
    size_bytes: artifact.sizeBytes,
    created_at: input.now,
    metadata_json: {
      adapter: input.selectedAdapter,
      execution_mode: "portable_local_read_only",
      workflow_id: input.workflowId,
      exact_blocker: receipt.exact_blocker,
      readback_verified: receipt.readback_verified,
      business_completion_verified: false,
      external_action_executed: false
    }
  });
  const completed = receipt.status === "complete" && receipt.exact_blocker === null;
  const stepStatus = completed ? "completed" : "blocked";
  const laneStatus = completed ? "idle" : "blocked";
  const proofGate = completed
    ? { ok: true, missing: [] as string[], present: ["portable_local_worker_receipt", "cleanup_verified"] }
    : { ok: false, missing: [receipt.exact_blocker ?? "portable_local_worker_business_completion_pending"], present: ["portable_local_worker_receipt", "cleanup_verified"] };
  const proofSummary = completed
    ? "complete: Mac local read-only adapter returned a verified receipt"
    : `blocked: ${receipt.exact_blocker ?? "portable_local_worker_business_completion_pending"}`;
  execSql(`UPDATE run_steps SET status=${sqlValue(stepStatus)}, completed_at=${sqlValue(input.now)}, metadata_json=${sqlValue({
    ...input.metadata,
    adapter: input.selectedAdapter,
    execution_mode: "portable_local_read_only",
    portable_local_workflow_id: input.workflowId,
    portable_local_receipt: receipt,
    portable_local_artifact: artifact.uri,
    proof_gate: proofGate,
    proof_summary: proofSummary,
    exact_blocker: receipt.exact_blocker,
    external_action_executed: false,
    business_completion_verified: false
  })} WHERE id=${sqlValue(input.step.id)};
  UPDATE lanes SET status=${sqlValue(laneStatus)}, progress=${completed ? 100 : 50}, health=${sqlValue(completed ? "good" : "blocked")}, updated_at=${sqlValue(input.now)} WHERE id=${sqlValue(input.step.lane_id)};`);
  logWorkerEvent({
    runId: input.step.run_id,
    stepId: input.step.id,
    laneId: input.step.lane_id ?? undefined,
    eventType: completed ? "worker_completed" : "worker_blocked",
    message: proofSummary,
    metadata: {
      adapter: input.selectedAdapter,
      workflow_id: input.workflowId,
      artifact_uri: artifact.uri,
      exact_blocker: receipt.exact_blocker,
      external_action_executed: false,
      business_completion_verified: false
    }
  });
  return {
    workerMode: "execute_portable_local_read_only",
    status: receipt.status,
    proof_gate: proofGate,
    proof_summary: proofSummary,
    metadata: {
      portable_local_worker: {
        workflow_id: input.workflowId,
        adapter: input.selectedAdapter,
        artifact_uri: artifact.uri,
        receipt,
        external_action_executed: false,
        business_completion_verified: false
      }
    }
  };
}

async function completeWorkerStep(
  step: StepRow,
  metadata: Record<string, unknown>,
  approvalGranted = false
): Promise<RegisteredExecutionResult | undefined> {
  const now = nowIso();
  const selectedAdapter = String(metadata.adapter ?? "local_worker") as WorkerAdapter;
  const localWorkflowId = localWorkflowIdForWorkerAdapter(selectedAdapter);
  const runMetadataForPortableLocal = localWorkflowId ? getRunMetadata(step.run_id) : {};
  if (localWorkflowId && isPortableLocalRun(runMetadataForPortableLocal, localWorkflowId)) {
    execSql(`UPDATE run_steps SET status='running', started_at=COALESCE(started_at, ${sqlValue(now)}) WHERE id=${sqlValue(step.id)};
      UPDATE lanes SET status='active', progress=50, updated_at=${sqlValue(now)} WHERE id=${sqlValue(step.lane_id)};`);
    return completePortableLocalWorkerStep({ step, metadata, selectedAdapter, workflowId: localWorkflowId, now });
  }
  const portableWorkflowId = portableWorkflowIdForWorkerAdapter(selectedAdapter);
  if (portableWorkflowId && isPortableWorkerCanaryRun(step.run_id)) {
    return completePortableWorkerCanaryStep({ step, metadata, selectedAdapter, workflowId: portableWorkflowId, now });
  }
  if (portableWorkflowId && isPortableWorkerExternalRun(step.run_id)) {
    return completePortableExternalWorkerStep({ step, metadata, selectedAdapter, workflowId: portableWorkflowId, now, approvalGranted });
  }
  const routeContext = buildCanonicalRouteBlockContext({ step, metadata, adapter: selectedAdapter });
  if (!routeContext.routeDecision) {
    blockStepForRouting(step, metadata, now, "route_decision_missing");
    return undefined;
  }
  if (routeContext.exactBlocker) {
    blockStepForRouting(
      step,
      {
        ...metadata,
        adapter: selectedAdapter,
        command: routeContext.command,
        command_display: routeContext.command.display,
        worker_mode: routeContext.workerMode,
        execution_mode: routeContext.workerMode,
        adapter_policy: routeContext.adapterPolicy,
        route_readback: routeContext.effectiveRouteReadback,
        execution_routing: routeContext.effectiveRouteReadback,
        route_readback_fingerprint: routeContext.effectiveRouteReadback.fingerprint,
        route_decision: routeContext.routeDecision ?? undefined,
        route_decision_fingerprint: routeContext.routeDecision?.fingerprint ?? null,
        proof_gate: { ok: false, missing: [routeContext.exactBlocker], present: [] as string[] },
        proof_summary: `blocked: ${routeContext.exactBlocker}`,
        stop_reason: routeContext.exactBlocker,
        external_action_executed: false,
        ...(routeContext.runnerSafety ? { runner_safety: routeContext.runnerSafety } : {})
      },
      now,
      routeContext.exactBlocker,
      routeContext.routeDecision ?? undefined,
      routeContext.effectiveRouteReadback,
      routeContext.adapterPolicy,
      routeContext.workerMode,
      routeContext.command,
      routeContext.runnerSafety
    );
    return undefined;
  }
  const commonBrowserBoundaryBlocker = registeredBrowserWorkflowCommonBoundaryBlocker({
    portableWorkflowId,
    // X's registered lane is a no-effect human-input evidence stop. It has a
    // dedicated fail-closed evidence runner and does not hand an external
    // business operation to a provider, so the common business boundary does
    // not replace that evidence contract.
    portableRunAdmitted: isHumanInputRequiredWithEvidenceAdapter(selectedAdapter)
  });
  if (commonBrowserBoundaryBlocker) {
    blockStepForRouting(
      step,
      {
        ...metadata,
        adapter: selectedAdapter,
        command: routeContext.command,
        command_display: routeContext.command.display,
        worker_mode: routeContext.workerMode,
        execution_mode: routeContext.workerMode,
        adapter_policy: routeContext.adapterPolicy,
        route_readback: routeContext.effectiveRouteReadback,
        execution_routing: routeContext.effectiveRouteReadback,
        route_readback_fingerprint: routeContext.effectiveRouteReadback.fingerprint,
        route_decision: routeContext.routeDecision ?? undefined,
        route_decision_fingerprint: routeContext.routeDecision?.fingerprint ?? null,
        proof_gate: { ok: false, missing: [commonBrowserBoundaryBlocker], present: [] as string[] },
        proof_summary: `blocked: ${commonBrowserBoundaryBlocker}`,
        exact_blocker: commonBrowserBoundaryBlocker,
        blocker: commonBrowserBoundaryBlocker,
        stop_reason: commonBrowserBoundaryBlocker,
        external_action_executed: false,
        ...(routeContext.runnerSafety ? { runner_safety: routeContext.runnerSafety } : {})
      },
      now,
      commonBrowserBoundaryBlocker,
      routeContext.routeDecision ?? undefined,
      routeContext.effectiveRouteReadback,
      routeContext.adapterPolicy,
      routeContext.workerMode,
      routeContext.command,
      routeContext.runnerSafety
    );
    return undefined;
  }
  execSql(
    `UPDATE run_steps SET status='running', started_at=COALESCE(started_at, ${sqlValue(now)}) WHERE id=${sqlValue(step.id)};
     UPDATE lanes SET status='active', progress=50, updated_at=${sqlValue(now)} WHERE id=${sqlValue(step.lane_id)};`
  );
  updateRunStatus(step.run_id, "running", {
    worker_protocol: "local_worker_v1",
    worker_mode: routeContext.workerMode,
    active_step_id: step.id,
    active_adapter: selectedAdapter,
    adapter_policy: routeContext.adapterPolicy,
    worker_started_at: now,
    route_decision: routeContext.routeDecision,
    route_readback: routeContext.routeReadback,
    execution_routing: routeContext.routeReadback,
    route_decision_fingerprint: routeContext.routeDecision.fingerprint,
    route_readback_fingerprint: routeContext.routeReadback.fingerprint
  });
  logWorkerEvent({
    runId: step.run_id,
    stepId: step.id,
    laneId: step.lane_id ?? undefined,
    eventType: "worker_started",
    message: routeContext.command.display,
    metadata: {
      adapter: selectedAdapter,
      adapter_policy: routeContext.adapterPolicy,
      ...(routeContext.runnerSafety ? { runner_safety: routeContext.runnerSafety } : {}),
      ...(routeContext.command.env ? { command_env: routeContext.command.env } : {})
    }
  });

  if (selectedAdapter === "daily_ai_registered") {
    const runner_safety = runnerSafetyMetadata("billing_only");
    const result = runDailyAiRegisteredRunner({ runId: step.run_id, startedAtMs: Date.now() });
    const summarySize = result.summaryPath && existsSync(result.summaryPath) ? statSync(result.summaryPath).size : 0;
    for (const proof of result.proofs) {
      insertRunProof(step.run_id, {
        id: makeId("proof"),
        run_id: step.run_id,
        step_id: step.id,
        proof_type: proof.proofType,
        label: proof.label,
        uri: proof.uri,
        size_bytes: summarySize,
        created_at: nowIso(),
        metadata_json: proof.metadata ?? {}
      });
    }
    const completedAt = nowIso();
    const stepStatus = result.status === "complete" ? "completed" : "blocked";
    const laneStatus = result.status === "complete" ? "idle" : "blocked";
    const laneHealth = result.status === "complete" ? "good" : result.status;
    execSql(
      `UPDATE run_steps SET status=${sqlValue(stepStatus)}, completed_at=${sqlValue(completedAt)}, metadata_json=${sqlValue({
        ...metadata,
        adapter: selectedAdapter,
        command: routeContext.command,
        command_display: routeContext.command.display,
        daily_ai_status: result.status,
        daily_ai_summary_path: result.summaryPath,
        daily_ai_exit_status: result.exitStatus,
        daily_ai_signal: result.signal,
        proof_gate: result.proof_gate,
        proof_summary: result.proof_summary,
        issue_ledger_summary: result.metadata.issue_ledger_summary,
        runner_safety,
        external_action_executed: false
      })} WHERE id=${sqlValue(step.id)};
       UPDATE lanes SET status=${sqlValue(laneStatus)}, progress=${result.status === "complete" ? 100 : 50}, health=${sqlValue(
         laneHealth
       )}, updated_at=${sqlValue(completedAt)} WHERE id=${sqlValue(step.lane_id)};`
    );
    logWorkerEvent({
      runId: step.run_id,
      stepId: step.id,
      laneId: step.lane_id ?? undefined,
      eventType: result.status === "complete" ? "worker_completed" : "worker_blocked",
      message: result.proof_summary,
      metadata: {
        adapter: selectedAdapter,
        command: result.command,
        status: result.status,
        summary_path: result.summaryPath,
        proof_gate: result.proof_gate,
        exit_status: result.exitStatus,
        signal: result.signal,
        issue_ledger_summary: result.metadata.issue_ledger_summary,
        runner_safety,
        stdout_tail: result.stdoutTail,
        stderr_tail: result.stderrTail
      }
    });
    return {
      workerMode: "execute_daily_ai_registered",
      status: result.status,
      proof_gate: result.proof_gate,
      proof_summary: result.proof_summary,
      metadata: {
        ...result.metadata,
        runner_safety,
        daily_ai_executor: {
          command: result.command,
          exit_status: result.exitStatus,
          signal: result.signal,
          stdout_tail: result.stdoutTail,
          stderr_tail: result.stderrTail
        }
      }
    };
  }

  if (selectedAdapter === "nisenprints_registered") {
    const runner_safety = runnerSafetyMetadata("billing_only");
    const result = runNisenPrintsRegisteredRunner({ runId: step.run_id, startedAtMs: Date.now() });
    const summarySize = result.summaryPath && existsSync(result.summaryPath) ? statSync(result.summaryPath).size : 0;
    for (const proof of result.proofs) {
      insertRunProof(step.run_id, {
        id: makeId("proof"),
        run_id: step.run_id,
        step_id: step.id,
        proof_type: proof.proofType,
        label: proof.label,
        uri: proof.uri,
        size_bytes: summarySize,
        created_at: nowIso(),
        metadata_json: proof.metadata ?? {}
      });
    }
    const completedAt = nowIso();
    const stepStatus = result.status === "complete" ? "completed" : "blocked";
    const laneStatus = result.status === "complete" ? "idle" : "blocked";
    const laneHealth = result.status === "complete" ? "good" : result.status;
    execSql(
      `UPDATE run_steps SET status=${sqlValue(stepStatus)}, completed_at=${sqlValue(completedAt)}, metadata_json=${sqlValue({
        ...metadata,
        adapter: selectedAdapter,
        command: routeContext.command,
        command_display: routeContext.command.display,
        nisenprints_status: result.status,
        nisenprints_summary_path: result.summaryPath,
        nisenprints_exit_status: result.exitStatus,
        nisenprints_signal: result.signal,
        proof_gate: result.proof_gate,
        proof_summary: result.proof_summary,
        issue_ledger_summary: result.metadata.issue_ledger_summary,
        runner_safety
      })} WHERE id=${sqlValue(step.id)};
       UPDATE lanes SET status=${sqlValue(laneStatus)}, progress=${result.status === "complete" ? 100 : 50}, health=${sqlValue(
         laneHealth
       )}, updated_at=${sqlValue(completedAt)} WHERE id=${sqlValue(step.lane_id)};`
    );
    logWorkerEvent({
      runId: step.run_id,
      stepId: step.id,
      laneId: step.lane_id ?? undefined,
      eventType: result.status === "complete" ? "worker_completed" : "worker_blocked",
      message: result.proof_summary,
      metadata: {
        adapter: selectedAdapter,
        command: result.command,
        status: result.status,
        summary_path: result.summaryPath,
        proof_gate: result.proof_gate,
        exit_status: result.exitStatus,
        signal: result.signal,
        issue_ledger_summary: result.metadata.issue_ledger_summary,
        runner_safety,
        stdout_tail: result.stdoutTail,
        stderr_tail: result.stderrTail
      }
    });
    return {
      workerMode: "execute_nisenprints_registered",
      status: result.status,
      proof_gate: result.proof_gate,
      proof_summary: result.proof_summary,
      metadata: {
        ...result.metadata,
        runner_safety,
        nisenprints_executor: {
          command: result.command,
          exit_status: result.exitStatus,
          signal: result.signal,
          stdout_tail: result.stdoutTail,
          stderr_tail: result.stderrTail
        }
      }
    };
  }

  if (selectedAdapter === "job_submit_registered" || selectedAdapter === "job_followup_registered") {
    const runner_safety = runnerSafetyMetadata("billing_only");
    const workflowId = selectedAdapter;
    const registeredWorkerMode = selectedAdapter === "job_submit_registered" ? "execute_job_submit_registered" : "execute_job_followup_registered";
    const result = runJobManagerBrowserUseCliRegisteredRunner({ runId: step.run_id, workflowId });
    for (const proof of result.proofs) {
      insertRunProof(step.run_id, {
        id: makeId("proof"),
        run_id: step.run_id,
        step_id: step.id,
        proof_type: proof.proofType,
        label: proof.label,
        uri: proof.uri,
        size_bytes: jobManagerBrowserUseCliArtifactSize(result.artifactPath),
        created_at: nowIso(),
        metadata_json: proof.metadata ?? {}
      });
    }
    const completedAt = nowIso();
    const stepStatus = "blocked";
    const laneStatus = "blocked";
    const laneHealth = "blocked";
    execSql(
      `UPDATE run_steps SET status=${sqlValue(stepStatus)}, completed_at=${sqlValue(completedAt)}, metadata_json=${sqlValue({
        ...metadata,
        adapter: selectedAdapter,
        command: routeContext.command,
        command_display: routeContext.command.display,
        worker_mode: registeredWorkerMode,
        execution_mode: registeredWorkerMode,
        route_decision: routeContext.routeDecision ?? undefined,
        route_decision_fingerprint: routeContext.routeDecision?.fingerprint ?? null,
        route_readback: routeContext.routeReadback,
        execution_routing: routeContext.routeReadback,
        route_readback_fingerprint: routeContext.routeReadback.fingerprint,
        adapter_policy: routeContext.adapterPolicy,
        registered_browser_use_cli_status: result.status,
        registered_browser_use_cli_artifact: pathToFileUri(result.artifactPath),
        registered_browser_use_cli_exit_status: result.exitStatus,
        registered_browser_use_cli_signal: result.signal,
        proof_gate: result.proof_gate,
        proof_summary: result.proof_summary,
        issue_ledger_summary: result.metadata.issue_ledger_summary,
        runner_safety
      })} WHERE id=${sqlValue(step.id)};
       UPDATE lanes SET status=${sqlValue(laneStatus)}, progress=50, health=${sqlValue(
         laneHealth
       )}, updated_at=${sqlValue(completedAt)} WHERE id=${sqlValue(step.lane_id)};`
    );
    logWorkerEvent({
      runId: step.run_id,
      stepId: step.id,
      laneId: step.lane_id ?? undefined,
      eventType: result.status === "blocked" ? "worker_blocked" : "worker_completed",
      message: result.proof_summary,
      metadata: {
        adapter: selectedAdapter,
        command: result.command,
        status: result.status,
        artifact_path: result.artifactPath,
        proof_gate: result.proof_gate,
        exit_status: result.exitStatus,
        signal: result.signal,
        issue_ledger_summary: result.metadata.issue_ledger_summary,
        runner_safety,
        stdout_tail: result.stdoutTail,
        stderr_tail: result.stderrTail
      }
    });
    return {
      workerMode: registeredWorkerMode,
      status: result.status,
      proof_gate: result.proof_gate,
      proof_summary: result.proof_summary,
      metadata: {
        ...result.metadata,
        adapter: selectedAdapter,
        command: routeContext.command,
        command_display: routeContext.command.display,
        execution_mode: registeredWorkerMode,
        worker_mode: registeredWorkerMode,
        adapter_policy: routeContext.adapterPolicy,
        route_decision: routeContext.routeDecision ?? undefined,
        route_decision_fingerprint: routeContext.routeDecision?.fingerprint ?? null,
        route_readback: routeContext.routeReadback,
        execution_routing: routeContext.routeReadback,
        route_readback_fingerprint: routeContext.routeReadback.fingerprint,
        runner_safety,
        external_action_executed: false,
        registered_browser_use_cli_executor: {
          command: result.command,
          artifact_path: result.artifactPath,
          exit_status: result.exitStatus,
          signal: result.signal,
          stdout_tail: result.stdoutTail,
          stderr_tail: result.stderrTail
        }
      }
    };
  }

  if (selectedAdapter === "prompt_transfer_registered") {
    const result = runPromptTransferRegisteredRunner({ runId: step.run_id });
    const summarySize = promptTransferArtifactSize(result.summaryPath);
    for (const proof of result.proofs) {
      insertRunProof(step.run_id, {
        id: makeId("proof"),
        run_id: step.run_id,
        step_id: step.id,
        proof_type: proof.proofType,
        label: proof.label,
        uri: proof.uri,
        size_bytes: summarySize,
        created_at: nowIso(),
        metadata_json: proof.metadata ?? {}
      });
    }
    const completedAt = nowIso();
    const stepStatus = result.status === "blocked" ? "blocked" : "completed";
    const laneStatus = result.status === "blocked" ? "blocked" : "idle";
    const laneHealth = result.status === "blocked" ? "blocked" : "partial";
    const exactBlocker = typeof result.metadata.blocker === "string" ? result.metadata.blocker : undefined;
    execSql(
      `UPDATE run_steps SET status=${sqlValue(stepStatus)}, completed_at=${sqlValue(completedAt)}, metadata_json=${sqlValue({
        ...metadata,
        adapter: selectedAdapter,
        command: routeContext.command,
        command_display: routeContext.command.display,
        execution_mode: "execute_prompt_transfer_registered",
        prompt_transfer_status: result.status,
        prompt_transfer_summary_path: result.summaryPath,
        prompt_transfer_exit_status: result.exitStatus,
        prompt_transfer_signal: result.signal,
        exact_blocker: exactBlocker,
        proof_gate: result.proof_gate,
        proof_summary: result.proof_summary,
        runner_safety: runnerSafetyMetadata("billing_only")
      })} WHERE id=${sqlValue(step.id)};
       UPDATE lanes SET status=${sqlValue(laneStatus)}, progress=${result.status === "blocked" ? 50 : 100}, health=${sqlValue(
         laneHealth
       )}, updated_at=${sqlValue(completedAt)} WHERE id=${sqlValue(step.lane_id)};`
    );
    logWorkerEvent({
      runId: step.run_id,
      stepId: step.id,
      laneId: step.lane_id ?? undefined,
      eventType: result.status === "blocked" ? "worker_blocked" : "worker_completed",
      message: result.proof_summary,
      metadata: {
        adapter: selectedAdapter,
        command: result.command,
        status: result.status,
        summary_path: result.summaryPath,
        proof_gate: result.proof_gate,
        exit_status: result.exitStatus,
        signal: result.signal,
        runner_safety: runnerSafetyMetadata("billing_only"),
        stdout_tail: result.stdoutTail,
        stderr_tail: result.stderrTail
      }
    });
    return {
      workerMode: "execute_prompt_transfer_registered",
      status: result.status,
      proof_gate: result.proof_gate,
      proof_summary: result.proof_summary,
      metadata: {
        ...result.metadata,
        runner_safety: runnerSafetyMetadata("billing_only"),
        prompt_transfer_executor: {
          command: result.command,
          exit_status: result.exitStatus,
          signal: result.signal,
          stdout_tail: result.stdoutTail,
          stderr_tail: result.stderrTail
        }
      }
    };
  }

  if (selectedAdapter === "sns_multi_poster_registered") {
    const result = runSnsMultiPosterRegisteredRunner({ runId: step.run_id });
    const summarySize = snsMultiPosterArtifactSize(result.summaryPath);
    for (const proof of result.proofs) {
      insertRunProof(step.run_id, {
        id: makeId("proof"),
        run_id: step.run_id,
        step_id: step.id,
        proof_type: proof.proofType,
        label: proof.label,
        uri: proof.uri,
        size_bytes: summarySize,
        created_at: nowIso(),
        metadata_json: proof.metadata ?? {}
      });
    }
    const completedAt = nowIso();
    const stepStatus = result.status === "blocked" ? "blocked" : "completed";
    const laneStatus = result.status === "blocked" ? "blocked" : "idle";
    const laneHealth = result.status === "blocked" ? "blocked" : "partial";
    const exactBlocker = typeof result.metadata.blocker === "string" ? result.metadata.blocker : undefined;
    const externalActionExecuted = result.metadata.external_action_executed === true;
    execSql(
      `UPDATE run_steps SET status=${sqlValue(stepStatus)}, completed_at=${sqlValue(completedAt)}, metadata_json=${sqlValue({
        ...metadata,
        adapter: selectedAdapter,
        command: routeContext.command,
        command_display: routeContext.command.display,
        execution_mode: "execute_sns_multi_poster_registered",
        sns_multi_poster_status: result.status,
        sns_multi_poster_summary_path: result.summaryPath,
        sns_multi_poster_exit_status: result.exitStatus,
        sns_multi_poster_signal: result.signal,
        exact_blocker: exactBlocker,
        proof_gate: result.proof_gate,
        proof_summary: result.proof_summary,
        runner_safety: runnerSafetyMetadata("billing_only"),
        external_action_executed: externalActionExecuted
      })} WHERE id=${sqlValue(step.id)};
       UPDATE lanes SET status=${sqlValue(laneStatus)}, progress=${result.status === "blocked" ? 50 : 100}, health=${sqlValue(
         laneHealth
       )}, updated_at=${sqlValue(completedAt)} WHERE id=${sqlValue(step.lane_id)};`
    );
    logWorkerEvent({
      runId: step.run_id,
      stepId: step.id,
      laneId: step.lane_id ?? undefined,
      eventType: result.status === "blocked" ? "worker_blocked" : "worker_completed",
      message: result.proof_summary,
      metadata: {
        adapter: selectedAdapter,
        command: result.command,
        status: result.status,
        summary_path: result.summaryPath,
        proof_gate: result.proof_gate,
        exit_status: result.exitStatus,
        signal: result.signal,
        runner_safety: runnerSafetyMetadata("billing_only"),
        stdout_tail: result.stdoutTail,
        stderr_tail: result.stderrTail,
        external_action_executed: externalActionExecuted
      }
    });
    return {
      workerMode: "execute_sns_multi_poster_registered",
      status: result.status,
      proof_gate: result.proof_gate,
      proof_summary: result.proof_summary,
      metadata: {
        ...result.metadata,
        runner_safety: runnerSafetyMetadata("billing_only"),
        external_action_executed: externalActionExecuted,
        sns_multi_poster_executor: {
          command: result.command,
          exit_status: result.exitStatus,
          signal: result.signal,
          stdout_tail: result.stdoutTail,
          stderr_tail: result.stderrTail
        }
      }
    };
  }

  if (isHumanInputRequiredWithEvidenceAdapter(selectedAdapter)) {
    const result = humanInputRequiredWithEvidenceRunner({ adapter: selectedAdapter, runId: step.run_id, stepId: step.id, command: routeContext.command, createdAt: now });
    insertRunProof(step.run_id, {
      id: makeId("proof"),
      run_id: step.run_id,
      step_id: step.id,
      proof_type: result.proofType,
      label: result.label,
      uri: result.artifact.uri,
      size_bytes: result.artifact.sizeBytes,
      created_at: nowIso(),
      metadata_json: result.metadata
    });
    const completedAt = nowIso();
    execSql(
      `UPDATE run_steps SET status='blocked', completed_at=${sqlValue(completedAt)}, metadata_json=${sqlValue({
        ...metadata,
        adapter: selectedAdapter,
        command: routeContext.command,
        command_display: routeContext.command.display,
        execution_mode: "human_input_required_with_evidence",
        registered_workflow_id: result.workflowId,
        exact_blocker: result.exactBlocker,
        proof_gate: result.proof_gate,
        proof_summary: result.proof_summary,
        dry_run: true,
        external_action_executed: false,
        runner_safety: runnerSafetyMetadata("billing_only"),
        human_input_required_with_evidence_artifact: result.artifact.uri
      })} WHERE id=${sqlValue(step.id)};
       UPDATE lanes SET status='blocked', progress=50, health='blocked', updated_at=${sqlValue(completedAt)} WHERE id=${sqlValue(step.lane_id)};`
    );
    logWorkerEvent({
      runId: step.run_id,
      stepId: step.id,
      laneId: step.lane_id ?? undefined,
      eventType: "worker_blocked",
      message: result.proof_summary,
      metadata: result.metadata
    });
    return {
      workerMode: "human_input_required_with_evidence",
      status: "blocked",
      proof_gate: result.proof_gate,
      proof_summary: result.proof_summary,
      metadata: {
        exact_blocker: result.exactBlocker,
        human_input_required_with_evidence: {
          adapter: selectedAdapter,
          workflow_id: result.workflowId,
          artifact_uri: result.artifact.uri,
          dryRun: true,
          externalActionExecuted: false,
          mode: "human_input_required_with_evidence",
          approvalBoundary: "billing_purchase_payment_checkout_hard_stop",
          hardStops: ["billing", "purchase", "payment", "checkout"]
        },
        external_action_executed: false,
        runner_safety: runnerSafetyMetadata("billing_only")
      }
    };
  }

  if (selectedAdapter === "browser_use_cli") {
    // The contract is a pure fact gate. It must be present and bound to this
    // exact worker step before any adapter/helper/process handoff is possible.
    // This branch remains stop-only even when the contract is valid; execution
    // wiring is intentionally deferred to a separately approved packet.
    const contractExpected = {
      run_id: step.run_id,
      stage_id: typeof metadata.stage_id === "string" ? metadata.stage_id : undefined,
      attempt_id: typeof metadata.attempt_id === "string" ? metadata.attempt_id : undefined,
      session_id:
        typeof metadata.session_id === "string"
          ? metadata.session_id
          : typeof metadata.browser_use_session === "string"
            ? metadata.browser_use_session
            : undefined,
      authority_digest:
        typeof metadata.authority_digest === "string"
          ? metadata.authority_digest
          : typeof metadata.browser_use_authority_digest === "string"
            ? metadata.browser_use_authority_digest
            : undefined,
      allowed_origin:
        typeof metadata.allowed_origin === "string"
          ? metadata.allowed_origin
          : typeof metadata.browser_use_allowed_origin === "string"
            ? metadata.browser_use_allowed_origin
            : undefined
    };
    const contractResult = validateServiceReadinessBrowserUseAuthorizedAdapterContractV1(
      metadata.browser_use_authorized_adapter_contract,
      contractExpected
    );
    // This packet does not authorize a positive handoff. Even a valid-looking
    // pure contract remains unverified at the executable boundary.
    const exactBlocker = SERVICE_READINESS_BROWSER_USE_AUTHORIZED_ADAPTER_CONTRACT_BLOCKER;
    const adapterContractValidation = contractResult.ok ? "valid_shape" : "invalid_shape";
    const artifact = writeNamedWorkerArtifact(step.run_id, `${step.id}-browser-use-cli-blocked.json`, {
      runId: step.run_id,
      stepId: step.id,
      task: step.name,
      adapter: "browser_use_cli",
      mode: "browser_use_cli",
      status: "blocked",
      exactBlocker,
      adapter_contract_status: "unverified",
      adapter_contract_validation: adapterContractValidation,
      browser_surface: "browser_use_cli",
      browser_adapter: browserUseAdapterEntryPoint,
      browser_helper: browserUseHelper,
      browser_runtime_config: browserUseRuntimeConfig,
      external_action_executed: false,
      cleanup_verified: false,
      helper_launched: false,
      command: routeContext.command,
      commandDisplay: routeContext.command.display,
      lane: routeContext.lane,
      createdAt: now
    });
    insertRunProof(step.run_id, {
      id: makeId("proof"),
      run_id: step.run_id,
      step_id: step.id,
      proof_type: "browser_use_blocked",
      label: `Browser Use CLI blocked: ${step.name}`,
      uri: artifact.uri,
      size_bytes: artifact.sizeBytes,
      created_at: nowIso(),
      metadata_json: {
        adapter: "browser_use_cli",
        exact_blocker: exactBlocker,
        adapter_contract_status: "unverified",
        adapter_contract_validation: adapterContractValidation,
        helper_launched: false,
        external_action_executed: false
      }
    });
    const completedAt = nowIso();
    execSql(
      `UPDATE run_steps SET status='blocked', completed_at=${sqlValue(completedAt)}, metadata_json=${sqlValue({
        ...metadata,
        adapter: "browser_use_cli",
        command: routeContext.command,
        command_display: routeContext.command.display,
        execution_mode: "execute_browser_use",
        worker_mode: "execute_browser_use",
        adapter_policy: routeContext.adapterPolicy,
        route_decision: routeContext.routeDecision ?? undefined,
        route_decision_fingerprint: routeContext.routeDecision?.fingerprint ?? null,
        route_readback: routeContext.routeReadback,
        execution_routing: routeContext.routeReadback,
        route_readback_fingerprint: routeContext.routeReadback.fingerprint,
        browser_use_status: "blocked",
        browser_use_exact_blocker: exactBlocker,
        browser_use_adapter_contract_status: "unverified",
        browser_use_adapter_contract_validation: adapterContractValidation,
        browser_use_artifact: artifact.uri,
        helper_launched: false,
        external_action_executed: false
      })} WHERE id=${sqlValue(step.id)};
       UPDATE lanes SET status='blocked', progress=50, health='blocked', updated_at=${sqlValue(completedAt)} WHERE id=${sqlValue(step.lane_id)};`
    );
    logWorkerEvent({
      runId: step.run_id,
      stepId: step.id,
      laneId: step.lane_id ?? undefined,
      eventType: "worker_blocked",
      message: `Browser Use CLI blocked: ${exactBlocker}`,
      metadata: { adapter: "browser_use_cli", artifact, exact_blocker: exactBlocker, helper_launched: false }
    });
    return {
      workerMode: "execute_browser_use",
      status: "blocked",
      proof_gate: { ok: false, missing: [exactBlocker], present: ["browser_use_blocked", `browser_use_blocked:${step.id}`] },
      proof_summary: `blocked: ${exactBlocker}`,
      metadata: {
        browser_use_executor: {
          status: "blocked",
          exact_blocker: exactBlocker,
          adapter_contract_status: "unverified",
          adapter_contract_validation: adapterContractValidation,
          artifact_uri: artifact.uri,
          helper_launched: false,
          external_action_executed: false
        }
      }
    };
  }

  if (selectedAdapter === "playwright_cli") {
    // Historical metadata may still name this adapter, but its execution
    // surface is now canonical Browser Use CLI only.
    const normalizedAdapter: WorkerAdapter = "browser_use_cli";
    const result = runBrowserUseLocalCheck({ command: routeContext.command.bin, env: routeContext.command.env });
    const exactBlocker =
      result.status === "ok"
        ? null
        : result.metadata.missingArtifacts[0]
          ? `browser_use_artifact_missing:${result.metadata.missingArtifacts[0]}`
            : (result.consoleErrorCount ?? 0) > 0
            ? "browser_use_console_errors"
            : "browser_use_check_blocked";
    const artifact = writeNamedWorkerArtifact(step.run_id, `${step.id}-browser-use-check.json`, {
      runId: step.run_id,
      stepId: step.id,
      task: step.name,
      adapter: normalizedAdapter,
      mode: "browser_use_cli",
      status: result.status,
      targetUrl: result.targetUrl,
      exactBlocker,
        command: routeContext.command,
        commandDisplay: routeContext.command.display,
        lane: routeContext.lane,
        browserUseCheck: result,
        createdAt: now
    });
    insertRunProof(step.run_id, {
        id: makeId("proof"),
        run_id: step.run_id,
        step_id: step.id,
        proof_type: result.status === "ok" ? "browser_use_check" : "browser_use_blocked",
        label: `Browser Use CLI check: ${step.name}`,
        uri: artifact.uri,
        size_bytes: artifact.sizeBytes,
        created_at: nowIso(),
        metadata_json: {
          adapter: normalizedAdapter,
          command: routeContext.command,
          command_display: routeContext.command.display,
          execution_mode: "execute_browser_use",
          status: result.status,
          exact_blocker: exactBlocker,
        check_id: result.id
      }
    });
    const completedAt = nowIso();
    const stepStatus = result.status === "ok" ? "completed" : "blocked";
    const laneStatus = result.status === "ok" ? "idle" : "blocked";
    const laneHealth = result.status === "ok" ? "good" : "blocked";
    execSql(
      `UPDATE run_steps SET status=${sqlValue(stepStatus)}, completed_at=${sqlValue(completedAt)}, metadata_json=${sqlValue({
        ...metadata,
        adapter: normalizedAdapter,
        command: routeContext.command,
        command_display: routeContext.command.display,
        execution_mode: "execute_browser_use",
        browser_use_status: result.status,
        browser_use_check_artifact: artifact.uri,
        browser_use_exact_blocker: exactBlocker
      })} WHERE id=${sqlValue(step.id)};
       UPDATE lanes SET status=${sqlValue(laneStatus)}, progress=${result.status === "ok" ? 100 : 50}, health=${sqlValue(laneHealth)}, updated_at=${sqlValue(
         completedAt
       )} WHERE id=${sqlValue(step.lane_id)};`
    );
    logWorkerEvent({
      runId: step.run_id,
      stepId: step.id,
      laneId: step.lane_id ?? undefined,
      eventType: result.status === "ok" ? "worker_completed" : "worker_blocked",
      message: result.status === "ok" ? `Browser Use CLI check completed at ${artifact.uri}` : `Browser Use CLI check blocked: ${exactBlocker}`,
      metadata: { adapter: normalizedAdapter, artifact, status: result.status, exact_blocker: exactBlocker }
    });
    return {
      workerMode: "execute_browser_use",
      status: result.status === "ok" ? "complete" : "blocked",
      proof_gate:
        result.status === "ok"
          ? { ok: true, missing: [], present: ["browser_use_check", `browser_use_check:${step.id}`] }
          : { ok: false, missing: [exactBlocker ?? "browser_use_check_blocked"], present: ["browser_use_blocked", `browser_use_blocked:${step.id}`] },
      proof_summary: result.status === "ok" ? "complete: Browser Use CLI screen proof captured" : `blocked: ${exactBlocker}`,
      metadata: {
        browser_use_executor: {
          status: result.status,
          exact_blocker: exactBlocker,
          artifact_uri: artifact.uri
        }
      }
    };
  }

  if (shouldExecuteCodexReadonly(selectedAdapter)) {
    launchCodexReadonlyStep({
      step,
      metadata,
      command: routeContext.command,
      lane: routeContext.lane,
      createdAt: now
    });
    return;
  }

  if (selectedAdapter === "child_codex") {
    launchChildCodexReadonlyStep({
      step,
      metadata,
      command: routeContext.command,
      lane: routeContext.lane,
      createdAt: now
    });
    return;
  }

  const artifact = writeWorkerArtifact(step.run_id, step.id, {
    runId: step.run_id,
    stepId: step.id,
    task: step.name,
    adapter: selectedAdapter,
    command: routeContext.command,
    commandDisplay: routeContext.command.display,
    lane: routeContext.lane,
    resources: metadata.resources ?? [],
    ai: selectedAdapter === "codex_cli" ? "codex_cli_subscription_lane" : "local_worker_lane",
    openaiApiRequired: false,
    mode: "receipt_only",
    createdAt: now
  });

  insertRunProof(step.run_id, {
    id: makeId("proof"),
    run_id: step.run_id,
    step_id: step.id,
    proof_type: "worker_receipt",
    label: `${selectedAdapter} receipt: ${step.name}`,
    uri: artifact.uri,
    size_bytes: artifact.sizeBytes,
    created_at: nowIso(),
    metadata_json: { adapter: selectedAdapter, command: routeContext.command, command_display: routeContext.command.display, execution_mode: "receipt_only", receipt_only: true }
  });

  execSql(
    `UPDATE run_steps SET status='completed', completed_at=${sqlValue(nowIso())}, metadata_json=${sqlValue({
      ...metadata,
      adapter: selectedAdapter,
      command: routeContext.command,
      command_display: routeContext.command.display,
      execution_mode: "receipt_only",
      worker_receipt_artifact: artifact.uri,
      receipt_only: true
    })} WHERE id=${sqlValue(step.id)};
     UPDATE lanes SET status='idle', progress=100, updated_at=${sqlValue(nowIso())} WHERE id=${sqlValue(step.lane_id)};`
  );
  logWorkerEvent({
    runId: step.run_id,
    stepId: step.id,
    laneId: step.lane_id ?? undefined,
    eventType: "worker_completed",
    message: `Receipt captured at ${artifact.uri}`,
    metadata: { adapter: selectedAdapter, artifact }
  });
}

function legacyProofOnlyExternalWriteBoundaryMode(): string {
  return ["proof", "only", "external", "write", "boundary"].join("_");
}

function shouldExecuteCodexReadonly(adapter: WorkerAdapter): boolean {
  return adapter === "codex_cli" && process.env.AUTOMATION_OS_EXECUTE_CODEX === "1";
}

function launchCodexReadonlyStep(input: {
  step: StepRow;
  metadata: Record<string, unknown>;
  command: WorkerCommandSpec;
  lane?: LaneRow;
  createdAt: string;
}): void {
  const childRunId = makeId("child");
  const promptText = [`# Codex read-only task`, ``, `Run ID: ${input.step.run_id}`, `Step ID: ${input.step.id}`, `Task: ${input.step.name}`, `Command: ${input.command.display}`].join("\n");
  const promptArtifact = writeTextArtifact(input.step.run_id, `${input.step.id}-codex-prompt.txt`, promptText);
  startChildRunLedger({
    childRunId,
    step: input.step,
    role: "codex_cli",
    promptUri: promptArtifact.uri,
    command: input.command,
    metadata: { adapter: "codex_cli", execution_mode: "execute_codex_readonly" },
    createdAt: input.createdAt
  });
  execSql(
    `UPDATE run_steps SET metadata_json=${sqlValue({
      ...input.metadata,
      adapter: "codex_cli",
      command: input.command,
      command_display: input.command.display,
      execution_mode: "execute_codex_readonly",
      child_run_id: childRunId,
      prompt_uri: promptArtifact.uri
    })} WHERE id=${sqlValue(input.step.id)};`
  );
  void runCodexReadonlyStep({ ...input, childRunId })
    .then((result) => finalizeCodexReadonlyStep({ ...input, childRunId, promptArtifact, result }))
    .catch((error: unknown) =>
      finalizeCodexReadonlyStep({
        ...input,
        childRunId,
        promptArtifact,
        result: codexReadonlyErrorResult(input, error)
      })
    );
}

function launchChildCodexReadonlyStep(input: {
  step: StepRow;
  metadata: Record<string, unknown>;
  command: WorkerCommandSpec;
  lane?: LaneRow;
  createdAt: string;
}): void {
  const childRunId = makeId("child");
  const promptText = [`# Child Codex read-only task`, ``, `Run ID: ${input.step.run_id}`, `Step ID: ${input.step.id}`, `Task: ${input.step.name}`, `Command: ${input.command.display}`].join("\n");
  const command = { ...input.command, args: [...input.command.args.slice(0, -1), promptText] };
  const promptArtifact = writeTextArtifact(input.step.run_id, `${input.step.id}-child-prompt.txt`, promptText);
  startChildRunLedger({
    childRunId,
    step: input.step,
    role: "child_codex",
    promptUri: promptArtifact.uri,
    command,
    metadata: { adapter: "child_codex", execution_mode: "child_codex" },
    createdAt: input.createdAt
  });
  execSql(
    `UPDATE run_steps SET metadata_json=${sqlValue({
      ...input.metadata,
      adapter: "child_codex",
      command,
      command_display: command.display,
      execution_mode: "child_codex",
      child_run_id: childRunId,
      prompt_uri: promptArtifact.uri
    })} WHERE id=${sqlValue(input.step.id)};`
  );
  void runChildCodexReadonlyStep({ ...input, command, childRunId, promptArtifact })
    .then((result) => finalizeChildCodexReadonlyStep({ ...input, childRunId, promptArtifact, result }))
    .catch((error: unknown) =>
      finalizeChildCodexReadonlyStep({
        ...input,
        childRunId,
        promptArtifact,
        result: childCodexErrorResult(input, command, childRunId, promptArtifact, error)
      })
    );
}

function startChildRunLedger(input: {
  childRunId: string;
  step: StepRow;
  role: "codex_cli" | "child_codex";
  promptUri: string;
  command: WorkerCommandSpec;
  metadata: Record<string, unknown>;
  createdAt: string;
}) {
  insert("child_runs", {
    id: input.childRunId,
    parent_run_id: input.step.run_id,
    step_id: input.step.id,
    role: input.role,
    prompt_uri: input.promptUri,
    status: "running",
    pid: null,
    exit_status: null,
    signal: null,
    result_uri: null,
    summary: `${input.role} read-only execution started`,
    blocker: null,
    created_at: input.createdAt,
    started_at: input.createdAt,
    completed_at: null,
    metadata_json: {
      ...input.metadata,
      command: input.command,
      command_display: input.command.display,
      prompt_uri: input.promptUri
    }
  });
}

async function runCodexReadonlyStep(input: {
  step: StepRow;
  metadata: Record<string, unknown>;
  command: WorkerCommandSpec;
  lane?: LaneRow;
  createdAt: string;
  childRunId: string;
}): Promise<CodexReadonlyExecutionResult> {
  const timeoutMs = codexReadonlyTimeoutMs();
  const result = await runWorkerProcess(input.command, {
    cwd: resolveWorkerWorkspacePath(undefined, process.env.AUTOMATION_OS_WORKER_WORKSPACE_ROOT),
    env: safeWorkerEnvironment(process.env, { overrides: input.command.env }),
    timeoutMs,
    onSpawn: (pid) => recordChildRunPid(input.childRunId, pid)
  });
  const stderrTail = tail([result.stderr, result.timedOut ? `Automation OS Codex read-only execution timed out after ${timeoutMs}ms` : undefined, result.errorMessage]
    .filter(Boolean)
    .join("\n"));
  const succeeded = result.status === 0 && !result.timedOut && !result.errorMessage;
  const proofType = succeeded ? "codex_readonly_execution" : "codex_readonly_blocked";
  const artifact = writeWorkerArtifact(input.step.run_id, input.step.id, {
    runId: input.step.run_id,
    stepId: input.step.id,
    task: input.step.name,
    adapter: "codex_cli",
    mode: "execute_codex_readonly",
    exitStatus: result.status,
    signal: result.signal,
    stdoutTail: tail(result.stdout),
    stderrTail,
    command: input.command,
    commandDisplay: input.command.display,
    lane: input.lane,
    resources: input.metadata.resources ?? [],
    createdAt: input.createdAt,
    timedOut: result.timedOut,
    errorMessage: result.errorMessage
  });

  return {
    artifact,
    proofType,
    stepStatus: succeeded ? "completed" : "blocked",
    laneStatus: succeeded ? "idle" : "blocked",
    laneProgress: succeeded ? 100 : 50,
    laneHealth: succeeded ? "good" : "blocked",
    ...(result.pid ? { pid: result.pid } : {}),
    exitStatus: result.status,
    signal: result.signal,
    stdoutTail: tail(result.stdout),
    stderrTail,
    timedOut: result.timedOut,
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {})
  };
}

async function runChildCodexReadonlyStep(input: {
  step: StepRow;
  metadata: Record<string, unknown>;
  command: WorkerCommandSpec;
  lane?: LaneRow;
  createdAt: string;
  childRunId: string;
  promptArtifact: ReturnType<typeof writeTextArtifact>;
}): Promise<ChildCodexExecutionResult> {
  const timeoutMs = childCodexReadonlyTimeoutMs();
  const result = await runWorkerProcess(input.command, {
    cwd: resolveWorkerWorkspacePath(undefined, process.env.AUTOMATION_OS_WORKER_WORKSPACE_ROOT),
    env: safeWorkerEnvironment(process.env, { overrides: input.command.env }),
    timeoutMs,
    onSpawn: (pid) => recordChildRunPid(input.childRunId, pid)
  });
  const stderrTail = tail([result.stderr, result.timedOut ? `Automation OS child Codex read-only execution timed out after ${timeoutMs}ms` : undefined, result.errorMessage]
    .filter(Boolean)
    .join("\n"));
  const stdoutTail = tail(result.stdout);
  const succeeded = result.status === 0 && !result.timedOut && !result.errorMessage;
  const blocker = succeeded ? undefined : result.errorMessage ?? (stderrTail || `child_codex exited with ${result.status ?? "unknown status"}`);
  const proofType = succeeded ? "child_codex_result" : "child_codex_blocked";
  const resultArtifact = writeNamedWorkerArtifact(input.step.run_id, `${input.step.id}-child-result.json`, {
    runId: input.step.run_id,
    stepId: input.step.id,
    childRunId: input.childRunId,
    task: input.step.name,
    adapter: "child_codex",
    mode: "child_codex",
    exitStatus: result.status,
    signal: result.signal,
    stdoutTail,
    stderrTail,
    command: input.command,
    commandDisplay: input.command.display,
    lane: input.lane,
    resources: input.metadata.resources ?? [],
    promptUri: input.promptArtifact.uri,
    createdAt: input.createdAt,
    timedOut: result.timedOut,
    ...(blocker ? { blocker } : {}),
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {})
  });

  return {
    resultArtifact,
    promptArtifact: input.promptArtifact,
    command: input.command,
    proofType,
    stepStatus: succeeded ? "completed" : "blocked",
    laneStatus: succeeded ? "idle" : "blocked",
    laneProgress: succeeded ? 100 : 50,
    laneHealth: succeeded ? "good" : "blocked",
    childRunId: input.childRunId,
    ...(result.pid ? { pid: result.pid } : {}),
    exitStatus: result.status,
    signal: result.signal,
    stdoutTail,
    stderrTail,
    timedOut: result.timedOut,
    ...(blocker ? { blocker } : {}),
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {})
  };
}

function finalizeCodexReadonlyStep(input: {
  step: StepRow;
  metadata: Record<string, unknown>;
  command: WorkerCommandSpec;
  childRunId: string;
  promptArtifact: ReturnType<typeof writeTextArtifact>;
  result: CodexReadonlyExecutionResult;
}) {
  const completedAt = nowIso();
  const summary =
    input.result.stepStatus === "completed" ? "Codex read-only execution completed" : "Codex read-only execution blocked";
  execSql(
    `UPDATE child_runs SET status=${sqlValue(input.result.stepStatus === "completed" ? "completed" : "blocked")},
       pid=${sqlValue(input.result.pid)},
       exit_status=${sqlValue(input.result.exitStatus)},
       signal=${sqlValue(input.result.signal)},
       result_uri=${sqlValue(input.result.artifact.uri)},
       summary=${sqlValue(summary)},
       blocker=${sqlValue(input.result.stepStatus === "completed" ? null : input.result.errorMessage ?? input.result.stderrTail)},
       completed_at=${sqlValue(completedAt)},
       metadata_json=${sqlValue({
         adapter: "codex_cli",
         command: input.command,
         command_display: input.command.display,
         execution_mode: "execute_codex_readonly",
         prompt_uri: input.promptArtifact.uri,
         result_uri: input.result.artifact.uri,
         timed_out: input.result.timedOut,
         stdout_tail: input.result.stdoutTail,
         stderr_tail: input.result.stderrTail,
         ...(input.result.errorMessage ? { error_message: input.result.errorMessage } : {})
       })}
     WHERE id=${sqlValue(input.childRunId)};`
  );
  insertRunProof(input.step.run_id, {
    id: makeId("proof"),
    run_id: input.step.run_id,
    step_id: input.step.id,
    proof_type: input.result.proofType,
    label: `codex_cli read-only execution: ${input.step.name}`,
    uri: input.result.artifact.uri,
    size_bytes: input.result.artifact.sizeBytes,
    created_at: completedAt,
    metadata_json: {
      adapter: "codex_cli",
      command: input.command,
      command_display: input.command.display,
      execution_mode: "execute_codex_readonly",
      child_run_id: input.childRunId,
      prompt_uri: input.promptArtifact.uri,
      exit_status: input.result.exitStatus,
      signal: input.result.signal,
      timed_out: input.result.timedOut,
      stdout_tail: input.result.stdoutTail,
      stderr_tail: input.result.stderrTail,
      ...(input.result.errorMessage ? { error_message: input.result.errorMessage } : {})
    }
  });
  execSql(
    `UPDATE run_steps SET status=${sqlValue(input.result.stepStatus)}, completed_at=${sqlValue(completedAt)}, metadata_json=${sqlValue({
      ...input.metadata,
      adapter: "codex_cli",
      command: input.command,
      command_display: input.command.display,
      execution_mode: "execute_codex_readonly",
      child_run_id: input.childRunId,
      prompt_uri: input.promptArtifact.uri,
      codex_readonly_artifact: input.result.artifact.uri,
      codex_readonly_exit_status: input.result.exitStatus,
      codex_readonly_signal: input.result.signal,
      codex_readonly_timed_out: input.result.timedOut,
      ...(input.result.errorMessage ? { codex_readonly_error_message: input.result.errorMessage } : {})
    })} WHERE id=${sqlValue(input.step.id)};
     UPDATE lanes SET status=${sqlValue(input.result.laneStatus)}, progress=${input.result.laneProgress}, health=${sqlValue(
       input.result.laneHealth
     )}, updated_at=${sqlValue(completedAt)} WHERE id=${sqlValue(input.step.lane_id)};`
  );
  logWorkerEvent({
    runId: input.step.run_id,
    stepId: input.step.id,
    laneId: input.step.lane_id ?? undefined,
    eventType: input.result.stepStatus === "completed" ? "worker_completed" : "worker_blocked",
    message:
      input.result.stepStatus === "completed"
        ? `Codex read-only execution completed at ${input.result.artifact.uri}`
        : `Codex read-only execution blocked at ${input.result.artifact.uri}`,
    metadata: {
      adapter: "codex_cli",
      child_run_id: input.childRunId,
      artifact: input.result.artifact,
      exit_status: input.result.exitStatus,
      signal: input.result.signal,
      timed_out: input.result.timedOut,
      stdout_tail: input.result.stdoutTail,
      stderr_tail: input.result.stderrTail,
      ...(input.result.errorMessage ? { error_message: input.result.errorMessage } : {})
    }
  });
  refreshRunStatusAfterAsyncWorker(input.step, "codex_cli", input.childRunId);
}

function finalizeChildCodexReadonlyStep(input: {
  step: StepRow;
  metadata: Record<string, unknown>;
  childRunId: string;
  promptArtifact: ReturnType<typeof writeTextArtifact>;
  result: ChildCodexExecutionResult;
}) {
  if (!claimRunningChildRunForFinalize(input.childRunId)) {
    logLateFinalizeSkipped({
      step: input.step,
      adapter: "child_codex",
      childRunId: input.childRunId,
      artifact: input.result.resultArtifact,
      proofType: input.result.proofType,
      exitStatus: input.result.exitStatus,
      signal: input.result.signal,
      timedOut: input.result.timedOut,
      blocker: input.result.blocker ?? input.result.errorMessage
    });
    return;
  }
  const completedAt = nowIso();
  execSql(
    `UPDATE child_runs SET status=${sqlValue(input.result.stepStatus === "completed" ? "completed" : "blocked")},
       pid=${sqlValue(input.result.pid)},
       exit_status=${sqlValue(input.result.exitStatus)},
       signal=${sqlValue(input.result.signal)},
       result_uri=${sqlValue(input.result.resultArtifact.uri)},
       summary=${sqlValue(input.result.stepStatus === "completed" ? "child Codex read-only execution completed" : "child Codex read-only execution blocked")},
       blocker=${sqlValue(input.result.blocker ?? null)},
       completed_at=${sqlValue(completedAt)},
       metadata_json=${sqlValue({
         adapter: "child_codex",
         command: input.result.command,
         command_display: input.result.command.display,
         execution_mode: "child_codex",
         prompt_uri: input.promptArtifact.uri,
         result_uri: input.result.resultArtifact.uri,
         timed_out: input.result.timedOut,
         stdout_tail: input.result.stdoutTail,
         stderr_tail: input.result.stderrTail,
         ...(input.result.errorMessage ? { error_message: input.result.errorMessage } : {})
       })}
     WHERE id=${sqlValue(input.childRunId)};`
  );
  insertRunProof(input.step.run_id, {
    id: makeId("proof"),
    run_id: input.step.run_id,
    step_id: input.step.id,
    proof_type: input.result.proofType,
    label: `child_codex read-only result: ${input.step.name}`,
    uri: input.result.resultArtifact.uri,
    size_bytes: input.result.resultArtifact.sizeBytes,
    created_at: completedAt,
    metadata_json: {
      adapter: "child_codex",
      command: input.result.command,
      command_display: input.result.command.display,
      execution_mode: "child_codex",
      child_run_id: input.childRunId,
      prompt_uri: input.promptArtifact.uri,
      exit_status: input.result.exitStatus,
      signal: input.result.signal,
      timed_out: input.result.timedOut,
      stdout_tail: input.result.stdoutTail,
      stderr_tail: input.result.stderrTail,
      ...(input.result.blocker ? { blocker: input.result.blocker } : {}),
      ...(input.result.errorMessage ? { error_message: input.result.errorMessage } : {})
    }
  });
  execSql(
    `UPDATE run_steps SET status=${sqlValue(input.result.stepStatus)}, completed_at=${sqlValue(completedAt)}, metadata_json=${sqlValue({
      ...input.metadata,
      adapter: "child_codex",
      command: input.result.command,
      command_display: input.result.command.display,
      execution_mode: "child_codex",
      child_run_id: input.childRunId,
      prompt_uri: input.promptArtifact.uri,
      child_codex_result_artifact: input.result.resultArtifact.uri,
      child_codex_exit_status: input.result.exitStatus,
      child_codex_signal: input.result.signal,
      child_codex_timed_out: input.result.timedOut,
      ...(input.result.blocker ? { child_codex_blocker: input.result.blocker } : {}),
      ...(input.result.errorMessage ? { child_codex_error_message: input.result.errorMessage } : {})
    })} WHERE id=${sqlValue(input.step.id)};
     UPDATE lanes SET status=${sqlValue(input.result.laneStatus)}, progress=${input.result.laneProgress}, health=${sqlValue(
       input.result.laneHealth
     )}, updated_at=${sqlValue(completedAt)} WHERE id=${sqlValue(input.step.lane_id)};`
  );
  logWorkerEvent({
    runId: input.step.run_id,
    stepId: input.step.id,
    laneId: input.step.lane_id ?? undefined,
    eventType: input.result.stepStatus === "completed" ? "worker_completed" : "worker_blocked",
    message:
      input.result.stepStatus === "completed"
        ? `Child Codex read-only execution completed at ${input.result.resultArtifact.uri}`
        : `Child Codex read-only execution blocked at ${input.result.resultArtifact.uri}`,
    metadata: {
      adapter: "child_codex",
      child_run_id: input.childRunId,
      prompt_artifact: input.promptArtifact,
      result_artifact: input.result.resultArtifact,
      exit_status: input.result.exitStatus,
      signal: input.result.signal,
      timed_out: input.result.timedOut,
      stdout_tail: input.result.stdoutTail,
      stderr_tail: input.result.stderrTail,
      ...(input.result.blocker ? { blocker: input.result.blocker } : {}),
      ...(input.result.errorMessage ? { error_message: input.result.errorMessage } : {})
    }
  });
  refreshRunStatusAfterAsyncWorker(input.step, "child_codex", input.childRunId);
}

function claimRunningChildRunForFinalize(childRunId: string): boolean {
  const current = querySql<{ status: string }>(`SELECT status FROM child_runs WHERE id=${sqlValue(childRunId)} LIMIT 1`)[0];
  return current?.status === "running";
}

function logLateFinalizeSkipped(input: {
  step: StepRow;
  adapter: "codex_cli" | "child_codex";
  childRunId: string;
  artifact: { uri: string; sizeBytes: number };
  proofType: string;
  exitStatus: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  blocker?: string;
}) {
  logWorkerEvent({
    runId: input.step.run_id,
    stepId: input.step.id,
    laneId: input.step.lane_id ?? undefined,
    eventType: "worker_late_finalize_skipped",
    message: `${input.adapter} late finalize skipped because child run was already reconciled`,
    metadata: {
      adapter: input.adapter,
      child_run_id: input.childRunId,
      skipped_proof_type: input.proofType,
      late_artifact: input.artifact,
      exit_status: input.exitStatus,
      signal: input.signal,
      timed_out: input.timedOut,
      ...(input.blocker ? { blocker: input.blocker } : {})
    }
  });
}

function refreshRunStatusAfterAsyncWorker(step: StepRow, adapter: "codex_cli" | "child_codex", childRunId: string) {
  void runWorkerCycle(step.run_id).catch((error: unknown) => {
    logWorkerEvent({
      runId: step.run_id,
      stepId: step.id,
      laneId: step.lane_id ?? undefined,
      eventType: "worker_blocked",
      message: `Failed to refresh run status after ${adapter} execution: ${errorToMessage(error)}`,
      metadata: { adapter, child_run_id: childRunId, error_message: errorToMessage(error) }
    });
  });
}

function recordChildRunPid(childRunId: string, pid: number) {
  execSql(
    `UPDATE child_runs SET pid=${pid}, metadata_json=json_patch(metadata_json, ${sqlValue({ spawned_pid: pid })}) WHERE id=${sqlValue(
      childRunId
    )} AND status='running';`
  );
}

function reconcileStaleChildCodexRuns(runId: string) {
  const staleAfterMs = childCodexReadonlyTimeoutMs() + workerProcessKillGraceMs();
  const nowMs = Date.now();
  const children = querySql<{
    id: string;
    parent_run_id: string;
    step_id: string | null;
    role: string;
    prompt_uri: string;
    status: string;
    pid: number | null;
    started_at: string | null;
    metadata_json: string;
  }>(
    `SELECT id, parent_run_id, step_id, role, prompt_uri, status, pid, started_at, metadata_json
       FROM child_runs
      WHERE parent_run_id=${sqlValue(runId)} AND role='child_codex' AND status='running'
      ORDER BY created_at ASC`
  );
  for (const child of children) {
    if (!child.step_id) continue;
    const startedMs = child.started_at ? Date.parse(child.started_at) : Number.NaN;
    if (!Number.isFinite(startedMs) || nowMs - startedMs <= staleAfterMs) continue;
    const step = querySql<StepRow>(`SELECT * FROM run_steps WHERE id=${sqlValue(child.step_id)} LIMIT 1`)[0];
    if (!step) continue;
    const existingProofs = querySql<ChildCodexProofRow>(
      `SELECT run_id, proof_type, step_id, uri, metadata_json FROM proofs
        WHERE run_id=${sqlValue(runId)}
          AND step_id=${sqlValue(child.step_id)}
          AND proof_type IN ('child_codex_result', 'child_codex_blocked')
        ORDER BY created_at ASC`
    );
    const existingProof = selectExistingChildCodexProofForStaleReconcile({ child, step, proofs: existingProofs });
    if (existingProof && reconcileStaleChildCodexFromExistingProof({ child, step, proof: existingProof })) continue;
    blockStaleChildCodexRun({ child, step, staleAfterMs });
  }
}

function reconcileStaleDailyAiRegisteredRuns(runId: string) {
  const staleAfterMs = Number(process.env.AUTOMATION_OS_REGISTERED_STALE_AFTER_MS || 10 * 60 * 1000);
  const nowMs = Date.now();
  const steps = querySql<StepRow>(
    `SELECT * FROM run_steps
      WHERE run_id=${sqlValue(runId)}
        AND status='running'
        AND metadata_json LIKE '%"adapter":"daily_ai_registered"%'
      ORDER BY started_at ASC`
  );
  for (const step of steps) {
    const startedMs = step.started_at ? Date.parse(step.started_at) : Number.NaN;
    if (!Number.isFinite(startedMs) || nowMs - startedMs <= staleAfterMs) continue;
    reconcileStaleDailyAiRegisteredStep({ step, staleAfterMs });
  }
}

function reconcileStaleDailyAiRegisteredStep(input: { step: StepRow; staleAfterMs: number }) {
  const completedAt = nowIso();
  const metadata = parseJson<Record<string, unknown>>(input.step.metadata_json, {});
  const staleMetadata = stripLegacyCompletionMetadata(metadata);
  const routeContext = buildCanonicalRouteBlockContext({ step: input.step, metadata, adapter: "daily_ai_registered" });
  const exactBlocker = routeContext.exactBlocker ?? BROWSER_USE_CLI_STALE_RECONCILIATION_REQUIRED_BLOCKER;
  const effectiveRouteReadback = staleReconciliationRouteReadback(routeContext.effectiveRouteReadback, exactBlocker, routeContext.adapterPolicy);
  blockStepForRouting(
    input.step,
    {
      ...staleMetadata,
      adapter: "daily_ai_registered",
      command: routeContext.command,
      command_display: routeContext.command.display,
      worker_mode: routeContext.workerMode,
      execution_mode: routeContext.workerMode,
      adapter_policy: routeContext.adapterPolicy,
      route_decision: routeContext.routeDecision ?? undefined,
      route_decision_fingerprint: routeContext.routeDecisionFingerprint,
      route_readback: effectiveRouteReadback,
      execution_routing: effectiveRouteReadback,
      route_readback_fingerprint: effectiveRouteReadback.fingerprint,
      proof_gate: { ok: false, missing: [exactBlocker], present: [] as string[] },
      proof_summary: `blocked: ${exactBlocker}`,
      stop_reason: exactBlocker,
      external_action_executed: false,
      ...(routeContext.runnerSafety ? { runner_safety: routeContext.runnerSafety } : {}),
      reconciled_from_stale_registered_summary: true,
      stale_after_ms: input.staleAfterMs
    },
    completedAt,
    exactBlocker,
    routeContext.routeDecision ?? undefined,
    effectiveRouteReadback,
    routeContext.adapterPolicy,
    routeContext.workerMode,
    routeContext.command,
    routeContext.runnerSafety
  );
  logWorkerEvent({
    runId: input.step.run_id,
    stepId: input.step.id,
    laneId: input.step.lane_id ?? undefined,
    eventType: "worker_blocked",
    message: "Daily AI registered stale running step blocked by canonical route policy before summary reconciliation",
    metadata: {
      adapter: "daily_ai_registered",
      exact_blocker: exactBlocker,
      command_display: routeContext.command.display,
      route_decision_fingerprint: routeContext.routeDecisionFingerprint,
      route_readback_fingerprint: effectiveRouteReadback.fingerprint,
      proof_gate: { ok: false, missing: [exactBlocker], present: [] as string[] },
      proof_summary: `blocked: ${exactBlocker}`,
      stop_reason: exactBlocker,
      external_action_executed: false,
      runner_safety: routeContext.runnerSafety,
      reconciled_from_stale_registered_summary: true
    }
  });
}

function reconcileStaleRegisteredCodexAutomationRuns(runId: string) {
  const staleAfterMs = Number(process.env.AUTOMATION_OS_REGISTERED_STALE_AFTER_MS || 10 * 60 * 1000);
  const steps = querySql<StepRow>(
    `SELECT * FROM run_steps
      WHERE run_id=${sqlValue(runId)}
        AND status='running'
      ORDER BY started_at ASC`
  ).filter((step) => {
    const metadata = parseJson<Record<string, unknown>>(step.metadata_json, {});
    return metadata.adapter === "job_submit_registered" || metadata.adapter === "job_followup_registered";
  });
  for (const step of steps) {
    const startedMs = step.started_at ? Date.parse(step.started_at) : Number.NaN;
    if (!Number.isFinite(startedMs) || Date.now() - startedMs <= staleAfterMs) continue;
    reconcileStaleRegisteredCodexAutomationStep({ step, staleAfterMs });
  }
}

function reconcileStaleRegisteredCodexAutomationStep(input: { step: StepRow; staleAfterMs: number }) {
  const completedAt = nowIso();
  const metadata = parseJson<Record<string, unknown>>(input.step.metadata_json, {});
  const staleMetadata = stripLegacyCompletionMetadata(metadata);
  const adapter = String(metadata.adapter ?? "");
  const routeContext = buildCanonicalRouteBlockContext({ step: input.step, metadata, adapter: adapter as WorkerAdapter });
  const exactBlocker = routeContext.exactBlocker ?? BROWSER_USE_CLI_STALE_RECONCILIATION_REQUIRED_BLOCKER;
  const effectiveRouteReadback = staleReconciliationRouteReadback(routeContext.effectiveRouteReadback, exactBlocker, routeContext.adapterPolicy);
  blockStepForRouting(
    input.step,
    {
      ...staleMetadata,
      adapter,
      command: routeContext.command,
      command_display: routeContext.command.display,
      worker_mode: routeContext.workerMode,
      execution_mode: routeContext.workerMode,
      adapter_policy: routeContext.adapterPolicy,
      route_decision: routeContext.routeDecision ?? undefined,
      route_decision_fingerprint: routeContext.routeDecisionFingerprint,
      route_readback: effectiveRouteReadback,
      execution_routing: effectiveRouteReadback,
      route_readback_fingerprint: effectiveRouteReadback.fingerprint,
      proof_gate: { ok: false, missing: [exactBlocker], present: [] as string[] },
      proof_summary: `blocked: ${exactBlocker}`,
      stop_reason: exactBlocker,
      external_action_executed: false,
      ...(routeContext.runnerSafety ? { runner_safety: routeContext.runnerSafety } : {}),
      reconciled_from_stale_registered_codex: true,
      stale_after_ms: input.staleAfterMs
    },
    completedAt,
    exactBlocker,
    routeContext.routeDecision ?? undefined,
    effectiveRouteReadback,
    routeContext.adapterPolicy,
    routeContext.workerMode,
    routeContext.command,
    routeContext.runnerSafety
  );
  logWorkerEvent({
    runId: input.step.run_id,
    stepId: input.step.id,
    laneId: input.step.lane_id ?? undefined,
    eventType: "worker_blocked",
    message: `Registered Codex stale running step blocked without rerun: ${exactBlocker}`,
    metadata: {
      adapter,
      status: "blocked",
      command_display: routeContext.command.display,
      route_decision_fingerprint: routeContext.routeDecisionFingerprint,
      route_readback_fingerprint: effectiveRouteReadback.fingerprint,
      proof_gate: { ok: false, missing: [exactBlocker], present: [] as string[] },
      proof_summary: `blocked: ${exactBlocker}`,
      stop_reason: exactBlocker,
      external_action_executed: false,
      runner_safety: routeContext.runnerSafety,
      reconciled_from_stale_registered_codex: true
    }
  });
}

function selectExistingChildCodexProofForStaleReconcile(input: {
  child: {
    id: string;
  };
  step: StepRow;
  proofs: ChildCodexProofRow[];
}): ChildCodexProofRow | undefined {
  return (
    input.proofs.find((proof) => proof.proof_type === "child_codex_result" && childCodexExistingProofIsValid({ ...input, proof })) ??
    input.proofs.find((proof) => proof.proof_type === "child_codex_blocked" && childCodexExistingProofIsValid({ ...input, proof }))
  );
}

function childCodexExistingProofIsValid(input: {
  child: {
    id: string;
  };
  step: StepRow;
  proof: ChildCodexProofRow;
}): boolean {
  const proofMetadata = parseJson<Record<string, unknown>>(input.proof.metadata_json, {});
  const proofChildRunId = typeof proofMetadata.child_run_id === "string" ? proofMetadata.child_run_id : undefined;
  if (proofChildRunId !== input.child.id || input.proof.step_id !== input.step.id) return false;
  if (input.proof.proof_type === "child_codex_result") {
    return validateChildCodexResultArtifact({
      uri: input.proof.uri,
      runId: input.proof.run_id,
      stepId: input.step.id,
      childRunId: input.child.id
    }).ok;
  }
  return input.proof.proof_type === "child_codex_blocked" && artifactExists(input.proof.uri);
}

function reconcileStaleChildCodexFromExistingProof(input: {
  child: {
    id: string;
    prompt_uri: string;
    pid: number | null;
    metadata_json: string;
  };
  step: StepRow;
  proof: ChildCodexProofRow;
}): boolean {
  if (!childCodexExistingProofIsValid(input)) return false;
  const proofMetadata = parseJson<Record<string, unknown>>(input.proof.metadata_json, {});
  const proofIsSuccess = input.proof.proof_type === "child_codex_result";

  const completedAt = nowIso();
  const childMetadata = parseJson<Record<string, unknown>>(input.child.metadata_json, {});
  const stepMetadata = parseJson<Record<string, unknown>>(input.step.metadata_json, {});
  const exitStatus = typeof proofMetadata.exit_status === "number" ? proofMetadata.exit_status : proofIsSuccess ? 0 : null;
  const signal = typeof proofMetadata.signal === "string" ? proofMetadata.signal : null;
  const blocker = proofIsSuccess
    ? null
    : typeof proofMetadata.blocker === "string"
      ? proofMetadata.blocker
      : "child_codex_blocked_proof_reconciled_after_stale_running_child";
  execSql(
    `UPDATE child_runs SET status=${sqlValue(proofIsSuccess ? "completed" : "blocked")},
       exit_status=${sqlValue(exitStatus)},
       signal=${sqlValue(signal)},
       result_uri=${sqlValue(input.proof.uri)},
       summary=${sqlValue(proofIsSuccess ? "child Codex read-only execution completed from existing proof" : "child Codex read-only execution blocked from existing proof")},
       blocker=${sqlValue(blocker)},
       completed_at=${sqlValue(completedAt)},
       metadata_json=${sqlValue({
         ...childMetadata,
         adapter: "child_codex",
         execution_mode: "child_codex",
         prompt_uri: input.child.prompt_uri,
         result_uri: input.proof.uri,
         reconciled_from_existing_proof: true,
         existing_proof_type: input.proof.proof_type,
         ...(blocker ? { blocker } : {})
       })}
     WHERE id=${sqlValue(input.child.id)} AND status='running';
     UPDATE run_steps SET status=${sqlValue(proofIsSuccess ? "completed" : "blocked")},
       completed_at=${sqlValue(completedAt)},
       metadata_json=${sqlValue({
         ...stepMetadata,
         adapter: "child_codex",
         execution_mode: "child_codex",
         child_run_id: input.child.id,
         prompt_uri: input.child.prompt_uri,
         child_codex_result_artifact: input.proof.uri,
         child_codex_exit_status: exitStatus,
         child_codex_signal: signal,
         reconciled_from_existing_proof: true,
         ...(blocker ? { child_codex_blocker: blocker } : {})
       })}
     WHERE id=${sqlValue(input.step.id)} AND status='running';
     UPDATE lanes SET status=${sqlValue(proofIsSuccess ? "idle" : "blocked")},
       progress=${proofIsSuccess ? 100 : 50},
       health=${sqlValue(proofIsSuccess ? "good" : "blocked")},
       updated_at=${sqlValue(completedAt)}
      WHERE id=${sqlValue(input.step.lane_id)};`
  );
  logWorkerEvent({
    runId: input.step.run_id,
    stepId: input.step.id,
    laneId: input.step.lane_id ?? undefined,
    eventType: proofIsSuccess ? "worker_completed" : "worker_blocked",
    message: `Child Codex stale running child reconciled from existing ${input.proof.proof_type} proof`,
    metadata: {
      adapter: "child_codex",
      child_run_id: input.child.id,
      proof_type: input.proof.proof_type,
      proof_uri: input.proof.uri,
      reconciled_from_existing_proof: true
    }
  });
  return true;
}

function artifactExists(uri: string): boolean {
  try {
    return uri.startsWith("file://") && existsSync(new URL(uri));
  } catch {
    return false;
  }
}

function blockStaleChildCodexRun(input: {
  child: {
    id: string;
    prompt_uri: string;
    pid: number | null;
    metadata_json: string;
  };
  step: StepRow;
  staleAfterMs: number;
}) {
  const completedAt = nowIso();
  const stepMetadata = parseJson<Record<string, unknown>>(input.step.metadata_json, {});
  const childMetadata = parseJson<Record<string, unknown>>(input.child.metadata_json, {});
  const shouldBlockStep = input.step.status === "running";
  const command = (childMetadata.command ?? stepMetadata.command) as WorkerCommandSpec | undefined;
  const termination = terminateStaleWorkerPid(input.child.pid);
  const blocker = input.child.pid
    ? "async_child_codex_timed_out_without_result_proof"
    : "async_child_codex_parent_exited_before_pid_or_result_proof";
  const resultArtifact = writeNamedWorkerArtifact(input.step.run_id, `${input.step.id}-${input.child.id}-stale-child-result.json`, {
    runId: input.step.run_id,
    stepId: input.step.id,
    childRunId: input.child.id,
    task: input.step.name,
    adapter: "child_codex",
    mode: "child_codex",
    exitStatus: null,
    signal: null,
    stdoutTail: "",
    stderrTail: blocker,
    ...(command ? { command, commandDisplay: command.display } : {}),
    promptUri: input.child.prompt_uri,
    createdAt: completedAt,
    timedOut: true,
    staleAfterMs: input.staleAfterMs,
    pid_alive_before_termination: termination.pidAliveBeforeTermination,
    pid_alive_after_termination: termination.pidAliveAfterTermination,
    terminationAttempted: termination.terminationAttempted,
    terminationSignal: termination.terminationSignal,
    terminationError: termination.terminationError,
    blocker
  });
  execSql(
    `UPDATE child_runs SET status='blocked',
       exit_status=NULL,
       signal=NULL,
       result_uri=${sqlValue(resultArtifact.uri)},
       summary='child Codex async execution blocked without result proof',
       blocker=${sqlValue(blocker)},
       completed_at=${sqlValue(completedAt)},
       metadata_json=${sqlValue({
         ...childMetadata,
         adapter: "child_codex",
         execution_mode: "child_codex",
         prompt_uri: input.child.prompt_uri,
         result_uri: resultArtifact.uri,
         timed_out: true,
         stale_after_ms: input.staleAfterMs,
         pid_alive_before_termination: termination.pidAliveBeforeTermination,
         pid_alive_after_termination: termination.pidAliveAfterTermination,
         termination_attempted: termination.terminationAttempted,
         termination_signal: termination.terminationSignal,
         termination_error: termination.terminationError,
         blocker
       })}
     WHERE id=${sqlValue(input.child.id)};`
  );
  if (shouldBlockStep) {
    execSql(
      `UPDATE run_steps SET status='blocked',
       completed_at=${sqlValue(completedAt)},
       metadata_json=${sqlValue({
         ...stepMetadata,
         adapter: "child_codex",
         execution_mode: "child_codex",
         child_run_id: input.child.id,
         prompt_uri: input.child.prompt_uri,
         child_codex_result_artifact: resultArtifact.uri,
         child_codex_exit_status: null,
         child_codex_signal: null,
         child_codex_timed_out: true,
         child_codex_pid_alive_before_termination: termination.pidAliveBeforeTermination,
         child_codex_pid_alive_after_termination: termination.pidAliveAfterTermination,
         child_codex_termination_attempted: termination.terminationAttempted,
         child_codex_termination_signal: termination.terminationSignal,
         child_codex_termination_error: termination.terminationError,
         child_codex_blocker: blocker
       })}
     WHERE id=${sqlValue(input.step.id)} AND status='running';
     UPDATE lanes SET status='blocked', progress=50, health='blocked', updated_at=${sqlValue(completedAt)}
      WHERE id=${sqlValue(input.step.lane_id)};`
    );
  }
  insertRunProof(input.step.run_id, {
    id: makeId("proof"),
    run_id: input.step.run_id,
    step_id: input.step.id,
    proof_type: "child_codex_blocked",
    label: `child_codex stale async blocked: ${input.step.name}`,
    uri: resultArtifact.uri,
    size_bytes: resultArtifact.sizeBytes,
    created_at: completedAt,
    metadata_json: {
      adapter: "child_codex",
      execution_mode: "child_codex",
      child_run_id: input.child.id,
      prompt_uri: input.child.prompt_uri,
      exit_status: null,
      signal: null,
      timed_out: true,
      stale_after_ms: input.staleAfterMs,
      pid_alive_before_termination: termination.pidAliveBeforeTermination,
      pid_alive_after_termination: termination.pidAliveAfterTermination,
      termination_attempted: termination.terminationAttempted,
      termination_signal: termination.terminationSignal,
      termination_error: termination.terminationError,
      blocker
    }
  });
  logWorkerEvent({
    runId: input.step.run_id,
    stepId: input.step.id,
    laneId: input.step.lane_id ?? undefined,
    eventType: "worker_blocked",
    message: `Child Codex async execution blocked without result proof: ${blocker}`,
    metadata: {
      adapter: "child_codex",
      child_run_id: input.child.id,
      result_artifact: resultArtifact,
      pid_alive_before_termination: termination.pidAliveBeforeTermination,
      pid_alive_after_termination: termination.pidAliveAfterTermination,
      termination_attempted: termination.terminationAttempted,
      termination_signal: termination.terminationSignal,
      termination_error: termination.terminationError,
      blocker
    }
  });
}

function terminateStaleWorkerPid(pid: number | null): {
  pidAliveBeforeTermination: boolean | null;
  pidAliveAfterTermination: boolean | null;
  terminationAttempted: boolean;
  terminationSignal: NodeJS.Signals | null;
  terminationError: string | null;
} {
  if (!pid) {
    return { pidAliveBeforeTermination: null, pidAliveAfterTermination: null, terminationAttempted: false, terminationSignal: null, terminationError: null };
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    return {
      pidAliveBeforeTermination: false,
      pidAliveAfterTermination: false,
      terminationAttempted: false,
      terminationSignal: null,
      terminationError: isNoSuchProcessError(error) ? null : errorToMessage(error)
    };
  }
  let terminationError: string | null = null;
  let terminationSignal: NodeJS.Signals | null = "SIGTERM";
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    terminationError = errorToMessage(error);
  }
  sleepSync(workerProcessKillGraceMs());
  if (isPidAlive(pid)) {
    terminationSignal = "SIGKILL";
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      terminationError = terminationError ? `${terminationError}; ${errorToMessage(error)}` : errorToMessage(error);
    }
  }
  return {
    pidAliveBeforeTermination: true,
    pidAliveAfterTermination: isPidAlive(pid),
    terminationAttempted: true,
    terminationSignal,
    terminationError
  };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isNoSuchProcessError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ESRCH";
}

function sleepSync(ms: number) {
  if (ms <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function codexReadonlyErrorResult(
  input: { step: StepRow; metadata: Record<string, unknown>; command: WorkerCommandSpec; lane?: LaneRow; createdAt: string },
  error: unknown
): CodexReadonlyExecutionResult {
  const errorMessage = errorToMessage(error);
  const artifact = writeWorkerArtifact(input.step.run_id, input.step.id, {
    runId: input.step.run_id,
    stepId: input.step.id,
    task: input.step.name,
    adapter: "codex_cli",
    mode: "execute_codex_readonly",
    exitStatus: null,
    signal: null,
    stdoutTail: "",
    stderrTail: errorMessage,
    command: input.command,
    commandDisplay: input.command.display,
    lane: input.lane,
    resources: input.metadata.resources ?? [],
    createdAt: input.createdAt,
    timedOut: false,
    errorMessage
  });
  return {
    artifact,
    proofType: "codex_readonly_blocked",
    stepStatus: "blocked",
    laneStatus: "blocked",
    laneProgress: 50,
    laneHealth: "blocked",
    exitStatus: null,
    signal: null,
    stdoutTail: "",
    stderrTail: errorMessage,
    timedOut: false,
    errorMessage
  };
}

function childCodexErrorResult(
  input: { step: StepRow; metadata: Record<string, unknown>; lane?: LaneRow; createdAt: string },
  command: WorkerCommandSpec,
  childRunId: string,
  promptArtifact: ReturnType<typeof writeTextArtifact>,
  error: unknown
): ChildCodexExecutionResult {
  const errorMessage = errorToMessage(error);
  const resultArtifact = writeNamedWorkerArtifact(input.step.run_id, `${input.step.id}-child-result.json`, {
    runId: input.step.run_id,
    stepId: input.step.id,
    childRunId,
    task: input.step.name,
    adapter: "child_codex",
    mode: "child_codex",
    exitStatus: null,
    signal: null,
    stdoutTail: "",
    stderrTail: errorMessage,
    command,
    commandDisplay: command.display,
    lane: input.lane,
    resources: input.metadata.resources ?? [],
    promptUri: promptArtifact.uri,
    createdAt: input.createdAt,
    timedOut: false,
    blocker: errorMessage,
    errorMessage
  });
  return {
    resultArtifact,
    promptArtifact,
    command,
    proofType: "child_codex_blocked",
    stepStatus: "blocked",
    laneStatus: "blocked",
    laneProgress: 50,
    laneHealth: "blocked",
    childRunId,
    exitStatus: null,
    signal: null,
    stdoutTail: "",
    stderrTail: errorMessage,
    timedOut: false,
    blocker: errorMessage,
    errorMessage
  };
}

function runWorkerProcess(
  command: WorkerCommandSpec,
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; onSpawn?: (pid: number) => void }
): Promise<WorkerProcessResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let spawnError: Error | undefined;
    let timer: NodeJS.Timeout | undefined;
    const child = spawn(command.bin, command.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    if (typeof child.pid === "number") options.onSpawn?.(child.pid);
    let killTimer: NodeJS.Timeout | undefined;
    const finish = (result: WorkerProcessResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };
    const append = (current: string, chunk: Buffer) => tail(current + chunk.toString("utf8"), 20 * 1024 * 1024);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (status, signal) => {
      finish({
        pid: child.pid,
        status,
        signal,
        stdout,
        stderr,
        timedOut,
        ...(spawnError ? { errorMessage: String(spawnError.message || spawnError) } : {})
      });
    });
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        finish({
          pid: child.pid,
          status: null,
          signal: "SIGKILL",
          stdout,
          stderr,
          timedOut,
          errorMessage: "worker process timed out and did not exit after SIGTERM"
        });
      }, workerProcessKillGraceMs());
    }, options.timeoutMs);
  });
}

function codexReadonlyTimeoutMs(): number {
  const raw = Number(process.env.AUTOMATION_OS_CODEX_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000;
}

function childCodexReadonlyTimeoutMs(): number {
  const raw = Number(process.env.AUTOMATION_OS_CHILD_CODEX_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60 * 1000;
}

function workerProcessKillGraceMs(): number {
  const raw = Number(process.env.AUTOMATION_OS_WORKER_KILL_GRACE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5_000;
}

function tail(value: string | Buffer | null | undefined, maxChars = 4_000): string {
  return redactWorkerOutput(value, maxChars);
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathToFileUri(path: string): string {
  return pathToFileURL(path).href;
}

function writeWorkerArtifact(runId: string, stepId: string, payload: Record<string, unknown>) {
  return writeNamedWorkerArtifact(runId, `${stepId}.json`, payload);
}

function writeNamedWorkerArtifact(runId: string, filename: string, payload: Record<string, unknown>) {
  const artifactRoot = process.env.AUTOMATION_OS_ARTIFACT_ROOT ? resolve(process.env.AUTOMATION_OS_ARTIFACT_ROOT) : resolve(process.cwd(), "data", "artifacts");
  const artifactPath = resolve(artifactRoot, runId, filename);
  const bytes = `${JSON.stringify(payload, null, 2)}\n`;
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, bytes);
  const sizeBytes = existsSync(artifactPath) ? statSync(artifactPath).size : 0;
  return {
    path: artifactPath,
    uri: pathToFileUri(artifactPath),
    sizeBytes,
    mimeType: "application/json",
    checksumSha256: createHash("sha256").update(bytes).digest("hex")
  };
}

function writeTextArtifact(runId: string, filename: string, text: string) {
  const artifactRoot = process.env.AUTOMATION_OS_ARTIFACT_ROOT ? resolve(process.env.AUTOMATION_OS_ARTIFACT_ROOT) : resolve(process.cwd(), "data", "artifacts");
  const artifactPath = resolve(artifactRoot, runId, filename);
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, text);
  const sizeBytes = existsSync(artifactPath) ? statSync(artifactPath).size : 0;
  return { path: artifactPath, uri: pathToFileUri(artifactPath), sizeBytes };
}

function logWorkerEvent(input: {
  runId: string;
  stepId?: string;
  laneId?: string;
  eventType: string;
  message: string;
  metadata?: Record<string, unknown>;
}) {
  insert("worker_events", {
    id: makeId("evt"),
    company_id: getRunCompanyId(input.runId),
    run_id: input.runId,
    step_id: input.stepId ?? null,
    lane_id: input.laneId ?? null,
    event_type: input.eventType,
    message: input.message,
    created_at: nowIso(),
    metadata_json: input.metadata ?? {}
  });
}

export function getRunWorkerProgressState(runId: string): RunWorkerProgressState {
  const stepCounts = querySql<{
    steps_started: number;
    steps_completed: number;
    steps_status_progressed: number;
  }>(
    `SELECT
       SUM(CASE WHEN started_at IS NOT NULL THEN 1 ELSE 0 END) AS steps_started,
       SUM(CASE WHEN completed_at IS NOT NULL THEN 1 ELSE 0 END) AS steps_completed,
       SUM(CASE WHEN status NOT IN ('waiting_approval', 'queued') THEN 1 ELSE 0 END) AS steps_status_progressed
     FROM run_steps
     WHERE run_id=${sqlValue(runId)}`
  )[0] ?? { steps_started: 0, steps_completed: 0, steps_status_progressed: 0 };
  const eventCounts = querySql<{
    worker_started_events: number;
    worker_completed_events: number;
    worker_blocked_events: number;
  }>(
    `SELECT
       SUM(CASE WHEN event_type='worker_started' THEN 1 ELSE 0 END) AS worker_started_events,
       SUM(CASE WHEN event_type='worker_completed' THEN 1 ELSE 0 END) AS worker_completed_events,
       SUM(CASE WHEN event_type='worker_blocked' THEN 1 ELSE 0 END) AS worker_blocked_events
     FROM worker_events
     WHERE run_id=${sqlValue(runId)}`
  )[0] ?? { worker_started_events: 0, worker_completed_events: 0, worker_blocked_events: 0 };
  const proofCounts = querySql<{ proofs: number }>(`SELECT COUNT(*) AS proofs FROM proofs WHERE run_id=${sqlValue(runId)}`)[0] ?? { proofs: 0 };
  const counts = {
    stepsStarted: Number(stepCounts.steps_started ?? 0),
    stepsCompleted: Number(stepCounts.steps_completed ?? 0),
    stepsStatusProgressed: Number(stepCounts.steps_status_progressed ?? 0),
    workerStartedEvents: Number(eventCounts.worker_started_events ?? 0),
    workerCompletedEvents: Number(eventCounts.worker_completed_events ?? 0),
    workerBlockedEvents: Number(eventCounts.worker_blocked_events ?? 0),
    proofs: Number(proofCounts.proofs ?? 0)
  };
  return {
    progressed: Object.values(counts).some((count) => count > 0),
    counts
  };
}

function updateRunStatus(runId: string, status: string, metadata: Record<string, unknown>) {
  const current = querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  const merged = { ...parseJson<Record<string, unknown>>(current?.metadata_json, {}), ...metadata };
  execSql(`UPDATE runs SET status=${sqlValue(status)}, updated_at=${sqlValue(nowIso())}, metadata_json=${sqlValue(merged)} WHERE id=${sqlValue(runId)};`);
}

function getRunMetadata(runId: string): Record<string, unknown> {
  const current = querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  return parseJson<Record<string, unknown>>(current?.metadata_json, {});
}

function sanitizeRunMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const copy = { ...(metadata ?? {}) };
  delete copy.route_decision;
  delete copy.route_readback;
  delete copy.execution_routing;
  delete copy.route_decision_fingerprint;
  delete copy.route_readback_fingerprint;
  return stripLegacyCompletionMetadata(copy);
}

function stripLegacyCompletionMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...metadata };
  delete copy.daily_ai_status;
  delete copy.daily_ai_summary_path;
  delete copy.daily_ai_exit_status;
  delete copy.daily_ai_signal;
  delete copy.registered_codex_status;
  delete copy.registered_codex_artifact;
  delete copy.registered_codex_exit_status;
  delete copy.registered_codex_signal;
  delete copy.completion_claimed;
  delete copy.submitted_confirmed;
  delete copy.application_appends;
  delete copy.decoy_success_artifact;
  delete copy.proof_gate;
  delete copy.proof_summary;
  delete copy.external_action_executed;
  delete copy.stop_reason;
  return copy;
}

function getRoutingCommandFromMetadata(metadata: Record<string, unknown>, step: StepRow): string {
  const command = metadata.command;
  return typeof command === "string" && command.trim() ? command : step.name;
}

function resolveWorkerCapabilities(metadata: Record<string, unknown>): CodexCapabilitiesSummary {
  const candidate = metadata.capabilities;
  if (isCodexCapabilitiesSummary(candidate)) return candidate;
  return getCodexCapabilities();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCodexCapabilitiesSummary(value: unknown): value is CodexCapabilitiesSummary {
  if (!isRecord(value)) return false;
  const capabilities = value.capabilities;
  const chrome = isRecord(capabilities) ? capabilities.chrome : undefined;
  const chromeState = isRecord(chrome) ? chrome.state : undefined;
  return isRecord(capabilities) && isRecord(chrome) && isRecord(chromeState) && typeof chromeState.connected === "boolean";
}

function buildCanonicalRouteBlockContext(input: {
  step: StepRow;
  metadata: Record<string, unknown>;
  adapter: WorkerAdapter;
}): CanonicalRouteBlockContext {
  const runMetadata = getRunMetadata(input.step.run_id);
  const routeDecisionReadback = readCanonicalExecutionRoutingDecision(runMetadata.route_decision, runMetadata.route_decision_fingerprint);
  const routeDecision = routeDecisionReadback.routeDecision;
  const routeSource = routeDecision?.source ?? inferExecutionRoutingSource(runMetadata);
  const adapterPolicy = resolveWorkerAdapterPolicy(input.adapter);
  // The isolated reference canary must prove the canonical Browser Use CLI
  // stop boundary without ever invoking a registered workflow runner.  This
  // is deliberately scoped to canary metadata; live runs still use the
  // adapter's normal admission policy below.
  const referenceCanaryBrowserUseSafeStop = runMetadata.reference_workflow_canary === true &&
    adapterPolicy.classification === "browser_use_cli";
  const workerMode = workerModeForAdapter(input.adapter);
  const lane = input.step.lane_id
    ? querySql<LaneRow>(
        `SELECT id, cdp_port, profile_dir, workdir, browser_use_session, browser_use_cdp_url, browser_use_profile, profile_strategy, lane_visibility FROM lanes WHERE id=${sqlValue(
          input.step.lane_id
        )} LIMIT 1`
      )[0]
    : undefined;
  const command = buildWorkerCommand({ adapter: input.adapter, taskName: input.step.name, lane });
  const rawRouteReadback = buildExecutionRoutingSnapshot({
    command: getRoutingCommandFromMetadata(runMetadata, input.step),
    source: routeSource,
    phase: "route_readback",
    decisionFingerprint: routeDecisionReadback.routeDecisionFingerprint,
    selectedAdapter: input.adapter,
    capabilities: resolveWorkerCapabilities(runMetadata)
  });
  const browserUseAdmitted = (
    command.env?.AUTOMATION_OS_BROWSER_SURFACE === "browser_use_cli"
    && command.env?.AUTOMATION_OS_BROWSER_DRIVER === "browser_use_cli"
    && command.env?.AUTOMATION_OS_BROWSER_ADAPTER === browserUseAdapterEntryPoint
    && command.env?.AUTOMATION_OS_BROWSER_NO_FALLBACK === "1"
  ) || (
    input.adapter === "daily_ai_registered"
    && adapterPolicy.classification === "browser_use_cli"
    && command.env?.DAILY_AI_BROWSER_DRIVER === "browser_use_cli"
    && command.env?.DAILY_AI_CLI_REQUIRE_BROWSER_USE === "1"
    && command.env?.DAILY_AI_CLI_RECORDING_REQUIRED === "1"
  );
  const routeReadback = browserUseAdmitted && (rawRouteReadback.exactBlocker === "in_app_browser_required" || rawRouteReadback.exactBlocker === BROWSER_USE_CLI_REQUIRED_BLOCKER)
    ? {
        ...rawRouteReadback,
        allowed: true,
        exactBlocker: null,
        fallbackReason: "route=browser_use_cli",
        controller: { ...rawRouteReadback.controller, status: "readback" as const, reason: "browser_use_cli_route_readback" },
        evidence: uniqueStrings([...rawRouteReadback.evidence, "browser_use_cli_manifest_surface=browser_use_cli", "browser_use_cli_no_fallback=true"])
      }
    : rawRouteReadback;
  const exactBlocker = referenceCanaryBrowserUseSafeStop
    ? BROWSER_USE_CLI_REQUIRED_BLOCKER
    : routeReadback.exactBlocker ?? adapterPolicy.exactBlocker;
  const effectiveRouteReadback = exactBlocker
    ? {
        ...routeReadback,
        allowed: false,
        exactBlocker,
        controller: {
          ...routeReadback.controller,
          status: "inventory_only" as const,
          reason: `blocked:${exactBlocker}`
        },
        fallbackReason: `blocked:${exactBlocker}`,
        evidence: uniqueStrings([
          ...routeReadback.evidence,
          `exactBlocker=${exactBlocker}`,
          `adapter_policy=${adapterPolicy.classification}`,
          ...adapterPolicy.evidence
        ])
      }
    : routeReadback;
  return {
    routeDecision,
    routeDecisionFingerprint: routeDecisionReadback.routeDecisionFingerprint,
    routeSource,
    routeReadback,
    effectiveRouteReadback,
    adapterPolicy,
    workerMode,
    command,
    lane,
    runnerSafety: registeredRunnerSafetyMetadataForAdapter(input.adapter),
    exactBlocker
  };
}

function staleReconciliationRouteReadback(
  base: ExecutionRoutingSnapshot,
  exactBlocker: NonNullable<ExecutionRoutingSnapshot["exactBlocker"]>,
  adapterPolicy: WorkerAdapterPolicySnapshot
): ExecutionRoutingSnapshot {
  return {
    ...base,
    allowed: false,
    exactBlocker,
    controller: {
      ...base.controller,
      status: "inventory_only",
      reason: `blocked:${exactBlocker}`
    },
    fallbackReason: `blocked:${exactBlocker}`,
    evidence: uniqueStrings([
      ...base.evidence,
      `exactBlocker=${exactBlocker}`,
      `adapter_policy=${adapterPolicy.classification}`,
      ...adapterPolicy.evidence
    ])
  };
}

function blockStepForRouting(
  step: StepRow,
  metadata: Record<string, unknown>,
  now: string,
  exactBlocker: NonNullable<ExecutionRoutingSnapshot["exactBlocker"]>,
  routeDecision?: ExecutionRoutingSnapshot,
  routeReadback?: ExecutionRoutingSnapshot,
  adapterPolicy?: WorkerAdapterPolicySnapshot,
  workerMode?: WorkerMode,
  command?: WorkerCommandSpec,
  runnerSafety?: ReturnType<typeof runnerSafetyMetadata>
): void {
  const runMetadata = sanitizeRunMetadata(getRunMetadata(step.run_id));
  const stepMetadata = sanitizeRunMetadata(metadata);
  const proofGate = { ok: false, missing: [exactBlocker], present: [] as string[] };
  const proofSummary = `blocked: ${exactBlocker}`;
  execSql(
    `UPDATE runs
     SET status='blocked',
         updated_at=${sqlValue(now)},
         metadata_json=${sqlValue({
           ...runMetadata,
           ...(typeof metadata.adapter === "string" ? { adapter: metadata.adapter } : {}),
           ...(workerMode ? { worker_mode: workerMode, execution_mode: workerMode } : {}),
           ...(command ? { command, command_display: command.display } : {}),
           ...(routeDecision ? { route_decision: routeDecision } : {}),
           ...(routeReadback ? { route_readback: routeReadback, execution_routing: routeReadback } : {}),
           ...(adapterPolicy ? { adapter_policy: adapterPolicy } : {}),
           route_decision_fingerprint: routeDecision?.fingerprint ?? null,
           route_readback_fingerprint: routeReadback?.fingerprint ?? null,
           proof_gate: proofGate,
           proof_summary: proofSummary,
           exact_blocker: exactBlocker,
           blocker: exactBlocker,
           stop_reason: exactBlocker,
           external_action_executed: false,
           ...(runnerSafety ? { runner_safety: runnerSafety } : {})
         })}
     WHERE id=${sqlValue(step.run_id)};
     UPDATE run_steps
     SET status='blocked',
         completed_at=${sqlValue(now)},
         metadata_json=${sqlValue({
           ...stepMetadata,
           ...(workerMode ? { worker_mode: workerMode, execution_mode: workerMode } : {}),
           ...(command ? { command, command_display: command.display } : {}),
           ...(routeDecision ? { route_decision: routeDecision } : {}),
           ...(routeReadback ? { route_readback: routeReadback, execution_routing: routeReadback } : {}),
           ...(adapterPolicy ? { adapter_policy: adapterPolicy } : {}),
           route_decision_fingerprint: routeDecision?.fingerprint ?? null,
           route_readback_fingerprint: routeReadback?.fingerprint ?? null,
           proof_gate: proofGate,
           proof_summary: proofSummary,
           exact_blocker: exactBlocker,
           blocker: exactBlocker,
           stop_reason: exactBlocker,
           external_action_executed: false,
           ...(runnerSafety ? { runner_safety: runnerSafety } : {})
         })}
     WHERE id=${sqlValue(step.id)};
     UPDATE lanes
     SET status='blocked',
         progress=50,
         health='blocked',
         updated_at=${sqlValue(now)}
     WHERE id=${sqlValue(step.lane_id)};`
  );
  logWorkerEvent({
    runId: step.run_id,
    stepId: step.id,
    laneId: step.lane_id ?? undefined,
    eventType: "worker_blocked",
    message: `route block: ${exactBlocker}`,
    metadata: {
      exact_blocker: exactBlocker,
      ...(workerMode ? { worker_mode: workerMode } : {}),
      ...(adapterPolicy ? { adapter_policy: adapterPolicy } : {}),
      ...(command ? { command, command_display: command.display } : {}),
      route_decision_fingerprint: routeDecision?.fingerprint ?? null,
      route_readback_fingerprint: routeReadback?.fingerprint ?? null,
      proof_gate: proofGate,
      proof_summary: proofSummary,
      stop_reason: exactBlocker,
      ...(runnerSafety ? { runner_safety: runnerSafety } : {}),
      external_action_executed: false
    }
  });
  if (isReferenceWorkflowCanaryRun(step.run_id)) {
    try {
      const runtimeBinding = serviceReadinessRuntimeBindingForStep(step.run_id, step.id, runMetadata);
      const registeredWorkflowStart = runMetadata.registered_workflow_start;
      const artifact = writeNamedWorkerArtifact(step.run_id, `${step.id}-route-guard-attestation.json`, {
        schema: "automation_os_route_guard_attestation.v1",
        run_id: step.run_id,
        step_id: step.id,
        company_id: getRunCompanyId(step.run_id),
        adapter: stepMetadata.adapter ?? metadata.adapter ?? null,
        registered_workflow_start: registeredWorkflowStart ?? null,
        route_decision_fingerprint: routeDecision?.fingerprint ?? null,
        route_readback_fingerprint: routeReadback?.fingerprint ?? null,
        exact_blocker: exactBlocker,
        worker_outcome: "blocked_before_runner",
        completion_claimed: false,
        operation_proof_gate_ok: false,
        external_action_executed: false,
        ...(runtimeBinding ? { service_readiness_runtime_binding: runtimeBinding } : {}),
        created_at: now
      });
      insertRunProof(step.run_id, {
        id: makeId("proof"),
        run_id: step.run_id,
        step_id: step.id,
        proof_type: "registered_workflow_route_guard_attestation",
        label: `route guard attestation: ${exactBlocker}`,
        uri: artifact.uri,
        size_bytes: artifact.sizeBytes,
        created_at: now,
        metadata_json: {
          schema: "automation_os_route_guard_attestation.v1",
          adapter: stepMetadata.adapter ?? metadata.adapter ?? null,
          registered_workflow_start: registeredWorkflowStart ?? null,
          route_decision_fingerprint: routeDecision?.fingerprint ?? null,
          route_readback_fingerprint: routeReadback?.fingerprint ?? null,
          exact_blocker: exactBlocker,
          worker_outcome: "blocked_before_runner",
          completion_claimed: false,
          operation_proof_gate_ok: false,
          external_action_executed: false,
          ...(runtimeBinding ? { service_readiness_runtime_binding: runtimeBinding } : {}),
          checksum_sha256: artifact.checksumSha256,
          mime_type: artifact.mimeType,
          size_bytes: artifact.sizeBytes
        }
      });
    } catch (error) {
      logWorkerEvent({
        runId: step.run_id,
        stepId: step.id,
        laneId: step.lane_id ?? undefined,
        eventType: "worker_evidence_blocked",
        message: "route guard attestation could not be persisted",
        metadata: {
          exact_blocker: "route_guard_attestation_persistence_failed",
          route_blocker: exactBlocker,
          error: errorToMessage(error),
          external_action_executed: false
        }
      });
    }
  }
}

function evaluateStoredContractProofGate(runId: string, contract: RunContract) {
  const proofs = querySql<{ proof_type: string; label: string; uri: string; metadata_json: string }>(
    `SELECT proof_type, label, uri, metadata_json FROM proofs WHERE run_id=${sqlValue(runId)} ORDER BY created_at ASC`
  ).map((proof) => ({
    proofType: proof.proof_type,
    label: proof.label,
    uri: proof.uri,
    metadata: parseJson<Record<string, unknown>>(proof.metadata_json, {})
  }));
  return evaluateRunContractProofGate(contract, proofs);
}

function parseRunContract(value: unknown): RunContract | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Partial<RunContract>;
  if (candidate.workflow !== "NisenPrints" || !Array.isArray(candidate.requiredProofs)) return undefined;
  return candidate as RunContract;
}

/**
 * A reference readback proves route/auth/runtime/readback/cleanup only.  It
 * deliberately does not claim the business proofs required by a publish or
 * commerce contract, even when the contract is carried in run metadata for
 * provenance.  Effect-bearing stages continue to evaluate the contract.
 */
export function getRunContractForProofEvaluation(runId: string, runMetadata: Record<string, unknown>): RunContract | undefined {
  if (portableExternalReadOnlyStage(runId, runMetadata) === "reference_readback") return undefined;
  return parseRunContract(runMetadata.run_contract);
}

function summarizeRun(runId: string): CommandRunSummary {
  const run = querySql(`SELECT * FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  if (!run) throw new Error(`run_not_found:${runId}`);
  const steps = querySql(`SELECT * FROM run_steps WHERE run_id=${sqlValue(runId)} ORDER BY id ASC`);
  const approvals = querySql(`SELECT * FROM approvals WHERE run_id=${sqlValue(runId)} ORDER BY created_at ASC`);
  const proofs = querySql(`SELECT * FROM proofs WHERE run_id=${sqlValue(runId)} ORDER BY created_at ASC`);
  const children = querySql(`SELECT * FROM child_runs WHERE parent_run_id=${sqlValue(runId)} ORDER BY created_at ASC`);
  return { runId, run: sanitizeDashboardRows([run])[0], steps, approvals, proofs, children: sanitizeDashboardRows(children) };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

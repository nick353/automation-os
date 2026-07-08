import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { countConsoleErrors, runLocalBrowserBridgeCheck } from "../browser/localCheck.js";
import { sanitizeDashboardRows } from "../dashboardSanitizer.js";
import { execSql, insert, makeId, nowIso, querySql, sqlValue } from "../db/client.js";
import { decomposeGoal, PlannedTask } from "../planner/decompose.js";
import { createApprovalRequest, requiresApproval } from "./approvalGate.js";
import { dailyAiRegisteredOutputDir, evaluateDailyAiRegisteredSummary, runDailyAiRegisteredRunner } from "./dailyAiRegisteredRunner.js";
import { allocateParallelLanes, LaneAllocation, registeredBrowserLaneForRunnerKind, visibleBrowserLaneForRecordReplay } from "./laneManager.js";
import { resolveNisenPrintsPlaywrightRunner, runNisenPrintsRegisteredRunner } from "./nisenPrintsRegisteredRunner.js";
import { evaluateRunContractProofGate, summarizeProofGate, type ProofEvaluation } from "./proofGate.js";
import { promptTransferArtifactSize, resolvePromptTransferUkiyoeRunner, runPromptTransferRegisteredRunner } from "./promptTransferRegisteredRunner.js";
import { registeredCodexArtifactSize, runRegisteredCodexAutomation } from "./registeredCodexAutomationRunner.js";
import { resolveRunContract, RUN_CONTRACT_VERSION, RunContract } from "./runContracts.js";
import { resolveSnsMultiPosterUkiyoeRunner, runSnsMultiPosterRegisteredRunner, snsMultiPosterArtifactSize } from "./snsMultiPosterRegisteredRunner.js";

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
  | "local_worker";
export type WorkerMode =
  | "execute_child_codex"
  | "execute_codex"
  | "execute_playwright"
  | "execute_browser_use"
  | "execute_daily_ai_registered"
  | "execute_nisenprints_registered"
  | "execute_prompt_transfer_registered"
  | "execute_sns_multi_poster_registered"
  | "execute_registered_codex_automation"
  | "human_input_required_with_evidence"
  | "receipt_only";

export type WorkerCommandSpec = {
  bin: string;
  args: string[];
  env?: Record<string, string>;
  display: string;
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
  const explicitBrowserUseIntent = /browser[\s_-]*use/.test(haystack);
  const codeMaintenanceStructuralIntent = /executor|workerengine|コード|code|実装|レビュー|review|修正|設計|調査|docs?|ドキュメント/.test(haystack);
  const codeMaintenanceIntent = /executor|workerengine|コード|code|実装|レビュー|review|修正|設計|調査|qa|確認|test|テスト|docs?|ドキュメント/.test(haystack);
  const dailyAiRunIntent =
    /\bdaily[\s_-]*ai\b\s*(social_publish)?$|daily-ai-research-publish-run|publish|post|投稿|実行|回して|run|完走|full[\s_-]*flow/.test(
      haystack
    );
  if (dailyAiIntent && !codeMaintenanceIntent && dailyAiRunIntent) {
    return "daily_ai_registered";
  }
  if (nisenPrintsIntent && !codeMaintenanceIntent && /registered workflow|full publish|approval\/proof gate|公開|実行|run/.test(haystack)) {
    return "nisenprints_registered";
  }
  if ((jobSubmitIntent || jobFollowupIntent) && !codeMaintenanceIntent) {
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
    return "playwright_cli";
  }
  if (codeMaintenanceIntent || /research|調査|watchtower|codex|code|コード|実装|レビュー|review|修正|qa|確認|test|テスト/.test(haystack)) {
    return "child_codex";
  }
  if (/playwright|browser use|browser|chrome|runway|mcp/.test(haystack)) {
    return "playwright_cli";
  }
  if (/x\.com|twitter|linkedin|pinterest|投稿|publish/.test(haystack) && !codeMaintenanceIntent) {
    return "playwright_cli";
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
    return {
      bin: process.env.AUTOMATION_OS_CHILD_CODEX_BIN || process.env.AUTOMATION_OS_CODEX_BIN || "codex",
      args: ["exec", "--sandbox", "read-only", "--cd", process.env.AUTOMATION_OS_CHILD_CODEX_CWD || process.cwd(), input.taskName],
      display: `codex exec --sandbox read-only --cd ${JSON.stringify(process.env.AUTOMATION_OS_CHILD_CODEX_CWD || process.cwd())} ${JSON.stringify(
        input.taskName
      )}`
    };
  }
  if (input.adapter === "codex_cli") {
    return {
      bin: process.env.AUTOMATION_OS_CODEX_BIN || "codex",
      args: ["exec", "--sandbox", "read-only", input.taskName],
      display: `codex exec --sandbox read-only ${JSON.stringify(input.taskName)}`
    };
  }
  if (input.adapter === "playwright_cli" || input.adapter === "browser_use_cli") {
    const port = input.lane?.cdp_port ?? 9333;
    const profile = input.lane?.profile_dir ?? "/tmp/automation-os/profile";
    const workdir = input.lane?.workdir ?? "/tmp/automation-os/workdir";
    const session = `browser-use-${String(input.taskName)
      .replace(/[^0-9A-Za-z_.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 48) || "task"}`;
    return {
      bin: process.env.AUTOMATION_OS_PLAYWRIGHT_CLI || process.env.PWCLI || "/Users/nichikatanaka/.codex/skills/playwright/scripts/playwright_cli.sh",
      args: ["open", process.env.AUTOMATION_OS_BROWSER_CHECK_URL || "http://127.0.0.1:5173/#sources"],
      env: {
        PLAYWRIGHT_CLI_SESSION: session,
        PLAYWRIGHT_CLI_PROFILE: profile,
        PLAYWRIGHT_CLI_WORKDIR: workdir,
        PLAYWRIGHT_CLI_CDP_URL: `http://127.0.0.1:${port}`
      },
      display: `PLAYWRIGHT_CLI_CDP_URL=http://127.0.0.1:${port} PLAYWRIGHT_CLI_PROFILE=${JSON.stringify(profile)} PLAYWRIGHT_CLI_WORKDIR=${JSON.stringify(
        workdir
      )} PLAYWRIGHT_CLI_SESSION=${JSON.stringify(session)} playwright-cli open ${JSON.stringify(process.env.AUTOMATION_OS_BROWSER_CHECK_URL || "http://127.0.0.1:5173/#sources")}`
    };
  }
  if (input.adapter === "daily_ai_registered") {
    const runner = process.env.AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER || "/Users/nichikatanaka/Documents/New project/scripts/run_daily_ai_playwright_cli.mjs";
    const registeredLane = visibleBrowserLaneForRecordReplay(registeredBrowserLaneForRunnerKind("daily_ai_registered"));
    return {
      bin: process.env.AUTOMATION_OS_NODE_BIN || "node",
      args: [runner],
      env: {
        DAILY_AI_BROWSER_DRIVER: "playwright_cli",
        DAILY_AI_CLI_REQUIRE_BROWSER_USE: "0",
        DAILY_AI_CLI_RECORDING_REQUIRED: "0",
        DAILY_AI_CLI_EXTERNAL_VIDEO_QA_REQUIRED: "0",
        DAILY_AI_CLI_REQUIRE_FEED_STUDY: "false",
        DAILY_AI_CLI_REQUIRE_SHIP_NOW_BUFFER: "false",
        DAILY_AI_CLI_REPLENISH_BUFFER_TIMEOUT_MS: "600000",
        DAILY_AI_RUNWAY_MCP_TIMEOUT_SECONDS: "300",
        DAILY_AI_CDP_PORT: String(registeredLane?.cdpPort ?? 9333),
        DAILY_AI_CLI_PROFILE_DIR: registeredLane?.profileDir ?? "/Users/nichikatanaka/.daily-ai-playwright-chrome",
        DAILY_AI_CLI_HEADLESS: registeredLane?.laneVisibility === "headless" ? "true" : "false",
        DAILY_AI_CLI_SHOW_BROWSER: registeredLane?.laneVisibility === "visible" ? "true" : "false"
      },
      display:
        `DAILY_AI_CDP_PORT=${String(registeredLane?.cdpPort ?? 9333)} DAILY_AI_CLI_PROFILE_DIR=${JSON.stringify(
          registeredLane?.profileDir ?? "/Users/nichikatanaka/.daily-ai-playwright-chrome"
        )} DAILY_AI_CLI_HEADLESS=${registeredLane?.laneVisibility === "headless" ? "true" : "false"} DAILY_AI_CLI_SHOW_BROWSER=${
          registeredLane?.laneVisibility === "visible" ? "true" : "false"
        } DAILY_AI_CLI_EXTERNAL_VIDEO_QA_REQUIRED=0 DAILY_AI_CLI_REPLENISH_BUFFER_TIMEOUT_MS=600000 DAILY_AI_RUNWAY_MCP_TIMEOUT_SECONDS=300 node ${JSON.stringify(runner)}`
    };
  }
  if (input.adapter === "nisenprints_registered") {
    const resolvedRunner = resolveNisenPrintsPlaywrightRunner({ defaultRunnerPath: input.nisenprintsDefaultRunnerPath });
    const runIdPlaceholder = "<AUTOMATION_OS_RUN_ID>";
    const outputDirPlaceholder = "<NISENPRINTS_OUTPUT_DIR>";
    const summaryPathPlaceholder = "<NISENPRINTS_REGISTERED_SUMMARY_PATH>";
    const nodeBin = process.env.AUTOMATION_OS_NODE_BIN || "node";
    const stageTimeoutMs = process.env.AUTOMATION_STAGE_TIMEOUT_MS || "900000";
    return {
      bin: nodeBin,
      args: resolvedRunner.runner ? [resolvedRunner.runner] : ["<NisenPrints Playwright CLI runner missing>"],
      env: {
        NISENPRINTS_BROWSER_DRIVER: "playwright_cli",
        NISENPRINTS_REQUIRE_BROWSER_USE: "0",
        NISENPRINTS_RECORDING_REQUIRED: "0",
        NISENPRINTS_GEMINI_VIDEO_QA_REQUIRED: "0",
        AUTOMATION_OS_RUN_ID: runIdPlaceholder,
        NISENPRINTS_REGISTERED_SUMMARY_PATH: summaryPathPlaceholder,
        NISENPRINTS_OUTPUT_DIR: outputDirPlaceholder,
        AUTOMATION_STAGE_TIMEOUT_MS: stageTimeoutMs
      },
      display: resolvedRunner.runner
        ? `NISENPRINTS_BROWSER_DRIVER=playwright_cli NISENPRINTS_REQUIRE_BROWSER_USE=0 NISENPRINTS_RECORDING_REQUIRED=0 NISENPRINTS_GEMINI_VIDEO_QA_REQUIRED=0 AUTOMATION_OS_RUN_ID=${JSON.stringify(
            runIdPlaceholder
          )} NISENPRINTS_REGISTERED_SUMMARY_PATH=${JSON.stringify(summaryPathPlaceholder)} NISENPRINTS_OUTPUT_DIR=${JSON.stringify(
            outputDirPlaceholder
          )} AUTOMATION_STAGE_TIMEOUT_MS=${JSON.stringify(stageTimeoutMs)} ${nodeBin} ${JSON.stringify(resolvedRunner.runner)}`
        : "NisenPrints Playwright CLI runner is not configured"
    };
  }
  if (input.adapter === "prompt_transfer_registered") {
    const resolvedRunner = resolvePromptTransferUkiyoeRunner();
    return {
      bin: resolvedRunner.runner ? process.env.PYTHON || process.env.PYTHON3 || "python3" : "automation-os-fail-closed",
      args: resolvedRunner.runner ? [resolvedRunner.runner, "--run-id", "<run_id>", "--out-root", "<artifact_root>", "--commit", "--allow-external-commit"] : ["prompt-transfer-ukiyoe"],
      env: {
        AUTOMATION_OS_REGISTERED_WORKFLOW_ID: "prompt-transfer-ukiyoe",
        PROMPT_TRANSFER_EXTERNAL_COMMIT_REQUESTED: "1",
        PROMPT_TRANSFER_ALLOW_EXTERNAL_COMMIT: "1"
      },
      display: resolvedRunner.runner
        ? `python3 ${JSON.stringify(resolvedRunner.runner)} --run-id "<run_id>" --out-root "<artifact_root>" --commit --allow-external-commit`
        : "Prompt Transfer Playwright/Sheets runner missing; Browser Use wrapper will not be launched"
    };
  }
  if (input.adapter === "sns_multi_poster_registered") {
    const resolvedRunner = resolveSnsMultiPosterUkiyoeRunner();
    return {
      bin: resolvedRunner.runner ? process.env.AUTOMATION_OS_NODE_BIN || "node" : "automation-os-fail-closed",
      args: resolvedRunner.runner
        ? [resolvedRunner.runner, "--run-id", "<run_id>", "--out-root", "<artifact_root>", "--image-path", "<SNS_MULTI_POSTER_IMAGE_PATH>", "--caption", "<SNS_MULTI_POSTER_CAPTION>"]
        : ["sns-multi-poster-ukiyoe"],
      env: {
        AUTOMATION_OS_REGISTERED_WORKFLOW_ID: "sns-multi-poster-ukiyoe",
        SNS_MULTI_POSTER_APPROVED_EXTERNAL_ACTIONS: "post,publish",
        SNS_MULTI_POSTER_HARD_STOPS: "billing,purchase,payment,checkout"
      },
      display: resolvedRunner.runner
        ? `node ${JSON.stringify(resolvedRunner.runner)} --run-id "<run_id>" --out-root "<artifact_root>" --image-path "<SNS_MULTI_POSTER_IMAGE_PATH>" --caption "<SNS_MULTI_POSTER_CAPTION>"`
        : "SNS Multi Poster Ukiyoe Playwright CLI runner is not connected; capture callable surface/auth human-input evidence"
    };
  }
  if (input.adapter === "job_submit_registered" || input.adapter === "job_followup_registered") {
    const workflowId = "job-application-manager";
    return {
      bin: process.env.AUTOMATION_OS_CODEX_BIN || "codex",
      args: ["exec", "--sandbox", "workspace-write", "--cd", "/Users/nichikatanaka/Documents/New project", "<registered automation prompt>"],
      env: {
        AUTOMATION_OS_REGISTERED_WORKFLOW_ID: workflowId,
        AUTOMATION_OS_RUN_ID: "<AUTOMATION_OS_RUN_ID>",
        AUTOMATION_OS_REGISTERED_SUMMARY_PATH: "<AUTOMATION_OS_REGISTERED_SUMMARY_PATH>"
      },
      display: `AUTOMATION_OS_RUN_ID="<AUTOMATION_OS_RUN_ID>" AUTOMATION_OS_REGISTERED_SUMMARY_PATH="<AUTOMATION_OS_REGISTERED_SUMMARY_PATH>" codex exec --sandbox workspace-write --cd "/Users/nichikatanaka/Documents/New project" "<${workflowId} automation.toml prompt>"`
    };
  }
  if (isHumanInputRequiredWithEvidenceAdapter(input.adapter)) {
    const workflowId = humanInputRequiredWithEvidenceWorkflowId(input.adapter);
    return {
      bin: "automation-os-human-input-required",
      args: [workflowId],
      env: {
        AUTOMATION_OS_REGISTERED_WORKFLOW_ID: workflowId,
        AUTOMATION_OS_HARD_STOPS: "billing,purchase,payment,checkout",
        AUTOMATION_OS_HUMAN_INPUT_REQUIRED_WITH_EVIDENCE: "captcha,otp,security_code,identity_verification,auth_callable_surface"
      },
      display: `${workflowId} runner callable surface is not connected; capture URL/screenshot/DOM/exact blocker as human input required`
    };
  }
  return {
    bin: "automation-os-local-worker",
    args: [input.taskName],
    display: `automation-os-local-worker ${JSON.stringify(input.taskName)}`
  };
}

export type StartCommandRunOptions = {
  metadata?: Record<string, unknown>;
  deferWorker?: boolean;
};

export async function startCommandRun(command: string, options: StartCommandRunOptions = {}) {
  const plan = planCommandRun(command);
  const runId = makeId("run");
  const now = nowIso();
  insert("runs", {
    id: runId,
    name: command.slice(0, 72) || "Automation OS command",
    status: plan.approvalRequired ? "waiting_approval" : "queued",
    objective: command,
    created_at: now,
    updated_at: now,
    metadata_json: {
      command,
      plan,
      ...(options.metadata ?? {}),
      ...(plan.runContract ? { run_contract: plan.runContract, contract_version: plan.contractVersion } : {}),
      ai_adapters: ["codex_cli", "chatgpt_subscription", "playwright_cli"],
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
      status: task?.requiresApproval ? "blocked" : "active",
      current_task: task?.name ?? "standby",
      progress: task?.requiresApproval ? 0 : 10,
      health: lane.collisionWith.length ? "collision" : task?.requiresApproval ? "approval_required" : "good",
      resource_locks_json: lane.resourceLocks,
      updated_at: now
    });
  });

  plan.tasks.forEach((task, index) => {
    insert("run_steps", {
      id: `${runId}_step_${index + 1}`,
      run_id: runId,
      name: task.name,
      status: task.requiresApproval ? "waiting_approval" : "queued",
      lane_id: `${runId}_${plan.lanes[index]?.id}`,
      started_at: task.requiresApproval ? null : now,
      completed_at: null,
      metadata_json: {
        resources: task.resources,
        dangerous_action: task.dangerousAction,
        requires_approval: task.requiresApproval,
        collision_with: task.collisionWith,
        collision_override_required: task.collisionWith.length > 0,
        adapter: task.adapter,
        parallel_safe: task.parallelSafe
      }
    });
  });

  if (plan.approvalRequired) {
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
    ? [runId]
    : querySql<{ id: string }>("SELECT id FROM runs WHERE status IN ('queued', 'running', 'waiting_approval') ORDER BY created_at ASC").map(
        (row) => row.id
      );
  const summaries = [];
  for (const id of runIds) {
    summaries.push(await runWorkerCycle(id));
  }
  return summaries;
}

export async function runWorkerCycle(runId: string) {
  const run = querySql<{ id: string; status: string }>(`SELECT id, status FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  if (!run) return { runId, status: "missing" };

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
    const metadata = parseJson<Record<string, unknown>>(step.metadata_json, {});
    const requires = Boolean(metadata.requires_approval);
    if (requires && !protectedStepsAllowed) {
      blockedByApproval = true;
      continue;
    }
    if (step.status === "completed" || step.status === "running") continue;
    if (step.status === "waiting_approval" || step.status === "queued") {
      const result = await completeWorkerStep(step, metadata);
      if (result) {
        registeredExecutionResults.push(result);
      }
    }
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
  const runContract = parseRunContract(runMetadata.run_contract);
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
  updateRunStatus(runId, status, {
    worker_protocol: "local_worker_v1",
    worker_mode: workerMode,
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
    if (proof.proof_type === "playwright_check") {
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
    metadata.execution_mode === "execute_registered_codex_automation"
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

async function completeWorkerStep(
  step: StepRow,
  metadata: Record<string, unknown>
): Promise<RegisteredExecutionResult | undefined> {
  const now = nowIso();
  const lane = step.lane_id
    ? querySql<LaneRow>(
        `SELECT id, cdp_port, profile_dir, workdir, browser_use_session, browser_use_cdp_url, browser_use_profile, profile_strategy, lane_visibility FROM lanes WHERE id=${sqlValue(
          step.lane_id
        )} LIMIT 1`
      )[0]
    : undefined;
  const adapter = String(metadata.adapter ?? "local_worker") as WorkerAdapter;
  const command = buildWorkerCommand({ adapter, taskName: step.name, lane });
  const startedRunnerSafety = registeredRunnerSafetyMetadataForAdapter(adapter);
  execSql(
    `UPDATE run_steps SET status='running', started_at=COALESCE(started_at, ${sqlValue(now)}) WHERE id=${sqlValue(step.id)};
     UPDATE lanes SET status='active', progress=50, updated_at=${sqlValue(now)} WHERE id=${sqlValue(step.lane_id)};`
  );
  updateRunStatus(step.run_id, "running", {
    worker_protocol: "local_worker_v1",
    worker_mode: adapter === "daily_ai_registered" ? "execute_daily_ai_registered" : "execute_worker_step",
    active_step_id: step.id,
    active_adapter: adapter,
    worker_started_at: now
  });
  logWorkerEvent({
    runId: step.run_id,
    stepId: step.id,
    laneId: step.lane_id ?? undefined,
    eventType: "worker_started",
    message: command.display,
    metadata: {
      adapter,
      ...(startedRunnerSafety ? { runner_safety: startedRunnerSafety } : {}),
      ...(command.env ? { command_env: command.env } : {})
    }
  });

  if (adapter === "daily_ai_registered") {
    const runner_safety = runnerSafetyMetadata("billing_only");
    const result = runDailyAiRegisteredRunner({ runId: step.run_id, startedAtMs: Date.now() });
    const summarySize = result.summaryPath && existsSync(result.summaryPath) ? statSync(result.summaryPath).size : 0;
    for (const proof of result.proofs) {
      insert("proofs", {
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
        adapter,
        command,
        command_display: command.display,
        daily_ai_status: result.status,
        daily_ai_summary_path: result.summaryPath,
        daily_ai_exit_status: result.exitStatus,
        daily_ai_signal: result.signal,
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
        adapter,
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

  if (adapter === "nisenprints_registered") {
    const runner_safety = runnerSafetyMetadata("billing_only");
    const result = runNisenPrintsRegisteredRunner({ runId: step.run_id, startedAtMs: Date.now() });
    const summarySize = result.summaryPath && existsSync(result.summaryPath) ? statSync(result.summaryPath).size : 0;
    for (const proof of result.proofs) {
      insert("proofs", {
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
        adapter,
        command,
        command_display: command.display,
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
        adapter,
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

  if (adapter === "job_submit_registered" || adapter === "job_followup_registered") {
    const runner_safety = runnerSafetyMetadata("billing_only");
    const workflowId = adapter;
    const result = runRegisteredCodexAutomation({ runId: step.run_id, workflowId });
    for (const proof of result.proofs) {
      insert("proofs", {
        id: makeId("proof"),
        run_id: step.run_id,
        step_id: step.id,
        proof_type: proof.proofType,
        label: proof.label,
        uri: proof.uri,
        size_bytes: registeredCodexArtifactSize(result.artifactPath),
        created_at: nowIso(),
        metadata_json: proof.metadata ?? {}
      });
    }
    const completedAt = nowIso();
    const stepStatus = result.status === "blocked" ? "blocked" : "completed";
    const laneStatus = result.status === "blocked" ? "blocked" : "idle";
    const laneHealth = result.status === "complete" ? "good" : "blocked";
    execSql(
      `UPDATE run_steps SET status=${sqlValue(stepStatus)}, completed_at=${sqlValue(completedAt)}, metadata_json=${sqlValue({
        ...metadata,
        adapter,
        command,
        command_display: command.display,
        registered_codex_status: result.status,
        registered_codex_artifact: pathToFileUri(result.artifactPath),
        registered_codex_exit_status: result.exitStatus,
        registered_codex_signal: result.signal,
        proof_gate: result.proof_gate,
        proof_summary: result.proof_summary,
        issue_ledger_summary: result.metadata.issue_ledger_summary,
        runner_safety
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
        adapter,
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
      workerMode: "execute_registered_codex_automation",
      status: result.status,
      proof_gate: result.proof_gate,
      proof_summary: result.proof_summary,
      metadata: {
        ...result.metadata,
        runner_safety,
        registered_codex_executor: {
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

  if (adapter === "prompt_transfer_registered") {
    const result = runPromptTransferRegisteredRunner({ runId: step.run_id });
    const summarySize = promptTransferArtifactSize(result.summaryPath);
    for (const proof of result.proofs) {
      insert("proofs", {
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
        adapter,
        command,
        command_display: command.display,
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
        adapter,
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

  if (adapter === "sns_multi_poster_registered") {
    const result = runSnsMultiPosterRegisteredRunner({ runId: step.run_id });
    const summarySize = snsMultiPosterArtifactSize(result.summaryPath);
    for (const proof of result.proofs) {
      insert("proofs", {
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
        adapter,
        command,
        command_display: command.display,
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
        adapter,
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

  if (isHumanInputRequiredWithEvidenceAdapter(adapter)) {
    const result = humanInputRequiredWithEvidenceRunner({ adapter, runId: step.run_id, stepId: step.id, command, createdAt: now });
    insert("proofs", {
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
        adapter,
        command,
        command_display: command.display,
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
          adapter,
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

  if (adapter === "playwright_cli" || adapter === "browser_use_cli") {
    const normalizedAdapter: WorkerAdapter = "playwright_cli";
    const result = runLocalBrowserBridgeCheck({ command: command.bin, env: command.env });
    const exactBlocker =
      result.status === "ok"
        ? null
        : result.metadata.missingArtifacts[0]
          ? `playwright_artifact_missing:${result.metadata.missingArtifacts[0]}`
          : result.consoleErrorCount > 0
            ? "playwright_console_errors"
            : "playwright_check_blocked";
    const artifact = writeNamedWorkerArtifact(step.run_id, `${step.id}-playwright-check.json`, {
      runId: step.run_id,
      stepId: step.id,
      task: step.name,
      adapter: normalizedAdapter,
      mode: "playwright_cli",
      status: result.status,
      targetUrl: result.targetUrl,
      exactBlocker,
      command,
      commandDisplay: command.display,
      lane,
      playwrightCheck: result,
      createdAt: now
    });
    insert("proofs", {
      id: makeId("proof"),
      run_id: step.run_id,
      step_id: step.id,
      proof_type: result.status === "ok" ? "playwright_check" : "playwright_blocked",
      label: `Playwright check: ${step.name}`,
      uri: artifact.uri,
      size_bytes: artifact.sizeBytes,
      created_at: nowIso(),
      metadata_json: {
        adapter: normalizedAdapter,
        command,
        command_display: command.display,
        execution_mode: "execute_playwright",
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
        command,
        command_display: command.display,
        execution_mode: "execute_playwright",
        playwright_status: result.status,
        playwright_check_artifact: artifact.uri,
        playwright_exact_blocker: exactBlocker
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
      message: result.status === "ok" ? `Playwright check completed at ${artifact.uri}` : `Playwright check blocked: ${exactBlocker}`,
      metadata: { adapter: normalizedAdapter, artifact, status: result.status, exact_blocker: exactBlocker }
    });
    return {
      workerMode: "execute_playwright",
      status: result.status === "ok" ? "complete" : "blocked",
      proof_gate:
        result.status === "ok"
          ? { ok: true, missing: [], present: ["playwright_check", `playwright_check:${step.id}`] }
          : { ok: false, missing: [exactBlocker ?? "playwright_check_blocked"], present: ["playwright_blocked", `playwright_blocked:${step.id}`] },
      proof_summary: result.status === "ok" ? "complete: Playwright CLI screen proof captured" : `blocked: ${exactBlocker}`,
      metadata: {
        playwright_executor: {
          status: result.status,
          exact_blocker: exactBlocker,
          artifact_uri: artifact.uri
        }
      }
    };
  }

  if (shouldExecuteCodexReadonly(adapter)) {
    launchCodexReadonlyStep({
      step,
      metadata,
      command,
      lane,
      createdAt: now
    });
    return;
  }

  if (adapter === "child_codex") {
    launchChildCodexReadonlyStep({
      step,
      metadata,
      command,
      lane,
      createdAt: now
    });
    return;
  }

  const artifact = writeWorkerArtifact(step.run_id, step.id, {
    runId: step.run_id,
    stepId: step.id,
    task: step.name,
    adapter,
    command,
    commandDisplay: command.display,
    lane,
    resources: metadata.resources ?? [],
    ai: adapter === "codex_cli" ? "codex_cli_subscription_lane" : "local_worker_lane",
    openaiApiRequired: false,
    mode: "receipt_only",
    createdAt: now
  });

  insert("proofs", {
    id: makeId("proof"),
    run_id: step.run_id,
    step_id: step.id,
    proof_type: "worker_receipt",
    label: `${adapter} receipt: ${step.name}`,
    uri: artifact.uri,
    size_bytes: artifact.sizeBytes,
    created_at: nowIso(),
    metadata_json: { adapter, command, command_display: command.display, execution_mode: "receipt_only", receipt_only: true }
  });

  execSql(
    `UPDATE run_steps SET status='completed', completed_at=${sqlValue(nowIso())}, metadata_json=${sqlValue({
      ...metadata,
      adapter,
      command,
      command_display: command.display,
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
    metadata: { adapter, artifact }
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
    cwd: process.cwd(),
    env: { ...process.env, ...(input.command.env ?? {}) },
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
    cwd: process.cwd(),
    env: { ...process.env, ...(input.command.env ?? {}) },
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
  insert("proofs", {
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
  insert("proofs", {
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
  if (hasActiveDailyAiRegisteredProcess()) return;
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
    const summaryPath = `${dailyAiRegisteredOutputDir(runId).outputDir}/registered-playwright-cli-summary.json`;
    if (!existsSync(summaryPath)) continue;
    const evaluation = evaluateDailyAiRegisteredSummary(summaryPath);
    reconcileStaleDailyAiRegisteredStep({ step, evaluation, summaryPath, staleAfterMs });
  }
}

function reconcileStaleDailyAiRegisteredStep(input: {
  step: StepRow;
  evaluation: ReturnType<typeof evaluateDailyAiRegisteredSummary>;
  summaryPath: string;
  staleAfterMs: number;
}) {
  const completedAt = nowIso();
  const metadata = parseJson<Record<string, unknown>>(input.step.metadata_json, {});
  const runner_safety = runnerSafetyMetadata("billing_only");
  const stepStatus = input.evaluation.status === "complete" ? "completed" : "blocked";
  const laneStatus = input.evaluation.status === "complete" ? "idle" : "blocked";
  const laneHealth = input.evaluation.status === "complete" ? "good" : input.evaluation.status;
  const summarySize = existsSync(input.summaryPath) ? statSync(input.summaryPath).size : 0;
  const existingProofTypes = new Set(
    querySql<{ proof_type: string }>(
      `SELECT proof_type FROM proofs WHERE run_id=${sqlValue(input.step.run_id)} AND step_id=${sqlValue(input.step.id)}`
    ).map((proof) => proof.proof_type)
  );
  for (const proof of input.evaluation.proofs) {
    if (existingProofTypes.has(proof.proofType)) continue;
    insert("proofs", {
      id: makeId("proof"),
      run_id: input.step.run_id,
      step_id: input.step.id,
      proof_type: proof.proofType,
      label: proof.label,
      uri: proof.uri,
      size_bytes: summarySize,
      created_at: nowIso(),
      metadata_json: proof.metadata ?? {}
    });
  }
  execSql(
    `UPDATE run_steps SET status=${sqlValue(stepStatus)},
       completed_at=${sqlValue(completedAt)},
       metadata_json=${sqlValue({
         ...metadata,
         adapter: "daily_ai_registered",
         execution_mode: "execute_daily_ai_registered",
         daily_ai_status: input.evaluation.status,
         daily_ai_summary_path: input.evaluation.summaryPath,
         proof_gate: input.evaluation.proof_gate,
         proof_summary: input.evaluation.proof_summary,
         issue_ledger_summary: input.evaluation.metadata.issue_ledger_summary,
         runner_safety,
         reconciled_from_stale_registered_summary: true,
         stale_after_ms: input.staleAfterMs
       })}
      WHERE id=${sqlValue(input.step.id)} AND status='running';
     UPDATE lanes SET status=${sqlValue(laneStatus)},
       progress=${input.evaluation.status === "complete" ? 100 : 50},
       health=${sqlValue(laneHealth)},
       updated_at=${sqlValue(completedAt)}
      WHERE id=${sqlValue(input.step.lane_id)};`
  );
  logWorkerEvent({
    runId: input.step.run_id,
    stepId: input.step.id,
    laneId: input.step.lane_id ?? undefined,
    eventType: input.evaluation.status === "complete" ? "worker_completed" : "worker_blocked",
    message: `Daily AI registered stale running step reconciled from summary: ${input.evaluation.proof_summary}`,
    metadata: {
      adapter: "daily_ai_registered",
      status: input.evaluation.status,
      summary_path: input.evaluation.summaryPath,
      proof_gate: input.evaluation.proof_gate,
      issue_ledger_summary: input.evaluation.metadata.issue_ledger_summary,
      runner_safety,
      reconciled_from_stale_registered_summary: true
    }
  });
}

function hasActiveDailyAiRegisteredProcess(): boolean {
  if (process.env.AUTOMATION_OS_TEST_IGNORE_DAILY_AI_PROCESS === "1") return false;
  if (process.env.NODE_TEST_CONTEXT === "1" && process.env.AUTOMATION_OS_TEST_RESPECT_DAILY_AI_PROCESS !== "1") return false;
  const result = spawnSync("ps", ["axww", "-o", "command="], { encoding: "utf8" });
  if (result.status !== 0) return false;
  return String(result.stdout || "")
    .split(/\r?\n/)
    .some(
      (line) =>
        line.includes("run_daily_ai_playwright_cli.mjs") ||
        (line.includes("--remote-debugging-port=9333") && line.includes("--user-data-dir=/Users/nichikatanaka/.daily-ai-playwright-chrome"))
    );
}

function reconcileStaleRegisteredCodexAutomationRuns(runId: string) {
  if (hasActiveRegisteredCodexAutomationProcess(runId)) return;
  const staleAfterMs = Number(process.env.AUTOMATION_OS_REGISTERED_STALE_AFTER_MS || 10 * 60 * 1000);
  const nowMs = Date.now();
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
    if (!Number.isFinite(startedMs) || nowMs - startedMs <= staleAfterMs) continue;
    reconcileStaleRegisteredCodexAutomationStep({ step, staleAfterMs });
  }
}

function reconcileStaleRegisteredCodexAutomationStep(input: { step: StepRow; staleAfterMs: number }) {
  const completedAt = nowIso();
  const metadata = parseJson<Record<string, unknown>>(input.step.metadata_json, {});
  const adapter = String(metadata.adapter ?? "");
  const proofType = registeredCodexProofTypeForAdapter(adapter);
  if (!proofType) return;
  const runner_safety = runnerSafetyMetadata("billing_only");
  const blocker = "registered_codex_parent_exited_before_result_proof";
  const proof_gate = {
    ok: false,
    missing: [proofType],
    present: [`${proofType}_blocked`]
  };
  const artifact = writeNamedWorkerArtifact(input.step.run_id, `${input.step.id}-registered-codex-stale-blocked.json`, {
    runId: input.step.run_id,
    stepId: input.step.id,
    adapter,
    status: "blocked",
    blocker,
    proof_gate,
    started_at: input.step.started_at,
    completed_at: completedAt,
    stale_after_ms: input.staleAfterMs,
    parent_only: true,
    codex_cli_rerun_suppressed: true,
    runner_safety
  });
  const existingProof = querySql<{ id: string }>(
    `SELECT id FROM proofs WHERE run_id=${sqlValue(input.step.run_id)} AND step_id=${sqlValue(input.step.id)} AND proof_type=${sqlValue(`${proofType}_blocked`)} LIMIT 1`
  )[0];
  if (!existingProof) {
    insert("proofs", {
      id: makeId("proof"),
      run_id: input.step.run_id,
      step_id: input.step.id,
      proof_type: `${proofType}_blocked`,
      label: `${adapter} stale registered Codex execution blocked`,
      uri: artifact.uri,
      size_bytes: artifact.sizeBytes,
      created_at: completedAt,
      metadata_json: {
        adapter,
        blocker,
        proof_gate,
        artifact_path: artifact.path,
        parent_only: true,
        codex_cli_rerun_suppressed: true
      }
    });
  }
  execSql(
    `UPDATE run_steps SET status='blocked',
       completed_at=${sqlValue(completedAt)},
       metadata_json=${sqlValue({
         ...metadata,
         adapter,
         execution_mode: "execute_registered_codex_automation",
         registered_codex_status: "blocked",
         registered_codex_artifact: artifact.uri,
         registered_codex_exit_status: null,
         registered_codex_signal: null,
         proof_gate,
         proof_summary: `blocked: ${blocker}`,
         runner_safety,
         reconciled_from_stale_registered_codex: true,
         stale_after_ms: input.staleAfterMs
       })}
      WHERE id=${sqlValue(input.step.id)} AND status='running';
     UPDATE lanes SET status='blocked',
       progress=50,
       health='blocked',
       updated_at=${sqlValue(completedAt)}
      WHERE id=${sqlValue(input.step.lane_id)};`
  );
  logWorkerEvent({
    runId: input.step.run_id,
    stepId: input.step.id,
    laneId: input.step.lane_id ?? undefined,
    eventType: "worker_blocked",
    message: `Registered Codex stale running step blocked without rerun: ${blocker}`,
    metadata: {
      adapter,
      status: "blocked",
      artifact_path: artifact.path,
      proof_gate,
      runner_safety,
      blocker,
      parent_only: true,
      codex_cli_rerun_suppressed: true,
      reconciled_from_stale_registered_codex: true
    }
  });
}

function registeredCodexProofTypeForAdapter(adapter: string): string | undefined {
  if (adapter === "job_submit_registered") return "job_submit_registered_codex_execution";
  if (adapter === "job_followup_registered") return "job_followup_registered_codex_execution";
  return undefined;
}

function hasActiveRegisteredCodexAutomationProcess(runId: string): boolean {
  const result = spawnSync("ps", ["axww", "-o", "command="], { encoding: "utf8" });
  if (result.status !== 0) return false;
  const codexExecPattern = /(?:^|\s)(?:codex|[^"\s]*\/codex)\s+exec(?:\s|$)/;
  return String(result.stdout || "")
    .split(/\r?\n/)
    .some((line) => codexExecPattern.test(line) && line.includes("/Users/nichikatanaka/Documents/New project") && line.includes(runId));
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
  insert("proofs", {
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
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value ?? "";
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pathToFileUri(path: string): string {
  return `file://${path}`;
}

function writeWorkerArtifact(runId: string, stepId: string, payload: Record<string, unknown>) {
  return writeNamedWorkerArtifact(runId, `${stepId}.json`, payload);
}

function writeNamedWorkerArtifact(runId: string, filename: string, payload: Record<string, unknown>) {
  const artifactRoot = process.env.AUTOMATION_OS_ARTIFACT_ROOT ? resolve(process.env.AUTOMATION_OS_ARTIFACT_ROOT) : resolve(process.cwd(), "data", "artifacts");
  const artifactPath = resolve(artifactRoot, runId, filename);
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, JSON.stringify(payload, null, 2));
  const sizeBytes = existsSync(artifactPath) ? statSync(artifactPath).size : 0;
  return { path: artifactPath, uri: pathToFileUri(artifactPath), sizeBytes };
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

function summarizeRun(runId: string) {
  const run = querySql(`SELECT * FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  const steps = querySql(`SELECT * FROM run_steps WHERE run_id=${sqlValue(runId)} ORDER BY id ASC`);
  const approvals = querySql(`SELECT * FROM approvals WHERE run_id=${sqlValue(runId)} ORDER BY created_at ASC`);
  const proofs = querySql(`SELECT * FROM proofs WHERE run_id=${sqlValue(runId)} ORDER BY created_at ASC`);
  const children = querySql(`SELECT * FROM child_runs WHERE parent_run_id=${sqlValue(runId)} ORDER BY created_at ASC`);
  return { runId, run: run ? sanitizeDashboardRows([run])[0] : run, steps, approvals, proofs, children: sanitizeDashboardRows(children) };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

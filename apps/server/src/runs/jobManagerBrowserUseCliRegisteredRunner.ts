import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Proof } from "./proofGate.js";
import { BROWSER_USE_HELPER_PATH, BROWSER_USE_RUNTIME_CONFIG_PATH, BROWSER_USE_STAGE_ADAPTER_PATH } from "../serviceReadiness/browserUseCanonical.js";

export type JobManagerBrowserUseCliRegisteredStatus = "blocked";

export type JobManagerBrowserUseCliRegisteredRunResult = {
  status: JobManagerBrowserUseCliRegisteredStatus;
  proof_gate: { ok: false; missing: string[]; present: string[] };
  proof_summary: string;
  proofs: Proof[];
  metadata: Record<string, unknown>;
  command: {
    bin: string;
    args: string[];
    cwd: string;
    display: string;
    env: Record<string, string>;
  };
  artifactPath: string;
  exitStatus: number | null;
  signal: NodeJS.Signals | null;
  stdoutTail: string;
  stderrTail: string;
};

const PROJECT_ROOT = "/Users/nichikatanaka/Documents/New project";
const CANONICAL_STAGE_ADAPTER = BROWSER_USE_STAGE_ADAPTER_PATH;
const BLOCKER = "browser_use_cli_job_manager_registered_runner_required";

function artifactPathFor(runId: string, workflowId: string): string {
  const root = process.env.AUTOMATION_OS_ARTIFACT_ROOT?.trim()
    ? resolve(process.env.AUTOMATION_OS_ARTIFACT_ROOT)
    : resolve(process.cwd(), "data", "artifacts");
  return resolve(root, runId, `${workflowId}.json`);
}

function privateRunnerCommand(runId: string, workflowId: string, summaryPath: string) {
  const env = {
    AUTOMATION_OS_REGISTERED_WORKFLOW_ID: workflowId,
    AUTOMATION_OS_RUN_ID: runId,
    AUTOMATION_OS_REGISTERED_SUMMARY_PATH: summaryPath,
    AUTOMATION_OS_BROWSER_SURFACE: "browser_use_cli",
    AUTOMATION_OS_BROWSER_DRIVER: "browser_use_cli",
    AUTOMATION_OS_BROWSER_ADAPTER: CANONICAL_STAGE_ADAPTER,
    AUTOMATION_OS_BROWSER_HELPER: BROWSER_USE_HELPER_PATH,
    AUTOMATION_OS_BROWSER_RUNTIME_CONFIG: BROWSER_USE_RUNTIME_CONFIG_PATH,
    AUTOMATION_OS_BROWSER_NO_FALLBACK: "1",
    AUTOMATION_OS_BROWSER_REQUIRED: "1",
  };
  return {
    bin: "/usr/local/bin/node",
    args: [CANONICAL_STAGE_ADAPTER],
    cwd: PROJECT_ROOT,
    display: `node ${JSON.stringify(CANONICAL_STAGE_ADAPTER)} AUTOMATION_OS_BROWSER_SURFACE=browser_use_cli AUTOMATION_OS_BROWSER_NO_FALLBACK=1 AUTOMATION_OS_RUN_ID=${JSON.stringify(runId)}`,
    env,
  };
}

function runtimeReadback(): Record<string, unknown> {
  if (!existsSync(BROWSER_USE_HELPER_PATH) || !existsSync(CANONICAL_STAGE_ADAPTER) || !existsSync(BROWSER_USE_RUNTIME_CONFIG_PATH)) {
    return { ok: false, exact_blocker: "browser_use_cli_runtime_unavailable" };
  }
  try {
    if (!statSync(BROWSER_USE_HELPER_PATH).isFile() || !statSync(CANONICAL_STAGE_ADAPTER).isFile() || !statSync(BROWSER_USE_RUNTIME_CONFIG_PATH).isFile()) {
      return { ok: false, exact_blocker: "browser_use_cli_runtime_unavailable" };
    }
    const result = spawnSync(BROWSER_USE_HELPER_PATH, ["runtime-readback"], {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1_000_000,
    });
    const lines = String(result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const last = lines.at(-1) ?? "";
    const readback = last ? JSON.parse(last) as Record<string, unknown> : {};
    if (result.error || result.status !== 0 || readback.exact_blocker || readback.runtime_drift === true || readback.launch === true) {
      return { ok: false, exact_blocker: "browser_use_cli_runtime_unavailable" };
    }
    return { ok: true, exact_blocker: null, schema: "browser_use_cli_runtime_readback" };
  } catch {
    return { ok: false, exact_blocker: "browser_use_cli_runtime_unavailable" };
  }
}

/**
 * The old registered Codex executor is intentionally not a browser runner.
 * Normal AOS Job runs must enter the portable external lane, whose workflow
 * runner owns the live Browser Use CLI flow. If a legacy/non-portable run
 * reaches this branch, stop before any child or browser is started.
 */
export function runJobManagerBrowserUseCliRegisteredRunner(input: {
  runId: string;
  workflowId: "job_submit_registered" | "job_followup_registered";
}): JobManagerBrowserUseCliRegisteredRunResult {
  const artifactPath = artifactPathFor(input.runId, input.workflowId);
  const summaryPath = resolve(dirname(artifactPath), `${input.workflowId}-browser-use-cli-summary.json`);
  mkdirSync(dirname(artifactPath), { recursive: true, mode: 0o700 });
  const command = privateRunnerCommand(input.runId, input.workflowId, summaryPath);
  const readback = runtimeReadback();
  const metadata = {
    executor: "execute_registered_browser_use_cli_workflow",
    workflow_id: input.workflowId,
    browser_surface: "browser_use_cli",
    browser_driver: "browser_use_cli",
    browser_adapter: CANONICAL_STAGE_ADAPTER,
    browser_helper: BROWSER_USE_HELPER_PATH,
    browser_runtime_config: BROWSER_USE_RUNTIME_CONFIG_PATH,
    browser_no_fallback: true,
    external_action_executed: false,
    exact_blocker: BLOCKER,
    runtime_readback: readback,
    next_safe_route: "portable_external_worker",
  };
  writeFileSync(artifactPath, JSON.stringify({
    schema: "automation_os_registered_browser_use_cli_blocked.v1",
    run_id: input.runId,
    workflow_id: input.workflowId,
    status: "blocked",
    exact_blocker: BLOCKER,
    command,
    metadata,
  }, null, 2));
  const proof: Proof = {
    proofType: `${input.workflowId}_browser_use_cli_blocked`,
    label: `${input.workflowId} Browser Use CLI-only route blocked before live worker`,
    uri: pathToFileURL(artifactPath).href,
    metadata: { ...metadata, artifact_path: artifactPath },
  };
  return {
    status: "blocked",
    proof_gate: { ok: false, missing: [BLOCKER], present: [proof.proofType] },
    proof_summary: `blocked: ${BLOCKER}`,
    proofs: [proof],
    metadata,
    command,
    artifactPath,
    exitStatus: null,
    signal: null,
    stdoutTail: "",
    stderrTail: BLOCKER,
  };
}

export function jobManagerBrowserUseCliArtifactSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

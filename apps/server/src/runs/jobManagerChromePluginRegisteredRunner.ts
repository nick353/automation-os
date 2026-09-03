import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Proof } from "./proofGate.js";

export type JobManagerChromePluginRegisteredRunResult = {
  status: "blocked";
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

const AOS_ROOT = "/Users/nichikatanaka/Documents/Codex/automation-os";
const PROJECT_ROOT = "/Users/nichikatanaka/Documents/New project";
const RUNNER = join(AOS_ROOT, "scripts", "aos-job-chrome-plugin-business-runner.mjs");
const SURFACE = "signed_chrome_extension_profile2";
const BLOCKER = "chrome_plugin_job_manager_portable_external_worker_required";

function artifactPathFor(runId: string, workflowId: string): string {
  const root = process.env.AUTOMATION_OS_ARTIFACT_ROOT?.trim()
    ? resolve(process.env.AUTOMATION_OS_ARTIFACT_ROOT)
    : resolve(process.cwd(), "data", "artifacts");
  return resolve(root, runId, `${workflowId}-chrome-plugin.json`);
}

function commandFor(runId: string, workflowId: string, artifactPath: string) {
  const env = {
    AUTOMATION_OS_REGISTERED_WORKFLOW_ID: workflowId,
    AUTOMATION_OS_RUN_ID: runId,
    AUTOMATION_OS_BROWSER_SURFACE: SURFACE,
    AUTOMATION_OS_BROWSER_DRIVER: "chrome_plugin",
    AUTOMATION_OS_BROWSER_NO_FALLBACK: "1",
    AUTOMATION_OS_BROWSER_REQUIRED: "1",
    AOS_WEB_OPERATION_BACKEND: "chrome_plugin",
    AOS_CHROME_PROFILE_ID: "profile2",
    AOS_CHROME_PROFILE_NAME: "Profile 2",
    AOS_CHROME_PROFILE_DIRECTORY: "Profile 2",
    AOS_CHROME_PROFILE_SURFACE: SURFACE,
    AUTOMATION_OS_REGISTERED_SUMMARY_PATH: artifactPath,
  };
  const args = [
    RUNNER,
    "--workflow-id", "job-application-manager",
    "--run-id", runId,
    "--step-id", `${workflowId}:${runId}`,
    "--source-trigger", "automation_os_worker",
    "--idempotency-key", `${workflowId}:${runId}`,
  ];
  return {
    bin: process.execPath,
    args,
    cwd: PROJECT_ROOT,
    display: `${process.execPath} ${JSON.stringify(RUNNER)} AOS_WEB_OPERATION_BACKEND=chrome_plugin AOS_CHROME_PROFILE_SURFACE=${SURFACE}`,
    env,
  };
}

export function runJobManagerChromePluginRegisteredRunner(input: {
  runId: string;
  workflowId: "job_submit_registered" | "job_followup_registered";
}): JobManagerChromePluginRegisteredRunResult {
  const artifactPath = artifactPathFor(input.runId, input.workflowId);
  mkdirSync(dirname(artifactPath), { recursive: true, mode: 0o700 });
  const command = commandFor(input.runId, input.workflowId, artifactPath);
  const metadata = {
    executor: "execute_registered_chrome_plugin_workflow",
    workflow_id: input.workflowId,
    browser_surface: SURFACE,
    browser_driver: "chrome_plugin",
    chrome_profile: { id: "profile2", name: "Profile 2", directory: "Profile 2", surface: SURFACE },
    browser_no_fallback: true,
    external_action_executed: false,
    exact_blocker: BLOCKER,
    next_safe_route: "portable_external_worker",
    runner_entrypoint: RUNNER,
    note: "Legacy/non-portable worker has no target-bound input bundle; portable external worker owns the live Chrome Plugin bridge.",
  };
  writeFileSync(artifactPath, JSON.stringify({
    schema: "automation_os_registered_chrome_plugin_blocked.v1",
    run_id: input.runId,
    workflow_id: input.workflowId,
    status: "blocked",
    exact_blocker: BLOCKER,
    command,
    metadata,
  }, null, 2));
  const proof: Proof = {
    proofType: `${input.workflowId}_chrome_plugin_blocked`,
    label: `${input.workflowId} Chrome Plugin route stopped before unbound live work`,
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

export function jobManagerChromePluginArtifactSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

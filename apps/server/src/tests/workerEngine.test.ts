import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-worker-engine-"));
process.env.AUTOMATION_OS_DB = join(tempRoot, "automation-os.sqlite");
process.env.AUTOMATION_OS_ARTIFACT_ROOT = join(tempRoot, "artifacts");
process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_OUTPUT_ROOT = join(tempRoot, "nisenprints-node-runs");

const db = await import("../db/client.js");
const worker = await import("../runs/workerEngine.js");
const snsRunner = await import("../runs/snsMultiPosterRegisteredRunner.js");
const api = await import("../index.js");
const { execSql, initDb, querySql, resetDemoData, sqlValue } = db;
const { approvalsAllowProtectedSteps, buildWorkerCommand, chooseWorkerAdapter, deriveRunStatus, planCommandRun, resumeRunAfterApproval, runWorkerOnce, startCommandRun } = worker;
const { evaluateSnsMultiPosterSummary } = snsRunner;

test("getRunWorkerProgressState treats worker_started, started steps, terminal events, and proofs as progress", () => {
  initDb();
  resetDemoData();
  const runId = "run_progress_state";
  const stepId = "step_progress_state";
  const now = new Date().toISOString();
  db.insert("runs", {
    id: runId,
    name: "Progress state regression",
    status: "waiting_approval",
    objective: "Regression test",
    created_at: now,
    updated_at: now,
    metadata_json: {}
  });
  db.insert("run_steps", {
    id: stepId,
    run_id: runId,
    name: "Started worker step",
    status: "running",
    lane_id: null,
    started_at: now,
    completed_at: null,
    metadata_json: {}
  });
  db.insert("worker_events", {
    id: "evt_progress_state_started",
    run_id: runId,
    step_id: stepId,
    lane_id: null,
    event_type: "worker_started",
    message: "worker started",
    created_at: now,
    metadata_json: {}
  });
  db.insert("proofs", {
    id: "proof_progress_state",
    run_id: runId,
    step_id: stepId,
    proof_type: "worker_receipt",
    label: "Worker receipt",
    uri: "file:///tmp/progress-state.json",
    size_bytes: 2,
    created_at: now,
    metadata_json: {}
  });

  const state = worker.getRunWorkerProgressState(runId);

  assert.equal(state.progressed, true);
  assert.equal(state.counts.stepsStarted, 1);
  assert.equal(state.counts.stepsCompleted, 0);
  assert.equal(state.counts.stepsStatusProgressed, 1);
  assert.equal(state.counts.workerStartedEvents, 1);
  assert.equal(state.counts.workerCompletedEvents, 0);
  assert.equal(state.counts.workerBlockedEvents, 0);
  assert.equal(state.counts.proofs, 1);
});

function writeFakeCodex(): string {
  const path = join(tempRoot, "fake-codex.js");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (process.env.FAKE_CODEX_REGISTERED_SUMMARY && process.env.AUTOMATION_OS_REGISTERED_SUMMARY_PATH) {
  require("node:fs").writeFileSync(process.env.AUTOMATION_OS_REGISTERED_SUMMARY_PATH, process.env.FAKE_CODEX_REGISTERED_SUMMARY);
}
const finish = () => {
  console.log(JSON.stringify({ argv, cwd: process.cwd(), task: argv.at(-1) }));
  if (process.env.FAKE_CODEX_EXIT_STATUS) {
    console.error("fake codex blocked");
    process.exit(Number(process.env.FAKE_CODEX_EXIT_STATUS));
  }
  console.error("fake codex completed");
};
const delayMs = Number(process.env.FAKE_CODEX_DELAY_MS || "0");
if (Number.isFinite(delayMs) && delayMs > 0) setTimeout(finish, delayMs);
else finish();
`
  );
  chmodSync(path, 0o755);
  return path;
}

function installFakeBrowserUse(name: string): () => void {
  const previousCli = process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  const previousPlaywrightCli = process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  const previousArtifactDir = process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR;
  const previousSidecar = process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR;
  const path = join(tempRoot, `${name}.sh`);
  const outputRoot = join(tempRoot, `${name}-playwright-artifacts`);
  writeFileSync(
    path,
    `#!/bin/sh
set -eu
mkdir -p ${JSON.stringify(outputRoot)}
last=""
for arg in "$@"; do last="$arg"; done
case " $* " in
  *" snapshot "*) printf '%s\\n' "Automation OS local screen snapshot env_cdp=$PLAYWRIGHT_CLI_CDP_URL env_profile=$PLAYWRIGHT_CLI_PROFILE env_workdir=$PLAYWRIGHT_CLI_WORKDIR";;
  *" screenshot "*) printf '%s' 'png' > ${JSON.stringify(join(outputRoot, "screen.png"))}; printf '%s\\n' '[Screenshot](${join(outputRoot, "screen.png")})';;
  *" console "*) : > ${JSON.stringify(join(outputRoot, "console.log"))}; printf '%s\\n' '[Console](${join(outputRoot, "console.log")})';;
  *" open "*) printf '%s\\n' 'opened';;
  *" resize "*) printf '%s\\n' 'resized';;
  *" session-stop "*) printf '%s\\n' 'stopped';;
  *" close "*) printf '%s\\n' 'closed';;
  *) printf '%s\\n' 'ok';;
esac
`,
    "utf8"
  );
  chmodSync(path, 0o755);
  process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = path;
  process.env.AUTOMATION_OS_BROWSER_USE_CLI = path;
  process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR = join(tempRoot, `${name}-artifacts`);
  delete process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR;
  return () => {
    if (previousPlaywrightCli === undefined) delete process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
    else process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = previousPlaywrightCli;
    if (previousCli === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_CLI;
    else process.env.AUTOMATION_OS_BROWSER_USE_CLI = previousCli;
    if (previousArtifactDir === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR;
    else process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR = previousArtifactDir;
    if (previousSidecar === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR;
    else process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR = previousSidecar;
  };
}

function installFakePromptTransferRunner(name: string, exitStatus = 0): () => void {
  const previousRunner = process.env.AUTOMATION_OS_PROMPT_TRANSFER_UKIYOE_RUNNER;
  const previousOutputRoot = process.env.AUTOMATION_OS_PROMPT_TRANSFER_OUTPUT_ROOT;
  const previousBrowserUse = process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  const previousPython = process.env.PYTHON;
  const path = join(tempRoot, `${name}.js`);
  writeFileSync(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : fallback;
};
const runId = valueAfter("--run-id", "fake-run");
const outRoot = valueAfter("--out-root", process.cwd());
const runDir = path.join(outRoot, "artifacts", "runs", runId);
fs.mkdirSync(runDir, { recursive: true });
const commitRequested = args.includes("--commit");
const allowExternalCommit = args.includes("--allow-external-commit");
const payload = {
  status: commitRequested && allowExternalCommit ? "success" : "partial",
  run_id: runId,
  commit_requested: commitRequested,
  allow_external_commit: allowExternalCommit,
  committed: commitRequested && allowExternalCommit,
  artifact_uri: runDir,
  stages: [
    { stage: "extract", returncode: 0, result: { status: "success" } },
    { stage: "apply-plan", returncode: 0, result: { status: "success" } },
    ...(commitRequested && allowExternalCommit ? [{ stage: "commit", returncode: 0, result: { status: "success" } }] : [])
  ],
  argv: args
};
fs.writeFileSync(path.join(runDir, "ukiyoe_wrapper.json"), JSON.stringify(payload, null, 2));
fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(payload, null, 2));
console.log(JSON.stringify(payload));
process.exit(${exitStatus});
`
  );
  chmodSync(path, 0o755);
  process.env.AUTOMATION_OS_PROMPT_TRANSFER_UKIYOE_RUNNER = path;
  process.env.AUTOMATION_OS_PROMPT_TRANSFER_OUTPUT_ROOT = join(tempRoot, `${name}-output`);
  process.env.AUTOMATION_OS_BROWSER_USE_CLI = join(tempRoot, `${name}-node`);
  process.env.PYTHON = process.execPath;
  return () => {
    if (previousRunner === undefined) delete process.env.AUTOMATION_OS_PROMPT_TRANSFER_UKIYOE_RUNNER;
    else process.env.AUTOMATION_OS_PROMPT_TRANSFER_UKIYOE_RUNNER = previousRunner;
    if (previousOutputRoot === undefined) delete process.env.AUTOMATION_OS_PROMPT_TRANSFER_OUTPUT_ROOT;
    else process.env.AUTOMATION_OS_PROMPT_TRANSFER_OUTPUT_ROOT = previousOutputRoot;
    if (previousBrowserUse === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_CLI;
    else process.env.AUTOMATION_OS_BROWSER_USE_CLI = previousBrowserUse;
    if (previousPython === undefined) delete process.env.PYTHON;
    else process.env.PYTHON = previousPython;
  };
}

function withSnsMultiPosterEnv<T>(
  name: string,
  input: { imagePath?: string; caption?: string; runner?: string; nisenPrintsRoot?: string },
  fn: () => T | Promise<T>
): Promise<T> {
  const previous = {
    imagePath: process.env.SNS_MULTI_POSTER_IMAGE_PATH,
    caption: process.env.SNS_MULTI_POSTER_CAPTION,
    outputRoot: process.env.AUTOMATION_OS_SNS_MULTI_POSTER_OUTPUT_ROOT,
    runner: process.env.AUTOMATION_OS_SNS_MULTI_POSTER_RUNNER,
    nisenPrintsRoot: process.env.AUTOMATION_OS_SNS_MULTI_POSTER_NISENPRINTS_ROOT
  };
  if (input.imagePath === undefined) delete process.env.SNS_MULTI_POSTER_IMAGE_PATH;
  else process.env.SNS_MULTI_POSTER_IMAGE_PATH = input.imagePath;
  if (input.caption === undefined) delete process.env.SNS_MULTI_POSTER_CAPTION;
  else process.env.SNS_MULTI_POSTER_CAPTION = input.caption;
  process.env.AUTOMATION_OS_SNS_MULTI_POSTER_OUTPUT_ROOT = join(tempRoot, `${name}-sns-output`);
  if (input.runner === undefined) delete process.env.AUTOMATION_OS_SNS_MULTI_POSTER_RUNNER;
  else process.env.AUTOMATION_OS_SNS_MULTI_POSTER_RUNNER = input.runner;
  if (input.nisenPrintsRoot === undefined) process.env.AUTOMATION_OS_SNS_MULTI_POSTER_NISENPRINTS_ROOT = join(tempRoot, `${name}-missing-nisenprints-root`);
  else process.env.AUTOMATION_OS_SNS_MULTI_POSTER_NISENPRINTS_ROOT = input.nisenPrintsRoot;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous.imagePath === undefined) delete process.env.SNS_MULTI_POSTER_IMAGE_PATH;
      else process.env.SNS_MULTI_POSTER_IMAGE_PATH = previous.imagePath;
      if (previous.caption === undefined) delete process.env.SNS_MULTI_POSTER_CAPTION;
      else process.env.SNS_MULTI_POSTER_CAPTION = previous.caption;
      if (previous.outputRoot === undefined) delete process.env.AUTOMATION_OS_SNS_MULTI_POSTER_OUTPUT_ROOT;
      else process.env.AUTOMATION_OS_SNS_MULTI_POSTER_OUTPUT_ROOT = previous.outputRoot;
      if (previous.runner === undefined) delete process.env.AUTOMATION_OS_SNS_MULTI_POSTER_RUNNER;
      else process.env.AUTOMATION_OS_SNS_MULTI_POSTER_RUNNER = previous.runner;
      if (previous.nisenPrintsRoot === undefined) delete process.env.AUTOMATION_OS_SNS_MULTI_POSTER_NISENPRINTS_ROOT;
      else process.env.AUTOMATION_OS_SNS_MULTI_POSTER_NISENPRINTS_ROOT = previous.nisenPrintsRoot;
    });
}

function writeFakeSnsMultiPosterRunner(name: string, result: Record<string, unknown>): string {
  const runnerPath = join(tempRoot, `${name}.mjs`);
  writeFileSync(
    runnerPath,
    `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const args = process.argv.slice(2);
const valueAfter = (flag, fallback = "") => {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};
const runId = valueAfter("--run-id", process.env.AUTOMATION_OS_RUN_ID || "fake-sns-run");
const outRoot = resolve(valueAfter("--out-root", process.cwd()));
const runDir = join(outRoot, "artifacts", "runs", runId);
mkdirSync(runDir, { recursive: true });
const stagePlanPath = join(runDir, "stage-plan.json");
const resultPath = join(runDir, "result.json");
const payload = {
  ${JSON.stringify(result).slice(1, -1)},
  run_id: runId,
  stage_plan_path: stagePlanPath,
  result_path: resultPath,
  artifact_uri: pathToFileURL(runDir).href
};
writeFileSync(stagePlanPath, JSON.stringify({ status: payload.status, run_id: runId, external_action_executed: payload.external_action_executed }, null, 2) + "\\n");
writeFileSync(resultPath, JSON.stringify(payload, null, 2) + "\\n");
console.log(JSON.stringify(payload));
`,
    "utf8"
  );
  chmodSync(runnerPath, 0o755);
  return runnerPath;
}

function writeFakeCompletedNisenPrintsManifest(name: string): { root: string; imagePath: string; manifestPath: string; runId: string } {
  const root = join(tempRoot, `${name}-nisenprints`);
  const runId = "2026-06-15-133435-562a-fuji-cosmos-field-onsen-dilute-calico-cat";
  const manifestDir = join(root, "artifacts", "publish_manifests");
  const exportDir = join(root, "artifacts", "canva_exports", runId);
  mkdirSync(manifestDir, { recursive: true });
  mkdirSync(exportDir, { recursive: true });
  const imagePath = join(exportDir, "1.png");
  const manifestPath = join(manifestDir, `${runId}.json`);
  writeFileSync(imagePath, "png", "utf8");
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        run_id: runId,
        ok: true,
        final_status: "pinterest_posted",
        resume_stage: "complete",
        canva_export_dir: `artifacts/canva_exports/${runId}`
      },
      null,
      2
    ),
    "utf8"
  );
  return { root, imagePath, manifestPath, runId };
}

function installFakeBrowserUseWithSidecar(name: string): () => void {
  const previousCli = process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  const previousPlaywrightCli = process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  const previousArtifactDir = process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR;
  const previousSidecar = process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR;
  const path = join(tempRoot, `${name}.sh`);
  const sidecarPath = join(tempRoot, `${name}-recording-sidecar.sh`);
  const outputRoot = join(tempRoot, `${name}-playwright-artifacts`);
  writeFileSync(
    path,
    `#!/bin/sh
set -eu
mkdir -p ${JSON.stringify(outputRoot)}
last=""
for arg in "$@"; do last="$arg"; done
case " $* " in
  *" snapshot "*) printf '%s\\n' 'Automation OS local screen snapshot';;
  *" screenshot "*)
    printf '%s' 'png' > ${JSON.stringify(join(outputRoot, "screen.png"))}
    printf '%s\\n' '[Screenshot](${join(outputRoot, "screen.png")})'
    ;;
  *" console "*) : > ${JSON.stringify(join(outputRoot, "console.log"))}; printf '%s\\n' '[Console](${join(outputRoot, "console.log")})';;
  *" open "*) printf '%s\\n' 'opened';;
  *" resize "*) printf '%s\\n' 'resized';;
  *" session-stop "*) printf '%s\\n' 'stopped';;
  *" close "*) printf '%s\\n' 'closed';;
  *) printf '%s\\n' 'ok';;
esac
`,
    "utf8"
  );
  writeFileSync(
    sidecarPath,
    `#!/bin/sh
set -eu
recording=""
qa=""
manifest=""
target_url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest) manifest="$2"; shift 2;;
    --recording) recording="$2"; shift 2;;
    --gemini-qa) qa="$2"; shift 2;;
    --target-url) target_url="$2"; shift 2;;
    *) shift;;
  esac
done
printf '%s' 'webm' > "$recording"
cat > "$qa" <<EOF
{"provider":"gemini","kind":"gemini_video_qa","status":"passed","verdict":"pass","completion_gate_alignment":"aligned","completion_gate_matches":true,"video_artifact_uri":"$recording","target_url":"$target_url"}
EOF
MANIFEST="$manifest" TARGET_URL="$target_url" node -e 'const fs=require("node:fs"); const path=process.env.MANIFEST; const data=JSON.parse(fs.readFileSync(path,"utf8")); data.recordingSidecar={status:"ok",reason:"browser_use_recording_sidecar_completed",targetUrl:process.env.TARGET_URL,targetPageUrl:process.env.TARGET_URL}; fs.writeFileSync(path, JSON.stringify(data,null,2)+"\\n");'
printf '%s\\n' 'recorded'
`,
    "utf8"
  );
  chmodSync(path, 0o755);
  chmodSync(sidecarPath, 0o755);
  process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = path;
  process.env.AUTOMATION_OS_BROWSER_USE_CLI = path;
  process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR = join(tempRoot, `${name}-artifacts`);
  process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR = sidecarPath;
  return () => {
    if (previousPlaywrightCli === undefined) delete process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
    else process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = previousPlaywrightCli;
    if (previousCli === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_CLI;
    else process.env.AUTOMATION_OS_BROWSER_USE_CLI = previousCli;
    if (previousArtifactDir === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR;
    else process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR = previousArtifactDir;
    if (previousSidecar === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR;
    else process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR = previousSidecar;
  };
}

function installFakeBrowserUseWithSidecarButMissingScreenshot(name: string): () => void {
  const previousCli = process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  const previousPlaywrightCli = process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  const previousArtifactDir = process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR;
  const previousSidecar = process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR;
  const path = join(tempRoot, `${name}.sh`);
  const sidecarPath = join(tempRoot, `${name}-recording-sidecar.sh`);
  const outputRoot = join(tempRoot, `${name}-playwright-artifacts`);
  writeFileSync(
    path,
    `#!/bin/sh
set -eu
mkdir -p ${JSON.stringify(outputRoot)}
case " $* " in
  *" snapshot "*) printf '%s\\n' 'Automation OS local screen snapshot';;
  *" screenshot "*) printf '%s\\n' 'saved screenshot without file';;
  *" console "*) : > ${JSON.stringify(join(outputRoot, "console.log"))}; printf '%s\\n' '[Console](${join(outputRoot, "console.log")})';;
  *" open "*) printf '%s\\n' 'opened';;
  *" resize "*) printf '%s\\n' 'resized';;
  *" session-stop "*) printf '%s\\n' 'stopped';;
  *" close "*) printf '%s\\n' 'closed';;
  *) printf '%s\\n' 'ok';;
esac
`,
    "utf8"
  );
  writeFileSync(
    sidecarPath,
    `#!/bin/sh
set -eu
recording=""
qa=""
manifest=""
target_url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest) manifest="$2"; shift 2;;
    --recording) recording="$2"; shift 2;;
    --gemini-qa) qa="$2"; shift 2;;
    --target-url) target_url="$2"; shift 2;;
    *) shift;;
  esac
done
printf '%s' 'webm' > "$recording"
cat > "$qa" <<EOF
{"provider":"gemini","kind":"gemini_video_qa","status":"passed","verdict":"pass","completion_gate_alignment":"aligned","completion_gate_matches":true,"video_artifact_uri":"$recording","target_url":"$target_url"}
EOF
MANIFEST="$manifest" TARGET_URL="$target_url" node -e 'const fs=require("node:fs"); const path=process.env.MANIFEST; const data=JSON.parse(fs.readFileSync(path,"utf8")); data.recordingSidecar={status:"ok",reason:"browser_use_recording_sidecar_completed",targetUrl:process.env.TARGET_URL,targetPageUrl:process.env.TARGET_URL}; fs.writeFileSync(path, JSON.stringify(data,null,2)+"\\n");'
printf '%s\\n' 'recorded'
`,
    "utf8"
  );
  chmodSync(path, 0o755);
  chmodSync(sidecarPath, 0o755);
  process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = path;
  process.env.AUTOMATION_OS_BROWSER_USE_CLI = path;
  process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR = join(tempRoot, `${name}-artifacts`);
  process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR = sidecarPath;
  return () => {
    if (previousPlaywrightCli === undefined) delete process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
    else process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = previousPlaywrightCli;
    if (previousCli === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_CLI;
    else process.env.AUTOMATION_OS_BROWSER_USE_CLI = previousCli;
    if (previousArtifactDir === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR;
    else process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR = previousArtifactDir;
    if (previousSidecar === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR;
    else process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR = previousSidecar;
  };
}

function installFakeBrowserUseWithBlockedSidecar(name: string, exactBlocker: string): () => void {
  const previousCli = process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  const previousPlaywrightCli = process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  const previousArtifactDir = process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR;
  const previousSidecar = process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR;
  const path = join(tempRoot, `${name}.sh`);
  const sidecarPath = join(tempRoot, `${name}-recording-sidecar.sh`);
  const outputRoot = join(tempRoot, `${name}-playwright-artifacts`);
  writeFileSync(
    path,
    `#!/bin/sh
set -eu
mkdir -p ${JSON.stringify(outputRoot)}
last=""
for arg in "$@"; do last="$arg"; done
case " $* " in
  *" snapshot "*) printf '%s\\n' 'Automation OS local screen snapshot';;
  *" screenshot "*) printf '%s' 'png' > ${JSON.stringify(join(outputRoot, "screen.png"))}; printf '%s\\n' '[Screenshot](${join(outputRoot, "screen.png")})';;
  *" console "*) printf '%s\\n' 'playwright console error' > ${JSON.stringify(join(outputRoot, "console.log"))}; printf '%s\\n' '[Console](${join(outputRoot, "console.log")})';;
  *" open "*) printf '%s\\n' 'opened';;
  *" resize "*) printf '%s\\n' 'resized';;
  *" session-stop "*) printf '%s\\n' 'stopped';;
  *" close "*) printf '%s\\n' 'closed';;
  *) printf '%s\\n' 'ok';;
esac
`,
    "utf8"
  );
  writeFileSync(
    sidecarPath,
    `#!/bin/sh
set -eu
manifest=""
target_url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest) manifest="$2"; shift 2;;
    --target-url) target_url="$2"; shift 2;;
    *) shift;;
  esac
done
MANIFEST="$manifest" TARGET_URL="$target_url" EXACT_BLOCKER="${exactBlocker}" node -e 'const fs=require("node:fs"); const path=process.env.MANIFEST; const data=JSON.parse(fs.readFileSync(path,"utf8")); data.recordingSidecar={status:"blocked",reason:"generic_recorder_unavailable",exactBlocker:process.env.EXACT_BLOCKER,targetUrl:process.env.TARGET_URL,targetPageUrl:"http://127.0.0.1:5173/#other"}; fs.writeFileSync(path, JSON.stringify(data,null,2)+"\\n");'
printf '%s\\n' '${exactBlocker}' >&2
exit 2
`,
    "utf8"
  );
  chmodSync(path, 0o755);
  chmodSync(sidecarPath, 0o755);
  process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = path;
  process.env.AUTOMATION_OS_BROWSER_USE_CLI = path;
  process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR = join(tempRoot, `${name}-artifacts`);
  process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR = sidecarPath;
  return () => {
    if (previousPlaywrightCli === undefined) delete process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
    else process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = previousPlaywrightCli;
    if (previousCli === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_CLI;
    else process.env.AUTOMATION_OS_BROWSER_USE_CLI = previousCli;
    if (previousArtifactDir === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR;
    else process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR = previousArtifactDir;
    if (previousSidecar === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR;
    else process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR = previousSidecar;
  };
}

function installFakeNisenPrintsBrowserUseRunner(name: string, exitStatus: number): () => void {
  const previousRunner = process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
  const runnerPath = join(tempRoot, `${name}.mjs`);
  writeFileSync(
    runnerPath,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.NISENPRINTS_REGISTERED_SUMMARY_PATH, JSON.stringify({
  automation_os_run_id: process.env.AUTOMATION_OS_RUN_ID || "",
  run_id: "2026-06-17-worker-test",
  final_status: "playlite_flow_completed",
  stop_reason: "",
  etsy_listing_id: "4512345678",
  etsy_listing_url: "https://www.etsy.com/listing/4512345678/test",
  pinterest_pin_url: "https://www.pinterest.com/pin/982347737606212559/",
  pinterest_visit_site_listing_id: "4512345678"
}));
process.exit(${exitStatus});
`,
    "utf8"
  );
  chmodSync(runnerPath, 0o755);
  process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER = runnerPath;
  return () => {
    if (previousRunner === undefined) delete process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER;
    else process.env.AUTOMATION_OS_NISENPRINTS_PLAYWRIGHT_RUNNER = previousRunner;
  };
}

function installFakeDailyAiRunner(name: string, exitStatus: number): () => void {
  const previousRunner = process.env.AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER;
  const previousOutputRoot = process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT;
  const runnerPath = join(tempRoot, `${name}.mjs`);
  writeFileSync(
    runnerPath,
    `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const outputDir = process.env.DAILY_AI_CLI_OUTPUT_DIR;
if (!outputDir) throw new Error("DAILY_AI_CLI_OUTPUT_DIR missing");
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "registered-playwright-cli-summary.json"), JSON.stringify({
  automation_os_run_id: process.env.AUTOMATION_OS_RUN_ID || "",
  run_id: process.env.DAILY_AI_CLI_RUN_ID || "",
  direct_publish: { ok: true },
  post_publish_feed_study: { ok: true },
  direct_engagement: { ok: true },
  postflight_sync: { ok: true },
  final_buffer_refresh: { ok: true },
  cleanup_proof: { ok: true },
  full_flow_completion: { ok: true, failures: [] }
}, null, 2));
process.exit(${exitStatus});
`,
    "utf8"
  );
  chmodSync(runnerPath, 0o755);
  process.env.AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER = runnerPath;
  process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT = join(tempRoot, `${name}-runs`);
  return () => {
    if (previousRunner === undefined) delete process.env.AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER;
    else process.env.AUTOMATION_OS_DAILY_AI_PLAYWRIGHT_RUNNER = previousRunner;
    if (previousOutputRoot === undefined) delete process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT;
    else process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT = previousOutputRoot;
  };
}

function assertBillingOnlyRunnerSafety(metadata: Record<string, any>) {
  assert.equal(metadata.runner_safety.external_action_executed, false);
  assert.equal(metadata.runner_safety.kind, "billing_only_external_action_policy");
  assert.equal(metadata.runner_safety.publicKind, "billing_only_hard_stop");
  assert.equal(metadata.runner_safety.externalActionBoundary, "billing_purchase_payment_checkout_hard_stop");
  assert.deepEqual(metadata.runner_safety.defaultHardStops, ["billing", "purchase", "payment", "checkout"]);
}

function latestStartedWorkerEventMetadata(runId: string): Record<string, any> {
  const event = querySql<{ metadata_json: string }>(
    `SELECT metadata_json FROM worker_events WHERE run_id=${sqlValue(runId)} AND event_type='worker_started' ORDER BY created_at DESC, id DESC LIMIT 1`
  )[0];
  assert.ok(event);
  return JSON.parse(event.metadata_json);
}

function latestTerminalWorkerEventMetadata(runId: string): Record<string, any> {
  const event = querySql<{ metadata_json: string }>(
    `SELECT metadata_json FROM worker_events WHERE run_id=${sqlValue(runId)} AND event_type IN ('worker_completed', 'worker_blocked') ORDER BY created_at DESC, id DESC LIMIT 1`
  )[0];
  assert.ok(event);
  return JSON.parse(event.metadata_json);
}

async function withCodexExecutionEnv<T>(fn: () => T | Promise<T>): Promise<T> {
  const previous = {
    executeCodex: process.env.AUTOMATION_OS_EXECUTE_CODEX,
    codexBin: process.env.AUTOMATION_OS_CODEX_BIN,
    fakeExitStatus: process.env.FAKE_CODEX_EXIT_STATUS,
    fakeRegisteredSummary: process.env.FAKE_CODEX_REGISTERED_SUMMARY,
    fakeDelayMs: process.env.FAKE_CODEX_DELAY_MS,
    registeredSummaryRoot: process.env.AUTOMATION_OS_REGISTERED_SUMMARY_ROOT
  };
  process.env.AUTOMATION_OS_EXECUTE_CODEX = "1";
  process.env.AUTOMATION_OS_CODEX_BIN = writeFakeCodex();
  process.env.AUTOMATION_OS_REGISTERED_SUMMARY_ROOT = join(tempRoot, "registered-summaries");
  try {
    return await fn();
  } finally {
    if (previous.executeCodex === undefined) delete process.env.AUTOMATION_OS_EXECUTE_CODEX;
    else process.env.AUTOMATION_OS_EXECUTE_CODEX = previous.executeCodex;
    if (previous.codexBin === undefined) delete process.env.AUTOMATION_OS_CODEX_BIN;
    else process.env.AUTOMATION_OS_CODEX_BIN = previous.codexBin;
    if (previous.fakeExitStatus === undefined) delete process.env.FAKE_CODEX_EXIT_STATUS;
    else process.env.FAKE_CODEX_EXIT_STATUS = previous.fakeExitStatus;
    if (previous.fakeRegisteredSummary === undefined) delete process.env.FAKE_CODEX_REGISTERED_SUMMARY;
    else process.env.FAKE_CODEX_REGISTERED_SUMMARY = previous.fakeRegisteredSummary;
    if (previous.fakeDelayMs === undefined) delete process.env.FAKE_CODEX_DELAY_MS;
    else process.env.FAKE_CODEX_DELAY_MS = previous.fakeDelayMs;
    if (previous.registeredSummaryRoot === undefined) delete process.env.AUTOMATION_OS_REGISTERED_SUMMARY_ROOT;
    else process.env.AUTOMATION_OS_REGISTERED_SUMMARY_ROOT = previous.registeredSummaryRoot;
  }
}

async function withChildCodexExecutionEnv<T>(fn: () => T | Promise<T>): Promise<T> {
  const previous = {
    childCodexBin: process.env.AUTOMATION_OS_CHILD_CODEX_BIN,
    fakeExitStatus: process.env.FAKE_CODEX_EXIT_STATUS,
    fakeDelayMs: process.env.FAKE_CODEX_DELAY_MS,
    childTimeoutMs: process.env.AUTOMATION_OS_CHILD_CODEX_TIMEOUT_MS,
    workerKillGraceMs: process.env.AUTOMATION_OS_WORKER_KILL_GRACE_MS
  };
  process.env.AUTOMATION_OS_CHILD_CODEX_BIN = writeFakeCodex();
  try {
    return await fn();
  } finally {
    if (previous.childCodexBin === undefined) delete process.env.AUTOMATION_OS_CHILD_CODEX_BIN;
    else process.env.AUTOMATION_OS_CHILD_CODEX_BIN = previous.childCodexBin;
    if (previous.fakeExitStatus === undefined) delete process.env.FAKE_CODEX_EXIT_STATUS;
    else process.env.FAKE_CODEX_EXIT_STATUS = previous.fakeExitStatus;
    if (previous.fakeDelayMs === undefined) delete process.env.FAKE_CODEX_DELAY_MS;
    else process.env.FAKE_CODEX_DELAY_MS = previous.fakeDelayMs;
    if (previous.childTimeoutMs === undefined) delete process.env.AUTOMATION_OS_CHILD_CODEX_TIMEOUT_MS;
    else process.env.AUTOMATION_OS_CHILD_CODEX_TIMEOUT_MS = previous.childTimeoutMs;
    if (previous.workerKillGraceMs === undefined) delete process.env.AUTOMATION_OS_WORKER_KILL_GRACE_MS;
    else process.env.AUTOMATION_OS_WORKER_KILL_GRACE_MS = previous.workerKillGraceMs;
  }
}

async function waitForRunStatus(runId: string, expected: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let latest: { status: string; metadata_json: string } | undefined;
  while (Date.now() < deadline) {
    await runWorkerOnce(runId);
    latest = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
    if (latest?.status === expected) return latest;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for run ${runId} to become ${expected}; latest=${latest?.status ?? "missing"}`);
}

async function waitForWorkerEvent(runId: string, eventType: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let latestCount = 0;
  while (Date.now() < deadline) {
    const rows = querySql<{ event_type: string; metadata_json: string }>(
      `SELECT event_type, metadata_json FROM worker_events WHERE run_id=${sqlValue(runId)} AND event_type=${sqlValue(eventType)} ORDER BY created_at ASC`
    );
    latestCount = rows.length;
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for worker event ${eventType} on run ${runId}; latestCount=${latestCount}`);
}

test("plans command run with subscription-backed worker lanes", () => {
  const plan = planCommandRun("Codexで実装レビュー, Runway MCPの代替を調査, X publish");

  assert.equal(plan.tasks.length, 3);
  assert.equal(plan.tasks[0].adapter, "child_codex");
  assert.equal(plan.tasks[1].adapter, "child_codex");
  assert.equal(plan.tasks[2].requiresApproval, false);
  assert.equal(plan.approvalRequired, false);
  assert.deepEqual(plan.approvalResources, []);
  assert.equal(plan.collisionOverrideResources.length, 0);
});

test("builds worker commands without OpenAI API keys", () => {
  assert.equal(chooseWorkerAdapter({ name: "Daily AI publish full flow", resources: ["social_publish"] }), "daily_ai_registered");
  assert.equal(
    chooseWorkerAdapter({ name: "NisenPrints registered workflow billing-only proof gate full publish", resources: ["commerce_publish"] }),
    "nisenprints_registered"
  );
  assert.equal(
    chooseWorkerAdapter({ name: "Job Application Daily Submit Queue registered workflow billing-only submit", resources: ["local_worker"] }),
    "job_submit_registered"
  );
  assert.equal(
    chooseWorkerAdapter({ name: "Job Application Post-Application Manager registered workflow billing-only send follow-up", resources: ["local_worker"] }),
    "job_submit_registered"
  );
  assert.equal(chooseWorkerAdapter({ name: "コードをレビュー", resources: ["local_worker"] }), "child_codex");
  assert.match(buildWorkerCommand({ adapter: "child_codex", taskName: "調査" }).display, /codex exec --sandbox read-only --cd/);
  assert.equal(buildWorkerCommand({ adapter: "codex_cli", taskName: "調査" }).display, 'codex exec --sandbox read-only "調査"');
  const dailyAiCommand = buildWorkerCommand({ adapter: "daily_ai_registered", taskName: "Daily AI" });
  assert.match(dailyAiCommand.display, /run_daily_ai_playwright_cli\.mjs/);
  assert.equal(dailyAiCommand.env?.DAILY_AI_CDP_PORT, "9333");
  assert.equal(dailyAiCommand.env?.DAILY_AI_CLI_PROFILE_DIR, "/Users/nichikatanaka/.daily-ai-playwright-chrome");
  assert.equal(dailyAiCommand.env?.DAILY_AI_CLI_HEADLESS, "true");
  assert.equal(dailyAiCommand.env?.DAILY_AI_CLI_SHOW_BROWSER, "false");
  assert.equal(dailyAiCommand.env?.DAILY_AI_CLI_EXTERNAL_VIDEO_QA_REQUIRED, "0");
  assert.equal(dailyAiCommand.env?.DAILY_AI_CLI_REPLENISH_BUFFER_TIMEOUT_MS, "600000");
  assert.equal(dailyAiCommand.env?.DAILY_AI_RUNWAY_MCP_TIMEOUT_SECONDS, "300");
  assert.ok(Number(dailyAiCommand.env?.DAILY_AI_CLI_REPLENISH_BUFFER_TIMEOUT_MS) >= Number(dailyAiCommand.env?.DAILY_AI_RUNWAY_MCP_TIMEOUT_SECONDS) * 1000);
  assert.equal(dailyAiCommand.env && "DAILY_AI_CLI_GEMINI_VIDEO_QA_REQUIRED" in dailyAiCommand.env, false);
  assert.match(dailyAiCommand.display, /DAILY_AI_CDP_PORT=9333/);
  assert.match(dailyAiCommand.display, /DAILY_AI_CLI_HEADLESS=true/);
  assert.match(dailyAiCommand.display, /DAILY_AI_CLI_EXTERNAL_VIDEO_QA_REQUIRED=0/);
  assert.match(dailyAiCommand.display, /DAILY_AI_CLI_REPLENISH_BUFFER_TIMEOUT_MS=600000/);
  assert.match(dailyAiCommand.display, /DAILY_AI_RUNWAY_MCP_TIMEOUT_SECONDS=300/);
  const nisenprintsDefaultRunner = join(tempRoot, "worker-command-default-nisenprints-runner.mjs");
  writeFileSync(nisenprintsDefaultRunner, "#!/usr/bin/env node\n", "utf8");
  chmodSync(nisenprintsDefaultRunner, 0o755);
  const nisenprintsCommand = buildWorkerCommand({ adapter: "nisenprints_registered", taskName: "NisenPrints", nisenprintsDefaultRunnerPath: nisenprintsDefaultRunner });
  assert.equal(nisenprintsCommand.bin, "node");
  assert.deepEqual(nisenprintsCommand.args, [nisenprintsDefaultRunner]);
  assert.equal(nisenprintsCommand.env?.NISENPRINTS_BROWSER_DRIVER, "playwright_cli");
  assert.equal(nisenprintsCommand.env?.NISENPRINTS_REQUIRE_BROWSER_USE, "0");
  assert.equal(nisenprintsCommand.env?.NISENPRINTS_RECORDING_REQUIRED, "0");
  assert.equal(nisenprintsCommand.env?.NISENPRINTS_GEMINI_VIDEO_QA_REQUIRED, "0");
  assert.equal(nisenprintsCommand.env && "BROWSER_USE_CDP_URL" in nisenprintsCommand.env, false);
  assert.equal(nisenprintsCommand.env && "BROWSER_USE_SESSION" in nisenprintsCommand.env, false);
  assert.equal(nisenprintsCommand.env?.AUTOMATION_OS_RUN_ID, "<AUTOMATION_OS_RUN_ID>");
  assert.equal(nisenprintsCommand.env?.NISENPRINTS_REGISTERED_SUMMARY_PATH, "<NISENPRINTS_REGISTERED_SUMMARY_PATH>");
  assert.equal(nisenprintsCommand.env?.NISENPRINTS_OUTPUT_DIR, "<NISENPRINTS_OUTPUT_DIR>");
  assert.equal(nisenprintsCommand.env?.AUTOMATION_STAGE_TIMEOUT_MS, "900000");
  assert.match(nisenprintsCommand.display, /NISENPRINTS_BROWSER_DRIVER=playwright_cli/);
  assert.match(nisenprintsCommand.display, /AUTOMATION_OS_RUN_ID="<AUTOMATION_OS_RUN_ID>"/);
  assert.match(nisenprintsCommand.display, /NISENPRINTS_REGISTERED_SUMMARY_PATH="<NISENPRINTS_REGISTERED_SUMMARY_PATH>"/);
  assert.match(nisenprintsCommand.display, /NISENPRINTS_OUTPUT_DIR="<NISENPRINTS_OUTPUT_DIR>"/);
  assert.match(nisenprintsCommand.display, /AUTOMATION_STAGE_TIMEOUT_MS="900000"/);
  assert.doesNotMatch(nisenprintsCommand.display, /BROWSER_USE_/);
  assert.match(
    buildWorkerCommand({ adapter: "nisenprints_registered", taskName: "NisenPrints", nisenprintsDefaultRunnerPath: join(tempRoot, "missing-nisenprints-runner.mjs") }).display,
    /NisenPrints Playwright CLI runner is not configured/
  );
  const jobSubmitCommand = buildWorkerCommand({ adapter: "job_submit_registered", taskName: "Job submit" });
  const jobFollowupCommand = buildWorkerCommand({ adapter: "job_followup_registered", taskName: "Job follow-up" });
  assert.match(jobSubmitCommand.display, /job-application-manager/);
  assert.equal(jobSubmitCommand.env?.AUTOMATION_OS_RUN_ID, "<AUTOMATION_OS_RUN_ID>");
  assert.equal(jobSubmitCommand.env?.AUTOMATION_OS_REGISTERED_SUMMARY_PATH, "<AUTOMATION_OS_REGISTERED_SUMMARY_PATH>");
  assert.match(jobSubmitCommand.display, /AUTOMATION_OS_RUN_ID="<AUTOMATION_OS_RUN_ID>"/);
  assert.match(jobSubmitCommand.display, /AUTOMATION_OS_REGISTERED_SUMMARY_PATH="<AUTOMATION_OS_REGISTERED_SUMMARY_PATH>"/);
  assert.match(jobFollowupCommand.display, /job-application-manager/);
  assert.equal(jobFollowupCommand.env?.AUTOMATION_OS_RUN_ID, "<AUTOMATION_OS_RUN_ID>");
  assert.equal(jobFollowupCommand.env?.AUTOMATION_OS_REGISTERED_SUMMARY_PATH, "<AUTOMATION_OS_REGISTERED_SUMMARY_PATH>");
  assert.match(jobFollowupCommand.display, /AUTOMATION_OS_RUN_ID="<AUTOMATION_OS_RUN_ID>"/);
  assert.match(jobFollowupCommand.display, /AUTOMATION_OS_REGISTERED_SUMMARY_PATH="<AUTOMATION_OS_REGISTERED_SUMMARY_PATH>"/);
  const promptTransferCommand = buildWorkerCommand({ adapter: "prompt_transfer_registered", taskName: "Prompt Transfer" });
  assert.equal(promptTransferCommand.bin, "python3");
  assert.match(promptTransferCommand.display, /run_prompt_transfer_ukiyoe_playwright_sheets\.py/);
  assert.match(promptTransferCommand.display, /--commit --allow-external-commit/);
  assert.equal(promptTransferCommand.env?.PROMPT_TRANSFER_EXTERNAL_COMMIT_REQUESTED, "1");
  assert.equal(promptTransferCommand.env?.PROMPT_TRANSFER_ALLOW_EXTERNAL_COMMIT, "1");
  assert.doesNotMatch(promptTransferCommand.display, /browser-use-cmd/);
  assert.equal(buildWorkerCommand({ adapter: "codex_cli", taskName: "調査" }).display, 'codex exec --sandbox read-only "調査"');
  const previousChildBin = process.env.AUTOMATION_OS_CHILD_CODEX_BIN;
  const previousCodexBin = process.env.AUTOMATION_OS_CODEX_BIN;
  delete process.env.AUTOMATION_OS_CHILD_CODEX_BIN;
  process.env.AUTOMATION_OS_CODEX_BIN = "/tmp/fallback-codex";
  try {
    assert.equal(buildWorkerCommand({ adapter: "child_codex", taskName: "調査" }).bin, "/tmp/fallback-codex");
  } finally {
    if (previousChildBin === undefined) delete process.env.AUTOMATION_OS_CHILD_CODEX_BIN;
    else process.env.AUTOMATION_OS_CHILD_CODEX_BIN = previousChildBin;
    if (previousCodexBin === undefined) delete process.env.AUTOMATION_OS_CODEX_BIN;
    else process.env.AUTOMATION_OS_CODEX_BIN = previousCodexBin;
  }

  const command = buildWorkerCommand({
    adapter: "playwright_cli",
    taskName: "Runway MCP alternative",
    lane: { cdp_port: 9335, profile_dir: "/tmp/profile-a", workdir: "/tmp/work-a" }
  });

  assert.match(command.bin, /playwright_cli\.sh|playwright-cli/);
  assert.equal(command.env?.PLAYWRIGHT_CLI_CDP_URL, "http://127.0.0.1:9335");
  assert.equal(command.env?.PLAYWRIGHT_CLI_PROFILE, "/tmp/profile-a");
  assert.equal(command.env?.PLAYWRIGHT_CLI_WORKDIR, "/tmp/work-a");
  assert.match(command.display, /playwright-cli open/);
  assert.equal(
    buildWorkerCommand({
      adapter: "browser_use_cli",
      taskName: "legacy Browser Use alias",
      lane: { cdp_port: 9444, profile_dir: "/tmp/profile-legacy", workdir: "/tmp/work-legacy" }
    }).env?.PLAYWRIGHT_CLI_CDP_URL,
    "http://127.0.0.1:9444"
  );
});

test("routes explicit Browser Use QA to Playwright CLI unless it is code maintenance", () => {
  assert.equal(chooseWorkerAdapter({ name: "Browser Use QA", resources: ["local_worker"] }), "playwright_cli");
  assert.equal(chooseWorkerAdapter({ name: "Browser Useで画面確認", resources: ["local_worker"] }), "playwright_cli");
  assert.equal(chooseWorkerAdapter({ name: "Browser Use workerEngine修正", resources: ["local_worker"] }), "child_codex");
});

test("routes Codex review about social copy without approval", () => {
  const plan = planCommandRun("CodexでX投稿文をレビュー");

  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].adapter, "child_codex");
  assert.equal(plan.tasks[0].requiresApproval, false);
  assert.deepEqual(plan.tasks[0].resources, ["local_worker"]);
  assert.equal(plan.approvalRequired, false);
});

test("plans Codex existence checks with response condition as one executable task", () => {
  const plan = planCommandRun("Codexでdocs/10-obsidian-export.md存在確認のみ。存在したら1文で終了。");

  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].adapter, "child_codex");
  assert.equal(plan.tasks[0].name, "Codexでdocs/10-obsidian-export.md存在確認のみ。存在したら1文で終了");
  assert.equal(plan.approvalRequired, false);
});

test("does not merge dangerous response-like conditions into readonly existence checks", () => {
  const plan = planCommandRun("Codexでdocs/10-obsidian-export.md存在確認のみ。存在したら保存して1文で報告。");

  assert.equal(plan.tasks.length, 2);
  assert.equal(plan.tasks[0].name, "Codexでdocs/10-obsidian-export.md存在確認のみ");
  assert.equal(plan.tasks[0].requiresApproval, false);
  assert.equal(plan.tasks[1].name, "存在したら保存して1文で報告");
  assert.equal(plan.tasks[1].dangerousAction, true);
  assert.equal(plan.tasks[1].requiresApproval, false);
  assert.equal(plan.approvalRequired, false);
});

test("plans non-billing external actions as executable without approval", () => {
  const plan = planCommandRun("SNSに投稿して、応募フォームを提出して、Gmailで送信して、Sheetsに保存して、重複行を削除して");

  assert.ok(plan.tasks.length >= 1);
  assert.equal(plan.approvalRequired, false);
  assert.deepEqual(plan.approvalResources, []);
  assert.equal(plan.tasks.every((task) => task.requiresApproval === false), true);
});

test("does not route Daily AI code maintenance text to the live registered runner", () => {
  const plan = planCommandRun("Daily AI専用executor, workerEngine分岐をレビュー");

  assert.equal(plan.approvalRequired, false);
  assert.deepEqual(plan.tasks.map((task) => task.adapter), ["child_codex", "child_codex"]);
  assert.deepEqual(plan.tasks.flatMap((task) => task.resources), ["local_worker", "local_worker"]);
});

test("routes fixed registered workflow start commands to executable registered adapters", () => {
  const nisenPlan = planCommandRun("NisenPrints registered workflow billing-only proof gate full publish");
  const submitPlan = planCommandRun("Job Application Daily Submit Queue registered workflow billing-only submit");
  const followupPlan = planCommandRun("Job Application Post-Application Manager registered workflow billing-only send follow-up");
  const promptTransferPlan = planCommandRun("Prompt Transfer Ukiyoe registered workflow billing-only save sheets");
  const snsPlan = planCommandRun("SNS Multi Poster Ukiyoe registered workflow billing-only post publish");
  const xLanePlan = planCommandRun("X authenticated browser lane registered workflow billing-only x.com save lane proof");

  assert.equal(nisenPlan.tasks[0].adapter, "nisenprints_registered");
  assert.equal(nisenPlan.approvalRequired, false);
  assert.equal(nisenPlan.runContract?.mode, "nisenprints_full_publish_run");
  assert.equal(submitPlan.tasks[0].adapter, "job_submit_registered");
  assert.equal(submitPlan.tasks[0].requiresApproval, false);
  assert.equal(submitPlan.approvalRequired, false);
  assert.equal(followupPlan.tasks[0].adapter, "job_submit_registered");
  assert.equal(followupPlan.tasks[0].requiresApproval, false);
  assert.equal(followupPlan.approvalRequired, false);
  assert.equal(promptTransferPlan.tasks[0].adapter, "prompt_transfer_registered");
  assert.equal(promptTransferPlan.approvalRequired, false);
  assert.equal(snsPlan.tasks[0].adapter, "sns_multi_poster_registered");
  assert.equal(snsPlan.approvalRequired, false);
  assert.equal(xLanePlan.tasks[0].adapter, "x_authenticated_browser_lane_registered");
  assert.equal(xLanePlan.approvalRequired, false);
});

test("SNS Multi Poster registered workflow blocks when image or caption input is missing", async () => {
  initDb();
  resetDemoData();
  await withSnsMultiPosterEnv("worker-sns-missing-input", {}, async () => {
    const created = await startCommandRun("SNS Multi Poster Ukiyoe registered workflow billing-only post publish", {
      metadata: {
        registered_workflow_id: "sns-multi-poster-ukiyoe",
        registered_workflow_start: { source: "manual", runnerKind: "sns_multi_poster_registered" }
      }
    });

    const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(created.runId)} LIMIT 1`)[0];
    const step = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM run_steps WHERE run_id=${sqlValue(created.runId)} LIMIT 1`)[0];
    const approvals = querySql<{ id: string }>(`SELECT id FROM approvals WHERE run_id=${sqlValue(created.runId)}`);
    const runMetadata = JSON.parse(run.metadata_json);
    const stepMetadata = JSON.parse(step.metadata_json);
    const startedEventMetadata = latestStartedWorkerEventMetadata(created.runId);

    assert.equal(approvals.length, 0);
    assert.equal(run.status, "blocked");
    assert.equal(step.status, "blocked");
    assert.equal(stepMetadata.execution_mode, "execute_sns_multi_poster_registered");
    assert.equal(stepMetadata.exact_blocker, "sns_multi_poster_input_required");
    assert.equal(stepMetadata.external_action_executed, false);
    assertBillingOnlyRunnerSafety(startedEventMetadata);
    assertBillingOnlyRunnerSafety(stepMetadata);
    assert.equal(runMetadata.worker_mode, "execute_sns_multi_poster_registered");
    assert.deepEqual(runMetadata.proof_gate.missing, ["sns_multi_poster_input_required"]);
    assert.equal(runMetadata.external_action_executed, false);
    assert.equal(runMetadata.resolved_inputs.source, "missing");
    assertBillingOnlyRunnerSafety(runMetadata);
  });
});

test("SNS Multi Poster registered workflow resolves latest completed NisenPrints asset without manual input", async () => {
  initDb();
  resetDemoData();
  const nisen = writeFakeCompletedNisenPrintsManifest("worker-sns-auto-input");
  const fakeRunner = writeFakeSnsMultiPosterRunner("fake-sns-auto-input-runner", {
    status: "success",
    external_action_executed: true,
    posted: true,
    published: true,
    platform_results: [{ platform: "x", status: "posted", url: "https://x.com/example/status/auto-input" }]
  });
  await withSnsMultiPosterEnv("worker-sns-auto-input", { runner: fakeRunner, nisenPrintsRoot: nisen.root }, async () => {
    const created = await startCommandRun("SNS Multi Poster Ukiyoe registered workflow billing-only post publish", {
      metadata: {
        registered_workflow_id: "sns-multi-poster-ukiyoe",
        registered_workflow_start: { source: "manual", runnerKind: "sns_multi_poster_registered" }
      }
    });

    const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(created.runId)} LIMIT 1`)[0];
    const approvals = querySql<{ id: string }>(`SELECT id FROM approvals WHERE run_id=${sqlValue(created.runId)}`);
    const runMetadata = JSON.parse(run.metadata_json);

    assert.equal(approvals.length, 0);
    assert.equal(run.status, "complete");
    assert.equal(runMetadata.resolved_inputs.source, "nisenprints_latest_completed");
    assert.equal(runMetadata.resolved_inputs.nisenprints_run_id, nisen.runId);
    assert.deepEqual(runMetadata.proof_gate.missing, []);
    assert.equal(runMetadata.external_action_executed, true);
  });
});

test("SNS Multi Poster registered workflow executes approved runner and records external post metadata", async () => {
  initDb();
  resetDemoData();
  const imagePath = join(tempRoot, "sns-stage-image.png");
  writeFileSync(imagePath, "png");
  const fakeRunner = writeFakeSnsMultiPosterRunner("fake-sns-approved-post-runner", {
    status: "success",
    external_action_executed: true,
    posted: true,
    published: true,
    platform_results: [{ platform: "x", status: "posted", url: "https://x.com/example/status/1" }]
  });
  await withSnsMultiPosterEnv("worker-sns-approved-post", { imagePath, caption: "浮世絵猫の投稿文", runner: fakeRunner }, async () => {
    const command = buildWorkerCommand({ adapter: "sns_multi_poster_registered", taskName: "SNS Multi Poster" });
    assert.match(command.display, /fake-sns-approved-post-runner\.mjs/);
    assert.equal(command.env?.SNS_MULTI_POSTER_APPROVED_EXTERNAL_ACTIONS, "post,publish");
    assert.equal(command.env?.SNS_MULTI_POSTER_HARD_STOPS, "billing,purchase,payment,checkout");

    const created = await startCommandRun("SNS Multi Poster Ukiyoe registered workflow billing-only post publish", {
      metadata: {
        registered_workflow_id: "sns-multi-poster-ukiyoe",
        registered_workflow_start: { source: "manual", runnerKind: "sns_multi_poster_registered" }
      }
    });

    const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(created.runId)} LIMIT 1`)[0];
    const step = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM run_steps WHERE run_id=${sqlValue(created.runId)} LIMIT 1`)[0];
    const proofs = querySql<{ proof_type: string; uri: string; metadata_json: string }>(`SELECT proof_type, uri, metadata_json FROM proofs WHERE run_id=${sqlValue(created.runId)} ORDER BY proof_type ASC`);
    const runMetadata = JSON.parse(run.metadata_json);
    const stepMetadata = JSON.parse(step.metadata_json);
    const startedEventMetadata = latestStartedWorkerEventMetadata(created.runId);
    const approvals = querySql<{ id: string }>(`SELECT id FROM approvals WHERE run_id=${sqlValue(created.runId)}`);
    const postProof = proofs.find((proof) => proof.proof_type === "sns_multi_poster_external_post_done");
    const summaryProof = proofs.find((proof) => proof.proof_type === "sns_multi_poster_summary");
    assert.ok(postProof);
    assert.ok(summaryProof);
    const summary = JSON.parse(readFileSync(fileURLToPath(summaryProof.uri), "utf8"));

    assert.equal(approvals.length, 0);
    assert.equal(run.status, "complete");
    assert.equal(step.status, "completed");
    assert.equal(stepMetadata.execution_mode, "execute_sns_multi_poster_registered");
    assert.equal(stepMetadata.sns_multi_poster_status, "complete");
    assert.equal(stepMetadata.external_action_executed, true);
    assertBillingOnlyRunnerSafety(startedEventMetadata);
    assertBillingOnlyRunnerSafety(stepMetadata);
    assert.equal(runMetadata.worker_mode, "execute_sns_multi_poster_registered");
    assert.deepEqual(runMetadata.proof_gate.missing, []);
    assert.ok(runMetadata.proof_gate.present.includes("sns_multi_poster_external_post_done"));
    assert.ok(runMetadata.proof_gate.present.includes("sns_multi_poster_summary"));
    assert.equal(runMetadata.external_action_executed, true);
    assertBillingOnlyRunnerSafety(runMetadata);
    assert.equal(summary.external_action_executed, true);
  });
});

test("SNS Multi Poster registered summary can complete after approved external post", () => {
  const summaryDir = join(tempRoot, "worker-sns-approved-post");
  mkdirSync(summaryDir, { recursive: true });
  const summaryPath = join(summaryDir, "result.json");
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        status: "success",
        run_id: "run_sns_approved_post",
        external_action_executed: true,
        posted: true,
        published: true,
        platform_results: [{ platform: "x", status: "posted", url: "https://x.com/example/status/1" }]
      },
      null,
      2
    )
  );

  const result = evaluateSnsMultiPosterSummary(summaryPath, { runId: "run_sns_approved_post", outputRoot: summaryDir, exitStatus: 0, timedOut: false });

  assert.equal(result.status, "complete");
  assert.equal(result.proof_gate.ok, true);
  assert.deepEqual(result.proof_gate.missing, []);
  assert.ok(result.proof_gate.present.includes("sns_multi_poster_external_post_done"));
  assert.ok(result.proof_gate.present.includes("sns_multi_poster_summary"));
  assert.equal(result.metadata.external_action_executed, true);
});

test("SNS Multi Poster registered summary blocks human-input proof when evidence path is missing", () => {
  const summaryDir = join(tempRoot, "worker-sns-human-evidence-missing");
  mkdirSync(summaryDir, { recursive: true });
  const summaryPath = join(summaryDir, "result.json");
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        status: "blocked",
        run_id: "run_sns_human_evidence_missing",
        exact_blocker: "sns_multi_poster_human_input_required_with_evidence",
        evidence_reason: "compose_surface_missing",
        external_action_executed: false
      },
      null,
      2
    )
  );

  const result = evaluateSnsMultiPosterSummary(summaryPath, { runId: "run_sns_human_evidence_missing", outputRoot: summaryDir, exitStatus: 0, timedOut: false });

  assert.equal(result.status, "blocked");
  assert.equal(result.proof_gate.ok, false);
  assert.deepEqual(result.proof_gate.present, []);
  assert.deepEqual(result.proof_gate.missing, ["sns_multi_poster_human_input_evidence_missing"]);
  assert.equal(result.metadata.blocker, "sns_multi_poster_human_input_evidence_missing");
  assert.equal(result.metadata.evidence_error, "evidence_path_missing");
});

test("SNS Multi Poster registered summary records human-input proof only with readable evidence path", () => {
  const summaryDir = join(tempRoot, "worker-sns-human-evidence-present");
  mkdirSync(summaryDir, { recursive: true });
  const evidencePath = join(summaryDir, "human-input-required-with-evidence.json");
  const summaryPath = join(summaryDir, "result.json");
  writeFileSync(
    evidencePath,
    JSON.stringify(
      {
        status: "blocked",
        exact_blocker: "sns_multi_poster_compose_surface_missing",
        screenshot_path: join(summaryDir, "x-compose.png"),
        dom_path: join(summaryDir, "x-compose-dom.txt"),
        attempt_path: join(summaryDir, "x-cdp-attempt.json"),
        external_action_executed: false
      },
      null,
      2
    )
  );
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        status: "blocked",
        run_id: "run_sns_human_evidence_present",
        exact_blocker: "sns_multi_poster_human_input_required_with_evidence",
        evidence_reason: "compose_surface_missing",
        evidence_path: evidencePath,
        external_action_executed: false
      },
      null,
      2
    )
  );

  const result = evaluateSnsMultiPosterSummary(summaryPath, { runId: "run_sns_human_evidence_present", outputRoot: summaryDir, exitStatus: 0, timedOut: false });

  assert.equal(result.status, "blocked");
  assert.equal(result.proof_gate.ok, false);
  assert.deepEqual(result.proof_gate.missing, ["sns_multi_poster_external_post_not_executed"]);
  assert.ok(result.proof_gate.present.includes("sns_multi_poster_human_input_required_with_evidence"));
  assert.ok(result.proof_gate.present.includes("sns_multi_poster_summary"));
  assert.equal(result.proofs[0]?.uri, pathToFileURL(evidencePath).href);
  assert.equal(result.metadata.evidence_path, evidencePath);
});

test("SNS Multi Poster runner classifies X onboarding login as auth evidence", () => {
  const source = readFileSync("scripts/run_sns_multi_poster_ukiyoe_playwright_cli.mjs", "utf8");

  assert.match(source, /\/i\\\/jf\\\/onboarding\\\/web/);
  assert.match(source, /mode=login/);
  assert.match(source, /電話番号で続ける/);
  assert.match(source, /メールアドレスまたはユーザー名/);
  assert.match(source, /sns_multi_poster_login_or_auth_required/);
});

test("X registered workflow records human-input evidence blocker when callable surface is missing", async () => {
  initDb();
  resetDemoData();

  const created = await startCommandRun("X authenticated browser lane registered workflow billing-only x.com save lane proof", {
    metadata: {
      registered_workflow_id: "x-authenticated-browser-lane",
      registered_workflow_start: { source: "manual", runnerKind: "x_authenticated_browser_lane_registered" }
    }
  });

    const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(created.runId)} LIMIT 1`)[0];
    const step = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM run_steps WHERE run_id=${sqlValue(created.runId)} LIMIT 1`)[0];
    const lane = querySql<{ status: string }>(`SELECT status FROM lanes WHERE id=(SELECT lane_id FROM run_steps WHERE run_id=${sqlValue(created.runId)} LIMIT 1) LIMIT 1`)[0];
    const proof = querySql<{ proof_type: string; uri: string; metadata_json: string }>(`SELECT proof_type, uri, metadata_json FROM proofs WHERE run_id=${sqlValue(created.runId)} LIMIT 1`)[0];
    const approvals = querySql<{ id: string }>(`SELECT id FROM approvals WHERE run_id=${sqlValue(created.runId)}`);
    const runMetadata = JSON.parse(run.metadata_json);
    const stepMetadata = JSON.parse(step.metadata_json);
    const proofMetadata = JSON.parse(proof.metadata_json);
    const startedEventMetadata = latestStartedWorkerEventMetadata(created.runId);
    const artifact = JSON.parse(readFileSync(fileURLToPath(proof.uri), "utf8"));

    assert.equal(approvals.length, 0);
    assert.equal(run.status, "blocked");
    assert.equal(step.status, "blocked");
    assert.equal(lane.status, "blocked");
    assert.equal(stepMetadata.execution_mode, "human_input_required_with_evidence");
    assert.equal(stepMetadata.exact_blocker, "x_authenticated_browser_lane_human_input_required_with_evidence");
    assert.equal(stepMetadata.dry_run, true);
    assert.equal(stepMetadata.external_action_executed, false);
    assertBillingOnlyRunnerSafety(startedEventMetadata);
    assertBillingOnlyRunnerSafety(stepMetadata);
    assert.equal(proof.proof_type, "x_authenticated_browser_lane_registered_blocked");
    assert.equal(proofMetadata.completion_boundary, "approved_x_action_or_callable_surface_human_input_evidence");
    assert.equal(proofMetadata.external_action_executed, false);
    assertBillingOnlyRunnerSafety(proofMetadata);
    assert.equal("proofOnly" in artifact, false);
    assert.equal(artifact.dryRun, true);
    assert.equal(artifact.externalActionExecuted, false);
    assertBillingOnlyRunnerSafety({ runner_safety: artifact.runnerSafety });
    assert.equal(artifact.mode, "human_input_required_with_evidence");
    assert.equal(artifact.approvalBoundary, "billing_purchase_payment_checkout_hard_stop");
    assert.equal(runMetadata.worker_mode, "human_input_required_with_evidence");
    assert.equal(runMetadata.proof_gate.ok, false);
    assert.deepEqual(runMetadata.proof_gate.missing, ["x_authenticated_browser_lane_human_input_required_with_evidence"]);
    assert.ok(runMetadata.proof_gate.present.includes("x_authenticated_browser_lane_registered:human_input_required_with_evidence"));
    assert.equal(runMetadata.external_action_executed, false);
    assertBillingOnlyRunnerSafety(runMetadata);
    assert.equal(runMetadata.human_input_required_with_evidence.externalActionExecuted, false);
});

test("Prompt Transfer registered workflow saves Sheets immediately with commit flags", async () => {
  initDb();
  resetDemoData();
  const restoreRunner = installFakePromptTransferRunner("worker-prompt-transfer-plan");
  try {
    const created = await startCommandRun("Prompt Transfer Ukiyoe registered workflow billing-only save sheets", {
      metadata: {
        registered_workflow_id: "prompt-transfer-ukiyoe",
        registered_workflow_start: { source: "manual", runnerKind: "prompt_transfer_registered" }
      }
    });
    const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(created.runId)} LIMIT 1`)[0];
    const step = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM run_steps WHERE run_id=${sqlValue(created.runId)} LIMIT 1`)[0];
    const proof = querySql<{ proof_type: string; uri: string; metadata_json: string }>(`SELECT proof_type, uri, metadata_json FROM proofs WHERE run_id=${sqlValue(created.runId)} LIMIT 1`)[0];
    const runMetadata = JSON.parse(run.metadata_json);
    const stepMetadata = JSON.parse(step.metadata_json);
    const proofMetadata = JSON.parse(proof.metadata_json);
    const startedEventMetadata = latestStartedWorkerEventMetadata(created.runId);
    const artifact = JSON.parse(readFileSync(fileURLToPath(proof.uri), "utf8"));
    const approvals = querySql<{ id: string }>(`SELECT id FROM approvals WHERE run_id=${sqlValue(created.runId)}`);

    assert.equal(approvals.length, 0);
    assert.equal(run.status, "complete");
    assert.equal(step.status, "completed");
    assert.equal(stepMetadata.execution_mode, "execute_prompt_transfer_registered");
    assert.equal(stepMetadata.prompt_transfer_status, "complete");
    assertBillingOnlyRunnerSafety(startedEventMetadata);
    assertBillingOnlyRunnerSafety(stepMetadata);
    assert.equal(proof.proof_type, "prompt_transfer_external_commit_done");
    assert.equal(proofMetadata.commit_requested, true);
    assert.equal(proofMetadata.allow_external_commit, true);
    assert.equal(runMetadata.worker_mode, "execute_prompt_transfer_registered");
    assertBillingOnlyRunnerSafety(runMetadata);
    assert.equal(runMetadata.proof_gate.ok, true);
    assert.deepEqual(runMetadata.proof_gate.missing, []);
    assert.ok(runMetadata.proof_gate.present.includes("prompt_transfer_external_commit_done"));
    assert.equal(artifact.commit_requested, true);
    assert.equal(artifact.allow_external_commit, true);
    assert.equal(artifact.committed, true);
    assert.ok(artifact.argv.includes("--commit"));
    assert.ok(artifact.argv.includes("--allow-external-commit"));

    await runWorkerOnce(created.runId);
    const rerun = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(created.runId)} LIMIT 1`)[0];
    const rerunMetadata = JSON.parse(rerun.metadata_json);
    assert.equal(rerun.status, "complete");
    assert.equal(rerunMetadata.worker_mode, "execute_prompt_transfer_registered");
    assert.deepEqual(rerunMetadata.proof_gate.missing, []);
  } finally {
    restoreRunner();
  }
});

test("Prompt Transfer registered workflow fails closed when Playwright/Sheets runner is missing", async () => {
  initDb();
  resetDemoData();
  const previousRunner = process.env.AUTOMATION_OS_PROMPT_TRANSFER_UKIYOE_RUNNER;
  process.env.AUTOMATION_OS_PROMPT_TRANSFER_UKIYOE_RUNNER = join(tempRoot, "missing-prompt-transfer-playwright-sheets.py");
  try {
    const created = await startCommandRun("Prompt Transfer Ukiyoe registered workflow billing-only save sheets", {
      metadata: {
        registered_workflow_id: "prompt-transfer-ukiyoe",
        registered_workflow_start: { source: "manual", runnerKind: "prompt_transfer_registered" }
      }
    });

    const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(created.runId)} LIMIT 1`)[0];
    const step = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM run_steps WHERE run_id=${sqlValue(created.runId)} LIMIT 1`)[0];
    const runMetadata = JSON.parse(run.metadata_json);
    const stepMetadata = JSON.parse(step.metadata_json);

    assert.equal(run.status, "blocked");
    assert.equal(step.status, "blocked");
    assert.equal(stepMetadata.exact_blocker, "prompt_transfer_playwright_runner_missing");
    assert.equal(stepMetadata.command_display, "Prompt Transfer Playwright/Sheets runner missing; Browser Use wrapper will not be launched");
    assert.equal(runMetadata.proof_gate.ok, false);
    assert.ok(runMetadata.proof_gate.missing.includes("prompt_transfer_playwright_runner_missing"));
    assert.equal(runMetadata.prompt_transfer_executor.command.display, "Prompt Transfer Playwright/Sheets runner missing; Browser Use wrapper will not be launched");
  } finally {
    if (previousRunner === undefined) delete process.env.AUTOMATION_OS_PROMPT_TRANSFER_UKIYOE_RUNNER;
    else process.env.AUTOMATION_OS_PROMPT_TRANSFER_UKIYOE_RUNNER = previousRunner;
  }
});

test("Prompt Transfer registered workflow blocks when runner exits nonzero even with plan summary", async () => {
  initDb();
  resetDemoData();
  const restoreRunner = installFakePromptTransferRunner("worker-prompt-transfer-nonzero", 7);
  try {
    const created = await startCommandRun("Prompt Transfer Ukiyoe registered workflow billing-only save sheets", {
      metadata: {
        registered_workflow_id: "prompt-transfer-ukiyoe",
        registered_workflow_start: { source: "manual", runnerKind: "prompt_transfer_registered" }
      }
    });

    const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(created.runId)} LIMIT 1`)[0];
    const step = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM run_steps WHERE run_id=${sqlValue(created.runId)} LIMIT 1`)[0];
    const runMetadata = JSON.parse(run.metadata_json);
    const stepMetadata = JSON.parse(step.metadata_json);

    assert.equal(run.status, "blocked");
    assert.equal(step.status, "blocked");
    assert.equal(stepMetadata.execution_mode, "execute_prompt_transfer_registered");
    assert.equal(stepMetadata.exact_blocker, "prompt_transfer_runner_exit_nonzero");
    assert.equal(stepMetadata.runner_safety.external_action_executed, false);
    assert.equal(stepMetadata.runner_safety.kind, "billing_only_external_action_policy");
    assert.equal(stepMetadata.runner_safety.publicKind, "billing_only_hard_stop");
    assert.equal(runMetadata.worker_mode, "execute_prompt_transfer_registered");
    assert.equal(runMetadata.runner_safety.external_action_executed, false);
    assert.equal(runMetadata.runner_safety.kind, "billing_only_external_action_policy");
    assert.equal(runMetadata.runner_safety.publicKind, "billing_only_hard_stop");
    assert.ok(runMetadata.proof_gate.missing.includes("prompt_transfer_runner_exit_nonzero"));
  } finally {
    restoreRunner();
  }
});

test("requires explicit approval rows before protected steps can run", () => {
  assert.equal(approvalsAllowProtectedSteps([]), false);
  assert.equal(approvalsAllowProtectedSteps([{ status: "pending" }]), false);
  assert.equal(approvalsAllowProtectedSteps([{ status: "approved" }]), true);
  assert.equal(approvalsAllowProtectedSteps([{ status: "approved" }, { status: "pending" }]), false);
});

test("records collision resources without approval-stopping non-billing parallel commits", () => {
  const plan = planCommandRun("X publish, LinkedIn publish");

  assert.deepEqual(plan.collisionOverrideResources, ["social_publish"]);
  assert.deepEqual(plan.approvalResources, []);
  assert.equal(plan.approvalRequired, false);
  assert.equal(plan.tasks.every((task) => task.requiresApproval), false);
  assert.deepEqual(plan.tasks.map((task) => task.collisionWith), [["social_publish"], ["social_publish"]]);
});

test("persists Browser Use lane details when starting a command run", async () =>
  withChildCodexExecutionEnv(async () => {
    initDb();
    resetDemoData();

    const summary = await startCommandRun("Codexで実装レビュー");
    const lane = querySql<{
      cdp_port: number;
      profile_dir: string;
      browser_use_session: string;
      browser_use_cdp_url: string;
      browser_use_profile: string;
      profile_strategy: string;
      lane_visibility: string;
    }>(`SELECT * FROM lanes WHERE run_id=${sqlValue(summary.runId)} ORDER BY cdp_port ASC LIMIT 1`)[0];

    assert.equal(lane.cdp_port, 9445);
    assert.match(lane.browser_use_session, /^browser-use-/);
    assert.equal(lane.browser_use_cdp_url, "http://127.0.0.1:9445");
    assert.equal(lane.browser_use_profile, lane.profile_dir);
    assert.equal(lane.profile_strategy, "cdp_profile_lane");
    assert.equal(lane.lane_visibility, "visible");
  }));

test("completes Playwright CLI worker runs with DOM screenshot and console proof", async () => {
  initDb();
  resetDemoData();
  const restoreBrowserUse = installFakeBrowserUse("worker-playwright-ok");
  try {
    const summary = await startCommandRun("Browser Useで画面確認");
    const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const step = querySql<{ id: string; status: string; metadata_json: string }>(`SELECT id, status, metadata_json FROM run_steps WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const lane = querySql<{ status: string; health: string }>(`SELECT status, health FROM lanes WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const proof = querySql<{ proof_type: string; uri: string; metadata_json: string }>(`SELECT proof_type, uri, metadata_json FROM proofs WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const runMetadata = JSON.parse(run.metadata_json);
    const stepMetadata = JSON.parse(step.metadata_json);
    const proofMetadata = JSON.parse(proof.metadata_json);
    const artifactJson = JSON.parse(readFileSync(new URL(proof.uri), "utf8"));

    assert.equal(run.status, "complete");
    assert.equal(runMetadata.worker_mode, "execute_playwright");
    assert.equal(runMetadata.proof_gate.ok, true);
    assert.deepEqual(runMetadata.proof_gate.missing, []);
    assert.deepEqual(runMetadata.proof_gate.present, ["playwright_check", `playwright_check:${step.id}`]);
    assert.equal(step.status, "completed");
    assert.equal(stepMetadata.execution_mode, "execute_playwright");
    assert.equal(stepMetadata.playwright_status, "ok");
    assert.equal(lane.status, "idle");
    assert.equal(lane.health, "good");
    assert.equal(proof.proof_type, "playwright_check");
    assert.equal(proofMetadata.exact_blocker, null);
    assert.equal(artifactJson.mode, "playwright_cli");
    assert.equal(artifactJson.playwrightCheck.status, "ok");
    assert.match(
      artifactJson.playwrightCheck.steps.find((item: { command: string }) => item.command.endsWith(" snapshot"))?.stdout ?? "",
      /env_cdp=http:\/\/127\.0\.0\.1:\d+ env_profile=.+ env_workdir=.+/
    );
  } finally {
    restoreBrowserUse();
  }
});

test("keeps Playwright CLI worker runs complete after persisted screen proof is re-evaluated", async () => {
  initDb();
  resetDemoData();
  const restoreBrowserUse = installFakeBrowserUseWithSidecar("worker-node-sidecar-ok");
  try {
    const summary = await startCommandRun("Browser Useで画面確認");
    const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const step = querySql<{ id: string; status: string; metadata_json: string }>(`SELECT id, status, metadata_json FROM run_steps WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const lane = querySql<{ status: string; health: string }>(`SELECT status, health FROM lanes WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const proof = querySql<{ proof_type: string; uri: string; metadata_json: string }>(`SELECT proof_type, uri, metadata_json FROM proofs WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const runMetadata = JSON.parse(run.metadata_json);
    const stepMetadata = JSON.parse(step.metadata_json);
    const proofMetadata = JSON.parse(proof.metadata_json);
    const artifactJson = JSON.parse(readFileSync(new URL(proof.uri), "utf8"));

    assert.equal(run.status, "complete");
    assert.equal(runMetadata.worker_mode, "execute_playwright");
    assert.equal(runMetadata.proof_gate.ok, true);
    assert.deepEqual(runMetadata.proof_gate.missing, []);
    assert.deepEqual(runMetadata.proof_gate.present, ["playwright_check", `playwright_check:${step.id}`]);
    assert.equal(step.status, "completed");
    assert.equal(stepMetadata.execution_mode, "execute_playwright");
    assert.equal(stepMetadata.playwright_status, "ok");
    assert.equal(lane.status, "idle");
    assert.equal(lane.health, "good");
    assert.equal(proof.proof_type, "playwright_check");
    assert.equal(proofMetadata.exact_blocker, null);
    assert.equal(artifactJson.status, "ok");
    assert.equal(artifactJson.playwrightCheck.status, "ok");

    await runWorkerOnce(summary.runId);
    const rerun = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const rerunMetadata = JSON.parse(rerun.metadata_json);

    assert.equal(rerun.status, "complete");
    assert.equal(rerunMetadata.worker_mode, "execute_playwright");
    assert.equal(rerunMetadata.proof_gate.ok, true);
    assert.deepEqual(rerunMetadata.proof_gate.missing, []);
    assert.deepEqual(rerunMetadata.proof_gate.present, ["playwright_check", `playwright_check:${step.id}`]);
  } finally {
    restoreBrowserUse();
  }
});

test("does not accept legacy Browser Use checks as current completion proof", async () => {
  initDb();
  resetDemoData();
  const restoreBrowserUse = installFakeBrowserUseWithSidecar("worker-legacy-browser-use-check");
  try {
    const summary = await startCommandRun("Browser Useで画面確認");
    const step = querySql<{ id: string }>(`SELECT id FROM run_steps WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    execSql(
      `UPDATE proofs SET proof_type='browser_use_check', label='Legacy Browser Use check' WHERE run_id=${sqlValue(
        summary.runId
      )} AND proof_type='playwright_check'`
    );

    await runWorkerOnce(summary.runId);
    const rerun = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const rerunMetadata = JSON.parse(rerun.metadata_json);

    assert.equal(rerun.status, "partial");
    assert.equal(rerunMetadata.worker_mode, "execute_playwright");
    assert.equal(rerunMetadata.proof_gate.ok, false);
    assert.deepEqual(rerunMetadata.proof_gate.missing, [`playwright_check:${step.id}`]);
    assert.deepEqual(rerunMetadata.proof_gate.present, ["browser_use_check", `browser_use_check:${step.id}`]);
  } finally {
    restoreBrowserUse();
  }
});

test("rejects persisted Playwright checks when artifact status drifts", async () => {
  initDb();
  resetDemoData();
  const restoreBrowserUse = installFakeBrowserUseWithSidecar("worker-node-manifest-drift");
  try {
    const summary = await startCommandRun("Browser Useで画面確認");
    const proof = querySql<{ uri: string }>(`SELECT uri FROM proofs WHERE run_id=${sqlValue(summary.runId)} AND proof_type='playwright_check' LIMIT 1`)[0];
    const artifactJson = JSON.parse(readFileSync(new URL(proof.uri), "utf8"));
    writeFileSync(fileURLToPath(proof.uri), `${JSON.stringify({ ...artifactJson, status: "blocked" }, null, 2)}\n`, "utf8");

    await runWorkerOnce(summary.runId);
    const rerun = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const step = querySql<{ id: string }>(`SELECT id FROM run_steps WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const rerunMetadata = JSON.parse(rerun.metadata_json);

    assert.equal(rerun.status, "partial");
    assert.equal(rerunMetadata.proof_gate.ok, false);
    assert.deepEqual(rerunMetadata.proof_gate.missing, [`playwright_check_artifact_invalid:${step.id}`]);
  } finally {
    restoreBrowserUse();
  }
});

test("rejects persisted Playwright checks when screenshot proof disappears", async () => {
  initDb();
  resetDemoData();
  const restoreBrowserUse = installFakeBrowserUseWithSidecar("worker-node-manifest-target-drift");
  try {
    const summary = await startCommandRun("Browser Useで画面確認");
    const proof = querySql<{ uri: string }>(`SELECT uri FROM proofs WHERE run_id=${sqlValue(summary.runId)} AND proof_type='playwright_check' LIMIT 1`)[0];
    const artifactJson = JSON.parse(readFileSync(new URL(proof.uri), "utf8"));
    unlinkSync(artifactJson.playwrightCheck.screenshotPath);

    await runWorkerOnce(summary.runId);
    const rerun = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const step = querySql<{ id: string }>(`SELECT id FROM run_steps WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const rerunMetadata = JSON.parse(rerun.metadata_json);

    assert.equal(rerun.status, "partial");
    assert.equal(rerunMetadata.proof_gate.ok, false);
    assert.deepEqual(rerunMetadata.proof_gate.missing, [`playwright_check_artifact_invalid:${step.id}`]);
  } finally {
    restoreBrowserUse();
  }
});

test("rejects persisted Playwright checks when DOM proof disappears", async () => {
  initDb();
  resetDemoData();
  const restoreBrowserUse = installFakeBrowserUseWithSidecar("worker-node-gemini-target-drift");
  try {
    const summary = await startCommandRun("Browser Useで画面確認");
    const proof = querySql<{ uri: string }>(`SELECT uri FROM proofs WHERE run_id=${sqlValue(summary.runId)} AND proof_type='playwright_check' LIMIT 1`)[0];
    const artifactJson = JSON.parse(readFileSync(new URL(proof.uri), "utf8"));
    unlinkSync(artifactJson.playwrightCheck.domPath);

    await runWorkerOnce(summary.runId);
    const rerun = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const step = querySql<{ id: string }>(`SELECT id FROM run_steps WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const rerunMetadata = JSON.parse(rerun.metadata_json);

    assert.equal(rerun.status, "partial");
    assert.equal(rerunMetadata.proof_gate.ok, false);
    assert.deepEqual(rerunMetadata.proof_gate.missing, [`playwright_check_artifact_invalid:${step.id}`]);
  } finally {
    restoreBrowserUse();
  }
});

test("revalidates persisted Playwright console proof before keeping a run complete", async () => {
  initDb();
  resetDemoData();
  const restoreBrowserUse = installFakeBrowserUseWithSidecar("worker-node-sidecar-revalidate");
  try {
    const summary = await startCommandRun("Browser Useで画面確認");
    const proof = querySql<{ uri: string }>(`SELECT uri FROM proofs WHERE run_id=${sqlValue(summary.runId)} AND proof_type='playwright_check' LIMIT 1`)[0];
    const artifactJson = JSON.parse(readFileSync(new URL(proof.uri), "utf8"));
    unlinkSync(artifactJson.playwrightCheck.consolePath);

    await runWorkerOnce(summary.runId);
    const rerun = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const step = querySql<{ id: string }>(`SELECT id FROM run_steps WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const rerunMetadata = JSON.parse(rerun.metadata_json);

    assert.equal(rerun.status, "partial");
    assert.equal(rerunMetadata.proof_gate.ok, false);
    assert.deepEqual(rerunMetadata.proof_gate.missing, [`playwright_check_artifact_invalid:${step.id}`]);
  } finally {
    restoreBrowserUse();
  }
});

test("rejects persisted Playwright checks when artifact and check target URLs differ", async () => {
  initDb();
  resetDemoData();
  const restoreBrowserUse = installFakeBrowserUseWithSidecar("worker-playwright-target-mismatch");
  try {
    const summary = await startCommandRun("Browser Useで画面確認");
    const proof = querySql<{ uri: string }>(`SELECT uri FROM proofs WHERE run_id=${sqlValue(summary.runId)} AND proof_type='playwright_check' LIMIT 1`)[0];
    const artifactJson = JSON.parse(readFileSync(new URL(proof.uri), "utf8"));
    writeFileSync(
      fileURLToPath(proof.uri),
      `${JSON.stringify({ ...artifactJson, targetUrl: "http://127.0.0.1:5173/#sources-mismatch" }, null, 2)}\n`,
      "utf8"
    );

    await runWorkerOnce(summary.runId);
    const rerun = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const step = querySql<{ id: string }>(`SELECT id FROM run_steps WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const rerunMetadata = JSON.parse(rerun.metadata_json);

    assert.equal(rerun.status, "partial");
    assert.equal(rerunMetadata.proof_gate.ok, false);
    assert.deepEqual(rerunMetadata.proof_gate.missing, [`playwright_check_artifact_invalid:${step.id}`]);
  } finally {
    restoreBrowserUse();
  }
});

test("rejects persisted Playwright checks when target URL drifts outside local http", async () => {
  initDb();
  resetDemoData();
  const restoreBrowserUse = installFakeBrowserUseWithSidecar("worker-playwright-external-target");
  try {
    const summary = await startCommandRun("Browser Useで画面確認");
    const proof = querySql<{ uri: string }>(`SELECT uri FROM proofs WHERE run_id=${sqlValue(summary.runId)} AND proof_type='playwright_check' LIMIT 1`)[0];
    const artifactJson = JSON.parse(readFileSync(new URL(proof.uri), "utf8"));
    writeFileSync(fileURLToPath(proof.uri), `${JSON.stringify({ ...artifactJson, targetUrl: "https://example.com/#sources" }, null, 2)}\n`, "utf8");

    await runWorkerOnce(summary.runId);
    const rerun = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const step = querySql<{ id: string }>(`SELECT id FROM run_steps WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const rerunMetadata = JSON.parse(rerun.metadata_json);

    assert.equal(rerun.status, "partial");
    assert.equal(rerunMetadata.proof_gate.ok, false);
    assert.deepEqual(rerunMetadata.proof_gate.missing, [`playwright_check_artifact_invalid:${step.id}`]);
  } finally {
    restoreBrowserUse();
  }
});

test("rejects persisted Playwright checks when console proof content drifts", async () => {
  initDb();
  resetDemoData();
  const restoreBrowserUse = installFakeBrowserUseWithSidecar("worker-playwright-console-drift");
  try {
    const summary = await startCommandRun("Browser Useで画面確認");
    const proof = querySql<{ uri: string }>(`SELECT uri FROM proofs WHERE run_id=${sqlValue(summary.runId)} AND proof_type='playwright_check' LIMIT 1`)[0];
    const artifactJson = JSON.parse(readFileSync(new URL(proof.uri), "utf8"));
    writeFileSync(artifactJson.playwrightCheck.consolePath, "late console error\n", "utf8");

    await runWorkerOnce(summary.runId);
    const rerun = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const step = querySql<{ id: string }>(`SELECT id FROM run_steps WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const rerunMetadata = JSON.parse(rerun.metadata_json);

    assert.equal(rerun.status, "partial");
    assert.equal(rerunMetadata.proof_gate.ok, false);
    assert.deepEqual(rerunMetadata.proof_gate.missing, [`playwright_check_artifact_invalid:${step.id}`]);
  } finally {
    restoreBrowserUse();
  }
});

test("uses missing artifact names instead of cleanup reason for Browser Use worker exact blocker fallback", async () => {
  initDb();
  resetDemoData();
  const restoreBrowserUse = installFakeBrowserUseWithSidecarButMissingScreenshot("worker-node-missing-screenshot");
  try {
    const summary = await startCommandRun("Browser Useで画面確認");
    const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const step = querySql<{ id: string; status: string; metadata_json: string }>(`SELECT id, status, metadata_json FROM run_steps WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const proof = querySql<{ proof_type: string; uri: string; metadata_json: string }>(`SELECT proof_type, uri, metadata_json FROM proofs WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const runMetadata = JSON.parse(run.metadata_json);
    const stepMetadata = JSON.parse(step.metadata_json);
    const proofMetadata = JSON.parse(proof.metadata_json);
    const artifactJson = JSON.parse(readFileSync(new URL(proof.uri), "utf8"));

    assert.equal(run.status, "blocked");
    assert.equal(step.status, "blocked");
    assert.equal(proof.proof_type, "playwright_blocked");
    assert.equal(stepMetadata.playwright_exact_blocker, "playwright_artifact_missing:screenshotPath");
    assert.equal(proofMetadata.exact_blocker, "playwright_artifact_missing:screenshotPath");
    assert.equal(artifactJson.exactBlocker, "playwright_artifact_missing:screenshotPath");
    assert.deepEqual(runMetadata.proof_gate.missing, ["playwright_artifact_missing:screenshotPath", `playwright_check:${step.id}`]);
    assert.equal(artifactJson.playwrightCheck.metadata.artifactValidationStatus, "blocked");
  } finally {
    restoreBrowserUse();
  }
});

test("blocks Playwright CLI worker runs when console errors are captured", async () => {
  initDb();
  resetDemoData();
  const restoreBrowserUse = installFakeBrowserUseWithBlockedSidecar("worker-node-sidecar-exact-blocker", "browser_use_recording_cdp_target_mismatch");
  try {
    const summary = await startCommandRun("Browser Useで画面確認");
    const run = querySql<{ status: string }>(`SELECT status FROM runs WHERE id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const step = querySql<{ metadata_json: string }>(`SELECT metadata_json FROM run_steps WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const proof = querySql<{ proof_type: string; uri: string; metadata_json: string }>(`SELECT proof_type, uri, metadata_json FROM proofs WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const stepMetadata = JSON.parse(step.metadata_json);
    const proofMetadata = JSON.parse(proof.metadata_json);
    const artifactJson = JSON.parse(readFileSync(new URL(proof.uri), "utf8"));

    assert.equal(run.status, "blocked");
    assert.equal(proof.proof_type, "playwright_blocked");
    assert.equal(stepMetadata.playwright_exact_blocker, "playwright_console_errors");
    assert.equal(proofMetadata.exact_blocker, "playwright_console_errors");
    assert.equal(artifactJson.exactBlocker, "playwright_console_errors");
    assert.equal(artifactJson.playwrightCheck.consoleErrorCount, 1);
  } finally {
    restoreBrowserUse();
  }
});

test("keeps receipt-only worker runs partial until real execution is verified", () => {
  assert.equal(deriveRunStatus({ blockedByApproval: false, hasPendingApproval: false, remainingSteps: 0, workerMode: "receipt_only" }), "partial");
  assert.equal(deriveRunStatus({ blockedByApproval: false, hasPendingApproval: false, remainingSteps: 0, workerMode: "execute_codex" }), "complete");
  assert.equal(
    deriveRunStatus({
      blockedByApproval: false,
      hasPendingApproval: false,
      hasReceiptOnlyProofInExecutableRun: true,
      remainingSteps: 0,
      workerMode: "execute_codex"
    }),
    "partial"
  );
  assert.equal(deriveRunStatus({ blockedByApproval: false, hasPendingApproval: false, hasBlockedStep: true, remainingSteps: 1, workerMode: "execute_daily_ai_registered" }), "blocked");
  assert.equal(deriveRunStatus({ blockedByApproval: true, hasPendingApproval: true, remainingSteps: 2, workerMode: "receipt_only" }), "waiting_approval");
});

test("records child_codex success with child_runs and result proof", async () =>
  withChildCodexExecutionEnv(async () => {
    initDb();
    resetDemoData();

    const summary = await startCommandRun("CodexでworkerEngineをread-only確認");
    const run = await waitForRunStatus(summary.runId, "complete");
    const step = querySql<{ id: string; status: string; metadata_json: string }>(`SELECT id, status, metadata_json FROM run_steps WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const proof = querySql<{ proof_type: string; uri: string; metadata_json: string }>(`SELECT proof_type, uri, metadata_json FROM proofs WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const child = querySql<{ id: string; parent_run_id: string; step_id: string; role: string; status: string; pid: number | null; exit_status: number | null; signal: string | null; prompt_uri: string; result_uri: string; summary: string; blocker: string | null; metadata_json: string }>(
      `SELECT id, parent_run_id, step_id, role, status, pid, exit_status, signal, prompt_uri, result_uri, summary, blocker, metadata_json FROM child_runs WHERE parent_run_id=${sqlValue(summary.runId)} LIMIT 1`
    )[0];
    const runMetadata = JSON.parse(run.metadata_json);
    const stepMetadata = JSON.parse(step.metadata_json);
    const proofMetadata = JSON.parse(proof.metadata_json);
    const childMetadata = JSON.parse(child.metadata_json);
    const promptText = readFileSync(new URL(child.prompt_uri), "utf8");
    const resultJson = JSON.parse(readFileSync(new URL(child.result_uri), "utf8"));
    const fakeInvocation = JSON.parse(resultJson.stdoutTail);

    assert.equal(run.status, "complete");
    assert.equal(runMetadata.worker_mode, "execute_child_codex");
    assert.equal(runMetadata.proof_gate.ok, true);
    assert.deepEqual(runMetadata.proof_gate.missing, []);
    assert.deepEqual(runMetadata.proof_gate.present, ["child_codex_result", `child_codex_result:${step.id}`]);
    assert.equal(step.status, "completed");
    assert.equal(stepMetadata.execution_mode, "child_codex");
    assert.equal(proof.proof_type, "child_codex_result");
    assert.equal(proofMetadata.child_run_id, child.id);
    assert.equal(proof.uri, child.result_uri);
    assert.equal(stepMetadata.child_run_id, child.id);
    assert.equal(child.parent_run_id, summary.runId);
    assert.equal(child.step_id, step.id);
    assert.equal(child.role, "child_codex");
    assert.equal(child.status, "completed");
    assert.ok(typeof child.pid === "number" && child.pid > 0);
    assert.equal(child.exit_status, 0);
    assert.equal(child.signal, null);
    assert.equal(child.blocker, null);
    assert.match(child.prompt_uri, /-child-prompt\.txt$/);
    assert.match(child.result_uri, /-child-result\.json$/);
    assert.match(promptText, /CodexでworkerEngineをread-only確認/);
    assert.equal(fakeInvocation.argv.at(-1), promptText);
    assert.equal(resultJson.mode, "child_codex");
    assert.equal(childMetadata.execution_mode, "child_codex");
  }));

test("parent-only result proof satisfies a child_codex step without child delegation", async () => {
  initDb();
  resetDemoData();

  const runId = "run_parent_only_child_codex_step";
  const stepId = `${runId}_step_1`;
  const now = new Date().toISOString();
  const resultPath = join(tempRoot, `${runId}-parent-result.json`);
  writeFileSync(
    resultPath,
    JSON.stringify(
      {
        runId,
        stepId,
        mode: "parent_only",
        exitStatus: 0,
        summary: "Parent-only verification completed without child Codex delegation.",
        createdAt: now
      },
      null,
      2
    )
  );
  db.insert("runs", {
    id: runId,
    name: "parent-only child_codex step",
    status: "running",
    objective: "CodexでworkerEngineを確認",
    created_at: now,
    updated_at: now,
    metadata_json: { command: "CodexでworkerEngineを確認", parent_only: true }
  });
  db.insert("run_steps", {
    id: stepId,
    run_id: runId,
    name: "CodexでworkerEngineを確認",
    status: "completed",
    lane_id: null,
    started_at: now,
    completed_at: now,
    metadata_json: {
      execution_mode: "child_codex",
      parent_only: true
    }
  });
  db.insert("proofs", {
    id: `${runId}_proof_parent_only`,
    run_id: runId,
    step_id: stepId,
    proof_type: "parent_only_result",
    label: "Parent-only result proof",
    uri: pathToFileURL(resultPath).href,
    size_bytes: statSync(resultPath).size,
    created_at: now,
    metadata_json: { execution_mode: "parent_only", replaces_child_codex_result: true }
  });

  await worker.runWorkerOnce(runId);
  const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  const runMetadata = JSON.parse(run.metadata_json);

  assert.equal(run.status, "complete");
  assert.equal(runMetadata.worker_mode, "execute_child_codex");
  assert.equal(runMetadata.proof_gate.ok, true);
  assert.deepEqual(runMetadata.proof_gate.missing, []);
  assert.deepEqual(runMetadata.proof_gate.present, ["parent_only_result", `parent_only_result:${stepId}`]);
});

test("records child_codex blocked with child_runs and blocked proof", async () =>
  withChildCodexExecutionEnv(async () => {
    initDb();
    resetDemoData();
    process.env.FAKE_CODEX_EXIT_STATUS = "7";

    const summary = await startCommandRun("CodexでworkerEngineをread-only確認");
    const run = await waitForRunStatus(summary.runId, "blocked");
    const step = querySql<{ id: string; status: string }>(`SELECT id, status FROM run_steps WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const lane = querySql<{ status: string; health: string }>(`SELECT status, health FROM lanes WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const proof = querySql<{ proof_type: string; metadata_json: string }>(`SELECT proof_type, metadata_json FROM proofs WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const child = querySql<{ status: string; exit_status: number | null; blocker: string | null; result_uri: string }>(
      `SELECT status, exit_status, blocker, result_uri FROM child_runs WHERE parent_run_id=${sqlValue(summary.runId)} LIMIT 1`
    )[0];
    const runMetadata = JSON.parse(run.metadata_json);
    const proofMetadata = JSON.parse(proof.metadata_json);
    const resultJson = JSON.parse(readFileSync(new URL(child.result_uri), "utf8"));

    assert.equal(run.status, "blocked");
    assert.equal(runMetadata.worker_mode, "execute_child_codex");
    assert.equal(runMetadata.proof_gate.ok, false);
    assert.deepEqual(runMetadata.proof_gate.present, ["child_codex_blocked", `child_codex_blocked:${step.id}`]);
    assert.deepEqual(runMetadata.proof_gate.missing, [`child_codex_result:${step.id}`]);
    assert.equal(step.status, "blocked");
    assert.equal(lane.status, "blocked");
    assert.equal(lane.health, "blocked");
    assert.equal(proof.proof_type, "child_codex_blocked");
    assert.equal(proofMetadata.exit_status, 7);
    assert.equal(child.status, "blocked");
    assert.equal(child.exit_status, 7);
    assert.match(String(child.blocker), /fake codex blocked|child_codex exited/);
    assert.equal(resultJson.exitStatus, 7);
  }));

test("runs Daily AI code maintenance through child Codex instead of live registered runner", async () =>
  withChildCodexExecutionEnv(async () => {
    initDb();
    resetDemoData();

    const summary = await startCommandRun("Daily AI専用executor, workerEngine分岐をレビュー");
    const run = await waitForRunStatus(summary.runId, "complete");
    const steps = querySql<{ id: string; status: string; metadata_json: string }>(`SELECT id, status, metadata_json FROM run_steps WHERE run_id=${sqlValue(summary.runId)} ORDER BY id ASC`);
    const proofs = querySql<{ proof_type: string }>(`SELECT proof_type FROM proofs WHERE run_id=${sqlValue(summary.runId)} ORDER BY proof_type ASC`);
    const childRuns = querySql<{ parent_run_id: string; status: string; prompt_uri: string; result_uri: string }>(`SELECT parent_run_id, status, prompt_uri, result_uri FROM child_runs WHERE parent_run_id=${sqlValue(summary.runId)} ORDER BY created_at ASC`);
    const runMetadata = JSON.parse(run.metadata_json);

    assert.equal(run.status, "complete");
    assert.equal(runMetadata.worker_mode, "execute_child_codex");
    assert.equal(runMetadata.proof_gate.ok, true);
    assert.deepEqual(runMetadata.proof_gate.missing, []);
    assert.deepEqual([...runMetadata.proof_gate.present].sort(), [
      "child_codex_result",
      ...steps.map((step) => `child_codex_result:${step.id}`)
    ].sort());
    assert.deepEqual(steps.map((step) => step.status), ["completed", "completed"]);
    assert.ok(steps.every((step) => JSON.parse(step.metadata_json).execution_mode === "child_codex"));
    assert.deepEqual(proofs.map((proof) => proof.proof_type), ["child_codex_result", "child_codex_result"]);
    assert.equal(childRuns.length, 2);
    assert.ok(childRuns.every((childRun) => childRun.status === "completed" && childRun.prompt_uri.endsWith("-child-prompt.txt") && childRun.result_uri.endsWith("-child-result.json")));
  }));

test("Daily AI registered workflow records billing-only runner safety metadata", async () => {
  initDb();
  resetDemoData();
  const restoreRunner = installFakeDailyAiRunner("worker-daily-ai-runner-safety", 7);
  try {
    const summary = await startCommandRun("Daily AI registered workflow run full flow");
    execSql(`UPDATE approvals SET status='approved', decided_at=${sqlValue(new Date().toISOString())} WHERE run_id=${sqlValue(summary.runId)}`);
    await resumeRunAfterApproval(summary.runId);

    const run = await waitForRunStatus(summary.runId, "blocked", 12000);
    const step = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM run_steps WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const runMetadata = JSON.parse(run.metadata_json);
    const stepMetadata = JSON.parse(step.metadata_json);
    const startedEventMetadata = latestStartedWorkerEventMetadata(summary.runId);
    const eventMetadata = latestTerminalWorkerEventMetadata(summary.runId);

    assert.equal(run.status, "blocked");
    assert.equal(step.status, "blocked");
    assert.equal(runMetadata.worker_mode, "execute_daily_ai_registered");
    assert.equal(stepMetadata.daily_ai_exit_status, 7);
    assertBillingOnlyRunnerSafety(startedEventMetadata);
    assertBillingOnlyRunnerSafety(stepMetadata);
    assertBillingOnlyRunnerSafety(eventMetadata);
    assertBillingOnlyRunnerSafety(runMetadata);
  } finally {
    restoreRunner();
  }
});

test("blocks NisenPrints registered worker step when Playwright CLI runner exits nonzero", async () => {
  initDb();
  resetDemoData();
  const restoreRunner = installFakeNisenPrintsBrowserUseRunner("worker-nisenprints-nonzero", 7);
  try {
    const summary = await startCommandRun("NisenPrints registered workflow billing-only proof gate full publish");
    execSql(`UPDATE approvals SET status='approved', decided_at=${sqlValue(new Date().toISOString())} WHERE run_id=${sqlValue(summary.runId)}`);
    await resumeRunAfterApproval(summary.runId);
    const run = await waitForRunStatus(summary.runId, "blocked", 12000);
    const step = querySql<{ id: string; status: string; metadata_json: string }>(`SELECT id, status, metadata_json FROM run_steps WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const lane = querySql<{ status: string; health: string; progress: number }>(`SELECT status, health, progress FROM lanes WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const runMetadata = JSON.parse(run.metadata_json);
    const stepMetadata = JSON.parse(step.metadata_json);
    const startedEventMetadata = latestStartedWorkerEventMetadata(summary.runId);
    const eventMetadata = latestTerminalWorkerEventMetadata(summary.runId);

    assert.equal(run.status, "blocked");
    assert.equal(runMetadata.worker_mode, "execute_nisenprints_registered");
    assert.equal(runMetadata.proof_gate.ok, false);
    assert.equal(step.status, "blocked");
    assert.equal(stepMetadata.nisenprints_status, "partial");
    assert.equal(stepMetadata.nisenprints_exit_status, 7);
    assert.ok(stepMetadata.proof_gate.missing.includes("nisenprints_runner_exit_0"));
    assertBillingOnlyRunnerSafety(startedEventMetadata);
    assertBillingOnlyRunnerSafety(stepMetadata);
    assertBillingOnlyRunnerSafety(eventMetadata);
    assertBillingOnlyRunnerSafety(runMetadata);
    assert.equal(lane.status, "blocked");
    assert.equal(lane.health, "partial");
    assert.equal(lane.progress, 50);
  } finally {
    restoreRunner();
  }
});

for (const scenario of [
  {
    name: "Job Submit",
    command: "Job Application Daily Submit Queue registered workflow billing-only submit",
    workerMode: "execute_registered_codex_automation"
  },
  {
    name: "Job Followup",
    command: "Job Application Post-Application Manager registered workflow billing-only send follow-up",
    workerMode: "execute_registered_codex_automation"
  }
] as const) {
  test(`${scenario.name} registered workflow records billing-only runner safety metadata`, async () =>
    withCodexExecutionEnv(async () => {
      initDb();
      resetDemoData();
      process.env.FAKE_CODEX_EXIT_STATUS = "7";
      process.env.FAKE_CODEX_REGISTERED_SUMMARY = JSON.stringify({
        status: "blocked",
        workflow_id: scenario.name === "Job Submit" ? "job_submit_registered" : "job_followup_registered",
        run_id: "fake-job-runner-safety",
        completion_claimed: false,
        exact_blocker: "fake_registered_codex_blocked_before_external_action",
        source_of_truth_proofs: [],
        cleanup_proof: null
      });

      const summary = await startCommandRun(scenario.command);
      execSql(`UPDATE approvals SET status='approved', decided_at=${sqlValue(new Date().toISOString())} WHERE run_id=${sqlValue(summary.runId)}`);
      await resumeRunAfterApproval(summary.runId);

      const run = await waitForRunStatus(summary.runId, "blocked", 12000);
      const step = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM run_steps WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
      const runMetadata = JSON.parse(run.metadata_json);
      const stepMetadata = JSON.parse(step.metadata_json);
      const startedEventMetadata = latestStartedWorkerEventMetadata(summary.runId);
      const eventMetadata = latestTerminalWorkerEventMetadata(summary.runId);

      assert.equal(run.status, "blocked");
      assert.equal(step.status, "blocked");
      assert.equal(runMetadata.worker_mode, scenario.workerMode);
      assert.equal(stepMetadata.registered_codex_exit_status, 7);
      assert.equal(runMetadata.proof_gate.missing.length, 1);
      assert.match(runMetadata.proof_gate.missing[0], /job_(submit|followup)_registered_codex_execution/);
      assertBillingOnlyRunnerSafety(startedEventMetadata);
      assertBillingOnlyRunnerSafety(stepMetadata);
      assertBillingOnlyRunnerSafety(eventMetadata);
      assertBillingOnlyRunnerSafety(runMetadata);

      await runWorkerOnce(summary.runId);
      const rerun = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(summary.runId)} LIMIT 1`)[0];
      const rerunMetadata = JSON.parse(rerun.metadata_json);
      assert.equal(rerun.status, "blocked");
      assert.equal(rerunMetadata.worker_mode, "execute_registered_codex_automation");
      assert.equal(rerunMetadata.proof_gate.ok, runMetadata.proof_gate.ok);
      assert.deepEqual(rerunMetadata.proof_gate.missing, runMetadata.proof_gate.missing);
      assert.deepEqual(rerunMetadata.proof_gate.present, runMetadata.proof_gate.present);
      assertBillingOnlyRunnerSafety(rerunMetadata);
    }));
}

test("keeps contract-gated Codex read-only runs partial until required contract proofs exist", async () =>
  withChildCodexExecutionEnv(async () => {
    initDb();
    resetDemoData();

    const summary = await startCommandRun("NisenPrints Etsy Sync current listings 正本同期 Codexでレビュー");
    execSql(`UPDATE approvals SET status='approved', decided_at=${sqlValue(new Date().toISOString())} WHERE run_id=${sqlValue(summary.runId)}`);
    await resumeRunAfterApproval(summary.runId);
    const run = await waitForRunStatus(summary.runId, "partial");
    const step = querySql<{ id: string }>(`SELECT id FROM run_steps WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
    const proofs = querySql<{ proof_type: string }>(`SELECT proof_type FROM proofs WHERE run_id=${sqlValue(summary.runId)} ORDER BY proof_type ASC`);
    const runMetadata = JSON.parse(run.metadata_json);

    assert.equal(run.status, "partial");
    assert.equal(runMetadata.worker_mode, "execute_child_codex");
    assert.equal(runMetadata.proof_gate.ok, false);
    assert.deepEqual(runMetadata.proof_gate.present, ["child_codex_result", `child_codex_result:${step.id}`]);
    assert.deepEqual(runMetadata.proof_gate.missing, [
      "etsy_current_listings_snapshot",
      "local_queue_synced",
      "stale_rows_pruned"
    ]);
    assert.match(runMetadata.proof_summary, /missing etsy_current_listings_snapshot/);
    assert.deepEqual(proofs.map((proof) => proof.proof_type), ["child_codex_result"]);
  }));

test("keeps contract-complete mixed child Codex and receipt-only runs proof-gated partial", async () =>
  withChildCodexExecutionEnv(async () => {
    initDb();
    resetDemoData();

    const summary = await startCommandRun("NisenPrints Etsy Sync current listings 正本同期 Codexでレビュー, ローカル作業");
    const proofTypes = ["etsy_current_listings_snapshot", "local_queue_synced", "stale_rows_pruned"];
    proofTypes.forEach((proofType, index) => {
      db.insert("proofs", {
        id: `proof_contract_present_${index}`,
        run_id: summary.runId,
        step_id: null,
        proof_type: proofType,
        label: proofType,
        uri: `receipt://${proofType}`,
        size_bytes: 1,
        created_at: new Date(Date.UTC(2026, 5, 12, 0, 0, index)).toISOString(),
        metadata_json: {}
      });
    });
    execSql(`UPDATE approvals SET status='approved', decided_at=${sqlValue(new Date().toISOString())} WHERE run_id=${sqlValue(summary.runId)}`);
    await resumeRunAfterApproval(summary.runId);

    const run = await waitForRunStatus(summary.runId, "partial");
    const steps = querySql<{ id: string; metadata_json: string }>(`SELECT id, metadata_json FROM run_steps WHERE run_id=${sqlValue(summary.runId)} ORDER BY id ASC`);
    const receiptStep = steps.find((step) => JSON.parse(step.metadata_json).execution_mode === "receipt_only");
    assert.ok(receiptStep);
    const runMetadata = JSON.parse(run.metadata_json);

    assert.equal(run.status, "partial");
    assert.equal(runMetadata.proof_gate.ok, false);
    assert.deepEqual(runMetadata.proof_gate.missing, [`actual_execution_or_manual_verification:${receiptStep.id}`]);
    assert.ok(runMetadata.proof_gate.present.includes("etsy_current_listings_snapshot"));
    assert.ok(runMetadata.proof_gate.present.includes("child_codex_result"));
    assert.ok(runMetadata.proof_gate.present.includes("worker_receipt"));
    assert.equal(
      runMetadata.proof_summary,
      `partial: missing actual_execution_or_manual_verification:${receiptStep.id}`
    );
  }));

test("combines contract missing and receipt-only missing for mixed child Codex runs", async () =>
  withChildCodexExecutionEnv(async () => {
    initDb();
    resetDemoData();

    const summary = await startCommandRun("NisenPrints Etsy Sync current listings 正本同期 Codexでレビュー, ローカル作業");
    execSql(`UPDATE approvals SET status='approved', decided_at=${sqlValue(new Date().toISOString())} WHERE run_id=${sqlValue(summary.runId)}`);
    await resumeRunAfterApproval(summary.runId);

    const run = await waitForRunStatus(summary.runId, "partial");
    const steps = querySql<{ id: string; metadata_json: string }>(`SELECT id, metadata_json FROM run_steps WHERE run_id=${sqlValue(summary.runId)} ORDER BY id ASC`);
    const receiptStep = steps.find((step) => JSON.parse(step.metadata_json).execution_mode === "receipt_only");
    assert.ok(receiptStep);
    const runMetadata = JSON.parse(run.metadata_json);

    assert.equal(run.status, "partial");
    assert.equal(runMetadata.proof_gate.ok, false);
    assert.deepEqual(runMetadata.proof_gate.missing, [
      "etsy_current_listings_snapshot",
      "local_queue_synced",
      "stale_rows_pruned",
      `actual_execution_or_manual_verification:${receiptStep.id}`
    ]);
    assert.ok(runMetadata.proof_gate.present.includes("child_codex_result"));
    assert.ok(runMetadata.proof_gate.present.includes("worker_receipt"));
  }));

test("keeps completed child_codex execution_mode steps partial when child result proof is missing", async () => {
  initDb();
  resetDemoData();

  const runId = "run_missing_child_codex_proof";
  const stepId = `${runId}_step_1`;
  const now = new Date().toISOString();
  db.insert("runs", {
    id: runId,
    name: "inconsistent child_codex",
    status: "queued",
    objective: "CodexでworkerEngineを確認",
    created_at: now,
    updated_at: now,
    metadata_json: { command: "CodexでworkerEngineを確認" }
  });
  db.insert("run_steps", {
    id: stepId,
    run_id: runId,
    name: "CodexでworkerEngineを確認",
    status: "completed",
    lane_id: null,
    started_at: now,
    completed_at: now,
    metadata_json: {
      execution_mode: "child_codex"
    }
  });

  await worker.runWorkerOnce(runId);
  const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  const runMetadata = JSON.parse(run.metadata_json);

  assert.equal(run.status, "partial");
  assert.equal(runMetadata.worker_mode, "execute_child_codex");
  assert.equal(runMetadata.proof_gate.ok, false);
  assert.deepEqual(runMetadata.proof_gate.missing, [`child_codex_result:${stepId}`]);
});

test("reconciles stale running child_codex with null pid into blocked proof", async () => {
  initDb();
  resetDemoData();

  const runId = "run_stale_child_codex_null_pid";
  const stepId = `${runId}_step_1`;
  const childRunId = `${runId}_child_1`;
  const laneId = `${runId}_lane_1`;
  const old = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  db.insert("runs", {
    id: runId,
    name: "stale child_codex null pid",
    status: "running",
    objective: "CodexでworkerEngineを確認",
    created_at: old,
    updated_at: old,
    metadata_json: { command: "CodexでworkerEngineを確認" }
  });
  db.insert("lanes", {
    id: laneId,
    run_id: runId,
    role: "local_worker",
    cdp_port: 9333,
    profile_dir: "/tmp/profile",
    workdir: "/tmp/workdir",
    status: "active",
    current_task: "CodexでworkerEngineを確認",
    progress: 50,
    health: "good",
    resource_locks_json: [],
    updated_at: old
  });
  db.insert("run_steps", {
    id: stepId,
    run_id: runId,
    name: "CodexでworkerEngineを確認",
    status: "running",
    lane_id: laneId,
    started_at: old,
    completed_at: null,
    metadata_json: { adapter: "child_codex", execution_mode: "child_codex", child_run_id: childRunId }
  });
  db.insert("child_runs", {
    id: childRunId,
    parent_run_id: runId,
    step_id: stepId,
    role: "child_codex",
    prompt_uri: "file:///tmp/stale-child-prompt.txt",
    status: "running",
    pid: null,
    exit_status: null,
    signal: null,
    result_uri: null,
    summary: "child_codex read-only execution started",
    blocker: null,
    created_at: old,
    started_at: old,
    completed_at: null,
    metadata_json: { adapter: "child_codex", execution_mode: "child_codex", prompt_uri: "file:///tmp/stale-child-prompt.txt" }
  });

  await worker.runWorkerOnce(runId);

  const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  const step = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM run_steps WHERE id=${sqlValue(stepId)} LIMIT 1`)[0];
  const lane = querySql<{ status: string; progress: number; health: string }>(`SELECT status, progress, health FROM lanes WHERE id=${sqlValue(laneId)} LIMIT 1`)[0];
  const child = querySql<{ status: string; pid: number | null; result_uri: string; blocker: string | null; metadata_json: string }>(
    `SELECT status, pid, result_uri, blocker, metadata_json FROM child_runs WHERE id=${sqlValue(childRunId)} LIMIT 1`
  )[0];
  const proof = querySql<{ proof_type: string; uri: string; metadata_json: string }>(`SELECT proof_type, uri, metadata_json FROM proofs WHERE run_id=${sqlValue(runId)} LIMIT 1`)[0];
  const event = querySql<{ metadata_json: string }>(
    `SELECT metadata_json FROM worker_events WHERE run_id=${sqlValue(runId)} AND event_type='worker_blocked' ORDER BY created_at DESC LIMIT 1`
  )[0];
  const runMetadata = JSON.parse(run.metadata_json);
  const stepMetadata = JSON.parse(step.metadata_json);
  const proofMetadata = JSON.parse(proof.metadata_json);
  const childMetadata = JSON.parse(child.metadata_json);
  const eventMetadata = JSON.parse(event.metadata_json);
  const resultJson = JSON.parse(readFileSync(new URL(child.result_uri), "utf8"));

  assert.equal(run.status, "blocked");
  assert.equal(runMetadata.worker_mode, "execute_child_codex");
  assert.equal(runMetadata.proof_gate.ok, false);
  assert.deepEqual(runMetadata.proof_gate.present, ["child_codex_blocked", `child_codex_blocked:${stepId}`]);
  assert.deepEqual(runMetadata.proof_gate.missing, [`child_codex_result:${stepId}`]);
  assert.equal(step.status, "blocked");
  assert.equal(stepMetadata.child_codex_blocker, "async_child_codex_parent_exited_before_pid_or_result_proof");
  assert.equal(stepMetadata.child_codex_pid_alive_before_termination, null);
  assert.equal(stepMetadata.child_codex_pid_alive_after_termination, null);
  assert.deepEqual(lane, { status: "blocked", progress: 50, health: "blocked" });
  assert.equal(child.status, "blocked");
  assert.equal(child.pid, null);
  assert.equal(child.blocker, "async_child_codex_parent_exited_before_pid_or_result_proof");
  assert.match(child.result_uri, /-stale-child-result\.json$/);
  assert.equal(childMetadata.pid_alive_before_termination, null);
  assert.equal(childMetadata.pid_alive_after_termination, null);
  assert.equal(childMetadata.termination_attempted, false);
  assert.equal(proof.proof_type, "child_codex_blocked");
  assert.equal(proof.uri, child.result_uri);
  assert.equal(proofMetadata.blocker, "async_child_codex_parent_exited_before_pid_or_result_proof");
  assert.equal(proofMetadata.pid_alive_before_termination, null);
  assert.equal(proofMetadata.pid_alive_after_termination, null);
  assert.equal(proofMetadata.termination_attempted, false);
  assert.equal(resultJson.blocker, "async_child_codex_parent_exited_before_pid_or_result_proof");
  assert.equal(resultJson.pid_alive_before_termination, null);
  assert.equal(resultJson.pid_alive_after_termination, null);
  assert.equal(resultJson.terminationAttempted, false);
  assert.equal(eventMetadata.pid_alive_before_termination, null);
  assert.equal(eventMetadata.pid_alive_after_termination, null);
  assert.equal(resultJson.mode, "child_codex");
  assert.equal(resultJson.childRunId, childRunId);
});

test("reconciles stale running Daily AI registered step from existing summary artifact", async () => {
  initDb();
  resetDemoData();

  const runId = "run_stale_daily_ai_registered_summary";
  const stepId = `${runId}_step_1`;
  const laneId = `${runId}_lane_1`;
  const old = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const outputRoot = join(tempRoot, "daily-ai-stale-summary-runs");
  const outputDir = join(outputRoot, runId);
  const previousIgnoreDailyAiProcess = process.env.AUTOMATION_OS_TEST_IGNORE_DAILY_AI_PROCESS;
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(
    join(outputDir, "registered-playwright-cli-summary.json"),
    JSON.stringify(
      {
        automation_os_run_id: runId,
        run_id: runId,
        mode: "registered_daily_ai_playwright_cli",
	        current_stage: "core_flow",
	        stage_status: "running",
	        stop_reason: "",
	        issue_ledger: [
	          {
	            stage: "single_flight_lock",
	            blocker_reason: "daily_ai_runner_already_active:123",
	            policy: {
	              next_safe_action: "wait_for_active_runner_or_clear_stale_lock",
	              repost_allowed: false
	            }
	          }
	        ],
	        full_flow_completion: null,
	        cleanup_proof: null
      },
      null,
      2
    )
  );
  const previousOutputRoot = process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT;
  process.env.AUTOMATION_OS_TEST_IGNORE_DAILY_AI_PROCESS = "1";
  process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT = outputRoot;
  try {
    db.insert("runs", {
      id: runId,
      name: "stale Daily AI registered workflow",
      status: "queued",
      objective: "Daily AI registered workflow run full flow",
      created_at: old,
      updated_at: old,
      metadata_json: { command: "Daily AI registered workflow run full flow" }
    });
    db.insert("lanes", {
      id: laneId,
      run_id: runId,
      role: "Daily AI Runner",
      cdp_port: 9333,
      profile_dir: "/Users/nichikatanaka/.daily-ai-playwright-chrome",
      workdir: "/tmp/workdir",
      status: "active",
      current_task: "Daily AI registered workflow run full flow",
      progress: 50,
      health: "good",
      resource_locks_json: ["social_publish"],
      updated_at: old
    });
    db.insert("run_steps", {
      id: stepId,
      run_id: runId,
      name: "Daily AI registered workflow run full flow",
      status: "running",
      lane_id: laneId,
      started_at: old,
      completed_at: null,
      metadata_json: { adapter: "daily_ai_registered" }
    });
    db.insert("worker_events", {
      id: `${runId}_worker_started`,
      run_id: runId,
      step_id: stepId,
      lane_id: laneId,
      event_type: "worker_started",
      message: "node run_daily_ai_playwright_cli.mjs",
      created_at: old,
      metadata_json: { adapter: "daily_ai_registered" }
    });

    await worker.runWorkerOnce(runId);

    const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
    const step = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM run_steps WHERE id=${sqlValue(stepId)} LIMIT 1`)[0];
    const lane = querySql<{ status: string; health: string; progress: number }>(`SELECT status, health, progress FROM lanes WHERE id=${sqlValue(laneId)} LIMIT 1`)[0];
    const events = querySql<{ event_type: string; metadata_json: string }>(
      `SELECT event_type, metadata_json FROM worker_events WHERE run_id=${sqlValue(runId)} ORDER BY created_at ASC`
    );
    const proofs = querySql<{ proof_type: string }>(`SELECT proof_type FROM proofs WHERE run_id=${sqlValue(runId)} ORDER BY proof_type`);
    const runMetadata = JSON.parse(run.metadata_json);
    const stepMetadata = JSON.parse(step.metadata_json);
    const terminalEventMetadata = JSON.parse(events.at(-1)?.metadata_json ?? "{}");

    assert.equal(run.status, "blocked");
    assert.equal(step.status, "blocked");
    assert.equal(lane.status, "blocked");
    assert.equal(lane.health, "blocked");
    assert.equal(lane.progress, 50);
    assert.equal(stepMetadata.reconciled_from_stale_registered_summary, true);
    assert.equal(stepMetadata.daily_ai_status, "blocked");
    assert.ok(stepMetadata.proof_gate.missing.includes("full_flow_completion"));
	    assert.equal(runMetadata.worker_mode, "execute_daily_ai_registered");
	    assert.ok(runMetadata.proof_gate.missing.includes("full_flow_completion"));
	    assert.equal(runMetadata.issue_ledger_summary.latest_blocker, "daily_ai_runner_already_active:123");
	    assert.equal(terminalEventMetadata.reconciled_from_stale_registered_summary, true);
	    assert.equal(terminalEventMetadata.issue_ledger_summary.latest_blocker, "daily_ai_runner_already_active:123");
	    assert.ok(proofs.some((proof) => proof.proof_type === "daily_ai_registered_summary"));
  } finally {
    if (previousOutputRoot === undefined) {
      delete process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT;
    } else {
      process.env.AUTOMATION_OS_DAILY_AI_OUTPUT_ROOT = previousOutputRoot;
    }
    if (previousIgnoreDailyAiProcess === undefined) {
      delete process.env.AUTOMATION_OS_TEST_IGNORE_DAILY_AI_PROCESS;
    } else {
      process.env.AUTOMATION_OS_TEST_IGNORE_DAILY_AI_PROCESS = previousIgnoreDailyAiProcess;
    }
  }
});

test("reconciles stale running Job Submit registered Codex step without rerunning Codex", async () => {
  initDb();
  resetDemoData();

  const runId = "run_stale_job_submit_registered_codex";
  const stepId = `${runId}_step_1`;
  const laneId = `${runId}_lane_1`;
  const old = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  db.insert("runs", {
    id: runId,
    name: "stale Job Submit registered workflow",
    status: "queued",
    objective: "Job Application Daily Submit Queue registered workflow billing-only submit",
    created_at: old,
    updated_at: old,
    metadata_json: { command: "Job Application Daily Submit Queue registered workflow billing-only submit" }
  });
  db.insert("lanes", {
    id: laneId,
    run_id: runId,
    role: "Job Submit",
    cdp_port: 9333,
    profile_dir: "/tmp/job-submit-profile",
    workdir: "/tmp/job-submit-workdir",
    status: "active",
    current_task: "Job Application Daily Submit Queue registered workflow billing-only submit",
    progress: 50,
    health: "good",
    resource_locks_json: ["local_worker"],
    updated_at: old
  });
  db.insert("run_steps", {
    id: stepId,
    run_id: runId,
    name: "Job Application Daily Submit Queue registered workflow billing-only submit",
    status: "running",
    lane_id: laneId,
    started_at: old,
    completed_at: null,
    metadata_json: { adapter: "job_submit_registered" }
  });
  db.insert("worker_events", {
    id: `${runId}_worker_started`,
    run_id: runId,
    step_id: stepId,
    lane_id: laneId,
    event_type: "worker_started",
    message: "codex exec --sandbox workspace-write",
    created_at: old,
    metadata_json: { adapter: "job_submit_registered" }
  });

  await worker.runWorkerOnce(runId);

  const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  const step = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM run_steps WHERE id=${sqlValue(stepId)} LIMIT 1`)[0];
  const lane = querySql<{ status: string; health: string; progress: number }>(`SELECT status, health, progress FROM lanes WHERE id=${sqlValue(laneId)} LIMIT 1`)[0];
  const proof = querySql<{ proof_type: string; uri: string; metadata_json: string }>(`SELECT proof_type, uri, metadata_json FROM proofs WHERE run_id=${sqlValue(runId)} LIMIT 1`)[0];
  const event = querySql<{ metadata_json: string }>(
    `SELECT metadata_json FROM worker_events WHERE run_id=${sqlValue(runId)} AND event_type='worker_blocked' ORDER BY created_at DESC LIMIT 1`
  )[0];
  const runMetadata = JSON.parse(run.metadata_json);
  const stepMetadata = JSON.parse(step.metadata_json);
  const proofMetadata = JSON.parse(proof.metadata_json);
  const eventMetadata = JSON.parse(event.metadata_json);
  const artifact = JSON.parse(readFileSync(new URL(proof.uri), "utf8"));

  assert.equal(run.status, "blocked");
  assert.equal(step.status, "blocked");
  assert.equal(lane.status, "blocked");
  assert.equal(lane.health, "blocked");
  assert.equal(lane.progress, 50);
  assert.equal(proof.proof_type, "job_submit_registered_codex_execution_blocked");
  assert.equal(stepMetadata.reconciled_from_stale_registered_codex, true);
  assert.equal(stepMetadata.registered_codex_status, "blocked");
  assert.equal(stepMetadata.proof_gate.missing[0], "job_submit_registered_codex_execution");
  assert.equal(runMetadata.worker_mode, "execute_registered_codex_automation");
  assert.equal(runMetadata.proof_gate.missing[0], "job_submit_registered_codex_execution");
  assert.equal(proofMetadata.codex_cli_rerun_suppressed, true);
  assert.equal(eventMetadata.codex_cli_rerun_suppressed, true);
  assert.equal(artifact.parent_only, true);
  assert.equal(artifact.blocker, "registered_codex_parent_exited_before_result_proof");
});

test("does not block completed child_codex step or lane when a stale orphan child_run is blocked", async () => {
  initDb();
  resetDemoData();

  const runId = "run_stale_orphan_child_codex_completed_step";
  const stepId = `${runId}_step_1`;
  const completedChildRunId = `${runId}_child_completed`;
  const staleChildRunId = `${runId}_child_stale`;
  const laneId = `${runId}_lane_1`;
  const resultPath = join(tempRoot, "stale-orphan-completed-child-result.json");
  const resultUri = pathToFileURL(resultPath).href;
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  writeFileSync(
    resultPath,
    JSON.stringify({
      runId,
      stepId,
      childRunId: completedChildRunId,
      mode: "child_codex",
      exitStatus: 0
    })
  );
  db.insert("runs", {
    id: runId,
    name: "stale orphan child_codex completed step",
    status: "running",
    objective: "CodexでworkerEngineを確認",
    created_at: old,
    updated_at: now,
    metadata_json: { command: "CodexでworkerEngineを確認" }
  });
  db.insert("lanes", {
    id: laneId,
    run_id: runId,
    role: "local_worker",
    cdp_port: 9333,
    profile_dir: "/tmp/profile",
    workdir: "/tmp/workdir",
    status: "idle",
    current_task: "CodexでworkerEngineを確認",
    progress: 100,
    health: "good",
    resource_locks_json: [],
    updated_at: now
  });
  db.insert("run_steps", {
    id: stepId,
    run_id: runId,
    name: "CodexでworkerEngineを確認",
    status: "completed",
    lane_id: laneId,
    started_at: old,
    completed_at: now,
    metadata_json: {
      adapter: "child_codex",
      execution_mode: "child_codex",
      child_run_id: completedChildRunId,
      child_codex_result_artifact: resultUri
    }
  });
  db.insert("child_runs", {
    id: completedChildRunId,
    parent_run_id: runId,
    step_id: stepId,
    role: "child_codex",
    prompt_uri: "file:///tmp/completed-child-prompt.txt",
    status: "completed",
    pid: 123,
    exit_status: 0,
    signal: null,
    result_uri: resultUri,
    summary: "child Codex read-only execution completed",
    blocker: null,
    created_at: old,
    started_at: old,
    completed_at: now,
    metadata_json: { adapter: "child_codex", execution_mode: "child_codex", prompt_uri: "file:///tmp/completed-child-prompt.txt" }
  });
  db.insert("child_runs", {
    id: staleChildRunId,
    parent_run_id: runId,
    step_id: stepId,
    role: "child_codex",
    prompt_uri: "file:///tmp/stale-orphan-child-prompt.txt",
    status: "running",
    pid: null,
    exit_status: null,
    signal: null,
    result_uri: null,
    summary: "orphan child Codex execution started",
    blocker: null,
    created_at: old,
    started_at: old,
    completed_at: null,
    metadata_json: { adapter: "child_codex", execution_mode: "child_codex", prompt_uri: "file:///tmp/stale-orphan-child-prompt.txt" }
  });
  db.insert("proofs", {
    id: `${runId}_proof_result`,
    run_id: runId,
    step_id: stepId,
    proof_type: "child_codex_result",
    label: "child_codex result",
    uri: resultUri,
    size_bytes: 1,
    created_at: now,
    metadata_json: { child_run_id: completedChildRunId, exit_status: 0 }
  });

  await worker.runWorkerOnce(runId);

  const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  const step = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM run_steps WHERE id=${sqlValue(stepId)} LIMIT 1`)[0];
  const lane = querySql<{ status: string; progress: number; health: string }>(`SELECT status, progress, health FROM lanes WHERE id=${sqlValue(laneId)} LIMIT 1`)[0];
  const staleChild = querySql<{ status: string; result_uri: string; blocker: string | null }>(
    `SELECT status, result_uri, blocker FROM child_runs WHERE id=${sqlValue(staleChildRunId)} LIMIT 1`
  )[0];
  const proofs = querySql<{ proof_type: string; metadata_json: string }>(`SELECT proof_type, metadata_json FROM proofs WHERE run_id=${sqlValue(runId)} ORDER BY created_at ASC`);
  const runMetadata = JSON.parse(run.metadata_json);
  const stepMetadata = JSON.parse(step.metadata_json);
  const blockedProofMetadata = JSON.parse(proofs[1].metadata_json);

  assert.equal(run.status, "complete");
  assert.equal(runMetadata.proof_gate.ok, true);
  assert.deepEqual(runMetadata.proof_gate.missing, []);
  assert.equal(step.status, "completed");
  assert.equal(stepMetadata.child_run_id, completedChildRunId);
  assert.equal(stepMetadata.child_codex_result_artifact, resultUri);
  assert.equal(stepMetadata.child_codex_blocker, undefined);
  assert.deepEqual(lane, { status: "idle", progress: 100, health: "good" });
  assert.equal(staleChild.status, "blocked");
  assert.match(staleChild.result_uri, /-stale-child-result\.json$/);
  assert.equal(staleChild.blocker, "async_child_codex_parent_exited_before_pid_or_result_proof");
  assert.deepEqual(proofs.map((proof) => proof.proof_type), ["child_codex_result", "child_codex_blocked"]);
  assert.equal(blockedProofMetadata.child_run_id, staleChildRunId);
});

test("reconciles stale running child_codex with pid into timed-out blocked proof", async () => {
  initDb();
  resetDemoData();

  const runId = "run_stale_child_codex_with_pid";
  const stepId = `${runId}_step_1`;
  const childRunId = `${runId}_child_1`;
  const old = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  db.insert("runs", {
    id: runId,
    name: "stale child_codex with pid",
    status: "running",
    objective: "CodexでworkerEngineを確認",
    created_at: old,
    updated_at: old,
    metadata_json: { command: "CodexでworkerEngineを確認" }
  });
  db.insert("run_steps", {
    id: stepId,
    run_id: runId,
    name: "CodexでworkerEngineを確認",
    status: "running",
    lane_id: null,
    started_at: old,
    completed_at: null,
    metadata_json: { adapter: "child_codex", execution_mode: "child_codex", child_run_id: childRunId }
  });
  db.insert("child_runs", {
    id: childRunId,
    parent_run_id: runId,
    step_id: stepId,
    role: "child_codex",
    prompt_uri: "file:///tmp/stale-child-prompt.txt",
    status: "running",
    pid: 4242,
    exit_status: null,
    signal: null,
    result_uri: null,
    summary: "child_codex read-only execution started",
    blocker: null,
    created_at: old,
    started_at: old,
    completed_at: null,
    metadata_json: { adapter: "child_codex", execution_mode: "child_codex", prompt_uri: "file:///tmp/stale-child-prompt.txt" }
  });

  await worker.runWorkerOnce(runId);

  const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  const child = querySql<{ status: string; pid: number | null; result_uri: string; blocker: string | null; metadata_json: string }>(
    `SELECT status, pid, result_uri, blocker, metadata_json FROM child_runs WHERE id=${sqlValue(childRunId)} LIMIT 1`
  )[0];
  const step = querySql<{ metadata_json: string }>(`SELECT metadata_json FROM run_steps WHERE id=${sqlValue(stepId)} LIMIT 1`)[0];
  const proof = querySql<{ proof_type: string; metadata_json: string }>(`SELECT proof_type, metadata_json FROM proofs WHERE run_id=${sqlValue(runId)} LIMIT 1`)[0];
  const event = querySql<{ metadata_json: string }>(
    `SELECT metadata_json FROM worker_events WHERE run_id=${sqlValue(runId)} AND event_type='worker_blocked' ORDER BY created_at DESC LIMIT 1`
  )[0];
  const resultJson = JSON.parse(readFileSync(new URL(child.result_uri), "utf8"));
  const runMetadata = JSON.parse(run.metadata_json);
  const stepMetadata = JSON.parse(step.metadata_json);
  const proofMetadata = JSON.parse(proof.metadata_json);
  const childMetadata = JSON.parse(child.metadata_json);
  const eventMetadata = JSON.parse(event.metadata_json);

  assert.equal(run.status, "blocked");
  assert.deepEqual(runMetadata.proof_gate.present, ["child_codex_blocked", `child_codex_blocked:${stepId}`]);
  assert.deepEqual(runMetadata.proof_gate.missing, [`child_codex_result:${stepId}`]);
  assert.equal(child.status, "blocked");
  assert.equal(child.pid, 4242);
  assert.equal(child.blocker, "async_child_codex_timed_out_without_result_proof");
  assert.match(child.result_uri, /-stale-child-result\.json$/);
  assert.equal(stepMetadata.child_codex_pid_alive_before_termination, false);
  assert.equal(stepMetadata.child_codex_pid_alive_after_termination, false);
  assert.equal(childMetadata.pid_alive_before_termination, false);
  assert.equal(childMetadata.pid_alive_after_termination, false);
  assert.equal(childMetadata.termination_attempted, false);
  assert.equal(proof.proof_type, "child_codex_blocked");
  assert.equal(proofMetadata.blocker, "async_child_codex_timed_out_without_result_proof");
  assert.equal(proofMetadata.pid_alive_before_termination, false);
  assert.equal(proofMetadata.pid_alive_after_termination, false);
  assert.equal(proofMetadata.termination_attempted, false);
  assert.equal(resultJson.blocker, "async_child_codex_timed_out_without_result_proof");
  assert.equal(resultJson.pid_alive_before_termination, false);
  assert.equal(resultJson.pid_alive_after_termination, false);
  assert.equal(resultJson.terminationAttempted, false);
  assert.equal(eventMetadata.pid_alive_before_termination, false);
  assert.equal(eventMetadata.pid_alive_after_termination, false);
});

test("reconciles stale running child_codex from an existing valid result proof", async () => {
  initDb();
  resetDemoData();

  const runId = "run_stale_child_codex_existing_result";
  const stepId = `${runId}_step_1`;
  const childRunId = `${runId}_child_1`;
  const resultPath = join(tempRoot, "stale-existing-child-result.json");
  const resultUri = pathToFileURL(resultPath).href;
  const old = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  writeFileSync(
    resultPath,
    JSON.stringify({
      runId,
      stepId,
      childRunId,
      mode: "child_codex",
      exitStatus: 0
    })
  );
  db.insert("runs", {
    id: runId,
    name: "stale child_codex existing result",
    status: "running",
    objective: "CodexでworkerEngineを確認",
    created_at: old,
    updated_at: old,
    metadata_json: { command: "CodexでworkerEngineを確認" }
  });
  db.insert("run_steps", {
    id: stepId,
    run_id: runId,
    name: "CodexでworkerEngineを確認",
    status: "running",
    lane_id: null,
    started_at: old,
    completed_at: null,
    metadata_json: { adapter: "child_codex", execution_mode: "child_codex", child_run_id: childRunId }
  });
  db.insert("child_runs", {
    id: childRunId,
    parent_run_id: runId,
    step_id: stepId,
    role: "child_codex",
    prompt_uri: "file:///tmp/stale-child-prompt.txt",
    status: "running",
    pid: null,
    exit_status: null,
    signal: null,
    result_uri: null,
    summary: "child_codex read-only execution started",
    blocker: null,
    created_at: old,
    started_at: old,
    completed_at: null,
    metadata_json: { adapter: "child_codex", execution_mode: "child_codex", prompt_uri: "file:///tmp/stale-child-prompt.txt" }
  });
  db.insert("proofs", {
    id: `${runId}_proof_1`,
    run_id: runId,
    step_id: stepId,
    proof_type: "child_codex_result",
    label: "child_codex result",
    uri: resultUri,
    size_bytes: 1,
    created_at: old,
    metadata_json: { child_run_id: childRunId, exit_status: 0 }
  });

  await worker.runWorkerOnce(runId);

  const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  const step = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM run_steps WHERE id=${sqlValue(stepId)} LIMIT 1`)[0];
  const child = querySql<{ status: string; exit_status: number | null; result_uri: string; metadata_json: string }>(
    `SELECT status, exit_status, result_uri, metadata_json FROM child_runs WHERE id=${sqlValue(childRunId)} LIMIT 1`
  )[0];
  const proofs = querySql<{ proof_type: string }>(`SELECT proof_type FROM proofs WHERE run_id=${sqlValue(runId)} ORDER BY created_at ASC`);
  const runMetadata = JSON.parse(run.metadata_json);
  const stepMetadata = JSON.parse(step.metadata_json);
  const childMetadata = JSON.parse(child.metadata_json);

  assert.equal(run.status, "complete");
  assert.equal(runMetadata.proof_gate.ok, true);
  assert.deepEqual(runMetadata.proof_gate.missing, []);
  assert.equal(step.status, "completed");
  assert.equal(stepMetadata.reconciled_from_existing_proof, true);
  assert.equal(child.status, "completed");
  assert.equal(child.exit_status, 0);
  assert.equal(child.result_uri, resultUri);
  assert.equal(childMetadata.reconciled_from_existing_proof, true);
  assert.deepEqual(proofs.map((proof) => proof.proof_type), ["child_codex_result"]);
});

test("reconciles stale running child_codex from valid result proof before newer blocked proof", async () => {
  initDb();
  resetDemoData();

  const runId = "run_stale_child_codex_prefers_valid_result";
  const stepId = `${runId}_step_1`;
  const childRunId = `${runId}_child_1`;
  const resultPath = join(tempRoot, "preferred-stale-child-result.json");
  const blockedPath = join(tempRoot, "newer-stale-child-blocked.json");
  const resultUri = pathToFileURL(resultPath).href;
  const blockedUri = pathToFileURL(blockedPath).href;
  const old = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const newer = new Date(Date.now() - 14 * 60 * 1000).toISOString();
  writeFileSync(resultPath, JSON.stringify({ runId, stepId, childRunId, mode: "child_codex", exitStatus: 0 }));
  writeFileSync(blockedPath, JSON.stringify({ blocker: "blocked proof exists" }));
  db.insert("runs", {
    id: runId,
    name: "stale child_codex prefers valid result",
    status: "running",
    objective: "CodexでworkerEngineを確認",
    created_at: old,
    updated_at: old,
    metadata_json: { command: "CodexでworkerEngineを確認" }
  });
  db.insert("run_steps", {
    id: stepId,
    run_id: runId,
    name: "CodexでworkerEngineを確認",
    status: "running",
    lane_id: null,
    started_at: old,
    completed_at: null,
    metadata_json: { adapter: "child_codex", execution_mode: "child_codex", child_run_id: childRunId }
  });
  db.insert("child_runs", {
    id: childRunId,
    parent_run_id: runId,
    step_id: stepId,
    role: "child_codex",
    prompt_uri: "file:///tmp/stale-child-prompt.txt",
    status: "running",
    pid: null,
    exit_status: null,
    signal: null,
    result_uri: null,
    summary: "child_codex read-only execution started",
    blocker: null,
    created_at: old,
    started_at: old,
    completed_at: null,
    metadata_json: { adapter: "child_codex", execution_mode: "child_codex", prompt_uri: "file:///tmp/stale-child-prompt.txt" }
  });
  db.insert("proofs", {
    id: `${runId}_proof_result`,
    run_id: runId,
    step_id: stepId,
    proof_type: "child_codex_result",
    label: "child_codex result",
    uri: resultUri,
    size_bytes: 1,
    created_at: old,
    metadata_json: { child_run_id: childRunId, exit_status: 0 }
  });
  db.insert("proofs", {
    id: `${runId}_proof_blocked`,
    run_id: runId,
    step_id: stepId,
    proof_type: "child_codex_blocked",
    label: "child_codex blocked",
    uri: blockedUri,
    size_bytes: 1,
    created_at: newer,
    metadata_json: { child_run_id: childRunId, blocker: "blocked proof exists" }
  });

  await worker.runWorkerOnce(runId);

  const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  const child = querySql<{ status: string; exit_status: number | null; result_uri: string; blocker: string | null }>(
    `SELECT status, exit_status, result_uri, blocker FROM child_runs WHERE id=${sqlValue(childRunId)} LIMIT 1`
  )[0];
  const runMetadata = JSON.parse(run.metadata_json);

  assert.equal(run.status, "complete");
  assert.equal(runMetadata.proof_gate.ok, true);
  assert.equal(child.status, "completed");
  assert.equal(child.exit_status, 0);
  assert.equal(child.result_uri, resultUri);
  assert.equal(child.blocker, null);
});

test("reconciles stale running child_codex from valid blocked proof when result proofs are invalid", async () => {
  initDb();
  resetDemoData();

  const runId = "run_stale_child_codex_uses_valid_blocked";
  const stepId = `${runId}_step_1`;
  const childRunId = `${runId}_child_1`;
  const badResultPath = join(tempRoot, "invalid-stale-child-result-before-blocked.json");
  const blockedPath = join(tempRoot, "valid-stale-child-blocked.json");
  const badResultUri = pathToFileURL(badResultPath).href;
  const blockedUri = pathToFileURL(blockedPath).href;
  const old = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const newer = new Date(Date.now() - 14 * 60 * 1000).toISOString();
  writeFileSync(badResultPath, JSON.stringify({ runId, stepId: `${stepId}_wrong`, childRunId, mode: "child_codex", exitStatus: 0 }));
  writeFileSync(blockedPath, JSON.stringify({ blocker: "existing blocked proof" }));
  db.insert("runs", {
    id: runId,
    name: "stale child_codex uses valid blocked",
    status: "running",
    objective: "CodexでworkerEngineを確認",
    created_at: old,
    updated_at: old,
    metadata_json: { command: "CodexでworkerEngineを確認" }
  });
  db.insert("run_steps", {
    id: stepId,
    run_id: runId,
    name: "CodexでworkerEngineを確認",
    status: "running",
    lane_id: null,
    started_at: old,
    completed_at: null,
    metadata_json: { adapter: "child_codex", execution_mode: "child_codex", child_run_id: childRunId }
  });
  db.insert("child_runs", {
    id: childRunId,
    parent_run_id: runId,
    step_id: stepId,
    role: "child_codex",
    prompt_uri: "file:///tmp/stale-child-prompt.txt",
    status: "running",
    pid: null,
    exit_status: null,
    signal: null,
    result_uri: null,
    summary: "child_codex read-only execution started",
    blocker: null,
    created_at: old,
    started_at: old,
    completed_at: null,
    metadata_json: { adapter: "child_codex", execution_mode: "child_codex", prompt_uri: "file:///tmp/stale-child-prompt.txt" }
  });
  db.insert("proofs", {
    id: `${runId}_proof_bad_result`,
    run_id: runId,
    step_id: stepId,
    proof_type: "child_codex_result",
    label: "child_codex result",
    uri: badResultUri,
    size_bytes: 1,
    created_at: newer,
    metadata_json: { child_run_id: childRunId, exit_status: 0 }
  });
  db.insert("proofs", {
    id: `${runId}_proof_blocked`,
    run_id: runId,
    step_id: stepId,
    proof_type: "child_codex_blocked",
    label: "child_codex blocked",
    uri: blockedUri,
    size_bytes: 1,
    created_at: old,
    metadata_json: { child_run_id: childRunId, blocker: "existing blocked proof" }
  });

  await worker.runWorkerOnce(runId);

  const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  const child = querySql<{ status: string; result_uri: string; blocker: string | null }>(
    `SELECT status, result_uri, blocker FROM child_runs WHERE id=${sqlValue(childRunId)} LIMIT 1`
  )[0];
  const proofs = querySql<{ proof_type: string; uri: string }>(`SELECT proof_type, uri FROM proofs WHERE run_id=${sqlValue(runId)} ORDER BY created_at ASC`);
  const runMetadata = JSON.parse(run.metadata_json);

  assert.equal(run.status, "blocked");
  assert.equal(runMetadata.proof_gate.ok, false);
  assert.ok(runMetadata.proof_gate.present.includes("child_codex_blocked"));
  assert.deepEqual(runMetadata.proof_gate.missing, [`child_codex_child_run_incomplete_or_mismatch:${stepId}`]);
  assert.equal(child.status, "blocked");
  assert.equal(child.result_uri, blockedUri);
  assert.equal(child.blocker, "existing blocked proof");
  assert.deepEqual(proofs.map((proof) => proof.proof_type), ["child_codex_blocked", "child_codex_result"]);
});

test("blocks stale running child_codex when existing result proof is inconsistent", async () => {
  initDb();
  resetDemoData();

  const runId = "run_stale_child_codex_bad_existing_result";
  const stepId = `${runId}_step_1`;
  const childRunId = `${runId}_child_1`;
  const resultPath = join(tempRoot, "bad-stale-existing-child-result.json");
  const resultUri = pathToFileURL(resultPath).href;
  const old = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  writeFileSync(
    resultPath,
    JSON.stringify({
      runId,
      stepId: `${stepId}_wrong`,
      childRunId,
      mode: "child_codex",
      exitStatus: 0
    })
  );
  db.insert("runs", {
    id: runId,
    name: "bad stale child_codex existing result",
    status: "running",
    objective: "CodexでworkerEngineを確認",
    created_at: old,
    updated_at: old,
    metadata_json: { command: "CodexでworkerEngineを確認" }
  });
  db.insert("run_steps", {
    id: stepId,
    run_id: runId,
    name: "CodexでworkerEngineを確認",
    status: "running",
    lane_id: null,
    started_at: old,
    completed_at: null,
    metadata_json: { adapter: "child_codex", execution_mode: "child_codex", child_run_id: childRunId }
  });
  db.insert("child_runs", {
    id: childRunId,
    parent_run_id: runId,
    step_id: stepId,
    role: "child_codex",
    prompt_uri: "file:///tmp/stale-child-prompt.txt",
    status: "running",
    pid: null,
    exit_status: null,
    signal: null,
    result_uri: null,
    summary: "child_codex read-only execution started",
    blocker: null,
    created_at: old,
    started_at: old,
    completed_at: null,
    metadata_json: { adapter: "child_codex", execution_mode: "child_codex", prompt_uri: "file:///tmp/stale-child-prompt.txt" }
  });
  db.insert("proofs", {
    id: `${runId}_proof_1`,
    run_id: runId,
    step_id: stepId,
    proof_type: "child_codex_result",
    label: "child_codex result",
    uri: resultUri,
    size_bytes: 1,
    created_at: old,
    metadata_json: { child_run_id: childRunId, exit_status: 0 }
  });

  await worker.runWorkerOnce(runId);

  const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  const child = querySql<{ status: string; result_uri: string; blocker: string | null }>(
    `SELECT status, result_uri, blocker FROM child_runs WHERE id=${sqlValue(childRunId)} LIMIT 1`
  )[0];
  const proofs = querySql<{ proof_type: string; uri: string }>(`SELECT proof_type, uri FROM proofs WHERE run_id=${sqlValue(runId)} ORDER BY created_at ASC`);
  const runMetadata = JSON.parse(run.metadata_json);

  assert.equal(run.status, "blocked");
  assert.equal(runMetadata.proof_gate.ok, false);
  assert.deepEqual(runMetadata.proof_gate.missing, [`child_codex_child_run_incomplete_or_mismatch:${stepId}`]);
  assert.equal(child.status, "blocked");
  assert.match(child.result_uri, /-stale-child-result\.json$/);
  assert.equal(child.blocker, "async_child_codex_parent_exited_before_pid_or_result_proof");
  assert.deepEqual(proofs.map((proof) => proof.proof_type), ["child_codex_result", "child_codex_blocked"]);
  assert.notEqual(proofs[1].uri, resultUri);
});

test("skips late child_codex finalize after stale repair without overwriting ledger or proofs", async () =>
  withChildCodexExecutionEnv(async () => {
    initDb();
    resetDemoData();
    process.env.FAKE_CODEX_DELAY_MS = "2000";
    process.env.AUTOMATION_OS_CHILD_CODEX_TIMEOUT_MS = "5000";
    process.env.AUTOMATION_OS_WORKER_KILL_GRACE_MS = "10";

    const summary = await startCommandRun("CodexでworkerEngineをread-only確認");
    const child = querySql<{ id: string; step_id: string; result_uri: string | null }>(
      `SELECT id, step_id, result_uri FROM child_runs WHERE parent_run_id=${sqlValue(summary.runId)} LIMIT 1`
    )[0];
    assert.ok(child);
    const old = new Date(Date.now() - 10_000).toISOString();
    execSql(`UPDATE child_runs SET started_at=${sqlValue(old)} WHERE id=${sqlValue(child.id)}`);

    await worker.runWorkerOnce(summary.runId);
    await worker.runWorkerOnce(summary.runId);
    const lateEvents = await waitForWorkerEvent(summary.runId, "worker_late_finalize_skipped", 8000);

    const finalChild = querySql<{ status: string; result_uri: string; blocker: string | null; metadata_json: string }>(
      `SELECT status, result_uri, blocker, metadata_json FROM child_runs WHERE id=${sqlValue(child.id)} LIMIT 1`
    )[0];
    const step = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM run_steps WHERE id=${sqlValue(child.step_id)} LIMIT 1`)[0];
    const proofs = querySql<{ proof_type: string; uri: string }>(`SELECT proof_type, uri FROM proofs WHERE run_id=${sqlValue(summary.runId)} ORDER BY created_at ASC`);
    const childMetadata = JSON.parse(finalChild.metadata_json);
    const stepMetadata = JSON.parse(step.metadata_json);

    assert.equal(finalChild.status, "blocked");
    assert.match(finalChild.result_uri, /-stale-child-result\.json$/);
    assert.equal(finalChild.blocker, "async_child_codex_timed_out_without_result_proof");
    assert.equal(childMetadata.pid_alive_before_termination, true);
    assert.equal(typeof childMetadata.pid_alive_after_termination, "boolean");
    assert.equal(childMetadata.termination_attempted, true);
    assert.match(childMetadata.termination_signal, /^SIG(TERM|KILL)$/);
    assert.equal(step.status, "blocked");
    assert.equal(stepMetadata.child_codex_result_artifact, finalChild.result_uri);
    assert.deepEqual(proofs.map((proof) => proof.proof_type), ["child_codex_blocked"]);
    assert.equal(proofs[0].uri, finalChild.result_uri);
    assert.equal(lateEvents.length, 1);
    const lateMetadata = JSON.parse(lateEvents[0].metadata_json);
    assert.equal(lateMetadata.child_run_id, child.id);
    assert.equal(lateMetadata.skipped_proof_type, "child_codex_blocked");
    assert.notEqual(lateMetadata.late_artifact.uri, finalChild.result_uri);
  }));

test("does not apply child_codex late finalize skip guard to codex_cli finalize", async () =>
  withCodexExecutionEnv(async () => {
    initDb();
    resetDemoData();
    process.env.FAKE_CODEX_DELAY_MS = "150";

    const runId = "run_codex_cli_finalize_without_child_guard";
    const stepId = `${runId}_step_1`;
    const now = new Date().toISOString();
    db.insert("runs", {
      id: runId,
      name: "codex cli no child guard",
      status: "running",
      objective: "Codex CLI read-only",
      created_at: now,
      updated_at: now,
      metadata_json: { command: "Codex CLI read-only" }
    });
    db.insert("run_steps", {
      id: stepId,
      run_id: runId,
      name: "Codex CLI read-only",
      status: "queued",
      lane_id: null,
      started_at: null,
      completed_at: null,
      metadata_json: { adapter: "codex_cli", execution_mode: "execute_codex_readonly" }
    });

    await worker.runWorkerOnce(runId);
    const startedChild = querySql<{ id: string }>(`SELECT id FROM child_runs WHERE parent_run_id=${sqlValue(runId)} LIMIT 1`)[0];
    assert.ok(startedChild);
    execSql(`UPDATE child_runs SET status='blocked', blocker='preexisting non-running status' WHERE id=${sqlValue(startedChild.id)}`);
    const run = await waitForRunStatus(runId, "complete", 30_000);

    const child = querySql<{ status: string; result_uri: string; blocker: string | null }>(
      `SELECT status, result_uri, blocker FROM child_runs WHERE id=${sqlValue(startedChild.id)} LIMIT 1`
    )[0];
    const step = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM run_steps WHERE id=${sqlValue(stepId)} LIMIT 1`)[0];
    const proofs = querySql<{ proof_type: string; uri: string; metadata_json: string }>(`SELECT proof_type, uri, metadata_json FROM proofs WHERE run_id=${sqlValue(runId)} ORDER BY created_at ASC`);
    const lateEvents = querySql<{ event_type: string }>(
      `SELECT event_type FROM worker_events WHERE run_id=${sqlValue(runId)} AND event_type='worker_late_finalize_skipped'`
    );
    const runMetadata = JSON.parse(run.metadata_json);
    const stepMetadata = JSON.parse(step.metadata_json);
    const proofMetadata = JSON.parse(proofs[0]?.metadata_json ?? "{}");

    assert.equal(run.status, "complete");
    assert.equal(runMetadata.proof_gate.ok, true);
    assert.deepEqual(runMetadata.proof_gate.missing, []);
    assert.equal(step.status, "completed");
    assert.equal(stepMetadata.codex_readonly_artifact, child.result_uri);
    assert.equal(child.status, "completed");
    assert.match(child.result_uri, /_step_1\.json$/);
    assert.equal(child.blocker, null);
    assert.deepEqual(proofs.map((proof) => proof.proof_type), ["codex_readonly_execution"]);
    assert.equal(proofMetadata.child_run_id, startedChild.id);
    assert.equal(proofs[0]?.uri, child.result_uri);
    assert.equal(lateEvents.length, 0);
  }));

test("keeps child_codex steps partial when child_run_id result uri does not match proof uri", async () => {
  initDb();
  resetDemoData();

  const runId = "run_mismatched_child_codex_result_uri";
  const stepId = `${runId}_step_1`;
  const childRunId = `${runId}_child_1`;
  const now = new Date().toISOString();
  db.insert("runs", {
    id: runId,
    name: "mismatched child_codex",
    status: "queued",
    objective: "CodexでworkerEngineを確認",
    created_at: now,
    updated_at: now,
    metadata_json: { command: "CodexでworkerEngineを確認" }
  });
  db.insert("run_steps", {
    id: stepId,
    run_id: runId,
    name: "CodexでworkerEngineを確認",
    status: "completed",
    lane_id: null,
    started_at: now,
    completed_at: now,
    metadata_json: {
      child_run_id: childRunId
    }
  });
  db.insert("child_runs", {
    id: childRunId,
    parent_run_id: runId,
    step_id: stepId,
    role: "child_codex",
    prompt_uri: "file:///tmp/prompt.txt",
    status: "completed",
    pid: 123,
    exit_status: 0,
    signal: null,
    result_uri: "file:///tmp/actual-child-result.json",
    summary: "child Codex read-only execution completed",
    blocker: null,
    created_at: now,
    started_at: now,
    completed_at: now,
    metadata_json: { execution_mode: "child_codex" }
  });
  db.insert("proofs", {
    id: `${runId}_proof_1`,
    run_id: runId,
    step_id: stepId,
    proof_type: "child_codex_result",
    label: "child_codex result",
    uri: "file:///tmp/wrong-child-result.json",
    size_bytes: 1,
    created_at: now,
    metadata_json: { child_run_id: childRunId }
  });

  await worker.runWorkerOnce(runId);
  const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  const runMetadata = JSON.parse(run.metadata_json);

  assert.equal(run.status, "partial");
  assert.equal(runMetadata.worker_mode, "execute_child_codex");
  assert.equal(runMetadata.proof_gate.ok, false);
  assert.deepEqual(runMetadata.proof_gate.present, []);
  assert.deepEqual(runMetadata.proof_gate.missing, [`child_codex_result_uri_mismatch:${stepId}`]);
});

test("keeps child_codex steps partial when result artifact is missing", async () => {
  initDb();
  resetDemoData();

  const runId = "run_missing_child_codex_result_artifact";
  const stepId = `${runId}_step_1`;
  const childRunId = `${runId}_child_1`;
  const resultUri = pathToFileURL(join(tempRoot, "missing-child-result.json")).href;
  const now = new Date().toISOString();
  db.insert("runs", {
    id: runId,
    name: "missing child_codex artifact",
    status: "queued",
    objective: "CodexでworkerEngineを確認",
    created_at: now,
    updated_at: now,
    metadata_json: { command: "CodexでworkerEngineを確認" }
  });
  db.insert("run_steps", {
    id: stepId,
    run_id: runId,
    name: "CodexでworkerEngineを確認",
    status: "completed",
    lane_id: null,
    started_at: now,
    completed_at: now,
    metadata_json: { child_run_id: childRunId }
  });
  db.insert("child_runs", {
    id: childRunId,
    parent_run_id: runId,
    step_id: stepId,
    role: "child_codex",
    prompt_uri: "file:///tmp/prompt.txt",
    status: "completed",
    pid: 123,
    exit_status: 0,
    signal: null,
    result_uri: resultUri,
    summary: "child Codex read-only execution completed",
    blocker: null,
    created_at: now,
    started_at: now,
    completed_at: now,
    metadata_json: { execution_mode: "child_codex" }
  });
  db.insert("proofs", {
    id: `${runId}_proof_1`,
    run_id: runId,
    step_id: stepId,
    proof_type: "child_codex_result",
    label: "child_codex result",
    uri: resultUri,
    size_bytes: 1,
    created_at: now,
    metadata_json: { child_run_id: childRunId }
  });

  await worker.runWorkerOnce(runId);
  const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  const runMetadata = JSON.parse(run.metadata_json);

  assert.equal(run.status, "partial");
  assert.equal(runMetadata.proof_gate.ok, false);
  assert.deepEqual(runMetadata.proof_gate.present, []);
  assert.deepEqual(runMetadata.proof_gate.missing, [`child_codex_result_artifact_missing:${stepId}`]);
});

test("keeps child_codex steps partial when result artifact JSON identifiers mismatch", async () => {
  initDb();
  resetDemoData();

  const runId = "run_mismatched_child_codex_result_artifact_json";
  const stepId = `${runId}_step_1`;
  const childRunId = `${runId}_child_1`;
  const resultPath = join(tempRoot, "mismatched-child-result.json");
  const resultUri = pathToFileURL(resultPath).href;
  const now = new Date().toISOString();
  writeFileSync(
    resultPath,
    JSON.stringify({
      runId,
      stepId: `${stepId}_wrong`,
      childRunId,
      mode: "child_codex",
      exitStatus: 0
    })
  );
  db.insert("runs", {
    id: runId,
    name: "mismatched child_codex artifact json",
    status: "queued",
    objective: "CodexでworkerEngineを確認",
    created_at: now,
    updated_at: now,
    metadata_json: { command: "CodexでworkerEngineを確認" }
  });
  db.insert("run_steps", {
    id: stepId,
    run_id: runId,
    name: "CodexでworkerEngineを確認",
    status: "completed",
    lane_id: null,
    started_at: now,
    completed_at: now,
    metadata_json: { child_run_id: childRunId }
  });
  db.insert("child_runs", {
    id: childRunId,
    parent_run_id: runId,
    step_id: stepId,
    role: "child_codex",
    prompt_uri: "file:///tmp/prompt.txt",
    status: "completed",
    pid: 123,
    exit_status: 0,
    signal: null,
    result_uri: resultUri,
    summary: "child Codex read-only execution completed",
    blocker: null,
    created_at: now,
    started_at: now,
    completed_at: now,
    metadata_json: { execution_mode: "child_codex" }
  });
  db.insert("proofs", {
    id: `${runId}_proof_1`,
    run_id: runId,
    step_id: stepId,
    proof_type: "child_codex_result",
    label: "child_codex result",
    uri: resultUri,
    size_bytes: 1,
    created_at: now,
    metadata_json: { child_run_id: childRunId }
  });

  await worker.runWorkerOnce(runId);
  const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  const runMetadata = JSON.parse(run.metadata_json);

  assert.equal(run.status, "partial");
  assert.equal(runMetadata.proof_gate.ok, false);
  assert.deepEqual(runMetadata.proof_gate.present, []);
  assert.deepEqual(runMetadata.proof_gate.missing, [`child_codex_result_artifact_invalid:${stepId}`]);
});

test("keeps mixed executable runs partial when receipt-only step has no worker receipt proof", async () => {
  initDb();
  resetDemoData();

  const runId = "run_receipt_step_without_receipt_proof";
  const childStepId = `${runId}_step_1`;
  const receiptStepId = `${runId}_step_2`;
  const childRunId = `${runId}_child_1`;
  const resultPath = join(tempRoot, "receipt-mixed-child-result.json");
  const resultUri = pathToFileURL(resultPath).href;
  const now = new Date().toISOString();
  writeFileSync(
    resultPath,
    JSON.stringify({
      runId,
      stepId: childStepId,
      childRunId,
      mode: "child_codex",
      exitStatus: 0
    })
  );
  db.insert("runs", {
    id: runId,
    name: "mixed run missing receipt proof",
    status: "queued",
    objective: "CodexでworkerEngineを確認, ローカル作業",
    created_at: now,
    updated_at: now,
    metadata_json: { command: "CodexでworkerEngineを確認, ローカル作業" }
  });
  db.insert("run_steps", {
    id: childStepId,
    run_id: runId,
    name: "CodexでworkerEngineを確認",
    status: "completed",
    lane_id: null,
    started_at: now,
    completed_at: now,
    metadata_json: { execution_mode: "child_codex", child_run_id: childRunId }
  });
  db.insert("run_steps", {
    id: receiptStepId,
    run_id: runId,
    name: "ローカル作業",
    status: "completed",
    lane_id: null,
    started_at: now,
    completed_at: now,
    metadata_json: { execution_mode: "receipt_only", receipt_only: true }
  });
  db.insert("child_runs", {
    id: childRunId,
    parent_run_id: runId,
    step_id: childStepId,
    role: "child_codex",
    prompt_uri: "file:///tmp/prompt.txt",
    status: "completed",
    pid: 123,
    exit_status: 0,
    signal: null,
    result_uri: resultUri,
    summary: "child Codex read-only execution completed",
    blocker: null,
    created_at: now,
    started_at: now,
    completed_at: now,
    metadata_json: { execution_mode: "child_codex" }
  });
  db.insert("proofs", {
    id: `${runId}_proof_1`,
    run_id: runId,
    step_id: childStepId,
    proof_type: "child_codex_result",
    label: "child_codex result",
    uri: resultUri,
    size_bytes: 1,
    created_at: now,
    metadata_json: { child_run_id: childRunId }
  });

  await worker.runWorkerOnce(runId);
  const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  const runMetadata = JSON.parse(run.metadata_json);

  assert.equal(run.status, "partial");
  assert.equal(runMetadata.proof_gate.ok, false);
  assert.deepEqual(runMetadata.proof_gate.missing, [`actual_execution_or_manual_verification:${receiptStepId}`]);
});

test("keeps codex_cli steps partial when child run result uri does not match proof uri", async () => {
  initDb();
  resetDemoData();

  const runId = "run_mismatched_codex_readonly_result_uri";
  const stepId = `${runId}_step_1`;
  const childRunId = `${runId}_child_1`;
  const resultPath = join(tempRoot, "codex-readonly-result.json");
  const resultUri = pathToFileURL(resultPath).href;
  const now = new Date().toISOString();
  writeFileSync(
    resultPath,
    JSON.stringify({
      runId,
      stepId,
      mode: "execute_codex_readonly",
      exitStatus: 0
    })
  );
  db.insert("runs", {
    id: runId,
    name: "mismatched codex readonly",
    status: "queued",
    objective: "CodexでworkerEngineを確認",
    created_at: now,
    updated_at: now,
    metadata_json: { command: "CodexでworkerEngineを確認" }
  });
  db.insert("run_steps", {
    id: stepId,
    run_id: runId,
    name: "CodexでworkerEngineを確認",
    status: "completed",
    lane_id: null,
    started_at: now,
    completed_at: now,
    metadata_json: { adapter: "codex_cli", execution_mode: "execute_codex_readonly" }
  });
  db.insert("child_runs", {
    id: childRunId,
    parent_run_id: runId,
    step_id: stepId,
    role: "codex_cli",
    prompt_uri: "file:///tmp/prompt.txt",
    status: "completed",
    pid: 123,
    exit_status: 0,
    signal: null,
    result_uri: "file:///tmp/actual-codex-readonly-result.json",
    summary: "Codex read-only execution completed",
    blocker: null,
    created_at: now,
    started_at: now,
    completed_at: now,
    metadata_json: { execution_mode: "execute_codex_readonly" }
  });
  db.insert("proofs", {
    id: `${runId}_proof_1`,
    run_id: runId,
    step_id: stepId,
    proof_type: "codex_readonly_execution",
    label: "codex readonly result",
    uri: resultUri,
    size_bytes: 1,
    created_at: now,
    metadata_json: { child_run_id: childRunId }
  });

  await worker.runWorkerOnce(runId);
  const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  const runMetadata = JSON.parse(run.metadata_json);

  assert.equal(run.status, "partial");
  assert.equal(runMetadata.worker_mode, "execute_codex");
  assert.equal(runMetadata.proof_gate.ok, false);
  assert.deepEqual(runMetadata.proof_gate.present, []);
  assert.deepEqual(runMetadata.proof_gate.missing, [`codex_readonly_result_uri_mismatch:${stepId}`]);
});

test("keeps mixed child_codex and codex_cli runs partial when codex_cli proof is missing", async () => {
  initDb();
  resetDemoData();

  const runId = "run_mixed_child_and_codex_missing_codex_proof";
  const childStepId = `${runId}_step_1`;
  const codexStepId = `${runId}_step_2`;
  const childRunId = `${runId}_child_1`;
  const resultPath = join(tempRoot, "mixed-executable-child-result.json");
  const resultUri = pathToFileURL(resultPath).href;
  const now = new Date().toISOString();
  writeFileSync(
    resultPath,
    JSON.stringify({
      runId,
      stepId: childStepId,
      childRunId,
      mode: "child_codex",
      exitStatus: 0
    })
  );
  db.insert("runs", {
    id: runId,
    name: "mixed child and codex",
    status: "queued",
    objective: "Codex child and codex_cli",
    created_at: now,
    updated_at: now,
    metadata_json: { command: "Codex child and codex_cli" }
  });
  db.insert("run_steps", {
    id: childStepId,
    run_id: runId,
    name: "child_codex",
    status: "completed",
    lane_id: null,
    started_at: now,
    completed_at: now,
    metadata_json: { execution_mode: "child_codex", child_run_id: childRunId }
  });
  db.insert("run_steps", {
    id: codexStepId,
    run_id: runId,
    name: "codex_cli",
    status: "completed",
    lane_id: null,
    started_at: now,
    completed_at: now,
    metadata_json: { adapter: "codex_cli", execution_mode: "execute_codex_readonly" }
  });
  db.insert("child_runs", {
    id: childRunId,
    parent_run_id: runId,
    step_id: childStepId,
    role: "child_codex",
    prompt_uri: "file:///tmp/prompt.txt",
    status: "completed",
    pid: 123,
    exit_status: 0,
    signal: null,
    result_uri: resultUri,
    summary: "child Codex read-only execution completed",
    blocker: null,
    created_at: now,
    started_at: now,
    completed_at: now,
    metadata_json: { execution_mode: "child_codex" }
  });
  db.insert("proofs", {
    id: `${runId}_proof_1`,
    run_id: runId,
    step_id: childStepId,
    proof_type: "child_codex_result",
    label: "child_codex result",
    uri: resultUri,
    size_bytes: 1,
    created_at: now,
    metadata_json: { child_run_id: childRunId }
  });

  await worker.runWorkerOnce(runId);
  const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  const runMetadata = JSON.parse(run.metadata_json);

  assert.equal(run.status, "partial");
  assert.equal(runMetadata.proof_gate.ok, false);
  assert.deepEqual(runMetadata.proof_gate.present, ["child_codex_result", `child_codex_result:${childStepId}`]);
  assert.deepEqual(runMetadata.proof_gate.missing, [`codex_readonly_execution:${codexStepId}`]);
});

test("reports blocked child_codex proof present with step scope in mixed two-step runs", async () => {
  initDb();
  resetDemoData();

  const runId = "run_one_child_codex_blocked";
  const completedStepId = `${runId}_step_1`;
  const blockedStepId = `${runId}_step_2`;
  const childRunId = `${runId}_child_1`;
  const resultPath = join(tempRoot, "completed-child-result.json");
  const resultUri = pathToFileURL(resultPath).href;
  const now = new Date().toISOString();
  writeFileSync(
    resultPath,
    JSON.stringify({
      runId,
      stepId: completedStepId,
      childRunId,
      mode: "child_codex",
      exitStatus: 0
    })
  );
  db.insert("runs", {
    id: runId,
    name: "one blocked child_codex",
    status: "queued",
    objective: "CodexでworkerEngineを確認, Codexでblocked確認",
    created_at: now,
    updated_at: now,
    metadata_json: { command: "CodexでworkerEngineを確認, Codexでblocked確認" }
  });
  for (const [stepId, status] of [
    [completedStepId, "completed"],
    [blockedStepId, "blocked"]
  ] as const) {
    db.insert("run_steps", {
      id: stepId,
      run_id: runId,
      name: stepId === completedStepId ? "CodexでworkerEngineを確認" : "Codexでblocked確認",
      status,
      lane_id: null,
      started_at: now,
      completed_at: now,
      metadata_json: { execution_mode: "child_codex" }
    });
  }
  db.insert("child_runs", {
    id: childRunId,
    parent_run_id: runId,
    step_id: completedStepId,
    role: "child_codex",
    prompt_uri: "file:///tmp/prompt.txt",
    status: "completed",
    pid: 123,
    exit_status: 0,
    signal: null,
    result_uri: resultUri,
    summary: "child Codex read-only execution completed",
    blocker: null,
    created_at: now,
    started_at: now,
    completed_at: now,
    metadata_json: { execution_mode: "child_codex" }
  });
  db.insert("proofs", {
    id: `${runId}_proof_result`,
    run_id: runId,
    step_id: completedStepId,
    proof_type: "child_codex_result",
    label: "child_codex result",
    uri: resultUri,
    size_bytes: 1,
    created_at: now,
    metadata_json: { child_run_id: childRunId }
  });
  db.insert("proofs", {
    id: `${runId}_proof_blocked`,
    run_id: runId,
    step_id: blockedStepId,
    proof_type: "child_codex_blocked",
    label: "child_codex blocked",
    uri: "file:///tmp/blocked-child-result.json",
    size_bytes: 1,
    created_at: now,
    metadata_json: { exit_status: 7 }
  });

  await worker.runWorkerOnce(runId);
  const run = querySql<{ status: string; metadata_json: string }>(`SELECT status, metadata_json FROM runs WHERE id=${sqlValue(runId)} LIMIT 1`)[0];
  const runMetadata = JSON.parse(run.metadata_json);

  assert.equal(run.status, "blocked");
  assert.equal(runMetadata.proof_gate.ok, false);
  assert.deepEqual(runMetadata.proof_gate.present, [
    "child_codex_result",
    `child_codex_result:${completedStepId}`,
    "child_codex_blocked",
    `child_codex_blocked:${blockedStepId}`
  ]);
  assert.deepEqual(runMetadata.proof_gate.missing, [`child_codex_result:${blockedStepId}`]);
});

test("stores NisenPrints Etsy Sync contract in plan and start metadata", async () => {
  const command = "NisenPrints Etsy Sync current listings 正本同期";
  const plan = planCommandRun(command);

  assert.equal(plan.runContract?.mode, "nisenprints_etsy_sync");
  assert.equal(plan.contractVersion, "nisenprints_v1");

  initDb();
  resetDemoData();
  const summary = await startCommandRun(command);
  const responseMetadata = JSON.parse(String(summary.run.metadata_json));
  const run = querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${sqlValue(summary.runId)} LIMIT 1`)[0];
  const step = querySql<{ id: string }>(`SELECT id FROM run_steps WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
  const approvals = querySql<{ id: string }>(`SELECT id FROM approvals WHERE run_id=${sqlValue(summary.runId)}`);
  const metadata = JSON.parse(run.metadata_json);

  assert.equal(responseMetadata.run_contract.requiredProofs, undefined);
  assert.equal(responseMetadata.run_contract.sourceOfTruth, undefined);
  assert.equal(responseMetadata.run_contract_summary.progress.total, 3);
  assert.equal(responseMetadata.proof_gate.ok, false);
  assert.ok(responseMetadata.proof_gate.missing.includes("確認記録"));
  assert.ok(responseMetadata.proof_gate.missing.every((item: string) => !/[_:]/.test(item)));
  assert.equal(responseMetadata.proof_summary, undefined);
  assert.doesNotMatch(String(summary.run.metadata_json), /etsy_current_listings_snapshot|local_queue_synced|stale_rows_pruned/);
  assert.equal(metadata.run_contract.mode, "nisenprints_etsy_sync");
  assert.equal(metadata.run_contract.beginnerLabel, "Etsy同期");
  assert.deepEqual(metadata.run_contract.requiredProofs, [
    "etsy_current_listings_snapshot",
    "local_queue_synced",
    "stale_rows_pruned"
  ]);
  assert.equal(approvals.length, 0);
  assert.ok(metadata.proof_gate.missing.includes(`playwright_check:${step.id}`));
  assert.ok(metadata.proof_gate.missing.some((item: string) => item.startsWith("playwright_artifact_missing:")));
  assert.match(metadata.proof_summary, /playwright/);
  assert.equal(metadata.contract_version, "nisenprints_v1");
  assert.equal(metadata.plan.runContract.mode, "nisenprints_etsy_sync");
});

test("starts NisenPrints contract runs without non-billing approval and records execution proof gate", async () => {
  initDb();
  resetDemoData();
  const summary = await startCommandRun("NisenPrints Etsy Sync current listings 正本同期");
  const run = querySql<{ metadata_json: string }>(`SELECT metadata_json FROM runs WHERE id=${sqlValue(summary.runId)} LIMIT 1`)[0];
  const step = querySql<{ id: string }>(`SELECT id FROM run_steps WHERE run_id=${sqlValue(summary.runId)} LIMIT 1`)[0];
  const approvals = querySql<{ id: string }>(`SELECT id FROM approvals WHERE run_id=${sqlValue(summary.runId)}`);
  const metadata = JSON.parse(run.metadata_json);

  assert.equal(metadata.proof_gate.ok, false);
  assert.equal(approvals.length, 0);
  assert.ok(metadata.proof_gate.present.includes("playwright_blocked"));
  assert.ok(metadata.proof_gate.present.includes(`playwright_blocked:${step.id}`));
  assert.ok(metadata.proof_gate.missing.includes(`playwright_check:${step.id}`));
  assert.match(metadata.proof_summary, /playwright/);
  assert.doesNotMatch(JSON.stringify(metadata.proof_gate), /actual_execution_or_manual_verification/);
});

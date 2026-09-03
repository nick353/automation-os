#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(process.env.AUTOMATION_OS_REPO_ROOT || join(scriptDir, ".."));
const receiptPath = resolve(
  process.env.AUTOMATION_OS_REFERENCE_CANARY_RECEIPT ||
    join(repoRoot, "data", "state", "reference-workflow-canary.json")
);
const cliPath = resolve(repoRoot, "apps/server", "dist", "cli", "referenceWorkflowCanary.js");
const tempRoot = await mkdtemp(join(tmpdir(), "aos-reference-workflow-canary-"));
const tempOutput = join(tempRoot, "reference-workflow-canary.json");

function runCanary(env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cliPath, "--output", tempOutput], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "inherit"]
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => resolveRun({ code, signal, stdout }));
  });
}

try {
  await mkdir(dirname(receiptPath), { recursive: true });
  const canaryEnv = { ...process.env };
  delete canaryEnv.AUTOMATION_OS_DATABASE_URL;
  delete canaryEnv.DATABASE_URL;
  Object.assign(canaryEnv, {
    AUTOMATION_OS_DATABASE_MODE: "sqlite",
    AUTOMATION_OS_DB: join(tempRoot, "reference.sqlite"),
    AUTOMATION_OS_ARTIFACT_ROOT: join(tempRoot, "artifacts"),
    // The canary intentionally boots an isolated SQLite database. Its
    // backend readback must not write that temporary default into the live
    // AOS/Chrome Plugin mirror used by the server and worker.
    AOS_WEB_OPERATION_BACKEND_CONFIG: join(tempRoot, "web-operation-backend.json"),
    AUTOMATION_OS_WEB_OPERATION_BACKEND_CONFIG: join(tempRoot, "web-operation-backend.json")
  });
  const outcome = await runCanary(canaryEnv);
  if (outcome.code !== 0) {
    throw new Error(`reference_workflow_canary_startup_failed:${outcome.signal || outcome.code}`);
  }
  const receipt = JSON.parse(await readFile(tempOutput, "utf8"));
  if (
    receipt.ok !== true ||
    receipt.safety_reference_paths_ok !== true ||
    receipt.reference_paths_complete !== false ||
    receipt.external_action_executed !== false ||
    !Array.isArray(receipt.paths) ||
    receipt.paths.length !== 3
  ) {
    throw new Error("reference_workflow_canary_startup_receipt_invalid");
  }
  await rename(tempOutput, receiptPath);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    receipt_path: receiptPath,
    generated_at: receipt.generated_at,
    path_count: receipt.paths.length,
    external_action_executed: false
  })}\n`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

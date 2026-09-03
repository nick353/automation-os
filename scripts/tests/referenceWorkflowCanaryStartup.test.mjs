import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const repoRoot = resolve(new URL("../..", import.meta.url).pathname);
const prepareScript = join(repoRoot, "scripts", "prepare_reference_workflow_canary.mjs");

function runPreparation(receiptPath, mirrorPath) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [prepareScript], {
      cwd: repoRoot,
      env: {
        ...process.env,
        AUTOMATION_OS_REPO_ROOT: repoRoot,
        AUTOMATION_OS_REFERENCE_CANARY_RECEIPT: receiptPath,
        AOS_WEB_OPERATION_BACKEND_CONFIG: mirrorPath,
        AUTOMATION_OS_WEB_OPERATION_BACKEND_CONFIG: mirrorPath
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", rejectRun);
    child.once("close", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

test("startup preparation binds a fresh isolated safe-stop receipt without external effects", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-reference-canary-startup-test-"));
  const receiptPath = join(root, "trusted", "reference-workflow-canary.json");
  try {
    const result = await runPreparation(receiptPath);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    assert.equal(receipt.schema, "automation_os_reference_workflow_canary.v2");
    assert.equal(receipt.ok, true);
    assert.equal(receipt.safety_reference_paths_ok, true);
    assert.equal(receipt.reference_paths_complete, false);
    assert.equal(receipt.external_action_executed, false);
    assert.equal(receipt.paths.length, 3);
    assert.ok(receipt.paths.every((path) =>
      path.status === "proof_backed_safe_stop_verified" &&
      path.exact_blocker === "browser_use_cli_required" &&
      path.runner_started === false &&
      path.runner_completed === false &&
      path.external_action_executed === false &&
      path.cleanup_receipt_verified === true
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isolated startup canary does not overwrite the live backend mirror", async () => {
  const root = await mkdtemp(join(tmpdir(), "aos-reference-canary-mirror-test-"));
  const receiptPath = join(root, "trusted", "reference-workflow-canary.json");
  const mirrorPath = join(root, "live-web-operation-backend.json");
  const sentinel = {
    schema: "web_operation_backend_config.v1",
    source: "automation_os",
    backend: "chrome_plugin",
    revision: 26,
    chrome_profile: {
      id: "profile2",
      name: "Profile 2",
      directory: "Profile 2",
      surface: "signed_chrome_extension_profile2"
    }
  };
  try {
    await writeFile(mirrorPath, `${JSON.stringify(sentinel)}\n`, "utf8");
    const result = await runPreparation(receiptPath, mirrorPath);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(await readFile(mirrorPath, "utf8")), sentinel);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("server startup wires the trusted receipt path and preparation boundary", async () => {
  const source = await readFile(join(repoRoot, "scripts", "start-automation-os-server.sh"), "utf8");
  assert.match(source, /AUTOMATION_OS_REFERENCE_CANARY_RECEIPT/);
  assert.match(source, /prepare_reference_workflow_canary\.mjs/);
  assert.match(source, /AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS=.*read_only/u);
});

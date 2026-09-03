import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { runtimeBoundaryNextAction } from "../lib/runtime-boundary-route.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const dynamicRunnerSelection = /unset AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER AUTOMATION_OS_PORTABLE_EXTERNAL_DEFAULT_RUNNER/u;

test("project startup boundaries leave runner selection to the AOS resolver and split server read-only from worker effects", () => {
  const files = [
    join(root, "scripts", "start-automation-os-server.sh"),
    join(root, "scripts", "start-automation-os-worker.sh"),
    join(root, "ops", "launchd", "com.nichikatanaka.automation-os.plist"),
    join(root, "ops", "launchd", "com.nichikatanaka.automation-os-worker.plist")
  ];
  const serverHelperText = readFileSync(files[0], "utf8");
  assert.match(serverHelperText, dynamicRunnerSelection, files[0]);
  assert.doesNotMatch(serverHelperText, /AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER=.*aos-portable-browser-use-runner/u, files[0]);
  assert.doesNotMatch(serverHelperText, /portable-external-runner\.mjs/u, files[0]);
  assert.doesNotMatch(serverHelperText, /AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS=.*enabled/u, files[0]);
  assert.match(serverHelperText, /read_only/u, files[0]);
  const workerHelperText = readFileSync(files[1], "utf8");
  for (const [file, text] of [[files[1], workerHelperText]]) {
    assert.match(text, dynamicRunnerSelection, file);
    assert.doesNotMatch(text, /AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER=.*aos-portable-browser-use-runner/u, file);
    assert.doesNotMatch(text, /portable-external-runner\.mjs/u, file);
    assert.match(text, /AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS=.*enabled/u, file);
  }
  const serverPlist = readFileSync(files[2], "utf8");
  assert.match(serverPlist, /Library\/Application Support\/Automation OS\/start-automation-os-server\.sh/u);
  assert.match(serverPlist, /<key>AUTOMATION_OS_DATABASE_MODE<\/key>\s*<string>postgres<\/string>/u);
  assert.match(serverPlist, /<key>AUTOMATION_OS_DURABLE_SCHEDULER_OWNER<\/key>\s*<string>server<\/string>/u);
  assert.doesNotMatch(serverPlist, /portable-external-runner\.mjs/u);
  assert.doesNotMatch(serverPlist, /<string>enabled<\/string>/u);
  const serverHelper = readFileSync(files[0], "utf8");
  assert.match(serverHelper, /export AUTOMATION_OS_ASSUME_EXISTING_POSTGRES_SCHEMA="\$\{AUTOMATION_OS_ASSUME_EXISTING_POSTGRES_SCHEMA:-1\}"/u);
  const workerHelper = readFileSync(files[1], "utf8");
  assert.match(workerHelper, /AUTOMATION_OS_PORTABLE_LOCAL_QUEUE_COMPANY_ID=.*AUTOMATION_OS_PORTABLE_REMOTE_COMPANY_ID/u);
  assert.match(workerHelper, /AUTOMATION_OS_PORTABLE_QUEUE_AUTHORITY:-remote\}/u);
  assert.doesNotMatch(workerHelper, /AUTOMATION_OS_PORTABLE_QUEUE_AUTHORITY:-remote_and_local\}/u);
  const installedServerPlist = join(process.env.HOME || "", "Library", "LaunchAgents", "com.nichikatanaka.automation-os.plist");
  if (existsSync(installedServerPlist)) {
    const installedText = readFileSync(installedServerPlist, "utf8");
    assert.match(installedText, /<key>AUTOMATION_OS_DATABASE_MODE<\/key>\s*<string>postgres<\/string>/u, installedServerPlist);
    assert.match(installedText, /<key>AUTOMATION_OS_DURABLE_SCHEDULER_OWNER<\/key>\s*<string>server<\/string>/u, installedServerPlist);
  }
  const workerPlist = readFileSync(files[3], "utf8");
  assert.match(workerPlist, /<key>AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS<\/key>\s*<string>enabled<\/string>/u);
  assert.doesNotMatch(workerPlist, /AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER/u);
  assert.doesNotMatch(workerPlist, /portable-external-runner\.mjs/u);
});

test("installed helper defaults are synchronized when the local launch-agent copy exists", () => {
  const installedRoot = join(process.env.HOME || "", "Library", "Application Support", "Automation OS");
  for (const name of ["start-automation-os-server.sh", "start-automation-os-worker.sh"]) {
    const file = join(installedRoot, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    assert.match(text, dynamicRunnerSelection, file);
    assert.doesNotMatch(text, /AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER=.*aos-portable-browser-use-runner/u, file);
    assert.doesNotMatch(text, /portable-external-runner\.mjs/u, file);
    if (name.includes("worker")) {
      assert.match(text, /AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS=.*enabled/u, file);
    } else {
      assert.doesNotMatch(text, /AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS=.*enabled/u, file);
      assert.match(text, /AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS=.*read_only/u, file);
    }
  }
  const installedServerHelper = join(installedRoot, "start-automation-os-server.sh");
  if (existsSync(installedServerHelper)) {
    const installedServerText = readFileSync(installedServerHelper, "utf8");
    assert.match(installedServerText, /export AUTOMATION_OS_REPO_ROOT=/u, installedServerHelper);
  }
  const installedWorkerHelper = join(installedRoot, "start-automation-os-worker.sh");
  if (existsSync(installedWorkerHelper)) {
    const installedWorkerText = readFileSync(installedWorkerHelper, "utf8");
    assert.match(installedWorkerText, /AUTOMATION_OS_PORTABLE_LOCAL_QUEUE_COMPANY_ID=.*AUTOMATION_OS_PORTABLE_REMOTE_COMPANY_ID/u, installedWorkerHelper);
    assert.match(installedWorkerText, /AUTOMATION_OS_PORTABLE_QUEUE_AUTHORITY:-remote\}/u, installedWorkerHelper);
    assert.doesNotMatch(installedWorkerText, /AUTOMATION_OS_PORTABLE_QUEUE_AUTHORITY:-remote_and_local\}/u, installedWorkerHelper);
  }
});

test("runtime boundary readback includes the canonical portable remote worker process without exposing its environment", () => {
  const file = join(root, "scripts", "aos-runtime-boundary-readback.mjs");
  const text = readFileSync(file, "utf8");
  assert.match(text, /aos-portable-remote-worker/u);
  assert.match(text, /processKind/u);
  assert.match(text, /AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS/u);
  assert.match(text, /AUTOMATION_OS_PORTABLE_WORKER_MODE/u);
  assert.doesNotMatch(text, /console\.log\(output\)/u);
});

test("runtime boundary next action follows the canonical browser selector", () => {
  const fixture = mkdtempSync(join(tmpdir(), "aos-runtime-route-"));
  try {
    const selector = join(fixture, "web-operation-backend.json");
    writeFileSync(selector, JSON.stringify({
      backend: "chrome_plugin",
      chrome_profile: { surface: "signed_chrome_extension_profile2" }
    }));
    assert.match(runtimeBoundaryNextAction(selector), /official Chrome Plugin\/Profile 2 route/u);

    writeFileSync(selector, JSON.stringify({ backend: "aos_chrome_companion" }));
    assert.match(runtimeBoundaryNextAction(selector), /AOS Chrome Companion route/u);

    writeFileSync(selector, "not-json");
    assert.match(runtimeBoundaryNextAction(selector), /selected browser route/u);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

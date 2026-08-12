import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const dynamicRunnerSelection = /unset AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER AUTOMATION_OS_PORTABLE_EXTERNAL_DEFAULT_RUNNER/u;

test("project startup boundaries leave runner selection to the AOS resolver and default to read-only effects", () => {
  const files = [
    join(root, "scripts", "start-automation-os-server.sh"),
    join(root, "scripts", "start-automation-os-worker.sh"),
    join(root, "ops", "launchd", "com.nichikatanaka.automation-os.plist"),
    join(root, "ops", "launchd", "com.nichikatanaka.automation-os-worker.plist")
  ];
  for (const file of files.slice(0, 2)) {
    const text = readFileSync(file, "utf8");
    assert.match(text, dynamicRunnerSelection, file);
    assert.doesNotMatch(text, /AUTOMATION_OS_PORTABLE_EXTERNAL_RUNNER=.*aos-portable-browser-use-runner/u, file);
    assert.doesNotMatch(text, /portable-external-runner\.mjs/u, file);
    assert.doesNotMatch(text, /AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS=.*enabled/u, file);
    assert.match(text, /read_only/u, file);
  }
  const serverPlist = readFileSync(files[2], "utf8");
  assert.match(serverPlist, /Library\/Application Support\/Automation OS\/start-automation-os-server\.sh/u);
  assert.match(serverPlist, /<key>AUTOMATION_OS_DATABASE_MODE<\/key>\s*<string>postgres<\/string>/u);
  assert.match(serverPlist, /<key>AUTOMATION_OS_DURABLE_SCHEDULER_OWNER<\/key>\s*<string>worker<\/string>/u);
  assert.doesNotMatch(serverPlist, /portable-external-runner\.mjs/u);
  assert.doesNotMatch(serverPlist, /<string>enabled<\/string>/u);
  const installedServerPlist = join(process.env.HOME || "", "Library", "LaunchAgents", "com.nichikatanaka.automation-os.plist");
  if (existsSync(installedServerPlist)) {
    const installedText = readFileSync(installedServerPlist, "utf8");
    assert.match(installedText, /<key>AUTOMATION_OS_DATABASE_MODE<\/key>\s*<string>postgres<\/string>/u, installedServerPlist);
    assert.match(installedText, /<key>AUTOMATION_OS_DURABLE_SCHEDULER_OWNER<\/key>\s*<string>worker<\/string>/u, installedServerPlist);
  }
  const workerPlist = readFileSync(files[3], "utf8");
  assert.match(workerPlist, /<string>read_only<\/string>/u);
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
    assert.doesNotMatch(text, /AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS=.*enabled/u, file);
    assert.match(text, /AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS=.*read_only/u, file);
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

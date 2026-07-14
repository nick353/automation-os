import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolveBuiltInBrowserUseScript } from "../browser/browserUseBuiltIns.js";
import { buildAutoCdpLaunchArgs } from "../browser/browserUseLocalCheck.js";
import { findCdpTarget } from "../browser/browserUseRecordingSidecar.js";
import { runBrowserUseLocalCheck, runBrowserUseLocalCheckAsync } from "../browser/browserUseLocalCheck.js";
import { runLocalBrowserBridgeCheck, runLocalBrowserBridgeCheckAsync, validateLocalTargetUrl } from "../browser/localCheck.js";

process.env.AUTOMATION_OS_BROWSER_USE_DISABLE_BUILTIN_RECORDING_SIDECAR = "1";

function localBrowserCliAction(args: string[]): string | undefined {
  return args[0] === "session-stop" ? "session-stop" : args.at(2);
}

function browserUseCliAction(args: string[]): string | undefined {
  return args.find((arg) => ["open", "state", "screenshot", "close"].includes(arg));
}

test("Browser Use built-in resolver ignores src TypeScript and finds dist JavaScript from repo root", () => {
  const oldRepoRoot = process.env.AUTOMATION_OS_REPO_ROOT;
  const oldCwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "automation-os-browser-use-builtins-"));
  const srcBrowserDir = join(root, "apps", "server", "src", "browser");
  const distBrowserDir = join(root, "apps", "server", "dist", "browser");
  mkdirSync(srcBrowserDir, { recursive: true });
  mkdirSync(distBrowserDir, { recursive: true });
  writeFileSync(join(srcBrowserDir, "browserUseRecordingSidecar.ts"), "export {};\n");
  writeFileSync(join(srcBrowserDir, "geminiVideoQaRunner.ts"), "export {};\n");
  writeFileSync(join(distBrowserDir, "browserUseRecordingSidecar.js"), "export {};\n");
  process.env.AUTOMATION_OS_REPO_ROOT = root;

  const moduleUrl = pathToFileURL(join(srcBrowserDir, "health.js")).href;

  try {
    process.chdir(root);
    assert.equal(resolveBuiltInBrowserUseScript("browserUseRecordingSidecar.js", { moduleUrl }), join(distBrowserDir, "browserUseRecordingSidecar.js"));
    assert.equal(resolveBuiltInBrowserUseScript("geminiVideoQaRunner.js", { moduleUrl }), undefined);
  } finally {
    process.chdir(oldCwd);
    if (oldRepoRoot === undefined) {
      delete process.env.AUTOMATION_OS_REPO_ROOT;
    } else {
      process.env.AUTOMATION_OS_REPO_ROOT = oldRepoRoot;
    }
  }
});

test("browser use auto CDP launch does not force a new window", () => {
  const args = buildAutoCdpLaunchArgs("browser_use_check_2026_07_10", 9471, "/tmp/automation-os-browser-use-check");
  assert.ok(!args.includes("--new-window"));
  assert.deepEqual(args.slice(0, 4), [
    "--remote-debugging-port=9471",
    "--user-data-dir=/tmp/automation-os-browser-use-check",
    "--window-size=1280,900",
    "--no-first-run"
  ]);
});

test("browser bridge check opens only local targets and captures screenshot proof", () => {
  const oldCommand = process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  const oldSession = process.env.AUTOMATION_OS_BROWSER_CHECK_SESSION;
  process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = "playwright-cli-test";
  delete process.env.AUTOMATION_OS_BROWSER_CHECK_SESSION;
  const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-browser-bridge-"));
  const screenshot = join(tempRoot, "screen.png");
  const consoleLog = join(tempRoot, "console.log");
  writeFileSync(screenshot, "png");
  writeFileSync(consoleLog, "");

  const result = runLocalBrowserBridgeCheck({
    targetUrl: "http://127.0.0.1:5173/#sources",
    artifactRoot: tempRoot,
    now: () => new Date("2026-06-06T00:00:00.000Z"),
    runner: (_command, args) => {
      const cliCommand = localBrowserCliAction(args);
      if (cliCommand === "snapshot") return { status: 0, stdout: "user@example.com Bearer abcdefghijklmnop\n", stderr: "" };
      if (cliCommand === "screenshot") return { status: 0, stdout: `### Result\n- [Screenshot of viewport](${screenshot})\n`, stderr: "" };
      if (cliCommand === "console") return { status: 0, stdout: `### Result\n- [Console](${consoleLog})\n`, stderr: "" };
      return { status: 0, stdout: "ok", stderr: "" };
    }
  });

  if (oldCommand === undefined) {
    delete process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  } else {
    process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = oldCommand;
  }
  if (oldSession === undefined) {
    delete process.env.AUTOMATION_OS_BROWSER_CHECK_SESSION;
  } else {
    process.env.AUTOMATION_OS_BROWSER_CHECK_SESSION = oldSession;
  }

  assert.equal(result.status, "ok");
  assert.equal(result.targetUrl, "http://127.0.0.1:5173/#sources");
  assert.equal(result.screenshotPath, screenshot);
  assert.ok(result.domPath?.startsWith(tempRoot));
  assert.ok(existsSync(result.domPath ?? ""));
  assert.match(readFileSync(result.domPath ?? "", "utf8"), /\[redacted-email\] Bearer \[redacted-token\]/);
  assert.equal(result.consolePath, consoleLog);
  assert.equal(result.consoleErrorCount, 0);
  assert.equal(result.steps.length, 6);
  assert.match(result.metadata.session, /^aos-[a-z0-9]+$/);
  assert.ok(result.metadata.session.length <= 16);
  assert.deepEqual(
    result.steps.map((step) => step.command),
    [
      `playwright-cli-test --session ${result.metadata.session} open http://127.0.0.1:5173/#sources`,
      `playwright-cli-test --session ${result.metadata.session} resize 1440 900`,
      `playwright-cli-test --session ${result.metadata.session} snapshot`,
      `playwright-cli-test --session ${result.metadata.session} screenshot`,
      `playwright-cli-test --session ${result.metadata.session} console error`,
      `playwright-cli-test session-stop ${result.metadata.session}`
    ]
  );
  assert.deepEqual(result.metadata.missingArtifacts, []);
  assert.equal(result.metadata.artifactValidationStatus, "ok");
});

test("browser bridge check can run an explicit Playwright CLI command without global discovery", () => {
  const oldCommand = process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  delete process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-browser-bridge-explicit-cli-"));
  const explicitCli = join(tempRoot, "explicit-playwright.sh");
  const screenshot = join(tempRoot, "screen.png");
  const consoleLog = join(tempRoot, "console.log");
  writeFileSync(consoleLog, "");
  writeFileSync(
    explicitCli,
    `#!/bin/sh
set -eu
case " $* " in
  *" snapshot "*) printf '%s\\n' "explicit snapshot";;
  *" screenshot "*) printf '%s' 'png' > "${screenshot}"; printf '%s\\n' '### Result' '- [Screenshot of viewport](${screenshot})';;
  *" console error "*) printf '%s\\n' '### Result' '- [Console](${consoleLog})';;
  *) printf '%s\\n' ok;;
esac
`,
    "utf8"
  );
  chmodSync(explicitCli, 0o755);

  const result = runLocalBrowserBridgeCheck({
    command: explicitCli,
    targetUrl: "http://127.0.0.1:5173/#sources",
    artifactRoot: tempRoot,
    now: () => new Date("2026-06-06T01:00:00.000Z")
  });

  if (oldCommand === undefined) {
    delete process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  } else {
    process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = oldCommand;
  }

  assert.equal(result.status, "ok");
  assert.equal(result.screenshotPath, screenshot);
  assert.equal(result.consolePath, consoleLog);
  assert.ok(result.steps.every((step) => step.command === "artifact validation" || step.command.startsWith(explicitCli)));
  assert.deepEqual(result.metadata.missingArtifacts, []);
});

test("browser bridge check blocks when screenshot or console artifacts are missing", () => {
  const oldCommand = process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  const oldSession = process.env.AUTOMATION_OS_BROWSER_CHECK_SESSION;
  process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = "playwright-cli-test";
  delete process.env.AUTOMATION_OS_BROWSER_CHECK_SESSION;
  const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-browser-bridge-missing-"));
  const screenshot = join(tempRoot, "screen.png");
  writeFileSync(screenshot, "png");

  const result = runLocalBrowserBridgeCheck({
    targetUrl: "http://localhost:5173/",
    artifactRoot: tempRoot,
    now: () => new Date("2026-06-06T01:00:00.000Z"),
    runner: (_command, args) => {
      const cliCommand = localBrowserCliAction(args);
      if (cliCommand === "screenshot") return { status: 0, stdout: `### Result\n- [Screenshot of viewport](${screenshot})\n`, stderr: "" };
      if (cliCommand === "console") return { status: 0, stdout: "### Result\nNo console report was linked.\n", stderr: "" };
      return { status: 0, stdout: "ok", stderr: "" };
    }
  });

  if (oldCommand === undefined) {
    delete process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  } else {
    process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = oldCommand;
  }
  if (oldSession === undefined) {
    delete process.env.AUTOMATION_OS_BROWSER_CHECK_SESSION;
  } else {
    process.env.AUTOMATION_OS_BROWSER_CHECK_SESSION = oldSession;
  }

  assert.equal(result.status, "blocked");
  assert.equal(result.screenshotPath, screenshot);
  assert.equal(result.consolePath, null);
  assert.match(result.summary, /artifact が欠落しています: consolePath/);
  assert.deepEqual(result.metadata.missingArtifacts, ["consolePath"]);
  assert.equal(result.metadata.artifactValidationStatus, "blocked");
  const artifactValidation = result.steps.find((step) => step.command === "artifact validation");
  assert.ok(artifactValidation);
  assert.match(artifactValidation.stdout, /missing_artifacts=consolePath/);
  assert.equal(result.steps.at(-1)?.command, `playwright-cli-test session-stop ${result.metadata.session}`);
});

test("browser bridge check async path captures the same proof without spawnSync", async () => {
  const oldCommand = process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = "playwright-cli-test";
  const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-browser-bridge-async-"));
  const screenshot = join(tempRoot, "screen.png");
  const consoleLog = join(tempRoot, "console.log");
  writeFileSync(screenshot, "png");
  writeFileSync(consoleLog, "");
  const calls: string[][] = [];

  const result = await runLocalBrowserBridgeCheckAsync({
    targetUrl: "http://127.0.0.1:5173/#sources",
    artifactRoot: tempRoot,
    now: () => new Date("2026-06-06T01:30:00.000Z"),
    asyncRunner: async (_command, args) => {
      calls.push(args);
      await new Promise((resolve) => setTimeout(resolve, 1));
      const cliCommand = localBrowserCliAction(args);
      if (cliCommand === "screenshot") return { status: 0, stdout: `### Result\n- [Screenshot of viewport](${screenshot})\n`, stderr: "" };
      if (cliCommand === "console") return { status: 0, stdout: `### Result\n- [Console](${consoleLog})\n`, stderr: "" };
      return { status: 0, stdout: "ok", stderr: "" };
    }
  });

  if (oldCommand === undefined) {
    delete process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  } else {
    process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = oldCommand;
  }

  assert.equal(result.status, "ok");
  assert.equal(result.screenshotPath, screenshot);
  assert.ok(result.domPath?.startsWith(tempRoot));
  assert.ok(existsSync(result.domPath ?? ""));
  assert.equal(result.consolePath, consoleLog);
  assert.deepEqual(calls.map(localBrowserCliAction), ["open", "resize", "snapshot", "screenshot", "console", "session-stop"]);
  assert.ok(calls.slice(0, 5).every((args) => args[0] === "--session" && args[1] === result.metadata.session));
  assert.deepEqual(calls.at(-1), ["session-stop", result.metadata.session]);
});

test("browser bridge check async path reports timed out CLI commands as blocked", async () => {
  const oldCommand = process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  const oldTimeout = process.env.AUTOMATION_OS_BROWSER_CHECK_TIMEOUT_MS;
  const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-browser-bridge-timeout-"));
  const slowCli = join(tempRoot, "slow-playwright.sh");
  writeFileSync(slowCli, "#!/bin/sh\nsleep 2\nprintf '%s\\n' late\n", "utf8");
  chmodSync(slowCli, 0o755);
  process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = slowCli;
  process.env.AUTOMATION_OS_BROWSER_CHECK_TIMEOUT_MS = "50";

  const result = await runLocalBrowserBridgeCheckAsync({
    targetUrl: "http://127.0.0.1:5173/#sources",
    artifactRoot: tempRoot,
    now: () => new Date("2026-06-06T01:45:00.000Z")
  });

  if (oldCommand === undefined) {
    delete process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  } else {
    process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = oldCommand;
  }
  if (oldTimeout === undefined) {
    delete process.env.AUTOMATION_OS_BROWSER_CHECK_TIMEOUT_MS;
  } else {
    process.env.AUTOMATION_OS_BROWSER_CHECK_TIMEOUT_MS = oldTimeout;
  }

  assert.equal(result.status, "blocked");
  assert.equal(result.steps[0]?.status, 124);
  assert.match(result.steps[0]?.stderr ?? "", /command timed out after 50ms/);
});

test("browser bridge check async path honors timeout from env override", async () => {
  const oldCommand = process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  const oldTimeout = process.env.AUTOMATION_OS_BROWSER_CHECK_TIMEOUT_MS;
  const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-browser-bridge-env-timeout-"));
  const slowCli = join(tempRoot, "slow-playwright-env.sh");
  writeFileSync(slowCli, "#!/bin/sh\nsleep 2\nprintf '%s\\n' late\n", "utf8");
  chmodSync(slowCli, 0o755);
  process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = slowCli;
  delete process.env.AUTOMATION_OS_BROWSER_CHECK_TIMEOUT_MS;

  const result = await runLocalBrowserBridgeCheckAsync({
    targetUrl: "http://127.0.0.1:5173/#sources",
    artifactRoot: tempRoot,
    now: () => new Date("2026-06-06T01:47:00.000Z"),
    env: { AUTOMATION_OS_BROWSER_CHECK_TIMEOUT_MS: "50" }
  });

  if (oldCommand === undefined) {
    delete process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  } else {
    process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = oldCommand;
  }
  if (oldTimeout === undefined) {
    delete process.env.AUTOMATION_OS_BROWSER_CHECK_TIMEOUT_MS;
  } else {
    process.env.AUTOMATION_OS_BROWSER_CHECK_TIMEOUT_MS = oldTimeout;
  }

  assert.equal(result.status, "blocked");
  assert.equal(result.steps[0]?.status, 124);
  assert.match(result.steps[0]?.stderr ?? "", /command timed out after 50ms/);
});

test("browser bridge check async path keeps stubborn timed out CLI commands bounded", async () => {
  const oldCommand = process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  const oldTimeout = process.env.AUTOMATION_OS_BROWSER_CHECK_TIMEOUT_MS;
  const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-browser-bridge-sigkill-"));
  const stubbornCli = join(tempRoot, "stubborn-playwright.sh");
  const screenshot = join(tempRoot, "screen.png");
  const consoleLog = join(tempRoot, "console.log");
  writeFileSync(consoleLog, "");
  writeFileSync(
    stubbornCli,
    `#!/bin/sh
set -eu
case " $* " in
  *" open "*) trap '' TERM; printf '%s\\n' ready; while :; do sleep 1 || true; done;;
  *" screenshot "*) printf '%s' 'png' > "${screenshot}"; printf '%s\\n' '### Result' '- [Screenshot of viewport](${screenshot})';;
  *" console "*) printf '%s\\n' '### Result' '- [Console](${consoleLog})';;
  *) printf '%s\\n' ok;;
esac
`,
    "utf8"
  );
  chmodSync(stubbornCli, 0o755);
  process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = stubbornCli;
  process.env.AUTOMATION_OS_BROWSER_CHECK_TIMEOUT_MS = "500";

  const started = Date.now();
  const result = await runLocalBrowserBridgeCheckAsync({
    targetUrl: "http://127.0.0.1:5173/#sources",
    artifactRoot: tempRoot,
    now: () => new Date("2026-06-06T01:50:00.000Z")
  });
  const elapsedMs = Date.now() - started;

  if (oldCommand === undefined) {
    delete process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  } else {
    process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = oldCommand;
  }
  if (oldTimeout === undefined) {
    delete process.env.AUTOMATION_OS_BROWSER_CHECK_TIMEOUT_MS;
  } else {
    process.env.AUTOMATION_OS_BROWSER_CHECK_TIMEOUT_MS = oldTimeout;
  }

  assert.equal(result.status, "blocked");
  assert.equal(result.steps[0]?.status, 124);
  assert.match(result.steps[0]?.stderr ?? "", /command timed out after 500ms/);
  assert.ok(elapsedMs < 6000, `expected force kill path to stay bounded, elapsed=${elapsedMs}ms`);
});

test("browser bridge check uses a generated short session for every CLI command and cleanup", () => {
  const oldCommand = process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  const oldSession = process.env.AUTOMATION_OS_BROWSER_CHECK_SESSION;
  process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = "playwright-cli-test";
  process.env.AUTOMATION_OS_BROWSER_CHECK_SESSION = "custom-browser-check-session";
  const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-browser-bridge-session-"));
  const screenshot = join(tempRoot, "screen.png");
  const consoleLog = join(tempRoot, "console.log");
  writeFileSync(screenshot, "png");
  writeFileSync(consoleLog, "");
  const calls: string[][] = [];

  const result = runLocalBrowserBridgeCheck({
    targetUrl: "http://127.0.0.1:5173/",
    artifactRoot: tempRoot,
    now: () => new Date("2026-06-06T02:00:00.000Z"),
    runner: (_command, args) => {
      calls.push(args);
      const cliCommand = localBrowserCliAction(args);
      if (cliCommand === "screenshot") return { status: 0, stdout: `### Result\n- [Screenshot of viewport](${screenshot})\n`, stderr: "" };
      if (cliCommand === "console") return { status: 0, stdout: `### Result\n- [Console](${consoleLog})\n`, stderr: "" };
      return { status: 0, stdout: "ok", stderr: "" };
    }
  });

  if (oldCommand === undefined) {
    delete process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  } else {
    process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = oldCommand;
  }
  if (oldSession === undefined) {
    delete process.env.AUTOMATION_OS_BROWSER_CHECK_SESSION;
  } else {
    process.env.AUTOMATION_OS_BROWSER_CHECK_SESSION = oldSession;
  }

  assert.equal(result.status, "ok");
  assert.match(result.metadata.session, /^aos-[a-z0-9]+$/);
  assert.ok(result.metadata.session.length <= 16);
  assert.notEqual(result.metadata.session, "custom-browser-check-session");
  assert.deepEqual(
    calls.map((args) => args.slice(0, 3)),
    [
      ["--session", result.metadata.session, "open"],
      ["--session", result.metadata.session, "resize"],
      ["--session", result.metadata.session, "snapshot"],
      ["--session", result.metadata.session, "screenshot"],
      ["--session", result.metadata.session, "console"],
      ["session-stop", result.metadata.session]
    ]
  );
  assert.deepEqual(
    result.steps.map((step) => step.command),
    [
      `playwright-cli-test --session ${result.metadata.session} open http://127.0.0.1:5173/`,
      `playwright-cli-test --session ${result.metadata.session} resize 1440 900`,
      `playwright-cli-test --session ${result.metadata.session} snapshot`,
      `playwright-cli-test --session ${result.metadata.session} screenshot`,
      `playwright-cli-test --session ${result.metadata.session} console error`,
      `playwright-cli-test session-stop ${result.metadata.session}`
    ]
  );
  assert.equal(result.steps.at(-1)?.command, `playwright-cli-test session-stop ${result.metadata.session}`);
});

test("browser bridge check generates a unique session per check", () => {
  const oldCommand = process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = "playwright-cli-test";
  const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-browser-bridge-unique-"));
  const screenshot = join(tempRoot, "screen.png");
  const consoleLog = join(tempRoot, "console.log");
  writeFileSync(screenshot, "png");
  writeFileSync(consoleLog, "");

  const results = Array.from({ length: 3 }, () =>
    runLocalBrowserBridgeCheck({
      targetUrl: "http://127.0.0.1:5173/",
      artifactRoot: tempRoot,
      now: () => new Date("2026-06-06T02:15:00.000Z"),
      runner: (_command, args) => {
        const cliCommand = localBrowserCliAction(args);
        if (cliCommand === "screenshot") return { status: 0, stdout: `### Result\n- [Screenshot of viewport](${screenshot})\n`, stderr: "" };
        if (cliCommand === "console") return { status: 0, stdout: `### Result\n- [Console](${consoleLog})\n`, stderr: "" };
        return { status: 0, stdout: cliCommand === "session-stop" ? "stopped" : "ok", stderr: "" };
      }
    })
  );

  if (oldCommand === undefined) {
    delete process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  } else {
    process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = oldCommand;
  }

  assert.equal(new Set(results.map((result) => result.metadata.session)).size, 3);
  for (const result of results) {
    assert.equal(result.status, "ok");
    assert.match(result.metadata.session, /^aos-[a-z0-9]+$/);
    assert.ok(result.metadata.session.length <= 16);
    assert.equal(result.steps.at(-1)?.command, `playwright-cli-test session-stop ${result.metadata.session}`);
  }
});

test("browser bridge check blocks when stopping the generated session fails", () => {
  const oldCommand = process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = "playwright-cli-test";
  const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-browser-bridge-close-fail-"));
  const screenshot = join(tempRoot, "screen.png");
  const consoleLog = join(tempRoot, "console.log");
  writeFileSync(screenshot, "png");
  writeFileSync(consoleLog, "");
  const calls: string[][] = [];

  const result = runLocalBrowserBridgeCheck({
    targetUrl: "http://127.0.0.1:5173/",
    artifactRoot: tempRoot,
    now: () => new Date("2026-06-06T02:30:00.000Z"),
    runner: (_command, args) => {
      calls.push(args);
      const cliCommand = localBrowserCliAction(args);
      if (cliCommand === "screenshot") return { status: 0, stdout: `### Result\n- [Screenshot of viewport](${screenshot})\n`, stderr: "" };
      if (cliCommand === "console") return { status: 0, stdout: `### Result\n- [Console](${consoleLog})\n`, stderr: "" };
      if (cliCommand === "session-stop") return { status: 1, stdout: "", stderr: "session busy" };
      return { status: 0, stdout: "ok", stderr: "" };
    }
  });

  if (oldCommand === undefined) {
    delete process.env.AUTOMATION_OS_PLAYWRIGHT_CLI;
  } else {
    process.env.AUTOMATION_OS_PLAYWRIGHT_CLI = oldCommand;
  }

  assert.equal(result.status, "blocked");
  assert.match(result.summary, /Playwright CLI cleanup failed/);
  assert.deepEqual(result.metadata.missingArtifacts, []);
  assert.equal(result.metadata.artifactValidationStatus, "ok");
  assert.deepEqual(calls.map(localBrowserCliAction), ["open", "resize", "snapshot", "screenshot", "console", "session-stop"]);
  assert.equal(result.steps.at(-1)?.command, `playwright-cli-test session-stop ${result.metadata.session}`);
  assert.equal(result.steps.at(-1)?.status, 1);
});

test("browser bridge check blocks remote targets", () => {
  assert.throws(() => validateLocalTargetUrl("https://example.com"), /browser_target_must_be_local/);
});

test("Browser Use local check blocks when screenshot and state exist but recording QA is unavailable", () => {
  const oldCommand = process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  process.env.AUTOMATION_OS_BROWSER_USE_CLI = "browser-use-test";
  const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-browser-use-"));
  const calls: string[][] = [];

  const result = runBrowserUseLocalCheck({
    targetUrl: "http://127.0.0.1:5173/#sources",
    now: () => new Date("2026-06-06T03:00:00.000Z"),
    artifactRoot: tempRoot,
    runner: (_command, args) => {
      calls.push(args);
      const cliCommand = browserUseCliAction(args);
      if (cliCommand === "state") return { status: 0, stdout: "url: http://127.0.0.1:5173/#sources\ntitle: Automation OS\n", stderr: "" };
      if (cliCommand === "screenshot") {
        writeFileSync(String(args.at(-1)), "png");
        return { status: 0, stdout: "saved screenshot\n", stderr: "" };
      }
      if (cliCommand === "close") return { status: 0, stdout: "closed", stderr: "" };
      return { status: 0, stdout: "opened", stderr: "" };
    }
  });

  if (oldCommand === undefined) {
    delete process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  } else {
    process.env.AUTOMATION_OS_BROWSER_USE_CLI = oldCommand;
  }

  assert.equal(result.status, "blocked");
  assert.equal(result.driver, "browser_use_cli");
  assert.match(result.summary, /browser_use_recording_requires_cdp_lane/);
  assert.match(result.metadata.session, /^browser-use-check-2026-06-06t03-00-00-000z-[a-z0-9]+$/);
  assert.ok(result.screenshotPath?.endsWith("/screenshot.png"));
  assert.equal(result.recordingPath, null);
  assert.equal(result.geminiQaPath, null);
  assert.ok(existsSync(result.screenshotPath ?? ""));
  assert.ok(result.statePath);
  assert.ok(result.logPath);
  assert.ok(existsSync(result.statePath));
  assert.ok(existsSync(result.logPath));
  assert.match(readFileSync(result.statePath, "utf8"), /url: http:\/\/127\.0\.0\.1:5173\/#sources/);
  assert.match(readFileSync(result.logPath, "utf8"), /current_url=http:\/\/127\.0\.0\.1:5173\/#sources/);
  assert.match(readFileSync(result.logPath, "utf8"), /current_title=Automation OS/);
  assert.match(readFileSync(result.logPath, "utf8"), /driver=browser_use_cli/);
  assert.deepEqual(calls.map(browserUseCliAction), ["open", "state", "screenshot", "close"]);
  assert.ok(calls.every((args) => args[0] === "--session" && args[1] === result.metadata.session));
  assert.equal(calls[2]?.at(-1), result.screenshotPath);
  assert.equal(result.metadata.geminiVideoQa.status, "blocked");
  assert.equal(result.metadata.geminiVideoQa.completionVetoOnly, true);
  assert.equal(result.metadata.geminiVideoQa.exactBlocker, "browser_use_recording_requires_cdp_lane");
  assert.deepEqual(result.metadata.missingArtifacts, ["recordingQa"]);
  assert.equal(result.metadata.artifactValidationStatus, "blocked");
  assert.equal(result.metadata.recordingQa.status, "blocked");
  assert.equal(result.metadata.recordingQa.reason, "browser_use_recording_requires_cdp_lane");
  assert.equal(result.metadata.recordingQa.plannedVideoPath, null);
  assert.ok(result.metadata.recordingQa.manifestPath?.endsWith("/recording-qa-manifest.json"));
  assert.ok(existsSync(result.metadata.recordingQa.manifestPath ?? ""));
  assert.equal(result.metadata.connectionStrategy.mode, "unique_session");
  assert.equal(result.metadata.connectionStrategy.cdpUrl, null);
  assert.equal(result.metadata.connectionStrategy.profile, null);
  assert.equal(result.metadata.profileIsolation.status, "session_only");
  assert.deepEqual(result.metadata.cleanup, {
    attempted: true,
    status: "ok",
    reason: "unique_session_closed",
    command: `browser-use-test --session ${result.metadata.session} close`
  });
});

test("Browser Use local check can attach to a CDP/profile lane through options", () => {
  const oldCommand = process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  process.env.AUTOMATION_OS_BROWSER_USE_CLI = "browser-use-test";
  const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-browser-use-cdp-"));
  const profile = join(tempRoot, "profile");
  const calls: string[][] = [];

  const result = runBrowserUseLocalCheck({
    targetUrl: "http://127.0.0.1:5173/#sources",
    now: () => new Date("2026-06-06T03:30:00.000Z"),
    artifactRoot: tempRoot,
    cdpPort: 9444,
    profile,
    runner: (_command, args) => {
      calls.push(args);
      const cliCommand = browserUseCliAction(args);
      if (cliCommand === "state") return { status: 0, stdout: "url: http://127.0.0.1:5173/#sources\n", stderr: "" };
      if (cliCommand === "screenshot") {
        writeFileSync(String(args.at(-1)), "png");
        return { status: 0, stdout: "saved screenshot\n", stderr: "" };
      }
      return { status: 0, stdout: "opened", stderr: "" };
    }
  });

  if (oldCommand === undefined) {
    delete process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  } else {
    process.env.AUTOMATION_OS_BROWSER_USE_CLI = oldCommand;
  }

  assert.equal(result.status, "blocked");
  assert.match(result.summary, /browser_use_recording_sidecar_not_configured/);
  assert.equal(result.metadata.connectionStrategy.mode, "cdp_profile_lane");
  assert.equal(result.metadata.connectionStrategy.cdpUrl, "http://127.0.0.1:9444");
  assert.equal(result.metadata.connectionStrategy.profile, profile);
  assert.equal(result.metadata.profileIsolation.status, "cdp_profile_lane");
  assert.ok(calls.every((args) => args.includes("--cdp-url") && args.includes("http://127.0.0.1:9444")));
  assert.ok(calls.every((args) => args.includes("--profile") && args.includes(profile)));
  assert.equal(calls.some((args) => args.includes("close")), true);
  assert.equal(result.metadata.recordingQa.status, "blocked");
  assert.equal(result.metadata.recordingQa.reason, "browser_use_recording_recorder_unavailable");
  assert.ok(result.metadata.recordingQa.plannedVideoPath?.endsWith("/recording.mp4"));
  assert.ok(result.metadata.recordingQa.manifestPath?.endsWith("/recording-qa-manifest.json"));
  assert.ok(existsSync(result.metadata.recordingQa.manifestPath ?? ""));
  assert.match(readFileSync(result.metadata.recordingQa.manifestPath ?? "", "utf8"), /cdp_screencast_recorder/);
  assert.deepEqual(result.metadata.missingArtifacts, ["recordingQa", "recordingSidecar"]);
  assert.deepEqual(result.metadata.recordingSidecar, {
    attempted: false,
    status: "skipped",
    reason: "browser_use_recording_sidecar_not_configured",
    exactBlocker: null,
    targetUrl: "http://127.0.0.1:5173/#sources",
    targetPageUrl: null,
    command: null
  });
  assert.equal(result.metadata.artifactValidationStatus, "blocked");
  assert.deepEqual(result.metadata.cleanup, {
    attempted: true,
    status: "ok",
    reason: "cdp_profile_lane_session_closed",
    command: `browser-use-test --session ${result.metadata.session} --cdp-url http://127.0.0.1:9444 --profile ${profile} close`
  });
});

test("Browser Use local check completes when a CDP recording and passing Gemini QA sidecar are present", () => {
  const oldCommand = process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  process.env.AUTOMATION_OS_BROWSER_USE_CLI = "browser-use-test";
  const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-browser-use-sidecar-ok-"));
  const profile = join(tempRoot, "profile");
  const calls: Array<{ command: string; args: string[] }> = [];

  const result = runBrowserUseLocalCheck({
    targetUrl: "http://127.0.0.1:5173/#sources",
    now: () => new Date("2026-06-06T03:35:00.000Z"),
    artifactRoot: tempRoot,
    cdpPort: 9445,
    profile,
    recordingSidecarCommand: "browser-use-recording-sidecar-test",
    runner: (command, args) => {
      calls.push({ command, args });
      if (command === "browser-use-recording-sidecar-test") {
        const recordingPath = String(args[args.indexOf("--recording") + 1]);
        const geminiQaPath = String(args[args.indexOf("--gemini-qa") + 1]);
        writeFileSync(recordingPath, "mp4");
        writeFileSync(
          geminiQaPath,
          `${JSON.stringify({
            provider: "gemini",
            kind: "gemini_video_qa",
            status: "passed",
            verdict: "pass",
            completion_gate_alignment: "aligned",
            completion_gate_matches: true,
            video_artifact_uri: recordingPath,
            target_url: "http://127.0.0.1:5173/#sources"
          })}\n`,
          "utf8"
        );
        return { status: 0, stdout: "recorded\n", stderr: "" };
      }
      const cliCommand = browserUseCliAction(args);
      if (cliCommand === "state") return { status: 0, stdout: "url: http://127.0.0.1:5173/#sources\n", stderr: "" };
      if (cliCommand === "screenshot") {
        const screenshotPath = String(args.at(-1));
        writeFileSync(screenshotPath, "png");
        return { status: 0, stdout: "saved screenshot\n", stderr: "" };
      }
      return { status: 0, stdout: "opened", stderr: "" };
    }
  });

  if (oldCommand === undefined) {
    delete process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  } else {
    process.env.AUTOMATION_OS_BROWSER_USE_CLI = oldCommand;
  }

  assert.equal(result.status, "ok");
  assert.equal(result.recordingPath?.endsWith("/recording.mp4"), true);
  assert.equal(result.geminiQaPath?.endsWith("/gemini-video-qa.json"), true);
  assert.deepEqual(result.metadata.missingArtifacts, []);
  assert.equal(result.metadata.artifactValidationStatus, "ok");
  assert.equal(result.metadata.recordingQa.status, "present");
  assert.equal(result.metadata.recordingQa.reason, null);
  assert.equal(result.metadata.recordingQa.recorderStatus, "captured");
  const manifest = JSON.parse(readFileSync(result.metadata.recordingQa.manifestPath ?? "", "utf8")) as {
    recordingQa: { status: string; reason: string | null; recorderStatus: string; artifactUri: string | null; videoArtifactUri: string | null };
  };
  assert.equal(manifest.recordingQa.status, "present");
  assert.equal(manifest.recordingQa.reason, null);
  assert.equal(manifest.recordingQa.recorderStatus, "captured");
  assert.equal(manifest.recordingQa.artifactUri?.endsWith("/gemini-video-qa.json"), true);
  assert.equal(manifest.recordingQa.videoArtifactUri?.endsWith("/recording.mp4"), true);
  assert.equal(result.metadata.geminiVideoQa.status, "present");
  assert.equal(result.metadata.geminiVideoQa.exactBlocker, null);
  assert.deepEqual(result.metadata.recordingSidecar, {
    attempted: true,
    status: "ok",
    reason: "browser_use_recording_sidecar_completed",
    exactBlocker: null,
    targetUrl: "http://127.0.0.1:5173/#sources",
    targetPageUrl: null,
    command: `browser-use-recording-sidecar-test --manifest ${result.metadata.recordingQa.manifestPath} --recording ${result.recordingPath} --gemini-qa ${result.geminiQaPath} --target-url http://127.0.0.1:5173/#sources --session ${result.metadata.session} --cdp-url http://127.0.0.1:9445 --profile ${profile}`
  });
  assert.deepEqual(
    calls.map((call) => (call.command === "browser-use-recording-sidecar-test" ? "recording-sidecar" : browserUseCliAction(call.args))),
    ["open", "state", "screenshot", "recording-sidecar", "close"]
  );
  assert.deepEqual(result.metadata.cleanup, {
    attempted: true,
    status: "ok",
    reason: "cdp_profile_lane_session_closed",
    command: `browser-use-test --session ${result.metadata.session} --cdp-url http://127.0.0.1:9445 --profile ${profile} close`
  });
});

test("Browser Use recording sidecar retries CDP version and target list startup races", async () => {
  const oldAttempts = process.env.AUTOMATION_OS_BROWSER_USE_CDP_RETRY_ATTEMPTS;
  const oldBackoff = process.env.AUTOMATION_OS_BROWSER_USE_CDP_RETRY_BACKOFF_MS;
  const originalFetch = globalThis.fetch;
  process.env.AUTOMATION_OS_BROWSER_USE_CDP_RETRY_ATTEMPTS = "3";
  process.env.AUTOMATION_OS_BROWSER_USE_CDP_RETRY_BACKOFF_MS = "1";
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/json/version") && calls.filter((call) => call.endsWith("/json/version")).length === 1) {
      return new Response("starting", { status: 503 });
    }
    if (url.endsWith("/json/list") && calls.filter((call) => call.endsWith("/json/list")).length === 1) {
      return new Response("[]", { status: 503 });
    }
    if (url.endsWith("/json/version")) {
      return Response.json({ Browser: "Chrome" });
    }
    if (url.endsWith("/json/list")) {
      return Response.json([
        {
          id: "target-1",
          type: "page",
          url: "http://127.0.0.1:5173/#sources",
          title: "Automation OS",
          webSocketDebuggerUrl: "ws://127.0.0.1:9445/devtools/page/target-1"
        }
      ]);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    const target = await findCdpTarget("http://127.0.0.1:9445", "http://127.0.0.1:5173/#sources");
    assert.equal(target.id, "target-1");
    assert.equal(target.webSocketDebuggerUrl, "ws://127.0.0.1:9445/devtools/page/target-1");
    assert.deepEqual(calls, [
      "http://127.0.0.1:9445/json/version",
      "http://127.0.0.1:9445/json/version",
      "http://127.0.0.1:9445/json/list",
      "http://127.0.0.1:9445/json/list"
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (oldAttempts === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_CDP_RETRY_ATTEMPTS;
    else process.env.AUTOMATION_OS_BROWSER_USE_CDP_RETRY_ATTEMPTS = oldAttempts;
    if (oldBackoff === undefined) delete process.env.AUTOMATION_OS_BROWSER_USE_CDP_RETRY_BACKOFF_MS;
    else process.env.AUTOMATION_OS_BROWSER_USE_CDP_RETRY_BACKOFF_MS = oldBackoff;
  }
});

test("Browser Use local check blocks when state URL does not match the requested local target", () => {
  const oldCommand = process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  process.env.AUTOMATION_OS_BROWSER_USE_CLI = "browser-use-test";
  const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-browser-use-state-mismatch-"));

  const result = runBrowserUseLocalCheck({
    targetUrl: "http://127.0.0.1:5173/#sources",
    now: () => new Date("2026-06-06T03:35:30.000Z"),
    artifactRoot: tempRoot,
    runner: (_command, args) => {
      const cliCommand = browserUseCliAction(args);
      if (cliCommand === "state") return { status: 0, stdout: "url: http://127.0.0.1:5173/#other\n", stderr: "" };
      if (cliCommand === "screenshot") {
        writeFileSync(String(args.at(-1)), "png");
        return { status: 0, stdout: "saved screenshot\n", stderr: "" };
      }
      return { status: 0, stdout: "opened", stderr: "" };
    }
  });

  if (oldCommand === undefined) {
    delete process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  } else {
    process.env.AUTOMATION_OS_BROWSER_USE_CLI = oldCommand;
  }

  assert.equal(result.status, "blocked");
  assert.ok(result.metadata.missingArtifacts.includes("stateTargetUrl"));
});

test("Browser Use local check accepts current Browser Use state output without a url line when open confirmed target", () => {
  const oldCommand = process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  process.env.AUTOMATION_OS_BROWSER_USE_CLI = "browser-use-test";
  const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-browser-use-open-url-"));

  const result = runBrowserUseLocalCheck({
    targetUrl: "http://127.0.0.1:5173/#sources",
    now: () => new Date("2026-06-06T03:35:45.000Z"),
    artifactRoot: tempRoot,
    runner: (_command, args) => {
      const cliCommand = browserUseCliAction(args);
      if (cliCommand === "open") return { status: 0, stdout: "url: http://127.0.0.1:5173/#sources\n", stderr: "" };
      if (cliCommand === "state") return { status: 0, stdout: "viewport: 756x469\npage: 756x1200\n", stderr: "" };
      if (cliCommand === "screenshot") {
        writeFileSync(String(args.at(-1)), "png");
        return { status: 0, stdout: "saved screenshot\n", stderr: "" };
      }
      return { status: 0, stdout: "ok", stderr: "" };
    }
  });

  if (oldCommand === undefined) {
    delete process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  } else {
    process.env.AUTOMATION_OS_BROWSER_USE_CLI = oldCommand;
  }

  assert.equal(result.status, "blocked");
  assert.ok(!result.metadata.missingArtifacts.includes("stateTargetUrl"));
  assert.deepEqual(result.metadata.missingArtifacts, ["recordingQa"]);
});

test("Browser Use local check blocks when Gemini QA sidecar points at a different recording", () => {
  const oldCommand = process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  process.env.AUTOMATION_OS_BROWSER_USE_CLI = "browser-use-test";
  const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-browser-use-sidecar-mismatch-"));

  const result = runBrowserUseLocalCheck({
    targetUrl: "http://127.0.0.1:5173/#sources",
    now: () => new Date("2026-06-06T03:36:00.000Z"),
    artifactRoot: tempRoot,
    cdpPort: 9446,
    profile: join(tempRoot, "profile"),
    runner: (_command, args) => {
      const cliCommand = browserUseCliAction(args);
      if (cliCommand === "state") return { status: 0, stdout: "url: http://127.0.0.1:5173/#sources\n", stderr: "" };
      if (cliCommand === "screenshot") {
        const screenshotPath = String(args.at(-1));
        const artifactDir = dirname(screenshotPath);
        writeFileSync(screenshotPath, "png");
        writeFileSync(join(artifactDir, "recording.mp4"), "mp4");
        writeFileSync(
          join(artifactDir, "gemini-video-qa.json"),
          `${JSON.stringify({
            provider: "gemini",
            kind: "gemini_video_qa",
            status: "passed",
            verdict: "pass",
            completion_gate_alignment: "aligned",
            completion_gate_matches: true,
            video_artifact_uri: join(tempRoot, "other-run", "recording.mp4")
          })}\n`,
          "utf8"
        );
        return { status: 0, stdout: "saved screenshot\n", stderr: "" };
      }
      return { status: 0, stdout: "opened", stderr: "" };
    }
  });

  if (oldCommand === undefined) {
    delete process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  } else {
    process.env.AUTOMATION_OS_BROWSER_USE_CLI = oldCommand;
  }

  assert.equal(result.status, "blocked");
  assert.equal(result.recordingPath, null);
  assert.equal(result.geminiQaPath, null);
  assert.equal(result.metadata.recordingQa.status, "blocked");
  assert.equal(result.metadata.recordingQa.reason, "browser_use_gemini_video_qa_video_mismatch");
  const manifest = JSON.parse(readFileSync(result.metadata.recordingQa.manifestPath ?? "", "utf8")) as {
    recordingQa: { status: string; reason: string | null; recorderStatus: string };
  };
  assert.equal(manifest.recordingQa.status, "blocked");
  assert.equal(manifest.recordingQa.reason, "browser_use_gemini_video_qa_video_mismatch");
  assert.equal(manifest.recordingQa.recorderStatus, "planned");
  assert.equal(result.metadata.geminiVideoQa.exactBlocker, "browser_use_gemini_video_qa_video_mismatch");
  assert.deepEqual(result.metadata.missingArtifacts, ["recordingQa", "recordingSidecar"]);
});

test("Browser Use local check blocks when Gemini QA target_url points at a different local target", () => {
  const oldCommand = process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  process.env.AUTOMATION_OS_BROWSER_USE_CLI = "browser-use-test";
  const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-browser-use-gemini-target-mismatch-"));

  const result = runBrowserUseLocalCheck({
    targetUrl: "http://127.0.0.1:5173/#sources",
    now: () => new Date("2026-06-06T03:36:10.000Z"),
    artifactRoot: tempRoot,
    cdpPort: 9446,
    profile: join(tempRoot, "profile"),
    recordingSidecarCommand: "browser-use-recording-sidecar-test",
    runner: (_command, args) => {
      const cliCommand = browserUseCliAction(args);
      if (cliCommand === "state") return { status: 0, stdout: "url: http://127.0.0.1:5173/#sources\n", stderr: "" };
      if (cliCommand === "screenshot") {
        writeFileSync(String(args.at(-1)), "png");
        return { status: 0, stdout: "saved screenshot\n", stderr: "" };
      }
      if (String(_command) === "browser-use-recording-sidecar-test") {
        const recordingPath = String(args[args.indexOf("--recording") + 1]);
        const geminiQaPath = String(args[args.indexOf("--gemini-qa") + 1]);
        writeFileSync(recordingPath, "mp4");
        writeFileSync(
          geminiQaPath,
          `${JSON.stringify({
            provider: "gemini",
            kind: "gemini_video_qa",
            status: "passed",
            verdict: "pass",
            completion_gate_alignment: "aligned",
            completion_gate_matches: true,
            video_artifact_uri: recordingPath,
            target_url: "http://127.0.0.1:5173/#wrong"
          })}\n`,
          "utf8"
        );
        return { status: 0, stdout: "recorded\n", stderr: "" };
      }
      return { status: 0, stdout: "opened", stderr: "" };
    }
  });

  if (oldCommand === undefined) {
    delete process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  } else {
    process.env.AUTOMATION_OS_BROWSER_USE_CLI = oldCommand;
  }

  assert.equal(result.status, "blocked");
  assert.equal(result.recordingPath, null);
  assert.equal(result.geminiQaPath, null);
  assert.equal(result.metadata.recordingQa.status, "blocked");
  assert.equal(result.metadata.recordingQa.reason, "browser_use_gemini_video_qa_completion_mismatch");
  assert.equal(result.metadata.geminiVideoQa.exactBlocker, "browser_use_gemini_video_qa_completion_mismatch");
});

test("Browser Use local check preserves recording sidecar exactBlocker on blocked sidecars", () => {
  const oldCommand = process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  process.env.AUTOMATION_OS_BROWSER_USE_CLI = "browser-use-test";
  const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-browser-use-sidecar-exact-blocker-"));

  const result = runBrowserUseLocalCheck({
    targetUrl: "http://127.0.0.1:5173/#sources",
    now: () => new Date("2026-06-06T03:36:20.000Z"),
    artifactRoot: tempRoot,
    cdpPort: 9447,
    profile: join(tempRoot, "profile"),
    recordingSidecarCommand: "browser-use-recording-sidecar-test",
    runner: (_command, args) => {
      const cliCommand = browserUseCliAction(args);
      if (cliCommand === "state") return { status: 0, stdout: "url: http://127.0.0.1:5173/#sources\n", stderr: "" };
      if (cliCommand === "screenshot") {
        writeFileSync(String(args.at(-1)), "png");
        return { status: 0, stdout: "saved screenshot\n", stderr: "" };
      }
      if (String(_command) === "browser-use-recording-sidecar-test") {
        const manifestPath = String(args[args.indexOf("--manifest") + 1]);
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        writeFileSync(
          manifestPath,
          `${JSON.stringify(
            {
              ...manifest,
              recordingSidecar: {
                status: "blocked",
                reason: "generic_recorder_unavailable",
                exactBlocker: "browser_use_recording_cdp_target_mismatch",
                targetUrl: "http://127.0.0.1:5173/#sources",
                targetPageUrl: "http://127.0.0.1:5173/#wrong"
              }
            },
            null,
            2
          )}\n`,
          "utf8"
        );
        return { status: 2, stdout: "", stderr: "target mismatch\n" };
      }
      return { status: 0, stdout: "opened", stderr: "" };
    }
  });

  if (oldCommand === undefined) {
    delete process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  } else {
    process.env.AUTOMATION_OS_BROWSER_USE_CLI = oldCommand;
  }

  assert.equal(result.status, "blocked");
  assert.equal(result.metadata.recordingSidecar.status, "blocked");
  assert.equal(result.metadata.recordingSidecar.reason, "browser_use_recording_cdp_target_mismatch");
  assert.equal(result.metadata.recordingSidecar.exactBlocker, "browser_use_recording_cdp_target_mismatch");
  assert.equal(result.metadata.recordingSidecar.targetPageUrl, "http://127.0.0.1:5173/#wrong");
  assert.equal(result.metadata.geminiVideoQa.exactBlocker, "browser_use_recording_recorder_unavailable");
});

for (const exactBlocker of ["browser_use_gemini_video_qa_runner_missing", "browser_use_gemini_video_qa_runner_failed"] as const) {
  test(`Browser Use local check preserves Gemini QA exact blocker ${exactBlocker}`, () => {
    const oldCommand = process.env.AUTOMATION_OS_BROWSER_USE_CLI;
    process.env.AUTOMATION_OS_BROWSER_USE_CLI = "browser-use-test";
    const tempRoot = mkdtempSync(join(tmpdir(), `automation-os-browser-use-${exactBlocker}-`));

    const result = runBrowserUseLocalCheck({
      targetUrl: "http://127.0.0.1:5173/#sources",
      now: () => new Date("2026-06-06T03:37:00.000Z"),
      artifactRoot: tempRoot,
      cdpPort: 9447,
      profile: join(tempRoot, "profile"),
      runner: (_command, args) => {
        const cliCommand = browserUseCliAction(args);
        if (cliCommand === "state") return { status: 0, stdout: "url: http://127.0.0.1:5173/#sources\n", stderr: "" };
        if (cliCommand === "screenshot") {
          const screenshotPath = String(args.at(-1));
          const artifactDir = dirname(screenshotPath);
          const recordingPath = join(artifactDir, "recording.mp4");
          writeFileSync(screenshotPath, "png");
          writeFileSync(recordingPath, "mp4");
          writeFileSync(
            join(artifactDir, "gemini-video-qa.json"),
            `${JSON.stringify({
              provider: "gemini",
              kind: "gemini_video_qa",
              status: "blocked",
              verdict: "blocked",
              completion_gate_alignment: "blocked",
              completion_gate_matches: false,
              exact_blocker: exactBlocker,
              video_artifact_uri: recordingPath
            })}\n`,
            "utf8"
          );
          return { status: 0, stdout: "saved screenshot\n", stderr: "" };
        }
        return { status: 0, stdout: "opened", stderr: "" };
      }
    });

    if (oldCommand === undefined) {
      delete process.env.AUTOMATION_OS_BROWSER_USE_CLI;
    } else {
      process.env.AUTOMATION_OS_BROWSER_USE_CLI = oldCommand;
    }

    assert.equal(result.status, "blocked");
    assert.equal(result.geminiQaPath, null);
    assert.equal(result.metadata.recordingQa.status, "blocked");
    assert.equal(result.metadata.recordingQa.reason, exactBlocker);
    assert.equal(result.metadata.geminiVideoQa.exactBlocker, exactBlocker);
    const manifest = JSON.parse(readFileSync(result.metadata.recordingQa.manifestPath ?? "", "utf8")) as {
      recordingQa: { status: string; reason: string | null; recorderStatus: string };
    };
    assert.equal(manifest.recordingQa.status, "blocked");
    assert.equal(manifest.recordingQa.reason, exactBlocker);
    assert.equal(manifest.recordingQa.recorderStatus, "planned");
  });
}

test("Browser Use local check rounds unknown Gemini QA exact blocker to completion mismatch", () => {
  const oldCommand = process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  process.env.AUTOMATION_OS_BROWSER_USE_CLI = "browser-use-test";
  const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-browser-use-unknown-blocker-"));

  const result = runBrowserUseLocalCheck({
    targetUrl: "http://127.0.0.1:5173/#sources",
    now: () => new Date("2026-06-06T03:38:00.000Z"),
    artifactRoot: tempRoot,
    cdpPort: 9448,
    profile: join(tempRoot, "profile"),
    runner: (_command, args) => {
      const cliCommand = browserUseCliAction(args);
      if (cliCommand === "state") return { status: 0, stdout: "url: http://127.0.0.1:5173/#sources\n", stderr: "" };
      if (cliCommand === "screenshot") {
        const screenshotPath = String(args.at(-1));
        const artifactDir = dirname(screenshotPath);
        const recordingPath = join(artifactDir, "recording.mp4");
        writeFileSync(screenshotPath, "png");
        writeFileSync(recordingPath, "mp4");
        writeFileSync(
          join(artifactDir, "gemini-video-qa.json"),
          `${JSON.stringify({
            provider: "gemini",
            kind: "gemini_video_qa",
            status: "blocked",
            verdict: "blocked",
            completion_gate_alignment: "blocked",
            completion_gate_matches: false,
            exact_blocker: "browser_use_unexpected_new_blocker",
            video_artifact_uri: recordingPath
          })}\n`,
          "utf8"
        );
        return { status: 0, stdout: "saved screenshot\n", stderr: "" };
      }
      return { status: 0, stdout: "opened", stderr: "" };
    }
  });

  if (oldCommand === undefined) {
    delete process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  } else {
    process.env.AUTOMATION_OS_BROWSER_USE_CLI = oldCommand;
  }

  assert.equal(result.status, "blocked");
  assert.equal(result.metadata.recordingQa.reason, "browser_use_gemini_video_qa_completion_mismatch");
  assert.equal(result.metadata.geminiVideoQa.exactBlocker, "browser_use_gemini_video_qa_completion_mismatch");
});

test("Browser Use local check blocks when unique session cleanup fails", () => {
  const oldCommand = process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  process.env.AUTOMATION_OS_BROWSER_USE_CLI = "browser-use-test";
  const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-browser-use-cleanup-fail-"));
  const calls: string[][] = [];

  const result = runBrowserUseLocalCheck({
    targetUrl: "http://127.0.0.1:5173/#sources",
    now: () => new Date("2026-06-06T03:45:00.000Z"),
    artifactRoot: tempRoot,
    runner: (_command, args) => {
      calls.push(args);
      const cliCommand = browserUseCliAction(args);
      if (cliCommand === "state") return { status: 0, stdout: "url: http://127.0.0.1:5173/#sources\n", stderr: "" };
      if (cliCommand === "screenshot") {
        writeFileSync(String(args.at(-1)), "png");
        return { status: 0, stdout: "saved screenshot\n", stderr: "" };
      }
      if (cliCommand === "close") return { status: 1, stdout: "", stderr: "close failed" };
      return { status: 0, stdout: "opened", stderr: "" };
    }
  });

  if (oldCommand === undefined) {
    delete process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  } else {
    process.env.AUTOMATION_OS_BROWSER_USE_CLI = oldCommand;
  }

  assert.equal(result.status, "blocked");
  assert.match(result.summary, /Browser Use cleanup failed/);
  assert.deepEqual(calls.map(browserUseCliAction), ["open", "state", "screenshot", "close"]);
  assert.deepEqual(result.metadata.missingArtifacts, ["recordingQa"]);
  assert.equal(result.metadata.artifactValidationStatus, "blocked");
  assert.equal(result.metadata.recordingQa.reason, "browser_use_recording_requires_cdp_lane");
  assert.deepEqual(result.metadata.cleanup, {
    attempted: true,
    status: "blocked",
    reason: "unique_session_close_failed",
    command: `browser-use-test --session ${result.metadata.session} close`
  });
});

test("Browser Use local check blocks missing CLI but still writes a log artifact", () => {
  const oldCommand = process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  process.env.AUTOMATION_OS_BROWSER_USE_CLI = "";
  const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-browser-use-missing-"));

  const result = runBrowserUseLocalCheck({
    targetUrl: "http://localhost:5173/",
    now: () => new Date("2026-06-06T04:00:00.000Z"),
    artifactRoot: tempRoot
  });

  if (oldCommand === undefined) {
    delete process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  } else {
    process.env.AUTOMATION_OS_BROWSER_USE_CLI = oldCommand;
  }

  assert.equal(result.status, "blocked");
  assert.equal(result.summary, "Browser Use CLI が見つかりません");
  assert.equal(result.screenshotPath, null);
  assert.equal(result.recordingPath, null);
  assert.equal(result.geminiQaPath, null);
  assert.equal(result.statePath, null);
  assert.ok(result.logPath);
  assert.match(readFileSync(result.logPath, "utf8"), /Browser Use CLI が見つかりません/);
  assert.deepEqual(result.metadata.missingArtifacts, ["screenshotPath", "statePath", "recordingQa"]);
  assert.equal(result.metadata.recordingQa.status, "blocked");
  assert.equal(result.metadata.recordingQa.reason, "browser_use_recording_requires_cdp_lane");
  assert.ok(result.metadata.recordingQa.manifestPath?.endsWith("/recording-qa-manifest.json"));
  assert.ok(existsSync(result.metadata.recordingQa.manifestPath ?? ""));
  assert.deepEqual(result.metadata.cleanup, {
    attempted: false,
    status: "skipped",
    reason: "browser_use_cli_missing",
    command: null
  });
});

test("Browser Use async local checks run in parallel while preserving per-check command order", async () => {
  const oldCommand = process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  process.env.AUTOMATION_OS_BROWSER_USE_CLI = "browser-use-test";
  const tempRoot = mkdtempSync(join(tmpdir(), "automation-os-browser-use-async-"));
  const calls: Array<{ label: string; action: string | undefined; session: string | undefined; started: number }> = [];
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const makeRunner = (label: string) => async (_command: string, args: string[]) => {
    const action = browserUseCliAction(args);
    calls.push({ label, action, session: args[1], started: Date.now() });
    await delay(60);
    if (action === "state") return { status: 0, stdout: `url: ${label}\n`, stderr: "" };
    if (action === "screenshot") {
      writeFileSync(String(args.at(-1)), "png");
      return { status: 0, stdout: "saved screenshot\n", stderr: "" };
    }
    return { status: 0, stdout: action === "close" ? "closed" : "opened", stderr: "" };
  };

  const results = await Promise.all(
    ["home", "sources", "lanes"].map((label) =>
      runBrowserUseLocalCheckAsync({
        targetUrl: `http://127.0.0.1:5173/#${label}`,
        now: () => new Date(`2026-06-06T05:00:0${label.length % 3}.000Z`),
        artifactRoot: tempRoot,
        asyncRunner: makeRunner(label)
      })
    )
  );

  if (oldCommand === undefined) {
    delete process.env.AUTOMATION_OS_BROWSER_USE_CLI;
  } else {
    process.env.AUTOMATION_OS_BROWSER_USE_CLI = oldCommand;
  }

  const firstStarts = ["home", "sources", "lanes"].map((label) => {
    const call = calls.find((entry) => entry.label === label && entry.action === "open");
    assert.ok(call, `missing first open call for ${label}`);
    return call.started;
  });
  const startSpread = Math.max(...firstStarts) - Math.min(...firstStarts);
  assert.ok(startSpread < 500, `expected parallel async checks to start together, startSpread=${startSpread}ms`);
  assert.equal(results.length, 3);
  assert.ok(results.every((result) => result.status === "blocked"));
  assert.equal(new Set(results.map((result) => result.metadata.session)).size, 3);
  for (const result of results) {
    assert.deepEqual(
      result.steps.map((step) => browserUseCliAction(step.command.split(" "))),
      ["open", "state", "screenshot", "close"]
    );
    assert.equal(result.metadata.cleanup.status, "ok");
    assert.equal(result.metadata.recordingQa.reason, "browser_use_recording_requires_cdp_lane");
  }
  for (const label of ["home", "sources", "lanes"]) {
    assert.deepEqual(
      calls.filter((call) => call.label === label).map((call) => call.action),
      ["open", "state", "screenshot", "close"]
    );
  }
});

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getBrowserHealth } from "./health.js";
import { redactSensitiveText } from "../obsidian/redaction.js";

export type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

export type CommandRunner = (command: string, args: string[]) => CommandResult;
export type AsyncCommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export type BrowserBridgeCheckResult = {
  id: string;
  kind: "browser_check";
  driver: "playwright_cli";
  status: "ok" | "blocked";
  targetUrl: string;
  summary: string;
  screenshotPath: string | null;
  domPath: string | null;
  consolePath: string | null;
  consoleErrorCount: number;
  createdAt: string;
  steps: Array<{ command: string; status: number | null; stdout: string; stderr: string }>;
  metadata: {
    session: string;
    driver: "playwright_cli";
    domPath?: string | null;
    missingArtifacts: string[];
    artifactValidationStatus: "ok" | "blocked";
  };
};

export type BrowserBridgeCheckOptions = {
  targetUrl?: string;
  command?: string;
  runner?: CommandRunner;
  asyncRunner?: AsyncCommandRunner;
  env?: Record<string, string>;
  artifactRoot?: string;
  now?: () => Date;
};

const defaultTargetUrl = "http://127.0.0.1:5173/#sources";

export function runLocalBrowserBridgeCheck(options: BrowserBridgeCheckOptions = {}): BrowserBridgeCheckResult {
  const now = options.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const id = makeCheckId(createdAt);
  const targetUrl = validateLocalTargetUrl(options.targetUrl ?? process.env.AUTOMATION_OS_BROWSER_CHECK_URL ?? defaultTargetUrl);
  const session = browserCheckSession(id);
  const command = options.command ?? getBrowserHealth().playwrightCli.command;
  if (!command) {
    return {
      id,
      kind: "browser_check",
      driver: "playwright_cli",
      status: "blocked",
      targetUrl,
      summary: "Playwright CLI が見つかりません",
      screenshotPath: null,
      domPath: null,
      consolePath: null,
      consoleErrorCount: 0,
      createdAt,
      steps: [],
      metadata: {
        session,
        driver: "playwright_cli",
        missingArtifacts: ["screenshotPath", "domPath", "consolePath"],
        artifactValidationStatus: "blocked"
      }
    };
  }

  const runner = options.runner ?? ((bin, args) => runCommand(bin, args, options.env));
  const domPath = browserCheckDomPath(id, options.artifactRoot);
  const commands: Array<[string, string[]]> = [
    [command, withBrowserCheckSession(session, ["open", targetUrl])],
    [command, withBrowserCheckSession(session, ["resize", "1440", "900"])],
    [command, withBrowserCheckSession(session, ["snapshot"])],
    [command, withBrowserCheckSession(session, ["screenshot"])],
    [command, withBrowserCheckSession(session, ["console", "error"])]
  ];
  const steps = commands.map(([bin, args]) => {
    const result = runner(bin, args);
    return toStep(bin, args, result);
  });
  const failed = steps.find((step) => step.status !== 0);
  const combinedOutput = steps.map((step) => `${step.stdout}\n${step.stderr}`).join("\n");
  const screenshotPath = latestLinkedPath(combinedOutput, ".png");
  const savedDomPath = saveSnapshotArtifact(steps.find((step) => step.command.endsWith(" snapshot")), domPath);
  const consolePath = latestLinkedPath(combinedOutput, ".log");
  const consoleErrorCount = countConsoleErrors(consolePath);
  const missingArtifacts = [
    screenshotPath ? null : "screenshotPath",
    savedDomPath ? null : "domPath",
    consolePath ? null : "consolePath"
  ].filter((artifact): artifact is string => Boolean(artifact));
  if (missingArtifacts.length > 0) {
    steps.push({
      command: "artifact validation",
      status: 1,
      stdout: `missing_artifacts=${missingArtifacts.join(",")}`,
      stderr: ""
    });
  }
  const cleanup = closeBrowserCheckSession(command, session, runner, steps);
  const cleanupFailed = cleanup.status === "blocked";
  const status = failed || cleanupFailed || missingArtifacts.length > 0 || consoleErrorCount > 0 ? "blocked" : "ok";
  const summary = failed
    ? `Playwright CLI check failed at: ${failed.command}`
    : cleanupFailed
      ? `Playwright CLI cleanup failed at: ${cleanup.command}`
      : missingArtifacts.length > 0
        ? `browser check artifact が欠落しています: ${missingArtifacts.join(", ")}`
        : consoleErrorCount > 0
          ? `${consoleErrorCount}件のconsole errorがあります`
          : "ローカル画面を開いてDOM、スクリーンショット、console確認まで完了しました";

  return {
    id,
    kind: "browser_check",
    driver: "playwright_cli",
    status,
    targetUrl,
    summary,
    screenshotPath,
    domPath: savedDomPath,
    consolePath,
    consoleErrorCount,
    createdAt,
    steps,
    metadata: {
      session,
      driver: "playwright_cli",
      domPath: savedDomPath,
      missingArtifacts,
      artifactValidationStatus: missingArtifacts.length > 0 ? "blocked" : "ok"
    }
  };
}

export async function runLocalBrowserBridgeCheckAsync(options: BrowserBridgeCheckOptions = {}): Promise<BrowserBridgeCheckResult> {
  const now = options.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const id = makeCheckId(createdAt);
  const targetUrl = validateLocalTargetUrl(options.targetUrl ?? process.env.AUTOMATION_OS_BROWSER_CHECK_URL ?? defaultTargetUrl);
  const session = browserCheckSession(id);
  const command = options.command ?? getBrowserHealth().playwrightCli.command;
  if (!command) {
    return {
      id,
      kind: "browser_check",
      driver: "playwright_cli",
      status: "blocked",
      targetUrl,
      summary: "Playwright CLI が見つかりません",
      screenshotPath: null,
      domPath: null,
      consolePath: null,
      consoleErrorCount: 0,
      createdAt,
      steps: [],
      metadata: {
        session,
        driver: "playwright_cli",
        missingArtifacts: ["screenshotPath", "domPath", "consolePath"],
        artifactValidationStatus: "blocked"
      }
    };
  }

  const runner = options.asyncRunner ?? ((bin, args) => runCommandAsync(bin, args, options.env));
  const domPath = browserCheckDomPath(id, options.artifactRoot);
  const commands: Array<[string, string[]]> = [
    [command, withBrowserCheckSession(session, ["open", targetUrl])],
    [command, withBrowserCheckSession(session, ["resize", "1440", "900"])],
    [command, withBrowserCheckSession(session, ["snapshot"])],
    [command, withBrowserCheckSession(session, ["screenshot"])],
    [command, withBrowserCheckSession(session, ["console", "error"])]
  ];
  const steps = [];
  for (const [bin, args] of commands) {
    const result = await runner(bin, args);
    steps.push(toStep(bin, args, result));
  }
  const failed = steps.find((step) => step.status !== 0);
  const combinedOutput = steps.map((step) => `${step.stdout}\n${step.stderr}`).join("\n");
  const screenshotPath = latestLinkedPath(combinedOutput, ".png");
  const savedDomPath = saveSnapshotArtifact(steps.find((step) => step.command.endsWith(" snapshot")), domPath);
  const consolePath = latestLinkedPath(combinedOutput, ".log");
  const consoleErrorCount = countConsoleErrors(consolePath);
  const missingArtifacts = [
    screenshotPath ? null : "screenshotPath",
    savedDomPath ? null : "domPath",
    consolePath ? null : "consolePath"
  ].filter((artifact): artifact is string => Boolean(artifact));
  if (missingArtifacts.length > 0) {
    steps.push({
      command: "artifact validation",
      status: 1,
      stdout: `missing_artifacts=${missingArtifacts.join(",")}`,
      stderr: ""
    });
  }
  const cleanup = await closeBrowserCheckSessionAsync(command, session, runner, steps);
  const cleanupFailed = cleanup.status === "blocked";
  const status = failed || cleanupFailed || missingArtifacts.length > 0 || consoleErrorCount > 0 ? "blocked" : "ok";
  const summary = failed
    ? `Playwright CLI check failed at: ${failed.command}`
    : cleanupFailed
      ? `Playwright CLI cleanup failed at: ${cleanup.command}`
      : missingArtifacts.length > 0
        ? `browser check artifact が欠落しています: ${missingArtifacts.join(", ")}`
        : consoleErrorCount > 0
          ? `${consoleErrorCount}件のconsole errorがあります`
          : "ローカル画面を開いてDOM、スクリーンショット、console確認まで完了しました";

  return {
    id,
    kind: "browser_check",
    driver: "playwright_cli",
    status,
    targetUrl,
    summary,
    screenshotPath,
    domPath: savedDomPath,
    consolePath,
    consoleErrorCount,
    createdAt,
    steps,
    metadata: {
      session,
      driver: "playwright_cli",
      domPath: savedDomPath,
      missingArtifacts,
      artifactValidationStatus: missingArtifacts.length > 0 ? "blocked" : "ok"
    }
  };
}

export function validateLocalTargetUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("browser_target_must_be_local");
  }
  const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (!["http:", "https:"].includes(parsed.protocol) || !localHosts.has(parsed.hostname)) {
    throw new Error("browser_target_must_be_local");
  }
  return parsed.toString();
}

function browserCheckSession(id: string): string {
  const suffix = id
    .split("_")
    .at(-1)
    ?.toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8) || Math.random().toString(36).slice(2, 8);
  return `aos-${suffix}`;
}

function withBrowserCheckSession(session: string, args: string[]): string[] {
  return ["--session", session, ...args];
}

function browserCheckDomPath(id: string, artifactRoot?: string): string {
  return resolve(artifactRoot ?? "data/artifacts/browser-bridge-checks", id, "snapshot.txt");
}

function runCommand(command: string, args: string[], env?: Record<string, string>): CommandResult {
  const mergedEnv = { ...process.env, ...(env ?? {}) };
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: mergedEnv,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: browserCheckTimeoutMs(mergedEnv)
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function runCommandAsync(command: string, args: string[], env?: Record<string, string>): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const mergedEnv = { ...process.env, ...(env ?? {}) };
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: mergedEnv,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const timeoutMs = browserCheckTimeoutMs(mergedEnv);
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolveResult({ status, stdout, stderr });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stderr += `\ncommand timed out after ${timeoutMs}ms`;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 1000);
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += `\n${error.message}`;
      finish(127);
    });
    child.on("close", (status, signal) => {
      finish(status ?? (timedOut || signal ? 124 : null));
    });
  });
}

function browserCheckTimeoutMs(env: NodeJS.ProcessEnv): number {
  const value = Number(env.AUTOMATION_OS_BROWSER_CHECK_TIMEOUT_MS ?? 30000);
  return Number.isFinite(value) && value > 0 ? value : 30000;
}

function closeBrowserCheckSession(
  command: string,
  session: string,
  runner: CommandRunner,
  steps: BrowserBridgeCheckResult["steps"]
): { status: "ok" | "blocked"; command: string } {
  const args = ["session-stop", session];
  const result = runner(command, args);
  const step = toStep(command, args, result);
  steps.push(step);
  return {
    status: result.status === 0 ? "ok" : "blocked",
    command: step.command
  };
}

async function closeBrowserCheckSessionAsync(
  command: string,
  session: string,
  runner: AsyncCommandRunner,
  steps: BrowserBridgeCheckResult["steps"]
): Promise<{ status: "ok" | "blocked"; command: string }> {
  const args = ["session-stop", session];
  const result = await runner(command, args);
  const step = toStep(command, args, result);
  steps.push(step);
  return {
    status: result.status === 0 ? "ok" : "blocked",
    command: step.command
  };
}

function latestLinkedPath(output: string, suffix: string): string | null {
  const matches = [...output.matchAll(/\]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((path) => path.endsWith(suffix));
  const path = matches.at(-1);
  return path ? resolve(process.cwd(), path) : null;
}

export function countConsoleErrors(path: string | null): number {
  if (!path || !existsSync(path)) return 0;
  const lines = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/React DevTools/i.test(line));
  return lines.length;
}

function saveSnapshotArtifact(step: BrowserBridgeCheckResult["steps"][number] | undefined, path: string): string | null {
  if (!step || step.status !== 0 || !step.stdout.trim()) return null;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${redactSensitiveText(step.stdout)}${step.stderr ? `\n${redactSensitiveText(step.stderr)}` : ""}\n`, "utf8");
  return path;
}

function makeCheckId(createdAt: string): string {
  return `check_${createdAt.replace(/[^0-9A-Za-z]+/g, "-")}_${Math.random().toString(36).slice(2, 8)}`;
}

function toStep(command: string, args: string[], result: CommandResult): BrowserBridgeCheckResult["steps"][number] {
  return {
    command: [command, ...args].join(" "),
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

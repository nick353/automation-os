import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveBuiltInBrowserUseScript } from "./browserUseBuiltIns.js";
import { getBrowserHealth } from "./health.js";
import { type CommandResult, type CommandRunner, validateLocalTargetUrl } from "./localCheck.js";

export type BrowserUseLocalCheckResult = {
  id: string;
  kind: "browser_check";
  driver: "browser_use_cli";
  status: "ok" | "blocked";
  targetUrl: string;
  summary: string;
  screenshotPath: string | null;
  recordingPath: string | null;
  geminiQaPath: string | null;
  statePath: string | null;
  logPath: string | null;
  createdAt: string;
  steps: Array<{ command: string; status: number | null; stdout: string; stderr: string }>;
  metadata: {
    session: string;
    driver: "browser_use_cli";
    connectionStrategy: {
      mode: "unique_session" | "cdp_profile_lane";
      session: string;
      cdpUrl: string | null;
      cdpCliUrl?: string | null;
      profile: string | null;
    };
    statePath: string | null;
    screenshotPath: string | null;
    recordingPath: string | null;
    geminiQaPath: string | null;
    logPath: string | null;
    geminiVideoQa: {
      status: "present" | "blocked";
      artifactUri: string | null;
      videoArtifactUri: string | null;
      completionVetoOnly: true;
      exactBlocker: string | null;
    };
    recordingQa: {
      required: true;
      status: "present" | "blocked";
      reason:
        | "browser_use_recording_recorder_unavailable"
        | "browser_use_recording_requires_cdp_lane"
        | "browser_use_recording_video_missing"
        | "browser_use_gemini_video_qa_missing"
        | "browser_use_gemini_video_qa_invalid"
        | "browser_use_gemini_video_qa_video_mismatch"
        | "browser_use_gemini_video_qa_completion_mismatch"
        | "browser_use_gemini_video_qa_runner_missing"
        | "browser_use_gemini_video_qa_runner_failed"
        | null;
      recorderStatus: "unavailable" | "planned" | "captured";
      cdpRequired: true;
      plannedVideoPath: string | null;
      manifestPath: string | null;
      artifactUri: string | null;
      videoArtifactUri: string | null;
      completionVetoOnly: true;
    };
    recordingSidecar: {
      attempted: boolean;
      status: "ok" | "blocked" | "skipped";
      reason: string;
      exactBlocker: string | null;
      targetUrl: string | null;
      targetPageUrl: string | null;
      command: string | null;
    };
    cleanup: {
      attempted: boolean;
      status: "ok" | "blocked" | "skipped";
      reason: string;
      command: string | null;
    };
    missingArtifacts: string[];
    artifactValidationStatus: "ok" | "blocked";
    profileIsolation: {
      status: "session_only" | "cdp_profile_lane";
      summary: string;
    };
  };
};

export type AsyncCommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export type BrowserUseLocalCheckOptions = {
  targetUrl?: string;
  runner?: CommandRunner;
  asyncRunner?: AsyncCommandRunner;
  now?: () => Date;
  artifactRoot?: string;
  session?: string;
  cdpUrl?: string;
  cdpPort?: number;
  profile?: string;
  recordingSidecarCommand?: string;
  recordingSidecarArgs?: string[];
};

type PreparedBrowserUseCheck = {
  id: string;
  createdAt: string;
  session: string;
  targetUrl: string;
  plannedScreenshotPath: string;
  plannedVideoPath: string | null;
  plannedGeminiQaPath: string;
  recordingQaManifestPath: string;
  statePath: string;
  logPath: string;
  command: string;
  commands: Array<[string, string[]]>;
  recordingSidecarCommand: string | null;
  recordingSidecarArgs: string[];
  steps: BrowserUseLocalCheckResult["steps"];
  connectionStrategy: BrowserUseLocalCheckResult["metadata"]["connectionStrategy"];
  autoCdp: AutoCdpLane | null;
};

const defaultTargetUrl = "http://127.0.0.1:5173/#sources";

type AutoCdpLane = {
  pid: number;
  port: number;
  profileDir: string;
  cdpUrl: string;
};

export function runBrowserUseLocalCheck(options: BrowserUseLocalCheckOptions = {}): BrowserUseLocalCheckResult {
  const prepared = prepareBrowserUseLocalCheck(options);
  if ("result" in prepared) return prepared.result;

  const runner = options.runner ?? runCommand;
  for (const [bin, args] of prepared.commands) {
    const result = runner(bin, args);
    prepared.steps.push(toStep(bin, args, result));
  }
  const recordingSidecar = runRecordingSidecarIfNeeded({ prepared, runner });
  const cleanup = runCleanupIfNeeded({ command: prepared.command, connectionStrategy: prepared.connectionStrategy, autoCdp: prepared.autoCdp, runner, steps: prepared.steps });
  return finalizeBrowserUseLocalCheck(prepared, recordingSidecar, cleanup);
}

export async function runBrowserUseLocalCheckAsync(options: BrowserUseLocalCheckOptions = {}): Promise<BrowserUseLocalCheckResult> {
  const prepared = prepareBrowserUseLocalCheck(options);
  if ("result" in prepared) return prepared.result;

  const runner = options.asyncRunner ?? runCommandAsync;
  for (const [bin, args] of prepared.commands) {
    const result = await runner(bin, args);
    prepared.steps.push(toStep(bin, args, result));
  }
  const recordingSidecar = await runRecordingSidecarIfNeededAsync({ prepared, runner });
  const cleanup = await runCleanupIfNeededAsync({ command: prepared.command, connectionStrategy: prepared.connectionStrategy, autoCdp: prepared.autoCdp, runner, steps: prepared.steps });
  return finalizeBrowserUseLocalCheck(prepared, recordingSidecar, cleanup);
}

function prepareBrowserUseLocalCheck(options: BrowserUseLocalCheckOptions): PreparedBrowserUseCheck | { result: BrowserUseLocalCheckResult } {
  const now = options.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const id = makeCheckId(createdAt);
  const session = options.session ?? makeSessionName(id);
  const targetUrl = validateLocalTargetUrl(options.targetUrl ?? process.env.AUTOMATION_OS_BROWSER_CHECK_URL ?? defaultTargetUrl);
  const artifactDir = resolveArtifactDir(options.artifactRoot, id);
  mkdirSync(artifactDir, { recursive: true });
  const autoCdp = shouldLaunchAutoCdp(options) ? launchAutoCdpLane(id) : null;
  const connectionStrategy = resolveConnectionStrategy({ session, cdpUrl: options.cdpUrl ?? autoCdp?.cdpUrl, cdpPort: options.cdpPort, profile: options.profile });

  const plannedScreenshotPath = resolve(artifactDir, "screenshot.png");
  const plannedVideoPath = connectionStrategy.cdpUrl ? resolve(artifactDir, "recording.mp4") : null;
  const plannedGeminiQaPath = resolve(artifactDir, "gemini-video-qa.json");
  const recordingQaManifestPath = resolve(artifactDir, "recording-qa-manifest.json");
  const statePath = resolve(artifactDir, "state.txt");
  const logPath = resolve(artifactDir, "browser-use.log");
  const command = getBrowserHealth().browserUseCli.command;
  const sidecar = resolveRecordingSidecar(options);
  const steps: BrowserUseLocalCheckResult["steps"] = [];
  writeRecordingQaManifest({
    id,
    createdAt,
    targetUrl,
    connectionStrategy,
    plannedVideoPath,
    plannedGeminiQaPath,
    manifestPath: recordingQaManifestPath
  });

  if (!command) {
    const summary = "Browser Use CLI が見つかりません";
    writeFileSync(logPath, `${summary}\n`, "utf8");
    return {
      result: buildResult({
        id,
        createdAt,
        session,
        targetUrl,
        summary,
        status: "blocked",
        screenshotPath: null,
        recordingPath: null,
        geminiQaPath: null,
        statePath: null,
        logPath,
        steps,
        connectionStrategy,
        cleanup: {
          attempted: false,
          status: "skipped",
          reason: "browser_use_cli_missing",
          command: null
        },
        recordingSidecar: {
          attempted: false,
          status: "skipped",
          reason: "browser_use_cli_missing",
          exactBlocker: null,
          targetUrl,
          targetPageUrl: null,
          command: null
        },
        plannedVideoPath,
        plannedGeminiQaPath,
        recordingQaManifestPath,
        missingArtifacts: ["screenshotPath", "statePath", "recordingQa"]
      })
    };
  }

  return {
    id,
    createdAt,
    session,
    targetUrl,
    plannedScreenshotPath,
    plannedVideoPath,
    plannedGeminiQaPath,
    recordingQaManifestPath,
    statePath,
    logPath,
    command,
    commands: [
      [command, withBrowserUseConnection(connectionStrategy, ["open", targetUrl])],
      [command, withBrowserUseConnection(connectionStrategy, ["state"])],
      [command, withBrowserUseConnection(connectionStrategy, ["screenshot", plannedScreenshotPath])]
    ],
    recordingSidecarCommand: sidecar.command,
    recordingSidecarArgs: sidecar.args,
    steps,
    connectionStrategy,
    autoCdp
  };
}

function shouldLaunchAutoCdp(options: BrowserUseLocalCheckOptions): boolean {
  if (options.cdpUrl || options.cdpPort || options.profile) return false;
  return process.env.AUTOMATION_OS_BROWSER_USE_AUTO_CDP === "1";
}

function launchAutoCdpLane(id: string): AutoCdpLane | null {
  const chromePath = process.env.AUTOMATION_OS_BROWSER_USE_CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(chromePath)) return null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = 9460 + ((Date.now() + process.pid + attempt) % 200);
    const profileDir = `/tmp/automation-os-browser-use-auto-cdp-${id}-${attempt}`;
    rmSync(profileDir, { recursive: true, force: true });
    mkdirSync(profileDir, { recursive: true });
    const child = spawn(
      chromePath,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        "--window-size=1280,900",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-extensions",
        "--new-window",
        browserUseLocalCheckStartingUrl(id)
      ],
      { detached: true, stdio: "ignore" }
    );
    child.unref();
    const cdpUrl = `http://127.0.0.1:${port}`;
    if (waitForCdp(cdpUrl)) return { pid: child.pid ?? 0, port, profileDir, cdpUrl };
    if (child.pid) killProcess(child.pid);
    rmSync(profileDir, { recursive: true, force: true });
  }
  return null;
}

function browserUseLocalCheckStartingUrl(id: string): string {
  const safeId = id.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
  const html = `<!doctype html><meta charset="utf-8"><title>Automation OS Browser Check</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f8fafc;color:#111827}.box{max-width:720px;padding:32px;border:1px solid #d1d5db;background:white}h1{font-size:22px;margin:0 0 12px}p{font-size:14px;line-height:1.6;margin:0;color:#374151}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}</style><main class="box"><h1>Automation OS Browser check starting</h1><p>This temporary Chrome window is controlled by Automation OS and will navigate automatically.</p><p>Check ID: <code>${safeId}</code></p></main>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function waitForCdp(cdpUrl: string): boolean {
  const url = `${cdpUrl.replace(/\/+$/, "")}/json/version`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = spawnSync("curl", ["-fsS", "-m", "1", url], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    if (result.status === 0) return true;
    spawnSync("sleep", ["0.2"], { stdio: "ignore" });
  }
  return false;
}

function runRecordingSidecarIfNeeded(input: {
  prepared: PreparedBrowserUseCheck;
  runner: CommandRunner;
}): BrowserUseLocalCheckResult["metadata"]["recordingSidecar"] {
  const command = input.prepared.recordingSidecarCommand;
  const args = buildRecordingSidecarArgs(input.prepared);
  if (!args) return skippedRecordingSidecar(input.prepared);
  if (!command) {
    return {
      attempted: false,
      status: "skipped",
      reason: "browser_use_recording_sidecar_not_configured",
      exactBlocker: null,
      targetUrl: input.prepared.targetUrl,
      targetPageUrl: null,
      command: null
    };
  }
  const fullArgs = [...input.prepared.recordingSidecarArgs, ...args];
  const result = input.runner(command, fullArgs);
  input.prepared.steps.push(toStep(command, fullArgs, result));
  const metadata = readRecordingSidecarMetadata(input.prepared.recordingQaManifestPath);
  const blockedReason = metadata.exactBlocker ?? metadata.reason ?? "browser_use_recording_sidecar_failed";
  return {
    attempted: true,
    status: result.status === 0 ? "ok" : "blocked",
    reason: result.status === 0 ? "browser_use_recording_sidecar_completed" : blockedReason,
    exactBlocker: result.status === 0 ? null : metadata.exactBlocker ?? blockedReason,
    targetUrl: metadata.targetUrl ?? input.prepared.targetUrl,
    targetPageUrl: metadata.targetPageUrl,
    command: [command, ...fullArgs].join(" ")
  };
}

async function runRecordingSidecarIfNeededAsync(input: {
  prepared: PreparedBrowserUseCheck;
  runner: AsyncCommandRunner;
}): Promise<BrowserUseLocalCheckResult["metadata"]["recordingSidecar"]> {
  const command = input.prepared.recordingSidecarCommand;
  const args = buildRecordingSidecarArgs(input.prepared);
  if (!args) return skippedRecordingSidecar(input.prepared);
  if (!command) {
    return {
      attempted: false,
      status: "skipped",
      reason: "browser_use_recording_sidecar_not_configured",
      exactBlocker: null,
      targetUrl: input.prepared.targetUrl,
      targetPageUrl: null,
      command: null
    };
  }
  const fullArgs = [...input.prepared.recordingSidecarArgs, ...args];
  const result = await input.runner(command, fullArgs);
  input.prepared.steps.push(toStep(command, fullArgs, result));
  const metadata = readRecordingSidecarMetadata(input.prepared.recordingQaManifestPath);
  const blockedReason = metadata.exactBlocker ?? metadata.reason ?? "browser_use_recording_sidecar_failed";
  return {
    attempted: true,
    status: result.status === 0 ? "ok" : "blocked",
    reason: result.status === 0 ? "browser_use_recording_sidecar_completed" : blockedReason,
    exactBlocker: result.status === 0 ? null : metadata.exactBlocker ?? blockedReason,
    targetUrl: metadata.targetUrl ?? input.prepared.targetUrl,
    targetPageUrl: metadata.targetPageUrl,
    command: [command, ...fullArgs].join(" ")
  };
}

function buildRecordingSidecarArgs(prepared: PreparedBrowserUseCheck): string[] | null {
  const cdpUrl = prepared.connectionStrategy.cdpUrl;
  if (!cdpUrl || !prepared.plannedVideoPath) return null;
  return [
    "--manifest",
    prepared.recordingQaManifestPath,
    "--recording",
    prepared.plannedVideoPath,
    "--gemini-qa",
    prepared.plannedGeminiQaPath,
    "--target-url",
    prepared.targetUrl,
    "--session",
    prepared.session,
    "--cdp-url",
    cdpUrl,
    ...(prepared.connectionStrategy.profile ? ["--profile", prepared.connectionStrategy.profile] : [])
  ];
}

function skippedRecordingSidecar(prepared: PreparedBrowserUseCheck): BrowserUseLocalCheckResult["metadata"]["recordingSidecar"] {
  return {
    attempted: false,
    status: "skipped",
    reason: prepared.connectionStrategy.cdpUrl ? "browser_use_recording_sidecar_not_applicable" : "browser_use_recording_requires_cdp_lane",
    exactBlocker: null,
    targetUrl: prepared.targetUrl,
    targetPageUrl: null,
    command: null
  };
}

function readRecordingSidecarMetadata(manifestPath: string): {
  reason: string | null;
  exactBlocker: string | null;
  targetUrl: string | null;
  targetPageUrl: string | null;
} {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const sidecar = manifest.recordingSidecar && typeof manifest.recordingSidecar === "object" ? (manifest.recordingSidecar as Record<string, unknown>) : {};
    return {
      reason: stringOrNull(sidecar.reason),
      exactBlocker: stringOrNull(sidecar.exactBlocker),
      targetUrl: stringOrNull(sidecar.targetUrl),
      targetPageUrl: stringOrNull(sidecar.targetPageUrl)
    };
  } catch {
    return { reason: null, exactBlocker: null, targetUrl: null, targetPageUrl: null };
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function runCleanupIfNeeded(input: {
  command: string;
  connectionStrategy: BrowserUseLocalCheckResult["metadata"]["connectionStrategy"];
  autoCdp: AutoCdpLane | null;
  runner: CommandRunner;
  steps: BrowserUseLocalCheckResult["steps"];
}): BrowserUseLocalCheckResult["metadata"]["cleanup"] {
  if (input.autoCdp) {
    return cleanupAutoCdp(input.autoCdp, input.connectionStrategy.session);
  }
  return cleanupBrowserUseSession({
    command: input.command,
    connectionStrategy: input.connectionStrategy,
    runner: input.runner,
    steps: input.steps,
    lanePreserved: input.connectionStrategy.mode !== "unique_session"
  });
}

async function runCleanupIfNeededAsync(input: {
  command: string;
  connectionStrategy: BrowserUseLocalCheckResult["metadata"]["connectionStrategy"];
  autoCdp: AutoCdpLane | null;
  runner: AsyncCommandRunner;
  steps: BrowserUseLocalCheckResult["steps"];
}): Promise<BrowserUseLocalCheckResult["metadata"]["cleanup"]> {
  if (input.autoCdp) {
    return cleanupAutoCdp(input.autoCdp, input.connectionStrategy.session);
  }
  const args = withBrowserUseConnection(input.connectionStrategy, ["close"]);
  const command = [input.command, ...args].join(" ");
  const result = await input.runner(input.command, args);
  input.steps.push({ command, status: result.status, stdout: result.stdout, stderr: result.stderr });
  const killed = killBrowserUseSessionProcesses(input.connectionStrategy.session);
  const ok = (result.status === 0 || /connection attempts failed|not found|no session/i.test(`${result.stdout}\n${result.stderr}`)) && killed;
  return {
    attempted: true,
    status: ok ? "ok" : "blocked",
    reason: ok
      ? input.connectionStrategy.mode === "unique_session"
        ? "unique_session_closed"
        : "cdp_profile_lane_session_closed"
      : "browser_use_session_close_failed",
    command
  };
}

function cleanupBrowserUseSession(input: {
  command: string;
  connectionStrategy: BrowserUseLocalCheckResult["metadata"]["connectionStrategy"];
  runner: CommandRunner;
  steps: BrowserUseLocalCheckResult["steps"];
  lanePreserved: boolean;
}): BrowserUseLocalCheckResult["metadata"]["cleanup"] {
  const args = withBrowserUseConnection(input.connectionStrategy, ["close"]);
  const command = [input.command, ...args].join(" ");
  const result = input.runner(input.command, args);
  input.steps.push({ command, status: result.status, stdout: result.stdout, stderr: result.stderr });
  const killed = killBrowserUseSessionProcesses(input.connectionStrategy.session);
  const closeWasBenign = result.status === 0 || /connection attempts failed|not found|no session/i.test(`${result.stdout}\n${result.stderr}`);
  const ok = closeWasBenign && killed;
  return {
    attempted: true,
    status: ok ? "ok" : "blocked",
    reason: ok
      ? input.lanePreserved
        ? "cdp_profile_lane_session_closed"
        : "unique_session_closed"
      : input.lanePreserved
        ? "cdp_profile_lane_session_close_failed"
        : "unique_session_close_failed",
    command
  };
}

function cleanupAutoCdp(autoCdp: AutoCdpLane, session: string): BrowserUseLocalCheckResult["metadata"]["cleanup"] {
  killBrowserUseSessionProcesses(session);
  if (autoCdp.pid > 0) killProcess(autoCdp.pid);
  rmSync(autoCdp.profileDir, { recursive: true, force: true });
  const closed = !isPortListening(autoCdp.port) && !existsSync(autoCdp.profileDir);
  return {
    attempted: true,
    status: closed ? "ok" : "blocked",
    reason: closed ? "auto_cdp_lane_closed" : "auto_cdp_lane_close_failed",
    command: `kill ${autoCdp.pid}; rm -rf ${autoCdp.profileDir}`
  };
}

function killBrowserUseSessionProcesses(session: string): boolean {
  if (!session.trim()) return true;
  spawnSync("pkill", ["-TERM", "-f", session], { stdio: "ignore" });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const alive = spawnSync("pgrep", ["-f", session], { stdio: "ignore" }).status === 0;
    if (!alive) return true;
    spawnSync("sleep", ["0.2"], { stdio: "ignore" });
  }
  spawnSync("pkill", ["-KILL", "-f", session], { stdio: "ignore" });
  return spawnSync("pgrep", ["-f", session], { stdio: "ignore" }).status !== 0;
}

function isPortListening(port: number): boolean {
  return spawnSync("sh", ["-lc", `lsof -nP -iTCP:${port} -sTCP:LISTEN >/dev/null 2>&1`], { stdio: "ignore" }).status === 0;
}

function killProcess(pid: number): boolean {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return true;
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const alive = spawnSync("sh", ["-lc", `kill -0 ${pid} 2>/dev/null`], { stdio: "ignore" }).status === 0;
    if (!alive) return true;
    spawnSync("sleep", ["0.2"], { stdio: "ignore" });
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return true;
  }
  return spawnSync("sh", ["-lc", `kill -0 ${pid} 2>/dev/null`], { stdio: "ignore" }).status !== 0;
}

function finalizeBrowserUseLocalCheck(
  prepared: PreparedBrowserUseCheck,
  recordingSidecar: BrowserUseLocalCheckResult["metadata"]["recordingSidecar"],
  cleanup: BrowserUseLocalCheckResult["metadata"]["cleanup"]
): BrowserUseLocalCheckResult {
  const stateStep = prepared.steps.find((step) => /\sstate$/.test(step.command));
  writeFileSync(prepared.statePath, `${stateStep?.stdout ?? ""}${stateStep?.stderr ? `\n${stateStep.stderr}` : ""}\n`, "utf8");
  writeFileSync(
    prepared.logPath,
    formatLog({ id: prepared.id, createdAt: prepared.createdAt, session: prepared.session, targetUrl: prepared.targetUrl, steps: prepared.steps }),
    "utf8"
  );

  const failed = prepared.steps.find((step) => step.status !== 0 && step.command !== cleanup.command);
  const cleanupFailed = cleanup.status === "blocked";
  const combinedOutput = prepared.steps.map((step) => `${step.stdout}\n${step.stderr}`).join("\n");
  const linkedScreenshotPath = latestLinkedPath(combinedOutput, ".png");
  const screenshotPath = existsSync(prepared.plannedScreenshotPath) ? prepared.plannedScreenshotPath : linkedScreenshotPath;
  const openStep = prepared.steps.find((step) => /\sopen\s/.test(step.command));
  const stateTargetOk = stateOrOpenMatchesTarget(stateStep?.stdout ?? "", openStep?.stdout ?? "", prepared.targetUrl);
  const recordingQa = buildRecordingQa({
    targetUrl: prepared.targetUrl,
    connectionStrategy: prepared.connectionStrategy,
    plannedVideoPath: prepared.plannedVideoPath,
    plannedGeminiQaPath: prepared.plannedGeminiQaPath,
    manifestPath: prepared.recordingQaManifestPath
  });
  const recordingSidecarMissing = Boolean(prepared.connectionStrategy.cdpUrl) && recordingSidecar.status !== "ok";
  const missingArtifacts = [
    screenshotPath && existsSync(screenshotPath) ? null : "screenshotPath",
    stateTargetOk ? null : "stateTargetUrl",
    recordingQa.status === "present" ? null : "recordingQa",
    recordingSidecarMissing ? "recordingSidecar" : null,
    prepared.statePath ? null : "statePath",
    prepared.logPath ? null : "logPath"
  ].filter((artifact): artifact is string => Boolean(artifact));
  const sidecarFailed = recordingSidecar.status === "blocked";
  const status = failed || sidecarFailed || recordingSidecarMissing || cleanupFailed || missingArtifacts.length > 0 ? "blocked" : "ok";
  const summary = failed
    ? `Browser Use CLI check failed at: ${failed.command}`
      : sidecarFailed
        ? `Browser Use recording sidecar failed at: ${recordingSidecar.command}`
      : recordingSidecarMissing
        ? `Browser Use recording sidecar blocked: ${recordingSidecar.reason}`
      : cleanupFailed
        ? `Browser Use cleanup failed at: ${cleanup.command}`
        : recordingQa.status === "blocked"
          ? `Browser Use recording QA blocked: ${recordingQa.reason}`
          : missingArtifacts.length > 0
            ? `Browser Use artifact が欠落しています: ${missingArtifacts.join(", ")}`
            : "Browser Use CLIでローカル画面のopen/state/screenshotと録画QAを完了しました";

  return buildResult({
    id: prepared.id,
    createdAt: prepared.createdAt,
    session: prepared.session,
    targetUrl: prepared.targetUrl,
    summary,
    status,
    screenshotPath,
    recordingPath: recordingQa.status === "present" ? prepared.plannedVideoPath : null,
    geminiQaPath: recordingQa.status === "present" ? prepared.plannedGeminiQaPath : null,
    statePath: prepared.statePath,
    logPath: prepared.logPath,
    steps: prepared.steps,
    connectionStrategy: prepared.connectionStrategy,
    recordingSidecar,
    cleanup,
    plannedVideoPath: prepared.plannedVideoPath,
    plannedGeminiQaPath: prepared.plannedGeminiQaPath,
    recordingQaManifestPath: prepared.recordingQaManifestPath,
    missingArtifacts
  });
}

function buildResult(input: {
  id: string;
  createdAt: string;
  session: string;
  targetUrl: string;
  summary: string;
  status: "ok" | "blocked";
  screenshotPath: string | null;
  recordingPath: string | null;
  geminiQaPath: string | null;
  statePath: string | null;
  logPath: string | null;
  steps: BrowserUseLocalCheckResult["steps"];
  connectionStrategy: BrowserUseLocalCheckResult["metadata"]["connectionStrategy"];
  cleanup: BrowserUseLocalCheckResult["metadata"]["cleanup"];
  recordingSidecar: BrowserUseLocalCheckResult["metadata"]["recordingSidecar"];
  plannedVideoPath: string | null;
  plannedGeminiQaPath: string;
  recordingQaManifestPath: string | null;
  missingArtifacts: string[];
}): BrowserUseLocalCheckResult {
  const recordingQa = buildRecordingQa({
    targetUrl: input.targetUrl,
    connectionStrategy: input.connectionStrategy,
    plannedVideoPath: input.plannedVideoPath,
    plannedGeminiQaPath: input.plannedGeminiQaPath,
    manifestPath: input.recordingQaManifestPath
  });
  updateRecordingQaManifest(input.recordingQaManifestPath, recordingQa);
  return {
    id: input.id,
    kind: "browser_check",
    driver: "browser_use_cli",
    status: input.status,
    targetUrl: input.targetUrl,
    summary: input.summary,
    screenshotPath: input.screenshotPath,
    recordingPath: input.recordingPath,
    geminiQaPath: input.geminiQaPath,
    statePath: input.statePath,
    logPath: input.logPath,
    createdAt: input.createdAt,
    steps: input.steps,
    metadata: {
      session: input.session,
      driver: "browser_use_cli",
      connectionStrategy: input.connectionStrategy,
      statePath: input.statePath,
      screenshotPath: input.screenshotPath,
      recordingPath: input.recordingPath,
      geminiQaPath: input.geminiQaPath,
      logPath: input.logPath,
      geminiVideoQa: {
        status: input.geminiQaPath ? "present" : "blocked",
        artifactUri: input.geminiQaPath ? pathToFileUri(input.geminiQaPath) : null,
        videoArtifactUri: input.recordingPath ? pathToFileUri(input.recordingPath) : null,
        completionVetoOnly: true,
        exactBlocker: input.geminiQaPath ? null : recordingQa.reason
      },
      recordingQa,
      recordingSidecar: input.recordingSidecar,
      cleanup: input.cleanup,
      missingArtifacts: input.missingArtifacts,
      artifactValidationStatus: input.missingArtifacts.length > 0 ? "blocked" : "ok",
      profileIsolation: {
        status: input.connectionStrategy.mode === "cdp_profile_lane" ? "cdp_profile_lane" : "session_only",
        summary:
          input.connectionStrategy.mode === "cdp_profile_lane"
            ? "Browser Use CLI is attached to a lane-specific CDP URL/profile."
            : "Browser Use CLI is isolated by a unique session name; no CDP/profile lane was requested."
      }
    }
  };
}

function buildRecordingQa(input: {
  targetUrl: string;
  connectionStrategy: BrowserUseLocalCheckResult["metadata"]["connectionStrategy"];
  plannedVideoPath: string | null;
  plannedGeminiQaPath: string | null;
  manifestPath: string | null;
}): BrowserUseLocalCheckResult["metadata"]["recordingQa"] {
  const hasCdpLane = Boolean(input.connectionStrategy.cdpUrl);
  const present = validateRecordingQaSidecar(input);
  if (present.ok) {
    return {
      required: true,
      status: "present",
      reason: null,
      recorderStatus: "captured",
      cdpRequired: true,
      plannedVideoPath: input.plannedVideoPath,
      manifestPath: input.manifestPath,
      artifactUri: input.plannedGeminiQaPath ? pathToFileUri(input.plannedGeminiQaPath) : null,
      videoArtifactUri: input.plannedVideoPath ? pathToFileUri(input.plannedVideoPath) : null,
      completionVetoOnly: true
    };
  }
  const reason = hasCdpLane ? "browser_use_recording_recorder_unavailable" : "browser_use_recording_requires_cdp_lane";
  return {
    required: true,
    status: "blocked",
    reason: present.reason ?? reason,
    recorderStatus: hasCdpLane ? "planned" : "unavailable",
    cdpRequired: true,
    plannedVideoPath: input.plannedVideoPath,
    manifestPath: input.manifestPath,
    artifactUri: input.manifestPath ? pathToFileUri(input.manifestPath) : null,
    videoArtifactUri: input.plannedVideoPath ? pathToFileUri(input.plannedVideoPath) : null,
    completionVetoOnly: true
  };
}

function writeRecordingQaManifest(input: {
  id: string;
  createdAt: string;
  targetUrl: string;
  connectionStrategy: BrowserUseLocalCheckResult["metadata"]["connectionStrategy"];
  plannedVideoPath: string | null;
  plannedGeminiQaPath: string;
  manifestPath: string;
}): void {
  const recordingQa = buildRecordingQa({
    targetUrl: input.targetUrl,
    connectionStrategy: input.connectionStrategy,
    plannedVideoPath: input.plannedVideoPath,
    plannedGeminiQaPath: input.plannedGeminiQaPath,
    manifestPath: input.manifestPath
  });
  writeFileSync(
    input.manifestPath,
    `${JSON.stringify(
      {
        id: input.id,
        createdAt: input.createdAt,
        targetUrl: input.targetUrl,
        driver: "browser_use_cli",
        contract: "browser_use_recording_qa_required",
        browserUseCliCommands: ["open", "state", "screenshot", "cleanup"],
        plannedSidecar: "cdp_screencast_recorder",
        expectedVideoPath: input.plannedVideoPath,
        expectedGeminiQaPath: input.plannedGeminiQaPath,
        connectionStrategy: input.connectionStrategy,
        recordingQa
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

function updateRecordingQaManifest(manifestPath: string | null, recordingQa: BrowserUseLocalCheckResult["metadata"]["recordingQa"]): void {
  if (!manifestPath || !existsSync(manifestPath)) return;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, recordingQa }, null, 2)}\n`, "utf8");
  } catch {
    return;
  }
}

function validateRecordingQaSidecar(input: {
  targetUrl: string;
  connectionStrategy: BrowserUseLocalCheckResult["metadata"]["connectionStrategy"];
  plannedVideoPath: string | null;
  plannedGeminiQaPath: string | null;
}): { ok: true } | { ok: false; reason: BrowserUseLocalCheckResult["metadata"]["recordingQa"]["reason"] } {
  if (!input.connectionStrategy.cdpUrl) return { ok: false, reason: "browser_use_recording_requires_cdp_lane" };
  if (!input.plannedVideoPath || !existsNonEmptyFile(input.plannedVideoPath)) {
    return { ok: false, reason: existsSync(input.plannedGeminiQaPath ?? "") ? "browser_use_recording_video_missing" : null };
  }
  if (!input.plannedGeminiQaPath || !existsSync(input.plannedGeminiQaPath)) return { ok: false, reason: "browser_use_gemini_video_qa_missing" };

  let qa: unknown;
  try {
    qa = JSON.parse(readFileSync(input.plannedGeminiQaPath, "utf8"));
  } catch {
    return { ok: false, reason: "browser_use_gemini_video_qa_invalid" };
  }
  if (!qa || typeof qa !== "object") return { ok: false, reason: "browser_use_gemini_video_qa_invalid" };
  const record = qa as Record<string, unknown>;
  if (!looksLikeGeminiQa(record)) return { ok: false, reason: "browser_use_gemini_video_qa_invalid" };
  if (!qaMatchesVideo(record, input.plannedVideoPath)) return { ok: false, reason: "browser_use_gemini_video_qa_video_mismatch" };
  if (!qaMatchesTargetUrl(record, input.targetUrl)) return { ok: false, reason: "browser_use_gemini_video_qa_completion_mismatch" };
  if (!qaPassesCompletionGate(record)) {
    return { ok: false, reason: allowedBrowserUseGeminiQaExactBlocker(record.exact_blocker) ?? "browser_use_gemini_video_qa_completion_mismatch" };
  }
  return { ok: true };
}

function allowedBrowserUseGeminiQaExactBlocker(value: unknown): BrowserUseLocalCheckResult["metadata"]["recordingQa"]["reason"] | null {
  if (value !== "browser_use_gemini_video_qa_runner_missing" && value !== "browser_use_gemini_video_qa_runner_failed") return null;
  return value;
}

function stateOrOpenMatchesTarget(stateOutput: string, openOutput: string, targetUrl: string): boolean {
  const stateUrl = extractStateUrl(stateOutput);
  if (stateUrl) return urlMatchesTarget(stateUrl, targetUrl);
  const openUrl = extractStateUrl(openOutput);
  return openUrl ? urlMatchesTarget(openUrl, targetUrl) : false;
}

function urlMatchesTarget(value: string, targetUrl: string): boolean {
  try {
    const actual = new URL(value);
    const expected = new URL(targetUrl);
    return actual.origin === expected.origin && actual.pathname === expected.pathname && actual.search === expected.search && actual.hash === expected.hash;
  } catch {
    return false;
  }
}

function qaMatchesTargetUrl(record: Record<string, unknown>, targetUrl: string): boolean {
  const candidate = typeof record.target_url === "string" ? record.target_url : typeof record.targetUrl === "string" ? record.targetUrl : null;
  return candidate ? urlMatchesTarget(candidate, targetUrl) : true;
}

function extractStateUrl(stateOutput: string): string | null {
  const match = stateOutput.match(/(?:^|\n)\s*url:\s*(\S+)/i);
  return match?.[1] ?? null;
}

function existsNonEmptyFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile() && statSync(path).size > 0;
  } catch {
    return false;
  }
}

function looksLikeGeminiQa(record: Record<string, unknown>): boolean {
  const markers = ["provider", "model", "kind", "type", "driver", "auditor"].map((key) => String(record[key] ?? "").toLowerCase());
  return markers.some((value) => value.includes("gemini") || value.includes("video_qa") || value.includes("video qa"));
}

function qaMatchesVideo(record: Record<string, unknown>, plannedVideoPath: string): boolean {
  const expected = normalizeArtifactPath(plannedVideoPath);
  const candidates = ["video_artifact_uri", "videoArtifactUri", "video_uri", "videoUri", "recording_uri", "recordingPath", "video_path", "videoPath"]
    .map((key) => normalizeArtifactPath(record[key]))
    .filter((value): value is string => Boolean(value));
  return Boolean(expected && candidates.includes(expected));
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
  if (typeof value !== "string") return false;
  return /fail|failed|blocked|mismatch|conflict|veto|reject|error/.test(value.toLowerCase());
}

function stringFieldIsGood(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /^(ok|pass|passed|success|aligned|match|matched)$/i.test(value.trim());
}

function normalizeArtifactPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const trimmed = value.trim();
  try {
    return resolve(trimmed.startsWith("file://") ? fileURLToPath(trimmed) : trimmed);
  } catch {
    return null;
  }
}

function pathToFileUri(path: string): string {
  return pathToFileURL(path).href;
}

function resolveConnectionStrategy(input: {
  session: string;
  cdpUrl?: string;
  cdpPort?: number;
  profile?: string;
}): BrowserUseLocalCheckResult["metadata"]["connectionStrategy"] {
  const envCdpUrl = process.env.AUTOMATION_OS_BROWSER_USE_CDP_URL;
  const envCdpPort = process.env.AUTOMATION_OS_BROWSER_USE_CDP_PORT;
  const envProfile = process.env.AUTOMATION_OS_BROWSER_USE_PROFILE;
  const cdpUrl = input.cdpUrl ?? (input.cdpPort ? cdpUrlFromPort(input.cdpPort) : undefined) ?? envCdpUrl ?? (envCdpPort ? cdpUrlFromPort(Number(envCdpPort)) : undefined);
  const profile = input.profile ?? envProfile;
  const cdpCliUrl = cdpUrl ? resolveBrowserUseCliCdpUrl(cdpUrl) : null;
  return {
    mode: cdpUrl || profile ? "cdp_profile_lane" : "unique_session",
    session: input.session,
    cdpUrl: cdpUrl ?? null,
    cdpCliUrl,
    profile: profile ?? null
  };
}

function withBrowserUseConnection(strategy: BrowserUseLocalCheckResult["metadata"]["connectionStrategy"], args: string[]): string[] {
  const cliCdpUrl = strategy.cdpCliUrl ?? strategy.cdpUrl;
  return [
    "--session",
    strategy.session,
    ...(cliCdpUrl ? ["--cdp-url", cliCdpUrl] : []),
    ...(strategy.profile ? ["--profile", strategy.profile] : []),
    ...args
  ];
}

function resolveBrowserUseCliCdpUrl(cdpUrl: string): string | null {
  if (/^wss?:\/\//.test(cdpUrl)) return cdpUrl;
  if (!/^https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/?$/.test(cdpUrl)) return null;
  const versionUrl = cdpUrl.replace(/\/+$/, "") + "/json/version";
  const result = spawnSync("curl", ["-fsS", "-m", "2", versionUrl], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { webSocketDebuggerUrl?: unknown };
    return typeof parsed.webSocketDebuggerUrl === "string" && parsed.webSocketDebuggerUrl.trim() ? parsed.webSocketDebuggerUrl.trim() : null;
  } catch {
    return null;
  }
}

function cdpUrlFromPort(port: number): string | undefined {
  if (!Number.isInteger(port) || port <= 0) return undefined;
  return `http://127.0.0.1:${port}`;
}

function runCommand(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: Number(process.env.AUTOMATION_OS_BROWSER_USE_TIMEOUT_MS ?? 30000)
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function runCommandAsync(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks: { stdout: string[]; stderr: string[] } = { stdout: [], stderr: [] };
    const timeoutMs = Number(process.env.AUTOMATION_OS_BROWSER_USE_TIMEOUT_MS ?? 30000);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      chunks.stderr.push(`Timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => chunks.stdout.push(chunk));
    child.stderr.on("data", (chunk) => chunks.stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveResult({ status: 127, stdout: chunks.stdout.join(""), stderr: `${chunks.stderr.join("")}${error.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveResult({
        status: code ?? (signal ? 124 : null),
        stdout: chunks.stdout.join(""),
        stderr: chunks.stderr.join("")
      });
    });
  });
}

function firstNonEmpty(value: string | undefined): string | null {
  return value && value.trim() ? value.trim() : null;
}

function splitCommandArgs(value: string | undefined): string[] {
  return value?.trim() ? value.trim().split(/\s+/) : [];
}

function resolveRecordingSidecar(options: BrowserUseLocalCheckOptions): { command: string | null; args: string[] } {
  if (options.recordingSidecarCommand) return { command: options.recordingSidecarCommand, args: options.recordingSidecarArgs ?? [] };
  const envCommand = firstNonEmpty(process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR);
  if (envCommand) return { command: envCommand, args: splitCommandArgs(process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR_ARGS) };
  if (process.env.AUTOMATION_OS_BROWSER_USE_DISABLE_BUILTIN_RECORDING_SIDECAR === "1") return { command: null, args: [] };
  if (process.argv.some((arg) => arg === "--test" || arg.startsWith("--test-"))) return { command: null, args: [] };
  const scriptPath = resolveBuiltInBrowserUseScript("browserUseRecordingSidecar.js");
  return scriptPath && existsSync(scriptPath) ? { command: process.execPath, args: [scriptPath] } : { command: null, args: [] };
}

function resolveArtifactDir(root: string | undefined, id: string): string {
  return resolve(root ?? process.env.AUTOMATION_OS_BROWSER_USE_ARTIFACT_DIR ?? resolve(process.cwd(), "data", "artifacts", "browser-use-local-checks"), id);
}

function latestLinkedPath(output: string, suffix: string): string | null {
  const matches = [...output.matchAll(/\]\(([^)]+)\)/g)]
    .map((match) => match[1])
    .filter((path) => path.endsWith(suffix));
  const path = matches.at(-1);
  return path ? resolve(process.cwd(), path) : null;
}

function formatLog(input: {
  id: string;
  createdAt: string;
  session: string;
  targetUrl: string;
  steps: BrowserUseLocalCheckResult["steps"];
}): string {
  const lines = [
    `id=${input.id}`,
    `created_at=${input.createdAt}`,
    `driver=browser_use_cli`,
    `session=${input.session}`,
    `target_url=${input.targetUrl}`
  ];
  for (const step of input.steps) {
    lines.push("", `$ ${step.command}`, `status=${step.status ?? "null"}`, step.stdout.trim(), step.stderr.trim());
  }
  return `${lines.filter((line) => line !== undefined).join("\n")}\n`;
}

function makeCheckId(createdAt: string): string {
  return `browser_use_check_${createdAt.replace(/[^0-9A-Za-z]+/g, "-")}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeSessionName(id: string): string {
  return id.replace(/_/g, "-").toLowerCase();
}

function toStep(command: string, args: string[], result: CommandResult): BrowserUseLocalCheckResult["steps"][number] {
  return {
    command: [command, ...args].join(" "),
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

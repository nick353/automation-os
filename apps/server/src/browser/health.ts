import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { resolveBuiltInBrowserUseScript } from "./browserUseBuiltIns.js";
import { readStoredSecretByKind } from "../secrets/secretStore.js";

type BrowserUseRecordingQaBlocker =
  | "browser_use_callable_surface_missing"
  | "browser_use_recording_recorder_unavailable"
  | "browser_use_recording_ffmpeg_missing"
  | "browser_use_gemini_video_qa_runner_missing"
  | "browser_use_gemini_api_key_missing"
  | "browser_use_recording_requires_cdp_lane";

type BrowserUseRecordingQaHealth = {
  status: "ready" | "blocked";
  exactBlocker: BrowserUseRecordingQaBlocker | null;
  userSummary: string;
  nextAction: string;
  builtinSidecarAvailable: boolean;
  ffmpegAvailable: boolean;
  geminiQaRunnerConfigured: boolean;
  cdpLaneConfigured: boolean;
};

export type BrowserHealth = {
  generatedAt: string;
  playwrightCli: {
    available: boolean;
    command: string | null;
    status: "available" | "missing";
  };
  browserUseCli: {
    available: boolean;
    command: string | null;
    status: "available" | "missing";
  };
  browserUseRecordingQa: BrowserUseRecordingQaHealth;
  codexBrowserBridge: {
    required: boolean;
    directCallableFromLocalApp: boolean;
    status: "requires_bridge";
    summary: string;
  };
  chromeExtension: {
    status: "ready" | "blocked";
    exactBlocker: string | null;
    summary: string;
    nextAction: string;
    chromeBinary: string | null;
    cdpLaneConfigured: boolean;
  };
  localApp: {
    canReportHealth: boolean;
    canExecuteBrowserPlugin: boolean;
  };
};

export function getBrowserHealth(): BrowserHealth {
  const command = null;
  const browserUseCommand = resolveCanonicalBrowserUseCli();
  const browserUseRecordingQa = getBrowserUseRecordingQaHealth(Boolean(browserUseCommand));
  const chromeBinary = resolveChromeBinary();
  const cdpLaneConfigured = Boolean(
    firstNonEmpty(process.env.AUTOMATION_OS_BROWSER_USE_CDP_URL) ||
      cdpUrlFromPort(process.env.AUTOMATION_OS_BROWSER_USE_CDP_PORT) ||
      firstNonEmpty(process.env.BROWSER_USE_CDP_URL) ||
      autoCdpLaunchConfigured()
  );
  return {
    generatedAt: new Date().toISOString(),
    playwrightCli: {
      available: false,
      command: null,
      status: "missing"
    },
    browserUseCli: {
      available: Boolean(browserUseCommand),
      command: browserUseCommand,
      status: browserUseCommand ? "available" : "missing"
    },
    browserUseRecordingQa,
    codexBrowserBridge: {
      required: true,
      directCallableFromLocalApp: false,
      status: "requires_bridge",
      summary: "In-App Browser plugin actions require the Codex runtime bridge; this local API can only report readiness."
    },
    chromeExtension: {
      status: "blocked",
      exactBlocker: "chrome_extension_requires_codex_bridge",
      summary: "Chrome Extension lane は local app から直呼びできず、Codex bridge が必要です。",
      nextAction: "Codex bridge の接続状態と Chrome profile/CDP lane を bridge 側 readback で確認してください。",
      chromeBinary,
      cdpLaneConfigured
    },
    localApp: {
      canReportHealth: true,
      canExecuteBrowserPlugin: false
    }
  };
}

function getBrowserUseRecordingQaHealth(browserUseCliAvailable: boolean): BrowserUseRecordingQaHealth {
  const builtinSidecarAvailable = recordingSidecarAvailable();
  const ffmpegAvailable = commandExists("ffmpeg");
  const envGeminiRunner = firstNonEmpty(process.env.AUTOMATION_OS_BROWSER_USE_GEMINI_QA_RUNNER);
  const geminiQaRunnerConfigured = envGeminiRunner ? executableExists(envGeminiRunner) : builtInGeminiRunnerAvailable();
  const geminiApiKeyConfigured = Boolean(resolveGeminiApiKey());
  const cdpLaneConfigured = Boolean(
    firstNonEmpty(process.env.AUTOMATION_OS_BROWSER_USE_CDP_URL) ||
      cdpUrlFromPort(process.env.AUTOMATION_OS_BROWSER_USE_CDP_PORT) ||
      firstNonEmpty(process.env.BROWSER_USE_CDP_URL) ||
      autoCdpLaunchConfigured()
  );
  const exactBlocker = firstBlocker([
    browserUseCliAvailable ? null : "browser_use_callable_surface_missing",
    builtinSidecarAvailable ? null : "browser_use_recording_recorder_unavailable",
    ffmpegAvailable ? null : "browser_use_recording_ffmpeg_missing",
    geminiQaRunnerConfigured ? null : "browser_use_gemini_video_qa_runner_missing",
    geminiApiKeyConfigured ? null : "browser_use_gemini_api_key_missing",
    cdpLaneConfigured ? null : "browser_use_recording_requires_cdp_lane"
  ]);

  return {
    status: exactBlocker ? "blocked" : "ready",
    exactBlocker,
    userSummary: browserUseRecordingQaUserSummary(exactBlocker),
    nextAction: browserUseRecordingQaNextAction(exactBlocker),
    builtinSidecarAvailable,
    ffmpegAvailable,
    geminiQaRunnerConfigured,
    cdpLaneConfigured
  };
}

function firstBlocker(blockers: Array<BrowserUseRecordingQaBlocker | null>): BrowserUseRecordingQaBlocker | null {
  return blockers.find((blocker): blocker is BrowserUseRecordingQaBlocker => Boolean(blocker)) ?? null;
}

function browserUseRecordingQaUserSummary(blocker: BrowserUseRecordingQaBlocker | null): string {
  switch (blocker) {
    case null:
      return "Browser Useの録画とGemini確認を動かす準備ができています。";
    case "browser_use_callable_surface_missing":
      return "Browser Useを呼び出す道具が見つかりません。";
    case "browser_use_recording_recorder_unavailable":
      return "画面を録画する係が見つかりません。";
    case "browser_use_recording_ffmpeg_missing":
      return "録画を動画にする道具が見つかりません。";
    case "browser_use_gemini_video_qa_runner_missing":
      return "録画をGeminiで確認する係が設定されていません。";
    case "browser_use_gemini_api_key_missing":
      return "録画をGeminiで確認するための鍵がありません。";
    case "browser_use_recording_requires_cdp_lane":
      return "録画するブラウザの入口が決まっていません。";
  }
}

function browserUseRecordingQaNextAction(blocker: BrowserUseRecordingQaBlocker | null): string {
  switch (blocker) {
    case null:
      return "このままBrowser Use録画+Gemini QAを使えます。";
    case "browser_use_callable_surface_missing":
      return "Browser Use CLIを入れるか、AUTOMATION_OS_BROWSER_USE_CLIに実行ファイルを設定してください。";
    case "browser_use_recording_recorder_unavailable":
      return "録画sidecarを有効にするか、AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECARを設定してください。";
    case "browser_use_recording_ffmpeg_missing":
      return "ffmpegをインストールしてPATHから呼べるようにしてください。";
    case "browser_use_gemini_video_qa_runner_missing":
      return "AUTOMATION_OS_BROWSER_USE_GEMINI_QA_RUNNERにGemini QA runnerを設定してください。";
    case "browser_use_gemini_api_key_missing":
      return "Gemini確認用の環境設定を有効にしてください。";
    case "browser_use_recording_requires_cdp_lane":
      return "AUTOMATION_OS_BROWSER_USE_CDP_URLかAUTOMATION_OS_BROWSER_USE_CDP_PORTを設定してください。";
  }
}

function recordingSidecarAvailable(): boolean {
  const envSidecar = firstNonEmpty(process.env.AUTOMATION_OS_BROWSER_USE_RECORDING_SIDECAR);
  if (envSidecar) return executableExists(envSidecar);
  if (process.env.AUTOMATION_OS_BROWSER_USE_DISABLE_BUILTIN_RECORDING_SIDECAR === "1") return false;
  return Boolean(resolveBuiltInBrowserUseScript("browserUseRecordingSidecar.js"));
}

function builtInGeminiRunnerAvailable(): boolean {
  return Boolean(resolveBuiltInBrowserUseScript("geminiVideoQaRunner.js"));
}

function autoCdpLaunchConfigured(): boolean {
  return false;
}

function resolveCanonicalBrowserUseCli(): string | null {
  if (process.env.AUTOMATION_OS_BROWSER_USE_HELPER !== undefined && !process.env.AUTOMATION_OS_BROWSER_USE_HELPER.trim()) return null;
  if (process.env.AUTOMATION_OS_BROWSER_USE_CLI !== undefined && !process.env.AUTOMATION_OS_BROWSER_USE_CLI.trim()) return null;
  const explicit = firstNonEmpty(process.env.AUTOMATION_OS_BROWSER_USE_HELPER)
    ?? firstNonEmpty(process.env.AUTOMATION_OS_BROWSER_USE_CLI);
  if (explicit) return isLegacyBrowserExecutable(explicit) ? null : explicit;
  const configured = "/Users/nichikatanaka/.local/bin/codex-browser-use";
  return executableExists(configured) ? configured : null;
}

function isLegacyBrowserExecutable(command: string): boolean {
  const executable = basename(command.trim().split(/\s+/u, 1)[0] ?? "").toLowerCase();
  return /(?:^|[-_.])(playwright|puppeteer|chrome|chromium)(?:$|[-_.])/u.test(executable);
}

function resolveChromeBinary(): string | null {
  const envChrome = firstNonEmpty(process.env.AUTOMATION_OS_BROWSER_USE_CHROME_BIN) ?? firstNonEmpty(process.env.AUTOMATION_OS_YOUTUBE_TRANSCRIPT_CHROME_BIN);
  if (envChrome) return envChrome;
  const defaultChromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  return existsSync(defaultChromePath) ? defaultChromePath : null;
}

function resolveGeminiApiKey(): string | null {
  const envKey = firstNonEmpty(process.env.GEMINI_API_KEY);
  if (envKey) return envKey;
  try {
    return firstNonEmpty(readStoredSecretByKind("gemini"));
  } catch {
    return null;
  }
}

function executableExists(command: string): boolean {
  return existsSync(command) || commandExists(command);
}

function firstNonEmpty(value: string | undefined): string | null {
  return value && value.trim() ? value.trim() : null;
}

function cdpUrlFromPort(port: string | undefined): string | null {
  const value = firstNonEmpty(port);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? `http://127.0.0.1:${parsed}` : null;
}

function commandExists(command: string): boolean {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return result.status === 0 && result.stdout.trim().length > 0;
}

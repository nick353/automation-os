import { registeredBrowserLaneForWorkflow } from "../runs/laneManager.js";
import { getBrowserHealth } from "./health.js";

const registeredLane = registeredBrowserLaneForWorkflow("x-authenticated-browser-lane");
const fallbackPort = 19885;
const fallbackProfileDir = "/Users/nichikatanaka/.browser-use-cli/profiles/scheduled/x-authenticated-browser-lane";

export const xLearningLane = {
  name: "x_learning_authenticated_browser_use_cli",
  port: registeredLane?.cdpPort ?? fallbackPort,
  profileDir: registeredLane?.profileDir ?? fallbackProfileDir,
  homeUrl: "https://x.com/home",
  versionUrl: "browser-use-cli://x-learning/authenticated-session"
} as const;

export type XLearningChromeCommand = {
  bin: string;
  args: string[];
  laneName: string;
  port: number;
  profileDir: string;
};

export type XLearningChromeOpenResult = XLearningChromeCommand & {
  ok: boolean;
  pid?: number;
  url: string;
  exactBlocker?: string;
  summary: string;
};

export function buildOpenXLearningChromeCommand(_ignoredLegacyChromePath?: string): XLearningChromeCommand {
  const command = getBrowserHealth().browserUseCli.command || "/Users/nichikatanaka/.local/bin/codex-browser-use";
  return {
    bin: command,
    args: [
      "--session",
      "aos-x-learning-authenticated",
      "open",
      xLearningLane.homeUrl
    ],
    laneName: xLearningLane.name,
    port: xLearningLane.port,
    profileDir: xLearningLane.profileDir
  };
}

export function openXLearningChrome(): XLearningChromeOpenResult {
  const command = buildOpenXLearningChromeCommand();
  return {
    ok: false,
    ...command,
    url: xLearningLane.homeUrl,
    exactBlocker: getBrowserHealth().browserUseCli.available ? "browser_use_authority_required" : "browser_use_cli_missing",
    summary: "X learningはcanonical Browser Use CLIのfresh authority/sessionからのみ実行します。Chrome/CDPの直接起動はしません。"
  };
}

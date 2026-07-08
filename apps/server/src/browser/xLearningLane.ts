import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { registeredBrowserLaneForWorkflow } from "../runs/laneManager.js";

const registeredLane = registeredBrowserLaneForWorkflow("x-authenticated-browser-lane");

export const xLearningLane = {
  name: "x_learning_authenticated_cdp",
  port: registeredLane?.cdpPort ?? 9336,
  profileDir: registeredLane?.profileDir ?? "/Users/nichikatanaka/.x-learning-playwright-chrome",
  profileDirectory: "Default",
  homeUrl: "https://x.com/home",
  versionUrl: `http://127.0.0.1:${registeredLane?.cdpPort ?? 9336}/json/version`
} as const;

const defaultChromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

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
  summary: string;
};

export function buildOpenXLearningChromeCommand(chromePath = process.env.AUTOMATION_OS_X_LEARNING_CHROME_BIN || defaultChromePath): XLearningChromeCommand {
  return {
    bin: chromePath,
    args: [
      `--remote-debugging-port=${xLearningLane.port}`,
      `--user-data-dir=${xLearningLane.profileDir}`,
      `--profile-directory=${xLearningLane.profileDirectory}`,
      xLearningLane.homeUrl
    ],
    laneName: xLearningLane.name,
    port: xLearningLane.port,
    profileDir: xLearningLane.profileDir
  };
}

export function openXLearningChrome(): XLearningChromeOpenResult {
  mkdirSync(xLearningLane.profileDir, { recursive: true });
  const command = buildOpenXLearningChromeCommand();
  const child = spawn(command.bin, command.args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return {
    ok: true,
    ...command,
    pid: child.pid,
    url: xLearningLane.homeUrl,
    summary: "Opened the fixed X learning authenticated CDP lane without fallback."
  };
}

import { runBrowserUseLocalCheck, runBrowserUseLocalCheckAsync, type BrowserUseLocalCheckOptions, type BrowserUseLocalCheckResult } from "./browserUseLocalCheck.js";
import { readFileSync } from "node:fs";
import { type AsyncCommandRunner, type CommandResult, type CommandRunner } from "./commandTypes.js";

export type { AsyncCommandRunner, CommandResult, CommandRunner } from "./commandTypes.js";
export { validateLocalTargetUrl } from "./commandTypes.js";

/**
 * Compatibility names for the old bridge endpoint. The implementation is
 * intentionally the canonical Browser Use CLI path; there is no Playwright,
 * Chrome-extension, or direct-CDP fallback behind this API.
 */
export type BrowserBridgeCheckResult = BrowserUseLocalCheckResult;
export type BrowserBridgeCheckOptions = BrowserUseLocalCheckOptions & {
  command?: string;
  env?: Record<string, string>;
};

export function runLocalBrowserBridgeCheck(options: BrowserBridgeCheckOptions = {}): BrowserBridgeCheckResult {
  return runBrowserUseLocalCheck({
    ...options,
    runner: options.runner ?? (() => ({ status: 127, stdout: "", stderr: "browser_use_cli_compatibility_surface_disabled" }))
  });
}

export async function runLocalBrowserBridgeCheckAsync(options: BrowserBridgeCheckOptions = {}): Promise<BrowserBridgeCheckResult> {
  return runBrowserUseLocalCheckAsync({
    ...options,
    asyncRunner: options.asyncRunner ?? (async () => ({ status: 127, stdout: "", stderr: "browser_use_cli_compatibility_surface_disabled" }))
  });
}

export function countConsoleErrors(path: string | null): number {
  if (!path) return 0;
  try {
    return readFileSync(path, "utf8").split(/\r?\n/u).filter((line) => /\b(?:error|exception|failed)\b/iu.test(line)).length;
  } catch {
    return 0;
  }
}

export type { BrowserUseLocalCheckOptions, BrowserUseLocalCheckResult };

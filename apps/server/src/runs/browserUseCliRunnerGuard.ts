import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export const BROWSER_USE_CLI_WORKFLOW_ADAPTER_MISSING_BLOCKER = "browser_use_cli_workflow_adapter_missing" as const;

const FORBIDDEN_RUNNER_PATH_SIGNALS = [
  /playwright/iu,
  /puppeteer/iu,
  /chrome/iu,
  /cdp/iu,
];
const FORBIDDEN_RUNNER_SOURCE_SIGNALS = [
  /connectovercdp/iu,
  /remote-debugging-port/iu,
  /chromium\.launch/iu,
  /puppeteer/iu,
  /google chrome\.app/iu,
  /run_.*chrome_plugin/iu,
  /chrome[_-]plugin/iu,
  /(?:\/json\/version|Input\.dispatchMouseEvent|CdpWebSocketTransport)/iu,
];
const CANONICAL_STAGE_ADAPTER_SIGNAL = /browser-use-cli[\\/]lib[\\/]stage-adapter\.m?js/iu;
const CANONICAL_STAGE_EXECUTOR_SIGNAL = /runBrowserUseCli(?:FlowCommand|NoPostVisualPreflight|CleanupProof)/u;
const CANONICAL_REGISTERED_DAILY_AI_ENTRY_SIGNAL = /runDailyAiChromePluginResume/iu;
const CANONICAL_REGISTERED_DAILY_AI_MODULE_SIGNAL = /run_daily_ai_chrome_plugin\.m?js/iu;
const CANONICAL_REGISTERED_SURFACE_SIGNAL = /browser_use_cli_registered_runner/iu;
const CANONICAL_REGISTERED_CLI_MODULE_SIGNAL = /browser-use-cli[\\/]lib[\\/]stage-adapter\.m?js/iu;
const CANONICAL_REGISTERED_PYTHON_HELPER_SIGNAL = /codex-browser-use/iu;
const COMPATIBILITY_BROWSER_PLUGIN_SIGNALS = [/run_.*chrome_plugin/iu, /chrome[_-]plugin/iu];

export type BrowserUseCliRunnerInspection = {
  ok: boolean;
  exactBlocker: typeof BROWSER_USE_CLI_WORKFLOW_ADAPTER_MISSING_BLOCKER | null;
  runner: string;
  forbiddenSignals: string[];
};

/**
 * A registered workflow runner is a second browser boundary.  It may only
 * start after its source has been checked for the legacy browser drivers.
 * Unknown or unreadable runners fail closed; the worker-level route gate is
 * still the primary admission boundary.
 */
export function inspectBrowserUseCliRunner(runner: string | undefined): BrowserUseCliRunnerInspection {
  const normalized = typeof runner === "string" ? runner.trim() : "";
  if (!normalized || !existsSync(normalized) || !statIsRegularFile(normalized)) {
    return blockedInspection(normalized, ["runner_missing"]);
  }

  let source = "";
  try {
    source = readFileSync(resolve(normalized), "utf8").slice(0, 512 * 1024);
  } catch {
    return blockedInspection(normalized, ["runner_unreadable"]);
  }

  const canonicalStageAdapter = (
    CANONICAL_STAGE_ADAPTER_SIGNAL.test(source) && CANONICAL_STAGE_EXECUTOR_SIGNAL.test(source)
  ) || (
    CANONICAL_REGISTERED_DAILY_AI_ENTRY_SIGNAL.test(source)
    && CANONICAL_REGISTERED_DAILY_AI_MODULE_SIGNAL.test(source)
    && CANONICAL_REGISTERED_SURFACE_SIGNAL.test(source)
  ) || (
    CANONICAL_REGISTERED_CLI_MODULE_SIGNAL.test(source)
    && CANONICAL_REGISTERED_SURFACE_SIGNAL.test(source)
  ) || (
    CANONICAL_REGISTERED_PYTHON_HELPER_SIGNAL.test(source)
    && CANONICAL_REGISTERED_SURFACE_SIGNAL.test(source)
  );
  const forbiddenSignals = [
    ...FORBIDDEN_RUNNER_PATH_SIGNALS.filter((pattern) => pattern.test(normalized)),
    ...FORBIDDEN_RUNNER_SOURCE_SIGNALS.filter((pattern) => {
      if (canonicalStageAdapter && COMPATIBILITY_BROWSER_PLUGIN_SIGNALS.some((compatibility) => compatibility.source === pattern.source)) return false;
      return pattern.test(source);
    }),
  ].map((pattern) => pattern.source);
  if (forbiddenSignals.length > 0) return blockedInspection(normalized, forbiddenSignals);
  if (!canonicalStageAdapter) return blockedInspection(normalized, ["canonical_stage_adapter_missing"]);

  return {
    ok: true,
    exactBlocker: null,
    runner: resolve(normalized),
    forbiddenSignals: []
  };
}

function blockedInspection(runner: string, forbiddenSignals: string[]): BrowserUseCliRunnerInspection {
  return {
    ok: false,
    exactBlocker: BROWSER_USE_CLI_WORKFLOW_ADAPTER_MISSING_BLOCKER,
    runner,
    forbiddenSignals
  };
}

function statIsRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

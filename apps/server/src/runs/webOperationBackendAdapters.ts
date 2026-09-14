import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { WebOperationBackend } from "./webOperationBackendSettings.js";

export type WebOperationAdapter =
  | "daily_ai_registered"
  | "nisenprints_registered"
  | "job_submit_registered"
  | "job_followup_registered"
  | "prompt_transfer_registered"
  | "sns_multi_poster_registered"
  | "x_authenticated_browser_lane_registered";

export type WebOperationAdapterCoverage = {
  adapter: WebOperationAdapter;
  chrome_plugin: boolean;
  browser_use_cli: boolean;
  playwright: boolean;
  aos_chrome_companion: boolean;
  chrome_plugin_mode: "effectful" | "entrypoint_only" | "not_bound";
  chrome_plugin_exact_blocker: string | null;
  chrome_plugin_next_action: string;
  chrome_plugin_runner_entrypoint: string | null;
  browser_use_cli_mode: "effectful" | "entrypoint_only" | "not_bound";
  browser_use_cli_exact_blocker: string | null;
  browser_use_cli_next_action: string;
  browser_use_cli_runner_entrypoint: string | null;
  playwright_mode: "effectful" | "entrypoint_only" | "not_bound";
  playwright_exact_blocker: string | null;
  playwright_next_action: string;
  playwright_runner_entrypoint: string | null;
  aos_chrome_companion_mode: "effectful" | "entrypoint_only" | "not_bound";
  aos_chrome_companion_exact_blocker: string | null;
  aos_chrome_companion_next_action: string;
  aos_chrome_companion_runner_entrypoint: string | null;
};

type AdapterDefinition = Omit<WebOperationAdapterCoverage, "adapter" | "browser_use_cli" | "playwright" | "aos_chrome_companion" | "aos_chrome_companion_mode" | "aos_chrome_companion_exact_blocker" | "aos_chrome_companion_next_action" | "aos_chrome_companion_runner_entrypoint">;

type SurfaceState = {
  mode: "effectful" | "entrypoint_only" | "not_bound";
  exactBlocker: string | null;
  nextAction: string;
  runnerEntrypoint: string | null;
};

function adapterProjectRoots(): string[] {
  return [...new Set([
    process.env.AOS_ADAPTER_PROJECT_ROOT?.trim(),
    process.env.AUTOMATION_OS_PROJECT_ROOT?.trim(),
    process.cwd(),
    resolve(process.cwd(), ".."),
    resolve(process.cwd(), "../.."),
    homedir(),
  ].filter((value): value is string => Boolean(value)))];
}

function regularFile(path: string): boolean {
  try {
    return existsSync(path) && lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Adapter metadata is useful only when the referenced entrypoint exists in
 * the current runtime. The old static table could claim an effectful adapter
 * while its path was absent, which made the UI and worker admission disagree.
 */
export function runnerEntrypointExists(entrypoint: string | null): boolean {
  if (!entrypoint) return false;
  if (entrypoint.startsWith("/")) return regularFile(entrypoint);
  const normalized = entrypoint.replace(/^automation-os\//u, "");
  return adapterProjectRoots().some((root) => [
    resolve(root, entrypoint),
    resolve(root, normalized),
  ].some(regularFile));
}

function effectiveSurface(input: {
  backend: WebOperationBackend;
  mode: SurfaceState["mode"];
  exactBlocker: string | null;
  nextAction: string;
  runnerEntrypoint: string | null;
}): SurfaceState {
  if (input.mode === "not_bound" || runnerEntrypointExists(input.runnerEntrypoint)) {
    return {
      mode: input.mode,
      exactBlocker: input.exactBlocker,
      nextAction: input.nextAction,
      runnerEntrypoint: input.runnerEntrypoint,
    };
  }
  return {
    mode: "not_bound",
    exactBlocker: "web_operation_" + input.backend + "_runner_entrypoint_missing",
    nextAction: "restore the current-run " + input.backend + " runner entrypoint before enabling this workflow",
    runnerEntrypoint: input.runnerEntrypoint,
  };
}

// Keep this list deliberately narrow. An adapter is bound only when AOS has a
// current-run entrypoint that selects the requested surface and returns the
// workflow's own completion/readback contract. A file that merely exists is
// reported as entrypoint_only and must not clear the worker admission gate.
const ADAPTER_DEFINITIONS: Record<WebOperationAdapter, AdapterDefinition> = {
  daily_ai_registered: {
    chrome_plugin: true,
    chrome_plugin_mode: "effectful",
    chrome_plugin_exact_blocker: null,
    chrome_plugin_next_action: "fresh bridge/profile readback and workflow receipt are required on every run",
    chrome_plugin_runner_entrypoint: "New project/scripts/run_daily_ai_chrome_plugin_registered.mjs",
    browser_use_cli_mode: "effectful",
    browser_use_cli_exact_blocker: null,
    browser_use_cli_next_action: "fresh Browser Use CLI authority, workflow receipt, source sync, reconciliation, and cleanup are required on every run",
    browser_use_cli_runner_entrypoint: "automation-os/scripts/aos-daily-ai-business-runner.mjs",
    playwright_mode: "entrypoint_only",
    playwright_exact_blocker: "playwright_effect_stages_not_implemented",
    playwright_next_action: "implement workflow-specific Playwright provider stages with receipt, source sync, reconciliation, and group-only cleanup before enabling effects",
    playwright_runner_entrypoint: "automation-os/scripts/aos-playwright-business-runner.mjs",
  },
  nisenprints_registered: {
    chrome_plugin: false,
    chrome_plugin_mode: "entrypoint_only",
    chrome_plugin_exact_blocker: "chrome_plugin_nisenprints_effect_stages_not_implemented",
    chrome_plugin_next_action: "extend the current Canva/Printify/Etsy/Pinterest read-only preflight into one approved stage at a time with provider receipts, listing/pin readback, source sync, and cleanup",
    chrome_plugin_runner_entrypoint: "New project/scripts/run_nisenprints_chrome_plugin_registered.mjs",
    browser_use_cli_mode: "effectful",
    browser_use_cli_exact_blocker: null,
    browser_use_cli_next_action: "fresh Browser Use CLI authority, listing/pin provider receipts, source sync, reconciliation, and cleanup are required on every run",
    browser_use_cli_runner_entrypoint: "automation-os/scripts/aos-nisenprints-business-runner.mjs",
    playwright_mode: "entrypoint_only",
    playwright_exact_blocker: "playwright_effect_stages_not_implemented",
    playwright_next_action: "implement workflow-specific Playwright provider stages with receipt, source sync, reconciliation, and group-only cleanup before enabling effects",
    playwright_runner_entrypoint: "automation-os/scripts/aos-playwright-business-runner.mjs",
  },
  job_submit_registered: {
    chrome_plugin: true,
    chrome_plugin_mode: "effectful",
    chrome_plugin_exact_blocker: null,
    chrome_plugin_next_action: "use the target-bound portable worker; the direct legacy route remains fail-closed",
    chrome_plugin_runner_entrypoint: "automation-os/scripts/aos-job-chrome-plugin-business-runner.mjs",
    browser_use_cli_mode: "effectful",
    browser_use_cli_exact_blocker: null,
    browser_use_cli_next_action: "use a fresh target-bound Browser Use CLI worker with provider receipt, ledger finalize, source sync, reconciliation, and cleanup",
    browser_use_cli_runner_entrypoint: "New project/scripts/browser_use/job_manager_browser_use_cli_business_runner.mjs",
    playwright_mode: "entrypoint_only",
    playwright_exact_blocker: "playwright_effect_stages_not_implemented",
    playwright_next_action: "implement workflow-specific Playwright provider stages with receipt, source sync, reconciliation, and group-only cleanup before enabling effects",
    playwright_runner_entrypoint: "automation-os/scripts/aos-playwright-business-runner.mjs",
  },
  job_followup_registered: {
    chrome_plugin: true,
    chrome_plugin_mode: "effectful",
    chrome_plugin_exact_blocker: null,
    chrome_plugin_next_action: "use the target-bound portable worker; the direct legacy route remains fail-closed",
    chrome_plugin_runner_entrypoint: "automation-os/scripts/aos-job-chrome-plugin-business-runner.mjs",
    browser_use_cli_mode: "effectful",
    browser_use_cli_exact_blocker: null,
    browser_use_cli_next_action: "use a fresh target-bound Browser Use CLI worker with provider receipt, ledger finalize, source sync, reconciliation, and cleanup",
    browser_use_cli_runner_entrypoint: "New project/scripts/browser_use/job_manager_browser_use_cli_business_runner.mjs",
    playwright_mode: "entrypoint_only",
    playwright_exact_blocker: "playwright_effect_stages_not_implemented",
    playwright_next_action: "implement workflow-specific Playwright provider stages with receipt, source sync, reconciliation, and group-only cleanup before enabling effects",
    playwright_runner_entrypoint: "automation-os/scripts/aos-playwright-business-runner.mjs",
  },
  prompt_transfer_registered: {
    chrome_plugin: true,
    chrome_plugin_mode: "effectful",
    chrome_plugin_exact_blocker: null,
    chrome_plugin_next_action: "fresh Docs/Sheets authority, approval-bound B:D write, same-range readback, source sync, and group-only cleanup are required on every run",
    chrome_plugin_runner_entrypoint: "New project/scripts/run_prompt_transfer_chrome_plugin_registered.mjs",
    browser_use_cli_mode: "effectful",
    browser_use_cli_exact_blocker: null,
    browser_use_cli_next_action: "fresh Docs/Sheets authority, same-run target readback, source sync, and cleanup are required; commit remains approval-gated",
    browser_use_cli_runner_entrypoint: ".agents/skills/prompt-transfer-ukiyoe/scripts/run_prompt_transfer_ukiyoe_browser_use.py",
    playwright_mode: "entrypoint_only",
    playwright_exact_blocker: "playwright_effect_stages_not_implemented",
    playwright_next_action: "implement workflow-specific Playwright provider stages with receipt, source sync, reconciliation, and group-only cleanup before enabling effects",
    playwright_runner_entrypoint: "automation-os/scripts/aos-playwright-business-runner.mjs",
  },
  sns_multi_poster_registered: {
    chrome_plugin: true,
    chrome_plugin_mode: "effectful",
    chrome_plugin_exact_blocker: null,
    chrome_plugin_next_action: "fresh Profile 2 account, post URL, source sync, and group-only cleanup proof are required on every run",
    chrome_plugin_runner_entrypoint: "New project/scripts/run_sns_multi_poster_chrome_plugin_registered.mjs",
    browser_use_cli_mode: "effectful",
    browser_use_cli_exact_blocker: null,
    browser_use_cli_next_action: "use the workflow-owned SNS Browser Use CLI runner; fresh account/target/authority and same-run provider/source/cleanup proof remain mandatory",
    browser_use_cli_runner_entrypoint: "New project/scripts/run_sns_multi_poster_ukiyoe_browser_use_cli.mjs",
    playwright_mode: "entrypoint_only",
    playwright_exact_blocker: "playwright_effect_stages_not_implemented",
    playwright_next_action: "implement workflow-specific Playwright provider stages with receipt, source sync, reconciliation, and group-only cleanup before enabling effects",
    playwright_runner_entrypoint: "automation-os/scripts/aos-playwright-business-runner.mjs",
  },
  x_authenticated_browser_lane_registered: {
    chrome_plugin: true,
    chrome_plugin_mode: "effectful",
    chrome_plugin_exact_blocker: null,
    chrome_plugin_next_action: "fresh Profile 2 X account, post URL, source sync, and group-only cleanup proof are required on every run",
    chrome_plugin_runner_entrypoint: "New project/scripts/run_sns_multi_poster_chrome_plugin_registered.mjs",
    browser_use_cli_mode: "effectful",
    browser_use_cli_exact_blocker: null,
    browser_use_cli_next_action: "use the workflow-owned X Browser Use CLI runner; fresh account/target/authority and same-run provider/source/cleanup proof remain mandatory",
    browser_use_cli_runner_entrypoint: "New project/scripts/run_x_authenticated_browser_lane_browser_use_cli.mjs",
    playwright_mode: "entrypoint_only",
    playwright_exact_blocker: "playwright_effect_stages_not_implemented",
    playwright_next_action: "implement workflow-specific Playwright provider stages with receipt, source sync, reconciliation, and group-only cleanup before enabling effects",
    playwright_runner_entrypoint: "automation-os/scripts/aos-playwright-business-runner.mjs",
  },
};

export function isWebOperationBackendAdapterBound(
  backend: WebOperationBackend,
  adapter: WebOperationAdapter,
): boolean {
  const coverage = webOperationBackendAdapterCoverage().find((item) => item.adapter === adapter);
  if (!coverage) return false;
  if (backend === "browser_use_cli") return coverage.browser_use_cli;
  if (backend === "aos_chrome_companion") return coverage.aos_chrome_companion;
  if (backend === "chrome_plugin") return coverage.chrome_plugin;
  return coverage.playwright;
}

export function isWebOperationAdapter(value: string | null | undefined): value is WebOperationAdapter {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ADAPTER_DEFINITIONS, value);
}

/**
 * Read-only preflight is allowed for an entrypoint-only adapter because it can
 * still expose the bounded reference/readback stage. A backend with no
 * current-run adapter must remain a No-Go; otherwise the inventory endpoint
 * could render a preflight button that the worker will reject after queueing.
 */
export function webOperationBackendAdapterReadOnlyBlocker(
  backend: WebOperationBackend,
  adapter: WebOperationAdapter,
): string | null {
  const coverage = webOperationBackendAdapterCoverage().find((item) => item.adapter === adapter);
  if (!coverage) return `web_operation_${backend}_adapter_not_bound`;
  const mode = backend === "chrome_plugin"
    ? coverage.chrome_plugin_mode
    : backend === "browser_use_cli"
      ? coverage.browser_use_cli_mode
      : backend === "aos_chrome_companion"
        ? coverage.aos_chrome_companion_mode
        : coverage.playwright_mode;
  if (mode !== "not_bound") return null;
  return backend === "chrome_plugin"
    ? coverage.chrome_plugin_exact_blocker || `web_operation_${backend}_adapter_not_bound`
    : backend === "browser_use_cli"
      ? coverage.browser_use_cli_exact_blocker || `web_operation_${backend}_adapter_not_bound`
      : backend === "aos_chrome_companion"
        ? coverage.aos_chrome_companion_exact_blocker || `web_operation_${backend}_adapter_not_bound`
      : coverage.playwright_exact_blocker || `web_operation_${backend}_adapter_not_bound`;
}

export function webOperationBackendAdapterCoverage(): WebOperationAdapterCoverage[] {
  const companionRunnerEntrypoint = resolve(process.cwd(), "scripts", "aos-portable-browser-use-runner.mjs");
  return (Object.entries(ADAPTER_DEFINITIONS) as [WebOperationAdapter, AdapterDefinition][]).map(([adapter, definition]) => {
    const chromePlugin = effectiveSurface({
      backend: "chrome_plugin",
      mode: definition.chrome_plugin_mode,
      exactBlocker: definition.chrome_plugin_exact_blocker,
      nextAction: definition.chrome_plugin_next_action,
      runnerEntrypoint: definition.chrome_plugin_runner_entrypoint,
    });
    const browserUseCli = effectiveSurface({
      backend: "browser_use_cli",
      mode: definition.browser_use_cli_mode,
      exactBlocker: definition.browser_use_cli_exact_blocker,
      nextAction: definition.browser_use_cli_next_action,
      runnerEntrypoint: definition.browser_use_cli_runner_entrypoint,
    });
    const playwright = effectiveSurface({
      backend: "playwright",
      mode: definition.playwright_mode,
      exactBlocker: definition.playwright_exact_blocker,
      nextAction: definition.playwright_next_action,
      runnerEntrypoint: definition.playwright_runner_entrypoint,
    });
    const aosChromeCompanion = effectiveSurface({
      backend: "aos_chrome_companion",
      mode: "effectful",
      exactBlocker: null,
      nextAction: "use fresh Companion authority, provider receipt, same-run source sync, reconciliation/no-replay, and terminal task-tab cleanup",
      runnerEntrypoint: companionRunnerEntrypoint,
    });
    return {
      adapter,
      chrome_plugin: chromePlugin.mode === "effectful",
      chrome_plugin_mode: chromePlugin.mode,
      chrome_plugin_exact_blocker: chromePlugin.exactBlocker,
      chrome_plugin_next_action: chromePlugin.nextAction,
      chrome_plugin_runner_entrypoint: chromePlugin.runnerEntrypoint,
      browser_use_cli: browserUseCli.mode === "effectful",
      browser_use_cli_mode: browserUseCli.mode,
      browser_use_cli_exact_blocker: browserUseCli.exactBlocker,
      browser_use_cli_next_action: browserUseCli.nextAction,
      browser_use_cli_runner_entrypoint: browserUseCli.runnerEntrypoint,
      playwright: playwright.mode === "effectful",
      playwright_mode: playwright.mode,
      playwright_exact_blocker: playwright.exactBlocker,
      playwright_next_action: playwright.nextAction,
      playwright_runner_entrypoint: playwright.runnerEntrypoint,
      aos_chrome_companion: aosChromeCompanion.mode === "effectful",
      aos_chrome_companion_mode: aosChromeCompanion.mode,
      aos_chrome_companion_exact_blocker: aosChromeCompanion.exactBlocker,
      aos_chrome_companion_next_action: aosChromeCompanion.nextAction,
      aos_chrome_companion_runner_entrypoint: aosChromeCompanion.runnerEntrypoint,
    };
  });
}

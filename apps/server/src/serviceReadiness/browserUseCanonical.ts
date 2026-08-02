/**
 * Machine-local canonical Browser Use CLI paths.
 *
 * The portable Browser Use package owns ~/.browser-use-cli. Keep every
 * Automation OS authority, receipt, manifest, and worker projection bound to
 * that same root so profile/port/room readbacks cannot split across ledgers.
 */
export const BROWSER_USE_STATE_ROOT = "/Users/nichikatanaka/.browser-use-cli" as const;
export const BROWSER_USE_HELPER_PATH = "/Users/nichikatanaka/.local/bin/codex-browser-use" as const;
export const BROWSER_USE_RUNTIME_CONFIG_PATH = `${BROWSER_USE_STATE_ROOT}/browser-use-runtime.toml` as const;
export const BROWSER_USE_HOME = `${BROWSER_USE_STATE_ROOT}/home` as const;
export const BROWSER_USE_SCHEDULED_PROFILE_ROOT = `${BROWSER_USE_STATE_ROOT}/profiles/scheduled` as const;
export const BROWSER_USE_SINGLE_USE_PROFILE_ROOT = `${BROWSER_USE_STATE_ROOT}/profiles/single-use` as const;
export const BROWSER_USE_TEMPORARY_PROFILE_ROOT = `${BROWSER_USE_STATE_ROOT}/profiles/temporary` as const;
export const BROWSER_USE_PROFILE_ROOT = `${BROWSER_USE_STATE_ROOT}/profiles` as const;
export const BROWSER_USE_LOCK_ROOT = `${BROWSER_USE_STATE_ROOT}/locks` as const;

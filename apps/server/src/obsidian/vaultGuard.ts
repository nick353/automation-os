import { resolve } from "node:path";

export const defaultObsidianVaultPath = "/Users/nichikatanaka/Documents/Obsidian Vault";
export const customObsidianExportError = "obsidian_custom_export_requires_approval";
export const customObsidianExportSummary = "custom vault selection requires AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT=1";

export type ObsidianVaultGuardResult =
  | {
      ok: true;
      vaultPath: string;
      customVaultRequested: boolean;
    }
  | {
      ok: false;
      vaultPath: string;
      customVaultRequested: true;
      error: typeof customObsidianExportError;
      summary: typeof customObsidianExportSummary;
    };

export function resolveConfiguredObsidianVaultPath(input?: string): string {
  return resolve(input ?? process.env.AUTOMATION_OS_OBSIDIAN_VAULT ?? defaultObsidianVaultPath);
}

export function guardObsidianVaultPath(input?: string): ObsidianVaultGuardResult {
  const vaultPath = resolveConfiguredObsidianVaultPath(input);
  const customVaultRequested = vaultPath !== resolve(defaultObsidianVaultPath);
  if (!customVaultRequested || process.env.AUTOMATION_OS_ALLOW_CUSTOM_OBSIDIAN_EXPORT === "1") {
    return { ok: true, vaultPath, customVaultRequested };
  }
  return {
    ok: false,
    vaultPath,
    customVaultRequested: true,
    error: customObsidianExportError,
    summary: customObsidianExportSummary
  };
}

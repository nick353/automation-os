import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import { withVaultWriteLockSync } from "./vaultWriteLock.js";

export type VaultHygieneResult = {
  ok: boolean;
  exactBlocker: string | null;
  checked: number;
  archived: string[];
  skipped: string[];
  archiveDir: string | null;
};

const untitledBasePattern = /^無題のファイル(?: \d+)?\.base$/u;
const emptyBaseBody = "views:\n  - type: table\n    name: 表";
const defaultMinimumAgeMs = 7 * 24 * 60 * 60 * 1000;

export function archiveStaleUntitledBases(input: {
  vaultPath: string;
  now?: Date;
  minimumAgeMs?: number;
}): VaultHygieneResult {
  const now = input.now ?? new Date();
  try {
    return withVaultWriteLockSync(input.vaultPath, "obsidian-vault-hygiene", () => {
      const candidates = existsSync(input.vaultPath)
        ? readdirSync(input.vaultPath).filter((name) => untitledBasePattern.test(name)).sort()
        : [];
      const archived: string[] = [];
      const skipped: string[] = [];
      let archiveDir: string | null = null;

      for (const name of candidates) {
        const source = join(input.vaultPath, name);
        const stat = lstatSync(source);
        const oldEnough = now.getTime() - stat.mtimeMs >= (input.minimumAgeMs ?? defaultMinimumAgeMs);
        const initialContent = stat.isFile() && !stat.isSymbolicLink() ? readFileSync(source, "utf8") : "";
        const exactEmptyBase = initialContent.trim() === emptyBaseBody;
        if (!oldEnough || !exactEmptyBase) {
          skipped.push(name);
          continue;
        }
        archiveDir ??= join(input.vaultPath, ".backups", "manual-cleanup", "untitled-bases", safeTimestamp(now));
        mkdirSync(archiveDir, { recursive: true });
        const target = join(archiveDir, name);
        if (existsSync(target) || statSync(source).mtimeMs !== stat.mtimeMs || readFileSync(source, "utf8") !== initialContent) {
          skipped.push(name);
          continue;
        }
        renameSync(source, target);
        archived.push(name);
      }

      return { ok: true, exactBlocker: null, checked: candidates.length, archived, skipped, archiveDir };
    });
  } catch (error) {
    return {
      ok: false,
      exactBlocker: error instanceof Error ? error.message : "obsidian_vault_hygiene_failed",
      checked: 0,
      archived: [],
      skipped: [],
      archiveDir: null
    };
  }
}

function safeTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

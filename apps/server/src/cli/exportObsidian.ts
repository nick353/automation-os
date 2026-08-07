import { initDb } from "../db/client.js";
import { runObsidianExportNow } from "../obsidian/autoExport.js";
import { runObsidianMaintenance } from "../obsidian/maintenance.js";
import { guardObsidianVaultPath } from "../obsidian/vaultGuard.js";

const vaultArg = process.argv.find((arg) => arg.startsWith("--vault="))?.slice("--vault=".length);
const reasonArg = process.argv.find((arg) => arg.startsWith("--reason="))?.slice("--reason=".length);
const reason = reasonArg?.trim() || "cli_manual_export";
const vaultGuard = guardObsidianVaultPath(vaultArg);

if (!vaultGuard.ok) {
  console.error(JSON.stringify({ ok: false, error: vaultGuard.error, summary: vaultGuard.summary }, null, 2));
  process.exitCode = 1;
} else {
  initDb();
  const maintenance = vaultArg || process.env.AUTOMATION_OS_OBSIDIAN_SKIP_MAINTENANCE === "1"
    ? undefined
    : runObsidianMaintenance();
  const refreshSessionIndex = process.env.AUTOMATION_OS_OBSIDIAN_REFRESH_CODEX_SESSION_INDEX === "0"
    ? false
    : process.env.AUTOMATION_OS_OBSIDIAN_REFRESH_CODEX_SESSION_INDEX === "1"
      ? true
      : process.env.AUTOMATION_OS_OBSIDIAN_EXPORT_SKIP_NON_GENERATED !== "1";
  const result = runObsidianExportNow(reason, {
    vaultPath: vaultArg,
    skipNonGenerated: process.env.AUTOMATION_OS_OBSIDIAN_EXPORT_SKIP_NON_GENERATED === "1",
    refreshCodexSessionIndex: refreshSessionIndex
  });
  console.log(JSON.stringify({ ...result, maintenance }, null, 2));
  if (result.ok === false) process.exitCode = 1;
}

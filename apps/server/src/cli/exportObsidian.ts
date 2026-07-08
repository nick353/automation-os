import { initDb } from "../db/client.js";
import { runObsidianExportNow } from "../obsidian/autoExport.js";
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
  const result = runObsidianExportNow(reason, { vaultPath: vaultArg });
  console.log(JSON.stringify(result, null, 2));
  if (result.ok === false) process.exitCode = 1;
}

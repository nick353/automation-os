import { auditProjects, writeProjectAuditStatus } from "../projects/projectAuditor.js";
import { guardObsidianVaultPath } from "../obsidian/vaultGuard.js";

const registryArg = process.argv.find((arg) => arg.startsWith("--registry="))?.slice("--registry=".length);
const vaultArg = process.argv.find((arg) => arg.startsWith("--vault="))?.slice("--vault=".length);
const outputArg = process.argv.find((arg) => arg.startsWith("--output="))?.slice("--output=".length);
const vaultGuard = guardObsidianVaultPath(vaultArg);

if (!vaultGuard.ok) {
  console.error(JSON.stringify({ ok: false, error: vaultGuard.error, summary: vaultGuard.summary }, null, 2));
  process.exitCode = 1;
} else {
  const result = auditProjects({ registryPath: registryArg, obsidianVaultPath: vaultArg });
  const statusFile = writeProjectAuditStatus(result, outputArg);
  console.log(JSON.stringify({ ...result, statusFile }, null, 2));
  if (!result.ok && process.env.AUTOMATION_OS_PROJECT_AUDIT_STRICT === "1") process.exitCode = 1;
}

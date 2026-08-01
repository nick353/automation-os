import { runObsidianGitSync } from "../obsidian/vaultGitSync.js";

const result = runObsidianGitSync({
  execute: process.argv.includes("--execute"),
  force: process.argv.includes("--force")
});
console.log(JSON.stringify(result, null, 2));
if (!result.ok && !result.skipped) process.exitCode = 1;

import { runObsidianMaintenance } from "../obsidian/maintenance.js";

const force = process.argv.includes("--force");
const result = runObsidianMaintenance({ force });
console.log(JSON.stringify(result, null, 2));
if (!result.ok && !result.skipped) process.exitCode = 1;

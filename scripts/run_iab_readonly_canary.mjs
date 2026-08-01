#!/usr/bin/env node

// Compatibility filename only. Delegate to the current Browser Use CLI canary;
// this file contains no retired browser-surface implementation.
import { spawnSync } from "node:child_process";
import path from "node:path";

const target = path.join(path.dirname(new URL(import.meta.url).pathname), "run_browser_use_readonly_canary.mjs");
const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = Number.isInteger(result.status) ? result.status : 1;

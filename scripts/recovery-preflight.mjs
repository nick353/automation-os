#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(process.env.AUTOMATION_OS_REPO_ROOT || join(dirname(fileURLToPath(import.meta.url)), ".."));
const requiredFiles = [
  "package.json",
  "package-lock.json",
  "README.md",
  "docs/RECOVERY_RUNBOOK.md",
  "docs/portable-worker-contract.md",
  "ops/zeabur/Dockerfile.codex-app-server",
  "ops/zeabur/start-codex-app-server.sh",
  "scripts/portable-worker-profile.mjs",
  "scripts/portable-external-runner.mjs",
  "scripts/aos-portable-remote-worker.mjs"
];

function gitValue(args) {
  try { return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
}

function safeRemote(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return "configured_remote_redacted";
  }
}

const missingFiles = requiredFiles.filter((relativePath) => !existsSync(join(repoRoot, relativePath)));
const packageJson = existsSync(join(repoRoot, "package.json")) ? JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) : {};
const result = {
  schema: "aos.recovery_source_preflight.v1",
  status: missingFiles.length ? "blocked" : "ready_for_recovery",
  exact_blocker: missingFiles.length ? `recovery_source_file_missing:${missingFiles[0]}` : null,
  repo_root: repoRoot,
  git_remote: safeRemote(gitValue(["remote", "get-url", "origin"])),
  git_ref: gitValue(["branch", "--show-current"]),
  package_name: packageJson.name || null,
  required_files: Object.fromEntries(requiredFiles.map((relativePath) => [relativePath, existsSync(join(repoRoot, relativePath))])),
  required_secret_inputs: [
    "DATABASE_URL or AUTOMATION_OS_DATABASE_URL",
    "AUTOMATION_OS_READ_TOKEN or protected read token file",
    "AUTOMATION_OS_WRITE_TOKEN or protected write token file",
    "AOS worker token in Keychain or a protected token file",
    "Codex login in the selected CODEX_HOME when Codex execution is required"
  ],
  secrets_read: false,
  external_action_executed: false,
  next_action: missingFiles.length
    ? "Restore the missing source files from the published AOS GitHub ref, then rerun this preflight."
    : "Inject host-managed secrets, run npm ci, npm run build, the Codex App Server source preflight, and a read-only AOS readiness/canary sequence."
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = missingFiles.length ? 2 : 0;

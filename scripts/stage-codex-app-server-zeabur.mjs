#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceFiles = [
  ["ops/zeabur/Dockerfile.codex-app-server", "Dockerfile"],
  ["ops/zeabur/start-codex-app-server.sh", "ops/zeabur/start-codex-app-server.sh"],
];

function fail(message) {
  throw new Error(message);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function sha256(filePath) {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

const output = argument("--output");
if (!output || !path.isAbsolute(output) || path.resolve(output) !== output) {
  fail("--output must be a canonical absolute path");
}

try {
  await fs.lstat(output);
  fail("--output already exists; refusing to overwrite a staging directory");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

await fs.mkdir(output, { recursive: true, mode: 0o700 });
const staged = [];
for (const [relativeSource, relativeTarget] of sourceFiles) {
  const source = path.join(repoRoot, relativeSource);
  const target = path.join(output, relativeTarget);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  if (relativeTarget.endsWith(".sh")) await fs.chmod(target, 0o755);
  staged.push({
    source: relativeSource,
    target: relativeTarget,
    sha256: await sha256(target),
  });
}

const dockerfile = await fs.readFile(path.join(output, "Dockerfile"), "utf8");
if (!dockerfile.includes("COPY ops/zeabur/start-codex-app-server.sh /usr/local/bin/start-codex-app-server")) {
  fail("staged Dockerfile source boundary mismatch");
}

console.log(JSON.stringify({
  schema: "codex_app_server_zeabur_staging.v1",
  status: "ready_for_cli_deploy_preflight",
  output,
  context_file_count: staged.length,
  staged,
  competing_root_files_excluded: ["zbpack.json", "package.json", "apps/", "work/"],
  deploy_command_boundary: "run zeabur deploy only from this exact staging directory with explicit project/environment/service target",
  external_action_executed: false,
  secrets_read: false,
}, null, 2));

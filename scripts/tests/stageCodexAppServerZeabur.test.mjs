import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("Codex App Server staging excludes competing workspace sources", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aos-codex-stage-test-"));
  const output = path.resolve(tempRoot, "stage");
  const { stdout } = await execFileAsync(process.execPath, [
    path.join(repoRoot, "scripts/stage-codex-app-server-zeabur.mjs"),
    "--output",
    output,
  ], { cwd: repoRoot, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout);
  assert.equal(result.status, "ready_for_cli_deploy_preflight");
  assert.equal(result.context_file_count, 3);
  assert.deepEqual(result.competing_root_files_excluded, ["zbpack.json", "package.json", "apps/", "work/"]);
  assert.deepEqual((await fs.readdir(output)).sort(), ["Dockerfile", "ops", "scripts"]);
  assert.equal(await fs.readFile(path.join(output, "Dockerfile"), "utf8").then((value) => value.includes("CODEX_CLI_VERSION=0.153.4")), true);
  assert.equal(await fs.readFile(path.join(output, "Dockerfile"), "utf8").then((value) => value.includes("COPY scripts/codex-app-server-auth-readback.mjs /app/scripts/codex-app-server-auth-readback.mjs")), true);
  const readback = path.join(output, "scripts/codex-app-server-auth-readback.mjs");
  assert.equal((await fs.stat(readback)).isFile(), true);
  const stagedReadback = result.staged.find((entry) => entry.target === "scripts/codex-app-server-auth-readback.mjs");
  assert.match(stagedReadback?.sha256 || "", /^[a-f0-9]{64}$/u);
  assert.equal(stagedReadback?.sha256, stagedReadback?.source_sha256);
  assert.equal((await fs.stat(path.join(output, "ops/zeabur/start-codex-app-server.sh"))).mode & 0o777, 0o755);
});

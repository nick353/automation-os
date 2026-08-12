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
  assert.equal(result.context_file_count, 2);
  assert.deepEqual(result.competing_root_files_excluded, ["zbpack.json", "package.json", "apps/", "work/"]);
  assert.deepEqual((await fs.readdir(output)).sort(), ["Dockerfile", "ops"]);
  assert.equal(await fs.readFile(path.join(output, "Dockerfile"), "utf8").then((value) => value.includes("CODEX_CLI_VERSION=0.145.0")), true);
  assert.equal((await fs.stat(path.join(output, "ops/zeabur/start-codex-app-server.sh"))).mode & 0o777, 0o755);
});

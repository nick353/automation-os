import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(import.meta.dirname, "../codex-app-server-auth-readback.mjs");

async function createFakeCodex(root) {
  const cliPath = path.join(root, "codex");
  const recordPath = path.join(root, "requests.jsonl");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const recordPath = ${JSON.stringify(recordPath)};
const threadId = "thread-readback-test";
const turnId = "turn-readback-test";
function reply(id, result) { process.stdout.write(JSON.stringify({ id, result }) + "\\n"); }
function record(request) {
  fs.appendFileSync(recordPath, JSON.stringify({
    method: request.method,
    params: request.params,
    env: {
      openaiApiKey: process.env.OPENAI_API_KEY ?? null,
      codexAccessToken: process.env.CODEX_ACCESS_TOKEN ?? null,
      codexHome: process.env.CODEX_HOME ?? null
    }
  }) + "\\n");
}
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    record(request);
    if (request.method === "initialize") reply(request.id, { protocolVersion: "test" });
    else if (request.method === "account/read") reply(request.id, { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: false });
    else if (request.method === "thread/start") reply(request.id, { thread: { id: threadId } });
    else if (request.method === "turn/start") {
      reply(request.id, { turn: { id: turnId } });
      setImmediate(() => process.stdout.write(JSON.stringify({ method: "turn/completed", params: { turn: { id: turnId, status: "completed" } } }) + "\\n"));
    }
  }
});
`;
  await fs.writeFile(cliPath, source, { mode: 0o700 });
  return { cliPath, recordPath };
}

test("runs the bounded auth/thread/turn readback without forwarding secrets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aos-codex-auth-readback-test-"));
  const workspace = path.join(root, "workspace");
  const codexHome = path.join(root, "codex-home");
  await fs.mkdir(workspace);
  await fs.mkdir(codexHome);
  const { cliPath, recordPath } = await createFakeCodex(root);
  const { stdout } = await execFileAsync(process.execPath, [scriptPath], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${root}${path.delimiter}${process.env.PATH || ""}`,
      CODEX_CLI_PATH: cliPath,
      CODEX_HOME: codexHome,
      CODEX_APP_SERVER_READBACK_CWD: workspace,
      OPENAI_API_KEY: "must-not-forward",
      CODEX_ACCESS_TOKEN: "must-not-forward"
    },
    maxBuffer: 1024 * 1024
  });

  const output = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(output.map((entry) => entry.stage), ["account/read", "thread/start", "turn/start", "turn/completed"]);
  assert.equal(output.at(-1).status, "completed");

  const requests = (await fs.readFile(recordPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(requests.map((request) => request.method), ["initialize", "initialized", "account/read", "thread/start", "turn/start"]);
  assert.equal(requests[1].params?.approvalPolicy, undefined);
  assert.deepEqual(requests[3].params, {
    approvalPolicy: "never",
    sandbox: "read-only",
    serviceName: "automation_os_auth_readback",
    ephemeral: true,
    cwd: workspace
  });
  assert.equal(requests[4].params.approvalPolicy, "never");
  assert.equal(requests[4].params.cwd, workspace);
  assert.deepEqual(requests.map((request) => request.env.openaiApiKey), [null, null, null, null, null]);
  assert.deepEqual(requests.map((request) => request.env.codexAccessToken), [null, null, null, null, null]);
  assert.equal(requests[0].env.codexHome, codexHome);
});

test("rejects an explicitly configured non-executable Codex CLI path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aos-codex-auth-readback-path-test-"));
  const missingPath = path.join(root, "missing-codex");
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath], {
      cwd: root,
      env: { ...process.env, CODEX_CLI_PATH: missingPath, CODEX_APP_SERVER_READBACK_CWD: root },
      maxBuffer: 1024 * 1024
    }),
    (error) => {
      const output = String(error.stdout || "").trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(output, [{
        stage: "error",
        exact_error: "configured_codex_cli_not_executable",
        rpc_error_code: null,
        rpc_error_data_keys: []
      }]);
      return error.code === 1;
    }
  );
});

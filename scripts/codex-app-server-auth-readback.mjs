#!/usr/bin/env node

/**
 * Read-only local Codex App Server auth/protocol readback.
 *
 * This intentionally uses the official local stdio transport and the
 * persisted Codex login. It never passes OPENAI_API_KEY/CODEX_ACCESS_TOKEN
 * to the child, never prints raw protocol payloads, and never starts AOS or
 * Browser Use work.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const workspace = path.resolve(process.env.CODEX_APP_SERVER_READBACK_CWD?.trim() || process.cwd());
const timeoutMs = 60_000;
const allowedEnvironment = new Set([
  "PATH", "HOME", "CODEX_HOME", "CODEX_CLI_PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM",
  "USER", "LOGNAME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"
]);

const childEnvironment = {};
for (const [key, value] of Object.entries(process.env)) {
  if (allowedEnvironment.has(key) && typeof value === "string") childEnvironment[key] = value;
}
childEnvironment.AUTOMATION_OS_CODEX_APP_SERVER_CHILD = "1";

let lineBuffer = "";
let nextId = 1;
let closed = false;
const pending = new Map();

async function isExecutable(filePath) {
  try {
    const stat = await fs.stat(filePath);
    await fs.access(filePath, fs.constants.X_OK);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function resolveCodexCommand() {
  const configuredPath = process.env.CODEX_CLI_PATH?.trim();
  if (configuredPath) {
    const candidate = path.resolve(configuredPath);
    if (await isExecutable(candidate)) return candidate;
    throw new Error("configured_codex_cli_not_executable");
  }

  const bundledPath = "/usr/local/bin/codex";
  if (await isExecutable(bundledPath)) return bundledPath;

  for (const entry of (process.env.PATH || "").split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.resolve(entry, "codex");
    if (await isExecutable(candidate)) return candidate;
  }
  throw new Error("codex_cli_not_found");
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function rpc(method, params) {
  if (closed) return Promise.reject(new Error("process_closed"));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method.replaceAll("/", "_")}_timeout`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    } catch {
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error("write_failed"));
    }
  });
}

function accountReadback(response) {
  const account = response?.result?.account;
  return {
    account_present: Boolean(account && typeof account === "object"),
    account_type: typeof account?.type === "string" ? account.type : null,
    plan_type: typeof account?.planType === "string" ? account.planType : null,
    requires_openai_auth: response?.result?.requiresOpenaiAuth === true
  };
}

let child = null;
let completed = false;
let exitCode = 0;
try {
  const command = await resolveCodexCommand();
  child = spawn(command, ["app-server", "--listen", "stdio://"], {
    cwd: workspace,
    env: childEnvironment,
    stdio: ["pipe", "pipe", "pipe"]
  });

  child.stderr.on("data", () => {
    // stderr can contain implementation details or sensitive diagnostics.
  });

  const completedTurns = new Map();
  child.stdout.on("data", (chunk) => {
    lineBuffer += String(chunk);
    while (true) {
      const newline = lineBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = lineBuffer.slice(0, newline).trim();
      lineBuffer = lineBuffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof message.id === "number") {
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        if (message.error) {
          // Keep only the numeric JSON-RPC code. The server message may contain
          // paths, URLs, provider data, or credential-like text.
          const code = Number.isSafeInteger(message.error.code) ? String(message.error.code) : "unknown";
          const error = new Error(`rpc_rejected_code_${code}`);
          error.rpcErrorCode = code;
          error.rpcErrorDataKeys = message.error.data && typeof message.error.data === "object"
            ? Object.keys(message.error.data).slice(0, 20)
            : [];
          waiter.reject(error);
        }
        else waiter.resolve(message);
        continue;
      }
      if (message.method === "turn/completed" && typeof message.params?.turn?.id === "string") {
        completedTurns.set(message.params.turn.id, {
          status: typeof message.params.turn.status === "string" ? message.params.turn.status : "unknown"
        });
      }
    }
  });

  child.on("error", () => {
    closed = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("process_error"));
    }
    pending.clear();
  });

  child.on("close", () => {
    closed = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("process_closed"));
    }
    pending.clear();
  });

  const initialize = await rpc("initialize", {
    clientInfo: { name: "automation_os_auth_readback", title: "Automation OS Auth Readback", version: "0.1.0" },
    capabilities: {}
  });
  if (!initialize?.result) throw new Error("initialize_rejected");
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");

  const accountResponse = await rpc("account/read", { refreshToken: false });
  const account = accountReadback(accountResponse);
  output({ stage: "account/read", ...account });
  // `requiresOpenaiAuth` describes the auth mode supported by the server;
  // it is not an unauthenticated result when account/read also returned an
  // account. Let the read-only thread/turn canary prove usable credentials.
  if (!account.account_present) {
    output({
      stage: "blocked",
      exact_blocker: "codex_app_server_chatgpt_login_required",
      next_action: "Complete the official ChatGPT login with codex login, then rerun this readback.",
      restart_point: "account/read on a fresh local stdio app-server connection"
    });
    exitCode = 2;
  } else {
    const threadResponse = await rpc("thread/start", {
      approvalPolicy: "never",
      sandbox: "read-only",
      serviceName: "automation_os_auth_readback",
      ephemeral: true,
      cwd: workspace
    });
    const threadId = typeof threadResponse?.result?.thread?.id === "string" ? threadResponse.result.thread.id : null;
    output({ stage: "thread/start", thread_started: Boolean(threadId) });
    if (!threadId) throw new Error("thread_id_missing");

    const turnResponse = await rpc("turn/start", {
      threadId,
      input: [{ type: "text", text: "Return READY only. Do not use tools or modify files.", text_elements: [] }],
      approvalPolicy: "never",
      cwd: workspace
    });
    const turnId = typeof turnResponse?.result?.turn?.id === "string" ? turnResponse.result.turn.id : null;
    output({ stage: "turn/start", turn_started: Boolean(turnId) });
    if (!turnId) throw new Error("turn_id_missing");

    const deadline = Date.now() + timeoutMs;
    let completion;
    while (Date.now() < deadline) {
      completion = completedTurns.get(turnId);
      if (completion) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!completion) throw new Error("turn_completion_timeout");
    output({
      stage: "turn/completed",
      completion_observed: true,
      status: completion.status
    });
  }
} catch (error) {
  output({
    stage: "error",
    exact_error: String(error?.message ?? "unknown").replace(/[^a-zA-Z0-9_:-]/g, "_"),
    rpc_error_code: typeof error?.rpcErrorCode === "string" ? error.rpcErrorCode : null,
    rpc_error_data_keys: Array.isArray(error?.rpcErrorDataKeys) ? error.rpcErrorDataKeys : []
  });
  exitCode = 1;
} finally {
  completed = true;
  if (child && !child.killed) child.kill("SIGTERM");
}

process.exitCode = exitCode;

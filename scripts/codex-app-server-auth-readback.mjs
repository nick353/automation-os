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

const workspace = "/Users/nichikatanaka/Documents/Codex/automation-os";
const command = process.env.CODEX_CLI_PATH?.trim() || "/Users/nichikatanaka/.local/bin/codex";
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

const child = spawn(command, ["app-server", "--listen", "stdio://"], {
  cwd: workspace,
  env: childEnvironment,
  stdio: ["pipe", "pipe", "pipe"]
});

let lineBuffer = "";
let nextId = 1;
let closed = false;
const pending = new Map();
const notifications = [];

child.stderr.on("data", () => {
  // stderr can contain implementation details or sensitive diagnostics.
});

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
      if (message.error) waiter.reject(new Error("rpc_rejected"));
      else waiter.resolve(message);
      continue;
    }
    if (typeof message.method === "string") notifications.push(message);
  }
});

child.on("close", (code, signal) => {
  closed = true;
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error("process_closed"));
  }
  pending.clear();
  if (!completed) {
    output({ stage: "process_closed", code, signal });
  }
});

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

let completed = false;
let exitCode = 0;
try {
  const initialize = await rpc("initialize", {
    clientInfo: { name: "automation_os_auth_readback", title: "Automation OS Auth Readback", version: "0.1.0" },
    capabilities: {}
  });
  if (!initialize?.result) throw new Error("initialize_rejected");
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");

  const accountResponse = await rpc("account/read", { refreshToken: false });
  const account = accountReadback(accountResponse);
  output({ stage: "account/read", ...account });
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
      permissionProfile: ":read-only",
      cwd: workspace
    });
    const turnId = typeof turnResponse?.result?.turn?.id === "string" ? turnResponse.result.turn.id : null;
    output({ stage: "turn/start", turn_started: Boolean(turnId) });
    if (!turnId) throw new Error("turn_id_missing");

    const deadline = Date.now() + timeoutMs;
    let completion;
    while (Date.now() < deadline) {
      completion = notifications.find((message) =>
        message.method === "turn/completed" && message.params?.turn?.id === turnId
      );
      if (completion) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!completion) throw new Error("turn_completion_timeout");
    output({
      stage: "turn/completed",
      completion_observed: true,
      status: typeof completion.params?.turn?.status === "string" ? completion.params.turn.status : "unknown"
    });
  }
} catch (error) {
  output({ stage: "error", exact_error: String(error?.message ?? "unknown").replace(/[^a-zA-Z0-9_:-]/g, "_") });
  exitCode = 1;
} finally {
  completed = true;
  child.kill("SIGTERM");
}

process.exitCode = exitCode;

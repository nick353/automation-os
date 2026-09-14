import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const CODEX_APP_SERVER_BINARY = "/Applications/ChatGPT.app/Contents/Resources/codex";
const JOB_SCHEMA = "aos.codex_app_server_continuation_job.v1";
const RESULT_SCHEMA = "aos.codex_app_server_continuation_result.v1";
const MAX_JOB_BYTES = 256 * 1024;
const DEFAULT_OBSERVATION_MS = 30_000;

function clean(value, max = 400) {
  return String(value ?? "")
    .replace(/[\u0000\r\n]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

function fail(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.details = details;
  return error;
}

function serializedError(error) {
  if (!error || typeof error !== "object") return null;
  const details = error.details && typeof error.details === "object" && !Array.isArray(error.details)
    ? error.details
    : {};
  const method = clean(error.method, 120);
  const code = clean(details.code || error.code, 120);
  const message = clean(details.message || error.message, 300);
  if (!method && !code && !message) return null;
  return {
    ...(method ? { method } : {}),
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
  };
}

function atomicWrite(file, value) {
  const target = path.resolve(file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
}

function readJob(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_JOB_BYTES) throw fail("continuation_worker_job_invalid");
  const job = JSON.parse(fs.readFileSync(file, "utf8"));
  if (job?.schema !== JOB_SCHEMA
    || typeof job.threadId !== "string" || !job.threadId
    || typeof job.prompt !== "string" || !job.prompt.trim()
    || typeof job.resultPath !== "string" || !job.resultPath) {
    throw fail("continuation_worker_job_invalid");
  }
  return job;
}

function rpcClient(binary = CODEX_APP_SERVER_BINARY) {
  const child = spawn(binary, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "ignore"] });
  let buffer = "";
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  const notifications = [];
  const rejectAll = (error) => {
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  };
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id !== undefined && pending.has(message.id)) {
        const item = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          const error = fail(`codex_app_server_protocol_error:${item.method}`, {
            message: clean(message.error.message, 300),
            code: clean(message.error.code, 120),
          });
          error.method = item.method;
          item.reject(error);
        }
        else item.resolve(message.result);
      } else {
        notifications.push(message);
        if (notifications.length > 100) notifications.shift();
      }
    }
  });
  child.on("error", (error) => {
    closed = true;
    rejectAll(error);
  });
  child.on("close", () => {
    closed = true;
    rejectAll(fail("codex_app_server_closed"));
  });
  const request = (method, params = {}, timeoutMs = 30_000) => new Promise((resolve, reject) => {
    if (closed) {
      reject(fail("codex_app_server_closed"));
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(fail(`codex_app_server_timeout:${method}`));
    }, timeoutMs);
    pending.set(id, {
      method,
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const waitForCompletion = async (threadId, turnId, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const existing = notifications.find((message) =>
        message?.method === "turn/completed"
        && String(message?.params?.threadId || "") === String(threadId)
        && String(message?.params?.turn?.id || message?.params?.turnId || "") === String(turnId));
      if (existing) return existing;
      if (closed) throw fail("codex_app_server_closed");
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    }
    // An observation deadline must never cancel the destination's turn.
    return null;
  };
  return {
    child,
    request,
    waitForCompletion,
    close() {
      if (!closed) {
        closed = true;
        try { child.kill("SIGTERM"); } catch { /* already terminal */ }
      }
    },
  };
}

export async function runContinuationJob(job, { createClient = rpcClient, persist = atomicWrite } = {}) {
  const client = createClient(job.binary || CODEX_APP_SERVER_BINARY);
  let turnId = null;
  try {
    await client.request("initialize", {
      clientInfo: { name: "aos-companion-continuation-worker", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    client.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    await client.request("thread/resume", {
      threadId: job.threadId,
      ...(typeof job.cwd === "string" && job.cwd.trim() ? { cwd: job.cwd.trim() } : {}),
      excludeTurns: true,
    });
    const started = await client.request("turn/start", {
      threadId: job.threadId,
      ...(typeof job.cwd === "string" && job.cwd.trim() ? { cwd: job.cwd.trim() } : {}),
      input: [{ type: "text", text: job.prompt, text_elements: [] }],
    });
    turnId = started?.turn?.id ?? started?.turnId ?? null;
    if (!turnId) throw fail("codex_app_server_turn_id_missing");
    const progress = {
      schema: RESULT_SCHEMA, jobId: job.jobId, threadId: job.threadId,
      idempotencyKey: job.idempotencyKey, turnId, turnStatus: "inProgress",
      status: "running", exactBlocker: null, externalActionExecuted: false,
    };
    // Record the exact turn immediately, before the heartbeat stops observing.
    // The detached worker owns its connection until the turn is actually terminal.
    let completion;
    do {
      persist(job.resultPath, { ...progress, recordedAt: new Date().toISOString() });
      completion = await client.waitForCompletion(job.threadId, turnId,
        Math.max(1, Math.min(Number(job.observationMs) || DEFAULT_OBSERVATION_MS, 60_000)));
    } while (!completion);
    const status = clean(completion?.params?.turn?.status, 80) || "unknown";
    return {
      schema: RESULT_SCHEMA,
      jobId: clean(job.jobId, 200) || null,
      threadId: job.threadId,
      idempotencyKey: clean(job.idempotencyKey, 200) || null,
      status: status === "completed" ? "completed" : "failed",
      turnId: clean(turnId, 200) || null,
      turnStatus: status,
      exactBlocker: status === "completed" ? null : "codex_app_server_turn_failed",
      externalActionExecuted: false,
      recordedAt: new Date().toISOString(),
    };
  } catch (error) {
    const preDispatchNoEffect = error?.method === "thread/resume" && turnId === null;
    const errorSummary = serializedError(error);
    return {
      schema: RESULT_SCHEMA,
      jobId: clean(job.jobId, 200) || null,
      threadId: job.threadId,
      idempotencyKey: clean(job.idempotencyKey, 200) || null,
      status: "failed",
      turnId: clean(turnId, 200) || null,
      turnStatus: null,
      exactBlocker: clean(error?.code || error?.message, 240) || "continuation_worker_failed",
      ...(preDispatchNoEffect ? { preDispatchNoEffect: true } : {}),
      ...(errorSummary ? { error: errorSummary } : {}),
      externalActionExecuted: false,
      recordedAt: new Date().toISOString(),
    };
  } finally {
    client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
const jobFlag = process.argv.indexOf("--job");
const jobPath = jobFlag >= 0 ? process.argv[jobFlag + 1] : null;
if (!jobPath || !path.isAbsolute(jobPath)) process.exitCode = 2;
else {
  let job;
  try {
    job = readJob(jobPath);
    const result = await runContinuationJob(job);
    atomicWrite(job.resultPath, result);
  } catch (error) {
    try {
      const fallback = job || { schema: JOB_SCHEMA, jobId: null, threadId: null, idempotencyKey: null };
      const errorSummary = serializedError(error);
      atomicWrite(fallback.resultPath || `${jobPath}.result.json`, {
        schema: RESULT_SCHEMA,
        jobId: clean(fallback.jobId, 200) || null,
        threadId: clean(fallback.threadId, 200) || null,
        idempotencyKey: clean(fallback.idempotencyKey, 200) || null,
        status: "failed",
        turnId: null,
        turnStatus: null,
        exactBlocker: clean(error?.code || error?.message, 240) || "continuation_worker_failed",
        ...(errorSummary ? { error: errorSummary } : {}),
        externalActionExecuted: false,
        recordedAt: new Date().toISOString(),
      });
    } catch { /* no safe result path */ }
    process.exitCode = 1;
  }
}
}

#!/usr/bin/env node

/**
 * Read-only Codex App Server WSS canary.
 *
 * This file is also copied into the dedicated Zeabur service exec boundary by
 * the operator. It reads the token only from the service secret file and
 * emits safe booleans/blockers; it never prints protocol payloads or secrets.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";

const urlText = process.env.CODEX_APP_SERVER_WSS_URL || "wss://codex-app-server.zeabur.app/";
const tokenFile = process.env.CODEX_APP_SERVER_TOKEN_FILE || "/run/secrets/codex-app-server-token";
const timeoutMs = 35_000;

function safeOutput(value, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(value)}\n`, () => process.exit(exitCode));
}

function parseUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash) {
    throw new Error("wss_url_invalid");
  }
  return url;
}

function maskedTextFrame(value) {
  const payload = Buffer.from(value, "utf8");
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length | 0x80]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126 | 0x80;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127 | 0x80;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function parseFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      const largeLength = buffer.readBigUInt64BE(offset + 2);
      if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("frame_too_large");
      length = Number(largeLength);
      headerLength = 10;
    }
    const masked = (second & 0x80) !== 0;
    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + length;
    if (buffer.length - offset < frameLength) break;
    let payload = Buffer.from(buffer.subarray(offset + headerLength + maskLength, offset + frameLength));
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }
    frames.push({ opcode, payload });
    offset += frameLength;
  }
  return { frames, rest: buffer.subarray(offset) };
}

let url;
let token;
try {
  url = parseUrl(urlText);
  const stat = fs.statSync(tokenFile);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("token_file_permissions_invalid");
  token = fs.readFileSync(tokenFile, "utf8").trim();
  if (!token) throw new Error("token_file_empty");
} catch (error) {
  safeOutput({ schema: "codex_app_server_zeabur_wss_readback.v1", status: "blocked", exact_blocker: error instanceof Error ? error.message : "readback_setup_failed" }, 2);
}

let socket;
let buffer = Buffer.alloc(0);
let stage = "connect";
let threadId;
let turnId;
let finished = false;
let timeout;

function finish(result, exitCode = 0) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  try {
    socket?.destroy();
  } catch {
    // cleanup only
  }
  safeOutput({
    schema: "codex_app_server_zeabur_wss_readback.v1",
    url: `${url.protocol}//${url.host}${url.pathname || "/"}`,
    ...result
  }, exitCode);
}

function send(message) {
  socket.write(maskedTextFrame(JSON.stringify(message)));
}

function handleMessage(text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    finish({ status: "blocked", stage, exact_blocker: "rpc_payload_invalid" }, 2);
    return;
  }
  if (message.error) {
    finish({ status: "blocked", stage, exact_blocker: "rpc_rejected", authenticated_wss: true }, 2);
    return;
  }
  if (message.id === 1) {
    stage = "account/read";
    send({ method: "initialized", params: {} });
    send({ id: 2, method: "account/read", params: { refreshToken: false } });
    return;
  }
  if (message.id === 2) {
    const account = message.result?.account;
    const accountPresent = Boolean(account && typeof account === "object");
    const requiresOpenaiAuth = message.result?.requiresOpenaiAuth === true;
    if (!accountPresent) {
      finish({ status: "blocked", stage: "account/read", authenticated_wss: true, account_present: false, requires_openai_auth: requiresOpenaiAuth, exact_blocker: "zeabur_codex_app_server_chatgpt_login_required" }, 2);
      return;
    }
    stage = "thread/start";
    send({ id: 3, method: "thread/start", params: { approvalPolicy: "never", sandbox: "read-only", serviceName: "automation_os_zeabur_wss_readback", ephemeral: true, cwd: "/app" } });
    return;
  }
  if (message.id === 3) {
    threadId = typeof message.result?.thread?.id === "string" ? message.result.thread.id : null;
    if (!threadId) {
      finish({ status: "blocked", stage: "thread/start", authenticated_wss: true, thread_started: false, exact_blocker: "thread_id_missing" }, 2);
      return;
    }
    stage = "turn/start";
    send({ id: 4, method: "turn/start", params: { threadId, input: [{ type: "text", text: "Return READY only. Do not use tools or modify files.", text_elements: [] }], approvalPolicy: "never", permissionProfile: ":read-only", cwd: "/app" } });
    return;
  }
  if (message.id === 4) {
    turnId = typeof message.result?.turn?.id === "string" ? message.result.turn.id : null;
    if (!turnId) {
      finish({ status: "blocked", stage: "turn/start", authenticated_wss: true, thread_started: Boolean(threadId), turn_started: false, exact_blocker: "turn_id_missing" }, 2);
    }
    return;
  }
  if (message.method === "turn/completed" && turnId && message.params?.turn?.id === turnId) {
    finish({ status: "passed", stage: "turn/completed", authenticated_wss: true, account_present: true, thread_started: true, turn_started: true, completion_observed: true, turn_status: typeof message.params?.turn?.status === "string" ? message.params.turn.status : "unknown", external_action_executed: false }, 0);
  }
}

const request = https.request({
  hostname: url.hostname,
  port: url.port || 443,
  path: `${url.pathname || "/"}${url.search}`,
  method: "GET",
  headers: {
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
    Authorization: `Bearer ${token}`
  }
}, (response) => {
  finish({ status: "blocked", stage: "connect", authenticated_wss: false, http_status: response.statusCode, exact_blocker: "websocket_upgrade_rejected" }, 2);
  response.resume();
});

request.on("upgrade", (response, upgradedSocket, head) => {
  if (response.statusCode !== 101) {
    finish({ status: "blocked", stage: "connect", authenticated_wss: false, http_status: response.statusCode, exact_blocker: "websocket_upgrade_rejected" }, 2);
    return;
  }
  socket = upgradedSocket;
  stage = "initialize";
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const parsed = parseFrames(buffer);
    buffer = parsed.rest;
    for (const frame of parsed.frames) {
      if (frame.opcode === 0x1) handleMessage(frame.payload.toString("utf8"));
      if (frame.opcode === 0x8) finish({ status: "blocked", stage, authenticated_wss: true, exact_blocker: "remote_closed" }, 2);
    }
  });
  socket.on("error", () => finish({ status: "blocked", stage, authenticated_wss: true, exact_blocker: "socket_error" }, 2));
  if (head?.length) {
    buffer = Buffer.concat([buffer, head]);
    const parsed = parseFrames(buffer);
    buffer = parsed.rest;
    for (const frame of parsed.frames) if (frame.opcode === 0x1) handleMessage(frame.payload.toString("utf8"));
  }
  send({ id: 1, method: "initialize", params: { clientInfo: { name: "automation_os_zeabur_wss_readback", title: "Automation OS Zeabur WSS Readback", version: "0.1.0" }, capabilities: {} } });
});

request.on("error", () => finish({ status: "blocked", stage: "connect", authenticated_wss: false, exact_blocker: "network_error" }, 2));
request.end();
timeout = setTimeout(() => finish({ status: "blocked", stage, authenticated_wss: Boolean(socket), exact_blocker: "readback_timeout" }, 2), timeoutMs);

#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_INPUT_BUNDLE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const TOP_LEVEL_KEYS = new Set([
  "ok", "schema", "queued", "dry_run", "status", "error", "exactBlocker", "exact_blocker",
  "source_trigger", "execution_authority", "provider_neutral", "external_action_executed",
  "company_scope", "next_action", "job", "run", "accepted", "portable", "workflow_id", "worker_protocol"
]);
const JOB_KEYS = new Set([
  "id", "company_id", "run_id", "automation_id", "automation_version_id", "schedule_occurrence_id",
  "kind", "status", "payload_hash", "priority", "max_attempts", "attempt_count", "available_at",
  "concurrency_key", "max_concurrency", "lease_active", "heartbeat_at", "created_at", "updated_at"
]);
const RUN_KEYS = new Set(["id", "status", "company_id", "automation_id", "automation_version_id"]);

const args = process.argv.slice(2);
const valueFor = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] ?? "").trim() : "";
};

function safeFailure(exactBlocker) {
  console.log(JSON.stringify({
    ok: false,
    status: "blocked",
    error: exactBlocker,
    exact_blocker: exactBlocker,
    external_action_executed: false
  }));
  process.exitCode = 2;
}

function normalizedHostname(url) {
  return url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
}

function resolveBaseUrl(rawBaseUrl) {
  let url;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new Error("aos_trigger_base_url_invalid");
  }
  const hostname = normalizedHostname(url);
  if (!hostname || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("aos_trigger_base_url_invalid");
  }
  const loopback = LOOPBACK_HOSTS.has(hostname);
  if (!loopback && url.protocol !== "https:") throw new Error("aos_trigger_remote_tls_required");
  return { url: url.toString().replace(/\/$/u, ""), origin: url.origin, loopback };
}

function resolveTrustedOrigin(rawOrigin) {
  if (!rawOrigin) return "";
  let url;
  try {
    url = new URL(rawOrigin);
  } catch {
    throw new Error("aos_trigger_allowed_origin_invalid");
  }
  if (!url.hostname || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("aos_trigger_allowed_origin_invalid");
  }
  const hostname = normalizedHostname(url);
  if (!LOOPBACK_HOSTS.has(hostname) && url.protocol !== "https:") throw new Error("aos_trigger_allowed_origin_invalid");
  return url.origin;
}

function requestTimeoutMs() {
  const configured = Number(process.env.AOS_TRIGGER_TIMEOUT_MS ?? "");
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(250, Math.floor(configured)));
}

function resolveToken(tokenFile) {
  // Registered automation triggers use a dedicated service identity.  The
  // legacy AOS_TRIGGER_TOKEN name remains a compatibility input for older
  // local wrappers, but an operator/write token is never an implicit fallback.
  const configured = process.env.AOS_TRIGGER_SERVICE_IDENTITY?.trim() || process.env.AOS_TRIGGER_TOKEN?.trim() || "";
  if (configured) return configured;
  if (!tokenFile) return "";
  try {
    return readFileSync(tokenFile, "utf8").trim();
  } catch {
    throw new Error("aos_trigger_token_file_unavailable");
  }
}

function readInputBundle(file) {
  if (!file) return undefined;
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    throw new Error("aos_trigger_input_bundle_file_unavailable");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new Error("aos_trigger_input_bundle_file_untrusted");
  }
  if (stat.size > MAX_INPUT_BUNDLE_BYTES) throw new Error("aos_trigger_input_bundle_too_large");
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("aos_trigger_input_bundle_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("aos_trigger_input_bundle_invalid");
  }
  return value;
}

async function readBoundedResponseText(response) {
  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("aos_trigger_response_too_large");
  }
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("aos_trigger_response_too_large");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function safeString(value, token) {
  const text = String(value);
  return token ? text.split(token).join("[REDACTED]") : text;
}

function projectObject(value, keys, token) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result = {};
  for (const key of keys) {
    if (!(key in value)) continue;
    const item = value[key];
    if (typeof item === "string") result[key] = safeString(item, token);
    else if (typeof item === "number" || typeof item === "boolean" || item === null) result[key] = item;
  }
  return result;
}

function projectTriggerResponse(body, token) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "aos_trigger_response_not_object", external_action_executed: false };
  }
  const result = {};
  for (const key of TOP_LEVEL_KEYS) {
    if (!(key in body)) continue;
    if (key === "job") {
      const job = projectObject(body.job, JOB_KEYS, token);
      if (job) result.job = job;
      continue;
    }
    if (key === "run") {
      const run = projectObject(body.run, RUN_KEYS, token);
      if (run) result.run = run;
      continue;
    }
    if (key === "company_scope") {
      const scope = projectObject(body.company_scope, new Set(["enforced", "company_id"]), token);
      if (scope) result.company_scope = scope;
      continue;
    }
    const value = body[key];
    if (typeof value === "string") result[key] = safeString(value, token);
    else if (typeof value === "number" || typeof value === "boolean" || value === null) result[key] = value;
  }
  result.external_action_executed = false;
  return result;
}

function isValidTriggerSuccess(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  if (body.schema === "aos.automation_trigger.v1") {
    return body.ok === true && body.external_action_executed === false;
  }
  // Portable browser workflows are owned by AOS and intentionally return a
  // distinct schema.  Treat that response as a valid thin-trigger receipt;
  // the Mac Browser Use worker remains the only external Web executor.
  return body.schema === "aos.portable_workflow_trigger.v1"
    && body.ok === true
    && body.accepted === true
    && body.queued === true
    && body.portable === true
    && body.worker_protocol === "mac_worker_polling_required"
    && body.external_action_executed === false;
}

async function main() {
  const companyId = valueFor("--company") || process.env.AOS_TRIGGER_COMPANY_ID?.trim() || "";
  const automationId = valueFor("--automation") || process.env.AOS_TRIGGER_AUTOMATION_ID?.trim() || "";
  const rawBaseUrl = valueFor("--base-url") || process.env.AOS_TRIGGER_BASE_URL?.trim() || "http://127.0.0.1:8787";
  const idempotencyKey = valueFor("--idempotency-key") || `aos-trigger-${randomUUID()}`;
  const tokenFile = valueFor("--token-file") || process.env.AOS_TRIGGER_TOKEN_FILE?.trim() || "";
  const inputBundleFile = valueFor("--input-bundle-file") || process.env.AOS_TRIGGER_INPUT_BUNDLE_FILE?.trim() || "";

  if (!companyId || !automationId) {
    safeFailure("aos_trigger_arguments_missing");
    return;
  }

  let base;
  try {
    base = resolveBaseUrl(rawBaseUrl);
  } catch (error) {
    safeFailure(error instanceof Error ? error.message : "aos_trigger_base_url_invalid");
    return;
  }

  if (!base.loopback) {
    let trustedOrigin;
    try {
      trustedOrigin = resolveTrustedOrigin(process.env.AOS_TRIGGER_ALLOWED_ORIGIN?.trim() || "");
    } catch (error) {
      safeFailure(error instanceof Error ? error.message : "aos_trigger_allowed_origin_invalid");
      return;
    }
    if (!trustedOrigin || trustedOrigin !== base.origin) {
      safeFailure("aos_trigger_remote_origin_not_trusted");
      return;
    }
  }

  let token = "";
  if (!base.loopback) {
    try {
      token = resolveToken(tokenFile);
    } catch (error) {
      safeFailure(error instanceof Error ? error.message : "aos_trigger_token_file_unavailable");
      return;
    }
  }
  if (!base.loopback && !token) {
    safeFailure("aos_trigger_machine_token_required");
    return;
  }

  let inputBundle;
  try {
    inputBundle = readInputBundle(inputBundleFile);
  } catch (error) {
    safeFailure(error instanceof Error ? error.message : "aos_trigger_input_bundle_invalid");
    return;
  }

  const headers = { "content-type": "application/json", "idempotency-key": idempotencyKey };
  if (token) headers.authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs());
  let response;
  try {
    response = await fetch(`${base.url}/api/v1/companies/${encodeURIComponent(companyId)}/automations/${encodeURIComponent(automationId)}/trigger`, {
      method: "POST",
      headers,
      redirect: "manual",
      signal: controller.signal,
      body: JSON.stringify({
        execution_mode: "preflight_no_effect",
        external_action_allowed: false,
        ...(inputBundle ? { input_bundle: inputBundle } : {}),
      })
    });
    if (response.status >= 300 && response.status < 400) {
      safeFailure("aos_trigger_redirect_forbidden");
      return;
    }
    let text;
    text = await readBoundedResponseText(response);
    let body;
    let jsonParsed = true;
    try {
      body = JSON.parse(text);
    } catch {
      jsonParsed = false;
      body = { ok: false, error: "aos_trigger_response_not_json", status: response.status };
    }
    if (response.ok && !jsonParsed) {
      safeFailure("aos_trigger_response_not_json");
      return;
    }
    if (response.ok && !isValidTriggerSuccess(body)) {
      safeFailure("aos_trigger_response_contract_invalid");
      return;
    }
    const projected = projectTriggerResponse(body, token);
    if (body && typeof body === "object" && body.external_action_executed === true) {
      projected.ok = false;
      projected.error = "aos_trigger_external_effect_claim_rejected";
      projected.exact_blocker = "aos_trigger_external_effect_claim_rejected";
    }
    console.log(JSON.stringify(projected));
    if (!response.ok || projected.error === "aos_trigger_external_effect_claim_rejected") process.exitCode = 1;
  } catch (error) {
    const blocker = error instanceof Error && error.name === "AbortError"
      ? "aos_trigger_request_timeout"
      : error instanceof Error && ["aos_trigger_response_too_large"].includes(error.message)
        ? error.message
        : "aos_trigger_request_failed";
    safeFailure(blocker);
  } finally {
    clearTimeout(timeout);
  }
}

await main();

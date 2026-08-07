#!/usr/bin/env node

import { basename, join, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { buildReadbackHeaders, readProductionReadToken } from "./productionReadbackAuth.mjs";

// Production replay never owns a second browser implementation. UI replay is
// admitted only by the canonical Browser Use CLI flow, with a fresh authority,
// profile, port, same-session readback, and cleanup receipt. This script is an
// API/readback harness; it must fail closed until that flow is supplied.
const BROWSER_USE_CLI_HELPER = process.env.AUTOMATION_OS_BROWSER_USE_HELPER
  || "/Users/nichikatanaka/.local/bin/codex-browser-use";
const UI_RUNTIME_BLOCKER = "browser_use_cli_runtime_required";

const baseUrl = (process.env.AUTOMATION_OS_PRODUCTION_URL || process.argv[2] || "https://automation-os.zeabur.app").replace(/\/+$/u, "");
const stamp = new Date().toISOString().replace(/[^0-9A-Za-z]+/gu, "-").replace(/-$/u, "");
const outDir = resolve(process.env.AUTOMATION_OS_REPLAY_QA_OUTPUT_DIR || join("/tmp", `automation-os-production-replay-qa-${stamp}`));
const allowWrite = process.env.AUTOMATION_OS_REPLAY_ALLOW_WRITE === "1";
const writeToken = (process.env.AUTOMATION_OS_WRITE_TOKEN || process.env.AUTOMATION_OS_REPLAY_WRITE_TOKEN || "").trim();
const readToken = readProductionReadToken();
const writeWorkflowAllowlist = new Set((process.env.AUTOMATION_OS_REPLAY_WRITE_WORKFLOWS || "").split(",").map((item) => item.trim()).filter(Boolean));
const writeGuardProbeWorkflowId = "__replay_write_guard_probe_never_registered__";
mkdirSync(outDir, { recursive: true });

// installScopedReadbackRoute is intentionally absent: authenticated UI
// navigation is owned by the canonical Browser Use CLI same-run lifecycle.

const result = {
  ok: false,
  workflow: "automation-os-production-record-replay-qa",
  run_id: `replay_qa_${stamp}`,
  baseUrl,
  artifactRoot: basename(outDir),
  generatedAt: new Date().toISOString(),
  browser_surface: "browser_use_cli",
  browser_use_cli_helper: BROWSER_USE_CLI_HELPER,
  readTokenAvailable: Boolean(readToken),
  allowWrite,
  writeTokenAvailable: Boolean(writeToken),
  writeWorkflowAllowlist: [...writeWorkflowAllowlist],
  stages: [],
  api: {},
  ui: {},
  createReplay: null,
  registeredWorkflowReadback: null,
  failures: [],
  blockers: [],
  recommendations: []
};

await stage("api-readback", async () => {
  result.api.health = await getJson("/api/health");
  result.api.dashboard = await getPreferredApi(["/api/dashboard", "/api/mvp/state"]);
  result.api.registeredWorkflows = await getPreferredApi([
    "/api/registered-workflows",
    "/api/mvp/registered-automations?project_id=project-a"
  ]);
  result.api.browserHealth = await getPreferredApi(["/api/browser/health", "/api/mvp/feedback"], { optional: true });
  const workflows = extractAutomationRows(rawBody(result.api.registeredWorkflows));
  result.registeredWorkflowReadback = {
    count: workflows.length,
    ids: workflows.map((row) => row.id).filter(Boolean),
    statuses: workflows.map((row) => ({ id: row.id, status: row.status, runnerStatus: row.runnerStatus || row.last, boundary: row.boundaryLabel || row.boundary }))
  };
  if (!result.api.health.ok) fail("api_health_unreachable");
  if (!result.api.dashboard.ok && !result.api.registeredWorkflows.ok) fail("api_mvp_compatibility_unreachable");
  if (!result.api.registeredWorkflows.ok || workflows.length === 0) fail("registered_workflows_empty");
});

await stage("create-plan-api-replay", async () => {
  const prompts = {
    capabilityQuestion: ["今の状況としてこのチャットはどんなことまでできる？"],
    correctionQuestion: ["違います。このチャットができることを書き出してください全て"],
    improvementRequest: ["このチャットでできることを増やしたい。UI改善相談です。"],
    readOnlyAutomation: ["毎朝9時に公式サイトの価格を確認して、変化があったらURLを保存する自動化を作りたい。投稿や購入はしない。"],
    incompleteAutomation: ["新しい自動化を作って"],
    dangerousBoundary: ["求人応募を自動化したい。応募ボタンを押す直前で止めて、URLと入力内容を証跡にして。"],
    secretOnly: ["OPENAI_API_KEY=sk-test1234567890abcdef1234567890abcdef 保存だけして。実行しないで。"]
  };
  const cases = {};
  for (const [name, messages] of Object.entries(prompts)) {
    cases[name] = await postJson("/api/create/plan", { messages: messages.map((text) => ({ role: "user", text })) });
  }
  result.createReplay = Object.fromEntries(Object.entries(cases).map(([name, entry]) => {
    const plan = rawBody(entry)?.plan || {};
    return [name, {
      ok: entry.ok,
      status: entry.status,
      intent: plan.intent,
      title: plan.title,
      openQuestionCount: Array.isArray(plan.openQuestions) ? plan.openQuestions.length : null,
      replyHead: typeof plan.reply === "string" ? sanitizeDetail(plan.reply.slice(0, 240)) : ""
    }];
  }));
});

await stage("production-write-guard-readback", async () => {
  const blocked = await postJson(`/api/registered-workflows/${encodeURIComponent(writeGuardProbeWorkflowId)}/start`, {});
  const productionGuardRequired = rawBody(result.api.health)?.productionGuard?.required === true;
  const expectedStatus = productionGuardRequired ? [401, 423] : [401, 423, 404];
  result.api.writeGuardProbe = {
    workflowId: writeGuardProbeWorkflowId,
    ok: expectedStatus.includes(blocked.status),
    status: blocked.status,
    exactBlocker: rawBody(blocked)?.exactBlocker || rawBody(blocked)?.error || blocked.exact_blocker || "",
    bodyArtifact: blocked.bodyArtifact
  };
  if (!expectedStatus.includes(blocked.status)) fail("production_write_guard_did_not_block_without_token");
});

await stage("route-visual-readback", async () => {
  if (!readToken) {
    fail("production_read_token_missing");
    return;
  }
  result.ui.routeVisualReadback = {
    status: "blocked",
    exact_blocker: UI_RUNTIME_BLOCKER,
    browser_surface: "browser_use_cli",
    helper: BROWSER_USE_CLI_HELPER,
    external_effects: "none",
    required_lifecycle: ["fresh authority", "fresh profile/port", "record-start", "same-session state/title/url", "record-finalize", "cleanup receipt"],
    note: "No Playwright, direct Chrome, CDP, or in-app-browser fallback is permitted."
  };
  fail(UI_RUNTIME_BLOCKER);
});

await stage("create-chat-ui-video-replay", async () => {
  if (!readToken) {
    fail("production_read_token_missing");
    return;
  }
  result.ui.createChatVideoReplay = {
    status: "blocked",
    exact_blocker: UI_RUNTIME_BLOCKER,
    browser_surface: "browser_use_cli",
    helper: BROWSER_USE_CLI_HELPER,
    video: null,
    external_effects: "none",
    note: "A video is not produced by a non-canonical browser driver."
  };
  fail(`${UI_RUNTIME_BLOCKER}:create-chat-ui-video-replay`);
});

if (allowWrite) {
  const blocker = !writeToken ? "write_token_missing_for_limited_replay" : writeWorkflowAllowlist.size === 0 ? "write_workflow_allowlist_missing" : "production_write_execution_requires_separate_authorized_run";
  result.blockers.push({ exact_blocker: blocker, detail: "This QA command does not queue external-effect workflows." });
  fail(blocker);
}

result.ok = result.failures.length === 0;
writeFileSync(join(outDir, "replay-summary.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);

async function stage(name, fn) {
  const stageEntry = { name, startedAt: new Date().toISOString(), status: "running" };
  result.stages.push(stageEntry);
  const failureStart = result.failures.length;
  try {
    await fn();
    stageEntry.status = result.failures.length > failureStart ? "blocked" : "ok";
    if (stageEntry.status === "blocked") stageEntry.exact_blocker = result.failures[failureStart];
  } catch (error) {
    stageEntry.status = "blocked";
    stageEntry.exact_blocker = `${name}_failed`;
    stageEntry.error = sanitizeDetail(error instanceof Error ? error.message : String(error));
    fail(stageEntry.exact_blocker);
  } finally {
    stageEntry.finishedAt = new Date().toISOString();
  }
}

async function getPreferredApi(routes, options = {}) {
  let last = null;
  for (const route of routes) {
    last = await getJson(route);
    if (last.ok || last.status !== 404) return last;
  }
  if (options.optional) return last || { ok: false, status: 0, body: null, bodyArtifact: "" };
  return last || { ok: false, status: 0, body: null, bodyArtifact: "" };
}

async function getJson(route) {
  try {
    const headers = route === "/api/health" ? {} : buildReadbackHeaders(readToken);
    const response = await fetch(`${baseUrl}${route}`, Object.keys(headers).length ? { headers } : undefined);
    const text = await response.text();
    const body = parseJson(text);
    const bodyArtifact = writeJsonArtifact(`api-${route.replace(/[^0-9A-Za-z]+/gu, "-") || "root"}.json`, body ?? { raw: text.slice(0, 2000) });
    return { ok: response.ok && Boolean(body), status: response.status, body: summarizeBody(body), bodyArtifact, bodyHead: sanitizeDetail(text.slice(0, 500)), rawBody: body };
  } catch (error) {
    return { ok: false, status: 0, body: null, bodyArtifact: "", exact_blocker: `fetch_failed:${route}`, error: sanitizeDetail(error instanceof Error ? error.message : String(error)), rawBody: null };
  }
}

async function postJson(route, payload) {
  try {
    const response = await fetch(`${baseUrl}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    const text = await response.text();
    const body = parseJson(text);
    const bodyArtifact = writeJsonArtifact(`post-${route.replace(/[^0-9A-Za-z]+/gu, "-")}-${Date.now()}.json`, body ?? { raw: text.slice(0, 2000) });
    return { ok: response.ok && Boolean(body), status: response.status, body: summarizeBody(body), bodyArtifact, bodyHead: sanitizeDetail(text.slice(0, 500)), rawBody: body };
  } catch (error) {
    return { ok: false, status: 0, body: null, bodyArtifact: "", exact_blocker: `fetch_failed:${route}`, error: sanitizeDetail(error instanceof Error ? error.message : String(error)), rawBody: null };
  }
}

function extractAutomationRows(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  for (const key of ["automations", "registeredWorkflows", "workflows", "rows", "items", "data"]) {
    if (Array.isArray(body[key])) return body[key];
  }
  return [];
}

function summarizeBody(body) {
  if (!body || typeof body !== "object") return null;
  return { keys: Object.keys(body).slice(0, 40), status: body.status, error: body.error, exactBlocker: body.exactBlocker };
}

function rawBody(entry) { return entry?.rawBody ?? null; }
function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }
function fail(blocker) { if (!result.failures.includes(blocker)) result.failures.push(blocker); }
function writeJsonArtifact(name, value) {
  const safe = name.replace(/[^0-9A-Za-z._-]+/gu, "-") || "artifact.json";
  writeFileSync(join(outDir, safe), `${JSON.stringify(sanitizeArtifactValue(value), null, 2)}\n`, "utf8");
  return safe;
}
function sanitizeArtifactValue(value, depth = 0) {
  if (depth > 8) return "[truncated-depth]";
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeArtifactValue(item, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeArtifactValue(item, depth + 1)]));
  return typeof value === "string" ? sanitizeDetail(value) : value;
}
function sanitizeDetail(value) {
  return String(value).replace(/(?:\/Users\/|\/private)?\/tmp\/[^\n\r"'<> ]+/gu, "[redacted-path]").replace(/https?:\/\/[^\s"'<>]+/gu, "[redacted-url]");
}

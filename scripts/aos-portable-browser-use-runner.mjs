#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { validateWebOperationIntent } from "./portable-business-action-plan.mjs";
import { runAdaptiveWebOperationEffect } from "./web-operation-effect-executor.mjs";

const IDENTIFIER = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,179}$/u;
const CANONICAL_STAGE_ADAPTER = "/Users/nichikatanaka/.codex/skills/automation-kernel-run/scripts/browser-use-cli-stage-adapter.mjs";
const JOB_CANDIDATE_SUPPLY_STEP = "job_candidate_supply";
const JOB_CANDIDATE_SUPPLY_STAGE = "candidate_supply";
const REFERENCE_READBACK_STAGE = "reference_readback";
const JOB_CANDIDATE_SUPPLY_ADAPTER = "/Users/nichikatanaka/Documents/New project/scripts/browser_use/job_manager_browser_use_cli_candidate_supply_adapter.mjs";
const JOB_CANDIDATE_SUPPLY_PACKAGE_HELPER = "/Users/nichikatanaka/Documents/New project/browser-use-cli/bin/codex-browser-use";
const PORTABLE_INPUT_BUNDLE_SCHEMA = "automation_os_portable_workflow_input_bundle.v1";
const WEB_OPERATION_INTENT_SCHEMA = "automation_os_web_operation_intent.v1";
const ADAPTIVE_WEB_READBACK_STAGE = "adaptive_web_readback";
const ADAPTIVE_PUBLIC_WEB_AUTOMATION = "aos-adaptive-public-web";
const ADAPTIVE_PUBLIC_PORT_START = 19981;
const ADAPTIVE_PUBLIC_PORT_END = 19999;
const WEB_OPERATION_ROUTE_REGISTRY_SCHEMA = "automation_os_web_operation_route_registry.v1";
const WEB_OPERATION_ROUTE_REGISTRY_ID = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,127}$/u;

// These are read-only provider adapters.  They deliberately do not accept a
// business action, candidate id, or arbitrary URL from the child process.
// The browser surface is selected by AOS and the provider-specific code is
// only responsible for the already approved readback contract.
const READ_ONLY_ROUTES = Object.freeze({
  "job-application-manager": Object.freeze({
    automation_id: "automation-3",
    stage_id: "aos_job_read_only_preflight",
    target_url: "https://www.linkedin.com/jobs/",
    allowed_origins: ["https://www.linkedin.com"],
    port: 19881,
    account_identity: "linkedin_authenticated_job_manager",
    data_exposure: "authenticated_linkedin_candidate_read",
  }),
  "daily-ai-research-publish-run": Object.freeze({
    automation_id: "daily-ai",
    stage_id: "aos_daily_ai_read_only_preflight",
    target_url: "https://x.com/home",
    allowed_origins: ["https://x.com"],
    port: 19882,
    account_identity: "daily_ai_social_readback",
    data_exposure: "authenticated_social_readback",
  }),
  "nisenprints-daily-product-canva-printify-etsy-pinterest": Object.freeze({
    automation_id: "nisenprints",
    stage_id: "aos_nisenprints_read_only_preflight",
    // Keep the canary bound to the same canonical root used by the login
    // handoff. Canva may choose the locale/dashboard path after auth; the
    // helper owns same-origin navigation reconciliation.
    target_url: "https://www.canva.com/",
    allowed_origins: ["https://www.canva.com"],
    port: 19884,
    account_identity: "nisenprints_authenticated_workflow",
    data_exposure: "authenticated_canva_readback",
  }),
});

export const PORTABLE_EXTERNAL_ACTION_PLAN_REQUIRED = "portable_external_action_plan_required";
export const PORTABLE_EXTERNAL_ADMISSION_INVALID = "portable_external_admission_invalid";
export const PORTABLE_EXTERNAL_ADMISSION_EXPIRED = "portable_external_admission_expired";
export const PORTABLE_EXTERNAL_READ_ONLY_ROUTE_NOT_CONFIGURED = "portable_external_read_only_route_not_configured";
export const PORTABLE_EXTERNAL_READ_ONLY_BUSINESS_PROOF_PENDING = "portable_external_read_only_business_completion_proof_pending";
export const PORTABLE_EXTERNAL_AUTHORIZED_BUSINESS_RUNNER = "scripts/aos-portable-business-runner.mjs";

export function routeForWorkflow(workflowId) {
  return READ_ONLY_ROUTES[String(workflowId || "")] || null;
}

export function parsePortableRunnerArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || "");
    if (!token.startsWith("--")) throw new Error("portable_external_runner_argument_invalid");
    const key = token.slice(2).replaceAll("-", "_");
    const value = argv[index + 1];
    if (!value || String(value).startsWith("--")) throw new Error(`portable_external_${key}_missing`);
    values[key] = String(value);
    index += 1;
  }
  for (const key of ["workflow_id", "run_id", "step_id", "source_trigger", "idempotency_key"]) {
    if (!IDENTIFIER.test(String(values[key] || ""))) throw new Error(`portable_external_${key}_invalid`);
  }
  return values;
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeRunRoot(runId, environment = process.env) {
  const artifactRoot = path.resolve(String(environment.AUTOMATION_OS_ARTIFACT_ROOT || path.join(process.cwd(), "data", "artifacts")));
  if (!IDENTIFIER.test(runId)) throw new Error("portable_external_run_id_invalid");
  const runRoot = path.resolve(artifactRoot, runId);
  const relative = path.relative(artifactRoot, runRoot);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("portable_external_run_root_invalid");
  fs.mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(runRoot, 0o700);
  return { artifactRoot, runRoot };
}

function readAdaptiveWebOperationIntent(input, environment = process.env) {
  const configuredPath = String(environment.AUTOMATION_OS_PORTABLE_WEB_OPERATION_INTENT_PATH || "").trim();
  if (!configuredPath) return null;
  const { runRoot } = safeRunRoot(input.run_id, environment);
  const expectedPath = path.resolve(runRoot, "web-operation-intent.v1.json");
  const resolvedPath = path.resolve(configuredPath);
  const expectedSha256 = String(environment.AUTOMATION_OS_PORTABLE_WEB_OPERATION_INTENT_SHA256 || "").trim();
  if (resolvedPath !== expectedPath || !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    throw new Error("portable_external_web_operation_intent_invalid");
  }
  let stat;
  let bytes;
  try {
    stat = fs.lstatSync(resolvedPath);
    bytes = fs.readFileSync(resolvedPath);
  } catch {
    throw new Error("portable_external_web_operation_intent_missing");
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.uid !== currentUid || (stat.mode & 0o777) !== 0o600) {
    throw new Error("portable_external_web_operation_intent_permissions_invalid");
  }
  if (sha256Bytes(bytes) !== expectedSha256) throw new Error("portable_external_web_operation_intent_digest_invalid");
  let raw;
  try { raw = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("portable_external_web_operation_intent_json_invalid"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schema !== WEB_OPERATION_INTENT_SCHEMA
    || raw.workflow_id !== input.workflow_id || raw.run_id !== input.run_id || raw.step_id !== input.step_id
    || raw.source_trigger !== input.source_trigger || raw.idempotency_key !== input.idempotency_key
    || raw.browser_surface !== "browser_use_cli" || !raw.entry_url) {
    throw new Error("portable_external_web_operation_intent_binding_invalid");
  }
  const intent = validateWebOperationIntent(raw);
  if (!intent.entry_url) throw new Error("portable_external_web_operation_intent_entry_url_required");
  return { path: resolvedPath, sha256: expectedSha256, intent };
}

function readAdmission(input, environment = process.env) {
  const admissionPath = String(environment.AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_PATH || "").trim();
  const expectedSha256 = String(environment.AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_SHA256 || "").trim();
  if (!path.isAbsolute(admissionPath) || !/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new Error(PORTABLE_EXTERNAL_ADMISSION_INVALID);
  let stat;
  let bytes;
  try {
    stat = fs.lstatSync(admissionPath);
    bytes = fs.readFileSync(admissionPath);
  } catch {
    throw new Error(PORTABLE_EXTERNAL_ADMISSION_INVALID);
  }
  if (!stat.isFile() || stat.nlink !== 1 || sha256Bytes(bytes) !== expectedSha256) throw new Error(PORTABLE_EXTERNAL_ADMISSION_INVALID);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(PORTABLE_EXTERNAL_ADMISSION_INVALID); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(PORTABLE_EXTERNAL_ADMISSION_INVALID);
  if (value.workflow_id !== input.workflow_id || value.run_id !== input.run_id || value.step_id !== input.step_id
    || value.source_trigger !== input.source_trigger || value.idempotency_key !== input.idempotency_key
    || value.approval_status !== "approved" || value.effect_class !== "external_non_idempotent"
    || value.browser_surface !== "browser_use_cli") throw new Error(PORTABLE_EXTERNAL_ADMISSION_INVALID);
  if (Date.parse(String(value.expires_at || "")) <= Date.now()) throw new Error(PORTABLE_EXTERNAL_ADMISSION_EXPIRED);
  return Object.freeze({ path: admissionPath, sha256: expectedSha256, value });
}

function writePrivateImmutableJson(filePath, value) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(resolved), 0o700);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.nlink !== 1 || fs.readFileSync(resolved, "utf8") !== bytes) throw new Error("portable_external_authority_immutable_collision");
    fs.chmodSync(resolved, 0o600);
    return { path: resolved, sha256: sha256Bytes(bytes) };
  }
  const fd = fs.openSync(resolved, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes, "utf8"); } finally { fs.closeSync(fd); }
  fs.chmodSync(resolved, 0o600);
  return { path: resolved, sha256: sha256Bytes(bytes) };
}

function issueReadOnlyAuthority({ route, input, runRoot }) {
  const now = Date.now();
  const authority = {
    schema: "authority.v1",
    version: "1",
    automation_id: route.automation_id,
    stage_id: route.stage_id,
    mode: "authorized",
    browser_surface: "browser_use_cli",
    run_id: input.run_id,
    session: `aos-${sha256Bytes(`${input.run_id}:${route.stage_id}`).slice(0, 20)}-preflight`,
    not_before: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 20 * 60 * 1000).toISOString(),
    allowed_origins: [...route.allowed_origins],
    account_identity: route.account_identity,
    data_exposure: route.data_exposure,
    side_effect_scope: "read_only_preflight",
    // Browser Use CLI accepts the same approval token for read-only and
    // authorized flows; the effect boundary is carried by side_effect_scope.
    approval: "approved",
    readback_required: true,
    source_admission_sha256: input.admission.sha256,
  };
  return writePrivateImmutableJson(
    path.join(runRoot, "browser-use-cli-authority", `${route.stage_id}.v1.json`),
    authority,
  );
}

function capturedValue(result) {
  let value = result?.captured_readback;
  for (let index = 0; index < 5; index += 1) {
    if (typeof value !== "string") break;
    try { value = JSON.parse(value); } catch { break; }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (value["0"] !== undefined) return value["0"];
    if (value.result !== undefined) return value.result;
  }
  return value ?? "";
}

function textLength(value) {
  if (typeof value === "string") return value.length;
  if (value && typeof value === "object") return JSON.stringify(value).length;
  return String(value ?? "").length;
}

function firstUrl(value) {
  if (typeof value === "string") {
    const match = value.match(/https?:\/\/[^\s"'\\]+/iu);
    return match ? match[0].replace(/[),.;]+$/u, "") : "";
  }
  if (!value || typeof value !== "object") return "";
  for (const key of ["url", "href", "result", "data"]) {
    const found = firstUrl(value[key]);
    if (found) return found;
  }
  return "";
}

function exactOrigin(url) {
  try { return new URL(url).origin; } catch { return ""; }
}

function unsafeWebHostname(value) {
  const hostname = String(value).replace(/^\[|\]$/gu, "").toLocaleLowerCase().replace(/\.$/u, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")
    || hostname === "metadata.google.internal" || hostname === "metadata" || hostname === "instance-data") return true;
  const octets = hostname.split(".").map((part) => Number(part));
  if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) || (a === 198 && b >= 18 && b <= 19)
      || a >= 224;
  }
  if (hostname.includes(":")) {
    if (hostname === "::" || hostname === "::1" || /^f[cd]/u.test(hostname) || /^fe[89ab]/u.test(hostname)) return true;
    const mapped = hostname.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u)?.[1];
    return mapped ? unsafeWebHostname(mapped) : false;
  }
  return false;
}

function routeRegistryOrigin(value) {
  let parsed;
  try { parsed = new URL(String(value)); } catch { throw new Error("portable_external_web_operation_route_registry_origin_invalid"); }
  if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || unsafeWebHostname(parsed.hostname)) {
    throw new Error("portable_external_web_operation_route_registry_origin_invalid");
  }
  return parsed.origin;
}

function normalizedBlocker(error) {
  return String(error?.exact_blocker || error?.message || error || "portable_external_read_only_probe_failed").slice(0, 240);
}

function readCandidateSupplyInput(input, runRoot, environment = process.env) {
  const requestedPath = path.resolve(String(environment.AUTOMATION_OS_PORTABLE_EXTERNAL_INPUT_BUNDLE_PATH || ""));
  const expectedPath = path.resolve(runRoot, "portable-input-bundle.v1.json");
  if (!requestedPath || requestedPath !== expectedPath || !fs.existsSync(requestedPath)) {
    throw new Error("portable_external_candidate_supply_input_bundle_missing");
  }
  const stat = fs.lstatSync(requestedPath);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.uid !== currentUid || (stat.mode & 0o777) !== 0o600) {
    throw new Error("portable_external_candidate_supply_input_bundle_invalid");
  }
  const bytes = fs.readFileSync(requestedPath);
  let document;
  try { document = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("portable_external_candidate_supply_input_bundle_json_invalid"); }
  const bundle = document?.input;
  if (document?.schema !== PORTABLE_INPUT_BUNDLE_SCHEMA || document?.workflow_id !== input.workflow_id || document?.run_id !== input.run_id
    || !bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("portable_external_candidate_supply_input_bundle_binding_invalid");
  }
  const stringFields = ["source_snapshot_id", "supply_run_id", "bucket"];
  if (stringFields.some((key) => !IDENTIFIER.test(String(bundle[key] || "")))) {
    throw new Error("portable_external_candidate_supply_input_bundle_fields_missing");
  }
  if (!["japan_targeted", "overseas_global"].includes(String(bundle.bucket))) {
    throw new Error("portable_external_candidate_supply_input_bundle_bucket_invalid");
  }
  for (const key of ["remaining", "margin"]) {
    const value = Number(bundle[key]);
    if (!Number.isSafeInteger(value) || value < 0 || value > 20) {
      throw new Error("portable_external_candidate_supply_input_bundle_count_invalid");
    }
  }
  if (Number(bundle.remaining) + Number(bundle.margin) < 1) {
    throw new Error("portable_external_candidate_supply_input_bundle_empty_request");
  }
  return {
    path: requestedPath,
    sha256: sha256Bytes(bytes),
    input: {
      sourceSnapshotId: String(bundle.source_snapshot_id),
      supplyRunId: String(bundle.supply_run_id),
      bucket: String(bundle.bucket),
      remaining: Number(bundle.remaining),
      margin: Number(bundle.margin),
    },
  };
}

async function runJobCandidateSupply(input, environment = process.env) {
  const { runRoot } = safeRunRoot(input.run_id, environment);
  const bundle = readCandidateSupplyInput(input, runRoot, environment);
  if (!fs.existsSync(JOB_CANDIDATE_SUPPLY_ADAPTER)) {
    throw new Error("portable_external_candidate_supply_adapter_missing");
  }
  // The New project adapter deliberately enforces helper/source parity. Keep
  // this child on its own packaged helper so that its source boundary and
  // executable cannot silently drift from one another. This is scoped to the
  // candidate-supply child; the canonical AOS preflight lane keeps using the
  // installed helper and its own lifecycle/readback contract.
  if (!environment.BROWSER_USE_CLI_HELPER && fs.existsSync(JOB_CANDIDATE_SUPPLY_PACKAGE_HELPER)) {
    process.env.BROWSER_USE_CLI_HELPER = JOB_CANDIDATE_SUPPLY_PACKAGE_HELPER;
  }
  const candidateSupplyModule = await import(pathToFileURL(JOB_CANDIDATE_SUPPLY_ADAPTER).href);
  if (typeof candidateSupplyModule.runJobManagerBrowserUseCliCandidateSupply !== "function") {
    throw new Error("portable_external_candidate_supply_adapter_invalid");
  }
  const artifactDir = path.join(runRoot, "candidate-supply");
  const result = await candidateSupplyModule.runJobManagerBrowserUseCliCandidateSupply({
    payload: {
      runId: input.run_id,
      sourceSnapshotId: bundle.input.sourceSnapshotId,
      supplyRunId: bundle.input.supplyRunId,
      bucket: bundle.input.bucket,
      remaining: bundle.input.remaining,
      margin: bundle.input.margin,
      automationId: "automation-3",
      runDir: runRoot,
      schedulerRunDir: runRoot,
      artifactDir,
      browserFlowFinalize: true,
      bridgeInstanceId: input.idempotency_key,
    },
    runDir: runRoot,
    runId: `${input.run_id}:candidate-supply-bridge`,
    receiptPath: path.join(runRoot, "candidate-supply-bridge-receipt.v1.json"),
  });
  const cleanupVerified = result?.cleanup_verified === true;
  const candidateCount = Number(result?.candidate_count || 0);
  const requestedCount = Number(result?.requested_count || bundle.input.remaining + bundle.input.margin);
  const ready = result?.status === "ready" && cleanupVerified && candidateCount >= requestedCount;
  const exactBlocker = result?.exact_blocker
    ? String(result.exact_blocker)
    : ready
      ? null
      : PORTABLE_EXTERNAL_READ_ONLY_BUSINESS_PROOF_PENDING;
  return {
    status: ready
      ? "complete"
      : result?.exact_blocker && !String(result.exact_blocker).startsWith("candidate_supply_buffer_short:") ? "blocked" : "partial",
    exact_blocker: exactBlocker,
    external_action_executed: false,
    browser_surface: "browser_use_cli",
    workflow_id: input.workflow_id,
    run_id: input.run_id,
    step_id: input.step_id,
    input_bundle_sha256: bundle.sha256,
    readback_verified: candidateCount > 0 || result?.status === "ready",
    cleanup_verified: cleanupVerified,
    effects_mode: "read_only",
    read_only_stage_bound: true,
    same_run_receipt: ready,
    external_executor_status: "candidate_supply_read_only_completed",
    business_runner_entrypoint: "job_manager_browser_use_cli_candidate_supply_adapter.mjs",
    adapter_result: {
      stage: JOB_CANDIDATE_SUPPLY_STEP,
      status: String(result?.status || "blocked"),
      ready,
      read_only: result?.read_only === true,
      candidate_count: candidateCount,
      requested_count: requestedCount,
      artifact_uri: String(result?.artifact_uri || ""),
      browser_authority_path: String(result?.browser_authority_path || ""),
      browser_flow_receipt_path: String(result?.browser_flow_receipt_path || ""),
      browser_flow_manifest_path: String(result?.browser_flow_manifest_path || ""),
      cleanup_verified: cleanupVerified,
      browser_flow_status: String(result?.browser_flow_status || ""),
      browser_runtime_readback: result?.browser_runtime_readback && typeof result.browser_runtime_readback === "object"
        ? {
          requested_session: String(result.browser_runtime_readback.requested_session || ""),
          effective_session: String(result.browser_runtime_readback.effective_session || ""),
          profile_root: String(result.browser_runtime_readback.profile_root || ""),
          reserved_port: Number(result.browser_runtime_readback.reserved_port || 0),
          flow_status: String(result.browser_runtime_readback.flow_status || ""),
          cleanup_verified: result.browser_runtime_readback.cleanup_verified === true,
        }
        : null,
    },
  };
}

function loopbackPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const finish = (available) => {
      server.removeAllListeners();
      try { server.close(); } catch (_) { /* no listener was established */ }
      resolve(available);
    };
    server.once("error", () => finish(false));
    server.listen({ host: "127.0.0.1", port }, () => finish(true));
  });
}

async function adaptivePublicPort(input) {
  const span = ADAPTIVE_PUBLIC_PORT_END - ADAPTIVE_PUBLIC_PORT_START + 1;
  const seed = Number.parseInt(sha256Bytes(`${input.run_id}:${input.step_id}`).slice(0, 8), 16) % span;
  for (let offset = 0; offset < span; offset += 1) {
    const port = ADAPTIVE_PUBLIC_PORT_START + ((seed + offset) % span);
    if (await loopbackPortAvailable(port)) return port;
  }
  throw new Error("portable_external_adaptive_public_port_exhausted");
}

function readWebOperationRouteRegistry(environment = process.env) {
  const configured = String(environment.AUTOMATION_OS_WEB_OPERATION_ROUTES_PATH || "").trim();
  if (!configured) return [];
  const resolved = path.resolve(configured);
  let stat;
  let raw;
  try {
    stat = fs.lstatSync(resolved);
    raw = fs.readFileSync(resolved, "utf8");
  } catch {
    throw new Error("portable_external_web_operation_route_registry_missing");
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.uid !== currentUid || (stat.mode & 0o777) !== 0o600) {
    throw new Error("portable_external_web_operation_route_registry_permissions_invalid");
  }
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("portable_external_web_operation_route_registry_json_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== WEB_OPERATION_ROUTE_REGISTRY_SCHEMA || !Array.isArray(value.routes) || value.routes.length > 32) {
    throw new Error("portable_external_web_operation_route_registry_invalid");
  }
  const routes = value.routes.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || !WEB_OPERATION_ROUTE_REGISTRY_ID.test(String(entry.account_ref || ""))
      || !WEB_OPERATION_ROUTE_REGISTRY_ID.test(String(entry.automation_id || ""))
      || !WEB_OPERATION_ROUTE_REGISTRY_ID.test(String(entry.stage_id || ""))
      || !Array.isArray(entry.allowed_origins) || entry.allowed_origins.length < 1 || entry.allowed_origins.length > 16) {
      throw new Error("portable_external_web_operation_route_registry_entry_invalid");
    }
    const origins = [...new Set(entry.allowed_origins.map((origin) => routeRegistryOrigin(origin)))].filter(Boolean).sort();
    if (origins.length !== entry.allowed_origins.length) throw new Error("portable_external_web_operation_route_registry_origin_invalid");
    const port = Number(entry.port);
    if (!Number.isSafeInteger(port) || port < 19880 || port > 19899) throw new Error("portable_external_web_operation_route_registry_port_invalid");
    return Object.freeze({
      automation_id: String(entry.automation_id),
      stage_id: String(entry.stage_id),
      target_url: "",
      allowed_origins: origins,
      port,
      account_identity: String(entry.account_identity || entry.account_ref),
      data_exposure: "authorized_semantic_web_operation",
      account_ref: String(entry.account_ref),
      public_lane: false,
      mode: "authorized",
      lifecycle: "scheduled",
    });
  });
  const bindings = new Set();
  for (const route of routes) {
    for (const origin of route.allowed_origins) {
      const binding = `${route.account_ref}\u001f${origin}`;
      if (bindings.has(binding)) throw new Error("portable_external_web_operation_route_registry_duplicate");
      bindings.add(binding);
    }
  }
  return routes;
}

function adaptiveRouteForIntent(baseRoute, intent, input, environment = process.env) {
  const sameRegisteredAccount = Boolean(baseRoute)
    && intent.account_ref === baseRoute.account_identity
    && intent.allowed_origins.every((origin) => baseRoute.allowed_origins.includes(origin));
  if (sameRegisteredAccount) {
    const stageId = `${baseRoute.stage_id}-${ADAPTIVE_WEB_READBACK_STAGE}`;
    return {
      ...baseRoute,
      mode: "authorized",
      lifecycle: "scheduled",
      stage_id: stageId,
      target_url: intent.entry_url,
      allowed_origins: [...intent.allowed_origins],
      data_exposure: "bounded_semantic_target_readback",
      public_lane: false,
    };
  }
  const registeredRoute = readWebOperationRouteRegistry(environment).find((candidate) => candidate.account_ref === intent.account_ref
    && intent.allowed_origins.every((origin) => candidate.allowed_origins.includes(origin)));
  if (registeredRoute) {
    return {
      ...registeredRoute,
      target_url: intent.entry_url,
      allowed_origins: [...intent.allowed_origins],
      stage_id: `${registeredRoute.stage_id}-${ADAPTIVE_WEB_READBACK_STAGE}`,
      workflow_id: input.workflow_id,
    };
  }
  if (intent.account_ref !== "public") {
    throw new Error("portable_external_web_operation_authority_missing_for_unregistered_origin");
  }
  if (intent.allowed_origins.length !== 1) {
    throw new Error("portable_external_web_operation_public_origin_scope_invalid");
  }
  return {
    automation_id: ADAPTIVE_PUBLIC_WEB_AUTOMATION,
    stage_id: `aos-${ADAPTIVE_PUBLIC_WEB_AUTOMATION}-${ADAPTIVE_WEB_READBACK_STAGE}`,
    mode: "public",
    lifecycle: "single-use",
    target_url: intent.entry_url,
    allowed_origins: [...intent.allowed_origins],
    account_identity: "public",
    data_exposure: "bounded_public_semantic_target_readback",
    port: null,
    public_lane: true,
    workflow_id: input.workflow_id,
  };
}

async function runAdaptiveWebOperationReadback(input, baseRoute, intent, environment = process.env) {
  const route = adaptiveRouteForIntent(baseRoute, intent, input, environment);
  if (route.public_lane) route.port = await adaptivePublicPort(input);
  const { runRoot } = safeRunRoot(input.run_id, environment);
  const authority = route.public_lane ? null : issueReadOnlyAuthority({ route, input, runRoot });
  let adaptiveScreenshotPath = "";
  let flow = null;
  let adapter = null;
  let primaryError = null;
  let finalized = null;
  let observedUrl = "";
  let title = "";
  let state = "";
  let readbackVerified = false;
  let targetReadbackVerified = false;
  let targetCandidate = null;
  let targetSourceStateDigest = "";

  try {
    if (!fs.existsSync(CANONICAL_STAGE_ADAPTER)) throw new Error("portable_external_browser_use_cli_stage_adapter_missing");
    adapter = await import(pathToFileURL(CANONICAL_STAGE_ADAPTER).href);
    const session = `aos-${sha256Bytes(`${input.run_id}:${route.stage_id}`).slice(0, 20)}-adaptive`;
    const contractToken = sha256Bytes(`${input.run_id}:${input.step_id}:${route.stage_id}`).slice(0, 24);
    flow = await adapter.startBrowserUseCliFlow({
      automationId: route.automation_id,
      runId: input.run_id,
      stageId: route.stage_id,
      session,
      mode: route.mode,
      lifecycle: route.lifecycle,
      authorityPath: authority?.path || "",
      allowedOrigins: route.allowed_origins,
      port: route.port,
      contract: {
        workflowId: input.workflow_id,
        workflowVersion: "1",
        attemptId: `aos-${contractToken}-attempt-1`,
        flowId: `aos-${contractToken}-flow`,
        leaseId: `aos-${contractToken}-lease`,
        ...(authority ? { authoritySha256: authority.sha256 } : {}),
        notBefore: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
      },
    });
    adaptiveScreenshotPath = path.join(flow.recording_dir, "aos-adaptive-readback.png");
    const baseSequence = Number(flow.contract?.action_sequence || 0);
    const readbackBatch = await adapter.runBrowserUseCliFlowReadOnlyBatch({
      flow,
      authorityPath: authority?.path || "",
      commands: [
        ["open", route.target_url],
        ["wait", "1"],
        ["get", "url"],
        ["get", "title"],
        ["state"],
        ["screenshot", adaptiveScreenshotPath],
      ],
      actionSequence: baseSequence,
      actionNonces: Array.from({ length: 6 }, (_, index) => `${input.run_id}-adaptive-${index + 1}-${randomUUID()}`),
      captureReadback: true,
    });
    flow = readbackBatch;
    const batchCaptured = readbackBatch.captured_readback || {};
    const batchValue = (index) => capturedValue({ captured_readback: batchCaptured[String(index)] });
    observedUrl = firstUrl(batchValue(2));
    title = batchValue(3);
    state = batchValue(4);
    readbackVerified = exactOrigin(observedUrl) === exactOrigin(route.target_url) && textLength(state) > 0 && textLength(title) > 0;
    const targetResult = await adapter.runBrowserUseCliFlowTargetInspect({
      flow,
      authorityPath: authority?.path || "",
      targetText: intent.target.semantic_query,
      actionSequence: Number(flow.contract?.action_sequence || 0) + 1,
      actionNonce: `${input.run_id}-adaptive-target-${randomUUID()}`,
    });
    flow = targetResult;
    targetReadbackVerified = targetResult.command_completed === true;
    const safeTargetResult = targetResult.target_result && typeof targetResult.target_result === "object"
      ? targetResult.target_result
      : {};
    targetCandidate = safeTargetResult.candidate && typeof safeTargetResult.candidate === "object"
      ? safeTargetResult.candidate
      : null;
    targetSourceStateDigest = safeTargetResult.before_state && typeof safeTargetResult.before_state === "object"
      ? String(safeTargetResult.before_state.state_sha256 || "")
      : "";
  } catch (error) {
    primaryError = error;
  }

  if (flow && adapter) {
    try {
      finalized = await adapter.finalizeBrowserUseCliFlow({ flow, authorityPath: authority?.path || "" });
    } catch (error) {
      if (!primaryError) primaryError = error;
    }
  }
  const cleanupVerified = finalized?.finalized === true;
  const loginRequired = /\b(sign in|log in|checkpoint|verify)\b|ログイン|サインイン|本人確認/iu.test(`${observedUrl} ${JSON.stringify(state)}`);
  const exactBlocker = loginRequired
    ? `auth_blocked:${input.workflow_id}_login_required`
    : primaryError
      ? normalizedBlocker(primaryError)
      : !readbackVerified
        ? "portable_external_browser_use_cli_readback_invalid"
        : !targetReadbackVerified
          ? "portable_external_web_operation_target_readback_invalid"
          : !cleanupVerified
            ? "portable_external_browser_use_cli_cleanup_unverified"
            : null;
  return {
    status: exactBlocker === null ? "complete" : "blocked",
    exact_blocker: exactBlocker,
    external_action_executed: false,
    browser_surface: "browser_use_cli",
    workflow_id: input.workflow_id,
    run_id: input.run_id,
    step_id: input.step_id,
    operation: "read",
    generic_web_operation: true,
    intent_sha256: String(environment.AUTOMATION_OS_PORTABLE_WEB_OPERATION_INTENT_SHA256 || ""),
    authority_path: authority?.path || "",
    authority_sha256: authority?.sha256 || "",
    requested_origin: exactOrigin(route.target_url),
    observed_origin: exactOrigin(observedUrl),
    state_length: textLength(state),
    title_length: textLength(title),
    screenshot_path: fs.existsSync(adaptiveScreenshotPath) ? adaptiveScreenshotPath : "",
    receipt_path: String(finalized?.receipt_path || ""),
    manifest_path: String(finalized?.manifest_path || ""),
    cleanup_verified: cleanupVerified,
    readback_verified: readbackVerified,
    semantic_target_readback_verified: targetReadbackVerified,
    semantic_target_sha256: sha256Bytes(intent.target.semantic_query),
    semantic_target_candidate_present: Boolean(targetCandidate),
    semantic_target_candidate_digest: targetCandidate && typeof targetCandidate.match_text_sha256 === "string"
      ? targetCandidate.match_text_sha256
      : "",
    semantic_target_source_state_digest: targetSourceStateDigest,
    effects_mode: "read_only",
    read_only_stage_bound: true,
    external_executor_status: "adaptive_semantic_readback_completed",
    adapter_result: {
      browser_runtime_readback: {
        requested_session: String(flow?.contract?.requested_session || flow?.session || ""),
        effective_session: String(flow?.contract?.effective_session || flow?.session || ""),
        profile_root: String(flow?.profile || ""),
        reserved_port: Number(flow?.port || route.port || 0),
        flow_status: cleanupVerified ? "finalized" : "blocked",
        cleanup_verified: cleanupVerified,
      },
      target_readback: {
        verified: targetReadbackVerified,
        candidate_present: Boolean(targetCandidate),
        candidate_digest: targetCandidate && typeof targetCandidate.match_text_sha256 === "string" ? targetCandidate.match_text_sha256 : "",
        source_state_digest: targetSourceStateDigest,
      },
    },
  };
}

export async function runReadOnlyWorkflow(input, environment = process.env) {
  const adaptiveIntent = readAdaptiveWebOperationIntent(input, environment);
  const route = routeForWorkflow(input.workflow_id);
  if (adaptiveIntent) return runAdaptiveWebOperationReadback(input, route, adaptiveIntent.intent, environment);
  if (!route) {
    return {
      status: "blocked",
      exact_blocker: `${PORTABLE_EXTERNAL_READ_ONLY_ROUTE_NOT_CONFIGURED}:${input.workflow_id}`,
      external_action_executed: false,
      browser_surface: "browser_use_cli",
    };
  }
  if (input.workflow_id === "job-application-manager"
    && (input.step_id === JOB_CANDIDATE_SUPPLY_STEP
      || environment.AUTOMATION_OS_PORTABLE_EXTERNAL_READ_ONLY_STAGE === JOB_CANDIDATE_SUPPLY_STAGE)) {
    return runJobCandidateSupply(input, environment);
  }
  const { runRoot } = safeRunRoot(input.run_id, environment);
  const authority = issueReadOnlyAuthority({ route, input, runRoot });
  let screenshotPath = "";
  let flow = null;
  let adapter;
  try {
    if (!fs.existsSync(CANONICAL_STAGE_ADAPTER)) throw new Error("portable_external_browser_use_cli_stage_adapter_missing");
    adapter = await import(pathToFileURL(CANONICAL_STAGE_ADAPTER).href);
    const session = `aos-${sha256Bytes(`${input.run_id}:${route.stage_id}`).slice(0, 20)}-preflight`;
    const contractToken = sha256Bytes(`${input.run_id}:${input.step_id}:${route.stage_id}`).slice(0, 24);
    flow = await adapter.startBrowserUseCliFlow({
      automationId: route.automation_id,
      runId: input.run_id,
      stageId: route.stage_id,
      session,
      mode: "authorized",
      lifecycle: "scheduled",
      authorityPath: authority.path,
      allowedOrigins: route.allowed_origins,
      port: route.port,
      contract: {
        workflowId: input.workflow_id,
        workflowVersion: "1",
        attemptId: `aos-${contractToken}-attempt-1`,
        flowId: `aos-${contractToken}-flow`,
        leaseId: `aos-${contractToken}-lease`,
        authoritySha256: authority.sha256,
        notBefore: new Date(Date.now() - 1000).toISOString(),
        expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
      },
    });
    screenshotPath = path.join(flow.recording_dir, "aos-readback.png");
    let actionSequence = 0;
    const batch = async (commands, captureReadback = true) => {
      const baseSequence = Math.max(actionSequence, Number(flow?.contract?.action_sequence || 0));
      const actionNonces = commands.map((_, index) => `${input.run_id}-${baseSequence + index + 1}-${randomUUID()}`);
      const result = await adapter.runBrowserUseCliFlowReadOnlyBatch({
        flow,
        authorityPath: authority.path,
        commands,
        actionSequence: baseSequence,
        actionNonces,
        captureReadback,
      });
      flow = result;
      actionSequence = Number(result.contract?.action_sequence || baseSequence + commands.length);
      return result;
    };
    // Opening a provider root may legitimately land on a same-origin
    // authenticated route (for example Canva's locale/login landing). Let
    // the canonical helper perform its bounded same-origin auth/navigation
    // reconciliation instead of treating that redirect as an exact-URL
    // failure. This remains read-only and never enters credentials.
    const readbackBatch = await batch([
      ["open", route.target_url],
      ["eval", "location.href"],
      ["eval", "document.title"],
      ["state"],
      ["screenshot", screenshotPath],
    ]);
    const batchCaptured = readbackBatch.captured_readback || {};
    const batchValue = (index) => capturedValue({ captured_readback: batchCaptured[String(index)] });
    const observedUrl = firstUrl(batchValue(1));
    const title = batchValue(2);
    const state = batchValue(3);
    const loginRequired = /\b(sign in|log in|checkpoint|verify)\b|ログイン|サインイン|本人確認/iu.test(`${observedUrl} ${JSON.stringify(state)}`);
    const readbackVerified = exactOrigin(observedUrl) === exactOrigin(route.target_url) && textLength(state) > 0 && textLength(title) > 0;
    const finalized = await adapter.finalizeBrowserUseCliFlow({ flow, authorityPath: authority.path });
    // The AOS worker creates an initial runtime binding before this child is
    // launched.  Return the effective session and owned runtime identity from
    // the same finalized flow so the worker can atomically upgrade that
    // binding to verified.  Without this, a successful Browser Use read-only
    // probe was incorrectly persisted as
    // service_readiness_browser_use_effective_session_missing.
    const browserRuntimeReadback = {
      requested_session: String(flow.contract?.requested_session || flow.session || ""),
      effective_session: String(flow.contract?.effective_session || flow.session || ""),
      profile_root: String(flow.profile || ""),
      reserved_port: Number(flow.port || route.port || 0),
      flow_status: finalized?.finalized === true ? "finalized" : "blocked",
      cleanup_verified: finalized?.finalized === true,
    };
    flow = null;
    const referenceReadback = environment.AUTOMATION_OS_PORTABLE_EXTERNAL_READ_ONLY_STAGE === REFERENCE_READBACK_STAGE;
    const exactBlocker = loginRequired
      ? `auth_blocked:${input.workflow_id}_login_required`
      : !readbackVerified
        ? "portable_external_browser_use_cli_readback_invalid"
        : finalized?.finalized !== true
          ? "portable_external_browser_use_cli_cleanup_unverified"
          : referenceReadback
            ? null
            : PORTABLE_EXTERNAL_READ_ONLY_BUSINESS_PROOF_PENDING;
    return {
      // Reference readback is a terminal no-effect stage with its own
      // readback/cleanup proof. It is intentionally distinct from a
      // candidate-supply shortfall or a business effect receipt; completing
      // this stage never authorizes submit/publish/commerce work.
      status: exactBlocker === null ? "complete" : exactBlocker === PORTABLE_EXTERNAL_READ_ONLY_BUSINESS_PROOF_PENDING ? "partial" : "blocked",
      exact_blocker: exactBlocker || null,
      external_action_executed: false,
      browser_surface: "browser_use_cli",
      workflow_id: input.workflow_id,
      run_id: input.run_id,
      step_id: input.step_id,
      authority_path: authority.path,
      authority_sha256: authority.sha256,
      requested_origin: exactOrigin(route.target_url),
      observed_origin: exactOrigin(observedUrl),
      state_length: textLength(state),
      title_length: textLength(title),
      screenshot_path: fs.existsSync(screenshotPath) ? screenshotPath : "",
      receipt_path: String(finalized?.receipt_path || ""),
      manifest_path: String(finalized?.manifest_path || ""),
      cleanup_verified: finalized?.finalized === true,
      readback_verified: readbackVerified,
      effects_mode: "read_only",
      read_only_stage_bound: [JOB_CANDIDATE_SUPPLY_STAGE, REFERENCE_READBACK_STAGE].includes(environment.AUTOMATION_OS_PORTABLE_EXTERNAL_READ_ONLY_STAGE),
      same_run_receipt: exactBlocker === null,
      external_executor_status: referenceReadback ? "reference_readback_completed" : "authorized_business_runner_pending",
      business_runner_entrypoint: PORTABLE_EXTERNAL_AUTHORIZED_BUSINESS_RUNNER,
      adapter_result: { browser_runtime_readback: browserRuntimeReadback, reference_readback: referenceReadback },
    };
  } catch (error) {
    if (flow) {
      try { await adapter.finalizeBrowserUseCliFlow({ flow, authorityPath: authority.path }); } catch (_) { /* preserve primary blocker */ }
    }
    return {
      status: "blocked",
      exact_blocker: normalizedBlocker(error),
      external_action_executed: false,
      browser_surface: "browser_use_cli",
      workflow_id: input.workflow_id,
      run_id: input.run_id,
      step_id: input.step_id,
      authority_path: authority.path,
      authority_sha256: authority.sha256,
      cleanup_verified: false,
      readback_verified: false,
      effects_mode: "read_only",
      external_executor_status: "authorized_business_runner_pending",
      business_runner_entrypoint: PORTABLE_EXTERNAL_AUTHORIZED_BUSINESS_RUNNER,
    };
  }
}

function effectsEnabled(environment = process.env) {
  return /^(?:1|true|yes|on|enabled)$/iu.test(String(environment.AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS || "").trim());
}

function safeReceipt(value) {
  return JSON.stringify({
    status: value.status,
    exact_blocker: value.exact_blocker ?? null,
    external_action_executed: value.external_action_executed === true,
    browser_surface: value.browser_surface || "browser_use_cli",
    workflow_id: value.workflow_id,
    run_id: value.run_id,
    step_id: value.step_id,
    ...(value.operation ? { operation: value.operation } : {}),
    ...(value.generic_web_operation ? { generic_web_operation: true } : {}),
    authority_path: value.authority_path || "",
    authority_sha256: value.authority_sha256 || "",
    ...(value.intent_sha256 ? { intent_sha256: value.intent_sha256 } : {}),
    requested_origin: value.requested_origin || "",
    observed_origin: value.observed_origin || "",
    state_length: value.state_length || 0,
    title_length: value.title_length || 0,
    screenshot_path: value.screenshot_path || "",
    receipt_path: value.receipt_path || "",
    manifest_path: value.manifest_path || "",
    cleanup_verified: value.cleanup_verified === true,
    readback_verified: value.readback_verified === true,
    ...(value.same_run_receipt !== undefined ? { same_run_receipt: value.same_run_receipt === true } : {}),
    ...(value.target_digest ? { target_digest: value.target_digest } : {}),
    ...(value.source_state_digest ? { source_state_digest: value.source_state_digest } : {}),
    ...(value.payload_hash ? { payload_hash: value.payload_hash } : {}),
    ...(value.dispatch_state ? { dispatch_state: value.dispatch_state } : {}),
    ...(value.effect_claim_path ? { effect_claim_path: value.effect_claim_path } : {}),
    ...(value.web_operation_lifecycle ? { web_operation_lifecycle: value.web_operation_lifecycle } : {}),
    ...(value.semantic_target_readback_verified !== undefined ? { semantic_target_readback_verified: value.semantic_target_readback_verified === true } : {}),
    ...(value.semantic_target_sha256 ? { semantic_target_sha256: value.semantic_target_sha256 } : {}),
    ...(value.semantic_target_candidate_present !== undefined ? { semantic_target_candidate_present: value.semantic_target_candidate_present === true } : {}),
    ...(value.semantic_target_candidate_digest ? { semantic_target_candidate_digest: value.semantic_target_candidate_digest } : {}),
    effects_mode: value.effects_mode || "read_only",
    read_only_stage_bound: value.read_only_stage_bound === true,
    external_executor_status: value.external_executor_status || "authorized_business_runner_pending",
    business_runner_entrypoint: value.business_runner_entrypoint || PORTABLE_EXTERNAL_AUTHORIZED_BUSINESS_RUNNER,
    ...(value.input_bundle_sha256 ? { input_bundle_sha256: value.input_bundle_sha256 } : {}),
    ...(value.adapter_result ? { adapter_result: value.adapter_result } : {}),
  });
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  let input;
  try {
    input = parsePortableRunnerArgs(argv);
    if (effectsEnabled(environment)) {
      const intentFile = readAdaptiveWebOperationIntent(input, environment);
      if (intentFile?.intent?.operation && intentFile.intent.operation !== "read") {
        const admission = readAdmission(input, environment);
        const route = adaptiveRouteForIntent(routeForWorkflow(input.workflow_id), intentFile.intent, input, environment);
        if (route.public_lane === true) throw new Error("portable_external_web_operation_effect_public_forbidden");
        const result = await runAdaptiveWebOperationEffect({ ...input, admission }, route, intentFile.intent, environment);
        process.stdout.write(`${safeReceipt(result)}\n`);
        return result.status === "complete" && !result.exact_blocker ? 0 : 1;
      }
      const approval = String(environment.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL || "").trim();
      const blocked = {
        status: "blocked",
        exact_blocker: approval === "approved" ? PORTABLE_EXTERNAL_ACTION_PLAN_REQUIRED : "portable_external_approval_required",
        external_action_executed: false,
        browser_surface: "browser_use_cli",
      };
      process.stdout.write(`${safeReceipt(blocked)}\n`);
      return 1;
    }
    const admission = readAdmission(input, environment);
    const result = await runReadOnlyWorkflow({ ...input, admission }, environment);
    process.stdout.write(`${safeReceipt(result)}\n`);
    return result.status === "complete" && !result.exact_blocker ? 0 : 1;
  } catch (error) {
    const blocked = {
      status: "blocked",
      exact_blocker: normalizedBlocker(error),
      external_action_executed: false,
      browser_surface: "browser_use_cli",
      workflow_id: input?.workflow_id || "",
      run_id: input?.run_id || "",
      step_id: input?.step_id || "",
    };
    process.stdout.write(`${safeReceipt(blocked)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; });
}

#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { portableBrowserUsePaths } from "./portable-worker-profile.mjs";
import { validateWebOperationIntent } from "./portable-business-action-plan.mjs";
import {
  AOS_CHROME_COMPANION_BROWSER_SURFACE,
  CHROME_PLUGIN_BROWSER_SURFACE,
  normalizeWebOperationBackend,
  webOperationBrowserSurface,
} from "./lib/web-operation-route.mjs";
import { runAdaptiveWebOperationEffect } from "./web-operation-effect-executor.mjs";
import { runAosChromeCompanionWebOperationEffect } from "./aos-chrome-companion-effect-executor.mjs";
import {
  completeSafeExtensionSurfaceHandoff,
  evaluateSafeExtensionSurfaceHandoff,
  officialExtensionEnvironmentForHandoff,
} from "./safe-extension-surface-handoff.mjs";
import {
  checkpointBrowserUseGoal,
  createBrowserUseGoalKernel,
  ensureBrowserUseGoalFlow,
  finalizeBrowserUseGoalFlow,
  recoverBrowserUseGoalFlow,
  readBrowserUseGoalState,
} from "./browser-use-goal-kernel.mjs";

const IDENTIFIER = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,179}$/u;
const JOB_CANDIDATE_SUPPLY_STEP = "job_candidate_supply";
const JOB_CANDIDATE_SUPPLY_STAGE = "candidate_supply";
const REFERENCE_READBACK_STAGE = "reference_readback";
const PORTABLE_INPUT_BUNDLE_SCHEMA = "automation_os_portable_workflow_input_bundle.v1";
const WEB_OPERATION_INTENT_SCHEMA = "automation_os_web_operation_intent.v1";
const ADAPTIVE_WEB_READBACK_STAGE = "adaptive_web_readback";
const ADAPTIVE_PUBLIC_WEB_AUTOMATION = "aos-adaptive-public-web";
const CANDIDATE_SUPPLY_INDUSTRY = "Technology, Information and Internet";
const CANDIDATE_SUPPLY_SALARY_MIN_JPY = 6_000_000;
const CANDIDATE_SUPPLY_SALARY_MAX_JPY = 7_000_000;
const ADAPTIVE_PUBLIC_PORT_START = 19981;
const ADAPTIVE_PUBLIC_PORT_END = 19999;
const WEB_OPERATION_ROUTE_REGISTRY_SCHEMA = "automation_os_web_operation_route_registry.v1";
const WEB_OPERATION_ROUTE_REGISTRY_ID = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,127}$/u;
const AOS_CHROME_COMPANION_TASK_ID_ENV = "AOS_CHROME_COMPANION_TASK_ID";
// These failures belong to the foreground plane only.  They must remain
// visible in the proof, but they must not make an otherwise healthy
// openTabs()->target readback lane unavailable.
const CHROME_PLUGIN_FOREGROUND_ONLY_BLOCKERS = new Set([
  "chrome_selected_tab_readback_invalid",
  "chrome_plugin_foreground_executor_lease_expired",
  "chrome_foreground_activation_capability_unavailable",
]);
const CHROME_PLUGIN_BACKEND_SNAPSHOT_SCHEMA = "aos_web_operation_backend_snapshot.v1";
const CHROME_PLUGIN_BACKEND_SNAPSHOT_MISSING = "chrome_plugin_backend_snapshot_missing";
const CHROME_PLUGIN_BACKGROUND_READ_ONLY_CAPABILITY_SCHEMA = "aos.chrome_plugin_background_read_only_capability.v1";
const CHROME_PLUGIN_DIRECT_BRIDGE_TIMEOUT_ENV = "SOCIAL_FLOW_CHROME_EXTENSION_BRIDGE_IN_PROCESS_TIMEOUT_MS";
const CHROME_PLUGIN_DIRECT_BRIDGE_TIMEOUT_DEFAULT_MS = 20_000;
const CHROME_PLUGIN_DIRECT_BRIDGE_TIMEOUT_MAX_MS = 25_000;
const runtimeHomeDir = typeof process !== "undefined" && process?.env
  ? String(process.env.HOME || "")
  : String(globalThis?.nodeRepl?.homeDir || "");
const CHROME_PLUGIN_READBACK_PATH = path.join(runtimeHomeDir, ".social-flow", "aos-company1-profile2-bridge-readback-v2.json");
const CHROME_PLUGIN_BACKGROUND_READ_ONLY_CAPABILITY_PATH = path.join(
  runtimeHomeDir,
  ".codex",
  "runtime",
  "aos-chrome-plugin-background-read-only-capability.v1.json",
);

function currentRuntimeUid(fallbackStat) {
  const runtimeProcess = typeof process !== "undefined" ? process : null;
  return typeof runtimeProcess?.getuid === "function" ? runtimeProcess.getuid() : fallbackStat.uid;
}

function chromePluginDirectBridgeTimeoutMs(environment = process.env) {
  const requested = Number(String(environment?.[CHROME_PLUGIN_DIRECT_BRIDGE_TIMEOUT_ENV] || "").trim());
  if (!Number.isFinite(requested) || requested <= 0) return CHROME_PLUGIN_DIRECT_BRIDGE_TIMEOUT_DEFAULT_MS;
  return Math.max(100, Math.min(CHROME_PLUGIN_DIRECT_BRIDGE_TIMEOUT_MAX_MS, Math.floor(requested)));
}

async function executeChromePluginDirectBridgeBounded(directBridge, payload, environment = process.env) {
  const timeoutMs = chromePluginDirectBridgeTimeoutMs(environment);
  let timer;
  try {
    return await Promise.race([
      directBridge.executeAosPortableReadOnlyHandoff(payload),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("chrome_plugin_direct_bridge_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function selectedBrowserSurface(environment = process.env) {
  return webOperationBrowserSurface(environment, { defaultBackend: "browser_use_cli" });
}

function chromePluginSelected(environment = process.env) {
  return normalizeWebOperationBackend(environment, { defaultBackend: "browser_use_cli" }) === "chrome_plugin";
}

function chromePluginBackendSnapshotFromEnvironment(environment = process.env) {
  if (!chromePluginSelected(environment)) return { snapshot: null, exact_blocker: null };
  const revision = Number(String(environment.AOS_WEB_OPERATION_BACKEND_REVISION || "").trim());
  const profile = {
    id: String(environment.AOS_CHROME_PROFILE_ID || "").trim(),
    name: String(environment.AOS_CHROME_PROFILE_NAME || "").trim(),
    directory: String(environment.AOS_CHROME_PROFILE_DIRECTORY || "").trim(),
    surface: String(environment.AOS_CHROME_PROFILE_SURFACE || "").trim(),
  };
  const source = String(environment.AOS_WEB_OPERATION_BACKEND_SOURCE || "").trim();
  const fallbackAllowed = String(environment.AOS_WEB_OPERATION_BACKEND_FALLBACK_ALLOWED || "").trim();
  if (!Number.isSafeInteger(revision) || revision < 1
    || source !== "aos_global_setting"
    || fallbackAllowed !== "false"
    || profile.id !== "profile2"
    || profile.name !== "Profile 2"
    || profile.directory !== "Profile 2"
    || profile.surface !== CHROME_PLUGIN_BROWSER_SURFACE) {
    return { snapshot: null, exact_blocker: CHROME_PLUGIN_BACKEND_SNAPSHOT_MISSING };
  }
  return {
    snapshot: {
      schema: CHROME_PLUGIN_BACKEND_SNAPSHOT_SCHEMA,
      requested_backend: "chrome_plugin",
      resolved_backend: "chrome_plugin",
      revision,
      source,
      fallback_allowed: false,
      chrome_profile: profile,
      browser_surface: CHROME_PLUGIN_BROWSER_SURFACE,
      exact_blocker: null,
    },
    exact_blocker: null,
  };
}

export function readChromePluginBackgroundReadOnlyCapability(environment = process.env, { now = Date.now() } = {}) {
  const configuredPath = String(
    environment.AOS_CHROME_PLUGIN_BACKGROUND_READ_ONLY_CAPABILITY_PATH
      || CHROME_PLUGIN_BACKGROUND_READ_ONLY_CAPABILITY_PATH,
  ).trim();
  if (!path.isAbsolute(configuredPath)) throw new Error("chrome_plugin_background_read_only_capability_path_invalid");
  let stat;
  let value;
  try {
    stat = fs.lstatSync(configuredPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("invalid_capability_permissions");
    }
    value = JSON.parse(fs.readFileSync(configuredPath, "utf8"));
  } catch {
    throw new Error("chrome_plugin_background_read_only_capability_missing");
  }
  const token = String(value?.token || "").trim();
  const expiresAt = Date.parse(String(value?.expires_at || ""));
  const capabilityId = createHash("sha256").update(token).digest("hex");
  if (value?.schema !== CHROME_PLUGIN_BACKGROUND_READ_ONLY_CAPABILITY_SCHEMA
    || value?.audience !== "aos_portable_remote_worker"
    || value?.browser_backend !== "chrome_plugin"
    || value?.browser_surface !== CHROME_PLUGIN_BROWSER_SURFACE
    || value?.read_only !== true
    || value?.external_action_allowed !== false
    || !token
    || capabilityId !== String(value.capability_id || "")
    || !Number.isFinite(expiresAt)
    || expiresAt <= Number(now)) {
    throw new Error("chrome_plugin_background_read_only_capability_invalid");
  }
  return Object.freeze({
    path: configuredPath,
    token,
    capability_id: capabilityId,
    bridge_instance_id: String(value.bridge_instance_id || ""),
    expires_at: String(value.expires_at),
  });
}

function selectedReadOnlyBackend(environment = process.env) {
  return normalizeWebOperationBackend(environment, { defaultBackend: "browser_use_cli" });
}

function readOnlyBackendBlocker(environment = process.env) {
  const backend = selectedReadOnlyBackend(environment);
  if (backend === "playwright") return "portable_external_read_only_backend_not_implemented:playwright";
  if (backend !== "chrome_plugin" && backend !== "browser_use_cli" && backend !== "aos_chrome_companion") {
    return `portable_external_read_only_backend_unknown:${backend || "empty"}`;
  }
  return null;
}

function browserUsePaths(environment = process.env) {
  const configured = portableBrowserUsePaths(environment);
  return {
    stageAdapter: configured.stageAdapter,
    helper: path.resolve(String(environment.BROWSER_USE_CLI_HELPER || environment.AUTOMATION_OS_BROWSER_USE_CLI_HELPER || configured.helper)),
    candidateSupplyAdapter: path.resolve(String(environment.AUTOMATION_OS_PORTABLE_CANDIDATE_SUPPLY_ADAPTER || path.join(environment.AUTOMATION_OS_BROWSER_USE_PROJECT_ROOT || path.join(runtimeHomeDir, "Documents", "New project"), "scripts", "browser_use", "job_manager_browser_use_cli_candidate_supply_adapter.mjs"))),
  };
}

function companionTaskIdFor(input, environment = process.env) {
  const candidate = String(
    input?.task_id
      || environment?.[AOS_CHROME_COMPANION_TASK_ID_ENV]
      || "",
  ).trim();
  return IDENTIFIER.test(candidate) ? candidate : "";
}

function companionReceiptBlocker(receipt) {
  const blocker = receipt?.exact_blocker;
  if (typeof blocker === "string" && blocker.trim()) return blocker.trim().slice(0, 240);
  if (blocker && typeof blocker === "object" && typeof blocker.code === "string" && blocker.code.trim()) {
    return blocker.code.trim().slice(0, 240);
  }
  return "aos_chrome_companion_read_only_receipt_invalid";
}

/**
 * Companion is a normal/read-only surface, but it is intentionally not an
 * effectful business adapter. Keep this lane independent from Browser Use
 * CLI and require the exact task owner ID before opening a Companion session.
 * The adapter owns session/lease cleanup; this wrapper only normalizes the
 * runner receipt and closes the broker client it created.
 */
export async function runAosChromeCompanionReadOnlyWorkflow(
  input,
  environment = process.env,
  { adapterModule = null, client = null } = {},
) {
  const route = routeForWorkflow(input.workflow_id);
  const taskId = companionTaskIdFor(input, environment);
  if (!taskId) {
    return {
      status: "blocked",
      exact_blocker: "aos_chrome_companion_task_id_missing",
      external_action_executed: false,
      browser_backend: "aos_chrome_companion",
      browser_surface: AOS_CHROME_COMPANION_BROWSER_SURFACE,
      workflow_id: input.workflow_id,
      run_id: input.run_id,
    };
  }
  if (!route) {
    return {
      status: "blocked",
      exact_blocker: `${PORTABLE_EXTERNAL_READ_ONLY_ROUTE_NOT_CONFIGURED}:${input.workflow_id}`,
      external_action_executed: false,
      browser_backend: "aos_chrome_companion",
      browser_surface: AOS_CHROME_COMPANION_BROWSER_SURFACE,
      workflow_id: input.workflow_id,
      run_id: input.run_id,
      task_id: taskId,
    };
  }

  let module = adapterModule;
  let brokerClient = client;
  let ownsClient = false;
  try {
    module ||= await import("./aos-chrome-companion-adapter.mjs");
    if (!brokerClient) {
      brokerClient = await module.loadCompanionBrokerClient(environment);
      ownsClient = true;
    }
    const receipt = await module.executeAosChromeCompanionReadOnly({
      runId: input.run_id,
      taskId,
      mode: "read_only",
      target: { url: route.target_url },
      allowedOrigins: route.allowed_origins,
      profileInstanceId: environment.AOS_CHROME_COMPANION_PROFILE_INSTANCE_ID || undefined,
      maxTextChars: 30_000,
    }, { client: brokerClient });
    const cleanupVerified = receipt?.cleanup?.session_closed === true
      && receipt?.cleanup?.lease_released_by_session_close === true;
    const targetOwnershipVerified = receipt?.target?.task_owned === true;
    const readbackVerified = receipt?.result === "verified"
      && Boolean(receipt?.readback)
      && targetOwnershipVerified;
    const visualReadbackVerified = receipt?.visual_readback_verified === true
      && receipt?.visual_readback?.captured === true
      && Boolean(receipt?.visual_readback?.sha256);
    const exactBlocker = readbackVerified && visualReadbackVerified && cleanupVerified
      ? null
      : receipt?.result === "verified" && !targetOwnershipVerified
        ? "aos_chrome_companion_target_not_task_owned"
      : readbackVerified && !visualReadbackVerified
        ? "aos_chrome_companion_visual_readback_unverified"
        : receipt?.result === "verified" && !cleanupVerified
        ? "aos_chrome_companion_cleanup_unverified"
        : companionReceiptBlocker(receipt);
    const completeReadOnlyProof = exactBlocker === null;
    return {
      status: exactBlocker === null ? "complete" : "blocked",
      exact_blocker: exactBlocker,
      external_action_executed: false,
      browser_backend: "aos_chrome_companion",
      browser_surface: AOS_CHROME_COMPANION_BROWSER_SURFACE,
      workflow_id: input.workflow_id,
      run_id: input.run_id,
      step_id: input.step_id,
      task_id: taskId,
      requested_origin: new URL(route.target_url).origin,
      observed_origin: receipt?.readback?.url ? new URL(receipt.readback.url).origin : "",
      readback_verified: readbackVerified,
      visual_readback_required: true,
      visual_readback_verified: visualReadbackVerified,
      visual_readback: receipt?.visual_readback || null,
      cleanup_verified: cleanupVerified,
      mutation_dispatch_attempted: false,
      mutation_dispatch_count: 0,
      operation_effect_state: "none",
      reconciliation_required: false,
      same_run_receipt: completeReadOnlyProof,
      read_only_proof_verified: completeReadOnlyProof,
      effects_mode: "read_only",
      read_only_stage_bound: true,
      external_executor_status: readbackVerified && visualReadbackVerified && cleanupVerified
        ? "aos_chrome_companion_read_only_completed"
        : "aos_chrome_companion_read_only_blocked",
      adapter_result: receipt,
    };
  } catch (error) {
    return {
      status: "blocked",
      exact_blocker: normalizedBlocker(error),
      external_action_executed: false,
      browser_backend: "aos_chrome_companion",
      browser_surface: AOS_CHROME_COMPANION_BROWSER_SURFACE,
      workflow_id: input.workflow_id,
      run_id: input.run_id,
      step_id: input.step_id,
      task_id: taskId,
      effects_mode: "read_only",
      read_only_stage_bound: true,
      external_executor_status: "aos_chrome_companion_read_only_blocked",
    };
  } finally {
    if (ownsClient && brokerClient && typeof brokerClient.close === "function") {
      try { await brokerClient.close(); } catch { /* preserve the primary receipt */ }
    }
  }
}

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
  "prompt-transfer-ukiyoe": Object.freeze({
    automation_id: "prompt-transfer-ukiyoe",
    stage_id: "aos_prompt_transfer_read_only_preflight",
    // This is the canonical source root used by the workflow-owned Chrome
    // adapter. The later Sheets B:D write remains a separate approval-gated
    // effect stage; this route only verifies authenticated Docs readback.
    target_url: "https://docs.google.com/document/d/1j2lsvr1zJs9k9cCkLGeGF-soZZSGuY2p0tQ6wJp8S0s/edit?tab=t.0",
    allowed_origins: ["https://docs.google.com"],
    port: 19981,
    account_identity: "prompt_transfer_authenticated_google_workspace",
    data_exposure: "authenticated_google_docs_readback",
  }),
  "sns-multi-poster-ukiyoe": Object.freeze({
    automation_id: "sns-multi-poster-ukiyoe",
    stage_id: "aos_sns_multi_poster_read_only_preflight",
    // The existing Chrome social runner uses X home as its canonical
    // authenticated social root. No composer or publish URL is opened here.
    target_url: "https://x.com/home",
    allowed_origins: ["https://x.com"],
    port: 20081,
    account_identity: "sns_multi_poster_authenticated_social_readback",
    data_exposure: "authenticated_social_readback",
  }),
  "x-authenticated-browser-lane": Object.freeze({
    automation_id: "x-authenticated-browser-lane",
    stage_id: "aos_x_authenticated_read_only_preflight",
    target_url: "https://x.com/home",
    allowed_origins: ["https://x.com"],
    port: 19885,
    account_identity: "x_authenticated_browser_lane_readback",
    data_exposure: "authenticated_x_readback",
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
  if (values.task_id !== undefined && !IDENTIFIER.test(String(values.task_id || ""))) {
    throw new Error("portable_external_task_id_invalid");
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
  const currentUid = currentRuntimeUid(stat);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.uid !== currentUid || (stat.mode & 0o777) !== 0o600) {
    throw new Error("portable_external_web_operation_intent_permissions_invalid");
  }
  if (sha256Bytes(bytes) !== expectedSha256) throw new Error("portable_external_web_operation_intent_digest_invalid");
  let raw;
  try { raw = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("portable_external_web_operation_intent_json_invalid"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schema !== WEB_OPERATION_INTENT_SCHEMA
    || raw.workflow_id !== input.workflow_id || raw.run_id !== input.run_id || raw.step_id !== input.step_id
    || raw.source_trigger !== input.source_trigger || raw.idempotency_key !== input.idempotency_key
    || raw.browser_surface !== selectedBrowserSurface(environment) || !raw.entry_url) {
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
    || value.browser_surface !== selectedBrowserSurface(environment)) throw new Error(PORTABLE_EXTERNAL_ADMISSION_INVALID);
  if (Date.parse(String(value.expires_at || "")) <= Date.now()) throw new Error(PORTABLE_EXTERNAL_ADMISSION_EXPIRED);
  return Object.freeze({ path: admissionPath, sha256: expectedSha256, value });
}

function authorityImmutableProjection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const projection = { ...value };
  delete projection.not_before;
  delete projection.expires_at;
  return JSON.stringify(projection);
}

function writePrivateImmutableJson(filePath, value, { reusableReadOnlyAuthority = false } = {}) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(resolved), 0o700);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("portable_external_authority_immutable_collision");
    const existingBytes = fs.readFileSync(resolved, "utf8");
    if (reusableReadOnlyAuthority) {
      let existing;
      try { existing = JSON.parse(existingBytes); } catch { throw new Error("portable_external_authority_immutable_collision"); }
      if (value?.schema !== "authority.v1"
        || existing?.schema !== "authority.v1"
        || authorityImmutableProjection(existing) !== authorityImmutableProjection(value)) {
        throw new Error("portable_external_authority_immutable_collision");
      }
      if (Date.parse(String(existing.expires_at || "")) <= Date.now()) {
        throw new Error("portable_external_authority_expired");
      }
      fs.chmodSync(resolved, 0o600);
      return { path: resolved, sha256: sha256Bytes(existingBytes), reused: true };
    }
    if (existingBytes !== bytes) throw new Error("portable_external_authority_immutable_collision");
    fs.chmodSync(resolved, 0o600);
    return { path: resolved, sha256: sha256Bytes(bytes) };
  }
  const fd = fs.openSync(resolved, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, bytes, "utf8"); } finally { fs.closeSync(fd); }
  fs.chmodSync(resolved, 0o600);
  return { path: resolved, sha256: sha256Bytes(bytes) };
}

export function issueReadOnlyAuthority({ route, input, runRoot, environment = process.env }) {
  const now = Date.now();
  const authority = {
    schema: "authority.v1",
    version: "1",
    automation_id: route.automation_id,
    stage_id: route.stage_id,
    mode: "authorized",
    browser_surface: selectedBrowserSurface(environment),
    run_id: input.run_id,
    // The authority and Goal kernel must carry the exact same session. A
    // preflight-only suffix creates a fresh-session mismatch before Browser
    // Use starts, defeating the Goal-level reuse contract.
    session: goalSessionFor(input, route),
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
    { reusableReadOnlyAuthority: true },
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
  const currentUid = currentRuntimeUid(stat);
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
  const industry = String(bundle.industry || CANDIDATE_SUPPLY_INDUSTRY).trim();
  if (!industry || industry.length > 120 || /[\u0000-\u001f]/u.test(industry)) {
    throw new Error("portable_external_candidate_supply_input_bundle_industry_invalid");
  }
  const salaryMinJpy = Number(bundle.salary_min_jpy ?? CANDIDATE_SUPPLY_SALARY_MIN_JPY);
  const salaryMaxJpy = Number(bundle.salary_max_jpy ?? CANDIDATE_SUPPLY_SALARY_MAX_JPY);
  if (!Number.isSafeInteger(salaryMinJpy) || !Number.isSafeInteger(salaryMaxJpy)
    || salaryMinJpy <= 0 || salaryMaxJpy < salaryMinJpy || salaryMaxJpy > 100_000_000) {
    throw new Error("portable_external_candidate_supply_input_bundle_salary_range_invalid");
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
      industry,
      salaryMinJpy,
      salaryMaxJpy,
    },
  };
}

export function chromePluginReadbackPathForEnvironment(environment = process.env) {
  const homeDir = String(environment.HOME || runtimeHomeDir || "").trim();
  return String(
    environment.AOS_CHROME_PLUGIN_READBACK_PATH
      || environment.SOCIAL_FLOW_CHROME_PLUGIN_READBACK_PATH
      || (homeDir ? path.join(homeDir, ".social-flow", "aos-company1-profile2-bridge-readback-v2.json") : CHROME_PLUGIN_READBACK_PATH),
  ).trim();
}

function readChromePluginBridgeRaw(environment = process.env) {
  const configuredPath = chromePluginReadbackPathForEnvironment(environment);
  if (!path.isAbsolute(configuredPath)) throw new Error("chrome_plugin_bridge_readback_path_invalid");
  let stat;
  let value;
  try {
    stat = fs.lstatSync(configuredPath);
    value = JSON.parse(fs.readFileSync(configuredPath, "utf8"));
  } catch {
    throw new Error("chrome_plugin_bridge_readback_missing");
  }
  const currentUid = currentRuntimeUid(stat);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.uid !== currentUid || (stat.mode & 0o077) !== 0) {
    throw new Error("chrome_plugin_bridge_readback_permissions_invalid");
  }
  return Object.freeze({ path: configuredPath, value });
}

function writeChromePluginBridgeReadbackAtomically(readbackPath, value) {
  const resolvedPath = path.resolve(String(readbackPath || ""));
  if (!resolvedPath || resolvedPath === path.parse(resolvedPath).root) {
    throw new Error("chrome_plugin_bridge_readback_path_invalid");
  }
  const parent = path.dirname(resolvedPath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporaryPath = `${resolvedPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, resolvedPath);
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* best effort */ }
    throw new Error(`chrome_plugin_bridge_readback_rebind_write_failed:${String(error?.message || error)}`);
  }
  return resolvedPath;
}

export function readChromePluginProfile2LastUsedFromLocalState(environment = process.env) {
  const configuredPath = String(
    environment.AOS_CHROME_PLUGIN_LOCAL_STATE_PATH
      || environment.AOS_CHROME_LOCAL_STATE_PATH
      || path.join(String(environment.HOME || "/Users/nichikatanaka"), "Library", "Application Support", "Google", "Chrome", "Local State")
  ).trim();
  const expectedDirectory = String(environment.AOS_CHROME_PROFILE_DIRECTORY || "Profile 2").trim();
  if (!path.isAbsolute(configuredPath) || !expectedDirectory) return false;
  try {
    const localState = JSON.parse(fs.readFileSync(configuredPath, "utf8"));
    const profile = localState?.profile;
    return profile?.last_used === expectedDirectory
      && Array.isArray(profile?.profiles_order)
      && profile.profiles_order.includes(expectedDirectory)
      && profile?.info_cache?.[expectedDirectory]
      && typeof profile.info_cache[expectedDirectory] === "object";
  } catch {
    return false;
  }
}

export function chromePluginBridgeUrlFromReadback(value, environment = process.env) {
  const rawUrl = String(value?.bridge_url || "").trim().replace(/\/$/u, "");
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("chrome_plugin_bridge_url_invalid");
  }
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !/^\d+$/u.test(parsed.port)) {
    throw new Error("chrome_plugin_bridge_url_not_loopback");
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("chrome_plugin_bridge_port_invalid");
  }
  const configuredPort = String(environment.AOS_CHROME_PLUGIN_BRIDGE_PORT || "").trim();
  if (configuredPort && configuredPort !== String(port)) {
    throw new Error("chrome_plugin_bridge_port_binding_invalid");
  }
  return `http://127.0.0.1:${port}`;
}

export function assertChromePluginBridgeReadbackValue(value, environment = process.env, { targetScopedReadback = false } = {}) {
  const seenAt = Date.parse(String(value?.last_seen_at || ""));
  const browser = value?.browser && typeof value.browser === "object" ? value.browser : {};
  const metadata = browser.metadata && typeof browser.metadata === "object" ? browser.metadata : {};
  const owner = value?.bridge_owner && typeof value.bridge_owner === "object" ? value.bridge_owner : {};
  const ownerUpdatedAt = Date.parse(String(owner.updated_at || ""));
  const expectedBridgeUrl = chromePluginBridgeUrlFromReadback(value, environment);
  const selectedTab = value?.selected_tab && typeof value.selected_tab === "object" ? value.selected_tab : null;
  const visibility = value?.visibility && typeof value.visibility === "object" ? value.visibility : null;
  const authority = String(value?.browser_execution_authority || "");
  const targetScopedBusiness = authority === "target_scoped_business";
  const transportAdmission = authority === "general" || authority === "read_only_admission" || targetScopedBusiness;
  const readOnlyAdmission = authority === "read_only_admission" || targetScopedBusiness;
  const exactBlocker = String(value?.exact_blocker || value?.operation_exact_blocker || value?.refresh_exact_blocker || "").trim();
  const targetScopedBlockerAllowed = exactBlocker === ""
    || CHROME_PLUGIN_FOREGROUND_ONLY_BLOCKERS.has(exactBlocker);
  // Target-scoped read-only does not need selected()/focus/visibility.  A
  // fresh bridge may therefore truthfully report a terminal selected-tab
  // or foreground-capability blocker while still admitting the separate
  // openTabs()->target readback contract. Keep the exception narrow: only
  // known foreground-plane blockers, blocked operation state, and an absent
  // selected tab qualify.
  const targetScopedForegroundBlockerAdmission = targetScopedReadback
    && selectedTab === null
    && value?.operation_ready === false
    && value?.operation_status === "blocked"
    && CHROME_PLUGIN_FOREGROUND_ONLY_BLOCKERS.has(exactBlocker);
  const targetScopedReadOnlyStatusValid = targetScopedReadback
    && readOnlyAdmission
    && ["read_only_ready", "target_scoped_ready"].includes(String(value?.operation_status || ""));
  const operationAdmissionValid = targetScopedForegroundBlockerAdmission || (transportAdmission
    ? value?.operation_ready === true
      && (targetScopedReadOnlyStatusValid || value?.operation_status === (readOnlyAdmission ? "read_only_ready" : "ready"))
      && (targetScopedReadback || String(selectedTab?.id || "").trim().length > 0)
    : value?.operation_ready === true
      && value?.operation_status === "ready"
      && (targetScopedReadback || String(selectedTab?.id || "").trim().length > 0)
      && visibility?.capability_id === "visibility"
      && visibility?.advertised === true
      && visibility?.state === true);
  const profile2LastUsed = String(metadata.profileIsLastUsed || "") === "true"
    || (String(metadata.profileIsLastUsed || "") === "false" && readChromePluginProfile2LastUsedFromLocalState(environment));
  if (value?.schema !== "aos.chrome_plugin_bridge_readback.v2"
    || (targetScopedReadback
      ? !["ready", "blocked"].includes(String(value.status || "")) || !targetScopedBlockerAllowed
      : value.status !== "ready")
    || value.backend !== "chrome_extension_trusted_bridge"
    || value.browser_execution_disabled === true
    || String(value.bridge_url || "").replace(/\/$/u, "") !== expectedBridgeUrl
    || !String(value.bridge_instance_id || "").trim()
    || browser.type !== "extension"
    || String(metadata.profileOrdering || "") !== "2"
    || !profile2LastUsed
    || owner.schema !== "aos.chrome_plugin_bridge_owner.v1"
    || !String(owner.owner_id || "").trim()
    || String(owner.bridge_instance_id || "") !== String(value.bridge_instance_id || "")
    || !String(owner.session_id || "").trim()
    || !String(owner.thread_id || "").trim()
    || !String(owner.turn_id || "").trim()
    || (targetScopedReadback
      ? !["bridge_only", "foreground_ready"].includes(String(owner.status || ""))
      : owner.status !== "foreground_ready")
    || (!targetScopedReadback && owner.foreground_executor_ready !== true)
    || !operationAdmissionValid
    || (!targetScopedReadback && (
      !Number.isFinite(ownerUpdatedAt)
      || Date.now() - ownerUpdatedAt > 30_000
      || ownerUpdatedAt - Date.now() > 5_000
      || !Number.isFinite(seenAt)
      || Date.now() - seenAt > 30_000
      || seenAt - Date.now() > 5_000
    ))) {
    throw new Error(String(
      value?.exact_blocker
        || value?.operation_exact_blocker
        || owner.exact_blocker
        || (value?.schema !== "aos.chrome_plugin_bridge_readback.v2"
          ? "chrome_plugin_bridge_readback_schema_invalid"
          : "chrome_plugin_operation_admission_readback_invalid")
    ));
  }
}

function readChromePluginBridgeReadback(environment = process.env) {
  const raw = readChromePluginBridgeRaw(environment);
  assertChromePluginBridgeReadbackValue(raw.value, environment);
  return raw;
}

export async function refreshChromePluginBridgeReadback(environment = process.env, { targetScopedReadback = false } = {}) {
  const raw = readChromePluginBridgeRaw(environment);
  const bridgeUrl = chromePluginBridgeUrlFromReadback(raw.value, environment);
  const bridgeInstanceId = String(raw.value?.bridge_instance_id || "").trim();
  if (!bridgeInstanceId) {
    throw new Error("chrome_plugin_bridge_readback_missing");
  }
  let response;
  try {
    response = await fetch(`${bridgeUrl}/health`);
  } catch {
    throw new Error("chrome_plugin_bridge_health_unavailable");
  }
  if (!response.ok) throw new Error("chrome_plugin_bridge_health_blocked");
  const health = await response.json().catch(() => ({}));
  const healthBridgeInstanceId = String(health.bridge_instance_id || "").trim();
  const healthUrl = String(health.url || "").replace(/\/$/u, "");
  if (health?.ok !== true
    || health?.backend !== "chrome_extension_trusted_bridge"
    || !healthBridgeInstanceId
    || healthUrl !== bridgeUrl) {
    throw new Error("chrome_plugin_bridge_health_binding_invalid");
  }
  const freshReadback = health?.browser_readback && typeof health.browser_readback === "object"
    ? health.browser_readback
    : null;
  if (!freshReadback) throw new Error("chrome_plugin_bridge_health_readback_missing");
  if (String(freshReadback.bridge_instance_id || "").trim() !== healthBridgeInstanceId
    || String(freshReadback.bridge_url || "").replace(/\/$/u, "") !== bridgeUrl) {
    throw new Error("chrome_plugin_bridge_health_readback_binding_invalid");
  }
  assertChromePluginBridgeReadbackValue(freshReadback, environment, { targetScopedReadback });
  // The worker-owned path is a durable handoff boundary, not just a cached
  // observation. A bridge can be restarted by another official foreground
  // owner while this file still contains a stopped predecessor. Publish the
  // already-validated same-owner health readback through the official runner
  // writer so the next worker iteration can bind the current instance. Never
  // overwrite a different live foreground owner: that is an ownership
  // conflict, not a rebind opportunity.
  const currentLastSeen = Date.parse(String(raw.value?.last_seen_at || ""));
  const currentOwner = raw.value?.bridge_owner && typeof raw.value.bridge_owner === "object"
    ? raw.value.bridge_owner
    : {};
  const currentOwnerUpdated = Date.parse(String(currentOwner.updated_at || ""));
  const currentLooksLive = raw.value?.status === "ready"
    && String(currentOwner.status || "") === "foreground_ready"
    && currentOwner.foreground_executor_ready === true
    && String(currentOwner.bridge_instance_id || "") === bridgeInstanceId
    && Number.isFinite(currentLastSeen)
    && Number.isFinite(currentOwnerUpdated)
    && Date.now() - currentLastSeen <= 30_000
    && Date.now() - currentOwnerUpdated <= 30_000;
  if (bridgeInstanceId !== healthBridgeInstanceId && currentLooksLive) {
    throw new Error("chrome_plugin_bridge_rebind_conflict");
  }
  const writtenPath = writeChromePluginBridgeReadbackAtomically(raw.path, freshReadback);
  return {
    path: writtenPath,
    value: freshReadback,
    rebound: bridgeInstanceId !== healthBridgeInstanceId,
    previous_bridge_instance_id: bridgeInstanceId,
    bridge_instance_id: healthBridgeInstanceId,
  };
}

export async function runChromePluginBridgeClient({ payload, environment = process.env, bridgeReadback = null }) {
  const directBridge = globalThis?.__socialFlowChromeExtensionBridge;
  const hostMetadata = globalThis?.nodeRepl?.requestMeta?.["x-codex-turn-metadata"] || null;
  if (globalThis?.nodeRepl && typeof directBridge?.executeAosPortableReadOnlyHandoff === "function") {
    const boundPayload = hostMetadata
      ? {
          ...payload,
          codexSessionId: String(hostMetadata.session_id || ""),
          codexThreadId: String(hostMetadata.thread_id || hostMetadata.session_id || ""),
          codexTurnId: String(hostMetadata.turn_id || ""),
          thread_source: String(hostMetadata.thread_source || "user"),
        }
      : payload;
    try {
      const result = await executeChromePluginDirectBridgeBounded(directBridge, boundPayload, environment);
      return { result, code: 0, signal: null, stderr: "", direct: true };
    } catch (error) {
      return { result: null, code: 2, signal: null, error: String(error?.message || error), stderr: "", direct: true };
    }
  }
  const projectRoot = path.resolve(String(environment.AUTOMATION_OS_CHROME_PLUGIN_PROJECT_ROOT || "/Users/nichikatanaka/Documents/New project"));
  const clientPath = path.join(projectRoot, "scripts", "browser_use", "chrome_extension_trusted_bridge_client.mjs");
  if (!fs.existsSync(clientPath)) throw new Error("chrome_plugin_trusted_bridge_client_missing");
  const bridge = bridgeReadback?.value || readChromePluginBridgeReadback(environment).value;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [clientPath, "aos-read-only-handoff"], {
      cwd: projectRoot,
      env: {
        ...environment,
        SOCIAL_FLOW_CHROME_EXTENSION_BRIDGE_URL: String(bridge.bridge_url),
        SOCIAL_FLOW_TRUSTED_BRIDGE_INSTANCE_ID: String(bridge.bridge_instance_id),
        SOCIAL_FLOW_CHROME_EXTENSION_BRIDGE_TIMEOUT_MS: String(environment.SOCIAL_FLOW_CHROME_EXTENSION_BRIDGE_TIMEOUT_MS || "240000"),
        SOCIAL_FLOW_CHROME_EXTENSION_BRIDGE_POLL_SECONDS: String(environment.SOCIAL_FLOW_CHROME_EXTENSION_BRIDGE_POLL_SECONDS || "220"),
        SOCIAL_FLOW_CHROME_EXTENSION_BRIDGE_POLL_INTERVAL_MS: String(environment.SOCIAL_FLOW_CHROME_EXTENSION_BRIDGE_POLL_INTERVAL_MS || "2000"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-200_000); });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    child.once("error", (error) => resolve({ result: null, code: null, error: String(error?.message || error), stderr }));
    child.once("close", (code, signal) => {
      let result = null;
      for (const line of stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean).reverse()) {
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) { result = parsed; break; }
        } catch { /* keep the last structured line only */ }
      }
      resolve({ result, code, signal, stderr });
    });
    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

async function issueChromePluginReadOnlyActiveCallNonce({ targetScopedReadback = false } = {}) {
  const bridge = globalThis?.__socialFlowChromeExtensionBridge;
  if (typeof bridge?.issueAosPortableReadOnlyHandoffNonce !== "function") return "";
  return String(await bridge.issueAosPortableReadOnlyHandoffNonce({ targetScopedReadback }) || "").trim();
}

function chromePluginTargetScopedReadbackEligible(value) {
  const exactBlocker = String(
    value?.exact_blocker
      || value?.operation_exact_blocker
      || value?.refresh_exact_blocker
      || "",
  ).trim();
  const owner = value?.bridge_owner;
  return CHROME_PLUGIN_FOREGROUND_ONLY_BLOCKERS.has(exactBlocker)
    && String(value?.bridge_instance_id || "").trim()
    && owner
    && String(owner.session_id || "").trim()
    && String(owner.thread_id || "").trim()
    && String(owner.turn_id || "").trim();
}

function chromePluginReadOnlyRequest({ input, runRoot, bundle = null, route = null, environment = process.env, bridgeReadback = null, activeCallNonce = "", backgroundCapabilityId = "", webOperationBackendSnapshot = null, targetScopedReadback = false }) {
  const handoffDir = path.join(runRoot, "chrome-plugin-foreground-handoff");
  const requestPath = path.join(handoffDir, "request.v1.json");
  fs.mkdirSync(handoffDir, { recursive: true, mode: 0o700 });
  const bridge = bridgeReadback?.value || readChromePluginBridgeReadback(environment).value;
  const request = {
    schema: "aos.chrome_plugin_read_only_handoff_request.v1",
    workflow_id: input.workflow_id,
    run_id: input.run_id,
    step_id: input.step_id,
    source_trigger: input.source_trigger,
    idempotency_key: input.idempotency_key,
    scheduler_run_dir: runRoot,
    request_path: requestPath,
    control_run_id: `aos-${input.run_id}-control`,
    control_request_id: `aos-${input.run_id}-${input.step_id}-handoff`,
    receipt_id: `${input.run_id}:${input.step_id}:chrome-plugin-read-only`,
    handoff_authority: activeCallNonce ? "active_call" : "background_read_only",
    active_call_nonce: String(activeCallNonce || ""),
    background_capability_id: String(backgroundCapabilityId || ""),
    bridge_instance_id: String(bridge.bridge_instance_id),
    bridge_owner_id: String(bridge.bridge_owner?.owner_id || ""),
    bridge_owner_pid: Number(bridge.bridge_owner?.pid || 0),
    bridge_owner_started_at: String(bridge.bridge_owner?.started_at || ""),
    bridge_owner_session_id: String(bridge.bridge_owner?.session_id || ""),
    bridge_owner_thread_id: String(bridge.bridge_owner?.thread_id || ""),
    bridge_owner_turn_id: String(bridge.bridge_owner?.turn_id || ""),
    browser_backend: "chrome_plugin",
    browser_surface: CHROME_PLUGIN_BROWSER_SURFACE,
    web_operation_backend_snapshot: webOperationBackendSnapshot,
    web_operation_backend_snapshot_sha256: webOperationBackendSnapshot
      ? sha256Bytes(`${JSON.stringify(webOperationBackendSnapshot, null, 2)}\n`)
      : "",
    operation: bundle ? "candidate_supply" : "readback",
    target_scoped_readback: targetScopedReadback === true,
    visual_readback_required: true,
    visual_readback_policy: "always_before_completion",
    // The target-scoped lane owns only its allowlisted read-only route. When
    // the exact route is absent from this fresh browser inventory, the
    // common Chrome Plugin layer may create one task-owned tab, verify it,
    // and close only that tab. Foreground/selected-tab recovery remains a
    // separate gate and is never inferred from this flag.
    provision_target_if_missing: targetScopedReadback === true,
    target_tab: input?.target_tab && typeof input.target_tab === "object" ? input.target_tab : null,
    source_snapshot_id: bundle?.input.sourceSnapshotId || "",
    supply_run_id: bundle?.input.supplyRunId || "",
    bucket: bundle?.input.bucket || "",
    remaining: bundle?.input.remaining || 0,
    margin: bundle?.input.margin || 0,
    industry: bundle?.input.industry || "",
    salary_min_jpy: bundle?.input.salaryMinJpy || 0,
    salary_max_jpy: bundle?.input.salaryMaxJpy || 0,
    salary_filter_mode: bundle ? "visible_job_text_strict" : "none",
    existing_keys: [],
    target_url: String(route?.target_url || ""),
    artifact_dir: path.join(runRoot, "candidate-supply"),
    created_at: new Date().toISOString(),
  };
  const encoded = `${JSON.stringify(request, null, 2)}\n`;
  const requestSha256 = sha256Bytes(encoded);
  const requestArtifact = writePrivateImmutableJson(requestPath, request);
  if (requestArtifact.sha256 !== requestSha256) throw new Error("chrome_plugin_read_only_handoff_request_digest_invalid");
  return { request, requestPath, requestSha256, bridge };
}

async function runChromePluginReadOnlyWorkflow(input, environment = process.env, { bundle = null } = {}) {
  const { runRoot } = safeRunRoot(input.run_id, environment);
  const route = routeForWorkflow(input.workflow_id);
  if (!route) {
    return {
      status: "blocked",
      exact_blocker: `${PORTABLE_EXTERNAL_READ_ONLY_ROUTE_NOT_CONFIGURED}:${input.workflow_id}`,
      external_action_executed: false,
      browser_backend: "chrome_plugin",
      browser_surface: CHROME_PLUGIN_BROWSER_SURFACE,
    };
  }
  const backendBinding = chromePluginBackendSnapshotFromEnvironment(environment);
  if (backendBinding.exact_blocker) {
    return {
      status: "blocked",
      exact_blocker: backendBinding.exact_blocker,
      external_action_executed: false,
      browser_backend: "chrome_plugin",
      browser_surface: CHROME_PLUGIN_BROWSER_SURFACE,
    };
  }
  let bridgeReadback;
  // Every Chrome Plugin invocation in this function is a read-only workflow.
  // Keep it on the target-scoped plane even when the foreground bridge is
  // healthy: a healthy bridge is transport admission, not a reason to queue
  // the worker behind selected()/focus/foreground execution.
  let targetScopedReadback = true;
  try {
    // The foreground Chrome Plugin call owns the browser-client context. Use
    // its direct bridge refresh first; an HTTP /health callback is detached
    // from that context and can only report cached transport state. Background
    // workers retain the loopback refresh path and queue for a later foreground
    // drain instead of attempting browser work from the worker.
    const directBridge = globalThis?.__socialFlowChromeExtensionBridge;
    if (globalThis?.nodeRepl && typeof directBridge?.refreshReadback === "function") {
      try {
        const fresh = await directBridge.refreshReadback();
        bridgeReadback = { path: String(directBridge?.readback_path || fresh?.path || ""), value: fresh };
      } catch (error) {
        const exactBlocker = String(error?.exact_blocker || error?.message || error);
        const currentReadback = directBridge?.readback;
        const targetScopedEligible = chromePluginTargetScopedReadbackEligible({
          ...(currentReadback || {}),
          exact_blocker: exactBlocker,
        });
        if (!targetScopedEligible) throw error;
        // The foreground readback is intentionally not repaired or retried.
        // The worker may continue only through the separate target-scoped
        // contract, which reads one exact descriptor from fresh openTabs().
        targetScopedReadback = true;
        bridgeReadback = { path: String(directBridge?.readback_path || ""), value: currentReadback };
      }
    } else {
      bridgeReadback = await refreshChromePluginBridgeReadback(environment, { targetScopedReadback: true });
      // Background workers receive the same fresh health readback over the
      // official loopback bridge. A selected-tab blocker is not a reason to
      // stop a read-only worker: the bridge handoff can use the separate
      // target-scoped contract, which performs fresh openTabs() and reads one
      // allowlisted descriptor without selected()/claimTab()/focus. Keep the
      // owner-lineage requirement so a stale or foreign bridge still fails
      // closed.
      // A valid fresh bridge readback admits the target-scoped read-only
      // operation regardless of whether selected-tab state is available.
      targetScopedReadback = true;
    }
  } catch (error) {
    throw new Error(`chrome_plugin_bridge_refresh_failed:${String(error?.message || error)}`);
  }
  const activeCallNonce = await issueChromePluginReadOnlyActiveCallNonce({ targetScopedReadback });
  const backgroundCapability = activeCallNonce
    ? null
    : readChromePluginBackgroundReadOnlyCapability(environment);
  if (!activeCallNonce && String(backgroundCapability?.bridge_instance_id || "") !== String(bridgeReadback.value.bridge_instance_id || "")) {
    throw new Error("chrome_plugin_background_read_only_capability_bridge_instance_mismatch");
  }
  const handoff = chromePluginReadOnlyRequest({
    input,
    runRoot,
    bundle,
    route,
    environment,
    bridgeReadback,
    activeCallNonce,
    backgroundCapabilityId: backgroundCapability?.capability_id || "",
    webOperationBackendSnapshot: backendBinding.snapshot,
    targetScopedReadback,
  });
  const response = await runChromePluginBridgeClient({
    payload: {
      ...handoff.request,
      requestSha256: handoff.requestSha256,
      schedulerRunDir: runRoot,
      runDir: runRoot,
      runId: input.run_id,
      bridgeRunId: `${input.run_id}:chrome-plugin-bridge`,
      receiptDir: path.join(runRoot, "chrome-plugin-foreground-handoff", "bridge-receipts"),
      artifactDir: path.join(runRoot, "candidate-supply"),
      sourceSnapshotId: bundle?.input.sourceSnapshotId || "",
      supplyRunId: bundle?.input.supplyRunId || "",
      bucket: bundle?.input.bucket || "",
      remaining: bundle?.input.remaining || 0,
      margin: bundle?.input.margin || 0,
      controlRunId: handoff.request.control_run_id,
      controlRequestId: handoff.request.control_request_id,
      requestPath: handoff.requestPath,
      receiptId: handoff.request.receipt_id,
      activeCallNonce,
      backgroundReadOnlyCapabilityToken: backgroundCapability?.token || "",
      backgroundReadOnlyCapabilityId: backgroundCapability?.capability_id || "",
      bridgeInstanceId: handoff.bridge.bridge_instance_id,
      browserBackend: "chrome_plugin",
      browserSurface: CHROME_PLUGIN_BROWSER_SURFACE,
      webOperationBackendSnapshot: backendBinding.snapshot,
      webOperationBackendSnapshotSha256: handoff.request.web_operation_backend_snapshot_sha256,
    },
    environment,
    bridgeReadback,
  });
  if (!response.result) {
    const bridgeFailure = String(response.error || response.stderr || "").trim();
    throw new Error(response.code === 2
      ? (bridgeFailure || "chrome_plugin_bridge_handoff_endpoint_unavailable")
      : (bridgeFailure || "chrome_plugin_bridge_handoff_client_failed"));
  }
  const result = response.result || {};
  const candidateCount = Number(result.candidate_count || result.adapter_result?.candidate_count || 0);
  const requestedCount = Number(result.requested_count || result.adapter_result?.requested_count || bundle?.input.remaining + bundle?.input.margin || 0);
  const cleanupVerified = result.cleanup_verified === true || result.tab_cleanup?.ok === true;
  const readbackVerified = bundle ? candidateCount > 0 || result.status === "ready" : result.readback_verified === true;
  const visualReadbackVerified = result.visual_readback_verified === true
    && Boolean(result.screenshot_path)
    && Boolean(result.screenshot_sha256);
  const ready = bundle
    ? result.status === "ready" && cleanupVerified && visualReadbackVerified && candidateCount >= requestedCount
    : result.status === "complete" && cleanupVerified && readbackVerified && visualReadbackVerified;
  const exactBlocker = result.exact_blocker
    ? String(result.exact_blocker)
    : ready
      ? null
      : bundle
        ? PORTABLE_EXTERNAL_READ_ONLY_BUSINESS_PROOF_PENDING
        : "chrome_plugin_read_only_cleanup_or_readback_unverified";
  const bridgeReceiptPath = String(
    result.bridge_receipt_path
      || result.receipt_path
      || response.result?.bridge_receipt_path
      || response.result?.receipt_path
      || response.result?.handoff_receipt_path
      || result.handoff_receipt_path
      || "",
  );
  return {
    status: ready ? "complete" : (bundle && String(exactBlocker).startsWith("candidate_supply_buffer_short:") ? "partial" : "blocked"),
    exact_blocker: exactBlocker,
    external_action_executed: false,
    browser_backend: "chrome_plugin",
    browser_surface: CHROME_PLUGIN_BROWSER_SURFACE,
    web_operation_backend_snapshot: backendBinding.snapshot,
    web_operation_backend_snapshot_sha256: handoff.request.web_operation_backend_snapshot_sha256,
    workflow_id: input.workflow_id,
    run_id: input.run_id,
    step_id: input.step_id,
    operation: bundle ? "candidate_supply" : "read",
    input_bundle_sha256: bundle?.sha256 || "",
    readback_verified: readbackVerified,
    visual_readback_required: true,
    visual_readback_verified: visualReadbackVerified,
    cleanup_verified: cleanupVerified,
    effects_mode: "read_only",
    read_only_stage_bound: true,
    same_run_receipt: ready,
    read_only_proof_verified: ready,
    external_executor_status: bundle ? "chrome_plugin_candidate_supply_completed" : "chrome_plugin_read_only_readback_completed",
    handoff_request_path: handoff.requestPath,
    handoff_request_sha256: handoff.requestSha256,
    bridge_instance_id: handoff.bridge.bridge_instance_id,
    // The Chrome Plugin bridge owns the terminal receipt and returns it as
    // handoff_receipt_path. Normalize that same-run path at the runner
    // boundary so the AOS receipt verifier does not mistake a completed
    // read-only handoff for missing provider evidence.
    bridge_receipt_path: bridgeReceiptPath,
    screenshot_path: String(result.screenshot_path || ""),
    tab_cleanup: result.tab_cleanup || null,
    adapter_result: {
      ...result,
      web_operation_backend_snapshot: backendBinding.snapshot,
      web_operation_backend_snapshot_sha256: handoff.request.web_operation_backend_snapshot_sha256,
      candidate_count: candidateCount,
      requested_count: requestedCount,
      cleanup_verified: cleanupVerified,
      readback_verified: readbackVerified,
      // Keep the receipt verifier's required same-run provider path inside
      // adapter_result as well as at the normalized runner boundary.
      bridge_receipt_path: bridgeReceiptPath,
      handoff_receipt_path: String(result.handoff_receipt_path || ""),
      cleanup_failed: result.tab_cleanup?.cleanup_failed === true,
    },
  };
}

async function runJobCandidateSupply(input, environment = process.env) {
  const paths = browserUsePaths(environment);
  const { runRoot } = safeRunRoot(input.run_id, environment);
  const bundle = readCandidateSupplyInput(input, runRoot, environment);
  if (!fs.existsSync(paths.candidateSupplyAdapter)) {
    throw new Error("portable_external_candidate_supply_adapter_missing");
  }
  // The candidate-supply adapter is allowed to provide provider semantics,
  // but it must inherit the already-admitted canonical helper/runtime lane.
  // The AOS owner-bound worker may intentionally bind the immutable package
  // helper while the installed entrypoint is in a different live generation;
  // that source helper is canonical too, not an arbitrary fallback.  Keep the
  // allowlist explicit so an untrusted child environment cannot select a
  // different executable.
  const helper = paths.helper;
  if (!fs.existsSync(helper) || !fs.statSync(helper).isFile()) {
    throw new Error("portable_external_browser_use_cli_noncanonical_helper");
  }
  const candidateSupplyModule = await import(pathToFileURL(paths.candidateSupplyAdapter).href);
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
    read_only_proof_verified: ready,
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
  const currentUid = currentRuntimeUid(stat);
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

function goalStageIdFor(input, route, environment = process.env) {
  const configured = String(environment.AUTOMATION_OS_BROWSER_GOAL_STAGE_ID || "").trim();
  return configured || `aos-${route.automation_id}-${input.workflow_id}-goal`;
}

function goalSessionFor(input, route) {
  return `aos-${sha256Bytes(`${input.run_id}:${route.automation_id}:${input.workflow_id}:goal`).slice(0, 20)}-goal`;
}

function goalTerminal(environment = process.env) {
  return !/^(?:0|false|no|off|hold|waiting)$/iu.test(String(environment.AUTOMATION_OS_BROWSER_GOAL_TERMINAL || "1"));
}

function goalKernelFor(input, environment = process.env) {
  return createBrowserUseGoalKernel({
    input: {
      workflow_id: input.workflow_id,
      run_id: input.run_id,
      step_id: input.step_id,
      source_trigger: input.source_trigger,
      idempotency_key: input.idempotency_key,
    },
    environment,
  });
}

function goalSpecFor(input, route, authority, environment = process.env) {
  return {
    automationId: route.automation_id,
    stageId: route.stage_id,
    session: goalSessionFor(input, route),
    mode: route.mode || "authorized",
    lifecycle: route.lifecycle || "scheduled",
    authorityPath: authority?.path || "",
    authoritySha256: authority?.sha256 || "",
    allowedOrigins: [...route.allowed_origins],
    port: route.port,
    approval: "approved",
    effectful: false,
    currentStage: input.step_id,
    externalActionExecuted: false,
    effectUnknown: false,
  };
}

async function runAdaptiveWebOperationReadback(input, baseRoute, intent, environment = process.env) {
  let route = adaptiveRouteForIntent(baseRoute, intent, input, environment);
  route = { ...route, stage_id: goalStageIdFor(input, route, environment) };
  if (route.public_lane) route.port = await adaptivePublicPort(input);
  const { runRoot } = safeRunRoot(input.run_id, environment);
  const authority = route.public_lane ? null : issueReadOnlyAuthority({ route, input, runRoot });
  const goalKernel = goalKernelFor(input, environment);
  const goalSpec = goalSpecFor(input, route, authority, environment);
  let adaptiveScreenshotPath = "";
  let flow = null;
  let adapter = null;
  let goalState = null;
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
    if (!fs.existsSync(browserUsePaths(environment).stageAdapter)) throw new Error("portable_external_browser_use_cli_stage_adapter_missing");
    const ensured = await ensureBrowserUseGoalFlow({ kernel: goalKernel, spec: goalSpec });
    adapter = ensured.adapter;
    flow = ensured.flow;
    goalState = ensured.state;
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
    checkpointBrowserUseGoal({
      kernel: goalKernel,
      status: "running",
      currentStage: input.step_id,
      lastReadback: {
        stage: input.step_id,
        origin: exactOrigin(observedUrl),
        observed_origin: exactOrigin(observedUrl),
        title_length: textLength(title),
        state_length: textLength(state),
        target_digest: targetCandidate?.match_text_sha256 || sha256Bytes(intent.target.semantic_query),
        source_state_digest: targetSourceStateDigest,
      },
      nextAction: goalTerminal(environment) ? "finalize_goal_flow_after_readback" : "reuse_goal_flow_for_next_stage",
      exactBlocker: null,
      restartPoint: "goal_flow_readback",
    });
  } catch (error) {
    primaryError = error;
    const recovery = await recoverBrowserUseGoalFlow({ kernel: goalKernel, spec: goalSpec, error });
    goalState = recovery.state || readBrowserUseGoalState({ kernel: goalKernel });
  }

  const loginRequired = /\b(sign in|log in|checkpoint|verify)\b|ログイン|サインイン|本人確認/iu.test(`${observedUrl} ${JSON.stringify(state)}`);
  if (flow && adapter && !primaryError && !loginRequired && goalTerminal(environment)) {
    try {
      goalState = await finalizeBrowserUseGoalFlow({ kernel: goalKernel, authorityPath: authority?.path || "" });
      finalized = {
        finalized: goalState?.status === "completed",
        cleanup_verified: goalState?.status === "completed",
        receipt_path: String(goalState?.receipt_path || ""),
        manifest_path: String(goalState?.manifest_path || ""),
      };
    } catch (error) {
      if (!primaryError) primaryError = error;
      const recovery = await recoverBrowserUseGoalFlow({ kernel: goalKernel, spec: goalSpec, error });
      goalState = recovery.state || readBrowserUseGoalState({ kernel: goalKernel });
    }
  } else if (flow && adapter && !primaryError && !goalTerminal(environment)) {
    finalized = { finalized: false, cleanup_verified: false };
    goalState = readBrowserUseGoalState({ kernel: goalKernel });
  }
  const cleanupVerified = finalized?.finalized === true;
  const exactBlocker = loginRequired
    ? `auth_blocked:${input.workflow_id}_login_required`
    : primaryError
      ? normalizedBlocker(primaryError)
      : !readbackVerified
        ? "portable_external_browser_use_cli_readback_invalid"
        : !targetReadbackVerified
          ? "portable_external_web_operation_target_readback_invalid"
          : !cleanupVerified && !goalTerminal(environment)
            ? "browser_use_goal_waiting_for_next_stage"
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
        flow_status: cleanupVerified ? "finalized" : goalState?.status || "held",
        cleanup_verified: cleanupVerified,
      },
      goal_kernel: {
        schema: "automation_os_browser_use_goal_kernel.v1",
        goal_id: goalKernel.goalId,
        status: goalState?.status || "blocked",
        state_path: goalKernel.paths.statePath,
        lease_path: goalKernel.paths.leasePath,
        current_stage: goalState?.current_stage || input.step_id,
        next_action: goalState?.next_action || "retry_goal_flow_from_durable_checkpoint",
        exact_blocker: goalState?.exact_blocker || null,
        restart_point: goalState?.restart_point || "goal_flow_ensure",
        runtime: goalKernel.runtime,
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

export async function runReadOnlyWorkflow(
  input,
  environment = process.env,
  {
    companionWorkflow = runAosChromeCompanionReadOnlyWorkflow,
    officialWorkflow = runChromePluginReadOnlyWorkflow,
  } = {},
) {
  const backendBlocker = readOnlyBackendBlocker(environment);
  if (backendBlocker) {
    return {
      status: "blocked",
      exact_blocker: backendBlocker,
      external_action_executed: false,
      browser_backend: selectedReadOnlyBackend(environment),
      browser_surface: selectedBrowserSurface(environment),
    };
  }
  const backendBinding = chromePluginBackendSnapshotFromEnvironment(environment);
  if (backendBinding.exact_blocker) {
    return {
      status: "blocked",
      exact_blocker: backendBinding.exact_blocker,
      external_action_executed: false,
      browser_backend: "chrome_plugin",
      browser_surface: CHROME_PLUGIN_BROWSER_SURFACE,
    };
  }
  if (selectedReadOnlyBackend(environment) === "aos_chrome_companion") {
    const companionResult = await companionWorkflow(input, environment);
    if (companionResult?.status === "complete") return companionResult;
    const handoff = evaluateSafeExtensionSurfaceHandoff({ sourceResult: companionResult, input });
    if (handoff.status !== "ready_for_official_visual_preflight") {
      return { ...companionResult, safe_surface_handoff: handoff };
    }
    const officialEnvironment = officialExtensionEnvironmentForHandoff(environment);
    const destinationResult = await officialWorkflow(input, officialEnvironment);
    const completedHandoff = completeSafeExtensionSurfaceHandoff(handoff, destinationResult);
    return {
      ...destinationResult,
      status: completedHandoff.status === "completed" ? "complete" : "blocked",
      exact_blocker: completedHandoff.exact_blocker,
      external_action_executed: false,
      safe_surface_handoff: completedHandoff,
      source_surface_receipt: companionResult,
      external_executor_status: completedHandoff.status === "completed"
        ? "companion_to_official_visual_handoff_completed"
        : "companion_to_official_visual_handoff_blocked",
    };
  }
  if (chromePluginSelected(environment)) {
    const route = routeForWorkflow(input.workflow_id);
    if (!route) {
      return {
        status: "blocked",
        exact_blocker: `${PORTABLE_EXTERNAL_READ_ONLY_ROUTE_NOT_CONFIGURED}:${input.workflow_id}`,
        external_action_executed: false,
        browser_backend: "chrome_plugin",
        browser_surface: CHROME_PLUGIN_BROWSER_SURFACE,
      };
    }
    if (input.workflow_id === "job-application-manager"
      && (input.step_id === JOB_CANDIDATE_SUPPLY_STEP
        || environment.AUTOMATION_OS_PORTABLE_EXTERNAL_READ_ONLY_STAGE === JOB_CANDIDATE_SUPPLY_STAGE)) {
      const { runRoot } = safeRunRoot(input.run_id, environment);
      const bundle = readCandidateSupplyInput(input, runRoot, environment);
      return runChromePluginReadOnlyWorkflow(input, environment, { bundle });
    }
    return runChromePluginReadOnlyWorkflow(input, environment);
  }
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
  const goalRoute = { ...route, stage_id: goalStageIdFor(input, route, environment) };
  const { runRoot } = safeRunRoot(input.run_id, environment);
  const authority = issueReadOnlyAuthority({ route: goalRoute, input, runRoot });
  const goalKernel = goalKernelFor(input, environment);
  const goalSpec = goalSpecFor(input, { ...goalRoute, mode: "authorized", lifecycle: "scheduled" }, authority, environment);
  let screenshotPath = "";
  let flow = null;
  let adapter;
  let goalState = null;
  try {
    if (!fs.existsSync(browserUsePaths(environment).stageAdapter)) throw new Error("portable_external_browser_use_cli_stage_adapter_missing");
    const ensured = await ensureBrowserUseGoalFlow({ kernel: goalKernel, spec: goalSpec });
    adapter = ensured.adapter;
    flow = ensured.flow;
    goalState = ensured.state;
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
    checkpointBrowserUseGoal({
      kernel: goalKernel,
      status: loginRequired ? "blocked" : "running",
      currentStage: input.step_id,
      lastReadback: {
        stage: input.step_id,
        origin: exactOrigin(observedUrl),
        observed_origin: exactOrigin(observedUrl),
        title_length: textLength(title),
        state_length: textLength(state),
      },
      nextAction: loginRequired
        ? "await_human_authentication_without_entering_credentials"
        : goalTerminal(environment) ? "finalize_goal_flow_after_readback" : "reuse_goal_flow_for_next_stage",
      exactBlocker: loginRequired ? `auth_blocked:${input.workflow_id}_login_required` : null,
      restartPoint: "goal_flow_readback",
    });
    const finalized = loginRequired || !goalTerminal(environment)
      ? { finalized: false, cleanup_verified: false }
      : (() => {
        // Finalization is a Goal boundary operation. A stage that is held for
        // a later step retains the same lease/profile/port and does not close
        // the Browser Use session here.
        return null;
      })();
    if (!finalized && !loginRequired && goalTerminal(environment)) {
      goalState = await finalizeBrowserUseGoalFlow({ kernel: goalKernel, authorityPath: authority.path });
    }
    const finalizedResult = finalized || {
      finalized: goalState?.status === "completed",
      cleanup_verified: goalState?.status === "completed",
      receipt_path: String(goalState?.receipt_path || ""),
      manifest_path: String(goalState?.manifest_path || ""),
    };
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
      flow_status: finalizedResult?.finalized === true ? "finalized" : goalState?.status || "held",
      cleanup_verified: finalizedResult?.finalized === true,
    };
    flow = null;
    const referenceReadback = environment.AUTOMATION_OS_PORTABLE_EXTERNAL_READ_ONLY_STAGE === REFERENCE_READBACK_STAGE;
    const exactBlocker = loginRequired
      ? `auth_blocked:${input.workflow_id}_login_required`
      : !readbackVerified
        ? "portable_external_browser_use_cli_readback_invalid"
      : finalizedResult?.finalized !== true && goalTerminal(environment)
          ? "portable_external_browser_use_cli_cleanup_unverified"
          : !goalTerminal(environment)
            ? "browser_use_goal_waiting_for_next_stage"
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
      receipt_path: String(finalizedResult?.receipt_path || ""),
      manifest_path: String(finalizedResult?.manifest_path || ""),
      cleanup_verified: finalizedResult?.finalized === true,
      readback_verified: readbackVerified,
      effects_mode: "read_only",
      read_only_stage_bound: [JOB_CANDIDATE_SUPPLY_STAGE, REFERENCE_READBACK_STAGE].includes(environment.AUTOMATION_OS_PORTABLE_EXTERNAL_READ_ONLY_STAGE),
      same_run_receipt: exactBlocker === null,
      external_executor_status: referenceReadback ? "reference_readback_completed" : "authorized_business_runner_pending",
      business_runner_entrypoint: PORTABLE_EXTERNAL_AUTHORIZED_BUSINESS_RUNNER,
      adapter_result: {
        browser_runtime_readback: browserRuntimeReadback,
        reference_readback: referenceReadback,
        goal_kernel: {
          schema: "automation_os_browser_use_goal_kernel.v1",
          goal_id: goalKernel.goalId,
          status: goalState?.status || "blocked",
          state_path: goalKernel.paths.statePath,
          lease_path: goalKernel.paths.leasePath,
          current_stage: goalState?.current_stage || input.step_id,
          next_action: goalState?.next_action || "retry_goal_flow_from_durable_checkpoint",
          exact_blocker: goalState?.exact_blocker || null,
          restart_point: goalState?.restart_point || "goal_flow_ensure",
          runtime: goalKernel.runtime,
        },
      },
    };
  } catch (error) {
    const recovery = await recoverBrowserUseGoalFlow({ kernel: goalKernel, spec: goalSpec, error });
    goalState = recovery.state || readBrowserUseGoalState({ kernel: goalKernel });
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
      adapter_result: {
        goal_kernel: {
          schema: "automation_os_browser_use_goal_kernel.v1",
          goal_id: goalKernel.goalId,
          status: goalState?.status || "waiting",
          state_path: goalKernel.paths.statePath,
          lease_path: goalKernel.paths.leasePath,
          current_stage: goalState?.current_stage || input.step_id,
          next_action: goalState?.next_action || "retry_goal_flow_from_durable_checkpoint",
          exact_blocker: goalState?.exact_blocker || normalizedBlocker(error),
          restart_point: goalState?.restart_point || "goal_flow_resume",
          runtime: goalKernel.runtime,
        },
      },
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
    browser_surface: value.browser_surface || selectedBrowserSurface(),
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
    visual_readback_required: value.visual_readback_required === true,
    visual_readback_verified: value.visual_readback_verified === true,
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
    ...(value.safe_surface_handoff ? { safe_surface_handoff: value.safe_surface_handoff } : {}),
    ...(value.source_surface_receipt ? { source_surface_receipt: value.source_surface_receipt } : {}),
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
      if (chromePluginSelected(environment)) {
        const blocked = {
          status: "blocked",
          exact_blocker: "chrome_plugin_effect_requires_workflow_owned_runner",
          external_action_executed: false,
          browser_backend: "chrome_plugin",
          browser_surface: CHROME_PLUGIN_BROWSER_SURFACE,
        };
        process.stdout.write(`${safeReceipt(blocked)}\n`);
        return 1;
      }
      const intentFile = readAdaptiveWebOperationIntent(input, environment);
      if (intentFile?.intent?.operation && intentFile.intent.operation !== "read") {
        const admission = readAdmission(input, environment);
        const route = adaptiveRouteForIntent(routeForWorkflow(input.workflow_id), intentFile.intent, input, environment);
        if (route.public_lane === true) throw new Error("portable_external_web_operation_effect_public_forbidden");
        const result = selectedReadOnlyBackend(environment) === "aos_chrome_companion"
          ? await runAosChromeCompanionWebOperationEffect({ ...input, admission }, route, intentFile.intent, environment)
          : await runAdaptiveWebOperationEffect({ ...input, admission }, route, intentFile.intent, environment);
        process.stdout.write(`${safeReceipt(result)}\n`);
        return result.status === "complete" && !result.exact_blocker ? 0 : 1;
      }
      const approval = String(environment.AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL || "").trim();
      const blocked = {
        status: "blocked",
        exact_blocker: approval === "approved" ? PORTABLE_EXTERNAL_ACTION_PLAN_REQUIRED : "portable_external_approval_required",
        external_action_executed: false,
        browser_surface: selectedBrowserSurface(environment),
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
      browser_surface: selectedBrowserSurface(environment),
      workflow_id: input?.workflow_id || "",
      run_id: input?.run_id || "",
      step_id: input?.step_id || "",
    };
    process.stdout.write(`${safeReceipt(blocked)}\n`);
    return 1;
  }
}

if (typeof process !== "undefined" && process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => { process.exitCode = code; });
}

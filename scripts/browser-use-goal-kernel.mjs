#!/usr/bin/env node

/*
 * Goal-owned Browser Use CLI lifecycle.
 *
 * This module is intentionally the only lifecycle wrapper used by portable
 * AOS workers.  The actual browser process remains owned by the canonical
 * stage adapter; this module owns the durable Goal lease, checkpoint, resume,
 * recovery budget, and terminal cleanup boundary.
 */

import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export const BROWSER_USE_GOAL_KERNEL_SCHEMA = "automation_os_browser_use_goal_kernel.v1";
export const BROWSER_USE_GOAL_LEASE_SCHEMA = "browser-use-flow-lease.v2";
const DEFAULT_BROWSER_USE_HOME = path.join(homedir(), ".browser-use-cli");
const DEFAULT_CODEX_HOME = path.join(homedir(), ".codex");
export const CANONICAL_BROWSER_USE_HELPER = process.env.BROWSER_USE_CLI_HELPER || path.join(homedir(), ".local", "bin", "codex-browser-use");
export const CANONICAL_BROWSER_USE_RUNTIME = process.env.BROWSER_USE_RUNTIME_CONFIG || path.join(DEFAULT_BROWSER_USE_HOME, "browser-use-runtime.toml");
export const CANONICAL_BROWSER_USE_ADAPTER = process.env.AUTOMATION_OS_BROWSER_USE_CLI_STAGE_ADAPTER || path.join(DEFAULT_CODEX_HOME, "skills", "automation-kernel-run", "scripts", "browser-use-cli-stage-adapter.mjs");
export const CANONICAL_BROWSER_USE_HOME = process.env.BROWSER_USE_HOME || DEFAULT_BROWSER_USE_HOME;

const IDENTIFIER = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,179}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const GOAL_STATUSES = new Set(["running", "recovering", "waiting", "blocked", "completed"]);
const TRANSIENT_RECOVERY_RE = /(timeout|timed[_ -]?out|network|connection|disconnected|stale|selector|modal|browser[_ -]?restart|process[_ -]?missing|recording[_ -]?continued|navigation)/iu;
const HUMAN_GATE_RE = /(captcha|otp|one[- ]time|security[- ]code|identity verification|本人確認|秘密|password|パスワード|認証コード)/iu;
const AMBIGUOUS_EFFECT_RE = /(effect[_ -]?unknown|external[_ -]?effect.*unknown|receipt.*missing|source.*sync.*missing|reconciliation.*required|二重実行|曖昧)/iu;

function fail(code) {
  throw new Error(code);
}

function safeIdentifier(value, code) {
  if (!IDENTIFIER.test(String(value || ""))) fail(code);
  return String(value);
}

function digest(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function fileDigest(filePath) {
  return digest(fs.readFileSync(filePath));
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function assertOwnedPrivateFile(filePath, code = "browser_use_goal_state_invalid") {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) fail(code);
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) fail(code);
}

function assertOwnedPrivateDirectory(dirPath, code = "browser_use_goal_state_directory_invalid") {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dirPath);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700) fail(code);
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) fail(code);
}

function pathInside(basePath, candidate, code) {
  const base = path.resolve(basePath);
  const resolved = path.resolve(candidate);
  const relative = path.relative(base, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail(code);
  return resolved;
}

function writePrivateJsonReplace(filePath, value) {
  const resolved = path.resolve(filePath);
  assertOwnedPrivateDirectory(path.dirname(resolved));
  const temporary = path.join(path.dirname(resolved), `.goal-kernel-${randomUUID()}.tmp`);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  try {
    fs.writeFileSync(temporary, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, resolved);
    fs.chmodSync(resolved, 0o600);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* preserve the primary error */ }
  }
  return { path: resolved, sha256: digest(bytes) };
}

function readJson(filePath, code) {
  assertOwnedPrivateFile(filePath, code);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    fail(code);
  }
}

function sanitizedReadback(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = {};
  for (const key of ["stage", "origin", "observed_origin", "title_length", "state_length", "target_digest", "source_state_digest", "payload_hash", "account_ref", "audience", "provider_receipt_digest", "source_sync_digest", "reconciliation_digest"]) {
    if (source[key] === undefined || source[key] === null) continue;
    const current = source[key];
    if (typeof current === "string") result[key] = current.slice(0, 512);
    else if (typeof current === "number" && Number.isFinite(current)) result[key] = current;
  }
  return result;
}

function browserUsePaths(environment = process.env) {
  const runtime = String(environment.BROWSER_USE_RUNTIME_CONFIG || environment.AUTOMATION_OS_BROWSER_USE_CLI_RUNTIME_CONFIG || CANONICAL_BROWSER_USE_RUNTIME).trim();
  const home = String(environment.BROWSER_USE_HOME || environment.AUTOMATION_OS_BROWSER_USE_HOME || path.dirname(runtime)).trim();
  return {
    helper: String(environment.BROWSER_USE_CLI_HELPER || environment.AUTOMATION_OS_BROWSER_USE_CLI_HELPER || CANONICAL_BROWSER_USE_HELPER).trim(),
    runtime,
    adapter: String(environment.AUTOMATION_OS_BROWSER_USE_CLI_STAGE_ADAPTER || CANONICAL_BROWSER_USE_ADAPTER).trim(),
    home,
  };
}

function runtimeFingerprint(environment = process.env) {
  const paths = browserUsePaths(environment);
  const files = {
    helper: paths.helper,
    runtime: paths.runtime,
    adapter: paths.adapter,
  };
  const hashes = {};
  for (const [name, filePath] of Object.entries(files)) {
    let stat;
    try {
      stat = fs.lstatSync(filePath);
    } catch {
      fail(`browser_use_goal_canonical_${name}_missing`);
    }
    if (stat.isSymbolicLink() || !stat.isFile()) fail(`browser_use_goal_canonical_${name}_invalid`);
    hashes[name] = fileDigest(filePath);
  }
  return Object.freeze({
    helper_path: paths.helper,
    runtime_config_path: paths.runtime,
    adapter_path: paths.adapter,
    browser_use_home: paths.home,
    helper_sha256: hashes.helper,
    runtime_config_sha256: hashes.runtime,
    adapter_sha256: hashes.adapter,
  });
}

export function canonicalBrowserUseRuntimeFingerprint() {
  return runtimeFingerprint();
}

function statePathFor(input, environment) {
  const artifactRootCandidate = path.resolve(String(environment.AUTOMATION_OS_ARTIFACT_ROOT || path.join(process.cwd(), "data", "artifacts")));
  assertOwnedPrivateDirectory(artifactRootCandidate);
  // The canonical adapter rejects symlinked lease parents. macOS commonly
  // exposes os.tmpdir() through /var -> /private/var, so bind every Goal
  // artifact to its real path before deriving the lease and state files.
  const artifactRoot = fs.realpathSync(artifactRootCandidate);
  safeIdentifier(input.run_id, "browser_use_goal_run_id_invalid");
  const runRoot = pathInside(artifactRoot, path.join(artifactRoot, input.run_id), "browser_use_goal_run_root_invalid");
  assertOwnedPrivateDirectory(runRoot);
  const configured = String(environment.AUTOMATION_OS_BROWSER_GOAL_STATE_PATH || "").trim();
  const statePath = configured ? pathInside(runRoot, configured, "browser_use_goal_state_path_invalid") : path.join(runRoot, "browser-use-goal-kernel.v1.json");
  const leasePath = path.join(runRoot, "browser-use-goal-flow-lease.v2.json");
  return { artifactRoot, runRoot, statePath, leasePath };
}

function initialState(kernel, spec) {
  const attempt = 1;
  const attemptId = `goal-${digest(`${kernel.input.run_id}:${kernel.input.idempotency_key || ""}`).slice(0, 24)}-attempt-${attempt}`;
  return {
    schema: BROWSER_USE_GOAL_KERNEL_SCHEMA,
    status: "running",
    lifecycle_event: "starting",
    goal_id: kernel.goalId,
    workflow_id: kernel.input.workflow_id,
    run_id: kernel.input.run_id,
    step_id: kernel.input.step_id,
    source_trigger: kernel.input.source_trigger,
    idempotency_key: kernel.input.idempotency_key,
    automation_id: spec.automationId,
    goal_stage_id: spec.stageId,
    attempt,
    attempt_id: attemptId,
    recovery_budget: kernel.recoveryBudget,
    recovery_attempts: 0,
    external_action_executed: false,
    effect_unknown: false,
    current_stage: spec.currentStage || spec.stageId,
    last_readback: {},
    next_action: "reuse_goal_flow_for_next_stage",
    exact_blocker: null,
    restart_point: "goal_flow_ensure",
    runtime: kernel.runtime,
    lease_path: kernel.paths.leasePath,
    updated_at: new Date().toISOString(),
  };
}

function normalizeState(kernel, state) {
  if (!state || typeof state !== "object" || Array.isArray(state) || state.schema !== BROWSER_USE_GOAL_KERNEL_SCHEMA) fail("browser_use_goal_state_schema_invalid");
  safeIdentifier(state.goal_id, "browser_use_goal_state_goal_id_invalid");
  safeIdentifier(state.run_id, "browser_use_goal_state_run_id_invalid");
  if (state.goal_id !== kernel.goalId || state.run_id !== kernel.input.run_id) fail("browser_use_goal_state_binding_invalid");
  if (!GOAL_STATUSES.has(state.status)) fail("browser_use_goal_state_status_invalid");
  return state;
}

function writeState(kernel, state) {
  const value = normalizeState(kernel, {
    ...state,
    last_readback: sanitizedReadback(state.last_readback),
    next_action: String(state.next_action || "").trim().slice(0, 512),
    exact_blocker: state.exact_blocker ? String(state.exact_blocker).slice(0, 512) : null,
    restart_point: String(state.restart_point || "goal_flow_ensure").slice(0, 512),
    updated_at: new Date().toISOString(),
  });
  if (!value.next_action) fail("browser_use_goal_next_action_missing");
  return writePrivateJsonReplace(kernel.paths.statePath, value);
}

function readState(kernel) {
  if (!fs.existsSync(kernel.paths.statePath)) return null;
  return normalizeState(kernel, readJson(kernel.paths.statePath, "browser_use_goal_state_invalid"));
}

function leaseHeld(kernel) {
  if (!fs.existsSync(kernel.paths.leasePath)) return false;
  try {
    const lease = readJson(kernel.paths.leasePath, "browser_use_goal_lease_invalid");
    return lease?.schema === BROWSER_USE_GOAL_LEASE_SCHEMA && lease?.status === "held";
  } catch (error) {
    if (String(error?.message || "").includes("ENOENT")) return false;
    throw error;
  }
}

async function loadAdapter(kernel) {
  if (kernel.adapter) return kernel.adapter;
  kernel.adapter = await import(pathToFileURL(kernel.runtime.adapter_path).href);
  return kernel.adapter;
}

export function createBrowserUseGoalKernel({ input, environment = process.env, adapter = null, recoveryBudget = 2 } = {}) {
  if (!input || typeof input !== "object") fail("browser_use_goal_input_missing");
  for (const field of ["workflow_id", "run_id", "step_id", "source_trigger", "idempotency_key"]) safeIdentifier(input[field], `browser_use_goal_${field}_invalid`);
  const paths = statePathFor(input, environment);
  const goalId = safeIdentifier(String(environment.AUTOMATION_OS_BROWSER_GOAL_ID || `aos-goal-${input.run_id}`), "browser_use_goal_id_invalid");
  const budget = Number(environment.AUTOMATION_OS_BROWSER_GOAL_RECOVERY_BUDGET || recoveryBudget);
  return {
    input: { ...input },
    environment,
    paths,
    goalId,
    recoveryBudget: Number.isSafeInteger(budget) && budget >= 0 && budget <= 5 ? budget : recoveryBudget,
    runtime: runtimeFingerprint(environment),
    adapter,
  };
}

function assertSpec(kernel, spec) {
  for (const field of ["automationId", "stageId", "session"]) safeIdentifier(spec[field], `browser_use_goal_${field}_invalid`);
  if (!["authorized", "public"].includes(spec.mode)) fail("browser_use_goal_mode_invalid");
  if (!["scheduled", "single-use"].includes(spec.lifecycle)) fail("browser_use_goal_lifecycle_invalid");
  if (spec.mode === "authorized" && spec.lifecycle !== "scheduled") fail("browser_use_goal_authorized_lifecycle_invalid");
  if (spec.mode === "public" && spec.lifecycle !== "single-use") fail("browser_use_goal_public_lifecycle_invalid");
  if (!Array.isArray(spec.allowedOrigins) || spec.allowedOrigins.length === 0) fail("browser_use_goal_origins_missing");
  if (spec.mode === "authorized" && !String(spec.authorityPath || "")) fail("browser_use_goal_authority_missing");
  if (spec.effectful === true && spec.mode !== "authorized") fail("browser_use_goal_effect_authority_required");
  if (spec.effectful === true && spec.approval !== "approved") fail("browser_use_goal_effect_approval_required");
  if (spec.externalActionExecuted === true || spec.effectUnknown === true) fail("browser_use_goal_effect_replay_forbidden");
  if (String(spec.session).includes("cookie") || String(spec.session).includes("token")) fail("browser_use_goal_secret_like_session_rejected");
  return spec;
}

export async function ensureBrowserUseGoalFlow({ kernel, spec } = {}) {
  assertSpec(kernel, spec);
  const state = readState(kernel) || initialState(kernel, spec);
  if (state.status === "completed") fail("browser_use_goal_already_completed");
  const adapter = await loadAdapter(kernel);
  if (leaseHeld(kernel)) {
    const flow = await Promise.resolve(adapter.resumeBrowserUseCliFlowFromLease({ leasePath: kernel.paths.leasePath }));
    if (String(flow.run_id) !== kernel.input.run_id || String(flow.automation_id) !== spec.automationId || String(flow.lifecycle) !== spec.lifecycle) {
      fail("browser_use_goal_lease_binding_mismatch");
    }
    if (String(flow.contract?.step_id || flow.contract?.stage_id || "") !== spec.stageId) fail("browser_use_goal_stage_binding_mismatch");
    writeState(kernel, {
      ...state,
      status: "running",
      lifecycle_event: "resumed",
      current_stage: spec.currentStage || state.current_stage || spec.stageId,
      exact_blocker: null,
      next_action: "reuse_goal_flow_for_next_stage",
      restart_point: "goal_flow_resumed",
      runtime: kernel.runtime,
    });
    return { kernel, adapter, flow, reused: true, resumed: true, state: readState(kernel) };
  }
  const attempt = Number(state.attempt || 1);
  if (state.effect_unknown === true || state.external_action_executed === true) fail("browser_use_goal_effect_replay_forbidden");
  const contract = {
    workflowId: kernel.input.workflow_id,
    workflowVersion: "1",
    attemptId: String(state.attempt_id || `goal-${digest(kernel.goalId).slice(0, 24)}-attempt-${attempt}`),
    flowId: `goal-${digest(`${kernel.goalId}:${attempt}`).slice(0, 24)}-flow`,
    leaseId: `goal-${digest(`${kernel.goalId}:${attempt}`).slice(0, 24)}-lease`,
    ...(spec.authoritySha256 ? { authoritySha256: spec.authoritySha256 } : {}),
    notBefore: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
  };
  let flow;
  try {
    flow = await adapter.startBrowserUseCliFlow({
      automationId: spec.automationId,
      runId: kernel.input.run_id,
      stageId: spec.stageId,
      session: spec.session,
      mode: spec.mode,
      lifecycle: spec.lifecycle,
      authorityPath: spec.authorityPath || "",
      allowedOrigins: spec.allowedOrigins,
      port: spec.port ?? null,
      contract,
    });
    const lease = await Promise.resolve(adapter.writeBrowserUseCliFlowLease({
      flow,
      leasePath: kernel.paths.leasePath,
      authorityPath: spec.authorityPath || "",
      scope: "goal",
    }));
    writeState(kernel, {
      ...state,
      status: "running",
      lifecycle_event: "started",
      attempt,
      current_stage: spec.currentStage || spec.stageId,
      requested_session: String(flow.contract?.requested_session || flow.session || spec.session),
      effective_session: String(flow.contract?.effective_session || flow.session || spec.session),
      profile_root: String(flow.profile || ""),
      reserved_port: Number(flow.port || spec.port || 0),
      flow_id: String(flow.flow_id || flow.contract?.flow_id || ""),
      lease_id: String(lease.lease_id || flow.lease_id || ""),
      exact_blocker: null,
      next_action: "reuse_goal_flow_for_next_stage",
      restart_point: "goal_flow_started",
      runtime: kernel.runtime,
    });
    return { kernel, adapter, flow: { ...flow, lease_path: kernel.paths.leasePath }, reused: false, resumed: false, state: readState(kernel) };
  } catch (error) {
    const blocker = normalizeGoalBlocker(error);
    writeState(kernel, {
      ...state,
      status: isHardStopGoalBlocker(blocker) ? "blocked" : "waiting",
      lifecycle_event: "ensure_failed",
      exact_blocker: blocker,
      next_action: isHardStopGoalBlocker(blocker) ? "await_human_input_or_explicit_scope" : "retry_goal_flow_from_durable_checkpoint",
      restart_point: "goal_flow_ensure",
      runtime: kernel.runtime,
    });
    throw error;
  }
}

export function checkpointBrowserUseGoal({ kernel, status = "running", currentStage, lastReadback = {}, nextAction, exactBlocker = null, restartPoint = "goal_flow_checkpoint", externalActionExecuted = false, effectUnknown = false, recoveryAttempts = null } = {}) {
  if (!GOAL_STATUSES.has(status)) fail("browser_use_goal_checkpoint_status_invalid");
  if (!String(nextAction || "").trim()) fail("browser_use_goal_next_action_missing");
  const previous = readState(kernel) || {};
  const nextState = {
    ...previous,
    status,
    lifecycle_event: "checkpoint",
    current_stage: String(currentStage || previous.current_stage || "goal").slice(0, 256),
    last_readback: sanitizedReadback(lastReadback),
    next_action: String(nextAction).slice(0, 512),
    exact_blocker: exactBlocker ? String(exactBlocker).slice(0, 512) : null,
    restart_point: String(restartPoint).slice(0, 512),
    external_action_executed: externalActionExecuted,
    effect_unknown: effectUnknown,
    ...(recoveryAttempts === null ? {} : { recovery_attempts: recoveryAttempts }),
  };
  writeState(kernel, nextState);
  return readState(kernel);
}

export function normalizeGoalBlocker(error) {
  const message = String(error?.exactBlocker || error?.message || error || "browser_use_goal_unknown_error").trim();
  return message.replace(/\s+/gu, "_").slice(0, 512) || "browser_use_goal_unknown_error";
}

export function isHardStopGoalBlocker(value) {
  const blocker = String(value || "");
  return HUMAN_GATE_RE.test(blocker) || AMBIGUOUS_EFFECT_RE.test(blocker) || /(foreign|owner|profile|port|permission).*required/iu.test(blocker);
}

export async function recoverBrowserUseGoalFlow({ kernel, spec, error, externalActionExecuted = false, effectUnknown = false } = {}) {
  const previous = readState(kernel) || initialState(kernel, spec);
  const blocker = normalizeGoalBlocker(error);
  if (externalActionExecuted || effectUnknown || previous.external_action_executed === true || previous.effect_unknown === true || isHardStopGoalBlocker(blocker)) {
    const state = checkpointBrowserUseGoal({
      kernel,
      status: "blocked",
      currentStage: spec.currentStage || spec.stageId,
      lastReadback: previous.last_readback,
      nextAction: effectUnknown || previous.effect_unknown ? "wait_for_provider_source_readback_without_replay" : "await_human_input_or_explicit_scope",
      exactBlocker: effectUnknown || previous.effect_unknown ? "browser_use_goal_effect_readback_required_no_replay" : blocker,
      restartPoint: "goal_checkpoint_before_recovery",
      externalActionExecuted: externalActionExecuted || previous.external_action_executed === true,
      effectUnknown: effectUnknown || previous.effect_unknown === true,
    });
    return { recovered: false, terminal: true, state, exactBlocker: state.sha256 ? null : blocker };
  }
  const attempts = Number(previous.recovery_attempts || 0) + 1;
  if (attempts > kernel.recoveryBudget) {
    const state = checkpointBrowserUseGoal({
      kernel,
      status: "waiting",
      currentStage: spec.currentStage || spec.stageId,
      lastReadback: previous.last_readback,
      nextAction: "retry_goal_flow_from_durable_checkpoint",
      exactBlocker: `browser_use_goal_recovery_budget_exhausted:${blocker}`,
      restartPoint: "goal_checkpoint_before_recovery",
      externalActionExecuted: false,
      effectUnknown: false,
    });
    return { recovered: false, terminal: false, state, exactBlocker: blocker };
  }
  checkpointBrowserUseGoal({
    kernel,
    status: "recovering",
    currentStage: spec.currentStage || spec.stageId,
    lastReadback: previous.last_readback,
    nextAction: "resume_same_goal_lease",
    exactBlocker: blocker,
    restartPoint: "goal_flow_resume",
    externalActionExecuted: false,
    effectUnknown: false,
    recoveryAttempts: attempts,
  });
  try {
    const result = await ensureBrowserUseGoalFlow({ kernel, spec });
    const state = checkpointBrowserUseGoal({
      kernel,
      status: "running",
      currentStage: spec.currentStage || spec.stageId,
      lastReadback: previous.last_readback,
      nextAction: "retry_current_read_only_action_once",
      exactBlocker: null,
      restartPoint: "goal_flow_resumed",
      externalActionExecuted: false,
      effectUnknown: false,
      recoveryAttempts: attempts,
    });
    return { ...result, recovered: true, terminal: false, state, recovery_attempts: attempts };
  } catch (resumeError) {
    const state = checkpointBrowserUseGoal({
      kernel,
      status: "waiting",
      currentStage: spec.currentStage || spec.stageId,
      lastReadback: previous.last_readback,
      nextAction: "retry_goal_flow_from_durable_checkpoint",
      exactBlocker: `${blocker}:${normalizeGoalBlocker(resumeError)}`,
      restartPoint: "goal_flow_resume",
      externalActionExecuted: false,
      effectUnknown: false,
      recoveryAttempts: attempts,
    });
    return { recovered: false, terminal: false, state, exactBlocker: blocker };
  }
}

export async function finalizeBrowserUseGoalFlow({ kernel, authorityPath = "", externalActionExecuted = false, effectUnknown = false, providerReceipt = null, sourceSync = null, reconciliation = null } = {}) {
  const state = readState(kernel) || fail("browser_use_goal_state_missing");
  if (effectUnknown || state.effect_unknown === true) {
    let cleanup = {};
    if (fs.existsSync(kernel.paths.leasePath)) {
      try {
        const adapter = await loadAdapter(kernel);
        cleanup = await adapter.finalizeBrowserUseCliFlowLease({ leasePath: kernel.paths.leasePath, authorityPath });
      } catch {
        cleanup = { finalized: false, cleanup_verified: false };
      }
    }
    const blocked = checkpointBrowserUseGoal({
      kernel,
      status: "blocked",
      currentStage: state.current_stage,
      lastReadback: state.last_readback,
      nextAction: "wait_for_provider_source_readback_without_replay",
      exactBlocker: "browser_use_goal_effect_readback_required_no_replay",
      restartPoint: "goal_effect_reconciliation",
      externalActionExecuted: externalActionExecuted || state.external_action_executed === true,
      effectUnknown: true,
    });
    return {
      ...blocked,
      ...cleanup,
      finalized: cleanup.finalized === true,
      cleanup_verified: cleanup.cleanup_verified === true,
    };
  }
  if (!fs.existsSync(kernel.paths.leasePath)) fail("browser_use_goal_lease_missing_for_finalize");
  const adapter = await loadAdapter(kernel);
  const finalized = await adapter.finalizeBrowserUseCliFlowLease({ leasePath: kernel.paths.leasePath, authorityPath });
  if (finalized?.finalized !== true || finalized?.cleanup_verified !== true) {
    return checkpointBrowserUseGoal({
      kernel,
      status: "waiting",
      currentStage: state.current_stage,
      lastReadback: state.last_readback,
      nextAction: "retry_goal_cleanup_from_durable_checkpoint",
      exactBlocker: "browser_use_goal_cleanup_unverified",
      restartPoint: "goal_flow_finalize",
      externalActionExecuted,
      effectUnknown: false,
    });
  }
  const completed = checkpointBrowserUseGoal({
    kernel,
    status: "completed",
    currentStage: state.current_stage,
    lastReadback: {
      ...state.last_readback,
      provider_receipt_digest: providerReceipt ? digest(JSON.stringify(providerReceipt)) : state.last_readback?.provider_receipt_digest,
      source_sync_digest: sourceSync ? digest(JSON.stringify(sourceSync)) : state.last_readback?.source_sync_digest,
      reconciliation_digest: reconciliation ? digest(JSON.stringify(reconciliation)) : state.last_readback?.reconciliation_digest,
    },
    nextAction: "goal_completed_no_replay",
    exactBlocker: null,
    restartPoint: "goal_flow_finalized",
    externalActionExecuted,
    effectUnknown: false,
  });
  return {
    ...completed,
    receipt_path: String(finalized.receipt_path || ""),
    manifest_path: String(finalized.manifest_path || ""),
    cleanup_verified: finalized.cleanup_verified === true,
    finalized: finalized.finalized === true,
  };
}

export function readBrowserUseGoalState({ kernel } = {}) {
  return readState(kernel);
}

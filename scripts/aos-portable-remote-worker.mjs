#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { constants, existsSync, mkdirSync, openSync, readFileSync, lstatSync, chmodSync, writeFileSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { businessRunnerBindingEnvironment as resolveBusinessRunnerBindingEnvironment } from "./aos-portable-business-runner.mjs";

const ROOT = path.resolve(process.env.AUTOMATION_OS_REPO_ROOT || path.join(import.meta.dirname, ".."));
const REMOTE_URL = String(process.env.AUTOMATION_OS_PORTABLE_REMOTE_URL || "https://automation-os.zeabur.app").replace(/\/+$/u, "");
const COMPANY_ID = String(process.env.AUTOMATION_OS_PORTABLE_REMOTE_COMPANY_ID || "company_2560580981cedfd106b66245").trim();
const TOKEN_SERVICE = String(process.env.AUTOMATION_OS_PORTABLE_REMOTE_TOKEN_SERVICE || "Automation OS Zeabur Trigger");
const WORKER_ID = String(process.env.AUTOMATION_OS_PORTABLE_REMOTE_WORKER_ID || `mac-${hostname()}`).replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 120);
const ARTIFACT_ROOT = path.resolve(process.env.AUTOMATION_OS_PORTABLE_REMOTE_ARTIFACT_ROOT || path.join(ROOT, "data", "artifacts", "portable-remote-worker"));
const WORKER_STATUS_PATH = path.join(ARTIFACT_ROOT, "worker-status.v1.json");
const READ_ONLY_RUNNER = path.join(ROOT, "scripts", "aos-portable-browser-use-runner.mjs");
const BUSINESS_RUNNER = path.join(ROOT, "scripts", "aos-portable-business-runner.mjs");
const POLL_MS = Math.max(5_000, Math.min(10 * 60_000, Number(process.env.AUTOMATION_OS_PORTABLE_REMOTE_POLL_MS || 30_000)));
const LOG_IDLE = String(process.env.AUTOMATION_OS_PORTABLE_REMOTE_LOG_IDLE || "0") === "1";
const DEFAULT_REMOTE_HTTP_TIMEOUT_MS = 15_000;
const PORTABLE_LOCAL_WORKFLOW_IDS = new Set([
  "email-review-reply",
  "daily-backup-safety-check",
  "obsidian-project-memory-audit",
]);
let heartbeatInFlight = null;

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

export function shouldEmitPortableRemoteResult(value, { force = false, logIdle = LOG_IDLE } = {}) {
  return force || logIdle || value?.status !== "idle";
}

function emitResult(value, { force = false } = {}) {
  if (!shouldEmitPortableRemoteResult(value, { force })) return;
  console.log(JSON.stringify(value));
}

function readToken() {
  if (String(process.env.AUTOMATION_OS_PORTABLE_REMOTE_TOKEN || "").trim()) return String(process.env.AUTOMATION_OS_PORTABLE_REMOTE_TOKEN).trim();
  const result = spawnSync("security", ["find-generic-password", "-s", TOKEN_SERVICE, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

export function portableRemoteErrorCode(error) {
  const message = error instanceof Error ? error.message : "";
  if (message === "portable_remote_http_timeout") return message;
  if (/^portable_remote_http_\d+$/u.test(message)) return message;
  return "portable_remote_http_failed";
}

const WORKER_STATUS_PRESERVED_FIELDS = [
  "heartbeat_status",
  "heartbeat_exact_blocker",
  "last_attempt_at",
  "last_successful_heartbeat_at",
  "heartbeat_at",
  "generation_started_at",
  "claim_status",
  "last_claim_at",
];

export function mergePortableRemoteWorkerStatus(previous, update) {
  const source = previous && typeof previous === "object" ? previous : {};
  const preserved = Object.fromEntries(WORKER_STATUS_PRESERVED_FIELDS
    .filter((key) => Object.prototype.hasOwnProperty.call(source, key))
    .map((key) => [key, source[key]]));
  return { ...preserved, ...(update && typeof update === "object" ? update : {}) };
}

function writeWorkerStatus(update) {
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  const temporaryPath = `${WORKER_STATUS_PATH}.tmp-${process.pid}-${Date.now()}`;
  try {
    mkdirSync(path.dirname(WORKER_STATUS_PATH), { recursive: true, mode: 0o700 });
    let previous = {};
    if (existsSync(WORKER_STATUS_PATH)) {
      const stat = lstatSync(WORKER_STATUS_PATH);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (currentUid !== null && stat.uid !== currentUid)) return false;
      try {
        const parsed = JSON.parse(readFileSync(WORKER_STATUS_PATH, "utf8"));
        previous = mergePortableRemoteWorkerStatus(parsed, {});
      } catch {
        previous = {};
      }
    }
    const value = {
      schema: "aos.portable_remote_worker_status.v1",
      worker_id: WORKER_ID,
      pid: process.pid,
      remote_origin: (() => { try { return new URL(REMOTE_URL).origin; } catch { return "invalid"; } })(),
      effects: "read_only",
      ...previous,
      ...update,
      updated_at: new Date().toISOString(),
    };
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, WORKER_STATUS_PATH);
    chmodSync(WORKER_STATUS_PATH, 0o600);
    return true;
  } catch {
    try { if (existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch { /* status must never stop the worker */ }
    return false;
  }
}

function safeWrite(filePath, value) {
  const resolved = path.resolve(filePath);
  mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(resolved), 0o700);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(resolved)) {
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || readFileSync(resolved, "utf8") !== bytes) throw new Error("portable_remote_immutable_collision");
    chmodSync(resolved, 0o600);
    return { path: resolved, sha256: sha256(bytes) };
  }
  const fd = openSync(resolved, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
  try { writeFileSync(fd, bytes, "utf8"); } finally { closeSync(fd); }
  chmodSync(resolved, 0o600);
  return { path: resolved, sha256: sha256(bytes) };
}

function runRoot(runId) {
  if (!/^[A-Za-z0-9][-_A-Za-z0-9.:]{0,179}$/u.test(runId)) throw new Error("portable_remote_run_id_invalid");
  const root = path.resolve(ARTIFACT_ROOT, runId);
  const relative = path.relative(ARTIFACT_ROOT, root);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("portable_remote_run_root_invalid");
  return root;
}

export function effectAuthorityFromClaim(claim) {
  if (!claim || typeof claim !== "object") return null;
  // The HTTP claim is `effect_authority`; persisted run metadata uses the
  // explicit `portable_effect_authority` name. Accept both only at this
  // boundary, then pass the normalized object to every downstream gate.
  return claim.effect_authority || claim.portable_effect_authority || null;
}

export function createAdmission(claim, root) {
  const now = Date.now();
  const authority = claim.execution_mode === "business_effect" ? effectAuthorityFromClaim(claim) : null;
  if (claim.execution_mode === "business_effect" && (!authority || authority.schema !== "automation_os_portable_external_effect_authority.v1" || authority.external_action_authorized !== true || authority.first_class_root_required !== false)) {
    throw new Error("portable_remote_effect_authority_missing");
  }
  const admissionPath = path.join(root, `portable-external-admission-${sha256(`${claim.run_id}:${claim.step_id}:${claim.idempotency_key}`).slice(0, 24)}.json`);
  const approvalStatus = claim.approval_id ? "approved" : claim.execution_mode === "read_only" ? "approved" : "missing";
  const existing = readExistingAdmission(admissionPath, claim, approvalStatus, now);
  if (existing) return existing;
  return safeWrite(admissionPath, {
    schema: "automation_os_portable_external_admission.v1",
    issued_by: "automation_os_mac_worker",
    audience: "portable_external_runner",
    workflow_id: claim.workflow_id,
    run_id: claim.run_id,
    step_id: claim.step_id,
    source_trigger: claim.source_trigger,
    idempotency_key: claim.idempotency_key,
    effect_class: "external_non_idempotent",
    browser_surface: "browser_use_cli",
    external_effects: claim.execution_mode === "business_effect" ? "enabled" : "read_only",
    approval_status: approvalStatus,
    ...(authority ? {
      effect_authority_id: authority.authority_id,
      effect_authority_sha256: sha256(`${JSON.stringify(authority, null, 2)}\n`),
      timeout_controller: authority.timeout_controller,
      reconciliation_owner: authority.reconciliation_owner,
      reconciliation_required: authority.reconciliation_required,
      no_auto_retry: authority.no_auto_retry,
    } : {}),
    ...(claim.execution_mode === "business_effect" ? {
      business_effect_stage: claim.business_effect_stage,
      approval_id: claim.approval_id,
      input_bundle_sha256: claim.input_bundle_sha256,
      target_digest: claim.target_digest,
    } : {}),
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 20 * 60_000).toISOString(),
  });
}

function readExistingAdmission(admissionPath, claim, approvalStatus, now) {
  if (!fs.existsSync(admissionPath)) return null;
  let stat;
  let bytes;
  let value;
  try {
    stat = fs.lstatSync(admissionPath);
    bytes = fs.readFileSync(admissionPath);
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("portable_remote_immutable_collision");
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.uid !== currentUid || (stat.mode & 0o777) !== 0o600
    || !value || typeof value !== "object" || Array.isArray(value)
    || value.schema !== "automation_os_portable_external_admission.v1"
    || value.issued_by !== "automation_os_mac_worker"
    || value.audience !== "portable_external_runner"
    || value.workflow_id !== claim.workflow_id
    || value.run_id !== claim.run_id
    || value.step_id !== claim.step_id
    || value.source_trigger !== claim.source_trigger
    || value.idempotency_key !== claim.idempotency_key
    || value.effect_class !== "external_non_idempotent"
    || value.browser_surface !== "browser_use_cli"
    || value.external_effects !== (claim.execution_mode === "business_effect" ? "enabled" : "read_only")
    || value.approval_status !== approvalStatus
    || Date.parse(String(value.expires_at || "")) <= now
  ) {
    throw new Error("portable_remote_immutable_collision");
  }
  fs.chmodSync(admissionPath, 0o600);
  return { path: admissionPath, sha256: sha256(bytes) };
}

export function createEffectAuthorityFile(claim, root) {
  if (claim.execution_mode !== "business_effect") return null;
  const authority = effectAuthorityFromClaim(claim);
  if (!authority || authority.schema !== "automation_os_portable_external_effect_authority.v1") {
    throw new Error("portable_remote_effect_authority_missing");
  }
  const bytes = `${JSON.stringify(authority, null, 2)}\n`;
  const expected = sha256(bytes);
  if (authority.authority_id !== `portable-effect-${sha256([
    authority.company_id, authority.workflow_id, authority.run_id, authority.step_id,
    authority.effect_stage, authority.approval_id, authority.idempotency_key,
    authority.target_digest, authority.input_bundle_sha256
  ].join("\u001f")).slice(0, 32)}`) {
    throw new Error("portable_remote_effect_authority_binding_invalid");
  }
  return safeWrite(path.join(root, "portable-effect-authority.v1.json"), authority);
}

export function bindBusinessReceiptToClaim(claim, receipt) {
  if (claim?.execution_mode !== "business_effect" || !receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return receipt;
  }
  // The AOS target-bound approval receipt is authoritative.  Never accept a
  // child-run copy (or omission) as a substitute for the current claim.
  return {
    ...receipt,
    approval_receipt: claim.approval_receipt || null,
  };
}

function createInputBundle(claim, root) {
  if (!claim.input_bundle) return null;
  return safeWrite(path.join(root, "portable-input-bundle.v1.json"), {
    schema: "automation_os_portable_workflow_input_bundle.v1",
    workflow_id: claim.workflow_id,
    run_id: claim.run_id,
    input: claim.input_bundle,
  });
}

function parseFinalJson(stdout) {
  const lines = String(stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch { /* progress output is ignored */ }
  }
  return null;
}

async function runRunner(claim, files) {
  const runner = claim.execution_mode === "business_effect" ? BUSINESS_RUNNER : READ_ONLY_RUNNER;
  const child = spawn(process.execPath, [runner,
    "--workflow-id", claim.workflow_id,
    "--run-id", claim.run_id,
    "--step-id", claim.step_id,
    "--source-trigger", claim.source_trigger,
    "--idempotency-key", claim.idempotency_key,
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...resolveBusinessRunnerBindingEnvironment(),
      AUTOMATION_OS_ARTIFACT_ROOT: ARTIFACT_ROOT,
      AUTOMATION_OS_PORTABLE_EXTERNAL_EFFECTS: claim.execution_mode === "business_effect" ? "enabled" : "read_only",
      AUTOMATION_OS_PORTABLE_EXTERNAL_APPROVAL: "approved",
      AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_PATH: files.admission.path,
      AUTOMATION_OS_PORTABLE_EXTERNAL_ADMISSION_SHA256: files.admission.sha256,
      AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_PATH: files.actionPlan.path,
      AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_SHA256: files.actionPlan.sha256,
      ...(files.effectAuthority ? {
        AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_REQUIRED: "1",
        AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH: files.effectAuthority.path,
        AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256: files.effectAuthority.sha256,
        AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_ID: effectAuthorityFromClaim(claim)?.authority_id || "",
      } : {}),
      ...(files.inputBundle ? { AUTOMATION_OS_PORTABLE_EXTERNAL_INPUT_BUNDLE_PATH: files.inputBundle.path } : {}),
      ...(claim.read_only_stage ? { AUTOMATION_OS_PORTABLE_EXTERNAL_READ_ONLY_STAGE: claim.read_only_stage } : {}),
      ...(claim.execution_mode === "business_effect" ? {
        AUTOMATION_OS_PORTABLE_BUSINESS_EFFECT_STAGE: claim.business_effect_stage,
        AUTOMATION_OS_PORTABLE_BUSINESS_APPROVAL_ID: claim.approval_id,
        AUTOMATION_OS_PORTABLE_BUSINESS_TARGET_DIGEST: claim.target_digest,
      } : {}),
      AUTOMATION_OS_WEB_OPERATION_CONTRACT_SCHEMA: "automation_os_web_operation_contract.v1",
      AUTOMATION_OS_WEB_OPERATION_ADAPTIVE: "semantic_live_state_bounded_exploration",
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-500_000); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-50_000); });
  const timeoutMs = Math.max(30_000, Math.min(3_600_000, Number(
    process.env.AUTOMATION_OS_PORTABLE_REMOTE_RUN_TIMEOUT_MS
      || process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_TIMEOUT_MS
      || 180_000
  )));
  const terminateRunner = (signal) => {
    if (!child.pid) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* runner may have exited between timeout and group cleanup */ }
  };
  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => {
      terminateRunner("SIGTERM");
      setTimeout(() => terminateRunner("SIGKILL"), 5_000).unref();
      finish({ code: null, signal: "SIGTERM", timed_out: true });
    }, timeoutMs);
    child.once("error", () => { clearTimeout(timer); finish({ code: null, signal: null, timed_out: false }); });
    child.once("close", (code, signal) => { clearTimeout(timer); finish({ code, signal, timed_out: false }); });
  });
  let receipt = parseFinalJson(stdout) || {
    status: "blocked",
    exact_blocker: result.timed_out ? "portable_external_worker_timeout" : "portable_remote_runner_receipt_missing",
    external_action_executed: false,
    browser_surface: "browser_use_cli",
    workflow_id: claim.workflow_id,
    run_id: claim.run_id,
    step_id: claim.step_id,
    cleanup_verified: false,
    readback_verified: false,
    effects_mode: "read_only",
    read_only_stage_bound: true,
    external_executor_status: "runner_receipt_missing",
  };
  if (claim.execution_mode === "business_effect") {
    const adapter = receipt && typeof receipt.adapter_result === "object" && !Array.isArray(receipt.adapter_result) ? receipt.adapter_result : {};
    const jobProof = claim.workflow_id === "job-application-manager"
      && adapter.state === "submitted_confirmed"
      && adapter.sync_ok === true
      && adapter.ledger_finalized === true;
    const genericProof = Boolean(receipt.runner_receipt && receipt.same_run_receipt === true);
    receipt = bindBusinessReceiptToClaim(claim, {
      ...receipt,
      effects_mode: "business_effect",
      business_effect_stage: claim.business_effect_stage,
      target_digest: claim.target_digest,
      same_run_receipt: receipt.same_run_receipt === true,
      readback_verified: receipt.readback_verified === true || jobProof || genericProof,
      business_proof_verified: jobProof || genericProof,
    });
  } else {
    if (receipt.external_action_executed === true) throw new Error("portable_remote_external_effect_reported");
    receipt = { ...receipt, effects_mode: "read_only", read_only_stage_bound: true };
  }
  return { receipt, child_exit_code: result.code, child_signal: result.signal, timed_out: result.timed_out, stderr_present: Boolean(stderr.trim()) };
}

async function processPortableLocalWorkflowClaim(claim, token) {
  let localReceipt;
  let artifactUri = "";
  try {
    const modulePath = path.join(ROOT, "apps/server", "dist", "runs", "portableLocalWorkflow.js");
    const { runPortableLocalWorkflowReadOnly } = await import(pathToFileURL(modulePath).href);
    localReceipt = runPortableLocalWorkflowReadOnly({
      workflowId: claim.workflow_id,
      workerRole: process.env.AUTOMATION_OS_WORKER_ROLE?.trim() || "mac",
    });
    const root = runRoot(claim.run_id);
    const artifact = safeWrite(path.join(root, "portable-local-worker-receipt.v1.json"), {
      schema: "aos.portable_local_worker_receipt.v1",
      ...localReceipt,
      run_id: claim.run_id,
      step_id: claim.step_id,
      adapter: "portable_local_workflow",
      created_at: new Date().toISOString(),
    });
    artifactUri = `file://${artifact.path}`;
  } catch (error) {
    localReceipt = {
      status: "blocked",
      exact_blocker: error instanceof Error ? error.message.slice(0, 240) : "portable_local_worker_setup_failed",
      external_action_executed: false,
      workflow_id: claim.workflow_id,
      read_only_stage_bound: true,
      readback_verified: false,
      cleanup_verified: true,
      business_completion_verified: false,
      adapter_result: { execution_surface: "mac_local_worker", artifact_uri: artifactUri },
    };
  }
  const completed = localReceipt.status === "complete" && localReceipt.exact_blocker === null;
  const receipt = {
    status: localReceipt.status,
    exact_blocker: localReceipt.exact_blocker,
    external_action_executed: false,
    // The current Zeabur receipt endpoint accepts the stable portable
    // envelope surface. The adapter_result below preserves the truthful
    // local-worker execution surface until the next server candidate is
    // deployed with the explicit local_worker enum.
    browser_surface: "browser_use_cli",
    workflow_id: claim.workflow_id,
    run_id: claim.run_id,
    step_id: claim.step_id,
    cleanup_verified: localReceipt.cleanup_verified === true,
    readback_verified: localReceipt.readback_verified === true,
    effects_mode: "read_only",
    read_only_stage_bound: true,
    same_run_receipt: completed,
    business_proof_verified: false,
    read_only_proof_verified: completed,
    external_executor_status: completed ? "portable_local_worker_completed" : "portable_local_worker_blocked",
    adapter_result: {
      local_workflow_receipt: true,
      execution_surface: "mac_local_worker",
      artifact_uri: artifactUri,
      cleanup_verified: localReceipt.cleanup_verified === true,
      readback_verified: localReceipt.readback_verified === true,
      business_completion_verified: false,
      local_receipt: localReceipt.adapter_result,
    },
  };
  const completion = await requestJson(`${REMOTE_URL}/api/portable-worker/${encodeURIComponent(claim.run_id)}/receipt`, token, {
    worker_id: WORKER_ID,
    receipt,
  });
  return {
    status: receipt.status,
    run_id: claim.run_id,
    workflow_id: claim.workflow_id,
    step_id: claim.step_id,
    exact_blocker: receipt.exact_blocker,
    external_action_executed: false,
    browser_surface: "browser_use_cli",
    cleanup_verified: receipt.cleanup_verified,
    readback_verified: receipt.readback_verified,
    remote_replayed: completion.replayed === true,
    child_exit_code: completed ? 0 : 1,
    child_signal: null,
  };
}

export function portableRemoteHttpTimeoutMs(value = process.env.AUTOMATION_OS_PORTABLE_REMOTE_HTTP_TIMEOUT_MS) {
  const parsed = Number(value ?? DEFAULT_REMOTE_HTTP_TIMEOUT_MS);
  return Number.isFinite(parsed)
    ? Math.max(1_000, Math.min(120_000, Math.floor(parsed)))
    : DEFAULT_REMOTE_HTTP_TIMEOUT_MS;
}

export async function requestPortableRemoteJson(url, token, body, { timeoutMs } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), portableRemoteHttpTimeoutMs(timeoutMs));
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-automation-os-token": token,
        "x-automation-os-company-id": COMPANY_ID,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof json.exactBlocker === "string" ? json.exactBlocker : `portable_remote_http_${response.status}`);
    return json;
  } catch (error) {
    if (error && typeof error === "object" && error.name === "AbortError") {
      throw new Error("portable_remote_http_timeout");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const requestJson = requestPortableRemoteJson;

function publishHeartbeat() {
  if (heartbeatInFlight) return heartbeatInFlight;
  heartbeatInFlight = (async () => {
    const attemptedAt = new Date().toISOString();
    const token = readToken();
    if (!token) {
      writeWorkerStatus({ status: "blocked", exact_blocker: "portable_remote_worker_token_missing", heartbeat_status: "blocked", heartbeat_exact_blocker: "portable_remote_worker_token_missing", last_attempt_at: attemptedAt });
      return false;
    }
    try {
      const response = await requestJson(`${REMOTE_URL}/api/portable-worker/heartbeat`, token, {
        worker_id: WORKER_ID,
        status: "running",
        queue_depth: null,
        exact_blocker: null,
      });
      const heartbeatAt = typeof response.heartbeat_at === "string" ? response.heartbeat_at : null;
      writeWorkerStatus({
        status: "heartbeat_ok",
        exact_blocker: null,
        heartbeat_status: "ok",
        heartbeat_exact_blocker: null,
        last_attempt_at: attemptedAt,
        last_successful_heartbeat_at: heartbeatAt ?? attemptedAt,
        heartbeat_at: heartbeatAt,
      });
      return true;
    } catch (error) {
      const exactBlocker = portableRemoteErrorCode(error);
      writeWorkerStatus({ status: "heartbeat_blocked", exact_blocker: exactBlocker, heartbeat_status: "blocked", heartbeat_exact_blocker: exactBlocker, last_attempt_at: attemptedAt });
      return false;
    }
  })();
  const current = heartbeatInFlight;
  void current.finally(() => { if (heartbeatInFlight === current) heartbeatInFlight = null; });
  return current;
}

function startResidentHeartbeat() {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    void publishHeartbeat();
  };
  const interval = setInterval(tick, Math.max(5_000, Math.min(60_000, POLL_MS)));
  interval.unref?.();
  tick();
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

function setupFailureCode(error) {
  const value = error instanceof Error ? error.message : String(error || "");
  const allowed = new Set([
    "portable_remote_immutable_collision",
    "portable_remote_run_id_invalid",
    "portable_remote_run_root_invalid",
    "portable_remote_input_bundle_secret_like_key",
    "portable_remote_input_bundle_invalid"
  ]);
  return allowed.has(value) ? value : "portable_remote_local_setup_failed";
}

function setupFailureReceipt(claim, error) {
  const exactBlocker = setupFailureCode(error);
  return {
    status: "blocked",
    exact_blocker: exactBlocker,
    external_action_executed: false,
    browser_surface: "browser_use_cli",
    workflow_id: claim.workflow_id,
    run_id: claim.run_id,
    step_id: claim.step_id,
    cleanup_verified: false,
    readback_verified: false,
    effects_mode: claim.execution_mode,
    read_only_stage_bound: claim.execution_mode === "read_only",
    ...(claim.execution_mode === "business_effect" ? {
      business_effect_stage: claim.business_effect_stage,
      target_digest: claim.target_digest,
      ...(claim.effect_authority ? {
        effect_authority_id: claim.effect_authority.authority_id,
        effect_authority_sha256: sha256(`${JSON.stringify(claim.effect_authority, null, 2)}\n`),
      } : {}),
    } : {}),
    same_run_receipt: false,
    business_proof_verified: false,
    ...(claim.input_bundle_sha256 ? { input_bundle_sha256: claim.input_bundle_sha256 } : {}),
    external_executor_status: "portable_remote_local_setup_failed"
  };
}

async function processOne({ requestedRunId = null } = {}) {
  const token = readToken();
  if (!token) {
    writeWorkerStatus({ status: "blocked", exact_blocker: "portable_remote_worker_token_missing", heartbeat_status: "blocked", heartbeat_exact_blocker: "portable_remote_worker_token_missing" });
    return { status: "blocked", exact_blocker: "portable_remote_worker_token_missing", external_action_executed: false };
  }
  await publishHeartbeat();
  let claimed;
  try {
    claimed = await requestJson(`${REMOTE_URL}/api/portable-worker/claim`, token, { worker_id: WORKER_ID, ...(requestedRunId ? { run_id: requestedRunId } : {}) });
  } catch (error) {
    writeWorkerStatus({ status: "claim_blocked", exact_blocker: portableRemoteErrorCode(error) });
    throw error;
  }
  if (!claimed.run) {
    writeWorkerStatus({ status: "idle", exact_blocker: null, claim_status: "idle", last_claim_at: new Date().toISOString() });
    return { status: "idle", claimed: false, external_action_executed: false };
  }
  const claim = claimed.run;
  writeWorkerStatus({ status: "claimed", exact_blocker: null, claim_status: "claimed", last_claim_at: new Date().toISOString() });
  if (PORTABLE_LOCAL_WORKFLOW_IDS.has(claim.workflow_id)) {
    return processPortableLocalWorkflowClaim(claim, token);
  }
  let root;
  let admission;
  let inputBundle;
  let actionPlan;
  let effectAuthority;
  try {
    root = runRoot(claim.run_id);
    effectAuthority = createEffectAuthorityFile(claim, root);
    admission = createAdmission(claim, root);
    inputBundle = createInputBundle(claim, root);
    process.env.AUTOMATION_OS_ARTIFACT_ROOT = ARTIFACT_ROOT;
    const { issuePortableExternalActionPlan } = await import(pathToFileURL(path.join(ROOT, "apps/server/dist/runs/portableExternalActionPlan.js")).href);
    actionPlan = issuePortableExternalActionPlan({ workflowId: claim.workflow_id, runId: claim.run_id, stepId: claim.step_id, sourceTrigger: claim.source_trigger, idempotencyKey: claim.idempotency_key, inputBundlePath: inputBundle?.path || null });
  } catch (error) {
    // No runner/browser has started yet. Persist a safe no-effect receipt so
    // a local immutable artifact collision cannot keep the same lease alive
    // forever or cause an external retry.
    const receipt = setupFailureReceipt(claim, error);
    const completion = await requestJson(`${REMOTE_URL}/api/portable-worker/${encodeURIComponent(claim.run_id)}/receipt`, token, { worker_id: WORKER_ID, receipt });
    return {
      status: receipt.status,
      run_id: claim.run_id,
      workflow_id: claim.workflow_id,
      step_id: claim.step_id,
      exact_blocker: receipt.exact_blocker,
      external_action_executed: false,
      browser_surface: "browser_use_cli",
      cleanup_verified: false,
      readback_verified: false,
      remote_replayed: completion.replayed === true,
      child_exit_code: null,
      child_signal: null,
    };
  }
  const result = await runRunner(claim, { admission, inputBundle, actionPlan, effectAuthority });
  if (claim.execution_mode === "business_effect" && effectAuthorityFromClaim(claim)) {
    result.receipt.effect_authority_id = effectAuthorityFromClaim(claim).authority_id;
    result.receipt.effect_authority_sha256 = effectAuthority?.sha256 || null;
  }
  const completion = await requestJson(`${REMOTE_URL}/api/portable-worker/${encodeURIComponent(claim.run_id)}/receipt`, token, { worker_id: WORKER_ID, receipt: result.receipt });
  return {
    status: result.receipt.status,
    run_id: claim.run_id,
    workflow_id: claim.workflow_id,
    step_id: claim.step_id,
    exact_blocker: result.receipt.exact_blocker || null,
    external_action_executed: result.receipt.external_action_executed === true,
    browser_surface: "browser_use_cli",
    cleanup_verified: result.receipt.cleanup_verified === true,
    readback_verified: result.receipt.readback_verified === true,
    remote_replayed: completion.replayed === true,
    child_exit_code: result.child_exit_code,
    child_signal: result.child_signal,
  };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const requestedRunId = process.argv.find((value) => value.startsWith("--run-id="))?.slice("--run-id=".length) || null;
  const once = args.has("--once") || Boolean(requestedRunId);
  writeWorkerStatus({ status: "starting", claim_status: "unknown", heartbeat_status: "unknown", heartbeat_exact_blocker: null, last_attempt_at: null, last_successful_heartbeat_at: null, heartbeat_at: null, generation_started_at: new Date().toISOString() });
  if (once) {
    emitResult(await processOne({ requestedRunId }), { force: true });
    return;
  }
  const stopHeartbeat = startResidentHeartbeat();
  let stopping = false;
  process.once("SIGTERM", () => { stopping = true; });
  process.once("SIGINT", () => { stopping = true; });
  try {
    while (!stopping) {
      try { emitResult(await processOne()); } catch (error) { emitResult({ status: "blocked", exact_blocker: error instanceof Error ? error.message : "portable_remote_worker_failed", external_action_executed: false }); }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    stopHeartbeat();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => { emitResult({ status: "blocked", exact_blocker: error instanceof Error ? error.message : "portable_remote_worker_failed", external_action_executed: false }, { force: true }); process.exitCode = 1; });
}

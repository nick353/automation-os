#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { readPortableBusinessActionPlan, WEB_OPERATION_CONTRACT } from "./portable-business-action-plan.mjs";
import { buildPortableBusinessWebOperationLifecycle, readPortableBusinessEffectAuthority } from "./portable-business-lifecycle.mjs";
import { normalizeDailyAiCompanionIntent, prepareDailyAiCompanionOperation, executeDailyAiCompanionOperation, readDailyAiProviderAfterTransaction, validateDailyAiProviderReadback } from "./daily-ai-companion-adapter.mjs";
import { loadCompanionBrokerClient } from "./aos-chrome-companion-adapter.mjs";
import { validateCompanionIsolationBinding } from "./lib/companion-isolation-binding.mjs";

const ID = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,179}$/u;
const PROJECT_ROOT = "/Users/nichikatanaka/Documents/New project";
const DEFAULT_REGISTERED_RUNNER = path.join(PROJECT_ROOT, "scripts", "run_daily_ai_browser_use_cli_registered.mjs");
const QUEUE_PATH = path.join(PROJECT_ROOT, "posting_queue.tsv");
function dailyAiQueuePath() { return path.resolve(String(process.env.DAILY_AI_QUEUE_PATH || QUEUE_PATH)); }

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function persistProviderReadback(outputDir, proof) {
  const dir = path.join(path.resolve(outputDir), "provider-readback");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, `daily-ai-provider-readback-${proof.run_id}.v1.json`);
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(proof, null, 2)}\n`, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return file;
}
function commitProviderReadback(outputDir, proof, queuePath, validatedIsolation = false) {
  if (process.env.AOS_DAILY_AI_INJECT_COMMIT_FAILURE_ONCE === "1") {
    if (!validatedIsolation) throw new Error("daily_ai_companion_injection_requires_validated_isolation");
    const marker = path.join(path.resolve(outputDir), "provider-readback", ".commit-failure-injected");
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, "injected\n", { mode: 0o600 });
      return { status: "blocked", exact_blocker: "daily_ai_companion_queue_commit_injected_failure", injected: true };
    }
  }
  const requestPath = path.join(path.resolve(outputDir), "provider-readback", `daily-ai-provider-commit-${proof.run_id}.json`);
  const fd = fs.openSync(requestPath, "wx", 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify({ queue_path: queuePath, provider_readback: proof }, null, 2)}\n`, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const helper = path.join(PROJECT_ROOT, "src", "social_flow", "daily_ai_provider_commit.py");
  const result = spawnSync("python3", [helper, "--request", requestPath], {
    cwd: PROJECT_ROOT, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, PYTHONPATH: path.join(PROJECT_ROOT, "src") },
  });
  if (result.status !== 0) return { status: "blocked", exact_blocker: `daily_ai_companion_queue_commit_failed:${String(result.stderr || "").trim() || "helper_failed"}`, request_path: requestPath };
  try { return JSON.parse(String(result.stdout || "").trim()); } catch { return { status: "blocked", exact_blocker: "daily_ai_companion_queue_commit_readback_missing", request_path: requestPath }; }
}
function companionLifecycle({ input, authority, receipt }) {
  const sync = receipt?.postflight_sync;
  const operation = receipt?.operation;
  const queueSyncVerified = companionQueueSyncVerified(sync, operation);
  const lifecycleReadbackVerified = receipt?.provider_readback?.verified === true
    && queueSyncVerified
    && receipt?.reconciliation?.verified === true;
  return buildPortableBusinessWebOperationLifecycle({
    run_id: input.run_id,
    step_id: input.step_id,
    idempotency_key: input.idempotency_key,
    operation: "publish",
    authority,
    external_action_executed: receipt?.external_action_executed === true,
    same_run_receipt: receipt?.same_run_receipt === true,
    readback_verified: lifecycleReadbackVerified,
    cleanup_verified: receipt?.cleanup_verified === true,
    source_state_digest: queueSyncVerified ? sync.row_checksum : null,
    exact_blocker: receipt?.exact_blocker || null,
  });
}
function companionQueueSyncVerified(sync, operation) {
  return sync?.schema === "aos.daily_ai_provider_queue_commit.v1"
    && typeof sync.changed === "boolean"
    && sync.status === "completed"
    && sync?.content_key === operation?.content_key
    && sync?.platform === operation?.platform
    && /^[a-f0-9]{64}$/u.test(String(sync?.row_checksum || ""));
}
function persistCompanionBrokerIdentity(outputDir, identity) {
  if (!identity || identity.schema !== "aos.chrome_companion.broker_identity.v1" || identity.build_match !== true) throw new Error("daily_ai_companion_broker_identity_missing");
  const base = path.join(path.resolve(outputDir), "companion-broker-identity.v1.json");
  const existing = readJsonFile(base);
  if (fs.existsSync(base) && !existing) throw new Error("daily_ai_companion_broker_identity_record_invalid");
  if (existing?.schema === identity.schema
    && existing.expected_instance_id === identity.expected_instance_id
    && existing.observed_instance_id === identity.observed_instance_id
    && existing.expected_build_id === identity.expected_build_id
    && existing.observed_build_id === identity.observed_build_id
    && existing.build_match === true) return base;
  const file = existing ? path.join(path.resolve(outputDir), `companion-broker-identity-${Date.now()}-${process.pid}.v1.json`) : base;
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(identity, null, 2)}\n`, "utf8"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return file;
}
function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function selectedSurfaceFromEnvironment() {
  return String(process.env.AOS_WEB_OPERATION_BACKEND || "browser_use_cli").trim() === "aos_chrome_companion"
    ? "aos_chrome_companion_profile_instance" : "browser_use_cli";
}
function bindingDiagnostic() {
  const keys = [
    "AUTOMATION_OS_PORTABLE_WEB_OPERATION_INTENT_PATH",
    "AUTOMATION_OS_PORTABLE_WEB_OPERATION_INTENT_SHA256",
    "AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH",
    "AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256",
    "AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_ID",
    "DAILY_AI_QUEUE_PATH",
  ];
  const result = {};
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    result[key] = {
      present: Boolean(value),
      resolved_path: key.endsWith("_PATH") && value ? path.resolve(value) : null,
      exists: key.endsWith("_PATH") && value ? fs.existsSync(path.resolve(value)) : null,
      sha256_format: key.endsWith("_SHA256") ? /^[a-f0-9]{64}$/u.test(value) : null,
    };
  }
  return result;
}
function output(value, code = 1) {
  process.stdout.write(`${JSON.stringify({
    status: value.status || "blocked",
    exact_blocker: value.exact_blocker || null,
    external_action_executed: value.external_action_executed === true,
    browser_surface: value.browser_surface ?? selectedSurfaceFromEnvironment(),
    same_run_receipt: value.same_run_receipt === true,
    cleanup_verified: value.cleanup_verified === true,
    llm_provider_neutral: true,
    app_dependency: false,
    ...(value.run_id ? { run_id: value.run_id } : {}),
    ...(value.step_id ? { step_id: value.step_id } : {}),
    ...(value.runner_receipt ? { runner_receipt: value.runner_receipt } : {}),
    ...(value.web_operation_lifecycle ? { web_operation_lifecycle: value.web_operation_lifecycle } : {}),
    web_operation_contract: value.web_operation_contract || WEB_OPERATION_CONTRACT,
  })}\n`);
  return code;
}
function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = String(argv[index] || "").replace(/^--/u, "").replaceAll("-", "_");
    if (!key || !argv[index + 1] || String(argv[index + 1]).startsWith("--")) throw new Error("daily_ai_business_argument_invalid");
    result[key] = String(argv[index + 1]);
    index += 1;
  }
  for (const key of ["workflow_id", "run_id", "step_id", "source_trigger", "idempotency_key"]) {
    if (!ID.test(String(result[key] || ""))) throw new Error(`daily_ai_business_${key}_invalid`);
  }
  return result;
}
function readAdmission(input) {
  const file = path.resolve(String(process.env.AUTOMATION_OS_PORTABLE_BUSINESS_ADMISSION_PATH || ""));
  const expected = String(process.env.AUTOMATION_OS_PORTABLE_BUSINESS_ADMISSION_SHA256 || "");
  if (!file || !fs.existsSync(file) || !/^[a-f0-9]{64}$/u.test(expected)) throw new Error("daily_ai_business_admission_missing");
  const bytes = fs.readFileSync(file);
  const value = JSON.parse(bytes.toString("utf8"));
  const selectedSurface = String(process.env.AOS_WEB_OPERATION_BACKEND || "browser_use_cli").trim() === "aos_chrome_companion"
    ? "aos_chrome_companion_profile_instance" : "browser_use_cli";
  if (digest(bytes) !== expected || value.workflow_id !== input.workflow_id || value.run_id !== input.run_id || value.step_id !== input.step_id || value.audience !== "portable_external_runner" || value.approval_status !== "approved" || value.browser_surface !== selectedSurface) throw new Error("daily_ai_business_admission_binding_invalid");
  if (Date.parse(String(value.expires_at || "")) <= Date.now()) throw new Error("daily_ai_business_admission_expired");
  return { path: file, sha256: expected, browser_surface: selectedSurface };
}

function readTrustedDailyAiAuthority(input) {
  const rawPath = String(process.env.AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH || "").trim();
  const expectedSha = String(process.env.AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256 || "").trim();
  if (!rawPath || !/^[a-f0-9]{64}$/u.test(expectedSha) || !fs.existsSync(rawPath)) throw new Error("daily_ai_companion_authority_missing");
  const file = path.resolve(rawPath);
  const bytes = fs.readFileSync(file);
  let authority;
  try { authority = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("daily_ai_companion_authority_invalid"); }
  if (digest(bytes) !== expectedSha
    || authority?.schema !== "automation_os_portable_external_effect_authority.v1"
    || authority?.issued_by !== "automation_os_portable_controller"
    || authority?.workflow_id !== input.workflow_id
    || authority?.run_id !== input.run_id
    || authority?.step_id !== input.step_id
    || authority?.idempotency_key !== input.idempotency_key
    || typeof authority?.company_id !== "string" || !authority.company_id.trim()
    || typeof authority?.approval_id !== "string" || !authority.approval_id.trim()
    || authority?.approval_status !== "approved"
    || authority?.external_action_authorized !== true
    || authority?.browser_surface !== "aos_chrome_companion_profile_instance"
    || !Number.isFinite(Date.parse(String(authority?.expires_at || "")))
    || Date.parse(String(authority.expires_at)) <= Date.now()
    || !/^[a-f0-9]{64}$/u.test(String(authority?.target_digest || ""))
    || !/^[a-f0-9]{64}$/u.test(String(authority?.input_bundle_sha256 || ""))
    || !/^[a-f0-9]{64}$/u.test(String(authority?.payload_hash || ""))) {
    throw new Error("daily_ai_companion_authority_binding_invalid");
  }
  return { ...authority, path: file, sha256: expectedSha };
}

function readCanonicalDailyAiIntent(input, authority) {
  const canonicalPath = path.join(path.dirname(authority.path), "web-operation-intent.v1.json");
  const configuredPath = String(process.env.AUTOMATION_OS_PORTABLE_WEB_OPERATION_INTENT_PATH || "").trim();
  const rawPath = configuredPath && fs.existsSync(configuredPath) ? configuredPath : canonicalPath;
  const expectedSha = String(process.env.AUTOMATION_OS_PORTABLE_WEB_OPERATION_INTENT_SHA256 || "").trim();
  if (!fs.existsSync(rawPath)) throw new Error("daily_ai_companion_intent_missing");
  const file = path.resolve(rawPath);
  const bytes = fs.readFileSync(file);
  const resolvedSha = expectedSha || digest(bytes);
  let intent;
  try { intent = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("daily_ai_companion_intent_invalid"); }
  if (!/^[a-f0-9]{64}$/u.test(resolvedSha) || digest(bytes) !== resolvedSha
    || intent?.schema !== "automation_os_web_operation_intent.v1"
    || intent?.run_id !== input.run_id
    || intent?.step_id !== input.step_id
    || intent?.idempotency_key !== input.idempotency_key
    || typeof intent?.account_ref !== "string" || !intent.account_ref.trim()
    || intent?.browser_surface !== authority.browser_surface
    || intent?.browser_surface !== "aos_chrome_companion_profile_instance"
    || intent?.approval_status !== "approved"
    || intent?.authority_sha256 !== authority.sha256
    || intent?.readback_required !== true
    || intent?.no_replay !== true
    || !/^[a-f0-9]{64}$/u.test(String(intent?.payload_hash || ""))) {
    throw new Error("daily_ai_companion_intent_binding_invalid");
  }
  return { ...intent, path: file, sha256: resolvedSha };
}

function readCanonicalDailyAiQueueRow(contentKey) {
  const queuePath = dailyAiQueuePath();
  if (!fs.existsSync(queuePath) || !fs.statSync(queuePath).isFile()) throw new Error("daily_ai_companion_queue_missing");
  const lines = fs.readFileSync(queuePath, "utf8").split(/\r?\n/u).filter((line) => line.length > 0);
  if (lines.length < 2) throw new Error("daily_ai_companion_queue_row_missing");
  const headers = lines[0].split("\t");
  const row = lines.slice(1).map((line) => Object.fromEntries(headers.map((key, index) => [key, line.split("\t")[index] ?? ""]))).find((candidate) => String(candidate.id || "").trim() === contentKey);
  if (!row) throw new Error("daily_ai_companion_queue_row_missing");
  return { row, queue_path: queuePath, content_key: contentKey };
}

async function runDailyAiCompanionBranch({ input, targetBinding, outputDir, authority }) {
  const isolated = process.env.AOS_CHROME_COMPANION_REQUIRE_ISOLATED_PATHS === "1";
  if (!isolated && (process.env.AOS_CHROME_COMPANION_ISOLATION_BINDING_PATH || process.env.AOS_CHROME_COMPANION_ISOLATION_BINDING_SHA256)) {
    throw new Error("daily_ai_companion_isolation_mode_missing");
  }
  if (isolated) await validateCompanionIsolationBinding(process.env);
  if (!isolated && process.env.AOS_DAILY_AI_INJECT_COMMIT_FAILURE_ONCE === "1") {
    throw new Error("daily_ai_companion_injection_requires_validated_isolation");
  }
  const bundle = targetBinding.bundle;
  const trustedAuthority = readTrustedDailyAiAuthority(input);
  const intent = normalizeDailyAiCompanionIntent(readCanonicalDailyAiIntent(input, trustedAuthority));
  const targetKey = String(targetBinding.target_key || "").trim();
  const targetMatch = targetKey.match(/^(.+):(x|linkedin)$/u);
  if (!targetMatch || targetMatch[1] !== targetBinding.content_key || (intent.target?.target_key && intent.target.target_key !== targetKey)) throw new Error("daily_ai_companion_target_binding_invalid");
  if (String(intent.payload_hash) !== String(trustedAuthority.payload_hash)) throw new Error("daily_ai_companion_payload_binding_invalid");
  if (String(bundle.payload_hash || "") !== trustedAuthority.payload_hash || String(bundle.target_key || "") !== targetKey) throw new Error("daily_ai_companion_bundle_tampered");
  const taskId = String(process.env.AOS_CHROME_COMPANION_TASK_ID || "").trim();
  if (!taskId) throw new Error("daily_ai_companion_task_id_missing");
  const queueBinding = readCanonicalDailyAiQueueRow(targetMatch[1]);
  const row = queueBinding.row;
  const operation = prepareDailyAiCompanionOperation({
    row, platform: targetMatch[2], runId: input.run_id, taskId,
    approvalId: trustedAuthority.approval_id, accountRef: intent.account_ref,
    approvedPayloadHash: trustedAuthority.payload_hash, approvedTargetKey: targetKey, intent,
  });
  const savedReceiptPath = path.join(outputDir, "daily-ai-companion-receipt.json");
  const saved = readJsonFile(savedReceiptPath);
  if (saved?.run_id === input.run_id && saved?.operation?.task_id === operation.task_id
    && saved?.operation?.approval_id === operation.approval_id && saved?.provider_readback) {
    const savedProof = validateDailyAiProviderReadback(saved.provider_readback, {
      run_id: input.run_id, task_id: operation.task_id, approval_id: operation.approval_id,
      platform: targetMatch[2], account_ref: operation.account_ref, target_key: operation.target_key,
      content_key: operation.target_key.slice(0, -(`:${targetMatch[2]}`).length), approvedPayloadHash: operation.payload_hash,
    });
    const resumedSync = commitProviderReadback(outputDir, savedProof, dailyAiQueuePath(), isolated);
    const resumedOperation = { ...saved.operation, ...operation, platform: targetMatch[2], content_key: queueBinding.content_key };
    const resumedComplete = companionQueueSyncVerified(resumedSync, resumedOperation)
      && saved.cleanup_verified === true && saved.reconciliation?.verified === true;
    const resumed = { ...saved, operation: resumedOperation, provider_readback: savedProof, postflight_sync: resumedSync,
      status: resumedComplete ? "complete" : "blocked", same_run_receipt: resumedComplete,
      exact_blocker: resumedComplete ? null : resumedSync?.exact_blocker || "daily_ai_companion_queue_sync_missing", no_replay: true };
    resumed.web_operation_lifecycle = companionLifecycle({ input, authority: trustedAuthority, receipt: resumed });
    fs.writeFileSync(savedReceiptPath, `${JSON.stringify(resumed, null, 2)}\n`, { mode: 0o600 });
    return { ...resumed, receipt_path: savedReceiptPath, resumed_from_proof: true };
  }
  const client = await loadCompanionBrokerClient(process.env);
  let brokerIdentityPath;
  try {
    if (isolated) brokerIdentityPath = persistCompanionBrokerIdentity(outputDir, client.companionBrokerIdentity);
    const adapterReceipt = await executeDailyAiCompanionOperation({
      operation,
      authority: { ...trustedAuthority, task_id: taskId, account_ref: intent.account_ref, surface: "aos_chrome_companion_profile_instance", payload_hash: trustedAuthority.payload_hash, target_key: targetKey },
      client,
      afterTransaction: async (context) => {
        const observed = await readDailyAiProviderAfterTransaction({ ...context, operation });
        const proof = validateDailyAiProviderReadback(observed.provider_readback, {
          run_id: input.run_id, task_id: operation.task_id, approval_id: operation.approval_id,
          platform: targetMatch[2], account_ref: operation.account_ref, target_key: operation.target_key,
          content_key: operation.target_key.slice(0, -(`:${targetMatch[2]}`).length), approvedPayloadHash: operation.payload_hash,
          observedTabId: context.result?.tab?.id ?? context.result?.target?.tab_id ?? context.result?.task_tab?.tabId,
          observedSessionId: context.session.sessionId,
        });
        return { provider_readback: proof, provider_readback_path: persistProviderReadback(outputDir, proof) };
      },
    });
    let providerReadback = adapterReceipt?.provider_readback || null;
    let providerReadbackPath = adapterReceipt?.provider_readback_path || null;
    try {
      providerReadback = validateDailyAiProviderReadback(providerReadback, {
        run_id: input.run_id, task_id: operation.task_id, approval_id: operation.approval_id,
        platform: targetMatch[2], account_ref: operation.account_ref, target_key: operation.target_key,
        content_key: operation.target_key.slice(0, -(`:${targetMatch[2]}`).length), approvedPayloadHash: operation.payload_hash,
        observedTabId: adapterReceipt?.target?.tab_id || adapterReceipt?.tab_id,
        observedSessionId: adapterReceipt?.session?.session_id,
      });
    } catch (error) {
      providerReadback = null;
    }
    const postflight = providerReadback
      ? commitProviderReadback(outputDir, providerReadback, dailyAiQueuePath(), isolated)
      : null;
    const queueSyncVerified = companionQueueSyncVerified(postflight, { ...operation, platform: targetMatch[2], content_key: queueBinding.content_key });
    const reconciliation = adapterReceipt?.reconciliation?.verified === true
      ? adapterReceipt.reconciliation
      : (adapterReceipt?.reconciliation_required === false || adapterReceipt?.outcome?.reconciliation_required === false)
        ? { attempted: false, required: false, verified: true, replayed: false, reason: "broker_explicitly_not_required" }
        : adapterReceipt?.reconciliation || { attempted: false, required: null, verified: false, replayed: false };
    const reconciliationVerified = reconciliation.verified === true;
    const complete = Boolean(providerReadback) && Boolean(queueSyncVerified) && reconciliationVerified && adapterReceipt?.cleanup_verified === true;
    const receipt = {
      schema: "aos.daily_ai_companion_business_receipt.v1",
      workflow_id: input.workflow_id,
      run_id: input.run_id,
      step_id: input.step_id,
      browser_surface: "aos_chrome_companion_profile_instance",
      operation: { task_id: operation.task_id, approval_id: operation.approval_id, account_ref: operation.account_ref, target_key: operation.target_key, content_key: queueBinding.content_key, platform: targetMatch[2], queue_path: queueBinding.queue_path, payload_hash: operation.payload_hash },
      adapter_receipt: adapterReceipt,
      broker_identity_path: brokerIdentityPath,
      provider_readback: providerReadback,
      provider_readback_path: providerReadbackPath,
      postflight_sync: postflight,
      reconciliation,
      web_operation_lifecycle: null,
      external_action_executed: adapterReceipt?.external_action_executed === true,
      same_run_receipt: complete,
      cleanup_verified: adapterReceipt?.cleanup_verified === true,
      status: complete ? "complete" : "blocked",
      exact_blocker: complete ? null : adapterReceipt?.external_action_executed === true
        ? (!providerReadback ? "daily_ai_companion_provider_readback_contract_missing" : !queueSyncVerified ? (postflight?.exact_blocker || "daily_ai_companion_queue_sync_missing") : !reconciliationVerified ? "daily_ai_companion_reconciliation_unverified" : "daily_ai_companion_cleanup_unverified")
        : "daily_ai_companion_effect_not_confirmed",
      no_replay: true,
    };
    receipt.web_operation_lifecycle = companionLifecycle({ input, authority: trustedAuthority, receipt });
    const receiptPath = path.join(outputDir, "daily-ai-companion-receipt.json");
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    return { ...receipt, receipt_path: receiptPath };
  } finally {
    try { client.close?.(); } catch { /* receipt remains authoritative */ }
  }
}
function parseLastJson(stdout) {
  for (const line of String(stdout || "").split(/\r?\n/u).map((value) => value.trim()).filter(Boolean).reverse()) {
    try { const parsed = JSON.parse(line); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed; } catch (_) { /* progress output */ }
  }
  return null;
}
function registeredRunnerPath() {
  const configured = String(process.env.AUTOMATION_OS_DAILY_AI_BROWSER_USE_RUNNER || DEFAULT_REGISTERED_RUNNER).trim();
  if (!path.isAbsolute(configured)) throw new Error("daily_ai_browser_use_cli_registered_runner_path_invalid");
  if (!fs.existsSync(configured) || !fs.statSync(configured).isFile()) throw new Error("daily_ai_browser_use_cli_registered_runner_missing");
  const source = fs.readFileSync(configured, "utf8");
  if (!/(?:browser[_-]?use[_-]?cli|stage-adapter|codex-browser-use)/iu.test(source)) throw new Error("daily_ai_browser_use_cli_registered_runner_surface_invalid");
  return configured;
}
function readJsonRecord(file, root) {
  const candidate = path.resolve(String(file || ""));
  const base = path.resolve(root);
  if (!candidate || (candidate !== base && !candidate.startsWith(`${base}${path.sep}`)) || !fs.existsSync(candidate)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (_) { return null; }
}
function targetDigestForBundle(bundle) {
  const keys = [
    "account_ref", "target_key", "payload_hash", "content_key", "product_key", "asset_manifest_id",
    "job_url", "application_url", "candidate_key", "bucket", "sequence", "attempt",
    "source_snapshot_id", "supply_run_id", "company", "role", "target_digest", "source_state_digest",
  ];
  const value = Object.fromEntries(keys.filter((key) => Object.hasOwn(bundle, key)).map((key) => [key, bundle[key]]));
  return digest(Buffer.from(JSON.stringify(value)));
}
function readTargetBoundInputBundle(input, authority) {
  const rawPath = String(
    process.env.AUTOMATION_OS_PORTABLE_BUSINESS_INPUT_BUNDLE_PATH
      || process.env.AUTOMATION_OS_PORTABLE_EXTERNAL_INPUT_BUNDLE_PATH
      || "",
  ).trim();
  if (!rawPath || !path.isAbsolute(rawPath) || !fs.existsSync(rawPath)) {
    throw new Error("daily_ai_business_input_bundle_missing");
  }
  const stat = fs.lstatSync(rawPath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
    throw new Error("daily_ai_business_input_bundle_permissions_invalid");
  }
  let document;
  try {
    document = JSON.parse(fs.readFileSync(rawPath, "utf8"));
  } catch {
    throw new Error("daily_ai_business_input_bundle_json_invalid");
  }
  const bundle = document && typeof document === "object" && !Array.isArray(document)
    ? document.input
    : null;
  if (document?.schema !== "automation_os_portable_workflow_input_bundle.v1"
    || document.workflow_id !== "daily-ai-research-publish-run"
    || document.run_id !== input.run_id
    || !bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("daily_ai_business_input_bundle_binding_invalid");
  }
  const contentKey = String(bundle.content_key || "").trim();
  const targetKey = String(bundle.target_key || "").trim();
  const targetMatch = targetKey.match(/^(.+):(x|linkedin)$/u);
  if (!contentKey || !targetMatch || targetMatch[1] !== contentKey) {
    throw new Error("daily_ai_business_target_binding_invalid");
  }
  if (targetDigestForBundle(bundle) !== authority.target_digest
    || String(bundle.payload_hash || "") !== authority.payload_hash) {
    throw new Error("daily_ai_business_target_binding_digest_mismatch");
  }
  return { path: rawPath, bundle, content_key: contentKey, target_key: targetKey, platform: targetMatch[2] };
}
function hasText(value) { return typeof value === "string" && value.trim().length > 0; }
function dailyBusinessProofs(summary, runId) {
  if (!summary || typeof summary !== "object") return null;
  const publish = summary.direct_publish && typeof summary.direct_publish === "object" ? summary.direct_publish : {};
  const feed = summary.post_publish_feed_study && typeof summary.post_publish_feed_study === "object" ? summary.post_publish_feed_study : {};
  const engagement = summary.direct_engagement && typeof summary.direct_engagement === "object" ? summary.direct_engagement : {};
  const postflight = summary.postflight_sync && typeof summary.postflight_sync === "object" ? summary.postflight_sync : {};
  const cleanup = summary.cleanup_proof && typeof summary.cleanup_proof === "object" ? summary.cleanup_proof : {};
  return {
    publish_url_or_exact_blocker: Boolean((Array.isArray(publish.receipts) && publish.receipts.some((item) => hasText(item?.post_url))) || publish.no_candidate_proof === true || hasText(publish.exact_blocker || publish.stop_reason)),
    feed_study_or_exact_blocker: Boolean(hasText(feed.artifact) || feed.no_candidate_proof === true || hasText(feed.exact_blocker || feed.stop_reason)),
    engagement_or_no_candidate_proof: Boolean((Array.isArray(engagement.receipts) && engagement.receipts.length > 0) || engagement.no_candidate_proof === true || hasText(engagement.exact_blocker || engagement.stop_reason)),
    queue_sync: Boolean(postflight.run_id === runId && postflight.queue_readback && hasText(postflight.queue_readback.sha256)),
    cleanup_receipt: cleanup.cleanup_verified === true,
  };
}
function dailySameRunSourceSync(summary, runId) {
  return Boolean(summary && summary.postflight_sync?.run_id === runId && summary.postflight_sync?.status === "completed" && summary.postflight_sync?.queue_readback?.sha256);
}
function dailySourceStateDigest(summary, receipt, outputDir) {
  const queueDigest = String(summary?.postflight_sync?.queue_readback?.sha256 || "");
  if (/^[a-f0-9]{64}$/u.test(queueDigest)) return queueDigest;
  const summaryPath = path.resolve(String(receipt?.summary_path || ""));
  const root = path.resolve(outputDir);
  if (summaryPath === root || !summaryPath.startsWith(`${root}${path.sep}`) || !fs.existsSync(summaryPath)) return null;
  try { return digest(fs.readFileSync(summaryPath)); } catch (_) { return null; }
}
function runRegisteredRunner(input, outputDir, runner, targetBinding) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runner], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        DAILY_AI_CLI_RUN_ID: input.run_id,
        DAILY_AI_CLI_OUTPUT_DIR: outputDir,
        DAILY_AI_QUEUE_PATH: QUEUE_PATH,
        DAILY_AI_CLI_ALLOW_POSTFLIGHT_SYNC: "0",
        DAILY_AI_CLI_PUBLISH_ONLY_IDS: JSON.stringify([targetBinding.content_key]),
        DAILY_AI_CLI_PUBLISH_ONLY_PLATFORMS: JSON.stringify([targetBinding.platform]),
        DAILY_AI_CLI_MAX_PUBLISH_ACTIONS: "1",
        DAILY_AI_CLI_SKIP_ENGAGEMENT: "1",
        AUTOMATION_OS_DAILY_AI_APPROVED_PAYLOAD_HASH: targetBinding.bundle.payload_hash,
        AUTOMATION_OS_DAILY_AI_APPROVED_TARGET_KEY: targetBinding.target_key,
        AUTOMATION_OS_DAILY_AI_ACCOUNT_REF: String(targetBinding.bundle.account_ref || ""),
        AUTOMATION_OS_WEB_OPERATION_CONTRACT_SCHEMA: WEB_OPERATION_CONTRACT.schema,
        AUTOMATION_OS_WEB_OPERATION_ADAPTIVE: "semantic_live_state_bounded_exploration",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => resolve({ code: null, signal: null, stdout, stderr, error: String(error?.message || error) }));
    child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
async function main(argv = process.argv.slice(2)) {
  let input;
  try {
    input = parseArgs(argv);
    if (input.workflow_id !== "daily-ai-research-publish-run") return output({ exact_blocker: "daily_ai_business_workflow_invalid", run_id: input.run_id, step_id: input.step_id });
    const admission = readAdmission(input);
    if (/^(?:1|true|yes|on)$/iu.test(String(process.env.AUTOMATION_OS_PORTABLE_BUSINESS_NO_LAUNCH || ""))) {
      return output({ status: "blocked", exact_blocker: "daily_ai_browser_use_cli_no_launch_canary", browser_surface: admission.browser_surface, run_id: input.run_id, step_id: input.step_id, same_run_receipt: true, cleanup_verified: true });
    }
    if (admission.browser_surface === "aos_chrome_companion_profile_instance") {
      const authority = readPortableBusinessEffectAuthority(input);
      const targetBinding = readTargetBoundInputBundle(input, authority);
      const artifactRoot = path.resolve(process.env.AUTOMATION_OS_ARTIFACT_ROOT?.trim() || path.join(process.cwd(), "data", "artifacts"));
      const outputDir = path.join(artifactRoot, input.run_id, "business-run", "daily-ai");
      fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
      const receipt = await runDailyAiCompanionBranch({ input, targetBinding, outputDir, authority });
      return output({ status: receipt.status, exact_blocker: receipt.exact_blocker, browser_surface: admission.browser_surface, external_action_executed: receipt.external_action_executed, same_run_receipt: receipt.same_run_receipt, cleanup_verified: receipt.cleanup_verified, run_id: input.run_id, step_id: input.step_id, web_operation_lifecycle: receipt.web_operation_lifecycle, runner_receipt: { ...receipt, selected_branch: "aos_chrome_companion" } }, receipt.status === "complete" ? 0 : 1);
    }
    const runner = registeredRunnerPath();
    if (!fs.existsSync(QUEUE_PATH) || !fs.statSync(QUEUE_PATH).isFile()) return output({ exact_blocker: "daily_ai_browser_use_cli_queue_missing", run_id: input.run_id, step_id: input.step_id });
    const authority = readPortableBusinessEffectAuthority(input);
    const targetBinding = readTargetBoundInputBundle(input, authority);
    const actionPlan = readPortableBusinessActionPlan({
      workflowId: input.workflow_id,
      runId: input.run_id,
      stepId: input.step_id,
      sourceTrigger: input.source_trigger,
      idempotencyKey: input.idempotency_key,
    });
    const artifactRoot = path.resolve(process.env.AUTOMATION_OS_ARTIFACT_ROOT?.trim() || path.join(process.cwd(), "data", "artifacts"));
    const outputDir = path.join(artifactRoot, input.run_id, "business-run", "daily-ai");
    fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    const child = await runRegisteredRunner(input, outputDir, runner, targetBinding);
    const receipt = parseLastJson(child.stdout);
    const summary = readJsonRecord(receipt?.summary_path, outputDir);
    const businessProofs = dailyBusinessProofs(summary, input.run_id);
    const sameRunSourceSync = dailySameRunSourceSync(summary, input.run_id);
    const external = receipt?.external_action_executed === true;
    const cleanup = receipt?.cleanup_verified === true;
    const status = receipt?.status === "complete" || receipt?.status === "partial" || receipt?.status === "blocked" ? receipt.status : "blocked";
    const exactBlocker = receipt?.exact_blocker || (child.error ? "daily_ai_browser_use_cli_registered_runner_spawn_failed" : "daily_ai_browser_use_cli_business_proof_incomplete");
    const sameRunReceipt = Boolean(receipt?.same_run_receipt && receipt?.run_id === input.run_id);
    const webOperationLifecycle = buildPortableBusinessWebOperationLifecycle({
      run_id: input.run_id,
      step_id: input.step_id,
      idempotency_key: input.idempotency_key,
      operation: "publish",
      authority,
      external_action_executed: external,
      same_run_receipt: sameRunReceipt,
      readback_verified: sameRunSourceSync,
      cleanup_verified: cleanup,
      source_state_digest: dailySourceStateDigest(summary, receipt, outputDir),
      exact_blocker: external && status === "complete" && !receipt?.exact_blocker ? null : exactBlocker,
    });
    return output({ status, exact_blocker: exactBlocker, external_action_executed: external, same_run_receipt: sameRunReceipt, cleanup_verified: cleanup, run_id: input.run_id, step_id: input.step_id, web_operation_contract: actionPlan.value.web_operation_contract, web_operation_lifecycle: webOperationLifecycle, runner_receipt: { selected_branch: "browser_use_cli", child_exit_status: child.code, child_signal: child.signal, output_dir: outputDir, action_plan_sha256: actionPlan.sha256, web_operation_contract_schema: actionPlan.value.web_operation_contract.schema, ...(businessProofs ? { business_proofs: businessProofs } : {}), ...(sameRunSourceSync ? { same_run_source_sync: true } : {}) } }, status === "complete" && !receipt?.exact_blocker ? 0 : 1);
  } catch (error) {
    return output({ exact_blocker: String(error?.message || error || "daily_ai_business_failed").slice(0, 240), browser_surface: selectedSurfaceFromEnvironment(), run_id: input?.run_id, step_id: input?.step_id, runner_receipt: { selected_branch: "preselection_or_branch_error", binding_diagnostic: bindingDiagnostic() } });
  }
}
main().then((code) => { process.exitCode = code; });

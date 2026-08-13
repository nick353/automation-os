import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { validateWebOperationIntent } from "./portable-business-action-plan.mjs";
import {
  createBrowserUseGoalKernel,
  ensureBrowserUseGoalFlow,
  finalizeBrowserUseGoalFlow,
} from "./browser-use-goal-kernel.mjs";
import { portableBrowserUsePaths } from "./portable-worker-profile.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const EFFECT_CLAIM_SCHEMA = "automation_os_web_operation_effect_claim.v1";

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function safeRunRoot(runId, environment = process.env) {
  const artifactRoot = path.resolve(String(environment.AUTOMATION_OS_ARTIFACT_ROOT || path.join(process.cwd(), "data", "artifacts")));
  const runRoot = path.resolve(artifactRoot, runId);
  const relative = path.relative(artifactRoot, runRoot);
  if (!runRoot.startsWith(`${artifactRoot}${path.sep}`) || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("portable_external_run_root_invalid");
  return runRoot;
}

function privateJsonStat(filePath, code) {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch { throw new Error(code); }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.uid !== currentUid || (stat.mode & 0o777) !== 0o600) throw new Error(code);
  return stat;
}

function writePrivateJsonCreate(filePath, value) {
  const resolved = path.resolve(filePath);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = fs.openSync(resolved, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | noFollow, 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  fs.chmodSync(resolved, 0o600);
  return { path: resolved, sha256: sha256(bytes) };
}

function writePrivateJsonReplace(filePath, value) {
  const resolved = path.resolve(filePath);
  const parent = path.dirname(resolved);
  const temporary = path.join(parent, `.tmp-${randomUUID()}`);
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(temporary, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, resolved);
    fs.chmodSync(resolved, 0o600);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch (_) { /* preserve the primary error */ }
  }
  return { path: resolved, sha256: sha256(bytes) };
}

function readEffectClaim(claimPath, input, intent) {
  privateJsonStat(claimPath, "portable_external_web_operation_idempotency_claim_invalid");
  let claim;
  try { claim = JSON.parse(fs.readFileSync(claimPath, "utf8")); } catch { throw new Error("portable_external_web_operation_idempotency_claim_invalid"); }
  if (!claim || typeof claim !== "object" || Array.isArray(claim)
    || claim.schema !== EFFECT_CLAIM_SCHEMA
    || claim.workflow_id !== input.workflow_id
    || claim.run_id !== input.run_id
    || claim.step_id !== input.step_id
    || claim.idempotency_key !== input.idempotency_key
    || claim.operation !== intent.operation
    || claim.target_digest !== intent.target_binding.target_digest
    || claim.payload_hash !== intent.payload_hash) {
    throw new Error("portable_external_web_operation_idempotency_claim_binding_invalid");
  }
  return claim;
}

function claimEffectAttempt(input, intent, authority, environment = process.env) {
  const runRoot = safeRunRoot(input.run_id, environment);
  const claimPath = path.join(runRoot, "web-operation-effect-claim.v1.json");
  if (fs.existsSync(claimPath)) return { path: claimPath, existing: readEffectClaim(claimPath, input, intent) };
  const claim = {
    schema: EFFECT_CLAIM_SCHEMA,
    status: "claimed",
    workflow_id: input.workflow_id,
    run_id: input.run_id,
    step_id: input.step_id,
    idempotency_key: input.idempotency_key,
    operation: intent.operation,
    target_digest: intent.target_binding.target_digest,
    source_state_digest: intent.target_binding.source_state_digest,
    payload_hash: intent.payload_hash,
    authority_sha256: authority.sha256,
    external_action_executed: false,
    cleanup_verified: false,
    readback_verified: false,
    same_run_receipt: false,
    no_replay: true,
    claimed_at: new Date().toISOString(),
  };
  try {
    return { ...writePrivateJsonCreate(claimPath, claim), body: claim };
  } catch (error) {
    if (error?.code === "EEXIST" || fs.existsSync(claimPath)) return { path: claimPath, existing: readEffectClaim(claimPath, input, intent) };
    throw new Error("portable_external_web_operation_idempotency_claim_write_failed");
  }
}

function duplicateAttemptReceipt(input, intent, route, authority, claim) {
  const externalActionExecuted = claim.external_action_executed === true;
  const lifecycle = {
    schema: "automation_os_web_operation_lifecycle.v1",
    state: "effect_unknown",
    status: "blocked",
    exact_blocker: "portable_external_web_operation_duplicate_idempotency_key",
    restart_point: externalActionExecuted ? "same-run source-of-truth reconciliation; do not replay" : "use a new idempotency key only after confirming the prior claim had no effect",
    run_id: input.run_id,
    step_id: input.step_id,
    idempotency_key: input.idempotency_key,
    operation: intent.operation,
    target_digest: claim.target_digest,
    source_state_digest: claim.source_state_digest,
    payload_hash: claim.payload_hash,
    external_action_executed: externalActionExecuted,
    same_run_receipt: false,
    readback_verified: claim.readback_verified === true,
    cleanup_verified: claim.cleanup_verified === true,
    no_replay: true,
  };
  return {
    status: "blocked",
    exact_blocker: lifecycle.exact_blocker,
    external_action_executed: externalActionExecuted,
    browser_surface: "browser_use_cli",
    workflow_id: input.workflow_id,
    run_id: input.run_id,
    step_id: input.step_id,
    operation: intent.operation,
    generic_web_operation: true,
    effects_mode: "enabled",
    authority_path: authority.path,
    authority_sha256: authority.sha256,
    target_digest: claim.target_digest,
    source_state_digest: claim.source_state_digest,
    payload_hash: claim.payload_hash,
    dispatch_state: externalActionExecuted ? "unknown" : "not_attempted",
    requested_origin: route.allowed_origins[0] || "",
    cleanup_verified: claim.cleanup_verified === true,
    readback_verified: claim.readback_verified === true,
    same_run_receipt: false,
    web_operation_lifecycle: lifecycle,
    effect_claim_path: claim.path || "",
  };
}

function persistEffectClaim(claim, result) {
  const lifecycle = result.web_operation_lifecycle || {};
  const body = {
    ...claim.body,
    status: result.status,
    lifecycle_state: lifecycle.state || "blocked",
    exact_blocker: result.exact_blocker || null,
    external_action_executed: result.external_action_executed === true,
    cleanup_verified: result.cleanup_verified === true,
    readback_verified: result.readback_verified === true,
    same_run_receipt: result.same_run_receipt === true,
    completed_at: new Date().toISOString(),
  };
  writePrivateJsonReplace(claim.path, body);
  return body;
}

function readEffectAuthority(input, intent, environment = process.env) {
  const runRoot = safeRunRoot(input.run_id, environment);
  const configuredPath = path.resolve(String(environment.AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_PATH || ""));
  const expectedPath = path.join(runRoot, "portable-effect-authority.v1.json");
  const expectedSha = String(environment.AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_SHA256 || "");
  const expectedId = String(environment.AUTOMATION_OS_PORTABLE_EFFECT_AUTHORITY_ID || "");
  if (!configuredPath || configuredPath !== expectedPath || !HASH.test(expectedSha) || !expectedId) throw new Error("portable_external_effect_authority_missing");
  let stat;
  let bytes;
  try {
    stat = fs.lstatSync(configuredPath);
    bytes = fs.readFileSync(configuredPath);
  } catch {
    throw new Error("portable_external_effect_authority_missing");
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.uid !== currentUid || (stat.mode & 0o777) !== 0o600) throw new Error("portable_external_effect_authority_permissions_invalid");
  if (sha256(bytes) !== expectedSha) throw new Error("portable_external_effect_authority_digest_invalid");
  let authority;
  try { authority = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("portable_external_effect_authority_invalid"); }
  if (!authority || typeof authority !== "object" || Array.isArray(authority)
    || authority.schema !== "automation_os_portable_external_effect_authority.v1"
    || authority.authority_id !== expectedId
    || authority.workflow_id !== input.workflow_id
    || authority.run_id !== input.run_id
    || authority.step_id !== input.step_id
    || authority.idempotency_key !== input.idempotency_key
    || authority.approval_status !== "approved"
    || authority.external_action_authorized !== true
    || authority.reconciliation_required !== true
    || authority.no_auto_retry !== true
    || !HASH.test(String(authority.target_digest || ""))
    || !HASH.test(String(authority.input_bundle_sha256 || ""))
    || !HASH.test(String(authority.payload_hash || ""))
    || Date.parse(String(authority.expires_at || "")) <= Date.now()) throw new Error("portable_external_effect_authority_binding_invalid");
  if (intent.authority_sha256 && intent.authority_sha256 !== expectedSha) throw new Error("portable_external_effect_authority_intent_digest_mismatch");
  if (authority.payload_hash !== intent.payload_hash) throw new Error("portable_external_effect_authority_payload_mismatch");
  if (authority.effect_stage !== "web_operation_effect") throw new Error("portable_external_effect_authority_stage_invalid");
  return { authority, path: configuredPath, sha256: expectedSha };
}

function materializeBrowserGoalAuthority(input, route, intent, effectAuthority, environment = process.env) {
  const runRoot = safeRunRoot(input.run_id, environment);
  const stageId = `aos-${route.automation_id}-${input.workflow_id}-goal`;
  const session = `aos-${sha256(`${input.run_id}:${route.automation_id}:${input.workflow_id}:goal`).slice(0, 20)}-goal`;
  const authorityPath = path.join(runRoot, "browser-use-goal-authority.v1.json");
  const now = Date.now();
  const body = {
    schema: "authority.v1",
    version: "1",
    automation_id: route.automation_id,
    stage_id: stageId,
    mode: "authorized",
    browser_surface: "browser_use_cli",
    run_id: input.run_id,
    session,
    not_before: new Date(now - 1000).toISOString(),
    expires_at: String(effectAuthority.authority.expires_at),
    allowed_origins: [...route.allowed_origins],
    account_identity: intent.account_ref,
    data_exposure: "target_bound_external_effect",
    side_effect_scope: "web_operation_effect",
    approval: {
      approved: true,
      subject: effectAuthority.authority.authority_id,
      source: "automation_os_portable_controller",
      scope: "web_operation_effect",
      approved_at: String(effectAuthority.authority.issued_at),
    },
    readback_required: true,
    no_fallback: true,
    helper_path: portableBrowserUsePaths(environment).helper,
    runtime_config_path: portableBrowserUsePaths(environment).runtimeConfig,
  };
  const bytes = `${JSON.stringify(body, null, 2)}\n`;
  if (fs.existsSync(authorityPath)) {
    privateJsonStat(authorityPath, "portable_external_browser_goal_authority_invalid");
    if (fs.readFileSync(authorityPath, "utf8") !== bytes) throw new Error("portable_external_browser_goal_authority_immutable_collision");
  } else {
    writePrivateJsonCreate(authorityPath, body);
  }
  return { path: authorityPath, sha256: sha256(bytes), stageId, session };
}

function targetResult(flow) {
  const result = flow?.target_result && typeof flow.target_result === "object" ? flow.target_result : {};
  return result;
}

function targetCandidate(flow) {
  const result = targetResult(flow);
  const candidate = result.candidate;
  return candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : null;
}

function targetPresent(flow) {
  const candidate = targetCandidate(flow);
  return Boolean(candidate) && String(candidate.match_status || "") !== "not_found" && candidate.backend_present !== false;
}

function targetDigest(flow) {
  return String(targetCandidate(flow)?.match_text_sha256 || "");
}

function sourceStateDigest(flow) {
  const result = targetResult(flow);
  const before = result.before_state || result.before;
  return before && typeof before === "object" ? String(before.state_sha256 || "") : "";
}

function errorCode(error) {
  return String(error?.exact_blocker || error?.message || error || "portable_external_web_operation_effect_failed").slice(0, 240);
}

function preDispatchBlocker(code) {
  return /target_(?:not_found|ambiguous|inspect_failed)|target_coordinate_fallback_requires_explicit_opt_in|authority|origin_mismatch|navigation_readback_required|action_plan/iu.test(code);
}

function nextActionNonce(input, flow, label) {
  const sequence = Number(flow?.contract?.action_sequence || 0) + 1;
  return { sequence, nonce: `${input.run_id}-${label}-${sequence}-${randomUUID()}` };
}

function defaultReadback(intent) {
  return {
    semantic_query: intent.target.semantic_query,
    ...(intent.target.target_key ? { target_key: intent.target.target_key } : {}),
    expected: intent.operation === "delete" ? "absent" : "present",
  };
}

function safeEffectReceipt({ input, intent, route, authority, flow, finalized, externalActionExecuted, readbackVerified, exactBlocker, dispatchState, targetDigestValue, sourceStateDigestValue }) {
  const cleanupVerified = finalized?.finalized === true;
  const complete = !exactBlocker && externalActionExecuted && readbackVerified && cleanupVerified;
  const lifecycle = {
    schema: "automation_os_web_operation_lifecycle.v1",
    state: complete ? "cleaned" : externalActionExecuted && !readbackVerified ? "effect_unknown" : exactBlocker ? "blocked" : "readback_required",
    status: complete ? "complete" : "blocked",
    exact_blocker: complete ? null : exactBlocker || (externalActionExecuted ? "web_operation_source_readback_required" : "web_operation_no_effect_dispatched"),
    restart_point: complete ? null : externalActionExecuted ? "same-run source-of-truth reconciliation; do not replay" : "fresh target-bound admission; use a new idempotency key for a new attempt",
    run_id: input.run_id,
    step_id: input.step_id,
    idempotency_key: input.idempotency_key,
    operation: intent.operation,
    target_digest: targetDigestValue || authority.target_digest,
    source_state_digest: sourceStateDigestValue || intent.target_binding?.source_state_digest || null,
    payload_hash: intent.payload_hash,
    external_action_executed: externalActionExecuted,
    same_run_receipt: complete,
    readback_verified: readbackVerified,
    cleanup_verified: cleanupVerified,
    no_replay: true,
  };
  return {
    status: complete ? "complete" : "blocked",
    exact_blocker: lifecycle.exact_blocker,
    external_action_executed: externalActionExecuted,
    browser_surface: "browser_use_cli",
    workflow_id: input.workflow_id,
    run_id: input.run_id,
    step_id: input.step_id,
    operation: intent.operation,
    generic_web_operation: true,
    effects_mode: "enabled",
    authority_path: authority.path,
    authority_sha256: authority.sha256,
    target_digest: targetDigestValue || authority.target_digest,
    source_state_digest: sourceStateDigestValue || intent.target_binding?.source_state_digest || null,
    payload_hash: intent.payload_hash,
    dispatch_state: dispatchState,
    requested_origin: route.allowed_origins[0] || "",
    cleanup_verified: cleanupVerified,
    readback_verified: readbackVerified,
    same_run_receipt: complete,
    web_operation_lifecycle: lifecycle,
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
        verified: readbackVerified,
        candidate_present: targetPresent(flow),
        candidate_digest: targetDigest(flow),
      },
    },
  };
}

/**
 * Execute a provider-neutral, target-bound Web operation.  The site-specific
 * part is only the account/origin route registry; every live interaction is
 * re-resolved from semantic target text in the same Browser Use flow.
 * `adapterOverride` exists only for deterministic fixture tests after the
 * contract and authority checks have run.
 */
export async function runAdaptiveWebOperationEffect(input, route, rawIntent, environment = process.env, adapterOverride = null) {
  const intent = validateWebOperationIntent(rawIntent);
  if (intent.operation === "read") throw new Error("portable_external_web_operation_effect_requires_mutation");
  if (intent.approval_status !== "approved") throw new Error("portable_external_web_operation_approval_required");
  if (!route || route.public_lane === true || route.mode !== "authorized" || route.lifecycle !== "scheduled") throw new Error("portable_external_web_operation_effect_authorized_route_required");
  if (!intent.entry_url) throw new Error("portable_external_web_operation_entry_url_required");
  if (!intent.target_binding) throw new Error("portable_external_web_operation_target_binding_missing");
  if (!intent.action_plan) throw new Error("portable_external_web_operation_action_plan_missing");
  const authority = readEffectAuthority(input, intent, environment);
  if (authority.authority.target_digest !== intent.target_binding.target_digest) throw new Error("portable_external_effect_authority_target_mismatch");
  const claim = claimEffectAttempt(input, intent, authority, environment);
  if (claim.existing) return duplicateAttemptReceipt(input, intent, route, authority, { ...claim.existing, path: claim.path });

  const testAdapterPath = String(environment.AUTOMATION_OS_WEB_OPERATION_TEST_ADAPTER || "").trim();
  const adapter = adapterOverride
    || (environment.CODEX_BROWSER_USE_TEST_SEAM === "1" && testAdapterPath && path.isAbsolute(testAdapterPath)
      ? await import(pathToFileURL(testAdapterPath).href)
      : await import(pathToFileURL(portableBrowserUsePaths(environment).stageAdapter).href));
  safeRunRoot(input.run_id, environment);
  const browserAuthority = materializeBrowserGoalAuthority(input, route, intent, authority, environment);
  const goalKernel = createBrowserUseGoalKernel({
    input: { ...input, source_trigger: input.source_trigger || "codex_app_bridge" },
    environment,
    adapter,
  });
  const goalSpec = {
    automationId: route.automation_id,
    stageId: browserAuthority.stageId,
    session: browserAuthority.session,
    mode: "authorized",
    lifecycle: "scheduled",
    authorityPath: browserAuthority.path,
    authoritySha256: browserAuthority.sha256,
    allowedOrigins: [...route.allowed_origins],
    port: route.port,
    approval: "approved",
    effectful: true,
    currentStage: input.step_id,
    externalActionExecuted: false,
    effectUnknown: false,
  };
  let flow = null;
  let finalized = null;
  let externalActionExecuted = false;
  let dispatchState = "not_attempted";
  let readbackVerified = false;
  let exactBlocker = null;
  let resolvedTargetDigest = "";
  let resolvedSourceStateDigest = "";
  try {
    const ensured = await ensureBrowserUseGoalFlow({ kernel: goalKernel, spec: goalSpec });
    flow = ensured.flow;

    const nonce = nextActionNonce(input, flow, "open");
    flow = await adapter.runBrowserUseCliFlowCommand({ flow, authorityPath: browserAuthority.path, command: ["open", intent.entry_url], actionSequence: nonce.sequence - 1, actionNonce: nonce.nonce, captureReadback: true });
    const initialNonce = nextActionNonce(input, flow, "target");
    flow = await adapter.runBrowserUseCliFlowTargetInspect({ flow, authorityPath: browserAuthority.path, targetText: intent.target.semantic_query, actionSequence: initialNonce.sequence - 1, actionNonce: initialNonce.nonce });
    resolvedTargetDigest = targetDigest(flow);
    resolvedSourceStateDigest = sourceStateDigest(flow);
    if (!targetPresent(flow)) throw new Error("web_operation_target_not_found");
    if (resolvedTargetDigest !== intent.target_binding.target_digest) throw new Error("web_operation_target_binding_mismatch");
    if (resolvedSourceStateDigest !== intent.target_binding.source_state_digest) throw new Error("web_operation_source_state_binding_mismatch");

    const runCommand = async (command, label, businessEffect = false) => {
      const action = nextActionNonce(input, flow, label);
      if (businessEffect) {
        dispatchState = "executed";
        externalActionExecuted = true;
      }
      flow = await adapter.runBrowserUseCliFlowCommand({ flow, authorityPath: browserAuthority.path, command, actionSequence: action.sequence - 1, actionNonce: action.nonce, captureReadback: false });
    };
    const runTargetClick = async (targetText, label) => {
      const action = nextActionNonce(input, flow, label);
      dispatchState = "executed";
      externalActionExecuted = true;
      flow = await adapter.runBrowserUseCliFlowTargetClick({ flow, authorityPath: browserAuthority.path, targetText, actionSequence: action.sequence - 1, actionNonce: action.nonce });
    };

    for (const [index, step] of intent.action_plan.steps.entries()) {
      if (step.action === "open") await runCommand(["open", step.url], `open-${index}`);
      else if (step.action === "click_target") await runTargetClick(step.target.semantic_query, `click-${index}`);
      else if (step.action === "fill_target") {
        await runTargetClick(step.target.semantic_query, `fill-target-${index}`);
        await runCommand(["type", intent.action_plan.payload[step.payload_key]], `fill-value-${index}`, true);
      } else if (step.action === "type") await runCommand(["type", intent.action_plan.payload[step.payload_key]], `type-${index}`, true);
      else if (step.action === "keys") await runCommand(["keys", step.key], `keys-${index}`, true);
      else if (step.action === "wait") await runCommand(["wait", String(step.seconds)], `wait-${index}`);
      else if (step.action === "scroll") await runCommand(["scroll", step.direction], `scroll-${index}`);
    }

    const readbackAction = nextActionNonce(input, flow, "readback-target");
    flow = await adapter.runBrowserUseCliFlowTargetInspect({
      flow,
      authorityPath: browserAuthority.path,
      targetText: intent.action_plan.readback.semantic_query,
      actionSequence: readbackAction.sequence - 1,
      actionNonce: readbackAction.nonce,
    });
    const present = targetPresent(flow);
    const expected = intent.action_plan.readback.expected;
    const readbackDigest = targetDigest(flow);
    readbackVerified = expected === "present"
      ? present
      : expected === "absent"
        ? !present
        : present && readbackDigest === resolvedTargetDigest;
    if (!readbackVerified) exactBlocker = "web_operation_source_readback_mismatch";
    const stateAction = nextActionNonce(input, flow, "readback-state");
    flow = await adapter.runBrowserUseCliFlowReadOnlyBatch({
      flow,
      authorityPath: browserAuthority.path,
      commands: [["get", "url"], ["get", "title"], ["state"]],
      actionSequence: stateAction.sequence - 1,
      actionNonces: [stateAction.nonce, `${stateAction.nonce}-2`, `${stateAction.nonce}-3`],
      captureReadback: true,
    });
  } catch (error) {
    const blocker = errorCode(error);
    if (!exactBlocker) exactBlocker = externalActionExecuted && !preDispatchBlocker(blocker) ? "web_operation_external_effect_reconciliation_required" : blocker;
    if (externalActionExecuted) dispatchState = "unknown";
  } finally {
    if (flow) {
      try {
        const goalState = await finalizeBrowserUseGoalFlow({
          kernel: goalKernel,
          authorityPath: browserAuthority.path,
          externalActionExecuted,
          effectUnknown: dispatchState === "unknown",
        });
        finalized = {
          ...goalState,
          finalized: goalState?.finalized === true || goalState?.status === "completed",
          cleanup_verified: goalState?.cleanup_verified === true || goalState?.status === "completed",
        };
      }
      catch (error) { if (!exactBlocker) exactBlocker = errorCode(error); }
    }
  }
  if (!finalized?.finalized) exactBlocker = exactBlocker || "portable_external_browser_use_cli_cleanup_unverified";
  const result = safeEffectReceipt({ input, intent, route, authority, flow, finalized, externalActionExecuted, readbackVerified, exactBlocker, dispatchState, targetDigestValue: resolvedTargetDigest, sourceStateDigestValue: resolvedSourceStateDigest });
  result.effect_claim_path = claim.path;
  try {
    persistEffectClaim(claim, result);
  } catch {
    const lifecycle = {
      ...result.web_operation_lifecycle,
      state: result.external_action_executed ? "effect_unknown" : "blocked",
      status: "blocked",
      exact_blocker: "portable_external_web_operation_lifecycle_persist_failed",
      restart_point: result.external_action_executed ? "same-run source-of-truth reconciliation; do not replay" : "do not replay; inspect the run-owned claim and issue a new idempotency key only after recovery",
      same_run_receipt: false,
    };
    return { ...result, status: "blocked", exact_blocker: lifecycle.exact_blocker, same_run_receipt: false, web_operation_lifecycle: lifecycle };
  }
  return result;
}

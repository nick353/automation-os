import { createHash } from "node:crypto";
import { validateWebOperationIntent } from "./portable-business-action-plan.mjs";
import {
  claimEffectAttempt,
  duplicateAttemptReceipt,
  errorCode,
  persistEffectClaim,
  preDispatchBlocker,
  readEffectAuthority,
} from "./web-operation-effect-executor.mjs";

export const AOS_CHROME_COMPANION_EFFECT_RECEIPT_SCHEMA = "aos.chrome_companion.provider_receipt.v1";
export const AOS_CHROME_COMPANION_EFFECT_SURFACE = "aos_chrome_companion_profile_instance";
export const AOS_CHROME_COMPANION_TASK_CONTRACT_SCHEMA = "aos.chrome_companion.task_contract.v1";

function sha256(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function exactTaskId(input, environment) {
  return String(input.task_id || environment.AOS_CHROME_COMPANION_TASK_ID || input.run_id || "").trim();
}

function locator(target) {
  const text = String(target?.semantic_query || "").trim();
  if (!text) throw new Error("web_operation_semantic_target_missing");
  const frameId = target?.frame_id ?? target?.frameId;
  return { text, ...(Number.isInteger(frameId) ? { frameId } : {}) };
}

function requiredCapabilitiesForActions(actions) {
  const capabilities = new Set(["page.snapshot", "page.screenshot", "page.query"]);
  for (const action of actions) {
    if (action.method === "page.selectOption") capabilities.add("page.inspectDropdown");
    if (action.method === "visual.click") capabilities.add("visual.inspectTarget");
    if (action.method === "page.type" && action.params?.physicalFallback === "on_verified_no_effect") capabilities.add("visual.inspectTarget");
    capabilities.add(action.method);
  }
  return [...capabilities].sort();
}

export function companionActionsForIntent(intent) {
  const actions = [];
  for (const step of intent.action_plan.steps) {
    if (step.action === "open") {
      if (new URL(step.url).href !== new URL(intent.entry_url).href) actions.push({ method: "tabs.navigate", params: { url: step.url } });
    } else if (step.action === "click_target") {
      actions.push({ method: "page.click", params: { locator: locator(step.target), ...(step.visual_fallback === true ? { visualFallback: "on_verified_no_effect" } : {}) } });
    } else if (step.action === "fill_target") {
      actions.push({
        method: "page.type",
        params: {
          locator: locator(step.target),
          text: intent.action_plan.payload[step.payload_key],
          clear: true,
          physicalFallback: "on_verified_no_effect",
        },
      });
    } else if (step.action === "type") {
      actions.push({ method: "page.type", params: { text: intent.action_plan.payload[step.payload_key], clear: false } });
    } else if (step.action === "keys") {
      actions.push({ method: "page.pressKey", params: { key: step.key } });
    } else if (step.action === "wait") {
      actions.push({ method: "page.delay", params: { milliseconds: Math.min(Math.max(Number(step.seconds) * 1_000, 0), 10_000) } });
    } else if (step.action === "scroll") {
      actions.push({ method: "page.scroll", params: { locator: step.target ? locator(step.target) : undefined, direction: step.direction, amount: 600 } });
    } else if (step.action === "select") {
      actions.push({
        method: "page.selectOption",
        params: {
          locator: locator(step.target),
          option: step.option,
          exact: true,
          autoVisualProof: true,
        },
      });
    } else if (step.action === "select_text") {
      actions.push({ method: "page.selectText", params: { locator: locator(step.target), text: intent.action_plan.payload[step.payload_key] } });
    } else if (step.action === "upload") {
      actions.push({ method: "page.upload", params: { locator: locator(step.target), filePath: intent.action_plan.payload[step.payload_key] } });
    } else if (step.action === "submit") {
      actions.push({ method: "page.submit", params: { locator: locator(step.target) } });
    } else {
      throw new Error(`web_operation_action_not_supported_by_companion:${step.action}`);
    }
  }
  const readbackTarget = intent.action_plan.readback.target
    ? locator(intent.action_plan.readback.target)
    : null;
  actions.push({ method: "page.query", params: { ...(readbackTarget?.frameId !== undefined ? { frameId: readbackTarget.frameId } : {}), query: intent.action_plan.readback.semantic_query, limit: 2 } });
  return actions;
}

function inputRecoveryFromReceipt(receipt) {
  const inputActions = Array.isArray(receipt?.actions)
    ? receipt.actions.filter((action) => action?.method === "page.type")
    : [];
  const physicalFallbackCount = inputActions.filter((action) => action?.result?.inputStrategy === "physical_fallback").length;
  return {
    policy: "semantic_then_verified_no_effect_physical_once",
    semantic_first: true,
    input_action_count: inputActions.length,
    physical_fallback_count: physicalFallbackCount,
    physical_fallback_used: physicalFallbackCount > 0,
    ambiguous_effect_replay_allowed: false,
  };
}

export function readbackFromReceipt(receipt, intent) {
  const action = Array.isArray(receipt?.actions)
    ? [...receipt.actions].reverse().find((candidate) => candidate?.method === "page.query")
    : null;
  const result = action?.method === "page.query" ? action.result : null;
  const count = Number(result?.count);
  const readbackSpec = intent.action_plan.readback;
  const expected = readbackSpec.expected;
  const verified = Number.isSafeInteger(count) && (
    expected === "present" ? count === 1
      : expected === "absent" ? count === 0
        : count === 1
  );
  const match = Array.isArray(result?.matches) && result.matches.length === 1 ? result.matches[0] : null;
  const stateChecks = [];
  if (readbackSpec.kind === "selection" && readbackSpec.expected_text !== undefined) {
    stateChecks.push(String(match?.selectedText ?? "") === String(readbackSpec.expected_text));
  }
  if (readbackSpec.kind === "control_state" && readbackSpec.expected_value !== undefined) {
    stateChecks.push(String(match?.value ?? match?.selectedText ?? "") === String(readbackSpec.expected_value));
  }
  if (readbackSpec.kind === "upload" && readbackSpec.expected_file_name !== undefined) {
    stateChecks.push(Array.isArray(match?.fileNames) && match.fileNames.includes(readbackSpec.expected_file_name));
  }
  const operationSpecificVerified = stateChecks.length === 0 || stateChecks.every(Boolean);
  return {
    expected,
    kind: readbackSpec.kind,
    verified: verified && operationSpecificVerified,
    match_count: Number.isSafeInteger(count) ? count : null,
    operation_specific_verified: operationSpecificVerified,
    observed_control: match ? {
      role: match.role ?? null,
      name: match.name ?? null,
      value_present: match.valuePresent ?? null,
      value_length: match.valueLength ?? null,
      selected_text: match.selectedText ?? null,
      file_names: Array.isArray(match.fileNames) ? match.fileNames.slice(0, 5) : null,
    } : null,
    query_digest: sha256(intent.action_plan.readback.semantic_query),
  };
}

function companionEffectReceipt({ input, intent, route, authority, adapterReceipt, readback, exactBlocker }) {
  const externalActionExecuted = adapterReceipt?.external_action_executed === true;
  const outcome = adapterReceipt?.outcome;
  const browserDispatched = externalActionExecuted || outcome?.applied_action_indices?.length > 0
    || outcome?.uncertain_action_indices?.length > 0 || outcome?.reconciliation_required === true;
  // The generic broker cannot interpret a provider's completion message.
  // This executor can verify the readback declared in the approved intent;
  // keep that web operation proof separate from whole-workflow completion.
  const browserReceiptTrusted = adapterReceipt?.browser_receipt_verified === true || adapterReceipt?.provider_receipt_trusted === true;
  const providerTrusted = adapterReceipt?.provider_receipt_trusted === true || (browserReceiptTrusted && readback.verified === true);
  const cleanupVerified = adapterReceipt?.cleanup_verified === true;
  const sourceSyncVerified = readback.verified === true;
  const complete = !exactBlocker && externalActionExecuted && providerTrusted && sourceSyncVerified && cleanupVerified;
  const blocker = complete
    ? null
    : exactBlocker
      || (!externalActionExecuted ? (browserDispatched ? "web_operation_browser_effect_observed_provider_unverified" : "web_operation_no_effect_dispatched")
        : !providerTrusted ? "aos_chrome_companion_provider_receipt_unverified"
          : !sourceSyncVerified ? "web_operation_source_readback_mismatch"
            : "aos_chrome_companion_cleanup_unverified");
  const lifecycle = {
    schema: "automation_os_web_operation_lifecycle.v1",
    state: complete ? "cleaned" : browserDispatched ? "effect_unknown" : "blocked",
    status: complete ? "complete" : "blocked",
    exact_blocker: blocker,
    restart_point: complete ? null : browserDispatched ? "same-run source-of-truth reconciliation; continue only remaining actions; do not replay" : "fresh target-bound admission with a new idempotency key",
    run_id: input.run_id,
    step_id: input.step_id,
    idempotency_key: input.idempotency_key,
    operation: intent.operation,
    target_digest: intent.target_binding.target_digest,
    source_state_digest: intent.target_binding.source_state_digest,
    payload_hash: intent.payload_hash,
    dispatch_state: browserDispatched ? (complete ? "executed" : "unknown") : "not_attempted",
    external_action_executed: externalActionExecuted,
    browser_mutation_executed: Boolean(browserDispatched),
    outcome: outcome ?? null,
    same_run_receipt: complete,
    readback_verified: sourceSyncVerified,
    cleanup_verified: cleanupVerified,
    no_replay: true,
  };
  return {
    status: complete ? "complete" : "blocked",
    exact_blocker: blocker,
    external_action_executed: externalActionExecuted,
    browser_mutation_executed: Boolean(browserDispatched),
    outcome: outcome ?? null,
    browser_backend: "aos_chrome_companion",
    browser_surface: AOS_CHROME_COMPANION_EFFECT_SURFACE,
    execution_context: adapterReceipt?.execution_context ?? null,
    authority_source: "aos_local",
    workflow_id: input.workflow_id,
    run_id: input.run_id,
    step_id: input.step_id,
    operation: intent.operation,
    generic_web_operation: true,
    completion_scope: "approved_web_operation_and_declared_readback",
    workflow_completion: "unverified",
    effects_mode: "enabled",
    authority_path: authority.path,
    authority_sha256: authority.sha256,
    target_digest: intent.target_binding.target_digest,
    source_state_digest: intent.target_binding.source_state_digest,
    payload_hash: intent.payload_hash,
    dispatch_state: lifecycle.dispatch_state,
    requested_origin: route.allowed_origins[0] || "",
    cleanup_verified: cleanupVerified,
    readback_verified: sourceSyncVerified,
    same_run_receipt: complete,
    web_operation_lifecycle: lifecycle,
    adapter_result: {
      schema: AOS_CHROME_COMPANION_EFFECT_RECEIPT_SCHEMA,
      provider: "aos_chrome_companion",
      transaction_result: adapterReceipt?.result || "blocked",
      provider_receipt_trusted: providerTrusted,
      browser_receipt_verified: browserReceiptTrusted,
      evidence_scope: "declared_provider_page_readback",
      visual_readback_verified: adapterReceipt?.visual_readback_verified === true,
      input_recovery: inputRecoveryFromReceipt(adapterReceipt),
      readback,
      source_sync: { schema: "aos.chrome_companion.source_sync.v1", same_run: true, verified: sourceSyncVerified,
        scope: "declared_browser_readback", workflow_source_sync: "unverified" },
      cleanup: adapterReceipt?.cleanup || null,
      reconciliation: adapterReceipt?.reconciliation || { attempted: false, verified: false, replayed: false },
    },
  };
}

export async function runAosChromeCompanionWebOperationEffect(
  input,
  route,
  rawIntent,
  environment = process.env,
  { adapterModule = null, client = null } = {},
) {
  const intent = validateWebOperationIntent(rawIntent);
  if (intent.operation === "read") throw new Error("portable_external_web_operation_effect_requires_mutation");
  if (intent.approval_status !== "approved") throw new Error("portable_external_web_operation_approval_required");
  if (!route || route.public_lane === true || route.mode !== "authorized" || route.lifecycle !== "scheduled") throw new Error("portable_external_web_operation_effect_authorized_route_required");
  const taskId = exactTaskId(input, environment);
  if (!taskId) throw new Error("aos_chrome_companion_task_id_missing");
  const authority = readEffectAuthority(input, intent, environment);
  if (authority.authority.target_digest !== intent.target_binding.target_digest) throw new Error("portable_external_effect_authority_target_mismatch");
  const claim = claimEffectAttempt(input, intent, authority, environment);
  if (claim.existing) {
    const duplicate = duplicateAttemptReceipt(input, intent, route, authority, { ...claim.existing, path: claim.path });
    return { ...duplicate, browser_backend: "aos_chrome_companion", browser_surface: AOS_CHROME_COMPANION_EFFECT_SURFACE };
  }

  let module = adapterModule;
  let brokerClient = client;
  let ownsClient = false;
  let adapterReceipt = null;
  let exactBlocker = null;
  try {
    module ||= await import("./aos-chrome-companion-adapter.mjs");
    if (!brokerClient) {
      brokerClient = await module.loadCompanionBrokerClient(environment);
      ownsClient = true;
    }
    const actions = companionActionsForIntent(intent);
    adapterReceipt = await module.executeAosChromeCompanionAuthorized({
      runId: input.run_id,
      taskId,
      startUrl: intent.entry_url,
      allowedOrigins: intent.allowed_origins,
      actions,
      idempotencyKey: input.idempotency_key,
      intent: `web_operation:${intent.operation}`,
      precondition: {
        semanticQuery: intent.target.semantic_query,
        targetDigest: intent.target_binding.target_digest,
        sourceStateDigest: intent.target_binding.source_state_digest,
      },
      reuseTaskTab: true,
      keepTaskTab: false,
      retainOnUnknown: true,
      requireCapabilityHandshake: true,
      capabilityHandshake: {
        schema: AOS_CHROME_COMPANION_TASK_CONTRACT_SCHEMA,
        version: 1,
        taskId,
        requiredCapabilities: requiredCapabilitiesForActions(actions),
        capabilityDigest: sha256(JSON.stringify(requiredCapabilitiesForActions(actions))),
      },
    }, { client: brokerClient });
    if (adapterReceipt?.result !== "verified") {
      const code = typeof adapterReceipt?.exact_blocker === "object" ? adapterReceipt.exact_blocker.code : adapterReceipt?.exact_blocker;
      exactBlocker = adapterReceipt?.external_action_executed === true && !preDispatchBlocker(String(code || ""))
        ? "web_operation_external_effect_reconciliation_required"
        : String(code || "aos_chrome_companion_transaction_blocked");
    }
  } catch (error) {
    exactBlocker = errorCode(error);
  } finally {
    if (ownsClient && brokerClient && typeof brokerClient.close === "function") {
      try { brokerClient.close(); } catch { /* preserve the effect receipt */ }
    }
  }
  const readback = readbackFromReceipt(adapterReceipt, intent);
  const result = companionEffectReceipt({ input, intent, route, authority, adapterReceipt, readback, exactBlocker });
  result.effect_claim_path = claim.path;
  try {
    persistEffectClaim(claim, result);
  } catch {
    result.status = "blocked";
    result.exact_blocker = "portable_external_web_operation_lifecycle_persist_failed";
    result.same_run_receipt = false;
    result.web_operation_lifecycle = {
      ...result.web_operation_lifecycle,
      state: result.browser_mutation_executed ? "effect_unknown" : "blocked",
      status: "blocked",
      exact_blocker: result.exact_blocker,
      restart_point: "inspect the run-owned claim and reconcile; do not replay",
      same_run_receipt: false,
    };
  }
  return result;
}

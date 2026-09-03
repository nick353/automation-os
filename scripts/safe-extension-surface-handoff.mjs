export const SAFE_EXTENSION_SURFACE_HANDOFF_SCHEMA = "aos.safe_extension_surface_handoff.v1";
export const COMPANION_SURFACE = "aos_chrome_companion_profile_instance";
export const OFFICIAL_EXTENSION_SURFACE = "signed_chrome_extension_profile2";

const UNSAFE_BLOCKER = /(?:auth(?:entication)?|sign[ -]?in|log[ -]?in|captcha|otp|mfa|2fa|本人確認|認証|ログイン|サインイン|payment|purchase|checkout|課金|決済|target.*ambiguous|origin.*not_allowed|foreign|owner(?:ship)?|effect.*unknown|operation_effect_unknown|reconciliation|required|visual.*(?:conflict|mismatch))/iu;

function blockerCode(result) {
  const blocker = result?.exact_blocker;
  if (typeof blocker === "string") return blocker.trim();
  if (blocker && typeof blocker === "object") return String(blocker.code || blocker.message || "").trim();
  return "";
}

function explicitNoEffect(result) {
  if (result?.external_action_executed !== false) return false;
  if (result?.operation_effect_state && result.operation_effect_state !== "none") return false;
  if (result?.reconciliation_required === true) return false;
  const adapter = result?.adapter_result && typeof result.adapter_result === "object"
    ? result.adapter_result
    : {};
  if (adapter.external_action_executed === true
    || adapter.reconciliation_required === true
    || adapter.operation_effect_state === "unknown") return false;
  const dispatchCount = Number(result?.mutation_dispatch_count ?? adapter.mutation_dispatch_count ?? 0);
  const dispatchAttempted = result?.mutation_dispatch_attempted === true
    || adapter.mutation_dispatch_attempted === true;
  return dispatchCount === 0 && dispatchAttempted === false
    && (result?.effects_mode === "read_only" || result?.read_only_stage_bound === true);
}

export function evaluateSafeExtensionSurfaceHandoff({ sourceResult, input } = {}) {
  const base = {
    schema: SAFE_EXTENSION_SURFACE_HANDOFF_SCHEMA,
    source_backend: "aos_chrome_companion",
    source_surface: COMPANION_SURFACE,
    destination_backend: "chrome_plugin",
    destination_surface: OFFICIAL_EXTENSION_SURFACE,
    direction: "one_way",
    handoff_count: 0,
    max_handoffs: 1,
    external_action_executed: false,
    replay_allowed: false,
    source_no_effect_verified: false,
    source_cleanup_verified: sourceResult?.cleanup_verified === true,
    destination_visual_required: true,
    transition_visible: false,
    transition_label: "Companion → Codex Extension",
    transition_reason: null,
  };
  if (sourceResult?.status === "complete") return { ...base, status: "not_required", exact_blocker: null };
  if (sourceResult?.browser_surface !== COMPANION_SURFACE
    || sourceResult?.browser_backend !== "aos_chrome_companion") {
    return { ...base, status: "blocked", exact_blocker: "safe_surface_handoff_source_invalid" };
  }
  const blocker = blockerCode(sourceResult);
  if (!blocker) return { ...base, status: "blocked", exact_blocker: "safe_surface_handoff_source_blocker_missing" };
  if (UNSAFE_BLOCKER.test(blocker)) {
    return { ...base, status: "blocked", exact_blocker: `safe_surface_handoff_unsafe_source:${blocker}` };
  }
  if (sourceResult?.cleanup_verified !== true) {
    return { ...base, status: "blocked", exact_blocker: "safe_surface_handoff_source_cleanup_unverified" };
  }
  if (!explicitNoEffect(sourceResult)) {
    return { ...base, status: "blocked", exact_blocker: "safe_surface_handoff_source_no_effect_unverified" };
  }
  return {
    ...base,
    status: "ready_for_official_visual_preflight",
    exact_blocker: null,
    handoff_count: 1,
    source_no_effect_verified: true,
    source_exact_blocker: blocker,
    workflow_id: String(input?.workflow_id || ""),
    run_id: String(input?.run_id || ""),
    step_id: String(input?.step_id || ""),
    source_idempotency_key: String(input?.idempotency_key || ""),
    destination_attempt_id: `${String(input?.idempotency_key || "handoff")}:official:1`.slice(0, 180),
    transition_visible: true,
    transition_reason: blocker,
    user_message: `Companion could not complete this control without an effect. Switching once to the Codex Extension: ${blocker}`,
  };
}

export function officialExtensionEnvironmentForHandoff(environment = process.env) {
  return {
    ...environment,
    AOS_WEB_OPERATION_BACKEND: "chrome_plugin",
    AUTOMATION_OS_BROWSER_DRIVER: "chrome_plugin",
    AUTOMATION_OS_BROWSER_SURFACE: OFFICIAL_EXTENSION_SURFACE,
    AOS_CHROME_PROFILE_SURFACE: OFFICIAL_EXTENSION_SURFACE,
    AOS_WEB_OPERATION_BACKEND_FALLBACK_ALLOWED: "false",
    AOS_SAFE_EXTENSION_SURFACE_HANDOFF_COUNT: "1",
    AOS_VISUAL_READBACK_REQUIRED: "true",
  };
}

export function completeSafeExtensionSurfaceHandoff(handoff, destinationResult) {
  const visualVerified = destinationResult?.visual_readback_verified === true
    || destinationResult?.adapter_result?.visual_readback_verified === true;
  const destinationComplete = destinationResult?.status === "complete"
    && destinationResult?.external_action_executed === false
    && destinationResult?.cleanup_verified === true
    && destinationResult?.readback_verified === true
    && visualVerified;
  return {
    ...handoff,
    status: destinationComplete ? "completed" : "blocked",
    exact_blocker: destinationComplete
      ? null
      : String(destinationResult?.exact_blocker || "safe_surface_handoff_destination_proof_incomplete"),
    destination_visual_verified: visualVerified,
    destination_cleanup_verified: destinationResult?.cleanup_verified === true,
    destination_readback_verified: destinationResult?.readback_verified === true,
    external_action_executed: false,
    transition_visible: true,
    transition_reason: handoff?.transition_reason || handoff?.source_exact_blocker || null,
    user_message: destinationComplete
      ? `Companion → Codex Extension completed: ${handoff?.transition_reason || handoff?.source_exact_blocker || "terminal_no_effect"}`
      : `Companion → Codex Extension stopped: ${String(destinationResult?.exact_blocker || "destination_proof_incomplete")}`,
    completed_at: new Date().toISOString(),
  };
}

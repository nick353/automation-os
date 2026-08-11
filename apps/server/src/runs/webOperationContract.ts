/**
 * Common contract for every Web operation launched by Automation OS.
 *
 * The fixed kernel owns safety, authority, identity and evidence.  The
 * adaptive layer owns live target discovery and route variation.  Keeping
 * these as data (rather than embedding a site's click sequence in a runner)
 * lets the scheduler, Codex App bridge and an alternate LLM worker share the
 * same boundary.
 */

export const WEB_OPERATION_CONTRACT_SCHEMA_V1 = "automation_os_web_operation_contract.v1" as const;

export const WEB_OPERATION_INTENT_SCHEMA_V1 = "automation_os_web_operation_intent.v1" as const;
export type WebOperationIntentKind = "read" | "create" | "update" | "publish" | "submit" | "delete";

export type WebOperationTargetCandidateV1 = {
  schema: "automation_os_semantic_target_candidate.v1";
  candidate_id: string;
  semantic_role: string;
  label: string;
  target_digest: string;
  source_state_digest: string;
  origin: string;
  href?: string;
  accessible_name?: string;
  context?: string;
  semantic_aliases?: readonly string[];
  visible: boolean;
  enabled: boolean;
};

export const WEB_OPERATION_ACTION_PLAN_SCHEMA_V1 = "automation_os_web_operation_action_plan.v1" as const;

export type WebOperationTargetBindingV1 = {
  target_digest: string;
  source_state_digest: string;
};

export type WebOperationActionStepV1 =
  | { action: "open"; url: string }
  | { action: "click_target"; target: { semantic_query: string; target_key?: string } }
  | { action: "fill_target"; target: { semantic_query: string; target_key?: string }; payload_key: string }
  | { action: "type"; payload_key: string }
  | { action: "keys"; key: string }
  | { action: "wait"; seconds: number }
  | { action: "scroll"; direction: "up" | "down" | "left" | "right" };

export type WebOperationActionPlanV1 = {
  schema: typeof WEB_OPERATION_ACTION_PLAN_SCHEMA_V1;
  steps: readonly WebOperationActionStepV1[];
  payload: Readonly<Record<string, string>>;
  payload_hash: string;
  readback: {
    semantic_query: string;
    target_key?: string;
    expected: "present" | "absent" | "unchanged";
  };
};

export type WebOperationIntentV1 = {
  schema: typeof WEB_OPERATION_INTENT_SCHEMA_V1;
  operation: WebOperationIntentKind;
  run_id: string;
  step_id: string;
  idempotency_key: string;
  account_ref: string;
  allowed_origins: readonly string[];
  entry_url?: string;
  target: {
    semantic_query: string;
    target_key?: string;
  };
  target_binding?: WebOperationTargetBindingV1;
  action_plan?: WebOperationActionPlanV1;
  payload_hash: string | null;
  approval_status: "not_required" | "pending" | "approved";
  authority_sha256: string | null;
  readback_required: true;
  no_replay: true;
};

export type WebOperationContractV1 = {
  schema: typeof WEB_OPERATION_CONTRACT_SCHEMA_V1;
  browser_surface: "browser_use_cli";
  llm_provider_neutral: true;
  app_dependency: false;
  fixed_kernel: {
    workflow_owned_persistent_profile: true;
    reserved_port: true;
    process_identity: true;
    profile_flow_lease: true;
    fresh_authority: true;
    company_scope: true;
    allowed_origins: true;
    same_run_idempotency: true;
    same_run_provenance: true;
    external_effect_approval: true;
    semantic_business_readback: true;
    source_of_truth_sync: true;
    terminal_cleanup: true;
    screenshot_scope: "run_recording_dir";
    forbidden_surfaces: readonly ["playwright", "iab", "extension", "direct_cdp", "raw_browser"];
    fail_close_on: readonly [
      "captcha",
      "otp",
      "identity_verification",
      "assessment",
      "unknown_high_impact_question",
      "payment",
      "tax",
      "banking",
      "ambiguous_external_effect",
    ];
    secrets_policy: "never_log_or_artifact_secrets_cookies_passwords_tokens_raw_page_body";
  };
  adaptive_layer: {
    live_semantic_state: true;
    live_target_inspect: true;
    bounded_exploration: true;
    route_and_state_detection: true;
    modal_scroll_pagination_navigation: true;
    known_fact_autofill: true;
    unknown_safe_question_policy: "clarification_then_store_for_similar_questions";
    site_playbook_role: "hint_only";
    no_fixed_css_selector_authority: true;
    no_fixed_dom_order_authority: true;
    no_single_site_click_sequence_authority: true;
    no_fixed_screenshot_name_authority: true;
    reevaluate_after_readback: true;
  };
  operation_model: {
    intent_kinds: readonly ["read", "create", "update", "publish", "submit", "delete"];
    target_resolution: "live_semantic_candidate_unique_match";
    target_candidate_schema: "automation_os_semantic_target_candidate.v1";
    action_strategy: "bounded_semantic_primitives";
    exploration_limits: {
      max_steps: 32;
      max_candidates: 32;
      max_tabs: 16;
      max_same_state_retries: 1;
    };
    reevaluate_after: readonly ["navigation", "modal", "pagination", "state_readback", "authentication_change", "effect_readback"];
    fixed_playbook_policy: "hint_only";
    unresolved_target_policy: "stop_or_clarify";
    effect_sequence: readonly ["target_resolve", "approval_admit", "action", "source_of_truth_readback", "reconcile_or_cleanup"];
    unknown_effect_policy: "fail_close_reconcile_no_replay";
  };
};

const fixedKernel = {
  workflow_owned_persistent_profile: true,
  reserved_port: true,
  process_identity: true,
  profile_flow_lease: true,
  fresh_authority: true,
  company_scope: true,
  allowed_origins: true,
  same_run_idempotency: true,
  same_run_provenance: true,
  external_effect_approval: true,
  semantic_business_readback: true,
  source_of_truth_sync: true,
  terminal_cleanup: true,
  screenshot_scope: "run_recording_dir" as const,
  forbidden_surfaces: ["playwright", "iab", "extension", "direct_cdp", "raw_browser"] as const,
  fail_close_on: [
    "captcha",
    "otp",
    "identity_verification",
    "assessment",
    "unknown_high_impact_question",
    "payment",
    "tax",
    "banking",
    "ambiguous_external_effect",
  ] as const,
  secrets_policy: "never_log_or_artifact_secrets_cookies_passwords_tokens_raw_page_body" as const,
} as const;

const adaptiveLayer = {
  live_semantic_state: true,
  live_target_inspect: true,
  bounded_exploration: true,
  route_and_state_detection: true,
  modal_scroll_pagination_navigation: true,
  known_fact_autofill: true,
  unknown_safe_question_policy: "clarification_then_store_for_similar_questions" as const,
  site_playbook_role: "hint_only" as const,
  no_fixed_css_selector_authority: true,
  no_fixed_dom_order_authority: true,
  no_single_site_click_sequence_authority: true,
  no_fixed_screenshot_name_authority: true,
  reevaluate_after_readback: true,
} as const;

const operationModel = {
  intent_kinds: ["read", "create", "update", "publish", "submit", "delete"] as const,
  target_resolution: "live_semantic_candidate_unique_match" as const,
  target_candidate_schema: "automation_os_semantic_target_candidate.v1" as const,
  action_strategy: "bounded_semantic_primitives" as const,
  exploration_limits: {
    max_steps: 32,
    max_candidates: 32,
    max_tabs: 16,
    max_same_state_retries: 1,
  },
  reevaluate_after: ["navigation", "modal", "pagination", "state_readback", "authentication_change", "effect_readback"] as const,
  fixed_playbook_policy: "hint_only" as const,
  unresolved_target_policy: "stop_or_clarify" as const,
  effect_sequence: ["target_resolve", "approval_admit", "action", "source_of_truth_readback", "reconcile_or_cleanup"] as const,
  unknown_effect_policy: "fail_close_reconcile_no_replay" as const,
} as const;

export const commonWebOperationContract: WebOperationContractV1 = Object.freeze({
  schema: WEB_OPERATION_CONTRACT_SCHEMA_V1,
  browser_surface: "browser_use_cli",
  llm_provider_neutral: true,
  app_dependency: false,
  fixed_kernel: Object.freeze(fixedKernel),
  adaptive_layer: Object.freeze(adaptiveLayer),
  operation_model: Object.freeze(operationModel),
});

export function getWebOperationContract(): WebOperationContractV1 {
  return {
    ...commonWebOperationContract,
    fixed_kernel: { ...commonWebOperationContract.fixed_kernel },
    adaptive_layer: { ...commonWebOperationContract.adaptive_layer },
    operation_model: {
      ...commonWebOperationContract.operation_model,
      exploration_limits: { ...commonWebOperationContract.operation_model.exploration_limits },
    },
  };
}

function hasExactKeys(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]);
}

export function validateWebOperationContract(contract: unknown): WebOperationContractV1 {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    throw new Error("web_operation_contract_missing");
  }
  const value = contract as Record<string, unknown>;
  if (value.schema !== WEB_OPERATION_CONTRACT_SCHEMA_V1 || value.browser_surface !== "browser_use_cli") {
    throw new Error("web_operation_contract_schema_invalid");
  }
  if (value.llm_provider_neutral !== true || value.app_dependency !== false) {
    throw new Error("web_operation_contract_dependency_invalid");
  }
  const expected = commonWebOperationContract as unknown as Record<string, unknown>;
  for (const section of ["fixed_kernel", "adaptive_layer"] as const) {
    const actual = value[section];
    const required = expected[section];
    if (!actual || typeof actual !== "object" || Array.isArray(actual) || !required || typeof required !== "object") {
      throw new Error(`web_operation_contract_${section}_missing`);
    }
    if (!hasExactKeys(actual as Record<string, unknown>, required as Record<string, unknown>)) {
      throw new Error(`web_operation_contract_${section}_invalid`);
    }
    for (const [key, expectedValue] of Object.entries(required as Record<string, unknown>)) {
      const actualValue = (actual as Record<string, unknown>)[key];
      if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
        throw new Error(`web_operation_contract_${section}_${key}_invalid`);
      }
    }
  }
  const actualOperationModel = value.operation_model;
  const requiredOperationModel = expected.operation_model;
  if (!actualOperationModel || typeof actualOperationModel !== "object" || Array.isArray(actualOperationModel)) {
    throw new Error("web_operation_contract_operation_model_missing");
  }
  if (!hasExactKeys(actualOperationModel as Record<string, unknown>, requiredOperationModel as Record<string, unknown>)) {
    throw new Error("web_operation_contract_operation_model_invalid");
  }
  for (const [key, expectedValue] of Object.entries(requiredOperationModel as Record<string, unknown>)) {
    const actualValue = (actualOperationModel as Record<string, unknown>)[key];
    if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
      throw new Error(`web_operation_contract_operation_model_${key}_invalid`);
    }
  }
  const actualExplorationLimits = (actualOperationModel as Record<string, unknown>).exploration_limits;
  const requiredExplorationLimits = (requiredOperationModel as Record<string, unknown>).exploration_limits;
  if (
    !actualExplorationLimits ||
    typeof actualExplorationLimits !== "object" ||
    Array.isArray(actualExplorationLimits) ||
    !requiredExplorationLimits ||
    typeof requiredExplorationLimits !== "object" ||
    Array.isArray(requiredExplorationLimits) ||
    !hasExactKeys(actualExplorationLimits as Record<string, unknown>, requiredExplorationLimits as Record<string, unknown>)
  ) {
    throw new Error("web_operation_contract_operation_model_exploration_limits_invalid");
  }
  return getWebOperationContract();
}

const OPERATION_KINDS = new Set<WebOperationIntentKind>(["read", "create", "update", "publish", "submit", "delete"]);
const IDENTIFIER = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,179}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ACTION_PLAN_IDENTIFIER = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,127}$/u;
const ACTION_PLAN_KEY = /^[A-Za-z0-9][-_A-Za-z0-9.:-]{0,127}$/u;
const ACTION_PLAN_KEY_VALUE = /^[A-Za-z0-9][A-Za-z0-9 _+.:/-]{0,63}$/u;
const ACTION_PLAN_SECRET_KEY = /(token|cookie|password|secret|authorization|storage[_-]?state|credential|profile[_-]?path|header|body|html)/iu;

function unsafeWebHostname(value: string): boolean {
  const hostname = value.replace(/^\[|\]$/gu, "").toLocaleLowerCase().replace(/\.$/u, "");
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

function safeHttpUrl(value: unknown, errorCode: string): URL {
  let parsed: URL;
  try { parsed = new URL(String(value)); } catch { throw new Error(errorCode); }
  if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password || unsafeWebHostname(parsed.hostname)) {
    throw new Error(errorCode);
  }
  return parsed;
}

function normalizedSemanticText(value: unknown): string {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function candidateOriginAllowed(candidate: WebOperationTargetCandidateV1, allowedOrigins: readonly string[]): boolean {
  let origin: URL;
  try { origin = safeHttpUrl(candidate.origin, "web_operation_candidate_origin_invalid"); } catch { return false; }
  if (!allowedOrigins.includes(origin.origin)) return false;
  if (!candidate.href) return true;
  try {
    const href = safeHttpUrl(new URL(candidate.href, origin.origin).href, "web_operation_candidate_href_invalid");
    return allowedOrigins.includes(href.origin);
  } catch {
    return false;
  }
}

function semanticCandidateScore(intent: WebOperationIntentV1, candidate: WebOperationTargetCandidateV1): number {
  if (intent.target.target_key) return String(candidate.candidate_id) === intent.target.target_key ? 100 : 0;
  const query = normalizedSemanticText(intent.target.semantic_query);
  if (!query) return 0;
  const fields: Array<{ value: string; weight: number }> = [
    { value: candidate.label, weight: 100 },
    { value: candidate.accessible_name ?? "", weight: 100 },
    { value: candidate.semantic_role, weight: 90 },
    { value: candidate.context ?? "", weight: 85 },
    ...(candidate.semantic_aliases ?? []).map((value) => ({ value, weight: 95 }))
  ];
  return fields.reduce((best, field) => {
    const value = normalizedSemanticText(field.value);
    if (!value) return best;
    if (value === query) return Math.max(best, field.weight);
    if (value.includes(query)) return Math.max(best, field.weight - 20);
    if (query.includes(value)) return Math.max(best, field.weight - 30);
    return best;
  }, 0);
}

function validOrigin(value: unknown): string {
  const parsed = safeHttpUrl(value, "web_operation_origin_invalid");
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("web_operation_origin_invalid");
  }
  return parsed.origin;
}

export function validateWebOperationIntent(intent: unknown): WebOperationIntentV1 {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) throw new Error("web_operation_intent_missing");
  const value = intent as Record<string, unknown>;
  if (value.schema !== WEB_OPERATION_INTENT_SCHEMA_V1 || !OPERATION_KINDS.has(value.operation as WebOperationIntentKind)) {
    throw new Error("web_operation_intent_schema_invalid");
  }
  for (const field of ["run_id", "step_id", "idempotency_key", "account_ref"]) {
    if (!IDENTIFIER.test(String(value[field] || ""))) throw new Error(`web_operation_intent_${field}_invalid`);
  }
  const origins = Array.isArray(value.allowed_origins) ? [...new Set(value.allowed_origins.map(validOrigin))].sort() : [];
  if (origins.length === 0) throw new Error("web_operation_intent_allowed_origins_invalid");
  const entryUrlValue = value.entry_url === null || value.entry_url === undefined ? null : safeHttpUrl(value.entry_url, "web_operation_entry_url_invalid");
  if (entryUrlValue && !origins.includes(entryUrlValue.origin)) throw new Error("web_operation_entry_url_origin_invalid");
  const target = value.target;
  if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error("web_operation_intent_target_missing");
  const targetValue = target as Record<string, unknown>;
  if (!String(targetValue.semantic_query || "").trim() || String(targetValue.semantic_query).length > 240) {
    throw new Error("web_operation_intent_semantic_query_invalid");
  }
  if ("css_selector" in targetValue || "xpath" in targetValue || "dom_order" in targetValue) {
    throw new Error("web_operation_intent_fixed_target_rejected");
  }
  const operation = value.operation as WebOperationIntentKind;
  const payloadHash = value.payload_hash === null || value.payload_hash === undefined ? null : String(value.payload_hash);
  if (operation !== "read" && !SHA256.test(String(payloadHash || ""))) throw new Error("web_operation_intent_payload_hash_invalid");
  const approvalStatus = String(value.approval_status || "");
  if (!(approvalStatus === "not_required" || approvalStatus === "pending" || approvalStatus === "approved")) {
    throw new Error("web_operation_intent_approval_status_invalid");
  }
  const authoritySha = value.authority_sha256 === null || value.authority_sha256 === undefined ? null : String(value.authority_sha256);
  if (operation !== "read" && approvalStatus === "approved" && !SHA256.test(String(authoritySha || ""))) throw new Error("web_operation_intent_authority_missing");
  if (operation !== "read" && approvalStatus === "not_required") throw new Error("web_operation_intent_authority_missing");
  if (value.readback_required !== true || value.no_replay !== true) throw new Error("web_operation_intent_effect_guards_invalid");

  let targetBinding: WebOperationTargetBindingV1 | undefined;
  if (value.target_binding !== undefined && value.target_binding !== null) {
    if (!value.target_binding || typeof value.target_binding !== "object" || Array.isArray(value.target_binding)) {
      throw new Error("web_operation_intent_target_binding_invalid");
    }
    const binding = value.target_binding as Record<string, unknown>;
    if (!SHA256.test(String(binding.target_digest || "")) || !SHA256.test(String(binding.source_state_digest || ""))) {
      throw new Error("web_operation_intent_target_binding_invalid");
    }
    targetBinding = {
      target_digest: String(binding.target_digest),
      source_state_digest: String(binding.source_state_digest),
    };
  }

  let actionPlan: WebOperationActionPlanV1 | undefined;
  if (value.action_plan !== undefined && value.action_plan !== null) {
    const rawPlan = value.action_plan;
    if (!rawPlan || typeof rawPlan !== "object" || Array.isArray(rawPlan)) throw new Error("web_operation_action_plan_invalid");
    const plan = rawPlan as Record<string, unknown>;
    if (plan.schema !== WEB_OPERATION_ACTION_PLAN_SCHEMA_V1 || !Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > operationModel.exploration_limits.max_steps) {
      throw new Error("web_operation_action_plan_invalid");
    }
    if (!plan.payload || typeof plan.payload !== "object" || Array.isArray(plan.payload)) throw new Error("web_operation_action_plan_payload_invalid");
    const payload: Record<string, string> = {};
    for (const [key, raw] of Object.entries(plan.payload as Record<string, unknown>)) {
      if (!ACTION_PLAN_KEY.test(key) || ACTION_PLAN_SECRET_KEY.test(key) || typeof raw !== "string" || raw.length > 20_000) {
        throw new Error("web_operation_action_plan_payload_invalid");
      }
      payload[key] = raw;
    }
    if (!SHA256.test(String(plan.payload_hash || ""))) throw new Error("web_operation_action_plan_payload_hash_invalid");
    if (operation !== "read" && payloadHash !== String(plan.payload_hash)) throw new Error("web_operation_action_plan_payload_hash_mismatch");
    const steps: WebOperationActionStepV1[] = [];
    for (const rawStep of plan.steps) {
      if (!rawStep || typeof rawStep !== "object" || Array.isArray(rawStep)) throw new Error("web_operation_action_step_invalid");
      const step = rawStep as Record<string, unknown>;
      const action = String(step.action || "");
      if (action === "open") {
        const url = safeHttpUrl(step.url, "web_operation_action_url_invalid");
        if (!origins.includes(url.origin)) throw new Error("web_operation_action_url_origin_invalid");
        steps.push({ action, url: url.href });
      } else if (action === "click_target" || action === "fill_target") {
        const stepTarget = step.target;
        if (!stepTarget || typeof stepTarget !== "object" || Array.isArray(stepTarget)) throw new Error("web_operation_action_target_invalid");
        const stepTargetValue = stepTarget as Record<string, unknown>;
        const semanticQuery = String(stepTargetValue.semantic_query || "").trim();
        if (!semanticQuery || semanticQuery.length > 240 || "css_selector" in stepTargetValue || "xpath" in stepTargetValue || "dom_order" in stepTargetValue) {
          throw new Error("web_operation_action_target_invalid");
        }
        const normalizedTarget = { semantic_query: semanticQuery, ...(stepTargetValue.target_key ? { target_key: String(stepTargetValue.target_key) } : {}) };
        if (action === "fill_target") {
          const payloadKey = String(step.payload_key || "");
          if (!ACTION_PLAN_KEY.test(payloadKey) || payload[payloadKey] === undefined) throw new Error("web_operation_action_payload_key_invalid");
          steps.push({ action, target: normalizedTarget, payload_key: payloadKey });
        } else {
          steps.push({ action, target: normalizedTarget });
        }
      } else if (action === "type") {
        const payloadKey = String(step.payload_key || "");
        if (!ACTION_PLAN_KEY.test(payloadKey) || payload[payloadKey] === undefined) throw new Error("web_operation_action_payload_key_invalid");
        steps.push({ action, payload_key: payloadKey });
      } else if (action === "keys") {
        const key = String(step.key || "");
        if (!ACTION_PLAN_KEY_VALUE.test(key)) throw new Error("web_operation_action_key_invalid");
        steps.push({ action, key });
      } else if (action === "wait") {
        const seconds = Number(step.seconds);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30) throw new Error("web_operation_action_wait_invalid");
        steps.push({ action, seconds });
      } else if (action === "scroll") {
        const direction = String(step.direction || "");
        if (!(direction === "up" || direction === "down" || direction === "left" || direction === "right")) throw new Error("web_operation_action_scroll_invalid");
        steps.push({ action, direction });
      } else {
        throw new Error("web_operation_action_invalid");
      }
    }
    const readback = plan.readback;
    if (!readback || typeof readback !== "object" || Array.isArray(readback)) throw new Error("web_operation_action_readback_invalid");
    const readbackValue = readback as Record<string, unknown>;
    const readbackQuery = String(readbackValue.semantic_query || "").trim();
    const expected = String(readbackValue.expected || "");
    if (!readbackQuery || readbackQuery.length > 240 || !(expected === "present" || expected === "absent" || expected === "unchanged")) throw new Error("web_operation_action_readback_invalid");
    actionPlan = {
      schema: WEB_OPERATION_ACTION_PLAN_SCHEMA_V1,
      steps,
      payload: Object.freeze({ ...payload }),
      payload_hash: String(plan.payload_hash),
      readback: { semantic_query: readbackQuery, ...(readbackValue.target_key ? { target_key: String(readbackValue.target_key) } : {}), expected: expected as "present" | "absent" | "unchanged" },
    };
  }
  return {
    schema: WEB_OPERATION_INTENT_SCHEMA_V1,
    operation,
    run_id: String(value.run_id),
    step_id: String(value.step_id),
    idempotency_key: String(value.idempotency_key),
    account_ref: String(value.account_ref),
    allowed_origins: origins,
    ...(entryUrlValue ? { entry_url: entryUrlValue.href } : {}),
    target: {
      semantic_query: String(targetValue.semantic_query).trim(),
      ...(targetValue.target_key ? { target_key: String(targetValue.target_key) } : {}),
    },
    ...(targetBinding ? { target_binding: targetBinding } : {}),
    ...(actionPlan ? { action_plan: actionPlan } : {}),
    payload_hash: payloadHash,
    approval_status: approvalStatus as WebOperationIntentV1["approval_status"],
    authority_sha256: authoritySha,
    readback_required: true,
    no_replay: true,
  };
}

export type WebOperationTargetResolutionV1 =
  | { status: "resolved"; candidate: WebOperationTargetCandidateV1 }
  | { status: "blocked"; exact_blocker: "web_operation_target_not_found" | "web_operation_target_ambiguous" | "web_operation_target_invalid"; restart_point: string };

export function resolveLiveSemanticTarget({ intent, candidates }: { intent: WebOperationIntentV1; candidates: readonly WebOperationTargetCandidateV1[] }): WebOperationTargetResolutionV1 {
  const validated = validateWebOperationIntent(intent);
  if (!Array.isArray(candidates) || candidates.length > operationModel.exploration_limits.max_candidates) {
    return { status: "blocked", exact_blocker: "web_operation_target_invalid", restart_point: "fresh bounded semantic readback" };
  }
  const scored = candidates.flatMap((candidate) => {
    if (!candidate || candidate.schema !== operationModel.target_candidate_schema || candidate.visible !== true || candidate.enabled !== true) return [];
    if (!SHA256.test(String(candidate.target_digest || "")) || !SHA256.test(String(candidate.source_state_digest || ""))) return [];
    if (!candidateOriginAllowed(candidate, validated.allowed_origins)) return [];
    const score = semanticCandidateScore(validated, candidate);
    return score > 0 ? [{ candidate, score }] : [];
  });
  if (validated.target.target_key && scored.length === 1) return { status: "resolved", candidate: scored[0].candidate };
  const matches = scored.sort((left, right) => right.score - left.score);
  const uniqueBest = matches.length === 1 || (matches.length > 1 && matches[0].score - matches[1].score >= 25);
  if (matches.length > 0 && uniqueBest) return { status: "resolved", candidate: matches[0].candidate };
  return {
    status: "blocked",
    exact_blocker: matches.length === 0 ? "web_operation_target_not_found" : "web_operation_target_ambiguous",
    restart_point: "fresh live semantic readback; do not reuse stale target evidence",
  };
}

export function admitWebOperationEffect({ intent, resolution }: { intent: WebOperationIntentV1; resolution: WebOperationTargetResolutionV1 }): { status: "admitted" | "awaiting_approval" | "blocked"; exact_blocker?: string } {
  const validated = validateWebOperationIntent(intent);
  if (validated.operation === "read") return resolution.status === "resolved" ? { status: "admitted" } : { status: "blocked", exact_blocker: resolution.exact_blocker };
  if (resolution.status !== "resolved") return { status: "blocked", exact_blocker: resolution.exact_blocker };
  if (validated.approval_status === "pending") return { status: "awaiting_approval", exact_blocker: "web_operation_approval_pending" };
  if (validated.approval_status !== "approved") return { status: "blocked", exact_blocker: "web_operation_approval_required" };
  return { status: "admitted" };
}

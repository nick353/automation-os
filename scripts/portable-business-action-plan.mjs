import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const PORTABLE_EXTERNAL_ACTION_PLAN_SCHEMA_V1 = "automation_os_portable_external_action_plan.v1";

// Data-only mirror of AOS's common Web contract. A worker implemented by a
// different LLM can validate this without importing Codex or AOS runtime code.
export const WEB_OPERATION_CONTRACT = Object.freeze({
  schema: "automation_os_web_operation_contract.v1",
  browser_surface: "browser_use_cli",
  llm_provider_neutral: true,
  app_dependency: false,
  fixed_kernel: Object.freeze({
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
    screenshot_scope: "run_recording_dir",
    forbidden_surfaces: ["playwright", "iab", "extension", "direct_cdp", "raw_browser"],
    fail_close_on: ["captcha", "otp", "secret_input", "human_input_required", "identity_verification", "assessment", "unknown_high_impact_question", "payment", "tax", "banking", "foreign_owner_resource", "ambiguous_external_effect"],
    secrets_policy: "never_log_or_artifact_secrets_cookies_passwords_tokens_raw_page_body",
  }),
  adaptive_layer: Object.freeze({
    live_semantic_state: true,
    live_target_inspect: true,
    bounded_exploration: true,
    route_and_state_detection: true,
    modal_scroll_pagination_navigation: true,
    known_fact_autofill: true,
    unknown_safe_question_policy: "clarification_then_store_for_similar_questions",
    site_playbook_role: "hint_only",
    no_fixed_css_selector_authority: true,
    no_fixed_dom_order_authority: true,
    no_single_site_click_sequence_authority: true,
    no_fixed_screenshot_name_authority: true,
    reevaluate_after_readback: true,
  }),
  operation_model: Object.freeze({
    intent_kinds: Object.freeze(["read", "create", "update", "publish", "submit", "delete"]),
    target_resolution: "live_semantic_candidate_unique_match",
    target_candidate_schema: "automation_os_semantic_target_candidate.v1",
    action_strategy: "bounded_semantic_primitives",
    exploration_limits: Object.freeze({
      max_steps: 32,
      max_candidates: 32,
      max_tabs: 16,
      max_same_state_retries: 1,
    }),
    reevaluate_after: Object.freeze(["navigation", "modal", "pagination", "state_readback", "authentication_change", "effect_readback"]),
    fixed_playbook_policy: "hint_only",
    unresolved_target_policy: "stop_or_clarify",
    effect_sequence: Object.freeze(["target_resolve", "approval_admit", "action", "source_of_truth_readback", "reconcile_or_cleanup"]),
    unknown_effect_policy: "fail_close_reconcile_no_replay",
  }),
});

// AOS makeId() emits run_<time>_<random>; underscore is part of the
// provider-neutral run/step identity and must remain accepted at the worker
// boundary.
const IDENTIFIER = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,179}$/u;
// Compatibility readback for the currently deployed production artifact. The
// local contract remains stricter and is still returned to the runner; this
// narrow acceptance can be removed after production is redeployed with the
// current contract.
const LEGACY_REMOTE_FAIL_CLOSE_ON = Object.freeze([
  "captcha",
  "otp",
  "identity_verification",
  "assessment",
  "unknown_high_impact_question",
  "payment",
  "tax",
  "banking",
  "ambiguous_external_effect",
]);
const PLANS = Object.freeze({
  "job-application-manager": Object.freeze({
    runner_key: "job_application",
    stages: ["source_readback", "candidate_supply", "browser_preflight", "one_candidate_submit", "same_run_sync_readback", "cleanup"],
    required_business_proofs: ["submitted_confirmed", "same_run_source_of_truth_readback", "cleanup_receipt"],
    web_operation_contract: WEB_OPERATION_CONTRACT,
  }),
  "daily-ai-research-publish-run": Object.freeze({
    runner_key: "daily_ai",
    stages: ["research_queue_refresh", "pre_entry_readiness", "browser_preflight", "publish", "feed_study", "engagement", "postflight_sync", "cleanup"],
    required_business_proofs: ["publish_url_or_exact_blocker", "feed_study_or_exact_blocker", "engagement_or_no_candidate_proof", "queue_sync", "cleanup_receipt"],
    web_operation_contract: WEB_OPERATION_CONTRACT,
  }),
  "nisenprints-daily-product-canva-printify-etsy-pinterest": Object.freeze({
    runner_key: "nisenprints",
    stages: ["prepare_context", "browser_preflight", "runway_generate", "canva_preflight", "canva_transaction", "canva_commit_export", "canva_artifact_gate", "canva_verify", "printify_product_copy", "printify_publish", "etsy_listing_discovery", "etsy_media_repair", "pinterest_queue", "pinterest_post", "strict_completion", "cleanup"],
    required_business_proofs: ["generation_manifest", "etsy_listing", "pinterest_pin_url", "etsy_visit_site_match", "cleanup_receipt"],
    web_operation_contract: WEB_OPERATION_CONTRACT,
  }),
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fail(code) {
  throw new Error(code);
}

function contractSectionMatches(section, actual) {
  const expected = WEB_OPERATION_CONTRACT[section];
  if (JSON.stringify(actual) === JSON.stringify(expected)) return true;
  if (section !== "fixed_kernel") return false;
  const legacy = { ...expected, fail_close_on: LEGACY_REMOTE_FAIL_CLOSE_ON };
  return JSON.stringify(actual) === JSON.stringify(legacy);
}

export function validateWebOperationContract(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)
    || contract.schema !== WEB_OPERATION_CONTRACT.schema
    || contract.browser_surface !== WEB_OPERATION_CONTRACT.browser_surface
    || contract.llm_provider_neutral !== true
    || contract.app_dependency !== false) fail("web_operation_contract_schema_invalid");
  for (const section of ["fixed_kernel", "adaptive_layer", "operation_model"]) {
    if (!contractSectionMatches(section, contract[section])) {
      fail(`web_operation_contract_${section}_invalid`);
    }
  }
  return WEB_OPERATION_CONTRACT;
}

function expectedPlan(workflowId) {
  const plan = PLANS[String(workflowId || "")];
  if (!plan) fail("portable_external_action_plan_workflow_invalid");
  return plan;
}

function readPrivatePlan(file, expectedSha256) {
  if (!path.isAbsolute(file) || !/^[a-f0-9]{64}$/u.test(expectedSha256)) fail("portable_external_action_plan_missing");
  let stat;
  let bytes;
  try {
    stat = fs.lstatSync(file);
    bytes = fs.readFileSync(file);
  } catch {
    fail("portable_external_action_plan_missing");
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.uid !== currentUid || (stat.mode & 0o777) !== 0o600) {
    fail("portable_external_action_plan_permissions_invalid");
  }
  if (sha256(bytes) !== expectedSha256) fail("portable_external_action_plan_digest_invalid");
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { fail("portable_external_action_plan_json_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("portable_external_action_plan_json_invalid");
  return { value, bytes };
}

export function readPortableBusinessActionPlan({ workflowId, runId, stepId, sourceTrigger, idempotencyKey, environment = process.env, inputBundlePath = "" } = {}) {
  const plan = expectedPlan(workflowId);
  for (const [key, value] of Object.entries({ workflowId, runId, stepId, sourceTrigger, idempotencyKey })) {
    if (!IDENTIFIER.test(String(value || ""))) fail(`portable_external_action_plan_${key}_invalid`);
  }
  const file = String(environment.AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_PATH || "").trim();
  const expectedSha256 = String(environment.AUTOMATION_OS_PORTABLE_BUSINESS_ACTION_PLAN_SHA256 || "").trim();
  const loaded = readPrivatePlan(file, expectedSha256);
  const value = loaded.value;
  if (value.schema !== PORTABLE_EXTERNAL_ACTION_PLAN_SCHEMA_V1
    || value.workflow_id !== workflowId
    || value.runner_key !== plan.runner_key
    || value.run_id !== runId
    || value.step_id !== stepId
    || value.source_trigger !== sourceTrigger
    || value.idempotency_key !== idempotencyKey
    || value.browser_surface !== "browser_use_cli"
    || value.external_effect_policy !== "approved"
    || value.approval_status !== "approved"
    || !Array.isArray(value.allowed_stages)
    || JSON.stringify(value.allowed_stages) !== JSON.stringify(plan.stages)
    || !Array.isArray(value.required_business_proofs)
    || JSON.stringify(value.required_business_proofs) !== JSON.stringify(plan.required_business_proofs)
    || JSON.stringify(validateWebOperationContract(value.web_operation_contract)) !== JSON.stringify(WEB_OPERATION_CONTRACT)) {
    fail("portable_external_action_plan_binding_invalid");
  }
  if (Date.parse(String(value.expires_at || "")) <= Date.now()) fail("portable_external_action_plan_expired");
  if (value.input_bundle_sha256 !== null && value.input_bundle_sha256 !== undefined) {
    if (!/^[a-f0-9]{64}$/u.test(String(value.input_bundle_sha256))) fail("portable_external_action_plan_input_bundle_invalid");
    const bundle = String(inputBundlePath || environment.AUTOMATION_OS_PORTABLE_BUSINESS_INPUT_BUNDLE_PATH || "").trim();
    if (!bundle || !fs.existsSync(bundle) || sha256(fs.readFileSync(bundle)) !== value.input_bundle_sha256) fail("portable_external_action_plan_input_bundle_binding_invalid");
  }
  return Object.freeze({ path: file, sha256: expectedSha256, value });
}

export function portableBusinessPlanForWorkflow(workflowId) {
  const plan = expectedPlan(workflowId);
  return { runner_key: plan.runner_key, stages: [...plan.stages], required_business_proofs: [...plan.required_business_proofs], web_operation_contract: WEB_OPERATION_CONTRACT };
}

const WEB_OPERATION_INTENT_SCHEMA_V1 = "automation_os_web_operation_intent.v1";
const WEB_OPERATION_ACTION_PLAN_SCHEMA_V1 = "automation_os_web_operation_action_plan.v1";
const WEB_OPERATION_INTENT_KINDS = new Set(["read", "create", "update", "publish", "submit", "delete"]);
const WEB_OPERATION_IDENTIFIER = /^[A-Za-z0-9][-_A-Za-z0-9.:]{0,179}$/u;
const WEB_OPERATION_SHA256 = /^[a-f0-9]{64}$/u;
const WEB_OPERATION_ACTION_KEY = /^[A-Za-z0-9][-_A-Za-z0-9.:-]{0,127}$/u;
const WEB_OPERATION_ACTION_KEY_VALUE = /^[A-Za-z0-9][A-Za-z0-9 _+.:/-]{0,63}$/u;
const WEB_OPERATION_ACTION_SECRET_KEY = /(token|cookie|password|secret|authorization|storage[_-]?state|credential|profile[_-]?path|header|body|html)/iu;

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

function safeHttpUrl(value, errorCode) {
  let parsed;
  try { parsed = new URL(String(value)); } catch { fail(errorCode); }
  if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password || unsafeWebHostname(parsed.hostname)) fail(errorCode);
  return parsed;
}

function normalizedSemanticText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function candidateOriginAllowed(candidate, allowedOrigins) {
  let origin;
  try { origin = safeHttpUrl(candidate.origin, "web_operation_candidate_origin_invalid"); } catch { return false; }
  if (!allowedOrigins.includes(origin.origin)) return false;
  if (!candidate.href) return true;
  try {
    const href = safeHttpUrl(new URL(candidate.href, origin.origin).href, "web_operation_candidate_href_invalid");
    return allowedOrigins.includes(href.origin);
  } catch { return false; }
}

function semanticCandidateScore(intent, candidate) {
  if (intent.target.target_key) return String(candidate.candidate_id) === intent.target.target_key ? 100 : 0;
  const query = normalizedSemanticText(intent.target.semantic_query);
  if (!query) return 0;
  const fields = [
    { value: candidate.label, weight: 100 },
    { value: candidate.accessible_name || "", weight: 100 },
    { value: candidate.semantic_role, weight: 90 },
    { value: candidate.context || "", weight: 85 },
    ...(Array.isArray(candidate.semantic_aliases) ? candidate.semantic_aliases.map((value) => ({ value, weight: 95 })) : [])
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

function webOperationOrigin(value) {
  const parsed = safeHttpUrl(value, "web_operation_origin_invalid");
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) fail("web_operation_origin_invalid");
  return parsed.origin;
}

export function validateWebOperationIntent(intent) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) fail("web_operation_intent_missing");
  if (intent.schema !== WEB_OPERATION_INTENT_SCHEMA_V1 || !WEB_OPERATION_INTENT_KINDS.has(String(intent.operation))) fail("web_operation_intent_schema_invalid");
  for (const field of ["run_id", "step_id", "idempotency_key", "account_ref"]) {
    if (!WEB_OPERATION_IDENTIFIER.test(String(intent[field] || ""))) fail(`web_operation_intent_${field}_invalid`);
  }
  const origins = Array.isArray(intent.allowed_origins) ? [...new Set(intent.allowed_origins.map(webOperationOrigin))].sort() : [];
  if (origins.length === 0) fail("web_operation_intent_allowed_origins_invalid");
  const entryUrl = intent.entry_url === null || intent.entry_url === undefined ? null : safeHttpUrl(intent.entry_url, "web_operation_entry_url_invalid");
  if (entryUrl && !origins.includes(entryUrl.origin)) fail("web_operation_entry_url_origin_invalid");
  const target = intent.target;
  if (!target || typeof target !== "object" || Array.isArray(target)) fail("web_operation_intent_target_missing");
  if (!String(target.semantic_query || "").trim() || String(target.semantic_query).length > 240) fail("web_operation_intent_semantic_query_invalid");
  if (Object.hasOwn(target, "css_selector") || Object.hasOwn(target, "xpath") || Object.hasOwn(target, "dom_order")) fail("web_operation_intent_fixed_target_rejected");
  const operation = String(intent.operation);
  const payloadHash = intent.payload_hash === null || intent.payload_hash === undefined ? null : String(intent.payload_hash);
  if (operation !== "read" && !WEB_OPERATION_SHA256.test(String(payloadHash || ""))) fail("web_operation_intent_payload_hash_invalid");
  const approvalStatus = String(intent.approval_status || "");
  if (!new Set(["not_required", "pending", "approved"]).has(approvalStatus)) fail("web_operation_intent_approval_status_invalid");
  const authoritySha = intent.authority_sha256 === null || intent.authority_sha256 === undefined ? null : String(intent.authority_sha256);
  if (operation !== "read" && approvalStatus === "approved" && !WEB_OPERATION_SHA256.test(String(authoritySha || ""))) fail("web_operation_intent_authority_missing");
  if (operation !== "read" && approvalStatus === "not_required") fail("web_operation_intent_authority_missing");
  if (intent.readback_required !== true || intent.no_replay !== true) fail("web_operation_intent_effect_guards_invalid");
  let targetBinding;
  if (intent.target_binding !== undefined && intent.target_binding !== null) {
    if (!intent.target_binding || typeof intent.target_binding !== "object" || Array.isArray(intent.target_binding)
      || !WEB_OPERATION_SHA256.test(String(intent.target_binding.target_digest || ""))
      || !WEB_OPERATION_SHA256.test(String(intent.target_binding.source_state_digest || ""))) fail("web_operation_intent_target_binding_invalid");
    targetBinding = { target_digest: String(intent.target_binding.target_digest), source_state_digest: String(intent.target_binding.source_state_digest) };
  }
  let actionPlan;
  if (intent.action_plan !== undefined && intent.action_plan !== null) {
    const plan = intent.action_plan;
    if (!plan || typeof plan !== "object" || Array.isArray(plan) || plan.schema !== WEB_OPERATION_ACTION_PLAN_SCHEMA_V1
      || !Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > WEB_OPERATION_CONTRACT.operation_model.exploration_limits.max_steps
      || !plan.payload || typeof plan.payload !== "object" || Array.isArray(plan.payload)) fail("web_operation_action_plan_invalid");
    const payload = {};
    for (const [key, value] of Object.entries(plan.payload)) {
      if (!WEB_OPERATION_ACTION_KEY.test(key) || WEB_OPERATION_ACTION_SECRET_KEY.test(key) || typeof value !== "string" || value.length > 20_000) fail("web_operation_action_plan_payload_invalid");
      payload[key] = value;
    }
    if (!WEB_OPERATION_SHA256.test(String(plan.payload_hash || ""))) fail("web_operation_action_plan_payload_hash_invalid");
    if (operation !== "read" && payloadHash !== String(plan.payload_hash)) fail("web_operation_action_plan_payload_hash_mismatch");
    const steps = [];
    for (const step of plan.steps) {
      if (!step || typeof step !== "object" || Array.isArray(step)) fail("web_operation_action_step_invalid");
      const action = String(step.action || "");
      if (action === "open") {
        const url = safeHttpUrl(step.url, "web_operation_action_url_invalid");
        if (!origins.includes(url.origin)) fail("web_operation_action_url_origin_invalid");
        steps.push({ action, url: url.href });
      } else if (action === "click_target" || action === "fill_target") {
        const stepTarget = step.target;
        if (!stepTarget || typeof stepTarget !== "object" || Array.isArray(stepTarget)) fail("web_operation_action_target_invalid");
        const semanticQuery = String(stepTarget.semantic_query || "").trim();
        if (!semanticQuery || semanticQuery.length > 240 || Object.hasOwn(stepTarget, "css_selector") || Object.hasOwn(stepTarget, "xpath") || Object.hasOwn(stepTarget, "dom_order")) fail("web_operation_action_target_invalid");
        const normalizedTarget = { semantic_query: semanticQuery, ...(stepTarget.target_key ? { target_key: String(stepTarget.target_key) } : {}) };
        if (action === "fill_target") {
          const payloadKey = String(step.payload_key || "");
          if (!WEB_OPERATION_ACTION_KEY.test(payloadKey) || payload[payloadKey] === undefined) fail("web_operation_action_payload_key_invalid");
          steps.push({ action, target: normalizedTarget, payload_key: payloadKey });
        } else steps.push({ action, target: normalizedTarget });
      } else if (action === "type") {
        const payloadKey = String(step.payload_key || "");
        if (!WEB_OPERATION_ACTION_KEY.test(payloadKey) || payload[payloadKey] === undefined) fail("web_operation_action_payload_key_invalid");
        steps.push({ action, payload_key: payloadKey });
      } else if (action === "keys") {
        const key = String(step.key || "");
        if (!WEB_OPERATION_ACTION_KEY_VALUE.test(key)) fail("web_operation_action_key_invalid");
        steps.push({ action, key });
      } else if (action === "wait") {
        const seconds = Number(step.seconds);
        if (!Number.isFinite(seconds) || seconds < 0 || seconds > 30) fail("web_operation_action_wait_invalid");
        steps.push({ action, seconds });
      } else if (action === "scroll") {
        const direction = String(step.direction || "");
        if (!["up", "down", "left", "right"].includes(direction)) fail("web_operation_action_scroll_invalid");
        steps.push({ action, direction });
      } else fail("web_operation_action_invalid");
    }
    const readback = plan.readback;
    if (!readback || typeof readback !== "object" || Array.isArray(readback)) fail("web_operation_action_readback_invalid");
    const semanticQuery = String(readback.semantic_query || "").trim();
    const expected = String(readback.expected || "");
    if (!semanticQuery || semanticQuery.length > 240 || !["present", "absent", "unchanged"].includes(expected)) fail("web_operation_action_readback_invalid");
    actionPlan = { schema: WEB_OPERATION_ACTION_PLAN_SCHEMA_V1, steps, payload, payload_hash: String(plan.payload_hash), readback: { semantic_query: semanticQuery, ...(readback.target_key ? { target_key: String(readback.target_key) } : {}), expected } };
  }
  return Object.freeze({
    schema: WEB_OPERATION_INTENT_SCHEMA_V1,
    operation,
    run_id: String(intent.run_id),
    step_id: String(intent.step_id),
    idempotency_key: String(intent.idempotency_key),
    account_ref: String(intent.account_ref),
    allowed_origins: origins,
    ...(entryUrl ? { entry_url: entryUrl.href } : {}),
    target: { semantic_query: String(target.semantic_query).trim(), ...(target.target_key ? { target_key: String(target.target_key) } : {}) },
    ...(targetBinding ? { target_binding: targetBinding } : {}),
    ...(actionPlan ? { action_plan: actionPlan } : {}),
    payload_hash: payloadHash,
    approval_status: approvalStatus,
    authority_sha256: authoritySha,
    readback_required: true,
    no_replay: true,
  });
}

export function resolveLiveSemanticTarget({ intent, candidates } = {}) {
  const validated = validateWebOperationIntent(intent);
  if (!Array.isArray(candidates) || candidates.length > WEB_OPERATION_CONTRACT.operation_model.exploration_limits.max_candidates) {
    return { status: "blocked", exact_blocker: "web_operation_target_invalid", restart_point: "fresh bounded semantic readback" };
  }
  const scored = candidates.flatMap((candidate) => {
    if (!candidate || candidate.schema !== WEB_OPERATION_CONTRACT.operation_model.target_candidate_schema || candidate.visible !== true || candidate.enabled !== true) return [];
    if (!WEB_OPERATION_SHA256.test(String(candidate.target_digest || "")) || !WEB_OPERATION_SHA256.test(String(candidate.source_state_digest || ""))) return [];
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

export function admitWebOperationEffect({ intent, resolution } = {}) {
  const validated = validateWebOperationIntent(intent);
  if (validated.operation === "read") return resolution?.status === "resolved" ? { status: "admitted" } : { status: "blocked", exact_blocker: resolution?.exact_blocker || "web_operation_target_invalid" };
  if (resolution?.status !== "resolved") return { status: "blocked", exact_blocker: resolution?.exact_blocker || "web_operation_target_invalid" };
  if (validated.approval_status === "pending") return { status: "awaiting_approval", exact_blocker: "web_operation_approval_pending" };
  if (validated.approval_status !== "approved") return { status: "blocked", exact_blocker: "web_operation_approval_required" };
  return { status: "admitted" };
}

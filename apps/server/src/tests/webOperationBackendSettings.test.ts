import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { browserAuthRefForBackendSnapshot, browserSurfaceForWebOperationBackend, CHROME_PLUGIN_PROFILE2_AUTH_REF, DEFAULT_CHROME_PROFILE, DEFAULT_WEB_OPERATION_BACKEND, resolveWebOperationBackend, routeCompanionFirstWebOperationBackend, shouldAdoptNewerBackendMirror, webOperationBackendEnvironment, webOperationBackendReadback } from "../runs/webOperationBackendSettings.js";
import { isWebOperationBackendAdapterBound, runnerEntrypointExists, webOperationBackendAdapterCoverage, webOperationBackendAdapterReadOnlyBlocker } from "../runs/webOperationBackendAdapters.js";

test("web operation backend defaults to Chrome Plugin with Profile 2", () => {
  assert.equal(DEFAULT_WEB_OPERATION_BACKEND, "chrome_plugin");
  assert.equal(resolveWebOperationBackend(undefined, {}), "chrome_plugin");
  assert.deepEqual(DEFAULT_CHROME_PROFILE, {
    id: "profile2",
    name: "Profile 2",
    directory: "Profile 2",
    surface: "signed_chrome_extension_profile2",
  });
});

test("fixed Profile 2 supplies an internal browser-auth binding without a provider connection ref", () => {
  assert.equal(CHROME_PLUGIN_PROFILE2_AUTH_REF, "auth:chrome-profile2");
  assert.equal(browserAuthRefForBackendSnapshot({
    schema: "aos_web_operation_backend_snapshot.v1",
    requested_backend: "chrome_plugin",
    resolved_backend: "chrome_plugin",
    revision: 1,
    source: "aos_global_setting",
    fallback_allowed: false,
    chrome_profile: DEFAULT_CHROME_PROFILE,
    browser_surface: DEFAULT_CHROME_PROFILE.surface,
    exact_blocker: null,
  }), CHROME_PLUGIN_PROFILE2_AUTH_REF);
  assert.equal(browserAuthRefForBackendSnapshot({
    schema: "aos_web_operation_backend_snapshot.v1",
    requested_backend: "browser_use_cli",
    resolved_backend: "browser_use_cli",
    revision: 1,
    source: "aos_global_setting",
    fallback_allowed: false,
    chrome_profile: DEFAULT_CHROME_PROFILE,
    browser_surface: "browser_use_cli",
    exact_blocker: null,
  }), null);
});

test("web operation backend resolver keeps explicit UI selections exact", () => {
  assert.equal(resolveWebOperationBackend("browser-use-cli", {}), "browser_use_cli");
  assert.equal(resolveWebOperationBackend("playwright", {}), "playwright");
  assert.equal(resolveWebOperationBackend(undefined, { AOS_WEB_OPERATION_BACKEND: "browser_use_cli" }), "browser_use_cli");
  assert.throws(() => resolveWebOperationBackend("unsupported", {}), /web_operation_backend_unknown:unsupported/u);
});

test("Companion backend is effectful while official Chrome remains the stored default", () => {
  assert.equal(resolveWebOperationBackend("aos-chrome-companion", {}), "aos_chrome_companion");
  assert.equal(browserSurfaceForWebOperationBackend("aos_chrome_companion"), "aos_chrome_companion_profile_instance");
  assert.equal(resolveWebOperationBackend(undefined, {}), DEFAULT_WEB_OPERATION_BACKEND);
  assert.equal(isWebOperationBackendAdapterBound("aos_chrome_companion", "daily_ai_registered"), true);
  const coverage = webOperationBackendAdapterCoverage().find((item) => item.adapter === "daily_ai_registered");
  assert.equal(coverage?.aos_chrome_companion_mode, "effectful");
});

test("Companion environment exports its selected surface instead of legacy official profile metadata", () => {
  const environment = webOperationBackendEnvironment({
    requested_backend: "aos_chrome_companion",
    revision: 31,
    source: "aos_global_setting",
    fallback_allowed: false,
    chrome_profile: DEFAULT_CHROME_PROFILE,
  });
  assert.equal(environment.AOS_WEB_OPERATION_BACKEND, "aos_chrome_companion");
  assert.equal(environment.AOS_CHROME_PROFILE_SURFACE, "aos_chrome_companion_profile_instance");
});

test("adaptive Chrome extension router preserves continuity and selects an effect-capable surface before dispatch", () => {
  const normal = routeCompanionFirstWebOperationBackend({
    configuredBackend: "chrome_plugin",
    adapter: "daily_ai_registered",
    operationClass: "read_only",
  });
  assert.deepEqual({
    schema: normal.schema,
    routing_mode: normal.routing_mode,
    preferred_backend: normal.preferred_backend,
    configured_backend: normal.configured_backend,
    selected_backend: normal.selected_backend,
    route_reason: normal.route_reason,
    adapter: normal.adapter,
    operation_class: normal.operation_class,
    admission_status: normal.admission_status,
    exact_blocker: normal.exact_blocker,
    decision_scope: normal.decision_scope,
    frozen_after_dispatch: normal.frozen_after_dispatch,
    reroute_after_terminal_no_effect_only: normal.reroute_after_terminal_no_effect_only,
    extension_requirement: normal.extension_requirement,
    continuity_backend: normal.continuity_backend,
    official_extension_required: normal.official_extension_required,
  }, {
    schema: "browser_route_decision.v2",
    routing_mode: "adaptive_two_extension",
    preferred_backend: "chrome_plugin",
    configured_backend: "chrome_plugin",
    selected_backend: "aos_chrome_companion",
    route_reason: "companion_primary_for_normal_work",
    adapter: "daily_ai_registered",
    operation_class: "read_only",
    admission_status: "ready",
    exact_blocker: null,
    decision_scope: "browser_stage",
    frozen_after_dispatch: true,
    reroute_after_terminal_no_effect_only: true,
    extension_requirement: "automatic",
    continuity_backend: null,
    official_extension_required: false,
  });
  const registeredEffect = routeCompanionFirstWebOperationBackend({
    configuredBackend: "aos_chrome_companion",
    adapter: "daily_ai_registered",
    operationClass: "effect",
  });
  assert.equal(registeredEffect.selected_backend, "aos_chrome_companion");
  assert.equal(registeredEffect.route_reason, "companion_effect_adapter_available");
  assert.equal(registeredEffect.admission_status, "ready");
  assert.equal(registeredEffect.exact_blocker, null);
  assert.equal(routeCompanionFirstWebOperationBackend({
    configuredBackend: "aos_chrome_companion",
    operationClass: "normal",
    requiresOfficialExtension: true,
  }).route_reason, "official_extension_explicitly_required");
  assert.equal(routeCompanionFirstWebOperationBackend({
    configuredBackend: "browser_use_cli",
    operationClass: "normal",
    extensionRequirement: "official_extension",
  }).selected_backend, "chrome_plugin");
  assert.equal(routeCompanionFirstWebOperationBackend({
    configuredBackend: "chrome_plugin",
    operationClass: "normal",
    extensionRequirement: "companion_extension",
  }).route_reason, "companion_extension_explicitly_required");
  const companionEffect = routeCompanionFirstWebOperationBackend({
    configuredBackend: "aos_chrome_companion",
    adapter: "daily_ai_registered",
    operationClass: "effect",
    extensionRequirement: "companion_extension",
  });
  assert.equal(companionEffect.selected_backend, "aos_chrome_companion");
  assert.equal(companionEffect.admission_status, "ready");
  assert.equal(companionEffect.exact_blocker, null);
  const missingTwoExtensionAdapter = routeCompanionFirstWebOperationBackend({
    configuredBackend: "aos_chrome_companion",
    adapter: "nisenprints_registered",
    operationClass: "effect",
  });
  assert.equal(missingTwoExtensionAdapter.selected_backend, "aos_chrome_companion");
  assert.equal(missingTwoExtensionAdapter.admission_status, "ready");
  assert.equal(missingTwoExtensionAdapter.exact_blocker, null);
  const continuity = routeCompanionFirstWebOperationBackend({
    configuredBackend: "aos_chrome_companion",
    operationClass: "normal",
    continuityBackend: "chrome_plugin",
    preserveActiveRunContinuity: true,
  });
  assert.equal(continuity.selected_backend, "chrome_plugin");
  assert.equal(continuity.route_reason, "active_run_continuity_preserved");
  const continuityConflict = routeCompanionFirstWebOperationBackend({
    configuredBackend: "aos_chrome_companion",
    operationClass: "normal",
    extensionRequirement: "companion_extension",
    continuityBackend: "chrome_plugin",
    preserveActiveRunContinuity: true,
  });
  assert.equal(continuityConflict.admission_status, "blocked");
  assert.equal(continuityConflict.exact_blocker, "web_operation_active_run_continuity_conflict:chrome_plugin:aos_chrome_companion");
  assert.equal(routeCompanionFirstWebOperationBackend({
    configuredBackend: "browser_use_cli",
    operationClass: "normal",
  }).selected_backend, "browser_use_cli");
});

test("newer official selector mirror supersedes stale control-plane revision", () => {
  assert.equal(shouldAdoptNewerBackendMirror(4, {
    source: "automation_os",
    backend: "chrome_plugin",
    revision: 30,
  }), true);
  assert.equal(shouldAdoptNewerBackendMirror(30, {
    source: "automation_os",
    backend: "chrome_plugin",
    revision: 4,
  }), false);
  assert.equal(shouldAdoptNewerBackendMirror(4, {
    source: "unknown",
    backend: "chrome_plugin",
    revision: 30,
  }), false);
});

test("Chrome Plugin coverage distinguishes effectful, entrypoint-only, and unbound adapters", () => {
  assert.equal(isWebOperationBackendAdapterBound("chrome_plugin", "daily_ai_registered"), true);
  assert.equal(isWebOperationBackendAdapterBound("chrome_plugin", "sns_multi_poster_registered"), true);
  assert.equal(isWebOperationBackendAdapterBound("chrome_plugin", "x_authenticated_browser_lane_registered"), true);
  assert.equal(isWebOperationBackendAdapterBound("chrome_plugin", "job_submit_registered"), true);
  assert.equal(isWebOperationBackendAdapterBound("chrome_plugin", "prompt_transfer_registered"), true);
  assert.equal(isWebOperationBackendAdapterBound("chrome_plugin", "nisenprints_registered"), false);
  const job = webOperationBackendAdapterCoverage().find((item) => item.adapter === "job_submit_registered");
  assert.deepEqual(job && {
    chrome_plugin: job.chrome_plugin,
    chrome_plugin_mode: job.chrome_plugin_mode,
    chrome_plugin_exact_blocker: job.chrome_plugin_exact_blocker,
  }, {
    chrome_plugin: true,
    chrome_plugin_mode: "effectful",
    chrome_plugin_exact_blocker: null,
  });
  const prompt = webOperationBackendAdapterCoverage().find((item) => item.adapter === "prompt_transfer_registered");
  assert.deepEqual(prompt && {
    chrome_plugin: prompt.chrome_plugin,
    chrome_plugin_mode: prompt.chrome_plugin_mode,
    chrome_plugin_exact_blocker: prompt.chrome_plugin_exact_blocker,
    chrome_plugin_runner_entrypoint: prompt.chrome_plugin_runner_entrypoint,
  }, {
    chrome_plugin: true,
    chrome_plugin_mode: "effectful",
    chrome_plugin_exact_blocker: null,
    chrome_plugin_runner_entrypoint: "New project/scripts/run_prompt_transfer_chrome_plugin_registered.mjs",
  });
  const previousMirror = process.env.AOS_WEB_OPERATION_BACKEND_CONFIG;
  const isolatedMirror = join(mkdtempSync(join(tmpdir(), "aos-web-operation-backend-test-")), "web-operation-backend.json");
  process.env.AOS_WEB_OPERATION_BACKEND_CONFIG = isolatedMirror;
  try {
    const readback = webOperationBackendReadback();
    assert.equal(Array.isArray(readback.adapter_coverage), true);
    assert.equal(readback.adapter_coverage.length, 7);
    assert.equal(readback.local_sync.path, isolatedMirror);
    assert.equal(readback.local_sync.written, true);
    const mirror = JSON.parse(readFileSync(isolatedMirror, "utf8"));
    assert.equal(mirror.route_authority, "adaptive_two_extension_resolver");
    assert.equal(mirror.routing_mode, "adaptive_two_extension");
    assert.equal(mirror.preferred_backend, readback.setting.backend);
    assert.equal(mirror.backend_role, "preferred_backend_not_final_route");
    assert.equal(mirror.browser_surface, browserSurfaceForWebOperationBackend(readback.setting.backend, readback.setting.chrome_profile.surface));
    assert.equal(mirror.preferred_browser_surface, browserSurfaceForWebOperationBackend(readback.setting.backend, readback.setting.chrome_profile.surface));
    assert.equal(mirror.browser_surface_role, "preferred_surface_not_run_proof");
    assert.equal(mirror.chrome_profile_surface_role, "profile_metadata_only_not_route_authority");
    assert.equal(mirror.routing_policy.decision_scope, "browser_stage_before_skill_or_preflight");
    assert.equal(mirror.routing_policy.preserve_active_run_backend, true);
    assert.equal(mirror.routing_policy.normal_default, "aos_chrome_companion");
    assert.equal(mirror.routing_policy.effect_adapter_resolution, "effectful_adapter_required");
    assert.equal(mirror.routing_policy.no_post_dispatch_fallback, true);
    assert.equal(mirror.routing_policy.reroute_after_terminal_no_effect_only, true);
    assert.equal(mirror.routing_policy.safe_surface_handoff_schema, "aos.safe_extension_surface_handoff.v1");
    assert.equal(mirror.routing_policy.safe_surface_handoff_direction, "aos_chrome_companion_to_chrome_plugin_once");
    assert.equal(mirror.routing_policy.proactive_visual_readback_required, true);
    assert.deepEqual(mirror.routing_policy.unsafe_handoff_conditions, [
      "operation_effect_unknown",
      "reconciliation_required",
      "semantic_visual_conflict",
      "auth_or_human_verification",
      "target_or_owner_ambiguity",
    ]);
  } finally {
    if (previousMirror === undefined) delete process.env.AOS_WEB_OPERATION_BACKEND_CONFIG;
    else process.env.AOS_WEB_OPERATION_BACKEND_CONFIG = previousMirror;
  }
});

test("alternate backend coverage does not claim missing runners are bound", () => {
  assert.equal(isWebOperationBackendAdapterBound("browser_use_cli", "daily_ai_registered"), true);
  assert.equal(isWebOperationBackendAdapterBound("browser_use_cli", "prompt_transfer_registered"), true);
  assert.equal(isWebOperationBackendAdapterBound("browser_use_cli", "sns_multi_poster_registered"), true);
  assert.equal(isWebOperationBackendAdapterBound("browser_use_cli", "x_authenticated_browser_lane_registered"), true);
  assert.equal(isWebOperationBackendAdapterBound("playwright", "daily_ai_registered"), false);
  const playwright = webOperationBackendAdapterCoverage().find((item) => item.adapter === "daily_ai_registered");
  assert.deepEqual(playwright && {
    playwright: playwright.playwright,
    playwright_mode: playwright.playwright_mode,
    playwright_exact_blocker: playwright.playwright_exact_blocker,
    playwright_runner_entrypoint: playwright.playwright_runner_entrypoint,
  }, {
    playwright: false,
    playwright_mode: "entrypoint_only",
    playwright_exact_blocker: "playwright_effect_stages_not_implemented",
    playwright_runner_entrypoint: "automation-os/scripts/aos-playwright-business-runner.mjs",
  });
  const sns = webOperationBackendAdapterCoverage().find((item) => item.adapter === "sns_multi_poster_registered");
  assert.deepEqual(sns && {
    browser_use_cli: sns.browser_use_cli,
    browser_use_cli_mode: sns.browser_use_cli_mode,
    browser_use_cli_exact_blocker: sns.browser_use_cli_exact_blocker,
  }, {
    browser_use_cli: true,
    browser_use_cli_mode: "effectful",
    browser_use_cli_exact_blocker: null,
  });
  const x = webOperationBackendAdapterCoverage().find((item) => item.adapter === "x_authenticated_browser_lane_registered");
  assert.deepEqual(x && {
    browser_use_cli: x.browser_use_cli,
    browser_use_cli_mode: x.browser_use_cli_mode,
    browser_use_cli_exact_blocker: x.browser_use_cli_exact_blocker,
    browser_use_cli_runner_entrypoint: x.browser_use_cli_runner_entrypoint,
  }, {
    browser_use_cli: true,
    browser_use_cli_mode: "effectful",
    browser_use_cli_exact_blocker: null,
    browser_use_cli_runner_entrypoint: "New project/scripts/run_x_authenticated_browser_lane_browser_use_cli.mjs",
  });
});

test("runtime adapter coverage rejects a missing current-run entrypoint", () => {
  assert.equal(runnerEntrypointExists("missing/current-runner.mjs"), false);
  assert.equal(runnerEntrypointExists("automation-os/scripts/aos-playwright-business-runner.mjs"), true);
  assert.equal(runnerEntrypointExists("New project/scripts/run_prompt_transfer_chrome_plugin_registered.mjs"), true);
});

test("read-only preflight follows adapter coverage without treating entrypoint-only as effectful", () => {
  assert.equal(webOperationBackendAdapterReadOnlyBlocker("chrome_plugin", "nisenprints_registered"), null);
  assert.equal(webOperationBackendAdapterReadOnlyBlocker("browser_use_cli", "sns_multi_poster_registered"), null);
  assert.equal(
    webOperationBackendAdapterReadOnlyBlocker("browser_use_cli", "x_authenticated_browser_lane_registered"),
    null,
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import { bindBrowserSession, browserCommandReceipt, getBrowserKernelContract, resolveSemanticTarget, validateBrowserCommand } from "../browser/browserKernel.js";
import { buildCapabilityManifest, planAgainstCapabilities } from "../browser/capabilityRegistry.js";
import { detectBrowserDrift, fingerprintBrowserPage } from "../browser/driftDetector.js";
import { browserRouteAdapters, resolveBrowserRouteAdapter } from "../browser/routeAdapters.js";
import { browserSurfaceAdapters } from "../browser/browserSurfaceAdapters.js";
import { compileTaskPlan, fieldProvenance, replanTaskPlan, validateTaskDsl } from "../taskContracts/taskDsl.js";
import { buildTaskContractPreview } from "../taskContracts/taskContract.js";
import { verifyEnvironmentParity } from "../runs/environmentParity.js";
import { executeShadowMode, promoteShadowToEffectful } from "../runs/shadowMode.js";
import { buildHookWatchdog, observeHookWatchdog } from "../runs/hookWatchdog.js";
import { issueEphemeralCapability, verifyEphemeralCapability } from "../security/ephemeralCapability.js";

const hash = "a".repeat(64);
const future = new Date(Date.now() + 60_000).toISOString();

function dsl(verb: "read" | "draft" | "submit" = "read") {
  return {
    schema: "automation_os_task_dsl.v1" as const,
    task_id: `task-${verb}`,
    workflow_id: "generic-task",
    objective: verb === "submit" ? "求人1件へ応募し、visible provider receiptとsource syncを得る" : "候補を読み取る",
    intent: { verb, target_description: "semantic target" },
    inputs: [fieldProvenance({ field: "target", source: "current_page", valueRef: "job:one", valueSha256: hash }), fieldProvenance({ field: "payload", source: "profile", valueRef: "resume:ja:sha256", valueSha256: hash, effectEligible: verb !== "submit" ? true : true })],
    constraints: { max_effects: verb === "submit" ? 1 : 0, allowed_origins: ["https://jobs.example"], required_capabilities: verb === "submit" ? ["observe", "locate", "scroll", "fill", "upload", "submit", "visible_confirmation"] : ["observe", "locate"], sources: [] },
    completion: { provider_receipt: true, source_sync: true, reconciliation: true, cleanup: true, visible_confirmation: verb === "submit" },
  };
}

test("Task DSL compiles risk-specific graph and omits unnecessary gates", () => {
  const plan = compileTaskPlan(dsl("read"));
  assert.equal(plan.task_class, "read_only");
  assert.ok(plan.nodes.some((node) => node.id === "observe"));
  assert.ok(!plan.nodes.some((node) => node.id === "approval"));
  assert.ok(plan.omitted.includes("G0"));
  assert.ok(plan.omitted.includes("G1"));
  assert.ok(plan.omitted.includes("release_stage"));
  assert.ok(validateTaskDsl(dsl("submit")));
});

test("compiler keeps one-item external effect preview and replans only safe dependents", () => {
  const plan = compileTaskPlan(dsl("submit"));
  assert.equal(plan.task_class, "external_effect");
  assert.deepEqual(plan.nodes.filter((node) => node.id === "approval").map((node) => node.depends_on), [["preview"]]);
  const replanned = replanTaskPlan({ ...plan, nodes: plan.nodes.map((node) => node.id === "observe" ? { ...node, status: "complete" as const } : node) }, { blockedNodeId: "locate", exactBlocker: "browser_page_drift_reobserve_required" });
  assert.equal(replanned.exact_blocker, "browser_page_drift_reobserve_required");
  assert.equal(replanned.nodes.find((node) => node.id === "observe")?.status, "preserved");
  assert.match(replanned.restart_point, /preserve completed dependencies/);
});

test("inferred provenance cannot enter an effectful DSL", () => {
  assert.throws(() => validateTaskDsl({ ...dsl("submit"), inputs: [fieldProvenance({ field: "answer", source: "inferred", valueRef: "unknown", valueSha256: hash, effectEligible: true })] }), /task_dsl_inferred_effect_value_forbidden/);
});

test("capability registry returns exact missing capability and safe alternative", () => {
  const manifest = buildCapabilityManifest({ runId: "run-cap", sessionId: "session-cap", surface: "browser_use_cli", capabilities: { observe: true, locate: true }, allowedOrigins: ["https://jobs.example"], profileBindingRef: "profile-binding", sourceStateRef: "state", expiresAt: future, alternativeStage: "read_only_discovery_without_upload" });
  const decision = planAgainstCapabilities(manifest, ["observe", "upload"]);
  assert.equal(decision.status, "blocked");
  assert.deepEqual(decision.missing, ["upload"]);
  assert.equal(decision.alternative_stage, "read_only_discovery_without_upload");
});

test("browser kernel resolves semantic targets by AX/DOM/text before coordinate fallback", () => {
  const candidate = (source: "accessibility_tree" | "dom" | "visible_text" | "coordinate_fallback", id: string) => ({ candidate_id: id, source, semantic_role: "button", accessible_name: "Apply", visible_text: "Apply", visible: true, enabled: true, target_digest: hash, source_state_digest: hash, ...(source === "coordinate_fallback" ? { coordinate: { x: 10, y: 10 } } : {}) });
  const resolved = resolveSemanticTarget({ query: "Apply", candidates: [candidate("coordinate_fallback", "coord"), candidate("accessibility_tree", "ax")] });
  assert.equal(resolved.status, "resolved");
  if (resolved.status === "resolved") assert.equal(resolved.candidate.candidate_id, "ax");
  const ambiguous = resolveSemanticTarget({ query: "Apply", candidates: [candidate("visible_text", "one"), candidate("visible_text", "two")] });
  assert.equal(ambiguous.status, "blocked");
  if (ambiguous.status === "blocked") assert.equal(ambiguous.error_code, "target_ambiguous");
});

test("browser kernel command and receipt bind one run/session and require submit confirmation", () => {
  const session = bindBrowserSession({ runId: "run-browser", sessionId: "session-browser", surface: "codex_app_browser", authorityDigest: hash, allowedOrigins: ["https://jobs.example"], expiresAt: future });
  const command = { schema: "automation_os_browser_command.v1" as const, command_id: "cmd-observe", sequence: 0, kind: "observe" as const, session: { run_id: session.run_id, session_id: session.session_id, surface: session.surface, authority_digest: session.authority_digest }, timeout_ms: 1000, precondition: {}, postcondition: { expected: "changed" as const, receipt_required: true } };
  assert.doesNotThrow(() => validateBrowserCommand(command, session));
  assert.throws(() => validateBrowserCommand({ ...command, session: { ...command.session, run_id: "other" } }, session), /same_run_binding/);
  const submit = { ...command, command_id: "cmd-submit", sequence: 1, kind: "submit" as const, target: { semantic_query: "Submit application" }, effect_preview: { target_digest: hash, payload_sha256: hash, audience_digest: hash }, approval_id: "approval-1" };
  const receipt = browserCommandReceipt({ command: submit, session, status: "ok", before: hash, after: hash, targetDigest: hash, providerReceiptDigest: hash, externalActionExecuted: true, visibleConfirmation: true, cleanupVerified: true });
  assert.equal(receipt.same_run, true);
  assert.equal(receipt.surface, "codex_app_browser");
});

test("drift forces re-observe and never reuses old selector/coordinate", () => {
  const previous = fingerprintBrowserPage({ route: "/apply", dom: "old", accessibilityTree: "Apply", visibleText: "Apply", labels: ["Apply"] });
  const current = fingerprintBrowserPage({ route: "/apply", dom: "new", accessibilityTree: "Continue", visibleText: "Continue", labels: ["Continue"] });
  const result = detectBrowserDrift(previous, current);
  assert.equal(result.status, "drifted");
  assert.equal(result.exact_blocker, "browser_page_drift_reobserve_required");
});

test("CLI and Codex App surfaces share the same kernel and route SDK", () => {
  assert.deepEqual(getBrowserKernelContract().supported_surfaces, ["browser_use_cli", "codex_app_browser"]);
  assert.equal(browserSurfaceAdapters.length, 2);
  for (const adapter of browserRouteAdapters) assert.equal(adapter.selector_authority, "semantic_only");
  assert.equal(resolveBrowserRouteAdapter({ origin: "https://jobs.ashbyhq.com/acme", title: "Careers" })?.id, "ashby");
  assert.equal(resolveBrowserRouteAdapter({ surface: "codex_app_browser" })?.id, "codex_app_surface");
});

test("shadow mode preserves target binding and blocks changed promotion", () => {
  const contract = buildTaskContractPreview({ contract_id: "contract-shadow", task_id: "task-shadow", workflow_id: "generic-task", task_class: "external_effect", intent_kind: "submit", intent_ref: "intent:shadow", target_ref: "target:one", target_digest: hash, account_ref: "account:one", payload_ref: "resume:hash", payload_digest: hash, audience: "company:job:one", owner: "owner:one", authority_ref: "authority:one", authority_digest: hash, idempotency_key: "idem-shadow" });
  const shadow = executeShadowMode({ ...contract, approval: { ...contract.approval, status: "approved" } });
  assert.equal(shadow.external_action_executed, false);
  assert.equal(shadow.cleanup, "verified");
  assert.equal(promoteShadowToEffectful({ shadow, freshTargetBindingDigest: "b".repeat(64), approved: true }).status, "blocked");
  assert.equal(promoteShadowToEffectful({ shadow, freshTargetBindingDigest: shadow.target_binding_digest, approved: true }).status, "eligible");
});

test("ephemeral capability is task/target/expiry/effect bounded and never needs browser storage", () => {
  const token = issueEphemeralCapability({ capabilityId: "cap-1", taskId: "task-1", targetDigest: hash, authorityDigest: hash, provider: "greenhouse", expiresAt: future, maxEffects: 1, allowedEffects: ["one_candidate_submit"], secretStoreMaterial: "test-only-secret-material" });
  const claims = verifyEphemeralCapability(token, "test-only-secret-material");
  assert.equal(claims.task_id, "task-1");
  assert.equal(claims.max_effects, 1);
  assert.throws(() => verifyEphemeralCapability(token, "wrong-secret"), /signature_invalid/);
});

test("hook failure degrades read-only but trips external effect", () => {
  const initial = buildHookWatchdog("task-hook");
  const read = observeHookWatchdog(initial, { heartbeat: false, taskClass: "read_only" });
  assert.equal(read.mode, "degraded");
  assert.equal(read.read_only_continue, true);
  const external = observeHookWatchdog(initial, { heartbeat: false, taskClass: "external_effect" });
  assert.equal(external.mode, "tripped");
  assert.equal(external.external_effect_fail_closed, true);
});

test("environment parity blocks mixed source/runtime/artifact/deployment", () => {
  const result = verifyEnvironmentParity({ source: { name: "source", digest: "a" }, installed_runtime: { name: "runtime", digest: "a" }, artifact: { name: "artifact", digest: "b" }, deployment: { name: "deploy", digest: "a" } });
  assert.equal(result.status, "blocked");
  assert.equal(result.exact_blocker, "environment_source_runtime_artifact_deployment_parity_mismatch");
});

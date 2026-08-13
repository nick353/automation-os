import assert from "node:assert/strict";
import test from "node:test";
import { advanceCanaryRing, appendTrace, compileNaturalLanguagePolicy, consumeRiskBudget, createRiskBudget, createTrace, evaluateBackpressure, outcomeContract, routeSurface, selectAccountProfile } from "../taskContracts/taskOsPolicy.js";
import { anonymizeRouteLearning, versionedAdapters } from "../browser/adapterVersioning.js";

test("surface router keeps UI-free tasks off Browser Use and uses only allowed canonical fallback", () => {
  const api = routeSurface({ uiRequired: false, available: ["api", "browser_use_cli"], allowed: ["api", "connector", "local", "browser_use_cli"] });
  assert.equal(api.selected, "api");
  const browser = routeSurface({ uiRequired: true, available: ["browser_use_cli"], allowed: ["browser_use_cli", "codex_app_browser"] });
  assert.equal(browser.selected, "browser_use_cli");
});

test("risk budget stops at one effect, scope, time, or amount boundary", () => {
  let budget = createRiskBudget({ task_id: "task-budget", max_effects: 1, max_minutes: 5, max_amount_cents: 0, allowed_domains: ["jobs.example"], allowed_accounts: ["account:1"] });
  budget = consumeRiskBudget(budget, { effects: 1, minutes: 1, domain: "jobs.example", account: "account:1" });
  assert.equal(budget.status, "within_budget");
  budget = consumeRiskBudget(budget, { effects: 1, minutes: 1, domain: "jobs.example", account: "account:1" });
  assert.equal(budget.status, "stopped");
  assert.equal(budget.exact_blocker, "risk_budget_exceeded_or_scope_mismatch");
});

test("policy compiler asks for exactly one missing field and does not infer effect payload", () => {
  const missing = compileNaturalLanguagePolicy("応募して", { knownFields: { target: { source: "current_page", valueRef: "job:1" }, account: { source: "profile", valueRef: "account:1" } } });
  assert.equal(missing.status, "needs_input");
  assert.deepEqual(missing.missing, ["payload"]);
  const ready = compileNaturalLanguagePolicy("応募して", { knownFields: { target: { source: "current_page", valueRef: "job:1" }, account: { source: "profile", valueRef: "account:1" }, payload: { source: "profile", valueRef: "resume:sha256" } } });
  assert.equal(ready.status, "ready");
  assert.equal(ready.task?.inputs.find((field) => field.field === "payload")?.source, "profile");
});

test("account/profile pool blocks provider, locale, audience and expiry mismatch", () => {
  const selected = selectAccountProfile([{ provider: "greenhouse", account_ref: "account:1", resume_ref: "resume:ja", resume_sha256: "a".repeat(64), locale: "ja-JP", audience: "company:job:1", expires_at: new Date(Date.now() + 10_000).toISOString(), status: "eligible" }], { provider: "greenhouse", accountRef: "account:1", locale: "ja-JP", audience: "company:job:1" });
  assert.equal(selected.status, "selected");
  assert.equal(selectAccountProfile(selected.profile ? [selected.profile] : [], { provider: "lever", accountRef: "account:1" }).status, "blocked");
});

test("outcome contract rejects shallow completion signals by contract", () => {
  const outcome = outcomeContract("external_effect", "provider submitted one candidate");
  assert.deepEqual(outcome.forbidden_completion_signals, ["queued", "preflight", "screenshot", "cleanup_only"]);
  assert.equal(outcome.visible_confirmation_required, true);
});

test("canary ring advances only in order with fresh proof", () => {
  const initial = { schema: "automation_os_canary_ring.v1" as const, adapter_id: "greenhouse", stage: "fixture" as const, external_action_executed: false, same_run_receipt: true, source_sync: true, reconciliation: true, cleanup: true, exact_blocker: null };
  const noEffect = advanceCanaryRing(initial, "no_effect", { externalActionExecuted: false, receipt: true, sourceSync: true, reconciliation: true, cleanup: true });
  assert.equal(noEffect.stage, "no_effect");
  const privateTest = advanceCanaryRing(noEffect, "private_test", { externalActionExecuted: false, receipt: true, sourceSync: true, reconciliation: true, cleanup: true, privateTestApproved: true });
  assert.equal(privateTest.stage, "private_test");
  const blocked = advanceCanaryRing(privateTest, "one_effect", { externalActionExecuted: false, receipt: true, sourceSync: true, reconciliation: true, cleanup: true });
  assert.equal(blocked.exact_blocker, "canary_ring_effect_promotion_proof_missing");
});

test("trace and backpressure keep waiting distinct from completed", () => {
  let trace = createTrace("trace-1", "task-1");
  trace = appendTrace(trace, { kind: "browser", stage: "observe", status: "running", exact_blocker: null, proof: null }, { current_stage: "observe", exact_blocker: null, next_action: "locate", restart_point: "observe", proof: [] });
  assert.equal(trace.readback.current_stage, "observe");
  const queued = evaluateBackpressure({ provider_rate_limit_ok: false, worker_load_ok: true, profile_lease_ok: true, port_lease_ok: true, concurrency_ok: true });
  assert.equal(queued.status, "queued");
  assert.equal(queued.exact_blocker, "backpressure_provider_worker_lease_or_concurrency");
});

test("versioned adapter changes are isolated and learning never carries old authority/target/receipt/approval", () => {
  assert.ok(versionedAdapters.some((adapter) => adapter.adapter_id === "workday"));
  const learning = anonymizeRouteLearning({ adapterId: "greenhouse", route: "/apply", labels: ["Submit"], roles: ["button"] });
  assert.equal(learning.reused_authority, false);
  assert.equal(learning.reused_target, false);
  assert.equal(learning.reused_receipt, false);
  assert.equal(learning.reused_approval, false);
});

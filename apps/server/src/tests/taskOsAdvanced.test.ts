import assert from "node:assert/strict";
import test from "node:test";
import { EffectLedger, compensateSaga, enforceTrustedEffectInputs, operationKey, planDiff, verifyIdentityContinuity, universalTarget, crossWorkflowLedger, portableTaskPackage, newHumanFrictionSlo } from "../taskContracts/taskOsAdvanced.js";
import { adaptiveWait, chaosCases, correctionFeedback, downgradeAdapterOnFailures, humanDemonstration, offlineReplay, redactSnapshot, targetConfidence } from "../browser/browserReliability.js";
import { adapterSandbox, isKilled, killSwitch, scopedLease, revokeLease } from "../security/operationalControls.js";

const hash = "a".repeat(64);

test("page/email/SNS instructions cannot mutate trusted effect admission", () => {
  const result = enforceTrustedEffectInputs({ target: { field: "target", source: "aos_source_of_truth", ref: "target:1", sha256: hash }, account: { field: "account", source: "aos_source_of_truth", ref: "account:1", sha256: hash }, payload: { field: "payload", source: "aos_source_of_truth", ref: "resume:hash", sha256: hash }, approval: { field: "approval", source: "aos_source_of_truth", ref: "approval:1", sha256: hash }, pageValues: [{ field: "target", source: "page_source", ref: "attacker", sha256: hash }] });
  assert.equal(result.effect_admitted, false);
  assert.equal(result.exact_blocker, "untrusted_page_data_cannot_change_effect_admission");
});

test("identity continuity and negative capabilities fail closed", () => {
  assert.equal(verifyIdentityContinuity({ providerAccount: "a", expectedAccount: "a", company: "c", expectedCompany: "c", locale: "ja", expectedLocale: "ja", profileRef: "p", expectedProfileRef: "other" }).status, "blocked");
});

test("Effect Ledger gives one operation key and never replays ambiguous intent", () => {
  const input = { taskId: "task-1", targetHash: hash, payloadHash: hash, audienceHash: hash, idempotencyKey: "idem-1" };
  assert.equal(operationKey(input), operationKey(input));
  const ledger = new EffectLedger();
  const first = ledger.reserve(input);
  assert.equal(first.replay, false);
  assert.equal(ledger.reserve(input).replay, true);
  ledger.apply(first.record.operation_key, "admit"); ledger.apply(first.record.operation_key, "start"); ledger.apply(first.record.operation_key, "intent_sent");
  const ambiguous = ledger.apply(first.record.operation_key, "ambiguous");
  assert.equal(ambiguous.retry_forbidden, true);
  assert.throws(() => ledger.apply(first.record.operation_key, "start"), /effect_transition_invalid/);
});

test("Saga compensates completed prior steps and closes later", () => {
  const saga = { schema: "automation_os_saga.v1" as const, task_id: "task-saga", status: "running" as const, exact_blocker: null, steps: [{ id: "claim", action: "claim", compensation: "release_claim", status: "completed" as const }, { id: "upload", action: "upload", compensation: "discard_draft", status: "blocked" as const }] };
  const result = compensateSaga(saga, "upload");
  assert.equal(result.status, "compensating");
  assert.equal(result.steps[0].status, "compensated");
});

test("target confidence rejects low-confidence or duplicate resolution", () => {
  assert.equal(targetConfidence({ candidate_id: "one", confidence: 0.7, evidence: ["visible_text"], unique: true }).action_allowed, false);
  assert.equal(targetConfidence({ candidate_id: "one", confidence: 0.95, evidence: ["accessibility_tree", "label"], unique: true }).action_allowed, true);
});

test("adaptive wait and chaos cases are fixed primitives", () => {
  assert.equal(adaptiveWait(["dom_changed", "loading_cleared"]).fixed_sleep, false);
  assert.ok(chaosCases().includes("double_submit"));
});

test("adapter health downgrades effectful lane without stopping read-only globally", () => {
  assert.equal(downgradeAdapterOnFailures({ adapter_id: "x", provider_errors: 3, timeout_count: 0, drift_count: 0, mode: "effectful" }).mode, "read_only");
});

test("redacted snapshot supports offline replay without external action", () => {
  const snapshot = redactSnapshot({ runId: "run-replay", stage: "observe", route: "https://jobs.example", dom: "token=secret", ax: "Apply", state: "ready" });
  const replay = offlineReplay(snapshot);
  assert.equal(replay.status, "replayable");
  assert.equal(replay.external_action_executed, false);
});

test("human demonstration is quarantined and correction stores meaning not selector", () => {
  assert.equal(humanDemonstration({ demoId: "demo-1", semanticSteps: ["open application form", "upload resume"] }).effect_quarantined, true);
  assert.equal(correctionFeedback("choose the visible application upload control", 0.9).old_selector_reused, false);
});

test("scoped leases, adapter sandbox and kill switches are individually revocable", () => {
  const lease = scopedLease({ lease_id: "lease-1", task_id: "task-1", target_digest: hash, scope: "one_candidate_submit", expires_at: new Date(Date.now() + 10_000).toISOString() });
  assert.equal(revokeLease(lease).revoked, true);
  assert.deepEqual(adapterSandbox("greenhouse", ["https://greenhouse.io"], "job-application-manager").allowed_secrets, []);
  assert.equal(isKilled([killSwitch("provider", "greenhouse", "incident")], { provider: "greenhouse" }), true);
});

test("universal target, memory/package, cross-workflow ledger and plan diff remain versioned", () => {
  const target = universalTarget({ provider: "greenhouse", object_type: "job", stable_id: "job-1", url: "https://greenhouse.io/job-1", audience: "company:1", owner: "owner:1" });
  const ledger = crossWorkflowLedger({ universalTarget: target, domains: ["job", "mail"], operationKeys: ["operation-1", "operation-1"] });
  assert.equal(ledger.duplicate, true);
  assert.equal(planDiff({ target: "a", account: "b", payload: "c", audience: "d", effect_scope: "one" }, { target: "a", account: "b", payload: "changed", audience: "d", effect_scope: "one" }).reapproval_required, true);
  assert.equal(portableTaskPackage({ version: "1.0.0", migration_from: [], task_dsl_version: "1", adapter_version: "1", policy_version: "1", fixture_version: "1", receipt_schema_version: "1", task: { kind: "read" }, adapter: { id: "greenhouse" }, policy: { scope: "read" }, fixture_ref: "fixture:1" }).no_secrets, true);
  assert.equal(newHumanFrictionSlo().wrong_target_count, 0);
});

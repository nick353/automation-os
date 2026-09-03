import assert from "node:assert/strict";
import test from "node:test";
import { buildCompanyBindingReconciliationV1, type CompanyBindingReconciliationInput } from "../runs/companyBindingReconciliation.js";
import { buildCanonicalCompanyConsultationV1 } from "../runs/canonicalCompanyConsultation.js";

function reconciliation(overrides: Partial<CompanyBindingReconciliationInput> = {}) {
  return buildCompanyBindingReconciliationV1({
    now: "2026-09-03T00:00:00.000Z",
    requested_company_id: "company-local",
    trigger_company_id: "company-trigger",
    trigger_provenance: "test-registered-readback",
    trigger_sources: [{
      id: "registered-trigger",
      name: "Registered trigger",
      status: "ACTIVE",
      rrule: "FREQ=DAILY",
      company_id: "company-trigger",
      automation_id: "automation-trigger",
      provenance: "test-source"
    }],
    local_companies: [{
      company_id: "company-local",
      name: "Local company",
      status: "active",
      automation_count: 2,
      automation_ids: ["automation-local-1", "automation-local-2"],
      schedule_ids: ["schedule-local-1", "schedule-local-2"],
      provenance: "test-sql-readback"
    }],
    ...overrides
  });
}

function snapshot(fresh = true) {
  return {
    snapshot_id: "test-snapshot-1",
    captured_at: "2026-09-03T00:00:00.000Z",
    provenance: "test-fresh-reconciliation",
    fresh
  };
}

test("consultation preserves both company candidates and never recommends or selects one", () => {
  const result = buildCanonicalCompanyConsultationV1({ reconciliation: reconciliation(), snapshot: snapshot() });

  assert.equal(result.schema, "canonical_company_consultation.v1");
  assert.equal(result.status, "blocked");
  assert.equal(result.selection_state, "unresolved");
  assert.equal(result.canonical_company_id, null);
  assert.deepEqual(result.candidates.map((candidate) => candidate.company_id), ["company-local", "company-trigger"]);
  assert.deepEqual(result.candidates.map((candidate) => candidate.counts), [
    { registered_automations: 0, local_automations: 2, schedules: 2 },
    { registered_automations: 1, local_automations: 0, schedules: 0 }
  ]);
  assert.equal(result.owner_decision.required, true);
  assert.equal(result.owner_decision.recommended_candidate_company_id, null);
  assert.equal(result.exact_blocker, "canonical_company_unresolved");
  assert.equal(result.downstream.schedule_activation.status, "blocked");
  assert.equal(result.downstream.brief.delivery_status, "blocked");
  assert.equal(result.downstream.provider_receipt.status, "not_attempted");
  assert.equal(result.downstream.source_sync.status, "not_attempted");
  assert.equal(result.downstream.reconciliation.status, "not_attempted");
  assert.equal(result.downstream.cleanup.status, "not_attempted");
  assert.equal(result.external_action_executed, false);
  assert.doesNotMatch(JSON.stringify(result), /secret-token-sentinel|private-prompt-marker/u);
});
test("stale reconciliation fails closed without exposing candidates or enabling Chat demo", () => {
  const result = buildCanonicalCompanyConsultationV1({ reconciliation: reconciliation(), snapshot: snapshot(false) });

  assert.equal(result.selection_state, "unresolved");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.chat.consultation_available, false);
  assert.equal(result.chat.read_only_demo_available, false);
  assert.equal(result.exact_blocker, "company_binding_reconciliation_stale_or_missing");
  assert.equal(result.external_action_executed, false);
  assert.equal(result.mutation.schedules_materialized, false);
});

test("same fresh reconciliation produces the same consultation fingerprint", () => {
  const first = buildCanonicalCompanyConsultationV1({ reconciliation: reconciliation(), snapshot: snapshot() });
  const second = buildCanonicalCompanyConsultationV1({ reconciliation: reconciliation(), snapshot: snapshot() });

  assert.equal(first.snapshot.input_fingerprint, second.snapshot.input_fingerprint);
  assert.equal(first.snapshot.snapshot_id, second.snapshot.snapshot_id);
});

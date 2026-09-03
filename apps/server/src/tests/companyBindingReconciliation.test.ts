import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCompanyBindingReconciliationV1,
  type CompanyBindingReconciliationInput
} from "../runs/companyBindingReconciliation.js";

function input(overrides: Partial<CompanyBindingReconciliationInput> = {}): CompanyBindingReconciliationInput {
  return {
    now: "2026-09-03T00:00:00.000Z",
    requested_company_id: "company-local",
    trigger_company_id: "company-trigger",
    trigger_provenance: "test-registered-toml",
    trigger_sources: [{
      id: "registered-one",
      name: "Registered one",
      status: "ACTIVE",
      rrule: "FREQ=DAILY",
      company_id: "company-trigger",
      automation_id: "automation-trigger",
      source_kind: "codex_app_registered_automation",
      provenance: "test"
    }],
    local_companies: [{
      company_id: "company-local",
      name: "Local company",
      status: "active",
      automation_count: 1,
      automation_ids: ["automation-local"],
      schedule_ids: ["schedule-local"],
      provenance: "test-sql"
    }],
    reference_observations: {
      "company-local": {
        service_identity_configured: false,
        account_ref_count: 0,
        verified_account_ref_count: 0,
        account_platforms: [],
        brief_home_readback_available: true,
        chat_consultation_available: true,
        chat_read_only_demo_available: true,
        chat_approval_preview_available: true
      }
    },
    ...overrides
  };
}

test("company reconciliation never infers a canonical company from trigger or local recency", () => {
  const result = buildCompanyBindingReconciliationV1(input());

  assert.equal(result.schema, "company_binding_reconciliation.v1");
  assert.equal(result.status, "requires_user_decision");
  assert.equal(result.canonical_company_id, null);
  assert.equal(result.selection.selected, false);
  assert.equal(result.selection.canonical_candidate_company_id, null);
  assert.equal(result.exact_blocker, "canonical_company_unresolved");
  assert.ok(result.candidates.some((candidate) => candidate.status === "trigger_only"));
  assert.ok(result.candidates.some((candidate) => candidate.status === "local_only"));
  assert.ok(result.candidates.every((candidate) => candidate.decision === "requires_user_decision"));
});

test("only fresh explicit authority can identify a candidate, and it remains unapplied", () => {
  const result = buildCompanyBindingReconciliationV1(input({
    requested_company_id: "company-local",
    trigger_company_id: "company-local",
    trigger_sources: [{
      id: "registered-local",
      company_id: "company-local",
      automation_id: "automation-local",
      status: "ACTIVE",
      rrule: "FREQ=DAILY"
    }],
    explicit_authority: {
      company_id: "company-local",
      fresh: true,
      source: "test-owner-authority"
    }
  }));
  const candidate = result.candidates.find((item) => item.company_id === "company-local");

  assert.equal(result.status, "candidate_identified");
  assert.equal(result.selection.canonical_candidate_company_id, "company-local");
  assert.equal(candidate?.decision, "canonical_candidate");
  assert.equal(result.canonical_company_id, null);
  assert.equal(result.selection.selected, false);
  assert.equal(result.exact_blocker, "canonical_company_selection_not_applied");
  assert.equal(result.mutation.canonical_company_selected, false);
  assert.equal(result.external_action_executed, false);
});

test("reconciliation exposes only safe references and keeps all effects disabled", () => {
  const result = buildCompanyBindingReconciliationV1(input({
    reference_observations: {
      "company-local": {
        service_identity_configured: true,
        service_identity_source: "environment-readback",
        account_ref_count: 2,
        verified_account_ref_count: 1,
        account_platforms: ["gmail", "gmail"],
        provider_authority_fresh: true,
        browser_authority_fresh: true,
        brief_home_readback_available: true,
        brief_delivery_configured: false,
        chat_consultation_available: true,
        chat_read_only_demo_available: true,
        chat_approval_preview_available: true,
        chat_registration_ready: false
      }
    }
  }));
  const local = result.candidates.find((item) => item.company_id === "company-local")!;

  assert.deepEqual(local.references.account_refs, { count: 2, verified_count: 1, platforms: ["gmail"] });
  assert.equal(result.sensitive_values_exposed, false);
  assert.equal(result.mutation.trigger_rewired, false);
  assert.equal(result.mutation.schedules_materialized, false);
  assert.equal(result.mutation.provider_called, false);
  assert.doesNotMatch(JSON.stringify(result), /secret-token-sentinel|private-prompt-marker/u);
});
